package com.aurora.gallery.kotlin.ui.components

import android.graphics.Bitmap
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.gestures.detectVerticalDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
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
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathFillType
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
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

/** 裁剪页的一个候选封面（人物成员图）。[name] = 文件名，展开成列表时按它过滤。 */
data class AvatarCandidate(val fileId: String, val contentUri: String, val name: String)

/**
 * 取景窗在图像像素空间里的状态：窗心 + 窗所覆盖的**图像正方形边长**。
 *
 * 用「图像像素里的正方形」而不是「屏幕上的 scale/translate」来存状态，有两个好处：
 *  1. 保存时直接换算成 faceBox 百分比，不需要反推桌面那套 OFFSET/position 数学；
 *  2. 换一张候选图时状态可解释（重置成整图内切正方形），不会出现「新图沿用旧图缩放」
 *     那种看着像 bug 的观感。
 *
 * internal 而非 private：手势归约抽成了纯函数（[reduceCropGesture]）以便单测锚点不变量。
 */
internal data class CropView(val sidePx: Float, val cx: Float, val cy: Float)

/**
 * 每帧手势归约（纯函数，可测）。锚点口径：**图像上落在手指中点下的那点，缩放过程中
 * 始终留在指尖下**（真机报障是「基准点跑到右下角」，这就是它的反面）。
 *
 * [detectTransformGestures] 每帧给的是**当前**手指中点 [centroid]（手势节点的本地坐标）与
 * 它的位移 [pan]，所以上一帧的中点 c0 = c1 − pan。窗口位置 p 与图像坐标的双向换算都是
 * `ix = cx + (p − center)·sidePx / cropPx`，把它在缩放前后各写一次、令两者相等即得：
 *
 *     cx' = cx + (c0 − center)·side/crop − (c1 − center)·side'/crop
 *
 * [cropPx] 是取景圆在屏幕上的直径（= sidePx 个图像像素映射到这么多屏幕像素），
 * [center] 是取景圆圆心在 centroid 同一坐标空间里的位置——视口比取景圆大时两者不相等，
 * 这正是渲染端与手势端必须共用同一组数的原因。
 *
 * 两个退化情形说明这一条式子同时覆盖了桌面那两种操作、且**不把中点位移算两遍**：
 *  - zoom = 1（单指拖）：side' = side，式子塌成 `cx − pan·side/crop`，与原平移逐字相等，
 *    且与 centroid 无关——指尖走到哪，图就跟到哪；
 *  - pan = 0（指尖不动的纯捏合）：塌成绕指尖缩放，指尖在圆心时圆心不动（原语义）。
 *
 * 原先的实现是「绕窗心缩放 + 另加 pan」：中点位移既进了 pan、缩放又没跟住中点，两笔
 * 口径不一致，捏合时看起来就是基准点飘走。
 */
internal fun reduceCropGesture(
    view: CropView,
    centroid: Offset,
    pan: Offset,
    zoom: Float,
    cropPx: Float,
    center: Float,
    maxSide: Float,
    minSide: Float,
): CropView {
    // 捏合放大 = 取景窗在图像上覆盖的边长变小
    val side = (view.sidePx / zoom).coerceIn(minSide, maxSide)
    // 每图像像素占多少屏幕像素（渲染端与这里必须用同一个换算，否则跟不住指尖）
    val kOld = view.sidePx / cropPx
    val kNew = side / cropPx
    return CropView(
        sidePx = side,
        cx = view.cx + (centroid.x - pan.x - center) * kOld - (centroid.x - center) * kNew,
        cy = view.cy + (centroid.y - pan.y - center) * kOld - (centroid.y - center) * kNew,
    )
}

