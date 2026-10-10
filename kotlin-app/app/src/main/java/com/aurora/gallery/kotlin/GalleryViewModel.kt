package com.aurora.gallery.kotlin

import android.app.Application
import android.content.ContentUris
import android.content.Context
import android.database.ContentObserver
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import android.util.Log
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.snapshotFlow
import androidx.core.content.ContextCompat
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.aurora.gallery.kotlin.state.AppState
import com.aurora.gallery.kotlin.state.LAN_FOLDER_ID_PREFIX
import com.aurora.gallery.kotlin.state.LAN_ROOT_IMAGES_ID
import com.aurora.gallery.kotlin.state.LAN_SEARCH_FOLDER_ID
import com.aurora.gallery.kotlin.state.SettingsStore
import com.aurora.gallery.kotlin.state.LayoutVisibility
import com.aurora.gallery.kotlin.state.SortDirection
import com.aurora.gallery.kotlin.state.SortOption
import com.aurora.gallery.kotlin.state.ViewMode
import com.aurora.gallery.kotlin.state.lanFolderId
import com.aurora.gallery.kotlin.state.lanPersonFolderId
import com.aurora.gallery.kotlin.state.lanPersonIdOrNull
import com.aurora.gallery.kotlin.state.lanRemotePathOrNull
import com.aurora.gallery.kotlin.state.lanTagFilterOrNull
import com.aurora.gallery.kotlin.state.lanTopicFolderId
import com.aurora.gallery.kotlin.state.lanTopicIdOrNull
import com.aurora.gallery.kotlin.state.localPersonFolderId
import com.aurora.gallery.kotlin.state.localPersonIdOrNull
import com.aurora.gallery.kotlin.ui.components.ROOT_FOLDER_DISPLAY_NAME
import com.aurora.gallery.kotlin.ui.components.sortImages
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext
import com.aurora.gallery.kotlin.state.toAiConfig
import uniffi.aurora_core.AiInputItem
import uniffi.aurora_core.AiRenameCallback
import uniffi.aurora_core.AiRenameItem
import uniffi.aurora_core.AiTaskCallback
import uniffi.aurora_core.ColorBatchCallback
import uniffi.aurora_core.ColorPixels
import uniffi.aurora_core.FfiFileMetadata
import uniffi.aurora_core.FfiFaceBox
import uniffi.aurora_core.FfiPerson
import uniffi.aurora_core.FfiTopic
import uniffi.aurora_core.Folder
import uniffi.aurora_core.Image
import uniffi.aurora_core.MediaImage
import uniffi.aurora_core.RemoteTagCount
import uniffi.aurora_core.SearchItem
import uniffi.aurora_core.TagGroup
import uniffi.aurora_core.addFilesToTopic
import uniffi.aurora_core.addTagsToFiles
import uniffi.aurora_core.aiAnalyzeFiles
import uniffi.aurora_core.aiApplySearchFilter
import uniffi.aurora_core.aiCancelTask
import uniffi.aurora_core.aiGenerateFileNames
import uniffi.aurora_core.aiRewriteSearchQuery
import uniffi.aurora_core.batchExtractColors
import uniffi.aurora_core.cancelColorTask
import uniffi.aurora_core.cleanupColorNonexistent
import uniffi.aurora_core.colorDbStats
import uniffi.aurora_core.deleteColorErrorFiles
import uniffi.aurora_core.deleteIndexEntries
import uniffi.aurora_core.deletePerson
import uniffi.aurora_core.deleteTopic as deleteTopicFfi
import uniffi.aurora_core.extractAndSaveColors
import uniffi.aurora_core.getAllFileMetadata
import uniffi.aurora_core.getAllFileTags
import uniffi.aurora_core.getAllPeople
import uniffi.aurora_core.getAllTopics
import uniffi.aurora_core.getColorsByFilePaths
import uniffi.aurora_core.getGroupedTags
import uniffi.aurora_core.getColorErrorFiles
import uniffi.aurora_core.getFileMetadata
import uniffi.aurora_core.getTopicFiles
import uniffi.aurora_core.generateId
import uniffi.aurora_core.groupRemoteTagCounts
import uniffi.aurora_core.initColorDb
import uniffi.aurora_core.initDb
import uniffi.aurora_core.listFolders
import uniffi.aurora_core.listImages
import uniffi.aurora_core.listImagesByIds
import uniffi.aurora_core.listImagesByTags
import uniffi.aurora_core.pauseColorTask
import uniffi.aurora_core.removeFileFromTopic
import uniffi.aurora_core.resumeColorTask
import uniffi.aurora_core.retryColorErrorFiles
import uniffi.aurora_core.searchByColor
import uniffi.aurora_core.setFileTags
import uniffi.aurora_core.setTopicFiles
import uniffi.aurora_core.upsertFileMetadata
import uniffi.aurora_core.upsertMediaImage
import uniffi.aurora_core.upsertMediaImages
import uniffi.aurora_core.updatePersonAvatar
import uniffi.aurora_core.upsertPerson
import uniffi.aurora_core.upsertTopic
import java.io.File
import java.util.Locale
import java.util.UUID

/**
 * 应用数据与 UI 状态的持有者（ViewModel：生存期跨越旋转等配置变更重建）。
 *
 * 此前 folders / images / scanning / AppState / ThumbnailLoader 全挂在 MainActivity
 * 字段上，而旋转默认销毁重建 Activity（Manifest 未声明 configChanges），一次旋转 =
 * 状态全丢 + 全量重扫 + 缩略图内存缓存清空。上移到 ViewModel 后三者都跨重建保留，
 * [startScanIfNeeded] 的 scanStarted 守卫让重建后的 onCreate 不再重跑扫描。
 * 进程死亡仍会重置，持久化待后续里程碑评估。
 *
 * 热更新：通过 [mediaStoreObserver] 监听 MediaStore 变更（注册跟随 MainActivity 的
 * onStart/onStop），外部增删图片防抖后自动重跑扫描管道，应用开着无需重启即可看到新图。
 */
class GalleryViewModel(app: Application, initialLayout: LayoutVisibility) : ViewModel() {

    // internal 而非 private：文件操作簇在 GalleryViewModelFileOps.kt（扩展函数）里要用
    internal val appContext = app.applicationContext

    val folders = mutableStateOf<List<Folder>>(emptyList())
    val images = mutableStateOf<List<Image>>(emptyList())
    /**
     * 序列取数进行中（[reloadImages]/[reloadLanImages] 换视图清空之后、结果落地之前）。
     * 空态文案（「文件夹为空」等）只在 `!imagesPending && images.isEmpty()` 时显示：
     * 「还没查完」不是「真的空」，清空到落地之间的窗口把空态文案亮出来，就是用户看到的
     * 「进文件夹先闪一两帧文件夹为空」（M8b-23 用户报障）。
     */
    val imagesPending = mutableStateOf(false)
    val scanning = mutableStateOf(false)

    /**
     * 进目录即时首发的序列缓存（key 见 [sequenceKey]/[lanSequenceKey]）：近期看过的目录
     * 再进时，[openFolder] 在导航切换**之前**同步把缓存发布进 [images]，重组的第一帧就
     * 是网格而不是「文件夹为空」；随后的 [reloadImages] 因 key 相同不清空，查询落地后
     * 照常对账纠偏（stale-while-revalidate）。写入只走 [cachePutImages]（LRU 双限淘汰，
     * 防大库把整个索引抬进内存）；[scanAndReconcile] **不**清它——对账会因任何应用触碰
     * MediaStore 频繁触发，整表清空等于打回每次冷启，过期项靠进夹时的重查自愈。
     */
    // internal 而非 private：LAN 浏览簇已拆到 GalleryViewModelLanBrowse.kt（扩展函数）里要用
    internal val imagesCacheByKey = LinkedHashMap<String, List<Image>>(16, 0.75f, true)

    // —— M4a 2.0 标签数据层 ——
    //
    // 三份快照的唯一读源：查看器抽屉（2.2）、侧栏标签 Section（3.1）、标签过滤（4.1）
    // 都只读这三个，不许自己去查库。分头查就是三份缓存配三套失效时机，写完之后必然
    // 有一处是旧的。
    //
    // 唯一写者是 [reloadTagState]（全量重算，不做增量）：标签量级是「千」不是「万」，
    // 一次 SQL 分组比维护增量正确性便宜。

    /** `file_id` → 该文件上的标签，保持库里的先后顺序（`file_tags` 是安卓侧唯一真源）。 */
    val tagsByFile = mutableStateOf<Map<String, List<String>>>(emptyMap())

    /** `file_id` → 元数据行。只有**编辑过**的文件才在这一列里有行，所以量很小。 */
    val metadataById = mutableStateOf<Map<String, FfiFileMetadata>>(emptyMap())

    /** 侧栏要看的分组 + 计数。**顺序由 Rust 定**，UI 侧不再排（清单 §1「排序规则只许有一套」）。 */
    val tagGroups = mutableStateOf<List<TagGroup>>(emptyList())

    // —— M4a 3.2 专题数据层 ——
    // 与标签快照同一条纪律：总览/详情/选择弹窗三处都读这两份，唯一写者是 [reloadTopics]，
    // 所有专题写操作（建/归入/移除）落库后必须调它刷新，不许自己改列表。

    /** 全部专题（Rust `get_all_topics`）。列表口径用 [FfiTopic.fileCount]（fileIds 懒加载恒空）。 */
    val topics = mutableStateOf<List<FfiTopic>>(emptyList())

    /** 专题封面解析：coverFileId → Image（一次 `list_images_by_ids` 取齐）。 */
    val coverImagesById = mutableStateOf<Map<String, Image>>(emptyMap())

    /** [reloadImages] 上次取数用的序列源（folder|tags|topic 的复合 key），区分「换视图」与「同一视图热刷新」。 */
    // internal 而非 private：LAN 浏览簇已拆到 GalleryViewModelLanBrowse.kt（扩展函数）里要用
    internal var loadedImagesKey: String? = null

    /** 序列源复合 key 的唯一拼装点（folder|tags|topic 三输入）：[reloadImages] 判「换视图」
     *  与 [openFolder] 的首发缓存共用，别处不许手拼——格式漂移 = 首发缓存认不出 key。 */
    // internal 而非 private：Q 路径原语簇已拆到 GalleryViewModelQPaths.kt（扩展函数）里要用
    internal fun sequenceKey(folderId: String?, tags: Collection<String>, topicId: String?): String =
        "f=${folderId ?: "-"}|g=${tags.joinToString(",")}|t=${topicId ?: "-"}"

    /** LAN 序列源的 key（[reloadLanImages] 清空判定与 [openFolder] 首发缓存共用，同理不许手拼）。 */
    // internal 而非 private：LAN 浏览簇已拆到 GalleryViewModelLanBrowse.kt（扩展函数）里要用
    internal fun lanSequenceKey(folderId: String): String = "lan|$folderId"

