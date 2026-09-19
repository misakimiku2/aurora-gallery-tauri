package com.aurora.gallery.kotlin.ui.components

import androidx.compose.animation.core.EaseOut
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.path
import androidx.compose.ui.layout.layout
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.aurora.gallery.kotlin.ui.theme.AuroraTheme
import kotlin.math.roundToInt
import uniffi.aurora_core.Folder

/**
 * 左侧数据面板（3.4 侧栏 / 3.5 面板开合，对齐 React `SidebarPane.tsx` + `TreeSidebar.tsx`）。
 *
 * [SidebarPane] = 开合动画壳：对齐 React 同名组件的「外层 width 16rem↔0 + 内层固定宽
 * translateX(-100%)」推挤式动画——宽度收缩把右侧内容（含 TopBar）同步推开，内容层只
 * 平移不重排（React 用 willChange:transform 常驻合成层避免逐帧重绘，Compose 的
 * graphicsLayer 同效），300ms ease-out（§9.1：面板开合动画参数与捏合 FLIP 的 240ms
 * 是两套，勿混用）。进度到 0 时不组合内容，开合结束即释放。
 *
 * [TreeSidebar] = 六 Section 骨架（矩阵表 2：三端全部保留；内容按里程碑逐步填充）：
 * 专题 / 本地相册(文件夹) / 网络 / 人物 / 标签 / 画布，`activeSection` 单一状态**互斥
 * 展开**（对齐 React `setActiveSection(prev => prev === x ? null : x)`，初始展开文件夹）。
 * M1 数据现状与对应展示：
 *  - 本地相册：MediaStore bucket 扁平列表（真实数据），点击进文件夹（复用 openFolder
 *    历史导航），当前文件夹蓝底白字高亮（对齐 React 树节点 `bg-blue-600 text-white`），
 *    头部带名称/时间排序循环（「排序/展开收起保留」，4 态循环对齐 React handleToggleFolderSort）；
 *  - 其余 Section：M1 无数据源（人物/标签 M2、网络 M6、专题/画布 M2），展开显示
 *    空态文案（沿用 zh 文案：暂无专题/未连接/暂无人物/暂无标签）。标签 Section 接受
 *    [groupedTags]，M2 落库后传入即显示标签行，无需改结构。
 */
/** 侧栏宽度（React w-64 = 16rem；设计约定无对应 token，直接取同值）。 */
val SIDEBAR_WIDTH_DP = 256.dp

/** 面板开合动画时长（React SidebarPane `width 300ms ease-out`；与捏合 FLIP 240ms 是两套）。 */
private const val PANEL_ANIMATE_MS = 300

/**
 * [SidebarPane] = 开合动画壳：对齐 React 同名组件的「外层 width 16rem↔0 + 内层固定宽
 * translateX(-100%)」推挤式动画——宽度收缩把右侧内容（含 TopBar）同步推开，内容层只
 * 平移不重排，300ms ease-out（§9.1：面板开合动画参数与捏合 FLIP 的 240ms 是两套，
 * 勿混用）。
 *
 * **性能关键（2026-09-20 真机 15fps 卡顿的教训）**：动画进度**只在自定义 layout 的
 * 测量块里读取**（layout 阶段订阅，不进组合 → 动画期间零重组），且内容恒按**全宽**
 * 测量（约束逐帧恒定 → Compose 复用测量缓存，侧栏文字/图标零重排）。首版用
 * `Modifier.width(全宽×进度)` 逐帧改约束、内层 `width(256.dp)` 又被父约束压缩，
 * 等于每帧全量重排侧栏文本——模拟器上被宿主机性能掩盖，真机只有约 15fps。
 *
 * **内容常驻不卸载（2026-09-20 二轮真机反馈）**：曾做「收起后卸载内容」，结果展开
 * 要从零组合整棵侧栏树，首帧巨重——表现为「按下后侧栏不立即展开」，而收起因内容
 * 本就在组合里故即时，方向不对称。改为组合一次后常驻（收起态由 0 宽裁剪隐藏），
 * 开/收都只是动画目标值翻转，即点即动。
 */
