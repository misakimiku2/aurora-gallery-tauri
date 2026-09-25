package com.aurora.gallery.kotlin

import android.app.Application
import android.content.ContentUris
import android.content.ContentValues
import android.database.ContentObserver
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import android.util.Log
import androidx.compose.runtime.mutableStateOf
import androidx.core.content.ContextCompat
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.aurora.gallery.kotlin.state.AppState
import com.aurora.gallery.kotlin.state.LAN_FOLDER_ID_PREFIX
import com.aurora.gallery.kotlin.state.LAN_ROOT_IMAGES_ID
import com.aurora.gallery.kotlin.state.SettingsStore
import com.aurora.gallery.kotlin.state.LayoutVisibility
import com.aurora.gallery.kotlin.state.ViewMode
import com.aurora.gallery.kotlin.state.lanFolderId
import com.aurora.gallery.kotlin.state.lanRemotePathOrNull
import com.aurora.gallery.kotlin.state.lanTagFilterOrNull
import com.aurora.gallery.kotlin.ui.components.ROOT_FOLDER_DISPLAY_NAME
import kotlinx.coroutines.Dispatchers
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
import uniffi.aurora_core.deleteTopic as deleteTopicFfi
import uniffi.aurora_core.extractAndSaveColors
import uniffi.aurora_core.getAllFileMetadata
import uniffi.aurora_core.getAllFileTags
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
import uniffi.aurora_core.upsertFileMetadata
import uniffi.aurora_core.upsertMediaImages
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

    private val appContext = app.applicationContext

    val folders = mutableStateOf<List<Folder>>(emptyList())
    val images = mutableStateOf<List<Image>>(emptyList())
    val scanning = mutableStateOf(false)

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
    private var loadedImagesKey: String? = null

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
    private val lanRootImages = mutableStateOf<List<LanRemoteImage>>(emptyList())

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

    /** 连接成功后的会话拉取协程（刷新时可 join；断线时 cancel）。 */
    private var lanFetchJob: Job? = null

    /** 扫描通知（阶段 5，D17 基础版：初始扫描与手动刷新上进度/完成通知）。 */
    private val scanNotifier = ScanNotifier(appContext)

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
     * MediaStore 变更监听（注册/注销跟随 onStart/onStop，见 MainActivity）：应用开着时
     * 外部新增/删除/修改图片（相机、截图、MTP 拷入）也能热更新，不再需要重启应用刷新。
     */
    private val mediaStoreObserver = object : ContentObserver(null) {
        override fun onChange(selfChange: Boolean, uri: Uri?) {
            // 拷入一批文件会连发一串通知：取消重建防抖任务，等通知流平静后合并成一次重扫
            mediaChangeJob?.cancel()
            mediaChangeJob = viewModelScope.launch {
                delay(MEDIA_CHANGE_DEBOUNCE_MS)
                // 初始扫描若还在跑，等它结束再补一次对账（变更可能落在扫描查询之后，不能丢）
                initialScanJob?.join()
                hotRefresh()
            }
        }
    }

    /**
     * 应用设置（M4b 2.1/2.2，D15=SharedPreferences）。当前唯一的响应式消费方是
     * 语言开关（标签 collation）；其余项只在设置面板读写。声明在 init 之前供其应用默认值。
     */
    val settings = mutableStateOf(settingsStore.load())

    init {
        // 初始化 Rust 数据库（filesDir 下）；DB_POOL 已初始化时 Rust 侧 set 幂等忽略
        initDb(File(appContext.filesDir, "aurora.db").absolutePath)
        // M4b 2.1：默认布局与排序持久化——应用设置里的默认值压在 AppState 的初始值上
        appState.sortBy = settings.value.defaultSortBy
        appState.sortDirection = settings.value.defaultSortDirection
        appState.updateActiveTab { it.copy(layoutMode = settings.value.defaultLayout) }
        // M4c：默认分组同理（GroupBy 渲染能力 M1 已有，这里只补持久化默认值）
        appState.groupBy = settings.value.defaultGroupBy
        // M6a 阶段 3：有持久化 LAN 连接（token 未过期场景）就静默验证并自动恢复
        lan.start()
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

    private var aiJob: Job? = null

    /** AI 搜索态整体清理（关开关/清搜索词共用）。 */
    fun clearAiSearch() {
        aiSearchIds.value = null
        aiSearchResultImages.value = null
    }

    /** AI 搜索开关（持久化；关=清命中集回到普通文本过滤）。 */
    fun setAiSearchEnabled(enabled: Boolean) {
        settings.value = settings.value.copy(aiSearchEnabled = enabled)
        settingsStore.save(settings.value)
        if (!enabled) clearAiSearch()
    }

    /** AI 设置面板的逐项保存口（SettingsDialog 的 onAiSettingsChange 落点）。 */
    fun updateAiSettings(ai: com.aurora.gallery.kotlin.state.AiSettings) {
        settings.value = settings.value.copy(ai = ai)
        settingsStore.save(settings.value)
    }

    private fun aiToast(msg: String) {
        android.widget.Toast.makeText(appContext, msg, android.widget.Toast.LENGTH_SHORT).show()
    }

    /** 入口友好拦截（core 侧错误也能读，这里省一次网络往返）。 */
    private fun aiEndpointBlank(): Boolean {
        val ai = settings.value.ai
        return when (ai.provider) {
            "ollama" -> ai.ollamaEndpoint.isBlank()
            "lmstudio" -> ai.lmstudioEndpoint.isBlank()
            else -> ai.openaiEndpoint.isBlank()
        }
    }

    /** 通知「取消」action 的落点：core 取消注册表置位，下一张迭代首查生效（在途一张跑完）。 */
    fun cancelAiTask() {
        val st = aiTaskState.value ?: return
        runCatching { aiCancelTask(st.taskId) }
    }

    /** 批量 AI 分析（多选/文件夹/查看器单张共用入口）。完成后重算三快照+重拉当前视图。 */
    fun startAiAnalysis(fileIds: List<String>) {
        if (aiTaskState.value != null) {
            aiToast("AI 任务进行中，可从通知栏取消")
            return
        }
        if (fileIds.isEmpty()) return
        if (aiEndpointBlank()) {
            aiToast("请先在「设置 → AI 智能」配置服务地址")
            return
        }
        val cfg = settings.value.ai.toAiConfig(settings.value.language)
        aiJob = viewModelScope.launch {
            val taskId = "ai-analyze-${System.currentTimeMillis()}"
            val targets = withContext(Dispatchers.IO) { listImagesByIds(fileIds) }
            aiTaskState.value = AiTaskState("AI 分析", taskId, 0, targets.size)
            scanNotifier.aiProgress("AI 分析", 0, targets.size)
            var failed = 0
            withContext(Dispatchers.IO) {
                aiAnalyzeFiles(
                    cfg,
                    targets.map { AiInputItem(fileId = it.id, path = it.contentUri, name = it.name) },
                    taskId,
                    object : AiTaskCallback {
                        override fun readBytes(fileId: String): ByteArray? = runCatching {
                            targets.firstOrNull { it.id == fileId }?.contentUri?.let { uri ->
                                appContext.contentResolver.openInputStream(Uri.parse(uri))?.use { it.readBytes() }
                            }
                        }.getOrNull()

                        override fun onProgress(current: UInt, total: UInt) {
                            aiTaskState.value = AiTaskState("AI 分析", taskId, current.toInt(), total.toInt())
                            scanNotifier.aiProgress("AI 分析", current.toInt(), total.toInt())
                        }

                        override fun onFileDone(fileId: String, ok: Boolean, note: String) {
                            if (!ok) {
                                failed++
                                Log.w(TAG, "[Ai] analyze fail $fileId: $note")
                            }
                        }

                        override fun onFinished(state: String, message: String) {
                            aiTaskState.value = null
                            scanNotifier.aiDone(
                                when (state) {
                                    "completed" -> if (failed == 0) "分析完成 $message" else "分析完成 $message（$failed 张失败）"
                                    "cancelled" -> "已取消（$message）"
                                    else -> "分析失败：$message"
                                },
                            )
                        }
                    },
                )
            }
            // 标签/描述/词表已落库：三快照重算（内部失败容忍）+当前视图重拉（抽屉数据源）
            reloadTagState()
            reloadImages()
        }
    }

    /** 文件夹卡片「AI 分析相册」（总览选中入口；扁平 bucket 无需递归，M4b D18）。 */
    fun startAiFolderAnalysis(folderIds: List<String>) {
        viewModelScope.launch {
            val ids = withContext(Dispatchers.IO) {
                folderIds.flatMap { fid -> runCatching { listImages(fid) }.getOrDefault(emptyList()) }
                    .map { it.id }
                    .distinct()
            }
            if (ids.isEmpty()) {
                aiToast("所选相册没有图片")
                return@launch
            }
            startAiAnalysis(ids)
        }
    }

    /**
     * 批量 AI 重命名：AI 只产名字（core 不碰库不改文件），提案经 [aiRenameProposals]
     * 由宿主弹确认；真正改名=批量授权一次+M4b renameFiles（见 applyAiRenameProposals）。
     */
    fun startAiRename(fileIds: List<String>) {
        if (aiTaskState.value != null) {
            aiToast("AI 任务进行中，可从通知栏取消")
            return
        }
        if (fileIds.isEmpty()) return
        if (aiEndpointBlank()) {
            aiToast("请先在「设置 → AI 智能」配置服务地址")
            return
        }
        val cfg = settings.value.ai.toAiConfig(settings.value.language)
        aiJob = viewModelScope.launch {
            val taskId = "ai-rename-${System.currentTimeMillis()}"
            val targets = withContext(Dispatchers.IO) { listImagesByIds(fileIds) }
            aiTaskState.value = AiTaskState("AI 重命名", taskId, 0, targets.size)
            scanNotifier.aiProgress("AI 重命名", 0, targets.size)
            val proposals = mutableListOf<Triple<Image, String, String>>()
            var failed = 0
            withContext(Dispatchers.IO) {
                aiGenerateFileNames(
                    cfg,
                    targets.map { AiRenameItem(fileId = it.id, name = it.name) },
                    taskId,
                    object : AiRenameCallback {
                        override fun readBytes(fileId: String): ByteArray? = runCatching {
                            targets.firstOrNull { it.id == fileId }?.contentUri?.let { uri ->
                                appContext.contentResolver.openInputStream(Uri.parse(uri))?.use { it.readBytes() }
                            }
                        }.getOrNull()

                        override fun onProgress(current: UInt, total: UInt) {
                            aiTaskState.value = AiTaskState("AI 重命名", taskId, current.toInt(), total.toInt())
                            scanNotifier.aiProgress("AI 重命名", current.toInt(), total.toInt())
                        }

                        override fun onFileDone(fileId: String, ok: Boolean, note: String) {
                            if (!ok) {
                                failed++
                                Log.w(TAG, "[Ai] rename fail $fileId: $note")
                            }
                        }

                        override fun onName(fileId: String, newName: String) {
                            targets.firstOrNull { it.id == fileId }?.let { img ->
                                proposals.add(Triple(img, img.name, newName))
                            }
                        }

                        override fun onFinished(state: String, message: String) {
                            aiTaskState.value = null
                            scanNotifier.aiDone(
                                when (state) {
                                    "completed" -> "改名提案就绪 ${proposals.size} 张" + if (failed > 0) "（$failed 张失败）" else ""
                                    "cancelled" -> "已取消（$message）"
                                    else -> "AI 重命名失败：$message"
                                },
                            )
                        }
                    },
                )
            }
            if (proposals.isNotEmpty()) {
                aiRenameProposals.value = proposals.toList()
            } else {
                aiToast("AI 未产出可用的改名提案" + if (failed > 0) "（$failed 张失败）" else "")
            }
        }
    }

    /** 应用改名提案（确认弹窗「应用」）：走 M4b 重命名管线（系统授权+元数据挂住由它负责）。 */
    fun applyAiRenameProposals(targets: List<Pair<android.net.Uri, String>>, onDone: (Int) -> Unit = {}) {
        aiRenameProposals.value = null
        renameFiles(targets, onDone)
    }

    /** AI 搜索：query → core 改写（一次 HTTP）→ 全库过滤 → 命中集自带全库序列驱动网格。 */
    fun performAiSearch(query: String) {
        if (query.isBlank()) {
            clearAiSearch()
            return
        }
        if (aiEndpointBlank()) {
            aiToast("请先在「设置 → AI 智能」配置服务地址")
            return
        }
        val cfg = settings.value.ai.toAiConfig(settings.value.language)
        viewModelScope.launch {
            aiSearchBusy.value = true
            clearColorSearch() // 与颜色过滤互斥：AI 命中顶替颜色命中（反向互斥见 startColorSearch）
            try {
                val ids = withContext(Dispatchers.IO) {
                    val filter = aiRewriteSearchQuery(cfg, query)
                    val tags = getAllFileTags().associate { it.fileId to it.tags }
                    val meta = getAllFileMetadata().associateBy { it.fileId }
                    val items = folders.value
                        .flatMap { f -> runCatching { listImages(f.id) }.getOrDefault(emptyList()) }
                        .map {
                            SearchItem(
                                fileId = it.id,
                                name = it.name,
                                tags = tags[it.id].orEmpty(),
                                description = meta[it.id]?.description,
                            )
                        }
                    aiApplySearchFilter(filter, items)
                }
                aiSearchIds.value = ids.toSet()
                aiSearchResultImages.value = withContext(Dispatchers.IO) { listImagesByIds(ids) }
                aiToast("AI 搜索命中 ${ids.size} 张")            } catch (e: Exception) {
                Log.w(TAG, "[Ai] search failed", e)
                aiToast("AI 搜索失败：${e.message ?: "未知错误"}")
            } finally {
                aiSearchBusy.value = false
            }
        }
    }

    // —— M6b 阶段 3：颜色库任务层（提取/搜索/批量/统计都在 core color_ffi，本层=状态+像素供给+入口）——
    //
    // 键语义（core color_ffi.rs 模块注释）：一切 file_id = content URI 哈希（MediaStore
    // `_id` 派生，改名/移动不变形），落 colors.db 的 file_path 列。LAN 项（path 是 http
    // URL）不进颜色库——调用方必须用 contentUri 判别，本层 decodeRgba 也再拦一道。

    /** 主色调节统计（colorDbStats 的 UI 形；null=面板未加载过）。 */
    data class ColorDbStatsUi(val total: Int, val pending: Int, val extracted: Int, val error: Int)

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

    private val colorDbMutex = Mutex()

    @Volatile
    private var colorDbReady = false

    private var colorTaskId: String? = null

    /** 颜色库幂等初始化（FFI 进程级单槽；首次建库，重复 init=switch 幂等）。 */
    private suspend fun ensureColorDb() {
        if (colorDbReady) return
        colorDbMutex.withLock {
            if (!colorDbReady) {
                withContext(Dispatchers.IO) { initColorDb(File(appContext.filesDir, "colors.db").absolutePath) }
                colorDbReady = true
            }
        }
    }

    /**
     * content URI → 下采样 RGBA 像素（最长边 ≈256px，core 提取算法不再缩放）。
     * null = 非本地 content URI（LAN 项的 http URL）/开流失败/解码失败。
     * getPixels 逐像素装包（ARGB→RGBA）；半透明 PNG 受 Bitmap premultiplied 影响有
     * 轻微色偏——照片主色调语义下可忽略（登记）。
     */
    private fun decodeRgba(contentUri: String, maxSide: Int = 256): ColorPixels? {
        if (!contentUri.startsWith("content:")) return null
        return runCatching {
            val resolver = appContext.contentResolver
            val uri = android.net.Uri.parse(contentUri)
            val bounds = android.graphics.BitmapFactory.Options().apply { inJustDecodeBounds = true }
            resolver.openInputStream(uri)?.use { android.graphics.BitmapFactory.decodeStream(it, null, bounds) }
            val w = bounds.outWidth
            val h = bounds.outHeight
            if (w <= 0 || h <= 0) return null
            var sample = 1
            while (maxOf(w, h) / sample > maxSide) sample *= 2
            val opts = android.graphics.BitmapFactory.Options().apply { inSampleSize = sample }
            val bmp = resolver.openInputStream(uri)?.use {
                android.graphics.BitmapFactory.decodeStream(it, null, opts)
            } ?: return null
            val iw = bmp.width
            val ih = bmp.height
            val pixels = IntArray(iw * ih)
            bmp.getPixels(pixels, 0, iw, 0, 0, iw, ih)
            bmp.recycle()
            val rgba = ByteArray(iw * ih * 4)
            for (i in pixels.indices) {
                val p = pixels[i]
                rgba[i * 4] = ((p shr 16) and 0xFF).toByte()
                rgba[i * 4 + 1] = ((p shr 8) and 0xFF).toByte()
                rgba[i * 4 + 2] = (p and 0xFF).toByte()
                rgba[i * 4 + 3] = ((p shr 24) and 0xFF).toByte()
            }
            ColorPixels(width = iw.toUInt(), height = ih.toUInt(), rgba = rgba)
        }.getOrNull()
    }

    /** 提取中的 file_id 集（自动提取翻页连发与手动按钮同 id 并发防重）。 */
    private val inFlightPalettes = java.util.Collections.synchronizedSet(mutableSetOf<String>())

    /** 单张提取主色调并落库（查看器手动按钮/自动提取共用）。成功增量进 [colorPalettesById]；失败回调 null。 */
    fun extractPalette(fileId: String, contentUri: String, onDone: (List<String>?) -> Unit = {}) {
        if (!inFlightPalettes.add(fileId)) return
        viewModelScope.launch {
            val hexes: List<String>? = try {
                ensureColorDb()
                withContext(Dispatchers.IO) {
                    val px = decodeRgba(contentUri) ?: throw IllegalStateException("无法读取图像像素")
                    extractAndSaveColors(fileId, px.width, px.height, px.rgba)
                }
            } catch (e: Exception) {
                Log.w(TAG, "[Color] extract failed fileId=$fileId", e)
                null
            } finally {
                inFlightPalettes.remove(fileId)
            }
            if (hexes != null) {
                colorPalettesById.value = colorPalettesById.value + (fileId to hexes)
            }
            onDone(hexes)
        }
    }

    /** 全库批读主色调进 [colorPalettesById]（查看器打开前的暖缓存；只补缺不覆盖已有）。 */
    fun refreshPaletteCache() {
        viewModelScope.launch {
            runCatching {
                ensureColorDb()
                withContext(Dispatchers.IO) {
                    val ids = allImageIds()
                    if (ids.isEmpty()) return@withContext
                    val rows = getColorsByFilePaths(ids)
                    val map = colorPalettesById.value.toMutableMap()
                    ids.forEachIndexed { i, id -> rows.getOrNull(i)?.let { map[id] = it } }
                    colorPalettesById.value = map
                }
            }.onFailure { Log.w(TAG, "[Color] palette cache refresh failed", it) }
        }
    }

    /** 全库 file id 清单（相册枚举去重；与 performAiSearch 的全库惯用法同源）。 */
    private fun allImageIds(): List<String> =
        folders.value
            .flatMap { f -> runCatching { listImages(f.id) }.getOrDefault(emptyList()) }
            .map { it.id }
            .distinct()

    /** 按颜色搜索（查看器色块/TopBar 取色器共用）：命中集顶替文本过滤（AI 搜索同管线，互斥清理）。 */
    fun startColorSearch(hex: String) {
        if (colorSearchBusy.value) return
        viewModelScope.launch {
            colorSearchBusy.value = true
            clearAiSearch() // 与 AI 命中集互斥：颜色命中顶替 AI 命中（反向互斥见 performAiSearch）
            try {
                ensureColorDb()
                val ids = withContext(Dispatchers.IO) { searchByColor(hex) }
                colorSearchIds.value = ids.toSet()
                colorSearchHex.value = hex
                colorSearchResultImages.value =
                    if (ids.isEmpty()) emptyList() else withContext(Dispatchers.IO) { listImagesByIds(ids) }
                aiToast("按颜色搜索命中 ${ids.size} 张")
            } catch (e: Exception) {
                Log.w(TAG, "[Color] search failed hex=$hex", e)
                aiToast("颜色搜索失败：${e.message ?: "未知错误"}")
            } finally {
                colorSearchBusy.value = false
            }
        }
    }

    /** 颜色过滤态清理（清搜索词/关搜索胶囊共用）。 */
    fun clearColorSearch() {
        colorSearchIds.value = null
        colorSearchHex.value = null
        colorSearchResultImages.value = emptyList()
    }

    /** 主色调节刷新：先清一次磁盘上已不存在的路径残留（桌面同语义；file_id 键保留），再读统计+错误数。 */
    fun refreshColorPanel() {
        viewModelScope.launch {
            runCatching {
                ensureColorDb()
                withContext(Dispatchers.IO) {
                    cleanupColorNonexistent()
                    val s = colorDbStats()
                    colorStats.value =
                        ColorDbStatsUi(s.total.toInt(), s.pending.toInt(), s.extracted.toInt(), s.error.toInt())
                    colorErrorCount.value = getColorErrorFiles().size
                }
            }.onFailure { Log.w(TAG, "[Color] panel refresh failed", it) }
        }
    }

    /**
     * 批量提取全库主色调（StoragePanel「开始提取」）：逐张 请求像素→提取→落库，
     * 锁步泵在本协程的 IO 线程驱动回调；单张失败只记日志（行标 error 供错误文件管理）。
     * 进度/终态同步通知栏（ScanNotifier.colorProgress/colorDone，暂停/恢复由通知按钮
     * 与面板双入口控制）。
     */
    fun startColorBatchExtract() {
        if (colorTaskState.value != null) {
            aiToast("提取任务进行中")
            return
        }
        viewModelScope.launch {
            val imagesById = withContext(Dispatchers.IO) {
                folders.value
                    .flatMap { f -> runCatching { listImages(f.id) }.getOrDefault(emptyList()) }
                    .distinctBy { it.id }
                    .associateBy { it.id }
            }
            if (imagesById.isEmpty()) {
                aiToast("没有可提取的图片")
                return@launch
            }
            try {
                ensureColorDb()
            } catch (e: Exception) {
                Log.w(TAG, "[Color] batch init db failed", e)
                aiToast("颜色库初始化失败：${e.message ?: "未知错误"}")
                return@launch
            }
            val taskId = "color-batch-${System.currentTimeMillis()}"
            colorTaskId = taskId
            colorTaskState.value = ColorTaskState(0, imagesById.size, false)
            scanNotifier.colorProgress(0, imagesById.size, false)
            var finished = "completed" to ""
            try {
                withContext(Dispatchers.IO) {
                    batchExtractColors(imagesById.keys.toList(), taskId, object : ColorBatchCallback {
                        override fun readPixels(fileId: String): ColorPixels? =
                            imagesById[fileId]?.let { decodeRgba(it.contentUri) }

                        override fun onProgress(current: UInt, total: UInt) {
                            colorTaskState.value =
                                colorTaskState.value?.copy(current = current.toInt(), total = total.toInt())
                            scanNotifier.colorProgress(
                                current.toInt(),
                                total.toInt(),
                                colorTaskState.value?.paused ?: false,
                            )
                        }

                        override fun onFileDone(fileId: String, ok: Boolean, note: String) {
                            if (!ok) Log.w(TAG, "[Color] batch file failed fileId=$fileId: $note")
                        }

                        override fun onFinished(state: String, message: String) {
                            finished = state to message
                        }
                    })
                }
            } catch (e: Exception) {
                Log.w(TAG, "[Color] batch extract crashed", e)
                finished = "error" to (e.message ?: "未知错误")
            }
            colorTaskId = null
            colorTaskState.value = null
            refreshColorPanel()
            refreshPaletteCache()
            val doneMessage = when (finished.first) {
                "completed" -> "提取完成（${finished.second}）"
                "cancelled" -> "已取消（${finished.second}）"
                else -> "失败：${finished.second}"
            }
            scanNotifier.colorDone(doneMessage)
            aiToast("主色调$doneMessage")
        }
    }

    /** 暂停批量提取（下一张迭代边界生效；paused 为本层状态机标志，通知按钮组随之刷新）。 */
    fun pauseColorBatch() {
        val id = colorTaskId ?: return
        if (pauseColorTask(id)) {
            colorTaskState.value = colorTaskState.value?.copy(paused = true)
            colorTaskState.value?.let { scanNotifier.colorProgress(it.current, it.total, true) }
        }
    }

    fun resumeColorBatch() {
        val id = colorTaskId ?: return
        if (resumeColorTask(id)) {
            colorTaskState.value = colorTaskState.value?.copy(paused = false)
            colorTaskState.value?.let { scanNotifier.colorProgress(it.current, it.total, false) }
        }
    }

    /** 取消批量提取（在途一张跑完；终态经 onFinished 清任务态）。 */
    fun cancelColorBatch() {
        colorTaskId?.let { cancelColorTask(it) }
    }

    /** 错误文件三操作（重试=重新入队/删除=移除记录/清理=清磁盘上已不存在的路径记录）。 */
    fun retryColorErrors() = colorErrorOp { retryColorErrorFiles() }

    fun deleteColorErrors() = colorErrorOp { deleteColorErrorFiles() }

    fun cleanupColorRecords() = colorErrorOp { cleanupColorNonexistent() }

    private fun colorErrorOp(op: () -> UInt) {
        viewModelScope.launch {
            runCatching {
                ensureColorDb()
                withContext(Dispatchers.IO) { op() }
            }.onSuccess { n ->
                aiToast("操作完成（$n 条）")
                refreshColorPanel()
            }.onFailure {
                Log.w(TAG, "[Color] error-file op failed", it)
                aiToast("操作失败：${it.message ?: "未知错误"}")
            }
        }
    }

    /** 自动提取开关（查看器翻图自动提取；设置持久化，UI 在存储面板主色调节）。 */
    fun setAutoExtractPalette(enabled: Boolean) {
        settings.value = settings.value.copy(autoExtractPalette = enabled)
        settingsStore.save(settings.value)
    }

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
            val cached = withContext(Dispatchers.IO) { orderFoldersForOverview(listFolders()) }
            folders.value = cached
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
     * API < 30 的删除兜底（[MainActivity] 走 MediaStore.createDeleteRequest 的前置系统
     * 弹窗需要 API 30）：直接逐条 contentResolver.delete。本应用自建的媒体可删成功；
     * 三方媒体的共享存储删除在无 WRITE 权限时抛 SecurityException/Reject——逐条
     * try/catch，成功多少算多少，失败只记日志。
     */
    fun deleteDirect(uris: List<android.net.Uri>, onDone: (Int) -> Unit = {}) {
        viewModelScope.launch {
            val deleted = withContext(Dispatchers.IO) {
                var n = 0
                for (uri in uris) {
                    try {
                        if (appContext.contentResolver.delete(uri, null, null) > 0) n++
                    } catch (e: Exception) {
                        Log.w(TAG, "[Delete] direct delete failed: $uri", e)
                    }
                }
                n
            }
            Log.i(TAG, "[Delete] direct deleted=$deleted/${uris.size}")
            onDone(deleted)
        }
    }

    // ===== M4b 1.1 本地库文件操作（MediaStore 写原语）=====
    //
    // 与桌面 file_operations.rs 不同源（那边是文件系统语义 + 路径哈希迁移元数据；这边
    // 是 MediaStore 行操作），实现不互抄。三个原语都收 **content uri**（UI 边界把
    // file id 解析成 uri 只做一次，写授权也要用同一批 uri），公共纪律：
    //  - 授权在宿主（[MainActivity.requestWriteAccess]，createWriteRequest 攒一批一次弹）；
    //    复制是 insert 新行（App 拥有新行），不需要写授权；
    //  - 重命名/移动只改 MediaStore 行的 DISPLAY_NAME/RELATIVE_PATH，_id 与 content_uri
    //    不变 → file_id 不变 → 元数据自然还挂着（规划五要点②），不写任何迁移代码；
    //  - 全部 Dispatchers.IO + 逐条 try/catch（deleteDirect 同款，成功多少算多少）；
    //  - 完成后主动 scanAndReconcile + reloadImages：observer 的 1s 防抖会兜底，但主动
    //    触发让 UI 即时反映，不赌时序（五要点③「UI 不能等下次扫描才变」）。

    /** 选中集上下文菜单/查看器共用：把文件 id 解析成 content uri（读索引，不挑当前视图）。 */
    fun resolveFileUris(fileIds: Collection<String>, onReady: (List<android.net.Uri>) -> Unit) {
        viewModelScope.launch {
            onReady(resolveUris(fileIds).map { it.second })
        }
    }

    /**
     * 选中集（图片和/或总览的文件夹卡片）展开成**图片 id 列表**（M4b 1.4 复制/移动的
     * 前置；文件夹读库展开，与 [resolveSelectionUris] 同源同语义）。
     */
    fun resolveSelectionFileIds(ids: Set<String>, onReady: (List<String>) -> Unit) {
        viewModelScope.launch {
            val out = withContext(Dispatchers.IO) {
                val folderById = folders.value.associateBy { it.id }
                val out = ArrayList<String>(ids.size)
                for (id in ids) {
                    if (folderById.containsKey(id)) {
                        listImages(id).forEach { out += it.id }
                    } else {
                        out += id
                    }
                }
                out
            }
            onReady(out)
        }
    }

    /**
     * 重命名（改 DISPLAY_NAME）。[targets] = (uri, 新名)；调用方先过宿主授权（单选场景
     * 只有一个 uri，同样走 [MainActivity.requestWriteAccess] 一条路径）。
     */
    fun renameFiles(targets: List<Pair<android.net.Uri, String>>, onDone: (Int) -> Unit = {}) {
        if (targets.isEmpty()) {
            onDone(0)
            return
        }
        viewModelScope.launch {
            val n = withContext(Dispatchers.IO) {
                var count = 0
                for ((uri, newName) in targets) {
                    try {
                        val values = ContentValues().apply {
                            put(MediaStore.Images.Media.DISPLAY_NAME, newName)
                        }
                        if (appContext.contentResolver.update(uri, values, null, null) > 0) count++
                    } catch (e: Exception) {
                        Log.w(TAG, "[FileOp] rename failed $uri -> $newName", e)
                    }
                }
                count
            }
            Log.i(TAG, "[FileOp] renamed=$n/${targets.size}")
            if (n > 0) refreshAfterWrite()
            onDone(n)
        }
    }

    /**
     * 移动到目标相册（改 RELATIVE_PATH 跨 bucket）。[targetRelPath] 由宿主解析好传入
     * （既有相册的 RELATIVE_PATH 或新相册的 `Pictures/<名字>`，见 resolveFolderRelPath /
     * MainActivity 的新建相册分支）；授权（批量一次）由调用方先行完成。
     */
    fun moveFiles(uris: List<android.net.Uri>, targetRelPath: String, onDone: (Int) -> Unit = {}) {
        if (uris.isEmpty()) {
            onDone(0)
            return
        }
        val relPath = targetRelPath.ensureTrailingSlash()
        viewModelScope.launch {
            val n = withContext(Dispatchers.IO) {
                var count = 0
                for (uri in uris) {
                    try {
                        val values = ContentValues()
                        if (Build.VERSION.SDK_INT >= 29) {
                            values.put(MediaStore.Images.Media.RELATIVE_PATH, relPath)
                        } else {
                            // API < 29 没有 RELATIVE_PATH 列：按旧语义直接改 DATA 全路径
                            val name = queryDisplayName(uri) ?: continue
                            values.put(MediaStore.Images.Media.DATA, legacyDataPath(relPath, name))
                        }
                        if (appContext.contentResolver.update(uri, values, null, null) > 0) count++
                    } catch (e: Exception) {
                        Log.w(TAG, "[FileOp] move failed $uri -> $relPath", e)
                    }
                }
                count
            }
            Log.i(TAG, "[FileOp] moved=$n/${uris.size} -> $relPath")
            if (n > 0) refreshAfterWrite()
            onDone(n)
        }
    }

    /**
     * 复制到目标相册（insert 新行 + 字节流拷贝 + **元数据/标签搬运**）。不需要写授权
     * （App 拥有新行，只要读权限）。
     *
     * 搬运（M4b 1.2 方案 A，规划五要点④「副本带着原标签」）：新 uri 经 FFI `generateId`
     * 算出新 file_id（与扫描对账同一纯函数，必然同值），源行的 file_metadata 读出后
     * copy 成新行、源标签 `setFileTags` 写到新 id。顺序安全性：此时副本行已在 MediaStore，
     * 写后的对账（[refreshAfterWrite]）会把新 id 纳入 file_index——先写的元数据/标签
     * 不会被当孤儿清掉。
     */
    fun copyFiles(uris: List<android.net.Uri>, targetRelPath: String, onDone: (Int) -> Unit = {}) {
        if (uris.isEmpty()) {
            onDone(0)
            return
        }
        val relPath = targetRelPath.ensureTrailingSlash()
        viewModelScope.launch {
            val n = withContext(Dispatchers.IO) {
                var count = 0
                for (source in uris) {
                    try {
                        val uri = insertImageCopy(source, relPath) ?: continue
                        appContext.contentResolver.openInputStream(source)?.use { input ->
                            appContext.contentResolver.openOutputStream(uri)?.use { output ->
                                input.copyTo(output)
                            } ?: throw IllegalStateException("openOutputStream failed: $uri")
                        } ?: throw IllegalStateException("openInputStream failed: $source")
                        // 元数据/标签搬运；失败只记日志（副本本体已落地，别让它回滚计数）。
                        // uri 必须重导成扫描管道同款规范形式：insert 返回的是
                        // external_primary 形式，与 scanMediaStore 拼的 external 形式指向
                        // 同一行但字符串不同 → generateId 哈希不同 → 元数据写到索引永远
                        // 对不上的孤儿 id 上（本轮实测踩过）。
                        try {
                            val canonicalUri = ContentUris.withAppendedId(
                                MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
                                ContentUris.parseId(uri),
                            )
                            val newId = generateId(canonicalUri.toString())
                            val sourceId = generateId(source.toString())
                            getFileMetadata(sourceId)?.let { meta ->
                                upsertFileMetadata(meta.copy(fileId = newId, path = canonicalUri.toString()))
                            }
                            getAllFileTags().firstOrNull { it.fileId == sourceId }?.tags?.let { tags ->
                                if (tags.isNotEmpty()) setFileTags(newId, tags)
                            }
                        } catch (e: Exception) {
                            Log.w(TAG, "[FileOp] metadata copy failed $source -> $uri", e)
                        }
                        count++
                    } catch (e: Exception) {
                        Log.w(TAG, "[FileOp] copy failed $source -> $relPath", e)
                    }
                }
                count
            }
            Log.i(TAG, "[FileOp] copied=$n/${uris.size} -> $relPath")
            if (n > 0) refreshAfterWrite()
            onDone(n)
        }
    }

    /**
     * 既有相册的 folder_id → RELATIVE_PATH（移动/复制的目标值）。folder.id =
     * generate_id(bucket_id)（Rust 对账同款），这里现场从 MediaStore 查 (BUCKET_ID,
     * RELATIVE_PATH) 对并用同一纯函数反查——**不算出来的映射不做缓存**，空相册按 1.3
     * 的懒创建语义本就不该存在；查不到（理论上只剩 0 图的瞬时态）返回 null 由调用方提示。
     */
    fun resolveFolderRelPath(folderId: String, onReady: (String?) -> Unit) {
        viewModelScope.launch {
            val relPath = withContext(Dispatchers.IO) {
                appContext.contentResolver.query(
                    MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
                    arrayOf(
                        MediaStore.Images.Media.BUCKET_ID,
                        MediaStore.Images.Media.RELATIVE_PATH,
                    ),
                    null, null, null,
                )?.use { c ->
                    val bucketCol = c.getColumnIndexOrThrow(MediaStore.Images.Media.BUCKET_ID)
                    val relCol = c.getColumnIndexOrThrow(MediaStore.Images.Media.RELATIVE_PATH)
                    while (c.moveToNext()) {
                        if (generateId(c.getLong(bucketCol).toString()) == folderId) {
                            return@use c.getString(relCol)
                        }
                    }
                    null
                }
            }
            onReady(relPath)
        }
    }

    /** 逐条写操作后的主动刷新（防抖 observer 只是兜底）。 */
    private suspend fun refreshAfterWrite() {
        try {
            scanAndReconcile()
            reloadImages()
        } catch (e: Exception) {
            Log.w(TAG, "[FileOp] post-write refresh failed", e)
        }
    }

    /** file_id → content uri（FFI 索引为源，概览页 stale 的 images.value 不掺和）。 */
    private suspend fun resolveUris(fileIds: Collection<String>): List<Pair<String, android.net.Uri>> =
        withContext(Dispatchers.IO) {
            val byId = listImagesByIds(fileIds.toList()).associateBy { it.id }
            fileIds.mapNotNull { id -> byId[id]?.let { id to android.net.Uri.parse(it.contentUri) } }
        }

    /** 源行的 DISPLAY_NAME（API < 29 移动时拼 DATA 用）。 */
    private fun queryDisplayName(uri: android.net.Uri): String? =
        appContext.contentResolver.query(
            uri,
            arrayOf(MediaStore.Images.Media.DISPLAY_NAME),
            null, null, null,
        )?.use { if (it.moveToFirst()) it.getString(0) else null }

    /** insert 一行并返回新 uri（携带源的尺寸/日期等列；R+ 走 VOLUME_EXTERNAL_PRIMARY）。 */
    private fun insertImageCopy(source: android.net.Uri, relPath: String): android.net.Uri? {
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
        resolver.query(source, projection, null, null, null)?.use { c ->
            if (!c.moveToFirst()) return null
            val name = c.getString(0) ?: return null
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
            return resolver.insert(collection, values)
        }
        return null
    }

    /** API < 29 的目标全路径（共享存储根 + RELATIVE_PATH 语义 + 文件名）。 */
    private fun legacyDataPath(relPath: String, name: String): String {
        val base = android.os.Environment.getExternalStorageDirectory().absolutePath
        return "$base/$relPath/$name"
    }

    private fun String.ensureTrailingSlash(): String =
        if (isEmpty() || endsWith('/')) this else "$this/"

    /**
     * 媒体读权限检查。ViewModel 里兜这道闸是因为热刷新的入口（ContentObserver）在本类里：
     * 无权限时 MediaStore 查询只返回本应用自有的条目，拿这种残缺快照去对账会把整个索引清空。
     * 权限字符串须与 MainActivity.requestMediaPermissionIfNeeded 保持一致。
     */
    private fun hasMediaPermission(): Boolean {
        val permission = if (Build.VERSION.SDK_INT >= 33) {
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
        onDone: (Boolean) -> Unit = {},
    ) {
        // path 在新建元数据行时才用得上（库里已有行则整行读回来了）。在主线程读
        // images.value，不进 IO 块——Compose state 不该在别的线程读。
        val contentUri = images.value.firstOrNull { it.id == fileId }?.contentUri.orEmpty()
        viewModelScope.launch {
            val ok = withContext(Dispatchers.IO) {
                runCatching {
                    if (tags != null) setFileTags(fileId, tags)
                    if (description != null || sourceUrl != null) {
                        val row = getFileMetadata(fileId) ?: FfiFileMetadata(
                            fileId = fileId,
                            path = contentUri,
                            description = null,
                            sourceUrl = null,
                            aiData = null,
                            category = null,
                            updatedAt = null,
                        )
                        upsertFileMetadata(
                            row.copy(
                                description = description ?: row.description,
                                sourceUrl = sourceUrl ?: row.sourceUrl,
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
     * 删除专题（M4a 4.3 长按菜单；桌面右键「删除」同位）。`delete_topic` 只删该专题的
     * topics / topic_files / topic_people 三表行、**不级联子专题**，这里先把子专题
     * （两层模型下只此一层）递归删掉再删自己；图片本身不受影响。删的是当前详情正打开
     * 的专题时，宿主负责把 activeTopicId 清掉回列表。
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

    // ===== M6a 阶段 4：LAN 浏览（数据层；UI 只消费这里算好的结构）=====

    /** 清空 LAN 会话态（断线/手动断开联动；不动本地库/词表）。远端条目（含 tag 词表）整体消失。 */
    private fun clearLanSession() {
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
    }

    /** 连接成功（或手动刷新）后的远端根拉取：all_imageFolders 一次带回目录+根散图+门禁位。 */
    private fun refreshLanRootsInternal() {
        val session = lan.currentSession() ?: return
        lanFetchJob?.cancel()
        lanFetchJob = viewModelScope.launch {
            val result = withContext(Dispatchers.IO) {
                runCatching { session.client.allImageFolders(session.base, session.token) }
            }.getOrNull() ?: run {
                Log.w(TAG, "[Lan] all_image_folders 拉取失败（状态机重试链会跟进）")
                return@launch
            }
            lanConnected.value = true
            lanAllowEdit.value = result.allowEdit
            lanAllowUpload.value = result.allowUpload
            lanRootImages.value = result.rootImages
            rebuildLanOverview(session, result.folders)
            Log.i(
                TAG,
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
     *  1. 逐远端目录 browse 收集全部 image 项（并发 [LAN_BROWSE_CONCURRENCY]；单个目录
     *     失败 Log.w 跳过不炸整批）→ 合并根散图 → [lanLibraryImages]；
     *  2. path 分块（[LAN_METADATA_BATCH_CHUNK]）调 metadataBatch → [lanMetaByPath]
     *     （单块失败只丢那块，词表分组可以只差一块待下次重连补齐）；
     *  3. tag→count 聚合 → groupRemoteTagCounts 纯函数 → [lanRemoteTagGroups]；
     *  4. people() / topics() → [lanPeople] / [lanTopics]。
     *
     * 失败降级口径：任一环节 Log.w 后用已就绪的部分继续，不抛不炸（对齐 [reloadTagState]
     * 「读失败保留旧值」的纪律；断线重连会整体重跑）。
     */
    private suspend fun refreshLanLibraryInternal(session: LanManager.LanSession, folders: List<LanRemoteFolder>) {
        // 1) 全目录 browse（并发 4；协程体在主线程汇合，列表只在主线程写，无锁安全）
        val semaphore = Semaphore(LAN_BROWSE_CONCURRENCY)
        val browsed = coroutineScope {
            folders.map { folder ->
                async {
                    semaphore.withPermit {
                        withContext(Dispatchers.IO) {
                            runCatching { session.client.browse(session.base, session.token, folder.path) }
                                .onFailure {
                                    Log.w(TAG, "[Lan] 目录 browse 失败跳过：…${folder.path.takeLast(12)}")
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
            TAG,
            "[Lan] 远端库就绪 images=${library.size}（含根散图；browse 失败 ${browsed.count { it == null }} 目录）",
        )

        // 2) metadata 批读（分块 300；契约保证 items 与入参同序同数量，按 path 键回填）
        val meta = HashMap<String, LanMetadataItem>()
        library.keys.chunked(LAN_METADATA_BATCH_CHUNK).forEach { chunk ->
            val items = withContext(Dispatchers.IO) {
                runCatching { session.client.metadataBatch(session.base, session.token, chunk) }
            }
            items.getOrNull()?.forEach { meta[it.path] = it }
                ?: Log.w(TAG, "[Lan] metadata/batch 单块失败（${chunk.size} 项），远端词表暂缺该块")
        }
        lanMetaByPath.value = meta
        Log.i(TAG, "[Lan] 远端元数据就绪 ${meta.size}/${library.size}")

        // 3) 远端词表分组（唯一 FFI 触点 = groupRemoteTagCounts 纯函数，排序由 Rust 定）
        rebuildLanRemoteTagGroups()

        // 4) 人物与专题（读失败保留旧列表，桌面阶段 2「读失败保留内存行」同口径）
        reloadLanPeople(session)
        reloadLanTopics(session)
    }

    /**
     * 重算 [lanRemoteTagGroups]：[lanMetaByPath] 的 tags 做 tag→图片数聚合，交
     * groupRemoteTagCounts 纯函数分组排序（**Kotlin 侧不自己排**——「排序规则只许有一套」；
     * 纯函数不碰本地库，远端词表绝不写进本地词表，D31 纪律）。
     */
    private suspend fun rebuildLanRemoteTagGroups() {
        val counts = HashMap<String, Long>()
        for (item in lanMetaByPath.value.values) {
            for (tag in item.tags) counts.merge(tag, 1L, Long::plus)
        }
        lanRemoteTagGroups.value = withContext(Dispatchers.IO) {
            groupRemoteTagCounts(counts.map { (tag, n) -> RemoteTagCount(tag, n) }, settings.value.language)
        }
    }

    /** 重拉远端人物（失败保留旧列表——对齐桌面阶段 2「读失败保留内存行」口径）。 */
    private suspend fun reloadLanPeople(session: LanManager.LanSession) {
        val loaded = withContext(Dispatchers.IO) {
            runCatching { session.client.people(session.base, session.token) }
        }
        loaded.getOrNull()?.let { lanPeople.value = it }
            ?: Log.w(TAG, "[Lan] people 重拉失败（${loaded.exceptionOrNull()?.message ?: "unknown"}），保留旧列表")
    }

    /** 重拉远端专题（失败保留旧列表，口径同 [reloadLanPeople]）。 */
    private suspend fun reloadLanTopics(session: LanManager.LanSession) {
        val loaded = withContext(Dispatchers.IO) {
            runCatching { session.client.topics(session.base, session.token) }
        }
        loaded.getOrNull()?.let { lanTopics.value = it }
            ?: Log.w(TAG, "[Lan] topics 重拉失败（${loaded.exceptionOrNull()?.message ?: "unknown"}），保留旧列表")
    }

    /** LAN 总览下拉刷新（完成回调对齐本地 refreshManual 的形态）。 */
    fun refreshLanRoots(onDone: () -> Unit = {}) {
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
     */
    private fun rebuildLanOverview(session: LanManager.LanSession, folders: List<LanRemoteFolder>) {
        val out = ArrayList<Folder>(folders.size + 1)
        val roots = lanRootImages.value
        if (roots.isNotEmpty()) {
            out += Folder(
                id = lanFolderId(LAN_ROOT_IMAGES_ID),
                // 与本地根目录散图同一个显示名（sortFolders 的置顶规则按它识别，天然复用）
                name = ROOT_FOLDER_DISPLAY_NAME,
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
                imageCount = f.imageCount,
                coverUri = f.previewPath
                    ?.let { session.client.thumbnailUrl(session.base, session.token, it) },
                createdAt = 0,
                modifiedAt = 0,
            )
        }
        lanOverviewFolders.value = out
    }

    /** 远端图片项 → FFI [Image]（网格/查看器共用的展示模型；path 身份铁律：id=远端 path）。 */
    private fun lanImageOf(session: LanManager.LanSession, item: LanRemoteImage): Image = Image(
        id = item.path,
        name = item.name.ifEmpty { item.path.substringAfterLast('/') },
        // contentUri 装**缩略图 URL**：网格/总览的 URL 分支按 http 前缀识别（FileGrid.loadInto）
        contentUri = session.client.thumbnailUrl(session.base, session.token, item.path),
        width = null,
        height = null,
        size = item.size,
        // browse 响应不含时间字段：置 0（查看器抽屉显示「—」，日期分组落 Unknown，React 同口径）
        createdAt = 0,
        modifiedAt = 0,
        format = item.name.substringAfterLast('.', "").takeIf { it.isNotEmpty() }?.lowercase(Locale.US),
    )

    /**
     * LAN 大图 URL 构造器（查看器 ImageItem 的 path 用；未连接返回 null，查看器按本地图
     * 的空 path 兜底展示）。MainActivity 经 ViewerLayerHost 传入 toViewerItem。
     */
    fun lanImageUrlOf(): ((String) -> String)? {
        val s = lan.currentSession() ?: return null
        return { remotePath -> s.client.imageUrl(s.base, s.token, remotePath) }
    }

    /**
     * LAN 缩略图 URL 构造器（阶段 6：人物「换头像」的目录选择器图片行用；未连接返回
     * null，宿主退化为恒 null 的构造器，弹窗行只剩占位底）。与 [lanImageUrlOf] 同款
     * 「会话现取」——构造器快照在组合时求值，断线重连后的重组会换上新的会话。
     */
    fun lanThumbnailUrlOf(): ((String) -> String)? {
        val s = lan.currentSession() ?: return null
        return { remotePath -> s.client.thumbnailUrl(s.base, s.token, remotePath) }
    }

    /**
     * LAN 目录的序列取数（reloadImages 的并列入口，M4a 序列源先例）：
     *  - 虚拟根（`__lan_root_images__`）= 会话态里的根散图，**不单独 browse**；
     *  - tag 筛选虚拟目录（`__lan_tag__:<tag>`，阶段 5）= 从 [lanLibraryImages] 会话缓存
     *    按 tag 过滤（配合 [lanMetaByPath]），**不 browse、不动门禁位**（tag 视图沿用当前值）；
     *  - 其余远端目录 = LanClient.browse(path)，`type=video` 的项**过滤不进列表**
     *    （登记差异：React LAN 浏览含视频项；Kotlin 全 App 视频支持待定 M8+）。
     *
     * 阶段 8 起 browse/根散图分支尾随目录级元数据增量刷新（[refreshLanMetaFor]）：
     * 桌面反向写后目录内下拉刷新即可见，不必回总览刷新或重连。
     */
    private suspend fun reloadLanImages(folderId: String) {
        val key = "lan|$folderId"
        if (key != loadedImagesKey) images.value = emptyList()
        loadedImagesKey = key
        val session = lan.currentSession() ?: return
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
        } else {
            val remotePath = folderId.lanRemotePathOrNull() ?: return
            val result = withContext(Dispatchers.IO) {
                runCatching { session.client.browse(session.base, session.token, remotePath) }
            }.getOrNull() ?: run {
                Log.w(TAG, "[Lan] browse 失败 path 尾=${remotePath.takeLast(12)}")
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
            Log.i(TAG, "[Lan] 目录就绪 ${imgs.size} 张（视频项已过滤）")
        }
    }

    /**
     * 目录级元数据增量刷新（阶段 8 黑盒用例⑤）：把 [items] 的批读结果**并进**
     * [lanMetaByPath]（不替换整表——其他目录的缓存与词表计数不动）并重算远端词表。
     * 桌面反向写描述/标签后，目录内下拉刷新即可见；批读失败仅 Log.w 保留旧缓存
     * （失败降级口径同 [refreshLanLibraryInternal]）。
     */
    private suspend fun refreshLanMetaFor(items: List<LanRemoteImage>) {
        if (items.isEmpty()) return
        val session = lan.currentSession() ?: return
        val fresh = HashMap<String, LanMetadataItem>()
        items.map { it.path }.chunked(LAN_METADATA_BATCH_CHUNK).forEach { chunk ->
            val fetched = withContext(Dispatchers.IO) {
                runCatching { session.client.metadataBatch(session.base, session.token, chunk) }
            }
            fetched.getOrNull()?.forEach { fresh[it.path] = it }
                ?: Log.w(TAG, "[Lan] 目录级 metadata/batch 失败（${chunk.size} 项），保留旧缓存")
        }
        if (fresh.isNotEmpty()) {
            lanMetaByPath.value = lanMetaByPath.value + fresh
            rebuildLanRemoteTagGroups()
            Log.i(TAG, "[Lan] 目录级元数据刷新 ${fresh.size} 项")
        }
    }

    /** 当前 LAN 目录刷新（上传完成后重拉当前目录；完成回调对齐本地 refreshManual）。 */
    fun refreshLanFolder(onDone: () -> Unit = {}) {
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
    fun uploadUrisToLan(
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
            Log.i(TAG, "[Lan] 上传完成 ok=$okCount fail=$failCount target=…${targetDir.takeLast(12)}")
            if (okCount > 0) refreshLanFolder()
            onDone(okCount, failCount)
        }
    }

    /** 源行的 MIME 类型（upload multipart 用；查不到退回 image/jpeg 由调用方兜底）。 */
    private fun queryMimeType(uri: android.net.Uri): String? =
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
    fun saveLanImageToDownloads(remotePath: String, imageUrl: String, onDone: (ok: Boolean, savedName: String?) -> Unit) {
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
                Log.i(TAG, "[Lan] 已保存到下载：$name")
                onDone(true, name)
            }, onFailure = { e ->
                Log.w(TAG, "[Lan] 保存到设备失败", e)
                onDone(false, null)
            })
        }
    }

    /** MediaStore Downloads insert + 写字节；返回 MediaProvider 最终落定的文件名（重名自动序号）。 */
    private fun insertToDownloads(remotePath: String, bytes: ByteArray): String {
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

    private fun mimeForFileName(name: String): String = when (name.substringAfterLast('.', "").lowercase(Locale.US)) {
        "png" -> "image/png"
        "jpg", "jpeg" -> "image/jpeg"
        "webp" -> "image/webp"
        "gif" -> "image/gif"
        "bmp" -> "image/bmp"
        "heic", "heif" -> "image/heic"
        else -> "application/octet-stream"
    }

    // ===== M6a 阶段 5：在线元数据 / 人物 / 专题（写路径走 LanClient）=====
    //
    // 契约 §6：客户端不监听桌面 data-changed 事件，写操作成功后以**响应条目**做本地乐观
    // 更新 + 对应列表重拉。D31 数据层铁律落点：以下函数**绝不**触本地库/本地词表/本地
    // 过滤——不调 saveFileUpdates / upsertTopic / setFileTags / reloadTagState /
    // reloadTopics 等任何本地写路径；远端词表的新词只进 lanMetaByPath / lanRemoteTagGroups
    // 内存缓存，桌面词表由服务端自行维护。

    /**
     * 保存远端文件元数据（标签/描述/来源网址；契约 §2.2 整行读改写）。[tags] null =
     * 不改、空列表 = 显式清空（[LanMetadataPatch] 同义）；[description]/[sourceUrl]
     * null = 不改。成功：响应条目整行覆盖 [lanMetaByPath] 并重算 [lanRemoteTagGroups]
     * （乐观更新，不重拉全量）；失败（含 401/403/网络）：Log.w + onDone(false)，缓存不动。
     */
    fun saveLanFileUpdates(
        path: String,
        tags: List<String>? = null,
        description: String? = null,
        sourceUrl: String? = null,
        onDone: (Boolean) -> Unit = {},
    ) {
        val session = lan.currentSession()
        if (session == null) {
            onDone(false)
            return
        }
        viewModelScope.launch {
            val result = withContext(Dispatchers.IO) {
                runCatching {
                    session.client.putMetadata(
                        session.base, session.token, path,
                        LanMetadataPatch(tags = tags, description = description, sourceUrl = sourceUrl),
                    )
                }
            }
            val updated = result.getOrNull() ?: run {
                Log.w(TAG, "[Lan] 元数据保存失败 path 尾=…${path.takeLast(12)}：${result.exceptionOrNull()?.message}")
                onDone(false)
                return@launch
            }
            // 乐观更新：响应条目即服务端整行（以响应里的 path 为身份刷新，契约 §0）
            lanMetaByPath.value = lanMetaByPath.value + (updated.path to updated)
            rebuildLanRemoteTagGroups()
            Log.i(TAG, "[Lan] 元数据已保存 path 尾=…${updated.path.takeLast(12)} tags=${updated.tags.size}")
            onDone(true)
        }
    }

    /**
     * 建远端专题（契约 §4.2；id 服务端生成，description 仅非 null 才带上）。成功后重拉
     * topics() 刷新 [lanTopics]（重拉失败保留旧列表），新建的 [LanTopic] 回给调用方
     * （进详情/提示用）；失败回 null。
     */
    fun createLanTopic(name: String, description: String? = null, onDone: (LanTopic?) -> Unit = {}) {
        val trimmed = name.trim()
        val session = lan.currentSession()
        if (trimmed.isEmpty() || session == null) {
            onDone(null)
            return
        }
        viewModelScope.launch {
            val result = withContext(Dispatchers.IO) {
                runCatching { session.client.createTopic(session.base, session.token, trimmed, description) }
            }
            val topic = result.getOrNull() ?: run {
                Log.w(TAG, "[Lan] 建专题失败：${result.exceptionOrNull()?.message}")
                onDone(null)
                return@launch
            }
            reloadLanTopics(session)
            Log.i(TAG, "[Lan] 专题已建 id=${topic.id}")
            onDone(topic)
        }
    }

    /**
     * 删远端专题（契约 §4.3，级联删成员关联、图片本身不受影响）。成功后重拉 topics()；
     * 404（专题不存在）与其余失败同口径：Log.w + onDone(false)。
     */
    fun deleteLanTopic(topicId: String, onDone: (Boolean) -> Unit = {}) {
        val session = lan.currentSession()
        if (session == null) {
            onDone(false)
            return
        }
        viewModelScope.launch {
            val result = withContext(Dispatchers.IO) {
                runCatching { session.client.deleteTopic(session.base, session.token, topicId) }
            }
            val ok = result.getOrNull()?.success == true
            if (!ok) {
                Log.w(
                    TAG,
                    "[Lan] 删专题失败 id=$topicId：${result.exceptionOrNull()?.message ?: result.getOrNull()?.error}",
                )
                onDone(false)
                return@launch
            }
            reloadLanTopics(session)
            Log.i(TAG, "[Lan] 专题已删 id=$topicId")
            onDone(true)
        }
    }

    /**
     * 把选中集（远端 path 列表）归入远端专题（契约 §4.4；本入口只加**文件**成员，
     * peopleIds 恒空——加人物成员阶段 6 再接）。[paths] 为空直接回 false（两数组都空
     * 是服务端 400）。成功后重拉 topics()（fileCount 才会新）。
     */
    fun addSelectionToLanTopic(topicId: String, paths: List<String>, onDone: (Boolean) -> Unit = {}) {
        if (paths.isEmpty()) {
            onDone(false)
            return
        }
        val session = lan.currentSession()
        if (session == null) {
            onDone(false)
            return
        }
        viewModelScope.launch {
            val result = withContext(Dispatchers.IO) {
                runCatching {
                    session.client.addTopicMembers(session.base, session.token, topicId, paths, emptyList())
                }
            }
            val members = result.getOrNull()
            if (members?.success != true) {
                Log.w(TAG, "[Lan] 归入专题失败 topic=$topicId：${result.exceptionOrNull()?.message ?: "success=false"}")
                onDone(false)
                return@launch
            }
            reloadLanTopics(session)
            Log.i(TAG, "[Lan] 已归入专题 topic=$topicId fileCount=${members.fileCount}")
            onDone(true)
        }
    }

    /**
     * 重命名 / 换头像 / 改描述远端人物（契约 §3.2 整行读改写；三个可变字段任选，null =
     * 不改，[avatarPath] 是共享根相对 path——服务端内部换算 cover_file_id，客户端只碰
     * path）。404 = 人物不存在（服务端已删）、其余失败同口径：Log.w + onDone(false)。
     * 成功后重拉 people() 刷新 [lanPeople]（重拉失败保留旧列表）。
     */
    fun renameLanPerson(
        personId: String,
        name: String? = null,
        description: String? = null,
        avatarPath: String? = null,
        onDone: (Boolean) -> Unit = {},
    ) {
        val trimmedName = name?.trim()
        val session = lan.currentSession()
        if (session == null ||
            (trimmedName == null && description == null && avatarPath == null) ||
            trimmedName?.isEmpty() == true
        ) {
            onDone(false)
            return
        }
        viewModelScope.launch {
            val result = withContext(Dispatchers.IO) {
                runCatching {
                    session.client.putPerson(session.base, session.token, personId, trimmedName, avatarPath, description)
                }
            }
            if (result.getOrNull() == null) {
                Log.w(TAG, "[Lan] 人物更新失败 id=$personId：${result.exceptionOrNull()?.message}")
                onDone(false)
                return@launch
            }
            reloadLanPeople(session)
            Log.i(TAG, "[Lan] 人物已更新 id=$personId")
            onDone(true)
        }
    }

    // ===== M6a 阶段 6：互联态文件操作（rename/delete/move/copy；写路径走 LanClient）=====
    //
    // 契约 §1/§5：客户端不监听桌面 data-changed 事件，写成功后以响应里的新 path/逐项
    // 结果维护会话缓存（换 key / 移除 / 补最小条目）+ refreshLanFolder/refreshLanRoots
    // 重拉。目录纪律同阶段 5：只动 lan* 内存缓存，绝不触本地库/本地词表（D31）。

    /**
     * 一次性远端目录 browse（目录选择器等临时场景用）：**不改会话态与门禁位**——
     * [reloadLanImages] 的门禁同步是「当前浏览视图」语义，弹窗里的顺手 browse 不能动
     * 主界面的开关。[path] null/空串 = 共享根（服务端 handle_browse 对缺省/空串/`/` 同
     * 看待，unwrap_or_default 归零，空 `?path=` 即可）。失败（401/404/网络）回 null，
     * 调用方按「浏览不了」兜底。
     */
    fun browseLanPath(path: String?, onReady: (LanBrowseResult?) -> Unit) {
        val session = lan.currentSession()
        if (session == null) {
            onReady(null)
            return
        }
        viewModelScope.launch {
            val result = withContext(Dispatchers.IO) {
                runCatching { session.client.browse(session.base, session.token, path ?: "") }
            }
            result.getOrNull()?.let { onReady(it) } ?: run {
                Log.w(
                    TAG,
                    "[Lan] 临时 browse 失败 path 尾=…${(path ?: "").takeLast(12)}：${result.exceptionOrNull()?.message}",
                )
                onReady(null)
            }
        }
    }

    /**
     * 同目录改名远端文件（契约 §1；[newName] 是裸文件名，目录由服务端拼）。403/404/409
     * 走异常（runCatching 接住），FS 级失败是 200+success:false——两种失败形态同回
     * onDone(false, null)，缓存不动。成功：lanRootImages/lanLibraryImages/lanMetaByPath
     * 以响应新 path **换 key**（path 是身份，旧 key 不换就是幽灵条目），再
     * refreshLanFolder（当前目录重拉）+ refreshLanRoots（总览/侧栏计数）。
     */
    fun renameLanFile(oldPath: String, newName: String, onDone: (ok: Boolean, newPath: String?) -> Unit) {
        val trimmed = newName.trim()
        val session = lan.currentSession()
        if (session == null || trimmed.isEmpty()) {
            onDone(false, null)
            return
        }
        viewModelScope.launch {
            val result = withContext(Dispatchers.IO) {
                runCatching { session.client.rename(session.base, session.token, oldPath, trimmed) }
            }
            val renamed = result.getOrNull() ?: run {
                Log.w(TAG, "[Lan] 改名失败 path 尾=…${oldPath.takeLast(12)}：${result.exceptionOrNull()?.message}")
                onDone(false, null)
                return@launch
            }
            // 成功响应必带新 path；success=false 或缺新 path 都按失败处理——拿旧 path
            // 冒充新身份会把「换 key」做成自我污染
            val newPath = renamed.newPath
            if (!renamed.success || newPath == null) {
                Log.w(TAG, "[Lan] 改名失败 path 尾=…${oldPath.takeLast(12)}：${renamed.error ?: "success=false"}")
                onDone(false, null)
                return@launch
            }
            // 换 key：列表按 path 定位替换；两个 map 保持原序换 key 重插（LinkedHashMap）
            lanRootImages.value = lanRootImages.value.map {
                if (it.path == oldPath) it.copy(path = newPath, name = trimmed) else it
            }
            val library = LinkedHashMap<String, LanRemoteImage>(lanLibraryImages.value.size)
            lanLibraryImages.value.forEach { (p, img) ->
                library[if (p == oldPath) newPath else p] =
                    if (p == oldPath) img.copy(path = newPath, name = trimmed) else img
            }
            lanLibraryImages.value = library
            lanMetaByPath.value[oldPath]?.let { meta ->
                lanMetaByPath.value = lanMetaByPath.value - oldPath + (newPath to meta.copy(path = newPath))
            }
            Log.i(TAG, "[Lan] 已改名 …${oldPath.takeLast(12)} → …${newPath.takeLast(12)}")
            refreshLanFolder()
            refreshLanRoots()
            onDone(true, newPath)
        }
    }

    /**
     * 批量删远端文件（契约 §1 `DELETE /api/file`）：逐个顺序删（上传同款「逐个而非并发」
     * 先例，进度可读、服务端压力小；单条失败不中断批次，失败明细进日志）。全部完成后把
     * **真正删掉的** path 从三份会话缓存移除（失败项留在原地，UI 还能看见、可重试），
     * 再 refreshLanFolder + refreshLanRoots。onDone 的 (ok, fail) 不等重拉完成。
     */
    fun deleteLanFiles(paths: List<String>, onDone: (ok: Int, fail: Int) -> Unit) {
        val session = lan.currentSession()
        if (session == null || paths.isEmpty()) {
            onDone(0, paths.size)
            return
        }
        viewModelScope.launch {
            var okCount = 0
            val failedPaths = mutableSetOf<String>()
            paths.forEach { path ->
                val result = withContext(Dispatchers.IO) {
                    runCatching { session.client.deleteFile(session.base, session.token, path) }
                }
                val item = result.getOrNull()
                if (item?.success == true) {
                    okCount++
                } else {
                    failedPaths += path
                    Log.w(
                        TAG,
                        "[Lan] 删除失败 path 尾=…${path.takeLast(12)}：" +
                            "${result.exceptionOrNull()?.message ?: item?.error ?: "success=false"}",
                    )
                }
            }
            if (okCount > 0) {
                val deleted = paths.toSet() - failedPaths
                lanRootImages.value = lanRootImages.value.filter { it.path !in deleted }
                lanLibraryImages.value = lanLibraryImages.value.filterKeys { it !in deleted }
                lanMetaByPath.value = lanMetaByPath.value.filterKeys { it !in deleted }
                Log.i(TAG, "[Lan] 批量删除完成 ok=$okCount fail=${failedPaths.size}")
                refreshLanFolder()
                refreshLanRoots()
            } else {
                Log.w(TAG, "[Lan] 批量删除全部失败（${paths.size} 项），缓存不动")
            }
            onDone(okCount, paths.size - okCount)
        }
    }

    /**
     * 批量移动远端文件进 [targetDir]（契约 §5.1）：一次 [LanClient.moveFiles]，items 与
     * paths 同序逐项落账——成功项旧 path 出三缓存、新 path 补最小条目；目标目录不存在
     * 是整批 404（HTTP 异常，全批未动）。
     */
    fun moveLanFiles(paths: List<String>, targetDir: String, onDone: (ok: Int, fail: Int, firstError: String?) -> Unit) {
        val session = lan.currentSession()
        if (session == null || paths.isEmpty()) {
            onDone(0, paths.size, null)
            return
        }
        batchLanFileOp(
            label = "移动",
            removeSource = true,
            paths = paths,
            targetDir = targetDir,
            session = session,
            request = { session.client.moveFiles(session.base, session.token, paths, targetDir) },
            onDone = onDone,
        )
    }

    /**
     * 批量复制远端文件进 [targetDir]（契约 §5.2）：与 [moveLanFiles] 同形，差异在缓存
     * 语义——旧条目**保留**（本体没动），新条目按响应 new_path（重名自动改名后的实际
     * 落盘路径）插入；副本元数据由服务端迁移，metadataBatch 回读即可带原 tags。
     */
    fun copyLanFiles(paths: List<String>, targetDir: String, onDone: (ok: Int, fail: Int, firstError: String?) -> Unit) {
        val session = lan.currentSession()
        if (session == null || paths.isEmpty()) {
            onDone(0, paths.size, null)
            return
        }
        batchLanFileOp(
            label = "复制",
            removeSource = false,
            paths = paths,
            targetDir = targetDir,
            session = session,
            request = { session.client.copyFiles(session.base, session.token, paths, targetDir) },
            onDone = onDone,
        )
    }

    /**
     * move/copy 的公共体：一次批量请求 → items 逐项落缓存（[removeSource] 区分 move 删
     * 旧 / copy 留旧）→ 新 path 元数据回读 upsert → 远端词表重算 → 刷新当前目录与总览。
     * HTTP 级失败（404 = 目标目录不存在、403 = 门禁关闭、401 = 会话失效）整批未动，
     * onDone(0, paths.size, message)；item 级失败（源不存在/目标已存在）只计 fail，
     * 首个错误随 onDone 回给调用方做提示。
     */
    private fun batchLanFileOp(
        label: String,
        removeSource: Boolean,
        paths: List<String>,
        targetDir: String,
        session: LanManager.LanSession,
        request: suspend () -> List<LanFileOpItem>,
        onDone: (ok: Int, fail: Int, firstError: String?) -> Unit,
    ) {
        viewModelScope.launch {
            val result = withContext(Dispatchers.IO) {
                runCatching { request() }
            }
            val items = result.getOrNull() ?: run {
                Log.w(
                    TAG,
                    "[Lan] 批量${label}失败 target 尾=…${targetDir.takeLast(12)}：${result.exceptionOrNull()?.message}",
                )
                onDone(0, paths.size, result.exceptionOrNull()?.message)
                return@launch
            }
            var okCount = 0
            var firstError: String? = null
            val stalePaths = mutableSetOf<String>()
            val freshEntries = LinkedHashMap<String, LanRemoteImage>()
            items.forEach { item ->
                if (!item.success) {
                    if (firstError == null) firstError = item.error
                    return@forEach
                }
                val newPath = item.newPath ?: return@forEach // 契约成功项必带，防御不拦主流程
                okCount++
                if (removeSource) stalePaths += item.path
                // 最小条目的 size 从旧条目沿用；旧条目查不到（视频项/过期缓存）就不补——
                // 凭空造 size=0 的假条目，不如留给 refreshLanRoots 的全量重建兜底
                val old = lanLibraryImages.value[item.path]
                    ?: lanRootImages.value.firstOrNull { it.path == item.path }
                if (old != null) {
                    freshEntries[newPath] = LanRemoteImage(
                        name = newPath.substringAfterLast('/'),
                        path = newPath,
                        type = "image",
                        size = old.size,
                    )
                }
            }
            if (removeSource && stalePaths.isNotEmpty()) {
                lanRootImages.value = lanRootImages.value.filter { it.path !in stalePaths }
                lanLibraryImages.value = lanLibraryImages.value.filterKeys { it !in stalePaths }
                lanMetaByPath.value = lanMetaByPath.value.filterKeys { it !in stalePaths }
            }
            if (freshEntries.isNotEmpty()) {
                lanLibraryImages.value = lanLibraryImages.value + freshEntries
                // 新位置元数据回读 upsert（move/copy 服务端都迁移元数据）：tag 筛选视图从
                // lanMetaByPath 取数，缺行 = 新位置从 tag 视图漏项
                val metaPaths = freshEntries.keys.toList()
                val meta = withContext(Dispatchers.IO) {
                    runCatching { session.client.metadataBatch(session.base, session.token, metaPaths) }
                }
                meta.getOrNull()?.forEach { lanMetaByPath.value = lanMetaByPath.value + (it.path to it) }
                    ?: Log.w(TAG, "[Lan] ${label}后元数据回读失败（${metaPaths.size} 项），tag 视图暂缺待重连补齐")
                // 新元数据可能带来新词/新计数，远端词表分组跟着重算（纯函数，只动内存）
                rebuildLanRemoteTagGroups()
            }
            Log.i(
                TAG,
                "[Lan] 批量${label}完成 ok=$okCount fail=${items.size - okCount} target 尾=…${targetDir.takeLast(12)}",
            )
            refreshLanFolder()
            refreshLanRoots()
            onDone(okCount, items.size - okCount, firstError)
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
        // folderId 带 lan 前缀 = 远端目录（或虚拟根），走 LanClient.browse/会话态。
        if (tab.viewMode == ViewMode.BROWSER && tab.folderId?.startsWith(LAN_FOLDER_ID_PREFIX) == true) {
            reloadLanImages(tab.folderId!!)
            return
        }
        val topicId = if (tab.viewMode == ViewMode.TOPICS_OVERVIEW) tab.activeTopicId else null
        val byTag = tab.activeTags.isNotEmpty()
        if (topicId == null) {
            if (tab.viewMode != ViewMode.BROWSER) return
            if (!byTag && tab.folderId == null) return
        }
        // 换视图的 key 必须覆盖三条序列源的所有输入
        val key = buildString {
            append("f=").append(tab.folderId ?: "-")
            append("|g=").append(tab.activeTags.joinToString(","))
            append("|t=").append(topicId ?: "-")
        }
        // 只在**序列源换了**（进文件夹 / 改筛选 / 换专题）时先清空：否则从 B 切回 A 的
        // 那一帧会闪现上一个视图的内容。热刷新（MediaStore 变更）key 不变，不能清——清了就是闪白。
        if (key != loadedImagesKey) images.value = emptyList()
        loadedImagesKey = key
        val imgs = try {
            withContext(Dispatchers.IO) {
                when {
                    topicId != null -> {
                        val memberIds = getTopicFiles(topicId)
                        if (memberIds.isEmpty()) emptyList() else listImagesByIds(memberIds)
                    }
                    byTag -> listImagesByTags(tab.activeTags)
                    else -> listImages(tab.folderId!!)
                }
            }
        } catch (e: Exception) {
            // 取数失败留空网格而不是旧内容：旧的可能是**另一个视图**的，比空着更误导
            Log.w(TAG, "[Load] images failed topic=$topicId byTag=$byTag folderId=${tab.folderId}", e)
            return
        }
        // 取数期间用户可能已经导航走或改了筛选，过期结果直接丢弃
        val now = appState.activeTab
        val nowTopic = if (now.viewMode == ViewMode.TOPICS_OVERVIEW) now.activeTopicId else null
        val nowKey = buildString {
            append("f=").append(now.folderId ?: "-")
            append("|g=").append(now.activeTags.joinToString(","))
            append("|t=").append(nowTopic ?: "-")
        }
        if (nowKey == key) {
            images.value = imgs
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
    private fun orderFoldersForOverview(list: List<Folder>): List<Folder> =
        if (list.any { it.name == ROOT_FOLDER_DISPLAY_NAME })
            list.sortedBy { it.name != ROOT_FOLDER_DISPLAY_NAME }
        else list

    fun openFolder(folder: Folder) {
        // 导航走 TabState.history（推历史栈 + 切 BROWSER + 清选中），见 AppState.openFolder。
        // 取数不在这里：M4a 4.1 起统一由组合根的 LaunchedEffect(viewMode, folderId,
        // activeTags) 触发 [reloadImages]，导航与筛选共用一个触发点。
        appState.openFolder(folder.id)
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
        private const val TAG = "AuroraKotlin"

        /** MediaStore 变更通知的防抖窗口：拷入一批文件时通知连发，等平静后再合并成一次重扫。 */
        private const val MEDIA_CHANGE_DEBOUNCE_MS = 1_000L

        /** 阶段 5：远端库 browse 并发上限（远端目录可能上百，压并发护服务端与手机网络）。 */
        private const val LAN_BROWSE_CONCURRENCY = 4

        /** 阶段 5：metadata/batch 单块 path 数（契约无分页，块大小是客户端决定；300 折中单请求体积与失败重试粒度）。 */
        private const val LAN_METADATA_BATCH_CHUNK = 300

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
