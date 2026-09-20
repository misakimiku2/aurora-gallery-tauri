package com.aurora.gallery.kotlin

import android.Manifest
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.MediaStore
import android.util.Log
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.result.IntentSenderRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.core.content.ContextCompat
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp
import com.aurora.gallery.kotlin.ui.components.FileGrid
import com.aurora.gallery.kotlin.ui.components.SelectionBar
import com.aurora.gallery.kotlin.ui.components.SidebarPane
import com.aurora.gallery.kotlin.ui.components.TopBar
import com.aurora.gallery.kotlin.ui.components.TreeSidebar
import com.aurora.gallery.kotlin.ui.components.filterFolders
import com.aurora.gallery.kotlin.ui.components.filterImages
import com.aurora.gallery.kotlin.ui.components.sortFolders
import com.aurora.gallery.kotlin.ui.components.sortImages
import com.aurora.gallery.kotlin.ui.components.FoldersOverview
import com.aurora.gallery.kotlin.ui.components.PinchGridSpanListener
import com.aurora.gallery.kotlin.ui.components.PullToRefreshIndicator
import com.aurora.gallery.kotlin.ui.components.PullToRefreshState
import com.aurora.gallery.kotlin.ui.theme.AuroraTheme
import com.aurora.gallery.kotlin.state.AppState
import com.aurora.gallery.kotlin.state.LayoutVisibility
import com.aurora.gallery.kotlin.state.SortDirection
import com.aurora.gallery.kotlin.state.SortOption
import com.aurora.gallery.kotlin.state.ViewMode
import uniffi.aurora_core.Folder
import uniffi.aurora_core.Image

class MainActivity : ComponentActivity() {

    /**
     * 数据与 UI 状态都住在 GalleryViewModel（跨旋转重建保留）。factory 只在 ViewModel
     * 首次创建时求值，这里的横竖屏判断即初始面板可见性，旋转后不会被重算覆盖。
     */
    private val viewModel: GalleryViewModel by viewModels {
        GalleryViewModel.factory(
            application,
            LayoutVisibility(
                isSidebarVisible =
                    resources.configuration.orientation != Configuration.ORIENTATION_PORTRAIT,
            ),
        )
    }

