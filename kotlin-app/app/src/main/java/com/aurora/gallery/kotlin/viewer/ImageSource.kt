package com.aurora.gallery.kotlin.viewer

import android.content.ContentResolver
import android.net.Uri
import android.util.Log
import coil.request.ImageRequest
import java.io.File
import java.nio.ByteBuffer
import java.util.Locale

/**
 * 大图取图的数据源（M3 4.1，D8 定案 = A 案）。
 *
 * 不把 `content://` URI 直接交给 Coil：Coil 拿到 URI 会走 `ImageDecoder.createSource(context, uri)`，
 * 而三星的 MediaProvider 在解码失败时会去查它自己的恢复库——M1 §7 1.3 那次真机事故
 * （`MediaRecoveryDatabase_Impl` 缺失）就是这么炸的。改成宿主自己用 `ContentResolver` 开流喂给
 * Coil，URI 根本不进解码器，那颗雷在这条路径上物理存在不了。
 *
 * **喂的是 `ByteBuffer` 而不是 `InputStream`**：Coil 2.7.0 的 `coil.fetch` 包里只有
 * ByteBuffer / ContentUri / File / AssetUri / ResourceUri / HttpUri / Bitmap / Drawable 这些
 * fetcher，**没有 InputStreamFetcher**——直接喂 `ContentResolver.openInputStream` 的结果会在
 * `EngineInterceptor.fetch` 抛 `IllegalStateException: Unable to create a fetcher that supports:
 * ...AutoCloseInputStream`（2026-09-21 SM-X808U 实测）。
 *
 * 代价是**必须显式给缓存键**：`ByteBuffer` 没有稳定身份，Coil 默认拿 `data.toString()` 求 key，
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

/** LAN 大图的缓存键前缀（M6a 阶段 4；disk 键形制对齐 aurora-viewer 同款风格）。 */
private const val LAN_KEY_PREFIX = "aurora-lan:"

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
    if (item.isLan) {
        // M6a 阶段 4：LAN 大图（item.path = imageUrl，token 进 query）。
        // 之前分支缓存键全 null——Coil 对 HttpUri 数据默认按 URL 字符串求 key，能缓存但
        // 与本地大图的键形制割裂；这里补上显式键：disk=`aurora-lan:<remotePath>`（磁盘
        // 存原始字节，与请求尺寸无关）、memory 额外带 variant（解码后的 Bitmap 按尺寸分）。
        // fileId 对 LAN 项即远端 path（数据层映射时 id=远端 path，身份铁律）。
        return CoilSource(
            item.path,
            LAN_KEY_PREFIX + item.fileId,
            "$LAN_KEY_PREFIX${item.fileId}:$variant",
        )
    }
    if (item.contentUri.isNotEmpty()) {
        val uri = Uri.parse(item.contentUri)
        val bytes = runCatching { resolver.openInputStream(uri)?.use { it.readBytes() } }
            .onFailure { Log.w("AuroraViewer", "openInputStream failed: ${item.fileId}", it) }
            .getOrNull()
        // 读不到字节时退回 URI：至少不比 A 案之前的行为更差，失败原因留在上面的日志里
        if (bytes == null) return CoilSource(uri, null, null)
        return CoilSource(
            ByteBuffer.wrap(bytes),
            KEY_PREFIX + item.fileId,
            "$KEY_PREFIX${item.fileId}:$variant",
        )
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
