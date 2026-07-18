package com.aurora.gallery.dialogs

import android.app.Dialog
import android.content.Context
import android.graphics.Color
import android.view.Gravity
import android.view.Window
import android.view.WindowManager
import android.widget.LinearLayout
import android.widget.TextView

/**
 * 删除确认弹窗（UI 与 WebView ConfirmModal 一致）。
 *
 * 用法：
 * ```kotlin
 * DeleteConfirmDialog(
 *     context = context,
 *     theme = this,
 *     fileName = item.name,
 *     onConfirm = { confirmDelete(item.fileId) }
 * ).show()
 * ```
 */
class DeleteConfirmDialog(
    private val context: Context,
    private val theme: DialogTheme,
    private val fileName: String,
    private val onConfirm: () -> Unit,
    private val onCancel: () -> Unit = {}
) {
    fun show() {
        val density = DialogUtils.density(context)
        val dialog = Dialog(context)
        dialog.requestWindowFeature(Window.FEATURE_NO_TITLE)
        dialog.window?.setBackgroundDrawable(android.graphics.drawable.ColorDrawable(Color.TRANSPARENT))
        dialog.setOnCancelListener { onCancel() }

        val container = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            background = DialogUtils.createRoundedBg(theme.colorDialogBg(), 12f, theme.colorBorder(), 1f, context)
            setPadding((density * 24).toInt(), (density * 20).toInt(), (density * 24).toInt(), (density * 16).toInt())
        }

        // 标题
        container.addView(TextView(context).apply {
            text = "确认删除"
            setTextColor(theme.colorTextPrimary())
            textSize = 18f
            setPadding(0, 0, 0, (density * 8).toInt())
        })

        // 消息
        container.addView(TextView(context).apply {
            text = "确认删除 \"$fileName\" ?"
            setTextColor(theme.colorTextPrimary())
            textSize = 14f
            setPadding(0, 0, 0, (density * 8).toInt())
        })

        // 子消息（文件名，灰底圆角）
        container.addView(TextView(context).apply {
            text = fileName
            setTextColor(theme.colorTextSecondary())
            textSize = 12f
            setPadding((density * 8).toInt(), (density * 8).toInt(), (density * 8).toInt(), (density * 8).toInt())
            background = DialogUtils.createRoundedBg(theme.colorTextBoxBg(), 8f, theme.colorBorder(), 1f, context)
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply {
                bottomMargin = (density * 24).toInt()
            }
        })

        // 按钮行
        val buttonRow = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.END
        }
        buttonRow.addView(DialogUtils.createDialogButton(context, theme, "取消", isPrimary = false) { dialog.dismiss() })
        buttonRow.addView(DialogUtils.createDialogButton(context, theme, "删除", isPrimary = true) {
            onConfirm()
            dialog.dismiss()
        })
        container.addView(buttonRow)

        dialog.setContentView(container)
        dialog.show()
        val widthPx = (320 * density).toInt()
        dialog.window?.setLayout(widthPx, WindowManager.LayoutParams.WRAP_CONTENT)
    }
}
