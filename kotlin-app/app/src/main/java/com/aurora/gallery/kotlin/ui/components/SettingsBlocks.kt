package com.aurora.gallery.kotlin.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.aurora.gallery.kotlin.ui.theme.AuroraTheme

// —— 构建块（样式对齐桌面 token：panel/content/surface/subtle/primary 取自 AuroraTheme.colors）——

/**
 * 节标题：18sp 粗体 + 底部分隔线（对齐桌面 `text-lg font-bold border-subtle pb-2`）；
 * [icon] 非空时前置 20dp primary 色图标（外观/默认布局/关于节，对齐桌面 flex items-center）。
 * [trailing] 为标题行右端控件（桌面主色调节右端的「刷新」按钮即此口）。
 */
@Composable
internal fun SettingsSection(
    title: String,
    icon: ImageVector? = null,
    iconTint: Color? = null,
    trailing: @Composable RowScope.() -> Unit = {},
) {
    Column(Modifier.padding(top = 20.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            if (icon != null) {
                androidx.compose.material3.Icon(
                    imageVector = icon,
                    contentDescription = null,
                    tint = iconTint ?: AuroraTheme.colors.primary,
                    modifier = Modifier.size(18.dp),
                )
                Spacer(Modifier.size(8.dp))
            }
            Text(
                title,
                fontSize = 18.sp,
                fontWeight = FontWeight.Bold,
                color = AuroraTheme.colors.textPrimary,
            )
            Spacer(Modifier.weight(1f))
            trailing()
        }
        Box(
            Modifier
                .fillMaxWidth()
                .padding(top = 8.dp)
                .height(1.dp)
                .background(AuroraTheme.colors.border),
        )
    }
}

/** 节内字段标题（桌面 `text-sm font-bold text-gray-700`）。 */
@Composable
internal fun SettingsLabel(text: String, topPadding: Int = 12) {
    Text(
        text,
        fontSize = 13.sp,
        fontWeight = FontWeight.Bold,
        color = AuroraTheme.colors.textPrimary,
        modifier = Modifier.padding(top = topPadding.dp),
    )
}

