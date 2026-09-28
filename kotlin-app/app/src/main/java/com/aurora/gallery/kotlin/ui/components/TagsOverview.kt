package com.aurora.gallery.kotlin.ui.components

import androidx.compose.foundation.ExperimentalFoundationApi
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
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.path
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.aurora.gallery.kotlin.LanPerson
import com.aurora.gallery.kotlin.ui.theme.AuroraTheme
import uniffi.aurora_core.FfiPerson
import uniffi.aurora_core.TagGroup

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

    LazyVerticalGrid(
        columns = GridCells.Adaptive(minSize = 120.dp),
        state = gridState,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(24.dp),
        modifier = modifier.fillMaxSize(),
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

/**
 * 人物总览。远端人物卡网格（M6a 阶段 5，D31 并入口径）：connected 且有远端人物时渲染
 * 卡片（首字符圆底头像占位——契约 §3.1 无人脸头像可用——+ 名 + 计数 + 网络标识）；
 * 断线/无远端人物维持既有静态占位（逐像素一致）。
 *
 * 编辑入口（同位原则收在总览页，不放侧栏）：长按卡片 → 「重命名」「改描述」；
 * 「换头像」（M6a 阶段 6 起，[lanAllowEdit] 直通时）→ LanFolderPickerDialog 选远端图
 * （宿主把选中 path 交给 renameLanPerson 的 avatarPath）；403 门禁态不出现
 *（M4a「不适用的项不出现」先例）。点击卡片 = 宿主 Toast 占位（契约无成员枚举端点，
 * 不做假筛选）。
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
    /**
     * 本地人物（M6b 阶段 4，D37：WD14 互联态识别写本地库的 `person_{tag}` 行）。
     * 非空时在远端人物之前插「本地人物」节；空则不渲染该节（空态文案维持）。
     */
    localPeople: List<FfiPerson> = emptyList(),
    /** 卡片点击（M6b 阶段 5 / D40：远端成员筛选视图；本地人物宿主暂 Toast）。 */
    onPersonClick: (LanPerson) -> Unit = {},
    /** 长按菜单「重命名」（宿主弹输入框 → renameLanPerson(id, name, null)）。 */
    onRename: (LanPerson) -> Unit = {},
    /** 长按菜单「改描述」（宿主弹输入框 → renameLanPerson(id, null, description)）。 */
    onDescribe: (LanPerson) -> Unit = {},
    /** 长按菜单「换头像」（宿主开 AVATAR 模式的 LanFolderPickerDialog 选远端图）。 */
    onAvatarChange: (LanPerson) -> Unit = {},
) {
    val colors = AuroraTheme.colors
    if (lanPeople.isEmpty() && localPeople.isEmpty()) {
        // 无本地人物且无远端人物：空态（M6b 起语义=连桌面识别人物）
        Box(modifier = modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
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
                    text = "连接桌面端后，选中图片即可识别人物（AI 视觉）",
                    fontSize = 12.sp,
                    color = colors.textSecondary.copy(alpha = 0.7f),
                    modifier = Modifier.padding(top = 4.dp),
                )
            }
        }
        return
    }
    LazyVerticalGrid(
        columns = GridCells.Adaptive(minSize = 140.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(24.dp),
        modifier = modifier.fillMaxSize(),
    ) {
        // M6b 阶段 4（D37）：本地人物节（WD14 识别产物；点击暂 Toast——本地人物
        // 筛选视图未列验收，只保展示）
        if (localPeople.isNotEmpty()) {
            item(span = { GridItemSpan(maxLineSpan) }) {
                Column {
                    Text(
                        text = "本地人物",
                        fontSize = 13.sp,
                        fontWeight = FontWeight.SemiBold,
                        color = colors.textSecondary,
                    )
                    Spacer(Modifier.height(4.dp))
                }
            }
            items(
                count = localPeople.size,
                key = { i -> "local:${localPeople[i].id}" },
            ) { i ->
                val person = localPeople[i]
                Column(
                    modifier = Modifier
                        .clip(RoundedCornerShape(12.dp))
                        .clickable { }
                        .padding(8.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    // 头像：人物无远端缩略图可用，首字符圆形占位（对齐桌面 initials 形制）
                    Box(
                        modifier = Modifier
                            .size(64.dp)
                            .clip(CircleShape)
                            .background(colors.surface)
                            .border(1.dp, colors.subtle, CircleShape),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(
                            text = person.name.take(1),
                            fontSize = 24.sp,
                            fontWeight = FontWeight.Medium,
                            color = colors.primary,
                        )
                    }
                    Text(
                        text = person.name,
                        fontSize = 13.sp,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.padding(top = 6.dp),
                    )
                    Text(
                        text = "${person.count} 张",
                        fontSize = 11.sp,
                        color = colors.textSecondary,
                    )
                }
            }
        }
        if (lanPeople.isNotEmpty()) {
            if (localPeople.isNotEmpty()) {
                item(span = { GridItemSpan(maxLineSpan) }) {
                    Text(
                        text = "远端人物",
                        fontSize = 13.sp,
                        fontWeight = FontWeight.SemiBold,
                        color = colors.textSecondary,
                        modifier = Modifier.padding(top = 8.dp),
                    )
                }
            }
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
}

/**
 * 远端人物卡（形制对齐 [TagCard] 的白底卡 + 细边框）：头像占位 + 名称 + 计数行（带
 * 网络标识）。长按弹「重命名/改描述」；[lanAllowEdit] 直通时再加「换头像」（阶段 6，
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
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .background(colors.content)
            .border(1.dp, colors.subtle, RoundedCornerShape(8.dp))
            .combinedClickable(onClick = onClick, onLongClick = { menuOpen = true })
            .onGloballyPositioned { anchor = it.boundsInWindow() }
            .padding(14.dp),
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
        PersonAvatar(name = person.name, size = 56.dp)
        Spacer(Modifier.size(10.dp))
        Text(
            person.name,
            fontSize = 14.sp,
            fontWeight = FontWeight.Bold,
            color = colors.textPrimary,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        Spacer(Modifier.size(6.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(
                imageVector = IconWifi,
                contentDescription = null,
                tint = SECTION_EMERALD,
                modifier = Modifier.size(12.dp),
            )
            Spacer(Modifier.size(4.dp))
            Text(
                person.count.toString(),
                fontSize = 11.sp,
                color = colors.textSecondary,
                modifier = Modifier
                    .clip(RoundedCornerShape(50))
                    .background(colors.subtle)
                    .padding(horizontal = 8.dp, vertical = 2.dp),
            )
        }
    }
}

/**
 * 人物头像占位（首字符 + 人物紫圆底；侧栏与总览同源，色值取自 TreeSidebar 的
 * SECTION_PURPLE）。[size] 侧栏 28dp、总览卡 56dp。
 */
@Composable
private fun PersonAvatar(name: String, size: androidx.compose.ui.unit.Dp) {
    Box(
        Modifier
            .size(size)
            .clip(RoundedCornerShape(50))
            .background(PEOPLE_ACCENT.copy(alpha = 0.18f)),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            name.firstOrNull()?.uppercase() ?: "?",
            fontSize = (size.value / 2.6f).sp,
            fontWeight = FontWeight.Bold,
            color = PEOPLE_ACCENT,
        )
    }
}

/** 人物紫（对齐侧栏人物 Section 的 purple-500；总览卡的头像/标识用色同源）。 */
private val PEOPLE_ACCENT = Color(0xFFA855F7)

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
