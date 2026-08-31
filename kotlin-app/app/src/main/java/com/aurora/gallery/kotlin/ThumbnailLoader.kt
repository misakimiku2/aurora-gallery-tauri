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
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
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

    // 内存缓存：imageId -> Bitmap（maxSize 单位为 KB）。
    private val memoryCache = object : LruCache<Long, Bitmap>(MEMORY_CACHE_SIZE_KB) {
        override fun sizeOf(key: Long, value: Bitmap): Int = value.byteCount / 1024
    }

    /** 从 `content://media/external/images/media/{id}` 提取 MediaStore image id。 */
    fun extractImageId(contentUri: String): Long = runCatching {
        ContentUris.parseId(Uri.parse(contentUri))
    }.getOrElse {
        contentUri.substringAfterLast('/').toLong()
    }

    /**
     * 快速取图，用于立即上屏（可能在 IO 线程阻塞，调用方自行切线程）。
     * 命中内存/高清磁盘缓存则返回高清；否则返回 MINI_KIND（可能偏小，由调用方判断是否升级）。
     */
    fun loadFast(imageId: Long): Bitmap? {
        memoryCache.get(imageId)?.let { return it }

        val diskFile = hdFile(imageId)
        if (diskFile.exists()) {
            BitmapFactory.decodeFile(diskFile.absolutePath)?.let {
                memoryCache.put(imageId, it)
                return it
            }
        }

        @Suppress("DEPRECATION")
        return MediaStore.Images.Thumbnails.getThumbnail(
            appContext.contentResolver,
            imageId,
            MediaStore.Images.Thumbnails.MINI_KIND,
            null,
        )
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
        private const val THUMB_SIZE = 512
        private const val MIN_DIM_THRESHOLD = 200 // 最小边低于此值视为太糊，触发高清升级
        private const val HD_MAX_CONCURRENCY = 2 // 高清生成并发上限
    }
}