@Composable
fun SidebarPane(
    visible: Boolean,
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit,
) {
    val colors = AuroraTheme.colors
    val density = LocalDensity.current
    val fullWidthPx = remember(density) { with(density) { SIDEBAR_WIDTH_DP.roundToPx() } }

    // 首次组合即目标值（animateFloatAsState 初值 = 首个 target）：横屏初始展开不播动画，
    // 与 LayoutVisibility 的「横屏开侧栏」初始值配套
    val progress = animateFloatAsState(
        targetValue = if (visible) 1f else 0f,
        animationSpec = tween(durationMillis = PANEL_ANIMATE_MS, easing = EaseOut),
        label = "sidebarProgress",
    )

    Box(
        modifier
            .fillMaxHeight()
            .clipToBounds()
            .layout { measurable, constraints ->
                val p = progress.value
                val width = (fullWidthPx * p).roundToInt()
                // 内容恒按全宽测量：测量约束逐帧不变，深度测量命中缓存跳过
                val placeable = measurable.measure(
                    constraints.copy(minWidth = fullWidthPx, maxWidth = fullWidthPx),
                )
                layout(width, constraints.maxHeight) {
                    // 与 React 同款：内容左移 (1-p)·全宽，右缘随 width 收缩裁剪
                    placeable.placeRelative(x = width - fullWidthPx, y = 0)
                }
            }
            .background(colors.panel),
    ) {
        content()
    }
}

private enum class SidebarSection { TOPIC, FOLDERS, NETWORK, PEOPLE, TAGS, CANVAS }

/** 文件夹排序（侧栏头部循环切换，4 态对齐 React handleToggleFolderSort 的循环序）。 */
private enum class FolderSort(val label: String) {
    NAME_ASC("名称"), NAME_DESC("名称"), DATE_DESC("时间"), DATE_ASC("时间");
}

@Composable
fun TreeSidebar(
    folders: List<Folder>,
    currentFolderId: String?,
    onFolderClick: (Folder) -> Unit,
    groupedTags: Map<String, List<String>> = emptyMap(),
    modifier: Modifier = Modifier,
) {
    var activeSection by remember { mutableStateOf<SidebarSection?>(SidebarSection.FOLDERS) }
    var folderSort by remember { mutableStateOf(FolderSort.NAME_ASC) }

    val sortedFolders = remember(folders, folderSort) {
        when (folderSort) {
            FolderSort.NAME_ASC -> folders.sortedBy { it.name.lowercase() }
            FolderSort.NAME_DESC -> folders.sortedByDescending { it.name.lowercase() }
            FolderSort.DATE_DESC -> folders.sortedByDescending { it.modifiedAt }
            FolderSort.DATE_ASC -> folders.sortedBy { it.modifiedAt }
        }
    }
    val tagNames = remember(groupedTags) {
        groupedTags.values.flatten().sortedWith(compareBy(String.CASE_INSENSITIVE_ORDER) { it })
    }

    Column(
        modifier
            .fillMaxHeight()
            .width(SIDEBAR_WIDTH_DP)
            .verticalScroll(rememberScrollState())
            .padding(top = 10.dp, bottom = 16.dp),
    ) {
        SectionHeader(
            title = "专题",
            icon = IconLayout,
            iconTint = SECTION_PINK,
            expanded = activeSection == SidebarSection.TOPIC,
            onClick = {
                activeSection = if (activeSection == SidebarSection.TOPIC) null else SidebarSection.TOPIC
            },
        )
        if (activeSection == SidebarSection.TOPIC) {
            EmptyHint("暂无专题")
        }

        SectionHeader(
            title = "本地相册",
            icon = IconHardDrive,
            iconTint = SECTION_BLUE,
            count = folders.size,
            expanded = activeSection == SidebarSection.FOLDERS,
            onClick = {
                activeSection = if (activeSection == SidebarSection.FOLDERS) null else SidebarSection.FOLDERS
            },
            trailing = {
                SortCycleButton(
                    sort = folderSort,
                    onClick = {
                        // 名称升 → 名称降 → 时间降 → 时间升 → 名称升（对齐 React 循环序）
                        folderSort = when (folderSort) {
                            FolderSort.NAME_ASC -> FolderSort.NAME_DESC
                            FolderSort.NAME_DESC -> FolderSort.DATE_DESC
                            FolderSort.DATE_DESC -> FolderSort.DATE_ASC
                            FolderSort.DATE_ASC -> FolderSort.NAME_ASC
                        }
                    },
                )
            },
        )
        if (activeSection == SidebarSection.FOLDERS) {
            if (sortedFolders.isEmpty()) {
                EmptyHint("暂无文件夹")
            } else {
                sortedFolders.forEach { folder ->
                    FolderRow(
                        folder = folder,
                        selected = folder.id == currentFolderId,
                        onClick = { onFolderClick(folder) },
                    )
                }
            }
        }

        SectionHeader(
            title = "网络",
            icon = IconWifiOff,
            iconTint = SECTION_GRAY,
            titleTint = SECTION_GRAY,
            expanded = activeSection == SidebarSection.NETWORK,
            onClick = {
                activeSection = if (activeSection == SidebarSection.NETWORK) null else SidebarSection.NETWORK
            },
        )
        if (activeSection == SidebarSection.NETWORK) {
            EmptyHint("未连接")
        }

        SectionHeader(
            title = "人物",
            icon = IconBrain,
            iconTint = SECTION_PURPLE,
            count = 0,
            expanded = activeSection == SidebarSection.PEOPLE,
            onClick = {
                activeSection = if (activeSection == SidebarSection.PEOPLE) null else SidebarSection.PEOPLE
            },
        )
        if (activeSection == SidebarSection.PEOPLE) {
            EmptyHint("暂无人物")
        }

        SectionHeader(
            title = "标签",
            icon = IconTagBadge,
            iconTint = SECTION_BLUE,
            count = tagNames.size,
            expanded = activeSection == SidebarSection.TAGS,
            onClick = {
                activeSection = if (activeSection == SidebarSection.TAGS) null else SidebarSection.TAGS
            },
        )
        if (activeSection == SidebarSection.TAGS) {
            if (tagNames.isEmpty()) {
                EmptyHint("暂无标签")
            } else {
                tagNames.forEach { tag ->
                    TagRow(tag)
                }
            }
        }

        SectionHeader(
            title = "画布",
            icon = IconScan,
            iconTint = SECTION_EMERALD,
            expanded = activeSection == SidebarSection.CANVAS,
            onClick = {
                activeSection = if (activeSection == SidebarSection.CANVAS) null else SidebarSection.CANVAS
            },
        )
        if (activeSection == SidebarSection.CANVAS) {
            EmptyHint("暂无内容")
        }
    }
}

