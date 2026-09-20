package com.aurora.gallery.kotlin.viewer

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView
import com.aurora.gallery.kotlin.state.AppState
import org.json.JSONObject
import uniffi.aurora_core.Image

/**
 * 查看器层的挂载入口：放在 Activity 组合根的顶层、主内容之后（Compose 里后声明的画在上层），
 * 于是网格切到「扫描中」重载分支时查看器不会被拆掉——React 版的 overlay 本来也在 WebView
 * 之外，这条语义是平移过来的，不是新发明的。
 *
 * 宿主形态见 [NativeViewerLayer]（D7）。
 */
@Composable
fun ViewerLayerHost(
    state: AppState,
    /** **网格的展示序列**（过滤+排序后），不是全库序列——2.2 的硬要求。 */
    displayImages: List<Image>,
    viewerProvider: () -> NativeGalleryView,
    /** 抽屉「位置」一行显示的上级文件夹名；BROWSER 视图下即当前文件夹名。 */
    parentName: String = "",
) {
    val fileId = state.activeTab.viewingFileId ?: return
    val viewer = remember { viewerProvider() }
    val items = remember(displayImages, parentName) { displayImages.map { it.toViewerItem(parentName) } }
    // 只在进入这一次求值：翻页不回写 viewingFileId（否则 startIndex 变了会重跑
    // LaunchedEffect → 重新 open，正看着的图被拉回进入那张）。2.3 的「关闭后网格停在
    // 当前张」另有通道，靠 Listener.onNavigate 记下的当前位置。
    val startIndex = displayImages.indexOfFirst { it.id == fileId }.coerceAtLeast(0)
    NativeViewerLayer(
        viewer = viewer,
        items = items,
        startIndex = startIndex,
        onRequestClose = { state.closeViewer() },
    )
}

/**
 * 查看器宿主（D7 定案 = Compose 全屏条件层 + `AndroidView` 承载）。
 *
 * 只在有图在看时进入组合；[viewer] 实例由 Activity 持有、在其生命周期内复用——Coil 的
 * 内存/磁盘缓存跟着实例走，随进出组合重建会把缓存整体丢掉（4.2 压测要盯的内存台阶正来自这里）。
 *
 * 返回键：查看器自己实现了 `dispatchKeyEvent`（幻灯片 → 抽屉 → 关闭），拿到焦点时由它逐层
 * 消化；[BackHandler] 是拿不到焦点时的兜底，避免系统返回直接 finish Activity。
 */
@Composable
fun NativeViewerLayer(
    viewer: NativeGalleryView,
    items: List<NativeGalleryView.ImageItem>,
    startIndex: Int,
    onRequestClose: () -> Unit,
) {
    AndroidView(
        factory = { viewer },
        modifier = Modifier.fillMaxSize(),
    )
    LaunchedEffect(items, startIndex) { viewer.open(items, startIndex, viewerOptions) }
    BackHandler(onBack = onRequestClose)
}

/**
 * `open()` 的 options。M1/M3 应用固定浅色（`MainActivity` 的 `AuroraTheme(darkTheme = false)`），
 * 这里显式传 isDark=false，让查看器与网格用同一档色；将来深色跟系统走时只需改这一处。
 */
private val viewerOptions = JSONObject().put("isDark", false)
