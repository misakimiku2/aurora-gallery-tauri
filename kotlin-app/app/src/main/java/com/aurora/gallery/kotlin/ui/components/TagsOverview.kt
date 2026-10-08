package com.aurora.gallery.kotlin.ui.components

import android.graphics.Bitmap
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.rememberLazyGridState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.path
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.aurora.gallery.kotlin.LanPerson
import com.aurora.gallery.kotlin.ThumbnailLoader
import com.aurora.gallery.kotlin.state.PersonGroupBy
import com.aurora.gallery.kotlin.state.PersonSortOption
import com.aurora.gallery.kotlin.ui.theme.AuroraTheme
import java.text.Collator
import java.util.Locale
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import uniffi.aurora_core.FfiFaceBox
import uniffi.aurora_core.FfiPerson
import uniffi.aurora_core.FfiTopic
import uniffi.aurora_core.RemoteTagCount
import uniffi.aurora_core.TagGroup
import uniffi.aurora_core.groupRemoteTagCounts

/**
 * 标签总览（M4a 3.2，对齐桌面 `TagsList.tsx` 的标签卡片网格）。
 *
 * 桌面形态 → 触屏适配（desktop-to-android 适配表）：
 *  - 卡片 hover 高亮 → 删除（触屏无 hover），点击 = 直接进该标签的筛选视图
 *    （桌面双击 enterTagView 的唯一有效路径收拢为单击，同 4.1 侧栏标签行的口径）；
 *  - 卡片 hover 预览缩略图（600ms 延迟浮层）→ 删除（hover 依赖）；
 *  - 顶部字母索引条 → 删除（总览条目是「十~百」量级，惯性滑动已够用；条目量级涨上去
 *    再按移动端规范补快速滚动条/索引条，不预做）；
 *  - Ctrl/Shift 点选标签集合（selectedTagIds）→ 不做：触屏上点卡片即走，选中集无停留
 *    时机；标签的批量操作（重命名/删除）在词表管理入口（M4b）再收。
 *
 * 分组结构与顺序原样消费 Rust `get_grouped_tags` 的返回（[tagGroups]），组名行 = 不可点
 * 的分隔标题（与侧栏 [TagGroupHeader] 同口径），UI 不排第二遍（清单 §1）。
 * 卡片网格用 LazyVerticalGrid Adaptive：标签卡片量级小（词表条数），不需要 FoldersOverview
 * 那套 RV + 捏合机制；列数随宽度自适应，侧栏开合时自动重排。
 */
@Composable
fun TagsOverview(
    tagGroups: List<TagGroup>,
    /** 点击标签卡片 = 进该标签的筛选视图（宿主接 `AppState.toggleTagFilter`）。 */
    onTagClick: (String) -> Unit,
    modifier: Modifier = Modifier,
    /** 搜索词过滤（TopBar 搜索框，UI 侧过滤不过 FFI，见 1.2 的决定）。空串 = 不过滤。 */
    searchQuery: String = "",
    /** 返回总览时恢复的滚动位置（首个可见条目下标，见 `AppState.tagsOverviewScrollAnchor`）。 */
    initialScrollAnchor: Int = 0,
    /** 滚动位置上报（宿主用普通字段记录）。 */
    onScrollChanged: (Int) -> Unit = {},
    /** 空态文案：宿主按「有无搜索词」区分「无匹配标签」与「暂无标签」。 */
    emptyText: String = "暂无标签",
) {
    val colors = AuroraTheme.colors
    val gridState = rememberLazyGridState()
    // 页面级拖拽滚动条（2026-10-08）：与文件夹/网格同一条，条目 <100 时自动不显示
    val scrollbar = rememberLazyScrollbar(gridState)

    // 滚动恢复：本次组合实例消费一次（同 FoldersOverview 的 pendingRestore 模式）
    var pendingRestore by remember { mutableIntStateOf(initialScrollAnchor) }
    LaunchedEffect(Unit) {
        val anchor = pendingRestore
        if (anchor > 0) {
            pendingRestore = 0
            runCatching { gridState.scrollToItem(anchor) }
        }
    }
    LaunchedEffect(gridState) {
        // 条目级锚点随滚动上报；scrollToItem 恢复本身也会触发一次上报（值相同，无副作用）
        snapshotFlowScrollIndex(gridState) { onScrollChanged(it) }
    }

    // 搜索过滤（UI 侧）：组内标签全被滤掉的组整组隐藏，空组名不出现
    val displayGroups = remember(tagGroups, searchQuery) {
        if (searchQuery.isBlank()) tagGroups
        else tagGroups.mapNotNull { g ->
            val hits = g.tags.filter { it.tag.contains(searchQuery, ignoreCase = true) }
            if (hits.isEmpty()) null else TagGroup(g.key, hits)
        }
    }

    if (displayGroups.isEmpty()) {
        Box(modifier = modifier, contentAlignment = Alignment.Center) {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Icon(
                    imageVector = IconTagBig,
                    contentDescription = null,
                    tint = colors.textSecondary.copy(alpha = 0.3f),
                    modifier = Modifier.size(64.dp),
                )
                Text(
                    text = emptyText,
                    fontSize = 16.sp,
                    color = colors.textSecondary,
                    modifier = Modifier.padding(top = 12.dp),
                )
            }
        }
        return
    }

    Box(modifier = modifier.fillMaxSize()) {
        LazyVerticalGrid(
            columns = GridCells.Adaptive(minSize = 120.dp),
            state = gridState,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
            contentPadding = androidx.compose.foundation.layout.PaddingValues(24.dp),
            modifier = Modifier.fillMaxSize(),
        ) {
            displayGroups.forEach { group ->
                // 组名行：通栏分隔标题（桌面 TagsList 的 header:* 条目同款）
                item(key = "header:${group.key}", span = { GridItemSpan(maxLineSpan) }) {
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .padding(top = 8.dp, bottom = 2.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Box(
                            Modifier
                                .size(32.dp)
                                .clip(RoundedCornerShape(8.dp))
                                // 桌面组名行的字母盒（blue-50 底 + blue-600 字）＝色表的 tagBg/tagText；
                                // 这两个角色在 View 档，Compose 侧经 palette 取
                                .background(Color(colors.palette.tagBg)),
                            contentAlignment = Alignment.Center,
                        ) {
                            Text(
                                group.key,
                                fontSize = 16.sp,
                                fontWeight = FontWeight.Bold,
                                color = Color(colors.palette.tagText),
                            )
                        }
                        Spacer(Modifier.size(12.dp))
                        Text(
                            "${group.tags.size} 项",
                            fontSize = 12.sp,
                            color = colors.textSecondary,
                        )
                    }
                }
                items(
                    count = group.tags.size,
                    key = { i -> "tag:${group.tags[i].tag}" },
                ) { i ->
                    val entry = group.tags[i]
                    TagCard(
                        tag = entry.tag,
                        count = entry.count,
                        onClick = { onTagClick(entry.tag) },
                    )
                }
            }
        }
        GridScrollbar(
            controller = scrollbar,
            color = colors.textSecondary,
            indicatorColor = colors.content,
            modifier = Modifier.fillMaxSize(),
        )
    }
}

