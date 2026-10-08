package com.aurora.gallery.kotlin

import android.util.Log
import androidx.lifecycle.viewModelScope
import com.aurora.gallery.kotlin.state.localPersonFolderId
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import uniffi.aurora_core.FfiFaceBox
import uniffi.aurora_core.FfiFileMetadata
import uniffi.aurora_core.FfiPerson
import uniffi.aurora_core.Image
import uniffi.aurora_core.deletePerson
import uniffi.aurora_core.getAllPeople
import uniffi.aurora_core.getFileMetadata
import uniffi.aurora_core.listImagesByIds
import uniffi.aurora_core.updatePersonAvatar
import uniffi.aurora_core.upsertFileMetadata
import uniffi.aurora_core.upsertPerson
import java.util.UUID

// ===== 本地人物：手动维护（新建 / 重命名 / 删除 / 加图 / 进筛选）=====
//
// 2026-10-09 从 `GalleryViewModel.kt` 拆出：那个文件 5000 行装了二十来个职责簇，人物
// 这一簇（约 480 行）整体搬到这里，用**扩展函数**落——Kotlin 没有 partial class，扩展
// 是唯一能「不动结构就把一个类的成员摊到多个文件」的手段，往后其它簇也能照此搬。
//
// 桌面 usePeople.ts 的**手动那一半**移植过来；WD14/CLIP 那一半（智能创建、智能
// 添加、characterTagName/Index、筛选的标签兜底）不移植——本机没有那套模型。
//
// 人物↔图片的关系存在 `file_metadata.aiData.faces[]`（不是独立关联表），这是桌面
// 的既有口径：手动添加也写同一个数组，`confidence:1.0`、`box` 全 0（没有检测框可
// 言）。沿用它的收益是筛选/计数/备份导出与桌面完全同构，代价是每次加图都要对
// aiData 整行读改写（upsertFileMetadata 是整行 ON CONFLICT DO UPDATE，拿半空行
// 写会把别列冲掉——纪律同 saveFileUpdates）。

/** 重拉本地人物快照（[localPeople]；失败保留旧列表——快照纪律同 [reloadTagState]）。 */
fun GalleryViewModel.reloadLocalPeople() {
    viewModelScope.launch { refreshLocalPeople() }
}

/** [reloadLocalPeople] 的挂起版：写库后接着调，onDone 回调时列表已是新值。 */
internal suspend fun GalleryViewModel.refreshLocalPeople() {
    val loaded = withContext(Dispatchers.IO) { runCatching { getAllPeople() } }
    val list = loaded.getOrNull()
    if (list == null) {
        Log.w(GalleryViewModel.TAG, "[People] 本地人物快照重拉失败（保旧）：${loaded.exceptionOrNull()?.message ?: "unknown"}")
        return
    }
    localPeople.value = list
    // 封面一次取齐（形制同 reloadTopics 的 coverImagesById）：真头像要把
    // person.coverFileId 换成 contentUri 才进得了 ThumbnailLoader。已删除的封面图
    // listImagesByIds 静默跳过 → 该人物退回首字符占位。
    val coverIds = list.map { it.coverFileId }.filter { it.isNotEmpty() }.distinct()
    personCoverImagesById.value =
        if (coverIds.isEmpty()) {
            emptyMap()
        } else {
            withContext(Dispatchers.IO) {
                runCatching { listImagesByIds(coverIds) }
                    .onFailure { Log.w(GalleryViewModel.TAG, "[People] 封面批读失败：${it.message}") }
                    .getOrDefault(emptyList())
            }.associateBy { it.id }
        }
    // 诊断（2026-10-08 头像不出来的排查）：请求了几个封面、解析回来几个，
    // 两个数不一致就是 list_images_by_ids 那一层丢的
    debugLog(
        "refreshLocalPeople: people=${list.size} coverIds=${coverIds.size} " +
            "resolved=${personCoverImagesById.value.size}",
    )
}

