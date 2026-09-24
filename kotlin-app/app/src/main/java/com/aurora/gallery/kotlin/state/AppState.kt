package com.aurora.gallery.kotlin.state

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.aurora.gallery.kotlin.ui.components.GroupBy
import com.aurora.gallery.kotlin.ui.components.LayoutMode
import java.util.concurrent.atomic.AtomicInteger

/**
 * 视图模式（Kotlin 化 React `TabState['viewMode']`，`src/types.ts:498`）。
 *
 * React 版有六个取值（browser / folders-overview / tags-overview / people-overview /
 * topics-overview / lan-folders-overview）。M4a 3.2 起补齐三个、网络总览随 M6a 阶段 4 落地：
 *  - [FOLDERS_OVERVIEW]：文件夹总览（React 版 `folders-overview`；React 的根节点伪 id
 *    `__android_folders_root__` 在 Kotlin 端用 `folderId == null` 表示）；
 *  - [BROWSER]：文件夹内部网格（React 版 `browser`）；
 *  - [TAGS_OVERVIEW] / [PEOPLE_OVERVIEW] / [TOPICS_OVERVIEW]：侧栏对应 Section 头部
 *    进入的总览（React `handleNavigateAllTags` / `handleNavigateAllPeople` /
 *    `handleNavigateTopics`）。
 *
 * 专题详情**不设独立 ViewMode**（对齐 React：topics-overview + activeTopicId 非空即
 * 详情），见 [TabState.activeTopicId]。
 *
 * [CANVAS]（M4b 阶段 4 引入）：侧栏「画布」入口对应的视图模式。React 的「画布」=
 * 新建 isCompareMode 标签页进 ImageComparer 全屏，没有独立 ViewMode；Kotlin 侧独立
 * 成模式，视图本体已随 M5 落地（CanvasScreen/CanvasView）。
 *
 * [LAN_FOLDERS_OVERVIEW]（M6a 阶段 4 引入）：LAN 文件夹总览（React 版
 * `lan-folders-overview`，App.tsx:2482 同款判定）。远端目录的**内部网格不设独立
 * ViewMode**——复用 [BROWSER]，folderId 带 [LAN_FOLDER_ID_PREFIX] 前缀即远端目录
 * （对齐任务清单阶段 4「BROWSER 的 folderId 带 lan 前缀时走 LanClient.browse」，
 * 序列源分流在 GalleryViewModel.reloadImages）。
 */
enum class ViewMode {
    FOLDERS_OVERVIEW, BROWSER, TAGS_OVERVIEW, PEOPLE_OVERVIEW, TOPICS_OVERVIEW, CANVAS,
    LAN_FOLDERS_OVERVIEW,
}

/**
 * LAN 远端目录的 folderId 前缀（M6a 阶段 4）。远端 path 是不透明字符串（契约 §0 铁律，
 * 不解析不拼接），这个前缀是**我们自己**加在 folderId 命名空间上的命名标记：判定远端
 * 序列源时剥掉它，剩下的原样回传服务端。前缀本身永远不进网络请求。
 */
const val LAN_FOLDER_ID_PREFIX = "lan:"

/**
 * 根级散图虚拟目录 id（对齐 React `LAN_ROOT_IMAGES_ID` = `__lan_root_images__`）。
 * 有根级散图才在 LAN 总览置顶显示（FoldersOverview.tsx:649-650 同款），其内容来自
 * all_image_folders 的 root_images，不单独 browse（useLanClientSync 同款语义）。
 */
const val LAN_ROOT_IMAGES_ID = "__lan_root_images__"

/**
 * 远端标签筛选虚拟目录的命名空间标记（M6a 阶段 5；folderId 形如
 * `lan:__lan_tag__:<tag>`，见 [lanTagFolderId]）。**不是**可 browse 的远端目录——
 * 序列取数（GalleryViewModel.reloadLanImages）命中它时从远端库会话缓存按 tag 过滤，
 * 不发任何网络请求。tag 名不透明：含冒号也原样保留（解出后不截断、不加工）。
 */
const val LAN_TAG_VIRTUAL_ROOT = "__lan_tag__:"

