package com.aurora.gallery.kotlin.ui.components

import android.animation.Animator
import android.animation.AnimatorListenerAdapter
import android.animation.ValueAnimator
import android.graphics.Rect
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.widget.ImageView
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import androidx.recyclerview.widget.StaggeredGridLayoutManager
import kotlin.math.roundToInt

/** 松手时进度达到该值就落到新档位，否则退回原档位。 */
internal const val COMMIT_THRESHOLD = 0.5f

/**
 * **进度驱动的 FLIP**（GRID 版，与 [MasonryPinchController] 的瀑布流版对称）。
 *
 * 预览用**真实 measure/layout**（理由同瀑布流：transform 缩放式预览的文字、圆角永远不等于
 * 最终布局，松手 `captureFlip` 清 transform → 等新布局 → `playFlip` 的间隙会以自然尺寸闪一帧，
 * 表现为「文件名和圆角跳一下」）：每个可见卡片按「旧布局 → 新布局」的插值几何重新量测、
 * 摆位，文字、圆角全程按自然尺寸渲染，progress=1 的预览与真实布局逐位一致，收尾零跳变。
 *
 * GRID 的网格几何是 position 的纯函数，新档位位置直接解析计算（无需瀑布流的逐 item 模拟）：
 *  - 列边界 [gridSpanBorders] 逐位复刻 GridLayoutManager 1.3.2 的 calculateItemBorders——
 *    totalSpace/spanCount 的**余数会摊给部分列**（各列宽 ±1px），与 Staggered 的均分不同；
 *  - view.left = paddingLeft + 列边界[col] + 左 inset；view 宽 = 列宽 - 左 inset - 右 inset
 *    （GLM measureChild：getSpaceForSpanRange - decorInsets）；inset 与 GridSpacingDecoration
 *    同式：左 = gap*col/span、右 = gap*(span-1-col)/span；
 *  - 封面（SquareImageView）bind 时写显式高度 = applyCellWidth 的 cellPx，行进距 =
 *    cellPx + 文件名高 + gap（第 r 行的顶 inset 恰好贡献每行一个 gap）；
 *  - 只用于 GRID 且无分组（分组标题占整行，行号公式失效，那条路径走「松手换档」）。
 *
 * **锚点** = 第一个可见 item，全程停在捏合前的位置；列表末端钳制（δ）与瀑布流相同：
 * 真实布局的 scrollY 有界，目标几何越界时整体平移 δ，预览与落档一致。
 */
internal class PinchFlipController {

    private var active = false
    private var paddingLeft = 0
    private var paddingTop = 0
    private var paddingBottom = 0
    private var viewportHeight = 0
    private var availWidth = 0
    private var gap = 0

    /** 锚点：第一个可见 item 及其捏合前的 top。 */
    private var anchorPos = RecyclerView.NO_POSITION
    private var anchorTop = 0

    /** 卡片文字区高度（= item 总高 - 封面高），新档位沿用。 */
    private var textHeight = 0

    private var targetSpan = 0
    private var targetLevel = -1
    private var progress = 0f

    /** 某个目标列数的完整目标几何。一次手势至多一个目标档位，双槽缓存够用。 */
    private class SimTables(
        val span: Int,
        /** 新档位下 child 的视口 top / left / 宽（已叠加滚动可行性钳制位移 δ）。 */
        val topOf: IntArray,
        val leftOf: IntArray,
        val widthOf: IntArray,
        /** 新档位的封面显式高度（applyCellWidth 的 cellPx 同式）。 */
        val coverHOf: IntArray,
        /** 钳制位移：真实布局的 scrollY 夹在 [0, maxScroll]，锚点目标随之整体平移。 */
        val delta: Int,
    )

    private var cacheA: SimTables? = null
    private var cacheB: SimTables? = null

    /** 当前 update 正在使用的模拟表（commit 时取其钳制后的锚点目标）。 */
    private var lastTables: SimTables? = null

    /** position → 捏合前的布局位置 / 封面高。预览只是临时改写，真实布局从未被触碰。 */
    private val origins = HashMap<Int, Rect>()
    private val origCoverH = HashMap<Int, Int>()

    /** TODO(debug) 劫持探测：上次预览写入的封面高度；下次进来不一致 = 被外部改写。 */
    private val lastWrittenH = HashMap<Int, Int>()

    /** 退回动画：进度插值回 0 的手动布局重放（结束即恢复原布局，无需 RV 参与）。 */
    private var settleAnim: ValueAnimator? = null

    /** 诊断用：update 调用计数，用于节流采样日志。 */
    private var updateCount = 0

    /** TODO(debug) 手势期间是否有布局/重绑发生过（previewRestorer / applyToNewChild 置位）。 */
    internal var diagLayoutDuringGesture = false
        private set

    /** TODO(debug) */
    internal fun diagMarkLayout() { diagLayoutDuringGesture = true }

    val isActive: Boolean get() = active

    val currentProgress: Float get() = progress

    /** 当前打算切到的目标档位（供松手时决定换到哪一档）。 */
    val currentTargetLevel: Int get() = targetLevel

    /** 捏合锚点（供松手换档保持同一锚点、同一屏幕位置）。 */
    val pinchAnchorPos: Int get() = anchorPos
    val pinchAnchorTop: Int get() = anchorTop

    /**
     * 提交换档应使用的锚点屏幕 top：= 捏合锚点 top + 当前目标档位的钳制位移 δ。
     * 列表末端/顶部内容不足以填满视口时，真实布局的 scrollY 有界，锚点不可能停在
     * 捏合时的位置——预览与落档才一致。
     */
    val commitAnchorTop: Int
        get() {
            val t = lastTables ?: return anchorTop
            return t.topOf.getOrNull(anchorPos) ?: (anchorTop + t.delta)
        }

