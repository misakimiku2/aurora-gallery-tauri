package com.aurora.gallery.kotlin.ui.components

import android.graphics.Outline
import android.graphics.Rect
import android.graphics.Typeface
import android.util.TypedValue
import android.view.View
import android.view.ViewGroup
import android.view.ViewOutlineProvider
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.core.view.doOnLayout
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import androidx.recyclerview.widget.GridLayoutManager
import androidx.recyclerview.widget.RecyclerView
import androidx.recyclerview.widget.StaggeredGridLayoutManager
import androidx.recyclerview.widget.StaggeredSpanAccess
import com.aurora.gallery.kotlin.ThumbnailLoader
import com.aurora.gallery.kotlin.ui.theme.AuroraTheme
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import uniffi.aurora_core.Image
import kotlin.math.abs
import kotlin.math.roundToInt

/** 普通可变引用（捏合锚点透传）：变化不需要触发重组，update 里同步读取即可。 */
private class AnchorOverrideHolder {
    var value: PinchAnchor? = null
}

/** 普通可变代纪计数：模式切换收尾 FLIP 的时效守卫（避免触发重组）。 */
private class EpochHolder {
    var value: Int = 0
}

/**
 * 图片网格（原生 RecyclerView，对齐系统相册滚动性能）。
 *
 * 支持 [LayoutMode] 三种排布（安卓端不含 list，见 LayoutMode 的 KDoc）与 [GroupBy] 分组标题。
 * 三种模式的三档捏合都是**进度驱动（跟手）预览**：GRID 行号公式、MASONRY 列分配模拟、
 * ADAPTIVE 行装箱模拟（见 AdaptiveGrid.kt），松手按剩余进度收尾 FLIP 落档。
 */
