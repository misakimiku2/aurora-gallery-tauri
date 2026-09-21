package com.aurora.gallery.kotlin.ui.components

import android.graphics.Bitmap
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
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
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.rememberLazyGridState
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
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.path
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.aurora.gallery.kotlin.ThumbnailLoader
import com.aurora.gallery.kotlin.ui.theme.AuroraTheme
import uniffi.aurora_core.FfiTopic
import uniffi.aurora_core.Image

/**
 * 专题总览（M4a 3.2，对齐桌面 `TopicModule` 的专题列表层；D11 v7：含「手动建专题 +
 * 把图归入」入口，不是空壳）。
 *
 * 桌面形态 → 触屏适配（desktop-to-android 适配表）：
 *  - 专题卡 hover 换封面/3D 效果、右键菜单（重命名/设置封面/删除/智能创建）→ 不做：
 *    封面是桌面画布特性（归 M6 互联态后看桌面数据），重命名/删除等上下文操作归 4.3
 *    长按菜单收口时一起定；本轮交付「建专题 → 归图 → 看成员」主链路；
 *  - 新建入口（桌面是 Section 头 hover 的 + / 空白处右键）→ 常驻「新建专题」按钮
 *    （触屏无 hover，必须常显）；
 *  - 嵌套专题（parentId）→ 平板只做根专题（React 的嵌套导航依赖桌面双栏，M6 再看）。
 *
 * 封面：有 coverFileId 的专题经 [coverImages]（VM 已解析的 Image）加载缩略图；没有或
 * 已失效 → 占位图标。计数 = `topic.fileCount`（列表口径；fileIds 懒加载恒空，别用
 * fileIds.size——0.1 记过的坑）。
 */
@Composable
fun TopicsOverview(
    topics: List<FfiTopic>,
    /** coverFileId → 已解析的 Image（宿主 VM 一次取齐），缺 = 无封面或封面已失效。 */
    coverImages: Map<String, Image>,
    thumbnailLoader: ThumbnailLoader,
    onTopicClick: (FfiTopic) -> Unit,
    onCreateTopic: () -> Unit,
    modifier: Modifier = Modifier,
    /** 返回总览时恢复的滚动位置（首个可见条目下标，同 [TagsOverview] 的锚点语义）。 */
    initialScrollAnchor: Int = 0,
    onScrollChanged: (Int) -> Unit = {},
) {
    val colors = AuroraTheme.colors
    Column(modifier.fillMaxSize()) {
        // 常驻动作行：触屏没有 hover，桌面的「+ 悬停出现在 Section 头」在这里必须常显
        Row(
            Modifier
                .fillMaxWidth()
                .padding(start = 24.dp, end = 24.dp, top = 16.dp, bottom = 4.dp),
        ) {
            NewTopicButton(onClick = onCreateTopic)
        }

        if (topics.isEmpty()) {
            Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Icon(
                        imageVector = IconLayoutBig,
                        contentDescription = null,
                        tint = colors.textSecondary.copy(alpha = 0.3f),
                        modifier = Modifier.size(64.dp),
                    )
                    Text(
                        text = "暂无专题",
                        fontSize = 16.sp,
                        color = colors.textSecondary,
                        modifier = Modifier.padding(top = 12.dp),
                    )
                    Text(
                        text = "点「新建专题」把相关的图收在一起",
                        fontSize = 12.sp,
                        color = colors.textSecondary.copy(alpha = 0.7f),
                        modifier = Modifier.padding(top = 4.dp),
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
        LazyVerticalGrid(
            columns = GridCells.Adaptive(minSize = 150.dp),
            state = gridState,
            horizontalArrangement = Arrangement.spacedBy(16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
            contentPadding = androidx.compose.foundation.layout.PaddingValues(
                start = 24.dp, end = 24.dp, top = 8.dp, bottom = 24.dp,
            ),
            modifier = Modifier.weight(1f).fillMaxWidth(),
        ) {
            items(
                count = topics.size,
                key = { i -> topics[i].id },
            ) { i ->
                val topic = topics[i]
                TopicCard(
                    topic = topic,
                    cover = topic.coverFileId?.let { coverImages[it] },
                    thumbnailLoader = thumbnailLoader,
                    onClick = { onTopicClick(topic) },
                )
            }
        }
    }
}

/** 专题卡片：封面（正方形，右下角计数徽标）+ 名称。整卡可点。 */
@Composable
private fun TopicCard(
    topic: FfiTopic,
    cover: Image?,
    thumbnailLoader: ThumbnailLoader,
    onClick: () -> Unit,
) {
    val colors = AuroraTheme.colors
    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .clickable(onClick = onClick),
    ) {
        Box(
            Modifier
                .fillMaxWidth()
                .aspectRatio(1f)
                .clip(RoundedCornerShape(8.dp))
                .background(colors.surface),
        ) {
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
                // 占位：专题图标居中（封面未设或已随图删除）
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    Icon(
                        imageVector = IconLayoutBig,
                        contentDescription = null,
                        tint = colors.textSecondary.copy(alpha = 0.4f),
                        modifier = Modifier.size(36.dp),
                    )
                }
            }
            if (topic.fileCount > 0) {
                Text(
                    topic.fileCount.toString(),
                    fontSize = 10.sp,
                    color = Color.White,
                    modifier = Modifier
                        .align(Alignment.BottomEnd)
                        .padding(6.dp)
                        .clip(RoundedCornerShape(50))
                        .background(Color(0x80000000))
                        .padding(horizontal = 6.dp, vertical = 2.dp),
                )
            }
        }
        Text(
            topic.name,
            fontSize = 13.sp,
            fontWeight = FontWeight.Bold,
            color = colors.textPrimary,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.padding(top = 6.dp, start = 2.dp),
        )
    }
}

/** 「新建专题」按钮（粉色系，对齐桌面专题 Section 的强调色 pink-500；与 TreeSidebar 的 SECTION_PINK 同源）。 */
@Composable
private fun NewTopicButton(onClick: () -> Unit) {
    val pink = Color(0xFFEC4899)
    Row(
        Modifier
            .clip(RoundedCornerShape(8.dp))
            .background(pink.copy(alpha = 0.08f))
            .clickable(onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            imageVector = IconPlus,
            contentDescription = null,
            tint = pink,
            modifier = Modifier.size(16.dp),
        )
        Spacer(Modifier.size(6.dp))
        Text(
            "新建专题",
            fontSize = 14.sp,
            fontWeight = FontWeight.Bold,
            color = pink,
        )
    }
}

/**
 * 新建专题弹窗（名称输入）。桌面同操作是小模态；触屏规范建议 Bottom Sheet，但单行
 * 文本输入沿用应用内既有的 AlertDialog 口径（删除确认等），不为此引一套弹层形制。
 */
@Composable
fun CreateTopicDialog(
    onDismiss: () -> Unit,
    onConfirm: (String) -> Unit,
) {
    val colors = AuroraTheme.colors
    var name by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("新建专题") },
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
                Text("创建", color = if (name.isNotBlank()) colors.primary else colors.textSecondary)
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text("取消", color = colors.textPrimary)
            }
        },
    )
}

/** lucide Layout（专题卡片/空态；与 TreeSidebar 的 IconLayout 同形）。 */
private val IconLayoutBig: ImageVector by lazy {
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

/** lucide Plus。 */
private val IconPlus: ImageVector by lazy {
    ImageVector.Builder(
        name = "Plus",
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
            moveTo(5f, 12f)
            lineTo(19f, 12f)
            moveTo(12f, 5f)
            lineTo(12f, 19f)
        }
    }.build()
}
