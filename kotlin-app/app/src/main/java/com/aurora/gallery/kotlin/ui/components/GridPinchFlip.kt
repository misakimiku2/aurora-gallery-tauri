package com.aurora.gallery.kotlin.ui.components

import android.graphics.Rect
import android.util.Log
import android.view.View
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView

/** 松手时进度达到该值就落到新档位，否则退回原档位。 */
private const val COMMIT_THRESHOLD = 0.5f

/**
 * **进度驱动的 FLIP**：捏合手势 = FLIP 动画的进度条。
 *
 * 与「整块跟手缩放」的区别（后者是错的，会让整个网格像图片一样放大缩小）：
 * 这里每个 item 从**旧档位的布局位置**移动到**新档位的布局位置**——就是 FLIP 该有的位移，
 * 只不过位移的进度不靠时间推进，而是由双指的 `scale` 实时驱动。
 *
 *  - 捏合中：`progress = f(scale)`，item 位置/尺寸在 old↔new 之间线性插值；
 *  - 松手：`progress >= 0.5` 就换档（真改 spanCount，transform 交给换档 FLIP 从当前进度收尾），
 *    否则 `settle()` 退回 0。
 *
 * 捏合期间**不触发布局**——新档位的位置是纯算出来的（列数、间距、文字区高度已知），
 * 不需要真的改 spanCount。这样既流畅，也绕开了 `requestLayout` 被 RV 吞掉那个坑。
 *
 * **锚点**：以第一个可见 item 为基准对齐，保证捏合前后它停在原处，网格不会整体漂移。
 *
 * 只用于 GRID——MASONRY 的行高不固定、ADAPTIVE 的「行」是按宽度堆叠出来的，
 * 两者都无法用简单公式算出新档位的位置，那两个模式走「松手换档 + FLIP」的常规路径。
 */
internal class PinchFlipController {

    private var active = false
    private var paddingLeft = 0
    private var paddingTop = 0
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

    /** 诊断用：update 调用计数，用于节流采样日志。 */
    private var updateCount = 0

    /** position → 捏合前的布局位置。transform 不改 layout 位置，所以这里始终是未变换的坐标。 */
    private val origins = HashMap<Int, Rect>()

    val isActive: Boolean get() = active

    val currentProgress: Float get() = progress

    /** 当前打算切到的目标档位（供松手时决定换到哪一档）。 */
    val currentTargetLevel: Int get() = targetLevel

