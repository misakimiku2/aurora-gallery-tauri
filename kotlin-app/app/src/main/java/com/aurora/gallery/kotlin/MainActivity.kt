package com.aurora.gallery.kotlin

import android.Manifest
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.os.Build
import android.os.Bundle
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.core.content.ContextCompat
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.Text
import com.aurora.gallery.kotlin.ui.components.FileGrid
import com.aurora.gallery.kotlin.ui.components.TopBar
import com.aurora.gallery.kotlin.ui.components.filterImages
import com.aurora.gallery.kotlin.ui.components.sortImages
import com.aurora.gallery.kotlin.ui.components.FoldersOverview
import com.aurora.gallery.kotlin.ui.components.PinchGridSpanListener
import com.aurora.gallery.kotlin.ui.theme.AuroraTheme
import com.aurora.gallery.kotlin.state.AppState
import com.aurora.gallery.kotlin.state.LayoutVisibility
import com.aurora.gallery.kotlin.state.SortDirection
import com.aurora.gallery.kotlin.state.ViewMode
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
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
                    onImageClick = { viewModel.appState.toggleSelected(it.id) },
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
    onImageClick: (Image) -> Unit,
) {
    // 活动标签驱动 UI：folderId × folders 得出当前文件夹；viewMode 决定总览或文件夹网格
    val tab = state.activeTab
    val currentFolder = tab.folderId?.let { id -> folders.firstOrNull { it.id == id } }

    if (scanning) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Text("扫描中…")
        }
        return
    }

    // 工具按钮（搜索/排序/视图/日期）只在文件夹内部视图提供（3.2 对齐矩阵 M1 范围；
    // 总览的文件夹排序/视图切换在 React 里是 folderLayoutMode，Kotlin 总览暂只支持网格）
    val inBrowser = tab.viewMode == ViewMode.BROWSER && currentFolder != null

    Column(Modifier.fillMaxSize()) {
        TopBar(
            title = if (inBrowser) currentFolder?.name ?: "文件夹" else "文件夹",
            canBack = tab.history.canBack,
            onBack = { state.goBack() },
            searchQuery = tab.searchQuery,
            onSearchQueryChange = { state.setSearchQuery(it) },
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
            showBrowserTools = inBrowser,
            modifier = Modifier.fillMaxWidth(),
        )
        if (!inBrowser) {
            FoldersOverview(
                folders = folders,
                thumbnailLoader = thumbnailLoader,
                onFolderClick = onFolderClick,
                level = state.gridLevel,
                onLevelChange = { state.gridLevel = it },
                // 滚动位置恢复：离开总览（进文件夹）前记录的位置在重建时归位
                initialScrollTop = state.overviewScrollTop,
                onScrollChanged = { state.overviewScrollTop = it },
                modifier = Modifier.fillMaxWidth().weight(1f),
            )
        } else {
            // 3.2 数据管道：搜索/日期过滤 → 排序（分组在 FileGrid 内部完成）。
            // remember 键齐备：任一条件变化才重算，1~2 万条下键入也不卡。
            val displayImages = remember(images, tab.searchQuery, tab.dateFilter, state.sortBy, state.sortDirection) {
                sortImages(filterImages(images, tab.searchQuery, tab.dateFilter), state.sortBy, state.sortDirection)
            }
            if (displayImages.isEmpty()) {
                Box(Modifier.fillMaxWidth().weight(1f), contentAlignment = Alignment.Center) {
                    val hasCondition = tab.searchQuery.isNotBlank() || tab.dateFilter.start != null
                    Text(
                        if (hasCondition) "无匹配图片" else "文件夹为空",
                        color = AuroraTheme.colors.textSecondary,
                    )
                }
            } else {
                FileGrid(
                    images = displayImages,
                    selectedIds = tab.selectedFileIds,
                    thumbnailLoader = thumbnailLoader,
                    onItemClick = onImageClick,
                    layoutMode = tab.layoutMode,
                    groupBy = state.groupBy,
                    level = state.gridLevel,
                    onLevelChange = { state.gridLevel = it },
                    // weight(1f)：网格只占顶栏之下的剩余空间。fillMaxSize 会把 RecyclerView
                    // 量成全屏高、内容画进顶栏区域。
                    modifier = Modifier.fillMaxWidth().weight(1f),
                )
            }
        }
    }
}
