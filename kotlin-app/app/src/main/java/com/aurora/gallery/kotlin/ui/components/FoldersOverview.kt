package com.aurora.gallery.kotlin.ui.components

import android.graphics.Outline
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.text.TextUtils
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.ViewOutlineProvider
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.path
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.view.doOnLayout
import androidx.recyclerview.widget.GridLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.aurora.gallery.kotlin.ThumbnailLoader
import com.aurora.gallery.kotlin.ui.theme.AuroraTheme
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import uniffi.aurora_core.Folder

/** 简化文件夹图标（material-icons-core 无 Folder，自行绘制，对齐 lucide Folder）。 */
private val FolderIcon: ImageVector by lazy {
    ImageVector.Builder(
        name = "Folder",
        defaultWidth = 24.dp,
        defaultHeight = 24.dp,
        viewportWidth = 24f,
        viewportHeight = 24f,
    ).apply {
        path(fill = SolidColor(Color.Black)) {
            moveTo(2f, 6f)
            curveTo(2f, 4.9f, 2.9f, 4f, 4f, 4f)
            lineTo(9f, 4f)
            lineTo(11f, 6f)
            lineTo(20f, 6f)
            curveTo(21.1f, 6f, 22f, 6.9f, 22f, 8f)
            lineTo(22f, 18f)
            curveTo(22f, 19.1f, 21.1f, 20f, 20f, 20f)
            lineTo(4f, 20f)
            curveTo(2.9f, 20f, 2f, 19.1f, 2f, 18f)
            close()
        }
    }.build()
}

/**
 * 文件夹总览主视图（原生 RecyclerView + GridLayoutManager，对齐系统相册滚动性能）。
 */
