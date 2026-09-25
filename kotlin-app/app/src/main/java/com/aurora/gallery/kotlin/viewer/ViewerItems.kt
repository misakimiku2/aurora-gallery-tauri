package com.aurora.gallery.kotlin.viewer

import com.aurora.gallery.kotlin.LanMetadataItem
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
 * 两种语义：**LAN 项（M6a 阶段 4）的 `path` 装大图 URL**（token 进 query），`thumbnailUrl`
 * 装缩略图 URL，`fileId` = 远端 path（数据层映射时 Image.id = 远端 path，身份铁律）。
 *
 * 标签与元数据由调用方从 `GalleryViewModel` 的标签快照传入（M4a 2.2），本文件不查库。
 * palette / aiTags / aiDescription / aiSceneCategory / aiObjects 仍是空态（M6b）。
 */
internal fun Image.toViewerItem(
    parentName: String = "",
    tags: List<String> = emptyList(),
    metadata: FfiFileMetadata? = null,
    /**
     * 远端元数据行（M6a 阶段 5）：fileId（=远端 path）→ [LanMetadataItem]。**仅 isLan 项
     * 消费**（抽屉的标签/描述/来源三行改取这里）；本地项传 null。调用方（ViewerLayerHost）
     * 已按 isLan 显式分流，isLan 项不会把本地快照传进来。
     */
    lanMetadata: LanMetadataItem? = null,
    /**
     * LAN 大图 URL 构造器（M6a 阶段 4）：远端 path → imageUrl；未连接为 null（此时 LAN
     * 大图只能失败兜底——断线联动会自动退回本地视图，正常到不了这里）。
     */
    lanImageUrlOf: ((String) -> String)? = null,
) = run {
    // 数据驱动的 LAN 判定：映射时 contentUri 装的是缩略图 URL（本地图恒为 content://）
    val isLan = contentUri.startsWith("http")
    NativeGalleryView.ImageItem(
        // 本地：与 contentUri 同值（onShare 靠它拉起分享面板）；LAN：大图 URL（查看器
        // LAN 分支的取图源）。LAN 的分享按钮有 !isLan 拦截，path 不会被当成本地路径用。
        path = if (isLan) lanImageUrlOf?.invoke(id).orEmpty() else contentUri,
        fileId = id,
        name = name,
        width = width?.toInt() ?: 0,
        height = height?.toInt() ?: 0,
        isLan = isLan,
        thumbnailUrl = contentUri.takeIf { isLan },
        // LAN 置空：contentUri 的本地图语义（ContentResolver 开流）不适用于 http URL，
        // 免得任何本地兜底分支把 URL 误当 URI 用。
        contentUri = if (isLan) "" else contentUri,
        size = size,
        format = format.orEmpty(),
        createdAt = formatIso(createdAt),
        updatedAt = formatIso(modifiedAt),
        parentName = parentName,
        // 显式 isLan 分支（D31 铁律的 UI 半边）：远端项的标签/描述/来源**只**来自
        // [lanMetadata]，参数位上的本地快照结构上就不会被读；本地项照旧读本地行。
        tags = if (isLan) lanMetadata?.tags.orEmpty() else tags,
        description = if (isLan) lanMetadata?.description.orEmpty() else metadata?.description.orEmpty(),
        sourceUrl = if (isLan) lanMetadata?.sourceUrl.orEmpty() else metadata?.sourceUrl.orEmpty(),
        // M6b 阶段 2：AI 字段从本地 metadata.aiData 解析（TS 写入形状见 core ai.rs——
        // tags/sceneCategory/objects/description；LAN 项无远端 aiData，恒空=抽屉整节隐藏）
        aiTags = if (isLan) emptyList() else aiDataStrings(metadata, "tags"),
        aiDescription = if (isLan) "" else aiDataString(metadata, "description"),
        aiSceneCategory = if (isLan) "" else aiDataString(metadata, "sceneCategory"),
        aiObjects = if (isLan) emptyList() else aiDataStrings(metadata, "objects"),
    )
}

/** aiData JSON 的字符串字段（缺键/非串→空串）。 */
private fun aiDataString(metadata: FfiFileMetadata?, key: String): String =
    aiDataObject(metadata)?.optString(key, "").orEmpty()

/** aiData JSON 的字符串数组字段（缺键/非数组→空表）。 */
private fun aiDataStrings(metadata: FfiFileMetadata?, key: String): List<String> {
    val arr = aiDataObject(metadata)?.optJSONArray(key) ?: return emptyList()
    return (0 until arr.length()).mapNotNull { arr.optString(it).takeIf { s -> s.isNotEmpty() } }
}

private fun aiDataObject(metadata: FfiFileMetadata?): org.json.JSONObject? =
    metadata?.aiData?.takeIf { it.isNotEmpty() }?.let {
        runCatching { org.json.JSONObject(it) }.getOrNull()
    }

/**
 * epoch 秒 → ISO-8601。抽屉的 `formatDate` 是按 `'T'` 截取 `YYYY-MM-DD` 显示的，
 * 所以这里必须带 T，否则它会退化成「取前 10 个字符」显示成错误的串。
 *
 * 0 表示库里没有这个时间（React 版同样以 0 为哨兵），返回空串让抽屉显示「—」。
 */
private val isoFormat = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", Locale.US)

private fun formatIso(epochSeconds: Long): String =
    if (epochSeconds <= 0L) "" else isoFormat.format(Date(epochSeconds * 1000L))
