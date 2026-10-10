package com.aurora.gallery.kotlin

import android.content.ContentUris
import android.content.ContentValues
import android.os.Build
import android.provider.MediaStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import uniffi.aurora_core.Folder
import uniffi.aurora_core.listImagesByIds

// 2026-10-10 从 `GalleryViewModel.kt` 拆出（第 11 刀）：「写操作的乐观内存更新」与
// 「文件夹活动时间」两簇整体搬到这里，用**扩展函数**落（套路同 GalleryViewModelFileOps.kt
// ——Kotlin 没有 partial class）。只搬 `fun`；状态字段（folderActivityPrefs / folderActivityAt）
// 与原类 init 块留在原类（folderActivityPrefs 降为 internal 供本文件用；init 块调用本文件的
// [loadFolderActivity]，故它是 internal 而非 private）。三个常量只服务本文件，落成顶层 private const。

/** 文件夹活动表的 SharedPreferences key（JSON: folderId → epoch 秒）。 */
private const val FOLDER_ACTIVITY_KEY = "activity"

/** 活动时间的保留窗口：超过则视为沉寂，排序回落到内容时间。 */
private const val FOLDER_ACTIVITY_TTL_SEC = 30L * 24 * 3600

/** 活动时间表上限（按时间倒序保留最新的，防无限增长）。 */
private const val FOLDER_ACTIVITY_MAX_ENTRIES = 1000

// ===== 写操作的乐观内存更新 =====
//
// 网格数据 = [images]（Compose State）；对账要把 MediaStore 快照写进索引再重查，
// 26k 行上要数秒——写操作先改这份内存列表让 UI 当帧反映，对账完成后的 reloadImages
// 用权威数据覆盖（幂等）。只动 [images]，imagesCacheByKey 留给对账修正（乐观改缓存
// 要考虑视图 key 语义，收益配不上风险）。

/** content uri → MediaStore _id（external / external_primary 两种字符串拼法都归一）。 */
private fun GalleryViewModel.mediaIdOf(uri: android.net.Uri): Long? =
    runCatching { ContentUris.parseId(uri) }.getOrNull()

/** 删除/移出：把命中的项从当前网格移除（标签/专题视图同样移除——文件已不存在）。 */
// internal 而非 private：文件操作簇在 GalleryViewModelFileOps.kt（扩展函数）里要用
internal fun GalleryViewModel.optimisticRemoveFromGrid(uris: List<android.net.Uri>) {
    if (uris.isEmpty()) return
    val ids = uris.mapNotNull { mediaIdOf(it) }.toHashSet()
    if (ids.isEmpty()) return
    val cur = images.value
    val filtered = cur.filter { img -> mediaIdOf(android.net.Uri.parse(img.contentUri)) !in ids }
    if (filtered.size != cur.size) images.value = filtered
}

/** 重命名：就地更新命中项的显示名（_id 不变或 Q 文件路径版 _id 变化都由对账收尾）。 */
// internal 而非 private：文件操作簇在 GalleryViewModelFileOps.kt（扩展函数）里要用
internal fun GalleryViewModel.optimisticRenameInGrid(targets: List<Pair<android.net.Uri, String>>) {
    if (targets.isEmpty()) return
    val byId = targets.mapNotNull { (uri, _) -> mediaIdOf(uri) }.toHashSet()
    if (byId.isEmpty()) return
    val nameById = targets.associate { (uri, name) -> mediaIdOf(uri) to name }
    images.value = images.value.map { img ->
        val id = mediaIdOf(android.net.Uri.parse(img.contentUri))
        if (id != null && id in byId) img.copy(name = nameById[id] ?: img.name) else img
    }
}

/** file_id → content uri（FFI 索引为源，概览页 stale 的 images.value 不掺和）。 */
// internal 而非 private：文件操作簇在 GalleryViewModelFileOps.kt（扩展函数）里要用
internal suspend fun GalleryViewModel.resolveUris(fileIds: Collection<String>): List<Pair<String, android.net.Uri>> =
    withContext(Dispatchers.IO) {
        val byId = listImagesByIds(fileIds.toList()).associateBy { it.id }
        fileIds.mapNotNull { id -> byId[id]?.let { id to android.net.Uri.parse(it.contentUri) } }
    }