@Composable
fun FileGrid(
    images: List<Image>,
    selectedIds: Set<String>,
    thumbnailLoader: ThumbnailLoader,
    onItemClick: (Image) -> Unit,
    modifier: Modifier = Modifier,
    layoutMode: LayoutMode = LayoutMode.GRID,
    groupBy: GroupBy = GroupBy.NONE,
) {
    val colors = AuroraTheme.colors
    val context = LocalContext.current

    // 折叠状态（按分组 id 记录）；切换分组方式时重置
    var collapsedIds by remember(groupBy) { mutableStateOf<Set<String>>(emptySet()) }
    val currentCollapsed = rememberUpdatedState(collapsedIds)

    val isTablet = LocalConfiguration.current.screenWidthDp >= 600
    val gapDp = if (isTablet) 16 else 10
    val paddingDp = if (isTablet) 24 else 8
    val gapPx = context.dp(gapDp)
    val paddingPx = context.dp(paddingDp)

    // 三档捏合：0=小、1=中、2=大（默认中档）
    var level by remember { mutableIntStateOf(1) }
    val currentLevel = rememberUpdatedState(level)
    // factory 闭包只创建一次，直接捕获 layoutMode/groupBy/gapPx 会在切换模式/分组后读到旧值，
    // 导致捏合判定与目标列数算错（布局错乱）。用 rememberUpdatedState 让闭包始终读到最新值。
    val currentLayoutMode = rememberUpdatedState(layoutMode)
    val currentGroupBy = rememberUpdatedState(groupBy)
    val currentGapPx = rememberUpdatedState(gapPx)
    val decoration = remember { GridSpacingDecoration(6, gapPx) }

    // 进度驱动 FLIP：捏合手势 = FLIP 动画的进度条（见 PinchFlipController）
    val rvHolder = remember { RvHolder() }
    val pinchFlip = remember { PinchFlipController() }
    // 收尾动画时长：捏合换档时按**剩余进度**缩短（捏到 80% 松手只剩 20% 要跑），用后即复位
    var flipDurationMs by remember { mutableLongStateOf(FLIP_DURATION_MS) }

    // 容器宽度（dp）：先用配置屏宽兜底，再由 AndroidView.update 用量出的实际值覆盖。
    // 兜底是必须的——adaptive 的行化依赖宽度，首帧若为 0 会退化成「每张图独占一行」闪一下。
    var measuredWidthDp by remember { mutableIntStateOf(0) }
    val containerWidthDp = measuredWidthDp.takeIf { it > 0 } ?: LocalConfiguration.current.screenWidthDp
    // sticky 分组标题实例；RecyclerView 无法查询已挂载的 ItemDecoration，只能自己记账
    var stickyDecoration by remember { mutableStateOf<RecyclerView.ItemDecoration?>(null) }

    // 已应用到 RecyclerView 的布局模式。与 layoutMode 不一致时触发切换 + FLIP。
    var appliedMode by remember { mutableStateOf(layoutMode) }

    val cols = if (containerWidthDp > 0) targetCols(containerWidthDp, level) else 0
    // adaptive 当前档位的目标行高（dp → px）。行划分不再进 adapter item（一图一项），
    // 只作为 AuroraAdaptiveLayoutManager 的布局参数与捏合模拟的目标几何。
    val density = context.resources.displayMetrics.density
    val adaptiveRowHeightPx = if (containerWidthDp > 0 && layoutMode == LayoutMode.ADAPTIVE) {
        (adaptiveTargetHeightDp(containerWidthDp, kotlin.math.max(1, cols), gapDp, paddingDp) * density)
            .roundToInt()
    } else {
        0
    }
    // adaptive 目标档位的行高 px（捏合预览用；gapDp/paddingDp 经 rememberUpdatedState 防闭包过期）
    val currentGapDp = rememberUpdatedState(gapDp)
    val currentPaddingDp = rememberUpdatedState(paddingDp)
    fun adaptiveTargetRowHeightPx(widthDp: Int, targetLevel: Int): Int =
        (adaptiveTargetHeightDp(
            widthDp,
            kotlin.math.max(1, targetCols(widthDp, targetLevel)),
            currentGapDp.value,
            currentPaddingDp.value,
        ) * density).roundToInt()

    // 三种模式的 item 序列相同（一图一项 + 分组标题），与布局模式/宽度/档位无关——
    // 换档、切换模式不再重建 item 序列，position 与图的对应关系跨档稳定（跟手预览的前提）。
    val items = remember(images, groupBy, collapsedIds) {
        buildGridItems(images, groupBy, collapsedIds)
    }

    val adapter = remember {
        FileGridAdapter(
            loader = thumbnailLoader,
            surfaceColor = colors.surface.toArgb(),
            textPrimaryColor = colors.textPrimary.toArgb(),
            textSecondaryColor = colors.textSecondary.toArgb(),
            primaryColor = colors.primary.toArgb(),
            onClick = onItemClick,
            onToggleGroup = { id ->
                collapsedIds = if (id in collapsedIds) collapsedIds - id else collapsedIds + id
            },
        ).also { it.pinchFlip = pinchFlip }
    }

    // 瀑布流的进度驱动 FLIP：列分配是确定性算法（逐 item 放入最短列），离线模拟出新档位
    // 布局做逐 item 跟手。依赖 adapter 的宽高比查询，必须在 adapter 之后创建。
    val masonryPinch = remember {
        MasonryPinchController(
            ratioAt = { adapter.aspectRatioAt(it) },
            isHeaderAt = { adapter.isHeaderAt(it) },
        )
    }
    adapter.masonryPinch = masonryPinch

    // 自适应视图的进度驱动 FLIP：行装箱是确定性算法（贪心累加成行 + 整行拉伸），与
    // AuroraAdaptiveLayoutManager 共用 packAdaptiveRowAt 一份数学，离线模拟目标档位
    // 行划分做逐 item 跟手（架构与 masonry 对称，见 AdaptiveGrid.kt）。
    val adaptivePinch = remember {
        AdaptivePinchController(
            ratioAt = { adapter.aspectRatioAt(it) },
            isHeaderAt = { adapter.isHeaderAt(it) },
        )
    }
    adapter.adaptivePinch = adaptivePinch

    // adaptive 卡片的文件名文字区高度：与 buildPhotoView 的 name 视图完全同参数离线测量
    //（布局管理器的行推进依赖它，必须与真实渲染逐位一致）。
    val adaptiveTextHeightPx = remember {
        TextView(context).apply {
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
            typeface = Typeface.DEFAULT_BOLD
            maxLines = 1
            setPadding(context.dp(4), context.dp(6), context.dp(4), 0)
        }.let { probe ->
            probe.measure(
                View.MeasureSpec.makeMeasureSpec(1000, View.MeasureSpec.EXACTLY),
                View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED),
            )
            probe.measuredHeight
        }
    }

    // 捏合换档的锚点透传（GRID / MASONRY 共用）：onPinchEnd 记录 → update 消费（一次）。
    // 松手换档必须保持同一锚点停在同一屏幕位置，预览与收尾 FLIP 才无缝衔接。
    val pendingPinchAnchor = remember { AnchorOverrideHolder() }

    // 模式切换收尾 FLIP 的代纪：captureModeSwitch 的快照只在「此后布局没有任何变化」时
    // 有效。收尾回调挂在 doOnLayout/OnLayoutChangeListener 上——滚动只重绘不重布局，
    // 回调可能挂起几分钟，直到下一次真正的布局（往往是下一次捏合的落档）才触发；
    // 那时快照早已过期，对着当前布局放 240ms 反向位移会把整屏卡片甩一下。任何捏合
    // （开始/落档）、档位切换、数据变化都递增代纪，回调执行时发现代纪不符即放弃。
    val modeFlipEpoch = remember { EpochHolder() }

    // 注意：cellWidthPx（单元格宽度）**不在 key 里**。换档必然伴随列宽变化，若列宽变化触发
    // submit，全量刷新会重新 bind 所有 item，把 FLIP 的初始位移抹掉（表现为硬切）。
    // 列宽改用 adapter.applyCellWidth 同步到可见 item，不 notify。
    LaunchedEffect(items, layoutMode, gapPx) {
        if (adapter.submit(items, selectedIds, layoutMode, gapPx, collapsedIds)) {
            modeFlipEpoch.value++
        }
    }

    LaunchedEffect(selectedIds) {
        adapter.updateSelection(selectedIds)
    }

    DisposableEffect(adapter) {
        onDispose { adapter.cancel() }
    }

    AndroidView(
        factory = { ctx ->
            val initialCols = targetCols(ctx.pxToDp(ctx.resources.displayMetrics.widthPixels), 1)
            decoration.spanCount = initialCols
            val initialRowHeightPx = if (adaptiveRowHeightPx > 0) adaptiveRowHeightPx else {
                val wDp = ctx.pxToDp(ctx.resources.displayMetrics.widthPixels)
                (adaptiveTargetHeightDp(
                    wDp,
                    kotlin.math.max(1, targetCols(wDp, 1)),
                    gapDp,
                    paddingDp,
                ) * density).roundToInt()
            }
            RecyclerView(ctx).apply {
                layoutManager = if (layoutMode == LayoutMode.ADAPTIVE) {
                    createAdaptiveLayoutManager(
                        ctx,
                        initialRowHeightPx,
                        adaptiveTextHeightPx,
                        gapPx,
                        { adapter.isHeaderAt(it) },
                        { adapter.aspectRatioAt(it) },
                    ) {
                        rvHolder.rv?.let { rv ->
                            pinchFlip.reapplyPreview(rv)
                            masonryPinch.reapplyPreview(rv)
                            adaptivePinch.reapplyPreview(rv)
                        }
                    }
                } else {
                    createLayoutManager(
                        layoutMode,
                        ctx,
                        initialCols,
                        gapPx,
                        previewRestorer = {
                            rvHolder.rv?.let {
                                // GRID / MASONRY 各自的控制器在非捏合期都是空操作
                                pinchFlip.reapplyPreview(it)
                                masonryPinch.reapplyPreview(it)
                            }
                        },
                    )
                }
                this.adapter = adapter
                // 见 adapter.PHOTO_POOL_SIZE 的说明：扩容 photo 回收池，吸收预填 strip/重建
                recycledViewPool.setMaxRecycledViews(
                    FileGridAdapter.TYPE_PHOTO,
                    FileGridAdapter.PHOTO_POOL_SIZE,
                )
                // 捏合落档要换全新 LayoutManager（冷启动），旧 LM 的全部 child 会在此刻回收。
                // 默认 mCachedViews 容量只有 2，落档时几乎全部掉进回收池 → 新 LM 逐个重绑 →
                // loadInto 在内存缓存逐出时清空重载，表现为「松手后一些图片刷新一下」。
                // 提到 48（≥ 最大档位一屏的可见数）后，同位置视图经 mCachedViews 复用、
                // 完全不重走 bind；高度正确性由 onViewAttachedToWindow 归一兜底（不走 bind
                // 的复用路径）。
                setItemViewCacheSize(48)
                addItemDecoration(decoration)
                setPadding(paddingPx, paddingPx, paddingPx, paddingPx)
                clipToPadding = false
                // 裁剪双保险：滚出 RV 顶边的内容不得画进标题/chip 行（Compose interop 链路
                // 默认不裁剪）。clipToOutline 的 outline 必须显式给 rect——RV 无背景时
                // BACKGROUND provider 拿到的是 null outline，clipToOutline 不生效。
                clipToOutline = true
                outlineProvider = object : ViewOutlineProvider() {
                    override fun getOutline(view: View, outline: Outline) {
                        outline.setRect(0, 0, view.width, view.height)
                    }
                }
                itemAnimator = null
                isVerticalScrollBarEnabled = false
                rvHolder.rv = this
                // 同时挂两条分发路径，覆盖「第一指落在 item 上」与「落在网格间隙上」两种情况
                val pinch = PinchGridSpanListener(
                    context = ctx,
                    onPinchStart = { _, _ ->
                        // 任何捏合手势都使未决的模式切换收尾 FLIP 过期（见 modeFlipEpoch 的说明）
                        modeFlipEpoch.value++
                        // 进度驱动（跟手）覆盖面：
                        //  - GRID + 无分组：行号公式直接算目标位置；
                        //  - MASONRY：列分配是确定性算法（逐 item 放入最短列），离线模拟目标位置；
                        //  - ADAPTIVE：行装箱是确定性算法（贪心累加成行 + 整行拉伸），离线模拟
                        //    目标档位行划分（含分组标题行）；
                        //  - 分组 GRID：标题占整行走行号公式会错位 → 只做松手换档。
                        when {
                            currentLayoutMode.value == LayoutMode.GRID &&
                                currentGroupBy.value == GroupBy.NONE ->
                                rvHolder.rv?.let { pinchFlip.begin(it, currentGapPx.value) }

                            currentLayoutMode.value == LayoutMode.MASONRY ->
                                rvHolder.rv?.let {
                                    masonryPinch.begin(it, currentGapPx.value)
                                    // 进捏合补一轮预填布局：滚动等增量路径会回收视口下方的预填
                                    // view（无 span 记账的 view 不能参与增量 fill），首次进入
                                    // 瀑布流也还没有预填。不补的话，收拢（列数变多）时可见内容
                                    // 压缩上移、下方没有 item 可插值，底部露出一大段空白直到
                                    // 松手换档。本轮布局会把预览几何洗掉，由 previewRestorer
                                    // 在同一次布局末尾重放，不会闪回原布局。
                                    it.requestLayout()
                                }

                            currentLayoutMode.value == LayoutMode.ADAPTIVE ->
                                rvHolder.rv?.let { adaptivePinch.begin(it, currentGapPx.value) }
                        }
                    },
                    onPinchProgress = { scale, _, _ ->
                        val rv = rvHolder.rv ?: return@PinchGridSpanListener
                        val dir = if (scale >= 1f) 1 else -1
                        val targetLevel = (currentLevel.value + dir).coerceIn(0, 2)
                        // 边界档位（最大/最小）继续缩放：targetLevel 被夹回当前档，目标布局
                        // 与现状完全相同，必须把进度压成 0——否则会产生非零 transform，
                        // 出现「本不该有画面变化却动了一小段」。
                        val progress = if (targetLevel == currentLevel.value) {
                            0f
                        } else {
                            PinchFlipController.progressFor(scale)
                        }
                        // 目标列数必须用 rv 实际宽度算（与 update 里的提交口径一致）。factory 闭包只创建
                        // 一次，直接捕获 containerWidthDp 会拿到首帧的屏宽兜底值——它与 pxToDp(rv.width)
                        // 差一个舍入，导致捏合预览列数与松手提交列数不一致，换档跳位错乱。
                        val widthDp = rv.context.pxToDp(rv.width)
                        when {
                            pinchFlip.isActive -> pinchFlip.update(
                                rv,
                                targetLevel,
                                targetCols(widthDp, targetLevel),
                                progress,
                            )

                            masonryPinch.isActive -> masonryPinch.update(
                                rv,
                                targetLevel,
                                targetCols(widthDp, targetLevel),
                                progress,
                            )

                            adaptivePinch.isActive -> adaptivePinch.update(
                                rv,
                                targetLevel,
                                adaptiveTargetRowHeightPx(widthDp, targetLevel),
                                progress,
                            )
                        }
                    },
                    onPinchEnd = { scale ->
                        val rv = rvHolder.rv ?: return@PinchGridSpanListener
                        // 落档：收尾只跑剩余那段进度，清捏合状态（保留 transform 供换档 FLIP 从当前位置收尾）
                        fun commitFlip(target: Int, progress: Float) {
                            val remaining = 1f - progress
                            flipDurationMs =
                                (FLIP_DURATION_MS * remaining).toLong().coerceAtLeast(80L)
                            // 换档要用同一个锚点（同一屏幕位置）换新布局，先记下再 release。
                            // top 用 commitAnchorTop：列表末端钉在视口边缘时的钳制值，
                            // 与捏合预览的目标几何一致（原样用捏合 top 会被布局拒绝滚动）。
                            when {
                                pinchFlip.isActive -> pendingPinchAnchor.value = PinchAnchor(
                                    pinchFlip.pinchAnchorPos,
                                    pinchFlip.commitAnchorTop,
                                )

                                masonryPinch.isActive -> pendingPinchAnchor.value = PinchAnchor(
                                    masonryPinch.pinchAnchorPos,
                                    masonryPinch.commitAnchorTop,
                                )

                                adaptivePinch.isActive -> pendingPinchAnchor.value = PinchAnchor(
                                    adaptivePinch.pinchAnchorPos,
                                    adaptivePinch.commitAnchorTop,
                                )
                            }
                            pinchFlip.release()
                            masonryPinch.release()
                            adaptivePinch.release()
                            // 落档换布局，未决的模式切换收尾 FLIP 一并作废
                            modeFlipEpoch.value++
                            level = target
                        }
                        when {
                            pinchFlip.isActive -> {
                                val target = pinchFlip.currentTargetLevel
                                // 过半就落到新档位；但若目标档 == 当前档（已在边界），不 commit，退回
                                if (pinchFlip.shouldCommit() && target != currentLevel.value) {
                                    commitFlip(target, pinchFlip.currentProgress)
                                } else {
                                    pinchFlip.settle(rv)
                                }
                            }

                            masonryPinch.isActive -> {
                                val target = masonryPinch.currentTargetLevel
                                if (masonryPinch.shouldCommit() && target != currentLevel.value) {
                                    commitFlip(target, masonryPinch.currentProgress)
                                } else {
                                    masonryPinch.settle(rv)
                                }
                            }

                            adaptivePinch.isActive -> {
                                val target = adaptivePinch.currentTargetLevel
                                if (adaptivePinch.shouldCommit() && target != currentLevel.value) {
                                    commitFlip(target, adaptivePinch.currentProgress)
                                } else {
                                    adaptivePinch.settle(rv)
                                }
                            }

                            else -> {
                                // 分组 GRID：捏合过阈值直接换一档
                                val delta = when {
                                    scale > PinchFlipController.STEP_THRESHOLD -> 1
                                    scale < 1f / PinchFlipController.STEP_THRESHOLD -> -1
                                    else -> 0
                                }
                                val target = currentLevel.value + delta
                                if (delta != 0 && target in 0..2) {
                                    modeFlipEpoch.value++
                                    level = target
                                }
                            }
                        }
                    },
                )
                setOnTouchListener(pinch)
                addOnItemTouchListener(pinch)
                pinch.debugAttachRv(this)
            }
        },
        update = { rv ->
            if (rv.width <= 0) return@AndroidView
            val widthDp = rv.context.pxToDp(rv.width)
            if (measuredWidthDp != widthDp) measuredWidthDp = widthDp
            val span = targetCols(widthDp, level)

            // 模式切换共用的 LM 构建 + 锚点寄存：scrollToPositionWithOffset 在该 LM 的
            // 首次布局生效，因此换完 LM 的那一刻滚动位置就已锁定，不依赖任何延迟回调
            //（旧实现把锚点定位放进 afterStableLayout 的 doOnLayout 链，回调可能挂起到
            // 很久以后才触发——期间视图停在粗定位甚至原点，表现为「切视图滚回顶部」）。
            fun buildModeLm(target: LayoutMode, anchorIdx: Int, anchorTop: Int): RecyclerView.LayoutManager {
                val restorer = {
                    pinchFlip.reapplyPreview(rv)
                    masonryPinch.reapplyPreview(rv)
                    adaptivePinch.reapplyPreview(rv)
                }
                return if (target == LayoutMode.ADAPTIVE) {
                    val rowH = if (adaptiveRowHeightPx > 0) adaptiveRowHeightPx else {
                        (adaptiveTargetHeightDp(
                            widthDp,
                            kotlin.math.max(1, span),
                            gapDp,
                            paddingDp,
                        ) * density).roundToInt()
                    }
                    createAdaptiveLayoutManager(
                        rv.context,
                        rowH,
                        adaptiveTextHeightPx,
                        gapPx,
                        { adapter.isHeaderAt(it) },
                        { adapter.aspectRatioAt(it) },
                        previewRestorer = restorer,
                    ).also { lm ->
                        // offset 语义（AuroraAdaptiveLayoutManager）：锚点视图 top 的视口坐标
                        if (anchorIdx != RecyclerView.NO_POSITION) {
                            lm.scrollToPositionWithOffset(anchorIdx, anchorTop)
                        }
                    }
                } else {
                    createLayoutManager(
                        target,
                        rv.context,
                        span,
                        gapPx,
                        isFullSpanAt = { adapter.isHeaderAt(it) },
                        previewRestorer = restorer,
                    ).also { lm ->
                        // Grid/Staggered：offset = 锚点 decorated top − 顶 inset − paddingTop
                        //（与 animateSpanChange/animateStaggeredSpanChange 的粗定位同式，
                        // 滚动钳制的残差由收尾 FLIP 的 scrollBy 修正）。
                        if (anchorIdx != RecyclerView.NO_POSITION) when (lm) {
                            is GridLayoutManager -> lm.scrollToPositionWithOffset(
                                anchorIdx,
                                anchorTop - (if (anchorIdx / span > 0) gapPx else 0) - rv.paddingTop,
                            )

                            is StaggeredGridLayoutManager -> lm.scrollToPositionWithOffset(
                                anchorIdx,
                                anchorTop - (if (anchorIdx >= span) gapPx else 0) - rv.paddingTop,
                            )
                        }
                    }
                }
            }

            // 布局模式切换：捕获 FLIP 快照 → 同步换 LayoutManager（含锚点寄存）+ 提交新数据
            // → 确定性收尾动画。必须同步提交：只换 LM 而数据还是旧 item 的话，会出现
            // 「新 LM + 旧数据」的中间帧（例如 adaptive 的行划分没跟上，整屏排布错乱）。
            if (appliedMode != layoutMode) {
                val snapshot = captureModeSwitch(rv, adapter)
                val mode = layoutMode
                appliedMode = mode
                // 本轮快照的有效代纪：此后任何捏合/落档/数据变化都会使其过期
                val myEpoch = ++modeFlipEpoch.value
                val anchorIdx = snapshot.anchorId?.let { adapter.indexOfImage(it) }
                    ?: RecyclerView.NO_POSITION
                val newLm = buildModeLm(mode, anchorIdx, snapshot.anchorTop.roundToInt())
                rv.layoutManager = newLm
                adapter.submit(items, selectedIds, mode, gapPx, collapsedIds)

                // 收尾 FLIP：等新模式的首次布局刷出来，把每张可见图从旧屏幕位置滑到新位置
                //（与 React 版一致：只动 translation，240ms / cubic-bezier(0.22,1,0.36,1)）。
                // runFlipWhenLayoutApplied 是 OnPreDraw 驱动 + 有限重试，不会像 doOnLayout
                // 链那样无限期挂起；即便因快照过期被跳过，位置也已由锚点寄存保住，只损失动画。
                runFlipWhenLayoutApplied(
                    rv,
                    FlipSnapshot(anchorIdx, snapshot.anchorTop.roundToInt(), 0, emptyMap(), emptyMap(), emptyMap()),
                    "FLIP-ModeSwitch",
                    0,
                    layoutApplied = { it.layoutManager === newLm && it.childCount > 0 },
                ) {
                    // 布局期间可能又被切走，snapshot 已失效，放弃
                    if (appliedMode != mode) return@runFlipWhenLayoutApplied
                    // 快照过期（此后发生过捏合/落档/数据变化）也放弃；位置已由锚点寄存保住
                    if (modeFlipEpoch.value != myEpoch) return@runFlipWhenLayoutApplied
                    applyModeSwitchFlip(rv, adapter, snapshot)
                }
            } else if (!matchesMode(rv.layoutManager, layoutMode)) {
                // 一致性兜底：appliedMode 已一致但 LM 类型不符。同样要寄存锚点，否则换 LM
                // 会丢滚动位置（「切视图回到顶部」的另一个来源）。
                val anchor = captureModeSwitch(rv, adapter)
                val anchorIdx = anchor.anchorId?.let { adapter.indexOfImage(it) }
                    ?: RecyclerView.NO_POSITION
                rv.layoutManager = buildModeLm(layoutMode, anchorIdx, anchor.anchorTop.roundToInt())
            }

            when (val lm = rv.layoutManager) {
                is GridLayoutManager -> {
                    // 分组标题占满整行；每次重建以清掉 SpanSizeLookup 的内部缓存
                    lm.spanSizeLookup = object : GridLayoutManager.SpanSizeLookup() {
                        override fun getSpanSize(position: Int): Int =
                            if (adapter.isHeaderAt(position)) lm.spanCount else 1
                    }
                    if (span != lm.spanCount) {
                        val anchor = pendingPinchAnchor.value
                        pendingPinchAnchor.value = null
                        animateSpanChange(rv, lm, decoration, span, flipDurationMs, pinchAnchor = anchor)
                        flipDurationMs = FLIP_DURATION_MS
                    }
                }

                is StaggeredGridLayoutManager -> {
                    if (span != lm.spanCount) {
                        val anchor = pendingPinchAnchor.value
                        pendingPinchAnchor.value = null
                        // 冷启动换档（换全新 LM）：真实布局与捏合预览的模拟逐位一致，
                        // FLIP 收尾就是最终布局，不再有「松手后再跳一下」。
                        animateStaggeredSpanChange(
                            rv,
                            lm,
                            decoration,
                            span,
                            flipDurationMs,
                            isFullSpanAt = { adapter.isHeaderAt(it) },
                            gapPx = currentGapPx.value,
                            pinchAnchor = anchor,
                            previewRestorer = { masonryPinch.reapplyPreview(rv) },
                        )
                        flipDurationMs = FLIP_DURATION_MS
                    }
                }

                is AuroraAdaptiveLayoutManager -> {
                    // adaptive 落档：行高变化即换全新 LM 冷启动（与瀑布流同构），真实布局与
                    // 捏合预览共用 packAdaptiveRowAt 一份数学，FLIP 收尾零跳变。
                    val wantRowHeight = (adaptiveTargetHeightDp(
                        widthDp,
                        kotlin.math.max(1, span),
                        gapDp,
                        paddingDp,
                    ) * density).roundToInt()
                    if (wantRowHeight > 0 && lm.rowHeightPx != wantRowHeight) {
                        val anchor = pendingPinchAnchor.value
                        pendingPinchAnchor.value = null
                        animateAdaptiveRowChange(
                            rv,
                            lm,
                            wantRowHeight,
                            adaptiveTextHeightPx,
                            gapPx,
                            { adapter.aspectRatioAt(it) },
                            { adapter.isHeaderAt(it) },
                            flipDurationMs,
                            pinchAnchor = anchor,
                            previewRestorer = { adaptivePinch.reapplyPreview(rv) },
                        )
                        flipDurationMs = FLIP_DURATION_MS
                    }
                }

                else -> Unit
            }

            // 网格/瀑布流按列铺（span=列数），adaptive 行装箱按整宽（span=1，行间距由
            // decoration 的顶 inset 提供）。
            // 赋值 spanCount 不会自动生效，必须配 invalidateItemDecorations——
            // 否则模式切换后间距仍按旧列数算（换档时 animateXxx 内部已经做了，这里补模式切换的情况）。
            val wantSpan = if (layoutMode == LayoutMode.ADAPTIVE) 1 else span
            if (decoration.spanCount != wantSpan) {
                decoration.spanCount = wantSpan
                rv.invalidateItemDecorations()
            }

            // 网格（正方形）/瀑布流（按宽高比）用单元格宽度推导封面高度；adaptive 用行高。
            // 走 applyCellWidth（不 notify）而非 submit——见 LaunchedEffect 处的说明。
            val inner = rv.width - rv.paddingLeft - rv.paddingRight
            val cell = if (layoutMode == LayoutMode.ADAPTIVE) 0
                else ((inner - (span - 1) * gapPx) / span).coerceAtLeast(1)
            adapter.applyCellWidth(rv, cell)
            if (layoutMode == LayoutMode.ADAPTIVE && adaptiveRowHeightPx > 0) {
                adapter.applyRowHeight(adaptiveRowHeightPx)
            }

            // sticky 分组标题
            val needSticky = groupBy != GroupBy.NONE
            if (needSticky && stickyDecoration == null) {
                var refs: HeaderRefs? = null
                val d = StickyHeaderDecoration(
                    headerPositions = { adapter.headerPositions },
                    createHeader = {
                        buildHeaderView(
                            rv.context,
                            colors.textPrimary.toArgb(),
                            colors.textSecondary.toArgb(),
                        ).also { refs = it }.root
                    },
                    bindHeader = { _, position ->
                        val item = adapter.itemAt(position) as? GridItem.Header
                        if (item != null) {
                            refs?.apply {
                                title.text = item.title
                                count.text = "${item.count}"
                                arrow.text = if (item.id in currentCollapsed.value) "▸" else "▾"
                            }
                        }
                    },
                    headerHeightPx = rv.context.dp(HEADER_HEIGHT_DP),
                )
                rv.addItemDecoration(d)
                stickyDecoration = d
            } else if (!needSticky && stickyDecoration != null) {
                stickyDecoration?.let { rv.removeItemDecoration(it) }
                stickyDecoration = null
            }
        },
        modifier = modifier.clipToBounds(),
    )
}