    /** 当前活动 tab 的序列源 key（发布/失败守卫与 [imagesPending] 复位共用）。 */
    // internal 而非 private：LAN 浏览簇已拆到 GalleryViewModelLanBrowse.kt（扩展函数）里要用
    internal fun activeSequenceKey(): String {
        val now = appState.activeTab
        return sequenceKey(
            now.folderId,
            now.activeTags,
            if (now.viewMode == ViewMode.TOPICS_OVERVIEW) now.activeTopicId else null,
        )
    }

    /** 首发缓存的唯一写入口：LRU 双限（条目 ≤6 且图片总数 ≤1.5 万，约几 MB 对象开销），超限从头淘汰。 */
    // internal 而非 private：Q 路径原语簇已拆到 GalleryViewModelQPaths.kt（扩展函数）里要用
    internal fun cachePutImages(key: String, imgs: List<Image>) {
        imagesCacheByKey[key] = imgs
        while (imagesCacheByKey.size > 6 || imagesCacheByKey.values.sumOf { it.size } > 15_000) {
            val eldest = imagesCacheByKey.entries.iterator()
            if (!eldest.hasNext()) break
            eldest.next()
            eldest.remove()
        }
    }

    /** 应用级 UI 状态（3.1）：标签页 / 导航历史 / 选中 / 档位 / 面板可见性。 */
    val appState = AppState(initialLayout = initialLayout)

    /**
     * 画布状态（M5 1.1，D21 单实例）：items/视口/z 序/选中/编辑态的唯一写者。
     * 进程内保活——退出画布视图数据不丢，进程被杀回空（React tab 内存态同语义）。
     */
    val canvasStore = com.aurora.gallery.kotlin.canvas.CanvasStore()

    /** 设置的唯一读写口（2.1，D15=SharedPreferences；专题排序已并入）。 */
    val settingsStore = SettingsStore(appContext)

    /**
     * D50：更新检查（GitHub→Gitee 双源清单 + 应用内下载安装）。
     * 挂在 ViewModel 作用域而不是 Activity：APK 下载是长任务，旋屏/重建不能被掐断。
     */
    val updateController = com.aurora.gallery.kotlin.update.UpdateController(appContext, viewModelScope)

    /**
     * M6a 阶段 3：LAN 客户端连接状态机（auth/心跳/周期重试/重启恢复）。
     * 状态与远端目录经 [LanManager.snapshot] StateFlow 暴露，设置 LAN 面板与侧栏
     * 网络 Section 消费；LAN 会话是纯 HTTP（LanClient），本地库/词表零接触。
     */
    val lan = LanManager(appContext, settingsStore)

    /**
     * M6a 阶段 7：对等服务端单例（init 幂等；认证随 peer_server 上报 / 断开联动停 /
     * 配对反向连接的接线见 init 块）。运行态经 [LanServerManager.snapshot] StateFlow
     * 暴露，设置面板「允许桌面浏览本机」开关消费。
     */
    val lanServer = LanServerManager.init(appContext, settingsStore)

    /** M6a 阶段 7：宿主（MainActivity）转接给设置面板的只读口（未 init 时 null）。 */
    val lanServerManager get() = LanServerManager.get()

    // —— M6a 阶段 4/5：LAN 浏览会话态 ——
    //
    // 纯内存会话数据（断线清空）：**只服务 LAN 视图的显示**，绝不写入本地库/本地词表
    // （清单 §1 命名空间铁律；阶段 5 的唯一 FFI 触点 = [rebuildLanRemoteTagGroups] 里的
    // groupRemoteTagCounts **纯函数**做远端词表分组，排序规则只许有一套、不碰本地库）。
    // 唯一写者是连接联动触发的 [refreshLanRootsInternal]、[reloadLanImages] 的尾部门禁位
    // 同步，以及阶段 5 的远端写路径（LanClient + 响应条目乐观更新，见「M6a 阶段 5」区段）。

    /** 连接已就绪（snapshot CONNECTED 且 all_image_folders 拉取成功过一次）。 */
    val lanConnected = mutableStateOf(false)

    /** 门禁位（browse/all_image_folders 尾部下发，D32；上传入口置灰消费 lanAllowUpload）。 */
    val lanAllowEdit = mutableStateOf(true)
    val lanAllowUpload = mutableStateOf(false)

    /**
     * LAN 总览的文件夹卡片序列（**数据层算好的结构**，UI 原样渲染）：
     * `__lan_root_images__` 虚拟根置顶（有根级散图才放；对齐 React
     * FoldersOverview.tsx:649-650），其余按服务端 all_image_folders 的原序。
     */
    val lanOverviewFolders = mutableStateOf<List<Folder>>(emptyList())

    /** 根级散图（虚拟根的网格内容；浏览不单独 browse，React useLanClientSync 同款）。 */
    // internal 而非 private：LAN 浏览簇已拆到 GalleryViewModelLanBrowse.kt（扩展函数）里要用
    internal val lanRootImages = mutableStateOf<List<LanRemoteImage>>(emptyList())

    // —— M6a 阶段 5：远端库会话缓存（D31 数据层铁律的落点）——
    //
    // 全部纯内存 mutableStateOf，**整个 LAN 会话期间本地词表/本地库/本地过滤零变化**：
    // 远端写一律走 LanClient（成功后用响应条目做乐观更新），绝不调 saveFileUpdates /
    // upsertTopic / setFileTags / reloadTagState / reloadTopics 等任何本地写路径——
    // 远端词表的新词只进下面这几份缓存，桌面词表由服务端自行维护。

    /**
     * 远端库图片缓存：path → browse 项（全部远端目录 + 根散图合并；type=video 不进，
     * 对齐 [reloadLanImages] 的网格过滤口径）。tag 筛选虚拟目录的数据源，不再 browse。
     */
    val lanLibraryImages = mutableStateOf<Map<String, LanRemoteImage>>(emptyMap())

    /** path → 远端元数据行（metadata/batch 的会话缓存；写成功后用响应条目整行覆盖）。 */
    val lanMetaByPath = mutableStateOf<Map<String, LanMetadataItem>>(emptyMap())

    /**
     * 远端词表分组：lanMetaByPath 聚合出的 tag→count 交 groupRemoteTagCounts 纯函数的
     * 产物。组序/组内序全由 Rust 定（「排序规则只许有一套」），Kotlin 侧不自己排。
     */
    val lanRemoteTagGroups = mutableStateOf<List<TagGroup>>(emptyList())

    /** 远端人物（GET /api/people 会话缓存；写成功后重拉刷新，失败保留旧列表）。 */
    val lanPeople = mutableStateOf<List<LanPerson>>(emptyList())

    /** 远端专题（GET /api/topics 会话缓存；写成功后重拉刷新，失败保留旧列表）。 */
    val lanTopics = mutableStateOf<List<LanTopic>>(emptyList())

    // —— M6b 阶段 4/5：LAN AI 视觉与成员筛选（契约 §8；会话态同「断线清空」纪律）——

    /**
     * 桌面词表（`GET /api/vocab`，D40）：与本地词表**两套不混**（契约 §8.6），只读作
     * 输入建议。连接成功后随 [refreshLanLibraryInternal] 尾随拉取，失败静默保旧；断线清空。
     */
    val lanVocab = mutableStateOf<List<String>>(emptyList())

    /**
     * 本地人物快照（FFI `getAllPeople`）：WD14 人物管线（[startWd14PersonPipeline]）
     * 落库后经 [reloadLocalPeople] 刷新。与 [lanPeople]（远端人物）是两套数据，互不相干。
     */
    val localPeople = mutableStateOf<List<FfiPerson>>(emptyList())

    /**
     * 本地人物封面解析：coverFileId → Image（一次 `list_images_by_ids` 取齐，形制同
     * [coverImagesById] 之于专题）。人物卡的真头像靠它把 id 换成 contentUri，再进
     * ThumbnailLoader；查不到（图已删/未索引）就退回首字符占位。随 [refreshLocalPeople] 重算。
     */
    val personCoverImagesById = mutableStateOf<Map<String, Image>>(emptyMap())

    /** LAN 搜索请求进行中（入口置灰消费；复位在 performLanSearch 的 finally）。 */
    val lanSearchBusy = mutableStateOf(false)

    /**
     * LAN 搜索命中（path→score；null = 非 LAN 搜索结果态）。语义与 [aiSearchIds] 同构：
     * 非 null 即「LAN 搜索结果视图」，网格内容由 [reloadLanImages] 的
     * [com.aurora.gallery.kotlin.state.LAN_SEARCH_FOLDER_ID] 分支渲染（按 score 降序，
     * 会话缓存里没有的 path 跳过）。performLanSearch / findSimilarOnDesktop 写、clearLanSearch 清。
     */
    val lanSearchHits = mutableStateOf<List<Pair<String, Double>>?>(null)

    /**
     * 成员筛选（人物/专题虚拟目录）的会话内存集：[openLanPersonFilter] / [openLanTopicFilter]
     * 进入时拉好，[reloadLanImages] 成员分支消费。归属记在 [pendingMemberPathsFolderId]——
     * 「人物 A → 人物 B → 返回 A」回导航时集合已换人，folderId 对不上就重拉端点；
     * 进程重建后为 null 同样重拉。
     */
    // internal 而非 private：LAN 浏览簇已拆到 GalleryViewModelLanBrowse.kt（扩展函数）里要用
    internal var pendingMemberPaths: Set<String>? = null
    internal var pendingMemberPathsFolderId: String? = null

    /** 连接成功后的会话拉取协程（刷新时可 join；断线时 cancel）。 */
    // internal 而非 private：LAN 浏览簇已拆到 GalleryViewModelLanBrowse.kt（扩展函数）里要用
    internal var lanFetchJob: Job? = null

    /** 扫描通知（阶段 5，D17 基础版：初始扫描与手动刷新上进度/完成通知）。 */
    // internal 而非 private：颜色库簇已拆到 GalleryViewModelColors.kt（扩展函数）里要用（进度通知栏）
    internal val scanNotifier = ScanNotifier(appContext)

    val thumbnailLoader = ThumbnailLoader(appContext)

    /** 本次 ViewModel 生存期内是否已启动过扫描；旋转重建复用同一实例，直接跳过重扫。 */
    private var scanStarted = false

    /**
     * 初始扫描协程。热刷新在它结束前触发时 join 等待：既不重复跑管道，也不丢扫描
     * 期间落地的变更（扫完后再对账一次）。isCompleted==true 即回前台兜底可安全运行。
     */
    private var initialScanJob: Job? = null

