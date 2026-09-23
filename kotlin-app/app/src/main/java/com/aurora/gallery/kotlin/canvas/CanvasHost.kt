package com.aurora.gallery.kotlin.canvas

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.zIndex

/**
 * 画布的 Compose 宿主（D7 形态：全屏条件层 + `AndroidView` 承载，对齐 ViewerLayer）。
 *
 * 宿主只推**结构性**变化（items/选中/编辑态/z 序/主题档）进 View；视口手势期间的高频
 * 重绘由 CanvasView 就地写 store 并自行 invalidate，不走重组。
 */
@Composable
fun CanvasHost(
    store: CanvasStore,
    dark: Boolean,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    val view = remember { CanvasView(context) }
    AndroidView(
        factory = { view },
        update = { it.attachStore(store) },
        // clipToBounds：interop 容器默认不裁子 View 的绘制，CanvasView 的整屏 drawColor
        // 会盖住同窗口的 Compose chrome（侧栏/顶栏整层白）；zIndex(-1)：canvas 先画，
        // chrome 后画（双保险，两台验证机表现见清单 §7 1.2 行）
        modifier = modifier
            .zIndex(-1f)
            .clipToBounds(),
    )
    LaunchedEffect(store.items, store.selectedIds, store.isEditMode, store.zOrderIds, dark) {
        view.applyTheme(dark)
        view.sync()
    }
}
