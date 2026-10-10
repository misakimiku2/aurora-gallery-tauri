package com.aurora.gallery.kotlin

import android.app.Application
import android.net.Uri
import android.util.Log
import androidx.lifecycle.viewModelScope
import com.aurora.gallery.kotlin.state.AppState
import com.aurora.gallery.kotlin.state.LAN_SEARCH_FOLDER_ID
import com.aurora.gallery.kotlin.state.lanPersonFolderId
import com.aurora.gallery.kotlin.state.lanPersonIdOrNull
import com.aurora.gallery.kotlin.state.lanTopicFolderId
import com.aurora.gallery.kotlin.state.lanTopicIdOrNull
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import uniffi.aurora_core.addFilesToTopic
import uniffi.aurora_core.addTagsToFiles
import uniffi.aurora_core.FfiFileMetadata
import uniffi.aurora_core.FfiPerson
import uniffi.aurora_core.Folder
import uniffi.aurora_core.getAllPeople
import uniffi.aurora_core.getFileMetadata
import uniffi.aurora_core.Image
import uniffi.aurora_core.listImagesByIds
import uniffi.aurora_core.upsertFileMetadata
import uniffi.aurora_core.upsertPerson

// 2026-10-10 从 `GalleryViewModel.kt` 拆出：M6b 阶段 4/5「LAN AI 视觉与成员筛选」这一簇
// 整体搬到这里，用**扩展函数**落（套路同 GalleryViewModelPeople.kt / GalleryViewModelFileOps.kt /
// GalleryViewModelQPaths.kt / GalleryViewModelColors.kt / GalleryViewModelAiTasks.kt /
// GalleryViewModelLanBrowse.kt / GalleryViewModelLanOps.kt——Kotlin 没有 partial class）。
//
// 只搬 `fun`（10 个：reloadLanVocab / startWd14PersonPipeline / ensureWorkTopicAndAdd /
// lanMemberPaths / lanSearchFailureToast / performLanSearch / clearLanSearch /
// openLanPersonFilter / openLanTopicFilter / findSimilarOnDesktop）。会话态（lanVocab /
// lanSearchHits / pendingMemberPaths 等）留在原类。
//
// 本刀同样**零降权**：段内引用的 aiJob / wd14Cancelled / pendingMemberPaths / scanNotifier /
// reloadLanPeople 等，已在第 7、8 刀落 internal；reloadLanVocab 与 lanMemberPaths 本就是
// 第 8 刀为 LanBrowse.kt 降的 internal，跟着本簇搬走后 LanBrowse.kt 照旧能调。
//
// 本簇无 object 表达式。

// ===== M6b 阶段 4/5：LAN AI 视觉与成员筛选（契约 §8；D36/D37/D40）=====
//
// 三块能力，全部吃 [lan] 会话（§8 端点是纯计算/纯查询，不受 allow_edit/allow_upload
// 门禁，契约 §8.0）：
//  - WD14 人物管线（D37，[startWd14PersonPipeline]）：本地图字节过桌面 WD14，
//    general_tags 进本地词表管线、character_tags 落本地人物库 + aiData.faces + 作品
//    专题。**写的是安卓本地库**，与「远端写绝不进本地库」的 D31 铁律不冲突——
//    那条管的是「远端数据的显示态」，这里是「本地文件借桌面算力产出的本地数据」。
//  - LAN 语义搜索（D36，[performLanSearch] / [findSimilarOnDesktop]）：
//    aiSearchEnabled 开 = CLIP 文本语义/以图搜图，关 = 既有文本搜索；命中进
//    [lanSearchHits] + `__lan_search__` 虚拟目录。
//  - 成员筛选虚拟目录（D40，[openLanPersonFilter] / [openLanTopicFilter]）：成员
//    path 集 → 内存过滤 [lanLibraryImages]。
//
// 503（模型/索引未就绪）统一由 LanClient 抛 LanHttpException，调用方读 code==503
// 给专属提示（[lanSearchFailureToast]）；其余失败 Log.w + toast。

