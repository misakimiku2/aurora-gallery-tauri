package com.aurora.gallery.kotlin

import android.content.ContentUris
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Build
import android.os.SystemClock
import android.provider.MediaStore
import android.util.Log
import android.util.LruCache
import android.util.Size
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext
import java.io.File
import kotlin.math.roundToInt
import uniffi.aurora_core.FfiFaceBox
import uniffi.aurora_core.generateThumbnail

/**
 * 缩略图加载器（M1 阶段 1.3）。
 *
 * 两段式「先糊后清」：
 *  - `loadFast`：内存缓存 → 磁盘缓存 → **自研降采样解码**（长边 512，落盘复用）→
 *    系统 `loadThumbnail` / MINI_KIND 兜底，立即上屏；
 *  - `generateHd`：**按需**——仅当绑定 item 拿到的 fast 结果偏小（<200px）时，
 *    后台读 `content://` 原图字节，交给 Rust `image` crate 解码缩放到 256px，
 *    生成 JPEG 写入磁盘缓存并替换（超大像素数不走这条路，见 [hdWorthDecoding]）。
 *
 * **为什么必须自己降采样**：MediaStore 的 `thumbnails` 表可能是空的（实测本机整库
 * 0 行），此时 `loadThumbnail` 只能现解原图。普通 2~4MP 照片无所谓，但一夹 60MP
 * 扫描件（9504×6336，解码后单张 230MB）会把设备 CPU/内存打满——实测进夹帧耗时
 * 0.9~2.8s、12 次快甩只出 12 帧、100% 掉帧。见 [decodeSubsampled]。
 *
 * 不做「进入文件夹时整夹预热」：即使已改成降采样解码，一张 60MP 扫描件仍要 ~230ms，
 * 大文件夹意味着数分钟的持续解码与写盘，内存带宽/GC 压力与滚动、捏合争抢；且产物是
 * 512px，并不优于系统 loadThumbnail。只为真正显示的图生成（对齐 React 版的按需队列 +
 * 升级事件策略），落盘后下次进夹直接命中。
 *
 * 背景：Coil 直接解码 `content://` 原图在三星 Tab S8+ 上会触发系统级
 * `MediaRecoveryDatabase_Impl` 缺失错误。改用系统缩略图做快速上屏，绕开原图解码路径；
 * 高清兜底由 Rust 完成。
 */
class ThumbnailLoader(context: Context) {

    private val appContext = context.applicationContext
    private val thumbDir = File(appContext.cacheDir, "thumbnails").apply { mkdirs() }

    /** 头像成品磁盘缓存（键含 faceBox，见 [avatarKey]）；换框自然换文件。 */
    private val avatarDir = File(appContext.cacheDir, "avatars").apply { mkdirs() }

    /** URL 缩略图的磁盘缓存（M6a 阶段 4；文件名 = URL 哈希，见 [lanDiskFile]）。 */
    private val lanThumbDir = File(appContext.cacheDir, "lan_thumbs").apply { mkdirs() }

    // 限制高清生成并发，避免滚动时同时解码多张大图抢 IO/CPU 造成掉帧。
    private val hdSemaphore = Semaphore(HD_MAX_CONCURRENCY)

    // 限制快速缩略图并发，避免滚动时大量 MediaStore 查询同时涌入挤爆 IO 线程池。
    // URL 分支（LAN）与本地分支共用同一信号量：滚动时远端 HTTP 请求同样不许挤爆。
    private val fastSemaphore = Semaphore(FAST_MAX_CONCURRENCY)

    // 内存缓存：key -> Bitmap（maxSize 单位为 KB）。**同一个池**装两类 key：
    // 本地图 = "id:<MediaStore id>"，LAN 缩略图 = "u:<完整 URL>"（前缀杜绝两类 key
    // 互撞；此前是 LruCache<Long, Bitmap>，阶段 4 起 LAN 以 URL 为 key 才并成 String）。
    private val memoryCache = object : LruCache<String, Bitmap>(MEMORY_CACHE_SIZE_KB) {
        override fun sizeOf(key: String, value: Bitmap): Int = value.byteCount / 1024
    }

