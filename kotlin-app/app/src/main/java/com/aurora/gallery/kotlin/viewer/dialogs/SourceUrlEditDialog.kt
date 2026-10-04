package com.aurora.gallery.kotlin.viewer.dialogs

import android.app.Dialog
import android.content.Context
import android.graphics.Color
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.view.Window
import android.util.Log
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

        // 条数不定，列表区可滚。
        // ⚠️ 高度**不能**写 `0 + weight=1`：父容器是 wrap_content，weight 分不到剩余空间，
        // 实测 ScrollView 拿到 0 高度（logcat 里 boundsInScreen 高度为 0），第二行起就被裁掉看不见。
        // 先给 WRAP_CONTENT，show() 之后按内容实测高度封顶（见文件末尾）。
        val rowsLayout = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
        }
        val scrollView = ScrollView(context).apply {
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
            isFillViewport = false
            addView(rowsLayout)
        }
        dialogView.addView(scrollView)

        val widthPx = (380 * density).toInt()
        val maxHeightPx = (360 * density).toInt()

        /**
         * 行数变了就重算列表高度与弹窗高度。
         *
         * 列表高度必须**显式设成实测值**（不能只靠 WRAP_CONTENT）：弹窗窗口在 show() 之后
         * 被 `setLayout` 固定成测量高度，之后新增的行不会把窗口顶高，列表区不跟着变的话
         * 第二行起就被裁掉（实测：加了行、日志打了「行数 2」，界面仍只有一行）。
         * 列表封顶 = 弹窗上限 - 标题/添加按钮/按钮行，多出来的条数由 ScrollView 自己滚。
         */
        fun syncListHeight() {
            val listWidthPx = widthPx - (2 * (density * 24)).toInt()
            rowsLayout.measure(
                View.MeasureSpec.makeMeasureSpec(listWidthPx, View.MeasureSpec.EXACTLY),
                View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED)
            )
            val capPx = (maxHeightPx - (density * 190).toInt()).coerceAtLeast((density * 96).toInt())
            val listHeightPx = minOf(rowsLayout.measuredHeight, capPx)
            scrollView.layoutParams =
                LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, listHeightPx)
            dialogView.measure(
                View.MeasureSpec.makeMeasureSpec(widthPx, View.MeasureSpec.EXACTLY),
                View.MeasureSpec.makeMeasureSpec(maxHeightPx, View.MeasureSpec.AT_MOST)
            )
            dialog.window?.setLayout(widthPx, minOf(dialogView.measuredHeight, maxHeightPx))
        }

        fun addRow(url: String, focus: Boolean = false) {
            Log.i("SourceUrlEditDialog", "addRow「$url」→ 行数 ${rowsLayout.childCount + 1}")
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
                    syncListHeight()
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
            // 新行要露出来：列表高度 + 弹窗高度都得跟着重算（见 syncListHeight）
            syncListHeight()
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
        // 首次按内容定高；之后每次增删行都会再调一次（syncListHeight）
        syncListHeight()
    }
}