/**
 * 新建人物 id：`person_` + 16 位十六进制。与 WD14 产物的 `person_<tag>` 同前缀，
 * 但后缀形态不可能撞上标签名（标签是小写词 + 下划线），日志里也一眼分得出来源。
 */
internal fun GalleryViewModel.newPersonId() =
    "person_" + UUID.randomUUID().toString().replace("-", "").take(16)

/** 人物行的 updatedAt 口径：秒（对齐 WD14 管线与桌面 strftime('%s','now')）。 */
internal fun GalleryViewModel.personNow() = System.currentTimeMillis() / 1000

/**
 * 新建本地人物（桌面 handleConfirmCreatePerson 同口径：只有 name，coverFileId 空、
 * count 0、无描述无头像框）。空名不建——桌面前端拦一道，VM 是多入口的，再拦一道。
 */
fun GalleryViewModel.createLocalPerson(name: String, onDone: (Boolean) -> Unit = {}) {
    val trimmed = name.trim()
    if (trimmed.isEmpty()) {
        onDone(false)
        return
    }
    viewModelScope.launch {
        val ok = withContext(Dispatchers.IO) {
            runCatching {
                upsertPerson(
                    FfiPerson(
                        id = newPersonId(),
                        name = trimmed,
                        coverFileId = "",
                        count = 0,
                        description = null,
                        faceBox = null,
                        updatedAt = personNow(),
                        characterTagName = null,
                        characterTagIndex = null,
                    ),
                )
            }.onFailure { Log.w(GalleryViewModel.TAG, "[People] 新建失败 name=$trimmed：${it.message}") }.isSuccess
        }
        if (ok) refreshLocalPeople()
        debugLog("createLocalPerson: name=$trimmed ok=$ok")
        onDone(ok)
    }
}

/**
 * 重命名本地人物。整行读改写：从 [localPeople] 快照取原行只换 name——upsert 是
 * 整行写，凭空造一行会把封面/计数/描述/头像框全冲成默认值。快照里没有该 id 直接
 * 失败返回（不猜、不建）。
 */
fun GalleryViewModel.renameLocalPerson(personId: String, name: String, onDone: (Boolean) -> Unit = {}) {
    val trimmed = name.trim()
    val current = localPeople.value.firstOrNull { it.id == personId }
    if (trimmed.isEmpty() || current == null) {
        onDone(false)
        return
    }
    viewModelScope.launch {
        val ok = withContext(Dispatchers.IO) {
            runCatching { upsertPerson(current.copy(name = trimmed, updatedAt = personNow())) }
                .onFailure { Log.w(GalleryViewModel.TAG, "[People] 重命名失败 id=$personId：${it.message}") }
                .isSuccess
        }
        if (ok) refreshLocalPeople()
        onDone(ok)
    }
}

/**
 * 改本地人物描述（空串 = 清空，口径同远端人物的 allowEmpty）。
 */
fun GalleryViewModel.describeLocalPerson(personId: String, description: String, onDone: (Boolean) -> Unit = {}) {
    val current = localPeople.value.firstOrNull { it.id == personId } ?: run { onDone(false); return }
    viewModelScope.launch {
        val ok = withContext(Dispatchers.IO) {
            runCatching {
                upsertPerson(
                    current.copy(
                        description = description.trim().takeIf { it.isNotEmpty() },
                        updatedAt = personNow(),
                    ),
                )
            }.onFailure { Log.w(GalleryViewModel.TAG, "[People] 改描述失败 id=$personId：${it.message}") }.isSuccess
        }
        if (ok) refreshLocalPeople()
        onDone(ok)
    }
}

