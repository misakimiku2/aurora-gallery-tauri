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

    // 限制高清生成并发，避免滚动时同时解码多张大图抢 IO/CPU 造成掉帧。
    private val hdSemaphore = Semaphore(HD_MAX_CONCURRENCY)

    // 限制快速缩略图并发，避免滚动时大量 MediaStore 查询同时涌入挤爆 IO 线程池。
    private val fastSemaphore = Semaphore(FAST_MAX_CONCURRENCY)

    // 内存缓存：imageId -> Bitmap（maxSize 单位为 KB）。
    private val memoryCache = object : LruCache<Long, Bitmap>(MEMORY_CACHE_SIZE_KB) {
        override fun sizeOf(key: Long, value: Bitmap): Int = value.byteCount / 1024
    }

    /** 从 `content://media/external/images/media/{id}` 提取 MediaStore image id。 */    fun extractImageId(contentUri: String): Long = runCatching {
        ContentUris.parseId(Uri.parse(contentUri))
    }.getOrElse {
        contentUri.substringAfterLast('/').toLong()
    }

    /** 同步读内存缓存（仅内存，不查磁盘/MediaStore），供组合阶段取初始值，避免 item 回收重进时占位符闪烁。 */
    fun peekMemory(imageId: Long): Bitmap? = memoryCache.get(imageId)

    /**
     * 快速取图，用于立即上屏（可能在 IO 线程阻塞，调用方自行切线程）。
     * 命中内存/高清磁盘缓存则直接返回；否则**降采样解码**原图；再退到系统缩略图。
     */
    fun loadFast(imageId: Long): Bitmap? {
        memoryCache.get(imageId)?.let {
            return it
        }

        val diskFile = hdFile(imageId)
        if (diskFile.exists()) {
            BitmapFactory.decodeFile(diskFile.absolutePath)?.let {
                memoryCache.put(imageId, it)
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
            memoryCache.put(imageId, sub)
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
                memoryCache.put(imageId, bmp)
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
        if (legacy != null) memoryCache.put(imageId, legacy)
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
                memoryCache.put(imageId, it)
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
                    memoryCache.put(imageId, it)
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
                memoryCache.put(imageId, bmp)
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
        private const val THUMB_JPEG_QUALITY = 82
        private const val MIN_DIM_THRESHOLD = 200 // 最小边低于此值视为太糊，触发高清升级
        private const val HD_MAX_CONCURRENCY = 2 // 高清生成并发上限
        private const val HD_MAX_SOURCE_PIXELS = 40_000_000L // 超过此像素数不走 Rust 全解码
        private const val SLOW_LOG_MS = 200L // 慢解码诊断阈值（只在超阈值时打日志）
    }
}