    /** LAN 缩略图拉取（HTTP 15s 超时对齐 LanTiming.FETCH_TIMEOUT_SECS 口径）。 */
    private val lanHttp = okhttp3.OkHttpClient.Builder()
        .connectTimeout(15, java.util.concurrent.TimeUnit.SECONDS)
        .readTimeout(15, java.util.concurrent.TimeUnit.SECONDS)
        .build()

    /** 从 `content://media/external/images/media/{id}` 提取 MediaStore image id。 */
    fun extractImageId(contentUri: String): Long = runCatching {
        ContentUris.parseId(Uri.parse(contentUri))
    }.getOrElse {
        contentUri.substringAfterLast('/').toLong()
    }

    /** 同步读内存缓存（仅内存，不查磁盘/MediaStore），供组合阶段取初始值，避免 item 回收重进时占位符闪烁。 */
    fun peekMemory(imageId: Long): Bitmap? = memoryCache.get(localKey(imageId))

    // —— URL 分支（M6a 阶段 4：LAN HTTP 缩略图；复用本地分支的内存池/并发信号量）——

    /** URL 缩略图的内存缓存键（同池防撞前缀）。 */
    private fun urlKey(url: String) = "u:$url"

    private fun localKey(imageId: Long) = "id:$imageId"

    /** 同步读 URL 缩略图的内存缓存（FileGrid/FoldersOverview 的 LAN 分支同步上屏用）。 */
    fun peekMemoryUrl(url: String): Bitmap? = memoryCache.get(urlKey(url))

    /** URL 缩略图磁盘文件：`lan_thumbs/<URL 的 MD5>`（URL 含 token/path，不进文件名）。 */
    private fun lanDiskFile(url: String): File {
        val digest = java.security.MessageDigest.getInstance("MD5").digest(url.toByteArray())
        return File(lanThumbDir, digest.joinToString("") { "%02x".format(it) })
    }