/** 远端 path → folderId（加 [LAN_FOLDER_ID_PREFIX] 前缀）。 */
fun lanFolderId(remotePath: String): String = LAN_FOLDER_ID_PREFIX + remotePath

/** folderId → 远端 path（带前缀才剥，返回 null 表示不是 LAN 目录）。 */
fun String.lanRemotePathOrNull(): String? =
    takeIf { startsWith(LAN_FOLDER_ID_PREFIX) }?.removePrefix(LAN_FOLDER_ID_PREFIX)

/** 远端 tag → folderId（[LAN_FOLDER_ID_PREFIX] + [LAN_TAG_VIRTUAL_ROOT] 双前缀标记）。 */
fun lanTagFolderId(tag: String): String = lanFolderId(LAN_TAG_VIRTUAL_ROOT + tag)

/**
 * folderId → 远端 tag（在 [lanRemotePathOrNull] 基础上再判 [LAN_TAG_VIRTUAL_ROOT] 前缀；
 * 返回 null 表示不是 tag 虚拟目录）。tag 名不透明：removePrefix 只剥头一段标记，
 * tag 自身含冒号也原样保留。
 */
fun String.lanTagFilterOrNull(): String? =
    lanRemotePathOrNull()
        ?.takeIf { it.startsWith(LAN_TAG_VIRTUAL_ROOT) }
        ?.removePrefix(LAN_TAG_VIRTUAL_ROOT)

/** 搜索范围（对齐 React `SearchScope`，`src/types.ts:455`）。 */
enum class SearchScope { ALL, FILE, TAG, FOLDER }

/** 排序字段与方向（对齐 React `SortOption` / `SortDirection`，`src/types.ts:456-457`）。 */
enum class SortOption { NAME, DATE, SIZE }

enum class SortDirection { ASC, DESC }

/**
 * 日期筛选（对齐 React `DateFilter`，`src/types.ts:440-444`）。
 *
 * React 版 start/end 是日期字符串；Kotlin 端直接用 epoch 秒，与 `Image.createdAt` /
 * `Image.modifiedAt`（`list_images` 返回）同单位，避免一层字符串转换。
 */
enum class DateFilterMode { CREATED, UPDATED }

data class DateFilter(
    val start: Long? = null,
    val end: Long? = null,
    val mode: DateFilterMode = DateFilterMode.CREATED,
) {
    val isActive: Boolean get() = start != null || end != null
}

/**
 * 历史条目（Kotlin 化 React `HistoryItem`，`src/types.ts:478-492`）。
 *
 * M1 只记录 folderId / viewMode / 搜索三项；M4a 3.1 起带上 activeTags（标签筛选要能被
 * 系统返回退掉）。React 版的 activePersonId / activeTopicId 随人物与专题筛选再补。
 * scrollTop 是该位置的滚动恢复点，M1 只记录不消费（TopBar 导航按钮 / 返回手势链 4.3
 * 接入后用于恢复滚动位置）。
 */
data class HistoryItem(
    val folderId: String?,
    val viewMode: ViewMode,
    val searchQuery: String = "",
    val searchScope: SearchScope = SearchScope.ALL,
    /** 该位置生效的标签筛选（M4a 3.1）。不存进历史的话「点标签→返回」会退回带筛选的状态。 */
    val activeTags: List<String> = emptyList(),
    /** 该位置打开的专题（M4a 3.2）。非空且 viewMode=TOPICS_OVERVIEW 即专题详情。 */
    val activeTopicId: String? = null,
    val scrollTop: Int = 0,
)

/**
 * 页内历史栈（Kotlin 化 React `TabState.history: { stack, currentIndex }`）。
 *
 * 栈内保存**走过的每个位置**（含当前位置），currentIndex 指向当前位置；push 时截断
 * currentIndex 之后的 forward 分支。语义对齐 `src/hooks/useNavigation.ts` 的
 * pushHistory / goBack / goForward。
 */
