package com.aurora.gallery.kotlin

import android.app.Application
import android.content.ContentValues
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import android.util.Log
import androidx.lifecycle.viewModelScope
import com.aurora.gallery.kotlin.state.AppState
import com.aurora.gallery.kotlin.state.LAN_FOLDER_ID_PREFIX
import com.aurora.gallery.kotlin.state.LAN_ROOT_IMAGES_ID
import com.aurora.gallery.kotlin.state.LAN_SEARCH_FOLDER_ID
import com.aurora.gallery.kotlin.state.lanFolderId
import com.aurora.gallery.kotlin.state.lanPersonIdOrNull
import com.aurora.gallery.kotlin.state.lanRemotePathOrNull
import com.aurora.gallery.kotlin.state.lanTagFilterOrNull
import com.aurora.gallery.kotlin.state.lanTopicIdOrNull
import com.aurora.gallery.kotlin.state.SortDirection
import com.aurora.gallery.kotlin.state.SortOption
import com.aurora.gallery.kotlin.state.ViewMode
import com.aurora.gallery.kotlin.ui.components.ROOT_FOLDER_DISPLAY_NAME
import com.aurora.gallery.kotlin.ui.components.sortImages
import java.util.Locale
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext
import uniffi.aurora_core.Folder
import uniffi.aurora_core.groupRemoteTagCounts
import uniffi.aurora_core.Image
import uniffi.aurora_core.RemoteTagCount

// 2026-10-10 从 `GalleryViewModel.kt` 拆出：M6a 阶段 4 LAN 浏览数据层这一簇（远端根拉取/
// 远端库缓存/目录刷新/上传/另存）整体搬到这里，用**扩展函数**落（套路同
// GalleryViewModelPeople.kt / GalleryViewModelFileOps.kt / GalleryViewModelQPaths.kt /
// GalleryViewModelColors.kt / GalleryViewModelAiTasks.kt——Kotlin 没有 partial class）。
//
// 只搬 `fun`。LAN 会话态（lanConnected / lanLibraryImages / lanMetaByPath / lanVocab …）
// 全部留在原类——扩展函数没有幕后字段。被本簇用到的私有成员（lanRootImages /
// pendingMemberPaths / pendingMemberPathsFolderId / lanFetchJob）在原类降为 internal。
//
// 本簇无 object 表达式，因此不需要第 6、7 刀那套 `val vm = this` 捕获。

// ===== M6a 阶段 4：LAN 浏览（数据层；UI 只消费这里算好的结构）=====

/** 清空 LAN 会话态（断线/手动断开联动；不动本地库/词表）。远端条目（含 tag 词表）整体消失。 */
internal fun GalleryViewModel.clearLanSession() {
    lanConnected.value = false
    lanAllowEdit.value = true
    lanAllowUpload.value = false
    lanRootImages.value = emptyList()
    lanOverviewFolders.value = emptyList()
    lanLibraryImages.value = emptyMap()
    lanMetaByPath.value = emptyMap()
    lanRemoteTagGroups.value = emptyList()
    lanPeople.value = emptyList()
    lanTopics.value = emptyList()
    // M6b 阶段 4/5：词表/搜索结果/成员筛选集同属会话态，断线一并清空
    //（lanSearchHits 不清会留一个渲染不出图的死视图态；本地图 localPeople 不在此列）
    lanVocab.value = emptyList()
    lanSearchHits.value = null
    pendingMemberPaths = null
    pendingMemberPathsFolderId = null
}

/**
 * 当前排序 → LAN 协议 `sort_by`/`sort_dir`（2026-10 扩展）：SortOption/SortDirection
 * 枚举映射成小写字符串。服务端据此为 folder 选 preview_images[0]（封面随排序）；
 * image 项的 created_at 字段与是否带参无关（新服务端恒回填）。
 */
private fun GalleryViewModel.lanSortParams(): Pair<String, String> = when (appState.sortBy) {
    SortOption.NAME -> "name"
    SortOption.DATE -> "date"
    SortOption.SIZE -> "size"
} to when (appState.sortDirection) {
    SortDirection.ASC -> "asc"
    SortDirection.DESC -> "desc"
}

