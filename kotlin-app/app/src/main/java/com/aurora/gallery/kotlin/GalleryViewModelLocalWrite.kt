package com.aurora.gallery.kotlin

import android.content.ContentUris
import android.content.ContentValues
import android.os.Build
import android.provider.MediaStore
import android.util.Log
import android.widget.Toast
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import uniffi.aurora_core.Folder
import uniffi.aurora_core.deleteIndexEntries
import uniffi.aurora_core.generateId
import uniffi.aurora_core.listImagesByIds
import uniffi.aurora_core.upsertMediaImage

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
 * 文件夹重命名的活动时间**过户**（2026-11-18）：旧 folder id 的活动时间原值挪给新 id。
 * 排序键 = max(内容最新时间, 活动时间)，改名不 bump（[GalleryViewModelFileOps.moveFiles]
 * 的 bumpActivity=false）也不丢历史活动——旧 id 若有活动记录（此前复制/删除过文件），
 * 不过户的话卡片会从「活动托起的位置」跌回内容时间位置，改名前后位置还是变了。
 * 旧 id 无记录时不动（多数文件夹没有活动层，位置本来就只由内容时间决定）。
 */
// internal 而非 private：宿主收尾簇在 MainActivityFileOps.kt（扩展函数）里要用
internal fun GalleryViewModel.transferFolderActivity(oldId: String, newId: String) {
    if (oldId == newId) return
    val at = folderActivityAt.value[oldId] ?: return
    val merged = (folderActivityAt.value - oldId) + (newId to at)
    folderActivityAt.value = merged
    runCatching {
        val obj = JSONObject()
        merged.forEach { (id, t) -> obj.put(id, t) }
        folderActivityPrefs.edit().putString(FOLDER_ACTIVITY_KEY, obj.toString()).apply()
    }
    debugLog("folderActivity: transfer $oldId -> $newId at=$at")
}

/**
 * 文件夹改名内容时间保真的**终棒**（每次全量对账 upsert 之后、listFolders 聚合之前
 * 调，2026-11-18 四轮）：按 [GalleryViewModel.renamedRowStamps] 登记表把改前行时间戳
 * 重灌回索引。为什么需要：legacy 重建行的 DATE_ADDED 无法经 update 写回（provider 对
 * app 丢弃该列，实测探针 +1s 已是登记时刻），对账 upsert 每轮都会把登记时刻灌进
 * created_at → 时间排序键 max(createdAt, 活动) 跳到 now → 改名文件夹置顶；本函数在
 * 聚合前纠正，跳变对用户不可见。行消失（文件夹被删/路径再变）时惰性注销登记。
 */
// internal 而非 private：scanAndReconcileInner（GalleryViewModel.kt）要调
internal fun GalleryViewModel.reapplyRenamedRowStamps() {
    if (renamedRowStamps.isEmpty()) return
    val it = renamedRowStamps.entries.iterator()
    var fixed = 0
    while (it.hasNext()) {
        val entry = it.next()
        val rowUri = queryRowUriByDataPath(entry.key)
        if (rowUri == null) {
            it.remove()
            continue
        }
        val img = runCatching { mediaImageOf(rowUri) }.getOrNull()
        if (img == null) {
            it.remove()
            continue
        }
        if (img.dateModified != entry.value.modified || img.dateAdded != entry.value.added) {
            runCatching {
                upsertMediaImage(img.copy(dateModified = entry.value.modified, dateAdded = entry.value.added))
            }
            fixed++
        }
    }
    if (fixed > 0) debugLog("reapplyRenamedRowStamps: fixed=$fixed registered=${renamedRowStamps.size}")
}

/**
 * 死行全量审计（2026-11-18，用户 QQ→QQid 实案驱动）：把媒体库里「记录在案但文件早已
 * 不存在」的行清出去。为什么需要：这台设备（EMUI Q legacy）的 MediaProvider **从不
 * 清理死行**（MmsCamera 2020 年的行躺到 2026），而应用按记录列表渲染、不验文件存在
 * → 幽灵文件夹可以显示数年；改名碰到全死行 = 死行清理 + 卡片就地消失，用户当数据
 * 丢失报障。审计让应用视图对齐其他应用（图库/文件管理都验存在，早就不显示死行）。
 *
 * 时机：授权后的首次对账跑一次（SP 无记录即跑），之后每 30 天一次；返回值 -1 = 未
 * 到期跳过。改名/搬移进行中（renameBridges/renamedRowStamps 非空）**必须跳过**——
 * 搬移中的行 _data 尚在旧路径而文件已到新路径，验存在会误判死行、把活行当尸体清掉。
 * 只审计主卷（/storage/emulated/0/）：外置卷卸载时 exists()=false 会误杀活行。
 * 删除与 moveFiles 死行分支同口径（媒体库行 + 索引行都摘；文件本就不存在 → EMUI
 * 拦截无事可拦，QQ 实案 54 条死行删除全程零通知）。SP 旗标在**跑完后**落——中断
 * （进程被杀）下次重跑幂等，已清的行自然跳过。
 */