    private val requestPermission = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        if (granted) viewModel.startScanIfNeeded()
    }

    /**
     * 4.2 删除：MediaStore.createDeleteRequest 的系统确认弹窗结果。用户允许后 MediaStore
     * 变更经 ContentObserver 自动重扫对账（GalleryViewModel.mediaStoreObserver），这里只
     * 负责退出编辑模式（对齐 React 确认后 handleExitAndroidSelectionMode 的时点）。
     */
    private val deleteLauncher = registerForActivityResult(
        ActivityResultContracts.StartIntentSenderForResult()
    ) { result ->
        if (result.resultCode == RESULT_OK) {
            viewModel.appState.exitSelectionMode()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        setContent {
            // 必须与窗口 XML 主题（Theme.AuroraKotlin = Material.Light，固定浅色）一致：
            // 跟随系统深色会拿到深色调色板（textPrimary=#E5E5E5），把浅灰文件名画在白底上看不清。
            AuroraTheme(darkTheme = false) {
                App(
                    state = viewModel.appState,
                    folders = viewModel.folders.value,
                    images = viewModel.images.value,
                    scanning = viewModel.scanning.value,
                    thumbnailLoader = viewModel.thumbnailLoader,
                    onFolderClick = { viewModel.openFolder(it) },
                    onShareSelection = { ids ->
                        viewModel.resolveSelectionUris(ids) { uris ->
                            if (uris.isNotEmpty()) shareUris(uris)
                        }
                    },
                    onDeleteSelection = { ids ->
                        viewModel.resolveSelectionUris(ids) { uris ->
                            if (uris.isNotEmpty()) requestDelete(uris)
                        }
                    },
                    onPullRefresh = { onComplete -> viewModel.refreshManual(onComplete) },
                )
            }
        }

        requestMediaPermissionIfNeeded()

        // 模拟器/Debug 构建：注册捏合注入广播（验证 FLIP 用，走生产回调链；Release 不注册）
        if (isEmulator() || applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE != 0) {
            ContextCompat.registerReceiver(
                this,
                pinchDebugReceiver,
                IntentFilter("aurora.debug.PINCH"),
                ContextCompat.RECEIVER_EXPORTED,
            )
        }
    }

    /** 4.2 分享：系统分享面板（多图 ACTION_SEND_MULTIPLE，content:// URI + 读授权）。 */
    private fun shareUris(uris: List<Uri>) {
        val intent = Intent(Intent.ACTION_SEND_MULTIPLE).apply {
            type = "image/*"
            putParcelableArrayListExtra(Intent.EXTRA_STREAM, ArrayList(uris))
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        startActivity(Intent.createChooser(intent, "分享图片"))
    }

    /**
     * 4.2 删除：API ≥ 30 走 MediaStore.createDeleteRequest（系统弹窗逐批授权，无需
     * 写权限）；< 30 无该 API，退化为直接逐条删（本应用自建媒体可成，三方媒体被拒
     * 只记日志，见 GalleryViewModel.deleteDirect）。完成后的索引对账都由 MediaStore
     * observer 自动完成。
     */
    private fun requestDelete(uris: List<Uri>) {
        if (uris.isEmpty()) return
        if (Build.VERSION.SDK_INT >= 30) {
            try {
                val pi = MediaStore.createDeleteRequest(contentResolver, uris)
                deleteLauncher.launch(IntentSenderRequest.Builder(pi.intentSender).build())
            } catch (e: Exception) {
                Log.w("AuroraKotlin", "[Delete] createDeleteRequest failed", e)
                Toast.makeText(this, "删除请求失败", Toast.LENGTH_SHORT).show()
            }
        } else {
            viewModel.deleteDirect(uris)
        }
    }

    /**
     * MediaStore 监听跟随前台生存期：后台不收通知（省电，也不做无谓重扫）。
     * 回前台时兜底对账一次——后台期间（监听已注销）MediaStore 的增删在这里补上；
     * 无实质变化时各 adapter 的幂等守卫不会 notifyDataSetChanged，界面纹丝不动。
     */
    override fun onStart() {
        super.onStart()
        viewModel.startMediaStoreObservation()
        viewModel.refreshFromForeground()
    }

    override fun onStop() {
        super.onStop()
        viewModel.stopMediaStoreObservation()
    }

    /**
     * 模拟器验证钩子：`adb shell am broadcast -a aurora.debug.PINCH --es scale 0.75`
     * 触发一次完整的捏合手势（走生产回调链），scale<1 收拢 / >1 张开。
     * `--es mode touch` 走合成双指 MotionEvent 的真实事件分发路径（含中途抬指/抖动）。
     */
    private val pinchDebugReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            val scale = intent.getStringExtra("scale")?.toFloatOrNull() ?: 0.75f
            val steps = intent.getStringExtra("steps")?.toIntOrNull() ?: 12
            val mode = intent.getStringExtra("mode") ?: "callback"
            val seed = intent.getStringExtra("seed")?.toLongOrNull() ?: 42L
            Log.i("AuroraKotlin", "[DebugPinch] inject mode=$mode scale=$scale steps=$steps seed=$seed")
            val listener = PinchGridSpanListener.lastInstance?.get() ?: return
            if (mode == "touch") listener.debugInjectTouchPinch(scale, steps, seed)
            else listener.debugInjectPinch(scale, steps)
        }
    }

    private fun isEmulator(): Boolean =
        Build.FINGERPRINT.startsWith("generic") ||
            Build.FINGERPRINT.startsWith("unknown") ||
            Build.MODEL.contains("Emulator") ||
            Build.MODEL.contains("Android SDK built for") ||
            Build.HARDWARE.contains("goldfish") ||
            Build.HARDWARE.contains("ranchu") ||
            Build.PRODUCT.contains("sdk")

    private fun requestMediaPermissionIfNeeded() {
        val permission = if (Build.VERSION.SDK_INT >= 33) {
            Manifest.permission.READ_MEDIA_IMAGES
        } else {
            Manifest.permission.READ_EXTERNAL_STORAGE
        }
        if (checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED) {
            viewModel.startScanIfNeeded()
        } else {
            requestPermission.launch(permission)
        }
    }
}

