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

/**
 * 语义化颜色 token（设计约定 §1）。
 *
 * 值不再写在这里——唯一的色值表是 [AuroraPalette]（Int ARGB），因为纯 View 体系的
 * 查看器/弹窗取不到 `@Composable` 的 token。本类只是它的 Compose 换算层。
 */
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
    val border: Color,        // 边框/描边（M4a 3.3 专题卡片细边框起进 scheme）
    /** 弹窗底色（2026-10-11 起进 Compose 层：M3 AlertDialog 显式 containerColor 用） */
    val dialogBg: Color,
    // —— 专题专属（M4a 3.3，值见 AuroraPalette 字段注释）——
    val topicPink: Color,
    val topicSelectPink: Color,
    val topicGradientStart: Color,
    val topicGradientEnd: Color,
    val primaryDeep: Color,
    val heroSlateStart: Color,
    val heroSlateEnd: Color,
    /** 原始 Int 档，供 View 体系组件（查看器/弹窗）同一张表取色 */
    val palette: AuroraPalette,
)

val LightAuroraColors = AuroraPalettes.light.toComposeColorScheme()

val DarkAuroraColors = AuroraPalettes.dark.toComposeColorScheme()

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
 *
 * 2026-10-11 弹窗主题色修复：M3 的 `AlertDialog` 默认容器色取 `surfaceContainerHigh`
 * 槽位（此前未映射 = Material 基线浅灰/深灰，与 Aurora 色板不符——用户报障「复制弹窗
 * 颜色跟主题不符合」的根源）。这里把 M3 的 surfaceContainer 槽位族统一映射进 Aurora
 * token（container 族 = dialogBg/panel），全仓库的裸 AlertDialog（删除确认/专题/
 * 人物/设置等十余处）随之整体对齐主题，无需逐个显式传色。
 */
@Composable
fun AuroraTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    val colors = AuroraPalettes.of(darkTheme).toComposeColorScheme()
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
            // M3 容器槽位族 → Aurora（AlertDialog/Menu/Sheet 等 M3 组件的实际取色点）
            surfaceContainerLowest = colors.dialogBg,
            surfaceContainerLow = colors.panel,
            surfaceContainer = colors.panel,
            surfaceContainerHigh = colors.dialogBg,
            surfaceContainerHighest = colors.surface,
            // 染色基准用中性 panel：M3 弹窗默认 tonalElevation 会拿 surfaceTint（默认
            // primary 蓝）往容器上叠色，不覆盖会把 dialogBg 染出蓝味
            surfaceTint = colors.panel,
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
            surfaceContainerLowest = colors.dialogBg,
            surfaceContainerLow = colors.panel,
            surfaceContainer = colors.panel,
            surfaceContainerHigh = colors.dialogBg,
            surfaceContainerHighest = colors.surface,
            surfaceTint = colors.panel,
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
