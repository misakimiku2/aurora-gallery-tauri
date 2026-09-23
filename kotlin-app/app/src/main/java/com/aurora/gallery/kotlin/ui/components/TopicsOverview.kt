package com.aurora.gallery.kotlin.ui.components

import android.graphics.Bitmap
import androidx.compose.animation.core.EaseOut
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Image
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
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.requiredWidth
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.rememberLazyGridState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
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
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.path
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.aurora.gallery.kotlin.ThumbnailLoader
import com.aurora.gallery.kotlin.ui.theme.AuroraTheme
import uniffi.aurora_core.FfiTopic
import uniffi.aurora_core.Image
import java.text.Collator
import java.util.Locale

/**
 * 专题总览（M4a 3.2 落地；3.3 视觉对齐桌面 `TopicModule` 的总览层）。
 *
 * 桌面形态 → 触屏适配（desktop-to-android 适配表）：
 *  - 杂志式专题卡（标题叠在封面顶部黑渐变条上、左下两行计数、右下类型胶囊、无封面
 *    靛紫渐变占位、静态阴影 + 12dp 圆角）→ 原样还原；hover 阴影/封面缩放不还原
 *    （触屏无 hover），单击 = 进详情（桌面双击进入的触屏等价物）；
 *  - 页头「专题」标题 + 排序菜单 + 蓝色实心「新建专题」按钮 → 常驻（触屏无 hover，
 *    桌面 Section 头 hover 的 + 在这里是实心按钮）；自动分类/来源筛选属桌面 AI 链路
 *    （M6），不做；
 *  - 排序（桌面 localStorage 持久化的 name/time × asc/desc）→ 宿主持久化同名语义；
 *  - 右键菜单（重命名/设置封面/删除/智能创建）→ 4.3 长按菜单收口：**重命名/删除**
 *    在卡片长按弹层（[onRenameTopic]/[onDeleteTopic]，桌面 single 右键的触屏同位；
 *    「设置专题封面」的同位入口挪到专题详情——选中一张成员图 → 更多菜单「设为封面」，
 *    触屏上比「卡片右键再弹选图器」少一层模态；「智能创建」属 AI 链路归 M6。
 *
 * 封面：有 coverFileId 的专题经 [coverImages]（VM 已解析的 Image）加载缩略图；没有或
 * 已失效 → 靛紫渐变 + 白色 Layout 图标占位。卡片左下计数 = [topicTreeTotals]（本专题
 * + 递归子专题，桌面 getTotalPersonCount/getTotalFileCount 同语义）；`fileCount` 是
 * 列表口径（fileIds 懒加载恒空，别用 fileIds.size——0.1 记过的坑）。
 *
 * [sidebarVisible] 是侧栏的**目标**状态：LazyVerticalGrid 没有列数动画，侧栏开合的
 * 300ms 里若用 Adaptive 每帧重算列数，跨阈值瞬间整个网格会跳一档（3.3fix 用户反馈）。
 * 这里学 FileGrid 3.5 的「列数预测」：列数按动画结束后的内容宽度一次收敛，动画期间
 * 卡片只做连续的宽度缩放。
 */
