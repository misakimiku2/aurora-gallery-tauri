package com.aurora.gallery.kotlin.ui.theme

import androidx.compose.ui.graphics.Color

/**
 * 唯一的色值表（M3 1.2 的落点）。
 *
 * 存在理由：查看器与弹窗是纯 View 体系，取不到 `@Composable` 的 `AuroraTheme.colors`，
 * 此前它在 `NativeGalleryView` 内自带一份 `Color.parseColor` 表，与 M1 的 Compose token
 * 是两套值——「桌面/移动一张脸」的原则正好在这里最容易破。现在两边都从本表取值：
 * Compose 侧由 [AuroraColorScheme] 包一层 `Color(...)`，View 侧直接用 Int。
 *
 * 取值规则：八个与 M1 共用的角色沿用既有 token 值（改动会让已封版的 M1 网格变色）；
 * 查看器独有的弹窗/标签/占位角色沿用查看器原值。深色档目前不渲染——M1 固定浅色
 * （`MainActivity` 的 `AuroraTheme(darkTheme = false)`），查看器跟随同一开关。
 */
data class AuroraPalette(
    // —— 与 M1 网格共用的八个角色（值须与 AuroraColorScheme 的历史值一致）——
    val main: Int,
    val content: Int,
    val panel: Int,
    val surface: Int,
    val subtle: Int,
    val primary: Int,
    val primaryWeak: Int,
    val textPrimary: Int,
    val textSecondary: Int,
    // —— 查看器 / 弹窗独有角色 ——
    val border: Int,
    /** 弹窗底色（比 [panel] 更实，不带面板灰） */
    val dialogBg: Int,
    /** 「更多」菜单弹层底色 */
    val menuBg: Int,
    /** 文本输入框底色 */
    val textBoxBg: Int,
    /** 图片占位底（抽屉预览图未加载出来时） */
    val placeholderBg: Int,
    /** 主色调提取中的脉冲骨架块 */
    val skeletonBg: Int,
    /** 色块描边（半透明，深浅各一档） */
    val hairline: Int,
    val hint: Int,
    val buttonSecondaryBg: Int,
    val buttonSecondaryText: Int,
    val tagBg: Int,
    val tagText: Int,
    val tagBorder: Int,
    val danger: Int,
)

/** 取色：`AuroraPalettes.of(dark)`。查看器与 Compose 主题共用这一处分支。 */
object AuroraPalettes {
    val light = AuroraPalette(
        main = 0xFFE5E5E5.toInt(),
        content = 0xFFFFFFFF.toInt(),
        // 2026-09-20 曾按用户要求提深到 #E5E5E5，实测观感突兀后用户要求改回桌面 bg-panel 同款
        panel = 0xFFF7F7F7.toInt(),
        surface = 0xFFE5E7EB.toInt(),
        subtle = 0xFFE5E7EB.toInt(),
        primary = 0xFF3B82F6.toInt(),
        primaryWeak = 0xCC3B82F6.toInt(),
        textPrimary = 0xFF1E293B.toInt(),
        textSecondary = 0xFF737373.toInt(),
        border = 0xFFE5E7EB.toInt(),
        dialogBg = 0xFFFFFFFF.toInt(),
        menuBg = 0xFFFFFFFF.toInt(),
        textBoxBg = 0xFFF9FAFB.toInt(),
        placeholderBg = 0xFFF3F4F6.toInt(),
        skeletonBg = 0xFFD4D4D4.toInt(),
        hairline = 0x10000000.toInt(),
        hint = 0xFF9CA3AF.toInt(),
        buttonSecondaryBg = 0xFFE5E7EB.toInt(),
        buttonSecondaryText = 0xFF404040.toInt(),
        tagBg = 0xFFEFF6FF.toInt(),
        tagText = 0xFF2563EB.toInt(),
        tagBorder = 0xFFDBEAFE.toInt(),
        danger = 0xFFEF4444.toInt(),
    )

    val dark = AuroraPalette(
        main = 0xFF1A1A1A.toInt(),
        content = 0xFF262626.toInt(),
        panel = 0xFF2A2A2A.toInt(),
        surface = 0xFF3A3A3A.toInt(),
        subtle = 0xFF404040.toInt(),
        primary = 0xFF3B82F6.toInt(),
        primaryWeak = 0xCC60A5FA.toInt(),
        textPrimary = 0xFFE5E5E5.toInt(),
        textSecondary = 0xFFA3A3A3.toInt(),
        border = 0xFF262626.toInt(),
        dialogBg = 0xFF1E1E1E.toInt(),
        menuBg = 0xFF262626.toInt(),
        textBoxBg = 0xFF262626.toInt(),
        placeholderBg = 0xFF262626.toInt(),
        skeletonBg = 0xFF404040.toInt(),
        hairline = 0x1FFFFFFF.toInt(),
        hint = 0xFF6B7280.toInt(),
        buttonSecondaryBg = 0xFF404040.toInt(),
        buttonSecondaryText = 0xFFA3A3A3.toInt(),
        tagBg = 0x331E3A8A.toInt(),
        tagText = 0xFF93C5FD.toInt(),
        tagBorder = 0x551E40AF.toInt(),
        danger = 0xFFF87171.toInt(),
    )

    fun of(dark: Boolean): AuroraPalette = if (dark) this.dark else light
}

/** Compose 侧的换算：token 表是 Int ARGB，Compose 要 [Color]。 */
fun AuroraPalette.toComposeColorScheme(): AuroraColorScheme = AuroraColorScheme(
    main = Color(main),
    content = Color(content),
    panel = Color(panel),
    surface = Color(surface),
    subtle = Color(subtle),
    primary = Color(primary),
    primaryWeak = Color(primaryWeak),
    textPrimary = Color(textPrimary),
    textSecondary = Color(textSecondary),
    palette = this,
)

/** 在 [color] 上换一层透明度（查看器顶栏/缩略图条的半透明底 = 主背景 @ 不同 alpha）。 */
fun withAlpha(color: Int, alpha: Int): Int = (color and 0x00FFFFFF) or (alpha shl 24)