/** 小节标题（关于页二级，桌面 `text-sm font-semibold` + 16dp 图标）。 */
@Composable
internal fun SettingsSubLabel(text: String, icon: ImageVector, topPadding: Int) {
    Row(
        Modifier.padding(top = topPadding.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        androidx.compose.material3.Icon(
            imageVector = icon,
            contentDescription = null,
            tint = AuroraTheme.colors.textSecondary,
            modifier = Modifier.size(14.dp),
        )
        Spacer(Modifier.size(6.dp))
        Text(
            text,
            fontSize = 13.sp,
            fontWeight = FontWeight.SemiBold,
            color = AuroraTheme.colors.textPrimary,
        )
    }
}

/** 卡片容器（对齐桌面 `bg-surface rounded-xl p-4`）。 */
@Composable
internal fun SettingsCard(content: @Composable () -> Unit) {
    Surface(
        modifier = Modifier
            .fillMaxWidth()
            .padding(top = 12.dp),
        shape = RoundedCornerShape(12.dp),
        color = AuroraTheme.colors.surface,
    ) {
        Column(Modifier.padding(horizontal = 16.dp, vertical = 6.dp)) { content() }
    }
}

/** 设置行：左标签（+ 可选灰字值），右控件。行高 ≥48dp 触屏目标。 */
@Composable
internal fun SettingsRow(
    label: String,
    value: String? = null,
    content: @Composable () -> Unit,
) {
    Row(
        Modifier
            .fillMaxWidth()
            .defaultMinSize(minHeight = 52.dp)
            .padding(vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(label, fontSize = 15.sp, color = AuroraTheme.colors.textPrimary)
            if (value != null) {
                Text(value, fontSize = 12.sp, color = AuroraTheme.colors.textSecondary)
            }
        }
        content()
    }
}

/**
 * 带图标横排按钮（对齐桌面语言/排序按钮：`rounded border`，选中蓝边 + blue-50 底 +
 * 蓝字）。选中时右侧带勾（排序按钮组桌面同款）。
 */
@Composable
internal fun SettingsIconOption(
    icon: ImageVector,
    label: String,
    selected: Boolean,
    onClick: () -> Unit,
    showCheck: Boolean = false,
) {
    val colors = AuroraTheme.colors
    Surface(
        shape = RoundedCornerShape(8.dp),
        color = if (selected) colors.primary.copy(alpha = 0.08f) else Color.Transparent,
        border = androidx.compose.foundation.BorderStroke(
            1.dp,
            if (selected) colors.primary else colors.border,
        ),
    ) {
        Row(
            Modifier
                .clickable(onClick = onClick)
                .padding(horizontal = 12.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            androidx.compose.material3.Icon(
                imageVector = icon,
                contentDescription = null,
                tint = if (selected) colors.primary else colors.textSecondary,
                modifier = Modifier.size(15.dp),
            )
            Spacer(Modifier.size(8.dp))
            Text(
                label,
                fontSize = 13.sp,
                fontWeight = if (selected) FontWeight.Bold else FontWeight.Normal,
                color = if (selected) colors.primary else colors.textPrimary,
            )
            if (showCheck && selected) {
                Spacer(Modifier.size(10.dp))
                androidx.compose.material3.Icon(
                    imageVector = IconCheck,
                    contentDescription = null,
                    tint = colors.primary,
                    modifier = Modifier.size(13.dp),
                )
            }
        }
    }
}

/**
 * 竖排选项按钮（排序方式/方向，桌面 `w-full flex items-center px-3 py-2 rounded-lg border`）：
 * 选中蓝边 + primary 8% 底 + 蓝字 + 右侧勾。
 */
@Composable
internal fun SettingsOptionButton(
    icon: ImageVector,
    label: String,
    selected: Boolean,
    onClick: () -> Unit,
) {
    val colors = AuroraTheme.colors
    Surface(
        modifier = Modifier
            .fillMaxWidth()
            .padding(bottom = 8.dp),
        shape = RoundedCornerShape(8.dp),
        color = if (selected) colors.primary.copy(alpha = 0.08f) else Color.Transparent,
        border = androidx.compose.foundation.BorderStroke(
            1.dp,
            if (selected) colors.primary else colors.border,
        ),
    ) {
        Row(
            Modifier
                .fillMaxWidth()
                .clickable(onClick = onClick)
                .padding(horizontal = 12.dp, vertical = 11.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            androidx.compose.material3.Icon(
                imageVector = icon,
                contentDescription = null,
                tint = if (selected) colors.primary else colors.textSecondary,
                modifier = Modifier.size(15.dp),
            )
            Spacer(Modifier.size(10.dp))
            Text(
                label,
                fontSize = 13.sp,
                fontWeight = if (selected) FontWeight.Bold else FontWeight.Normal,
                color = if (selected) colors.primary else colors.textPrimary,
                modifier = Modifier.weight(1f),
            )
            if (selected) {
                androidx.compose.material3.Icon(
                    imageVector = IconCheck,
                    contentDescription = null,
                    tint = colors.primary,
                    modifier = Modifier.size(13.dp),
                )
            }
        }
    }
}

/**
 * 图标卡（默认视图模式/分组方式，桌面 `flex flex-col items-center p-3 rounded-lg border-2`）：
 * 上图标下文字，选中 2dp 蓝边 + blue-50 底。
 */
@Composable
internal fun SettingsIconCard(
    icon: ImageVector,
    label: String,
    selected: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = AuroraTheme.colors
    Surface(
        modifier = modifier,
        shape = RoundedCornerShape(10.dp),
        color = if (selected) colors.primary.copy(alpha = 0.08f) else Color.Transparent,
        border = androidx.compose.foundation.BorderStroke(
            if (selected) 2.dp else 1.dp,
            if (selected) colors.primary else colors.border,
        ),
    ) {
        Column(
            Modifier
                .fillMaxWidth()
                .clickable(onClick = onClick)
                .padding(horizontal = 8.dp, vertical = 12.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            androidx.compose.material3.Icon(
                imageVector = icon,
                contentDescription = null,
                tint = if (selected) colors.primary else colors.textSecondary,
                modifier = Modifier.size(22.dp),
            )
            Spacer(Modifier.size(6.dp))
            Text(
                label,
                fontSize = 12.sp,
                fontWeight = if (selected) FontWeight.Bold else FontWeight.Normal,
                color = if (selected) colors.primary else colors.textSecondary,
            )
        }
    }
}

/**
 * 主题预览卡（对齐桌面 GeneralPanel:164-187）：预览块（[preview] 插槽）+ 下方档位名，
 * 选中 2dp 蓝边 + 右上角蓝圆白勾角标。
 */
@Composable
internal fun ThemePreviewCard(
    label: String,
    icon: ImageVector,
    selected: Boolean,
    preview: @Composable () -> Unit,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = AuroraTheme.colors
    Box(modifier = modifier) {
        Surface(
            modifier = Modifier.fillMaxWidth(),
            shape = RoundedCornerShape(10.dp),
            color = Color.Transparent,
            border = androidx.compose.foundation.BorderStroke(
                if (selected) 2.dp else 1.dp,
                if (selected) colors.primary else colors.border,
            ),
        ) {
            Column(
                Modifier
                    .fillMaxWidth()
                    .clickable(onClick = onClick)
                    .padding(6.dp),
            ) {
                Box(
                    Modifier
                        .fillMaxWidth()
                        .height(64.dp)
                        .clip(RoundedCornerShape(6.dp)),
                ) {
                    preview()
                    Box(contentAlignment = Alignment.Center, modifier = Modifier.matchParentSize()) {
                        androidx.compose.material3.Icon(
                            imageVector = icon,
                            contentDescription = null,
                            tint = colors.textSecondary,
                            modifier = Modifier.size(22.dp),
                        )
                    }
                }
                Text(
                    label,
                    fontSize = 12.sp,
                    fontWeight = if (selected) FontWeight.Bold else FontWeight.Medium,
                    color = if (selected) colors.primary else colors.textSecondary,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(top = 6.dp, bottom = 2.dp),
                    textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                )
            }
        }
        if (selected) {
            Box(
                Modifier
                    .align(Alignment.TopEnd)
                    .padding(6.dp)
                    .size(16.dp)
                    .clip(CircleShape)
                    .background(colors.primary),
                contentAlignment = Alignment.Center,
            ) {
                androidx.compose.material3.Icon(
                    imageVector = IconCheck,
                    contentDescription = null,
                    tint = Color.White,
                    modifier = Modifier.size(10.dp),
                )
            }
        }
    }
}

/** 徽标（版本/稳定版，桌面 `px-2.5 py-1 rounded-full text-xs`）。 */
@Composable
internal fun SettingsBadge(text: String, bg: Color, fg: Color) {
    Surface(shape = CircleShape, color = bg) {
        Text(
            text,
            fontSize = 11.sp,
            fontWeight = FontWeight.Medium,
            color = fg,
            modifier = Modifier.padding(horizontal = 10.dp, vertical = 3.dp),
        )
    }
}

/** 值卡（技术栈版本三卡，桌面 `bg-surface rounded-xl p-4 border`）。 */
@Composable
internal fun SettingsValueCard(label: String, value: String, modifier: Modifier = Modifier) {
    val colors = AuroraTheme.colors
    Surface(modifier = modifier, shape = RoundedCornerShape(12.dp), color = colors.surface) {
        Column(Modifier.padding(horizontal = 12.dp, vertical = 10.dp)) {
            Text(label, fontSize = 11.sp, color = colors.textSecondary)
            Text(
                value,
                fontSize = 14.sp,
                fontWeight = FontWeight.SemiBold,
                color = colors.textPrimary,
                modifier = Modifier.padding(top = 2.dp),
            )
        }
    }
}

/** 链接卡（相关链接，桌面 `flex items-center gap-3 p-4 bg-surface rounded-xl border`）。 */
@Composable
internal fun SettingsLinkCard(
    icon: ImageVector,
    title: String,
    subtitle: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = AuroraTheme.colors
    Surface(
        modifier = modifier,
        shape = RoundedCornerShape(12.dp),
        color = colors.surface,
        border = androidx.compose.foundation.BorderStroke(1.dp, colors.border),
    ) {
        Row(
            Modifier
                .fillMaxWidth()
                .clickable(onClick = onClick)
                .padding(horizontal = 12.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            androidx.compose.material3.Icon(
                imageVector = icon,
                contentDescription = null,
                tint = colors.textSecondary,
                modifier = Modifier.size(18.dp),
            )
            Spacer(Modifier.size(10.dp))
            Column {
                Text(title, fontSize = 13.sp, fontWeight = FontWeight.Medium, color = colors.textPrimary)
                Text(subtitle, fontSize = 11.sp, color = colors.textSecondary)
            }
        }
    }
}

/** M6 占位卡（图标 + 标题 + 说明，虚线感交给颜色弱化；不响应点击）。 */
@Composable
internal fun SettingsPlaceholderCard(
    icon: ImageVector,
    title: String,
    description: String,
) {
    val colors = AuroraTheme.colors
    Surface(
        modifier = Modifier
            .fillMaxWidth()
            .padding(top = 12.dp),
        shape = RoundedCornerShape(12.dp),
        color = colors.surface.copy(alpha = 0.5f),
        border = androidx.compose.foundation.BorderStroke(1.dp, colors.border),
    ) {
        Column(
            Modifier
                .fillMaxWidth()
                .padding(vertical = 20.dp, horizontal = 16.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            androidx.compose.material3.Icon(
                imageVector = icon,
                contentDescription = null,
                tint = colors.textSecondary.copy(alpha = 0.6f),
                modifier = Modifier.size(32.dp),
            )
            Text(
                title,
                fontSize = 14.sp,
                fontWeight = FontWeight.SemiBold,
                color = colors.textSecondary,
                modifier = Modifier.padding(top = 10.dp),
            )
            Text(
                description,
                fontSize = 12.sp,
                color = colors.textSecondary.copy(alpha = 0.8f),
                modifier = Modifier.padding(top = 4.dp),
                textAlign = androidx.compose.ui.text.style.TextAlign.Center,
            )
        }
    }
}

@Composable
internal fun SettingsAction(label: String, enabled: Boolean = true, onClick: () -> Unit) {
    TextButton(enabled = enabled, onClick = onClick) {
        Text(
            label,
            fontSize = 13.sp,
            color = if (enabled) AuroraTheme.colors.primary else AuroraTheme.colors.textSecondary,
        )
    }
}
