package com.aurora.gallery.kotlin.ui.components

import androidx.compose.foundation.layout.size
import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.unit.dp
import com.aurora.gallery.kotlin.state.PersonGroupBy
import com.aurora.gallery.kotlin.state.PersonSortOption
import com.aurora.gallery.kotlin.ui.theme.AuroraTheme
import uniffi.aurora_core.FfiPerson
import uniffi.aurora_core.FfiTopic
import uniffi.aurora_core.RemoteTagCount
import uniffi.aurora_core.groupRemoteTagCounts
import java.text.Collator
import java.util.Locale

/**
 * 人物总览的**排序 / 分组**与顶栏那颗排序钮的菜单体。
 *
 * 2026-10-09 从 `TagsOverview.kt` 拆出：那一个文件同时装了标签总览和整个人物总览
 * （1332 行），人物这一半单独成文件，本文件只留「怎么排、怎么分组」这一件事。
 * 纯函数刻意不 @Composable —— 排序/组序是「看着不对但很难截图证明」的那类逻辑，
 * 抽成函数才能拿单测钉住（组序的 0-9 最前 / # 与未分类最后就是典型）。
 */

/**
 * 人物展示排序（桌面 `PersonGrid.tsx:226-254` 同语义）：NAME 按 locale 比较、
 * COUNT 按张数、CREATED 取**封面文件**的创建时间（桌面读 `files[coverFileId].meta.created`，
 * 这里由宿主把 Image.createdAt 摊成表传进来；没封面就按 0 落尾）。
 * 与 [sortTopicsForDisplay] 同一把 Collator，别在 UI 里排第二遍。
 */
fun sortPeopleForDisplay(
    people: List<FfiPerson>,
    option: PersonSortOption,
    ascending: Boolean,
    createdAtByFileId: Map<String, Long>,
): List<FfiPerson> {
    val sorted = when (option) {
        PersonSortOption.NAME -> {
            val collator = Collator.getInstance(Locale.CHINA)
            people.sortedWith(compareBy(collator) { it.name })
        }
        PersonSortOption.COUNT -> people.sortedBy { it.count }
        PersonSortOption.CREATED -> people.sortedBy { createdAtByFileId[it.coverFileId] ?: 0L }
    }
    return if (ascending) sorted else sorted.asReversed()
}

/**
 * 人名的拼音组键表（name → 组键，如「初音」→ C）。
 *
 * 复用 core 的 `group_remote_tag_counts`：它和标签分组走**同一个** `collate::group_tags`
 * （边界表、组键、组序一套规则），所以人物的字母组和标签的字母组口径必然一致——在
 * Kotlin 侧另写一份边界表，迟早会和标签对不上而没人发现。该函数是纯函数、不碰库，
 * 传人名不会污染词表（D31 数据层铁律对它零风险）。
 *
 * 重名人物先 distinct，自然拿到同一个组键。FFI 异常回空表 → 调用方一律落「#」组：
 * 分组是锦上添花，不该把整页带崩。
 */
fun pinyinGroupKeysByCollate(names: List<String>, language: String): Map<String, String> {
    if (names.isEmpty()) return emptyMap()
    return runCatching {
        names.distinct()
            .let { list -> groupRemoteTagCounts(list.map { RemoteTagCount(it, 0L) }, language) }
            .flatMap { group -> group.tags.map { it.tag to group.key } }
            .toMap()
    }.getOrDefault(emptyMap())
}

/** 一个分组（组键 + 标题 + 组内人物 id；桌面 `PersonGroup` 同形）。 */
data class PersonGroup(val id: String, val title: String, val personIds: List<String>)

/**
 * 人物分组（桌面 `PersonGrid.tsx:257-313` 同语义）：
 *  - NONE = 单组「所有人物」；
 *  - NAME = 拼音组键（[pinyinGroupKeysByCollate]），查不到落「#」；
 *  - TOPIC = 首个 `peopleIds` 含该人物的专题名，没有则「未分类」——桌面同款取舍：
 *    一个人物属于多个专题时只进第一个，不重复出现。
 *
 * 组序（桌面 `:303-312` 原样）：`0-9` 最前，`#` 与「未分类」垫底，其余按组名 locale 升序。
 */