@Composable
fun App(
    state: AppState,
    folders: List<Folder>,
    images: List<Image>,
    scanning: Boolean,
    thumbnailLoader: ThumbnailLoader,
    onFolderClick: (Folder) -> Unit,
    /** 4.2 分享：解析选中项为 URI 后由宿主拉起系统分享面板。 */
    onShareSelection: (Set<String>) -> Unit,
    /** 4.2 删除：解析选中项为 URI 后由宿主发起删除请求（含系统确认）。 */
    onDeleteSelection: (Set<String>) -> Unit,
    /** 4.4 下拉刷新：宿主触发扫描，完成时回调 [onComplete]（指示器落勾）。 */
    onPullRefresh: ((onComplete: () -> Unit) -> Unit),
) {
    // 活动标签驱动 UI：folderId × folders 得出当前文件夹；viewMode 决定总览或文件夹网格
    val tab = state.activeTab
    val currentFolder = tab.folderId?.let { id -> folders.firstOrNull { it.id == id } }
    val context = LocalContext.current
    val density = LocalDensity.current
    // 4.4 下拉刷新的触发阈值（80dp，React threshold 同值）
    val ptrThresholdPx = with(density) { 80.dp.toPx() }

    // 4.3 返回链需要读取/关闭搜索胶囊（React 里是 searchInput focused 的判断），提升到这里
    var searchOpen by remember { mutableStateOf(false) }
    // 4.2 删除确认弹窗
    var showDeleteConfirm by remember { mutableStateOf(false) }
    // 4.4 下拉刷新状态（overview 与 browser 共用一个实例：同一时刻只有一个网格在组合）
    val ptrState = remember { PullToRefreshState() }

    if (scanning) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Text("扫描中…")
        }
        return
    }

    // 工具按钮按视图提供（2026-09-17 起）：文件夹内部 = 搜索/排序/视图/日期全量；
    // 总览 = 搜索（按文件夹名过滤）+ 排序 + 日期筛选（Folder.createdAt/modifiedAt，
    // Rust list_folders 子查询提供）。排序字段/方向是应用级状态（对齐 React：总览与
    // 文件网格共用同一 sortBy/sortDirection）。总览的视图循环（React folderLayoutMode）
    // 不做——文件夹卡片是等比正方形，adaptive/masonry 视觉与 grid 等价。
    val inBrowser = tab.viewMode == ViewMode.BROWSER && currentFolder != null

    // 总览数据管道：过滤（搜索词/日期）→ 排序（「根目录图片」恒置顶在 sortFolders 内保证）。
    // remember 键齐备：任一条件变化才重算，文件夹列表量级小、开销可忽略。
    val displayFolders = remember(folders, tab.searchQuery, tab.dateFilter, state.sortBy, state.sortDirection) {
        filterFolders(
            sortFolders(folders, state.sortBy, state.sortDirection),
            tab.searchQuery,
            tab.dateFilter,
        )
    }

    // 3.2 数据管道：搜索/日期过滤 → 排序（分组在 FileGrid 内部完成）。提前到这里：
    // 4.1/4.2 的选择处理与选择栏计数在两个分支外就要用（展示序列 = 范围选择/全选的
    // 输入，选择栏 total = 当前展示数量）。
    val displayImages = remember(images, tab.searchQuery, tab.dateFilter, state.sortBy, state.sortDirection) {
        sortImages(filterImages(images, tab.searchQuery, tab.dateFilter), state.sortBy, state.sortDirection)
    }
    // 范围选择/全选的输入（当前展示顺序）。rememberUpdatedState：长按回调经 adapter 的
    // 首帧闭包转发，这里保证它读到的是最新展示序列
    val currentImageIds = rememberUpdatedState(displayImages.map { it.id })
    val currentFolderIds = rememberUpdatedState(displayFolders.map { it.id })

    // —— 4.1 编辑模式的操作语义（对齐 React useFileSelection 的安卓分支 + App.tsx 的
    //    handleFolder* 系列；框选按 2026-09-20 用户决定平板不做）——
    val onImageClick: (Image) -> Unit = { img ->
        if (state.selectionMode) state.toggleSelectedInMode(img.id)
        // 非编辑模式：点图是打开查看器（M3 接入），当前无操作
    }
    val onImageLongPress: (Image) -> Unit = { img ->
        when {
            !state.selectionMode -> state.enterSelectionMode(img.id)
            img.id !in tab.selectedFileIds -> state.rangeSelect(img.id, currentImageIds.value)
            // 已选中项长按：React 是文件上下文菜单（M2 接入），当前无操作
        }
    }
    val onFolderCardClick: (Folder) -> Unit = { folder ->
        if (state.selectionMode) state.toggleSelectedInMode(folder.id) else onFolderClick(folder)
    }
    val onFolderCardLongPress: (Folder) -> Unit = { folder ->
        when {
            !state.selectionMode -> state.enterSelectionMode(folder.id)
            folder.id !in tab.selectedFileIds -> state.rangeSelect(folder.id, currentFolderIds.value)
        }
    }

    // —— 4.3 返回手势链（D5 后：关弹层→关搜索→退选择→返回上级→总览再退=系统默认）。
    // 排序菜单/日期弹层/标签弹层是独立窗口（Dialog/BottomSheet），系统返回先被它们
    // 自己消费，不进本链；全屏查看器（M3）接入后插在选择模式之前。
    BackHandler(enabled = searchOpen || state.selectionMode || tab.history.canBack) {
        when {
            searchOpen -> {
                // 对齐 React close-android-search：清词 + 关胶囊
                state.setSearchQuery("")
                searchOpen = false
            }

            state.selectionMode -> state.exitSelectionMode()

            else -> state.goBack()
        }
    }

    // 3.5 面板开合：侧栏在左、内容（TopBar + 网格）在右，开关时侧栏宽度收缩把内容
    // 推挤过去（SidebarPane 内做 300ms ease-out 动画，对齐 React SidebarPane）。
    Row(Modifier.fillMaxSize()) {
        SidebarPane(
            visible = state.layout.isSidebarVisible,
            modifier = Modifier.fillMaxHeight(),
        ) {
            // 侧栏文件夹列表用全量 folders：TopBar 搜索词只过滤总览网格（对齐 React
            // 侧栏树不被工具栏搜索过滤）
            TreeSidebar(
                folders = folders,
                currentFolderId = tab.folderId,
                onFolderClick = onFolderClick,
                // 头部点击 = 回主界面（React onNavigateHome，2026-09-20 用户要求）
                onNavigateHome = { state.navigateHome() },
                modifier = Modifier.fillMaxHeight(),
            )
        }
        Column(Modifier.weight(1f).fillMaxHeight()) {
            // 4.2 编辑模式：选择栏替换 TopBar（对齐 React ToolbarPane 的二选一结构）
            if (state.selectionMode) {
                SelectionBar(
                    selectedCount = tab.selectedFileIds.size,
                    totalCount = if (inBrowser) displayImages.size else displayFolders.size,
                    onToggleSelectAll = {
                        val ids = if (inBrowser) currentImageIds.value else currentFolderIds.value
                        if (tab.selectedFileIds.size >= ids.size) state.deselectAll()
                        else state.selectAll(ids)
                    },
                    onExit = { state.exitSelectionMode() },
                    onDelete = { showDeleteConfirm = true },
                    onShare = { onShareSelection(tab.selectedFileIds) },
                    onMore = {
                        // React 打开文件操作上下文菜单（复制/移动/标签等）；M2 接入
                        Toast.makeText(context, "更多操作将随 M2 提供", Toast.LENGTH_SHORT).show()
                    },
                    modifier = Modifier.fillMaxWidth(),
                )
            } else {
                TopBar(
                    title = currentFolder?.name ?: "文件夹",
                    canBack = tab.history.canBack,
                    onBack = { state.goBack() },
                    // 主界面（总览）不显示返回键（2026-09-20 用户要求）；进文件夹后才有返回
                    showBack = inBrowser,
                    sidebarVisible = state.layout.isSidebarVisible,
                    onToggleSidebar = { state.toggleSidebar() },
                    searchQuery = tab.searchQuery,
                    onSearchQueryChange = { state.setSearchQuery(it) },
                    searchOpen = searchOpen,
                    onSearchOpenChange = { searchOpen = it },
                    searchPlaceholder = if (inBrowser) "搜索图片" else "搜索文件夹",
                    dateFilter = tab.dateFilter,
                    onDateFilterChange = { state.setDateFilter(it) },
                    sortBy = state.sortBy,
                    onSortChange = { state.sortBy = it },
                    sortDirection = state.sortDirection,
                    onSortDirectionToggle = {
                        state.sortDirection =
                            if (state.sortDirection == SortDirection.ASC) SortDirection.DESC else SortDirection.ASC
                    },
                    groupBy = state.groupBy,
                    onGroupByChange = { state.groupBy = it },
                    layoutMode = tab.layoutMode,
                    onLayoutModeChange = { mode -> state.updateActiveTab { it.copy(layoutMode = mode) } },
                    showSearch = true,
                    showSortMenu = true,
                    showViewMode = inBrowser,
                    showDateFilter = true,
                    showGroupBy = inBrowser,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            if (!inBrowser) {
                // clipToBounds：指示器空闲时藏在容器上方（负偏移），不裁剪会透出到工具栏
                Box(Modifier.fillMaxWidth().weight(1f).clipToBounds()) {
                    FoldersOverview(
                        folders = displayFolders,
                        thumbnailLoader = thumbnailLoader,
                        onFolderClick = onFolderCardClick,
                        onFolderLongClick = onFolderCardLongPress,
                        level = state.gridLevel,
                        onLevelChange = { state.gridLevel = it },
                        // 3.5 列数预测：侧栏开合时按目标状态最终宽度一次性收敛列数
                        sidebarVisible = state.layout.isSidebarVisible,
                        // 4.1 选中态：总览的文件夹卡片同样高亮（边框 + 勾）
                        selectedIds = tab.selectedFileIds,
                        // 滚动位置恢复：离开总览（进文件夹）前记录的位置在重建时归位
                        initialScrollTop = state.overviewScrollTop,
                        onScrollChanged = { state.overviewScrollTop = it },
                        emptyText = if (tab.searchQuery.isNotBlank() || tab.dateFilter.start != null) "无匹配文件夹"
                        else "暂无文件夹",
                        pullToRefreshState = ptrState,
                        onPullToRefresh = onPullRefresh,
                        modifier = Modifier.fillMaxSize(),
                    )
                    // 4.4 指示器覆盖在网格上层（pointer-events 由 Canvas 天然不拦截触摸）
                    PullToRefreshIndicator(
                        state = ptrState,
                        thresholdPx = ptrThresholdPx,
                        modifier = Modifier.fillMaxSize(),
                    )
                }
            } else {
                if (displayImages.isEmpty()) {
                    Box(Modifier.fillMaxWidth().weight(1f), contentAlignment = Alignment.Center) {
                        val hasCondition = tab.searchQuery.isNotBlank() || tab.dateFilter.start != null
                        Text(
                            if (hasCondition) "无匹配图片" else "文件夹为空",
                            color = AuroraTheme.colors.textSecondary,
                        )
                    }
                } else {
                    Box(Modifier.fillMaxWidth().weight(1f).clipToBounds()) {
                        FileGrid(
                            images = displayImages,
                            selectedIds = tab.selectedFileIds,
                            thumbnailLoader = thumbnailLoader,
                            onItemClick = onImageClick,
                            onItemLongClick = onImageLongPress,
                            layoutMode = tab.layoutMode,
                            groupBy = state.groupBy,
                            level = state.gridLevel,
                            onLevelChange = { state.gridLevel = it },
                            sidebarVisible = state.layout.isSidebarVisible,
                            pullToRefreshState = ptrState,
                            onPullToRefresh = onPullRefresh,
                            modifier = Modifier.fillMaxSize(),
                        )
                        PullToRefreshIndicator(
                            state = ptrState,
                            thresholdPx = ptrThresholdPx,
                            modifier = Modifier.fillMaxSize(),
                        )
                    }
                }
            }
        }
    }

    if (showDeleteConfirm) {
        val n = tab.selectedFileIds.size
        AlertDialog(
            onDismissRequest = { showDeleteConfirm = false },
            title = { Text("删除所选") },
            text = {
                Text(
                    if (inBrowser) "确定删除所选的 $n 张图片吗？删除后可尝试在系统相册的回收站中找回。"
                    else "确定删除所选 $n 个文件夹内的全部图片吗？删除后可尝试在系统相册的回收站中找回。",
                    color = AuroraTheme.colors.textPrimary,
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    showDeleteConfirm = false
                    onDeleteSelection(tab.selectedFileIds)
                }) {
                    Text("删除", color = Color(0xFFEF4444))
                }
            },
            dismissButton = {
                TextButton(onClick = { showDeleteConfirm = false }) {
                    Text("取消", color = AuroraTheme.colors.textPrimary)
                }
            },
        )
    }
}