/** 连接成功（或手动刷新）后的远端根拉取：all_imageFolders 一次带回目录+根散图+门禁位。 */
internal fun GalleryViewModel.refreshLanRootsInternal() {
    val session = lan.currentSession() ?: return
    val (sortBy, sortDir) = lanSortParams()
    lanFetchJob?.cancel()
    lanFetchJob = viewModelScope.launch {
        val result = withContext(Dispatchers.IO) {
            runCatching { session.client.allImageFolders(session.base, session.token, sortBy, sortDir) }
        }.getOrNull() ?: run {
            Log.w(GalleryViewModel.TAG, "[Lan] all_image_folders 拉取失败（状态机重试链会跟进）")
            return@launch
        }
        lanConnected.value = true
        lanAllowEdit.value = result.allowEdit
        lanAllowUpload.value = result.allowUpload
        lanRootImages.value = result.rootImages
        rebuildLanOverview(session, result.folders)
        Log.i(
            GalleryViewModel.TAG,
            "[Lan] 会话态就绪 folders=${result.folders.size} rootImages=${result.rootImages.size} " +
                "allowEdit=${result.allowEdit} allowUpload=${result.allowUpload}",
        )
        // —— 阶段 5：远端库缓存（browse 全目录 → metadata 批读 → 远端词表/people/topics）
        // —— 整个流程在同一 lanFetchJob 内：断线 cancel 即废（意向守卫语义），不会出现
        // 半套新缓存盖在断线清理之后。
        refreshLanLibraryInternal(session, result.folders)
    }
}

/**
 * 远端库缓存构建（阶段 5；[refreshLanRootsInternal] 的尾段，同一 lanFetchJob 内）：
 *  1. 逐远端目录 browse 收集全部 image 项（并发 [GalleryViewModel.LAN_BROWSE_CONCURRENCY]；单个目录
 *     失败 Log.w 跳过不炸整批）→ 合并根散图 → [lanLibraryImages]；
 *  2. path 分块（[GalleryViewModel.LAN_METADATA_BATCH_CHUNK]）调 metadataBatch → [lanMetaByPath]
 *     （单块失败只丢那块，词表分组可以只差一块待下次重连补齐）；
 *  3. tag→count 聚合 → groupRemoteTagCounts 纯函数 → [lanRemoteTagGroups]；
 *  4. people() / topics() → [lanPeople] / [lanTopics]；
 *  5. vocab() → [lanVocab]（M6b 阶段 5，D40 桌面词表；失败静默保旧）。
 *
 * 失败降级口径：任一环节 Log.w 后用已就绪的部分继续，不抛不炸（对齐 [reloadTagState]
 * 「读失败保留旧值」的纪律；断线重连会整体重跑）。
 */