@Composable
fun TopicsOverview(
    topics: List<FfiTopic>,
    /** coverFileId → 已解析的 Image（宿主 VM 一次取齐），缺 = 无封面或封面已失效。 */
    coverImages: Map<String, Image>,
    thumbnailLoader: ThumbnailLoader,
    onTopicClick: (FfiTopic) -> Unit,
    onCreateTopic: () -> Unit,
    /** 4.3 长按菜单：重命名（宿主弹输入框，走 upsertTopic 整行写）。 */
    onRenameTopic: (FfiTopic) -> Unit = {},
    /** 4.3 长按菜单：删除（宿主弹确认框，递归删子专题）。 */
    onDeleteTopic: (FfiTopic) -> Unit = {},
    modifier: Modifier = Modifier,
    /** 返回总览时恢复的滚动位置（首个可见条目下标，同 [TagsOverview] 的锚点语义）。 */
    initialScrollAnchor: Int = 0,
    onScrollChanged: (Int) -> Unit = {},
    /** 排序字段/方向（宿主持久化，桌面 aurora_topic_sort_* 同语义）。 */
    sortOption: TopicSortOption = TopicSortOption.TIME,
    sortAscending: Boolean = false,
    onSortChange: (TopicSortOption, Boolean) -> Unit = { _, _ -> },
    /** 侧栏目标可见性（列数预测用，见 KDoc）。 */
    sidebarVisible: Boolean = false,
) {
    val colors = AuroraTheme.colors
    val totals = remember(topics) { topicTreeTotals(topics) }
    Column(modifier.fillMaxSize()) {
        // 页头（桌面 renderGallery 标题栏：h2「专题」+ 右侧排序/新建）
        Row(
            Modifier
                .fillMaxWidth()
                .padding(start = 24.dp, end = 24.dp, top = 16.dp, bottom = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                imageVector = IconLayoutBig,
                contentDescription = null,
                tint = colors.topicPink,
                modifier = Modifier.size(22.dp),
            )
            Spacer(Modifier.size(10.dp))
            Text(
                text = "专题",
                fontSize = 22.sp,
                fontWeight = FontWeight.Bold,
                color = colors.textPrimary,
            )
            Spacer(Modifier.weight(1f))
            TopicSortMenu(option = sortOption, ascending = sortAscending, onChange = onSortChange)
            Spacer(Modifier.size(8.dp))
            NewTopicButton(onClick = onCreateTopic)
        }

        if (topics.isEmpty()) {
            Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Icon(
                        imageVector = IconLayoutBig,
                        contentDescription = null,
                        tint = colors.textSecondary.copy(alpha = 0.2f),
                        modifier = Modifier.size(80.dp),
                    )
                    Text(
                        text = "暂无专题",
                        fontSize = 18.sp,
                        fontWeight = FontWeight.Medium,
                        color = colors.textSecondary,
                        modifier = Modifier.padding(top = 16.dp),
                    )
                    Text(
                        text = "点「新建专题」把相关的图收在一起",
                        fontSize = 13.sp,
                        color = colors.textSecondary.copy(alpha = 0.7f),
                        modifier = Modifier.padding(top = 6.dp),
                    )
                }
            }
            return
        }

        val gridState = rememberLazyGridState()
        var pendingRestore by remember { mutableIntStateOf(initialScrollAnchor) }
        LaunchedEffect(Unit) {
            val anchor = pendingRestore
            if (anchor > 0) {
                pendingRestore = 0
                runCatching { gridState.scrollToItem(anchor) }
            }
        }
        LaunchedEffect(gridState) {
            androidx.compose.runtime.snapshotFlow { gridState.firstVisibleItemIndex }
                .collect { onScrollChanged(it) }
        }
        // 桌面卡片 = 3:4、高 350px（≈260px 宽）。列数按侧栏目标状态的最终内容宽度一次
        // 算死（FileGrid 3.5 列数预测同思路）。3.3fix②：网格视口也用 requiredWidth 钉在
        // 目标宽度上——LazyVerticalGrid 的格子宽 = 当前视口宽 ÷ 列数，视口若随侧栏动画
        // 逐帧变化（或拍点被 incoming 约束重切，Modifier.width 压不过单元格强制约束），
        // 卡片就会瞬变一档再动画回归；视口钉死在目标宽度后格子宽恒定，开合只剩整网
        // 格的平移与一次列归属重排（桌面即时重排同感），卡片全程零尺寸变化。
        // 溢出方向：收起时网格比容器宽、右缘随容器长大滑入屏内（窗口裁剪）；展开时
        // 网格比容器窄、随侧栏滑入整体右移，右侧露底色。
        val screenWidthDp = LocalConfiguration.current.screenWidthDp
        val targetContentWidth = screenWidthDp - (if (sidebarVisible) SIDEBAR_WIDTH_DP.value else 0f)
        val cols = ((targetContentWidth + 16f) / (220f + 16f)).toInt().coerceAtLeast(1)
        LazyVerticalGrid(
            columns = GridCells.Fixed(cols),
            state = gridState,
            horizontalArrangement = Arrangement.spacedBy(16.dp),
            verticalArrangement = Arrangement.spacedBy(24.dp),
            contentPadding = androidx.compose.foundation.layout.PaddingValues(
                start = 24.dp, end = 24.dp, top = 8.dp, bottom = 24.dp,
            ),
            modifier = Modifier.weight(1f).requiredWidth(targetContentWidth.dp),
        ) {
            items(
                count = topics.size,
                key = { i -> topics[i].id },
            ) { i ->
                val topic = topics[i]
                // 3.3fix② 三轮：列归属重排（4↔5 列）会让跨行卡片在拍点瞬移——收起时
                // 第二行首卡直接跳到新列、展开时反向。animateItem 的 placement 动画让
                // 重排卡片用与侧栏开合同规格的 300ms ease-out 滑到新位置；spec 显式传
                // tween 与侧栏动画完全同步，fadeIn/Out 关掉（开关场景没有增删条目）。
                Box(
                    Modifier.animateItem(
                        fadeInSpec = null,
                        placementSpec = tween(durationMillis = PANEL_ANIMATE_MS, easing = EaseOut),
                        fadeOutSpec = null,
                    ),
                ) {
                    TopicCard(
                        topic = topic,
                        cover = topic.coverFileId?.let { coverImages[it] },
                        totals = totals[topic.id],
                        thumbnailLoader = thumbnailLoader,
                        onClick = { onTopicClick(topic) },
                        onRename = { onRenameTopic(topic) },
                        onDelete = { onDeleteTopic(topic) },
                    )
                }
            }
        }
    }
}

