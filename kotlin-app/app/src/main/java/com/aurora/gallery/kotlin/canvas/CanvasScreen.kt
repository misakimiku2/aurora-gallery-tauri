package com.aurora.gallery.kotlin.canvas

import androidx.activity.compose.BackHandler
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.path
import androidx.compose.material3.Icon
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.aurora.gallery.kotlin.ThumbnailLoader
import com.aurora.gallery.kotlin.ui.components.AuroraDropdown
import com.aurora.gallery.kotlin.ui.components.AuroraMenuDivider
import com.aurora.gallery.kotlin.ui.components.AuroraMenuItem
import com.aurora.gallery.kotlin.ui.components.IconMagnet
import com.aurora.gallery.kotlin.ui.components.IconMaximize
import com.aurora.gallery.kotlin.ui.components.IconMaximize2
import com.aurora.gallery.kotlin.ui.components.IconMinimize2
import com.aurora.gallery.kotlin.ui.components.IconPlus
import com.aurora.gallery.kotlin.ui.components.IconRefreshCcw
import com.aurora.gallery.kotlin.ui.components.IconScan
import com.aurora.gallery.kotlin.ui.components.IconTrash2
import com.aurora.gallery.kotlin.ui.components.auroraIcon
import com.aurora.gallery.kotlin.ui.components.roundedRect
import com.aurora.gallery.kotlin.ui.theme.AuroraTheme
import uniffi.aurora_core.FfiTopic
import uniffi.aurora_core.Image
import uniffi.aurora_core.TagGroup

/**
 * 画布屏（M5 2.2/3.3/3.4/4）：画布专属顶栏（侧栏开合 / 返回 / 计数徽标 N/24 / 标题「画布」/
 * 添加图片独立按钮 / 更多菜单带图标）+ [CanvasView] 主体 + 右下沉浸浮钮（主色底，
 * Maximize2/Minimize2 双态，触摸显示 3s 渐隐）+
 * 返回链（菜单 → 沉浸 → 编辑 → 选中 → 退画布，对齐 React android-back-press :2158-2192）。
 *
 * 单实例口径（D21/D28）：无画布名；计数全画布 N/24。「更多」二选一（React :1955）：
 * 有选中 = 轻整理集（2.2），无选中 = 吸附开关 / 查看全部 / 重置画布 / 清空画布；
 * 添加图片已从菜单提为顶栏独立按钮（2026-09-24 用户要求，React 安卓分支同款 Plus :133-141）。
 */