private suspend fun GalleryViewModel.refreshLanLibraryInternal(session: LanManager.LanSession, folders: List<LanRemoteFolder>) {
    // 1) 全目录 browse（并发 4；协程体在主线程汇合，列表只在主线程写，无锁安全）。
    //    带当前排序口径（2026-10 协议扩展）：库缓存条目拿全 created_at，口径统一。
    val (libSortBy, libSortDir) = lanSortParams()
    val semaphore = Semaphore(GalleryViewModel.LAN_BROWSE_CONCURRENCY)
    val browsed = coroutineScope {
        folders.map { folder ->
            async {
                semaphore.withPermit {
                    withContext(Dispatchers.IO) {
                        runCatching { session.client.browse(session.base, session.token, folder.path, libSortBy, libSortDir) }
                            .onFailure {
                                Log.w(GalleryViewModel.TAG, "[Lan] 目录 browse 失败跳过：…${folder.path.takeLast(12)}")
                            }
                            .getOrNull()
                    }
                }
            }
        }.awaitAll()
    }
    val library = (browsed.filterNotNull().flatMap { it.images } + lanRootImages.value)
        .filter { it.type != "video" } // 网格口径不含视频（reloadLanImages 同款），缓存保持一致
        .associateBy { it.path }
    lanLibraryImages.value = library
    Log.i(
        GalleryViewModel.TAG,
        "[Lan] 远端库就绪 images=${library.size}（含根散图；browse 失败 ${browsed.count { it == null }} 目录）",
    )

    // 2) metadata 批读（分块 300；契约保证 items 与入参同序同数量，按 path 键回填）
    val meta = HashMap<String, LanMetadataItem>()
    library.keys.chunked(GalleryViewModel.LAN_METADATA_BATCH_CHUNK).forEach { chunk ->
        val items = withContext(Dispatchers.IO) {
            runCatching { session.client.metadataBatch(session.base, session.token, chunk) }
        }
        items.getOrNull()?.forEach { meta[it.path] = it }
            ?: Log.w(GalleryViewModel.TAG, "[Lan] metadata/batch 单块失败（${chunk.size} 项），远端词表暂缺该块")
    }
    lanMetaByPath.value = meta
    Log.i(GalleryViewModel.TAG, "[Lan] 远端元数据就绪 ${meta.size}/${library.size}")

    // 3) 远端词表分组（唯一 FFI 触点 = groupRemoteTagCounts 纯函数，排序由 Rust 定）
    rebuildLanRemoteTagGroups()

    // 4) 人物与专题（读失败保留旧列表，桌面阶段 2「读失败保留内存行」同口径）
    reloadLanPeople(session)
    reloadLanTopics(session)

    // 5) 桌面词表（M6b 阶段 5，D40；建议性数据，失败静默保旧）
    reloadLanVocab(session)
}

/**
 * 重算 [lanRemoteTagGroups]：[lanMetaByPath] 的 tags 做 tag→图片数聚合，交
 * groupRemoteTagCounts 纯函数分组排序（**Kotlin 侧不自己排**——「排序规则只许有一套」；
 * 纯函数不碰本地库，远端词表绝不写进本地词表，D31 纪律）。
 */
internal suspend fun GalleryViewModel.rebuildLanRemoteTagGroups() {
    val counts = HashMap<String, Long>()
    for (item in lanMetaByPath.value.values) {
        for (tag in item.tags) counts.merge(tag, 1L, Long::plus)
    }
    lanRemoteTagGroups.value = withContext(Dispatchers.IO) {
        groupRemoteTagCounts(counts.map { (tag, n) -> RemoteTagCount(tag, n) }, settings.value.language)
    }
}

/** 重拉远端人物（失败保留旧列表——对齐桌面阶段 2「读失败保留内存行」口径）。 */
internal suspend fun GalleryViewModel.reloadLanPeople(session: LanManager.LanSession) {
    val loaded = withContext(Dispatchers.IO) {
        runCatching { session.client.people(session.base, session.token) }
    }
    loaded.getOrNull()?.let { lanPeople.value = it }
        ?: Log.w(GalleryViewModel.TAG, "[Lan] people 重拉失败（${loaded.exceptionOrNull()?.message ?: "unknown"}），保留旧列表")
}

/** 重拉远端专题（失败保留旧列表，口径同 [reloadLanPeople]）。 */
internal suspend fun GalleryViewModel.reloadLanTopics(session: LanManager.LanSession) {
    val loaded = withContext(Dispatchers.IO) {
        runCatching { session.client.topics(session.base, session.token) }
    }
    loaded.getOrNull()?.let { lanTopics.value = it }
        ?: Log.w(GalleryViewModel.TAG, "[Lan] topics 重拉失败（${loaded.exceptionOrNull()?.message ?: "unknown"}），保留旧列表")
}

/** LAN 总览下拉刷新（完成回调对齐本地 refreshManual 的形态）。 */
internal fun GalleryViewModel.refreshLanRoots(onDone: () -> Unit = {}) {
    if (lan.currentSession() == null) {
        onDone()
        return
    }
    refreshLanRootsInternal()
    viewModelScope.launch {
        lanFetchJob?.join()
        onDone()
    }
}

