package com.aurora.gallery.kotlin.viewer.dialogs

import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.text.SpannableString
import android.text.Spanned
import android.text.style.StyleSpan
import android.util.DisplayMetrics
import android.view.Gravity
import android.view.View
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import com.aurora.gallery.kotlin.ui.theme.AuroraPalettes

/**
 * 弹窗主题接口。由 NativeGalleryView 实现，提供颜色和密度信息。
 * 所有弹窗组件通过此接口获取主题色，实现解耦。
 *
 * 颜色不在这份接口里写死：实现方从 `AuroraPalette`（唯一的色值表）取值，弹窗与 M1 网格
 * 因此始终是同一套 token。带默认实现的角色（[colorDanger] / [colorMenuBg]）直接查表，
 * 免得每个实现方各抄一份。
 */
interface DialogTheme {
    fun isDarkTheme(): Boolean
    fun colorDialogBg(): Int
    fun colorTextBoxBg(): Int
    fun colorTextPrimary(): Int
    fun colorTextSecondary(): Int
    fun colorBorder(): Int
    fun colorAccent(): Int
    fun colorHint(): Int
    fun colorButtonSecondaryBg(): Int
    fun colorButtonSecondaryText(): Int
    fun colorTagBg(): Int
    fun colorTagText(): Int
    fun colorTagBorder(): Int
    /** 危险色（删除按钮红色） */
    fun colorDanger(): Int = AuroraPalettes.of(isDarkTheme()).danger
    /** 「更多」菜单弹层底色 */
    fun colorMenuBg(): Int = AuroraPalettes.of(isDarkTheme()).menuBg
}

/**
 * 弹窗通用工具：圆角背景、按钮、斜体提示等。
 * 所有方法都接收 [DialogTheme] 以获取主题色，接收 [Context] 以获取资源。
 */
object DialogUtils {

    /** 获取密度（dp→px 转换用） */
    fun density(context: Context): Float = context.resources.displayMetrics.density

    /** 创建圆角矩形背景 */
    fun createRoundedBg(
        bgColor: Int,
        cornerRadiusDp: Float,
        borderColor: Int? = null,
        strokeWidthDp: Float = 0f,
        context: Context
    ): GradientDrawable {
        val d = density(context)
        return GradientDrawable().apply {
            shape = GradientDrawable.RECTANGLE
            setColor(bgColor)
            cornerRadius = cornerRadiusDp * d
            if (borderColor != null) setStroke((strokeWidthDp * d).toInt(), borderColor)
        }
    }

    /** 创建弹窗按钮（主/次样式） */
    fun createDialogButton(
        context: Context,
        theme: DialogTheme,
        text: String,
        isPrimary: Boolean,
        onClick: () -> Unit
    ): TextView {
        val d = density(context)
        return TextView(context).apply {
            this.text = text
            textSize = 13f
            gravity = Gravity.CENTER
            setTextColor(if (isPrimary) Color.WHITE else theme.colorButtonSecondaryText())
            setPadding((d * 20).toInt(), (d * 10).toInt(), (d * 20).toInt(), (d * 10).toInt())
            // 13sp 文字 + 上下 10dp padding 只有约 45dp，差 3dp 不到移动端下限；这里补齐，
            // 全部查看器弹窗的取消/保存一次改到位。
            minHeight = (d * 48).toInt()
            background = createRoundedBg(
                if (isPrimary) theme.colorAccent() else theme.colorButtonSecondaryBg(),
                8f,
                if (isPrimary) null else theme.colorBorder(),
                if (isPrimary) 0f else 1f,
                context
            )
            setOnClickListener { onClick() }
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply {
                marginStart = (d * 8).toInt()
            }
        }
    }

    /** 设置斜体提示文本（hint），用于区分占位提示与正文输入 */
    fun setItalicHint(editText: EditText, hintText: String, theme: DialogTheme) {
        val spannable = SpannableString(hintText)
        spannable.setSpan(
            StyleSpan(Typeface.ITALIC),
            0, hintText.length,
            Spanned.SPAN_EXCLUSIVE_EXCLUSIVE
        )
        editText.setHint(spannable)
        editText.setHintTextColor(theme.colorHint())
    }
}