@Composable
fun FoldersOverview(
    folders: List<Folder>,
    thumbnailLoader: ThumbnailLoader,
    onFolderClick: (Folder) -> Unit,
    modifier: Modifier = Modifier,
    /**
     * 三档捏合档位：0=小、1=中、2=大（默认中档）。
     * 由应用级状态传入（3.1 `AppState.gridLevel`，L2 修复）：与 FileGrid 共享同一档位，
     * 进文件夹/返回总览不再重置，写回经 [onLevelChange]，本组件不持有档位。
     */
    level: Int = 1,
    onLevelChange: (Int) -> Unit = {},
    /**
     * 返回总览时恢复的滚动位置（对齐 React 版 `HistoryItem.scrollTop` 的恢复行为）。
     * 本组件因导航离开组合再回来时 RV 是全新的，由宿主把离开前记录的位置传回；
     * 只在本次组合实例消费一次，之后的重扫/重组不再重复归位。
     */
    initialScrollTop: Int = 0,
    /** 滚动位置上报（每滚动帧调用；宿主用普通字段记录，见 [AppState.overviewScrollTop]）。 */
    onScrollChanged: (Int) -> Unit = {},
) {
    val colors = AuroraTheme.colors
    val context = LocalContext.current

    // 进度驱动 FLIP（与 FileGrid 同一套手感：捏合 = FLIP 动画的进度条）。
    // 必须定义在 gridAdapter 之前——gridAdapter 与下面的 AndroidView 都要用。
    val rvHolder = remember { RvHolder() }
    val pinchFlip = remember { PinchFlipController() }
    // 收尾动画时长：捏合换档时按剩余进度缩短，用后即复位
    var flipDurationMs by remember { mutableLongStateOf(FLIP_DURATION_MS) }

    val gridAdapter = remember(pinchFlip) {
        FolderAdapter(
            loader = thumbnailLoader,
            surfaceColor = colors.surface.toArgb(),
            textPrimaryColor = colors.textPrimary.toArgb(),
            textSecondaryColor = colors.textSecondary.toArgb(),
            onClick = onFolderClick,
        ).also { it.pinchFlip = pinchFlip }
    }

    LaunchedEffect(folders) {
        gridAdapter.submit(folders)
        // notifyDataSetChanged 会把 RV 打回顶部（重扫/数据替换场景），记忆同步归零；
        // 返回总览的恢复（pendingRestore>0）在其后的布局回调里执行，会覆盖这里的值
        onScrollChanged(0)
    }

    // 滚动位置恢复：本次组合实例消费一次。submit 之后注册 doOnLayout——首个带数据的
    // 布局完成后 scrollBy 归位（LinearLayoutManager 按需填充，一步可滚到位），避免
    // 对着空内容滚；消费完置 0，重扫/重组不会重复归位。
    var pendingRestore by remember { mutableIntStateOf(initialScrollTop) }
    LaunchedEffect(Unit) {
        if (pendingRestore > 0) {
            val target = pendingRestore
            rvHolder.rv?.doOnLayout { rv ->
                pendingRestore = 0
                rv.scrollBy(0, target)
            }
        }
    }

    DisposableEffect(gridAdapter) {
        onDispose { gridAdapter.cancel() }
    }

    if (folders.isEmpty()) {
        Box(modifier = modifier, contentAlignment = Alignment.Center) {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Icon(
                    imageVector = FolderIcon,
                    contentDescription = null,
                    tint = colors.textSecondary,
                    modifier = Modifier.size(48.dp),
                )
                Text(
                    text = "暂无文件夹",
                    fontSize = 14.sp,
                    color = colors.textSecondary,
                    modifier = Modifier.padding(top = 12.dp),
                )
            }
        }
        return
    }

    val isTablet = LocalConfiguration.current.screenWidthDp >= 600
    val gapPx = context.dp(if (isTablet) 16 else 10)
    val paddingPx = context.dp(if (isTablet) 24 else 8)

    // 三档捏合：档位是应用级状态（AppState.gridLevel），这里只读参数 + 写回回调
    val currentLevel = rememberUpdatedState(level)
    // factory 闭包只创建一次，gapPx 直接捕获会在旋转（平板/手机间距变化）后读到旧值。
    val currentGapPx = rememberUpdatedState(gapPx)
    val decoration = remember { GridSpacingDecoration(6, gapPx) }

    AndroidView(
        factory = { ctx ->
            val initialCols = targetCols(ctx.pxToDp(ctx.resources.displayMetrics.widthPixels), level)
            decoration.spanCount = initialCols
            RecyclerView(ctx).apply {
                layoutManager = AuroraGridLayoutManager(ctx, initialCols)
                adapter = gridAdapter
                addItemDecoration(decoration)
                setPadding(paddingPx, paddingPx, paddingPx, paddingPx)
                clipToPadding = false
                itemAnimator = null
                isVerticalScrollBarEnabled = false
                rvHolder.rv = this
                // 同时挂两条分发路径，覆盖「第一指落在 item 上」与「落在网格间隙上」两种情况
                val pinch = PinchGridSpanListener(
                    context = ctx,
                    onPinchStart = { _, _ -> rvHolder.rv?.let { pinchFlip.begin(it, currentGapPx.value) } },
                    onPinchProgress = { scale, _, _ ->
                        val rv = rvHolder.rv ?: return@PinchGridSpanListener
                        if (!pinchFlip.isActive) return@PinchGridSpanListener
                        val dir = if (scale >= 1f) 1 else -1
                        val targetLevel = (currentLevel.value + dir).coerceIn(0, 2)
                        val progress = if (targetLevel == currentLevel.value) {
                            0f
                        } else {
                            PinchFlipController.progressFor(scale)
                        }
                        // 目标列数用 rv 实际宽度算，与 update 提交口径一致，避免首帧屏宽兜底值
                        // 与 pxToDp(rv.width) 的舍入差异导致预览列数与提交列数不一致。
                        val widthDp = rv.context.pxToDp(rv.width)
                        pinchFlip.update(
                            rv,
                            targetLevel,
                            targetCols(widthDp, targetLevel),
                            progress,
                        )
                    },
                    onPinchEnd = {
                        val rv = rvHolder.rv ?: return@PinchGridSpanListener
                        if (pinchFlip.isActive) {
                            val target = pinchFlip.currentTargetLevel
                            if (pinchFlip.shouldCommit() && target != currentLevel.value) {
                                // 收尾只跑剩下的那一段，别让手感发黏
                                val remaining = 1f - pinchFlip.currentProgress
                                flipDurationMs =
                                    (FLIP_DURATION_MS * remaining).toLong().coerceAtLeast(80L)
                                pinchFlip.release()
                                onLevelChange(target)
                            } else {
                                pinchFlip.settle(rv)
                            }
                        }
                    },
                )
                setOnTouchListener(pinch)
                addOnItemTouchListener(pinch)
                // 滚动位置上报：宿主用普通字段记录（非 Compose state，不触发重组），
                // 返回总览时作为 initialScrollTop 传回归位
                addOnScrollListener(object : RecyclerView.OnScrollListener() {
                    override fun onScrolled(rv: RecyclerView, dx: Int, dy: Int) {
                        onScrollChanged(rv.computeVerticalScrollOffset())
                    }
                })
            }
        },
        update = { rv ->
            val lm = rv.layoutManager as? GridLayoutManager ?: return@AndroidView
            if (rv.width <= 0) return@AndroidView
            val widthDp = rv.context.pxToDp(rv.width)
            val target = targetCols(widthDp, level)
            if (target != lm.spanCount) {
                animateSpanChange(rv, lm, decoration, target, flipDurationMs)
                flipDurationMs = FLIP_DURATION_MS
            }
        },
        modifier = modifier,
    )
}

