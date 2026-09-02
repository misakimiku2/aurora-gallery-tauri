package com.aurora.gallery.kotlin.ui.components

import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.widget.ImageView
import android.widget.LinearLayout
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
import androidx.core.view.doOnLayout
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import androidx.recyclerview.widget.GridLayoutManager
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import androidx.recyclerview.widget.StaggeredGridLayoutManager
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

private const val TAG = "AuroraKotlin"

/**
 * 图片网格（原生 RecyclerView，对齐系统相册滚动性能）。
 *
 * 支持 [LayoutMode] 三种排布（安卓端不含 list，见 LayoutMode 的 KDoc）与 [GroupBy] 分组标题。
 * 三档捏合在 GRID / MASONRY 下走 FLIP 动画；ADAPTIVE 换档是整行重排，不做 FLIP。
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

    // ADAPTIVE 换档检测：上一次应用到 adaptive 的档位 span（-1 = 尚未初始化，首帧不触发 FLIP）。
    // ADAPTIVE 换档是整行重排，item 粒度（行）变了，只能用「按图片 id 锚定」的 FLIP（复用模式切换路径）。
    var appliedAdaptiveSpan by remember { mutableIntStateOf(-1) }

    val cols = if (containerWidthDp > 0) targetCols(containerWidthDp, level) else 0
    // adaptive 的行高基准 = 该档位的 thumbnailSize（对齐 React 版 `targetHeight = thumbnailSize`）
    val targetHeightDp = if (containerWidthDp > 0 && layoutMode == LayoutMode.ADAPTIVE) {
        adaptiveTargetHeightDp(containerWidthDp, kotlin.math.max(1, cols), gapDp, paddingDp)
    } else {
        0f
    }

    val items = remember(images, groupBy, collapsedIds, layoutMode, containerWidthDp, targetHeightDp) {
        buildGridItems(images, groupBy, collapsedIds, layoutMode, containerWidthDp, targetHeightDp, gapDp)
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

    // 注意：cellWidthPx（单元格宽度）**不在 key 里**。换档必然伴随列宽变化，若列宽变化触发
    // submit，全量刷新会重新 bind 所有 item，把 FLIP 的初始位移抹掉（表现为硬切）。
    // 列宽改用 adapter.applyCellWidth 同步到可见 item，不 notify。
    LaunchedEffect(items, layoutMode, gapPx) {
        adapter.submit(items, selectedIds, layoutMode, gapPx, collapsedIds)
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
            RecyclerView(ctx).apply {
                layoutManager = createLayoutManager(layoutMode, ctx, initialCols)
                this.adapter = adapter
                addItemDecoration(decoration)
                setPadding(paddingPx, paddingPx, paddingPx, paddingPx)
                clipToPadding = false
                itemAnimator = null
                isVerticalScrollBarEnabled = false
                rvHolder.rv = this
                // 同时挂两条分发路径，覆盖「第一指落在 item 上」与「落在网格间隙上」两种情况
                val pinch = PinchGridSpanListener(
                    context = ctx,
                    onPinchStart = { _, _ ->
                        // 进度驱动（跟手）覆盖面：
                        //  - GRID + 无分组：行号公式直接算目标位置；
                        //  - MASONRY：列分配是确定性算法（逐 item 放入最短列），离线模拟目标位置；
                        //  - ADAPTIVE / 分组 GRID：行内图数会变、标题占整行，算不准 → 只做松手换档。
                        when {
                            currentLayoutMode.value == LayoutMode.GRID &&
                                currentGroupBy.value == GroupBy.NONE ->
                                rvHolder.rv?.let { pinchFlip.begin(it, currentGapPx.value) }

                            currentLayoutMode.value == LayoutMode.MASONRY ->
                                rvHolder.rv?.let { masonryPinch.begin(it, currentGapPx.value) }
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
                        }
                    },
                    onPinchEnd = { scale ->
                        val rv = rvHolder.rv ?: return@PinchGridSpanListener
                        // 落档：收尾只跑剩余那段进度，清捏合状态（保留 transform 供换档 FLIP 从当前位置收尾）
                        fun commitFlip(target: Int, progress: Float) {
                            val remaining = 1f - progress
                            Log.d(
                                TAG,
                                "[Pinch] commit target=$target current=${currentLevel.value} " +
                                    "progress=$progress remaining=$remaining",
                            )
                            flipDurationMs =
                                (FLIP_DURATION_MS * remaining).toLong().coerceAtLeast(80L)
                            pinchFlip.release()
                            masonryPinch.release()
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

                            else -> {
                                // ADAPTIVE / 分组 GRID：捏合过阈值直接换一档
                                val delta = when {
                                    scale > PinchFlipController.STEP_THRESHOLD -> 1
                                    scale < 1f / PinchFlipController.STEP_THRESHOLD -> -1
                                    else -> 0
                                }
                                val target = currentLevel.value + delta
                                if (delta != 0 && target in 0..2) level = target
                            }
                        }
                    },
                )
                setOnTouchListener(pinch)
                addOnItemTouchListener(pinch)
            }
        },
        update = { rv ->
            if (rv.width <= 0) return@AndroidView
            val widthDp = rv.context.pxToDp(rv.width)
            if (measuredWidthDp != widthDp) measuredWidthDp = widthDp
            val span = targetCols(widthDp, level)

            // 布局模式切换：捕获 FLIP 快照 → 同步换 LayoutManager + 提交新数据 → 布局后动画。
            // 必须同步提交：只换 LM 而数据还是旧 item 的话，会出现「新 LM + 旧数据」的中间帧
            // （例如 adaptive 用 LinearLayoutManager 渲染一堆单图 item，整屏变成一列）。
            if (appliedMode != layoutMode) {
                val snapshot = captureModeSwitch(rv, adapter)
                val mode = layoutMode
                appliedMode = mode
                // 切到 ADAPTIVE 时同步记录档位，避免同一帧又被下方 ADAPTIVE 换档分支误触发第二次 FLIP
                if (mode == LayoutMode.ADAPTIVE) appliedAdaptiveSpan = span
                // 同步换 LM + submit：appliedMode 立即更新，同一帧后续 update 不会重复触发
                rv.layoutManager = createLayoutManager(mode, rv.context, span) {
                    adapter.isHeaderAt(it)
                }
                adapter.submit(items, selectedIds, mode, gapPx, collapsedIds)
                afterStableLayout(rv) {
                    // 布局期间可能又被切走，snapshot 已失效，放弃
                    if (appliedMode != mode) return@afterStableLayout
                    applyModeSwitchFlip(rv, adapter, snapshot)
                }
            } else if (!matchesMode(rv.layoutManager, layoutMode)) {
                rv.layoutManager = createLayoutManager(layoutMode, rv.context, span) {
                    adapter.isHeaderAt(it)
                }
                if (layoutMode == LayoutMode.MASONRY) {
                    (rv.layoutManager as? AuroraStaggeredLayoutManager)?.pendingExtraPrefill = true
                }
            }

            when (val lm = rv.layoutManager) {
                is GridLayoutManager -> {
                    // 分组标题占满整行；每次重建以清掉 SpanSizeLookup 的内部缓存
                    lm.spanSizeLookup = object : GridLayoutManager.SpanSizeLookup() {
                        override fun getSpanSize(position: Int): Int =
                            if (adapter.isHeaderAt(position)) lm.spanCount else 1
                    }
                    if (span != lm.spanCount) {
                        animateSpanChange(rv, lm, decoration, span, flipDurationMs)
                        flipDurationMs = FLIP_DURATION_MS
                    }
                }

                is StaggeredGridLayoutManager -> {
                    if (span != lm.spanCount) {
                        animateStaggeredSpanChange(rv, lm, decoration, span, flipDurationMs)
                        flipDurationMs = FLIP_DURATION_MS
                        // 换档布局完成后续填视口下方 1.5 屏——捏合预览压缩内容时底部不露白
                        (lm as? AuroraStaggeredLayoutManager)?.pendingExtraPrefill = true
                    }
                }

                else -> {
                    // ADAPTIVE：换档是整行重排（items 重算、行内图数变化），item 粒度变了，
                    // 只能用「按图片 id 锚定」的 FLIP（复用模式切换路径 applyModeSwitchFlip）。
                    // 必须同步 submit 新行化结果并锚点归位——交给 LaunchedEffect 异步提交的话
                    // 滚动位置会丢（notifyDataSetChanged 后同一 position 对应不同行，视觉跳位）。
                    if (layoutMode == LayoutMode.ADAPTIVE &&
                        appliedAdaptiveSpan >= 0 && appliedAdaptiveSpan != span
                    ) {
                        val snapshot = captureModeSwitch(rv, adapter)
                        adapter.submit(items, selectedIds, layoutMode, gapPx, collapsedIds)
                        afterStableLayout(rv) {
                            // 期间可能又切模式或再换档，snapshot 失效，放弃
                            if (layoutMode != LayoutMode.ADAPTIVE ||
                                appliedAdaptiveSpan != span
                            ) return@afterStableLayout
                            applyModeSwitchFlip(rv, adapter, snapshot)
                        }
                    }
                    appliedAdaptiveSpan = span
                }
            }

            // 网格/瀑布流按列铺，adaptive 每行一个 item。
            // 赋值 spanCount 不会自动生效，必须配 invalidateItemDecorations——
            // 否则模式切换后间距仍按旧列数算（换档时 animateXxx 内部已经做了，这里补模式切换的情况）。
            val wantSpan = if (layoutMode == LayoutMode.ADAPTIVE) 1 else span
            if (decoration.spanCount != wantSpan) {
                decoration.spanCount = wantSpan
                rv.invalidateItemDecorations()
            }

            // 网格（正方形）与瀑布流（按宽高比）用单元格宽度推导封面高度。
            // 走 applyCellWidth（不 notify）而非 submit——见 LaunchedEffect 处的说明。
            val inner = rv.width - rv.paddingLeft - rv.paddingRight
            val cell = if (layoutMode == LayoutMode.ADAPTIVE) 0
                else ((inner - (span - 1) * gapPx) / span).coerceAtLeast(1)
            adapter.applyCellWidth(rv, cell)

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
        modifier = modifier,
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
    override fun calculateExtraLayoutSpace(
        state: RecyclerView.State,
        extraLayoutSpace: IntArray,
    ) {
        extraLayoutSpace[0] = height / 3
        extraLayoutSpace[1] = height * 3 / 2
    }
}

private fun createLayoutManager(
    mode: LayoutMode,
    context: android.content.Context,
    spanCount: Int,
    isFullSpanAt: (Int) -> Boolean = { false },
): RecyclerView.LayoutManager = when (mode) {
    // adaptive 把「一行」作为 item，行内排布在 item 内部完成，因此用最简单的纵向布局即可
    LayoutMode.ADAPTIVE -> LinearLayoutManager(context)
    LayoutMode.MASONRY -> AuroraStaggeredLayoutManager(spanCount, isFullSpanAt)
    else -> AuroraGridLayoutManager(context, spanCount)
}

/**
 * 视口下方**多布局一些 item** 的 StaggeredGridLayoutManager（与 [AuroraGridLayoutManager] 对称）。
 *
 * 为什么需要：瀑布流捏合缩小（列数变多）时内容压缩约一倍，捏合预览是把可见内容往新档位
 * 位置插值——若布局没有预填，下方/上方会露出大片空白。GRID 版靠
 * `LinearLayoutManager.calculateExtraLayoutSpace`（底部 1.5 屏）解决；但 StaggeredGridLayoutManager
 * **没有这个 hook**（它不继承 LinearLayoutManager），只能布局完成后手动补：
 * [pendingExtraPrefill] 置位后，下一次 onLayoutChildren 按与 Staggered 一致的
 * 「按 position 顺序放入最短列」规则把下方 1.5 屏补建出来。预填的 view 走 addView 正常
 * attach，随后的滚动/换档布局都由 Staggered 标准流程接管（span 记录失效时会重新推算，
 * 与这里的分配规则一致，不会错位）。
 */
