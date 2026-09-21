package com.aurora.gallery.kotlin.viewer

import uniffi.aurora_core.FfiFileMetadata
import uniffi.aurora_core.Image
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * 库里的 [Image] → 查看器的 [NativeGalleryView.ImageItem]（M3 2.1 的字段对照）。
 *
 * 取图优先走 `contentUri`：Scoped Storage 下库里的 `path` 未必可读，而 MediaStore 的 URI
 * 恒经 ContentResolver 授权。查看器的 `path` 字段在 React 版承载本地路径与 LAN 的 HTTP URL
 * 两种语义，M3 不做 LAN（M6），留空。
 *
 * 标签与元数据由调用方从 `GalleryViewModel` 的标签快照传入（M4a 2.2），本文件不查库。
 * palette / aiTags / aiDescription / aiSceneCategory / aiObjects 仍是空态：主色调提取与
 * AI 打标属 M6。
 */
internal fun Image.toViewerItem(
    parentName: String = "",
    tags: List<String> = emptyList(),
    metadata: FfiFileMetadata? = null,
) = NativeGalleryView.ImageItem(
    // 与 contentUri 同值：`Listener.onShare(filePath)` 只带这一个串，宿主要靠它拉起分享面板；
    // 取图不受影响（resolveLoadData 优先走 contentUri，File 分支只在 contentUri 为空时才碰）。
    path = contentUri,
    fileId = id,
    name = name,
    width = width?.toInt() ?: 0,
    height = height?.toInt() ?: 0,
    isLan = false,
    thumbnailUrl = null,
    contentUri = contentUri,
    size = size,
    format = format.orEmpty(),
    createdAt = formatIso(createdAt),
    updatedAt = formatIso(modifiedAt),
    parentName = parentName,
    tags = tags,
    description = metadata?.description.orEmpty(),
    sourceUrl = metadata?.sourceUrl.orEmpty(),
)

/**
 * epoch 秒 → ISO-8601。抽屉的 `formatDate` 是按 `'T'` 截取 `YYYY-MM-DD` 显示的，
 * 所以这里必须带 T，否则它会退化成「取前 10 个字符」显示成错误的串。
 *
 * 0 表示库里没有这个时间（React 版同样以 0 为哨兵），返回空串让抽屉显示「—」。
 */
private val isoFormat = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", Locale.US)

private fun formatIso(epochSeconds: Long): String =
    if (epochSeconds <= 0L) "" else isoFormat.format(Date(epochSeconds * 1000L))