/**
 * 会在视口之外**多布局一些 item** 的 GridLayoutManager。
 *
 * 为什么需要：捏合缩小（列数变多、卡片变小）时，视口需要**更多** item 才填得满；但捏合期间
 * 我们不触发布局（新档位的位置是算出来的、靠 transform 呈现），RV 不会去补充 item，
 * 于是底部露出空白。让 LM 多布局一些就能补上。
 *
 * 量取**单次捏合的最大档位差（一档）**估算：一次手势只跨一档（如 4→6 或 6→9 列），
 * 卡片高度缩到约一半、列数增加一半，二者相乘 ≈ 2.2 倍的内容压缩，底部需约 1.2 屏才够，
 * 给 1.5 屏留余量；顶部只在放大时被「挤」上去，不需要额外空间，1/3 屏足够普通回滚预加载。
 * 代价是多布局几十个 view，换来的是捏合全程无露白。
 */
internal class AuroraGridLayoutManager(
    context: android.content.Context,
    spanCount: Int,
) : GridLayoutManager(context, spanCount) {

    /** 每轮布局完成后的回调：GRID 捏合预览（真实 measure/layout）被布局洗掉时重放，
     *  与 AuroraStaggeredLayoutManager 的 previewRestorer 对称。非捏合期为空操作。 */
    var previewRestorer: (() -> Unit)? = null

    override fun calculateExtraLayoutSpace(
        state: RecyclerView.State,
        extraLayoutSpace: IntArray,
    ) {
        extraLayoutSpace[0] = height / 3
        extraLayoutSpace[1] = height * 3 / 2
    }

    override fun onLayoutChildren(
        recycler: RecyclerView.Recycler,
        state: RecyclerView.State,
    ) {
        super.onLayoutChildren(recycler, state)
        previewRestorer?.invoke()
    }
}