internal class AuroraStaggeredLayoutManager(
    spanCount: Int,
    /** pos 是否为满宽 header（分组标题）。预填时它必须占满整行。 */
    private val isFullSpanAt: (Int) -> Boolean,
) : StaggeredGridLayoutManager(spanCount, StaggeredGridLayoutManager.VERTICAL) {

    /** 换档后置位：下一次布局完成（新档位、span 缓存已失效）后向视口下方预填。 */
    var pendingExtraPrefill: Boolean = false

    override fun onLayoutChildren(
        recycler: RecyclerView.Recycler,
        state: RecyclerView.State,
    ) {
        super.onLayoutChildren(recycler, state)
        if (pendingExtraPrefill) {
            pendingExtraPrefill = false
            prefillBelow(recycler, state.itemCount)
        }
    }

    /** 按最短列优先把视口下方 1.5 屏的 item 补建出来（与 Staggered 分配规则一致）。 */
    private fun prefillBelow(recycler: RecyclerView.Recycler, itemCount: Int) {
        if (childCount == 0 || width <= 0 || itemCount <= 0) return

        // 列以 decorated left 识别（等间距修复后列宽一致，left 唯一对应一列）。
        // 底边用 decoratedBottom：decoration 的 outRect.bottom / margin 恒为 0，
        // 所以它等于 child.bottom，可作为下一 item 的 decorated top。
        val colLefts = sortedSetOf<Int>()
        val colBottoms = HashMap<Int, Int>()
        var maxPos = -1
        var headerBottom = Int.MIN_VALUE
        for (i in 0 until childCount) {
            val c = getChildAt(i) ?: continue
            val pos = getPosition(c)
            if (pos == RecyclerView.NO_POSITION) continue
            if (isFullSpanAt(pos)) {
                // 满宽 header 不属于任何一列；它之后各列的底边 = header 底边
                headerBottom = maxOf(headerBottom, getDecoratedBottom(c))
            } else {
                val dl = getDecoratedLeft(c)
                colLefts.add(dl)
                colBottoms[dl] = maxOf(colBottoms[dl] ?: Int.MIN_VALUE, getDecoratedBottom(c))
            }
            if (pos > maxPos) maxPos = pos
        }
        if (headerBottom > Int.MIN_VALUE) {
            for (k in colBottoms.keys) colBottoms[k] = maxOf(colBottoms[k] ?: 0, headerBottom)
        }
        val cols = colLefts.toList()
        if (cols.isEmpty() || maxPos < 0) return

        val limit = colBottoms.values.max() + height * 3 / 2
        var pos = maxPos + 1
        while (pos < itemCount) {
            // 最短列（bottom 最小；并列取靠左的，与 Staggered 的列扫描顺序一致）
            var best = cols.first()
            var bestBottom = colBottoms[best] ?: break
            for (c in cols) {
                val b = colBottoms[c] ?: continue
                if (b < bestBottom) {
                    bestBottom = b
                    best = c
                }
            }

            val v = try {
                recycler.getViewForPosition(pos)
            } catch (e: Exception) {
                return
            }
            addView(v)
            measureChildWithMargins(v, 0, 0)
            if (isFullSpanAt(pos)) {
                // 满宽 header：decorated 区间 = 内容区全宽，底部取各列最大值
                val top = colBottoms.values.max()
                layoutDecoratedWithMargins(
                    v, paddingLeft, top,
                    paddingLeft + v.measuredWidth, top + v.measuredHeight,
                )
                for (c in cols) colBottoms[c] = top + v.measuredHeight
            } else {
                layoutDecoratedWithMargins(
                    v, best, bestBottom,
                    best + v.measuredWidth, bestBottom + v.measuredHeight,
                )
                colBottoms[best] = bestBottom + v.measuredHeight
            }
            if (colBottoms.values.min() > limit) break
            pos++
        }
    }
}

