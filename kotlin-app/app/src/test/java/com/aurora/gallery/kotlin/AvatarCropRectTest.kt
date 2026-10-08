package com.aurora.gallery.kotlin

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import uniffi.aurora_core.FfiFaceBox

/**
 * faceBox（百分比）→ 图像像素正方形裁切区（[avatarCropRect]）。
 *
 * 这条换算链上一轮正是「存的头像不是圈里那块」的现场，所以逐条钉住：
 * 正方形框原样还原、无框退中心正方形、越界与历史脏数据不许崩也不许跑出图外。
 */
class AvatarCropRectTest {

    private fun box(x: Double, y: Double, w: Double, h: Double) =
        FfiFaceBox(x = x, y = y, w = w, h = h)

    @Test
    fun `竖图上按桌面口径存的框还原成整幅宽度的正方形`() {
        // 上一轮真机核过的数值：1080×1920 竖图写回 w=100% / h=56.25%
        val r = avatarCropRect(1080, 1920, box(x = 0.0, y = 21.875, w = 100.0, h = 56.25))
        assertEquals(0, r[0])
        assertEquals(420, r[1])
        assertEquals(1080, r[2])
        assertEquals(1080, r[3])
    }

    @Test
    fun `横图左上角的框裁到左上角`() {
        // AKM 那张 3200×1344 的实测数据：x=0, y=0, w=15.6%, h=37.15%
        val r = avatarCropRect(3200, 1344, box(0.0, 0.0, 15.6029716134071, 37.1499300003052))
        assertEquals(0, r[0])
        assertEquals(0, r[1])
        assertEquals(499, r[2])
        assertEquals(499, r[3])
    }

    @Test
    fun `无框与退化框退成整图中心正方形`() {
        assertEquals(listOf(928, 0, 1344, 1344), avatarCropRect(3200, 1344, null).toList())
        assertEquals(
            listOf(928, 0, 1344, 1344),
            avatarCropRect(3200, 1344, box(10.0, 10.0, 0.0, 0.0)).toList(),
        )
    }

    @Test
    fun `越界框被收进图内`() {
        // 历史数据里 x+w 可能超过 100%：裁切区不许跑出图像边界（createBitmap 会直接抛）
        val r = avatarCropRect(1000, 1000, box(90.0, 90.0, 20.0, 20.0))
        assertTrue("r=${r.toList()}", r[0] >= 0 && r[1] >= 0)
        assertTrue("r=${r.toList()}", r[0] + r[2] <= 1000 && r[1] + r[3] <= 1000)
        assertEquals(r[2], r[3])
    }

    @Test
    fun `非正方形框取框内最大居中正方形而不是拉伸`() {
        // 2000×1000 上 x=10% y=10% w=40% h=40% → 像素框 800×400（扁的）：居中取 400 方，
        // 桌面 cropToImgStyle 那种按宽高分别拉伸的做法这里不跟
        val r = avatarCropRect(2000, 1000, box(x = 10.0, y = 10.0, w = 40.0, h = 40.0))
        assertEquals(400, r[0])
        assertEquals(100, r[1])
        assertEquals(400, r[2])
        assertEquals(400, r[3])
    }
}
