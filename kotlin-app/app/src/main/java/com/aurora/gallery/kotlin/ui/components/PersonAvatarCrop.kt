package com.aurora.gallery.kotlin.ui.components

import android.graphics.Bitmap
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.requiredSize
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.aurora.gallery.kotlin.ThumbnailLoader
import com.aurora.gallery.kotlin.ui.theme.AuroraTheme
import kotlin.math.roundToInt
import uniffi.aurora_core.FfiFaceBox
import kotlin.math.max
import kotlin.math.min

/** 裁剪页的一个候选封面（人物成员图）。 */
data class AvatarCandidate(val fileId: String, val contentUri: String)

/**
 * 取景窗在图像像素空间里的状态：窗心 + 窗所覆盖的**图像正方形边长**。
 *
 * 用「图像像素里的正方形」而不是「屏幕上的 scale/translate」来存状态，有两个好处：
 *  1. 保存时直接换算成 faceBox 百分比，不需要反推桌面那套 OFFSET/position 数学；
 *  2. 换一张候选图时状态可解释（重置成整图内切正方形），不会出现「新图沿用旧图缩放」
 *     那种看着像 bug 的观感。
 */
private data class CropView(val sidePx: Float, val cx: Float, val cy: Float)

/**
 * 人物头像裁剪页（桌面 `CropAvatarModal` 的触屏同位）。
 *
 * 桌面 → 触屏的三处适配（desktop-to-android 适配表）：
 *  - 滚轮缩放 + 底部滑杆 → **双指捏合**（绕窗心，和桌面滚轮同一个语义），滑杆删除；
 *  - 鼠标拖拽平移 → **单指拖**；
 *  - 右侧竖排候选图列表 → 底部横滑条（拇指够得着，且给取景窗让出竖向空间）。
 *
 * 写回的 faceBox 口径与桌面逐字一致：**相对原图的百分比**，x/y = 左上角，w/h = 裁剪区
 * 宽高占比。桌面那个 250px 正方形窗在图像上截出的也是正方形，所以 w%·natW == h%·natH；
 * 本地图非正方形时 w% 与 h% 不相等是**正确的**，别在读取端把它们当同一个数。
 *
 * 取的是 ThumbnailLoader 的缩略图而非原图：faceBox 存的是百分比，缩略图与原图同比例，
 * 换算结果一致，而原图解码在安卓侧是已知雷区（见 ImageSource.kt 的三星事故注释）。
 */