    fun begin(rv: RecyclerView, gapPx: Int) {
        // 上一轮退回动画若还在跑：先摘牌取消，并把可见项恢复到原布局——origins 必须是
        // 未变换的布局位置，否则本轮预览从错误几何起步。
        settleAnim?.let { anim ->
            settleAnim = null
            anim.cancel()
            if (targetSpan > 0) applyProgress(rv, 0f)
        }
        origins.clear()
        origCoverH.clear()
        lastWrittenH.clear() // TODO(debug) 手势边界清空劫持探测，剩余记录即手势内外部改写
        progress = 0f
        targetSpan = 0
        targetLevel = -1
        // 模拟表以锚点为种子，跨手势必失效——哪怕 span 相同也必须重建。
        cacheA = null
        cacheB = null
        lastTables = null
        paddingLeft = rv.paddingLeft
        paddingTop = rv.paddingTop
        paddingBottom = rv.paddingBottom
        viewportHeight = rv.height
        availWidth = (rv.width - rv.paddingLeft - rv.paddingRight).coerceAtLeast(1)
        gap = gapPx

        // 终止上一轮 FLIP/退回动画并清掉 transform：origins 必须等于未变换的布局位置
        //（手动布局版预览本身无 transform，这里是清上一轮收尾 FLIP 动画的残留）。
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

        anchorPos = firstVisiblePosition(rv)
        val anchorView = if (anchorPos == RecyclerView.NO_POSITION) {
            null
        } else {
            rv.layoutManager?.findViewByPosition(anchorPos)
        }
        if (anchorPos == RecyclerView.NO_POSITION || anchorView == null || anchorView.width <= 0) {
            // 没有锚点就没法对齐，宁可不启用——否则 targetSpan/行号会算出错误位置。
            active = false
            return
        }
        anchorTop = anchorView.top
        // 网格下封面是正方形（= item 宽），剩下的就是文字区
        textHeight = (anchorView.height - anchorView.width).coerceAtLeast(0)
        active = true
        Log.d(
            "AuroraKotlin",
            "[Pinch] begin anchorPos=$anchorPos anchorTop=$anchorTop anchorW=${anchorView.width} " +
                "anchorH=${anchorView.height} textHeight=$textHeight availWidth=$availWidth " +
                "gap=$gap childCount=${rv.childCount}",
        )
    }

    /**
     * @param newTargetLevel 目标档位（由调用方按捏合方向算好）
     * @param newTargetSpan 目标档位的列数
     * @param newProgress 0=旧布局，1=新布局
     */
    fun update(rv: RecyclerView, newTargetLevel: Int, newTargetSpan: Int, newProgress: Float) {
        if (!active) return
        targetLevel = newTargetLevel
        targetSpan = newTargetSpan
        progress = newProgress.coerceIn(0f, 1f)
        applyProgress(rv, progress)
        // 诊断「重叠」：每 8 次 update 打印一次可见项的视觉 top。
        updateCount++
        if (updateCount % 8 == 0) logVisualTops(rv)
    }

    private fun logVisualTops(rv: RecyclerView) {
        val sb = StringBuilder("[Pinch] visual")
        var prevTop = Int.MIN_VALUE
        var overlap = false
        var sampled = 0
        for (i in 0 until rv.childCount) {
            val child = rv.getChildAt(i)
            val pos = rv.getChildAdapterPosition(child)
            if (pos == RecyclerView.NO_POSITION) continue
            val vt = child.top + child.translationY.toInt()
            if (vt < prevTop) overlap = true
            prevTop = vt
            if (sampled % 20 == 0) sb.append(" $pos@$vt")
            sampled++
        }
        sb.append(if (overlap) " OVERLAP" else " ok")
        Log.d("AuroraKotlin", sb.toString())
    }

    /** 松手后是否应该落到新档位。 */
    fun shouldCommit(): Boolean = progress >= COMMIT_THRESHOLD && targetSpan > 0

