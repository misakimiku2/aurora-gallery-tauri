package com.aurora.gallery.dialogs

import android.app.Dialog
import android.content.Context
import android.graphics.Color
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.view.Window
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView

/**
 * 来源网址编辑弹窗（单行输入）。
 *
 * 用法：
 * ```kotlin
 * SourceUrlEditDialog(
 *     context = context,
 *     theme = this,
 *     initialUrl = item.sourceUrl,
 *     onSave = { newUrl -> ... }
 * ).show()
 * ```
 */
class SourceUrlEditDialog(
    private val context: Context,
    private val theme: DialogTheme,
    private val initialUrl: String,
    private val onSave: (String) -> Unit
) {
    fun show() {
        val density = DialogUtils.density(context)
        val dialog = Dialog(context)
        dialog.requestWindowFeature(Window.FEATURE_NO_TITLE)
        dialog.setCancelable(true)
        dialog.window?.setBackgroundDrawable(android.graphics.drawable.ColorDrawable(Color.TRANSPARENT))

        val dialogView = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            background = DialogUtils.createRoundedBg(theme.colorDialogBg(), 16f, context = context)
            setPadding((density * 24).toInt(), (density * 24).toInt(), (density * 24).toInt(), (density * 16).toInt())
        }

        dialogView.addView(TextView(context).apply {
            text = "编辑来源网址"
            setTextColor(theme.colorTextPrimary())
            textSize = 16f
            paint.isFakeBoldText = true
            setPadding(0, 0, 0, (density * 16).toInt())
        })

        val input = EditText(context).apply {
            setTextColor(theme.colorTextPrimary())
            textSize = 13f
            setText(initialUrl)
            background = DialogUtils.createRoundedBg(theme.colorTextBoxBg(), 8f, theme.colorBorder(), 1f, context)
            setPadding((density * 12).toInt(), (density * 12).toInt(), (density * 12).toInt(), (density * 12).toInt())
            setSingleLine(true)
            inputType = InputType.TYPE_TEXT_VARIATION_URI
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
        }
        DialogUtils.setItalicHint(input, "https://...", theme)
        dialogView.addView(input)

        val buttonRow = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.END
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply {
                topMargin = (density * 20).toInt()
            }
        }
        buttonRow.addView(DialogUtils.createDialogButton(context, theme, "取消", isPrimary = false) { dialog.dismiss() })
        buttonRow.addView(DialogUtils.createDialogButton(context, theme, "保存", isPrimary = true) {
            onSave(input.text.toString().trim())
            dialog.dismiss()
        })
        dialogView.addView(buttonRow)

        dialog.setContentView(dialogView)
        dialog.show()
        val widthPx = (380 * density).toInt()
        val maxHeightPx = (300 * density).toInt()
        dialogView.measure(
            View.MeasureSpec.makeMeasureSpec(widthPx, View.MeasureSpec.EXACTLY),
            View.MeasureSpec.makeMeasureSpec(maxHeightPx, View.MeasureSpec.AT_MOST)
        )
        dialog.window?.setLayout(widthPx, dialogView.measuredHeight)
    }
}
