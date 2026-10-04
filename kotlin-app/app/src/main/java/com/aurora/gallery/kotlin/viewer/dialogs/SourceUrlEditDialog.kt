package com.aurora.gallery.kotlin.viewer.dialogs

import android.app.Dialog
import android.content.Context
import android.graphics.Color
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.view.Window
import android.widget.EditText
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView

/**
 * 来源网址编辑弹窗（**多值**：每条一行，可增删）。
 *
 * P1(b)：一张图可以有多个来源网址（库里是 JSON 数组，顺序即显示顺序）。
 * 保存是**整体覆盖**语义——弹窗里剩几条就写几条，删空 = 清空。
 *
 * 用法：
 * ```kotlin
 * SourceUrlEditDialog(
 *     context = context,
 *     theme = this,
 *     initialUrls = item.sourceUrls,
 *     onSave = { urls -> ... }
 * ).show()
 * ```
 */
class SourceUrlEditDialog(
    private val context: Context,
    private val theme: DialogTheme,
    private val initialUrls: List<String>,
    private val onSave: (List<String>) -> Unit
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

        // 条数不定，列表区可滚；弹窗总高封顶（见底部 setLayout），滚的是这块内容
        val rowsLayout = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
        }
        val scrollView = ScrollView(context).apply {
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f)
            isFillViewport = false
            addView(rowsLayout)
        }
        dialogView.addView(scrollView)

        fun addRow(url: String, focus: Boolean = false) {
            val row = LinearLayout(context).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = android.view.Gravity.CENTER_VERTICAL
                layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply {
                    bottomMargin = (density * 8).toInt()
                }
            }
            val input = EditText(context).apply {
                setTextColor(theme.colorTextPrimary())
                textSize = 13f
                setText(url)
                background = DialogUtils.createRoundedBg(theme.colorTextBoxBg(), 8f, theme.colorBorder(), 1f, context)
                setPadding((density * 12).toInt(), (density * 12).toInt(), (density * 12).toInt(), (density * 12).toInt())
                setSingleLine(true)
                inputType = InputType.TYPE_TEXT_VARIATION_URI
                layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
            }
            DialogUtils.setItalicHint(input, "https://...", theme)
            row.addView(input)

            // 删除这一行；删到最后一行时保留一个空行（否则弹窗里没处再添加）
            val remove = ImageView(context).apply {
                setImageResource(com.aurora.gallery.kotlin.R.drawable.ic_lucide_x)
                // lucide 线性图标靠着色上色（不依赖资源固有色），与 FolderPicker 的清除按钮同款
                setColorFilter(theme.colorTextSecondary())
                setPadding((density * 4).toInt(), 0, 0, 0)
                layoutParams = LinearLayout.LayoutParams((density * 32).toInt(), (density * 32).toInt()).apply {
                    marginStart = (density * 8).toInt()
                }
                contentDescription = "删除这条"
                setOnClickListener {
                    if (rowsLayout.childCount > 1) {
                        rowsLayout.removeView(row)
                    } else {
                        input.setText("")
                    }
                }
            }
            row.addView(remove)
            rowsLayout.addView(row)
            if (focus) {
                input.requestFocus()
                input.setSelection(input.text.length)
            }
        }

        if (initialUrls.isEmpty()) {
            addRow("")
        } else {
            initialUrls.forEach { addRow(it) }
        }

        dialogView.addView(DialogUtils.createDialogButton(context, theme, "+ 添加一条", isPrimary = false) {
            addRow("", focus = true)
        }.apply {
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply {
                topMargin = (density * 12).toInt()
            }
        })

        val buttonRow = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.END
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply {
                topMargin = (density * 20).toInt()
            }
        }
        buttonRow.addView(DialogUtils.createDialogButton(context, theme, "取消", isPrimary = false) { dialog.dismiss() })
        buttonRow.addView(DialogUtils.createDialogButton(context, theme, "保存", isPrimary = true) {
            // 空行与重复不计：库里不存空网址，重复那条也没有意义（与导入侧去重同口径）
            val urls = ArrayList<String>()
            repeat(rowsLayout.childCount) { i ->
                val row = rowsLayout.getChildAt(i) as? LinearLayout ?: return@repeat
                val input = row.getChildAt(0) as? EditText ?: return@repeat
                val text = input.text.toString().trim()
                if (text.isNotEmpty() && urls.none { it == text }) urls.add(text)
            }
            onSave(urls)
            dialog.dismiss()
        })
        dialogView.addView(buttonRow)

        dialog.setContentView(dialogView)
        dialog.show()
        val widthPx = (380 * density).toInt()
        val maxHeightPx = (360 * density).toInt()
        dialogView.measure(
            View.MeasureSpec.makeMeasureSpec(widthPx, View.MeasureSpec.EXACTLY),
            View.MeasureSpec.makeMeasureSpec(maxHeightPx, View.MeasureSpec.AT_MOST)
        )
        dialog.window?.setLayout(widthPx, minOf(dialogView.measuredHeight, maxHeightPx))
    }
}