/**
 * 删除本地人物：删 persons 行 + 把各文件 `aiData.faces` 里指向它的条目摘干净。
 *
 * 桌面 `handleDeletePerson` **只删 persons 行**，faces 里的孤儿条目原地留着（筛选按
 * personId 走所以肉眼看不出来，但备份导出与「清除人物信息」的口径就脏了）。这里
 * 顺手清干净：只碰 aiData 里真含该 id 的行（子串预筛，同 [localPersonMemberIds]），
 * 其余文件零写入。
 *
 * 删掉的人物如果正被当前视图筛着，退到上一级——不然网格停在一个 id 已不存在的
 * 虚拟目录上，返回键之前一直是个看不懂的空列表。
 */
fun GalleryViewModel.deleteLocalPerson(personId: String, onDone: (Boolean) -> Unit = {}) {
    viewModelScope.launch {
        val ok = withContext(Dispatchers.IO) {
            runCatching { deletePerson(personId) }
                .onFailure { Log.w(GalleryViewModel.TAG, "[People] 删除失败 id=$personId：${it.message}") }
                .isSuccess
        }
        if (ok) {
            val stripped = withContext(Dispatchers.IO) { stripPersonFromFaces(personId) }
            debugLog("deleteLocalPerson: id=$personId 清 faces 的文件数=$stripped")
            refreshLocalPeople()
            if (appState.activeTab.folderId == localPersonFolderId(personId)) appState.goBack()
            reloadTagState()
            reloadImages()
        }
        onDone(ok)
    }
}

/**
 * 从全库 aiData.faces 摘掉指向 [personId] 的条目，返回被改写的文件数。
 * 只在真的删掉了条目时才写回（无命中的文件一行都不碰）。
 */
internal fun GalleryViewModel.stripPersonFromFaces(personId: String): Int {
    var touched = 0
    for (meta in metadataById.value.values) {
        val json = meta.aiData
        if (json.isNullOrEmpty() || !json.contains(personId)) continue
        val row = runCatching {
            val aiJson = org.json.JSONObject(json)
            val faces = aiJson.optJSONArray("faces") ?: return@runCatching null
            val kept = org.json.JSONArray()
            var removed = 0
            for (i in 0 until faces.length()) {
                val face = faces.optJSONObject(i) ?: continue
                if (face.optString("personId") == personId) removed++ else kept.put(face)
            }
            if (removed == 0) return@runCatching null
            aiJson.put("faces", kept)
            meta.copy(aiData = aiJson.toString(), updatedAt = personNow())
        }.getOrNull() ?: continue
        val wrote = runCatching { upsertFileMetadata(row) }
            .onFailure { Log.w(GalleryViewModel.TAG, "[People] faces 清理写回失败 id=${meta.fileId}：${it.message}") }
            .isSuccess
        if (wrote) touched++
    }
    return touched
}

/**
 * 进本地人物筛选视图：虚拟目录 `__person__:<id>`，形制同 [openLanPersonFilter]
 * （标题「人物 · 名」由 UI 层拼），但**不发任何网络请求**——成员集由
 * [reloadImages] 的本地人物分支按本机库现算。
 */
fun GalleryViewModel.openLocalPersonFilter(personId: String) {
    appState.openFolder(localPersonFolderId(personId))
}

/**
 * 本地人物的成员图（裁剪头像页底部那条「换一张封面」的候选）。同步查
 * [metadataById] 快照再按 id 批量取 Image，不走网络。
 */
suspend fun GalleryViewModel.localPersonMemberImages(personId: String): List<Image> =
    withContext(Dispatchers.IO) {
        val ids = localPersonMemberIds(personId)
        if (ids.isEmpty()) emptyList()
        else runCatching { listImagesByIds(ids) }.getOrDefault(emptyList())
    }

/** [localPersonMemberImages] 的回调式外壳（形制同 createTopic——宿主拿不到 viewModelScope）。 */
fun GalleryViewModel.loadLocalPersonMemberImages(personId: String, onReady: (List<Image>) -> Unit) {
    viewModelScope.launch {
        val images = localPersonMemberImages(personId)
        debugLog("loadLocalPersonMemberImages: id=$personId images=${images.size}")
        onReady(images)
    }
}