/** 专题排序字段（桌面 localStorage `aurora_topic_sort_mode` 的 name/time 同语义）。 */
enum class TopicSortOption { NAME, TIME }

/**
 * 展示排序（桌面 TopicModule :680-692 同语义：名称按 locale 比较、时间按 createdAt；
 * 时间缺省当 0）。纯展示层排序——Rust 只保证 getAllTopics 的稳定顺序，桌面也是
 * 客户端排，不违反「UI 不重排 Rust 结果」的标签纪律。
 */
fun sortTopicsForDisplay(
    topics: List<FfiTopic>,
    option: TopicSortOption,
    ascending: Boolean,
): List<FfiTopic> {
    val sorted = when (option) {
        TopicSortOption.NAME -> {
            val collator = Collator.getInstance(Locale.CHINA)
            topics.sortedWith(compareBy(collator) { it.name })
        }
        TopicSortOption.TIME -> topics.sortedBy { it.createdAt ?: 0L }
    }
    return if (ascending) sorted else sorted.asReversed()
}

/** 递归合计：people 去重并集、fileCount 求和（含全部后代；桌面 :469-504 同口径）。 */
internal fun topicTreeTotals(topics: List<FfiTopic>): Map<String, Pair<Int, Int>> {
    val byParent = topics.groupBy { it.parentId }
    val result = HashMap<String, Pair<Int, Int>>(topics.size)
    fun resolve(topic: FfiTopic, path: MutableSet<String>): Pair<Set<String>, Int> {
        if (topic.id in path) return emptySet<String>() to 0 // 数据异常成环时兜底
        path.add(topic.id)
        val people = topic.peopleIds.toMutableSet()
        var files = topic.fileCount.coerceAtLeast(0)
        for (child in byParent[topic.id].orEmpty()) {
            val (childPeople, childFiles) = resolve(child, path)
            people.addAll(childPeople)
            files += childFiles
        }
        path.remove(topic.id)
        result[topic.id] = people.size to files
        return people to files
    }
    topics.forEach { topic -> if (topic.id !in result) resolve(topic, HashSet()) }
    return result
}

/** 来源中文标签（桌面总览卡右上角标；manual 与未知来源不显示）。 */
private fun topicSourceLabel(sourceType: String?): String? = when (sourceType) {
    null, "", "manual" -> null
    "auto_content" -> "内容分类"
    "auto_cluster" -> "视觉聚类"
    "auto_person" -> "作品角色"
    "folder_set" -> "图集"
    else -> null
}

/**
 * 专题卡阴影色（15% 黑）：Compose 阴影沿圆角裁剪边缘的抗锯齿像素会透出阴影色，
 * 纯黑（默认）在四角聚成细黑边——柔灰后与桌面 shadow-lg（black/10 大模糊）观感一致。
 */
private val TopicCardShadowColor = Color(0x26000000)

