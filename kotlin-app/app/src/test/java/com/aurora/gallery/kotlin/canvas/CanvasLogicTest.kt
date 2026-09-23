package com.aurora.gallery.kotlin.canvas

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * M5 1.1 纯逻辑单测：期望值全部来自 node 跑 **React 原算法逐字拷贝**（`layout.ts` /
 * `viewport.ts` / `geometry.ts` / `ImageComparer.tsx:1667-1756` handleReorder）的输出
 * 夹具（生成脚本存档于里程碑提交记录 `/tmp/m5fixture/fixtures.js`）——「同输入同输出」
 * 对拍，不是手算。
 */
class CanvasLogicTest {

    // ===== 装箱（layout.ts packImages）=====

    @Test
    fun `pack3 对拍 React - 面积降序 a(1600x1200) c(1000x1000) b(800x600)`() {
        val out = packImages(
            listOf(
                CanvasPackSource("a", 1600f, 1200f),
                CanvasPackSource("b", 800f, 600f),
                CanvasPackSource("c", 1000f, 1000f),
            ),
        )
        assertEquals(listOf("a", "c", "b"), out.map { it.id })
        // 首张以原点为中心
        val a = out[0]
        assertEquals(-800f, a.x, 0.01f)
        assertEquals(-600f, a.y, 0.01f)
        // c 在 a 正下方（候选 (a.x, a.y+h+40)）
        val c = out[1]
        assertEquals(-800f, c.x, 0.01f)
        assertEquals(640f, c.y, 0.01f)
        // b 在 a 正上方
        val b = out[2]
        assertEquals(-800f, b.x, 0.01f)
        assertEquals(-1240f, b.y, 0.01f)
    }

    @Test
    fun `packFirst 首张以原点为中心`() {
        // 尺寸兜底（无宽高 → 1000×750）在入口解析层完成（React layout.ts 的
        // `meta?.width || 1000` 语义）；packImages 收到的是已解析的尺寸
        val out = packImages(listOf(CanvasPackSource("x", 1000f, 750f)))
        assertEquals(1, out.size)
        assertEquals(-500f, out[0].x, 0.01f)
        assertEquals(-375f, out[0].y, 0.01f)
        assertEquals(1000f, out[0].width, 0.01f)
        assertEquals(750f, out[0].height, 0.01f)
    }

    @Test
    fun `pack10 对拍 React - 10 张混合尺寸的完整位置序列`() {
        val dims = listOf(
            1600f to 1200f, 1000f to 1000f, 800f to 600f, 1200f to 900f, 900f to 1600f,
        )
        val files = (0 until 10).map { i ->
            CanvasPackSource("f$i", dims[i % 5].first, dims[i % 5].second)
        }
        val out = packImages(files)
        // 夹具（React 原算法输出）：id → (x, y)
        val expected = mapOf(
            "f0" to (-800f to -600f),
            "f5" to (-800f to 640f),
            "f4" to (840f to -600f),
            "f9" to (-1740f to -600f),
            "f3" to (-800f to -1540f),
            "f8" to (440f to -1540f),
            "f1" to (-1840f to -1640f),
            "f6" to (840f to 1040f),
            "f2" to (-1640f to 1040f),
            "f7" to (-800f to -2180f),
        )
        assertEquals(expected.size, out.size)
        for (r in out) {
            val e = expected[r.id]!!
            assertEquals("x of ${r.id}", e.first, r.x, 0.01f)
            assertEquals("y of ${r.id}", e.second, r.y, 0.01f)
        }
    }

    @Test
    fun `空输入返回空`() {
        assertTrue(packImages(emptyList()).isEmpty())
    }

    @Test
    fun `增量装箱 - 新项选离原点最近的合法候选`() {
        val existing = listOf(CanvasPackedRect("a", -800f, -600f, 1600f, 1200f))
        val out = packNewItems(existing, listOf(CanvasPackSource("b", 800f, 600f)))
        assertEquals(1, out.size)
        val b = out[0]
        // 候选里离原点最近的是 a 正下方 (a.x, a.y+h+40)；左右侧候选中心距相等但出现更晚
        assertEquals(-800f, b.x, 0.01f)
        assertEquals(640f, b.y, 0.01f)
        // 不与 a 重叠
        assertFalse(
            aabbOverlap(
                computeAABB(b.x, b.y, b.width, b.height, 0f),
                computeAABB(-800f, -600f, 1600f, 1200f, 0f),
            ),
        )
    }

    // ===== 视口（viewport.ts）=====

    @Test
    fun `zoomAtPoint 对拍 React`() {
        val out = zoomAtPoint(CanvasViewport(100f, 200f, 0.5f), 300f, 400f, 1.5f)
        assertEquals(0f, out.x, 0.01f)
        assertEquals(100f, out.y, 0.01f)
        assertEquals(0.75f, out.scale, 0.001f)
    }