private class FolderAdapter(
    private val loader: ThumbnailLoader,
    private val surfaceColor: Int,
    private val textPrimaryColor: Int,
    private val textSecondaryColor: Int,
    private val onClick: (Folder) -> Unit,
) : RecyclerView.Adapter<FolderAdapter.VH>() {

    private val folders = mutableListOf<Folder>()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    /** 进度驱动 FLIP 控制器；捏合中新绑定的 item 需要补上当前进度的 transform。 */
    var pinchFlip: PinchFlipController? = null

    fun submit(list: List<Folder>) {
        folders.clear()
        folders.addAll(list)
        notifyDataSetChanged()
    }

    fun cancel() = scope.cancel()

    override fun getItemCount(): Int = folders.size

    class VH(
        view: View,
        val cover: ImageView,
        val count: TextView,
        val name: TextView,
    ) : RecyclerView.ViewHolder(view) {
        var job: Job? = null
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): VH {
        val context = parent.context
        val radius = context.dp(8).toFloat()

        val cover = SquareImageView(context).apply {
            scaleType = ImageView.ScaleType.CENTER_CROP
            setBackgroundColor(surfaceColor)
            clipToOutline = true
            outlineProvider = object : ViewOutlineProvider() {
                override fun getOutline(view: View, outline: Outline) {
                    outline.setRoundRect(0, 0, view.width, view.height, radius)
                }
            }
        }

        val count = TextView(context).apply {
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 9f)
            setTextColor(android.graphics.Color.WHITE)
            typeface = Typeface.DEFAULT_BOLD
            gravity = Gravity.CENTER
            background = GradientDrawable().apply {
                setColor(0x80000000.toInt())
                cornerRadius = context.dp(50).toFloat()
            }
            setPadding(context.dp(6), context.dp(2), context.dp(6), context.dp(2))
        }

        val name = TextView(context).apply {
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
            setTextColor(textPrimaryColor)
            typeface = Typeface.DEFAULT_BOLD
            gravity = Gravity.CENTER
            maxLines = 1
            ellipsize = TextUtils.TruncateAt.END
            setPadding(context.dp(4), context.dp(4), context.dp(4), 0)
        }

        val frame = FrameLayout(context).apply {
            addView(
                cover,
                FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                ),
            )
            addView(
                count,
                FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                    Gravity.BOTTOM or Gravity.END,
                ).apply { setMargins(0, 0, context.dp(6), context.dp(6)) },
            )
        }

        val root = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            addView(
                frame,
                LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                ),
            )
            addView(
                name,
                LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                ),
            )
        }

        val vh = VH(root, cover, count, name)
        root.setOnClickListener {
            val pos = vh.bindingAdapterPosition
            if (pos != RecyclerView.NO_POSITION) onClick(folders[pos])
        }
        return vh
    }

    override fun onBindViewHolder(holder: VH, position: Int) {
        // 同 FileGrid：清掉 FLIP 动画残留的 transform
        resetFlipTransform(holder.itemView)
        // 捏合进行中新绑定的 item 要补上当前进度的 transform，否则会以未变换的样子闪现
        pinchFlip?.takeIf { it.isActive }?.applyToNewChild(holder.itemView, position)

        val folder = folders[position]
        holder.name.text = folder.name
        holder.count.text = folder.imageCount.toString()
        holder.count.visibility = if (folder.imageCount > 0) View.VISIBLE else View.GONE

        val uri = folder.coverUri
        if (uri != null) {
            val imageId = loader.extractImageId(uri)
            val cached = loader.peekMemory(imageId)
            if (cached != null) {
                holder.cover.setImageBitmap(cached)
            } else {
                holder.cover.setImageBitmap(null)
                holder.job?.cancel()
                holder.job = scope.launch {
                    val bmp = loader.loadFastLimited(imageId)
                    if (holder.bindingAdapterPosition == position) {
                        holder.cover.setImageBitmap(bmp)
                    }
                }
            }
        } else {
            holder.cover.setImageBitmap(null)
        }
    }

    override fun onViewRecycled(holder: VH) {
        holder.job?.cancel()
        holder.cover.setImageBitmap(null)
    }
}
