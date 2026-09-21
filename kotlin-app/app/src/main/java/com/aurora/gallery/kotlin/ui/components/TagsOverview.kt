package com.aurora.gallery.kotlin.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
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
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.path
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.aurora.gallery.kotlin.ui.theme.AuroraTheme
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
 * 人物总览（M4a 3.2）。D11=③ 的空壳：数据源在 M6（人脸识别 / AI 打标 / 互联态读桌面库），
 * 本轮只做「有入口、有总览、空态文案正确」，**不造假数据**（清单 3.1 同一口径）。
 */
@Composable
fun PeopleOverview(modifier: Modifier = Modifier) {
    val colors = AuroraTheme.colors
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
                text = "人物识别将在后续版本提供",
                fontSize = 12.sp,
                color = colors.textSecondary.copy(alpha = 0.7f),
                modifier = Modifier.padding(top = 4.dp),
            )
        }
    }
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
