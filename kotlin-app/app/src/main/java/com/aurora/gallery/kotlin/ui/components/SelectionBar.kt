package com.aurora.gallery.kotlin.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.path
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.aurora.gallery.kotlin.ui.theme.AuroraTheme

/**
 * 编辑模式顶栏（4.2 选择栏，对齐 React `AndroidSelectionBar.tsx`：h-14 + 左「X + 计数」
 * 右「全选/删除/分享/更多」，编辑模式时**替换** TopBar 同一位置，React ToolbarPane 同构）。
 *
 * 按钮触控目标 48dp（React w-10 h-10 是 40dp 视觉 + hover 边距；触屏最小命中目标按
 * desktop-to-android 规范扩到 48dp）。删除为红色（React text-red-500 = #EF4444）。
 *
 * 「更多」菜单（M4a 3.2 起真菜单，4.3 扩成选中集上下文菜单的承载物）：[moreActions]
 * 非空时展开 AuroraDropdown 毛玻璃弹层（§8 教训：弹层一律复用 Aurora 系组件，不再起
 * material3 DropdownMenu 第二套）；为空时退回 [onMore] 占位 Toast。开合状态受控
 * （[moreExpanded]/[onMoreExpandedChange] 提升到宿主）——长按已选中项要从网格侧把它
 * 打开（M1 占位「长按已选中项的上下文菜单」的同位收口，桌面同位是文件右键菜单）。
 */
/** 「更多」菜单项（标签 + 动作；3.2 归入/移除 + 4.3 标签三项）。 */
data class SelectionMoreAction(val label: String, val onClick: () -> Unit)

@Composable
fun SelectionBar(
    selectedCount: Int,
    totalCount: Int,
    /** 全选/取消全选（按钮图标按是否全选自动切换，对齐 React CheckCheck/XCircle）。 */
    onToggleSelectAll: () -> Unit,
    onExit: () -> Unit,
    onDelete: () -> Unit,
    onShare: () -> Unit,
    /** [moreActions] 为空时的占位行为（Toast，M1 边界）。 */
    onMore: () -> Unit,
    /** 「更多」的菜单项；非空 = 点击弹出菜单。 */
    moreActions: List<SelectionMoreAction> = emptyList(),
    /** 菜单开合（受控）：长按已选中项时由宿主置 true。 */
    moreExpanded: Boolean = false,
    onMoreExpandedChange: (Boolean) -> Unit = {},
    modifier: Modifier = Modifier,
) {
    val colors = AuroraTheme.colors
    val allSelected = totalCount > 0 && selectedCount >= totalCount
    var moreAnchor by remember { mutableStateOf(androidx.compose.ui.geometry.Rect.Zero) }
    Row(
        modifier = modifier
            .fillMaxWidth()
            .height(56.dp)
            .background(colors.panel)
            // 8dp 与 TopBar 同边距（M8b 验收反馈：进入/退出选择模式时「更多」钮不许跳位
            // ——TopBar 竖屏 44dp 钮 + 8dp 边距，本栏原 12dp 边距 + 48dp 钮会横移 ~6dp）
            .padding(horizontal = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        SelBarButton(onClick = onExit) {
            Icon(
                imageVector = SelIconX,
                contentDescription = "退出选择",
                tint = colors.textSecondary,
                modifier = Modifier.size(20.dp),
            )
        }
        Spacer(Modifier.size(8.dp))
        Text(
            "$selectedCount/$totalCount",
            fontSize = 14.sp,
            fontWeight = FontWeight.SemiBold,
            color = colors.textPrimary,
        )
        Spacer(Modifier.weight(1f))
        SelBarButton(onClick = onToggleSelectAll) {
            Icon(
                imageVector = if (allSelected) SelIconXCircle else SelIconCheckCheck,
                contentDescription = if (allSelected) "取消全选" else "全选",
                tint = colors.textSecondary,
                modifier = Modifier.size(20.dp),
            )
        }
        Spacer(Modifier.size(4.dp))
        SelBarButton(onClick = onDelete) {
            Icon(
                imageVector = SelIconTrash,
                contentDescription = "删除",
                tint = SELECTION_DANGER,
                modifier = Modifier.size(20.dp),
            )
        }
        Spacer(Modifier.size(4.dp))
        SelBarButton(onClick = onShare) {
            Icon(
                imageVector = SelIconShare,
                contentDescription = "分享",
                tint = colors.textSecondary,
                modifier = Modifier.size(20.dp),
            )
        }
        Spacer(Modifier.size(4.dp))
        Box(
            Modifier.onGloballyPositioned { moreAnchor = it.boundsInWindow() },
        ) {
            SelBarButton(onClick = { if (moreActions.isEmpty()) onMore() else onMoreExpandedChange(true) }) {
                Icon(
                    imageVector = SelIconMore,
                    contentDescription = "更多",
                    tint = colors.textSecondary,
                    modifier = Modifier.size(20.dp),
                )
            }
            // 毛玻璃弹层复用（§8 教训）；AuroraDropdown 点选项后由这里收起
            AuroraDropdown(
                expanded = moreExpanded && moreActions.isNotEmpty(),
                anchorBoundsInWindow = moreAnchor,
                onDismissRequest = { onMoreExpandedChange(false) },
            ) {
                moreActions.forEach { action ->
                    AuroraMenuItem(
                        text = action.label,
                        onClick = {
                            onMoreExpandedChange(false)
                            action.onClick()
                        },
                    )
                }
            }
        }
    }
}

/** 删除按钮的红色（对齐 React text-red-500 #EF4444）。 */
private val SELECTION_DANGER = Color(0xFFEF4444)

/**
 * 选择栏圆角按钮（对齐 [TopBarButton] 形制——M8b 验收反馈「位置一致」：竖屏手机 44dp
 * （TopBar compact 同值，`minimumInteractiveComponentSize` 把命中区补回 48dp）、平板
 * 48dp；此前固定 48dp 且栏边距 12dp，与 TopBar 的 8dp+44/48 组合造成切换跳位）。
 */
@Composable
private fun SelBarButton(
    onClick: () -> Unit,
    content: @Composable () -> Unit,
) {
    val compact = com.aurora.gallery.kotlin.ui.isCompactWidth(
        androidx.compose.ui.platform.LocalConfiguration.current,
    )
    Box(
        modifier = Modifier
            .size(if (compact) 44.dp else 48.dp)
            .clip(RoundedCornerShape(12.dp))
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        content()
    }
}

// ---- 自绘图标：lucide 线性风格（同 TopBar.kt 的 iconBuilder，按文件就近持有一份）----

private const val SEL_STROKE = 2f

private fun selIconBuilder(
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
        strokeLineWidth = SEL_STROKE,
        strokeLineCap = StrokeCap.Round,
        strokeLineJoin = StrokeJoin.Round,
    ) { block() }
}.build()

