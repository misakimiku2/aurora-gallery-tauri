package com.aurora.gallery.kotlin.ui.components

import com.aurora.gallery.kotlin.state.PersonGroupBy
import com.aurora.gallery.kotlin.state.PersonSortOption
import org.junit.Assert.assertEquals
import org.junit.Test
import uniffi.aurora_core.FfiPerson
import uniffi.aurora_core.FfiTopic

/**
 * 人物总览排序/分组的纯函数单测（[sortPeopleForDisplay] / [buildPersonGroups]）。
 *
 * 钉的是**肉眼看不出来**的那几处：降序到底反没反、封面缺失时按 0 落尾还是落头、
 * 组序里 `0-9` 顶 / `#` 与「未分类」垫底、多专题人物只进第一个组。
 *
 * [pinyinGroupKeysByCollate] 不在这里测——它要过 uniffi 拿原生库，JVM 单测环境加载不了
 * `.so`（真调会 UnsatisfiedLinkError，被函数自己的 runCatching 吞成空表，测出来是假绿）。
 * 组键规则本身在 core 的 `group_remote_tag_counts_matches_local_rules` 里已经钉住，
 * 这里只测「拿到组键之后怎么分组」。
 */
class PeopleSortGroupTest {

    private fun person(
        id: String,
        name: String,
        count: Int = 0,
        coverFileId: String = "",
    ) = FfiPerson(
        id = id,
        name = name,
        coverFileId = coverFileId,
        count = count,
        description = null,
        faceBox = null,
        updatedAt = null,
        characterTagName = null,
        characterTagIndex = null,
    )

    private fun topic(id: String, name: String, peopleIds: List<String>) = FfiTopic(
        id = id,
        parentId = null,
        name = name,
        description = null,
        topicType = "TOPIC",
        coverFileId = null,
        backgroundFileId = null,
        coverCrop = null,
        peopleIds = peopleIds,
        fileIds = emptyList(),
        sourceUrl = null,
        createdAt = null,
        updatedAt = null,
        sourceType = null,
        workName = null,
        workNameCn = null,
        fileCount = 0,
    )

    // ===== 排序 =====

    @Test
    fun `按数量降序把张数多的排前面`() {
        val people = listOf(person("a", "A", count = 1), person("b", "B", count = 9), person("c", "C", count = 5))
        val desc = sortPeopleForDisplay(people, PersonSortOption.COUNT, ascending = false, createdAtByFileId = emptyMap())
        assertEquals(listOf("b", "c", "a"), desc.map { it.id })
        val asc = sortPeopleForDisplay(people, PersonSortOption.COUNT, ascending = true, createdAtByFileId = emptyMap())
        assertEquals(listOf("a", "c", "b"), asc.map { it.id })
    }

    @Test
    fun `按创建时间取封面图的时间，没封面的按 0 落尾`() {
        val people = listOf(
            person("new", "新", coverFileId = "f2"),
            person("old", "旧", coverFileId = "f1"),
            person("nocover", "无封面", coverFileId = ""),
        )
        val created = mapOf("f1" to 100L, "f2" to 200L)
        val asc = sortPeopleForDisplay(people, PersonSortOption.CREATED, ascending = true, createdAtByFileId = created)
        // 0 < 100 < 200：无封面既不是「未知排最前」也不是被丢掉，是落最早那一端
        assertEquals(listOf("nocover", "old", "new"), asc.map { it.id })
        val desc = sortPeopleForDisplay(people, PersonSortOption.CREATED, ascending = false, createdAtByFileId = created)
        assertEquals(listOf("new", "old", "nocover"), desc.map { it.id })
    }

    @Test
    fun `按名称排序不丢人`() {
        val people = listOf(person("z", "周"), person("a", "阿"), person("m", "初"))
        val sorted = sortPeopleForDisplay(people, PersonSortOption.NAME, ascending = true, createdAtByFileId = emptyMap())
        assertEquals(3, sorted.size)
        assertEquals(people.map { it.id }.toSet(), sorted.map { it.id }.toSet())
    }

    // ===== 分组 =====

    @Test
    fun `不分组时单组容纳全部人物`() {
        val people = listOf(person("a", "A"), person("b", "B"))
        val groups = buildPersonGroups(people, PersonGroupBy.NONE, emptyMap(), emptyList())
        assertEquals(1, groups.size)
        assertEquals("所有人物", groups[0].title)
        assertEquals(listOf("a", "b"), groups[0].personIds)
    }

    @Test
    fun `拼音组查不到的名字落井号组`() {
        val people = listOf(person("a", "初音"), person("b", "张三"), person("x", " weird"))
        val keys = mapOf("初音" to "C", "张三" to "Z")
        val groups = buildPersonGroups(people, PersonGroupBy.NAME, keys, emptyList())
        val byTitle = groups.associate { it.title to it.personIds }
        assertEquals(listOf("a"), byTitle["C"])
        assertEquals(listOf("b"), byTitle["Z"])
        assertEquals(listOf("x"), byTitle["#"])
    }

    @Test
    fun `组序是 0-9 最前、井号与未分类垫底`() {
        val people = listOf(
            person("z", "周"), person("n", "那"), person("d", "大"), person("h", "123"),
        )
        val keys = mapOf("周" to "Z", "那" to "N", "大" to "D", "123" to "0-9")
        val groups = buildPersonGroups(people, PersonGroupBy.NAME, keys, emptyList())
        assertEquals(listOf("0-9", "D", "N", "Z"), groups.map { it.id })
    }

    @Test
    fun `专题分组只进第一个命中专题，无专题落未分类`() {
        val people = listOf(person("p1", "甲"), person("p2", "乙"), person("p3", "丙"))
        val topics = listOf(
            topic("t1", "专题一", listOf("p1", "p2")),
            topic("t2", "专题二", listOf("p2")),
        )
        val groups = buildPersonGroups(people, PersonGroupBy.TOPIC, emptyMap(), topics)
        val byTitle = groups.associate { it.title to it.personIds }
        assertEquals(listOf("p1", "p2"), byTitle["专题一"])
        // p2 同时属于专题一和专题二：桌面同款取舍——只进**第一个**命中的专题，
        // 专题二里不再重复出现同一张卡（这条才是本用例真正钉的东西）
        assertEquals(null, byTitle["专题二"])
        assertEquals(listOf("p3"), byTitle["未分类"])
    }

    @Test
    fun `未分类垫在最后一个专题组之后`() {
        val people = listOf(person("p1", "甲"), person("p2", "乙"))
        val groups = buildPersonGroups(
            people,
            PersonGroupBy.TOPIC,
            emptyMap(),
            listOf(topic("t1", "Zzz专题", listOf("p1"))),
        )
        assertEquals(listOf("Zzz专题", "未分类"), groups.map { it.id })
    }
}
