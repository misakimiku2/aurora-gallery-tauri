package com.aurora.gallery.kotlin.ui.components

import android.animation.Animator
import android.animation.AnimatorListenerAdapter
import android.animation.ValueAnimator
import android.graphics.Rect
import android.util.Log
import android.view.View
import android.view.ViewGroup
import androidx.recyclerview.widget.RecyclerView
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * **自适应视图（ADAPTIVE）的行装箱数学 + 布局管理器 + 捏合控制器。**
 *
 * 与 GRID/MASONRY 的关键差异：自适应的「行」是按宽度贪心装箱出来的（逐图累加
 * `目标行高 × 宽高比`，装入后超出可用宽即成行、整行拉伸对齐可用宽、组内末行过短
 * 不拉伸），行划分随档位变化。历史实现把「一行」作为 adapter item——换档时 item
 * 序列整体重建，position 与图的对应关系断裂，做不了「同一 item 旧位置 → 新位置」
 * 的跟手预览（表现：不跟手、松手瞬变）。
 *
 * 现在与 GRID/MASONRY 统一为**一图一项**，行划分下沉到 [AuroraAdaptiveLayoutManager]
 * 的布局期；捏合预览由 [AdaptivePinchController] 离线模拟目标档位的行划分做逐 item
 * 真实 measure/layout 插值（与 [MasonryPinchController] 对称，进度驱动、跟手）。
 *
 * **行划分数学只有一份**（[packAdaptiveRowAt]）：LM 布局与捏合模拟共用，保证
 * progress=1 的预览与冷启动布局逐位一致、松手收尾 FLIP 零跳变。算法逐条对齐
 * React 版 `layout.worker.ts` 的 adaptive 分支（含组内末行不拉伸特例）。
 */

/** 一个行的装箱结果：[start, end) 与拉伸后的行高（photos 的封面高；header 为标题行高）。 */
internal class AdaptiveRowSpan(
    val start: Int,
    val end: Int,
    val coverH: Int,
) {
    /** 行内每个位置的宽度（与 [start] 对齐，含 [start] 自身）。 */
    val widths: IntArray = IntArray(end - start)
}

/**
 * 计算以 [start] 开头的行（[start] 必须是行首：pos==0、或前一个位置是上一行的末尾）。
 *
 * 对齐 React 版 `layout.worker.ts` 的 adaptive 分支：**先装入再判定**——逐图累加
 * `rowHeightPx × ratio`，装入后 `sumW + gaps >= availWidth` 即成行（超宽的那张图
 * 也留在本行内由 scale 压缩）；`scale = (availWidth - gaps) / sumW` 整行拉伸；
 * **组内末行特例**：行因「数据末尾 / 分组标题」终止（而非溢出成行）且
 * `sumW + gaps < availWidth / 2` 时不拉伸（scale = 1）。
 */
internal fun packAdaptiveRowAt(
    start: Int,
    count: Int,
    rowHeightPx: Int,
    headerHeightPx: Int,
    availWidth: Int,
    gapPx: Int,
    ratioAt: (Int) -> Float,
    isHeaderAt: (Int) -> Boolean,
): AdaptiveRowSpan {
    if (isHeaderAt(start)) {
        return AdaptiveRowSpan(start, start + 1, headerHeightPx).apply { widths[0] = availWidth }
    }
    var sumW = 0f
    var end = start
    var closedByOverflow = false
    while (end < count && !isHeaderAt(end)) {
        sumW += rowHeightPx * ratioAt(end).coerceAtLeast(0.05f)
        end++
        val gaps = (end - start - 1) * gapPx
        if (sumW + gaps >= availWidth) {
            closedByOverflow = true
            break
        }
    }
    val n = end - start
    val gaps = (n - 1) * gapPx
    var scale = (availWidth - gaps) / sumW
    val groupEnd = end >= count || isHeaderAt(end)
    if (groupEnd && !closedByOverflow && sumW + gaps < availWidth / 2f) scale = 1f
    return AdaptiveRowSpan(start, end, (rowHeightPx * scale).roundToInt()).apply {
        for (i in 0 until n) {
            widths[i] = (rowHeightPx * ratioAt(start + i).coerceAtLeast(0.05f) * scale)
                .roundToInt()
                .coerceAtLeast(1)
        }
    }
}

/**
 * 自适应视图的布局管理器：纵向滚动、按 [packAdaptiveRowAt] 贪心装箱成行、满宽分组标题
 * 独占一行。几何全部来自**预计算的行划分表**（内容坐标，一图一项），滚动/填充/回收都
 * 是查表操作，与捏合模拟共用同一份数学。
 *
 * 视口上方探 1/3 屏、下方常驻预填 1.5 屏（捏合收拢时内容压缩，无预填会露出大段空白，
 * 与 GRID/MASONRY 的预填策略一致）；每轮 [onLayoutChildren] 末尾回调 [previewRestorer]，
 * 重放捏合预览的手动 measure/layout（被布局洗掉后同帧恢复，避免闪回原布局一帧）。
 */
