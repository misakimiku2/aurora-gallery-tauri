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
 * topics-overview / lan-folders-overview）。M1 安卓端只用到两个：
 *  - [FOLDERS_OVERVIEW]：文件夹总览（React 版 `folders-overview`；React 的根节点伪 id
 *    `__android_folders_root__` 在 Kotlin 端用 `folderId == null` 表示）；
 *  - [BROWSER]：文件夹内部网格（React 版 `browser`）。
 * 侧栏六 Section 对应的 overview 值随 M2 侧栏任务再补枚举。
 */
enum class ViewMode { FOLDERS_OVERVIEW, BROWSER }

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
 * M1 只记录 folderId / viewMode / 搜索三项；React 版的 activeTags / activePersonId /
 * activeTopicId 等随 M2 侧栏筛选再补。scrollTop 是该位置的滚动恢复点，M1 只记录不
 * 消费（TopBar 导航按钮 / 返回手势链 4.3 接入后用于恢复滚动位置）。
 */
data class HistoryItem(
    val folderId: String?,
    val viewMode: ViewMode,
    val searchQuery: String = "",
    val searchScope: SearchScope = SearchScope.ALL,
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
 *  - activeTags / activePersonId / activeTopicId / selectedTopicIds / selectedPersonIds /
 *    selectedTagIds / aiFilter：侧栏六 Section 与标签/人物筛选（M2）再补；
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

    /** 面板可见性（3.5 在此之上做互斥开合）。 */
    var layout by mutableStateOf(initialLayout)

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
        updateActiveTab { tab ->
            tab.copy(
                folderId = folderId,
                viewMode = ViewMode.BROWSER,
                searchQuery = "",
                searchScope = SearchScope.ALL,
                selectedFileIds = emptySet(),
                lastSelectedId = null,
                history = tab.history.push(HistoryItem(folderId = folderId, viewMode = ViewMode.BROWSER)),
            )
        }
    }

    /** 历史后退；无可退返回 false（调用方转下一级返回行为，见 4.3 返回链）。 */
    fun goBack(): Boolean = stepHistory(-1)

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
        updateActiveTab {
            it.copy(
                folderId = step.folderId,
                viewMode = step.viewMode,
                searchQuery = step.searchQuery,
                searchScope = step.searchScope,
                selectedFileIds = emptySet(),
                lastSelectedId = null,
                history = it.history.copy(currentIndex = targetIndex),
            )
        }
        return true
    }

    // —— 选择（M1 2.1 基础选中；范围/框选在 4.1 扩展）——

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

    // —— 搜索与日期筛选（3.2 TopBar 消费）——

    fun setSearchQuery(query: String) {
        updateActiveTab { it.copy(searchQuery = query) }
    }

    fun setDateFilter(filter: DateFilter) {
        updateActiveTab { it.copy(dateFilter = filter) }
    }
}