/**
 * 专题卡片（桌面 TopicModule :1864-1928 杂志式：3:4 封面、顶部黑渐变标题条、左下两行
 * 计数、右下类型胶囊、靛紫渐变占位、静态阴影 + 12dp 圆角 + 细边框）。整卡可点；
 * 长按弹「重命名/删除」菜单（桌面 single 右键的触屏同位，4.3）。
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun TopicCard(
    topic: FfiTopic,
    cover: Image?,
    /** (人物数, 图片数) 递归合计；null = 不在快照里（退回本级口径）。 */
    totals: Pair<Int, Int>?,
    thumbnailLoader: ThumbnailLoader,
    onClick: () -> Unit,
    onRename: () -> Unit = {},
    onDelete: () -> Unit = {},
) {
    val colors = AuroraTheme.colors
    val shape = RoundedCornerShape(12.dp)
    var menuOpen by remember { mutableStateOf(false) }
    var anchor by remember { mutableStateOf(androidx.compose.ui.geometry.Rect.Zero) }
    Box(
        Modifier
            .fillMaxWidth()
            .aspectRatio(0.75f)
            // 阴影色调成 15% 黑：Compose 阴影在圆角裁剪边缘的抗锯齿像素会透出阴影色，
            // 纯黑时四角出现细黑边（3.3fix 用户反馈）；柔灰后与桌面 shadow-lg 的观感一致
            .shadow(
                elevation = 5.dp,
                shape = shape,
                clip = true,
                ambientColor = TopicCardShadowColor,
                spotColor = TopicCardShadowColor,
            )
            .background(colors.surface)
            .border(1.dp, colors.border, shape)
            .combinedClickable(onClick = onClick, onLongClick = { menuOpen = true })
            .onGloballyPositioned { anchor = it.boundsInWindow() },
    ) {
        TopicCardMenuOverlay(
            menuOpen = menuOpen,
            onMenuOpenChange = { menuOpen = it },
            anchor = anchor,
            onRename = onRename,
            onDelete = onDelete,
        )
        var bmp by remember(cover?.id) { mutableStateOf<Bitmap?>(null) }
        LaunchedEffect(cover?.id) {
            val img = cover ?: return@LaunchedEffect
            val imageId = thumbnailLoader.extractImageId(img.contentUri)
            bmp = thumbnailLoader.peekMemory(imageId) ?: thumbnailLoader.loadFastLimited(imageId)
        }
        val bitmap = bmp
        if (bitmap != null) {
            Image(
                bitmap = bitmap.asImageBitmap(),
                contentDescription = topic.name,
                contentScale = ContentScale.Crop,
                modifier = Modifier.fillMaxSize(),
            )
        } else {
            // 桌面无封面占位：from-indigo-500 to-purple-600 对角渐变 + 白色 Layout 图标 50%
            Box(
                Modifier
                    .fillMaxSize()
                    .background(
                        Brush.linearGradient(
                            listOf(colors.topicGradientStart, colors.topicGradientEnd),
                        ),
                    ),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    imageVector = IconLayoutBig,
                    contentDescription = null,
                    tint = Color.White.copy(alpha = 0.5f),
                    modifier = Modifier.size(48.dp),
                )
            }
        }

        // 顶部杂志式标题条（桌面 :1895-1906：黑渐变 + 白色衬线体大写宽字距）
        Row(
            Modifier
                .fillMaxWidth()
                .background(
                    Brush.verticalGradient(
                        listOf(Color(0x99000000), Color(0x00000000)),
                    ),
                )
                .padding(start = 12.dp, end = 12.dp, top = 12.dp, bottom = 22.dp),
            verticalAlignment = Alignment.Top,
        ) {
            Text(
                text = topic.name.uppercase(Locale.ROOT),
                fontSize = 20.sp,
                fontFamily = FontFamily.Serif,
                fontWeight = FontWeight.Bold,
                color = Color.White,
                letterSpacing = 2.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            topicSourceLabel(topic.sourceType)?.let { label ->
                Spacer(Modifier.size(6.dp))
                Text(
                    text = label,
                    fontSize = 10.sp,
                    color = Color.White,
                    modifier = Modifier
                        .clip(RoundedCornerShape(50))
                        .border(1.dp, Color(0x4DFFFFFF), RoundedCornerShape(50))
                        .background(Color(0x33FFFFFF))
                        .padding(horizontal = 8.dp, vertical = 2.dp),
                )
            }
        }

        // 底部信息条（桌面 :1909-1925：黑渐变 + 左下两行计数 + 右下类型胶囊）
        Row(
            Modifier
                .align(Alignment.BottomCenter)
                .fillMaxWidth()
                .background(
                    Brush.verticalGradient(
                        0f to Color.Transparent,
                        0.5f to Color(0x66000000),
                        1f to Color(0xCC000000),
                    ),
                )
                .padding(start = 12.dp, end = 12.dp, top = 28.dp, bottom = 10.dp),
            verticalAlignment = Alignment.Bottom,
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
                CardCountRow(
                    icon = IconUser,
                    text = (totals?.first ?: topic.peopleIds.size).toString(),
                )
                CardCountRow(
                    icon = IconImages,
                    text = (totals?.second ?: topic.fileCount.coerceAtLeast(0)).toString(),
                )
            }
            Spacer(Modifier.weight(1f))
            topic.topicType?.takeIf { it.isNotBlank() }?.let { type ->
                Text(
                    text = type.take(12),
                    fontSize = 11.sp,
                    color = Color.White,
                    maxLines = 1,
                    modifier = Modifier
                        .clip(RoundedCornerShape(50))
                        .border(1.dp, Color(0x4DFFFFFF), RoundedCornerShape(50))
                        .background(Color(0x33FFFFFF))
                        .padding(horizontal = 8.dp, vertical = 2.dp),
                )
            }
        }
    }
}

@Composable
private fun CardCountRow(icon: ImageVector, text: String) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Icon(
            imageVector = icon,
            contentDescription = null,
            tint = Color.White.copy(alpha = 0.7f),
            modifier = Modifier.size(10.dp),
        )
        Spacer(Modifier.size(3.dp))
        Text(text, fontSize = 11.sp, color = Color.White.copy(alpha = 0.7f))
    }
}

/**
 * 排序菜单：主界面顶栏排序菜单同款（TopBar 的 AuroraDropdown 毛玻璃弹层 + 条目结构，
 * 2026-09-22 用户要求样式一致）——小节标题 + 字段勾选（按名称/按时间）+ 分隔线 +
 * 升降序切换（箭头指向随方向旋转）。条目点击后不收起（与主菜单一致的连续调整语义）。
 */