private fun matchesMode(lm: RecyclerView.LayoutManager?, mode: LayoutMode): Boolean = when (mode) {
    LayoutMode.MASONRY -> lm is StaggeredGridLayoutManager
    // GridLayoutManager 继承自 LinearLayoutManager，需要排除
    LayoutMode.ADAPTIVE -> lm is LinearLayoutManager && lm !is GridLayoutManager
    else -> lm is GridLayoutManager
}

/** 视图切换的 FLIP 快照：锚点图 + 每张可见图的屏幕位置。 */
private class ModeSwitchSnapshot(
    val anchorId: String?,
    val anchorTop: Float,
    val positions: Map<String, Pair<Float, Float>>,
)

/**
 * 捕获切换前每张可见图的屏幕位置与锚点（锚点 = 最靠上的那张可见图，含部分露出的）。
 * 位置带当前 translation，连续快速切换时不会跳。
 */
private fun captureModeSwitch(
    rv: RecyclerView,
    adapter: FileGridAdapter,
): ModeSwitchSnapshot {
    var anchorId: String? = null
    var anchorTop = Float.MAX_VALUE
    val positions = HashMap<String, Pair<Float, Float>>()
    adapter.forEachVisibleImage(rv, withTranslation = true) { id, _, left, top ->
        positions[id] = left to top
        if (top < anchorTop) {
            anchorTop = top
            anchorId = id
        }
    }
    return ModeSwitchSnapshot(anchorId, if (anchorTop == Float.MAX_VALUE) 0f else anchorTop, positions)
}

