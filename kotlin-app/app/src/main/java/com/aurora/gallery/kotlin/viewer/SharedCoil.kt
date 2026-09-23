package com.aurora.gallery.kotlin.viewer

import android.content.Context
import android.os.Build
import android.util.Log
import coil.ImageLoader
import coil.decode.GifDecoder
import coil.decode.ImageDecoderDecoder
import coil.disk.DiskCache
import coil.memory.MemoryCache
import java.io.File

/**
 * 进程级共享 Coil ImageLoader（M5 1.2，D25）：
 * 查看器（NativeGalleryView）与画布（CanvasView）**同实例**——
 *  - 内存缓存一份（30%，两视图不同时在前台，互为对方让出空间）；
 *  - 磁盘缓存一份（`coil_viewer_cache` 200MB；两个 ImageLoader 实例指向同一目录会打架
 *    journal，必须同实例）；画布的 diskKey 沿用 `aurora-viewer:<fileId>`，看过的图
 *    画布零重复占盘；
 *  - 「清除缓存」（M4b 2.3，`cacheDir.deleteRecursively`）自动覆盖两视图，清理范围不变。
 */
object SharedCoil {

    @Volatile
    private var instance: ImageLoader? = null

    fun get(context: Context): ImageLoader =
        instance ?: synchronized(this) {
            instance ?: build(context.applicationContext).also { instance = it }
        }

    private fun build(context: Context): ImageLoader =
        ImageLoader.Builder(context)
            .memoryCache {
                MemoryCache.Builder(context).maxSizePercent(0.30).build()
            }
            .diskCache {
                DiskCache.Builder()
                    .directory(File(context.cacheDir, "coil_viewer_cache"))
                    .maxSizeBytes(200L * 1024 * 1024)
                    .build()
            }
            .crossfade(false)
            .precision(coil.size.Precision.INEXACT)
            .components {
                // API 28+: ImageDecoderDecoder 支持 animated WebP + animated GIF（硬件解码）
                // API < 28: GifDecoder 仅支持 animated GIF（软件解码，无 animated WebP 支持）
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                    add(ImageDecoderDecoder.Factory())
                } else {
                    add(GifDecoder.Factory())
                }
            }
            // 解码失败只报「加载失败」查不了真机问题（如 content:// 取流、缓存键、降级路径），
            // 让 Coil 自己把堆栈打出来
            .logger(coil.util.DebugLogger(level = Log.ERROR))
            .build()
}