@Composable
fun PersonAvatarCropDialog(
    personName: String,
    candidates: List<AvatarCandidate>,
    initialCoverFileId: String,
    initialFaceBox: FfiFaceBox?,
    loader: ThumbnailLoader,
    onCancel: () -> Unit,
    onSave: (fileId: String, faceBox: FfiFaceBox) -> Unit,
) {
    val colors = AuroraTheme.colors
    // 候选是宿主**异步**拉来的（开页那一刻恒为空），所以 selectedId 不能在 remember
    // 的初始值里定死：那样首帧算出 ""，候选到位后也不会再求值，selected 永远为 null
    // ——图、转圈、失败提示三个分支一个都不进，屏幕上就剩一个光秃秃的圆（2026-10-08 实测）。
    var selectedId by remember { mutableStateOf("") }
    LaunchedEffect(candidates) {
        if (selectedId.isEmpty() && candidates.isNotEmpty()) {
            selectedId = candidates.firstOrNull { it.fileId == initialCoverFileId }?.fileId
                ?: candidates.first().fileId
        }
    }
    val selected = candidates.firstOrNull { it.fileId == selectedId }

    var bitmap by remember { mutableStateOf<Bitmap?>(null) }
    var view by remember { mutableStateOf<CropView?>(null) }
    // 取图失败要说话：黑圈圈不解释就是「应用卡住了」的观感
    var loadFailed by remember { mutableStateOf(false) }
    val density = LocalDensity.current
    val windowPx = with(density) { 300.dp.toPx() }

    // 换封面图 = 重新取位图 + 重置取景窗。initialFaceBox 只用于**首张**：它描述的是
    // 旧封面的构图，套到另一张图上会把新图裁歪。
    LaunchedEffect(selected?.contentUri) {
        val uri = selected?.contentUri
        bitmap = null
        view = null
        loadFailed = false
        if (uri == null) return@LaunchedEffect
        val bmp = loader.loadFastLimited(loader.extractImageId(uri))
        if (bmp == null) {
            loadFailed = true
            return@LaunchedEffect
        }
        bitmap = bmp
        val side = min(bmp.width, bmp.height).toFloat()
        view = if (initialFaceBox != null && selectedId == initialCoverFileId &&
            initialFaceBox.w > 0.0 && initialFaceBox.h > 0.0
        ) {
            // faceBox 是 Double（FFI 记录口径），取景窗状态全程 Float，这里一次性收口
            val s = (initialFaceBox.w / 100.0 * bmp.width).toFloat()
            CropView(
                sidePx = s.coerceIn(side / MAX_AVATAR_ZOOM, side),
                cx = ((initialFaceBox.x / 100.0 + initialFaceBox.w / 200.0) * bmp.width).toFloat(),
                cy = ((initialFaceBox.y / 100.0 + initialFaceBox.h / 200.0) * bmp.height).toFloat(),
            )
        } else {
            CropView(sidePx = side, cx = bmp.width / 2f, cy = bmp.height / 2f)
        }
    }

    Dialog(
        onDismissRequest = onCancel,
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Box(
            Modifier
                .fillMaxSize()
                .background(Color.Black.copy(alpha = 0.92f)),
        ) {
            Column(Modifier.fillMaxSize()) {
                // 顶栏：标题 + 取消/保存（全屏页自己带操作，不借用系统对话框的按钮位）
                Row(
                    Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 8.dp, vertical = 6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    TextButton(onClick = onCancel) {
                        Text("取消", color = Color.White, fontSize = 15.sp)
                    }
                    Text(
                        text = "「$personName」的头像",
                        fontSize = 15.sp,
                        fontWeight = FontWeight.Medium,
                        color = Color.White,
                        modifier = Modifier.weight(1f),
                    )
                    TextButton(
                        enabled = bitmap != null && view != null && selected != null,
                        onClick = {
                            val bmp = bitmap ?: return@TextButton
                            val v = view ?: return@TextButton
                            val id = selected?.fileId ?: return@TextButton
                            onSave(id, v.toFaceBox(bmp.width, bmp.height))
                        },
                    ) {
                        Text(
                            text = "保存",
                            color = if (bitmap != null && view != null) colors.primary else Color.Gray,
                            fontSize = 15.sp,
                            fontWeight = FontWeight.Bold,
                        )
                    }
                }

                Box(
                    Modifier
                        .fillMaxWidth()
                        .weight(1f),
                    contentAlignment = Alignment.Center,
                ) {
                    Box(
                        Modifier
                            .size(300.dp)
                            .clip(CircleShape)
                            .background(Color(0xFF1A1A1A))
                            .pointerInput(bitmap) {
                                val bmp = bitmap ?: return@pointerInput
                                detectTransformGestures { _, pan, zoom, _ ->
                                    val v = view ?: return@detectTransformGestures
                                    val maxSide = min(bmp.width, bmp.height).toFloat()
                                    val minSide = maxSide / MAX_AVATAR_ZOOM
                                    // 捏合放大 = 取景窗在图像上覆盖的边长变小
                                    val side = (v.sidePx / zoom).coerceIn(minSide, maxSide)
                                    // 屏幕位移换图像位移（k = 每图像像素占多少屏幕像素）
                                    val k = windowPx / v.sidePx
                                    val next = CropView(side, v.cx - pan.x / k, v.cy - pan.y / k)
                                    view = next.clampedTo(bmp.width, bmp.height)
                                }
                            },
                        // **必须 TopStart**：图比窗大得多，默认的 Center 会先把图居中，
                        // 再叠上我们按「左上角为原点」算的 translationX/Y，两笔位移叠加
                        // 直接把图推出窗外（2026-10-08 实测：圆里全黑、什么也没有）。
                        contentAlignment = Alignment.TopStart,
                    ) {
                        val bmp = bitmap
                        val v = view
                        if (bmp != null && v != null) {
                            val k = windowPx / v.sidePx
                            // offset 必须在尺寸之前（外层）才挪的是整个节点；
                            // **requiredSize 而非 size**：size 会被父 Box 的 300dp 上限夹住，
                            // 节点实际只有窗大，而平移量是按放大后的真实尺寸算的，
                            // 结果图被整幅推出窗外（2026-10-08 实测：圆里全黑）。
                            Image(
                                bitmap = bmp.asImageBitmap(),
                                contentDescription = null,
                                modifier = Modifier
                                    .offset {
                                        IntOffset(
                                            (windowPx / 2f - v.cx * k).roundToInt(),
                                            (windowPx / 2f - v.cy * k).roundToInt(),
                                        )
                                    }
                                    .requiredSize(
                                        width = with(density) { (bmp.width * k).toDp() },
                                        height = with(density) { (bmp.height * k).toDp() },
                                    ),
                            )
                        } else if (selected == null) {
                            // 候选拉回来是空的（人物还没有成员图）——也不能只留一个黑圈
                            Text(
                                text = "这个人还没有成员图\n先在网格里选图「添加到人物」",
                                fontSize = 13.sp,
                                color = Color.White.copy(alpha = 0.7f),
                                textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                                modifier = Modifier
                                    .align(Alignment.Center)
                                    .padding(24.dp),
                            )
                        } else if (loadFailed) {
                            Text(
                                text = "这张图取不到\n换一张试试",
                                fontSize = 13.sp,
                                color = Color.White.copy(alpha = 0.7f),
                                textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                                modifier = Modifier
                                    .align(Alignment.Center)
                                    .padding(24.dp),
                            )
                        } else if (selected != null) {
                            CircularProgressIndicator(
                                color = Color.White,
                                modifier = Modifier.align(Alignment.Center),
                            )
                        }
                    }
                    // 圆形取景框描边（在裁剪窗之上，不参与手势）
                    Box(
                        Modifier
                            .size(300.dp)
                            .border(2.dp, Color.White.copy(alpha = 0.75f), CircleShape),
                    )
                }

                Text(
                    text = "拖动移动，双指缩放",
                    fontSize = 12.sp,
                    color = Color.White.copy(alpha = 0.55f),
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(top = 4.dp),
                    textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                )

                // 候选封面横条（桌面右侧竖列表的触屏同位）。只有一张时整条不出现——
                // 一排一个孤零零的圆点没有信息量。
                if (candidates.size > 1) {
                    LazyRow(
                        Modifier
                            .fillMaxWidth()
                            .padding(vertical = 12.dp),
                        horizontalArrangement = Arrangement.spacedBy(10.dp, Alignment.CenterHorizontally),
                    ) {
                        items(candidates, key = { it.fileId }) { candidate ->
                            AvatarCandidateChip(
                                candidate = candidate,
                                loader = loader,
                                selected = candidate.fileId == selectedId,
                                onClick = { selectedId = candidate.fileId },
                            )
                        }
                    }
                } else {
                    Spacer(Modifier.height(20.dp))
                }
            }
        }
    }
}