private fun createLayoutManager(
    mode: LayoutMode,
    context: android.content.Context,
    spanCount: Int,
    gapPx: Int,
    isFullSpanAt: (Int) -> Boolean = { false },
    previewRestorer: (() -> Unit)? = null,
): RecyclerView.LayoutManager = when (mode) {
    LayoutMode.MASONRY -> AuroraStaggeredLayoutManager(spanCount, isFullSpanAt, gapPx).apply {
        this.previewRestorer = previewRestorer
    }
    else -> AuroraGridLayoutManager(context, spanCount).apply {
        this.previewRestorer = previewRestorer
    }
}

/**
 * 自适应视图的布局管理器。textHeightPx 是与 buildPhotoView 的 name 视图同参数离线
 * 测出的文字区高度（见 FileGrid 的 adaptiveTextHeightPx），行推进依赖它，必须与真实
 * 渲染逐位一致。
 */
private fun createAdaptiveLayoutManager(
    context: android.content.Context,
    rowHeightPx: Int,
    textHeightPx: Int,
    gapPx: Int,
    isFullSpanAt: (Int) -> Boolean,
    ratioAt: (Int) -> Float,
    previewRestorer: (() -> Unit)? = null,
): AuroraAdaptiveLayoutManager = AuroraAdaptiveLayoutManager(
    rowHeightPx = rowHeightPx.coerceAtLeast(1),
    textHeightPx = textHeightPx,
    headerHeightPx = context.dp(HEADER_HEIGHT_DP),
    ratioAt = ratioAt,
    isHeaderAt = isFullSpanAt,
    gapPx = gapPx,
    previewRestorer = previewRestorer,
)