/** 标签卡片（桌面 TagItem 形制：图标 + 计数徽标一行，下方粗体标签名）。 */
@Composable
private fun TagCard(tag: String, count: Long, onClick: () -> Unit) {
    val colors = AuroraTheme.colors
    Column(
        Modifier
            .fillMaxWidth()
            .aspectRatio(1.6f)
            .clip(RoundedCornerShape(8.dp))
            // 白底卡片浮在 main 灰底上（桌面 gray-50 卡片 + gray-200 描边同构）
            .background(colors.content)
            .border(1.dp, colors.subtle, RoundedCornerShape(8.dp))
            .clickable(onClick = onClick)
            .padding(14.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(
                imageVector = IconTagBig,
                contentDescription = null,
                tint = colors.primary,
                modifier = Modifier.size(18.dp),
            )
            Spacer(Modifier.weight(1f))
            Text(
                count.toString(),
                fontSize = 11.sp,
                color = colors.textSecondary,
                modifier = Modifier
                    .clip(RoundedCornerShape(50))
                    .background(colors.subtle)
                    .padding(horizontal = 8.dp, vertical = 2.dp),
            )
        }
        Spacer(Modifier.weight(1f))
        Text(
            tag,
            fontSize = 14.sp,
            fontWeight = FontWeight.Bold,
            color = colors.textPrimary,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

/** 上报首个可见条目下标（挂起收集 LazyGridState 的滚动变化）。 */
private suspend fun snapshotFlowScrollIndex(
    state: androidx.compose.foundation.lazy.grid.LazyGridState,
    onIndex: (Int) -> Unit,
) {
    androidx.compose.runtime.snapshotFlow { state.firstVisibleItemIndex }.collect { onIndex(it) }
}

// ===== 人物总览的排序与分组（桌面 PersonGrid.tsx:226-313 的安卓同位）=====
//
// 三块都是纯函数，刻意不 @Composable：排序/组序是「看着不对但很难截图证明」的那类
// 逻辑，抽成函数才能拿单测钉住（组序的 0-9 最前 / # 与未分类最后就是典型）。

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

/**
 * 可折叠组头（桌面 `PersonGrid.tsx:163-176` 的 GroupHeader 触屏同位：组名 + 数量药丸 +
 * 折叠箭头）。桌面的 hover 阴影与 sticky 不还原；整行都是触点（≥48dp），不只在箭头上——
 * 触屏上「只有 16dp 箭头可点」等于点不到。
 */
@Composable
private fun PersonGroupHeader(
    title: String,
    count: Int,
    collapsed: Boolean,
    onToggle: () -> Unit,
) {
    val colors = AuroraTheme.colors
    Row(
        Modifier
            .fillMaxWidth()
            .defaultMinSize(minHeight = 48.dp)
            .clip(RoundedCornerShape(8.dp))
            .clickable(onClick = onToggle)
            .padding(horizontal = 4.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            imageVector = IconChevronRight,
            contentDescription = if (collapsed) "展开" else "折叠",
            tint = colors.textSecondary,
            modifier = Modifier
                .size(16.dp)
                .rotate(if (collapsed) 0f else 90f),
        )
        Spacer(Modifier.size(8.dp))
        Text(
            text = title,
            fontSize = 14.sp,
            fontWeight = FontWeight.SemiBold,
            color = colors.textPrimary,
        )
        Spacer(Modifier.size(8.dp))
        Box(
            Modifier
                .clip(RoundedCornerShape(999.dp))
                .background(colors.surface)
                .padding(horizontal = 8.dp, vertical = 2.dp),
        ) {
            Text(
                text = count.toString(),
                fontSize = 11.sp,
                color = colors.textSecondary,
            )
        }
    }
}

/**
 * 人物总览。页头（标题 + 「新建人物」；**排序在顶栏那颗钮里**，页头不留第二颗）+ 一个
 * 卡片网格：**本地人物**（本机库 persons 行）在前、**远端人物**（GET /api/people 会话缓存）
 * 在后，同一个网格混排、**不写节标题**（2026-10-08 指挥官要求：本地是默认态、不需要名字
 * 标识，远端靠头像右下角的网络角标区分）；两套都空才是空态。
 *
 * 本地人物是桌面 `usePeople.ts` **手动那一半**的移植：真头像（封面缩略图 + faceBox 圆形
 * 裁剪，取不到图退回首字符占位）、单击进该人物的筛选视图、长按「重命名 / 改描述 /
 * 删除」、页头「新建人物」。桌面的智能那一半（SmartCreatePersonModal /
 * SmartAddToPersonModal，走 `clipSearchByCharacterTag`）**不移植**——本机没有 WD14/CLIP。
 *
 * 远端人物与本地卡同一个形（[LanPersonCard]）：首字符占位（契约 §3.1 无人脸头像可用）+
 * 名 + 计数 + [LanBadge] 网络角标；长按「重命名 / 改描述」，[lanAllowEdit] 直通时加「换头像」
 * （403 门禁态不出现，M4a「不适用的项不出现」先例）；单击 = 成员筛选虚拟目录。
 *
 * 编辑入口同位原则：收在总览页卡片上，不放侧栏（侧栏行只负责导航）。
 */
@Composable
fun PeopleOverview(
    modifier: Modifier = Modifier,
    /** 远端人物（GET /api/people 会话缓存，原样渲染）。 */
    lanPeople: List<LanPerson> = emptyList(),
    /** LAN 会话已连接（当前仅语义标注；显隐由 lanPeople 是否为空决定）。 */
    lanConnected: Boolean = false,
    /** 编辑门禁位（allow_edit；false 时长按菜单不含「换头像」）。 */
    lanAllowEdit: Boolean = false,
    /** 本地人物（本机库 persons 行：手动建的 + 历史 WD14 产物，同列不分家）。 */
    localPeople: List<FfiPerson> = emptyList(),
    /** 本地人物封面：coverFileId → contentUri（宿主从 VM `personCoverImagesById` 摊平）。 */
    personCoverUris: Map<String, String> = emptyMap(),
    /** 缩略图加载器（真头像用；与文件网格同一内存池/并发信号量）。null = 一律走占位。 */
    thumbnailLoader: ThumbnailLoader? = null,
    /** coverFileId → 封面图创建时间（秒）；「按创建时间」排序用（桌面读 meta.created 同语义）。 */
    personCoverCreatedAt: Map<String, Long> = emptyMap(),
    /** 界面语言（透给 collate 做拼音分组，与标签分组同一个 locale）。 */
    language: String = "zh",
    /** 排序字段 / 升降 / 分组（宿主持态并持久化，默认按数量降序 = 桌面默认）。
     *  改档位走顶栏那颗钮（[PersonSortMenuContent]），这里只消费状态做排布。 */
    sortBy: PersonSortOption = PersonSortOption.COUNT,
    sortAscending: Boolean = false,
    groupBy: PersonGroupBy = PersonGroupBy.NONE,
    /** 本地专题（「按专题」分组用，消费 `FfiTopic.peopleIds`；不传则该档退化成全进未分类）。 */
    topics: List<FfiTopic> = emptyList(),
    /** 远端卡片点击（M6b 阶段 5 / D40：成员筛选虚拟目录）。 */
    onPersonClick: (LanPerson) -> Unit = {},
    /** 长按菜单「重命名」（宿主弹输入框 → renameLanPerson(id, name, null)）。 */
    onRename: (LanPerson) -> Unit = {},
    /** 长按菜单「改描述」（宿主弹输入框 → renameLanPerson(id, null, description)）。 */
    onDescribe: (LanPerson) -> Unit = {},
    /** 长按菜单「换头像」（宿主开 AVATAR 模式的 LanFolderPickerDialog 选远端图）。 */
    onAvatarChange: (LanPerson) -> Unit = {},
    /** 本地卡片点击 = 进该人物的筛选视图（宿主 openLocalPersonFilter）。 */
    onLocalPersonClick: (FfiPerson) -> Unit = {},
    /** 本地卡片长按「重命名」/「改描述」/「删除」（宿主弹窗 → VM 写库）。 */
    onLocalRename: (FfiPerson) -> Unit = {},
    onLocalDescribe: (FfiPerson) -> Unit = {},
    onLocalDelete: (FfiPerson) -> Unit = {},
    /** 本地卡片长按「换头像」= 开头像裁剪页（桌面 CropAvatarModal 的同位入口）。 */
    onLocalSetAvatar: (FfiPerson) -> Unit = {},
    /** 页头「新建人物」（宿主弹输入框 → createLocalPerson）。 */
    onCreatePerson: () -> Unit = {},
) {
    val colors = AuroraTheme.colors
    val peopleGridState = rememberLazyGridState()
    val peopleScrollbar = rememberLazyScrollbar(peopleGridState)
    // 折叠的组（组键；桌面 collapsedGroups 同语义）。不随排序/分组切换清空——
    // 用户刚收起来的组不该因为换个排序档又弹开。
    var collapsedGroups by remember { mutableStateOf(setOf<String>()) }

    // 排序 → 组键 → 分组三步都在 UI 层算（纯函数，见文件头的三块），Rust 不参与人物排序
    val sortedPeople = remember(
        localPeople, sortBy, sortAscending, personCoverCreatedAt, language,
    ) {
        sortPeopleForDisplay(localPeople, sortBy, sortAscending, personCoverCreatedAt)
    }
    val groupKeyByName = remember(sortedPeople, groupBy, language) {
        if (groupBy != PersonGroupBy.NAME) {
            emptyMap()
        } else {
            pinyinGroupKeysByCollate(sortedPeople.map { it.name }, language)
        }
    }
    val personGroups = remember(sortedPeople, groupBy, groupKeyByName, topics) {
        buildPersonGroups(sortedPeople, groupBy, groupKeyByName, topics)
    }
    val personById = remember(sortedPeople) { sortedPeople.associateBy { it.id } }

    Column(modifier.fillMaxSize()) {
        // 页头（形制对齐 TopicsOverview：图标 + 标题 + 右侧排序/实心新建钮；触点 ≥48dp）
        Row(
            Modifier
                .fillMaxWidth()
                .padding(start = 24.dp, end = 24.dp, top = 16.dp, bottom = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                imageVector = IconBrainBig,
                contentDescription = null,
                tint = colors.primary,
                modifier = Modifier.size(22.dp),
            )
            Spacer(Modifier.size(10.dp))
            Text(
                text = "人物",
                fontSize = 22.sp,
                fontWeight = FontWeight.Bold,
                color = colors.textPrimary,
            )
            Spacer(Modifier.weight(1f))
            // 页头不放排序钮：人物总览时顶栏那颗就是人物排序（走 TopBar 的 sortMenuContent
            // 注入位）。两颗都叫「排序」同时在场，用户不知道哪颗管当前视图（2026-10-08 报障）。
            NewPersonButton(onClick = onCreatePerson)
        }

        if (lanPeople.isEmpty() && localPeople.isEmpty()) {
            // 两节都空才是空态。文案随数据模型改口径：人物现在是**手动**维护的，
            // 不再承诺「连桌面就能识别」（那条 WD14 线已按指挥官指示砍掉）。
            Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Icon(
                        imageVector = IconBrainBig,
                        contentDescription = null,
                        tint = colors.textSecondary.copy(alpha = 0.3f),
                        modifier = Modifier.size(64.dp),
                    )
                    Text(
                        text = "暂无人物",
                        fontSize = 16.sp,
                        color = colors.textSecondary,
                        modifier = Modifier.padding(top = 12.dp),
                    )
                    Text(
                        text = "点「新建人物」建一个，再在网格里选图加进去",
                        fontSize = 12.sp,
                        color = colors.textSecondary.copy(alpha = 0.7f),
                        modifier = Modifier.padding(top = 4.dp),
                    )
                }
            }
        } else {
            Box(Modifier.weight(1f).fillMaxWidth()) {
                LazyVerticalGrid(
                    columns = GridCells.Adaptive(minSize = 140.dp),
                    state = peopleGridState,
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                    contentPadding = androidx.compose.foundation.layout.PaddingValues(24.dp),
                    modifier = Modifier.fillMaxSize(),
                ) {
                    // 本地人物在前、远端在后，同一个网格混排、**不分节**（2026-10-08 指挥官
                    // 要求：本地是默认态、不需要名字标识；远端靠头像右下角的网络角标区分）。
                    // 分组只作用于本地人物：不分组时平铺，分组时逐组插可折叠组头
                    // （桌面 PersonGrid 也是 groupBy==='none' 走无组分支）。
                    if (localPeople.isNotEmpty()) {
                        if (groupBy == PersonGroupBy.NONE) {
                            items(
                                count = sortedPeople.size,
                                key = { i -> "local:${sortedPeople[i].id}" },
                            ) { i ->
                                val person = sortedPeople[i]
                                LocalPersonCard(
                                    person = person,
                                    coverUri = personCoverUris[person.coverFileId],
                                    loader = thumbnailLoader,
                                    onClick = { onLocalPersonClick(person) },
                                    onRename = { onLocalRename(person) },
                                    onDescribe = { onLocalDescribe(person) },
                                    onSetAvatar = { onLocalSetAvatar(person) },
                                    onDelete = { onLocalDelete(person) },
                                )
                            }
                        } else {
                            personGroups.forEach { group ->
                                val isCollapsed = group.id in collapsedGroups
                                item(
                                    key = "pg:${groupBy.name}:${group.id}",
                                    span = { GridItemSpan(maxLineSpan) },
                                ) {
                                    PersonGroupHeader(
                                        title = group.title,
                                        count = group.personIds.size,
                                        collapsed = isCollapsed,
                                        onToggle = {
                                            collapsedGroups = if (isCollapsed) {
                                                collapsedGroups - group.id
                                            } else {
                                                collapsedGroups + group.id
                                            }
                                        },
                                    )
                                }
                                if (!isCollapsed) {
                                    items(
                                        count = group.personIds.size,
                                        key = { i -> "local:${group.personIds[i]}" },
                                    ) { i ->
                                        // 组是刚从 sortedPeople 算出来的，查不到只可能是
                                        // 快照在组合中途被换掉——跳过这一格，不拿 null 崩页面
                                        personById[group.personIds[i]]?.let { person ->
                                            LocalPersonCard(
                                                person = person,
                                                coverUri = personCoverUris[person.coverFileId],
                                                loader = thumbnailLoader,
                                                onClick = { onLocalPersonClick(person) },
                                                onRename = { onLocalRename(person) },
                                                onDescribe = { onLocalDescribe(person) },
                                                onSetAvatar = { onLocalSetAvatar(person) },
                                                onDelete = { onLocalDelete(person) },
                                            )
                                        }
                                    }
                                }
                            }
                        }
                    }
                    if (lanPeople.isNotEmpty()) {
                        items(
                            count = lanPeople.size,
                            key = { i -> lanPeople[i].id },
                        ) { i ->
                            LanPersonCard(
                                person = lanPeople[i],
                                lanAllowEdit = lanAllowEdit,
                                onClick = { onPersonClick(lanPeople[i]) },
                                onRename = { onRename(lanPeople[i]) },
                                onDescribe = { onDescribe(lanPeople[i]) },
                                onAvatarChange = { onAvatarChange(lanPeople[i]) },
                            )
                        }
                    }
                }
                GridScrollbar(
                    controller = peopleScrollbar,
                    color = colors.textSecondary,
                    indicatorColor = colors.content,
                    modifier = Modifier.fillMaxSize(),
                )
            }
        }
    }
}

/**
 * 「新建人物」入口（形制照 TopicsOverview 的 `NewTopicButton`：实心主色 + 加号 + 文案，
 * 触点 ≥48dp）。桌面是「总览页空白处右键 → 新建人物」，触屏没有右键，收进页头常驻钮。
 */
@Composable
private fun NewPersonButton(onClick: () -> Unit) {
    val colors = AuroraTheme.colors
    Row(
        Modifier
            .defaultMinSize(minHeight = 48.dp)
            .clip(RoundedCornerShape(10.dp))
            .background(colors.primaryDeep)
            .clickable(onClick = onClick)
            .padding(horizontal = 18.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            imageVector = IconPlus,
            contentDescription = null,
            tint = Color.White,
            modifier = Modifier.size(18.dp),
        )
        Spacer(Modifier.size(8.dp))
        Text(
            "新建人物",
            fontSize = 15.sp,
            fontWeight = FontWeight.Bold,
            color = Color.White,
        )
    }
}

/**
 * 本地人物卡：圆形真头像 + 名 + 计数。点击 = 进筛选视图，长按 = 编辑菜单。
 *
 * 头像取不到（没有封面 / 图已删 / 加载失败 / 没给 loader）时退回**首字符圆形占位**，
 * 即移植前的形态——占位不是错误态，是正常兜底。
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun LocalPersonCard(
    person: FfiPerson,
    coverUri: String?,
    loader: ThumbnailLoader?,
    onClick: () -> Unit,
    onRename: () -> Unit,
    onDescribe: () -> Unit,
    onSetAvatar: () -> Unit,
    onDelete: () -> Unit,
) {
    val colors = AuroraTheme.colors
    var menuOpen by remember { mutableStateOf(false) }
    var anchor by remember { mutableStateOf(androidx.compose.ui.geometry.Rect.Zero) }
    val avatar = rememberPersonAvatar(loader, coverUri, person.faceBox)
    Column(
        modifier = Modifier
            // fillMaxWidth 必须有：LazyGrid 的格子宽是定值，Column 不设就按最宽子项裹起
            // 来、贴在格子左边，名字短的人物卡看着就是歪的（LanPersonCard 同理）
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .combinedClickable(onClick = onClick, onLongClick = { menuOpen = true })
            .onGloballyPositioned { anchor = it.boundsInWindow() }
            .padding(8.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        AuroraDropdown(
            expanded = menuOpen,
            anchorBoundsInWindow = anchor,
            onDismissRequest = { menuOpen = false },
        ) {
            AuroraMenuItem(
                text = "重命名",
                leading = {
                    Icon(
                        imageVector = IconPencil,
                        contentDescription = null,
                        tint = colors.textSecondary,
                        modifier = Modifier.size(16.dp),
                    )
                },
                onClick = {
                    menuOpen = false
                    onRename()
                },
            )
            AuroraMenuItem(
                text = "改描述",
                leading = {
                    Icon(
                        imageVector = IconType,
                        contentDescription = null,
                        tint = colors.textSecondary,
                        modifier = Modifier.size(16.dp),
                    )
                },
                onClick = {
                    menuOpen = false
                    onDescribe()
                },
            )
            AuroraMenuItem(
                text = "换头像",
                leading = {
                    Icon(
                        imageVector = IconImage,
                        contentDescription = null,
                        tint = colors.textSecondary,
                        modifier = Modifier.size(16.dp),
                    )
                },
                onClick = {
                    menuOpen = false
                    onSetAvatar()
                },
            )
            AuroraMenuItem(
                text = "删除",
                textColor = Color(0xFFEF4444),
                leading = {
                    Icon(
                        imageVector = IconTrash2,
                        contentDescription = null,
                        tint = Color(0xFFEF4444),
                        modifier = Modifier.size(16.dp),
                    )
                },
                onClick = {
                    menuOpen = false
                    onDelete()
                },
            )
        }
        PersonCardAvatar(name = person.name, avatar = avatar)
        Text(
            text = person.name,
            fontSize = 15.sp,
            color = colors.textPrimary,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.padding(top = 6.dp),
        )
        Text(
            text = "${person.count} 张",
            fontSize = 12.sp,
            color = colors.textSecondary,
        )
    }
}

/**
 * 人物头像位图：contentUri → MediaStore id → ThumbnailLoader 取图 → 按 faceBox 裁方形。
 *
 * 同步取内存缓存做初值（[ThumbnailLoader.peekMemory]），LazyGrid 回收重进时不闪占位符
 * ——形制同 FoldersOverview 的封面加载。裁剪在 [cropSquareToAvatar]。
 */
@Composable
private fun rememberPersonAvatar(
    loader: ThumbnailLoader?,
    coverUri: String?,
    faceBox: FfiFaceBox?,
): Bitmap? {
    if (loader == null || coverUri.isNullOrEmpty()) return null
    val imageId = remember(coverUri) { loader.extractImageId(coverUri) }
    val cached = remember(imageId) { loader.peekMemory(imageId) }
    var bitmap by remember(imageId, faceBox) {
        mutableStateOf(cached?.let { cropSquareToAvatar(it, faceBox) })
    }
    LaunchedEffect(imageId, faceBox) {
        val src = cached ?: loader.loadFastLimited(imageId)
        // 裁剪挪 IO：createBitmap 要复制像素，人物一多全压主线程会掉帧
        bitmap = src?.let { bmp ->
            withContext(Dispatchers.IO) { cropSquareToAvatar(bmp, faceBox) }
        }
    }
    return bitmap
}

/**
 * 按 faceBox 裁成正方形位图（头像容器是圆，非方形部分露不出来）。
 *
 * faceBox 是**百分比坐标**（x/y = 左上角占比，w/h = 宽高占比，0..100），口径同桌面
 * `utils/cropStyle.ts` 的 CropRect。与桌面有一处刻意不同：桌面的 `cropToImgStyle` 对
 * 宽高分别按 `10000/w%`、`10000/h%` 缩放，非方形框会被**拉伸变形**；这里改成取框内
 * 最大的居中正方形，不变形。无框 / 退化框（w 或 h ≤ 0）→ 整图中心正方形，等价桌面
 * 的 `centerCrop`。
 */
private fun cropSquareToAvatar(src: Bitmap, faceBox: FfiFaceBox?): Bitmap {
    val fallbackSide = minOf(src.width, src.height)
    var x = (src.width - fallbackSide) / 2
    var y = (src.height - fallbackSide) / 2
    var side = fallbackSide
    if (faceBox != null && faceBox.w > 0.0 && faceBox.h > 0.0) {
        val bw = (faceBox.w / 100.0 * src.width).toInt().coerceIn(1, src.width)
        val bh = (faceBox.h / 100.0 * src.height).toInt().coerceIn(1, src.height)
        val bx = (faceBox.x / 100.0 * src.width).toInt().coerceIn(0, src.width - 1)
        val by = (faceBox.y / 100.0 * src.height).toInt().coerceIn(0, src.height - 1)
        val s = minOf(bw, bh, src.width - bx, src.height - by)
        if (s > 0) {
            side = s
            x = bx + (bw - s) / 2
            y = by + (bh - s) / 2
        }
    }
    if (side <= 0 || x < 0 || y < 0 || x + side > src.width || y + side > src.height) return src
    // 不可变位图上 createBitmap 会抛；缩略图来自解码器一般可变，兜住不崩
    return runCatching { Bitmap.createBitmap(src, x, y, side, side) }.getOrDefault(src)
}

/**
 * 远端人物卡：与 [LocalPersonCard] **同一个形**（96dp 圆头像 + 名 + 张数），差别只有头像
 * 右下角那枚 [LanBadge] 网络角标——远端没有可用的人脸框（契约 §3.1），一律首字符占位。
 * 去节标题后两套数据混排在一个网格里，形制必须一致才不像两张清单拼起来。
 * 长按弹「重命名/改描述」；[lanAllowEdit] 直通时再加「换头像」（阶段 6，
 * 见 [PeopleOverview] 注释）。
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun LanPersonCard(
    person: LanPerson,
    onClick: () -> Unit,
    onRename: () -> Unit,
    onDescribe: () -> Unit,
    lanAllowEdit: Boolean = false,
    onAvatarChange: () -> Unit = {},
) {
    val colors = AuroraTheme.colors
    var menuOpen by remember { mutableStateOf(false) }
    var anchor by remember { mutableStateOf(androidx.compose.ui.geometry.Rect.Zero) }
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .combinedClickable(onClick = onClick, onLongClick = { menuOpen = true })
            .onGloballyPositioned { anchor = it.boundsInWindow() }
            .padding(8.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        // 长按菜单：「重命名」「改描述」；「换头像」仅编辑门禁位直通时出现（阶段 6 起接
        // LanFolderPickerDialog 选远端图；403 门禁态不出现——M4a「不适用的项不出现」先例）
        AuroraDropdown(
            expanded = menuOpen,
            anchorBoundsInWindow = anchor,
            onDismissRequest = { menuOpen = false },
        ) {
            AuroraMenuItem(
                text = "重命名",
                leading = {
                    Icon(
                        imageVector = IconPencil,
                        contentDescription = null,
                        tint = colors.textSecondary,
                        modifier = Modifier.size(16.dp),
                    )
                },
                onClick = {
                    menuOpen = false
                    onRename()
                },
            )
            AuroraMenuItem(
                text = "改描述",
                leading = {
                    Icon(
                        imageVector = IconType,
                        contentDescription = null,
                        tint = colors.textSecondary,
                        modifier = Modifier.size(16.dp),
                    )
                },
                onClick = {
                    menuOpen = false
                    onDescribe()
                },
            )
            if (lanAllowEdit) {
                AuroraMenuItem(
                    text = "换头像",
                    leading = {
                        Icon(
                            imageVector = IconImage,
                            contentDescription = null,
                            tint = colors.textSecondary,
                            modifier = Modifier.size(16.dp),
                        )
                    },
                    onClick = {
                        menuOpen = false
                        onAvatarChange()
                    },
                )
            }
        }
        PersonCardAvatar(
            name = person.name,
            avatar = null,
            badge = { LanBadge() },
        )
        Text(
            text = person.name,
            fontSize = 15.sp,
            color = colors.textPrimary,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.padding(top = 6.dp),
        )
        Text(
            text = "${person.count} 张",
            fontSize = 12.sp,
            color = colors.textSecondary,
        )
    }
}

/**
 * 人物卡的圆头像位（96dp，本地/远端同一个形）：有封面时上按 faceBox 裁好的真头像，
 * 取不到图与远端人物一律走首字符占位。[badge] 叠在右下角、不参与圆形裁剪——
 * 远端人物用它标识网络来源，替代原先的「远端人物」文字节标题。
 */
@Composable
private fun PersonCardAvatar(
    name: String,
    avatar: Bitmap?,
    badge: (@Composable () -> Unit)? = null,
) {
    val colors = AuroraTheme.colors
    Box {
        Box(
            modifier = Modifier
                .size(96.dp)
                .clip(CircleShape)
                .background(colors.surface)
                .border(1.dp, colors.subtle, CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            if (avatar != null) {
                Image(
                    bitmap = avatar.asImageBitmap(),
                    contentDescription = name,
                    contentScale = ContentScale.Crop,
                    modifier = Modifier.fillMaxSize(),
                )
            } else {
                Text(
                    text = name.take(1).ifEmpty { "?" },
                    fontSize = 32.sp,
                    fontWeight = FontWeight.Medium,
                    color = colors.primary,
                )
            }
        }
        if (badge != null) {
            Box(
                Modifier
                    .align(Alignment.BottomEnd)
                    .padding(4.dp),
                contentAlignment = Alignment.Center,
            ) { badge() }
        }
    }
}

/**
 * 网络来源角标：翡翠绿圆片 + Wifi 字形（色值取自侧栏远端 Section 的 SECTION_EMERALD，
 * 与侧栏远端行的 12dp Wifi 前缀同一套标识）。外圈描内容底色，压在照片上才不会糊成一团。
 */
@Composable
private fun LanBadge() {
    val colors = AuroraTheme.colors
    Box(
        Modifier
            .size(22.dp)
            .clip(CircleShape)
            .background(SECTION_EMERALD)
            .border(1.5.dp, colors.content, CircleShape),
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            imageVector = IconWifi,
            contentDescription = "网络人物",
            tint = Color.White,
            modifier = Modifier.size(12.dp),
        )
    }
}

/**
 * 远端人物输入弹窗（M6a 阶段 5）：复用 [CreateTopicDialog] 的形制（AlertDialog +
 * OutlinedTextField + 确认/取消），重命名与改描述共用一个组件。[allowEmpty] =
 * 允许空串确认（改描述的空串 = 清空描述，契约 §3.2 的整行写语义）；重命名恒 false。
 */
@Composable
fun LanPersonEditDialog(
    title: String,
    initialText: String,
    placeholder: String,
    confirmLabel: String,
    onDismiss: () -> Unit,
    onConfirm: (String) -> Unit,
    allowEmpty: Boolean = false,
) {
    val colors = AuroraTheme.colors
    var text by remember { mutableStateOf(initialText) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = {
            OutlinedTextField(
                value = text,
                onValueChange = { text = it },
                singleLine = true,
                placeholder = { Text(placeholder, color = colors.textSecondary) },
            )
        },
        confirmButton = {
            TextButton(
                enabled = allowEmpty || text.isNotBlank(),
                onClick = { onConfirm(text.trim()) },
            ) {
                Text(
                    confirmLabel,
                    color = if (allowEmpty || text.isNotBlank()) colors.primaryDeep else colors.textSecondary,
                )
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text("取消", color = colors.textPrimary)
            }
        },
    )
}

/**
 * 「添加到人物」选择弹窗（桌面 `AddToPersonModal` 的触屏同位）：搜索框 + **多选**人物
 * 列表 + 底部「添加」。多选而非单选是照桌面口径——一批图往往同属几个人物，一次勾完
 * 比来回点 N 次少 N-1 步（VM `addFilesToLocalPersons` 本来就吃 id 列表）。
 *
 * 形制（AlertDialog + 48dp 行 + 圆角面板列表）沿用同仓 `TopicPickerDialog`，不新造视觉。
 * 行首是首字符圆点而非真头像：弹窗里人物量级小、且这一层的任务是「认名字」不是「认脸」。
 */
@Composable
fun PersonPickerDialog(
    people: List<FfiPerson>,
    onDismiss: () -> Unit,
    onPick: (List<String>) -> Unit,
    /** 标题与确认文案（宿主按「加入 / 解绑」两种语义给）。 */
    title: String = "添加到人物",
    confirmLabel: String = "添加",
    emptyHint: String = "暂无人物。先在人物页点「新建人物」建一个，再把图加进来。",
) {
    val colors = AuroraTheme.colors
    var query by remember { mutableStateOf("") }
    var selected by remember { mutableStateOf(setOf<String>()) }
    val filtered = remember(people, query) {
        val q = query.trim()
        if (q.isEmpty()) people else people.filter { it.name.contains(q, ignoreCase = true) }
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = {
            if (people.isEmpty()) {
                Text(emptyHint, color = colors.textSecondary)
            } else {
                Column {
                    OutlinedTextField(
                        value = query,
                        onValueChange = { query = it },
                        singleLine = true,
                        placeholder = { Text("搜索人物", color = colors.textSecondary) },
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Spacer(Modifier.height(8.dp))
                    if (filtered.isEmpty()) {
                        Text(
                            "没有匹配「$query」的人物",
                            color = colors.textSecondary,
                            modifier = Modifier.padding(vertical = 12.dp),
                        )
                    } else {
                        LazyColumn(
                            Modifier
                                .fillMaxWidth()
                                .heightIn(max = 340.dp)
                                .clip(RoundedCornerShape(12.dp))
                                .background(colors.panel),
                        ) {
                            items(
                                count = filtered.size,
                                key = { i -> filtered[i].id },
                            ) { i ->
                                val person = filtered[i]
                                val checked = person.id in selected
                                Row(
                                    Modifier
                                        .fillMaxWidth()
                                        .defaultMinSize(minHeight = 48.dp)
                                        .clip(RoundedCornerShape(8.dp))
                                        .clickable {
                                            selected = if (checked) selected - person.id
                                            else selected + person.id
                                        }
                                        .padding(horizontal = 8.dp, vertical = 8.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                ) {
                                    Spacer(Modifier.size(4.dp))
                                    Box(
                                        Modifier
                                            .size(28.dp)
                                            .clip(CircleShape)
                                            .background(colors.surface)
                                            .border(1.dp, colors.subtle, CircleShape),
                                        contentAlignment = Alignment.Center,
                                    ) {
                                        Text(
                                            person.name.take(1),
                                            fontSize = 13.sp,
                                            fontWeight = FontWeight.Medium,
                                            color = colors.primary,
                                        )
                                    }
                                    Spacer(Modifier.size(10.dp))
                                    Text(
                                        person.name,
                                        fontSize = 15.sp,
                                        color = colors.textPrimary,
                                        maxLines = 1,
                                        overflow = TextOverflow.Ellipsis,
                                        modifier = Modifier.weight(1f),
                                    )
                                    Text(
                                        "${person.count}",
                                        fontSize = 12.sp,
                                        color = colors.textSecondary,
                                    )
                                    Spacer(Modifier.size(10.dp))
                                    Text(
                                        if (checked) "✓" else "",
                                        fontSize = 16.sp,
                                        fontWeight = FontWeight.Bold,
                                        color = colors.primaryDeep,
                                    )
                                }
                            }
                        }
                    }
                }
            }
        },
        confirmButton = {
            TextButton(
                enabled = selected.isNotEmpty(),
                onClick = { onPick(selected.toList()) },
            ) {
                Text(
                    if (selected.isEmpty()) confirmLabel else "$confirmLabel（${selected.size}）",
                    color = if (selected.isNotEmpty()) colors.primaryDeep else colors.textSecondary,
                )
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text("取消", color = colors.textPrimary)
            }
        },
    )
}

private val IconBrainBig: ImageVector by lazy {
    ImageVector.Builder(
        name = "BrainBig",
        defaultWidth = 24.dp,
        defaultHeight = 24.dp,
        viewportWidth = 24f,
        viewportHeight = 24f,
    ).apply {
        path(
            stroke = SolidColor(Color.Black),
            strokeLineWidth = 2f,
            strokeLineCap = androidx.compose.ui.graphics.StrokeCap.Round,
            strokeLineJoin = androidx.compose.ui.graphics.StrokeJoin.Round,
        ) {
            // 与 TreeSidebar 的 IconBrain 同形（两片脑叶 + 中缝），那边是 private 就地复制
            moveTo(12f, 5f)
            curveTo(10.9f, 3.9f, 8.6f, 3.9f, 7.2f, 5.1f)
            curveTo(5.2f, 5.6f, 4.1f, 7.7f, 4.9f, 9.6f)
            curveTo(3.4f, 10.9f, 3.3f, 13.3f, 4.7f, 14.7f)
            curveTo(4.5f, 16.9f, 6.3f, 18.8f, 8.5f, 18.7f)
            curveTo(9.4f, 19.7f, 11.2f, 19.8f, 12f, 18.6f)
            close()
            moveTo(12f, 5f)
            curveTo(13.1f, 3.9f, 15.4f, 3.9f, 16.8f, 5.1f)
            curveTo(18.8f, 5.6f, 19.9f, 7.7f, 19.1f, 9.6f)
            curveTo(20.6f, 10.9f, 20.7f, 13.3f, 19.3f, 14.7f)
            curveTo(19.5f, 16.9f, 17.7f, 18.8f, 15.5f, 18.7f)
            curveTo(14.6f, 19.7f, 12.8f, 19.8f, 12f, 18.6f)
            close()
            moveTo(15f, 13f)
            curveTo(13.8f, 12.2f, 12.5f, 10.8f, 12f, 9.2f)
            curveTo(11.5f, 10.8f, 10.2f, 12.2f, 9f, 13f)
        }
    }.build()
}

/** lucide Tag（总览卡片/空态用；与 TreeSidebar 的 IconTagBadge 同形，含铆点）。 */
private val IconTagBig: ImageVector by lazy {
    ImageVector.Builder(
        name = "TagBig",
        defaultWidth = 24.dp,
        defaultHeight = 24.dp,
        viewportWidth = 24f,
        viewportHeight = 24f,
    ).apply {
        path(
            stroke = SolidColor(Color.Black),
            strokeLineWidth = 2f,
            strokeLineCap = androidx.compose.ui.graphics.StrokeCap.Round,
            strokeLineJoin = androidx.compose.ui.graphics.StrokeJoin.Round,
        ) {
            moveTo(12.586f, 2.586f)
            arcTo(2f, 2f, 0f, false, false, 11.172f, 2f)
            lineTo(4f, 2f)
            arcTo(2f, 2f, 0f, false, false, 2f, 4f)
            lineTo(2f, 11.172f)
            arcTo(2f, 2f, 0f, false, false, 2.586f, 12.586f)
            lineTo(11.29f, 21.29f)
            arcTo(2.426f, 2.426f, 0f, false, false, 14.71f, 21.29f)
            lineTo(21.29f, 14.71f)
            arcTo(2.426f, 2.426f, 0f, false, false, 21.29f, 11.29f)
            close()
            moveTo(7.5f, 7.5f)
            lineTo(7.51f, 7.5f)
        }
    }.build()
}
