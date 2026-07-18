package com.aurora.gallery.dialogs

import android.app.Dialog
import android.content.Context
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.StateListDrawable
import android.view.Gravity
import android.view.View
import android.view.Window
import android.view.WindowManager
import android.widget.LinearLayout
import android.widget.TextView

/** 更多菜单项 */
data class MoreMenuItem(
    val label: String,
    val textColor: Int,
    val action: () -> Unit
)

/**
 * 更多菜单弹窗（PopupWindow 风格，定位到锚点下方右对齐）。
 *
 * 用法：
 * ```kotlin
 * MoreMenuPopup(
 *     context = context,
 *     theme = this,
 *     anchor = moreBtn,
 *     menuItems = listOf(
 *         MoreMenuItem("删除", theme.colorDanger()) { showDeleteConfirmDialog() },
 *         MoreMenuItem("重命名", theme.colorTextPrimary()) { showRenameDialog() },
 *         ...
 *     )
 * ).show()
 * ```
 */
class MoreMenuPopup(
    private val context: Context,
    private val theme: DialogTheme,
    private val anchor: View,
    private val menuItems: List<MoreMenuItem>
) {
    fun show() {
        val density = DialogUtils.density(context)
        val menuBgColor = if (theme.isDarkTheme()) Color.parseColor("#262626") else Color.parseColor("#FFFFFF")
        val pressedColor = Color.argb(50, 59, 130, 246)

        val dialog = Dialog(context)
        dialog.requestWindowFeature(Window.FEATURE_NO_TITLE)
        dialog.setCancelable(true)
        dialog.setCanceledOnTouchOutside(true)
        dialog.window?.let { window ->
            window.setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
            window.clearFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND)
        }

        val menuView = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            background = DialogUtils.createRoundedBg(menuBgColor, 8f, theme.colorBorder(), 1f, context)
            setPadding(0, (density * 4).toInt(), 0, (density * 4).toInt())
            elevation = (density * 8).toInt().toFloat()
        }

        val minItemWidth = (200 * density).toInt()
        menuItems.forEach { (label, textColor, action) ->
            val pressedBg = StateListDrawable().apply {
                addState(intArrayOf(android.R.attr.state_pressed), ColorDrawable(pressedColor))
                addState(intArrayOf(), ColorDrawable(Color.TRANSPARENT))
            }
            menuView.addView(TextView(context).apply {
                text = label
                setTextColor(textColor)
                textSize = 15f
                setPadding((density * 16).toInt(), (density * 14).toInt(), (density * 16).toInt(), (density * 14).toInt())
                minWidth = minItemWidth
                background = pressedBg
                layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
                setOnClickListener {
                    dialog.dismiss()
                    action()
                }
            })
        }

        dialog.setContentView(menuView)

        val maxMeasureWidth = (250 * density).toInt()
        val maxMeasureHeight = context.resources.displayMetrics.heightPixels
        menuView.measure(
            View.MeasureSpec.makeMeasureSpec(maxMeasureWidth, View.MeasureSpec.AT_MOST),
            View.MeasureSpec.makeMeasureSpec(maxMeasureHeight, View.MeasureSpec.AT_MOST)
        )
        val measuredWidth = menuView.measuredWidth.coerceAtLeast(minItemWidth)
        val measuredHeight = menuView.measuredHeight

        val loc = IntArray(2)
        anchor.getLocationOnScreen(loc)
        val screenWidth = context.resources.displayMetrics.widthPixels
        val screenHeight = context.resources.displayMetrics.heightPixels

        var menuX = loc[0] + anchor.width - measuredWidth
        var menuY = loc[1] + anchor.height + (density * 4).toInt()

        if (menuX < 0) menuX = 0
        if (menuX + measuredWidth > screenWidth) menuX = screenWidth - measuredWidth
        if (menuY + measuredHeight > screenHeight) menuY = screenHeight - measuredHeight
        if (menuY < 0) menuY = 0

        dialog.show()
        dialog.window?.let { window ->
            window.setGravity(Gravity.TOP or Gravity.START)
            val params = window.attributes
            params.x = menuX
            params.y = menuY
            window.attributes = params
            window.setLayout(measuredWidth, measuredHeight)
        }
    }
}