/**
 * LAN 总览卡片序列：`__lan_root_images__` 虚拟根置顶（**有根级散图才放**，空则不出现
 * ——React FoldersOverview 行为），其余目录按服务端原序。id 带 lan 前缀供导航分流；
 * coverUri = preview_images[0]（或根散图首张）的缩略图 URL（网格 URL 分支的识别符）。
 *
 * 2026-10 协议扩展：Folder.createdAt 填服务端 `latest_created_at`（直接子图最新创建
 * 时间，DATE 排序=「内容最新」；与本地 list_folders 的 MAX 口径对齐）。旧服务端不带
 * 该字段 → 0 = 无日期（sortFolders 恒排最后）。根虚拟目录仍为 0（散图无文件夹日期，
 * 且 sortFolders 对它恒置顶，日期值不影响排序）。封面刷新时机 = 连接/手动刷新
 * （refreshLanRoots），排序变化不触发重拉：排序变化时卡片**顺序**由 sortFolders
 * 即时重排，封面候选反映的是拉取时刻的排序口径（LAN 模式的既定折衷）。
 */
private fun GalleryViewModel.rebuildLanOverview(session: LanManager.LanSession, folders: List<LanRemoteFolder>) {
    val out = ArrayList<Folder>(folders.size + 1)
    val roots = lanRootImages.value
    if (roots.isNotEmpty()) {
        out += Folder(
            id = lanFolderId(LAN_ROOT_IMAGES_ID),
            // 与本地根目录散图同一个显示名（sortFolders 的置顶规则按它识别，天然复用）
            name = ROOT_FOLDER_DISPLAY_NAME,
            // LAN 虚拟目录没有本地文件系统路径（复制/移动走 LanClient，不经
            // resolveFolderRelPath），置空
            path = "",
            imageCount = roots.size.toLong(),
            coverUri = roots.firstOrNull()
                ?.let { session.client.thumbnailUrl(session.base, session.token, it.path) },
            createdAt = 0,
            modifiedAt = 0,
        )
    }
    folders.forEach { f ->
        out += Folder(
            id = lanFolderId(f.path),
            name = f.name,
            path = "",
            imageCount = f.imageCount,
            coverUri = f.previewPath
                ?.let { session.client.thumbnailUrl(session.base, session.token, it) },
            // 直接子图最新创建时间（latest_created_at；旧服务端 0 = 无日期兜底）
            createdAt = f.latestCreatedAt,
            modifiedAt = 0,
        )
    }
    lanOverviewFolders.value = out
}

/** 远端图片项 → FFI [Image]（网格/查看器共用的展示模型；path 身份铁律：id=远端 path）。 */
private fun GalleryViewModel.lanImageOf(session: LanManager.LanSession, item: LanRemoteImage): Image = Image(
    id = item.path,
    name = item.name.ifEmpty { item.path.substringAfterLast('/') },
    // contentUri 装**缩略图 URL**：网格/总览的 URL 分支按 http 前缀识别（FileGrid.loadInto）
    contentUri = session.client.thumbnailUrl(session.base, session.token, item.path),
    width = null,
    height = null,
    size = item.size,
    // 2026-10 协议扩展：browse 响应带 created_at（file_index.created_at，秒级）。
    // 旧服务端/缺省仍为 0（查看器抽屉显示「—」，日期分组落 Unknown，React 同口径）
    createdAt = item.createdAt,
    modifiedAt = 0,
    format = item.name.substringAfterLast('.', "").takeIf { it.isNotEmpty() }?.lowercase(Locale.US),
)

/**
 * LAN 大图 URL 构造器（查看器 ImageItem 的 path 用；未连接返回 null，查看器按本地图
 * 的空 path 兜底展示）。MainActivity 经 ViewerLayerHost 传入 toViewerItem。
 */
internal fun GalleryViewModel.lanImageUrlOf(): ((String) -> String)? {
    val s = lan.currentSession() ?: return null
    return { remotePath -> s.client.imageUrl(s.base, s.token, remotePath) }
}

/**
 * LAN 缩略图 URL 构造器（阶段 6：人物「换头像」的目录选择器图片行用；未连接返回
 * null，宿主退化为恒 null 的构造器，弹窗行只剩占位底）。与 [lanImageUrlOf] 同款
 * 「会话现取」——构造器快照在组合时求值，断线重连后的重组会换上新的会话。
 */