@Composable
fun CanvasScreen(
    store: CanvasStore,
    dark: Boolean,
    thumbnailLoader: ThumbnailLoader,
    sidebarVisible: Boolean,
    folders: List<uniffi.aurora_core.Folder>,
    topics: List<FfiTopic>,
    tagGroups: List<TagGroup>,
    onLoadPickerImages: (scope: String, key: String, onReady: (List<Image>) -> Unit) -> Unit,
    onBack: () -> Unit,
    onToggleSidebar: () -> Unit,
    onSetImmersive: (Boolean) -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = AuroraTheme.colors
    val context = LocalContext.current
    val controller = remember { CanvasController() }
    var menuExpanded by remember { mutableStateOf(false) }
    var moreAnchor by remember { mutableStateOf(androidx.compose.ui.geometry.Rect.Zero) }
    var showAddDialog by remember { mutableStateOf(false) }
    var immersive by remember { mutableStateOf(false) }
    var immersiveBtnVisible by remember { mutableStateOf(true) }
    var sidebarBeforeImmersive by remember { mutableStateOf<Boolean?>(null) }

    // 添加图片入口（顶栏独立按钮 / 空态按钮共用）：满员拦截，否则开弹窗
    fun requestAddImages() {
        if (store.isFull) {
            android.widget.Toast.makeText(context, "画布已满（24/24）", android.widget.Toast.LENGTH_SHORT).show()
        } else {
            showAddDialog = true
        }
    }

    fun enterImmersive() {
        sidebarBeforeImmersive = sidebarVisible
        if (sidebarVisible) onToggleSidebar()
        onSetImmersive(true)
        immersive = true
        immersiveBtnVisible = true
    }

    fun exitImmersive() {
        onSetImmersive(false)
        immersive = false
        val before = sidebarBeforeImmersive
        if (before == true && !sidebarVisible) onToggleSidebar()
        sidebarBeforeImmersive = null
    }

    // 退画布视图不能停在沉浸态（M5-4 验收口径）；restore 侧栏
    DisposableEffect(Unit) {
        onDispose {
            if (immersive) {
                onSetImmersive(false)
                if (sidebarBeforeImmersive == true) onToggleSidebar()
            }
        }
    }

    // 返回链：菜单 → 沉浸 → 编辑 → 选中 → 退画布（组合序在 App 返回链之后，画布优先）
    BackHandler {
        when {
            menuExpanded -> menuExpanded = false
            immersive -> exitImmersive()
            store.isEditMode -> store.exitEditMode()
            store.selectedIds.isNotEmpty() -> store.clearSelection()
            else -> onBack()
        }
    }

    Column(modifier.fillMaxSize().background(colors.content)) {
        // —— 画布顶栏（3.4）——
        Row(
            Modifier
                .fillMaxWidth()
                .height(56.dp)
                .background(colors.panel)
                .padding(horizontal = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            // 侧栏开关在**原位**（最左，对齐主界面 TopBar 的排布；2026-09-23 用户反馈）
            CanvasTopButton(
                onClick = onToggleSidebar,
                contentDescription = if (sidebarVisible) "收起侧栏" else "展开侧栏",
            ) { Icon(IconSidebar, contentDescription = null, tint = colors.textSecondary, modifier = Modifier.size(22.dp)) }
            Spacer(Modifier.width(4.dp))
            CanvasTopButton(onClick = onBack, contentDescription = "返回") { Icon(IconBack, contentDescription = null, tint = colors.textSecondary, modifier = Modifier.size(22.dp)) }
            // 名称与数量居中（2026-09-23 用户反馈）：左右各一份 weight 空白把它推到中间
            Row(
                Modifier.weight(1f),
                horizontalArrangement = Arrangement.Center,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    "${store.count}/24",
                    fontSize = 13.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = colors.textSecondary,
                    modifier = Modifier
                        .clip(RoundedCornerShape(10.dp))
                        .background(colors.surface.copy(alpha = 0.53f))
                        .padding(horizontal = 10.dp, vertical = 3.dp),
                )
                Spacer(Modifier.width(10.dp))
                Text("画布", fontSize = 16.sp, fontWeight = FontWeight.SemiBold, color = colors.textPrimary)
            }
            // 添加图片独立按钮（2026-09-24 从菜单提出；React 安卓分支 Plus 按钮 ComparerToolbar :133-141）
            CanvasTopButton(onClick = { requestAddImages() }, contentDescription = "添加图片") {
                Icon(IconPlus, contentDescription = null, tint = colors.textSecondary, modifier = Modifier.size(22.dp))
            }
            Box(Modifier.onGloballyPositioned { moreAnchor = it.boundsInWindow() }) {
                CanvasTopButton(onClick = { menuExpanded = true }, contentDescription = "更多") { Icon(IconMore, contentDescription = null, tint = colors.textSecondary, modifier = Modifier.size(22.dp)) }
                AuroraDropdown(
                    expanded = menuExpanded,
                    anchorBoundsInWindow = moreAnchor,
                    onDismissRequest = { menuExpanded = false },
                ) {
                    if (store.selectedIds.isNotEmpty()) {
                        // —— 选中集菜单（2.2；React selectedMenuOptions :1874-1889，含同款图标）——
                        AuroraMenuItem(
                            "查看此图",
                            leading = { MenuIcon(IconMaximize) },
                            onClick = {
                                menuExpanded = false
                                store.activeItemId?.let { id -> store.itemById[id]?.let(controller::zoomToItem) }
                            },
                        )
                        AuroraMenuItem(
                            "重置变换",
                            leading = { MenuIcon(IconRefreshCcw) },
                            onClick = {
                                menuExpanded = false
                                store.resetItemTransforms(store.selectedIds)
                            },
                        )
                        AuroraMenuDivider()
                        AuroraMenuItem("放置到最顶层", leading = { MenuIcon(IconMaximize, Modifier.rotate(45f)) }, onClick = { menuExpanded = false; store.reorderActive(ZOrderOp.TOP) })
                        AuroraMenuItem("放置到上方", leading = { MenuIcon(IconMaximize, Modifier.rotate(45f)) }, onClick = { menuExpanded = false; store.reorderActive(ZOrderOp.UP) })
                        AuroraMenuItem("放置到下方", leading = { MenuIcon(IconMaximize, Modifier.rotate(45f)) }, onClick = { menuExpanded = false; store.reorderActive(ZOrderOp.DOWN) })
                        AuroraMenuItem("放置到最底层", leading = { MenuIcon(IconMaximize, Modifier.rotate(45f)) }, onClick = { menuExpanded = false; store.reorderActive(ZOrderOp.BOTTOM) })
                        AuroraMenuDivider()
                        AuroraMenuItem(
                            "从对比中移除",
                            leading = { MenuIcon(IconTrash2, tint = Color(0xFFEF4444)) },
                            textColor = Color(0xFFEF4444),
                            onClick = {
                                menuExpanded = false
                                store.removeImages(store.selectedIds)
                            },
                        )
                    } else {
                        // —— 画布菜单（3.4；分组对齐 React nonSelectedMenuOptions :1944-1953）——
                        AuroraMenuItem(
                            "吸附功能: ${if (store.isSnappingEnabled) "ON" else "OFF"}",
                            leading = {
                                MenuIcon(IconMagnet, tint = if (store.isSnappingEnabled) colors.primary else colors.textSecondary)
                            },
                            onClick = {
                                store.isSnappingEnabled = !store.isSnappingEnabled
                                menuExpanded = false
                            },
                        )
                        AuroraMenuDivider()
                        AuroraMenuItem(
                            "查看全部",
                            leading = { MenuIcon(IconScan) },
                            onClick = {
                                menuExpanded = false
                                controller.fitAll()
                            },
                        )
                        AuroraMenuItem(
                            "重置画布",
                            leading = { MenuIcon(IconRefreshCcw) },
                            onClick = {
                                menuExpanded = false
                                store.resetAll()
                            },
                        )
                        AuroraMenuItem(
                            "清空画布",
                            leading = { MenuIcon(IconTrash2, tint = Color(0xFFEF4444)) },
                            textColor = Color(0xFFEF4444),
                            onClick = {
                                menuExpanded = false
                                store.clear()
                                android.widget.Toast.makeText(context, "画布已清空", android.widget.Toast.LENGTH_SHORT).show()
                            },
                        )
                    }
                }
            }
        }

        // —— 画布主体 + 沉浸浮钮（任意触摸显示，3s 渐隐；React :2534-2545）——
        Box(
            Modifier
                .fillMaxWidth()
                .weight(1f)
                .pointerInput(Unit) {
                    // 只观察不消费：CanvasView 的手势不受影响
                    awaitEachGesture {
                        awaitFirstDown(requireUnconsumed = false)
                        immersiveBtnVisible = true
                    }
                },
        ) {
            CanvasHost(
                store = store,
                dark = dark,
                controller = controller,
                modifier = Modifier.fillMaxSize(),
            )
            // 空态（M3 3.3 可见占位口径：静默空屏会被当 bug；React 空态 :2262-2270）
            if (store.count == 0) {
                Column(
                    Modifier.align(Alignment.Center),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Text("暂无图片", fontSize = 18.sp, fontWeight = FontWeight.Bold, color = colors.textSecondary)
                    Spacer(Modifier.height(8.dp))
                    Text(
                        "从网格或查看器「加入画布」，或点击下方按钮添加",
                        fontSize = 13.sp,
                        color = colors.textSecondary,
                    )
                    Spacer(Modifier.height(16.dp))
                    Text(
                        "添加图片",
                        color = Color.White,
                        fontSize = 15.sp,
                        fontWeight = FontWeight.SemiBold,
                        modifier = Modifier
                            .clip(RoundedCornerShape(10.dp))
                            .background(colors.primaryDeep)
                            .clickable { showAddDialog = true }
                            .padding(horizontal = 24.dp, vertical = 12.dp),
                    )
                }
            }
            val btnAlpha by animateFloatAsState(if (immersiveBtnVisible) 1f else 0f, label = "immersiveBtn")
            Box(
                Modifier
                    .align(Alignment.BottomEnd)
                    .padding(bottom = 32.dp, end = 24.dp)
                    .size(56.dp)
                    .graphicsLayer { alpha = btnAlpha }
                    .clip(RoundedCornerShape(28.dp))
                    // 主色底（2026-09-24 用户要求；React :2536-2548 是 bg-black/50）
                    .background(colors.primary)
                    .then(if (immersiveBtnVisible) Modifier.clickable {
                        immersiveBtnVisible = true
                        if (immersive) exitImmersive() else enterImmersive()
                    } else Modifier),
                contentAlignment = Alignment.Center,
            ) {
                // 双态图标（React :2543 Maximize2/Minimize2 同款切换，点击有可见变化）
                Icon(
                    if (immersive) IconMinimize2 else IconMaximize2,
                    contentDescription = if (immersive) "退出沉浸" else "进入沉浸",
                    tint = Color.White,
                    modifier = Modifier.size(24.dp),
                )
            }
        }
    }

    // —— 添加图片弹窗（3.3）——
    // —— 添加图片弹窗（3.3；桌面形态版实现在 CanvasAddImagesDialog.kt，2026-09-24）——
    if (showAddDialog) {
        AddImagesToCanvasDialog(
            store = store,
            thumbnailLoader = thumbnailLoader,
            folders = folders,
            topics = topics,
            tagGroups = tagGroups,
            onLoad = onLoadPickerImages,
            onDismiss = { showAddDialog = false },
            onConfirm = { sources ->
                showAddDialog = false
                when (val r = store.addImages(sources)) {
                    is AddResult.Added -> android.widget.Toast
                        .makeText(context, "已加入 ${r.added} 张（${store.count}/24）", android.widget.Toast.LENGTH_SHORT)
                        .show()
                    AddResult.AllDuplicates -> android.widget.Toast
                        .makeText(context, "所选图片都已在画布中", android.widget.Toast.LENGTH_SHORT).show()
                    AddResult.Full -> android.widget.Toast
                        .makeText(context, "画布已满（24/24）", android.widget.Toast.LENGTH_SHORT).show()
                }
            },
        )
    }
}