/**
 * 人物头像裁剪页（桌面 `CropAvatarModal` 的触屏同位）。
 *
 * 桌面 → 触屏的三处适配（desktop-to-android 适配表）：
 *  - 滚轮缩放 + 底部滑杆 → **双指捏合**（绕指尖，口径见 [reduceCropGesture]），滑杆删除；
 *  - 鼠标拖拽平移 → **单指拖**；
 *  - 右侧竖排候选图列表 → 底部横滑条（拇指够得着，且给取景窗让出竖向空间）。
 *  - 桌面那套「400 视口 + 250 取景圆 + 圆外压暗」原样搬过来（[CROP_TO_VIEWPORT]）：只留
 *    一枚黑底圆窗时看不见整张图，也就无从判断「是不是已经拖到边了」；手势区同样放到整个
 *    视口上，不必精确按在那枚圆里。
 *
 * 写回的 faceBox 口径与桌面逐字一致：**相对原图的百分比**，x/y = 左上角，w/h = 裁剪区
 * 宽高占比。桌面那个 250px 正方形窗在图像上截出的也是正方形，所以 w%·natW == h%·natH；
 * 本地图非正方形时 w% 与 h% 不相等是**正确的**，别在读取端把它们当同一个数。
 *
 * 取图走 [ThumbnailLoader.loadCropSource]：按长边降采样解**原图**，线性分辨率约是缩略图
 * 的四倍——这一页是全 App 唯一会把图放大到远超原始像素的界面，用缩略图就是满屏马赛克
 * （2026-10-08 真机报障）。faceBox 存百分比、与原图/缩略图同比例，所以换源不影响已存的
 * 头像框，存量数据不用迁移；解不出来才退回缩略图。雷区是「把 URI 丢给系统解码器」而不是
 * 「解原图」本身（见 ImageSource.kt 的三星事故注释），这条路自己开流喂 BitmapFactory。
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
    // 候选抽屉：progress 0 = 收起（横条）、1 = 展开（搜索 + 网格）。拖拽期间由手势逐帧写，
    // 松手交给 animateFloatAsState 吸到最近一端 —— 与查看器底部抽屉同一套手感
    //（NativeGalleryView 的 applyDrawerProgress / animateDrawerTo：280ms 缓动 +
    //  ±500px/s 的甩动速度否决位置判断）。
    var drawerTarget by remember { mutableFloatStateOf(0f) }
    var dragProgress by remember { mutableFloatStateOf(0f) }
    var dragging by remember { mutableStateOf(false) }
    val drawerAnimated by animateFloatAsState(
        targetValue = drawerTarget,
        animationSpec = tween(durationMillis = 280, easing = FastOutSlowInEasing),
        label = "candidateDrawer",
    )
    var query by remember { mutableStateOf("") }

    // 换封面图 = 重新取位图 + 重置取景窗。initialFaceBox 只用于**首张**：它描述的是
    // 旧封面的构图，套到另一张图上会把新图裁歪。
    LaunchedEffect(selected?.contentUri) {
        val uri = selected?.contentUri
        bitmap = null
        view = null
        loadFailed = false
        if (uri == null) return@LaunchedEffect
        val id = loader.extractImageId(uri)
        // 优先按长边降采样解**原图**（#6）：裁剪页是全 App 里唯一会把图放大到远超原始像素
        // 的界面，512 的缩略图在这儿就是马赛克。解不出来退回缩略图——取景至少还能用，
        // 别把裁剪页变成崩溃面。faceBox 存百分比，换源不影响已存的头像框。
        val bmp = loader.loadCropSource(id) ?: loader.loadFastLimited(id)
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
        // BoxWithConstraints 而非 Box：展开候选区时要拿整页高度算面板上限
        BoxWithConstraints(
            Modifier
                .fillMaxSize()
                // 桌面同页是 bg-black/70：压得太死就看不见这是在图库里改头像
                .background(Color.Black.copy(alpha = 0.7f)),
        ) {
            // 视口那层还有一个 BoxWithConstraints，maxHeight 会被它遮住（Kotlin 不许隐式
            // 跨两层接收者取值），所以这里先把整页高度存成局部量
            val pageHeight = maxHeight
            Column(Modifier.fillMaxSize()) {
                // 顶栏：标题居中 + 取消/保存在两侧（全屏页自己带操作，不借用系统对话框的按钮位）
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
                        textAlign = TextAlign.Center,
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
                    BoxWithConstraints {
                        // 视口 = 当前可用空间里放得下的最大正方形（手机受宽限、平板受高限），
                        // 取景圆取视口的 5/8 —— 桌面 CropAvatarModal 的 250 / 400 同比例。
                        val side = minOf(minOf(maxWidth, maxHeight), 420.dp)
                        val viewportPx = with(LocalDensity.current) { side.toPx() }
                        val cropPx = viewportPx * CROP_TO_VIEWPORT
                        val center = viewportPx / 2f
                        // 圆外压暗的遮罩（EvenOdd：矩形挖掉取景圆），圆心与渲染共用同一个数
                        val mask = remember(viewportPx, cropPx) {
                            val r = cropPx / 2f
                            Path().apply {
                                addRect(Rect(0f, 0f, viewportPx, viewportPx))
                                addOval(Rect(center - r, center - r, center + r, center + r))
                                fillType = PathFillType.EvenOdd
                            }
                        }
                        val image = remember(bitmap) { bitmap?.asImageBitmap() }
                        Box(
                            Modifier
                                .size(side)
                                .clip(CircleShape)
                                .background(Color(0xFF1A1A1A))
                                // 图、遮罩、取景环全在同一个 DrawScope 里按**同一套换算**画。
                                // 之前是 offset + requiredSize 的 Image 节点：节点比父级大得多时
                                // 被按居中对齐放置，画出来的区域和模型保存的区域差了半个视口
                                // （2026-10-08 实测：圈里是人物，存完头像却是左上角的 logo）。
                                .drawBehind {
                                    val bmp = bitmap
                                    val v = view
                                    if (bmp != null && v != null && image != null) {
                                        val k = cropPx / v.sidePx
                                        drawImage(
                                            image = image,
                                            dstOffset = IntOffset(
                                                (center - v.cx * k).roundToInt(),
                                                (center - v.cy * k).roundToInt(),
                                            ),
                                            dstSize = IntSize(
                                                (bmp.width * k).roundToInt(),
                                                (bmp.height * k).roundToInt(),
                                            ),
                                        )
                                        drawPath(mask, Color.Black.copy(alpha = 0.6f))
                                        drawCircle(
                                            color = Color.White.copy(alpha = 0.85f),
                                            radius = cropPx / 2f,
                                            center = Offset(center, center),
                                            style = Stroke(width = 2.dp.toPx()),
                                        )
                                    }
                                }
                                .pointerInput(bitmap) {
                                    val bmp = bitmap ?: return@pointerInput
                                    detectTransformGestures { centroid, pan, zoom, _ ->
                                        val v = view ?: return@detectTransformGestures
                                        val maxSide = min(bmp.width, bmp.height).toFloat()
                                        val minSide = maxSide / MAX_AVATAR_ZOOM
                                        view = reduceCropGesture(
                                            v, centroid, pan, zoom, cropPx, center, maxSide, minSide,
                                        ).clampedTo(bmp.width, bmp.height)
                                    }
                                },
                            contentAlignment = Alignment.Center,
                        ) {
                            if (image == null || view == null) {
                                when {
                                    // 候选拉回来是空的（人物还没有成员图）——也不能只留一个黑圈
                                    selected == null -> Text(
                                        text = "这个人还没有成员图\n先在网格里选图「添加到人物」",
                                        fontSize = 13.sp,
                                        color = Color.White.copy(alpha = 0.7f),
                                        textAlign = TextAlign.Center,
                                        modifier = Modifier.padding(24.dp),
                                    )
                                    loadFailed -> Text(
                                        text = "这张图取不到\n换一张试试",
                                        fontSize = 13.sp,
                                        color = Color.White.copy(alpha = 0.7f),
                                        textAlign = TextAlign.Center,
                                        modifier = Modifier.padding(24.dp),
                                    )
                                    else -> CircularProgressIndicator(color = Color.White)
                                }
                            }
                        }
                    }
                }

                Text(
                    text = "拖动移动，双指缩放",
                    fontSize = 12.sp,
                    color = Color.White.copy(alpha = 0.55f),
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(top = 4.dp),
                    textAlign = TextAlign.Center,
                )

                // 候选封面抽屉（桌面右侧竖列表的触屏同位）。只有一张时整条不出现——
                // 一排一个孤零零的圆点没有信息量。
                if (candidates.size <= 1) {
                    Spacer(Modifier.height(20.dp))
                } else {
                    val collapsedH = 76.dp
                    val expandedH = pageHeight * PANEL_EXPANDED
                    val travelPx = with(LocalDensity.current) {
                        (expandedH - collapsedH).toPx().coerceAtLeast(1f)
                    }
                    val progress = if (dragging) dragProgress else drawerAnimated
                    // 把手：整行 48dp 命中区（视觉只是中间那条小横杠），跟手拖 + 点一下切换
                    // ——拖动之外必须留非拖拽替代（触屏适配规范）。
                    Box(
                        Modifier
                            .fillMaxWidth()
                            .height(48.dp)
                            .pointerInput(travelPx) {
                                var lastT = 0L
                                var vel = 0f
                                detectVerticalDragGestures(
                                    onDragStart = {
                                        dragging = true
                                        dragProgress = drawerTarget
                                        lastT = 0L
                                        vel = 0f
                                    },
                                    onVerticalDrag = { change, dy ->
                                        val t = change.uptimeMillis
                                        if (lastT != 0L) {
                                            vel = dy * 1000f / (t - lastT).coerceAtLeast(1L)
                                        }
                                        lastT = t
                                        dragProgress = (dragProgress - dy / travelPx).coerceIn(0f, 1f)
                                    },
                                    onDragEnd = {
                                        dragging = false
                                        drawerTarget = when {
                                            vel > 500f -> 0f
                                            vel < -500f -> 1f
                                            else -> if (dragProgress > 0.5f) 1f else 0f
                                        }
                                    },
                                    onDragCancel = { dragging = false },
                                )
                            }
                            .clickable { drawerTarget = if (drawerTarget > 0.5f) 0f else 1f },
                        contentAlignment = Alignment.Center,
                    ) {
                        Box(
                            Modifier
                                .size(width = 32.dp, height = 4.dp)
                                .clip(RoundedCornerShape(2.dp))
                                .background(Color.White.copy(alpha = 0.35f)),
                        )
                    }
                    Box(
                        Modifier
                            .fillMaxWidth()
                            .height(collapsedH + (expandedH - collapsedH) * progress)
                            .padding(bottom = 12.dp),
                    ) {
                        if (progress > 0.5f) {
                            val filtered = remember(candidates, query) {
                                val q = query.trim()
                                if (q.isEmpty()) {
                                    candidates
                                } else {
                                    candidates.filter { it.name.contains(q, ignoreCase = true) }
                                }
                            }
                            Column(Modifier.fillMaxSize()) {
                                // 搜索框形制照顶栏那颗搜索胶囊（SearchPill）：40dp 高、圆角 50、
                                // surface 底 + subtle 描边、放大镜 + 占位文字 + 尾部清空 X，
                                // 连「平板上不撑满、封顶 500dp」一起照抄（顶栏那条就是被反馈
                                // 横屏上搜索框太长才加的）。外面再垫到 48dp 高保证命中区够触屏。
                                Box(
                                    Modifier
                                        .fillMaxWidth()
                                        .height(48.dp)
                                        .padding(horizontal = 16.dp),
                                    contentAlignment = Alignment.Center,
                                ) {
                                    Row(
                                        Modifier
                                            .widthIn(max = 500.dp)
                                            .fillMaxWidth()
                                            .height(40.dp)
                                            .background(colors.surface, RoundedCornerShape(50))
                                            .border(1.dp, colors.subtle, RoundedCornerShape(50))
                                            .padding(horizontal = 12.dp),
                                        verticalAlignment = Alignment.CenterVertically,
                                    ) {
                                        Icon(
                                            imageVector = CropIconSearch,
                                            contentDescription = null,
                                            tint = colors.textSecondary,
                                            modifier = Modifier.size(16.dp),
                                        )
                                        Spacer(Modifier.size(8.dp))
                                        BasicTextField(
                                            value = query,
                                            onValueChange = { query = it },
                                            singleLine = true,
                                            modifier = Modifier.weight(1f),
                                            textStyle = TextStyle(
                                                color = colors.textPrimary,
                                                fontSize = 14.sp,
                                            ),
                                            cursorBrush = SolidColor(colors.primary),
                                            decorationBox = { inner ->
                                                Box(contentAlignment = Alignment.CenterStart) {
                                                    if (query.isEmpty()) {
                                                        Text(
                                                            text = "搜索文件名",
                                                            color = colors.textSecondary,
                                                            fontSize = 14.sp,
                                                        )
                                                    }
                                                    inner()
                                                }
                                            },
                                        )
                                        if (query.isNotEmpty()) {
                                            Box(
                                                Modifier
                                                    .size(40.dp)
                                                    .clip(CircleShape)
                                                    .clickable { query = "" },
                                                contentAlignment = Alignment.Center,
                                            ) {
                                                Icon(
                                                    imageVector = CropIconX,
                                                    contentDescription = "清空搜索",
                                                    tint = colors.textSecondary,
                                                    modifier = Modifier.size(16.dp),
                                                )
                                            }
                                        }
                                    }
                                }
                                LazyVerticalGrid(
                                    columns = GridCells.Adaptive(minSize = 72.dp),
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .weight(1f)
                                        .padding(horizontal = 16.dp, vertical = 4.dp),
                                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                                    verticalArrangement = Arrangement.spacedBy(10.dp),
                                ) {
                                    items(filtered, key = { it.fileId }) { candidate ->
                                        AvatarCandidateChip(
                                            candidate = candidate,
                                            loader = loader,
                                            selected = candidate.fileId == selectedId,
                                            size = 72.dp,
                                            onClick = { selectedId = candidate.fileId },
                                        )
                                    }
                                }
                            }
                        } else {
                            LazyRow(
                                Modifier
                                    .fillMaxWidth()
                                    .padding(horizontal = 16.dp),
                                horizontalArrangement = Arrangement.spacedBy(
                                    10.dp,
                                    Alignment.CenterHorizontally,
                                ),
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
                        }
                    }
                }
            }
        }
    }
}

/** 取景圆占视口边长的比例 = 桌面 CropAvatarModal 的 CROP_SIZE / VIEWPORT_SIZE（250 / 400）。 */
private const val CROP_TO_VIEWPORT = 0.625f