internal fun GalleryViewModel.lanThumbnailUrlOf(): ((String) -> String)? {
    val s = lan.currentSession() ?: return null
    return { remotePath -> s.client.thumbnailUrl(s.base, s.token, remotePath) }
}

/**
 * LAN 目录的序列取数（reloadImages 的并列入口，M4a 序列源先例）：
 *  - 虚拟根（`__lan_root_images__`）= 会话态里的根散图，**不单独 browse**；
 *  - tag 筛选虚拟目录（`lan:__lan_tag__:<tag>`，阶段 5）= 从 [lanLibraryImages] 会话缓存
 *    按 tag 过滤（配合 [lanMetaByPath]），**不 browse、不动门禁位**（tag 视图沿用当前值）；
 *  - LAN 搜索结果虚拟目录（`__lan_search__`，M6b 阶段 5）= [lanSearchHits] 按 score
 *    降序对齐会话缓存（缓存没有的 path 跳过——会话没浏览过该目录，登记差异）；
 *  - 人物/专题成员筛选虚拟目录（`lan:person:<id>` / `lan:topic:<id>`，M6b 阶段 5）=
 *    [pendingMemberPaths] 内存过滤会话缓存（同 tag 分支形制），集缺失/过期时按
 *    folderId 解出 id 重拉 D40 端点（[lanMemberPaths]）；
 *  - 其余远端目录 = LanClient.browse(path)，`type=video` 的项**过滤不进列表**
 *    （登记差异：React LAN 浏览含视频项；Kotlin 全 App 视频支持待定 M8+）。
 *
 * 阶段 8 起 browse/根散图分支尾随目录级元数据增量刷新（[refreshLanMetaFor]）：
 * 桌面反向写后目录内下拉刷新即可见，不必回总览刷新或重连。
 *
 * **标题机制（UI 线接）**：本函数与 VM 都不管标题——标题全部在 MainActivity 由
 * folderId 解析（lanBrowserTitle / lanTagTitle，约 :1938-1955）。三个新虚拟形态的
 * 建议标题与名字来源：人物 = 「人物 · 名」（id 在 [lanPeople] 快照查 name，入口
 * openLanPersonFilter 也带了 name 参数）；专题 = 「专题 · 名」（[lanTopics] 查 name）；
 * 搜索 = 固定「搜索结果」。另注意 `__lan_search__` 不带 lan: 前缀，
 * MainActivity 的 inLanBrowser 判定（folderId.lanRemotePathOrNull() != null）对它
 * 为 false，网格可见性与标题分支要单独加它。
 */