    /** 串行化「扫描 → 对账 → 刷新」管道：初始扫描与热刷新不并发写库。 */
    private val scanMutex = Mutex()

    /** MediaStore 变更通知的防抖协程：通知风暴只留最后一次，平静 [MEDIA_CHANGE_DEBOUNCE_MS] 后对账一次。 */
    private var mediaChangeJob: Job? = null

    /**
     * 合并「写操作后主动刷新」与「MediaStore 变更观察者」两条刷新路径：取消重建同一个
     * 防抖任务，一次写操作只跑一次全量对账。
     *
     * 为什么合并：一次复制会连带 scanner 登记新行、（移动/重命名还有）旧行删除等连发
     * 多条 MediaStore 通知。旧码里写操作的主动对账立即起跑、观察者的防抖对账另起炉灶，
     * 互不取消——真机日志实测一次复制串成 **3 次**全量扫描（2.6 万行每次约 2.4s，老机上
     * 直接把随后几秒的 UI 拖卡，2026-10-07）。合并后通知风暴收敛成一次；副本/新路径的
     * 即时可见由单行 upsert 负责，不等这次对账。
     */
    // internal 而非 private：文件操作簇在 GalleryViewModelFileOps.kt（扩展函数）里要用
    internal fun scheduleHotRefresh() {
        mediaChangeJob?.cancel()
        mediaChangeJob = viewModelScope.launch {
            delay(MEDIA_CHANGE_DEBOUNCE_MS)
            // 初始扫描若还在跑，等它结束再补一次对账（变更可能落在扫描查询之后，不能丢）
            initialScanJob?.join()
            hotRefresh()
        }
    }

    /**
     * MediaStore 变更监听（注册/注销跟随 onStart/onStop，见 MainActivity）：应用开着时
     * 外部新增/删除/修改图片（相机、截图、MTP 拷入）也能热更新，不再需要重启应用刷新。
     */
    private val mediaStoreObserver = object : ContentObserver(null) {
        override fun onChange(selfChange: Boolean, uri: Uri?) {
            // 拷入一批文件会连发一串通知：取消重建防抖任务，等通知流平静后合并成一次重扫
            scheduleHotRefresh()
        }
    }

    /**
     * 应用设置（M4b 2.1/2.2，D15=SharedPreferences）。当前唯一的响应式消费方是
     * 语言开关（标签 collation）；其余项只在设置面板读写。声明在 init 之前供其应用默认值。
     */
    val settings = mutableStateOf(settingsStore.load())

    /**
     * 本地总览封面重选结果（folderId → 封面 contentUri）。Compose state：宿主组合直接
     * `.value` 读，重算落地即触发重组。无直接子图 / FFI 失败的文件夹**缺项**——消费方
     * 回退该文件夹的原 cover_uri（「根目录图片」等虚拟目录同样走缺项回退）。
     *
     * **必须声明在下面 init 之前**：init 里那条 snapshotFlow 订阅会在构造期就同步跑到
     * `localCoverOverrides.value = ...`，Kotlin 按声明顺序初始化属性，晚声明就是 null ——
     * 实测启动崩过一次（NPE at refreshLocalOverviewCovers，GalleryViewModel.kt:4881）。
     */
    val localCoverOverrides = mutableStateOf<Map<String, String>>(emptyMap())

    /** 上次封面重算的口径 key（排序 + 文件夹列表指纹）；不变则跳过重算。 */
    private var localCoverKey: String? = null

    /** 在跑的封面重算协程（新口径到来时取消旧的，防乱序落地）。 */
    private var localCoverJob: Job? = null

    init {
        // 初始化 Rust 数据库（filesDir 下）；DB_POOL 已初始化时 Rust 侧 set 幂等忽略
        initDb(File(appContext.filesDir, "aurora.db").absolutePath)
        // M4b 2.1：默认布局与排序持久化——应用设置里的默认值压在 AppState 的初始值上
        appState.sortBy = settings.value.defaultSortBy
        appState.sortDirection = settings.value.defaultSortDirection
        appState.updateActiveTab { it.copy(layoutMode = settings.value.defaultLayout) }
        // M4c：默认分组同理（GroupBy 渲染能力 M1 已有，这里只补持久化默认值）
        appState.groupBy = settings.value.defaultGroupBy
        // 2026-10 排序改造：本地总览封面随排序重选。订阅排序与文件夹列表的变化
        // （Compose snapshot 状态），变化即触发一次逐文件夹重算（内部有 key 守卫，
        // 重复发射与首帧发射都幂等；本地空库/LAN 模式下 folders 为空，重算空转）。
        viewModelScope.launch {
            snapshotFlow { Triple(appState.sortBy, appState.sortDirection, folders.value) }
                .collect { (by, dir, fs) -> refreshLocalOverviewCovers(by, dir, fs) }
        }
        // M6a 阶段 3：有持久化 LAN 连接（token 未过期场景）就静默验证并自动恢复
        lan.start()
        // 本地人物快照：启动即拉一次。此前只在 WD14 识别完成后刷新（399x），
        // 结果"库里已经有人物"也要等下一次识别才显示（2026-10-08 指挥官实测：
        // 人物页在做过识别之前恒为空）——人物和标签一样是库里的事实，进页面就该看得见。
        reloadLocalPeople()
        // M6a 阶段 7：对等服务端启动恢复（持久化开关为开才自启，内部异步）+ 配对回调接线
        lanServer.autoStartIfEnabled()
        lanServer.onPeerPairing = { host, port, code, _ ->
            // React handlePeerPairing android 分支同款：跳过回环（模拟器/本机回测场景假配对）、
            // 已连同一台不重复连；连别的桌面 = 切换连接（对齐 React 覆盖语义）。
            // port<=0 = 对端 peer_server 缺 port 的畸形负载（Rust serde 会拒整请求，这里降级忽略）。
            if (port <= 0) {
                Log.d(TAG, "[LanServer] 配对回调忽略（peer_server 无有效端口）host=$host")
            } else if (host == "127.0.0.1" || host == "localhost" || host == "::1") {
                Log.d(TAG, "[LanServer] 配对回调忽略回环地址 host=$host:$port")
            } else if (lan.snapshot.value.state == LanState.CONNECTED &&
                lan.snapshot.value.host == host && lan.snapshot.value.port == port
            ) {
                Log.d(TAG, "[LanServer] 配对回调忽略（已连接同一桌面）host=$host:$port")
            } else {
                Log.d(TAG, "[LanServer] 配对回调：反向连接桌面 $host:$port")
                lan.connect("$host:$port", code)
            }
        }
        // M6a 阶段 4：连接态变化联动会话态——CONNECTED 拉远端目录+根散图；
        // 回到 DISCONNECTED 清会话态，且当前在 LAN 视图时自动退回本地视图（无残留）。
        viewModelScope.launch {
            var wasConnected = false
            lan.snapshot.collect { snap ->
                val connected = snap.state == LanState.CONNECTED
                when {
                    connected && !wasConnected -> refreshLanRootsInternal()
                    !connected && wasConnected -> {
                        lanFetchJob?.cancel()
                        clearLanSession()
                        val wasInLanView = appState.isInLanView
                        if (wasInLanView) appState.exitLanToHome()
                        Log.i(TAG, "[Lan] 断线联动：会话态已清${if (wasInLanView) "，LAN 视图在前台→已退回本地总览" else "，当前不在 LAN 视图"}")
                    }
                }
                wasConnected = connected
            }
        }
    }

    /** 语言切换（M4a 顺延项 1）：换 locale → 重算标签快照 → 侧栏分组顺序变。 */
    fun setLanguage(language: String) {
        if (language == settings.value.language) return
        settings.value = settings.value.copy(language = language)
        settingsStore.save(settings.value)
        viewModelScope.launch { reloadTagState() }
    }

    // —— M6b 阶段 2：AI 任务层（编排/取消/搜索改写在 core ai_task，本层=状态+入口+落库后刷新）——

    /** AI 任务运行态（null=空闲）；通知「取消」action 与任务同生命周期。 */
    data class AiTaskState(val kind: String, val taskId: String, val current: Int, val total: Int)

    val aiTaskState = mutableStateOf<AiTaskState?>(null)

    /** AI 改名提案（任务跑完一次性弹确认；null=无待确认）。Triple=Image/旧名/新名。 */
    val aiRenameProposals = mutableStateOf<List<Triple<Image, String, String>>?>(null)

    /** AI 搜索命中 id 集（null=未启用/已清；空集=搜了但零命中）。 */
    val aiSearchIds = mutableStateOf<Set<String>?>(null)

    /** AI 搜索的全库命中序列（[aiSearchIds] 非空时的网格/查看器数据源——文本搜索是
     * 视图级语义而 AI 搜索是全库语义，命中图可能不在当前文件夹序列里）。 */
    val aiSearchResultImages = mutableStateOf<List<Image>?>(null)

    /** AI 搜索请求进行中（TopBar 图标态）。 */
    val aiSearchBusy = mutableStateOf(false)

    // internal 而非 private：AI 任务簇已拆到 GalleryViewModelAiTasks.kt（扩展函数）里要用；
    // LAN 侧 startWd14PersonPipeline 也读它
    internal var aiJob: Job? = null

    /**
     * WD14 人物管线的 Kotlin 侧取消标志（M8b 阶段 3，遗留 #8）：该管线是 HTTP 直连
     * 逐张循环，不进 core 取消注册表（ai_task.rs 只管 aiAnalyzeFiles 系任务），通知
     * 「取消」此前对它空转。现在 [cancelAiTask] 对 `lan-wd14-` 前缀的 taskId 置此标志，
     * [startWd14PersonPipeline] 每张迭代首查生效（在途一张跑完）。AtomicBoolean：置位
     * 在主线程（广播 receiver），查在协程各切回点，跨线程可见性靠它保证。
     */
    // internal 而非 private：AI 任务簇已拆到 GalleryViewModelAiTasks.kt（扩展函数）里要用；
    // LAN 侧 startWd14PersonPipeline 也读它
    internal val wd14Cancelled = java.util.concurrent.atomic.AtomicBoolean(false)

    // —— M6b 阶段 3：颜色库任务层（提取/搜索/批量/统计都在 core color_ffi，本层=状态+像素供给+入口）——
    //
    // 键语义（core color_ffi.rs 模块注释）：一切 file_id = content URI 哈希（MediaStore
    // `_id` 派生，改名/移动不变形），落 colors.db 的 file_path 列。LAN 项（path 是 http
    // URL）不进颜色库——调用方必须用 contentUri 判别，本层 decodeRgba 也再拦一道。

