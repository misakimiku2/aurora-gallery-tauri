package com.aurora.gallery.kotlin.ui.components

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 自然序名字比较（[compareNaturalNames]）：对齐 React 版
 * `src/utils/__tests__/folderSort.spec.ts` 的 compareNaturalNames 断言口径。
 */
class NaturalNameSortTest {

    @Test
    fun `1jpg 2jpg 10jpg 11jpg 字典序会给出 1、10、11、2`() {
        val sorted = listOf("10.jpg", "1.jpg", "11.jpg", "2.jpg").sortedWith(naturalNameComparator { it })
        assertEquals(listOf("1.jpg", "2.jpg", "10.jpg", "11.jpg"), sorted)
    }

    @Test
    fun `多位数 img2 小于 img10`() {
        assertTrue(compareNaturalNames("img2.jpg", "img10.jpg") < 0)
        assertTrue(compareNaturalNames("img10.jpg", "img2.jpg") > 0)
    }

    @Test
    fun `前导零数值相等视为并列`() {
        assertEquals(0, compareNaturalNames("img01.jpg", "img1.jpg"))
    }

    @Test
    fun `多数字段逐段比较`() {
        assertTrue(compareNaturalNames("img2-2.jpg", "img2-10.jpg") < 0)
        assertTrue(compareNaturalNames("img2-10.jpg", "img2-2.jpg") > 0)
    }

    @Test
    fun `大小写不敏感`() {
        assertTrue(compareNaturalNames("Apple.jpg", "banana.JPG") < 0)
        assertTrue(compareNaturalNames("BANANA.jpg", "apple.jpg") > 0)
    }

    @Test
    fun `前缀情形短者在前`() {
        assertTrue(compareNaturalNames("img", "img2") < 0)
        assertTrue(compareNaturalNames("img2", "img") > 0)
        assertEquals(0, compareNaturalNames("img", "img"))
    }

    @Test
    fun `数字段与非数字段混排退回码位比较`() {
        assertTrue(compareNaturalNames("img2", "imga") < 0)
    }
}