/** 重拉桌面词表（[lanVocab]；失败静默保旧——建议性数据，不值得弹窗，口径同 [reloadLanPeople]）。 */
// internal 而非 private：LAN 浏览簇已拆到 GalleryViewModelLanBrowse.kt（扩展函数）里要用
internal suspend fun GalleryViewModel.reloadLanVocab(session: LanManager.LanSession) {
    val loaded = withContext(Dispatchers.IO) {
        runCatching { session.client.vocab(session.base, session.token) }
    }
    loaded.getOrNull()?.let { lanVocab.value = it }
        ?: Log.w(GalleryViewModel.TAG, "[Lan] vocab 拉取失败（保旧）：${loaded.exceptionOrNull()?.message ?: "unknown"}")
}

/**
 * D37 WD14 人物识别主链（多选/查看器共用入口）：逐张读本机字节 → 桌面 WD14 推理
 * （[LanClient.wd14Classify]）→ 双路落库（**安卓本地库**）：
 *  - general_tags → [addTagsToFiles]（词表管线：Rust add_tags_to_files 同事务 upsert
 *    词表，侧栏可见）；
 *  - character_tags → 人物库 upsert（id=`person_<tag>`，同人多张累计 count、首见
 *    fileId 作封面、已有 description 保护不冲掉）+ aiData.faces 追加（整行读改写，
 *    faces 键位 = 桌面 D40 读端点的同款口径 `{id, personId, name, confidence, box}`）
 *    + work 非空时同名作品专题（无则建，[ensureWorkTopicAndAdd]）归入。
 *
 * **串行逐张**而非并发：两张并行可能同时读改写同一文件的 aiData（faces 追加是
 * 读-改-写非原子）；与本地 AI 分析的互斥复用 [aiTaskState]。M8b 阶段 3（遗留 #8）
 * 销账：通知栏「取消」action 经 [cancelAiTask] 置 [wd14Cancelled]（core 注册表里
 * 没这个 taskId，故分流），每张迭代首查生效（在途一张跑完），终止后走「已取消」
 * 完成口径收通知。
 *
 * 失败口径：单张失败 Log.w 计数不中断批次（会话中途断线则余下全部走同一口径）。
 */
