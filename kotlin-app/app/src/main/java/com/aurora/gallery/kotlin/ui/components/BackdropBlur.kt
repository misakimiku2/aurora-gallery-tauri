package com.aurora.gallery.kotlin.ui.components

import android.content.Context
import android.graphics.Bitmap
import android.renderscript.Allocation
import android.renderscript.Element
import android.renderscript.RenderScript
import android.renderscript.ScriptIntrinsicBlur

/**
 * 低版本毛玻璃降级（2026-10-06 荣耀 Android 10 真机报障）：弹层垫底快照的 GPU
 * 模糊（graphicsLayer renderEffect=BlurEffect / View.setRenderEffect）要 API 31+，
 * 26-30 上快照此前原样清晰垫底——菜单背后网格根根可辨，用户感知即「毛玻璃消失
 * 只剩透明」。此处对快照做**真高斯**：1/2 降采样后 ScriptIntrinsicBlur（半径=
 * 12dp 像素的一半，降采样同步减半；对齐 GPU 版 backdrop-blur-md 观感，边缘自带
 * clamp），再双线性放大回原尺寸。首版单级 1/8 降采样-回插被用户评为「比 Mate 40
 * Pro 劣质不少」（双线性回插有格状色带），RS 高斯与 GPU 路径观感一致。
 * API 31+ 仍走 GPU BlurEffect 路径（调用方守卫不动），不经此函数。
 * RS 框架在 API 31+ 标记弃用但 26-30 完全可用；异常时（个别 ROM 裁剪）退回多级
 * 降采样-回插，保证有模糊垫底而非清晰快照。
 */
internal fun blurBackdropSnapshot(context: Context, src: Bitmap): Bitmap {
    val halfW = (src.width / 2).coerceAtLeast(1)
    val halfH = (src.height / 2).coerceAtLeast(1)
    val small = Bitmap.createScaledBitmap(src, halfW, halfH, true)
    try {
        val density = context.resources.displayMetrics.density
        // 12dp@density 的一半；ScriptIntrinsicBlur 半径上限 25f
        val radius = (density * 12f / 2f).coerceIn(1f, 25f)
        val blurred = rsGaussianBlur(context, small, radius)
        val full = Bitmap.createScaledBitmap(blurred, src.width, src.height, true)
        blurred.recycle()
        return full
    } catch (t: Throwable) {
        // RS 不可用兜底：1/4→1/16 两级降采样均值化 + 分级回插（比单级 1/8 平滑）
        val quarter = Bitmap.createScaledBitmap(small, (halfW / 2).coerceAtLeast(1), (halfH / 2).coerceAtLeast(1), true)
        val tiny = Bitmap.createScaledBitmap(quarter, (halfW / 4).coerceAtLeast(1), (halfH / 4).coerceAtLeast(1), true)
        val back1 = Bitmap.createScaledBitmap(tiny, halfW, halfH, true)
        val full = Bitmap.createScaledBitmap(back1, src.width, src.height, true)
        quarter.recycle()
        tiny.recycle()
        back1.recycle()
        return full
    } finally {
        small.recycle()
    }
}

/** ScriptIntrinsicBlur 真高斯；输入输出同尺寸 ARGB_8888。 */
@Suppress("DEPRECATION")
private fun rsGaussianBlur(context: Context, src: Bitmap, radius: Float): Bitmap {
    val out = Bitmap.createBitmap(src.width, src.height, Bitmap.Config.ARGB_8888)
    val rs = RenderScript.create(context)
    try {
        val input = Allocation.createFromBitmap(rs, src)
        val output = Allocation.createTyped(rs, input.type)
        val script = ScriptIntrinsicBlur.create(rs, Element.U8_4(rs))
        script.setRadius(radius)
        script.setInput(input)
        script.forEach(output)
        output.copyTo(out)
        input.destroy()
        output.destroy()
        script.destroy()
    } finally {
        rs.destroy()
    }
    return out
}