    fun begin(rv: RecyclerView, gapPx: Int) {
        origins.clear()
        progress = 0f
        targetSpan = 0
        paddingLeft = rv.paddingLeft
        paddingTop = rv.paddingTop
        availWidth = (rv.width - rv.paddingLeft - rv.paddingRight).coerceAtLeast(1)
        gap = gapPx

        anchorPos = firstVisiblePosition(rv)
        val anchorView = if (anchorPos == RecyclerView.NO_POSITION) {
            null
        } else {
            rv.layoutManager?.findViewByPosition(anchorPos)
        }
        if (anchorPos == RecyclerView.NO_POSITION || anchorView == null) {
            // 没有锚点就没法对齐，宁可不启用——否则 -1 / targetSpan 会算出错误行号，
            // 导致整个网格偏移。
            active = false
            return
        }
        anchorTop = anchorView.top
        // grid 下封面是正方形（= item 宽），剩下的就是文字区
        textHeight = (anchorView.height - anchorView.width).coerceAtLeast(0)
        active = true
        Log.d(
            "AuroraKotlin",
            "[Pinch] begin anchorPos=$anchorPos anchorTop=$anchorTop anchorW=${anchorView.width} " +
                "anchorH=${anchorView.height} textHeight=$textHeight availWidth=$availWidth " +
                "gap=$gap paddingTop=$paddingTop childCount=${rv.childCount}",
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
        apply(rv)
        // 诊断「重叠」：每 8 次 update 打印一次可见项的视觉 top。item 按布局顺序（从上到下、从左到右）排列，
        // 视觉 top 应单调不减；一旦出现后面的 top 反而更小（vt < prevTop）就是重叠。
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

    /** 退回原档位：动画回到 progress=0（即 identity）。 */
    fun settle(rv: RecyclerView, duration: Long = FLIP_DURATION_MS) {
        active = false
        for (i in 0 until rv.childCount) {
            rv.getChildAt(i).animate()
                .translationX(0f)
                .translationY(0f)
                .scaleX(1f)
                .scaleY(1f)
                .setDuration(duration)
                .setInterpolator(FLIP_INTERPOLATOR)
                .start()
        }
        origins.clear()
        progress = 0f
    }

    /** 交给换档流程：清状态，但保留当前 transform 作为换档 FLIP 的起点。 */
    fun release() {
        active = false
        origins.clear()
        progress = 0f
    }

    /** 捏合中新 fill 进来的 item 要补上当前进度，否则会以未变换的样子闪现。 */
    fun applyToNewChild(child: View, position: Int) {
        if (!active || position == RecyclerView.NO_POSITION) return
        // 捏合期间本不该触发 bind；一旦发生说明有 item 在捏合中被回收/新建，可能是「重叠」来源
        Log.d("AuroraKotlin", "[Pinch] applyToNewChild pos=$position")
        // bind 阶段 view 还没布局，left/top 是 0，必须等一帧再取
        child.post {
            if (!active) return@post
            val orig = origins.getOrPut(position) {
                Rect(child.left, child.top, child.right, child.bottom)
            }
            applyTo(child, position, orig)
        }
    }

    private fun apply(rv: RecyclerView) {
        for (i in 0 until rv.childCount) {
            val child = rv.getChildAt(i)
            val pos = rv.getChildAdapterPosition(child)
            if (pos == RecyclerView.NO_POSITION) continue
            val orig = origins.getOrPut(pos) {
                Rect(child.left, child.top, child.right, child.bottom)
            }
            applyTo(child, pos, orig)
        }
    }

    private fun applyTo(child: View, pos: Int, orig: Rect) {
        if (targetSpan <= 0 || orig.width() <= 0) return

        val newCellW = (availWidth - (targetSpan - 1) * gap).toFloat() / targetSpan
        // 锚点在新布局中的内容坐标 → 视口坐标的偏移。用它保证锚点 item 原地不动。
        val anchorRow = anchorPos / targetSpan
        val anchorContentY = paddingTop + anchorRow * (newCellW + textHeight + gap)
        val dy = anchorTop - anchorContentY

        val targetX = paddingLeft + (pos % targetSpan) * (newCellW + gap)
        val targetY = paddingTop + (pos / targetSpan) * (newCellW + textHeight + gap) + dy

        val x = orig.left + (targetX - orig.left) * progress
        val y = orig.top + (targetY - orig.top) * progress
        val w = orig.width() + (newCellW - orig.width()) * progress

        // pivot 设左上角，位移公式才对得上；等比缩放（文字区也随之缩放，240ms 内看不出来）
        child.pivotX = 0f
        child.pivotY = 0f
        child.scaleX = w / orig.width()
        child.scaleY = w / orig.width()
        child.translationX = x - orig.left
        child.translationY = y - orig.top
    }

    private fun firstVisiblePosition(rv: RecyclerView): Int {
        // 直接用 LinearLayoutManager.findFirstVisibleItemPosition，和换档时的锚点判据完全一致。
        // 不要自己实现「可见」判据——自己算 decorated 边界 / padding 很容易和框架的
        // findOneVisibleChild 差一行（item 刚露头时 bottom 在 0~paddingTop 之间），
        // 导致捏合锚点与松手换档锚点不一致、maxDelta 巨大、网格错乱。
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
    }
}

/**
 * **瀑布流的进度驱动 FLIP**（与 [PinchFlipController] 的 GRID 版对称）。
 *
 * 瀑布流不等高，无法用行号公式算出新档位位置；但它的列分配是**确定性算法**——
 * 逐 item 放入当前最短的列，而每张图的宽高比已知。所以在 `begin` 后按目标列数
 * **离线模拟**整个布局（每列累计高度），得到每个 item 的目标 (x, y)：
 *
 *  - `docY[pos]`：item 在新档位的文档 y（含 decoration 顶部间距，与 [GridSpacingDecoration]
 *    的「列内每项 +gap」规则一致）；
 *  - `colOf[pos]`：item 落入的列，x = paddingLeft + col * (newCellW + gap)；
 *  - 满宽 header：文档 y = 各列最大值，其后所有列从 header 底部 + gap 继续。
 *
 * 锚点（top 最小的可见图）保持屏幕位置不动，其余 item 相对锚点排布——与 GRID 版一致，
 * 保证捏合不整体漂移；松手 commit 后换档 FLIP 从预览当前位置平滑收敛到真实布局，
 * 模拟与真实布局的微小偏差由收尾动画吸收。
 */
internal class MasonryPinchController(
    /** pos → 图片宽高比（w/h）。header 处不会被查询。 */
    private val ratioAt: (Int) -> Float,
    private val isHeaderAt: (Int) -> Boolean,
) {

    private var active = false
    private var paddingLeft = 0
    private var paddingTop = 0
    private var availWidth = 0
    private var gap = 0
    private var headerH = 0

    /** 锚点：top 最小的可见图及捏合前的屏幕 top。 */
    private var anchorPos = RecyclerView.NO_POSITION
    private var anchorTop = 0

    /** 卡片文字区高度（item 总高 - 封面高），新档位沿用。 */
    private var textHeight = 0

    private var targetSpan = 0
    private var targetLevel = -1
    private var progress = 0f

    /** 模拟结果缓存：span / 可见上限不变就复用，避免每帧重算。 */
    private var simSpan = 0
    private var simLimit = -1
    private var docY = IntArray(0)
    private var colOf = IntArray(0)

    private val origins = HashMap<Int, Rect>()

    val isActive: Boolean get() = active
    val currentProgress: Float get() = progress
    val currentTargetLevel: Int get() = targetLevel

    fun begin(rv: RecyclerView, gapPx: Int) {
        origins.clear()
        progress = 0f
        targetSpan = 0
        targetLevel = -1
        simSpan = 0
        simLimit = -1
        paddingLeft = rv.paddingLeft
        paddingTop = rv.paddingTop
        availWidth = (rv.width - rv.paddingLeft - rv.paddingRight).coerceAtLeast(1)
        gap = gapPx
        headerH = rv.context.dp(HEADER_HEIGHT_DP)

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
        // 瀑布流封面高 = item 宽 / 宽高比，剩下的就是文字区
        val ratio = ratioAt(bestPos).coerceAtLeast(0.05f)
        textHeight = (view.height - (view.width / ratio).toInt()).coerceAtLeast(0)
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
        apply(rv)
    }

    /** 松手后是否应该落到新档位。 */
    fun shouldCommit(): Boolean = progress >= COMMIT_THRESHOLD && targetSpan > 0

    /** 退回原档位：动画回到 identity。 */
    fun settle(rv: RecyclerView, duration: Long = FLIP_DURATION_MS) {
        active = false
        for (i in 0 until rv.childCount) {
            rv.getChildAt(i).animate()
                .translationX(0f)
                .translationY(0f)
                .scaleX(1f)
                .scaleY(1f)
                .setDuration(duration)
                .setInterpolator(FLIP_INTERPOLATOR)
                .start()
        }
        origins.clear()
        progress = 0f
    }

    /** 交给换档流程：清状态，但保留当前 transform 作为换档 FLIP 的起点。 */
    fun release() {
        active = false
        origins.clear()
        progress = 0f
    }

    private fun apply(rv: RecyclerView) {
        if (targetSpan <= 0) return
        var lastPos = -1
        for (i in 0 until rv.childCount) {
            val pos = rv.getChildAdapterPosition(rv.getChildAt(i))
            if (pos != RecyclerView.NO_POSITION && pos > lastPos) lastPos = pos
        }
        if (lastPos < 0 || anchorPos == RecyclerView.NO_POSITION) return
        simulate(rv, lastPos)
        val anchorDoc = docY.getOrNull(anchorPos) ?: return
        val newCellW = (availWidth - (targetSpan - 1) * gap).toFloat() / targetSpan

        for (i in 0 until rv.childCount) {
            val child = rv.getChildAt(i)
            val pos = rv.getChildAdapterPosition(child)
            if (pos == RecyclerView.NO_POSITION || pos > simLimit) continue
            val orig = origins.getOrPut(pos) {
                Rect(child.left, child.top, child.right, child.bottom)
            }
            if (orig.width() <= 0) continue

            if (colOf[pos] < 0) {
                // 满宽 header：随锚点位移整体平移，不缩放
                val targetY = docY[pos] - anchorDoc + anchorTop
                child.pivotX = 0f
                child.pivotY = 0f
                child.scaleX = 1f
                child.scaleY = 1f
                child.translationX = 0f
                child.translationY = (targetY - orig.top) * progress
                continue
            }

            val targetX = paddingLeft + colOf[pos] * (newCellW + gap)
            val targetY = docY[pos] - anchorDoc + anchorTop

            val x = orig.left + (targetX - orig.left) * progress
            val y = orig.top + (targetY - orig.top) * progress
            val w = orig.width() + (newCellW - orig.width()) * progress

            // pivot 左上角，位移公式才对得上；等比缩放（文字区随之缩放，捏合中看不出来）
            child.pivotX = 0f
            child.pivotY = 0f
            child.scaleX = w / orig.width()
            child.scaleY = w / orig.width()
            child.translationX = x - orig.left
            child.translationY = y - orig.top
        }
    }

    /** 按目标列数模拟 [0, limit] 的文档布局（span / limit 不变时复用缓存）。 */
    private fun simulate(rv: RecyclerView, limit: Int) {
        val count = rv.adapter?.itemCount ?: 0
        if (docY.size != count || colOf.size != count) {
            docY = IntArray(count)
            colOf = IntArray(count)
            simSpan = 0
            simLimit = -1
        }
        if (simSpan == targetSpan && simLimit >= limit) return

        val newCellW = (availWidth - (targetSpan - 1) * gap).toFloat() / targetSpan
        val colDocY = IntArray(targetSpan) { paddingTop }
        val top = limit.coerceAtMost(count - 1)
        for (pos in 0..top) {
            if (isHeaderAt(pos)) {
                // 满宽：文档 y = 各列最大值，其后所有列从 header 底 + gap 继续
                var maxTop = colDocY[0]
                for (c in 1 until targetSpan) if (colDocY[c] > maxTop) maxTop = colDocY[c]
                docY[pos] = maxTop
                colOf[pos] = -1
                val next = maxTop + headerH + gap
                for (c in 0 until targetSpan) colDocY[c] = next
            } else {
                var minCol = 0
                for (c in 1 until targetSpan) if (colDocY[c] < colDocY[minCol]) minCol = c
                colOf[pos] = minCol
                docY[pos] = colDocY[minCol]
                val ratio = ratioAt(pos).coerceAtLeast(0.05f)
                val coverH = (newCellW / ratio).toInt().coerceAtLeast(1)
                colDocY[minCol] = docY[pos] + coverH + textHeight + gap
            }
        }
        simSpan = targetSpan
        simLimit = top
    }
}
