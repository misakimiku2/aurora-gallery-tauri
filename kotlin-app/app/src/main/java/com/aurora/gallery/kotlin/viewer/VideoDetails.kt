package com.aurora.gallery.kotlin.viewer

import android.content.Context
import android.media.MediaExtractor
import android.media.MediaFormat
import android.net.Uri
import android.util.Log
import android.util.LruCache

/**
 * 抽屉「更多详情」要的四个视频字段：帧率 / 码率 / 视频编码 / 旋转。
 *
 * 为什么必须现读：安卓入库时 `file_index` 的 `frame_rate`/`video_codec`/`bit_rate`/
 * `rotation` 四列**恒为 NULL**（P7 拍板：那四列当年是桌面 revelo 探针填的，安卓没有对应
 * 通路，见 `core/src/ffi.rs` 里 `media_entry_of` 的注释）。所以详情里这四项不能像桌面那样
 * 直接从 `Image` 带出来，只能在用户真的点开详情时现读容器。
 *
 * 用 [MediaExtractor] 而不是 ffmpeg/MediaMetadataRetriever：
 * - 系统自带、零新依赖，且**只读 moov/track 头，不解码一帧画面**（实测对 536 MB 的片子
 *   也是几十毫秒级，且放在后台线程）；
 * - MediaMetadataRetriever 没有帧率与编码名，只有旋转/尺寸；
 * - 编码名/帧率/旋转都得从 `MediaFormat` 拿，Extractor 一次给全。
 *
 * ⚠️ 口径差异，先写在这免得被当成 bug：
 * - **码率**：桌面取的是容器声明的 General `OverallBitRate`（整只文件的平均码率）。
 *   `MediaFormat.KEY_BIT_RATE` 只有**单轨**的，直接显示会和桌面对不上，所以这里按
 *   「文件字节数 × 8 ÷ 时长」自己算总码率，与桌面同源；拿不到 size/duration 才退回单轨值。
 * - **帧率**：`KEY_FRAME_RATE` 是容器里的近似值，29.97 的片子系统经常给 30（整数），
 *   桌面 revelo 给 29.97。差的是取整，不是读错。
 * - **分辨率**：这里取的是**编码尺寸**（`KEY_WIDTH/KEY_HEIGHT`），与桌面一致；
 *   MediaStore 的 `WIDTH/HEIGHT` 对旋转过的视频是**显示尺寸**，两者可能宽高互换。
 */
internal data class VideoDetails(
    /** 编码名，如 `AVC` / `HEVC` / `VP9`；读不到为空串（调用方显示「—」）。 */
    val codec: String,
    /** 已格式化好的 `"29.97 fps"`；读不到为空串。 */
    val frameRate: String,
    /** 已格式化好的 `"1.1 Mbps"` / `"523 kbps"`；读不到为空串。 */
    val bitRate: String,
    /** 0 = 无旋转（与桌面一致：为 0 时整格不显示）。 */
    val rotation: Int,
    val width: Int,
    val height: Int,
) {
    /** 抽屉里没读到的项一律显「—」，不猜值。 */
    fun orDash(v: String): String = v.ifEmpty { "—" }
}

/**
 * 现读 + 进程级缓存。
 *
 * 缓存键用 `fileId`（同一文件在查看器里来回翻页不该反复开 Extractor）。**负结果不缓存**：
 * 一次失败（比如当时正被别的进程占用）不该让这一整个会话永远显示「—」。
 */
internal object VideoDetailsProbe {

    /** logcat 里的名字：真机上排查「详情全是 —」全靠这一条。 */
    private const val TAG = "VideoDetails"

    private val cache = LruCache<String, VideoDetails>(256)

    fun cached(key: String): VideoDetails? = cache.get(key)

    /** 阻塞读容器头，**必须在后台线程调用**。失败返回 null。 */
    fun read(context: Context, key: String, contentUri: String, path: String, sizeBytes: Long): VideoDetails? {
        cache.get(key)?.let { return it }
        val d = runCatching { extract(context, contentUri, path, sizeBytes) }
            .onFailure { Log.w(TAG, "探针失败 ${path.substringAfterLast('/')} uri=${contentUri.take(24)}: ${it.javaClass.simpleName} ${it.message}") }
            .getOrNull()
        Log.i(TAG, "读回 ${path.substringAfterLast('/')} → ${d?.let { "codec=${it.codec} fps=${it.frameRate} br=${it.bitRate} rot=${it.rotation} ${it.width}x${it.height}" } ?: "null"}")
        d?.let { cache.put(key, it) }
        return d
    }

