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
 *
 * **interop 两坑（本里程碑实测）**：① interop 容器不裁子 View 绘制、且画在 Compose
 * chrome 之上——CanvasView 的整屏 drawColor 会把侧栏/顶栏盖成白板，必须 `clipToBounds`
 * + `zIndex(-1)`；② 画布私有状态（viewport 等）不要用 Compose state（曾在布局 pass 中
 * 写入干扰合成），见 CanvasState 注释。
 */
@Composable
fun CanvasHost(
    store: CanvasStore,
    dark: Boolean,
    controller: CanvasController,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    val view = remember { CanvasView(context) }
    AndroidView(
        factory = {
            controller.view = view
            view
        },
        update = { it.attachStore(store) },
        // clipToBounds + zIndex(-1)：见上，缺一会把同窗口的 Compose chrome 盖成白板
        modifier = modifier
            .zIndex(-1f)
            .clipToBounds(),
    )
    LaunchedEffect(store.items, store.selectedIds, store.isEditMode, store.zOrderIds, dark) {
        view.applyTheme(dark)
        view.sync()
    }
}