internal fun GalleryViewModel.startWd14PersonPipeline(fileIds: List<String>) {
    val session = lan.currentSession()
    if (session == null) {
        aiToast("需先连接桌面端")
        return
    }
    if (fileIds.isEmpty()) return
    if (aiTaskState.value != null) {
        aiToast("AI 任务进行中，可从通知栏取消")
        return
    }
    // M8b 阶段 3（遗留 #8）：启动时清取消标志——上一批的取消位不得泄漏到新批次
    // （互斥门在 [aiTaskState]，同一时刻至多一条管线，启动即清足够）。
    wd14Cancelled.set(false)
    aiJob = viewModelScope.launch {
        val taskId = "lan-wd14-${System.currentTimeMillis()}"
        val targets = withContext(Dispatchers.IO) { listImagesByIds(fileIds) }
        val total = targets.size
        aiTaskState.value = GalleryViewModel.AiTaskState("人物识别", taskId, 0, total)
        scanNotifier.aiProgress("人物识别", 0, total)
        // 人物库快照（本流水线是单写者，批内同人累计直接在这张表上做；跨任务/外部
        // 并发写不保证精确——count 允许近似，登记）
        val knownPeople = withContext(Dispatchers.IO) {
            runCatching { getAllPeople() }.getOrElse { e ->
                Log.w(GalleryViewModel.TAG, "[Lan][WD14] 人物库预读失败（按全新人处理）：${e.message}")
                emptyList()
            }
        }.associateBy { it.id }.toMutableMap()
        var failed = 0
        var processed = 0
        var cancelled = false
        for ((index, img) in targets.withIndex()) {
            // M8b 阶段 3（遗留 #8）：Kotlin 侧自管取消——每张迭代首查，置位即终止
            // 剩余识别（在途一张跑完），进度停在已处理数，尾部按「已取消」口径收通知。
            if (wd14Cancelled.get()) {
                cancelled = true
                Log.i(GalleryViewModel.TAG, "[Lan][WD14] 收到取消，终止剩余识别（剩余 ${total - index} 张）")
                break
            }
            try {
                val bytes = withContext(Dispatchers.IO) {
                    appContext.contentResolver.openInputStream(Uri.parse(img.contentUri))?.use { it.readBytes() }
                }
                if (bytes == null || bytes.isEmpty()) throw java.io.IOException("无法读取本机图片字节")
                val mime = mimeForFileName(img.name).takeIf { it != "application/octet-stream" } ?: "image/jpeg"
                val result = withContext(Dispatchers.IO) {
                    session.client.wd14Classify(session.base, session.token, bytes, img.name, mime)
                }
                // 1) general_tags → 本地词表管线（add_tags_to_files 同事务 upsert 词表）
                if (result.generalTags.isNotEmpty()) {
                    withContext(Dispatchers.IO) { addTagsToFiles(listOf(img.id), result.generalTags) }
                }
                // 2) character_tags → 人物库 + aiData.faces + 作品专题（faces 攒齐后
                //    单文件一次整行写回，避免同文件多 tag 各写一遍）
                if (result.characterTags.isNotEmpty()) {
                    val meta = withContext(Dispatchers.IO) {
                        runCatching { getFileMetadata(img.id) }.getOrNull()
                    }
                    val aiJson = meta?.aiData?.takeIf { it.isNotEmpty() }
                        ?.let { runCatching { org.json.JSONObject(it) }.getOrNull() }
                        ?: org.json.JSONObject()
                    val faces = aiJson.optJSONArray("faces") ?: org.json.JSONArray()
                    for (ct in result.characterTags) {
                        val personId = "person_${ct.tag}"
                        val existing = knownPeople[personId]
                        val person = FfiPerson(
                            id = personId,
                            name = ct.tag,
                            // 首见 fileId 作封面（已有非空封面保留；重复出现不换）
                            coverFileId = existing?.coverFileId?.takeIf { it.isNotEmpty() } ?: img.id,
                            count = (existing?.count ?: 0) + 1,
                            // 已有描述保护：upsert 是整行写，字面 description=null 会把
                            // 用户描述冲掉（登记偏差：null 只发生在全新人身上）
                            description = existing?.description,
                            faceBox = null,
                            updatedAt = System.currentTimeMillis() / 1000, // now秒（契约口径）
                            characterTagName = ct.tag,
                            characterTagIndex = null,
                        )
                        withContext(Dispatchers.IO) {
                            runCatching { upsertPerson(person) }.onFailure {
                                Log.w(GalleryViewModel.TAG, "[Lan][WD14] 人物落库失败 id=$personId：${it.message}")
                            }
                        }
                        knownPeople[personId] = person
                        // aiData.faces 追加（键位对齐桌面 §8.5 读端点 faces[].personId 口径）
                        faces.put(
                            org.json.JSONObject()
                                .put("id", "face_${img.id}")
                                .put("personId", personId)
                                .put("name", ct.tag)
                                .put("confidence", ct.score)
                                .put(
                                    "box",
                                    org.json.JSONObject()
                                        .put("x", 0.0)
                                        .put("y", 0.0)
                                        .put("w", 0.0)
                                        .put("h", 0.0),
                                ),
                        )
                        // work 非空 → 同名作品专题（无则建）归入
                        ct.work?.takeIf { it.isNotBlank() }?.let { work ->
                            ensureWorkTopicAndAdd(work, img.id)
                        }
                    }
                    // faces 整行读改写（saveFileUpdates 同款纪律：upsertFileMetadata 是
                    // 整行 ON CONFLICT DO UPDATE，拿半空行写会把别列冲掉）
                    withContext(Dispatchers.IO) {
                        runCatching {
                            val row = meta ?: FfiFileMetadata(
                                fileId = img.id,
                                path = img.contentUri, // 新建行 path 装 contentUri（saveFileUpdates 先例）
                                description = null,
                                sourceUrl = null,
                                sourceUrls = emptyList(),
                                aiData = null,
                                category = null,
                                updatedAt = null,
                            )
                            upsertFileMetadata(row.copy(aiData = aiJson.toString()))
                        }.onFailure {
                            Log.w(GalleryViewModel.TAG, "[Lan][WD14] aiData.faces 写回失败 id=${img.id}：${it.message}")
                        }
                    }
                }
            } catch (e: Exception) {
                failed++
                Log.w(GalleryViewModel.TAG, "[Lan][WD14] 单张失败 id=${img.id}：${e.message}")
            }
            // 进度每张推进（含失败张）
            val done = index + 1
            processed = done
            aiTaskState.value = GalleryViewModel.AiTaskState("人物识别", taskId, done, total)
            scanNotifier.aiProgress("人物识别", done, total)
        }
        aiTaskState.value = null
        // M8b 阶段 3（遗留 #8）：取消与完成分口径——取消时已落库的部分数据保留
        // （与「单张失败不回滚」同款口径），尾部快照重算照跑把半程结果刷出来。
        scanNotifier.aiDone(
            when {
                cancelled ->
                    if (failed == 0) "人物识别已取消（已处理 $processed/$total 张）"
                    else "人物识别已取消（已处理 $processed/$total 张，$failed 张失败）"
                failed == 0 -> "人物识别完成 $total 张"
                else -> "人物识别完成 $total 张（$failed 张失败）"
            },
        )
        // 标签/人物/词表已落库：快照重算 + 当前视图重拉（口径同 startAiAnalysis 尾部）
        reloadTagState()
        reloadLocalPeople()
        reloadImages()
    }
}