/**
 * 设本地人物头像：换封面图 + 写 faceBox（[faceBox] 为 null 表示清空裁剪框、
 * 退回中心裁剪）。
 *
 * 走已导出的 `update_person_avatar` FFI（桌面 `db_update_person_avatar` 同一支），
 * 它顺带把 updated_at 顶到当前——正是总览「操作过就排前面」要的语义。
 */
fun GalleryViewModel.setLocalPersonAvatar(
    personId: String,
    coverFileId: String,
    faceBox: FfiFaceBox?,
    onDone: (Boolean) -> Unit = {},
) {
    viewModelScope.launch {
        val ok = withContext(Dispatchers.IO) {
            runCatching { updatePersonAvatar(personId, coverFileId, faceBox) }
                .onFailure { Log.w(GalleryViewModel.TAG, "[People] 头像写回失败 id=$personId：${it.message}") }
                .isSuccess
        }
        if (ok) refreshLocalPeople()
        debugLog("setLocalPersonAvatar: id=$personId cover=$coverFileId box=$faceBox ok=$ok")
        onDone(ok)
    }
}

/**
 * 把选中的图加到已有人物（桌面 `handleManualAddPerson` 同口径）：
 *  - 每张图对每个人物只追加一条 face（已存在 personId 就跳过，重复点不会把 count
 *    越加越大）；
 *  - count 只累加**真新增**的张数；
 *  - coverFileId 为空时用第一张兜底（桌面同款：已设过封面就不抢）。
 *
 * 串行逐张：faces 追加是非原子的读改写，并发会互吞（纪律同 WD14 管线）。
 * 回调 (成功张数, 失败张数)——宿主拼 toast。
 */