internal suspend fun GalleryViewModel.reloadLanImages(folderId: String) {
    val key = lanSequenceKey(folderId)
    // 与本地分支同款：换源清空 + 置 pending（「还在连」≠「远端目录为空」），缓存先首发
    if (key != loadedImagesKey) {
        images.value = imagesCacheByKey[key] ?: emptyList()
        imagesPending.value = true
    }
    loadedImagesKey = key
    val session = lan.currentSession() ?: run {
        // 断线早退也要放下 pending：空态文案（「远端目录为空」）是此时唯一的状态交代
        if (activeSequenceKey() == key) imagesPending.value = false
        return
    }
    // tag 筛选虚拟目录（阶段 5）：纯内存过滤，不发网络请求。判定必须吃 folderId
    // 整串（lanTagFilterOrNull 内部自带 lan: 前缀剥离）；对剥完前缀的 remotePath 再调
    // 会因「lan: 已不在」恒落空、误进 browse 分支（E2E 实测翻过的车）。
    val tagFilter = folderId.lanTagFilterOrNull()
    val imgs: List<Image> = if (folderId == lanFolderId(LAN_ROOT_IMAGES_ID)) {
        // 阶段 8：根散图同样做目录级元数据增量刷新（桌面反向写后进目录即可见）
        refreshLanMetaFor(lanRootImages.value)
        lanRootImages.value.map { lanImageOf(session, it) }
    } else if (tagFilter != null) {
        lanLibraryImages.value.values
            .filter { lanMetaByPath.value[it.path]?.tags?.contains(tagFilter) == true }
            .map { lanImageOf(session, it) }
    } else if (folderId == LAN_SEARCH_FOLDER_ID) {
        // M6b 阶段 5：搜索结果虚拟目录（D36）。lanSearchHits 是 Pair(path, score)，
        // 按 score 降序；缓存没有的命中 path 构造最小条目补进会话缓存（搜索是全库
        // 语义，不能被「先浏览过来源目录」绑架；缩略图 URL 只依赖 path+token）。
        val library = lanLibraryImages.value
        val missing = lanSearchHits.value.orEmpty().map { it.first }.filter { it !in library }
        if (missing.isNotEmpty()) {
            val patched = library.toMutableMap()
            missing.forEach { p ->
                patched[p] = LanRemoteImage(
                    name = p.substringAfterLast('/'),
                    path = p,
                    type = "image",
                    size = 0,
                )
            }
            lanLibraryImages.value = patched
        }
        val patchedLibrary = lanLibraryImages.value
        lanSearchHits.value.orEmpty()
            .mapNotNull { hit -> patchedLibrary[hit.first]?.let { hit.second to it } }
            .sortedByDescending { it.first }
            .map { lanImageOf(session, it.second) }
    } else if (folderId.lanPersonIdOrNull() != null || folderId.lanTopicIdOrNull() != null) {
        // M6b 阶段 5：人物/专题成员筛选虚拟目录（D40，lan:person:<id> / lan:topic:<id>）。
        // openLanPersonFilter / openLanTopicFilter 进入时已把成员 path 集拉进
        // [pendingMemberPaths]；这里纯内存过滤（同 tag 分支形制，不发元数据批读），
        // 集缺失/过期（进程重建、回导航串台）时 [lanMemberPaths] 按 folderId 重拉端点。
        // 缓存没有的成员 path（本会话没浏览过该目录）构造最小条目补进会话缓存——
        // 成员筛选是全库语义，不能被「先浏览过来源目录」绑架；缩略图/大图 URL 机制
        // 只依赖 path+token，最小条目照常出图；元数据（标签）由抽屉打开时的既有
        // 批读兜底。
        val memberPaths = lanMemberPaths(folderId)
        val library = lanLibraryImages.value
        val missing = memberPaths.filter { it !in library }
        if (missing.isNotEmpty()) {
            val patched = library.toMutableMap()
            missing.forEach { p ->
                patched[p] = LanRemoteImage(
                    name = p.substringAfterLast('/'),
                    path = p,
                    type = "image",
                    size = 0,
                )
            }
            lanLibraryImages.value = patched
        }
        memberPaths.mapNotNull { lanLibraryImages.value[it] }
            .map { lanImageOf(session, it) }
    } else {
        val remotePath = folderId.lanRemotePathOrNull() ?: return
        // 带当前排序口径（2026-10 协议扩展）：网格吃 image 项的 created_at，
        // 顺序仍由 sortImages 客户端定（服务端 images 数组顺序不受 sort 参数影响）
        val (sortBy, sortDir) = lanSortParams()
        val result = withContext(Dispatchers.IO) {
            runCatching { session.client.browse(session.base, session.token, remotePath, sortBy, sortDir) }
        }.getOrNull() ?: run {
            Log.w(GalleryViewModel.TAG, "[Lan] browse 失败 path 尾=${remotePath.takeLast(12)}")
            return
        }
        // 尾部门禁位同步：验收人中途放开 allow_upload 后，上传入口无需重连即可用
        lanAllowEdit.value = result.allowEdit
        lanAllowUpload.value = result.allowUpload
        val fresh = result.images.filter { it.type != "video" }
        // 阶段 8：目录级元数据增量刷新——桌面反向写描述/标签后，目录内下拉刷新即可见，
        // 不必回总览全量刷新或重连（黑盒用例⑤发现的缺口）
        refreshLanMetaFor(fresh)
        fresh.map { lanImageOf(session, it) }
    }
    // 取数期间用户可能已经导航走，过期结果直接丢弃（与本地分支同一守卫）
    val now = appState.activeTab
    if (now.viewMode == ViewMode.BROWSER && now.folderId == folderId) {
        images.value = imgs
        cachePutImages(key, imgs)
        imagesPending.value = false
        Log.i(GalleryViewModel.TAG, "[Lan] 目录就绪 ${imgs.size} 张（视频项已过滤）")
    }
}

