package com.aurora.gallery.kotlin.viewer.dialogs

import android.app.AlertDialog
import android.content.Context
import android.graphics.Color
import android.view.Gravity
import android.view.View
import android.widget.EditText
import android.widget.LinearLayout
import androidx.appcompat.content.res.AppCompatResources
import androidx.appcompat.widget.AppCompatButton
import androidx.core.graphics.drawable.DrawableCompat
import com.aurora.gallery.kotlin.R

/**
 * 重命名弹窗（使用系统 AlertDialog）。
 *
 * [onAiRename] 非 null 时在输入框下方追加「AI 重命名」按钮（2026-10-11 长按菜单精简：
 * AI 重命名从菜单撤下收进这里，仅 AI 服务器已连接时由调用方传入）——点击即关闭本弹窗
 * 并触发 AI 生成，名字提案经 AI 改名确认弹窗回流（桌面同位是元数据面板文件名旁的
 * AI 按钮，两段式「生成 → 确认」同构）。LAN 远端项不传此参：提案管线读本机字节，
 * 对远端图无意义。
 *
 * 用法：
 * ```kotlin
 * RenameDialog(
 *     context = context,
 *     currentName = item.name,
 *     onConfirm = { newName -> ... }
 * ).show()
 * ```
 */
class RenameDialog(
    private val context: Context,
    private val currentName: String,
    private val onConfirm: (String) -> Unit,
    /** AI 重命名按钮（null=不显示）：点击回调（宿主拉起 AI 改名管线）。 */
    private val onAiRename: (() -> Unit)? = null,
) {
    fun show() {
        val input = EditText(context).apply {
            setText(currentName)
            setSingleLine(true)
            setPadding(48, 24, 48, 24)
        }
        // 有 AI 按钮时包一层纵向容器（输入框 + 右对齐按钮）；否则维持裸 EditText 旧形制。
        // 按钮紫 = 桌面 AI 项同款 purple-600（AuroraPalette topicGradientEnd 同源）；
        // lucide 线稿固有色是黑，drawable tint 与文字同紫（MoreMenuPopup setColorFilter 同款口径）
        var aiButton: AppCompatButton? = null
        val contentView: View = if (onAiRename != null) {
            val aiPurple = Color.parseColor("#9333EA")
            val density = context.resources.displayMetrics.density
            LinearLayout(context).apply {
                orientation = LinearLayout.VERTICAL
                addView(input)
                aiButton = AppCompatButton(context).apply {
                    text = "AI 重命名"
                    isAllCaps = false
                    textSize = 14f
                    background = null
                    setTextColor(aiPurple)
                    AppCompatResources.getDrawable(context, R.drawable.ic_lucide_sparkles)?.mutate()?.let { d ->
                        val iconPx = (18 * density).toInt()
                        d.setBounds(0, 0, iconPx, iconPx)
                        DrawableCompat.setTint(d, aiPurple)
                        setCompoundDrawables(d, null, null, null)
                    }
                    compoundDrawablePadding = (8 * density).toInt()
                    minHeight = (48 * density).toInt()
                    gravity = Gravity.CENTER or Gravity.LEFT
                }
                addView(
                    aiButton,
                    LinearLayout.LayoutParams(
                        LinearLayout.LayoutParams.WRAP_CONTENT,
                        LinearLayout.LayoutParams.WRAP_CONTENT,
                    ),
                )
            }
        } else {
            input
        }
        val dialog = AlertDialog.Builder(context)
            .setTitle("重命名")
            .setView(contentView)
            .setPositiveButton("保存") { _, _ ->
                val newName = input.text.toString().trim()
                if (newName.isNotEmpty() && newName != currentName) {
                    onConfirm(newName)
                }
            }
            .setNegativeButton("取消", null)
            .create()
        aiButton?.setOnClickListener {
            dialog.dismiss()
            onAiRename?.invoke()
        }
        dialog.show()
    }
}