fun GalleryViewModel.addFilesToLocalPersons(
    personIds: List<String>,
    fileIds: List<String>,
    onDone: (ok: Int, failed: Int) -> Unit = { _, _ -> },
) {
    if (personIds.isEmpty() || fileIds.isEmpty()) {
        onDone(0, 0)
        return
    }
    viewModelScope.launch {
        val targets = withContext(Dispatchers.IO) {
            runCatching { listImagesByIds(fileIds) }.getOrDefault(emptyList())
        }
        val people = localPeople.value.associateBy { it.id }
        val addedByPerson = HashMap<String, Int>()
        var ok = 0
        var failed = 0
        for (img in targets) {
            val added = withContext(Dispatchers.IO) {
                runCatching {
                    val meta = runCatching { getFileMetadata(img.id) }.getOrNull()
                    val aiJson = meta?.aiData?.takeIf { it.isNotEmpty() }
                        ?.let { runCatching { org.json.JSONObject(it) }.getOrNull() }
                        ?: org.json.JSONObject()
                    val faces = aiJson.optJSONArray("faces") ?: org.json.JSONArray()
                    val existing = (0 until faces.length())
                        .mapNotNull { faces.optJSONObject(it)?.optString("personId") }
                        .toHashSet()
                    val addedPids = mutableListOf<String>()
                    for (pid in personIds) {
                        if (!existing.add(pid)) continue
                        faces.put(
                            org.json.JSONObject()
                                .put("id", "face_${img.id}_$pid")
                                .put("personId", pid)
                                .put("name", people[pid]?.name.orEmpty())
                                .put("confidence", 1.0)
                                .put(
                                    "box",
                                    org.json.JSONObject()
                                        .put("x", 0.0).put("y", 0.0)
                                        .put("w", 0.0).put("h", 0.0),
                                ),
                        )
                        addedPids.add(pid)
                    }
                    // 全都已关联过：一行都不写（省掉一次无意义的 updatedAt 抖动）
                    if (addedPids.isEmpty()) return@runCatching addedPids
                    aiJson.put("faces", faces)
                    // 新建行 path 装 contentUri（saveFileUpdates / WD14 管线先例）
                    val row = meta ?: FfiFileMetadata(
                        fileId = img.id,
                        path = img.contentUri,
                        description = null,
                        sourceUrl = null,
                        sourceUrls = emptyList(),
                        aiData = null,
                        category = null,
                        updatedAt = null,
                    )
                    upsertFileMetadata(row.copy(aiData = aiJson.toString(), updatedAt = personNow()))
                    addedPids
                }.getOrElse { e ->
                    Log.w(GalleryViewModel.TAG, "[People] 加图失败 id=${img.id}：${e.message}")
                    null
                }
            }
            if (added == null) {
                failed++
            } else {
                ok++
                // count 只累加**真新增**的 (文件, 人物) 对：同一张重复加不会把数越推越大
                for (pid in added) addedByPerson[pid] = (addedByPerson[pid] ?: 0) + 1
            }
        }
        // 人物行写回（整行 copy：只动 count / coverFileId / updatedAt）
        withContext(Dispatchers.IO) {
            for (pid in personIds) {
                val p = people[pid] ?: continue
                val n = addedByPerson[pid] ?: 0
                // 一张都没新增就别写行：整行 upsert 会把 updatedAt 顶到最新，
                // 总览「操作过就排前面」的排序会被一次空操作悄悄改序
                if (n == 0) continue
                runCatching {
                    upsertPerson(
                        p.copy(
                            count = p.count + n,
                            // 没设过封面就拿本批第一张兜底（桌面同款）；已设过不抢
                            coverFileId = p.coverFileId.takeIf { it.isNotEmpty() }
                                ?: targets.firstOrNull()?.id.orEmpty(),
                            updatedAt = personNow(),
                        ),
                    )
                }.onFailure { Log.w(GalleryViewModel.TAG, "[People] 计数写回失败 id=$pid：${it.message}") }
            }
        }
        debugLog("addFilesToLocalPersons: persons=${personIds.size} files=${fileIds.size} ok=$ok fail=$failed")
        // aiData 变了：元数据快照（驱动人物筛选）与人物快照都要重算，再刷当前视图
        reloadTagState()
        refreshLocalPeople()
        reloadImages()
        onDone(ok, failed)
    }
}

/**
 * 把选中图从指定人物上解绑（桌面文件右键「清除人物信息」的安卓同位）：
 * 摘掉这些文件 aiData.faces 里指向所选人物的条目，人物 count 相应回退。
 *
 * 顺带处理封面：如果某人物的封面正是被解绑的那张，就把 coverFileId 清空、
 * faceBox 一起清掉（框的坐标属于那张图，留着会把头像裁到错的位置）——人物退回
 * 首字符占位，而不是顶着一张已经不属于它的脸。口径同桌面 LAN 的换头像
 * （`handlers.rs`：「faceBox 坐标属于旧头像，换头像即失效」）。
 *
 * 串行逐张，理由与 [addFilesToLocalPersons] 相同（faces 是非原子读改写）。
 */