/**
 * 视图切换后的锚点归位 + 二维 FLIP。动画参数与捏合换档完全一致（240ms /
 * `PathInterpolator(0.22,1,0.36,1)`），保证两种触发来源的换档观感统一。
 *
 * 顺序要点：**先 scrollBy 纠正锚点，再换算 FLIP 位移**。scrollBy 会同步把所有 child 的
 * top 平移 `-drift`，所以最终位置是 `newTop - drift`，直接用收集到的 newTop 会算错。
 */
private fun applyModeSwitchFlip(
    rv: RecyclerView,
    adapter: FileGridAdapter,
    snap: ModeSwitchSnapshot,
) {
    // 0. 粗定位：换 LayoutManager 会丢掉滚动位置（日志上表现为 old/new 两屏图片完全无交集、
    //    missing 全中、FLIP 一个都匹配不上）。先把锚点图所在的 item 滚进视口。
    val anchorId = snap.anchorId
    if (anchorId != null) {
        val idx = adapter.indexOfImage(anchorId)
        if (idx != RecyclerView.NO_POSITION) rv.scrollToPosition(idx)
    }

    afterStableLayout(rv) {
        // 1. 收集新位置（scrollBy 之前）
        val views = HashMap<String, View>()
        val newPos = HashMap<String, Pair<Float, Float>>()
        adapter.forEachVisibleImage(rv, withTranslation = false) { id, view, left, top ->
            views[id] = view
            newPos[id] = left to top
        }

        // 2. 锚点归位：让切换前后的锚点图停在同一屏幕位置
        var drift = 0
        if (anchorId != null) {
            val newTop = newPos[anchorId]?.second
            if (newTop != null) {
                drift = (newTop - snap.anchorTop).roundToInt()
                if (drift != 0) rv.scrollBy(0, drift)
            }
        }

        // 3. Invert + Play
        var animated = 0
        var missing = 0
        var skipped = 0
        for ((id, old) in snap.positions) {
            val view = views[id]
            val new = newPos[id]
            if (view == null || new == null) {
                missing++
                continue
            }
            val dx = old.first - new.first
            val dy = old.second - (new.second - drift)
            if (abs(dx) < 1f && abs(dy) < 1f) {
                skipped++
                continue
            }
            view.animate().cancel()
            view.translationX = dx
            view.translationY = dy
            view.animate()
                .translationX(0f)
                .translationY(0f)
                .setDuration(FLIP_DURATION_MS)
                .setInterpolator(FLIP_INTERPOLATOR)
                .start()
            animated++
        }
        Log.d(
            TAG,
            "[FLIP-ModeSwitch] anchor=${anchorId?.take(8)} drift=$drift oldCount=${snap.positions.size} " +
                "newCount=${newPos.size} animated=$animated missing=$missing skipped=$skipped",
        )
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
    private var gapPx: Int = 0
    private var collapsedIds: Set<String> = emptySet()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    /** 进度驱动 FLIP 控制器；捏合中新绑定的 item 需要补上当前进度的 transform。 */
    var pinchFlip: PinchFlipController? = null

    /** 所有分组标题的位置（升序），供 sticky 标题二分查找。 */
    var headerPositions: List<Int> = emptyList()
        private set

    companion object {
        private const val TYPE_HEADER = 0
        private const val TYPE_PHOTO = 1
        private const val TYPE_ADAPTIVE_ROW = 2

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
    fun applyCellWidth(rv: RecyclerView, cellPx: Int) {
        // adaptive 模式用不到列宽（行内宽度由行化结果给出）。这里必须**保留上一次的值**
        // 而不是置 0——否则切回 GRID/MASONRY 时会被误判成「首次量出宽度」而走全量刷新，
        // 把视图切换的 FLIP 打断。
        if (cellPx <= 0) return
        if (cellWidthPx == cellPx) return
        val wasZero = cellWidthPx <= 0
        cellWidthPx = cellPx
        Log.d(
            TAG,
            "[Cell] applyCellWidth cellPx=$cellPx wasZero=$wasZero childCount=${rv.childCount} " +
                "mode=$layoutMode itemCount=${items.size}",
        )
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

    /** 封面高度：瀑布流按宽高比，网格用正方形。 */
    private fun coverHeightFor(image: Image): Int =
        if (layoutMode == LayoutMode.MASONRY) (cellWidthPx / aspectRatioOf(image)).toInt() else cellWidthPx

    /**
     * 遍历当前可见的每一张图。
     *
     * 三种模式的 item 粒度不同（GRID / MASONRY 一个 item 是一张图，ADAPTIVE 一个 item 是
     * **一行**），所以视图切换的 FLIP 只能以**图片 id** 为锚，无法按 position 对应。
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
            when (val holder = rv.getChildViewHolder(child)) {
                is PhotoVH -> {
                    val image = (items.getOrNull(pos) as? GridItem.Photo)?.image ?: continue
                    block(image.id, child, child.left + tx, child.top + ty)
                }

                is AdaptiveRowVH -> {
                    val row = (items.getOrNull(pos) as? GridItem.AdaptiveRow)?.row ?: continue
                    holder.refs.cells.forEachIndexed { index, cell ->
                        if (index >= row.images.size || cell.root.visibility != View.VISIBLE) return@forEachIndexed
                        // cell 的坐标相对行容器，要加上行容器的位置才是 RV 坐标系
                        block(
                            row.images[index].id,
                            cell.root,
                            child.left + cell.root.left + tx,
                            child.top + cell.root.top + ty,
                        )
                    }
                }
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
            when (val it = items[i]) {
                is GridItem.Photo -> if (it.image.id == id) return i
                is GridItem.AdaptiveRow -> if (it.row.images.any { img -> img.id == id }) return i
                is GridItem.Header -> Unit
            }
        }
        return RecyclerView.NO_POSITION
    }

    override fun getItemCount(): Int = items.size

    override fun getItemViewType(position: Int): Int = when {
        items[position] is GridItem.Header -> TYPE_HEADER
        items[position] is GridItem.AdaptiveRow -> TYPE_ADAPTIVE_ROW
        else -> TYPE_PHOTO
    }

    private class PhotoVH(val refs: PhotoRefs) : RecyclerView.ViewHolder(refs.root) {
        var job: Job? = null
    }

    private class AdaptiveRowVH(val refs: AdaptiveRowRefs) : RecyclerView.ViewHolder(refs.root) {
        /** 行内每个单元格一个加载任务（下标 → Job）。 */
        val jobs = HashMap<Int, Job>()
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

            TYPE_ADAPTIVE_ROW -> AdaptiveRowVH(buildAdaptiveRowView(ctx))

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
                holder.refs.cover.layoutParams.height = coverHeightFor(image)
                holder.refs.cover.requestLayout()
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

        // 捏合进行中新绑定的 item 要补上当前进度的 transform，否则会以未变换的样子闪现
        pinchFlip?.takeIf { it.isActive }?.applyToNewChild(holder.itemView, position)

        when (holder) {
            is HeaderVH -> bindHeader(holder, position)
            is PhotoVH -> bindPhoto(holder, position)
            is AdaptiveRowVH -> bindAdaptiveRow(holder, position)
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

        // 瀑布流按宽高比推导封面高度；网格用正方形（React 版 itemHeight = colWidth + 40）。
        // cellWidthPx 尚未量出时回退到 WRAP_CONTENT，交给 SquareImageView 强制正方形，
        // 避免复用的 cover 带着上一次的显式高度（尤其从瀑布流复用过来）变成非正方形长条。
        val coverH = if (cellWidthPx > 0) {
            coverHeightFor(image)
        } else {
            ViewGroup.LayoutParams.WRAP_CONTENT
        }
        // 网格模式下 coverH 应恒等于 cellWidthPx（正方形）。一旦不等（WRAP_CONTENT=-2 或瀑布流公式），
        // 就是「滚动后出现非正方形长条」的来源——打印所有异常 case 定位。
        if (layoutMode == LayoutMode.GRID && coverH != cellWidthPx) {
            Log.d(
                TAG,
                "[Cell] NON-SQUARE pos=$position coverH=$coverH cellPx=$cellWidthPx " +
                    "ratio=${aspectRatioOf(image)} mode=$layoutMode",
            )
        }
        holder.refs.cover.layoutParams.height = coverH

        // 诊断「长条」：布局后打印封面实际宽高 + 图片宽高比。采样覆盖整个列表（每 20 个打一次），
        // 便于捕捉「滚动后才出现的错乱」。
        if (position % 20 == 0) {
            val imgW = image.width
            val imgH = image.height
            holder.refs.cover.post {
                Log.d(
                    TAG,
                    "[Cell] pos=$position coverW=${holder.refs.cover.width} coverH=${holder.refs.cover.height} " +
                        "cellPx=$cellWidthPx imgW=$imgW imgH=$imgH mode=$layoutMode",
                )
            }
        }

        holder.job?.cancel()
        holder.job = loadInto(holder.refs.cover, image) { holder.bindingAdapterPosition == position }
    }

    private fun bindAdaptiveRow(holder: AdaptiveRowVH, position: Int) {
        val row = (items[position] as? GridItem.AdaptiveRow)?.row ?: return
        val ctx = holder.itemView.context
        val density = ctx.resources.displayMetrics.density

        holder.refs.ensureCells(row.images.size, ctx, surfaceColor, textPrimaryColor, primaryColor)
        holder.jobs.values.forEach { it.cancel() }
        holder.jobs.clear()

        val imageHeightPx = (row.imageHeightDp * density).toInt()

        row.images.forEachIndexed { index, image ->
            val cell = holder.refs.cells[index]
            val lp = cell.root.layoutParams as LinearLayout.LayoutParams
            lp.width = (row.widthsDp[index] * density).toInt()
            lp.leftMargin = if (index > 0) gapPx else 0
            cell.root.layoutParams = lp
            cell.cover.layoutParams.height = imageHeightPx
            cell.name.text = image.name

            val selected = image.id in selectedIds
            cell.border.visibility = if (selected) View.VISIBLE else View.GONE
            cell.check.visibility = if (selected) View.VISIBLE else View.GONE

            val pos = position
            cell.root.setOnClickListener { onClick(image) }
            holder.jobs[index] = loadInto(cell.cover, image) {
                holder.bindingAdapterPosition == pos && holder.refs.cells.getOrNull(index) === cell
            }
        }
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
            return Job().apply { complete() }
        }
        cover.setImageBitmap(null)
        return scope.launch {
            val bmp = loader.loadFastLimited(imageId)
            if (stillValid()) cover.setImageBitmap(bmp)
        }
    }

    override fun onViewRecycled(holder: RecyclerView.ViewHolder) {
        when (holder) {
            is PhotoVH -> {
                holder.job?.cancel()
                holder.refs.cover.setImageBitmap(null)
            }
            is AdaptiveRowVH -> {
                holder.jobs.values.forEach { it.cancel() }
                holder.jobs.clear()
                for (cell in holder.refs.cells) {
                    cell.cover.setImageBitmap(null)
                    cell.root.visibility = View.GONE
                }
            }
        }
    }
}
