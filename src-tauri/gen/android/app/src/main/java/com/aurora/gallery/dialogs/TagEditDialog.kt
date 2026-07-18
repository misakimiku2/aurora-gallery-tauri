package com.aurora.gallery.dialogs

import android.app.Dialog
import android.content.Context
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.text.TextUtils
import android.view.Gravity
import android.view.View
import android.view.Window
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView

/**
 * 标签编辑弹窗。
 *
 * 用法：
 * ```kotlin
 * TagEditDialog(
 *     context = context,
 *     theme = this,
 *     initialTags = item.tags,
 *     onSave = { newTags -> ... }
 * ).show()
 * ```
 */
class TagEditDialog(
    private val context: Context,
    private val theme: DialogTheme,
    private val initialTags: List<String>,
    private val onSave: (List<String>) -> Unit
) {
    private val localTags = initialTags.toMutableList()

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

        // 标题
        dialogView.addView(TextView(context).apply {
            text = "编辑标签"
            setTextColor(theme.colorTextPrimary())
            textSize = 16f
            paint.isFakeBoldText = true
            setPadding(0, 0, 0, (density * 16).toInt())
        })

        // 标签列表
        val chipsBox = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
        }
        dialogView.addView(chipsBox)

        // 输入行
        val inputRow = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply {
                topMargin = (density * 12).toInt()
            }
            gravity = Gravity.CENTER_VERTICAL
        }
        val input = EditText(context).apply {
            setTextColor(theme.colorTextPrimary())
            textSize = 14f
            background = DialogUtils.createRoundedBg(theme.colorTextBoxBg(), 8f, theme.colorBorder(), 1f, context)
            setPadding((density * 12).toInt(), (density * 12).toInt(), (density * 12).toInt(), (density * 12).toInt())
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
            setSingleLine(true)
        }
        DialogUtils.setItalicHint(input, "新标签", theme)
        val widthPx = (380 * density).toInt()
        val maxHeightPx = (450 * density).toInt()
        fun relayoutTagDialog() {
            dialogView.measure(
                View.MeasureSpec.makeMeasureSpec(widthPx, View.MeasureSpec.EXACTLY),
                View.MeasureSpec.makeMeasureSpec(maxHeightPx, View.MeasureSpec.AT_MOST)
            )
            dialog.window?.setLayout(widthPx, dialogView.measuredHeight)
        }
        val addButton = TextView(context).apply {
            text = "+"
            setTextColor(Color.WHITE)
            textSize = 18f
            gravity = Gravity.CENTER
            background = DialogUtils.createRoundedBg(theme.colorAccent(), 8f, context = context)
            setOnClickListener {
                val tag = input.text.toString().trim()
                if (tag.isNotEmpty() && tag !in localTags) {
                    localTags.add(tag)
                    input.text.clear()
                    refreshTagChips(chipsBox, localTags) { removedTag ->
                        localTags.remove(removedTag)
                        refreshTagChips(chipsBox, localTags) {}
                        relayoutTagDialog()
                    }
                    relayoutTagDialog()
                }
            }
            layoutParams = LinearLayout.LayoutParams((density * 44).toInt(), (density * 44).toInt()).apply {
                marginStart = (density * 8).toInt()
            }
        }
        inputRow.addView(input)
        inputRow.addView(addButton)
        dialogView.addView(inputRow)

        refreshTagChips(chipsBox, localTags) { removedTag ->
            localTags.remove(removedTag)
            refreshTagChips(chipsBox, localTags) {}
            relayoutTagDialog()
        }

        // 按钮行
        val buttonRow = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.END
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply {
                topMargin = (density * 20).toInt()
            }
        }
        buttonRow.addView(DialogUtils.createDialogButton(context, theme, "取消", isPrimary = false) { dialog.dismiss() })
        buttonRow.addView(DialogUtils.createDialogButton(context, theme, "保存", isPrimary = true) {
            onSave(localTags.toList())
            dialog.dismiss()
        })
        dialogView.addView(buttonRow)

        dialog.setContentView(dialogView)
        dialog.show()
        relayoutTagDialog()
    }

    private fun refreshTagChips(container: LinearLayout, tags: List<String>, onRemove: (String) -> Unit) {
        container.removeAllViews()
        val density = DialogUtils.density(context)
        if (tags.isEmpty()) {
            container.addView(TextView(context).apply {
                text = "（无标签）"
                setTextColor(theme.colorTextSecondary())
                textSize = 13f
                setPadding(0, (density * 8).toInt(), 0, (density * 8).toInt())
            })
            return
        }
        tags.forEach { tag ->
            val row = LinearLayout(context).apply {
                orientation = LinearLayout.HORIZONTAL
                layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply {
                    topMargin = (density * 6).toInt()
                }
                gravity = Gravity.CENTER_VERTICAL
                val drawable = GradientDrawable().apply {
                    cornerRadius = density * 16
                    setColor(theme.colorTagBg())
                    setStroke((density * 1).toInt(), theme.colorTagBorder())
                }
                background = drawable
                setPadding((density * 14).toInt(), (density * 10).toInt(), (density * 10).toInt(), (density * 10).toInt())
            }
            row.addView(TextView(context).apply {
                text = tag
                setTextColor(theme.colorTagText())
                textSize = 14f
                maxEms = 14
                ellipsize = TextUtils.TruncateAt.END
                setSingleLine(true)
            })
            val removeBtn = TextView(context).apply {
                text = "✕"
                setTextColor(Color.parseColor("#EF4444"))
                textSize = 15f
                val minTouch = (density * 32).toInt()
                minWidth = minTouch
                minHeight = minTouch
                gravity = Gravity.CENTER
                setOnClickListener { onRemove(tag) }
            }
            row.addView(removeBtn)
            container.addView(row)
        }
    }
}