    /**
     * LAN 缩略图快速取图（阻塞版，调用方自行切线程/限并发）：
     * 内存 → 磁盘（`lan_thumbs/<urlHash>`，存服务端原始字节不重编码）→ okhttp 拉取。
     * 无本地 HD 升级语义——服务端给的 size=256 就是网格要的尺寸。
     */
    private fun loadFastUrl(url: String): Bitmap? {
        memoryCache.get(urlKey(url))?.let { return it }

        val disk = lanDiskFile(url)
        if (disk.exists()) {
            BitmapFactory.decodeFile(disk.absolutePath)?.let {
                Log.d(TAG, "[Thumb:Lan] disk hit bytes=${disk.length()} ${it.width}x${it.height} url#${url.hashCode()}")
                memoryCache.put(urlKey(url), it)
                return it
            }
            // 解码失败 = 半截/损坏缓存，删掉重新拉
            Log.w(TAG, "[Thumb:Lan] 磁盘缓存解码失败，删除重拉 url#${url.hashCode()}")
            disk.delete()
        }

        val bytes = runCatching {
            lanHttp.newCall(okhttp3.Request.Builder().url(url).get().build()).execute().use { resp ->
                if (!resp.isSuccessful) throw java.io.IOException("HTTP ${resp.code}")
                resp.body?.bytes() ?: ByteArray(0)
            }
        }.getOrNull().takeIf { it != null && it.isNotEmpty() } ?: run {
            Log.w(TAG, "[Thumb:Lan] 拉取失败（空/异常）url#${url.hashCode()}")
            return null
        }

        val bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.size) ?: run {
            Log.w(TAG, "[Thumb:Lan] 解码失败 bytes=${bytes.size} url#${url.hashCode()}")
            return null
        }
        Log.d(TAG, "[Thumb:Lan] fetch ok bytes=${bytes.size} ${bmp.width}x${bmp.height} url#${url.hashCode()}")
        memoryCache.put(urlKey(url), bmp)
        // 落盘失败不影响本次上屏（临时目录，系统可随时回收），但要留诊断线索。
        // tmp 文件名带 nanoTime：同一 URL 的并发加载（网格双绑会连发两次）不再互写
        // 同一 tmp 路径——那会产生「半截交错」的损坏缓存，且解码器对坏 JPEG 宽容地
        // 吐出灰块位图（2026-09-24 实测踩过：坏文件落盘后每次进夹都渲染成纯灰格）。
        runCatching {
            val tmp = File(lanThumbDir, "${disk.name}.${System.nanoTime()}.tmp")
            tmp.outputStream().use { it.write(bytes) }
            if (!tmp.renameTo(disk)) tmp.delete()
        }.onFailure { Log.w(TAG, "[Thumb:Lan] 落盘失败 url#${url.hashCode()}", it) }
        return bmp
    }

    /** 限并发的 URL 快速取图（挂起），滚动时与本地分支共用 [fastSemaphore]。 */
    suspend fun loadFastUrlLimited(url: String): Bitmap? =
        fastSemaphore.withPermit { withContext(Dispatchers.IO) { loadFastUrl(url) } }

    /**
     * 快速取图，用于立即上屏（可能在 IO 线程阻塞，调用方自行切线程）。
     * 命中内存/高清磁盘缓存则直接返回；否则**降采样解码**原图；再退到系统缩略图。
     */
    fun loadFast(imageId: Long): Bitmap? {
        memoryCache.get(localKey(imageId))?.let {
            return it
        }

        val diskFile = hdFile(imageId)
        if (diskFile.exists()) {
            BitmapFactory.decodeFile(diskFile.absolutePath)?.let {
                memoryCache.put(localKey(imageId), it)
                return it
            }
        }

        val uri = ContentUris.withAppendedId(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, imageId)

        // 首选：自己降采样解码。MediaStore 的 thumbnails 表可能是空的（实测本机整库 0 行），
        // 此时 loadThumbnail 只能现解原图——60MP 的原图全尺寸解码是 230MB 像素缓冲，
        // 一夹这样的图会把设备 CPU/内存打满（进夹帧耗时 0.9~2.8s）。见 decodeSubsampled。
        val t0 = SystemClock.elapsedRealtime()
        val sub = decodeSubsampled(uri, THUMB_SIZE)
        val subCost = SystemClock.elapsedRealtime() - t0
        if (sub != null) {
            if (subCost >= SLOW_LOG_MS) {
                Log.w(TAG, "[Thumb] 降采样 id=$imageId ${sub.width}x${sub.height} cost=${subCost}ms")
            }
            memoryCache.put(localKey(imageId), sub)
            persistToDisk(diskFile, sub)
            return sub
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val t1 = SystemClock.elapsedRealtime()
            val bmp = runCatching {
                appContext.contentResolver.loadThumbnail(uri, Size(THUMB_SIZE, THUMB_SIZE), null)
            }.getOrNull()
            val cost = SystemClock.elapsedRealtime() - t1
            if (bmp != null) {
                if (cost >= SLOW_LOG_MS) {
                    Log.w(TAG, "[Thumb] loadThumbnail id=$imageId ${bmp.width}x${bmp.height} cost=${cost}ms")
                }
                memoryCache.put(localKey(imageId), bmp)
                return bmp
            }
        }

        @Suppress("DEPRECATION")
        val legacy = MediaStore.Images.Thumbnails.getThumbnail(
            appContext.contentResolver,
            imageId,
            MediaStore.Images.Thumbnails.MINI_KIND,
            null,
        )
        if (legacy != null) memoryCache.put(localKey(imageId), legacy)
        return legacy
    }

    /**
     * 按目标长边**降采样**解码，全程不产生全尺寸位图。
     *
     * `inJustDecodeBounds` 只读文件头拿宽高，再取 2 的幂 `inSampleSize` 让长边落到
     * [targetPx] 附近。JPEG 的 1/2·1/4·1/8 走 DCT 缩放（连系数缓冲都省了），更大的
     * 倍数由解码后缩放，峰值仍是目标尺寸的常数倍——与先解 230MB 再缩到 1MB 是两个世界。
     */
    private fun decodeSubsampled(uri: Uri, targetPx: Int): Bitmap? = runCatching {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        appContext.contentResolver.openInputStream(uri)?.use {
            BitmapFactory.decodeStream(it, null, bounds)
        }
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
        val opts = BitmapFactory.Options().apply {
            inSampleSize = sampleSizeFor(bounds.outWidth, bounds.outHeight, targetPx)
        }
        appContext.contentResolver.openInputStream(uri)?.use {
            BitmapFactory.decodeStream(it, null, opts)
        }
    }.getOrNull()

    /** 取 2 的幂，使降采样后的长边仍 ≥ [targetPx]（再翻一倍就低于目标了）。 */
    private fun sampleSizeFor(width: Int, height: Int, targetPx: Int): Int {
        val longSide = maxOf(width, height)
        var sample = 1
        while (longSide / (sample * 2L) >= targetPx) sample *= 2
        return sample
    }

    /**
     * 落盘一次，下次进夹直接命中，不再重复解码原图。
     *
     * 带透明通道的图（PNG/WebP）**不落盘**：缓存格式是 JPEG，落盘等于把透明区涂成黑底，
     * 第二次进夹就和首次看到的不一样了。这类图整库只有百余张，重复解码代价可接受。
     */
    private fun persistToDisk(file: File, bitmap: Bitmap) {
        if (file.exists() || bitmap.hasAlpha()) return
        runCatching {
            val tmp = File(file.absolutePath + ".tmp")
            tmp.outputStream().use { bitmap.compress(Bitmap.CompressFormat.JPEG, THUMB_JPEG_QUALITY, it) }
            if (!tmp.renameTo(file)) tmp.delete()
        }
    }

    /** 限并发的快速取图（挂起），滚动时避免 MediaStore 查询挤爆 IO 线程池。 */
    suspend fun loadFastLimited(imageId: Long): Bitmap? =
        fastSemaphore.withPermit { withContext(Dispatchers.IO) { loadFast(imageId) } }

    /**
     * 头像裁剪页的取图源（#6）：按长边 [targetPx] 降采样解**原图**，比 512 的缩略图锐利
     * 四倍以上——裁剪页是全 App 里唯一会把图放大到远超原始像素的界面，用缩略图就是马赛克。
     *
     * 走 [decodeSubsampled]：自己 `openInputStream` 喂 BitmapFactory，URI 根本不进系统解码器，
     * 所以 M1 §7 1.3 那颗三星 `MediaRecoveryDatabase_Impl` 的雷在这条路上物理存在不了
     * （雷的是「把 URI 丢给解码器」，不是「解原图」本身）。
     *
     * **不进 [memoryCache]、不落盘**：一次性大图，塞进缩略图缓存会把整屏网格的缩略图挤出
     * LRU；它由裁剪页持有，退页即回收。失败返回 null，由调用方退回 [loadFastLimited]。
     */
    suspend fun loadCropSource(imageId: Long, targetPx: Int = CROP_SOURCE_PX): Bitmap? =
        fastSemaphore.withPermit {
            val uri = ContentUris.withAppendedId(
                MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
                imageId,
            )
            withContext(Dispatchers.IO) { decodeSubsampled(uri, targetPx) }
        }

    /** 头像成品是否已在内存（组合阶段取初值用，网格回收重进时不闪占位符）。 */
    fun peekAvatar(imageId: Long, box: FfiFaceBox?): Bitmap? =
        memoryCache.get(avatarKey(imageId, box))

    /**
     * 人物头像成品：按 [FfiFaceBox] 从**降采样原图**里裁出方块，再缩到 [AVATAR_PX]，
     * 结果单独进内存 + 磁盘缓存。
     *
     * 为什么不能拿网格那份缩略图直接裁：fast 结果长边只有 512，而头像框常常只占 15%
     * 上下，裁出来实际细节约 80px，投到 96dp（204px）就是糊的（2026-10-08 反馈）。
     * 头像要的是「那一小块」，所以取源得按原图比例解到那一块够像素为止。
     *
     * 缓存键带 box：换框 = 换键，不会拿旧框的成品糊弄新框。并发走 [hdSemaphore]——
     * 人物一多时这里比缩略图更贵（每张都要解一次 1600 级别的原图）。
     */
    suspend fun loadAvatar(imageId: Long, box: FfiFaceBox?): Bitmap? {
        val key = avatarKey(imageId, box)
        memoryCache.get(key)?.let { return it }
        val disk = File(avatarDir, key.replace(':', '_') + ".jpg")
        if (disk.exists()) {
            BitmapFactory.decodeFile(disk.absolutePath)?.let {
                memoryCache.put(key, it)
                return it
            }
        }
        return hdSemaphore.withPermit {
            withContext(Dispatchers.IO) {
                buildAvatar(imageId, box)?.also {
                    memoryCache.put(key, it)
                    persistToDisk(disk, it)
                }
            }
        }
    }

    private fun buildAvatar(imageId: Long, box: FfiFaceBox?): Bitmap? {
        val uri = ContentUris.withAppendedId(
            MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
            imageId,
        )
        // 解不到降采样原图时退回 fast 缩略图：糊，但比没有头像好
        val src = decodeSubsampled(uri, CROP_SOURCE_PX) ?: loadFast(imageId) ?: return null
        val rect = avatarCropRect(src.width, src.height, box)
        val crop = runCatching {
            Bitmap.createBitmap(src, rect[0], rect[1], rect[2], rect[3])
        }.getOrNull() ?: return null
        if (crop.width <= AVATAR_PX) return crop
        val small = Bitmap.createScaledBitmap(crop, AVATAR_PX, AVATAR_PX, true)
        // 裁切区正好等于整幅时 createBitmap 返回的是源图本身，那种情况不能回收
        if (crop !== src) crop.recycle()
        return small
    }

    /** 当前位图是否偏小、值得升级为高清。 */
    fun needsUpgrade(bitmap: Bitmap): Boolean =
        minOf(bitmap.width, bitmap.height) < MIN_DIM_THRESHOLD

    /**
     * 后台生成高清缩略图（挂起函数，受并发限制）。
     * 成功则写入高清磁盘缓存，供下次 `loadFast` 命中；失败退回 `loadThumbnail`。
     */
    suspend fun generateHd(imageId: Long, contentUri: String): Bitmap? =
        hdSemaphore.withPermit { generateHdBlocking(imageId, contentUri) }

    private fun generateHdBlocking(imageId: Long, contentUri: String): Bitmap? {
        val diskFile = hdFile(imageId)
        // 可能已有其它协程生成完成
        if (diskFile.exists()) {
            BitmapFactory.decodeFile(diskFile.absolutePath)?.let {
                memoryCache.put(localKey(imageId), it)
                return it
            }
        }

        val data = runCatching {
            appContext.contentResolver.openInputStream(Uri.parse(contentUri))?.use { it.readBytes() }
        }.getOrNull()

        if (data != null && data.isNotEmpty() && hdWorthDecoding(data)) {
            val jpeg = runCatching { generateThumbnail(data) }.getOrNull()
            if (jpeg != null && jpeg.isNotEmpty()) {
                runCatching { diskFile.outputStream().use { it.write(jpeg) } }
                BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size)?.let {
                    memoryCache.put(localKey(imageId), it)
                    return it
                }
            }
        }

        // 兜底：ContentResolver.loadThumbnail（API 29+，系统解码）
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val bmp = runCatching {
                appContext.contentResolver.loadThumbnail(
                    Uri.parse(contentUri),
                    Size(THUMB_SIZE, THUMB_SIZE),
                    null,
                )
            }.getOrNull()
            if (bmp != null) {
                memoryCache.put(localKey(imageId), bmp)
                return bmp
            }
        }
        return null
    }

    private fun hdFile(imageId: Long) = File(thumbDir, "$imageId.jpg")

    /**
     * Rust 的 `generateThumbnail` 是**全尺寸解码**（`image` crate 不做降采样），
     * 60MP 原图意味着 230MB 像素缓冲——这类超大图放弃 HD 升级，保留快速通道的
     * 降采样结果（长边已 ≥512，不比 HD 的 256px 差）。
     */
    private fun hdWorthDecoding(data: ByteArray): Boolean {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(data, 0, data.size, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return true
        return bounds.outWidth.toLong() * bounds.outHeight <= HD_MAX_SOURCE_PIXELS
    }

    companion object {
        private const val TAG = "AuroraKotlin"
        private const val MEMORY_CACHE_SIZE_KB = 128 * 1024 // 128 MB
        private const val FAST_MAX_CONCURRENCY = 4 // 快速缩略图并发上限
        private const val THUMB_SIZE = 512
        /**
         * 裁剪页取图源的目标长边（#6）。
         *
         * 取 1600 而不是 2048 是因为 [sampleSizeFor] 只取 2 的幂：手机默认 12MP 图的长边
         * 正好 4032，目标给 2048 时 `4032/2=2016 < 2048` 不成立 → sample=1 → **整幅原图解进
         * 内存（48MB）**。目标 1600 让这类图稳定落到 1/2（2016×1512 ≈ 12MB），同时线性分辨率
         * 仍是 512 缩略图的近四倍，够裁剪页放大用。
         */
        private const val CROP_SOURCE_PX = 1600
        private const val THUMB_JPEG_QUALITY = 82
        private const val MIN_DIM_THRESHOLD = 200 // 最小边低于此值视为太糊，触发高清升级
        private const val HD_MAX_CONCURRENCY = 2 // 高清生成并发上限
        private const val HD_MAX_SOURCE_PIXELS = 40_000_000L // 超过此像素数不走 Rust 全解码
        private const val SLOW_LOG_MS = 200L // 慢解码诊断阈值（只在超阈值时打日志）
    }
}

