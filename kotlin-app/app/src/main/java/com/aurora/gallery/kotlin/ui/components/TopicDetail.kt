package com.aurora.gallery.kotlin.ui.components

import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.blur
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.nestedscroll.NestedScrollConnection
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.foundation.layout.wrapContentHeight
import com.aurora.gallery.kotlin.ThumbnailLoader
import com.aurora.gallery.kotlin.ui.theme.AuroraTheme
import uniffi.aurora_core.FfiTopic
import uniffi.aurora_core.Image

/**
 * 专题详情的桌面化部件（M4a 3.3，对齐桌面 `TopicModule` renderDetail :2035-2293）。
 *
 * 滚动结构（3.3fix 起）：桌面详情整页滚动；平板详情主体是 FileGrid（原生 RecyclerView），
 * 通过 [TopicCollapsibleDetail] 的嵌套滚动桥接实现同款整页滚动——上滑先收起 Hero/区块头、
 * 顶到底后图片区接续滚动，在网格顶部下滑先展开头部（CoordinatorLayout 语义）。依赖
 * AndroidComposeView 的 View↔Compose 嵌套滚动互通（官方 interop API，RV 默认
 * nestedScrollingEnabled=true）。
 *
 * backgroundFileId（桌面画布「设置为专题背景」）暂不参与 Hero：coverImagesById 快照
 * 只解析封面，背景要 VM 扩快照，而平板目前也没有产生背景图的入口（归 M6 互联态）。
 */

/**
 * 「可收起头部 + 图片网格」的整页滚动容器。
 *
 * 结构：头部槽位高度 = 头部自然高度 - 已收起量（底部对齐、顶部被裁掉），网格吃剩余
 * 空间——所以收起过程是真实的布局让位（网格逐帧长高），不是 overlay 平移。收起量由
 * [NestedScrollConnection] 驱动：上滑（dy<0）在 onPreScroll 里先收头部；网格顶到头
 * 后的下滑（dy>0 剩余）在 onPostScroll 里先展头部。
 *
 * 未覆盖（记入清单 §8）：快速下滑（fling）的剩余速度不驱动头部展开——RV 的 fling
 * 剩余走 onPostFling，这里没实现，展开靠拖拽；桌面是连续滚动所以无此差异感。
 */