/**
 * 目录级元数据增量刷新（阶段 8 黑盒用例⑤）：把 [items] 的批读结果**并进**
 * [lanMetaByPath]（不替换整表——其他目录的缓存与词表计数不动）并重算远端词表。
 * 桌面反向写描述/标签后，目录内下拉刷新即可见；批读失败仅 Log.w 保留旧缓存
 * （失败降级口径同 [refreshLanLibraryInternal]）。
 */
private suspend fun GalleryViewModel.refreshLanMetaFor(items: List<LanRemoteImage>) {
    if (items.isEmpty()) return
    val session = lan.currentSession() ?: return
    val fresh = HashMap<String, LanMetadataItem>()
    items.map { it.path }.chunked(GalleryViewModel.LAN_METADATA_BATCH_CHUNK).forEach { chunk ->
        val fetched = withContext(Dispatchers.IO) {
            runCatching { session.client.metadataBatch(session.base, session.token, chunk) }
        }
        fetched.getOrNull()?.forEach { fresh[it.path] = it }
            ?: Log.w(GalleryViewModel.TAG, "[Lan] 目录级 metadata/batch 失败（${chunk.size} 项），保留旧缓存")
    }
    if (fresh.isNotEmpty()) {
        lanMetaByPath.value = lanMetaByPath.value + fresh
        rebuildLanRemoteTagGroups()
        Log.i(GalleryViewModel.TAG, "[Lan] 目录级元数据刷新 ${fresh.size} 项")
    }
}

/** 当前 LAN 目录刷新（上传完成后重拉当前目录；完成回调对齐本地 refreshManual）。 */
internal fun GalleryViewModel.refreshLanFolder(onDone: () -> Unit = {}) {
    viewModelScope.launch {
        val folderId = appState.activeTab.folderId
        if (folderId?.startsWith(LAN_FOLDER_ID_PREFIX) == true) reloadLanImages(folderId)
        onDone()
    }
}

/**
 * 上传（LAN 视图入口 → 系统照片选择器多选后调这里）：逐个 multipart（读取本机字节 →
 * LanClient.upload），[onProgress] 逐个回报（宿主转 Toast），全部完成 [onDone] 汇总
 * 并刷新当前目录列表。逐个而非并发：进度可读、服务端 multipart 压力小（React 同款）。
 */
internal fun GalleryViewModel.uploadUrisToLan(
    uris: List<android.net.Uri>,
    targetDir: String,
    onProgress: (index: Int, total: Int, name: String, ok: Boolean, message: String?) -> Unit,
    onDone: (ok: Int, fail: Int) -> Unit,
) {
    val session = lan.currentSession()
    if (session == null || uris.isEmpty()) {
        onDone(0, uris.size)
        return
    }
    viewModelScope.launch {
        var okCount = 0
        var failCount = 0
        uris.forEachIndexed { idx, uri ->
            val name = withContext(Dispatchers.IO) { queryDisplayName(uri) }
                ?: uri.lastPathSegment ?: "upload.img"
            val result = withContext(Dispatchers.IO) {
                runCatching {
                    val bytes = appContext.contentResolver.openInputStream(uri)?.use { it.readBytes() }
                        ?: throw java.io.IOException("无法读取所选图片")
                    val mime = queryMimeType(uri) ?: "image/jpeg"
                    session.client.upload(session.base, session.token, name, mime, bytes, targetDir)
                }
            }
            val ok = result.getOrNull()?.success == true
            if (ok) okCount++ else failCount++
            val message = result.exceptionOrNull()?.message ?: result.getOrNull()?.error
            onProgress(idx + 1, uris.size, name, ok, message)
        }
        Log.i(GalleryViewModel.TAG, "[Lan] 上传完成 ok=$okCount fail=$failCount target=…${targetDir.takeLast(12)}")
        if (okCount > 0) refreshLanFolder()
        onDone(okCount, failCount)
    }
}

