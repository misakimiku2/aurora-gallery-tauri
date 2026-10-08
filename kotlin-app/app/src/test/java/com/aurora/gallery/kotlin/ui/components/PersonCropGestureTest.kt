package com.aurora.gallery.kotlin.ui.components

import androidx.compose.ui.geometry.Offset
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 裁剪页手势归约的锚点不变量（待修清单 #1：真机捏合时基准点跑到右下角）。
 *
 * 验的是「图像上落在手指中点下的那点，缩放过程中始终留在指尖下」这一条，以及它退化成
 * 单指平移时与旧实现逐字相等——旧实现是「绕窗心缩放 + 另加 pan」，两笔口径不一致才飘。
 */
class PersonCropGestureTest {

    /** 取景窗的屏幕边长（300dp 在某密度下的像素数，测试里用一个整数好换算）。 */
    private val windowPx = 300f
    private val maxSide = 1000f
    private val minSide = maxSide / 8f

    /** 窗口位置 → 图像坐标（与渲染端 `offset = w/2 − cx·k` 是同一套换算的逆变换）。 */
    private fun CropView.imageAt(p: Float): Float = cx + (p - windowPx / 2f) * sidePx / windowPx

    private fun imageAtY(v: CropView, p: Float): Float =
        v.cy + (p - windowPx / 2f) * v.sidePx / windowPx

    @Test
    fun `任意位置的捏合都让指尖下的图像点留在指尖下`() {
        val start = CropView(sidePx = 600f, cx = 520f, cy = 480f)
        // 指尖在右上、左下、窗外（图比窗大时 centroid 会落在 300dp 之外）都验一遍
        for (centroid in listOf(Offset(260f, 60f), Offset(40f, 250f), Offset(470f, -80f))) {
            for (zoom in listOf(1.2f, 2f, 4f, 0.8f)) {
                val next = reduceCropGesture(start, centroid, Offset.Zero, zoom, windowPx, windowPx / 2f, maxSide, minSide)
                assertEquals(start.imageAt(centroid.x), next.imageAt(centroid.x), 0.01f)
                assertEquals(imageAtY(start, centroid.y), imageAtY(next, centroid.y), 0.01f)
            }
        }
    }

    @Test
    fun `边长收在上下限内时不被夹住`() {
        val big = reduceCropGesture(CropView(600f, 500f, 500f), Offset(10f, 10f), Offset.Zero, 0.01f, windowPx, windowPx / 2f, maxSide, minSide)
        assertEquals(maxSide, big.sidePx, 0.001f)
        val small = reduceCropGesture(CropView(600f, 500f, 500f), Offset(10f, 10f), Offset.Zero, 100f, windowPx, windowPx / 2f, maxSide, minSide)
        assertEquals(minSide, small.sidePx, 0.001f)
    }

    @Test
    fun `zoom 为一时与单指平移旧实现逐字相等`() {
        val start = CropView(sidePx = 400f, cx = 300f, cy = 700f)
        val pan = Offset(35f, -20f)
        // 纯平移时结果与指尖在哪无关：换三个 centroid 都该给同一个窗心
        for (centroid in listOf(Offset(150f, 210f), Offset(20f, 280f), Offset(600f, 600f))) {
            val next = reduceCropGesture(start, centroid, pan, 1f, windowPx, windowPx / 2f, maxSide, minSide)
            val legacyX = start.cx - pan.x * start.sidePx / windowPx
            val legacyY = start.cy - pan.y * start.sidePx / windowPx
            assertEquals(start.sidePx, next.sidePx, 0.001f)
            assertEquals(legacyX, next.cx, 0.01f)
            assertEquals(legacyY, next.cy, 0.01f)
        }
    }

    @Test
    fun `在窗心捏合时窗心不动（老语义的兼容面）`() {
        val start = CropView(sidePx = 600f, cx = 480f, cy = 520f)
        val next = reduceCropGesture(
            start, Offset(windowPx / 2f, windowPx / 2f), Offset.Zero, 2f, windowPx, windowPx / 2f, maxSide, minSide,
        )
        assertEquals(300f, next.sidePx, 0.001f)
        assertEquals(start.cx, next.cx, 0.001f)
        assertEquals(start.cy, next.cy, 0.001f)
    }

    @Test
    fun `捏近边界时窗心仍被收进图内`() {
        // 竖图：min(宽,高) 决定最大正方形；窗心贴边时 clamp 会接手
        val next = reduceCropGesture(CropView(200f, 60f, 90f), Offset(290f, 290f), Offset.Zero, 4f, windowPx, windowPx / 2f, maxSide, minSide)
        val clamped = next.clampedTo(imgW = 500, imgH = 1000)
        val half = clamped.sidePx / 2f
        assertTrue("cx=${clamped.cx} half=$half", clamped.cx in half..500f - half)
        assertTrue("cy=${clamped.cy} half=$half", clamped.cy in half..1000f - half)
    }
}