/** 最大放大倍率（桌面那颗滑杆的上限同量级；再大就是在放大缩略图的马赛克了）。 */
private const val MAX_AVATAR_ZOOM = 8f

/** 取景窗 → faceBox 百分比（口径见 [PersonAvatarCropDialog] 的 KDoc）。 */
private fun CropView.toFaceBox(imgW: Int, imgH: Int): FfiFaceBox = FfiFaceBox(
    x = (cx - sidePx / 2f) / imgW * 100.0,
    y = (cy - sidePx / 2f) / imgH * 100.0,
    w = sidePx / imgW * 100.0,
    h = sidePx / imgH * 100.0,
)

/** 把窗心收进图内：正方形边长恒 ≤ min(图宽高)，所以 half 不会越过对侧边界。 */
private fun CropView.clampedTo(imgW: Int, imgH: Int): CropView {
    val half = sidePx / 2f
    return copy(
        cx = cx.coerceIn(half, imgW - half),
        cy = cy.coerceIn(half, imgH - half),
    )
}

/** 候选图小圆点（56dp，选中带主色环）。 */
@Composable
private fun AvatarCandidateChip(
    candidate: AvatarCandidate,
    loader: ThumbnailLoader,
    selected: Boolean,
    onClick: () -> Unit,
) {
    val colors = AuroraTheme.colors
    var bmp by remember(candidate.contentUri) {
        mutableStateOf(loader.peekMemory(loader.extractImageId(candidate.contentUri)))
    }
    LaunchedEffect(candidate.contentUri) {
        if (bmp == null) bmp = loader.loadFastLimited(loader.extractImageId(candidate.contentUri))
    }
    Box(
        Modifier
            .size(56.dp)
            .clip(CircleShape)
            .background(colors.surface)
            .border(
                width = if (selected) 3.dp else 1.dp,
                color = if (selected) colors.primary else Color.White.copy(alpha = 0.25f),
                shape = CircleShape,
            )
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        bmp?.let {
            Image(
                bitmap = it.asImageBitmap(),
                contentDescription = null,
                contentScale = ContentScale.Crop,
                modifier = Modifier.fillMaxSize(),
            )
        }
    }
}