@Composable
fun TopicCollapsibleDetail(
    /** 换专题时重置收起量与已测头部高度（宿主传 activeTopicId）。 */
    resetKey: Any?,
    modifier: Modifier = Modifier,
    /** 头部内容（Hero + 子专题区 + 图片区块头）。自然高度随意，容器自适应。 */
    header: @Composable () -> Unit,
    /** 收起完成后的滚动主体（FileGrid）。 */
    body: @Composable () -> Unit,
) {
    val density = LocalDensity.current
    var headerFullPx by remember(resetKey) { mutableFloatStateOf(0f) }
    var collapsePx by remember(resetKey) { mutableFloatStateOf(0f) }

    val connection = remember(resetKey) {
        object : NestedScrollConnection {
            private fun take(dy: Float): Offset {
                val prev = collapsePx
                collapsePx = (collapsePx - dy).coerceIn(0f, headerFullPx)
                return Offset(0f, prev - collapsePx)
            }

            // 上滑：头部先收（消费 dy<0），剩余才进网格
            override fun onPreScroll(available: Offset, source: NestedScrollSource): Offset =
                if (available.y < 0f && collapsePx < headerFullPx) take(available.y) else Offset.Zero

            // 网格已在顶部的下滑（dy>0 剩余）：先展头部
            override fun onPostScroll(consumed: Offset, available: Offset, source: NestedScrollSource): Offset =
                if (available.y > 0f && collapsePx > 0f) take(available.y) else Offset.Zero
        }
    }

    Column(modifier.fillMaxSize().nestedScroll(connection)) {
        // 头部槽位：未量到自然高度前先放开量（首帧 = 自然高度，量到后高度恒等不跳变）
        val slotReady = headerFullPx > 0f
        val slotHeight = with(density) { (headerFullPx - collapsePx).coerceAtLeast(0f).toDp() }
        Box(
            Modifier
                .fillMaxWidth()
                .then(if (slotReady) Modifier.height(slotHeight) else Modifier)
                .clipToBounds()
                // 内容按自然高度测量、底部对齐：槽位收缩时顶部先滑出裁剪区（桌面滚动语义）
                .wrapContentHeight(align = Alignment.Bottom, unbounded = true),
        ) {
            Column(
                Modifier.onSizeChanged { headerFullPx = it.height.toFloat() },
            ) {
                header()
            }
        }
        Box(Modifier.fillMaxWidth().weight(1f)) {
            body()
        }
    }
}
@Composable
fun TopicHero(
    topic: FfiTopic,
    /** coverFileId → 已解析的 Image（宿主快照），null = 无封面（用 slate 渐变兜底）。 */
    coverImage: Image?,
    thumbnailLoader: ThumbnailLoader,
    modifier: Modifier = Modifier,
) {
    val colors = AuroraTheme.colors
    val context = LocalContext.current
    Box(modifier.fillMaxWidth().height(220.dp)) {
        var bmp by remember(coverImage?.id) { mutableStateOf<Bitmap?>(null) }
        LaunchedEffect(coverImage?.id) {
            val img = coverImage ?: return@LaunchedEffect
            val imageId = thumbnailLoader.extractImageId(img.contentUri)
            bmp = thumbnailLoader.peekMemory(imageId) ?: thumbnailLoader.loadFastLimited(imageId)
        }
        val bitmap = bmp
        if (bitmap != null) {
            // 桌面 :2039：封面 bg-cover blur-sm scale-110 opacity-50
            Image(
                bitmap = bitmap.asImageBitmap(),
                contentDescription = null,
                contentScale = ContentScale.Crop,
                modifier = Modifier
                    .fillMaxSize()
                    .blur(10.dp)
                    .graphicsLayer {
                        scaleX = 1.15f
                        scaleY = 1.15f
                    }
                    .alpha(0.5f),
            )
        } else {
            // 桌面 :2039 无封面分支：bg-gradient-to-r from-slate-900 to-slate-800
            Box(
                Modifier
                    .fillMaxSize()
                    .background(
                        Brush.horizontalGradient(
                            listOf(colors.heroSlateStart, colors.heroSlateEnd),
                        ),
                    ),
            )
        }
        // 底部渐隐到内容底色（桌面 :2043 bg-gradient-to-t from-white via-transparent）
        Box(
            Modifier
                .matchParentSize()
                .background(
                    Brush.verticalGradient(
                        0f to Color.Transparent,
                        0.55f to Color.Transparent,
                        1f to colors.content,
                    ),
                ),
        )
        // 标题区（桌面 :2046-2065：absolute bottom-6 left-6 right-6，衬线大标题 + 描述 + 来源）
        Row(
            Modifier
                .align(Alignment.BottomStart)
                .fillMaxWidth()
                .padding(start = 24.dp, end = 24.dp, bottom = 14.dp),
            verticalAlignment = Alignment.Bottom,
        ) {
            Column(Modifier.weight(1f)) {
                Text(
                    text = topic.name,
                    fontSize = 30.sp,
                    fontFamily = FontFamily.Serif,
                    fontWeight = FontWeight.Bold,
                    color = colors.textPrimary,
                    lineHeight = 36.sp,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    text = topic.description?.takeIf { it.isNotBlank() } ?: "暂无描述",
                    fontSize = 13.sp,
                    color = colors.textSecondary.copy(
                        alpha = if (topic.description.isNullOrBlank()) 0.7f else 1f,
                    ),
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.padding(top = 6.dp),
                )
            }
            topic.sourceUrl?.takeIf { it.isNotBlank() }?.let { url ->
                Spacer(Modifier.size(12.dp))
                Row(
                    Modifier
                        .defaultMinSize(minHeight = 48.dp)
                        .clip(RoundedCornerShape(50))
                        .background(colors.primary.copy(alpha = 0.12f))
                        .clickable {
                            // 桌面是 <a> 链接；平板交给系统浏览器（打不开就静默吞掉）
                            runCatching {
                                context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
                            }
                        }
                        .padding(horizontal = 14.dp, vertical = 12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(
                        imageVector = IconExternalLink,
                        contentDescription = null,
                        tint = colors.primary,
                        modifier = Modifier.size(14.dp),
                    )
                    Spacer(Modifier.size(6.dp))
                    Text(
                        "来源",
                        fontSize = 13.sp,
                        fontWeight = FontWeight.Medium,
                        color = colors.primary,
                    )
                }
            }
        }
    }
}

/** 详情区块头（桌面 text-xl bold + 彩色 lucide 图标：子专题 pink-500、图片 green-500）。 */
@Composable
fun TopicSectionHeader(
    icon: ImageVector,
    iconTint: Color,
    title: String,
    modifier: Modifier = Modifier,
) {
    val colors = AuroraTheme.colors
    Row(
        modifier
            .fillMaxWidth()
            .padding(start = 24.dp, end = 24.dp, top = 16.dp, bottom = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            imageVector = icon,
            contentDescription = null,
            tint = iconTint,
            modifier = Modifier.size(18.dp),
        )
        Spacer(Modifier.size(8.dp))
        Text(
            title,
            fontSize = 18.sp,
            fontWeight = FontWeight.Bold,
            color = colors.textPrimary,
        )
    }
}

/**
 * 虚线空态（桌面 :2170-2173 / :2288-2291：dashed 圆角框 + 20% 图标 + 斜体说明）。
 * 子专题/图片两个区块的「暂无」形态共用。
 */
@Composable
fun TopicDashedEmpty(
    icon: ImageVector,
    text: String,
    modifier: Modifier = Modifier,
) {
    val colors = AuroraTheme.colors
    val borderColor = colors.border
    Box(
        modifier
            .defaultMinSize(minHeight = 120.dp)
            .drawBehind {
                drawRoundRect(
                    color = borderColor,
                    cornerRadius = CornerRadius(12.dp.toPx()),
                    style = Stroke(
                        width = 1.5.dp.toPx(),
                        pathEffect = PathEffect.dashPathEffect(
                            floatArrayOf(8.dp.toPx(), 6.dp.toPx()),
                        ),
                    ),
                )
            },
        contentAlignment = Alignment.Center,
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            modifier = Modifier.padding(vertical = 24.dp),
        ) {
            Icon(
                imageVector = icon,
                contentDescription = null,
                tint = colors.textSecondary.copy(alpha = 0.2f),
                modifier = Modifier.size(36.dp),
            )
            Spacer(Modifier.size(10.dp))
            Text(
                text,
                fontSize = 13.sp,
                color = colors.textSecondary,
                fontStyle = FontStyle.Italic,
            )
        }
    }
}

/** 图片区块标题的强调色（桌面 text-green-500 #22C55E；区块图标色就近各文件持有）。 */
internal val TOPIC_SECTION_GREEN = Color(0xFF22C55E)
