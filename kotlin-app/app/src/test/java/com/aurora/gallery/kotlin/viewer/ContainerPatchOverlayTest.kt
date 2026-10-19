package com.aurora.gallery.kotlin.viewer

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * [overlayPatches] 的窗口算术 —— 播放时「容器字节代换」唯一的正确性所在。
 *
 * 之所以单独钉：这条链跑在 ExoPlayer 的读取路径上，代换的偏移是**绝对文件偏移**，而每次
 * `read()` 拿到的是一小段缓冲（ExoPlayer 常按几 KB 读，也会跨块、也会只覆盖补丁的一半）。
 * 算错一格的症状是"文件明明修好了却仍播到一半定格"或"画面花掉"，而且只在真机上、只在
 * 特定读取边界出现 —— 靠肉眼在设备上试根本抓不住，必须在 JVM 里把重叠关系逐个形状钉死。
 */
class ContainerPatchOverlayTest {

    private fun win(vararg bytes: Int) = PatchWindow(offset = 0, bytes = bytes.map { it.toByte() }.toByteArray(), kind = "test")

    private fun pw(offset: Long, vararg bytes: Int) =
        PatchWindow(offset, bytes.map { it.toByte() }.toByteArray(), "mdatSpan")

    @Test
    fun `补丁完全落在读窗口里时四处都被换掉`() {
        val buf = ByteArray(16) { (it + 1).toByte() }
        overlayPatches(buf, readFrom = 0, filled = 16, patches = listOf(pw(4, 0x2A, 0x2B, 0x2C, 0x2D)))
        assertEquals(0x2A, buf[4].toInt())
        assertEquals(0x2D, buf[7].toInt())
        // 补丁两侧一个字节都不该动（buf[i] 的初值是 i+1，索引 3 就是 4）
        assertEquals(1, buf[0].toInt())
        assertEquals(4, buf[3].toInt())
        assertEquals(9, buf[8].toInt())
    }

    @Test
    fun `窗口只盖住补丁左半时只换重叠的那两字节`() {
        val buf = ByteArray(8) { 0 }
        overlayPatches(buf, readFrom = 0, filled = 6, patches = listOf(pw(4, 0x11, 0x22, 0x33, 0x44)))
        assertArrayEquals(byteArrayOf(0, 0, 0, 0, 0x11, 0x22, 0, 0), buf)
    }

    @Test
    fun `窗口只盖住补丁右半时取补丁的后半`() {
        // 本次读的是文件 [6,8) 这一段 → buf 的**索引 0 就是绝对位置 6**，
        // 与补丁 [4,8) 的重叠是 [6,8)，取来的应当是补丁的第 2、3 个字节。
        val buf = ByteArray(2) { 0 }
        overlayPatches(buf, readFrom = 6, filled = 2, patches = listOf(pw(4, 0x11, 0x22, 0x33, 0x44)))
        assertArrayEquals(byteArrayOf(0x33, 0x44), buf)
    }

    @Test
    fun `同一个补丁跨两次读落地`() {
        // 真机上就是这样：一次 read 只覆盖补丁的前 2 字节，下一次覆盖后 2 字节
        val first = ByteArray(4) { 0 }
        overlayPatches(first, readFrom = 100, filled = 4, patches = listOf(pw(102, 0xAA, 0xBB, 0xCC, 0xDD)))
        assertArrayEquals(byteArrayOf(0, 0, 0xAA.toByte(), 0xBB.toByte()), first)
        val second = ByteArray(4) { 0 }
        overlayPatches(second, readFrom = 104, filled = 4, patches = listOf(pw(102, 0xAA, 0xBB, 0xCC, 0xDD)))
        assertArrayEquals(byteArrayOf(0xCC.toByte(), 0xDD.toByte(), 0, 0), second)
    }

    @Test
    fun `窗口在补丁之前就结束或在其之后才开始时不动一个字节`() {
        val before = ByteArray(4) { 0x7F }
        overlayPatches(before, readFrom = 0, filled = 4, patches = listOf(pw(4, 1, 2, 3, 4)))
        assertArrayEquals(byteArrayOf(0x7F, 0x7F, 0x7F, 0x7F), before)

        val after = ByteArray(4) { 0x7F }
        overlayPatches(after, readFrom = 8, filled = 4, patches = listOf(pw(4, 1, 2, 3, 4)))
        assertArrayEquals(byteArrayOf(0x7F, 0x7F, 0x7F, 0x7F), after)
    }

    @Test
    fun `一次窗口里多个补丁按各自偏移各归各位`() {
        val buf = ByteArray(20) { 0 }
        overlayPatches(
            buf, readFrom = 0, filled = 20,
            patches = listOf(pw(2, 1, 1, 1, 1), pw(10, 2, 2, 2, 2), pw(16, 3, 3, 3, 3)),
        )
        assertEquals(1, buf[3].toInt())
        assertEquals(0, buf[6].toInt())
        assertEquals(2, buf[10].toInt())
        assertEquals(3, buf[19].toInt())
    }

    @Test
    fun `空补丁表与零长度读都是空操作`() {
        val buf = ByteArray(8) { (it + 1).toByte() }
        val copy = buf.copyOf()
        overlayPatches(buf, readFrom = 0, filled = 8, patches = emptyList())
        assertArrayEquals(copy, buf)
        overlayPatches(buf, readFrom = 0, filled = 0, patches = listOf(pw(0, 9, 9, 9, 9)))
        assertArrayEquals(copy, buf)
        overlayPatches(buf, readFrom = 0, filled = -1, patches = listOf(pw(0, 9, 9, 9, 9)))
        assertArrayEquals(copy, buf)
    }

    @Test
    fun `补丁越出缓冲区末尾时只写进得去的部分而不是崩`() {
        // 防御：core 给的偏移理论上都在文件内，但算术不许越界抛 ArrayIndexOutOfBounds
        val buf = ByteArray(6) { 0 }
        overlayPatches(buf, readFrom = 0, filled = 6, patches = listOf(pw(3, 1, 2, 3, 4)))
        assertArrayEquals(byteArrayOf(0, 0, 0, 1, 2, 3), buf)
    }

    @Test
    fun `补丁窗口宽度不只有四字节时也按实际长度换`() {
        val buf = ByteArray(10) { 0 }
        overlayPatches(buf, readFrom = 0, filled = 10, patches = listOf(win(7, 7, 7)))
        // offset=0 的三字节
        assertArrayEquals(byteArrayOf(7, 7, 7, 0, 0, 0, 0, 0, 0, 0), buf)
    }
}