    private fun extract(context: Context, contentUri: String, path: String, sizeBytes: Long): VideoDetails? {
        val ex = MediaExtractor()
        try {
            // content:// 优先：Scoped Storage 下这才是稳的（与 imageSourceFor 同源的经验）。
            // LAN 项的 path 是 `http://…`，MediaExtractor 也支持（只读 moov，依赖服务端
            // Range —— LAN 服务端的 206 有测试钉着）；失败就整项降级成「—」，不重试。
            when {
                contentUri.startsWith("content://") -> ex.setDataSource(context, Uri.parse(contentUri), null)
                path.startsWith("http://") || path.startsWith("https://") ->
                    ex.setDataSource(context, Uri.parse(path), null)
                else -> ex.setDataSource(path)
            }
            // MediaExtractor.getDuration() 的单位就是微秒（没有 getDurationUs()）
            for (i in 0 until ex.trackCount) {
                val f = runCatching { ex.getTrackFormat(i) }.getOrNull() ?: continue
                val mime = runCatching { f.getString(MediaFormat.KEY_MIME) }.getOrNull() ?: continue
                if (!mime.startsWith("video/")) continue
                // MediaExtractor **没有** getDuration()：时长在轨的 MediaFormat.KEY_DURATION
                // 里（单位微秒），拿不到就当 0，让码率退回单轨声明值。
                val durationUs = mediaFormatDurationUs(f)
                return VideoDetails(
                    codec = codecLabel(mime),
                    frameRate = frameRateLabel(f),
                    bitRate = formatBitRate(bitRateBps(f, durationUs, sizeBytes)),
                    rotation = runCatching { f.getInteger(MediaFormat.KEY_ROTATION) }.getOrDefault(0),
                    width = runCatching { f.getInteger(MediaFormat.KEY_WIDTH) }.getOrDefault(0),
                    height = runCatching { f.getInteger(MediaFormat.KEY_HEIGHT) }.getOrDefault(0),
                )
            }
            // 开了容器却没有视频轨（或轨的 mime 不是 video/*）：如实报出来，
            // 否则界面上只剩一排「—」，谁都看不出是卡在哪一步。
            Log.w(TAG, "没有可用视频轨 tracks=${ex.trackCount} :: ${path.substringAfterLast('/')}")
            return null
        } finally {
            runCatching { ex.release() }
        }
    }

    /** `video/avc` → `AVC`，与桌面 revelo 的 `Format` 字段同一口径（`AVC`/`HEVC`/…）。 */
    private fun codecLabel(mime: String): String = when (mime) {
        "video/avc" -> "AVC"
        "video/hevc" -> "HEVC"
        "video/mp4v-es" -> "MP4V"
        "video/x-vnd.on2.vp8" -> "VP8"
        "video/x-vnd.on2.vp9" -> "VP9"
        "video/av01" -> "AV1"
        "video/mpeg2" -> "MPEG2"
        "video/3gpp" -> "H.263"
        else -> mime.substringAfter('/').uppercase()
    }

    private fun frameRateLabel(f: MediaFormat): String {
        // KEY_FRAME_RATE 在不同容器里可能是 Integer 也可能是 Float，两种都试
        val fps = runCatching { f.getFloat(MediaFormat.KEY_FRAME_RATE).toDouble() }
            .getOrElse { runCatching { f.getInteger(MediaFormat.KEY_FRAME_RATE).toDouble() }.getOrNull() }
            ?.takeIf { it > 0.0 } ?: return ""
        return if (kotlin.math.abs(fps - Math.round(fps)) < 0.05) "${Math.round(fps)} fps"
        else String.format(java.util.Locale.US, "%.2f fps", fps)
    }

    /** `KEY_DURATION` 在不同容器里可能是 Long 也可能是 Integer，两种都试。 */
    private fun mediaFormatDurationUs(f: MediaFormat): Long =
        runCatching { f.getLong(MediaFormat.KEY_DURATION) }
            .getOrElse { runCatching { f.getInteger(MediaFormat.KEY_DURATION).toLong() }.getOrNull() }
            ?.takeIf { it > 0 } ?: 0L

    /** 整只文件的平均码率优先（与桌面 `OverallBitRate` 同源），拿不到才用单轨声明值。 */
    private fun bitRateBps(f: MediaFormat, durationUs: Long, sizeBytes: Long): Long {
        if (sizeBytes > 0 && durationUs > 0) return sizeBytes * 8L * 1_000_000L / durationUs
        return runCatching { f.getInteger(MediaFormat.KEY_BIT_RATE).toLong() }.getOrDefault(0L)
    }

    /** 逐条对齐桌面端 `src/utils/mediaExtensions.ts::formatBitRate`（≥1e6 → Mbps 一位小数）。 */
    private fun formatBitRate(bps: Long): String = when {
        bps <= 0 -> ""
        // 固定 Locale.US：小数点必须是「.」，与桌面 `toFixed(1)` 同形，不随系统语言变逗号
        bps >= 1_000_000 -> String.format(java.util.Locale.US, "%.1f Mbps", bps / 1_000_000.0)
        else -> "${maxOf(1L, Math.round(bps / 1000.0))} kbps"
    }
}