fun buildPersonGroups(
    people: List<FfiPerson>,
    groupBy: PersonGroupBy,
    groupKeyByName: Map<String, String>,
    topics: List<FfiTopic>,
    ungroupedTitle: String = "未分类",
): List<PersonGroup> {
    if (groupBy == PersonGroupBy.NONE) {
        return listOf(PersonGroup(id = "all", title = "所有人物", personIds = people.map { it.id }))
    }
    val grouped = LinkedHashMap<String, MutableList<String>>()
    people.forEach { person ->
        val key = when (groupBy) {
            PersonGroupBy.NAME -> groupKeyByName[person.name] ?: "#"
            PersonGroupBy.TOPIC ->
                topics.firstOrNull { person.id in it.peopleIds }?.name ?: ungroupedTitle
            PersonGroupBy.NONE -> "all"
        }
        grouped.getOrPut(key) { mutableListOf() }.add(person.id)
    }
    // 档位而非字符串比较：0-9 顶、# 与未分类垫底，中间按 locale 升序
    fun rank(key: String): Int = when (key) {
        "0-9" -> 0
        "#" -> 2
        ungroupedTitle -> 3
        else -> 1
    }
    val collator = Collator.getInstance(Locale.CHINA)
    return grouped.entries
        .map { (key, ids) -> PersonGroup(id = key, title = key, personIds = ids) }
        .sortedWith(Comparator { a, b ->
            val byRank = rank(a.id).compareTo(rank(b.id))
            if (byRank != 0) byRank else collator.compare(a.title, b.title)
        })
}

/**
 * 人物总览的排序菜单**体**（排序方式 + 升降序 + 分组三节），渲染在顶栏那颗排序钮的
 * AuroraDropdown 里（[TopBar] 的 sortMenuContent 注入位），自身不带触发钮。
 *
 * 2026-10-08 指挥官定：进入人物界面时顶栏那颗钮换成当前视图对应的排序语义，页头不再留
 * 第二颗——这一档向桌面 `TopBar.tsx:1196-1254`（人物排序本就在顶栏）靠。
 * 专题/标签总览的页头那颗本轮没动，三个总览统一口径另开一轮。
 */
@Composable
fun PersonSortMenuContent(
    sortBy: PersonSortOption,
    ascending: Boolean,
    groupBy: PersonGroupBy,
    onSortChange: (PersonSortOption, Boolean) -> Unit,
    onGroupChange: (PersonGroupBy) -> Unit,
) {
    val colors = AuroraTheme.colors
    AuroraMenuHeader("排序方式")
    AuroraMenuItem(
        text = "按名称",
        checked = sortBy == PersonSortOption.NAME,
        onClick = { onSortChange(PersonSortOption.NAME, ascending) },
    )
    AuroraMenuItem(
        text = "按数量",
        checked = sortBy == PersonSortOption.COUNT,
        onClick = { onSortChange(PersonSortOption.COUNT, ascending) },
    )
    AuroraMenuItem(
        text = "按创建时间",
        checked = sortBy == PersonSortOption.CREATED,
        onClick = { onSortChange(PersonSortOption.CREATED, ascending) },
    )
    AuroraMenuDivider()
    AuroraMenuItem(
        text = if (ascending) "升序" else "降序",
        onClick = { onSortChange(sortBy, !ascending) },
        trailing = {
            Icon(
                imageVector = IconSortArrows,
                contentDescription = null,
                tint = colors.textSecondary,
                modifier = Modifier
                    .size(14.dp)
                    .rotate(if (ascending) 180f else 0f),
            )
        },
    )
    AuroraMenuDivider()
    AuroraMenuHeader("分组")
    AuroraMenuItem(
        text = "不分组",
        checked = groupBy == PersonGroupBy.NONE,
        onClick = { onGroupChange(PersonGroupBy.NONE) },
    )
    AuroraMenuItem(
        text = "按名称",
        checked = groupBy == PersonGroupBy.NAME,
        onClick = { onGroupChange(PersonGroupBy.NAME) },
    )
    AuroraMenuItem(
        text = "按专题",
        checked = groupBy == PersonGroupBy.TOPIC,
        onClick = { onGroupChange(PersonGroupBy.TOPIC) },
    )
}