/**
 * Section 头部（React 各 Section 头的通用形制：chevron + 彩色 Section 图标 + 大写粗体
 * 灰字标题 + 计数 + 尾部操作位；图标与配色逐一对应桌面端 TreeSidebar——专题 Layout 粉、
 * 本地相册 HardDrive 蓝、网络 WifiOff 灰（断连态）、人物 Brain 紫、标签 Tag 蓝、
 * 画布 Scan 绿。触控行高 48dp 达触屏最小触控目标）。
 */
@Composable
private fun SectionHeader(
    title: String,
    icon: ImageVector,
    iconTint: Color,
    expanded: Boolean,
    onClick: () -> Unit,
    count: Int? = null,
    titleTint: Color? = null,
    trailing: (@Composable () -> Unit)? = null,
) {
    val colors = AuroraTheme.colors
    Row(
        Modifier
            .fillMaxWidth()
            .height(48.dp)
            .clickable(onClick = onClick)
            .padding(horizontal = 16.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            imageVector = IconChevronDown,
            contentDescription = null,
            tint = colors.textSecondary,
            // 收起 = 朝右（-90°），展开 = 朝下（对齐 React ChevronRight/ChevronDown 切换）
            modifier = Modifier.size(14.dp).rotate(if (expanded) 0f else -90f),
        )
        Spacer(Modifier.size(10.dp))
        Icon(
            imageVector = icon,
            contentDescription = null,
            tint = iconTint,
            modifier = Modifier.size(16.dp),
        )
        Spacer(Modifier.size(10.dp))
        Text(
            title,
            fontSize = 12.sp,
            fontWeight = FontWeight.Bold,
            letterSpacing = 1.sp,
            color = titleTint ?: colors.textSecondary,
        )
        if (count != null) {
            Spacer(Modifier.size(4.dp))
            Text(
                "($count)",
                fontSize = 12.sp,
                fontWeight = FontWeight.Bold,
                color = titleTint ?: colors.textSecondary,
            )
        }
        Spacer(Modifier.weight(1f))
        if (trailing != null) {
            trailing()
        }
    }
}