internal class AuroraAdaptiveLayoutManager(
    /** 当前档位的目标行高 px（不含文件名文字区）。 */
    val rowHeightPx: Int,
    /** 文件名文字区高度 px（与 buildPhotoView 的 name 视图实测一致，见 FileGrid 的探针测量）。 */
    private val textHeightPx: Int,
    /** 分组标题行高 px（HEADER_HEIGHT_DP）。 */
    private val headerHeightPx: Int,
    private val ratioAt: (Int) -> Float,
    private val isHeaderAt: (Int) -> Boolean,
    private val gapPx: Int,
    var previewRestorer: (() -> Unit)? = null,
) : RecyclerView.LayoutManager() {

    /** 行划分表（内容坐标）。childTopOf 为**视图实际 top**（decorated top + 顶 inset）。 */
    private class Table(
        val count: Int,
        val rowHeightPx: Int,
        val availWidth: Int,
        val childTopOf: IntArray,
        val xOf: IntArray,
        val widthOf: IntArray,
        val coverHOf: IntArray,
        val rowStartOf: IntArray,
        val isHeaderOf: BooleanArray,
        /** 最后一个位置的 decorated bottom（内容坐标）。 */
        val contentBottom: Int,
    )

    private var table: Table? = null
    private var scrollY = 0
    private var pendingScrollPos = RecyclerView.NO_POSITION
    private var pendingOffset = 0

    init {
        isAutoMeasureEnabled = true
    }

    override fun onItemsChanged(recyclerView: RecyclerView) {
        table = null
        if (recyclerView.adapter?.itemCount == 0) scrollY = 0
        super.onItemsChanged(recyclerView)
    }

    override fun onItemsUpdated(recyclerView: RecyclerView, positionStart: Int, itemCount: Int) {
        table = null
        super.onItemsUpdated(recyclerView, positionStart, itemCount)
    }

    private fun availWidth(): Int = width - paddingLeft - paddingRight

    private fun ensureTable(count: Int): Table {
        table?.takeIf {
            it.count == count && it.rowHeightPx == rowHeightPx && it.availWidth == availWidth()
        }?.let { return it }
        val childTopOf = IntArray(count)
        val xOf = IntArray(count)
        val widthOf = IntArray(count)
        val coverHOf = IntArray(count)
        val rowStartOf = IntArray(count)
        val isHeaderOf = BooleanArray(count)
        val avail = availWidth().coerceAtLeast(1)
        var y = 0
        var pos = 0
        while (pos < count) {
            val span = packAdaptiveRowAt(
                pos, count, rowHeightPx, headerHeightPx, avail, gapPx, ratioAt, isHeaderAt,
            )
            val topInset = if (pos >= 1) gapPx else 0
            var x = 0
            var maxItemH = 0
            for (i in span.start until span.end) {
                val w = span.widths[i - span.start]
                rowStartOf[i] = span.start
                isHeaderOf[i] = isHeaderAt(i)
                xOf[i] = x
                widthOf[i] = w
                coverHOf[i] = span.coverH
                childTopOf[i] = y + topInset
                val itemH = if (isHeaderAt(i)) span.coverH else span.coverH + textHeightPx
                if (itemH > maxItemH) maxItemH = itemH
                x += w + gapPx
            }
            y += topInset + maxItemH
            pos = span.end
        }
        val t = Table(
            count, rowHeightPx, avail, childTopOf, xOf, widthOf, coverHOf,
            rowStartOf, isHeaderOf, y,
        )
        table = t
        return t
    }

    private fun Table.topInsetOf(pos: Int): Int = if (pos >= 1) gapPx else 0

    private fun Table.itemHeightOf(pos: Int): Int =
        if (isHeaderOf[pos]) coverHOf[pos] else coverHOf[pos] + textHeightPx

    override fun generateDefaultLayoutParams(): RecyclerView.LayoutParams =
        RecyclerView.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)

    override fun canScrollVertically(): Boolean = true
    override fun canScrollHorizontally(): Boolean = false

    override fun scrollToPosition(position: Int) {
        pendingScrollPos = position
        // 与 LinearLayoutManager 语义一致：目标停在顶 padding 边缘（视口坐标 paddingTop），
        // 而不是 0（那会顶进 sticky 标题/padding 区）。
        pendingOffset = paddingTop
    }

    /** offset = 目标视图 top 的视口坐标（与 masonry 换档锚点的语义一致）。 */
    fun scrollToPositionWithOffset(position: Int, offset: Int) {
        pendingScrollPos = position
        pendingOffset = offset
    }

    override fun onLayoutChildren(recycler: RecyclerView.Recycler, state: RecyclerView.State) {
        val count = state.itemCount
        if (count == 0) {
            detachAndScrapAttachedViews(recycler)
            table = null
            scrollY = 0
            return
        }
        val t = ensureTable(count)

        if (pendingScrollPos != RecyclerView.NO_POSITION) {
            val pos = pendingScrollPos.coerceIn(0, count - 1)
            // 目标：锚点视图 top（视口坐标）== pendingOffset。placeChild/relayoutAttached 的
            // 不变量是 view.top = paddingTop + childTopOf - scrollY，故
            // scrollY = paddingTop + childTopOf - offset。少加 paddingTop 会让锚点落低
            // paddingTop，仅靠 fixAnchor 的 scrollBy 补救——滚动被 [0,maxScroll] 钳制时
            // （列表底部）scrollBy 拒绝位移，落档位置与捏合预览永久差一段。
            scrollY = paddingTop + t.childTopOf[pos] - pendingOffset
            pendingScrollPos = RecyclerView.NO_POSITION
        }
        val maxScroll = max(0, t.contentBottom + paddingTop + paddingBottom - height)
        scrollY = scrollY.coerceIn(0, maxScroll)

        detachAndScrapAttachedViews(recycler)
        fillVisible(recycler, t, count)
        previewRestorer?.invoke()
    }

    override fun scrollVerticallyBy(dy: Int, recycler: RecyclerView.Recycler, state: RecyclerView.State): Int {
        val count = state.itemCount
        if (count == 0 || dy == 0) return 0
        val t = ensureTable(count)
        val maxScroll = max(0, t.contentBottom + paddingTop + paddingBottom - height)
        val target = (scrollY + dy).coerceIn(0, maxScroll)
        val consumed = target - scrollY
        if (consumed == 0) return 0
        scrollY = target
        offsetChildrenVertical(-consumed)
        fillVisible(recycler, t, count)
        recycleOffscreen(recycler, t)
        relayoutAttached(t)
        return consumed
    }

    /**
     * 把所有挂载子视图**强制按划分表重新 layout**。增量滚动的不变量（挂载子视图恒等于
     * 表位置）会被若干路径破坏——捏合预览的手动 measure/layout、playFlip 的 translation
     * 归零动画中途、回收复用的时序差——一旦破坏，fill 的「已挂载即跳过」会让错误位置
     * 永久滞留（视口空白）。layout 不触发测量风暴（spec 未变时 measure 直接跳过），
     * 每帧对 ~40 个子视图重放 layout 的成本可忽略，换来任何漂移一帧内自愈。
     */
    private fun relayoutAttached(t: Table) {
        for (i in 0 until childCount) {
            val c = getChildAt(i) ?: continue
            val pos = getPosition(c)
            if (pos == RecyclerView.NO_POSITION || pos >= t.count) continue
            val w = t.widthOf[pos]
            val contentDecorTop = paddingTop + t.childTopOf[pos] - t.topInsetOf(pos) - scrollY
            layoutDecoratedWithMargins(
                c,
                paddingLeft + t.xOf[pos],
                contentDecorTop,
                paddingLeft + t.xOf[pos] + w,
                contentDecorTop + t.topInsetOf(pos) + c.measuredHeight,
            )
        }
    }

    /**
     * 把 [scrollY - 上探, scrollY + 视口 + 下探] 范围内的 item 全部挂载（缺的补）。
     *
     * 上探一整屏（GRID/MASONRY 是 1/3 屏）：列表端捏合时预览目标会被滚动钳制位移 δ
     * 整体下移（δ 可达近一屏，见 AdaptivePinchController.buildTables），上方预留不足
     * 会在手势中露出成片空白。除从 firstVisible 向下填之外，还要**向上回填**探出窗口
     * 内的行——firstVisible 之上的行（完全在 scrollY 上方）单靠向下填永远不会挂载。
     */
    private fun fillVisible(recycler: RecyclerView.Recycler, t: Table, count: Int) {
        val aboveExtra = height
        val belowExtra = height * 3 / 2
        val topContent = scrollY - aboveExtra
        val bottomContent = scrollY + height + belowExtra

        val present = HashSet<Int>(childCount)
        for (i in 0 until childCount) {
            val c = getChildAt(i) ?: continue
            val pos = getPosition(c)
            if (pos in 0 until count) present.add(pos)
        }

        var pos = firstVisiblePosition(t, count)
        val first = pos
        var placed = 0
        while (pos < count && t.childTopOf[pos] < bottomContent) {
            if (t.childTopOf[pos] + t.itemHeightOf(pos) >= topContent && pos !in present) {
                placeChild(recycler, t, pos)
                placed++
            }
            pos++
        }
        // 向上回填：first 上一条起倒着走，直到行底越过窗口上沿。行内各位置共享同一
        // childTopOf，逐 pos 检查即可整行挂载（present 去重，placeChild 幂等）。
        var up = first - 1
        while (up >= 0 && t.childTopOf[up] + t.itemHeightOf(up) >= topContent) {
            if (up !in present) {
                placeChild(recycler, t, up)
                placed++
            }
            up--
        }
        // TODO(debug) 视口内可见子视图数为 0 时 dump 全部子视图几何
        var onScreen = 0
        val dump = StringBuilder()
        for (i in 0 until childCount) {
            val c = getChildAt(i) ?: continue
            if (c.top < height && c.bottom > 0) onScreen++
            if (onScreen == 0) dump.append(" c${getPosition(c)}:${c.top}-${c.bottom}")
        }
        if (onScreen == 0) {
            val tbl = StringBuilder()
            for (i in intArrayOf(0, 8, 16, 26, 43, 64, count - 1)) {
                if (i in 0 until count) tbl.append(" t$i=${t.childTopOf[i]}")
            }
            Log.d("AuroraKotlin", "[AdaptiveLM] BLANK scrollY=$scrollY first=$pos placed=$placed " +
                "range=[$topContent,$bottomContent]$dump tbl=$tbl rowH=$rowHeightPx") // TODO(debug)
        }
    }

    /** 二分找第一个 decorated bottom 越过 [scrollY]（含部分露出）的位置，并对齐到行首。 */
    private fun firstVisiblePosition(t: Table, count: Int): Int {
        var lo = 0
        var hi = count - 1
        var ans = count - 1
        while (lo <= hi) {
            val mid = (lo + hi) ushr 1
            if (t.childTopOf[mid] + t.itemHeightOf(mid) > scrollY) {
                ans = mid
                hi = mid - 1
            } else {
                lo = mid + 1
            }
        }
        while (ans > 0 && t.rowStartOf[ans] < ans) ans--
        return ans
    }

    private fun placeChild(recycler: RecyclerView.Recycler, t: Table, pos: Int) {
        val v = try {
            recycler.getViewForPosition(pos)
        } catch (e: Exception) {
            Log.e("AuroraKotlin", "[AdaptiveLM] getViewForPosition($pos) failed", e) // TODO(debug)
            return
        }
        addView(v)
        val w = t.widthOf[pos]
        // 封面高度归一到**本行装箱高**。bind/attach/payload 写的都是档位标称行高
        // rowHeightPx，而行装箱的行高 = 标称 × scale（溢出成行的 scale<1、组末拉伸的
        // scale>1）——不归一的话 item 实高 ≠ 行进距，行与行互相叠压、文件名被下一行
        // 盖住；且落档渲染高度 ≠ 捏合预览（p=1）的目标高度，松手后文件名/裁剪跳变。
        // 这里与 AdaptivePinchController.applyChildReal 写同一个 t.coverHOf 值，
        // 真实布局、捏合模拟、React 版 layout.worker 三方逐位一致。
        if (!t.isHeaderOf[pos]) {
            photoCoverOf(v)?.applyCoverHeight(t.coverHOf[pos])
        }
        calculateItemDecorationsForChild(v, Rect())
        // 宽度精确（行内宽度由装箱给出），高度包内容（封面 lp 高 + 文件名）
        measureChildWithMargins(v, availWidth() - w, 0)
        // 与 relayoutAttached 同一坐标系：view.top = paddingTop + childTopOf - scrollY。
        // 早期版本漏了 -scrollY：滚动中途任何整轮布局（换档冷启动、数据刷新）都把
        // 子视图铺在「未滚动」的内容坐标上，整体下坠 scrollY——页面深处捏合落档后
        // 视口上方露出一大片空白，只能等下一次滚动被 relayoutAttached 洗回。
        val decorTop = paddingTop + t.childTopOf[pos] - t.topInsetOf(pos) - scrollY
        layoutDecoratedWithMargins(
            v,
            paddingLeft + t.xOf[pos],
            decorTop,
            paddingLeft + t.xOf[pos] + w,
            decorTop + t.topInsetOf(pos) + v.measuredHeight,
        )
    }

    private fun recycleOffscreen(recycler: RecyclerView.Recycler, t: Table) {
        // 与 fillVisible 的窗口保持一致（上探一整屏），否则刚回填的行会被立刻回收。
        val aboveExtra = height
        val belowExtra = height * 3 / 2
        val topContent = scrollY - aboveExtra
        val bottomContent = scrollY + height + belowExtra
        for (i in childCount - 1 downTo 0) {
            val c = getChildAt(i) ?: continue
            val pos = getPosition(c)
            if (pos == RecyclerView.NO_POSITION || pos >= t.count) continue
            val bottom = t.childTopOf[pos] + t.itemHeightOf(pos)
            if (bottom < topContent || t.childTopOf[pos] > bottomContent) {
                removeAndRecycleView(c, recycler)
            }
        }
    }

    override fun computeVerticalScrollRange(state: RecyclerView.State): Int {
        val t = table ?: ensureTable(state.itemCount)
        return t.contentBottom + paddingTop + paddingBottom
    }

    override fun computeVerticalScrollOffset(state: RecyclerView.State): Int = scrollY

    override fun computeVerticalScrollExtent(state: RecyclerView.State): Int = height
}

