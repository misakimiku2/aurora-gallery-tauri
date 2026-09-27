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
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import com.aurora.gallery.kotlin.ui.theme.withAlpha

/**
 * 更多菜单项
 *
 * @param iconRes 行首图标资源（lucide 线性 VectorDrawable，如 R.drawable.ic_lucide_trash）。
 *   渲染时 setColorFilter(textColor) 随文字色着色——「删除」红字时图标同步读作危险色；
 *   0 表示无图标，该行退化为纯文字。默认 0 让尚未接线的旧调用点可编译（最终所有调用点
 *   都会显式传图标）。**必须声明在 [action] 之前**：Kotlin 尾随 lambda 只能绑定声明的
 *   最后一个参数，iconRes 若排在其后，「named iconRes + 尾随 lambda 传 action」的调用形
 *   会报 No value passed for parameter 'action'（M8b-8 编译实测）。
 */
data class MoreMenuItem(
    val label: String,
    val textColor: Int,
    val iconRes: Int = 0,
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
 *         MoreMenuItem("删除", theme.colorDanger(), iconRes = R.drawable.ic_lucide_trash) { showDeleteConfirmDialog() },
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
        menuItems.forEach { item ->
            val pressedBg = StateListDrawable().apply {
                addState(intArrayOf(android.R.attr.state_pressed), ColorDrawable(pressedColor))
                addState(intArrayOf(), ColorDrawable(Color.TRANSPARENT))
            }
            // 每项包一层横排行容器（图标 + 文字）：pressed 背景与点击监听都挂这层，
            // 触控热区/反馈覆盖整行含图标区——拆成两个 View 后若仍挂文字层，图标区会
            // 变成不可点死区
            val rowView = LinearLayout(context).apply {
                orientation = LinearLayout.HORIZONTAL
                // 横排容器默认顶对齐，20dp 图标与 15sp 文字会错位，垂直居中
                gravity = Gravity.CENTER_VERTICAL
                // 触控 48dp 硬规范与 192dp 宽度下限原在 TextView 上，随背景/点击一并挪到
                // 行容器（15sp 文字 + 上下 14dp padding 约 44dp，不足下限，补齐；
                // DialogUtils.createDialogButton 同款处理）。注意 LinearLayout 是普通
                // View：属性名是 minimumWidth/minimumHeight（minWidth/minHeight 是
                // TextView 专属）
                minimumHeight = (density * 48).toInt()
                minimumWidth = minItemWidth
                // 左缘 16dp 由行容器承担：无图标纯文字行与旧版（文字左右各 16dp 内缩）
                // 观感一致；右缘由文字层 padRight 16dp 承担，行容器不重复给
                setPadding((density * 16).toInt(), 0, 0, 0)
                background = pressedBg
                layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
                setOnClickListener {
                    dialog.dismiss()
                    item.action()
                }
            }
            // 行首 lucide 线性图标：setColorFilter(textColor) 色随文字（删除红字时图标
            // 同步读作危险色，不依赖图标资源固有色）；iconRes==0 不实例化，纯文字行
            // 无空占位、与旧版观感一致
            if (item.iconRes != 0) {
                rowView.addView(ImageView(context).apply {
                    setImageResource(item.iconRes)
                    setColorFilter(item.textColor)
                    layoutParams = LinearLayout.LayoutParams((density * 20).toInt(), (density * 20).toInt()).apply {
                        // 图标→文字 12dp 间距由图标 marginEnd 承担（文字层左 padding 归 0）
                        marginEnd = (density * 12).toInt()
                    }
                })
            }
            rowView.addView(TextView(context).apply {
                text = item.label
                setTextColor(item.textColor)
                textSize = 15f
                // 左 0：与图标的间距由图标 marginEnd 管；右 16dp 维持行尾留白（原 16dp）
                setPadding(0, (density * 14).toInt(), (density * 16).toInt(), (density * 14).toInt())
            })
            menuView.addView(rowView)
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
            // 显示后自校准（M8b-9）：上面的 statusTop 扣减建立在「insets 与父窗口内容框
            // 同步」的假设上——查看器有沉浸/系统栏隐藏态（用户真机实测：状态栏隐藏时
            // 菜单仍下坠一个 statusTop，insets 已报 0 而子窗口内容框原点滞后）。这里读
            // 弹窗实际落点与目标屏幕坐标（menuX/menuY，锚点 getLocationOnScreen 系）的
            // 差值一次修正——对任何坐标系偏差自洽，不再依赖系统栏状态假设。
            menuView.post {
                val actual = IntArray(2)
                window.decorView.getLocationOnScreen(actual)
                val dx = menuX - actual[0]
                val dy = menuY - actual[1]
                if (dx != 0 || dy != 0) {
                    val p = window.attributes
                    p.x += dx
                    p.y += dy
                    window.attributes = p
                }
            }
        }
    }
}