/** 头像成品边长：96dp 头像在 3.3 倍密度设备上是 317px，取 320 够到最密的一档。 */
private const val AVATAR_PX = 320

/** 头像缓存键（内存与磁盘同源）：带 box，换框即换键，不会拿旧框的成品糊弄新框。 */
internal fun avatarKey(imageId: Long, box: FfiFaceBox?): String = "av:$imageId:" +
    if (box == null || box.w <= 0.0 || box.h <= 0.0) {
        "full"
    } else {
        "%.1f_%.1f_%.1f".format(box.x, box.y, box.w)
    }

/**
 * faceBox（百分比：x/y = 左上角占比，w/h = 宽高占比，0..100）→ 图像像素上的正方形裁切区
 * `[x, y, side, side]`。口径同桌面 `utils/cropStyle.ts`：裁剪窗是正方形，所以
 * `w%·imgW == h%·imgH`。
 *
 * 无框 / 退化框 → 整图中心正方形（桌面 `centerCrop` 同语义）。框因历史数据或浮点误差
 * 不是正方形时，取框内最大的**居中**正方形——桌面那套 `cropToImgStyle` 对宽高分别按
 * `10000/w%`、`10000/h%` 缩放会拉伸变形，这里不跟。
 *
 * 单独抽成纯函数是为了能单测：这条换算链上一轮正是「存的头像不是圈里那块」的现场。
 */
internal fun avatarCropRect(imgW: Int, imgH: Int, box: FfiFaceBox?): IntArray {
    val center = minOf(imgW, imgH)
    val fallback = intArrayOf((imgW - center) / 2, (imgH - center) / 2, center, center)
    if (box == null || box.w <= 0.0 || box.h <= 0.0) return fallback
    // 先把左上角收进图内，再按「剩下的空间」夹宽高：历史数据里 x+w 可能超 100%，
    // 不夹就会算出跑到图外的裁切区（createBitmap 直接抛）
    val x = (box.x / 100.0 * imgW).roundToInt().coerceIn(0, imgW - 1)
    val y = (box.y / 100.0 * imgH).roundToInt().coerceIn(0, imgH - 1)
    val w = (box.w / 100.0 * imgW).roundToInt().coerceIn(1, imgW - x)
    val h = (box.h / 100.0 * imgH).roundToInt().coerceIn(1, imgH - y)
    val side = minOf(w, h)
    return intArrayOf(x + (w - side) / 2, y + (h - side) / 2, side, side)
}
