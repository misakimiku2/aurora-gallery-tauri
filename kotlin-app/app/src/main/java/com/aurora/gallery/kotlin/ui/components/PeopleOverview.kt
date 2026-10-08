package com.aurora.gallery.kotlin.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.rememberLazyGridState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.path
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.aurora.gallery.kotlin.LanPerson
import com.aurora.gallery.kotlin.ThumbnailLoader
import com.aurora.gallery.kotlin.state.PersonGroupBy
import com.aurora.gallery.kotlin.state.PersonSortOption
import com.aurora.gallery.kotlin.ui.theme.AuroraTheme
import uniffi.aurora_core.FfiPerson
import uniffi.aurora_core.FfiTopic

/**
 * 人物总览页。
 *
 * 2026-10-09 从 `TagsOverview.kt` 拆出：那一个文件同时装了标签总览和整个人物总览
 * （1332 行），人物这一半独立成文件。排序/分组的纯函数在 [PersonSorting] 一侧，
 * 卡片在 [PersonCards] 一侧，弹窗在 [PersonDialogs] 一侧，本文件只管**页面装配**。
 */

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
 * 名 + 计数 + LanBadge 网络角标；长按「重命名 / 改描述」，[lanAllowEdit] 直通时加「换头像」
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

    // 排序 → 组键 → 分组三步都在 UI 层算（纯函数，见 PersonSorting.kt），Rust 不参与人物排序
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
                    contentPadding = PaddingValues(24.dp),
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

/** lucide Brain（页头与空态用；与 TreeSidebar 的 IconBrain 同形，两片脑叶 + 中缝）。 */
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
