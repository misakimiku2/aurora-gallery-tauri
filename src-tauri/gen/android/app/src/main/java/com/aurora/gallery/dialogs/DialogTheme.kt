package com.aurora.gallery.dialogs

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

/**
 * 弹窗主题接口。由 NativeGalleryView 实现，提供颜色和密度信息。
 * 所有弹窗组件通过此接口获取主题色，实现解耦。
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
    fun colorDanger(): Int =
        if (isDarkTheme()) Color.parseColor("#F87171") else Color.parseColor("#EF4444")
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