/** CanvasView 的命令通道（菜单「查看此图 / 查看全部」驱动视口动画）。 */
class CanvasController {
    internal var view: CanvasView? = null
    fun zoomToItem(item: CanvasItem) = view?.zoomToItem(item)
    fun fitAll() = view?.fitToContent()
}

@Composable
private fun CanvasTopButton(
    onClick: () -> Unit,
    contentDescription: String,
    content: @Composable () -> Unit,
) {
    val colors = AuroraTheme.colors
    Box(
        Modifier
            .size(48.dp)
            .clip(RoundedCornerShape(12.dp))
            .clickable(onClick = onClick, onClickLabel = contentDescription),
        contentAlignment = Alignment.Center,
    ) {
        content()
    }
}

// —— 顶栏自绘图标（lucide 线性风格，24 视口 / 2 线宽 / 圆头；本文件就近持有）——

private fun canvasIcon(name: String, block: androidx.compose.ui.graphics.vector.PathBuilder.() -> Unit): ImageVector =
    ImageVector.Builder(
        name = name,
        defaultWidth = 24.dp,
        defaultHeight = 24.dp,
        viewportWidth = 24f,
        viewportHeight = 24f,
    ).apply {
        path(
            stroke = SolidColor(Color.Black),
            strokeLineWidth = 2f,
            strokeLineCap = StrokeCap.Round,
            strokeLineJoin = StrokeJoin.Round,
        ) { block() }
    }.build()

