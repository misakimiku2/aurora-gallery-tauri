package com.aurora.gallery.kotlin.ui.components

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.wrapContentHeight
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Icon
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.aurora.gallery.kotlin.state.LanSavedServer
import com.aurora.gallery.kotlin.ui.theme.AuroraTheme

// —— LAN 面板专用构件（M6a 阶段 3；M4c 面板此前没有文本输入，这里按同一 token 体系补）——

/**
 * 单行文本框（Surface 48dp 触屏目标 + BasicTextField；token 取 AuroraTheme 同表）。
 * [onEditCommitted] 非空 = 失焦且内容有变时回调（设备名的落库时点）。
 * [trailing] = 输入框内行尾插槽（2026-09-26 二轮反馈：扫码图标嵌进地址框右缘，
 * 形似输入框的一部分）；插槽自带 48×48 触屏目标，调用方负责内容与语义。
 */
@Composable
internal fun LanTextField(
    value: String,
    onValueChange: (String) -> Unit,
    hint: String,
    modifier: Modifier = Modifier,
    onEditCommitted: ((String) -> Unit)? = null,
    trailing: (@Composable () -> Unit)? = null,
) {
    val colors = AuroraTheme.colors
    Surface(
        modifier = modifier
            .fillMaxWidth()
            .padding(top = 8.dp)
            .height(48.dp),
        shape = RoundedCornerShape(8.dp),
        color = colors.surface,
        border = BorderStroke(1.dp, colors.border),
    ) {
        Row(
            Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            BasicTextField(
                value = value,
                onValueChange = onValueChange,
                singleLine = true,
                textStyle = TextStyle(fontSize = 14.sp, color = colors.textPrimary),
                cursorBrush = SolidColor(colors.primary),
                modifier = Modifier
                    .weight(1f)
                    .onFocusChanged { state ->
                        // 失焦且内容有变才提交（设备名落库时点；FocusState 无 isActive 这类
                        // 组合态可判，isFocused 足够——失焦即视为编辑结束）
                        if (!state.isFocused) onEditCommitted?.invoke(value)
                    }
                    .padding(start = 12.dp, end = if (trailing != null) 4.dp else 12.dp)
                    .wrapContentHeight(align = Alignment.CenterVertically),
                decorationBox = { inner ->
                    Box(Modifier.wrapContentHeight(align = Alignment.CenterVertically)) {
                        if (value.isEmpty()) {
                            Text(hint, fontSize = 14.sp, color = colors.textSecondary, maxLines = 1)
                        }
                        inner()
                    }
                },
            )
            if (trailing != null) {
                Spacer(Modifier.size(2.dp))
                trailing()
            }
        }
    }
}

/**
 * 访问码分位输入（2026-09-26 三轮反馈：对齐 web 连接页的四格圆角矩形样式）。
 * 单个透明 BasicTextField 承载 IME（数字键盘、过滤非数字、封顶 4 位——粘贴整段验证码
 * 自动分位），decorationBox 画四格：已填格 = primary 细描边 + 字符，光标格（下一位）
 * = primary 2dp 描边，未填格 = 灰描边。真实文本与光标透明，可视内容全由四格呈现；
 * 命中区是整行（触屏不必精确点到某一格）。
 */
@Composable
internal fun LanCodeInput(
    value: String,
    onValueChange: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = AuroraTheme.colors
    BasicTextField(
        value = value,
        onValueChange = { nv -> onValueChange(nv.filter(Char::isDigit).take(4)) },
        singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
        textStyle = TextStyle(color = Color.Transparent),
        cursorBrush = SolidColor(Color.Transparent),
        modifier = modifier
            .fillMaxWidth()
            .padding(top = 8.dp)
            .height(56.dp),
        decorationBox = {
            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.Center,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                repeat(4) { index ->
                    Box(
                        Modifier
                            .size(52.dp)
                            .clip(RoundedCornerShape(10.dp))
                            .background(colors.surface)
                            .border(
                                when {
                                    index == value.length -> 2.dp
                                    index < value.length -> 1.dp
                                    else -> 1.dp
                                },
                                when {
                                    index <= value.length -> colors.primary
                                    else -> colors.border
                                },
                                RoundedCornerShape(10.dp),
                            ),
                        contentAlignment = Alignment.Center,
                    ) {
                        if (index < value.length) {
                            Text(
                                value[index].toString(),
                                fontSize = 20.sp,
                                fontWeight = FontWeight.Bold,
                                color = colors.textPrimary,
                            )
                        }
                    }
                    if (index < 3) Spacer(Modifier.size(10.dp))
                }
            }
        },
    )
}