/** 源行的 DISPLAY_NAME（API < 29 移动时拼 DATA 用）。 */
// internal 而非 private：文件操作簇在 GalleryViewModelFileOps.kt（扩展函数）里要用
internal fun GalleryViewModel.queryDisplayName(uri: android.net.Uri): String? =
    appContext.contentResolver.query(
        uri,
        arrayOf(MediaStore.Images.Media.DISPLAY_NAME),
        null, null, null,
    )?.use { if (it.moveToFirst()) it.getString(0) else null }

/** insert 一行并返回新 uri（携带源的尺寸/日期等列；[overrideName] 覆盖 DISPLAY_NAME；R+ 走 VOLUME_EXTERNAL_PRIMARY）。 */
// internal 而非 private：文件操作簇在 GalleryViewModelFileOps.kt（扩展函数）里要用
internal fun GalleryViewModel.insertImageCopy(
    source: android.net.Uri,
    relPath: String,
    overrideName: String? = null,
): android.net.Uri? {
    val resolver = appContext.contentResolver
    val projection = arrayOf(
        MediaStore.Images.Media.DISPLAY_NAME,
        MediaStore.Images.Media.MIME_TYPE,
        MediaStore.Images.Media.WIDTH,
        MediaStore.Images.Media.HEIGHT,
        MediaStore.Images.Media.SIZE,
        MediaStore.Images.Media.DATE_ADDED,
        MediaStore.Images.Media.DATE_MODIFIED,
    )
    // 诊断：query 返回 null / 空 cursor / DISPLAY_NAME 为 null 三种路径原先都只报
    // 一句「insert null (source query empty)」，无法区分；insert 返回 null（华为
    // 对部分 insert 不抛异常直接回 null）也会走到同一句。逐分支落盘定位。
    val cursor = resolver.query(source, projection, null, null, null)
    if (cursor == null) {
        debugLog("insertImageCopy: query NULL source=$source relPath=$relPath")
        return null
    }
    cursor.use { c ->
        if (!c.moveToFirst()) {
            debugLog("insertImageCopy: cursor EMPTY source=$source relPath=$relPath")
            return null
        }
        val name = overrideName ?: c.getString(0)
        if (name == null) {
            debugLog("insertImageCopy: DISPLAY_NAME null source=$source relPath=$relPath")
            return null
        }
        val values = ContentValues().apply {
            put(MediaStore.Images.Media.DISPLAY_NAME, name)
            if (!c.isNull(1)) put(MediaStore.Images.Media.MIME_TYPE, c.getString(1))
            if (!c.isNull(2)) put(MediaStore.Images.Media.WIDTH, c.getInt(2))
            if (!c.isNull(3)) put(MediaStore.Images.Media.HEIGHT, c.getInt(3))
            put(MediaStore.Images.Media.SIZE, if (c.isNull(4)) 0L else c.getLong(4))
            if (!c.isNull(5)) put(MediaStore.Images.Media.DATE_ADDED, c.getLong(5))
            if (!c.isNull(6)) put(MediaStore.Images.Media.DATE_MODIFIED, c.getLong(6))
            if (Build.VERSION.SDK_INT >= 29) {
                put(MediaStore.Images.Media.RELATIVE_PATH, relPath)
            } else {
                put(MediaStore.Images.Media.DATA, legacyDataPath(relPath, name))
            }
        }
        val collection = if (Build.VERSION.SDK_INT >= 29) {
            MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
        } else {
            MediaStore.Images.Media.EXTERNAL_CONTENT_URI
        }
        val inserted = resolver.insert(collection, values)
        debugLog(
            "insertImageCopy: insert source=$source collection=$collection " +
                "relPath=$relPath name=$name mime=${values.getAsString(MediaStore.Images.Media.MIME_TYPE)} " +
                "result=${inserted ?: "NULL"}",
        )
        return inserted
    }
}