private val IconBack: ImageVector by lazy {
    canvasIcon("CanvasBack") {
        moveTo(19f, 12f)
        lineTo(5f, 12f)
        moveTo(12f, 19f)
        lineTo(5f, 12f)
        lineTo(12f, 5f)
    }
}

private val IconSidebar: ImageVector by lazy {
    // panel-left：与主界面 TopBar 的 IconPanelLeft 同一笔画（圆角外框 + 左栏分隔线；
    // 2026-09-24 用户要求两侧样式统一——此前是直角框版本）
    auroraIcon("CanvasSidebar") {
        roundedRect(3f, 3f, 18f, 18f, 2f)
        moveTo(9f, 3f)
        lineTo(9f, 21f)
    }
}

/**
 * 「更多」三点：**实心圆 r=2**（直径 4 视口单位，与 2f 笔画视觉重量相当）。
 * 不能用「0.01 单位线段+圆头笔帽」画——22dp 下只有 ≈1.7dp 的点（SelectionBar 的
 * SelIconMore 同款教训，2026-09-23 用户再次反馈）。
 */
private val IconMore: ImageVector by lazy {
    ImageVector.Builder(
        name = "CanvasMore",
        defaultWidth = 24.dp,
        defaultHeight = 24.dp,
        viewportWidth = 24f,
        viewportHeight = 24f,
    ).apply {
        path(fill = SolidColor(Color.Black)) {
            moreDot(12f, 5f)
            moreDot(12f, 12f)
            moreDot(12f, 19f)
        }
    }.build()
}

private fun androidx.compose.ui.graphics.vector.PathBuilder.moreDot(cx: Float, cy: Float, r: Float = 2f) {
    moveTo(cx - r, cy)
    arcTo(r, r, 0f, false, true, cx + r, cy)
    arcTo(r, r, 0f, false, true, cx - r, cy)
    close()
}

/** 菜单行前导图标（React 菜单 icon size=14 同款；放置类经 rotate(45f) 对齐 `className="rotate-45"`）。 */
@Composable
private fun MenuIcon(
    icon: ImageVector,
    modifier: Modifier = Modifier,
    tint: Color = AuroraTheme.colors.textSecondary,
) {
    Icon(icon, contentDescription = null, tint = tint, modifier = modifier.size(14.dp))
}