/**
 * 视口下方**常驻多布局一些 item** 的 StaggeredGridLayoutManager（与 [AuroraGridLayoutManager] 对称）。
 *
 * 为什么需要：瀑布流捏合缩小（列数变多）时内容压缩约一倍，捏合预览是把可见内容往新档位
 * 位置插值——若布局没有预填，下方会露出大片空白。GRID 版靠
 * `LinearLayoutManager.calculateExtraLayoutSpace`（底部 1.5 屏）解决；但 StaggeredGridLayoutManager
 * **没有这个 hook**（1.3.2 不含该方法），只能在布局完成后手动补：每轮 `onLayoutChildren` 末尾
 * 按与 Staggered 一致的「按 position 顺序放入最短列」规则把下方 1.5 屏补建出来。
 *
 * **预填 view 的识别与回收必须用「`LayoutParams.mSpan == null`」这个结构不变量，不能用 view
 * tag**：预填 view 经 `addView` 挂上、从不参与 span 记账，`mSpan` 恒为 null；而 Staggered 的
 * `fill()` 会在 `addView` 前给每个自己铺的 child 赋 `mSpan`（1.3.2 fill 第 1600 行），所以已挂载
 * child 中 `mSpan == null` ⟺ 预填 view。早期版本用 view tag 识别，但 tag 会经由「换 LM 冷启动」
 * 等非本类回收路径残留在 view 上——新 LM 的正常 fill 从 mCachedViews 复用它时**不重走 bind**、
 * 没人清 tag，它就成了「带预填标记的真实记账 child」；strip 时被误删且绕过 `Span.popStart()`，
 * span 的 mViews 留下幽灵条目，滚动 fill/recycle 记账错位后在 `recycleFromStart` 处 NPE
 *（`lp.mSpan.mViews` 空指针）。每轮布局都预填后该窗口必现，故弃用 tag。
 *
 * 任何增量路径（滚动 fill / 重新布局）开始前先回收预填 view（[stripPrefilled]）：增量 fill 按
 * span 列线再铺同一批 position 会叠出重影——这正是「瀑布流下半屏重叠」的来源。回收前经
 * [StaggeredSpanAccess.clearSpan]（[prefillBelow] 复用时也会）把上一条生命周期残留的 span
 * 引用清空，保证复用态干净。
 *
 * 例外是 `onScrollStateChanged(IDLE)`：stock 会在这里走 `checkForGaps → hasGapsToFix`，
 * 逐 child 解引用 `mSpan`，但该回调拿不到 Recycler、无法先 strip——见下方重写，有预填
 * child 挂载时直接跳过这次检查（1.3.2 中这是布局外进入 gap 检查的唯一入口）。

 *
 * [previewRestorer] 在预填之后回调：捏合预览是手动 measure/layout 改写 child 几何，本轮布局
 * （含补预填触发的那轮）会把它洗掉，回调里按当前进度重放，预览才不会闪回原布局一帧。
 */
internal class AuroraStaggeredLayoutManager(
    spanCount: Int,
    /** pos 是否为满宽 header（分组标题）。预填时它必须占满整行。 */
    private val isFullSpanAt: (Int) -> Boolean,
    /** 单元格间距（px）。预填的测量与链式记账要与 GridSpacingDecoration 完全一致。 */
    private val gapPx: Int,
    /** 每轮布局（含预填）完成后的回调；非捏合期为空操作，见 [MasonryPinchController.reapplyPreview]。 */
    var previewRestorer: (() -> Unit)? = null,
) : StaggeredGridLayoutManager(spanCount, StaggeredGridLayoutManager.VERTICAL) {

    override fun onLayoutChildren(
        recycler: RecyclerView.Recycler,
        state: RecyclerView.State,
    ) {
        stripPrefilled(recycler)
        super.onLayoutChildren(recycler, state)
        prefillBelow(recycler, state.itemCount)
        previewRestorer?.invoke()
    }

    override fun scrollVerticallyBy(
        dy: Int,
        recycler: RecyclerView.Recycler,
        state: RecyclerView.State,
    ): Int {
        stripPrefilled(recycler)
        return super.scrollVerticallyBy(dy, recycler, state)
    }

    /**
     * stock 在滚动状态变 IDLE 时走 `checkForGaps → hasGapsToFix`，逐个 child 读
     * `lp.mSpan.mIndex`（1.3.2 无判空）。预填 view（`mSpan == null`）在两轮布局/滚动之间
     * 常驻挂载，拖拽松手、停 fling、cancelTouch 等任何一次 IDLE 转换都会踩空 NPE 崩溃。
     * 有预填 child 挂载时跳过本次检查（此回调拿不到 Recycler，无法就地回收）：
     *  - 布局期 gap 检查在 `super.onLayoutChildren` 尾部、`prefillBelow` 之前运行，
     *    当时所有 child 都有 span 记账，gap 修复能力不受影响；
     *  - 滚动期 `scrollVerticallyBy` 已先 strip，无预填时 super 照常检查。
     */
    override fun onScrollStateChanged(state: Int) {
        if (state == RecyclerView.SCROLL_STATE_IDLE && hasPrefilledChild()) return
        super.onScrollStateChanged(state)
    }

    private fun hasPrefilledChild(): Boolean {
        for (i in 0 until childCount) {
            val c = getChildAt(i) ?: continue
            if (isPrefilled(c)) return true
        }
        return false
    }

    /**
     * 是否为预填 view：Staggered LayoutParams 且未参与 span 记账。见类 KDoc 的不变量说明。
     * 非 Staggered LayoutParams（如模式切换后池里的 GRID view）不在此列。
     */
    private fun isPrefilled(child: View): Boolean {
        val lp = child.layoutParams as? StaggeredGridLayoutManager.LayoutParams ?: return false
        return StaggeredSpanAccess.isSpanUnassigned(lp)
    }

    private fun stripPrefilled(recycler: RecyclerView.Recycler) {
        for (i in childCount - 1 downTo 0) {
            val c = getChildAt(i) ?: continue
            if (isPrefilled(c)) {
                removeAndRecycleView(c, recycler)
            }
        }
    }

    /** 按最短列优先把视口下方 1.5 屏的 item 补建出来（与 Staggered 分配规则一致）。 */
    private fun prefillBelow(recycler: RecyclerView.Recycler, itemCount: Int) {
        if (childCount == 0 || itemCount <= 0) return
        val span = spanCount
        val inner = width - paddingLeft - paddingRight
        if (inner <= 0) return
        // 与 updateMeasureSpecs 的 mSizePerSpan 一致（整数除法）
        val sizePerSpan = inner / span

        // 各列 decorated 底边（放置线）。满宽 header 之后各列底边一致。
        val colEnd = IntArray(span) { Int.MIN_VALUE }
        var maxPos = -1
        for (i in 0 until childCount) {
            val c = getChildAt(i) ?: continue
            val pos = getPosition(c)
            if (pos == RecyclerView.NO_POSITION) continue
            if (pos > maxPos) maxPos = pos
            val lp = c.layoutParams as? LayoutParams
            if (lp?.isFullSpan == true || isFullSpanAt(pos)) {
                for (s in 0 until span) colEnd[s] = maxOf(colEnd[s], getDecoratedBottom(c))
            } else {
                // 列号必须用 spanIndex（与 GridSpacingDecoration 一致），decorated left 不唯一
                val col = lp?.spanIndex ?: -1
                if (col in 0 until span) colEnd[col] = maxOf(colEnd[col], getDecoratedBottom(c))
            }
        }
        if (maxPos < 0) return
        // 个别列当前没有可见 child 时以最小列底边兜底，保证该列继续向下铺而不是空着
        var minEnd = Int.MAX_VALUE
        for (s in 0 until span) minEnd = minOf(minEnd, colEnd[s])
        if (minEnd == Int.MAX_VALUE || minEnd == Int.MIN_VALUE) return
        for (s in 0 until span) if (colEnd[s] == Int.MIN_VALUE) colEnd[s] = minEnd

        val limit = colEnd.max() + height * 3 / 2
        var pos = maxPos + 1
        while (pos < itemCount) {
            var best = 0
            for (s in 1 until span) if (colEnd[s] < colEnd[best]) best = s
            if (colEnd[best] > limit) break
            val v = try {
                recycler.getViewForPosition(pos)
            } catch (e: Exception) {
                return
            }
            // 复用的 view 可能带着上一条生命周期的 span 引用（换 LM 冷启动的整批回收不走
            // popStart），不清掉的话它同时「看起来已记账」（mSpan 非 null、不被 strip 识别）
            // 又「实际不在任何 span 的 mViews 里」——增量 fill 再铺同一 position 会叠出重影。
            // 清空后它满足「mSpan == null ⟺ 预填 view」的不变量，后续 strip 才能正确回收。
            val lp = v.layoutParams as? StaggeredGridLayoutManager.LayoutParams
            if (lp != null) StaggeredSpanAccess.clearSpan(lp)
            // decoration inset 必须先算（layoutDecoratedWithMargins 会按它定位）
            calculateItemDecorationsForChild(v, Rect())
            if (isFullSpanAt(pos)) {
                addView(v)
                // header 无 inset：内容宽 = inner
                measureChildWithMargins(v, 0, 0)
                val line = colEnd.max()
                layoutDecoratedWithMargins(
                    v, paddingLeft, line,
                    paddingLeft + inner, line + v.measuredHeight,
                )
                for (s in 0 until span) colEnd[s] = line + v.measuredHeight
            } else {
                val leftInset = gapPx * best / span
                val rightInset = gapPx * (span - 1 - best) / span
                val topInset = if (pos >= span) gapPx else 0
                addView(v)
                // 与 Staggered 的 measureChildWithDecorationsAndMargin 对齐：
                // 内容宽 = sizePerSpan - 左右 inset（widthUsed 把差额从总宽里扣掉）。
                // 直接用默认 spec 会量成全宽，预填卡片互相压边（「下半屏重叠」的来源之一）。
                measureChildWithMargins(v, inner - (sizePerSpan - leftInset - rightInset), 0)
                val line = colEnd[best]
                layoutDecoratedWithMargins(
                    v, paddingLeft + best * sizePerSpan, line,
                    paddingLeft + (best + 1) * sizePerSpan, line + topInset + v.measuredHeight,
                )
                colEnd[best] = line + topInset + v.measuredHeight
            }
            pos++
        }
    }
}

