package com.aurora.gallery.dialogs

import android.app.Dialog
import android.content.Context
import android.graphics.Color
import android.view.Gravity
import android.view.View
import android.view.Window
import android.view.WindowManager
import android.widget.LinearLayout
import android.widget.RadioButton
import android.widget.RadioGroup
import android.widget.SeekBar
import android.widget.Switch
import android.widget.TextView
import org.json.JSONObject

/** 幻灯片配置 */
data class SlideshowConfig(
    val intervalMs: Long,
    val transition: String,
    val isRandom: Boolean,
    val enableZoom: Boolean
)

/**
 * 幻灯片设置弹窗。
 *
 * 用法：
 * ```kotlin
 * SlideshowSettingsDialog(
 *     context = context,
 *     theme = this,
 *     initialConfig = SlideshowConfig(slideshowIntervalMs, slideshowTransition, slideshowRandom, slideshowZoom),
 *     onConfirm = { newConfig -> ... },
 *     onConfigJsonReady = { json -> listener?.onUpdateSlideshowConfig(json) }
 * ).show()
 * ```
 */
class SlideshowSettingsDialog(
    private val context: Context,
    private val theme: DialogTheme,
    private val initialConfig: SlideshowConfig,
    private val onConfirm: (SlideshowConfig) -> Unit
) {
    fun show() {
        val density = DialogUtils.density(context)
        val dialog = Dialog(context)
        dialog.requestWindowFeature(Window.FEATURE_NO_TITLE)
        dialog.window?.setBackgroundDrawable(android.graphics.drawable.ColorDrawable(Color.TRANSPARENT))

        val container = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            background = DialogUtils.createRoundedBg(theme.colorDialogBg(), 12f, theme.colorBorder(), 1f, context)
            setPadding((density * 24).toInt(), (density * 20).toInt(), (density * 24).toInt(), (density * 16).toInt())
        }

        container.addView(TextView(context).apply {
            text = "幻灯片设置"
            setTextColor(theme.colorTextPrimary())
            textSize = 18f
            setPadding(0, 0, 0, (density * 16).toInt())
        })

        // 播放间隔
        val intervalLabel = TextView(context).apply {
            text = "播放间隔：${initialConfig.intervalMs / 1000} 秒"
            setTextColor(theme.colorTextPrimary())
            textSize = 14f
            setPadding(0, (density * 8).toInt(), 0, (density * 4).toInt())
        }
        container.addView(intervalLabel)
        val intervalSeekBar = SeekBar(context).apply {
            max = 19
            progress = ((initialConfig.intervalMs / 1000) - 1).toInt().coerceIn(0, 19)
            setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
                override fun onProgressChanged(seekBar: SeekBar?, progress: Int, fromUser: Boolean) {
                    intervalLabel.text = "播放间隔：${progress + 1} 秒"
                }
                override fun onStartTrackingTouch(seekBar: SeekBar?) {}
                override fun onStopTrackingTouch(seekBar: SeekBar?) {}
            })
        }
        container.addView(intervalSeekBar)

        // 过渡效果
        container.addView(TextView(context).apply {
            text = "过渡效果"
            setTextColor(theme.colorTextPrimary())
            textSize = 14f
            setPadding(0, (density * 16).toInt(), 0, (density * 4).toInt())
        })
        val radioGroup = RadioGroup(context).apply { orientation = RadioGroup.VERTICAL }
        val transitions = listOf("none" to "无", "fade" to "淡入淡出", "slide" to "平滑移动")
        var selectedTransition = initialConfig.transition
        val transitionIds = HashMap<String, Int>()
        var defaultCheckId = View.NO_ID
        transitions.forEach { (value, label) ->
            val viewId = View.generateViewId()
            transitionIds[value] = viewId
            if (value == selectedTransition) defaultCheckId = viewId
            radioGroup.addView(RadioButton(context).apply {
                id = viewId
                text = label
                setTextColor(theme.colorTextPrimary())
            })
        }
        if (defaultCheckId != View.NO_ID) radioGroup.check(defaultCheckId)
        radioGroup.setOnCheckedChangeListener { _, checkedId ->
            transitionIds.entries.firstOrNull { it.value == checkedId }?.let { (value, _) ->
                selectedTransition = value
            }
        }
        container.addView(radioGroup)

        // 图片逐渐放大
        val zoomSwitch = Switch(context).apply {
            text = "图片逐渐放大"
            setTextColor(theme.colorTextPrimary())
            isChecked = initialConfig.enableZoom
            setPadding(0, (density * 12).toInt(), 0, (density * 4).toInt())
        }
        container.addView(zoomSwitch)

        // 随机播放
        val randomSwitch = Switch(context).apply {
            text = "随机播放"
            setTextColor(theme.colorTextPrimary())
            isChecked = initialConfig.isRandom
            setPadding(0, (density * 4).toInt(), 0, (density * 16).toInt())
        }
        container.addView(randomSwitch)

        // 按钮行
        val buttonRow = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.END
        }
        buttonRow.addView(DialogUtils.createDialogButton(context, theme, "取消", isPrimary = false) { dialog.dismiss() })
        buttonRow.addView(DialogUtils.createDialogButton(context, theme, "确定", isPrimary = true) {
            val newConfig = SlideshowConfig(
                intervalMs = (intervalSeekBar.progress + 1) * 1000L,
                transition = selectedTransition,
                isRandom = randomSwitch.isChecked,
                enableZoom = zoomSwitch.isChecked
            )
            onConfirm(newConfig)
            dialog.dismiss()
        })
        container.addView(buttonRow)

        dialog.setContentView(container)
        dialog.show()
        val widthPx = (320 * density).toInt()
        dialog.window?.setLayout(widthPx, WindowManager.LayoutParams.WRAP_CONTENT)
    }
}