/**
 * WD14 人物管线的作品专题落地：本地 topics 查同名（name==work）→ 无则走既有
 * [createTopic]（回调式拿不到新 id，用 [CompletableDeferred] 拉直成挂起等待；
 * onDone 前它已 reloadTopics，按 name 找回新建专题的 id）→ 既有 [addFilesToTopic]
 * 归入（沿用其首图自动成封面逻辑）。串行流水线内建过一次后同名必命中既有分支，
 * 不会重复建专题。创建失败 Log.w 并回 false——专题归属是锦上添花，不中断主链。
 */
private suspend fun GalleryViewModel.ensureWorkTopicAndAdd(work: String, fileId: String): Boolean {
    topics.value.firstOrNull { it.name == work }?.let {
        addFilesToTopic(it.id, setOf(fileId))
        return true
    }
    val created = CompletableDeferred<String?>()
    createTopic(work) { ok ->
        created.complete(if (ok) topics.value.firstOrNull { it.name == work }?.id else null)
    }
    val topicId = created.await() ?: run {
        Log.w(GalleryViewModel.TAG, "[Lan][WD14] 作品专题创建失败 work=$work")
        return false
    }
    addFilesToTopic(topicId, setOf(fileId))
    return true
}

/**
 * 成员筛选虚拟目录（人物/专题）的 path 集：优先消费 [pendingMemberPaths]（校验归属
 * folderId——「人物 A → 人物 B → 返回 A」的回导航时集合已换人，对不上就重拉；进程
 * 重建后为 null 同样重拉，id 从 folderId 解出）。重拉成功回写缓存（保持端点返回序，
 * 网格次序随之）；失败回空集（网格空态，不炸）。
 */
// internal 而非 private：LAN 浏览簇已拆到 GalleryViewModelLanBrowse.kt（扩展函数）里要用
internal suspend fun GalleryViewModel.lanMemberPaths(folderId: String): Set<String> {
    val cached = pendingMemberPaths
    if (cached != null && pendingMemberPathsFolderId == folderId) {
        return cached
    }
    val session = lan.currentSession() ?: return emptySet()
    val personId = folderId.lanPersonIdOrNull()
    val topicId = folderId.lanTopicIdOrNull()
    val result = withContext(Dispatchers.IO) {
        runCatching {
            when {
                personId != null -> session.client.peopleMembers(session.base, session.token, personId)
                topicId != null -> session.client.topicMembers(session.base, session.token, topicId).files
                else -> emptyList()
            }
        }
    }
    val paths = result.getOrElse { e ->
        Log.w(GalleryViewModel.TAG, "[Lan] 成员列表重拉失败 folder=$folderId：${e.message}")
        return emptySet()
    }
    val ordered = paths.toCollection(LinkedHashSet())
    pendingMemberPaths = ordered
    pendingMemberPathsFolderId = folderId
    return ordered
}