private fun matchesMode(lm: RecyclerView.LayoutManager?, mode: LayoutMode): Boolean = when (mode) {
    LayoutMode.MASONRY -> lm is StaggeredGridLayoutManager
    LayoutMode.ADAPTIVE -> lm is AuroraAdaptiveLayoutManager
    else -> lm is GridLayoutManager
}

/** 视图切换的 FLIP 快照：锚点图 + 每张可见图的屏幕位置。 */
private class ModeSwitchSnapshot(
    val anchorId: String?,
    val anchorTop: Float,
    val positions: Map<String, Pair<Float, Float>>,
)

/**
 * 捕获切换前每张可见图的屏幕位置与锚点。锚点语义对齐 React 版 `FileGrid.tsx` 的 FLIP：
 *  A. 视口顶边落在哪张图里（top ≤ 0 < bottom，取 top 最大者）——优先，切换后它停在原
 *     屏幕位置（哪怕半露出）；
 *  B. 顶边落在 padding/间隙里 → 取顶边下方第一张图（top ≥ 0 中最小者）。
 * 旧实现取「top 最小的可见图」：在列表深处它往往是一条几乎完全滚出视口顶的行，把它
 * 钉回原屏幕位置需要锚点定位的钳制补偿，切视图的观感就是「内容被大幅拖走」。
 * 位置带当前 translation，连续快速切换时不会跳。
 */
private fun captureModeSwitch(
    rv: RecyclerView,
    adapter: FileGridAdapter,
): ModeSwitchSnapshot {
    var straddleId: String? = null
    var straddleTop = Int.MIN_VALUE
    var belowId: String? = null
    var belowTop = Int.MAX_VALUE
    val positions = HashMap<String, Pair<Float, Float>>()
    adapter.forEachVisibleImage(rv, withTranslation = true) { id, view, left, top ->
        positions[id] = left to top
        val t = top.roundToInt()
        if (t <= 0 && view.bottom > 0 && t > straddleTop) {
            straddleTop = t
            straddleId = id
        }
        if (t > 0 && t < belowTop) {
            belowTop = t
            belowId = id
        }
    }
    return when {
        straddleId != null -> ModeSwitchSnapshot(straddleId, straddleTop.toFloat(), positions)
        belowId != null -> ModeSwitchSnapshot(belowId, belowTop.toFloat(), positions)
        else -> ModeSwitchSnapshot(null, 0f, positions)
    }
}

/**
 * 视图切换的收尾 FLIP。调用时机 = 新模式的首次布局已刷出（update 的模式切换分支经
 * `runFlipWhenLayoutApplied` 驱动，确定性触发）；锚点已在换 LM 的同帧经
 * scrollToPositionWithOffset 寄存、首次布局即落在原屏幕位置。这里只做两件事：
 *  1. 锚点残差修正：只有滚动钳制（列表端放不下目标位置）会留残差，scrollBy 尽力贴回
 *    （被滚动边界拒绝时保持钳制位置，位移不作补偿——那是物理上到不了的位置）；
 *  2. 二维 FLIP：每张可见图从「切换前的屏幕位置（含进行中的动画位移）」滑到新布局位置。
 * 与 React 版一致：只动 translation（卡片以新尺寸出现、滑入位），240ms /
 * `PathInterpolator(0.22,1,0.36,1)`。
 */
private fun applyModeSwitchFlip(
    rv: RecyclerView,
    adapter: FileGridAdapter,
    snap: ModeSwitchSnapshot,
) {
    val views = HashMap<String, View>()
    adapter.forEachVisibleImage(rv, withTranslation = false) { id, view, _, _ ->
        views[id] = view
    }

    // 1. 锚点残差修正。scrollBy 会同步把所有 child 的 top 平移，之后的 FLIP 位移
    //    必须按平移后的位置重新收集，不能拿平移前的位置做换算。
    val anchorView = snap.anchorId?.let { views[it] }
    if (anchorView != null) {
        val drift = anchorView.top - snap.anchorTop.roundToInt()
        if (drift != 0) rv.scrollBy(0, drift)
    }

    // 2. 收集新位置（scrollBy 之后）
    val newPos = HashMap<String, Pair<Float, Float>>()
    adapter.forEachVisibleImage(rv, withTranslation = false) { id, view, left, top ->
        views[id] = view
        newPos[id] = left to top
    }

    // 3. Invert + Play
    for ((id, old) in snap.positions) {
        val view = views[id]
        val new = newPos[id]
        if (view == null || new == null) continue
        val dx = old.first - new.first
        val dy = old.second - new.second
        if (abs(dx) < 1f && abs(dy) < 1f) continue
        view.animate().cancel()
        view.translationX = dx
        view.translationY = dy
        view.animate()
            .translationX(0f)
            .translationY(0f)
            .setDuration(FLIP_DURATION_MS)
            .setInterpolator(FLIP_INTERPOLATOR)
            .start()
    }
}