@Composable
private fun TopicSortMenu(
    option: TopicSortOption,
    ascending: Boolean,
    onChange: (TopicSortOption, Boolean) -> Unit,
) {
    val colors = AuroraTheme.colors
    var open by remember { mutableStateOf(false) }
    var anchor by remember { mutableStateOf(androidx.compose.ui.geometry.Rect.Zero) }
    Box(
        Modifier.onGloballyPositioned { anchor = it.boundsInWindow() },
    ) {
        Box(
            Modifier
                .size(48.dp)
                .clip(RoundedCornerShape(10.dp))
                .clickable { open = !open },
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                imageVector = IconSortArrows,
                contentDescription = "排序",
                tint = if (open) colors.primary else colors.textSecondary,
                modifier = Modifier.size(18.dp),
            )
        }
        AuroraDropdown(
            expanded = open,
            anchorBoundsInWindow = anchor,
            onDismissRequest = { open = false },
        ) {
            AuroraMenuHeader("排序方式")
            AuroraMenuItem(
                text = "按名称",
                checked = option == TopicSortOption.NAME,
                onClick = { onChange(TopicSortOption.NAME, ascending) },
            )
            AuroraMenuItem(
                text = "按时间",
                checked = option == TopicSortOption.TIME,
                onClick = { onChange(TopicSortOption.TIME, ascending) },
            )
            AuroraMenuDivider()
            AuroraMenuItem(
                text = if (ascending) "升序" else "降序",
                onClick = { onChange(option, !ascending) },
                trailing = {
                    Icon(
                        imageVector = IconSortArrows,
                        contentDescription = null,
                        tint = AuroraTheme.colors.textSecondary,
                        modifier = Modifier
                            .size(14.dp)
                            .rotate(if (ascending) 180f else 0f),
                    )
                },
            )
        }
    }
}

/** 「新建专题」实心按钮（桌面 :1836-1842 bg-blue-600 text-white；触点 ≥48dp）。 */
@Composable
private fun NewTopicButton(onClick: () -> Unit) {
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
            "新建专题",
            fontSize = 15.sp,
            fontWeight = FontWeight.Bold,
            color = Color.White,
        )
    }
}

/**
 * 新建专题弹窗（名称输入）。桌面同操作是小模态；触屏规范建议 Bottom Sheet，但单行
 * 文本输入沿用应用内既有的 AlertDialog 口径（删除确认等），不为此引一套弹层形制。
 * 4.3 起同一弹窗复用为**重命名**（[title]/[initialName]/[confirmLabel]）。
 */