    /**
     * 主色调节统计（colorDbStats 的 UI 形；null=面板未加载过）。
     *
     * [libraryImages]：本地图库图片总数（桌面「当前目录图片数」的安卓对应量），用于推算
     * 尚未入库的图片数（= 本值 − extracted − pending）；-1 = 本次刷新还没取到。
     * [dbSizeBytes]：colors.db（含 WAL/SHM）磁盘占用，对应桌面 StoragePanel「数据库大小」。
     */
    data class ColorDbStatsUi(
        val total: Int,
        val pending: Int,
        val extracted: Int,
        val error: Int,
        val libraryImages: Int = -1,
        val dbSizeBytes: Long = 0L,
    )

    /** 批量提取任务运行态（null=空闲）。paused 由本层维护（Rust 只发终态）。 */
    data class ColorTaskState(val current: Int, val total: Int, val paused: Boolean)

    /** file_id → 主色调 hex 列表（查看器抽屉色块预填源；全量批读+提取成功增量）。 */
    val colorPalettesById = mutableStateOf<Map<String, List<String>>>(emptyMap())

    val colorStats = mutableStateOf<ColorDbStatsUi?>(null)

    val colorTaskState = mutableStateOf<ColorTaskState?>(null)

    /** 错误文件条数（明细列表不进 UI，操作走全体重试/删除/清理三口）。 */
    val colorErrorCount = mutableStateOf(0)

    /** 颜色搜索命中 id 集（null=非颜色过滤态；与 [aiSearchIds] 共用 DisplayPipeline 过滤分支，互斥）。 */
    val colorSearchIds = mutableStateOf<Set<String>?>(null)

    /** 当前过滤色（TopBar 胶囊芯片/取色按钮高亮；与 [colorSearchIds] 同生命周期）。 */
    val colorSearchHex = mutableStateOf<String?>(null)

    /** 颜色搜索的全库命中序列（[colorSearchIds] 非空时的网格/查看器数据源）。 */
    val colorSearchResultImages = mutableStateOf<List<Image>>(emptyList())

    val colorSearchBusy = mutableStateOf(false)

    // internal 而非 private：颜色库簇已拆到 GalleryViewModelColors.kt（扩展函数）里要用
    internal val colorDbMutex = Mutex()

    // internal 而非 private：同上，颜色库簇在 GalleryViewModelColors.kt（扩展函数）里要用
    @Volatile
    internal var colorDbReady = false

    // internal 而非 private：同上，颜色库簇在 GalleryViewModelColors.kt（扩展函数）里要用
    internal var colorTaskId: String? = null

    /** 颜色搜索进行中到达的最新请求色（HSV 面板防抖连发时补跑用，见 startColorSearch）。 */
    // internal 而非 private：同上，颜色库簇在 GalleryViewModelColors.kt（扩展函数）里要用
    @Volatile
    internal var pendingColorHex: String? = null

    /** 提取中的 file_id 集（自动提取翻页连发与手动按钮同 id 并发防重）。 */
    // internal 而非 private：同上，颜色库簇在 GalleryViewModelColors.kt（扩展函数）里要用
    internal val inFlightPalettes = java.util.Collections.synchronizedSet(mutableSetOf<String>())

    // —— M5 画布数据助手（3.1/3.2/3.3 入口共用的取数口；id/宽高一律以 FFI 索引为准）——

    /**
     * 把一批 file id 解析成画布装箱输入（id/宽高/contentUri 都来自 `list_images_by_ids`，
     * 与网格/查看器的 file id 同源；宽高空缺兜底 React 同款 1000×750）。
     */
    fun canvasSourcesFor(fileIds: Collection<String>, onReady: (List<com.aurora.gallery.kotlin.canvas.CanvasPackSource>) -> Unit) {
        viewModelScope.launch {
            val sources = withContext(Dispatchers.IO) {
                listImagesByIds(fileIds.toList()).map { img ->
                    com.aurora.gallery.kotlin.canvas.CanvasPackSource(
                        id = img.id,
                        width = img.width?.toFloat() ?: 1000f,
                        height = img.height?.toFloat() ?: 750f,
                        contentUri = img.contentUri,
                    )
                }
            }
            onReady(sources)
        }
    }

    /**
     * 添加图片弹窗（3.3）的四类数据源：all=全库（各相册并集）、folder=相册、
     * topic=专题成员、tag=标签命中。全走 FFI，保证 id 与画布去重键一致。
     */
    fun loadCanvasPickerImages(scope: String, key: String, onReady: (List<Image>) -> Unit) {
        viewModelScope.launch {
            val imgs = withContext(Dispatchers.IO) {
                runCatching {
                    when (scope) {
                        "all" -> folders.value.flatMap { listImages(it.id) }.distinctBy { it.id }
                        "folder" -> key.takeIf { it.isNotEmpty() }?.let { listImages(it) } ?: emptyList()
                        "topic" -> key.takeIf { it.isNotEmpty() }
                            ?.let { t -> getTopicFiles(t).takeIf { it.isNotEmpty() }?.let { listImagesByIds(it) } }
                            ?: emptyList()
                        "tag" -> key.takeIf { it.isNotEmpty() }?.let { listImagesByTags(listOf(it)) } ?: emptyList()
                        else -> emptyList()
                    }
                }.getOrElse {
                    Log.w(TAG, "[Canvas] picker load failed scope=$scope key=$key", it)
                    emptyList()
                }
            }
            onReady(imgs)
        }
    }
    /** 备份导入后的快照重算（词表/人物/专题都可能有变）。 */
    fun refreshTagSnapshots() {
        viewModelScope.launch {
            reloadTagState()
            reloadTopics()
        }
    }

    /** 默认布局变更：落设置并即时应用到当前标签（2.1「改一项 → 重启还在」+ 所见即所得）。 */
    fun applyDefaultLayout(layout: com.aurora.gallery.kotlin.ui.components.LayoutMode) {
        settings.value = settings.value.copy(defaultLayout = layout)
        settingsStore.save(settings.value)
        appState.updateActiveTab { it.copy(layoutMode = layout) }
    }

    /** 默认排序变更：同上。 */
    fun applyDefaultSort(by: com.aurora.gallery.kotlin.state.SortOption, direction: com.aurora.gallery.kotlin.state.SortDirection) {
        settings.value = settings.value.copy(defaultSortBy = by, defaultSortDirection = direction)
        settingsStore.save(settings.value)
        appState.sortBy = by
        appState.sortDirection = direction
    }

    /** 默认分组变更：同上（M4c，即时应用到当前网格 + 重启还在）。 */
    fun applyDefaultGroupBy(groupBy: com.aurora.gallery.kotlin.ui.components.GroupBy) {
        settings.value = settings.value.copy(defaultGroupBy = groupBy)
        settingsStore.save(settings.value)
        appState.groupBy = groupBy
    }

    /**
     * 主题档变更（M4c，"light" | "dark" | "system"）：只落设置。生效链在 MainActivity
     * —— setContent 按 settings.theme + 系统 uiMode 推导 dark 后驱动 AuroraTheme、
     * 窗口底色/状态栏外观与查看器 isDark（"system" 的系统档变化走 onConfigurationChanged）。
     */
    fun setTheme(theme: String) {
        if (theme == settings.value.theme) return
        settings.value = settings.value.copy(theme = theme)
        settingsStore.save(settings.value)
    }

    /**
     * 扫描 MediaStore 并刷新索引，「先旧后新」：库里已有上次的数据就立即上屏，
     * 全量查询 + upsert 转后台跑，完成后再刷新列表。只有空库（首次启动）才用
     * 全屏扫描页挡住——启动感知耗时从「全量扫描」降到「一次本地查询」。
     */
    fun startScanIfNeeded() {
        if (scanStarted) return
        scanStarted = true
        initialScanJob = viewModelScope.launch {
            val t0 = android.os.SystemClock.elapsedRealtime()
            val cached = withContext(Dispatchers.IO) { orderFoldersForOverview(listFolders()) }
            folders.value = cached
            // 冷启动「文件夹列表可见」的耗时锚点（几万张图库上 list_folders 是主要瓶颈）
            Log.i(TAG, "[Scan] first publish folders=${cached.size} cost=${android.os.SystemClock.elapsedRealtime() - t0}ms")
            // 标签快照走本地库、不依赖 MediaStore，先于全量扫描发布：否则扫描那几秒里
            // 侧栏标签区是空的，重进应用的标签要等扫描跑完才回来。专题同理（3.2）。
            reloadTagState()
            reloadTopics()
            if (cached.isEmpty()) scanning.value = true
            try {
                scanAndReconcile(notifyScan = true)
            } catch (e: Exception) {
                // 扫描/入库失败时保留缓存列表（M1 阶段 1 简单容错）
                Log.w(TAG, "[Scan] failed", e)
            } finally {
                scanning.value = false
            }
        }
    }

    /** 注册 MediaStore 监听；notifyForDescendants=true 以捕获具体图片条目 URI 的通知。 */
    fun startMediaStoreObservation() {
        appContext.contentResolver.registerContentObserver(
            MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
            true,
            mediaStoreObserver,
        )
    }

    /** 注销 MediaStore 监听并丢弃未触发的防抖任务（后台期间不做无谓重扫）。 */
    fun stopMediaStoreObservation() {
        appContext.contentResolver.unregisterContentObserver(mediaStoreObserver)
        mediaChangeJob?.cancel()
        mediaChangeJob = null
    }

    /**
     * 回前台兜底（MainActivity.onStart）：后台期间（监听已注销）MediaStore 的增删在
     * 这里补上。初始扫描尚未完成的冷启动是纯重复（初始扫描读的就是当下的库），跳过；
     * 无实质变化时 adapter 的幂等守卫不会 notifyDataSetChanged，界面纹丝不动。
     */
    fun refreshFromForeground() {
        if (initialScanJob?.isCompleted != true) return
        hotRefresh()
    }

    /** 热刷新主体：重跑全量管道 + 刷新当前文件夹列表；失败只记日志，不影响已上屏数据。 */
    private fun hotRefresh() {
        if (!hasMediaPermission()) return
        viewModelScope.launch {
            try {
                val t0 = android.os.SystemClock.elapsedRealtime()
                scanAndReconcile()
                Log.i(TAG, "[Scan] hot refresh cost=${android.os.SystemClock.elapsedRealtime() - t0}ms total")
                reloadImages()
            } catch (e: Exception) {
                Log.w(TAG, "[Scan] hot refresh failed", e)
            }
        }
    }

    /**
     * 手动刷新（4.4 下拉刷新的入口）：同 [hotRefresh] 的管道，但完成时可回调——
     * 指示器等它落勾。[onDone] 在主线程回调，失败也回调（界面照常复位）。
     */
    fun refreshManual(onDone: () -> Unit = {}) {
        if (!hasMediaPermission()) {
            onDone()
            return
        }
        viewModelScope.launch {
            try {
                scanAndReconcile(notifyScan = true)
                reloadImages()
                Log.i(TAG, "[Scan] manual refresh done")
            } catch (e: Exception) {
                Log.w(TAG, "[Scan] manual refresh failed", e)
            }
            onDone()
        }
    }