private class FileGridAdapter(
    private val loader: ThumbnailLoader,
    private val surfaceColor: Int,
    private val textPrimaryColor: Int,
    private val textSecondaryColor: Int,
    private val primaryColor: Int,
    private val onClick: (Image) -> Unit,
    private val onToggleGroup: (String) -> Unit,
) : RecyclerView.Adapter<RecyclerView.ViewHolder>() {

    private val items = mutableListOf<GridItem>()
    private var selectedIds: Set<String> = emptySet()
    private var layoutMode: LayoutMode = LayoutMode.GRID
    private var cellWidthPx: Int = 0

    /** adaptive 档位的目标行高 px（不含文件名文字区）；bind 写封面 lp 高度用。 */
    private var rowHeightPx: Int = 0
    private var gapPx: Int = 0
    private var collapsedIds: Set<String> = emptySet()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    /** 进度驱动 FLIP 控制器；捏合中新绑定的 item 需要补上当前进度的 transform。 */
    var pinchFlip: PinchFlipController? = null

    /** 瀑布流的进度驱动 FLIP 控制器（与 [pinchFlip] 对称）。 */
    var masonryPinch: MasonryPinchController? = null

    /** 自适应视图的进度驱动 FLIP 控制器（与 [masonryPinch] 对称）。 */
    var adaptivePinch: AdaptivePinchController? = null

    /** 所有分组标题的位置（升序），供 sticky 标题二分查找。 */
    var headerPositions: List<Int> = emptyList()
        private set

    companion object {
        internal const val TYPE_HEADER = 0
        internal const val TYPE_PHOTO = 1

        /** photo 回收池容量：瀑布流预填约 1.5 屏（最小档 9 列时 ~80 个），strip/重建
         *  一次性回收量远超默认池（每类型 5），不够时重建全靠 onCreateViewHolder
         *  重新 inflate——重布局风暴里最贵的一环。 */
        internal const val PHOTO_POOL_SIZE = 160

        /** 局部刷新 payload：只更新封面高度，不重新 bind（不重载图片、不动 FLIP transform）。 */
        private const val PAYLOAD_CELL = "cell"
    }

    /**
     * 提交数据，返回是否真的发生变化——**无变化时不刷新**。
     *
     * 幂等守卫是视图切换 FLIP 的前提：切换时会在 `rv.post` 里同步提交一次并立刻启动动画，
     * 随后 `LaunchedEffect` 又会以相同参数提交一次。若这第二次刷新不被挡住，会给所有 item
     * 重新 bind，`resetFlipTransform` 会把动画的初始位移抹掉——动画直接消失。
     */
    fun submit(
        list: List<GridItem>,
        selection: Set<String>,
        mode: LayoutMode,
        gap: Int,
        collapsed: Set<String>,
    ): Boolean {
        val unchanged = items == list && selectedIds == selection && layoutMode == mode &&
            gapPx == gap && collapsedIds == collapsed
        if (unchanged) return false

        items.clear()
        items.addAll(list)
        selectedIds = selection
        layoutMode = mode
        gapPx = gap
        collapsedIds = collapsed
        headerPositions = items.mapIndexedNotNull { i, it -> if (it is GridItem.Header) i else null }
        notifyDataSetChanged()
        return true
    }

    /**
     * 更新单元格宽度，**只改可见 item 的封面高度，绝不 notifyDataSetChanged**。
     *
     * 这是 FLIP 能跑起来的关键：换档必然伴随列宽变化，若列宽变化走
     * `notifyDataSetChanged`，所有 item 会重新 bind，`resetFlipTransform` 恰好把刚设好的
     * 初始位移抹掉——表现就是「换档完全没有动画，直接硬切」。
     * 新 fill 进来的 item 在 bind 时自然会用到新值，无需刷新已有 item。
     */
    fun applyCellWidth(rv: RecyclerView, cellPx: Int) {        // adaptive 模式用不到列宽（行内宽度由行化结果给出）。这里必须**保留上一次的值**
        // 而不是置 0——否则切回 GRID/MASONRY 时会被误判成「首次量出宽度」而走全量刷新，
        // 把视图切换的 FLIP 打断。
        if (cellPx <= 0) return
        if (cellWidthPx == cellPx) return
        val wasZero = cellWidthPx <= 0
        cellWidthPx = cellPx
        if (wasZero) {
            // 从「未量出宽度」变为有宽度：已有 item 的封面高度还是默认的，必须全量刷新一次
            notifyDataSetChanged()
            return
        }
        // 用带 payload 的局部刷新把可见 item 的封面高度可靠地刷成新值。
        // 不能直接改 layoutParams + requestLayout：update 落在 layout 阶段时 requestLayout 会被 RV 吞掉，
        // 导致旧 item 的封面还停在上一档高度（缩小后出现横屏/竖屏长条，滚走再滚回才恢复）。
        notifyItemRangeChanged(0, items.size, PAYLOAD_CELL)
    }

    /**
     * adaptive 行高同步（不 notify 结构、只 payload 刷封面高度）。
     * 行划分由 [AuroraAdaptiveLayoutManager] 负责，这个值只供 bind 写封面 lp 高度；
     * 走 payload 而非 requestLayout 的理由与 [applyCellWidth] 相同。
     */
    fun applyRowHeight(rowHeight: Int) {
        if (rowHeight <= 0 || rowHeightPx == rowHeight) return
        rowHeightPx = rowHeight
        notifyItemRangeChanged(0, items.size, PAYLOAD_CELL)
    }

    /** 封面高度：瀑布流按宽高比，网格用正方形，adaptive 用行高。 */
    private fun coverHeightFor(image: Image): Int = when (layoutMode) {
        LayoutMode.MASONRY -> (cellWidthPx / aspectRatioOf(image)).toInt()
        LayoutMode.ADAPTIVE -> rowHeightPx
        else -> cellWidthPx
    }

    /**
     * 遍历当前可见的每一张图（三种模式一图一项）。
     *
     * @param block 参数依次为：图片 id、承载该图的 view（FLIP 的作用对象）、RV 坐标系下的 left / top
     */
    fun forEachVisibleImage(
        rv: RecyclerView,
        withTranslation: Boolean,
        block: (String, View, Float, Float) -> Unit,
    ) {
        for (i in 0 until rv.childCount) {
            val child = rv.getChildAt(i)
            val pos = rv.getChildAdapterPosition(child)
            if (pos == RecyclerView.NO_POSITION) continue
            val tx = if (withTranslation) child.translationX else 0f
            val ty = if (withTranslation) child.translationY else 0f
            // 三种模式一图一项，可见图 = PhotoVH
            val holder = rv.getChildViewHolder(child)
            if (holder is PhotoVH) {
                val image = (items.getOrNull(pos) as? GridItem.Photo)?.image ?: continue
                block(image.id, child, child.left + tx, child.top + ty)
            }
        }
    }

    fun updateSelection(selection: Set<String>) {
        val old = selectedIds
        selectedIds = selection
        val changed = mutableListOf<Int>()
        for (i in items.indices) {
            val item = items[i] as? GridItem.Photo ?: continue
            val id = item.image.id
            if ((id in old) != (id in selection)) changed.add(i)
        }
        changed.forEach { notifyItemChanged(it) }
    }

    fun cancel() = scope.cancel()

    fun itemAt(position: Int): GridItem? = items.getOrNull(position)

    fun isHeaderAt(position: Int): Boolean = items.getOrNull(position) is GridItem.Header

    /** pos → 图片宽高比（瀑布流跟手预览的模拟输入）；越界 / 非 Photo 返回 1f。 */
    fun aspectRatioAt(position: Int): Float =
        (items.getOrNull(position) as? GridItem.Photo)?.image?.let { aspectRatioOf(it) } ?: 1f

    /**
     * 返回该图片所在的 item 下标（抹平 Photo 与 adaptive 行两种 item）。
     *
     * 用于视图切换时把锚点图重新滚进视口——换 LayoutManager 会丢掉滚动位置，
     * 不补这一步的话新旧两屏图片可能完全没有交集，FLIP 会一个都匹配不上。
     */
    fun indexOfImage(id: String): Int {
        for (i in items.indices) {
            val it = items[i]
            if (it is GridItem.Photo && it.image.id == id) return i
        }
        return RecyclerView.NO_POSITION
    }

    override fun getItemCount(): Int = items.size

    override fun getItemViewType(position: Int): Int =
        if (items[position] is GridItem.Header) TYPE_HEADER else TYPE_PHOTO

    private class PhotoVH(val refs: PhotoRefs) : RecyclerView.ViewHolder(refs.root) {
        var job: Job? = null
    }

    private class HeaderVH(val refs: HeaderRefs) : RecyclerView.ViewHolder(refs.root)

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): RecyclerView.ViewHolder {
        val ctx = parent.context
        // 点击必须走 ViewHolder 的 bindingAdapterPosition（复用后位置会变），
        // 因此先建 ViewHolder 再挂监听，闭包捕获 holder 本身。
        return when (viewType) {
            TYPE_HEADER -> {
                val refs = buildHeaderView(ctx, textPrimaryColor, textSecondaryColor)
                val vh = HeaderVH(refs)
                refs.root.setOnClickListener {
                    val item = items.getOrNull(vh.bindingAdapterPosition) as? GridItem.Header
                    if (item != null) onToggleGroup(item.id)
                }
                vh
            }

            else -> {
                val refs = buildPhotoView(ctx, surfaceColor, textPrimaryColor, primaryColor)
                val vh = PhotoVH(refs)
                refs.root.setOnClickListener {
                    val item = items.getOrNull(vh.bindingAdapterPosition) as? GridItem.Photo
                    if (item != null) onClick(item.image)
                }
                vh
            }
        }
    }

    override fun onBindViewHolder(
        holder: RecyclerView.ViewHolder,
        position: Int,
        payloads: MutableList<Any>,
    ) {
        if (payloads.isNotEmpty()) {
            // 局部刷新（PAYLOAD_CELL）：只改封面高度，不重新 bind。
            // 换档（列宽变化）时靠它把旧 item 的封面高度可靠地刷成新值——
            // 直接改 layoutParams + requestLayout 会因「update 落在 layout 阶段」被 RV 吞掉，
            // 导致缩小后封面还带着上一档的高度（横屏/竖屏长条）。
            if (holder is PhotoVH) {
                val image = (items.getOrNull(position) as? GridItem.Photo)?.image ?: return
                holder.refs.cover.applyCoverHeight(coverHeightFor(image))
                forceMeasureOnRebind(holder)
            }
            return
        }
        onBindViewHolder(holder, position)
    }

    override fun onBindViewHolder(holder: RecyclerView.ViewHolder, position: Int) {
        // 清掉 FLIP 动画残留的 transform，否则复用后卡片会停在偏移态
        resetFlipTransform(holder.itemView)

        // 瀑布流下分组标题必须占满整行：StaggeredGrid 没有 SpanSizeLookup，
        // 靠 ItemView 的 LayoutParams.isFullSpan 控制（网格模式走 SpanSizeLookup）。
        if (layoutMode == LayoutMode.MASONRY) {
            (holder.itemView.layoutParams as? StaggeredGridLayoutManager.LayoutParams)
                ?.isFullSpan = items.getOrNull(position) is GridItem.Header
        }

        // 捏合进行中新绑定的 item 要补上当前进度的手动布局，否则会以未变换的样子闪现
        pinchFlip?.takeIf { it.isActive }?.applyToNewChild(holder.itemView, position)
        masonryPinch?.takeIf { it.isActive }?.applyToNewChild(holder.itemView, position)
        adaptivePinch?.takeIf { it.isActive }?.applyToNewChild(holder.itemView, position)

        when (holder) {
            is HeaderVH -> bindHeader(holder, position)
            is PhotoVH -> bindPhoto(holder, position)
        }
        forceMeasureOnRebind(holder)
    }

    /**
     * 重绑后强制重测。封面高度在 bind 时只写字段（[bindPhoto]）——[SquareImageView] 把
     * 内容级 requestLayout 降级为重绘后，重绑不再有「位图落地 → requestLayout」顺带设置的
     * 强制测量标志；RV fill 复用 view 时若尺寸 spec 与上次相同（同列宽），`View.measure`
     * 会跳过 onMeasure，视图保留**上一个档位/上一轮预览**的过期高度，bind 写入的正确
     * 高度没被消费——捏合起点布局（strip+重绑预填）恰好把过期高度捕获为预览插值起点，
     * 表现为捏合全程裁剪/错位、松手换档大幅跳动（maxDelta ~1800px）。forceLayout 只置
     * 强制标志、不上抛（见 [SquareImageView.requestLayout] 的说明），不会重新引发
     * 整网格重布局风暴。
     */
    private fun forceMeasureOnRebind(holder: RecyclerView.ViewHolder) {
        holder.itemView.forceLayout()
        if (holder is PhotoVH) {
            // frame 也要置强制标志：只 force 封面时，中间的 FrameLayout spec 未变会跳过
            // onMeasure，封面的新高度依旧不被消费（见 applyCoverHeight 的说明）。
            holder.refs.cover.forceLayout()
            (holder.refs.cover.parent as? View)?.forceLayout()
        }
    }

    private fun bindHeader(holder: HeaderVH, position: Int) {
        val item = items[position] as? GridItem.Header ?: return
        holder.refs.title.text = item.title
        holder.refs.count.text = "${item.count}"
        holder.refs.arrow.text = if (item.id in collapsedIds) "▸" else "▾"
    }

    private fun bindPhoto(holder: PhotoVH, position: Int) {
        val item = items[position] as? GridItem.Photo ?: return
        val image = item.image
        holder.refs.name.text = image.name

        val selected = image.id in selectedIds
        holder.refs.border.visibility = if (selected) View.VISIBLE else View.GONE
        holder.refs.check.visibility = if (selected) View.VISIBLE else View.GONE

        // 瀑布流按宽高比推导封面高度；网格用正方形（React 版 itemHeight = colWidth + 40）；
        // adaptive 用行高（宽度由行装箱给出，LM 测量时约束）。
        // 高度值尚未量出时回退到 WRAP_CONTENT，交给 SquareImageView 强制正方形，
        // 避免复用的 cover 带着上一次的显式高度（尤其从瀑布流复用过来）变成非正方形长条。
        val coverH = when {
            layoutMode == LayoutMode.ADAPTIVE && rowHeightPx > 0 -> rowHeightPx
            layoutMode == LayoutMode.ADAPTIVE -> ViewGroup.LayoutParams.WRAP_CONTENT
            cellWidthPx > 0 -> coverHeightFor(image)
            else -> ViewGroup.LayoutParams.WRAP_CONTENT
        }
        holder.refs.cover.applyCoverHeight(coverH)

        holder.job?.cancel()
        holder.job = loadInto(holder.refs.cover, image) { holder.bindingAdapterPosition == position }
    }


    /** 异步加载缩略图；[stillValid] 在回调时判定这次加载是否还对应同一张图（防复用错位）。 */
    private fun loadInto(
        cover: ImageView,
        image: Image,
        stillValid: () -> Boolean,
    ): Job {
        val imageId = loader.extractImageId(image.contentUri)
        val cached = loader.peekMemory(imageId)
        if (cached != null) {
            cover.setImageBitmap(cached)
            cover.tag = imageId
            return Job().apply { complete() }
        }
        // 视图正在展示同一张图（捏合落档换 LM 的同位置重绑必走这里）时不清空、不重载：
        // 内存缓存对大文件夹必然逐出（131 张 × 2MB > 128MB），清空 → 异步重载（media
        // ~12ms/张、并发 4）就是「松手后一片图片刷新」的直接来源。tag 记录该视图当前
        // 应显示的 imageId，drawable 非空即已上屏，直接沿用。
        if (cover.tag == imageId && cover.drawable != null) {
            return Job().apply { complete() }
        }
        cover.setImageBitmap(null)
        cover.tag = imageId
        return scope.launch {
            val bmp = loader.loadFastLimited(imageId)
            if (stillValid()) cover.setImageBitmap(bmp)
            // 按需高清升级：仅当系统缩略图偏小/缺失（<200px）才为这张图生成 HD（Rust 解码
            // 原图 ~145ms/张），512px 系统缩略图不触发——正常滚动零后台解码，不再整夹预热。
            if (bmp != null && loader.needsUpgrade(bmp)) {
                val hd = loader.generateHd(imageId, image.contentUri)
                if (stillValid() && hd != null) cover.setImageBitmap(hd)
            }
        }
    }

    override fun onViewRecycled(holder: RecyclerView.ViewHolder) {
        // 回收时置强制测量标志：经 mCachedViews 复用（不重走 bind）的 view 也必须重测，
        // 否则同样可能带着过期高度混进新一轮布局（见 forceMeasureOnRebind 的说明）。
        holder.itemView.forceLayout()
        if (holder is PhotoVH) {
            holder.job?.cancel()
            holder.refs.cover.setImageBitmap(null)
            holder.refs.cover.forceLayout()
        }
    }

    override fun onViewAttachedToWindow(holder: RecyclerView.ViewHolder) {
        // 经 mCachedViews 复用的 view（换档冷启动、预填回收再挂载）**不走 onBindViewHolder**，
        // 封面 lp 高度还带着上一个档位的值（瀑布流下差一整档，如 6 列的 421 混进 4 列布局，
        // 正确应为 559）。fill 会按旧值测量上屏；下一次捏合若选中它当锚点，textHeight 会被
        // 推算成毒值（实测 0/151/202），整张模拟表高度全错——预览把封面插向错误尺寸，
        // 表现为「捏合全程裁剪、松手复原」。attach 发生在 fill 测量该 child 之前，这里按
        // 当前数据归一，兜住所有不经 bind 的复用路径。
        if (holder is PhotoVH) {
            val image = (items.getOrNull(holder.bindingAdapterPosition) as? GridItem.Photo)?.image
            if (image != null) {
                holder.refs.cover.applyCoverHeight(coverHeightFor(image))
                holder.itemView.forceLayout()
            }
        }
    }
}
