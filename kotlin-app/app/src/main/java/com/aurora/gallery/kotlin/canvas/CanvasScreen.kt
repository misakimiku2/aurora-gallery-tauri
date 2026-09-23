package com.aurora.gallery.kotlin.canvas

import androidx.activity.compose.BackHandler
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
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
import com.aurora.gallery.kotlin.ui.theme.AuroraTheme
import com.aurora.gallery.kotlin.ui.theme.withAlpha
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import uniffi.aurora_core.FfiTopic
import uniffi.aurora_core.Image
import uniffi.aurora_core.TagGroup

/**
 * 画布屏（M5 2.2/3.3/3.4/4）：画布专属顶栏（返回 / 计数徽标 N/24 / 标题「画布」/
 * 侧栏开合 / 更多菜单）+ [CanvasView] 主体 + 右下沉浸浮钮（触摸显示 3s 渐隐）+
 * 返回链（菜单 → 沉浸 → 编辑 → 选中 → 退画布，对齐 React android-back-press :2158-2192）。
 *
 * 单实例口径（D21/D28）：无画布名；计数全画布 N/24。「更多」二选一（React :1955）：
 * 有选中 = 轻整理集（2.2），无选中 = 添加图片 / 查看全部 / 重置画布 / 吸附开关。
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
            Box(Modifier.onGloballyPositioned { moreAnchor = it.boundsInWindow() }) {
                CanvasTopButton(onClick = { menuExpanded = true }, contentDescription = "更多") { Icon(IconMore, contentDescription = null, tint = colors.textSecondary, modifier = Modifier.size(22.dp)) }
                AuroraDropdown(
                    expanded = menuExpanded,
                    anchorBoundsInWindow = moreAnchor,
                    onDismissRequest = { menuExpanded = false },
                ) {
                    if (store.selectedIds.isNotEmpty()) {
                        // —— 选中集菜单（2.2；React selectedMenuOptions :1875-1889 去注释项）——
                        AuroraMenuItem("查看此图", onClick = {
                            menuExpanded = false
                            store.activeItemId?.let { id -> store.itemById[id]?.let(controller::zoomToItem) }
                        })
                        AuroraMenuItem("重置变换", onClick = {
                            menuExpanded = false
                            store.resetItemTransforms(store.selectedIds)
                        })
                        AuroraMenuDivider()
                        AuroraMenuItem("放置到最顶层", onClick = { menuExpanded = false; store.reorderActive(ZOrderOp.TOP) })
                        AuroraMenuItem("放置到上方", onClick = { menuExpanded = false; store.reorderActive(ZOrderOp.UP) })
                        AuroraMenuItem("放置到下方", onClick = { menuExpanded = false; store.reorderActive(ZOrderOp.DOWN) })
                        AuroraMenuItem("放置到最底层", onClick = { menuExpanded = false; store.reorderActive(ZOrderOp.BOTTOM) })
                        AuroraMenuDivider()
                        AuroraMenuItem(
                            "从对比中移除",
                            textColor = Color(0xFFEF4444),
                            onClick = {
                                menuExpanded = false
                                store.removeImages(store.selectedIds)
                            },
                        )
                    } else {
                        // —— 画布菜单（3.4）——
                        AuroraMenuItem("添加图片", onClick = {
                            menuExpanded = false
                            if (store.isFull) {
                                android.widget.Toast.makeText(context, "画布已满（24/24）", android.widget.Toast.LENGTH_SHORT).show()
                            } else {
                                showAddDialog = true
                            }
                        })
                        AuroraMenuItem("查看全部", onClick = {
                            menuExpanded = false
                            controller.fitAll()
                        })
                        AuroraMenuItem("重置画布", onClick = {
                            menuExpanded = false
                            store.resetAll()
                        })
                        AuroraMenuItem(
                            "吸附功能: ${if (store.isSnappingEnabled) "ON" else "OFF"}",
                            checked = store.isSnappingEnabled,
                            onClick = {
                                store.isSnappingEnabled = !store.isSnappingEnabled
                                menuExpanded = false
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
                    .background(Color(0x80000000))
                    .border(1.dp, Color(0x33FFFFFF), RoundedCornerShape(28.dp))
                    .then(if (immersiveBtnVisible) Modifier.clickable {
                        immersiveBtnVisible = true
                        if (immersive) exitImmersive() else enterImmersive()
                    } else Modifier),
                contentAlignment = Alignment.Center,
            ) {
                Icon(IconImmersive, contentDescription = null, tint = Color.White, modifier = Modifier.size(24.dp))
            }
        }
    }

    // —— 添加图片弹窗（3.3）——
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
    canvasIcon("CanvasSidebar") {
        // panel-left：外框 + 左栏分隔线
        moveTo(3f, 5f)
        lineTo(21f, 5f)
        lineTo(21f, 19f)
        lineTo(3f, 19f)
        close()
        moveTo(9f, 5f)
        lineTo(9f, 19f)
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

/** 沉浸/退出双态图标（maximize2 / minimize2 合一：双向斜箭头）。 */
private val IconImmersive: ImageVector by lazy {
    canvasIcon("CanvasImmersive") {
        moveTo(15f, 3f)
        lineTo(21f, 3f)
        lineTo(21f, 9f)
        moveTo(9f, 21f)
        lineTo(3f, 21f)
        lineTo(3f, 15f)
        moveTo(21f, 3f)
        lineTo(14f, 10f)
        moveTo(3f, 21f)
        lineTo(10f, 14f)
    }
}

