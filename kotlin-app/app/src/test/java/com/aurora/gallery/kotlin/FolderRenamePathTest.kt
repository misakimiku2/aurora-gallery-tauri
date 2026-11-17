package com.aurora.gallery.kotlin

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * 文件夹重命名的 RELATIVE_PATH 派生纯逻辑单测（2026-11-18 文件夹长按菜单）。
 * [deriveRenamedRelPath] 是「逐文件改 RELATIVE_PATH 复用 moveFiles」管线的唯一
 * 路径运算点——派生错了会把整夹文件挪到错误的 RELATIVE_PATH（嵌套层级丢失），
 * 故与名字排序三端契约同款：纯函数钉测试。
 */
class FolderRenamePathTest {

    // ===== 正常派生 =====

    @Test
    fun `Pictures 下的文件夹 - 保持父层级`() {
        assertEquals("Pictures/新的名字/", deriveRenamedRelPath("Pictures/旧名字/", "新的名字"))
    }

    @Test
    fun `嵌套两层 - 只换末段`() {
        assertEquals("Pictures/A/B2/", deriveRenamedRelPath("Pictures/A/B/", "B2"))
    }

    @Test
    fun `顶层文件夹 - 直接落到根下`() {
        assertEquals("Y/", deriveRenamedRelPath("X/", "Y"))
    }

    @Test
    fun `DCIM 相机目录 - 同口径`() {
        assertEquals("DCIM/Camera2/", deriveRenamedRelPath("DCIM/Camera/", "Camera2"))
    }

    // ===== 拒绝路径 =====

    @Test
    fun `根目录散图（relPath = 根）- 不可改名`() {
        assertNull(deriveRenamedRelPath("/", "任意"))
    }

    @Test
    fun `空名字 - 拒绝`() {
        assertNull(deriveRenamedRelPath("Pictures/X/", ""))
        assertNull(deriveRenamedRelPath("Pictures/X/", "   "))
    }

    @Test
    fun `路径分隔符 - 拒绝`() {
        assertNull(deriveRenamedRelPath("Pictures/X/", "a/b"))
        assertNull(deriveRenamedRelPath("Pictures/X/", "a\\b"))
    }

    @Test
    fun `点引用 - 拒绝`() {
        assertNull(deriveRenamedRelPath("Pictures/X/", "."))
        assertNull(deriveRenamedRelPath("Pictures/X/", ".."))
    }

    // ===== 容错 =====

    @Test
    fun `旧路径无尾斜杠 - 也能派生（防御）`() {
        assertEquals("Pictures/Y/", deriveRenamedRelPath("Pictures/X", "Y"))
    }

    @Test
    fun `新名字两端空白 - trim 后可用`() {
        assertEquals("Pictures/Y/", deriveRenamedRelPath("Pictures/X/", " Y "))
    }
}