    /**
     * 把选中集合解析成可分享/删除的 content:// URI 列表（4.2）。选中项可能是图片
     * （文件夹内网格）也可能是文件夹（总览）——文件夹展开为其下全部图片（读库，
     * 与网格同源）。[onReady] 在主线程回调；空列表时也回调（调用方自行忽略）。
     */
    fun resolveSelectionUris(ids: Set<String>, onReady: (List<android.net.Uri>) -> Unit) {
        viewModelScope.launch {
            val uris = withContext(Dispatchers.IO) {
                val imgById = images.value.associateBy { it.id }
                val folderById = folders.value.associateBy { it.id }
                val out = ArrayList<android.net.Uri>(ids.size)
                for (id in ids) {
                    imgById[id]?.let { out += android.net.Uri.parse(it.contentUri) }
                        ?: folderById[id]?.let { folder ->
                            listImages(folder.id).forEach { out += android.net.Uri.parse(it.contentUri) }
                        }
                }
                out
            }
            onReady(uris)
        }
    }

    /**
     * 删除：直接逐条 contentResolver.delete（主路径，不再是「API < 30 的兜底」）。
     * 本应用自建/已授权过的行系统直接放行，零弹窗；非本应用创建的行抛
     * RecoverableSecurityException → 收进 [onBlocked] 由宿主决定是否走
     * MediaStore.createDeleteRequest 授权一次（重试只针对被拦的那几行）。
     * 无写权限时的普通 SecurityException 逐条吞掉，成功多少算多少。
     */
    fun deleteDirect(
        uris: List<android.net.Uri>,
        onDone: (Int) -> Unit = {},
        onBlocked: (List<android.net.Uri>, retry: () -> Unit) -> Unit =
            deleteConsentFallback ?: { _, _ -> },
    ) {
        if (uris.isEmpty()) {
            onDone(0)
            return
        }
        viewModelScope.launch {
            writeWithConsentFallback(
                items = uris,
                uriOf = { it },
                write = { uri ->
                    try {
                        // delete 返回 0（行已不存在）也算成功：删除是幂等的，「文件没了」
                        // 就是目标达成——索引死行（MediaStore 已无此行但列表还在显示）
                        // 由此获得清理机会，而不是永远报「删除失败」（真机 17:54 实测）。
                        appContext.contentResolver.delete(uri, null, null) >= 0
                    } catch (e: Exception) {
                        // 重删已被系统删掉的（createDeleteRequest 静默执行后）行时，华为
                        // 会直接抛异常而不是返回 0——此时行已不存在，删除同样达成。
                        val gone = runCatching { queryDisplayName(uri) == null }.getOrDefault(false)
                        if (gone) {
                            debugLog("delete: row already gone, count as success: $uri")
                            true
                        } else {
                            throw e
                        }
                    }
                },
                onDone = { n ->
                    Log.i(TAG, "[Delete] deleted=$n/${uris.size}")
                    onDone(n)
                },
                onBlocked = onBlocked,
                optimistic = { okItems ->
                    optimisticRemoveFromGrid(okItems)
                    // 索引即时收尾：把实际删掉的这批行从索引摘除 + 重算总览卡片
                    // （封面回退到剩余最新图、计数-1、时间戳回退、按时间排序的位置
                    // 归位）——不等全量对账（1s 防抖 + 2.4s 扫描），否则删除后卡片
                    // 几秒不动甚至计数还没减（索引死行在对账前一直算在内）。
                    val beforeFolders = folders.value
                    viewModelScope.launch {
                        val ids = okItems.map { generateId(it.toString()) }
                        withContext(Dispatchers.IO) {
                            runCatching { deleteIndexEntries(ids) }
                                .onFailure { Log.w(TAG, "[Delete] index cleanup failed", it) }
                        }
                        refreshFolderCards(force = true)
                        // 删除也是「操作过文件夹」：内容时间会掉回去，活动时间托在前面
                        bumpActivityForChangedFolders(beforeFolders)
                    }
                },
            )
        }
    }

    /**
     * 删除被系统拦下时的兜底（宿主在启动时设置：createDeleteRequest 发起；已开
     * 「管理媒体」时系统**不弹窗直接执行**删除，结果经 [MainActivity.deleteLauncher]
     * 回来调 retry 重删——delete 现在是幂等的（>=0 都算成功），计数/收尾都正确）。
     * rename/move 的「删源」阶段复用同一条兜底链。未设置（理论不可达）时被拦项按失败丢弃。
     */
    var deleteConsentFallback: ((List<android.net.Uri>, retry: () -> Unit) -> Unit)? = null

    /**
     * 华为真机吞第三方 App 的 logcat（AuroraKotlin tag 无输出，17:27/17:51 两次实测），
     * 文件操作的关键路径落盘到 filesDir/debug_fileop.log，`adb shell run-as
     * com.aurora.gallery.kotlin cat files/debug_fileop.log` 可读。
     */
    // internal 而非 private：人物簇已拆到 GalleryViewModelPeople.kt（扩展函数），
    // 那边要用它落诊断
    internal fun debugLog(msg: String) {
        try {
            java.io.File(appContext.filesDir, "debug_fileop.log").appendText("$msg\n")
        } catch (_: Exception) {
        }
        // 镜像到共享存储：华为间歇吞第三方 logcat（实时流也吞），run-as 又读不了
        // 非 debuggable 包的 filesDir——外部存储这份是唯一可靠取证面（排查完删）。
        try {
            if (Build.VERSION.SDK_INT == 29 && android.os.Environment.isExternalStorageLegacy()) {
                java.io.File(
                    android.os.Environment.getExternalStorageDirectory(),
                    "aurora_diag_debug.log",
                ).appendText("${System.currentTimeMillis()} $msg\n")
            }
        } catch (_: Exception) {
        }
    }

    /**
     * bucket_id → RELATIVE_PATH 缓存（[resolveFolderRelPath] 的查找表）。一次全量遍历
     * 2.6 万行老机约 300ms，复制/移动选目标时每次都要付一遍；首次查找同一趟遍历顺手
     * 建表，会话内后续查找零成本。
     *
     * 不需要失效逻辑：bucket_id 由目录路径派生、RELATIVE_PATH 就是该目录，两者 1:1——
     * 目录改名 = 新 bucket_id = 缓存里没有的新 key（查找落空会重建表），已在表里的
     * bucket_id 的 RELATIVE_PATH 不可能变。
     */
    // internal 而非 private：文件操作簇在 GalleryViewModelFileOps.kt（扩展函数）里要用
    internal var bucketRelPathCache: Map<String, String>? = null

    /** 总览卡片重算的防抖窗口：批量写操作（一次移动 N 个文件）会连发多次刷新请求，
     *  合并到一次（聚合全量约百毫秒，没必要连跑）。漏掉的少数情况由全量对账兜底。 */
    // internal 而非 private：refreshFolderCards 已拆到 GalleryViewModelQPaths.kt（扩展函数）里要用
    internal var lastFolderCardsRefreshAt = 0L

    // ===== 文件夹活动时间（「操作过就排前面」的排序语义）=====
    // 完整语义见 GalleryViewModelLocalWrite.kt（读写逻辑同在该文件）；此处只留状态与 init 填装。

    // internal 而非 private：文件夹活动时间簇已拆到 GalleryViewModelLocalWrite.kt（扩展函数）里要用
    //（状态字段，搬不走）
    internal val folderActivityPrefs by lazy {
        appContext.getSharedPreferences("aurora_folder_activity", Context.MODE_PRIVATE)
    }

    /** folderId → 活动时间（epoch 秒）。Compose state：总览排序的 remember 键之一。 */
    val folderActivityAt = mutableStateOf<Map<String, Long>>(emptyMap())

    init {
        folderActivityAt.value = loadFolderActivity()
    }

    /**
     * 媒体读权限检查。ViewModel 里兜这道闸是因为热刷新的入口（ContentObserver）在本类里：
     * 无权限时 MediaStore 查询只返回本应用自有的条目，拿这种残缺快照去对账会把整个索引清空。
     * 权限字符串须与 MainActivity.requestMediaPermissionIfNeeded 保持一致。
     */
    private fun hasMediaPermission(): Boolean {
        // 设备 API 33+ 且 targetSdk ≥ 33 才用 READ_MEDIA_IMAGES（targetSdk < 33 时系统
        // 不认该权限，须走 READ_EXTERNAL_STORAGE）。与 MainActivity.mediaPermission 一致。
        val permission = if (Build.VERSION.SDK_INT >= 33 &&
            appContext.applicationInfo.targetSdkVersion >= 33
        ) {
            "android.permission.READ_MEDIA_IMAGES"
        } else {
            android.Manifest.permission.READ_EXTERNAL_STORAGE
        }
        return ContextCompat.checkSelfPermission(appContext, permission) ==
            android.content.pm.PackageManager.PERMISSION_GRANTED
    }

    /** 全量管道：MediaStore 快照 → Rust 幂等对账入库 → 刷新总览文件夹列表 + 标签快照。
     *
     * [notifyScan] = true 时走阶段 5 的扫描通知（初始扫描与手动刷新；热刷新不通知）。
     */
    private suspend fun scanAndReconcile(notifyScan: Boolean = false) = scanMutex.withLock {
        val t0 = android.os.SystemClock.elapsedRealtime()
        val imgs = withContext(Dispatchers.IO) { scanMediaStore() }
        if (notifyScan) scanNotifier.progress()
        Log.i(TAG, "[Scan] MediaStore rows=${imgs.size} cost=${android.os.SystemClock.elapsedRealtime() - t0}ms")
        withContext(Dispatchers.IO) { upsertMediaImages(imgs) }
        debugLog(
            "[Scan] rows=${imgs.size} upsert cost=${android.os.SystemClock.elapsedRealtime() - t0}ms",
        )
        // 首发缓存**不**随对账清空（M8b-23 真机反馈二轮：任何应用触碰 MediaStore 都会
        // 触发对账，整表清空等于把「进夹秒开」打回每次都闪空白）。缓存在这里只承担
        // 首帧预览，每次进夹 reloadImages 都会重查对账，已删/已挪的项落地后一帧内
        // 自愈——拿一瞬的旧快照换稳定的零空白进夹，值。
        Log.i(TAG, "[Scan] reconcile upsert cost=${android.os.SystemClock.elapsedRealtime() - t0}ms total")
        folders.value = withContext(Dispatchers.IO) { orderFoldersForOverview(listFolders()) }
        Log.i(TAG, "[Scan] folders=${folders.value.size} cost=${android.os.SystemClock.elapsedRealtime() - t0}ms total")
        // 对账可能清掉孤儿行（含 file_tags 指向的 file_id），标签快照跟着重算，
        // 否则侧栏会数出几个网格里点不出来的标签。专题成员同理（topic_files 的孤儿），
        // fileCount 一并刷新。
        reloadTagState()
        reloadTopics()
        if (notifyScan) scanNotifier.done(folders = folders.value.size, images = imgs.size)
    }