    /**
     * 退回原档位：进度插值回 0，每帧重放手动布局；结束时可见项几何与原布局逐位一致，
     * 不经 RV 再布局、也不产生 transform 动画（文字/圆角全程自然渲染，无跳变）。
     */
    fun settle(rv: RecyclerView, duration: Long = FLIP_DURATION_MS) {
        active = false
        // 防御性清理：先摘牌再取消，onAnimationEnd 不会把待用的 origins/progress 清掉
        settleAnim?.let { anim ->
            settleAnim = null
            anim.cancel()
        }
        val from = progress
        Log.d("AuroraKotlin", "[PrevDiag] settle from=${"%.2f".format(from)}") // TODO(debug)
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
            // 退回期间布局被整体替换（切模式/换档）时手动几何不再成立，直接放弃
            if (rv.layoutManager !== lm) {
                it.cancel()
                return@addUpdateListener
            }
            progress = it.animatedValue as Float
            applyProgress(rv, progress)
        }
        anim.addListener(object : AnimatorListenerAdapter() {
            override fun onAnimationEnd(animation: Animator) {
                // settleAnim 已被 begin() 摘牌时跳过——状态清理由 begin() 接管
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

    /** 交给换档流程：清状态（保留手动布局几何供收尾 FLIP 捕捉），锚点留给调用方。 */
    fun release() {
        active = false
        origins.clear()
        origCoverH.clear()
        progress = 0f
        lastTables = null
    }

    /** 捏合中新 fill 进来的 item 要补上当前进度的手动布局，否则会以未变换的样子闪现。 */
    fun applyToNewChild(child: View, position: Int) {
        if (position == RecyclerView.NO_POSITION) return
        if (!active && settleAnim?.isRunning != true) return
        child.post {
            if (!active && settleAnim?.isRunning != true) return@post
            if (targetSpan <= 0) return@post
            val rv = child.parent as? RecyclerView ?: return@post
            val count = rv.adapter?.itemCount ?: return@post
            val t = tablesFor(targetSpan, count) ?: return@post
            applyChildReal(child, position, progress, t)
        }
    }

    /**
     * 布局把预览几何洗掉后按当前进度重放（[AuroraGridLayoutManager] 在 onLayoutChildren
     * 末尾回调，经 FileGrid 的 previewRestorer 接线）。与 [MasonryPinchController.reapplyPreview]
     * 对称。
     */
    fun reapplyPreview(rv: RecyclerView) {
        if ((active || settleAnim?.isRunning == true) && targetSpan > 0) {
            Log.d("AuroraKotlin", "[PrevDiag] reapply during gesture p=$progress children=${rv.childCount}") // TODO(debug)
            applyProgress(rv, progress)
        }
    }

    /** 把预览几何应用到当前所有可见 child。进度 p：0=原布局，1=目标档位布局。 */
    private fun applyProgress(rv: RecyclerView, p: Float) {
        if (targetSpan <= 0 || anchorPos == RecyclerView.NO_POSITION) return
        val count = rv.adapter?.itemCount ?: 0
        val t = tablesFor(targetSpan, count) ?: return
        lastTables = t
        for (i in 0 until rv.childCount) {
            val child = rv.getChildAt(i)
            val pos = rv.getChildAdapterPosition(child)
            if (pos == RecyclerView.NO_POSITION) continue
            applyChildReal(child, pos, p, t)
        }
    }

    /**
     * **真实 measure/layout 版预览**：不缩放视图，而是把卡片按插值后的尺寸重新量测、摆位。
     * 文件名、圆角全程自然渲染；progress=1 与新档位的真实布局逐位一致（见类 KDoc 的算术），
     * 松手收尾 FLIP 位移为零、视觉零跳变。封面高度只改 layoutParams.height（**不
     * requestLayout**），由随后的手动 measure 直接消费。
     */
    private fun applyChildReal(child: View, pos: Int, p: Float, t: SimTables) {
        if (pos >= t.topOf.size) return
        val orig = origins.getOrPut(pos) {
            Rect(child.left, child.top, child.right, child.bottom)
        }
        val oW = orig.width()
        if (oW <= 0) return
        val x = (orig.left + (t.leftOf[pos] - orig.left) * p).roundToInt()
        val y = (orig.top + (t.topOf[pos] - orig.top) * p).roundToInt()
        val w = (oW + (t.widthOf[pos] - oW) * p).roundToInt()

        photoCoverOf(child)?.let { cover ->
            val oCover = origCoverH.getOrPut(pos) {
                // 同 Masonry 版：插值起点取 lp 意图值，实测值可能是 FrameLayout 测量缓存
                // 跳过留下的上一条生命周期的过期高度（毒化整轮插值基线）。
                val lpH = cover.layoutParams.height
                lpH.takeIf { it > 0 }
                    ?: cover.height.takeIf { it > 0 }
                    ?: oW
            }
            val wantH = (oCover + (t.coverHOf[pos] - oCover) * p).roundToInt()
            // TODO(debug) 劫持探测：上次写入与当前实际不一致 = 期间被外部改写
            val prevH = lastWrittenH.put(pos, wantH)
            if (prevH != null && cover.height != prevH) {
                Log.d(
                    "AuroraKotlin",
                    "[PrevHijack-G] pos=$pos p=${"%.2f".format(p)} coverH=${cover.height} wrote=$prevH",
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

    private fun tablesFor(span: Int, count: Int): SimTables? {
        if (span <= 0 || count <= 0) return null
        cacheA?.takeIf { it.span == span && it.topOf.size == count }?.let { return it }
        cacheB?.takeIf { it.span == span && it.topOf.size == count }?.let { return it }
        val t = buildTables(span, count)
        cacheB = cacheA
        cacheA = t
        return t
    }

    /**
     * 对整个列表计算目标档位几何（视口坐标，种子 = 锚点行）。GRID 的几何是 position 的
     * 纯函数（行 = pos / span，列 = pos % span），直接解析计算，全量 O(count) 可忽略。
     */
    private fun buildTables(span: Int, count: Int): SimTables {
        val topOf = IntArray(count)
        val leftOf = IntArray(count)
        val widthOf = IntArray(count)
        val coverHOf = IntArray(count)

        val borders = gridSpanBorders(availWidth, span)
        // 封面显式高度与 adapter.applyCellWidth 的 cellPx 完全同式（整数除法），
        // 预览写出的封面高与换档后 bind 的一致
        val cellPx = ((availWidth - (span - 1) * gap) / span).coerceAtLeast(1)
        // 行进距 = 封面 + 文件名 + 行 gap（第 r 行的顶 inset 恰好贡献每行一个 gap）
        val rowAdvance = cellPx + textHeight + gap
        val seed = anchorTop - (anchorPos / span) * rowAdvance

        for (pos in 0 until count) {
            val row = pos / span
            val col = pos % span
            val li = gap * col / span
            val ri = gap * (span - 1 - col) / span
            leftOf[pos] = paddingLeft + borders[col] + li
            widthOf[pos] = borders[col + 1] - borders[col] - li - ri
            coverHOf[pos] = cellPx
            topOf[pos] = seed + row * rowAdvance
        }

        // 滚动可行性钳制（与 MasonryPinchController.buildTables 相同）：
        // 真实布局的 scrollY 夹在 [0, 内容高 - 视口高]，锚点钉在捏合位置越界时，
        // 真实布局会把列表端钉在视口边缘，预览目标必须做同样的整体平移 δ。
        val lastRow = (count - 1) / span
        val contentTop = seed
        val contentBottom = seed + lastRow * rowAdvance + cellPx + textHeight
        val deltaUpper = paddingTop - contentTop
        val deltaLower = viewportHeight - paddingBottom - contentBottom
        val delta = when {
            deltaLower > 0 -> deltaLower
            deltaUpper < 0 -> deltaUpper
            else -> 0
        }
        if (delta != 0) {
            for (p in topOf.indices) topOf[p] += delta
        }
        Log.d(
            "AuroraKotlin",
            "[Pinch] sim span=$span content=[$contentTop,$contentBottom] " +
                "deltaBounds=[$deltaLower,$deltaUpper] delta=$delta",
        )
        return SimTables(span, topOf, leftOf, widthOf, coverHOf, delta)
    }

    private fun firstVisiblePosition(rv: RecyclerView): Int {
        // 直接用 LinearLayoutManager.findFirstVisibleItemPosition，和换档时的锚点判据完全一致，
        // 保证捏合锚点与松手换档锚点一致。
        val lm = rv.layoutManager as? LinearLayoutManager
        return lm?.findFirstVisibleItemPosition() ?: RecyclerView.NO_POSITION
    }

    companion object {
        /** 换档阈值，与 React 版 STEP_THRESHOLD 一致（非进度驱动模式仍用它判断换几档）。 */
        const val STEP_THRESHOLD = 1.08f

        /**
         * **走完整条进度条所需的捏合幅度**。
         *
         * 不能用 STEP_THRESHOLD（1.08）——那是「触发换一次档」的阈值，拿它当行程的话
         * 手指只要捏 8% 动画就跑完全程，快得像瞬间跳档。这里放大到 1.5：
         * 手指要张开/收拢 50% 才把动画推到 100%，中途松手落在哪就是哪。
         */
        const val PROGRESS_FULL_SCALE = 1.5f

        /**
         * 把捏合 scale 换算成 FLIP 进度。
         * 放大（scale>1）走下一档（列数更少），缩小走上一档（列数更多）；
         * 两个方向对称——放大 1.5 倍与缩小到 1/1.5 对应同样的进度。
         */
        fun progressFor(scale: Float): Float =
            if (scale >= 1f) {
                (scale - 1f) / (PROGRESS_FULL_SCALE - 1f)
            } else {
                (1f / scale - 1f) / (PROGRESS_FULL_SCALE - 1f)
            }.coerceIn(0f, 1f)

        /**
         * 逐位复刻 GridLayoutManager 1.3.2 的 [calculateItemBorders]：
         * totalSpace/spanCount 的余数按「additionalSize 累加、跨过阈值就 +1」摊给部分列，
         * 各列宽可能差 1px——不能像 Staggered 那样简单地用 totalSpace/spanCount 均分。
         * 返回长度 spanCount+1 的边界数组，borders[i]..borders[i+1] 为第 i 列的 decorated 区间。
         */
        internal fun gridSpanBorders(availWidth: Int, spanCount: Int): IntArray {
            val borders = IntArray(spanCount + 1)
            borders[0] = 0
            val sizePerSpan = availWidth / spanCount
            val remainder = availWidth % spanCount
            var consumed = 0
            var additionalSize = 0
            for (i in 1..spanCount) {
                var itemSize = sizePerSpan
                additionalSize += remainder
                if (additionalSize > 0 && spanCount - additionalSize < remainder) {
                    itemSize += 1
                    additionalSize -= spanCount
                }
                consumed += itemSize
                borders[i] = consumed
            }
            return borders
        }
    }
}


/** buildPhotoView 的固定结构：root(LinearLayout) → frame(FrameLayout) → cover(ImageView)。
 *  GRID 与 MASONRY 两个捏合控制器都要在手动布局预览里插值封面高度。 */
internal fun photoCoverOf(child: View): ImageView? {
    if (child !is ViewGroup || child.childCount == 0) return null
    val frame = child.getChildAt(0) as? ViewGroup ?: return null
    return if (frame.childCount > 0) frame.getChildAt(0) as? ImageView else null
}

/**
 * **瀑布流的进度驱动 FLIP**（与 [PinchFlipController] 的 GRID 版对称）。
 *
 * 预览用**真实 measure/layout**：每个可见卡片按「旧布局 → 新布局」的插值几何重新量测、
 * 摆位（见 [applyChildReal]），文字、圆角、间距全程按自然尺寸渲染。这是硬性要求——
 * transform 缩放式预览无论怎么插值，其末态（缩小的文字/圆角）都不等于最终布局，松手
 * 必然跳变；真实布局让 progress=1 的预览与冷启动布局逐位一致，收尾 FLIP 位移为零。
 *
 * 新档位的位置来自列分配的**确定性算法**——逐 item 放入当前最短的列。要让「松手后的
 * 真实布局」与「捏合预览的目标位置」逐位一致（FLIP 收尾不跳变），这里的模拟必须逐条
 * 复刻 StaggeredGridLayoutManager 1.3.2 冷启动布局的全部规则
 *（换档时 [com.aurora.gallery.kotlin.ui.components.animateStaggeredSpanChange] 换全新 LM，
 * 首个布局即冷启动，与模拟同构）：
 *
 *  - 所有列从同一条种子线起步（锚点位置），锚点 item 是第一个被铺的、落 col 0；
 *  - 向前逐个放入**底边最小**的列（并列取最左，`getNextSpan` 的 LAYOUT_END 分支）；
 *    向后（锚点之上）逐个放入**顶边最大**的列（LAYOUT_START 分支在垂直方向
 *    `preferLastSpan = true`，扫描从右往左，**并列取最右**——取反了整个上方区域就会镜像错位）；
 *  - 列宽 = innerWidth / span（**整数除法**，与 `updateMeasureSpecs` 的 mSizePerSpan 一致）；
 *    item 左 inset = gap*col/span、右 = gap*(span-1-col)/span（整数除法，与
 *    GridSpacingDecoration 一致）；item 顶 inset = pos >= span ? gap : 0；
 *  - 封面高 = cellW / ratio（整数除法），cellW 与 adapter.applyCellWidth 的 cellPx 完全同式，
 *    保证真实 bind 出来的封面高度和模拟值一致；文字区高度取锚点 item 实测（= 单行文件名高）；
 *  - 满宽 header：压在各列底边最大值上、无 inset；之后所有列从 header 底继续。
 *
 * 锚点（top 最小的可见图）全程屏幕位置不动；真实布局经 fixAnchor 精确落到同一锚点同一
 * 位置，因此 progress=1 的预览 == 换档后的最终布局，松手 FLIP 是预览的自然延伸、零跳变。
 */
internal class MasonryPinchController(
    /** pos → 图片宽高比（w/h）。header 处不会被查询。 */
    private val ratioAt: (Int) -> Float,
    private val isHeaderAt: (Int) -> Boolean,
) {

    private var active = false
    private var paddingLeft = 0
    private var paddingTop = 0
    private var paddingBottom = 0
    private var viewportHeight = 0
    private var availWidth = 0
    private var gap = 0
    private var headerH = 0

    /** 锚点：top 最小的可见图及捏合前的屏幕 top。 */
    private var anchorPos = RecyclerView.NO_POSITION
    private var anchorTop = 0

    /** 卡片文字区高度（item 总高 - 封面高）= 单行文件名高度，新档位沿用。 */
    private var textHeight = 0

    private var targetSpan = 0
    private var targetLevel = -1
    private var progress = 0f

    /** 某个目标列数的完整布局模拟（视口坐标）。捏合中目标档位至多两个，双槽缓存够用。 */
    private class SimTables(
        val span: Int,
        /** -1 = 满宽 header。 */
        val colOf: IntArray,
        /** 新档位下 child 的视口 top / left / 宽（FLIP 目标，已叠加滚动可行性钳制位移 δ）。 */
        val topOf: IntArray,
        val leftOf: IntArray,
        val widthOf: IntArray,
        /** 新档位的封面高（cellW / ratio，与 adapter 同式）；满宽 header 处保持 0。 */
        val coverHOf: IntArray,
        /** 钳制位移：真实布局的 scrollY 夹在 [0, maxScroll]，锚点目标必须随之整体平移。 */
        val delta: Int,
    )

    private var cacheA: SimTables? = null
    private var cacheB: SimTables? = null

    /** 当前 update 正在使用的模拟表（commit 时取其钳制后的锚点目标）。 */
    private var lastTables: SimTables? = null

    /** position → 捏合前的布局位置 / 封面高。预览只是临时改写，真实布局从未被触碰。 */
    private val origins = HashMap<Int, Rect>()
    private val origCoverH = HashMap<Int, Int>()

    /** TODO(debug) 劫持探测（Masonry 版）。 */
    private val lastWrittenH = HashMap<Int, Int>()

    /** TODO(debug) lp 层劫持探测（Masonry 版）。 */
    private val lastWrittenLp = HashMap<Int, Int>()

    /** 退回动画：进度插值回 0 的手动布局重放（结束即恢复原布局，无需 RV 参与）。 */
    private var settleAnim: ValueAnimator? = null

    /** 诊断用：update 调用计数，用于节流采样日志。 */
    private var updateCount = 0

    val isActive: Boolean get() = active
    val currentProgress: Float get() = progress
    val currentTargetLevel: Int get() = targetLevel

    /** 捏合锚点（供松手换档保持同一锚点、同一屏幕位置）。 */
    val pinchAnchorPos: Int get() = anchorPos
    val pinchAnchorTop: Int get() = anchorTop

    /**
     * 提交换档应使用的锚点屏幕 top：= 捏合锚点 top + 当前目标档位的钳制位移 δ。
     * 列表底部/顶部内容不足以填满视口时，真实布局的 scrollY 有界，锚点不可能停在
     * 捏合时的位置——必须随「列表末端钉在视口边缘」整体平移，预览与落档才一致。
     */
    val commitAnchorTop: Int get() {
        val t = lastTables ?: return anchorTop
        return t.topOf.getOrNull(anchorPos) ?: (anchorTop + t.delta)
    }

    fun begin(rv: RecyclerView, gapPx: Int) {
        // 上一轮退回动画若还在跑：先摘牌取消（onAnimationEnd 不再清状态），并把可见项
        // 恢复到原布局——origins 必须是未变换的布局位置，否则本轮预览从错误几何起步。
        settleAnim?.let {
            val anim = it
            settleAnim = null
            anim.cancel()
            if (targetSpan > 0) applyProgress(rv, 0f)
        }
        origins.clear()
        origCoverH.clear()
        lastWrittenH.clear() // TODO(debug) 手势边界清空劫持探测，剩余记录即手势内外部改写
        lastWrittenLp.clear() // TODO(debug)
        progress = 0f
        targetSpan = 0
        targetLevel = -1
        updateCount = 0 // TODO(debug) 让 FrameProbe 每次手势都重启
        // 模拟表以锚点位置为种子，跨手势必失效——哪怕 span 相同也必须重建，
        // 否则新锚点的目标全错（日志上表现为 sim 行不再打印、预览目标停在旧位置）。
        cacheA = null
        cacheB = null
        lastTables = null
        paddingLeft = rv.paddingLeft
        paddingTop = rv.paddingTop
        paddingBottom = rv.paddingBottom
        viewportHeight = rv.height
        availWidth = (rv.width - rv.paddingLeft - rv.paddingRight).coerceAtLeast(1)
        gap = gapPx
        headerH = rv.context.dp(HEADER_HEIGHT_DP)

        // 终止上一轮 FLIP/退回动画并清掉 transform：origins 必须等于未变换的布局位置，
        // 否则上一轮动画的残留会叠加进本轮插值（收尾动画没跑完就再捏会跳）。
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

        // 锚点 = top 最小的可见「图片」item（header 不参与：它没有宽高比，不缩放）
        var bestPos = RecyclerView.NO_POSITION
        var bestTop = Int.MAX_VALUE
        var bestView: View? = null
        for (i in 0 until rv.childCount) {
            val child = rv.getChildAt(i)
            val pos = rv.getChildAdapterPosition(child)
            if (pos == RecyclerView.NO_POSITION || isHeaderAt(pos)) continue
            if (child.top < bestTop) {
                bestTop = child.top
                bestPos = pos
                bestView = child
            }
        }
        val view = bestView
        if (bestPos == RecyclerView.NO_POSITION || view == null || view.width <= 0) {
            active = false
            return
        }
        anchorPos = bestPos
        anchorTop = bestTop
        // 瀑布流封面高 = item 宽 / 宽高比（bind 时按旧 cellWidth 设置，实测值即旧封面高），
        // 两者相减正好是文字区（单行文件名）的真实高度，新档位沿用。
        val ratio = ratioAt(bestPos).coerceAtLeast(0.05f)
        // TODO(debug) 锚点数据/视图对照：两个比例不一致 = items 与实际显示错位（裁剪手势的源头）
        val aCover = coverOf(view)
        Log.d(
            "AuroraKotlin",
            "[PrevDiag-M] begin pos=$bestPos dataRatio=$ratio viewW=${view.width} " +
                "coverH=${aCover?.height} impliedRatio=" +
                (aCover?.let { view.width.toFloat() / it.height.coerceAtLeast(1) } ?: -1f),
        )
        // 文字区高度直接量 name view（item root 的第二个子 view）——不要用
        // 「view.height - 宽/ratio」反推：缓存复用的 view 可能带着上一个档位的封面高度
        //（不走 bind、无人归一时），反推出的 textHeight 会被毒化（实测出现过 0/151/202），
        // 整张模拟表的行进距随之全错，预览全程把封面插向错误高度（「捏合裁剪」的来源之一）。
        val nameView = (view as? ViewGroup)?.getChildAt(1)
        textHeight = when {
            nameView != null && nameView.height > 0 -> nameView.height
            else -> (view.height - (view.width / ratio).toInt()).coerceAtLeast(0)
        }
        active = true
        Log.d(
            "AuroraKotlin",
            "[MasonryPinch] begin anchorPos=$anchorPos anchorTop=$anchorTop " +
                "anchorW=${view.width} anchorH=${view.height} textHeight=$textHeight " +
                "availWidth=$availWidth gap=$gap childCount=${rv.childCount}",
        )
    }

    /**
     * @param newTargetLevel 目标档位（调用方按捏合方向算好）
     * @param newTargetSpan 目标档位列数
     * @param newProgress 0=旧布局，1=新布局
     */
    fun update(rv: RecyclerView, newTargetLevel: Int, newTargetSpan: Int, newProgress: Float) {
        if (!active) return
        targetLevel = newTargetLevel
        targetSpan = newTargetSpan
        progress = newProgress.coerceIn(0f, 1f)
        applyProgress(rv, progress)
        // 诊断「重叠」：每 8 次 update 打印一次可见项的视觉 top。item 按布局顺序排列，
        // 视觉 top 应单调不减；出现更小的 top 即重叠。
        updateCount++
        if (updateCount % 8 == 0) logVisualTops(rv)
        if (updateCount == 1) startFrameProbe(rv) // TODO(debug) 每帧几何快照
    }

    /**
     * TODO(debug) 手势期间每帧快照前几个可见卡片的完整几何（item top/height、cover lp/实测、
     * frame 实测、name top），捕捉两次 update 之间的渲染帧跳变。update 回调层的
     * 数据已验证平滑（visual 单调、劫持仅 ±1px），若仍见闪动则跳变发生在帧层。
     * lp 高度与实测高度不一致 = measure 链路（FrameLayout 缓存）吞掉了写入；
     * lp 高度本身突变 = 有其他代码在捏合中途改写 lp。
     */
    private fun startFrameProbe(rv: RecyclerView) {
        var lastSig = ""
        var frames = 0
        val cb = object : android.view.Choreographer.FrameCallback {
            override fun doFrame(time: Long) {
                if (!active || frames > 600) return
                frames++
                var idx = 0
                val sb = StringBuilder("[FrameProbe]")
                for (i in 0 until rv.childCount) {
                    val c = rv.getChildAt(i) ?: continue
                    val p = rv.getChildAdapterPosition(c)
                    if (p == RecyclerView.NO_POSITION) continue
                    val vg = c as? ViewGroup ?: continue
                    val frame = vg.getChildAt(0) as? ViewGroup ?: continue
                    val cover = frame.getChildAt(0)
                    val name = vg.getChildAt(1)
                    sb.append(
                        " $p:${c.top},${c.height}" +
                            "/lp${cover.layoutParams.height}" +
                            "/m${cover.height}" +
                            "/f${frame.height}" +
                            "/n${name.top}",
                    )
                    if (++idx == 6) break
                }
                val sig = sb.toString()
                if (sig != lastSig) {
                    Log.d("AuroraKotlin", sig)
                    lastSig = sig
                }
                android.view.Choreographer.getInstance().postFrameCallback(this)
            }
        }
        android.view.Choreographer.getInstance().postFrameCallback(cb)
    }

    private fun logVisualTops(rv: RecyclerView) {
        val sb = StringBuilder("[MasonryPinch] visual")
        var sampled = 0
        for (i in 0 until rv.childCount) {
            val child = rv.getChildAt(i)
            val pos = rv.getChildAdapterPosition(child)
            if (pos == RecyclerView.NO_POSITION) continue
            val top = child.top + child.translationY.toInt()
            if (sampled % 20 == 0) sb.append(" $pos@$top")
            sampled++
        }
        // 注：跨列迁移的卡在预览中途会与邻列短暂交叠，这是列数变化 FLIP 的固有观感；
        // 落位由真实布局决定，不在此检查（布局自身不会产生重叠）。
        Log.d("AuroraKotlin", sb.toString())
    }

    /** 松手后是否应该落到新档位。 */
    fun shouldCommit(): Boolean = progress >= COMMIT_THRESHOLD && targetSpan > 0

    /**
     * 退回原档位：进度插值回 0，每帧重放手动布局；结束时可见项几何与原布局逐位一致，
     * 不经 RV 再布局、也不产生 transform 动画（文字/圆角全程自然渲染，无跳变）。
     */
    fun settle(rv: RecyclerView, duration: Long = FLIP_DURATION_MS) {
        active = false
        // 防御性清理：先摘牌再取消，onAnimationEnd 不会把待用的 origins/progress 清掉
        settleAnim?.let { anim ->
            settleAnim = null
            anim.cancel()
        }
        val from = progress
        Log.d("AuroraKotlin", "[PrevDiag] settle from=${"%.2f".format(from)}") // TODO(debug)
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
            // 退回期间布局被整体替换（切模式/换档冷启动）时手动几何不再成立，直接放弃
            if (rv.layoutManager !== lm) {
                it.cancel()
                return@addUpdateListener
            }
            progress = it.animatedValue as Float
            applyProgress(rv, progress)
        }
        anim.addListener(object : AnimatorListenerAdapter() {
            override fun onAnimationEnd(animation: Animator) {
                // settleAnim 已被 begin() 摘牌时跳过——状态清理由 begin() 接管
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

    /** 交给换档流程：清状态（保留手动布局几何供收尾 FLIP 捕捉），锚点留给调用方。 */
    fun release() {
        active = false
        origins.clear()
        origCoverH.clear()
        progress = 0f
        lastTables = null
    }

    /** 捏合中新 fill 进来的 item 要补上当前进度的手动布局，否则会以未变换的样子闪现。 */
    fun applyToNewChild(child: View, position: Int) {
        if (position == RecyclerView.NO_POSITION) return
        if (!active && settleAnim?.isRunning != true) return
        child.post {
            if (!active && settleAnim?.isRunning != true) return@post
            if (targetSpan <= 0) return@post
            val rv = child.parent as? RecyclerView ?: return@post
            val count = rv.adapter?.itemCount ?: return@post
            val t = tablesFor(targetSpan, count) ?: return@post
            applyChildReal(child, position, progress, t)
        }
    }

    /**
     * 布局把预览几何洗掉后按当前进度重放（[AuroraStaggeredLayoutManager] 在 onLayoutChildren
     * 末尾回调，经 FileGrid 的 previewRestorer 接线）。
     *
     * 捏合/退回期间的任何布局——尤其是「进捏合时补预填」主动触发的那轮——都会把手动
     * measure/layout 的结果冲回 LM 布局；若不在同一次布局里重放，预览会闪回原布局一帧。
     * 非捏合/非退回期为空操作。
     */
    fun reapplyPreview(rv: RecyclerView) {
        if ((active || settleAnim?.isRunning == true) && targetSpan > 0) {
            Log.d("AuroraKotlin", "[PrevDiag] reapply during gesture p=$progress children=${rv.childCount}") // TODO(debug)
            applyProgress(rv, progress)
        }
    }

    /** 把预览几何应用到当前所有可见 child。进度 p：0=原布局，1=新档位布局。 */
    private fun applyProgress(rv: RecyclerView, p: Float) {
        if (targetSpan <= 0 || anchorPos == RecyclerView.NO_POSITION) return
        val count = rv.adapter?.itemCount ?: 0
        val t = tablesFor(targetSpan, count) ?: return
        lastTables = t
        for (i in 0 until rv.childCount) {
            val child = rv.getChildAt(i)
            val pos = rv.getChildAdapterPosition(child)
            if (pos == RecyclerView.NO_POSITION) continue
            applyChildReal(child, pos, p, t)
        }
    }

    /**
     * **真实 measure/layout 版预览**：不缩放视图，而是把卡片按插值后的尺寸重新量测、摆位。
     *
     * 旧实现用 scale/translation 做预览——文字、圆角、列距全部跟着 scale 缩小，无论进度
     * 多少，「FLIP 最后的样子」永远不等于最终布局（最终布局文字是自然大小、圆角 12dp），
     * 松手必然再跳一下。手动布局让 progress=1 的预览与冷启动布局逐位一致（列宽、封面高
     * 与 adapter/LM 完全同式，文字自然渲染），收尾 FLIP 位移为零，视觉零跳变。RV 在下一
     * 次布局前不感知这次改写；退回到 0 或换档冷启动都会自然恢复真实布局。
     *
     * 封面高度只改 layoutParams.height（**不 requestLayout**——它会沿视图树上抛给 RV），
     * 由随后的手动 measure 直接消费。
     */
    private fun applyChildReal(child: View, pos: Int, p: Float, t: SimTables) {
        if (pos >= t.colOf.size) return
        val orig = origins.getOrPut(pos) {
            Rect(child.left, child.top, child.right, child.bottom)
        }
        val oW = orig.width()
        if (oW <= 0) return
        val x = (orig.left + (t.leftOf[pos] - orig.left) * p).roundToInt()
        val y = (orig.top + (t.topOf[pos] - orig.top) * p).roundToInt()
        val w = (oW + (t.widthOf[pos] - oW) * p).roundToInt()

        if (t.colOf[pos] >= 0) {
            val cover = coverOf(child)
            if (cover != null) {
                val oCover = origCoverH.getOrPut(pos) {
                    // TODO(debug) 插值起点污染探测：实测高度 ≠ lp 高度 = 捕获到了过期测量
                    val lpH = cover.layoutParams.height
                    val mH = cover.height
                    if (lpH > 0 && mH > 0 && kotlin.math.abs(lpH - mH) > 2) {
                        Log.d(
                            "AuroraKotlin",
                            "[OrigCoverPoison-M] pos=$pos lp=$lpH measured=$mH",
                        )
                    }
                    // 插值起点必须取 lp（bind/attach/上轮预览写入的**意图值**），不能取实测
                    // 高度——实测值可能带着 FrameLayout 测量缓存跳过留下的上一条生命周期
                    // 的过期高度，把整轮手势的插值基线毒化（「捏合全程裁剪」的来源之一）。
                    lpH.takeIf { it > 0 }
                        ?: mH.takeIf { it > 0 }
                        ?: (oW / ratioAt(pos).coerceAtLeast(0.05f)).toInt()
                }
                val wantH = (oCover + (t.coverHOf[pos] - oCover) * p).roundToInt()
                // TODO(debug) 劫持探测（lp 层）：上次预览写入后 lp 被谁改了（bind/attach/payload 都写 lp）
                val lp = cover.layoutParams.height
                val prevLp = lastWrittenLp.put(pos, wantH)
                if (prevLp != null && lp != prevLp) {
                    Log.d(
                        "AuroraKotlin",
                        "[PrevHijackLp-M] pos=$pos p=${"%.2f".format(p)} lpNow=$lp wrote=$prevLp",
                    )
                }
                // TODO(debug) 劫持探测（实测层）：上次写入与当前实测不一致 = 测量链路吞掉写入
                val prevH = lastWrittenH.put(pos, wantH)
                if (prevH != null && cover.height != prevH) {
                    Log.d(
                        "AuroraKotlin",
                        "[PrevHijack-M] pos=$pos p=${"%.2f".format(p)} coverH=${cover.height} wrote=$prevH",
                    )
                }
                cover.applyCoverHeight(wantH)
            }
        }
        child.forceLayout()
        child.measure(
            View.MeasureSpec.makeMeasureSpec(w, View.MeasureSpec.EXACTLY),
            View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED),
        )
        child.layout(x, y, x + w, y + child.measuredHeight)
    }

    /** buildPhotoView 的固定结构：root(LinearLayout) → frame(FrameLayout) → cover(ImageView)。 */
    private fun coverOf(child: View): ImageView? = photoCoverOf(child)

    private fun tablesFor(span: Int, count: Int): SimTables? {
        if (span <= 0 || count <= 0) return null
        cacheA?.takeIf { it.span == span && it.colOf.size == count }?.let { return it }
        cacheB?.takeIf { it.span == span && it.colOf.size == count }?.let { return it }
        val t = buildTables(span, count)
        cacheB = cacheA
        cacheA = t
        return t
    }

    /**
     * 按目标列数对**整个列表**做文档级模拟（视口坐标，种子 = 锚点行）。
     *
     * 全量模拟（而非只算可见范围）：Staggered 的滚动增量 fill 会沿着同一条确定性链继续铺，
     * 全量结果与「最终会被铺出来的布局」逐位一致；捏合预览压缩内容时，预填区 item 也有目标位。
     * 每个目标列数只算一次（双槽缓存），13k 量级 item 一次遍历成本可忽略。
     */
    private fun buildTables(span: Int, count: Int): SimTables {
        val colOf = IntArray(count)
        val topOf = IntArray(count)
        val leftOf = IntArray(count)
        val widthOf = IntArray(count)
        val coverHOf = IntArray(count)

        // 与 adapter.applyCellWidth 的 cell 完全同式（整数除法），封面高才能逐位一致
        val cellW = ((availWidth - (span - 1) * gap) / span).coerceAtLeast(1)
        // 与 StaggeredGridLayoutManager.updateMeasureSpecs 的 mSizePerSpan 一致（整数除法）
        val sizePerSpan = availWidth / span

        fun coverH(pos: Int): Int = (cellW / ratioAt(pos).coerceAtLeast(0.05f)).toInt().coerceAtLeast(1)
        fun topInset(pos: Int): Int = if (pos >= span) gap else 0

        // 种子线：冷启动布局里所有列同线起铺、锚点是第一个 item。真实布局最终经 fixAnchor
        // 平移到「锚点 top == anchorTop」；相对几何在平移前后不变，所以种子 = anchorTop - 锚点
        // 自身的顶部 inset，模拟出的绝对坐标就是最终布局坐标。
        val seed = anchorTop - topInset(anchorPos)
        val colEnd = IntArray(span) { seed }
        val colTop = IntArray(span) { seed }

        // 向前：锚点..末尾，逐个放入底边最小的列（并列取最左）
        for (pos in anchorPos until count) {
            if (isHeaderAt(pos)) {
                var line = colEnd[0]
                for (s in 1 until span) if (colEnd[s] > line) line = colEnd[s]
                colOf[pos] = -1
                topOf[pos] = line
                leftOf[pos] = paddingLeft
                widthOf[pos] = availWidth
                for (s in 0 until span) {
                    colEnd[s] = line + headerH
                    if (line < colTop[s]) colTop[s] = line
                }
            } else {
                var best = 0
                for (s in 1 until span) if (colEnd[s] < colEnd[best]) best = s
                val inset = topInset(pos)
                val li = gap * best / span
                val ri = gap * (span - 1 - best) / span
                colOf[pos] = best
                topOf[pos] = colEnd[best] + inset
                leftOf[pos] = paddingLeft + best * sizePerSpan + li
                widthOf[pos] = sizePerSpan - li - ri
                coverHOf[pos] = coverH(pos)
                colEnd[best] = topOf[pos] + coverH(pos) + textHeight
            }
        }

        // 向后：锚点之上，逐个放入顶边最大的列。注意 1.3.2 的 preferLastSpan 在
        // 「垂直 + LAYOUT_START」返回 true——列扫描是从 spanCount-1 往回走、strict >，
        // 所以并列时取的是**最右**列（与向前方向的并列取最左相反），这里必须同序。
        for (pos in anchorPos - 1 downTo 0) {
            if (isHeaderAt(pos)) {
                var line = colTop[0]
                for (s in 1 until span) if (colTop[s] < line) line = colTop[s]
                colOf[pos] = -1
                topOf[pos] = line - headerH
                leftOf[pos] = paddingLeft
                widthOf[pos] = availWidth
                for (s in 0 until span) colTop[s] = topOf[pos]
            } else {
                var best = span - 1
                for (s in span - 2 downTo 0) if (colTop[s] > colTop[best]) best = s
                val inset = topInset(pos)
                val li = gap * best / span
                val ri = gap * (span - 1 - best) / span
                colOf[pos] = best
                topOf[pos] = colTop[best] - (coverH(pos) + textHeight)
                leftOf[pos] = paddingLeft + best * sizePerSpan + li
                widthOf[pos] = sizePerSpan - li - ri
                coverHOf[pos] = coverH(pos)
                colTop[best] = topOf[pos] - inset
            }
        }

        // 滚动可行性钳制。真实布局的 scrollY 夹在 [0, paddingTop + H + paddingBottom - 视口高]，
        // 即「列表顶端不低于视口顶、列表末端不高于视口底」。锚点钉在捏合时的屏幕位置只有当
        // 目标几何落在该区间内才可达；越界时真实布局会把**列表末端**钉在视口边缘（Staggered
        // 也拒绝向短边滚动），所以预览目标必须做同样的整体平移 δ，否则落档 FLIP 全屏漂移：
        //   δ 上界：锚点不能再往上 → 列表顶边钉在视口顶（paddingTop）；
        //   δ 下界：锚点不能再往下 → 列表底边钉在视口底（视口高 - paddingBottom）。
        var contentTop = Int.MAX_VALUE
        var contentBottom = Int.MIN_VALUE
        for (s in 0 until span) {
            if (colTop[s] < contentTop) contentTop = colTop[s]
            if (colEnd[s] > contentBottom) contentBottom = colEnd[s]
        }
        val deltaUpper = paddingTop - contentTop
        val deltaLower = viewportHeight - paddingBottom - contentBottom
        val delta = when {
            deltaLower > 0 -> deltaLower
            deltaUpper < 0 -> deltaUpper
            else -> 0
        }
        if (delta != 0) {
            for (p in topOf.indices) topOf[p] += delta
        }
        Log.d(
            "AuroraKotlin",
            "[MasonryPinch] sim span=$span content=[$contentTop,$contentBottom] " +
                "deltaBounds=[$deltaLower,$deltaUpper] delta=$delta",
        )
        return SimTables(span, colOf, topOf, leftOf, widthOf, coverHOf, delta)
    }
}