/** 候选区展开时占整页高度的比例：再多给就会把取景圆挤得太小，再少则列表看不到几行。 */
private const val PANEL_EXPANDED = 0.42f

/**
 * 最大放大倍率（与桌面那颗滑杆同量级）。换成取原图之后这颗上限不再由马赛克决定，而由
 * 像素比决定：1600 目标长边下放大到 8 倍时取景窗只覆盖约 200 图像像素，投到手机上
 * ~790 屏像素的窗是 4 倍插值——会软，但不出块。
 */
private const val MAX_AVATAR_ZOOM = 8f

/** 取景窗 → faceBox 百分比（口径见 [PersonAvatarCropDialog] 的 KDoc）。 */
private fun CropView.toFaceBox(imgW: Int, imgH: Int): FfiFaceBox = FfiFaceBox(
    x = (cx - sidePx / 2f) / imgW * 100.0,
    y = (cy - sidePx / 2f) / imgH * 100.0,
    w = sidePx / imgW * 100.0,
    h = sidePx / imgH * 100.0,
)

/**
 * 把窗心收进图内：正方形边长恒 ≤ min(图宽高)，所以 half 不会越过对侧边界。
 * internal 是为了让 [reduceCropGesture] 的单测连着 clamp 一起验。
 */
internal fun CropView.clampedTo(imgW: Int, imgH: Int): CropView {
    val half = sidePx / 2f
    return copy(
        cx = cx.coerceIn(half, imgW - half),
        cy = cy.coerceIn(half, imgH - half),
    )
}

/** 候选图小圆点（收起态 56dp、展开网格 72dp，选中带主色环）。 */
@Composable
private fun AvatarCandidateChip(
    candidate: AvatarCandidate,
    loader: ThumbnailLoader,
    selected: Boolean,
    onClick: () -> Unit,
    size: Dp = 56.dp,
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
            .size(size)
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

/**
 * 搜索胶囊里的放大镜与清空 X（lucide 同款字形）。顶栏 SearchPill 用的是它自己那份
 * private 图标，这里就近自绘一份同样的路径——字形一致，样式才算「和顶部工具栏一样」。
 */
private val CropIconSearch: ImageVector by lazy {
    auroraIcon("CropSearch") {
        moveTo(3f, 11f)
        arcTo(8f, 8f, 0f, true, true, 19f, 11f)
        arcTo(8f, 8f, 0f, true, true, 3f, 11f)
        close()
        moveTo(21f, 21f)
        lineTo(16.65f, 16.65f)
    }
}

private val CropIconX: ImageVector by lazy {
    auroraIcon("CropX") {
        moveTo(18f, 6f)
        lineTo(6f, 18f)
        moveTo(6f, 6f)
        lineTo(18f, 18f)
    }
}