    /**
     * 查看器编辑弹窗的**唯一**落库入口（M4a 2.1）。参数为 `null` 表示这次没编辑这一项，
     * 与「编辑成空串」是两回事（清空描述是 `""`，不是 `null`）。
     *
     * 标签走 `setFileTags` 整体替换（`file_tags` 是安卓侧唯一真源，见 1.1）；描述与来源
     * 网址走**读-改-写**：`upsertFileMetadata` 是整行 `ON CONFLICT DO UPDATE`，拿半空的
     * 行去写会把另一边的字段冲掉。合并只在 Rust 之外做这一次，元数据面板（4.2）复用本函数，
     * 不再各拼一遍整行。
     */
    fun saveFileUpdates(
        fileId: String,
        tags: List<String>? = null,
        description: String? = null,
        sourceUrl: String? = null,
        /**
         * 来源网址**全集**（P1(b) 多值，整体覆盖语义；空列表 = 清空）。
         * 给了它就以它为准（[sourceUrl] 只在没给数组时用作老单值路径）；两者都不给 = 不改。
         */
        sourceUrls: List<String>? = null,
        onDone: (Boolean) -> Unit = {},
    ) {
        // path 在新建元数据行时才用得上（库里已有行则整行读回来了）。在主线程读
        // images.value，不进 IO 块——Compose state 不该在别的线程读。
        val contentUri = images.value.firstOrNull { it.id == fileId }?.contentUri.orEmpty()
        viewModelScope.launch {
            val ok = withContext(Dispatchers.IO) {
                runCatching {
                    if (tags != null) setFileTags(fileId, tags)
                    if (description != null || sourceUrl != null || sourceUrls != null) {
                        val row = getFileMetadata(fileId) ?: FfiFileMetadata(
                            fileId = fileId,
                            path = contentUri,
                            description = null,
                            sourceUrl = null,
                            sourceUrls = emptyList(),
                            aiData = null,
                            category = null,
                            updatedAt = null,
                        )
                        // 多值优先：给了数组就整体覆盖，首条跟着数组走（老读者那一列不会分叉）；
                        // 空数组 → 首条也为空，Rust 侧据此把这一列写 NULL（= 清空）
                        val nextUrls = sourceUrls
                        upsertFileMetadata(
                            row.copy(
                                description = description ?: row.description,
                                sourceUrls = nextUrls ?: row.sourceUrls,
                                sourceUrl = when {
                                    nextUrls != null -> nextUrls.firstOrNull()
                                    sourceUrl != null -> sourceUrl
                                    else -> row.sourceUrl
                                },
                            )
                        )
                    }
                }.also {
                    if (it.isFailure) {
                        // 不弹「保存成功」的假反馈：这里失败=用户编辑的内容没了
                        Log.w(TAG, "[Edit] save failed fileId=$fileId", it.exceptionOrNull())
                    }
                }.isSuccess
            }
            // 只有真写进去才重算快照：失败时重算会把库里旧值当新值刷回界面
            if (ok) reloadTagState()
            onDone(ok)
        }
    }

    /**
     * 批量粘贴标签（M4a 4.3 长按菜单的「粘贴标签」）：把应用内剪贴板
     * （[AppState.copiedTags]）里的标签合并进选中集每个文件——1.1 的批量原语
     * `add_tags_to_files` 单事务完成，已有成员不重复、新标签追加尾部。合并语义与
     * 桌面 `handlePasteTags`（`useTags.ts:83`）一致；落库成功才重算快照。
     */
    fun pasteTagsToFiles(fileIds: Set<String>, onDone: (Boolean) -> Unit = {}) {
        val tags = appState.copiedTags.toList()
        if (fileIds.isEmpty() || tags.isEmpty()) {
            onDone(false)
            return
        }
        viewModelScope.launch {
            val ok = withContext(Dispatchers.IO) {
                runCatching { addTagsToFiles(fileIds.toList(), tags) }
                    .also {
                        if (it.isFailure) Log.w(TAG, "[Edit] paste tags failed", it.exceptionOrNull())
                    }
                    .isSuccess
            }
            if (ok) reloadTagState()
            onDone(ok)
        }
    }

    /**
     * 重命名专题（M4a 4.3 长按菜单；桌面 TopicModule 右键「重命名」同位）。FFI 没有
     * 专门的 rename 导出，走 `upsertTopic` 整行写——它只写元数据行、不动成员关联
     * （3.2 的自动封面同款路径已实证），快照里的 [topic] 直接 copy 即可。
     */
    fun renameTopic(topic: FfiTopic, newName: String, onDone: (Boolean) -> Unit = {}) {
        val trimmed = newName.trim()
        if (trimmed.isEmpty()) {
            onDone(false)
            return
        }
        viewModelScope.launch {
            val ok = withContext(Dispatchers.IO) {
                runCatching {
                    upsertTopic(topic.copy(name = trimmed, updatedAt = System.currentTimeMillis()))
                }.also {
                    if (it.isFailure) Log.w(TAG, "[Topics] rename failed", it.exceptionOrNull())
                }.isSuccess
            }
            if (ok) reloadTopics()
            onDone(ok)
        }
    }

    /**
     * 删除专题（M4a 4.3 长按菜单；桌面右键「删除」同位）。core 的 `delete_topic` 现在
     * 自己会**级联删整棵子树**（2026-09-29 起，桌面那边漏了这一步所以收进公共层），
     * 这里这段按 parentId 的预删因此变成兜底——重复删一个已不存在的 id 是 no-op，
     * 保留着不影响正确性。图片本身不受影响。删的是当前详情正打开的专题时，
     * 宿主负责把 activeTopicId 清掉回列表。
     */
    fun deleteTopic(topic: FfiTopic, onDone: (Boolean) -> Unit = {}) {
        viewModelScope.launch {
            val ok = withContext(Dispatchers.IO) {
                runCatching {
                    getAllTopics().filter { it.parentId == topic.id }.forEach { child ->
                        deleteTopicFfi(child.id)
                    }
                    deleteTopicFfi(topic.id)
                }.also {
                    if (it.isFailure) Log.w(TAG, "[Topics] delete failed id=${topic.id}", it.exceptionOrNull())
                }.isSuccess
            }
            if (ok) reloadTopics()
            onDone(ok)
        }
    }

    /**
     * 把成员图设为专题封面（M4a 4.3；桌面「设置专题封面」的触屏同位——桌面在专题
     * 卡片右键弹选图，平板入口在专题详情：选中一张成员图 → 更多菜单「设为封面」）。
     * 走 `upsertTopic` 整行写，同 [renameTopic] 的安全性论证。
     */
    fun setTopicCover(topicId: String, fileId: String, onDone: (Boolean) -> Unit = {}) {
        viewModelScope.launch {
            val topic = topics.value.firstOrNull { it.id == topicId }
            if (topic == null) {
                onDone(false)
                return@launch
            }
            val ok = withContext(Dispatchers.IO) {
                runCatching {
                    upsertTopic(
                        topic.copy(coverFileId = fileId, updatedAt = System.currentTimeMillis()),
                    )
                }.also {
                    if (it.isFailure) Log.w(TAG, "[Topics] set cover failed", it.exceptionOrNull())
                }.isSuccess
            }
            if (ok) reloadTopics()
            onDone(ok)
        }
    }

    /**
     * 重算 [topics] / [coverImagesById]。调用点：启动（先于扫描，专题读本地库不等
     * MediaStore）、对账尾部（删除图片会留下孤儿成员，fileCount 要跟上）、以及每个
     * 专题写操作（建/归入/移除）落库之后。
     */
    suspend fun reloadTopics() {
        try {
            val list = withContext(Dispatchers.IO) { getAllTopics() }
            topics.value = list
            // 封面一次取齐：有 coverFileId 的专题通常寥寥（新专题没有封面），
            // 空列表就不发查询。个别封面图已删除时 listImagesByIds 静默跳过，
            // 该专题退回占位图。
            val coverIds = list.mapNotNull { it.coverFileId }.distinct()
            coverImagesById.value =
                if (coverIds.isEmpty()) emptyMap()
                else withContext(Dispatchers.IO) { listImagesByIds(coverIds) }
                    .associateBy { it.id }
            Log.i(TAG, "[Topics] reload count=${list.size} covers=${coverImagesById.value.size}")
        } catch (e: Exception) {
            Log.w(TAG, "[Topics] reload failed", e)
        }
    }

    /**
     * 新建专题（M4a 3.2，对齐 React `handleCreateTopic(parentId, name)`）。[parentId]
     * 为 null = 根专题（专题总览的「新建专题」按钮）；非 null = 在该专题详情里建
     * **子专题**（子专题区头部的按钮，桌面 TopicModule.tsx:2108 同位）。
     * type 恒 "TOPIC"（React 默认值）；成员为空，不调 set_topic_files（与 React 同注：
     * upsert_topic 只写元数据）。桌面严格两层：子专题详情不再渲染子专题区（UI 层约束，
     * 这里不拦——万一将来要三层，数据层不用动）。
     */
    fun createTopic(name: String, parentId: String? = null, onDone: (Boolean) -> Unit = {}) {
        val trimmed = name.trim()
        if (trimmed.isEmpty()) {
            onDone(false)
            return
        }
        viewModelScope.launch {
            val now = System.currentTimeMillis()
            val topic = FfiTopic(
                id = UUID.randomUUID().toString(),
                parentId = parentId,
                name = trimmed,
                description = null,
                topicType = "TOPIC",
                coverFileId = null,
                backgroundFileId = null,
                coverCrop = null,
                peopleIds = emptyList(),
                fileIds = emptyList(),
                sourceUrl = null,
                createdAt = now,
                updatedAt = now,
                sourceType = null,
                workName = null,
                workNameCn = null,
                fileCount = 0,
            )
            val ok = withContext(Dispatchers.IO) {
                runCatching { upsertTopic(topic) }.also {
                    if (it.isFailure) Log.w(TAG, "[Topics] create failed", it.exceptionOrNull())
                }.isSuccess
            }
            if (ok) reloadTopics()
            onDone(ok)
        }
    }