// internal 而非 private：scanAndReconcileInner（GalleryViewModel.kt）要调
internal suspend fun GalleryViewModel.auditDeadMediaRows(): Int = withContext(Dispatchers.IO) {
    if (renameBridges.isNotEmpty() || renamedRowStamps.isNotEmpty()) return@withContext -1
    val prefs = appContext.getSharedPreferences("aurora_dead_row_audit", android.content.Context.MODE_PRIVATE)
    val last = prefs.getLong("lastAt", 0L)
    if (last != 0L && System.currentTimeMillis() - last < 30L * 24 * 3600 * 1000) return@withContext -1
    val root = android.os.Environment.getExternalStorageDirectory().absolutePath + "/"
    var dead = 0
    val t0 = android.os.SystemClock.elapsedRealtime()
    for (coll in listOf(
        MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
        MediaStore.Video.Media.EXTERNAL_CONTENT_URI,
    )) {
        runCatching {
            appContext.contentResolver.query(
                coll,
                arrayOf(MediaStore.MediaColumns._ID, MediaStore.MediaColumns.DATA),
                null, null, null,
            )?.use { c ->
                val idCol = c.getColumnIndexOrThrow(MediaStore.MediaColumns._ID)
                val dataCol = c.getColumnIndexOrThrow(MediaStore.MediaColumns.DATA)
                while (c.moveToNext()) {
                    val data = c.getString(dataCol) ?: continue
                    if (!data.startsWith(root)) continue
                    if (java.io.File(data).exists()) continue
                    val uri = ContentUris.withAppendedId(coll, c.getLong(idCol))
                    val removed = runCatching { appContext.contentResolver.delete(uri, null, null) }
                        .onFailure { Log.w(GalleryViewModel.TAG, "[DeadRowAudit] delete failed: $uri", it) }
                        .getOrDefault(0)
                    if (removed > 0) {
                        dead++
                        runCatching { deleteIndexEntries(listOf(generateId(uri.toString()))) }
                        if (dead % 200 == 0) debugLog("[DeadRowAudit] progress dead=$dead")
                    }
                }
            }
        }.onFailure { Log.w(GalleryViewModel.TAG, "[DeadRowAudit] collection scan failed: $coll", it) }
    }
    prefs.edit().putLong("lastAt", System.currentTimeMillis()).apply()
    debugLog("[DeadRowAudit] done dead=$dead cost=${android.os.SystemClock.elapsedRealtime() - t0}ms")
    dead
}

/**
 * 桥接卡片合并（2026-11-18 五/六轮）：文件夹改名是逐行迁移（大文件夹 ~10s），期间
 * 索引处于半迁移态——本函数让所有 listFolders 驱动的刷新（refreshFolderCards 与对账
 * 聚合两个调用点）对迁移无感：摘除正在退场的旧壳卡（按桥接 key=旧 id）、补回桥接卡
 * （新名/新路径/旧计数封面时间恒定显示）。「新路径真身落地 + 旧路径壳退场」同时满足
 * 时桥接自愈清除（真身 = 对账建的新 Folder 行，stamps 已被 reapplyRenamedRowStamps
 * 纠正，位置/计数/封面全对）。删除文件夹流程无条件清空桥接表（防僵尸卡片）。
 */
// internal 而非 private：refreshFolderCards（QPaths）与 scanAndReconcileInner（本类）要调
internal fun GalleryViewModel.mergeRenameBridge(list: List<Folder>): List<Folder> {
    if (renameBridges.isEmpty()) return list
    var out = list
    val entries = renameBridges.entries.iterator()
    var touched = false
    while (entries.hasNext()) {
        val en = entries.next()
        val bridge = en.value
        val newIn = out.any { it.path == bridge.card.path }
        val oldGone = out.none { it.path == bridge.oldPath }
        if (newIn && oldGone) {
            // 真身落地 + 旧壳退场：桥接完成，真身已在列表里
            entries.remove()
            touched = true
            // 十一轮：settle 时若用户正看着旧 id 的文件夹（改名迁移期进入的），视图
            // 原位接管到真身 id 并重载——否则对账摘掉旧行后正看着的网格停在空态，
            // 得返回再进才恢复（313 张实案）。接管是原位换 id 不推栈（返回键语义不变）。
            val realId = out.firstOrNull { it.path == bridge.card.path }?.id
            if (realId != null && appState.repointFolderView(en.key, realId)) {
                debugLog("renameBridge: view repointed ${en.key} -> $realId")
                viewModelScope.launch { reloadImages() }
            }
            continue
        }
        // 迁移中：旧壳摘除 + 桥接卡补回（列表里已有同路径卡=合并进既有相册的场景，不重复加）
        out = out.filter { it.id != en.key }
        if (out.none { it.path == bridge.card.path }) out = out + listOf(bridge.card)
        touched = true
    }
    if (touched) debugLog("renameBridge: active=${renameBridges.size} list=${out.size}")
    return out
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
