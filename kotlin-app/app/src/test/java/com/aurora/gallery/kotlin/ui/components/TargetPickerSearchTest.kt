package com.aurora.gallery.kotlin.ui.components

import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import uniffi.aurora_core.Folder

/**
 * TargetPickerDialog 顶部搜索框的过滤纯逻辑单测（[filterFoldersForSearch]）：
 * 包含即命中、大小写不敏感、空白查询原样返回、查询两端空白被 trim。
 */
class TargetPickerSearchTest {

    private fun folder(id: String, name: String) = Folder(id, name, 0, null, 0, 0)

    private val folders = listOf(
        folder("a", "Camera"),
        folder("b", "截图"),
        folder("c", "Screenshots"),
    )

    @Test
    fun `空白查询原样返回全量列表`() {
        assertSame(folders, filterFoldersForSearch(folders, ""))
        assertSame(folders, filterFoldersForSearch(folders, "   "))
    }

    @Test
    fun `名字包含即命中且大小写不敏感`() {
        assertEquals(listOf("a", "c"), filterFoldersForSearch(folders, "e").map { it.id })
        assertEquals(listOf("b"), filterFoldersForSearch(folders, "截图").map { it.id })
    }

    @Test
    fun `查询两端空白被忽略`() {
        assertEquals(listOf("a"), filterFoldersForSearch(folders, "  camera  ").map { it.id })
    }

    @Test
    fun `无命中返回空表`() {
        assertTrue(filterFoldersForSearch(folders, "不存在的相册").isEmpty())
    }
}
