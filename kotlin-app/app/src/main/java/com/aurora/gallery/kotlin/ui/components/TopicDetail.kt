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
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.blur
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.aurora.gallery.kotlin.ThumbnailLoader
import com.aurora.gallery.kotlin.ui.theme.AuroraTheme
import uniffi.aurora_core.FfiTopic
import uniffi.aurora_core.Image

/**
 * 专题详情的桌面化部件（M4a 3.3，对齐桌面 `TopicModule` renderDetail :2035-2293）。
 *
 * 与桌面的结构差：桌面详情整页滚动（Hero 随页滚走）；平板详情主体是 FileGrid（原生
 * RecyclerView，捏合换档/预取/滚动锚点都在它身上，不能嵌进 Compose 滚动列），所以
 * Hero 与区块头**固定在顶部**、图片区独立滚动——这是复用主网格的代价，视觉形制不变。
 *
 * backgroundFileId（桌面画布「设置为专题背景」）暂不参与 Hero：coverImagesById 快照
 * 只解析封面，背景要 VM 扩快照，而平板目前也没有产生背景图的入口（归 M6 互联态）。
 */
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