/** 源行的 MIME 类型（upload multipart 用；查不到退回 image/jpeg 由调用方兜底）。 */
private fun GalleryViewModel.queryMimeType(uri: android.net.Uri): String? =
    appContext.contentResolver.query(
        uri,
        arrayOf(MediaStore.Images.Media.MIME_TYPE),
        null, null, null,
    )?.use { if (it.moveToFirst()) it.getString(0) else null }

/**
 * 「保存到设备」（查看器菜单，仅 LAN 项；D34）：imageUrl 下载原文件 → MediaStore
 * Downloads insert（RELATIVE_PATH=Download/，文件名取远端 path 尾段，重名由
 * MediaProvider 自动序号）。与 React 的 app 内 lan-cache 临时下载语义差异已在矩阵
 * 登记（移动端「保存」的自然语义=落系统下载）。API < 29 无 Downloads 集合，明确不支持。
 *
 * @param remotePath 远端 path（**只取尾段当文件名**，不解析不回传服务端）
 * @param imageUrl 大图 URL（token in query；LanClient.imageUrl 的产物）
 */
internal fun GalleryViewModel.saveLanImageToDownloads(remotePath: String, imageUrl: String, onDone: (ok: Boolean, savedName: String?) -> Unit) {
    val session = lan.currentSession()
    if (session == null || Build.VERSION.SDK_INT < 29) {
        onDone(false, null)
        return
    }
    viewModelScope.launch {
        val saved = withContext(Dispatchers.IO) {
            runCatching {
                val bytes = session.client.fetchBytes(imageUrl)
                if (bytes.isEmpty()) throw java.io.IOException("下载内容为空")
                insertToDownloads(remotePath, bytes)
            }
        }
        saved.fold(onSuccess = { name ->
            Log.i(GalleryViewModel.TAG, "[Lan] 已保存到下载：$name")
            onDone(true, name)
        }, onFailure = { e ->
            Log.w(GalleryViewModel.TAG, "[Lan] 保存到设备失败", e)
            onDone(false, null)
        })
    }
}

/** MediaStore Downloads insert + 写字节；返回 MediaProvider 最终落定的文件名（重名自动序号）。 */
private fun GalleryViewModel.insertToDownloads(remotePath: String, bytes: ByteArray): String {
    val fileName = remotePath.substringAfterLast('/').ifEmpty {
        "aurora-lan-${System.currentTimeMillis()}.jpg"
    }
    val resolver = appContext.contentResolver
    val values = ContentValues().apply {
        put(MediaStore.MediaColumns.DISPLAY_NAME, fileName)
        put(MediaStore.MediaColumns.MIME_TYPE, mimeForFileName(fileName))
        put(MediaStore.MediaColumns.RELATIVE_PATH, android.os.Environment.DIRECTORY_DOWNLOADS + "/")
        put(MediaStore.MediaColumns.IS_PENDING, 1)
    }
    val collection = MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
    val uri = resolver.insert(collection, values) ?: throw java.io.IOException("MediaStore insert 失败")
    try {
        resolver.openOutputStream(uri)?.use { it.write(bytes) }
            ?: throw java.io.IOException("openOutputStream 失败")
        val done = ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }
        resolver.update(uri, done, null, null)
    } catch (e: Exception) {
        runCatching { resolver.delete(uri, null, null) } // 半截文件不留在下载里
        throw e
    }
    return queryDisplayName(uri) ?: fileName
}

internal fun GalleryViewModel.mimeForFileName(name: String): String = when (name.substringAfterLast('.', "").lowercase(Locale.US)) {
    "png" -> "image/png"
    "jpg", "jpeg" -> "image/jpeg"
    "webp" -> "image/webp"
    "gif" -> "image/gif"
    "bmp" -> "image/bmp"
    "heic", "heif" -> "image/heic"
    else -> "application/octet-stream"
}