private fun selCircle(cx: Float, cy: Float, r: Float): androidx.compose.ui.graphics.vector.PathBuilder.() -> Unit = {
    moveTo(cx - r, cy)
    arcTo(r, r, 0f, false, true, cx + r, cy)
    arcTo(r, r, 0f, false, true, cx - r, cy)
    close()
}

/** lucide X：退出选择（React onClearSelection 的同款图标）。 */
private val SelIconX: ImageVector by lazy {
    selIconBuilder("SelX") {
        moveTo(18f, 6f)
        lineTo(6f, 18f)
        moveTo(6f, 6f)
        lineTo(18f, 18f)
    }
}

/** lucide check-check：全选。 */
private val SelIconCheckCheck: ImageVector by lazy {
    selIconBuilder("SelCheckCheck") {
        moveTo(18f, 6f)
        lineTo(7f, 17f)
        lineTo(2f, 12f)
        moveTo(22f, 10f)
        lineTo(14.5f, 17.5f)
        lineTo(13f, 16f)
    }
}

/** lucide circle-x：取消全选。 */
private val SelIconXCircle: ImageVector by lazy {
    selIconBuilder("SelXCircle") {
        selCircle(12f, 12f, 10f)()
        moveTo(15f, 9f)
        lineTo(9f, 15f)
        moveTo(9f, 9f)
        lineTo(15f, 15f)
    }
}

/** lucide trash-2：删除（红色）。 */
private val SelIconTrash: ImageVector by lazy {
    selIconBuilder("SelTrash") {
        moveTo(3f, 6f)
        lineTo(21f, 6f)
        moveTo(19f, 6f)
        // 桶身（圆角矩形开口向下）
        lineTo(19f, 20f)
        arcTo(2f, 2f, 0f, false, true, 17f, 22f)
        lineTo(7f, 22f)
        arcTo(2f, 2f, 0f, false, true, 5f, 20f)
        lineTo(5f, 6f)
        moveTo(8f, 6f)
        lineTo(8f, 4f)
        arcTo(2f, 2f, 0f, false, true, 10f, 2f)
        lineTo(14f, 2f)
        arcTo(2f, 2f, 0f, false, true, 16f, 4f)
        lineTo(16f, 6f)
        moveTo(10f, 11f)
        lineTo(10f, 17f)
        moveTo(14f, 11f)
        lineTo(14f, 17f)
    }
}

/** lucide share-2：分享。 */
private val SelIconShare: ImageVector by lazy {
    selIconBuilder("SelShare") {
        selCircle(18f, 5f, 3f)()
        selCircle(6f, 12f, 3f)()
        selCircle(18f, 19f, 3f)()
        moveTo(8.59f, 13.51f)
        lineTo(15.42f, 17.49f)
        moveTo(15.41f, 6.51f)
        lineTo(8.59f, 10.49f)
    }
}

/** lucide ellipsis-vertical：更多。 */
// M4b 反馈：原先三个点用「0.01 单位线段 + 圆头笔帽」画（同 Tag 铆点技法），直径只有
// ≈2 视口单位，在 20dp 图标上渲染出 ≈1.7dp 的点，和同排其他线性图标相比明显偏小。
// 改为 r=2 的实心圆（直径 4 视口单位 ≈3.3dp），视觉重量与 2f 笔画相当。
private val SelIconMore: ImageVector by lazy {
    ImageVector.Builder(
        name = "SelMore",
        defaultWidth = 24.dp,
        defaultHeight = 24.dp,
        viewportWidth = 24f,
        viewportHeight = 24f,
    ).apply {
        path(fill = SolidColor(Color.Black)) {
            selDot(12f, 5f)
            selDot(12f, 12f)
            selDot(12f, 19f)
        }
    }.build()
}

/** 圆点子路径：实心圆（NonZero 填充下多个子路径互不干扰）。 */
private fun androidx.compose.ui.graphics.vector.PathBuilder.selDot(cx: Float, cy: Float, r: Float = 2f) {
    moveTo(cx - r, cy)
    arcTo(r, r, 0f, false, true, cx + r, cy)
    arcTo(r, r, 0f, false, true, cx - r, cy)
    close()
}