    @Test
    fun `zoomAtPoint 边界钳制 0点01 与 20`() {
        val low = zoomAtPoint(CanvasViewport(0f, 0f, 0.02f), 100f, 100f, 0.1f)
        assertEquals(0.01f, low.scale, 0.0001f)
        assertEquals(50f, low.x, 0.01f)
        val high = zoomAtPoint(CanvasViewport(0f, 0f, 19f), 100f, 100f, 2f)
        assertEquals(20f, high.scale, 0.0001f)
        // 夹具：100 - (100-0)*(20/19) = -5.2631…
        assertEquals(-5.2632f, high.x, 0.001f)
    }

    @Test
    fun `computeFitTransform 对拍 React - padding60 maxScale1点2`() {
        val fit = computeFitTransform(
            1000f, 800f,
            CanvasAABB(0f, 0f, 1600f, 1200f),
        )!!
        assertEquals(0.55f, fit.scale, 0.001f)
        assertEquals(60f, fit.x, 0.01f)
        assertEquals(70f, fit.y, 0.01f)
    }

    @Test
    fun `computeFitTransform 内容无效返回 null`() {
        assertNull(computeFitTransform(1000f, 800f, CanvasAABB(0f, 0f, 0f, 0f)))
    }

    // ===== 几何（geometry.ts）=====

    @Test
    fun `computeAABB 对拍 React - 45 度旋转`() {
        // item (100,100,200,100) 旋转 45°：中心 (200,150)，半对角 sqrt(100²+50²)=111.8
        val aabb = computeAABB(100f, 100f, 200f, 100f, 45f)
        assertEquals(93.934f, aabb.minX, 0.01f)
        assertEquals(43.934f, aabb.minY, 0.01f)
        assertEquals(306.066f, aabb.maxX, 0.01f)
        assertEquals(256.066f, aabb.maxY, 0.01f)
    }

    @Test
    fun `pointInRotatedItem - 中心命中 远离点不命中`() {
        // 旋转 45° 的 200×100（中心 (200,150)）：(105,105) 经反旋仍在框内（对拍验证），
        // 远离的对角 (600,600) 反旋后 lx≈801 超出右界
        assertTrue(pointInRotatedItem(200f, 150f, 100f, 100f, 200f, 100f, 45f))
        assertTrue(pointInRotatedItem(105f, 105f, 100f, 100f, 200f, 100f, 45f))
        assertFalse(pointInRotatedItem(600f, 600f, 100f, 100f, 200f, 100f, 45f))
        assertTrue(pointInRotatedItem(150f, 120f, 100f, 100f, 200f, 100f, 0f))
        assertFalse(pointInRotatedItem(350f, 120f, 100f, 100f, 200f, 100f, 0f))
    }

    @Test
    fun `aabbOverlap 对拍 React`() {
        val axis = computeAABB(0f, 0f, 100f, 50f, 0f)
        assertTrue(aabbOverlap(axis, CanvasAABB(50f, -10f, 200f, 10f)))
        assertFalse(aabbOverlap(axis, CanvasAABB(200f, 0f, 300f, 50f)))
    }

    // ===== z 序（handleReorder 转译）=====

    /** 夹具场景：z=[a,b,c,d]（尾=顶层），c 与 a 重叠、与 b/d 不重叠。 */
    private val zItems = mapOf(
        "a" to (0f to 0f),
        "b" to (500f to 0f),
        "c" to (50f to 0f),
        "d" to (900f to 900f),
    )

    private fun reorder(z: List<String>, target: String, op: ZOrderOp): List<String> =
        reorderZOrder(
            zOrderIds = z,
            targetId = target,
            op = op,
            existingIds = zItems.keys,
            isOverlap = { p, q ->
                val (px, py) = zItems[p]!!
                val (qx, qy) = zItems[q]!!
                aabbOverlap(computeAABB(px, py, 100f, 100f, 0f), computeAABB(qx, qy, 100f, 100f, 0f))
            },
        )

    @Test
    fun `zTopC - 越过最高重叠项 a 而非简单置顶`() {
        assertEquals(listOf("a", "c", "b", "d"), reorder(listOf("a", "b", "c", "d"), "c", ZOrderOp.TOP))
    }

    @Test
    fun `zTopD - 无重叠则置尾`() {
        assertEquals(listOf("a", "b", "c", "d"), reorder(listOf("a", "b", "c", "d"), "d", ZOrderOp.TOP))
    }

    @Test
    fun `zBottomC - 越过最低重叠项 a`() {
        assertEquals(listOf("c", "a", "b", "d"), reorder(listOf("a", "b", "c", "d"), "c", ZOrderOp.BOTTOM))
    }

    @Test
    fun `zUpC - 向上无相邻重叠则与相邻位交换`() {
        assertEquals(listOf("a", "b", "d", "c"), reorder(listOf("a", "b", "c", "d"), "c", ZOrderOp.UP))
    }

    @Test
    fun `zDownC - 向下遇重叠项 a 跳到其位`() {
        assertEquals(listOf("c", "a", "b", "d"), reorder(listOf("a", "b", "c", "d"), "c", ZOrderOp.DOWN))
    }