/** 文件夹行（React 树节点：Folder 图标 + 名称；选中 = 蓝底白字圆角；整行 48dp 触控目标）。 */
@Composable
private fun FolderRow(folder: Folder, selected: Boolean, onClick: () -> Unit) {
    val colors = AuroraTheme.colors
    Row(
        Modifier
            .padding(horizontal = 12.dp, vertical = 1.dp)
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .background(if (selected) colors.primary else Color.Transparent)
            .clickable(onClick = onClick)
            .padding(horizontal = 8.dp, vertical = 0.dp)
            .height(46.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            imageVector = IconFolder,
            contentDescription = null,
            tint = if (selected) Color.White else colors.primary,
            modifier = Modifier.size(16.dp),
        )
        Spacer(Modifier.size(8.dp))
        Text(
            folder.name,
            fontSize = 14.sp,
            color = if (selected) Color.White else colors.textPrimary,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
    }
}

/** 标签行（M1 骨架占位：Tag 图标 + 名称；点选筛选行为随 M2 接入）。 */
@Composable
private fun TagRow(tag: String) {
    val colors = AuroraTheme.colors
    Row(
        Modifier
            .padding(horizontal = 16.dp, vertical = 1.dp)
            .fillMaxWidth()
            .height(32.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            imageVector = IconTagSmall,
            contentDescription = null,
            tint = colors.textSecondary,
            modifier = Modifier.size(12.dp),
        )
        Spacer(Modifier.size(8.dp))
        Text(tag, fontSize = 13.sp, color = colors.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/** 空态提示（React 各 Section 的 `text-xs text-gray-400 italic`）。 */
@Composable
private fun EmptyHint(text: String) {
    val colors = AuroraTheme.colors
    Text(
        text,
        Modifier.padding(start = 38.dp, top = 4.dp, bottom = 8.dp),
        fontSize = 12.sp,
        fontStyle = FontStyle.Italic,
        color = colors.textSecondary,
    )
}

/** 排序循环按钮（React FolderSection 头部的 ArrowUpDown；图标随方向翻转示意降序）。 */
@Composable
private fun SortCycleButton(sort: FolderSort, onClick: () -> Unit) {
    val colors = AuroraTheme.colors
    val descending = sort == FolderSort.NAME_DESC || sort == FolderSort.DATE_DESC
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    Box(
        Modifier
            .size(32.dp)
            .clip(RoundedCornerShape(6.dp))
            .background(if (pressed) colors.surface else Color.Transparent)
            .clickable(interactionSource = interaction, indication = null, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            imageVector = IconArrowUpDown,
            contentDescription = "排序：${sort.label}${if (descending) "降序" else "升序"}",
            tint = colors.textSecondary,
            modifier = Modifier.size(14.dp).rotate(if (descending) 180f else 0f),
        )
    }
}

// ---- 自绘图标：lucide 线性风格（与 TopBar.kt 同款绘制参数；图标就近各自文件持有）----

// Section 图标配色（对齐 React TreeSidebar 的 tailwind 色：专题 pink-500、相册/标签
// blue-500、人物 purple-500、画布 emerald-500、网络断连 gray-400）
private val SECTION_PINK = Color(0xFFEC4899)
private val SECTION_BLUE = Color(0xFF3B82F6)
private val SECTION_PURPLE = Color(0xFFA855F7)
private val SECTION_EMERALD = Color(0xFF10B981)
private val SECTION_GRAY = Color(0xFF9CA3AF)

private const val STROKE = 2f

/** 在 [PathBuilder] 上画圆角矩形（lucide 的 rect rx；与 TopBar.kt 同款）。 */
private fun androidx.compose.ui.graphics.vector.PathBuilder.roundedRect(x: Float, y: Float, w: Float, h: Float, r: Float) {
    moveTo(x + r, y)
    lineTo(x + w - r, y)
    arcTo(r, r, 0f, false, true, x + w, y + r)
    lineTo(x + w, y + h - r)
    arcTo(r, r, 0f, false, true, x + w - r, y + h)
    lineTo(x + r, y + h)
    arcTo(r, r, 0f, false, true, x, y + h - r)
    lineTo(x, y + r)
    arcTo(r, r, 0f, false, true, x + r, y)
    close()
}

private fun iconBuilder(
    name: String,
    block: androidx.compose.ui.graphics.vector.PathBuilder.() -> Unit,
): ImageVector = ImageVector.Builder(
    name = name,
    defaultWidth = 24.dp,
    defaultHeight = 24.dp,
    viewportWidth = 24f,
    viewportHeight = 24f,
).apply {
    path(
        stroke = SolidColor(Color.Black),
        strokeLineWidth = STROKE,
        strokeLineCap = StrokeCap.Round,
        strokeLineJoin = StrokeJoin.Round,
    ) { block() }
}.build()

private val IconChevronDown: ImageVector by lazy {
    iconBuilder("ChevronDown") {
        moveTo(6f, 9f)
        lineTo(12f, 15f)
        lineTo(18f, 9f)
    }
}

/** lucide Layout（专题 Section；与 TopBar 的 LayoutTemplate 同形）。 */
private val IconLayout: ImageVector by lazy {
    iconBuilder("Layout") {
        roundedRect(3f, 3f, 18f, 18f, 2f)
        moveTo(3f, 9f)
        lineTo(21f, 9f)
        moveTo(9f, 21f)
        lineTo(9f, 9f)
    }
}

/** lucide HardDrive（本地相册 Section）。 */
private val IconHardDrive: ImageVector by lazy {
    iconBuilder("HardDrive") {
        moveTo(5.45f, 5.11f)
        lineTo(2f, 12f)
        lineTo(2f, 18f)
        arcTo(2f, 2f, 0f, false, true, 4f, 20f)
        lineTo(20f, 20f)
        arcTo(2f, 2f, 0f, false, true, 22f, 18f)
        lineTo(22f, 12f)
        lineTo(18.55f, 5.11f)
        arcTo(2f, 2f, 0f, false, true, 16.76f, 4f)
        lineTo(7.24f, 4f)
        arcTo(2f, 2f, 0f, false, true, 5.45f, 5.11f)
        close()
        moveTo(2f, 12f)
        lineTo(22f, 12f)
        // 指示灯两点（圆头线帽放大成点）
        moveTo(6f, 16f)
        lineTo(6.01f, 16f)
        moveTo(10f, 16f)
        lineTo(10.01f, 16f)
    }
}

/**
 * lucide WifiOff（网络 Section 断连态；圆弧用三次贝塞尔近似 lucide 的椭圆弧，
 * 16dp 显示尺寸下观感一致：两段残弧 + 底部点 + 左上到右下斜杠）。
 */
private val IconWifiOff: ImageVector by lazy {
    iconBuilder("WifiOff") {
        // 底部点
        moveTo(12f, 20f)
        lineTo(12.01f, 20f)
        // 内弧（完整）
        moveTo(8.5f, 16.43f)
        curveTo(9.9f, 15.1f, 14.1f, 15.1f, 15.5f, 16.43f)
        // 中弧左残段（斜杠截断）
        moveTo(5f, 12.86f)
        curveTo(6.6f, 12.1f, 8.3f, 11.2f, 10.17f, 10.17f)
        // 中弧右残段
        moveTo(19f, 12.86f)
        curveTo(18.4f, 12.4f, 17.7f, 11.9f, 16.99f, 11.34f)
        // 外弧左残段
        moveTo(2f, 8.82f)
        curveTo(3.3f, 8.1f, 4.6f, 7.1f, 6.18f, 6.18f)
        // 外弧右残段
        moveTo(22f, 8.82f)
        curveTo(18f, 7.2f, 14.3f, 5.7f, 10.71f, 5.06f)
        // 斜杠
        moveTo(2f, 2f)
        lineTo(22f, 22f)
    }
}

/**
 * lucide Brain（人物 Section；两个对称脑叶 + 中缝细节，lucide 的 8 段小弧在 16dp 下
 * 并入轮廓——贝塞尔近似脑叶云形，观感对齐桌面）。
 */
private val IconBrain: ImageVector by lazy {
    iconBuilder("Brain") {
        // 左脑叶：顶 → 左上凸 → 左缘 → 左下凸 → 底 → 回中缝
        moveTo(12f, 5f)
        curveTo(10.9f, 3.9f, 8.6f, 3.9f, 7.2f, 5.1f)
        curveTo(5.2f, 5.6f, 4.1f, 7.7f, 4.9f, 9.6f)
        curveTo(3.4f, 10.9f, 3.3f, 13.3f, 4.7f, 14.7f)
        curveTo(4.5f, 16.9f, 6.3f, 18.8f, 8.5f, 18.7f)
        curveTo(9.4f, 19.7f, 11.2f, 19.8f, 12f, 18.6f)
        close()
        // 右脑叶（镜像）
        moveTo(12f, 5f)
        curveTo(13.1f, 3.9f, 15.4f, 3.9f, 16.8f, 5.1f)
        curveTo(18.8f, 5.6f, 19.9f, 7.7f, 19.1f, 9.6f)
        curveTo(20.6f, 10.9f, 20.7f, 13.3f, 19.3f, 14.7f)
        curveTo(19.5f, 16.9f, 17.7f, 18.8f, 15.5f, 18.7f)
        curveTo(14.6f, 19.7f, 12.8f, 19.8f, 12f, 18.6f)
        close()
        // 中缝细节（对齐 lucide 中部 V 形曲线）
        moveTo(15f, 13f)
        curveTo(13.8f, 12.2f, 12.5f, 10.8f, 12f, 9.2f)
        curveTo(11.5f, 10.8f, 10.2f, 12.2f, 9f, 13f)
    }
}

/** lucide Tag（标签 Section；含铆点）。 */
private val IconTagBadge: ImageVector by lazy {
    iconBuilder("TagBadge") {
        moveTo(12.586f, 2.586f)
        arcTo(2f, 2f, 0f, false, false, 11.172f, 2f)
        lineTo(4f, 2f)
        arcTo(2f, 2f, 0f, false, false, 2f, 4f)
        lineTo(2f, 11.172f)
        arcTo(2f, 2f, 0f, false, false, 2.586f, 12.586f)
        lineTo(11.29f, 21.29f)
        arcTo(2.426f, 2.426f, 0f, false, false, 14.71f, 21.29f)
        lineTo(21.29f, 14.71f)
        arcTo(2.426f, 2.426f, 0f, false, false, 21.29f, 11.29f)
        close()
        moveTo(7.5f, 7.5f)
        lineTo(7.51f, 7.5f)
    }
}

/** lucide Scan（画布 Section）：四角取景框 + 中线。 */
private val IconScan: ImageVector by lazy {
    iconBuilder("Scan") {
        moveTo(3f, 7f)
        lineTo(3f, 5f)
        arcTo(2f, 2f, 0f, false, true, 5f, 3f)
        lineTo(7f, 3f)
        moveTo(17f, 3f)
        lineTo(19f, 3f)
        arcTo(2f, 2f, 0f, false, true, 21f, 5f)
        lineTo(21f, 7f)
        moveTo(21f, 17f)
        lineTo(21f, 19f)
        arcTo(2f, 2f, 0f, false, true, 19f, 21f)
        lineTo(17f, 21f)
        moveTo(7f, 21f)
        lineTo(5f, 21f)
        arcTo(2f, 2f, 0f, false, true, 3f, 19f)
        lineTo(3f, 17f)
        moveTo(7f, 12f)
        lineTo(17f, 12f)
    }
}

/** lucide folder。 */
private val IconFolder: ImageVector by lazy {
    iconBuilder("Folder") {
        moveTo(20f, 20f)
        arcTo(2f, 2f, 0f, false, false, 22f, 18f)
        lineTo(22f, 8f)
        arcTo(2f, 2f, 0f, false, false, 20f, 6f)
        lineTo(12.1f, 6f)
        arcTo(2f, 2f, 0f, false, true, 10.41f, 5.1f)
        lineTo(9.6f, 3.9f)
        arcTo(2f, 2f, 0f, false, false, 7.93f, 3f)
        lineTo(4f, 3f)
        arcTo(2f, 2f, 0f, false, false, 2f, 5f)
        lineTo(2f, 18f)
        arcTo(2f, 2f, 0f, false, false, 4f, 20f)
        close()
    }
}

/** lucide tag（主路径；小尺寸省铆点）。 */
private val IconTagSmall: ImageVector by lazy {
    iconBuilder("TagSmall") {
        moveTo(12.586f, 2.586f)
        arcTo(2f, 2f, 0f, false, false, 11.172f, 2f)
        lineTo(4f, 2f)
        arcTo(2f, 2f, 0f, false, false, 2f, 4f)
        lineTo(2f, 11.172f)
        arcTo(2f, 2f, 0f, false, false, 2.586f, 12.586f)
        lineTo(11.29f, 21.29f)
        arcTo(2.426f, 2.426f, 0f, false, false, 14.71f, 21.29f)
        lineTo(21.29f, 14.71f)
        arcTo(2.426f, 2.426f, 0f, false, false, 21.29f, 11.29f)
        close()
    }
}

/** lucide arrow-down-up（排序循环；同 TopBar 的 ArrowDownUp 绘制）。 */
private val IconArrowUpDown: ImageVector by lazy {
    iconBuilder("ArrowUpDown") {
        moveTo(3f, 16f)
        lineTo(7f, 20f)
        lineTo(11f, 16f)
        moveTo(7f, 20f)
        lineTo(7f, 4f)
        moveTo(21f, 8f)
        lineTo(17f, 4f)
        lineTo(13f, 8f)
        moveTo(17f, 4f)
        lineTo(17f, 20f)
    }
}
