package com.aurora.gallery.kotlin.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * Aurora 设计 token（M1 0.1 设计约定 → Compose 主题落地）。
 *
 * 原则（规划 §2.3）：Material 只作技术底座，不作视觉来源——主题色、组件形状、
 * 间距全部以桌面端设计约定为准，显式覆盖 MaterialTheme 默认，保证「与桌面一张脸」。
 * 来源：docs/Android/Kotlin版/设计约定.md。
 */

/** 语义化颜色 token（设计约定 §1）。 */
data class AuroraColorScheme(
    val main: Color,          // 应用主背景
    val content: Color,       // 内容区（卡片/网格所在层）
    val panel: Color,         // 面板（侧栏/详情面板）
    val surface: Color,       // 表面（次级容器/缩略图占位底）
    val subtle: Color,        // 细微（分隔替代、浅底）
    val primary: Color,       // 主色：选中态、按钮、高亮（收敛散落的 #3B82F6）
    val primaryWeak: Color,   // 选中框描边/拖拽描边（primary @ 0.8）
    val textPrimary: Color,   // 正文
    val textSecondary: Color, // 说明/占位
)

val LightAuroraColors = AuroraColorScheme(
    main = Color(0xFFE5E5E5),
    content = Color(0xFFFFFFFF),
    panel = Color(0xFFF7F7F7),
    surface = Color(0xFFE5E7EB),
    subtle = Color(0xFFE5E7EB),
    primary = Color(0xFF3B82F6),
    primaryWeak = Color(0xCC3B82F6), // rgba(59,130,246,0.8)
    textPrimary = Color(0xFF1E293B),
    textSecondary = Color(0xFF737373),
)

val DarkAuroraColors = AuroraColorScheme(
    main = Color(0xFF1A1A1A),
    content = Color(0xFF262626),
    panel = Color(0xFF2A2A2A),
    surface = Color(0xFF3A3A3A),
    subtle = Color(0xFF404040),
    primary = Color(0xFF3B82F6),
    primaryWeak = Color(0xCC60A5FA), // rgba(96,165,250,0.8)
    textPrimary = Color(0xFFE5E5E5),
    textSecondary = Color(0xFFA3A3A3),
)

val LocalAuroraColors = staticCompositionLocalOf { LightAuroraColors }

/** 圆角（设计约定 §2）。 */
val AuroraShapes = Shapes(
    small = RoundedCornerShape(8.dp),
    medium = RoundedCornerShape(12.dp),
    large = RoundedCornerShape(16.dp),
)

/** 字体层级（设计约定 §5，不引入新字体，仅调整字重/行高）。 */
val AuroraTypography = Typography(
    headlineSmall = TextStyle(fontSize = 20.sp, fontWeight = FontWeight.SemiBold, lineHeight = 24.sp),
    titleMedium = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.Medium, lineHeight = 22.sp),
    bodyMedium = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Normal, lineHeight = 20.sp),
    bodySmall = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.Normal, lineHeight = 16.sp),
)

/** 便捷访问：Composable 内取当前主题色，如 `AuroraTheme.colors.primary`。 */
object AuroraTheme {
    val colors: AuroraColorScheme
        @Composable @ReadOnlyComposable get() = LocalAuroraColors.current
}

/**
 * Aurora 主题包装：同时设置 MaterialTheme（对齐 Material 组件默认色）与
 * [LocalAuroraColors]（语义 token，供自绘组件使用）。
 */
@Composable
fun AuroraTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    val colors = if (darkTheme) DarkAuroraColors else LightAuroraColors
    val scheme = if (darkTheme) {
        darkColorScheme(
            primary = colors.primary,
            onPrimary = Color.White,
            background = colors.main,
            onBackground = colors.textPrimary,
            surface = colors.content,
            onSurface = colors.textPrimary,
            surfaceVariant = colors.surface,
            onSurfaceVariant = colors.textSecondary,
            secondary = colors.primary,
            onSecondary = Color.White,
        )
    } else {
        lightColorScheme(
            primary = colors.primary,
            onPrimary = Color.White,
            background = colors.main,
            onBackground = colors.textPrimary,
            surface = colors.content,
            onSurface = colors.textPrimary,
            surfaceVariant = colors.surface,
            onSurfaceVariant = colors.textSecondary,
            secondary = colors.primary,
            onSecondary = Color.White,
        )
    }

    CompositionLocalProvider(LocalAuroraColors provides colors) {
        MaterialTheme(
            colorScheme = scheme,
            shapes = AuroraShapes,
            typography = AuroraTypography,
            content = content,
        )
    }
}