    @Test
    fun `zUpB - 与相邻位交换`() {
        assertEquals(listOf("a", "c", "b", "d"), reorder(listOf("a", "b", "c", "d"), "b", ZOrderOp.UP))
    }

    @Test
    fun `z 序里残留已删除 id 保留在数组中但不参与重叠扫描`() {
        // React 语义：visible（过滤 layoutItemMap）只用于扫描目标，next 数组本身不动
        // ghost 的位置（同样保留在 Kotlin 转译里；删除时由 CanvasStore.removeImages 清理）
        assertEquals(
            listOf("ghost", "a", "c", "b", "d"),
            reorder(listOf("ghost", "a", "b", "c", "d"), "c", ZOrderOp.TOP),
        )
    }

    // ===== CanvasStore 状态机 =====

    private fun store() = CanvasStore()

    @Test
    fun `加图去重与 24 上限`() {
        val s = store()
        val first = (1..20).map { CanvasPackSource("f$it", 1000f, 750f) }
        assertTrue(s.addImages(first) is AddResult.Added)
        assertEquals(20, s.count)
        // 重复项跳过
        val dup = s.addImages(listOf(CanvasPackSource("f1", 1000f, 750f)))
        assertTrue(dup is AddResult.AllDuplicates)
        // 5 张进来只收 4 张（20→24）
        val more = (21..25).map { CanvasPackSource("f$it", 1000f, 750f) }
        val result = s.addImages(more)
        assertTrue(result is AddResult.Added)
        assertEquals(4, (result as AddResult.Added).added)
        assertEquals(24, s.count)
        assertTrue(s.isFull)
        // 满员再进 = Full
        assertTrue(s.addImages(listOf(CanvasPackSource("f99", 100f, 100f))) is AddResult.Full)
    }

    @Test
    fun `加图置 autoFitPending 并复位 userInteracted`() {
        val s = store()
        assertFalse(s.autoFitPending)
        s.markInteracted()
        assertTrue(s.userInteracted)
        s.addImages(listOf(CanvasPackSource("a", 1000f, 750f)))
        assertTrue(s.autoFitPending)
        assertFalse(s.userInteracted)
        // 有效容器给出 fit；消费后不再重复给出
        val fit = s.pendingAutoFit(1000f, 800f)
        assertTrue(fit != null && fit.scale > 0f)
        s.clearAutoFitPending()
        assertNull(s.pendingAutoFit(1000f, 800f))
    }

    @Test
    fun `移除同步清理 z 序与选中`() {
        val s = store()
        s.addImages(listOf(CanvasPackSource("a", 100f, 100f), CanvasPackSource("b", 100f, 100f)))
        s.selectSingle("b")
        s.enterEditMode()
        assertTrue(s.isEditMode)
        s.removeImages(listOf("b"))
        assertEquals(1, s.count)
        assertEquals(listOf("a"), s.zOrderIds)
        assertTrue(s.selectedIds.isEmpty())
        assertFalse(s.isEditMode)
    }

    @Test
    fun `重置变换回装箱位 转角归零`() {
        val s = store()
        s.addImages(listOf(CanvasPackSource("a", 400f, 300f)))
        val home = s.items.single()
        s.updateItemTransform("a", x = home.x + 50f, y = home.y + 25f, rotation = 30f)
        s.resetItemTransforms(listOf("a"))
        val after = s.items.single()
        assertEquals(home.homeX, after.x, 0.001f)
        assertEquals(home.homeY, after.y, 0.001f)
        assertEquals(0f, after.rotation, 0.001f)
    }

    @Test
    fun `重置画布全量重排并清转角`() {
        val s = store()
        s.addImages(
            listOf(
                CanvasPackSource("big", 2000f, 1500f),
                CanvasPackSource("small", 200f, 200f),
            ),
        )
        s.updateItemTransform("small", x = 9999f, y = 9999f, rotation = 45f)
        s.resetAll()
        val small = s.items.first { it.fileId == "small" }
        assertEquals(0f, small.rotation, 0.001f)
        assertTrue(small.y < 9000f)
        assertTrue(s.autoFitPending)
    }

    @Test
    fun `单实例语义 - z 序四项走重叠语义`() {
        val s = store()
        // 两张重叠的图：b 在 a 上（z 序 [a,b]），active=b
        s.addImages(
            listOf(
                CanvasPackSource("a", 100f, 100f),
                CanvasPackSource("b", 100f, 100f),
            ),
        )
        // packNewItems 会把 b 放在不重叠的候选位——手动摆成重叠再测
        s.updateItemTransform("b", x = 10f, y = 10f)
        s.selectSingle("b")
        s.reorderActive(ZOrderOp.BOTTOM)
        assertEquals(listOf("b", "a"), s.zOrderIds)
        s.reorderActive(ZOrderOp.TOP)
        // top：b 的最高重叠项是 a → 越过 a 一格 = 移到 a 后 = 尾部
        assertEquals(listOf("a", "b"), s.zOrderIds)
    }
}