/** LAN 搜索类失败的统一提示（503 = 模型/索引未就绪有专属文案，契约 §8.0）。 */
private fun GalleryViewModel.lanSearchFailureToast(e: Throwable?, fallback: String) {
    if (e is LanHttpException && e.code == 503) {
        aiToast("桌面端模型/索引未就绪")
    } else {
        Log.w(GalleryViewModel.TAG, "[Lan] $fallback：${e?.message}")
        aiToast("$fallback：${e?.message ?: "未知错误"}")
    }
}

/**
 * LAN 搜索（M6b 阶段 5，D36）：`settings.aiSearchEnabled` 开 = 桌面 CLIP 文本语义
 * （POST /api/ai/clip/search_text，min_score 0.2 / max_results 100）；关 = 既有文本
 * 搜索（GET /api/search，命中无分值 → score 记 1.0，与 CLIP 命中同一数据形态）。
 * 成功置 [lanSearchHits] 并 openFolder(LAN_SEARCH_FOLDER_ID)——网格内容由
 * [reloadLanImages] 搜索分支渲染，标题「搜索结果」由 UI 层处理（VM 不管标题）。
 * 503 = 桌面模型/嵌入索引未就绪（契约 §8.0）：toast 专属提示、busy 复位、结果态不动。
 */
internal fun GalleryViewModel.performLanSearch(query: String) {
    val session = lan.currentSession()
    if (session == null) {
        aiToast("需先连接桌面端")
        return
    }
    if (query.isBlank()) {
        clearLanSearch()
        return
    }
    viewModelScope.launch {
        lanSearchBusy.value = true
        try {
            val hits: List<Pair<String, Double>> = if (settings.value.aiSearchEnabled) {
                val result = withContext(Dispatchers.IO) {
                    runCatching { session.client.clipSearchText(session.base, session.token, query, 0.2, 100) }
                }
                val clip = result.getOrNull()
                if (clip == null) {
                    lanSearchFailureToast(result.exceptionOrNull(), "LAN 搜索失败")
                    return@launch
                }
                clip.map { it.path to it.score }
            } else {
                val result = withContext(Dispatchers.IO) {
                    runCatching { session.client.search(session.base, session.token, query) }
                }
                val browsed = result.getOrNull()
                if (browsed == null) {
                    lanSearchFailureToast(result.exceptionOrNull(), "LAN 搜索失败")
                    return@launch
                }
                // 文本命中无分值概念：score 恒 1.0（排序稳定）；视频项过滤口径同 browse
                browsed.images.filter { it.type != "video" }.map { it.path to 1.0 }
            }
            lanSearchHits.value = hits
            appState.openFolder(LAN_SEARCH_FOLDER_ID)
            aiToast("命中 ${hits.size} 张")
        } finally {
            lanSearchBusy.value = false
        }
    }
}

/** 清 LAN 搜索结果态（退出搜索视图/新搜索前置共用；视图内容由下次导航自然接管）。 */
internal fun GalleryViewModel.clearLanSearch() {
    lanSearchHits.value = null
}

/**
 * 打开人物成员筛选虚拟目录（D40）：people/members 拉 path 集 → 记入
 * [pendingMemberPaths]（归属 folderId 一起记，回导航防串台）→ openFolder
 * （`lan:person:<id>`，AppState.lanPersonFolderId 同款）。网格内容由
 * [reloadLanImages] 成员分支渲染（会话缓存里没有的 path 跳过）；标题「人物 · 名」
 * 由 UI 层消费 [name] 拼（VM 不管标题）。拉取失败不导航（留在原地），Log.w 记录。
 */