fun GalleryViewModel.clearPersonsFromFiles(
    personIds: List<String>,
    fileIds: List<String>,
    onDone: (ok: Int, failed: Int) -> Unit = { _, _ -> },
) {
    if (personIds.isEmpty() || fileIds.isEmpty()) {
        onDone(0, 0)
        return
    }
    val wanted = personIds.toHashSet()
    viewModelScope.launch {
        val targets = withContext(Dispatchers.IO) {
            runCatching { listImagesByIds(fileIds) }.getOrDefault(emptyList())
        }
        val people = localPeople.value.associateBy { it.id }
        val removedByPerson = HashMap<String, Int>()
        val clearedFilesByPerson = HashMap<String, MutableSet<String>>()
        var ok = 0
        var failed = 0
        for (img in targets) {
            val removed = withContext(Dispatchers.IO) {
                runCatching {
                    val meta = runCatching { getFileMetadata(img.id) }.getOrNull()
                    val json = meta?.aiData?.takeIf { it.isNotEmpty() } ?: return@runCatching null
                    val aiJson = runCatching { org.json.JSONObject(json) }.getOrNull()
                        ?: return@runCatching null
                    val faces = aiJson.optJSONArray("faces") ?: return@runCatching null
                    val kept = org.json.JSONArray()
                    val hit = mutableListOf<String>()
                    for (i in 0 until faces.length()) {
                        val face = faces.optJSONObject(i) ?: continue
                        val pid = face.optString("personId")
                        if (pid in wanted) hit.add(pid) else kept.put(face)
                    }
                    if (hit.isEmpty()) return@runCatching hit
                    aiJson.put("faces", kept)
                    upsertFileMetadata(meta.copy(aiData = aiJson.toString(), updatedAt = personNow()))
                    hit
                }.getOrElse { e ->
                    Log.w(GalleryViewModel.TAG, "[People] 解绑失败 id=${img.id}：${e.message}")
                    null
                }
            }
            if (removed == null) {
                failed++
            } else {
                ok++
                for (pid in removed) {
                    removedByPerson[pid] = (removedByPerson[pid] ?: 0) + 1
                    clearedFilesByPerson.getOrPut(pid) { mutableSetOf() }.add(img.id)
                }
            }
        }
        withContext(Dispatchers.IO) {
            for (pid in personIds) {
                val p = people[pid] ?: continue
                val n = removedByPerson[pid] ?: 0
                if (n == 0) continue
                val lostCover = p.coverFileId.isNotEmpty() && p.coverFileId in clearedFilesByPerson[pid].orEmpty()
                runCatching {
                    upsertPerson(
                        p.copy(
                            count = (p.count - n).coerceAtLeast(0),
                            coverFileId = if (lostCover) "" else p.coverFileId,
                            faceBox = if (lostCover) null else p.faceBox,
                            updatedAt = personNow(),
                        ),
                    )
                }.onFailure { Log.w(GalleryViewModel.TAG, "[People] 解绑计数写回失败 id=$pid：${it.message}") }
            }
        }
        debugLog("clearPersonsFromFiles: persons=${personIds.size} files=${fileIds.size} ok=$ok fail=$failed")
        reloadTagState()
        refreshLocalPeople()
        reloadImages()
        onDone(ok, failed)
    }
}

/**
 * 本地人物的成员 file_id 集：全库 [metadataById] 里 `aiData.faces[].personId` 命中者。
 *
 * 口径对齐桌面 `useFileSearch.ts:102-110` 的 activePersonId 分支，但**只取 faces 那
 * 一条**——桌面还有第二条「person.characterTagName 命中 file.tags」的兜底，那是 WD14
 * 角色标签专用的数据源（本机没有 WD14，人物移植已砍掉那条线），留着只会让人物在
 * 从没关联过的图上凭空命中。
 *
 * 子串预筛再解析：全库逐行 `JSONObject` 解析在大库上是白花的开销，而 faces 里必然
 * 原样带着 personId 字面量（两端写入口径都是紧凑 JSON，无空格）。预筛只可能漏
 * 「带空格的 JSON」，那种行本来也解析不出 faces 语义，漏得安全。
 */
internal fun GalleryViewModel.localPersonMemberIds(personId: String): List<String> {
    if (personId.isEmpty()) return emptyList()
    val hits = mutableListOf<String>()
    for (meta in metadataById.value.values) {
        val json = meta.aiData
        if (json.isNullOrEmpty() || !json.contains(personId)) continue
        val faces = runCatching { org.json.JSONObject(json).optJSONArray("faces") }.getOrNull()
            ?: continue
        for (i in 0 until faces.length()) {
            if (faces.optJSONObject(i)?.optString("personId") == personId) {
                hits.add(meta.fileId)
                break
            }
        }
    }
    return hits
}