    /**
     * 把一批图归入专题（M4a 3.2 的「归入」入口；Rust 原语在 1.1 同款语义：已在内成员
     * 不重复、新成员追加尾部）。归入后成员计数变了，[reloadTopics] 必须跑。
     *
     * **首图自动成封面**（对齐桌面 `useTopics.ts:89-99`）：专题还没有封面时，把成员里
     * 第一张图片设为封面——否则总览卡片一直是占位图（3.2 验收反馈 ①）。upsert_topic
     * 只写元数据行、不动成员关联（桌面同注），所以追加这条 upsert 是安全的。
     */
    fun addFilesToTopic(topicId: String, fileIds: Set<String>, onDone: (Boolean) -> Unit = {}) {
        if (fileIds.isEmpty()) {
            onDone(false)
            return
        }
        viewModelScope.launch {
            val ok = withContext(Dispatchers.IO) {
                runCatching {
                    addFilesToTopic(topicId, fileIds.toList())
                    // 无封面 → 成员按加入次序的第一张图（getTopicFiles 保序，
                    // listImagesByIds 只回图片、缺失 id 静默跳过）
                    val topic = topics.value.firstOrNull { it.id == topicId }
                    if (topic != null && topic.coverFileId == null) {
                        val members = getTopicFiles(topicId)
                        val firstImage = members.takeIf { it.isNotEmpty() }
                            ?.let { listImagesByIds(it) }
                            ?.firstOrNull()
                        if (firstImage != null) {
                            upsertTopic(
                                topic.copy(
                                    coverFileId = firstImage.id,
                                    updatedAt = System.currentTimeMillis(),
                                )
                            )
                        }
                    }
                }.also {
                    if (it.isFailure) Log.w(TAG, "[Topics] addFiles failed", it.exceptionOrNull())
                }.isSuccess
            }
            if (ok) reloadTopics()
            onDone(ok)
        }
    }

    /**
     * 从专题移除一批图（3.2 详情页的对称操作；归属关系在 topic_files，不动图片本身）。
     * Rust 原语是单文件的，这里在一个 IO 块里逐条调——选择集通常是个位数，且失败要
     * 逐条记日志而不是整体回滚（没有事务要求：成员关系本就是一行一条）。
     *
     * **封面改指**：桌面移除成员不处理封面（coverFileId 留着已移出的图，卡片还显示它），
     * 这里按修正语义处理——封面在被移除集合里时改指剩余成员的第一张图，专题空了才清空。
     */
    fun removeFilesFromTopic(topicId: String, fileIds: Set<String>, onDone: (Boolean) -> Unit = {}) {
        if (fileIds.isEmpty()) {
            onDone(false)
            return
        }
        viewModelScope.launch {
            val ok = withContext(Dispatchers.IO) {
                var success = 0
                for (id in fileIds) {
                    try {
                        removeFileFromTopic(topicId, id)
                        success++
                    } catch (e: Exception) {
                        Log.w(TAG, "[Topics] removeFile failed id=$id", e)
                    }
                }
                val allRemoved = success == fileIds.size
                // 封面改指（失败也应尝试：能删多少算多少，封面指向已移出的图更难看）
                val topic = topics.value.firstOrNull { it.id == topicId }
                if (allRemoved && topic?.coverFileId != null && topic.coverFileId in fileIds) {
                    try {
                        val remaining = getTopicFiles(topicId)
                        val nextCover = remaining.takeIf { it.isNotEmpty() }
                            ?.let { listImagesByIds(it) }
                            ?.firstOrNull()
                        upsertTopic(
                            topic.copy(
                                coverFileId = nextCover?.id,
                                updatedAt = System.currentTimeMillis(),
                            )
                        )
                    } catch (e: Exception) {
                        Log.w(TAG, "[Topics] cover re-point failed", e)
                    }
                }
                allRemoved
            }
            if (ok) {
                reloadTopics()
                reloadImages()
            }
            onDone(ok)
        }
    }

    /**
     * 当前视图该显示哪些图，**唯一的取数口**（M4a 4.1 / 3.2）。
     *
     * 三条序列源：
     *  - 专题详情（TOPICS_OVERVIEW + activeTopicId）→ `getTopicFiles` 成员 id 经
     *    `list_images_by_ids` 补齐（成员次序 = 详情网格次序 = 加入次序）；
     *  - 有标签筛选 → Rust 按标签取**全库**图片（`list_images_by_tags`）。不能只筛当前
     *    文件夹：侧栏标签上的计数是全库口径，点进去只剩本文件夹那几张的话，同一屏上
     *    「5」和「2 张」自相矛盾。
     *  - 否则 → 当前文件夹的图片；没有文件夹（总览）就不取，保留上一次的结果没有意义。
     *
     * 挂起函数，由 `MainActivity` 的
     * `LaunchedEffect(viewMode, folderId, activeTags, activeTopicId)` 触发——导航与筛选
     * 都收敛到这一个触发点，不再各处自己 launch 一份。
     */
    suspend fun reloadImages() {
        val tab = appState.activeTab
        // —— M6a 阶段 4：LAN 序列源分流（并列入口，M4a 序列源先例）——
        // folderId 带 lan 前缀 = 远端目录（或虚拟根/成员筛选虚拟目录），走 LanClient/会话态；
        // M6b 阶段 5：LAN 搜索结果虚拟目录（__lan_search__）不带 lan: 前缀（纯内部 id），
        // 这里显式并进分流，否则会落到本地 listImages 分支把网格清空。
        if (tab.viewMode == ViewMode.BROWSER &&
            (tab.folderId?.startsWith(LAN_FOLDER_ID_PREFIX) == true || tab.folderId == LAN_SEARCH_FOLDER_ID)
        ) {
            reloadLanImages(tab.folderId!!)
            return
        }
        val topicId = if (tab.viewMode == ViewMode.TOPICS_OVERVIEW) tab.activeTopicId else null
        // 本地人物筛选虚拟目录（`__person__:<id>`）。与 topicId 同为「成员集序列源」，
        // 优先级压在标签之前：人物是全库概念，进人物视图时 activeTags 已由 openFolder 归零。
        val personId = tab.folderId?.localPersonIdOrNull()
        val byTag = tab.activeTags.isNotEmpty()
        if (topicId == null) {
            if (tab.viewMode != ViewMode.BROWSER) return
            if (!byTag && tab.folderId == null) return
        }
        // 换视图的 key 必须覆盖三条序列源的所有输入
        val key = sequenceKey(tab.folderId, tab.activeTags, topicId)
        // 只在**序列源换了**（进文件夹 / 改筛选 / 换专题）时先清空：否则从 B 切回 A 的
        // 那一帧会闪现上一个视图的内容。热刷新（MediaStore 变更）key 不变，不能清——清了就是闪白。
        // 清空的同时置 [imagesPending]（「还没查完」≠「真的空」，空态文案由它压住不闪
        // 「文件夹为空」）；有缓存先首发缓存再查（进目录第一帧就出网格，M8b-23），落地后对账。
        if (key != loadedImagesKey) {
            images.value = imagesCacheByKey[key] ?: emptyList()
            imagesPending.value = true
        }
        loadedImagesKey = key
        val imgs = try {
            withContext(Dispatchers.IO) {
                when {
                    topicId != null -> {
                        val memberIds = getTopicFiles(topicId)
                        if (memberIds.isEmpty()) emptyList() else listImagesByIds(memberIds)
                    }
                    personId != null -> {
                        val memberIds = localPersonMemberIds(personId)
                        if (memberIds.isEmpty()) emptyList() else listImagesByIds(memberIds)
                    }
                    byTag -> listImagesByTags(tab.activeTags)
                    else -> listImages(tab.folderId!!)
                }
            }
        } catch (e: Exception) {
            // 取数失败留空网格而不是旧内容：旧的可能是**另一个视图**的，比空着更误导
            Log.w(TAG, "[Load] images failed topic=$topicId byTag=$byTag folderId=${tab.folderId}", e)
            // 还停在这个序列源上就把 pending 放下来，让空态文案恢复可见（不放=空态被永久吞掉）
            if (activeSequenceKey() == key) imagesPending.value = false
            return
        }
        // 取数期间用户可能已经导航走或改了筛选，过期结果直接丢弃
        if (activeSequenceKey() == key) {
            images.value = imgs
            cachePutImages(key, imgs)
            imagesPending.value = false
            // 诊断（2026-10-07 复制可见性排查）：每次取数落一条，folder + 条数 +
            // 是否含刚复制的行（由调用方上下文推断）。华为吞 logcat，这是唯一取证面。
            debugLog("reloadImages: folder=${tab.folderId} tags=$byTag topic=$topicId person=$personId n=${imgs.size}")
        }
    }

    /**
     * 重算 [tagsByFile] / [metadataById] / [tagGroups] 三份快照。
     *
     * 调用点只有两处：扫描对账之后（[scanAndReconcile] 尾部），以及元数据/标签落库之后
     * （2.1 的写入路径）。**挂起函数**而非 launch-and-forget：写入方要在快照落地后再
     * 刷新界面，否则「编辑完关掉重开」会读到上一次的快照。
     *
     * 失败只记日志并保留旧快照——三份快照任一读失败都不该把界面清成空的。
     */
    suspend fun reloadTagState() {
        try {
            val snapshot = withContext(Dispatchers.IO) {
                Triple(getAllFileTags(), getAllFileMetadata(), getGroupedTags(settings.value.language))
            }
            tagsByFile.value = snapshot.first.associate { it.fileId to it.tags }
            metadataById.value = snapshot.second.associateBy { it.fileId }
            tagGroups.value = snapshot.third
            Log.i(TAG, "[Tags] reload groups=${tagGroups.value.size} taggedFiles=${tagsByFile.value.size} meta=${metadataById.value.size}")
        } catch (e: Exception) {
            Log.w(TAG, "[Tags] reload failed", e)
        }
    }

    /**
     * 总览排序：「根目录图片」虚拟文件夹恒置顶，其余保持 listFolders 的字典序不变
     * （sortedBy 稳定排序）。总览 TopBar 的排序菜单（sortFolders）在其上再排，置顶规则
     * 两处都做，压在用户排序之上。
     */
    // internal 而非 private：Q 路径原语簇已拆到 GalleryViewModelQPaths.kt（扩展函数）里要用
    internal fun orderFoldersForOverview(list: List<Folder>): List<Folder> {
        // EMUI 对存储根目录散文件的 bucket_display_name 返回字面 "0"（AOSP 为 NULL，
        // scanMediaStore 只兜了 NULL）：索引里根目录 Folder 行的 name 因此是 "0"——
        // 总览卡片/浏览器标题/目标选择器显示 "0」，且按 ROOT_FOLDER_DISPLAY_NAME
        // 匹配的置顶规则（本函数与 GridModels.sortFolders 双保险）全部失效。
        // 按**路径**（= 外部存储根本身）认根目录并归一名字：路径判定不受 bucket 名字
        // quirks 影响，也不会误伤真名叫 "0" 的子文件夹（它们的 path 不是存储根）。
        val storageRoot = android.os.Environment.getExternalStorageDirectory().absolutePath
        val normalized = list.map { f ->
            if (f.path == storageRoot && f.name != ROOT_FOLDER_DISPLAY_NAME) {
                f.copy(name = ROOT_FOLDER_DISPLAY_NAME)
            } else {
                f
            }
        }
        return if (normalized.any { it.name == ROOT_FOLDER_DISPLAY_NAME })
            normalized.sortedBy { it.name != ROOT_FOLDER_DISPLAY_NAME }
        else normalized
    }