internal fun GalleryViewModel.openLanPersonFilter(personId: String, name: String) {
    val session = lan.currentSession()
    if (session == null) {
        aiToast("需先连接桌面端")
        return
    }
    viewModelScope.launch {
        val result = withContext(Dispatchers.IO) {
            runCatching { session.client.peopleMembers(session.base, session.token, personId) }
        }
        val paths = result.getOrNull() ?: run {
            Log.w(GalleryViewModel.TAG, "[Lan] 人物成员拉取失败 id=$personId：${result.exceptionOrNull()?.message}")
            return@launch
        }
        pendingMemberPaths = paths.toCollection(LinkedHashSet())
        pendingMemberPathsFolderId = lanPersonFolderId(personId)
        Log.i(GalleryViewModel.TAG, "[Lan] 人物筛选就绪 「$name」 id=$personId members=${paths.size}")
        appState.openFolder(lanPersonFolderId(personId))
    }
}

/**
 * 打开专题成员筛选虚拟目录（D40）：topic/members 的 `files`（人物成员 id 本任务
 * 无网格消费方，不用）→ 同 [openLanPersonFilter] 的缓存与导航形制，folderId =
 * `lan:topic:<id>`（AppState.lanTopicFolderId）。标题「专题 · 名」UI 层处理。
 */
internal fun GalleryViewModel.openLanTopicFilter(topicId: String) {
    val session = lan.currentSession()
    if (session == null) {
        aiToast("需先连接桌面端")
        return
    }
    viewModelScope.launch {
        val result = withContext(Dispatchers.IO) {
            runCatching { session.client.topicMembers(session.base, session.token, topicId) }
        }
        val members = result.getOrNull() ?: run {
            Log.w(GalleryViewModel.TAG, "[Lan] 专题成员拉取失败 id=$topicId：${result.exceptionOrNull()?.message}")
            return@launch
        }
        pendingMemberPaths = members.files.toCollection(LinkedHashSet())
        pendingMemberPathsFolderId = lanTopicFolderId(topicId)
        Log.i(GalleryViewModel.TAG, "[Lan] 专题筛选就绪 id=$topicId files=${members.files.size}")
        appState.openFolder(lanTopicFolderId(topicId))
    }
}

/**
 * 以图搜图（D36，本地图 → 桌面 CLIP 索引）：读本机图片字节 → POST
 * /api/ai/clip/search_image → 命中置 [lanSearchHits] + openFolder(LAN_SEARCH_FOLDER_ID)。
 * 503/断线/读图失败 → toast + onDone(false)，结果态不动。
 */
internal fun GalleryViewModel.findSimilarOnDesktop(fileId: String, onDone: (Boolean) -> Unit = {}) {
    val session = lan.currentSession()
    if (session == null) {
        aiToast("需先连接桌面端")
        onDone(false)
        return
    }
    viewModelScope.launch {
        var ok = false
        try {
            val bytes = withContext(Dispatchers.IO) {
                val img = listImagesByIds(listOf(fileId)).firstOrNull()
                    ?: throw java.io.IOException("本地图片不存在")
                appContext.contentResolver.openInputStream(Uri.parse(img.contentUri))?.use { it.readBytes() }
                    ?: throw java.io.IOException("无法读取本机图片字节")
            }
            val result = withContext(Dispatchers.IO) {
                runCatching { session.client.clipSearchImage(session.base, session.token, bytes) }
            }
            val hits = result.getOrNull()
            if (hits == null) {
                lanSearchFailureToast(result.exceptionOrNull(), "以图搜图失败")
            } else {
                lanSearchHits.value = hits.map { it.path to it.score }
                appState.openFolder(LAN_SEARCH_FOLDER_ID)
                aiToast("命中 ${hits.size} 张")
                ok = true
            }
        } catch (e: Exception) {
            Log.w(GalleryViewModel.TAG, "[Lan] 以图搜图失败：${e.message}")
            aiToast("以图搜图失败：${e.message ?: "未知错误"}")
        }
        onDone(ok)
    }
}
