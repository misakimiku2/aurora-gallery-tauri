package com.aurora.gallery.kotlin

import android.content.ContentUris
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import android.util.Log
import android.util.LruCache
import android.util.Size
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext
import java.io.File
import uniffi.aurora_core.generateThumbnail

/**
 * 缩略图加载器（M1 阶段 1.3）。
 *
 * 两段式「先糊后清」：
 *  - `loadFast`：内存缓存 → 高清磁盘缓存 → MINI_KIND 系统缩略图（可能偏小），立即上屏；
 *  - `generateHd`：当 fast 结果偏小/缺失时，后台读 `content://` 原图字节，交给 Rust
 *    `image` crate 解码缩放到 256px，生成 JPEG 写入磁盘缓存并替换。
 *
 * 背景：Coil 直接解码 `content://` 原图在三星 Tab S8+ 上会触发系统级
 * `MediaRecoveryDatabase_Impl` 缺失错误。改用 `MediaStore.Images.Thumbnails.getThumbnail(MINI_KIND)`
 * 取系统缩略图表做快速上屏，绕开对原图的解码路径；高清兜底由 Rust 完成。
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

    // 诊断统计：loadFast 命中类型与耗时（每 N 次打印汇总，定位掉帧来源）
    private var fastCount = 0
    private var fastMemory = 0
    private var fastDisk = 0
    private var fastMedia = 0
    private var fastMemoryMs = 0L
    private var fastDiskMs = 0L
    private var fastMediaMs = 0L

    /** 从 `content://media/external/images/media/{id}` 提取 MediaStore image id。 */
    fun extractImageId(contentUri: String): Long = runCatching {
        ContentUris.parseId(Uri.parse(contentUri))
    }.getOrElse {
        contentUri.substringAfterLast('/').toLong()
    }

    /** 同步读内存缓存（仅内存，不查磁盘/MediaStore），供组合阶段取初始值，避免 item 回收重进时占位符闪烁。 */
    fun peekMemory(imageId: Long): Bitmap? = memoryCache.get(imageId)

    /**
     * 快速取图，用于立即上屏（可能在 IO 线程阻塞，调用方自行切线程）。
     * 命中内存/高清磁盘缓存则返回高清；否则返回 MINI_KIND（可能偏小，由调用方判断是否升级）。
     */
    fun loadFast(imageId: Long): Bitmap? {
        val start = System.currentTimeMillis()
        memoryCache.get(imageId)?.let {
            recordFast("memory", start)
            return it
        }

        val diskFile = hdFile(imageId)
        if (diskFile.exists()) {
            BitmapFactory.decodeFile(diskFile.absolutePath)?.let {
                memoryCache.put(imageId, it)
                recordFast("disk", start)
                return it
            }
        }

        // MediaStore 缩略图：优先 ContentResolver.loadThumbnail（API 29+，走现代解码路径、
        // 有 MediaProvider 层缓存），回退废弃的 getThumbnail；结果缓存进内存，避免回滚重复查询。
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val uri = ContentUris.withAppendedId(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, imageId)
            val bmp = runCatching {
                appContext.contentResolver.loadThumbnail(uri, Size(THUMB_SIZE, THUMB_SIZE), null)
            }.getOrNull()
            if (bmp != null) {
                memoryCache.put(imageId, bmp)
                recordFast("media", start)
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
        recordFast("media", start)
        return legacy
    }

    /** 累计 loadFast 命中类型与耗时，每 [FAST_STATS_INTERVAL] 次打印汇总。 */
    private fun recordFast(kind: String, startMs: Long) {
        val elapsed = System.currentTimeMillis() - startMs
        when (kind) {
            "memory" -> { fastMemory++; fastMemoryMs += elapsed }
            "disk" -> { fastDisk++; fastDiskMs += elapsed }
            "media" -> { fastMedia++; fastMediaMs += elapsed }
        }
        fastCount++
        if (fastCount % FAST_STATS_INTERVAL == 0) {
            Log.d(
                TAG,
                "loadFast汇总[$fastCount] memory=${fastMemory}(${avg(fastMemoryMs, fastMemory)}ms) " +
                    "disk=${fastDisk}(${avg(fastDiskMs, fastDisk)}ms) " +
                    "media=${fastMedia}(${avg(fastMediaMs, fastMedia)}ms)",
            )
        }
    }

    private fun avg(totalMs: Long, count: Int): Long = if (count == 0) 0L else totalMs / count

    /** 限并发的快速取图（挂起），滚动时避免 MediaStore 查询挤爆 IO 线程池。 */
    suspend fun loadFastLimited(imageId: Long): Bitmap? =
        fastSemaphore.withPermit { withContext(Dispatchers.IO) { loadFast(imageId) } }

    /**
     * 后台预生成缩略图到磁盘缓存（进入文件夹时调用）。
     *
     * 渐进式：已存在的磁盘缓存跳过；其余并行生成，并发受 [hdSemaphore] 限制，
     * 让滚动中的 `loadFast` 逐步命中磁盘缓存（3ms），而非回退到较慢的 loadThumbnail。
     */
    suspend fun pregenerate(contentUris: List<String>) = coroutineScope {
        contentUris.forEach { uri ->
            val imageId = extractImageId(uri)
            if (hdFile(imageId).exists()) return@forEach
            launch(Dispatchers.IO) { generateHd(imageId, uri) }
        }
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
                memoryCache.put(imageId, it)
                return it
            }
        }

        val start = System.currentTimeMillis()
        val data = runCatching {
            appContext.contentResolver.openInputStream(Uri.parse(contentUri))?.use { it.readBytes() }
        }.getOrNull()

        if (data != null && data.isNotEmpty()) {
            val jpeg = runCatching { generateThumbnail(data) }.getOrNull()
            if (jpeg != null && jpeg.isNotEmpty()) {
                runCatching { diskFile.outputStream().use { it.write(jpeg) } }
                BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size)?.let {
                    memoryCache.put(imageId, it)
                    Log.d(
                        TAG,
                        "HD generated id=$imageId src=${data.size}B out=${jpeg.size}B " +
                            "${System.currentTimeMillis() - start}ms",
                    )
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

    companion object {
        private const val TAG = "AuroraKotlin"
        private const val MEMORY_CACHE_SIZE_KB = 128 * 1024 // 128 MB
        private const val FAST_STATS_INTERVAL = 100 // loadFast 每 100 次打印一次统计
        private const val FAST_MAX_CONCURRENCY = 4 // 快速缩略图并发上限
        private const val THUMB_SIZE = 512
        private const val MIN_DIM_THRESHOLD = 200 // 最小边低于此值视为太糊，触发高清升级
        private const val HD_MAX_CONCURRENCY = 2 // 高清生成并发上限
    }
}