/**
 * 自适应视图的落档：行高变化即**换全新 LM 冷启动**（与瀑布流的 animateStaggeredSpanChange
 * 同构）。真实布局与捏合预览共用 [packAdaptiveRowAt] 一份数学，首个布局从锚点起铺与
 * 预览的目标几何逐位一致，收尾 FLIP 位移为零、零跳变。
 *
 * [pinchAnchor]：捏合预览的锚点。松手换档必须保持同一锚点停在同一屏幕位置；非捏合路径
 * 传 null，退回「top 最小的可见图」扫描。
 */
internal fun animateAdaptiveRowChange(
    rv: RecyclerView,
    oldLm: AuroraAdaptiveLayoutManager,
    newRowHeightPx: Int,
    textHeightPx: Int,
    gapPx: Int,
    ratioAt: (Int) -> Float,
    isFullSpanAt: (Int) -> Boolean,
    durationMs: Long,
    pinchAnchor: PinchAnchor?,
    previewRestorer: (() -> Unit)?,
) {
    if (newRowHeightPx <= 0 || newRowHeightPx == oldLm.rowHeightPx) return

    var anchorPos = RecyclerView.NO_POSITION
    var anchorTop = 0
    if (pinchAnchor != null && pinchAnchor.pos != RecyclerView.NO_POSITION &&
        pinchAnchor.pos < (rv.adapter?.itemCount ?: 0)
    ) {
        anchorPos = pinchAnchor.pos
        anchorTop = pinchAnchor.top
    } else {
        // 与 AdaptivePinchController.begin 同一策略：优先首个顶边完整可见（top ≥ 0）
        // 的图片，退回 top 最小的可见图——钉住几乎滚出视口顶的行会被滚动钳制大幅下拉。
        var bestPos = RecyclerView.NO_POSITION
        var bestTop = 0
        var fullPos = RecyclerView.NO_POSITION
        var fullTop = Int.MAX_VALUE
        for (i in 0 until rv.childCount) {
            val child = rv.getChildAt(i)
            val pos = rv.getChildAdapterPosition(child)
            if (pos == RecyclerView.NO_POSITION || isFullSpanAt(pos)) continue
            if (bestPos == RecyclerView.NO_POSITION || child.top < bestTop) {
                bestPos = pos
                bestTop = child.top
            }
            if (child.top >= 0 && child.top < fullTop) {
                fullPos = pos
                fullTop = child.top
            }
        }
        if (fullPos != RecyclerView.NO_POSITION) {
            anchorPos = fullPos
            anchorTop = fullTop
        } else {
            anchorPos = bestPos
            anchorTop = bestTop
        }
    }
    val snap = captureFlip(rv, anchorPos, anchorTop)
    if (snap == null) return

    val newLm = AuroraAdaptiveLayoutManager(
        rowHeightPx = newRowHeightPx,
        textHeightPx = textHeightPx,
        headerHeightPx = rv.context.dp(HEADER_HEIGHT_DP),
        ratioAt = ratioAt,
        isHeaderAt = isFullSpanAt,
        gapPx = gapPx,
        previewRestorer = previewRestorer,
    )
    rv.layoutManager = newLm
    newLm.scrollToPositionWithOffset(anchorPos, anchorTop)

    Log.d(
        "AuroraKotlin",
        "[FLIP] adaptive row-height change -> $newRowHeightPx anchorPos=$anchorPos " +
            "anchorTop=$anchorTop pinchAnchor=${pinchAnchor != null}",
    )
    runFlipWhenLayoutApplied(
        rv,
        snap,
        "FLIP",
        0,
        // 冷启动判据：新 LM 已挂且已产出 child（捏合预览会改写视图宽度，不能用宽度判据，
        // 与瀑布流冷启动同款理由）。
        layoutApplied = { it.layoutManager === newLm && it.childCount > 0 },
    ) {
        val current = rv.layoutManager as? AuroraAdaptiveLayoutManager
        if (current !== newLm) {
            Log.d("AuroraKotlin", "[FLIP] superseded (lm now $current), skip")
            return@runFlipWhenLayoutApplied
        }
        fixAnchor(rv, anchorPos, anchorTop)
        // fixAnchor 与 playFlip 必须同帧：scrollBy 的位移靠 playFlip 的反向 translation
        // 补偿，分处两帧会裸露未补偿位移（与瀑布流同款要求）。
        playFlip(rv, snap, "FLIP", durationMs)
    }
}