data class HistoryStack(
    val stack: List<HistoryItem> = emptyList(),
    val currentIndex: Int = -1,
) {
    val canBack: Boolean get() = currentIndex > 0
    val canForward: Boolean get() = currentIndex < stack.lastIndex
    val current: HistoryItem? get() = stack.getOrNull(currentIndex)

    /** 截断 forward 条目后追加新位置，并前进到它。 */
    fun push(entry: HistoryItem): HistoryStack {
        val trimmed = stack.take(currentIndex + 1)
        return HistoryStack(trimmed + entry, trimmed.size)
    }
}

/**
 * 单个标签页状态（Kotlin 化 React `TabState`，`src/types.ts:494-521`）。
 *
 * 只保留 M1 与近期里程碑会消费的字段，省略项及理由：
 *  - activePersonId / selectedTopicIds / selectedPersonIds / selectedTagIds /
 *    aiFilter：人物与专题的筛选与多选集（人物数据源在 M6；专题多选随 4.3 长按菜单再补）；
 *  - isCompareMode / sessionName / currentPage：桌面画布与分页特性；
 *  - scrollToItemId：React 版跨页定位用，Kotlin 端 RV 锚点另有机制。
 *
 * layoutMode 沿 React 语义放在标签页上（单标签下即全局生效）；groupBy /
 * sortBy / sortDirection 在 React 版就是应用级状态（`App.tsx:267` 的 useState 与
 * `AppState` 顶层字段），同样放在 [AppState]。
 */
data class TabState(
    val id: String,
    /** 当前所在文件夹；null = 根（文件夹总览）。 */
    val folderId: String? = null,
    /** 全屏查看的图片；M3 查看器并入后消费（返回链「退全屏」判断依据）。 */
    val viewingFileId: String? = null,
    val viewMode: ViewMode = ViewMode.FOLDERS_OVERVIEW,
    val layoutMode: LayoutMode = LayoutMode.GRID,
    val searchQuery: String = "",
    val searchScope: SearchScope = SearchScope.ALL,
    /**
     * 侧栏标签筛选（M4a 3.1）。对齐 React `handleTagClick` 的**单选替换**语义
     * （`activeTags: [tag]`），生效范围是当前文件夹的展示序列。
     */
    val activeTags: List<String> = emptyList(),
    /**
     * 当前打开的专题（M4a 3.2）。非空且 viewMode=[ViewMode.TOPICS_OVERVIEW] 即专题
     * 详情；列表态恒为 null。对齐 React `TabState.activeTopicId`。
     */
    val activeTopicId: String? = null,
    val dateFilter: DateFilter = DateFilter(),
    /** 本标签页的选中集合（React 版选中即按标签页隔离）。 */
    val selectedFileIds: Set<String> = emptySet(),
    /** 范围选择的锚点（4.1 用 `lastSelectedId` 做区间合并，对齐 React useFileSelection）。 */
    val lastSelectedId: String? = null,
    val history: HistoryStack = HistoryStack(
        stack = listOf(HistoryItem(folderId = null, viewMode = ViewMode.FOLDERS_OVERVIEW)),
        currentIndex = 0,
    ),
) {
    companion object {
        private val idCounter = AtomicInteger(0)

        /**
         * 新建根标签页：文件夹总览 + 仅含根位置的历史栈
         *（对齐 `useNavigation.ts` handleNewTab 的安卓分支：folders-overview 根）。
         */
        fun newRootTab(): TabState = TabState(id = "tab-${idCounter.incrementAndGet()}")
    }
}

/**
 * 面板可见状态（Kotlin 化 React `AppState.layout`，`src/types.ts:564-568`）。
 *
 * 初始值对齐 `src/utils/layoutSettings.ts` 的安卓分支：横屏开侧栏、元数据面板收起。
 * React 版的 isColorPickerVisible 属桌面取色器面板，安卓端不实现，故省略。
 * 3.5 面板开合在此之上做互斥（对齐 `App.tsx:1793-1812`：开一个关其余）。
 */
data class LayoutVisibility(
    val isSidebarVisible: Boolean,
    val isMetadataVisible: Boolean = false,
)