    // ===== 2026-10 排序改造：本地总览封面随排序重选 =====
    //
    // list_folders 的 cover_uri 固定按 modified DESC 选第一张（Rust FFI 保持不动——
    // uniffi 绑定是手工生成后入库的（kotlin-app/app/src/main/java/uniffi/aurora_core/），
    // 改签名要手工重生成，故选 Kotlin 层重选而非改 FFI）。总览封面要随排序口径变化，
    // 在这里逐文件夹 list_images 取直接子图，按当前 (sortBy, sortDirection) 内存排序
    // 取第一张（比较语义与 GridModels.sortImages 一致：name 不区分大小写 / date=createdAt
    // / size=字节；排序稳定，同键保持 modified DESC 原序）。

    /**
     * 按当前排序口径重算总览封面（IO 协程；仅在排序方式或文件夹列表变化时执行一次，
     * 不逐帧跑——[localCoverKey] 守卫 + [localCoverJob] 取消旧算）。init 里经
     * snapshotFlow 订阅 (sortBy, sortDirection, folders) 触发。
     */
    private fun refreshLocalOverviewCovers(sortBy: SortOption, direction: SortDirection, foldersNow: List<Folder>) {
        val key = "${sortBy.name}|${direction.name}|${foldersNow.size}|${foldersNow.hashCode()}"
        if (key == localCoverKey) return
        localCoverKey = key
        localCoverJob?.cancel()
        localCoverJob = viewModelScope.launch {
            val computed = withContext(Dispatchers.IO) {
                foldersNow.mapNotNull { f ->
                    val imgs = try {
                        listImages(f.id)
                    } catch (e: Exception) {
                        Log.w(TAG, "[Covers] list_images 失败 folder=${f.name}", e)
                        emptyList()
                    }
                    pickCoverBySort(imgs, sortBy, direction)?.let { f.id to it }
                }.toMap()
            }
            localCoverOverrides.value = computed
            Log.d(TAG, "[Covers] 总览封面重算 ${computed.size}/${foldersNow.size}（$sortBy $direction）")
        }
    }

    /** 排序口径下直接子图的第一张的封面（复用 [sortImages] 的比较器，语义单一来源）。 */
    private fun pickCoverBySort(imgs: List<Image>, sortBy: SortOption, direction: SortDirection): String? =
        sortImages(imgs, sortBy, direction).firstOrNull()?.contentUri

    fun openFolder(folder: Folder) {
        // 导航走 TabState.history（推历史栈 + 切 BROWSER + 清选中），见 AppState.openFolder。
        // 取数不在这里：M4a 4.1 起统一由组合根的 LaunchedEffect(viewMode, folderId,
        // activeTags) 触发 [reloadImages]，导航与筛选共用一个触发点。
        //
        // M8b-23 唯一例外：序列的**同步首发**。LaunchedEffect 在重组之后才跑，清空/取数
        // 都慢一帧——进文件夹的头一两帧只能看到空列表，空态文案就被误亮出来（用户报障）。
        // 这里在切导航之前同步把 images 备好：
        //  - 缓存命中（近期看过的目录）→ 直接首发缓存并预写 loadedImagesKey，第一帧就是
        //    网格；随后 reloadImages 因 key 相同不清空，查询落地后对账纠偏（SWR）。
        //  - 未命中 → 同步清空 + 置 pending：第一帧既不给上一个视图的内容，也不闪
        //    「文件夹为空」，只有一小段空白。
        // key 已在载（侧栏点当前目录这类不触发重查的入口）则原地不动，别把网格清了。
        // key 形态必须与 reloadImages 的分流/拼装一致（LAN 分流含虚拟搜索目录）。
        if (tabSequenceDiffers(folder.id)) {
            val isLan = folder.id.startsWith(LAN_FOLDER_ID_PREFIX) || folder.id == LAN_SEARCH_FOLDER_ID
            val key = if (isLan) lanSequenceKey(folder.id) else sequenceKey(folder.id, emptyList(), null)
            val cached = imagesCacheByKey[key]
            images.value = cached ?: emptyList()
            imagesPending.value = cached == null
            loadedImagesKey = key
        }
        appState.openFolder(folder.id)
    }

    /** 目标目录的序列源是否与当前已载入的不同（[openFolder] 首发的前置判定）。 */
    private fun tabSequenceDiffers(folderId: String): Boolean {
        val tab = appState.activeTab
        if (tab.viewMode != ViewMode.BROWSER) return true
        val isLan = folderId.startsWith(LAN_FOLDER_ID_PREFIX) || folderId == LAN_SEARCH_FOLDER_ID
        val tabIsLan = tab.folderId?.startsWith(LAN_FOLDER_ID_PREFIX) == true || tab.folderId == LAN_SEARCH_FOLDER_ID
        if (isLan != tabIsLan) return true
        return if (isLan) tab.folderId != folderId
        else tab.folderId != folderId || tab.activeTags.isNotEmpty() || tab.activeTopicId != null
    }

    private fun scanMediaStore(): List<MediaImage> {
        val result = mutableListOf<MediaImage>()
        val projection = arrayOf(
            MediaStore.Images.Media._ID,
            MediaStore.Images.Media.DISPLAY_NAME,
            MediaStore.Images.Media.DATA,
            MediaStore.Images.Media.SIZE,
            MediaStore.Images.Media.DATE_ADDED,
            MediaStore.Images.Media.DATE_MODIFIED,
            MediaStore.Images.Media.WIDTH,
            MediaStore.Images.Media.HEIGHT,
            MediaStore.Images.Media.MIME_TYPE,
            MediaStore.Images.Media.BUCKET_ID,
            MediaStore.Images.Media.BUCKET_DISPLAY_NAME,
        )
        appContext.contentResolver.query(
            MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
            projection,
            null,
            null,
            "${MediaStore.Images.Media.DATE_MODIFIED} DESC"
        )?.use { c ->
            val idCol = c.getColumnIndexOrThrow(MediaStore.Images.Media._ID)
            val nameCol = c.getColumnIndexOrThrow(MediaStore.Images.Media.DISPLAY_NAME)
            val dataCol = c.getColumnIndexOrThrow(MediaStore.Images.Media.DATA)
            val sizeCol = c.getColumnIndexOrThrow(MediaStore.Images.Media.SIZE)
            val addedCol = c.getColumnIndexOrThrow(MediaStore.Images.Media.DATE_ADDED)
            val modifiedCol = c.getColumnIndexOrThrow(MediaStore.Images.Media.DATE_MODIFIED)
            val widthCol = c.getColumnIndexOrThrow(MediaStore.Images.Media.WIDTH)
            val heightCol = c.getColumnIndexOrThrow(MediaStore.Images.Media.HEIGHT)
            val mimeCol = c.getColumnIndexOrThrow(MediaStore.Images.Media.MIME_TYPE)
            val bucketIdCol = c.getColumnIndexOrThrow(MediaStore.Images.Media.BUCKET_ID)
            val bucketNameCol = c.getColumnIndexOrThrow(MediaStore.Images.Media.BUCKET_DISPLAY_NAME)

            while (c.moveToNext()) {
                val id = c.getLong(idCol)
                result.add(
                    MediaImage(
                        id = id,
                        contentUri = ContentUris.withAppendedId(
                            MediaStore.Images.Media.EXTERNAL_CONTENT_URI, id
                        ).toString(),
                        path = c.getString(dataCol) ?: "",
                        name = c.getString(nameCol) ?: "",
                        size = c.getLong(sizeCol),
                        dateAdded = c.getLong(addedCol),
                        dateModified = c.getLong(modifiedCol),
                        width = if (c.isNull(widthCol)) null else c.getInt(widthCol),
                        height = if (c.isNull(heightCol)) null else c.getInt(heightCol),
                        mimeType = c.getString(mimeCol) ?: "",
                        bucketId = c.getLong(bucketIdCol).toString(),
                        // 存储根目录散落文件的 bucket_display_name 为 NULL，兜底成虚拟文件夹名
                        //（对齐 React 版 __android_root_images__ 的「根目录图片」）
                        bucketName = c.getString(bucketNameCol)?.takeUnless { it.isBlank() }
                        ?: ROOT_FOLDER_DISPLAY_NAME,
                    )
                )
            }
        }
        return result
    }

    companion object {
        // internal 而非 private：人物簇已拆到 GalleryViewModelPeople.kt（扩展函数），
        // 那边打日志要取同一个 tag
        internal const val TAG = "AuroraKotlin"

        /** MediaStore 变更通知的防抖窗口：拷入一批文件时通知连发，等平静后再合并成一次重扫。 */
        private const val MEDIA_CHANGE_DEBOUNCE_MS = 1_000L

        /** 阶段 5：远端库 browse 并发上限（远端目录可能上百，压并发护服务端与手机网络）。 */
        // internal 而非 private：LAN 浏览簇已拆到 GalleryViewModelLanBrowse.kt（扩展函数）里要用
        internal const val LAN_BROWSE_CONCURRENCY = 4

        /** 阶段 5：metadata/batch 单块 path 数（契约无分页，块大小是客户端决定；300 折中单请求体积与失败重试粒度）。 */
        // internal 而非 private：LAN 浏览簇已拆到 GalleryViewModelLanBrowse.kt（扩展函数）里要用
        internal const val LAN_METADATA_BATCH_CHUNK = 300

        /**
         * 标签分组/组内排序用的 locale。M4b 2.2 起随设置面板的语言开关切换
         * （M4a 期间恒 `zh`，TAG_LOCALE 常量已由 [settings] 取代）。
         */
        // （TAG_LOCALE 常量已移除，见 reloadTagState）

        /**
         * factory 只在 ViewModel 首次创建时求值：旋转重建复用已有实例，不会重跑，
         * 所以 initialLayout 里的横竖屏判断就是「首次进入时的初始面板可见性」。
         */
        fun factory(app: Application, initialLayout: LayoutVisibility): ViewModelProvider.Factory =
            object : ViewModelProvider.Factory {
                @Suppress("UNCHECKED_CAST")
                override fun <T : ViewModel> create(modelClass: Class<T>): T =
                    GalleryViewModel(app, initialLayout) as T
            }
    }
}