/** 主按钮（连接）：primary 底白字，48dp 触屏目标。 */
@Composable
internal fun LanPrimaryButton(
    label: String,
    enabled: Boolean = true,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = AuroraTheme.colors
    Surface(
        modifier = modifier.height(48.dp),
        shape = RoundedCornerShape(8.dp),
        color = if (enabled) colors.primary else colors.surface,
        enabled = enabled,
        onClick = onClick,
    ) {
        Box(contentAlignment = Alignment.Center, modifier = Modifier.fillMaxSize()) {
            Text(
                label,
                fontSize = 14.sp,
                fontWeight = FontWeight.Bold,
                color = if (enabled) Color.White else colors.textSecondary,
            )
        }
    }
}

/** 次按钮（扫码连接/断开）：surface 底 + border 描边，48dp 触屏目标。 */
@Composable
internal fun LanSecondaryButton(
    label: String,
    enabled: Boolean = true,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = AuroraTheme.colors
    Surface(
        modifier = modifier.height(48.dp),
        shape = RoundedCornerShape(8.dp),
        color = colors.surface,
        border = BorderStroke(1.dp, if (enabled) colors.border else colors.border.copy(alpha = 0.5f)),
        enabled = enabled,
        onClick = onClick,
    ) {
        Box(contentAlignment = Alignment.Center, modifier = Modifier.fillMaxSize()) {
            Text(
                label,
                fontSize = 14.sp,
                color = if (enabled) colors.textPrimary else colors.textSecondary,
            )
        }
    }
}

/**
 * 图标动作钮（2026-09-26 验收反馈：LAN 面板文字按钮图形化）：48dp 圆形触屏目标居中
 * 20dp 图标（视觉小命中大），[description] 兼作无障碍文案；disabled 时图标降次级灰。
 * [tint] 非空覆盖默认着色（断开钮红色 = colors.palette.danger，三轮反馈）。
 * 用于行尾小动作（连接状态行的连接/断开、重新生成访问码）。
 */
@Composable
internal fun LanIconButton(
    icon: ImageVector,
    description: String,
    enabled: Boolean = true,
    tint: Color? = null,
    onClick: () -> Unit,
) {
    val colors = AuroraTheme.colors
    Box(
        modifier = Modifier
            .size(48.dp)
            .clip(CircleShape)
            .clickable(enabled = enabled, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            imageVector = icon,
            contentDescription = description,
            tint = tint ?: if (enabled) colors.primary else colors.textSecondary,
            modifier = Modifier.size(20.dp),
        )
    }
}

/** 最近服务器行（host:port + 名称/访问码副行；整行 52dp 触屏目标，点击一键连）。
 * 行尾 chevron 为可点暗示（原「连接」文字，2026-09-26 图形化）。 */
@Composable
internal fun LanSavedServerRow(server: LanSavedServer, onClick: () -> Unit) {
    val colors = AuroraTheme.colors
    Row(
        Modifier
            .fillMaxWidth()
            .height(52.dp)
            .clickable(onClick = onClick),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            imageVector = IconWifi,
            contentDescription = null,
            tint = colors.primary,
            modifier = Modifier.size(15.dp),
        )
        Spacer(Modifier.size(10.dp))
        Column(Modifier.weight(1f)) {
            Text(
                "${server.host}:${server.port}",
                fontSize = 14.sp,
                color = colors.textPrimary,
                maxLines = 1,
            )
            Text(
                listOfNotNull(server.name, server.accessCode?.let { "码 $it" }).joinToString(" · "),
                fontSize = 11.sp,
                color = colors.textSecondary,
                maxLines = 1,
            )
        }
        Icon(
            imageVector = IconChevronRight,
            contentDescription = null,
            tint = colors.primary,
            modifier = Modifier.size(16.dp),
        )
    }
}
