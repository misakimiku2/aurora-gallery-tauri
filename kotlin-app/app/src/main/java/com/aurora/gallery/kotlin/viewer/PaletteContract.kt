package com.aurora.gallery.kotlin.viewer

import com.aurora.gallery.kotlin.ui.theme.AuroraPalette
import com.aurora.gallery.kotlin.ui.theme.AuroraPalettes
import com.aurora.gallery.kotlin.viewer.dialogs.DialogTheme

/**
 * [DialogTheme] 的调色板取值实现（拆分清单第 21 刀）：原 NativeGalleryView 直答实现的
 * 15 个 `override colorXxx()` / `isDarkTheme()` 全部只是「读当前 palette 字段」的取值器，
 * 零副作用，故抽成独立委托类，NativeGalleryView 以 `DialogTheme by paletteContract`
 * 实现接口（实例经构造参数传入并默认自建）。
 *
 * 取值器经 [bind] 接上视图的可变状态，每次调用都读最新值——`palette` 字段随暗色主题
 * 切换会整体重赋（isDarkTheme 的 setter），不能构造期捕获快照。bind 在视图 init 里
 * 完成，早于任何附着/弹窗回调；bind 前的取值返回亮色默认值（该窗口期无 UI 可达）。
 *
 * `colorPanel()` 不在此处覆盖：DialogTheme 接口已带默认实现（palette.panel 同值），
 * 与原类的取舍一致，调用点落回接口默认实现，语义零变化。
 */
class PaletteContract : DialogTheme {

    private var paletteNow: () -> AuroraPalette = { AuroraPalettes.of(false) }
    private var darkNow: () -> Boolean = { false }

    /** 由 NativeGalleryView 在 init 里接上可变状态（见类 KDoc）。 */
    fun bind(paletteNow: () -> AuroraPalette, darkNow: () -> Boolean) {
        this.paletteNow = paletteNow
        this.darkNow = darkNow
    }

    override fun isDarkTheme(): Boolean = darkNow()
    override fun colorBorder(): Int = paletteNow().border
    override fun colorTextPrimary(): Int = paletteNow().textPrimary
    override fun colorTextSecondary(): Int = paletteNow().textSecondary
    override fun colorAccent(): Int = paletteNow().primary
    override fun colorTagBg(): Int = paletteNow().tagBg
    override fun colorTagText(): Int = paletteNow().tagText
    override fun colorTagBorder(): Int = paletteNow().tagBorder
    override fun colorTextBoxBg(): Int = paletteNow().textBoxBg
    override fun colorDialogBg(): Int = paletteNow().dialogBg
    override fun colorMenuBg(): Int = paletteNow().menuBg
    override fun colorButtonSecondaryBg(): Int = paletteNow().buttonSecondaryBg
    override fun colorButtonSecondaryText(): Int = paletteNow().buttonSecondaryText

    /** 提示文本颜色（比次文字更淡，纯色无透明度） */
    override fun colorHint(): Int = paletteNow().hint

    override fun colorDanger(): Int = paletteNow().danger
}
