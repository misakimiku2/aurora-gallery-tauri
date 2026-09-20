package com.aurora.gallery.kotlin.viewer

import android.content.ContentResolver
import android.net.Uri
import android.util.Log
import coil.request.ImageRequest
import java.io.File
import java.util.Locale

/**
 * 大图取图的数据源（M3 4.1，D8 定案 = A 案）。
 *
 * 不把 `content://` URI 直接交给 Coil：Coil 拿到 URI 会走 `ImageDecoder.createSource(context, uri)`，
 * 而三星的 MediaProvider 在解码失败时会去查它自己的恢复库——M1 §7 1.3 那次真机事故
 * （`MediaRecoveryDatabase_Impl` 缺失）就是这么炸的。改成宿主自己用 `ContentResolver` 开流喂给
 * Coil，URI 根本不进解码器，那颗雷在这条路径上物理存在不了。
 *
 * 代价是**必须显式给缓存键**：`InputStream` 没有稳定身份，Coil 默认拿 `data.toString()` 求 key，
 * 每次都是新对象 → 缓存全废、翻页全部重解。两个键各自的意义：
 *  - `diskKey` 用 fileId：磁盘缓存存的是**原始字节**，与请求尺寸无关，所以原图 / 抽屉预览 /
 *    缩略图条共用同一份字节，谁先到谁落盘；
 *  - `memoryKey` 额外带 `variant`：内存缓存存的是**解码后的 Bitmap**，尺寸不同不能互用
 *    （Coil 喂 URI 时是靠「key 里含目标尺寸」自动分开的，我们给了显式 key 就得自己分开）。
 */
internal class CoilSource(
    val data: Any,
    val diskKey: String?,
    val memoryKey: String?,
)

private const val KEY_PREFIX = "aurora-viewer:"

/**
 * 动画格式仍把 URI 交给 Coil。实测（2026-09-21 模拟器 A/B）：喂 InputStream 时
 * `ImageDecoderDecoder` 只给出静态首帧，GIF 不动；喂 URI 才拿到会播的
 * `AnimatedImageDrawable`。动画文件小、也不是 M1 §7 1.3 那次事故的触发形态（那是
 * 60MP 扫描件），所以这里让给动画、其余一律走流。
 */
private val ANIMATED_FORMATS = setOf("gif", "webp", "apng")

/** [variant] 区分同一张图的不同解码尺寸：full / preview / strip / slideshow。 */
internal fun imageSourceFor(
    item: NativeGalleryView.ImageItem,
    resolver: ContentResolver,
    variant: String = "full",
): CoilSource {
    if (item.isLan) return CoilSource(item.path, null, null)
    if (item.contentUri.isNotEmpty()) {
        val uri = Uri.parse(item.contentUri)
        if (item.format.lowercase(Locale.US) in ANIMATED_FORMATS) return CoilSource(uri, null, null)
        val stream = runCatching { resolver.openInputStream(uri) }
            .onFailure { Log.w("AuroraViewer", "openInputStream failed: ${item.fileId}", it) }
            .getOrNull()
        // 开流失败时退回 URI：至少不比 A 案之前的行为更差，失败原因留在上面的日志里
        if (stream == null) return CoilSource(uri, null, null)
        return CoilSource(stream, KEY_PREFIX + item.fileId, "$KEY_PREFIX${item.fileId}:$variant")
    }
    return CoilSource(File(item.path), null, null)
}

/** 把 [CoilSource] 一次性落到请求上：喂数据的同时补上两个缓存键，漏一个就退化成每次重解。 */
internal fun coilSource(builder: ImageRequest.Builder, src: CoilSource): ImageRequest.Builder =
    builder.apply {
        data(src.data)
        src.diskKey?.let { diskCacheKey(it) }
        src.memoryKey?.let { memoryCacheKey(it) }
    }