/**
 * 添加图片弹窗（M5 3.3，React AddImageModal 的触屏收敛）：全部/相册/专题/标签四类
 * 数据源，网格多选，已在画布中的项置勾且不可取消（去重），选择数受剩余容量钳制，
 * 确认后走 [CanvasStore.addImages]（追加 + z 序尾 + autoFit）。
 */
@Composable
private fun AddImagesToCanvasDialog(
    store: CanvasStore,
    thumbnailLoader: ThumbnailLoader,
    folders: List<uniffi.aurora_core.Folder>,
    topics: List<FfiTopic>,
    tagGroups: List<TagGroup>,
    onLoad: (scope: String, key: String, onReady: (List<Image>) -> Unit) -> Unit,
    onDismiss: () -> Unit,
    onConfirm: (List<CanvasPackSource>) -> Unit,
) {
    val colors = AuroraTheme.colors
    val context = LocalContext.current
    var scope by remember { mutableStateOf("all") }
    var scopeKey by remember { mutableStateOf("") }
    var images by remember { mutableStateOf<List<Image>?>(null) }
    var checked by remember { mutableStateOf<Set<String>>(emptySet()) }
    val capacity = CANVAS_CAPACITY - store.count
    val inCanvas = remember { store.itemById.keys.toSet() }

    fun load(s: String, k: String) {
        images = null
        onLoad(s, k) { list -> images = list }
    }
    LaunchedEffect(scope, scopeKey) { load(scope, scopeKey) }

    androidx.compose.ui.window.Dialog(onDismissRequest = onDismiss) {
        Column(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 24.dp)
                .clip(RoundedCornerShape(12.dp))
                .background(colors.panel)
                .padding(16.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("添加图片", fontSize = 17.sp, fontWeight = FontWeight.SemiBold, color = colors.textPrimary)
                Spacer(Modifier.weight(1f))
                Text(
                    "还可加 ${capacity.coerceAtLeast(0)} 张",
                    fontSize = 13.sp,
                    color = if (capacity <= 0) colors.primaryDeep else colors.textSecondary,
                )
            }
            Spacer(Modifier.height(10.dp))
            // 数据源 tab（chips）
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                val tabs = mutableListOf(Triple("all", "全部", ""))
                folders.forEach { tabs.add(Triple("folder", it.name, it.id)) }
                topics.forEach { tabs.add(Triple("topic", it.name, it.id)) }
                tagGroups.forEach { g -> g.tags.forEach { t -> tabs.add(Triple("tag", t.tag, t.tag)) } }
                androidx.compose.foundation.lazy.LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    items(tabs.size) { i ->
                        val (s, label, k) = tabs[i]
                        val active = s == scope && k == scopeKey
                        Text(
                            label,
                            fontSize = 13.sp,
                            color = if (active) Color.White else colors.textPrimary,
                            modifier = Modifier
                                .clip(RoundedCornerShape(14.dp))
                                .background(if (active) colors.primary else colors.surface)
                                .clickable {
                                    scope = s
                                    scopeKey = k
                                    checked = emptySet()
                                }
                                .padding(horizontal = 12.dp, vertical = 6.dp),
                        )
                    }
                }
            }
            Spacer(Modifier.height(10.dp))
            val list = images
            Box(Modifier.fillMaxWidth().height(380.dp)) {
                when {
                    list == null -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        Text("加载中…", color = colors.textSecondary)
                    }
                    list.isEmpty() -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        Text("暂无图片", color = colors.textSecondary)
                    }
                    else -> LazyVerticalGrid(
                        columns = GridCells.Adaptive(96.dp),
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        modifier = Modifier.fillMaxSize(),
                    ) {
                        items(list, key = { it.id }) { img ->
                            val already = img.id in inCanvas
                            val isChecked = img.id in checked || already
                            PickerCell(
                                image = img,
                                checked = isChecked,
                                alreadyInCanvas = already,
                                enabled = already || isChecked || checked.size < capacity,
                                thumbnailLoader = thumbnailLoader,
                                onToggle = {
                                    when {
                                        already -> android.widget.Toast.makeText(
                                            context, "这张已在画布中", android.widget.Toast.LENGTH_SHORT,
                                        ).show()
                                        img.id in checked -> checked = checked - img.id
                                        checked.size < capacity -> checked = checked + img.id
                                        else -> android.widget.Toast.makeText(
                                            context, "最多还可加 $capacity 张", android.widget.Toast.LENGTH_SHORT,
                                        ).show()
                                    }
                                },
                            )
                        }
                    }
                }
            }
            Spacer(Modifier.height(12.dp))
            Row {
                Spacer(Modifier.weight(1f))
                Text(
                    "取消", fontSize = 15.sp, color = colors.textPrimary,
                    modifier = Modifier
                        .clip(RoundedCornerShape(8.dp))
                        .clickable(onClick = onDismiss)
                        .padding(horizontal = 20.dp, vertical = 10.dp),
                )
                Spacer(Modifier.width(8.dp))
                Text(
                    if (checked.isEmpty()) "加入" else "加入 ${checked.size} 张",
                    fontSize = 15.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = if (checked.isEmpty()) colors.textSecondary else Color.White,
                    modifier = Modifier
                        .clip(RoundedCornerShape(8.dp))
                        .background(if (checked.isEmpty()) colors.surface else colors.primaryDeep)
                        .clickable(enabled = checked.isNotEmpty()) {
                            val sources = list
                                ?.filter { it.id in checked }
                                ?.map { img ->
                                    CanvasPackSource(
                                        id = img.id,
                                        width = img.width?.toFloat() ?: 1000f,
                                        height = img.height?.toFloat() ?: 750f,
                                        contentUri = img.contentUri,
                                    )
                                }
                                .orEmpty()
                            onConfirm(sources)
                        }
                        .padding(horizontal = 20.dp, vertical = 10.dp),
                )
            }
        }
    }
}


