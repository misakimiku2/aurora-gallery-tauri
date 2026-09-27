package com.aurora.gallery.kotlin.viewer.dialogs

import android.app.Dialog
import android.content.Context
import android.graphics.Color
import android.graphics.Outline
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.StateListDrawable
import android.view.Gravity
import android.view.View
import android.view.ViewOutlineProvider
import android.view.Window
import android.view.WindowManager
import android.widget.LinearLayout
import android.widget.TextView
import com.aurora.gallery.kotlin.ui.theme.withAlpha

/** 更多菜单项 */
data class MoreMenuItem(
    val label: String,
    val textColor: Int,
    val action: () -> Unit
)

/**
 * 更多菜单弹窗（PopupWindow 风格，定位到锚点下方右对齐）。
 *
 * 视觉形制对齐图库页的 AuroraDropdown（M8b 验收）：panel 90% 半透底 + 1dp 描边 +
 * 窗口级圆角投影 + 192dp 宽 + 48dp 行触控；定位修正同 AuroraDropdown（M8b-4）。
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
        // 弹层底色对齐图库 AuroraDropdown（M8b 验收）：panel token 90% 半透替代原
        // 不透明白底 + View 硬投影（后者四角读作锐角）。withAlpha 收 0-255 alpha：
        // 0.9f * 255 ≈ 229.5，取 230 与 Compose copy(alpha = 0.9f) 同值。
        val menuBgColor = withAlpha(theme.colorPanel(), 230)
        val pressedColor = withAlpha(theme.colorAccent(), 50)

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
            // 上下 8dp 与 AuroraDropdown 的 padding(vertical = 8.dp) 同值；不在这里设
            // elevation——半透底下 View 自身硬投影贴边读作锐角，改窗口级（见 show() 后配置块）
            setPadding(0, (density * 8).toInt(), 0, (density * 8).toInt())
        }

        // 192dp 与 AuroraDropdown 的 w-48 同值（原 200dp，图库菜单形制对齐）
        val minItemWidth = (192 * density).toInt()
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
                // 触控 48dp 硬规范：15sp 文字 + 上下 14dp padding 约 44dp，不足下限，
                // 补齐（DialogUtils.createDialogButton 同款处理）
                minHeight = (density * 48).toInt()
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
        // gap 8dp：菜单贴按钮正下方，与 AuroraDropdown 的 gap = 8.dp 一致（原 4dp）
        var menuY = loc[1] + anchor.height + (density * 8).toInt()

        if (menuX < 0) menuX = 0
        if (menuX + measuredWidth > screenWidth) menuX = screenWidth - measuredWidth
        if (menuY + measuredHeight > screenHeight) menuY = screenHeight - measuredHeight
        if (menuY < 0) menuY = 0

        dialog.show()
        dialog.window?.let { window ->
            window.setGravity(Gravity.TOP or Gravity.START)
            val params = window.attributes
            params.x = menuX
            // M8b-4 同款修正（AuroraDropdown / TopBar.kt:836-845 同式）：上面算出的
            // menuX/menuY 是 getLocationOnScreen 的全屏系坐标，而 Dialog 应用子窗口的
            // y 相对父窗口内容框（状态栏之下）——不扣状态栏高度，菜单整体下坠一个状态栏
            // （avd_ai1 实测 142px≈54dp）。anchor 已 attach，rootWindowInsets 非 null；
            // runCatching 兜底异常设备。x 不扣（状态栏只占顶部，水平两系一致）。
            val statusTop = runCatching {
                androidx.core.view.WindowInsetsCompat.toWindowInsetsCompat(anchor.rootWindowInsets)
                    .getInsets(androidx.core.view.WindowInsetsCompat.Type.statusBars()).top
            }.getOrDefault(0)
            params.y = menuY - statusTop
            window.attributes = params
            window.setLayout(measuredWidth, measuredHeight)
            // 窗口级圆角投影（AuroraDropdown TopBar.kt:970-976 同款技法）：投影按窗口
            // outline 的 8dp 圆角绘制、不贴弹层边缘，配 90% 半透面板底观感与图库菜单一致
            window.decorView.outlineProvider = object : ViewOutlineProvider() {
                override fun getOutline(v: View, outline: Outline) {
                    outline.setRoundRect(0, 0, v.width, v.height, density * 8)
                }
            }
            window.setElevation(density * 8)
        }
    }
}