/** API < 29 的目标全路径（共享存储根 + RELATIVE_PATH 语义 + 文件名）。 */
// internal 而非 private：文件操作簇在 GalleryViewModelFileOps.kt（扩展函数）里要用
internal fun GalleryViewModel.legacyDataPath(relPath: String, name: String): String {
    val base = android.os.Environment.getExternalStorageDirectory().absolutePath
    return "$base/$relPath/$name"
}

// ===== 文件夹活动时间（「操作过就排前面」的排序语义）=====
//
// 按时间排序的口径原本是「内容最新时间」（直接子图 MAX(date_added)，两端刻意
// 对齐）：复制文件进文件夹 → 内容时间=现在 → 排前面 ✓；但删掉该文件 → 内容时间
// 掉回剩余最新图 → 文件夹被排到后面 ✗。用户体感：「我明明刚操作过这个文件夹」。
//
// 活动时间：写操作（复制进/删除/移动/重命名）成功时把涉及文件夹的活动时间戳为
// 当前，总览排序键 = max(内容最新时间, 活动时间)（GridModels.sortFolders 的
// activityAt 参数）——删除也能托在前面，与文件系统里「目录 mtime 随增删改更新」
// 的直觉一致。只改安卓（桌面端内容时间语义不变，2026-10-08 用户拍板）。
//
// 持久化 SharedPreferences（跨重启保留；30 天前的活动自然过期让位内容时间，
// 上限 1000 条防无限增长）。与对账幂等：对账只重算内容时间，活动时间是独立的
// 叠加层，不会被覆盖。

internal fun GalleryViewModel.loadFolderActivity(): Map<String, Long> {
    val raw = folderActivityPrefs.getString(FOLDER_ACTIVITY_KEY, null) ?: return emptyMap()
    val cutoff = System.currentTimeMillis() / 1000 - FOLDER_ACTIVITY_TTL_SEC
    return runCatching {
        val obj = JSONObject(raw)
        val out = HashMap<String, Long>()
        for (key in obj.keys()) {
            val v = obj.optLong(key, 0L)
            if (v > cutoff) out[key] = v
        }
        out
    }.getOrDefault(emptyMap())
}

/** 把涉及文件夹的活动时间戳为当前（只增不减：后到的操作盖先前的）。 */
// internal 而非 private：Q 路径原语簇已拆到 GalleryViewModelQPaths.kt（扩展函数）里要用
internal fun GalleryViewModel.bumpFolderActivity(folderIds: Collection<String>) {
    if (folderIds.isEmpty()) return
    val nowSec = System.currentTimeMillis() / 1000
    val merged = (folderActivityAt.value + folderIds.associateWith { nowSec })
        .toList()
        .sortedByDescending { it.second }
        .take(FOLDER_ACTIVITY_MAX_ENTRIES)
        .toMap()
    folderActivityAt.value = merged
    runCatching {
        val obj = JSONObject()
        merged.forEach { (id, at) -> obj.put(id, at) }
        folderActivityPrefs.edit().putString(FOLDER_ACTIVITY_KEY, obj.toString()).apply()
    }
    debugLog("folderActivity: bump n=${folderIds.size} at=$nowSec ids=$folderIds")
}

/**
 * 写操作前后 [folders] 快照对比：聚合发生变化（计数/封面/时间戳任一不同）的文件夹
 * 就是被操作过的，活动时间戳当前。删除/移动的源与目标都由此覆盖（计数一减一增），
 * 无需知道具体动了哪些文件；重命名不改变聚合，不在此列。
 *
 * 调用时机：操作的即时收尾（索引摘行/新行入库 + [refreshFolderCards]）之后，
 * [before] 传操作前的快照。
 */
// internal 而非 private：Q 路径原语簇已拆到 GalleryViewModelQPaths.kt（扩展函数）里要用
internal fun GalleryViewModel.bumpActivityForChangedFolders(before: List<Folder>) {
    val beforeById = before.associateBy { it.id }
    val changed = folders.value.filter { f ->
        val old = beforeById[f.id]
        old == null || old.imageCount != f.imageCount || old.coverUri != f.coverUri ||
            old.createdAt != f.createdAt || old.modifiedAt != f.modifiedAt
    }.map { it.id }
    bumpFolderActivity(changed)
}