/**
 * **自适应视图的进度驱动捏合 FLIP**（与 [MasonryPinchController] 对称）。
 *
 * 目标档位的行划分由 [packAdaptiveRowAt] 离线模拟（与 LM 布局共用同一份数学，
 * progress=1 的预览与冷启动布局逐位一致），每个可见图按「旧布局 → 新布局」插值
 * x / y / 宽 / 封面高，真实 measure/layout 渲染（文字、圆角全程自然尺寸）。
 *
 * 松手 ≥ 阈值：锚点（position + 钳制后的目标 top）交给换档流程，换全新 LM 冷启动，
 * 收尾 FLIP 位移为零；否则 settle 退回 0。
 */
internal class AdaptivePinchController(
    private val ratioAt: (Int) -> Float,
    private val isHeaderAt: (Int) -> Boolean,
) {

    private var active = false
    private var paddingLeft = 0
    private var paddingTop = 0
    private var paddingBottom = 0
    private var viewportHeight = 0
    private var availWidth = 0
    private var gapPx = 0
    private var headerH = 0
    private var textHeight = 0

    private var anchorPos = RecyclerView.NO_POSITION
    private var anchorTop = 0

    private var targetLevel = -1
    private var targetRowHeight = 0
    private var progress = 0f

    private class SimTables(
        val count: Int,
        val targetRowHeight: Int,
        val childTopOf: IntArray,
        val xOf: IntArray,
        val widthOf: IntArray,
        val coverHOf: IntArray,
        val delta: Int,
    )

    /** 最后一次 applyProgress 所用的模拟表（commitAnchorTop 取其锚点目标）。 */
    private var lastTables: SimTables? = null

    /**
     * 双槽缓存，按 (目标行高, count) 命中——**不能只按 count**：捏合初期手指抖动会让
     * scale 在 1.0 附近摆动、targetLevel 随之在相邻两档间翻转，若命中不看目标行高，
     * 第一份（错误档位的）模拟表会被整个手势复用，预览朝错误几何插值（「不跟手」）。
     * 与 MasonryPinchController 的按 span 双槽缓存对称。
     */
    private var cacheA: SimTables? = null
    private var cacheB: SimTables? = null

    private val origins = HashMap<Int, Rect>()
    private val origCoverH = HashMap<Int, Int>()

    private val lastWrittenH = HashMap<Int, Int>()

    private var settleAnim: ValueAnimator? = null

    val isActive: Boolean get() = active
    val currentProgress: Float get() = progress
    val currentTargetLevel: Int get() = targetLevel

    val pinchAnchorPos: Int get() = anchorPos

    /** 提交换档的锚点视口 top：目标几何越界时的钳制位移 δ 已含在内（与 masonry 一致）。 */
    val commitAnchorTop: Int
        get() {
            val t = lastTables ?: return anchorTop
            return t.childTopOf.getOrNull(anchorPos) ?: anchorTop
        }

    fun begin(rv: RecyclerView, gapPx: Int) {
        settleAnim?.let {
            val anim = it
            settleAnim = null
            anim.cancel()
            if (targetRowHeight > 0) applyProgress(rv, 0f)
        }
        origins.clear()
        origCoverH.clear()
        lastWrittenH.clear()
        progress = 0f
        targetLevel = -1
        targetRowHeight = 0
        paddingLeft = rv.paddingLeft
        paddingTop = rv.paddingTop
        paddingBottom = rv.paddingBottom
        viewportHeight = rv.height
        availWidth = (rv.width - rv.paddingLeft - rv.paddingRight).coerceAtLeast(1)
        this.gapPx = gapPx
        headerH = rv.context.dp(HEADER_HEIGHT_DP)

        // 清上一轮 FLIP/settle 残留 transform：origins 必须是未变换的布局位置
        for (i in 0 until rv.childCount) {
            val c = rv.getChildAt(i) ?: continue
            c.animate().cancel()
            if (c.translationX != 0f || c.translationY != 0f || c.scaleX != 1f || c.scaleY != 1f) {
                c.translationX = 0f
                c.translationY = 0f
                c.scaleX = 1f
                c.scaleY = 1f
            }
        }

        // 锚点 = 首个「顶边完整可见」的图片（top ≥ 0）；没有（视口内全是跨顶边的行）
        // 再退回 top 最小的可见图。header 不参与。
        // 不能简单取 top 最小的可见图：在列表端它往往是一条几乎完全滚出视口顶的行
        // （top 为大负数），目标布局在列表端放不下锚点以下的内容时，钳制位移 δ 会把
        // 整张预览表大幅下移——手势中视口上方露白、落档内容整体下跳（页面“上滚”）。
        var bestPos = RecyclerView.NO_POSITION
        var bestTop = Int.MAX_VALUE
        var bestView: View? = null
        var fullPos = RecyclerView.NO_POSITION
        var fullTop = Int.MAX_VALUE
        var fullView: View? = null
        for (i in 0 until rv.childCount) {
            val child = rv.getChildAt(i)
            val pos = rv.getChildAdapterPosition(child)
            if (pos == RecyclerView.NO_POSITION || isHeaderAt(pos)) continue
            if (child.top < bestTop) {
                bestTop = child.top
                bestPos = pos
                bestView = child
            }
            if (child.top >= 0 && child.top < fullTop) {
                fullTop = child.top
                fullPos = pos
                fullView = child
            }
        }
        val useFull = fullPos != RecyclerView.NO_POSITION
        val anchorView = if (useFull) fullView else bestView
        anchorPos = if (useFull) fullPos else bestPos
        anchorTop = if (useFull) fullTop else bestTop
        val view = anchorView
        if (anchorPos == RecyclerView.NO_POSITION || view == null || view.width <= 0) {
            active = false
            return
        }
        // 文字区高度取 name 视图实测（item root 的第二个子 view）——不用宽高反推，
        // 避免复用视图带着过期封面高度毒化 textHeight（与 masonry 同源的经验）。
        val nameView = (view as? ViewGroup)?.getChildAt(1)
        textHeight = when {
            nameView != null && nameView.height > 0 -> nameView.height
            else -> (view.height - (view.width / ratioAt(bestPos).coerceAtLeast(0.05f)).toInt()).coerceAtLeast(0)
        }
        active = true
        Log.d(
            "AuroraKotlin",
            "[AdaptivePinch] begin anchorPos=$anchorPos anchorTop=$anchorTop " +
                "anchorW=${view.width} anchorH=${view.height} textHeight=$textHeight " +
                "availWidth=$availWidth gap=$gapPx childCount=${rv.childCount}",
        )
    }

    fun update(rv: RecyclerView, newTargetLevel: Int, newTargetRowHeight: Int, newProgress: Float) {
        if (!active) return
        targetLevel = newTargetLevel
        targetRowHeight = newTargetRowHeight
        progress = newProgress.coerceIn(0f, 1f)
        applyProgress(rv, progress)
    }

    fun shouldCommit(): Boolean = progress >= COMMIT_THRESHOLD && targetRowHeight > 0

    fun settle(rv: RecyclerView, duration: Long = FLIP_DURATION_MS) {
        active = false
        settleAnim?.let {
            val anim = it
            settleAnim = null
            anim.cancel()
        }
        val from = progress
        Log.d("AuroraKotlin", "[AdaptivePinch] settle from=$from")
        if (from <= 0f) {
            origins.clear()
            origCoverH.clear()
            progress = 0f
            return
        }
        val lm = rv.layoutManager
        val anim = ValueAnimator.ofFloat(from, 0f)
        anim.duration = (duration * from).toLong().coerceAtLeast(80L)
        anim.interpolator = FLIP_INTERPOLATOR
        anim.addUpdateListener {
            if (rv.layoutManager !== lm) {
                it.cancel()
                return@addUpdateListener
            }
            progress = it.animatedValue as Float
            applyProgress(rv, progress)
        }
        anim.addListener(object : AnimatorListenerAdapter() {
            override fun onAnimationEnd(animation: Animator) {
                if (settleAnim !== animation) return
                settleAnim = null
                origins.clear()
                origCoverH.clear()
                progress = 0f
            }
        })
        settleAnim = anim
        anim.start()
    }

    fun release() {
        active = false
        origins.clear()
        origCoverH.clear()
        progress = 0f
        lastTables = null
        cacheA = null
        cacheB = null
    }

    /** 捏合中新 fill 进来的 item 补上当前进度的手动布局（与 masonry 同款）。 */
    fun applyToNewChild(child: View, position: Int) {
        if (position == RecyclerView.NO_POSITION) return
        if (!active && settleAnim?.isRunning != true) return
        child.post {
            if (!active && settleAnim?.isRunning != true) return@post
            if (targetRowHeight <= 0) return@post
            val rv = child.parent as? RecyclerView ?: return@post
            val count = rv.adapter?.itemCount ?: return@post
            val t = tablesFor(count) ?: return@post
            applyChildReal(child, position, progress, t)
        }
    }

    /** 布局把预览几何洗掉后按当前进度重放（AuroraAdaptiveLayoutManager 每轮布局末尾回调）。 */
    fun reapplyPreview(rv: RecyclerView) {
        if ((active || settleAnim?.isRunning == true) && targetRowHeight > 0) {
            applyProgress(rv, progress)
        }
    }

    private fun applyProgress(rv: RecyclerView, p: Float) {
        if (targetRowHeight <= 0 || anchorPos == RecyclerView.NO_POSITION) return
        val count = rv.adapter?.itemCount ?: 0
        val t = tablesFor(count) ?: return
        lastTables = t
        for (i in 0 until rv.childCount) {
            val child = rv.getChildAt(i)
            val pos = rv.getChildAdapterPosition(child)
            if (pos == RecyclerView.NO_POSITION) continue
            applyChildReal(child, pos, p, t)
        }
    }

    private fun applyChildReal(child: View, pos: Int, p: Float, t: SimTables) {
        if (pos >= t.count) return
        val orig = origins.getOrPut(pos) {
            Rect(child.left, child.top, child.right, child.bottom)
        }
        val oW = orig.width()
        if (oW <= 0) return
        val x = (orig.left + (t.xOf[pos] - orig.left) * p).roundToInt()
        val y = (orig.top + (t.childTopOf[pos] - orig.top) * p).roundToInt()
        val w = (oW + (t.widthOf[pos] - oW) * p).roundToInt()

        val cover = photoCoverOf(child)
        if (cover != null && !isHeaderAt(pos)) {
            val oCover = origCoverH.getOrPut(pos) {
                cover.layoutParams.height.takeIf { it > 0 }
                    ?: cover.height.takeIf { it > 0 }
                    ?: oW
            }
            val wantH = (oCover + (t.coverHOf[pos] - oCover) * p).roundToInt()
            // TODO(debug) 劫持探测：上次写入与当前实测不一致 = 期间被外部改写
            val prevH = lastWrittenH.put(pos, wantH)
            if (prevH != null && cover.height != prevH) {
                Log.d(
                    "AuroraKotlin",
                    "[PrevHijack-A] pos=$pos p=${"%.2f".format(p)} coverH=${cover.height} wrote=$prevH",
                )
            }
            cover.applyCoverHeight(wantH)
        }
        child.forceLayout()
        child.measure(
            View.MeasureSpec.makeMeasureSpec(w, View.MeasureSpec.EXACTLY),
            View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED),
        )
        child.layout(x, y, x + w, y + child.measuredHeight)
    }

    private fun tablesFor(count: Int): SimTables? {
        if (targetRowHeight <= 0 || count <= 0 || anchorPos == RecyclerView.NO_POSITION) return null
        cacheA?.takeIf { it.count == count && it.targetRowHeight == targetRowHeight }?.let { return it }
        cacheB?.takeIf { it.count == count && it.targetRowHeight == targetRowHeight }?.let { return it }
        val t = buildTables(count)
        cacheB = cacheA
        cacheA = t
        return t
    }

    private fun buildTables(count: Int): SimTables {
        val contentChildTop = IntArray(count)
        val xOf = IntArray(count)
        val widthOf = IntArray(count)
        val coverHOf = IntArray(count)

        val avail = availWidth
        var y = 0
        var pos = 0
        while (pos < count) {
            val span = packAdaptiveRowAt(
                pos, count, targetRowHeight, headerH, avail, gapPx, ratioAt, isHeaderAt,
            )
            val topInset = if (pos >= 1) gapPx else 0
            var x = 0
            for (i in span.start until span.end) {
                val w = span.widths[i - span.start]
                contentChildTop[i] = y + topInset
                xOf[i] = x
                widthOf[i] = w
                coverHOf[i] = span.coverH
                x += w + gapPx
            }
            y += topInset + (if (isHeaderAt(span.start)) span.coverH else span.coverH + textHeight)
            pos = span.end
        }

        // 内容坐标 → 视口坐标：锚点**视图**的实际 top（childTopOf 语义，含行顶 inset）
        // 在预览中必须停在 begin 时的 anchorTop。不能对齐 decorated top（额外减一个
        // gap）——那会让锚点连同整张表在手势中整体下沉一个 gap，落档也停在低一个
        // gap 的位置（与 GRID/MASONRY 的「锚点钉死」语义不一致）。
        val shift = contentChildTop[anchorPos] - anchorTop
        for (i in 0 until count) {
            contentChildTop[i] -= shift
            xOf[i] += paddingLeft
        }

        // 滚动可行性钳制（与 masonry 相同）：真实布局的 scrollY 有界，锚点钉在捏合位置
        // 越界时整体平移 δ，预览目标必须做同样的平移，落档才一致。
        var contentTop = Int.MAX_VALUE
        var contentBottom = Int.MIN_VALUE
        for (i in 0 until count) {
            val decoratedTop = contentChildTop[i] - (if (i >= 1) gapPx else 0)
            if (decoratedTop < contentTop) contentTop = decoratedTop
            val bottom = contentChildTop[i] + (if (isHeaderAt(i)) coverHOf[i] else coverHOf[i] + textHeight)
            if (bottom > contentBottom) contentBottom = bottom
        }
        val deltaUpper = paddingTop - contentTop
        val deltaLower = viewportHeight - paddingBottom - contentBottom
        val delta = when {
            deltaLower > 0 -> deltaLower
            deltaUpper < 0 -> deltaUpper
            else -> 0
        }
        if (delta != 0) {
            for (i in 0 until count) contentChildTop[i] += delta
        }
        Log.d(
            "AuroraKotlin",
            "[AdaptivePinch] sim targetH=$targetRowHeight content=[$contentTop,$contentBottom] " +
                "deltaBounds=[$deltaLower,$deltaUpper] delta=$delta",
        )
        return SimTables(count, targetRowHeight, contentChildTop, xOf, widthOf, coverHOf, delta)
    }
}