@Composable
fun CreateTopicDialog(
    onDismiss: () -> Unit,
    onConfirm: (String) -> Unit,
    title: String = "新建专题",
    initialName: String = "",
    confirmLabel: String = "创建",
) {
    val colors = AuroraTheme.colors
    var name by remember { mutableStateOf(initialName) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = {
            OutlinedTextField(
                value = name,
                onValueChange = { name = it },
                singleLine = true,
                placeholder = { Text("专题名称", color = colors.textSecondary) },
            )
        },
        confirmButton = {
            TextButton(
                enabled = name.isNotBlank(),
                onClick = { onConfirm(name.trim()) },
            ) {
                Text(
                    confirmLabel,
                    color = if (name.isNotBlank()) colors.primaryDeep else colors.textSecondary,
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
 * 子专题区（M4a 3.2④ 落地；3.3 视觉对齐桌面详情页 Sub Topics 分区 :2072-2176）。
 * 桌面**严格两层**：子专题区只在根专题详情渲染，子专题里不再出现这个区——平板同构：
 * 本组件只被根专题详情调用（由宿主保证）。
 *
 * 形态差异（触屏适配）：桌面是页内网格分区 + hover 才出现的操作；平板详情页主体是
 * 图片网格（FileGrid），子专题做成**顶部横向滚动条**（LazyRow 的 3:4 竖版卡），「新建
 * 子专题」按钮常驻在区头。卡片下方是桌面同款「居中衬线名称 + 人物/图片计数行」
 * （:2116-2167），计数用本级口径（不递归）。
 */
@Composable
fun TopicChildrenSection(
    /** 当前专题的子专题（宿主按 parentId 过滤后的列表）。 */
    children: List<FfiTopic>,
    coverImages: Map<String, Image>,
    thumbnailLoader: ThumbnailLoader,
    onChildClick: (FfiTopic) -> Unit,
    onCreateChild: () -> Unit,
    /** 4.3 子专题卡长按菜单（与总览卡片同一套重命名/删除）。 */
    onRenameChild: (FfiTopic) -> Unit = {},
    onDeleteChild: (FfiTopic) -> Unit = {},
    modifier: Modifier = Modifier,
) {
    val colors = AuroraTheme.colors
    Column(modifier.fillMaxWidth()) {
        Row(
            Modifier
                .fillMaxWidth()
                .padding(start = 24.dp, end = 24.dp, top = 16.dp, bottom = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                imageVector = IconLayoutBig,
                contentDescription = null,
                tint = colors.topicPink,
                modifier = Modifier.size(18.dp),
            )
            Spacer(Modifier.size(8.dp))
            Text(
                "子专题",
                fontSize = 18.sp,
                fontWeight = FontWeight.Bold,
                color = colors.textPrimary,
            )
            Spacer(Modifier.weight(1f))
            Row(
                Modifier
                    .defaultMinSize(minHeight = 48.dp)
                    .clip(RoundedCornerShape(8.dp))
                    .clickable(onClick = onCreateChild)
                    .padding(horizontal = 12.dp, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(
                    imageVector = IconPlus,
                    contentDescription = null,
                    tint = colors.primary,
                    modifier = Modifier.size(16.dp),
                )
                Spacer(Modifier.size(6.dp))
                Text(
                    "新建子专题",
                    fontSize = 14.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = colors.primary,
                )
            }
        }
        if (children.isEmpty()) {
            TopicDashedEmpty(
                icon = IconLayoutBig,
                text = "暂无子专题",
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(start = 24.dp, end = 24.dp, bottom = 4.dp),
            )
        } else {
            LazyRow(
                contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 24.dp),
                horizontalArrangement = Arrangement.spacedBy(16.dp),
                modifier = Modifier.fillMaxWidth(),
            ) {
                items(children.size, key = { children[it].id }) { i ->
                    SubTopicCard(
                        topic = children[i],
                        cover = children[i].coverFileId?.let { coverImages[it] },
                        thumbnailLoader = thumbnailLoader,
                        onClick = { onChildClick(children[i]) },
                        onRename = { onRenameChild(children[i]) },
                        onDelete = { onDeleteChild(children[i]) },
                    )
                }
            }
        }
    }
}

/** 子专题长按菜单（与 [TopicCard] 同一套：重命名/删除，4.3）。 */
@Composable
private fun TopicCardMenuOverlay(
    menuOpen: Boolean,
    onMenuOpenChange: (Boolean) -> Unit,
    anchor: androidx.compose.ui.geometry.Rect,
    onRename: () -> Unit,
    onDelete: () -> Unit,
) {
    AuroraDropdown(
        expanded = menuOpen,
        anchorBoundsInWindow = anchor,
        onDismissRequest = { onMenuOpenChange(false) },
    ) {
        AuroraMenuItem(
            text = "重命名",
            onClick = {
                onMenuOpenChange(false)
                onRename()
            },
        )
        AuroraMenuDivider()
        AuroraMenuItem(
            text = "删除",
            textColor = Color(0xFFEF4444),
            onClick = {
                onMenuOpenChange(false)
                onDelete()
            },
        )
    }
}

/** 子专题卡（桌面 :2116-2167：封面 + 下方居中衬线名称 + 人物/图片计数行）。 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun SubTopicCard(
    topic: FfiTopic,
    cover: Image?,
    thumbnailLoader: ThumbnailLoader,
    onClick: () -> Unit,
    onRename: () -> Unit = {},
    onDelete: () -> Unit = {},
) {
    val colors = AuroraTheme.colors
    val shape = RoundedCornerShape(12.dp)
    var menuOpen by remember { mutableStateOf(false) }
    var anchor by remember { mutableStateOf(androidx.compose.ui.geometry.Rect.Zero) }
    Column(
        Modifier
            .width(176.dp)
            .clip(shape)
            .combinedClickable(onClick = onClick, onLongClick = { menuOpen = true })
            .onGloballyPositioned { anchor = it.boundsInWindow() },
    ) {
        TopicCardMenuOverlay(
            menuOpen = menuOpen,
            onMenuOpenChange = { menuOpen = it },
            anchor = anchor,
            onRename = onRename,
            onDelete = onDelete,
        )
        Box(
            Modifier
                .fillMaxWidth()
                .aspectRatio(0.75f)
                .shadow(
                    elevation = 5.dp,
                    shape = shape,
                    clip = true,
                    ambientColor = TopicCardShadowColor,
                    spotColor = TopicCardShadowColor,
                )
                .background(colors.surface),
        ) {
            var bmp by remember(topic.coverFileId) { mutableStateOf<Bitmap?>(null) }
            LaunchedEffect(topic.coverFileId) {
                val img = cover ?: return@LaunchedEffect
                val imageId = thumbnailLoader.extractImageId(img.contentUri)
                bmp = thumbnailLoader.peekMemory(imageId) ?: thumbnailLoader.loadFastLimited(imageId)
            }
            val bitmap = bmp
            if (bitmap != null) {
                Image(
                    bitmap = bitmap.asImageBitmap(),
                    contentDescription = topic.name,
                    contentScale = ContentScale.Crop,
                    modifier = Modifier.fillMaxSize(),
                )
            } else {
                Box(
                    Modifier
                        .fillMaxSize()
                        .background(
                            Brush.linearGradient(
                                listOf(colors.topicGradientStart, colors.topicGradientEnd),
                            ),
                        ),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(
                        imageVector = IconLayoutBig,
                        contentDescription = null,
                        tint = Color.White.copy(alpha = 0.5f),
                        modifier = Modifier.size(32.dp),
                    )
                }
            }
            topic.topicType?.takeIf { it.isNotBlank() }?.let { type ->
                Text(
                    text = type.take(12),
                    fontSize = 11.sp,
                    color = Color.White,
                    maxLines = 1,
                    modifier = Modifier
                        .align(Alignment.TopEnd)
                        .padding(10.dp)
                        .clip(RoundedCornerShape(50))
                        .border(1.dp, Color(0x4DFFFFFF), RoundedCornerShape(50))
                        .background(Color(0x33000000))
                        .padding(horizontal = 8.dp, vertical = 2.dp),
                )
            }
        }
        Text(
            topic.name,
            fontSize = 16.sp,
            fontFamily = FontFamily.Serif,
            fontWeight = FontWeight.Bold,
            color = colors.textPrimary,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            textAlign = androidx.compose.ui.text.style.TextAlign.Center,
            modifier = Modifier
                .fillMaxWidth()
                .padding(top = 8.dp, start = 4.dp, end = 4.dp),
        )
        Row(
            Modifier
                .fillMaxWidth()
                .padding(top = 4.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Spacer(Modifier.weight(1f))
            Icon(
                imageVector = IconUser,
                contentDescription = null,
                tint = colors.textSecondary,
                modifier = Modifier.size(12.dp),
            )
            Text(
                topic.peopleIds.size.toString(),
                fontSize = 11.sp,
                color = colors.textSecondary,
            )
            Icon(
                imageVector = IconImages,
                contentDescription = null,
                tint = colors.textSecondary,
                modifier = Modifier.size(12.dp),
            )
            Text(
                topic.fileCount.coerceAtLeast(0).toString(),
                fontSize = 11.sp,
                color = colors.textSecondary,
            )
            Spacer(Modifier.weight(1f))
        }
        Spacer(Modifier.heightIn(min = 4.dp))
    }
}

/**
 * 专题选择弹窗（M4a 3.2 的「归入」链路最后一跳：选择模式 → 更多 → 加入专题 → 选目标）。
 * 对齐桌面 AddToTopicModal：**根专题 + 可展开的子专题**两层树（子专题缩进展示，两层都
 * 可选为目标），列表落 panel 底圆角容器。无专题时给引导文案而不是空列表。
 */
@Composable
fun TopicPickerDialog(
    topics: List<FfiTopic>,
    onDismiss: () -> Unit,
    onPick: (FfiTopic) -> Unit,
) {
    val colors = AuroraTheme.colors
    // 展开的根专题集合（有子专题的根行才显示展开箭头，桌面 ChevronsDown/ChevronRight 同构）
    var expanded by remember { mutableStateOf(setOf<String>()) }
    val roots = topics.filter { it.parentId == null }

    @Composable
    fun TopicRow(topic: FfiTopic, indent: Boolean, hasChildren: Boolean, isExpanded: Boolean, onToggle: (() -> Unit)?) {
        Row(
            Modifier
                .fillMaxWidth()
                .padding(start = if (indent) 24.dp else 0.dp)
                .defaultMinSize(minHeight = 48.dp)
                .clip(RoundedCornerShape(8.dp))
                .clickable { onPick(topic) }
                .padding(horizontal = 8.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (hasChildren) {
                Box(
                    Modifier
                        .size(48.dp)
                        .clickable(onClick = onToggle ?: {}),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        if (isExpanded) "▾" else "▸",
                        fontSize = 14.sp,
                        color = colors.textSecondary,
                    )
                }
            } else {
                Spacer(Modifier.size(if (indent) 48.dp else 12.dp))
            }
            Icon(
                imageVector = IconLayoutBig,
                contentDescription = null,
                tint = colors.topicPink,
                modifier = Modifier.size(16.dp),
            )
            Spacer(Modifier.size(10.dp))
            Text(
                topic.name,
                fontSize = 15.sp,
                color = colors.textPrimary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            Text(
                topic.fileCount.toString(),
                fontSize = 12.sp,
                color = colors.textSecondary,
            )
        }
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("加入专题") },
        text = {
            if (topics.isEmpty()) {
                Text(
                    "暂无专题。先在侧栏「专题」里新建一个，再把图收进来。",
                    color = colors.textSecondary,
                )
            } else {
                Column(
                    Modifier
                        .heightIn(max = 380.dp)
                        .clip(RoundedCornerShape(12.dp))
                        .background(colors.panel)
                        .padding(6.dp)
                        .verticalScroll(rememberScrollState()),
                ) {
                    roots.forEach { root ->
                        val children = topics.filter { it.parentId == root.id }
                        TopicRow(
                            topic = root,
                            indent = false,
                            hasChildren = children.isNotEmpty(),
                            isExpanded = root.id in expanded,
                            onToggle = {
                                expanded = if (root.id in expanded) expanded - root.id else expanded + root.id
                            },
                        )
                        if (children.isNotEmpty() && root.id in expanded) {
                            children.forEach { child ->
                                TopicRow(
                                    topic = child,
                                    indent = true,
                                    hasChildren = false,
                                    isExpanded = false,
                                    onToggle = null,
                                )
                            }
                        }
                    }
                }
            }
        },
        confirmButton = {
            TextButton(onClick = onDismiss) { Text("取消", color = colors.textPrimary) }
        },
    )
}

// ---- 自绘图标：lucide 线性风格（与 TopBar.kt 同款绘制参数；专题系列图标在本文件
// 持有，TopicDetail.kt 同包直接引用）----

/** lucide Layout（专题卡片/空态；与 TreeSidebar 的 IconLayout 同形）。 */
internal val IconLayoutBig: ImageVector by lazy {
    ImageVector.Builder(
        name = "LayoutBig",
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
            // 圆角矩形外框
            moveTo(5f, 3f)
            lineTo(19f, 3f)
            arcTo(2f, 2f, 0f, false, true, 21f, 5f)
            lineTo(21f, 19f)
            arcTo(2f, 2f, 0f, false, true, 19f, 21f)
            lineTo(5f, 21f)
            arcTo(2f, 2f, 0f, false, true, 3f, 19f)
            lineTo(3f, 5f)
            arcTo(2f, 2f, 0f, false, true, 5f, 3f)
            close()
            moveTo(3f, 9f)
            lineTo(21f, 9f)
            moveTo(9f, 21f)
            lineTo(9f, 9f)
        }
    }.build()
}

/** lucide Plus：已上移 AuroraIcons.kt 共享（M5 画布菜单同名同形，直接引用）。 */

/** lucide User（人物计数）。 */
internal val IconUser: ImageVector by lazy {
    ImageVector.Builder(
        name = "TopicUser",
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
            // 头
            moveTo(12f, 12f)
            arcTo(4f, 4f, 0f, false, true, 12f, 4f)
            arcTo(4f, 4f, 0f, false, true, 12f, 12f)
            close()
            // 肩
            moveTo(19f, 21f)
            // v-2 a4 4 0 0 0-4-4 H9 a4 4 0 0 0-4 4 v2
            lineTo(19f, 19f)
            arcTo(4f, 4f, 0f, false, false, 15f, 15f)
            lineTo(9f, 15f)
            arcTo(4f, 4f, 0f, false, false, 5f, 19f)
            lineTo(5f, 21f)
        }
    }.build()
}

/** lucide Image（图片计数/图片区块标题）。 */
internal val IconImages: ImageVector by lazy {
    ImageVector.Builder(
        name = "TopicImage",
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
            // 外框（rx=2）
            moveTo(5f, 3f)
            lineTo(19f, 3f)
            arcTo(2f, 2f, 0f, false, true, 21f, 5f)
            lineTo(21f, 19f)
            arcTo(2f, 2f, 0f, false, true, 19f, 21f)
            lineTo(5f, 21f)
            arcTo(2f, 2f, 0f, false, true, 3f, 19f)
            lineTo(3f, 5f)
            arcTo(2f, 2f, 0f, false, true, 5f, 3f)
            close()
            // 太阳
            moveTo(9f, 11f)
            arcTo(2f, 2f, 0f, false, true, 9f, 7f)
            arcTo(2f, 2f, 0f, false, true, 9f, 11f)
            close()
            // 山（m21 15-3.086-3.086 a2 2 0 0 0-2.828 0 L6 21）
            moveTo(21f, 15f)
            lineTo(17.914f, 11.914f)
            arcTo(2f, 2f, 0f, false, false, 15.086f, 11.914f)
            lineTo(6f, 21f)
        }
    }.build()
}

// IconExternalLink（来源链接胶囊）已上移 AuroraIcons.kt 共享（M4c 2.6），此处直接
// 引用同包共享版本（路径与原实现一致）。

/** lucide ArrowDownUp（排序；主菜单同款图标与升降序箭头共用）。 */
internal val IconSortArrows: ImageVector by lazy {
    ImageVector.Builder(
        name = "TopicArrowDownUp",
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
            // 下箭头（m3 16 4 4 4-4 / M7 20V4）
            moveTo(3f, 16f)
            lineTo(7f, 20f)
            lineTo(11f, 16f)
            moveTo(7f, 20f)
            lineTo(7f, 4f)
            // 上箭头（m21 8-4-4-4 4 / M17 4v16）
            moveTo(21f, 8f)
            lineTo(17f, 4f)
            lineTo(13f, 8f)
            moveTo(17f, 4f)
            lineTo(17f, 20f)
        }
    }.build()
}