/** 弹窗网格单元：缩略图 + 右上勾角标；已在画布中的项恒勾选并压暗。 */
@Composable
private fun PickerCell(
    image: Image,
    checked: Boolean,
    alreadyInCanvas: Boolean,
    enabled: Boolean,
    thumbnailLoader: ThumbnailLoader,
    onToggle: () -> Unit,
) {
    val colors = AuroraTheme.colors
    val imageId = remember(image.contentUri) {
        thumbnailLoader.extractImageId(image.contentUri)
    }
    val bmp by produceState<android.graphics.Bitmap?>(initialValue = null, imageId) {
        value = withContext(Dispatchers.IO) { thumbnailLoader.loadFastLimited(imageId) }
    }
    Box(
        Modifier
            .aspectRatio(1f)
            .clip(RoundedCornerShape(8.dp))
            .background(Color(colors.palette.placeholderBg))
            .clickable(enabled = enabled, onClick = onToggle),
    ) {
        bmp?.let {
            Image(
                bitmap = it.asImageBitmap(),
                contentDescription = image.name,
                modifier = Modifier.fillMaxSize(),
            )
        } ?: androidx.compose.material3.CircularProgressIndicator(
            modifier = Modifier.align(Alignment.Center).size(20.dp),
            strokeWidth = 2.dp,
            color = colors.primary,
        )
        if (checked) {
            Text(
                "✓",
                color = Color.White,
                fontSize = 13.sp,
                fontWeight = FontWeight.Bold,
                modifier = Modifier
                    .align(Alignment.TopEnd)
                    .padding(4.dp)
                    .size(22.dp)
                    .clip(RoundedCornerShape(11.dp))
                    .background(if (alreadyInCanvas) Color(0xFF9CA3AF) else colors.primary),
                textAlign = androidx.compose.ui.text.style.TextAlign.Center,
            )
        }
    }
}