/**
 * 应用级状态容器（Kotlin 化 React `AppState` 的 UI 状态部分 + `App.tsx` 的散装 useState）。
 *
 * 持有：单标签页（**D5：移动版不做多标签**，TabState 是导航/选中/搜索等会话字段的
 * 挂载点）、面板可见性、排序/分组、网格捏合档位。档位从
 * FileGrid / FoldersOverview 各自的 remember 提升到这里（L2），进文件夹 / 返回总览
 * 不再重置为中档。
 *
 * 实例由 GalleryViewModel 持有（数据 folders / images / scanning 同在那里）：旋转等
 * 配置变更不再丢导航/选中/档位，重扫由 scanStarted 守卫挡住。全部写入都发生在
 * 主线程（Compose 回调 / viewModelScope 主协程），用 Compose state 而非 StateFlow：
 * UI 直接读取，重组粒度交给 Compose 快照系统。进程死亡仍会重置，持久化待后续里程碑评估。
 */
class AppState(
    initialLayout: LayoutVisibility = LayoutVisibility(isSidebarVisible = true),
) {
    private val initialTab = TabState.newRootTab()

    var tabs by mutableStateOf(listOf(initialTab))
        private set

    var activeTabId by mutableStateOf(initialTab.id)
        private set

    /** 活动标签；activeTabId 由各操作维护恒有效，兜底取第一个（tabs 恒非空）。 */
    val activeTab: TabState
        get() = tabs.firstOrNull { it.id == activeTabId } ?: tabs.first()

    /** 应用级布局设置（React 版即 AppState 顶层 sortBy/sortDirection 与 App.tsx 的 groupBy）。 */
    var groupBy by mutableStateOf(GroupBy.NONE)

    var sortBy by mutableStateOf(SortOption.NAME)

    var sortDirection by mutableStateOf(SortDirection.ASC)

    /** 三档捏合档位：0=小、1=中、2=大（默认中档）。应用级共享：总览与文件夹网格同一个档位。 */
    var gridLevel by mutableIntStateOf(1)

    /**
     * 主界面（FoldersOverview）滚动位置记忆。
     *
     * FoldersOverview 因导航离开组合再回来时 RecyclerView 是全新的（内容会回到顶部），
     * 靠它归位。**刻意不用 Compose state**：滚动期间每帧写入，没有任何 UI 需要因此
     * 重组；只在重建时读取一次。单标签页（D5），无需按标签页区分。
     */
    var overviewScrollTop: Int = 0

    /**
     * 标签总览（3.2）滚动位置记忆，机制同 [overviewScrollTop]：TagsOverview 因导航离开
     * 组合再回来时是全新组合，靠它归位。存的是**首个可见条目下标**而不是像素偏移——
     * 总览列数随侧栏开合重排，像素偏移跨导航不稳定，条目下标才是稳定锚点（恢复用
     * `LazyGridState.scrollToItem(index)`）。三个总览各有各的记忆字段，不共用——共用的
     * 话「总览 A 滚到底 → 进总览 B」会把 A 的位置套在 B 上。
     */
    var tagsOverviewScrollAnchor: Int = 0

    /** 专题总览（3.2）滚动位置记忆，语义同 [tagsOverviewScrollAnchor]。 */
    var topicsOverviewScrollAnchor: Int = 0

    /** 面板可见性（3.5 在此之上做互斥开合）。 */
    var layout by mutableStateOf(initialLayout)
        private set

    /**
     * 应用内标签剪贴板（M4a 4.3 长按菜单的「复制标签 / 粘贴标签」）。对齐 React 的
     * `state.clipboard`（`useTags.ts:79/:84`）——那边也是内存态、不是系统剪贴板，
     * 跨进程/跨会话不保留。复制时存选中集全部标签的并集（去重、保首见序）。
     */
    var copiedTags: Set<String> by mutableStateOf(emptySet())

    /**
     * 侧栏开合（3.5，TopBar 左侧开关按钮消费）。
     * 对齐 React `App.tsx` toggleSidebar 的安卓分支：开一个面板时收起其余（互斥开合），
     * 避免两面板同时挤占内容宽度。（isMetadataVisible 的唯一消费者本来是元数据面板，
     * v15 已拍板 4.2 改期不做，字段与互斥置 false 保留——将来做颜色搜索面板时直接接上。）
     */
    fun toggleSidebar() {
        layout = layout.copy(isSidebarVisible = !layout.isSidebarVisible, isMetadataVisible = false)
    }

    // —— 单标签页（D5：移动版不做多标签）——
    // tabs/activeTabId 保留为**单元素**实现：3.x 的状态字段（导航历史/选中/搜索等）
    // 全部挂在 TabState 上，这是它们的挂载点；多标签操作 API 已随 D5 移除。

    fun updateActiveTab(transform: (TabState) -> TabState) {
        tabs = tabs.map { if (it.id == activeTabId) transform(it) else it }
    }

    // —— 页内导航（3.2 TopBar 返回/上级、4.3 返回手势链消费）——

    /**
     * 进入文件夹：推入历史栈并切到 BROWSER。
     * 对齐 `useNavigation.ts` enterFolder 的安卓分支：进文件夹重置搜索（query=''、
     * scope=ALL）并清空选中。
     */
    fun openFolder(folderId: String) {
        selectionMode = false
        updateActiveTab { tab ->
            tab.copy(
                folderId = folderId,
                viewMode = ViewMode.BROWSER,
                searchQuery = "",
                searchScope = SearchScope.ALL,
                activeTags = emptyList(),
                activeTopicId = null,
                selectedFileIds = emptySet(),
                lastSelectedId = null,
                history = tab.history.push(HistoryItem(folderId = folderId, viewMode = ViewMode.BROWSER)),
            )
        }
    }

    /**
     * 进入总览视图（M4a 3.2：侧栏人物/标签/专题 Section 头部点击，对齐 React
     * `handleNavigateAllPeople` / `handleNavigateAllTags` / `handleNavigateTopics`——
     * pushHistory 保留当前 folderId，搜索与筛选复位，选中清空）。
     *
     * 复位对齐 React 的 pushHistory 实参（`usePersonTopicHandlers.ts`）：query=''、
     * scope=ALL、activeTags=[]——总览是「从头看全部」的入口，带着上一个文件夹的
     * 搜索词进总览只会得到一个看不懂的空列表。activeTopicId 一并归 null：从专题详情
     * 点侧栏「专题」头部应回到专题**列表**，不是停在原专题里。
     */
    fun openOverview(mode: ViewMode) {
        require(
            mode == ViewMode.TAGS_OVERVIEW ||
                mode == ViewMode.PEOPLE_OVERVIEW ||
                mode == ViewMode.TOPICS_OVERVIEW,
        ) { "openOverview 只接受总览类视图，收到 $mode" }
        selectionMode = false
        updateActiveTab { tab ->
            tab.copy(
                viewMode = mode,
                searchQuery = "",
                searchScope = SearchScope.ALL,
                activeTags = emptyList(),
                activeTopicId = null,
                selectedFileIds = emptySet(),
                lastSelectedId = null,
                history = tab.history.push(
                    HistoryItem(
                        folderId = tab.folderId,
                        viewMode = mode,
                    )
                ),
            )
        }
    }

    /**
     * 打开专题详情（M4a 3.2，对齐 React `handleNavigateTopic(topicId)`：TOPICS_OVERVIEW
     * + activeTopicId，推历史）。返回经 [goBack] 退回专题列表。
     */
    fun openTopic(topicId: String) {
        selectionMode = false
        updateActiveTab { tab ->
            tab.copy(
                viewMode = ViewMode.TOPICS_OVERVIEW,
                activeTopicId = topicId,
                searchQuery = "",
                searchScope = SearchScope.ALL,
                activeTags = emptyList(),
                selectedFileIds = emptySet(),
                lastSelectedId = null,
                history = tab.history.push(
                    HistoryItem(
                        folderId = tab.folderId,
                        viewMode = ViewMode.TOPICS_OVERVIEW,
                        activeTopicId = topicId,
                    )
                ),
            )
        }
    }

    /** 历史后退；无可退返回 false（调用方转下一级返回行为，见 4.3 返回链）。 */
    fun goBack(): Boolean = stepHistory(-1)

    /**
     * 打开画布占位视图（M4b 阶段 4；对齐其他入口：清搜索/筛选/选中，推历史栈）。
     * ViewMode 不持久化，重启自然回主界面（阶段 4 验收口径，天然满足）。
     */
    fun openCanvas() {
        selectionMode = false
        updateActiveTab { tab ->
            tab.copy(
                viewMode = ViewMode.CANVAS,
                searchQuery = "",
                searchScope = SearchScope.ALL,
                activeTags = emptyList(),
                activeTopicId = null,
                selectedFileIds = emptySet(),
                lastSelectedId = null,
                history = tab.history.push(
                    HistoryItem(folderId = tab.folderId, viewMode = ViewMode.CANVAS),
                ),
            )
        }
    }

    /**
     * 打开 LAN 文件夹总览（M6a 阶段 4；照 [openCanvas] 样板：ViewMode + HistoryItem
     * 入栈）。folderId 保留当前值（对齐 openOverview 先例——总览不绑定文件夹）。
     * 远端目录内部的网格走 [openFolder]（folderId 带 lan 前缀），返回链复用既有
     * HistoryItem.viewMode（goBack 退回本视图）。
     */
    fun openLanOverview() {
        selectionMode = false
        updateActiveTab { tab ->
            tab.copy(
                viewMode = ViewMode.LAN_FOLDERS_OVERVIEW,
                searchQuery = "",
                searchScope = SearchScope.ALL,
                activeTags = emptyList(),
                activeTopicId = null,
                selectedFileIds = emptySet(),
                lastSelectedId = null,
                history = tab.history.push(
                    HistoryItem(folderId = tab.folderId, viewMode = ViewMode.LAN_FOLDERS_OVERVIEW),
                ),
            )
        }
    }

    /**
     * 当前是否在 LAN 视图（总览或远端目录网格）。断线联动（GalleryViewModel）用它判定
     * 是否需要自动退回本地视图。
     */
    val isInLanView: Boolean
        get() {
            val tab = activeTab
            return tab.viewMode == ViewMode.LAN_FOLDERS_OVERVIEW ||
                (tab.viewMode == ViewMode.BROWSER && tab.folderId?.startsWith(LAN_FOLDER_ID_PREFIX) == true)
        }

    /**
     * 断线联动：退出全部 LAN 视图回本地主界面（总览 = 栈底），**历史栈整条重置为栈底**
     * ——普通 goBack 只挪 currentIndex，LAN 位置还留在栈里，之后「前进」会回到加载不出
     * 内容的死视图；重置后无残留（阶段 4 验收口径：断线后 LAN 视图退出且无残留）。
     * 查看器若开着（可能在看 LAN 大图）一并关掉。
     */
    fun exitLanToHome() {
        selectionMode = false
        updateActiveTab { tab ->
            val root = tab.history.stack.firstOrNull()
                ?: HistoryItem(folderId = null, viewMode = ViewMode.FOLDERS_OVERVIEW)
            tab.copy(
                folderId = root.folderId,
                viewMode = ViewMode.FOLDERS_OVERVIEW,
                searchQuery = root.searchQuery,
                searchScope = root.searchScope,
                activeTags = root.activeTags,
                activeTopicId = null,
                viewingFileId = null,
                selectedFileIds = emptySet(),
                lastSelectedId = null,
                history = HistoryStack(stack = listOf(root), currentIndex = 0),
            )
        }
    }

    /**
     * 回到主界面（总览 = 历史栈底，folderId = null）。
     * 对齐 React 侧栏「本地相册」头部点击的 onNavigateHome：无论深处几层，一步回总览
     * （2026-09-20 用户要求；此前头部点击只做展开切换）。已在总览时为无操作。
     */
    fun navigateHome() {
        stepHistory(-activeTab.history.currentIndex)
    }

    /** 历史前进；无可前进返回 false。 */
    fun goForward(): Boolean = stepHistory(1)

    /**
     * 沿历史栈移动并恢复目标位置的 tab 字段。选中集合对齐 React goBack/goForward：
     * 导航即清空（M1 无跨页保持选中的交互）。
     */
    private fun stepHistory(delta: Int): Boolean {
        val tab = activeTab
        val targetIndex = tab.history.currentIndex + delta
        val step = tab.history.stack.getOrNull(targetIndex) ?: return false
        // 导航即退出编辑模式（React 无此路径——返回链在编辑模式先退选择；侧栏导航等
        // 进入时同样复位，避免「选中残留到另一个视图」）
        selectionMode = false
        updateActiveTab {
            it.copy(
                folderId = step.folderId,
                viewMode = step.viewMode,
                searchQuery = step.searchQuery,
                searchScope = step.searchScope,
                activeTags = step.activeTags,
                activeTopicId = step.activeTopicId,
                selectedFileIds = emptySet(),
                lastSelectedId = null,
                history = it.history.copy(currentIndex = targetIndex),
            )
        }
        return true
    }

    // —— 选择（4.1 编辑模式/多选/范围选择；框选按 2026-09-20 用户决定平板不做）——

    /**
     * 编辑模式（选择模式）。对齐 React 的应用级 `isAndroidSelectionMode`（App.tsx:282，
     * 单标签下应用级与标签级等价）：长按进入，选择栏 X / 返回手势退出。
     * 退出总是连带清空选中（对齐 handleExitAndroidSelectionMode）。
     */
    var selectionMode by mutableStateOf(false)
        private set

    /** 切换选中并把范围选择锚点挪到该图（对齐 React 点击即更新 lastSelectedId）。 */
    fun toggleSelected(imageId: String) {
        updateActiveTab { tab ->
            val selected =
                if (imageId in tab.selectedFileIds) tab.selectedFileIds - imageId
                else tab.selectedFileIds + imageId
            tab.copy(selectedFileIds = selected, lastSelectedId = imageId)
        }
    }

    fun clearSelection() {
        updateActiveTab { it.copy(selectedFileIds = emptySet(), lastSelectedId = null) }
    }

    /**
     * 长按进入编辑模式并选中该项（对齐 React handleEnterAndroidSelectionMode：无论
     * 总览还是文件夹内，长按的项即首个选中项 + 锚点）。
     */
    fun enterSelectionMode(id: String) {
        selectionMode = true
        updateActiveTab { it.copy(selectedFileIds = setOf(id), lastSelectedId = id) }
    }

    /** 退出编辑模式并清空选中（对齐 handleExitAndroidSelectionMode）。 */
    fun exitSelectionMode() {
        selectionMode = false
        clearSelection()
    }

    /** 编辑模式内点击：切换选中（[toggleSelected] 已同步更新锚点）。 */
    fun toggleSelectedInMode(id: String) = toggleSelected(id)

    /**
     * 全选当前展示序列（4.2 选择栏）。入参是**界面上的展示顺序**（过滤+排序后的
     * 列表），对齐 React onSelectAll 的 displayFileIds 分支；React 总览分支选的是
     * 未过滤的 roots，这里统一用展示序列（选中不可见项只会让计数与界面脱节）。
     */
    fun selectAll(displayIds: List<String>) {
        updateActiveTab { it.copy(selectedFileIds = displayIds.toSet()) }
    }

    /**
     * 取消全选但**留在编辑模式**（对齐 React handleDeselectAllAndroid：只清
     * selectedFileIds，锚点与模式都不动）。
     */
    fun deselectAll() {
        updateActiveTab { it.copy(selectedFileIds = emptySet()) }
    }

    /**
     * 范围选择（4.1）：编辑模式内长按未选中项，把 [displayIds]（当前展示顺序）中
     * 锚点与该项之间的全部条目**并入**已选集合。语义逐条对齐 React
     * `useFileSelection.handleAndroidRangeSelect`：有锚点且已有选中 → 区间合并
     * （Set 去重，不是桌面 Shift+点击的整段替换）；否则退化为普通加选。锚点挪到
     * 本次长按的项，支持连续扩展。
     */
    fun rangeSelect(id: String, displayIds: List<String>) {
        updateActiveTab { tab ->
            val anchor = tab.lastSelectedId
            if (anchor != null && tab.selectedFileIds.isNotEmpty()) {
                val a = displayIds.indexOf(anchor)
                val b = displayIds.indexOf(id)
                if (a != -1 && b != -1) {
                    val range = displayIds.subList(minOf(a, b), maxOf(a, b) + 1).toSet()
                    tab.copy(selectedFileIds = tab.selectedFileIds + range, lastSelectedId = id)
                } else {
                    tab.copy(selectedFileIds = tab.selectedFileIds + id, lastSelectedId = id)
                }
            } else {
                tab.copy(selectedFileIds = tab.selectedFileIds + id, lastSelectedId = id)
            }
        }
    }

    // —— 全屏查看器（M3）——

    /**
     * 打开全屏查看器。写 [TabState.viewingFileId] 既是返回链「关查看器」的判断依据
     * （4.3 链），也是关闭后让网格停在原来那张图的锚点（2.3）。
     */
    fun openViewer(fileId: String) {
        updateActiveTab { it.copy(viewingFileId = fileId) }
    }

    fun closeViewer() {
        updateActiveTab { it.copy(viewingFileId = null) }
    }

    /**
     * 查看器内翻页：把挂载点跟到当前这张。字段非空即「查看器开着」，所以改值不会让层
     * 退出组合；进入动作是一次性的（见 `NativeViewerLayer`），这里写它不会重开查看器。
     * 值钱的后果是转屏重建 Activity 后能回到正在看的那一张，而不是进入那一张。
     */
    fun viewerNavigated(fileId: String) {
        updateActiveTab { it.copy(viewingFileId = fileId) }
    }

    // —— 搜索与日期筛选（3.2 TopBar 消费）——

    fun setSearchQuery(query: String) {
        updateActiveTab { it.copy(searchQuery = query) }
    }

    /**
     * 切换搜索范围（M4b 阶段 3 的 scope 下拉；React `onSearchScopeChange` 同位）。
     * 只改谓词不改序列源——scope 影响的是 [com.aurora.gallery.kotlin.ui.components.filterImages]
     * 的过滤分支，序列源（文件夹/标签/专题）仍由导航与 activeTags 驱动。
     */
    fun setSearchScope(scope: SearchScope) {
        updateActiveTab { it.copy(searchScope = scope) }
    }

    /**
     * 侧栏/弹层点标签 = **单选替换** + 进 BROWSER 视图（对齐 React `enterTagView` 的
     * `usePersonTopicHandlers.ts:69`：`viewMode: 'browser'`、`searchScope: 'tag'`、
     * `activeTags: [tag]`，folderId 保持当前值）。
     *
     * 序列源随之换成「该标签下的全库图片」，见 `GalleryViewModel.reloadImages`——所以
     * 在总览点标签也有确定反应（切到一个跨文件夹的标签视图），不是只能干等着。
     *
     * 与桌面的一处差别：这里把筛选态推成一条历史，「点标签 → 系统返回」退回未筛选态；
     * 再点一次已生效的那个标签 = 取消筛选（触屏没有「点别处取消」的等价物），取消后
     * 回到该位置本来该有的视图：在文件夹里留在文件夹，本来在总览就回总览。
     */
    fun toggleTagFilter(tag: String) {
        val tab = activeTab
        val clearing = tab.activeTags == listOf(tag)
        val next = if (clearing) emptyList() else listOf(tag)
        val scope = if (clearing) SearchScope.ALL else SearchScope.TAG
        val mode = if (clearing && tab.folderId == null) ViewMode.FOLDERS_OVERVIEW else ViewMode.BROWSER
        // 筛选一改展示序列就变，选中的项可能已经不在界面上（选择栏计数会跟界面脱节）
        selectionMode = false
        updateActiveTab {
            it.copy(
                viewMode = mode,
                activeTags = next,
                searchScope = scope,
                activeTopicId = null,
                selectedFileIds = emptySet(),
                lastSelectedId = null,
                history = it.history.push(
                    HistoryItem(
                        folderId = it.folderId,
                        viewMode = mode,
                        searchQuery = it.searchQuery,
                        searchScope = scope,
                        activeTags = next,
                    )
                ),
            )
        }
    }

    fun setDateFilter(filter: DateFilter) {
        updateActiveTab { it.copy(dateFilter = filter) }
    }
}
