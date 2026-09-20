package com.aurora.gallery.kotlin.ui.components

import android.view.MotionEvent
import android.view.ViewConfiguration
import android.view.animation.DecelerateInterpolator
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.layout.layout
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.dp
import androidx.recyclerview.widget.RecyclerView
import com.aurora.gallery.kotlin.ui.theme.AuroraTheme
import kotlin.math.ceil
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.roundToInt
import kotlin.math.sin

/**
 * 单指下拉刷新（4.4，对齐 React `usePullToRefresh.ts` + `PullToRefreshIndicator.tsx`）。
 *
 * 交互语义逐条对齐：
 *  - 仅**单指**且列表在顶部时参与；下拉阻尼 `min(maxPull, dy × 0.5)`（threshold=80 /
 *    maxPull=160 / resistance=0.5 同参）；
 *  - 拉过 80dp 松手触发刷新（内容钉在 threshold），否则弹回；
 *  - **双指（捏合）即取消**：任何时刻 pointer 数 > 1 就放弃本次下拉并复位——
 *    与捏合换档（2.2/2.5）互斥；
 *  - 刷新中不参与新手势；扫描完成由宿主调 [finishPullToRefresh]：内容弹回 +
 *    指示器打勾（isComplete），800ms 后完全复位（React COMPLETE_DELAY）。
 *
 * 实现是 `RecyclerView.SimpleOnItemTouchListener`（与捏合监听器同一条拦截路径；注册在
 * 捏合之后：多指事件捏合先拦，轮不到下拉刷新），拖拽期直接 `rv.translationY` 平移内容。
 * 指示器是 Compose 侧 40dp 圆点环（12 点、主蓝），state 只在 placement/draw 阶段读取，
 * 跟手零重组。
 */
class PullToRefreshState {
    /** 阻尼后的下拉距离（px）；0 = 无下拉。 */
    var pullDistance by mutableFloatStateOf(0f)

    /** 已触发刷新（内容钉在 threshold，等宿主完成回调）。 */
    var isRefreshing by mutableStateOf(false)

    /** 刷新完成的打勾展示窗口（[finishPullToRefresh] 置位，800ms 后自动复位）。 */
    var isComplete by mutableStateOf(false)
}

/** React cubic-bezier(0.25, 0.46, 0.45, 0.94)（easeOutQuad 族）的近似。 */
private val PULL_SETTLE_INTERPOLATOR = DecelerateInterpolator(1.6f)

internal class PullToRefreshListener(
    private val state: PullToRefreshState,
    /** 触发阈值（px，React threshold=80 逻辑像素）。 */
    private val thresholdPx: Int,
    /** 最大拉动（px，React maxPull=160）。 */
    private val maxPullPx: Int,
    private val onRefresh: () -> Unit,
) : RecyclerView.SimpleOnItemTouchListener() {

    private var downY = 0f
    private var pulling = false

    /** 本手势不再参与（多指捏合 / 刷新中）：到全部抬起为止。 */
    private var suppressUntilUp = false
    private var startAtTop = false
    private var touchSlopPx = 0

    override fun onInterceptTouchEvent(rv: RecyclerView, ev: MotionEvent): Boolean {
        when (ev.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                downY = ev.y
                pulling = false
                startAtTop = !rv.canScrollVertically(-1)
                suppressUntilUp = state.isRefreshing || state.isComplete
                touchSlopPx = ViewConfiguration.get(rv.context).scaledTouchSlop
            }

            MotionEvent.ACTION_POINTER_DOWN -> {
                // 双指 = 捏合开始：让位给捏合换档，已产生的下拉立即复位
                suppressUntilUp = true
                cancelPull(rv)
            }

            MotionEvent.ACTION_MOVE -> {
                if (suppressUntilUp || state.isRefreshing || state.isComplete) return false
                if (!pulling) {
                    if (!startAtTop) return false
                    val dy = ev.y - downY
                    // 阈值取 2×slop：捏合的第二指落下前的短暂下移不该误触发拦截
                    //（一旦拦截，本次事件流归本监听器，捏合手势作废）
                    if (dy > touchSlopPx * 2 && ev.pointerCount == 1) {
                        pulling = true
                        applyPull(rv, dy)
                        return true
                    }
                } else {
                    applyPull(rv, ev.y - downY)
                    return true
                }
            }

            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                if (!pulling) {
                    suppressUntilUp = false
                    downY = 0f
                }
            }
        }
        return false
    }

    override fun onTouchEvent(rv: RecyclerView, ev: MotionEvent) {
        when (ev.actionMasked) {
            MotionEvent.ACTION_POINTER_DOWN -> {
                // 拖拽中落下第二指：React「touches.length !== 1 → 取消」同款
                suppressUntilUp = true
                pulling = false
                cancelPull(rv)
            }

            MotionEvent.ACTION_MOVE -> {
                if (!suppressUntilUp && !state.isRefreshing) {
                    applyPull(rv, ev.y - downY)
                }
            }

            MotionEvent.ACTION_UP -> {
                suppressUntilUp = false
                if (!state.isRefreshing) {
                    if (state.pullDistance >= thresholdPx) triggerRefresh(rv) else cancelPull(rv)
                }
                pulling = false
            }

            MotionEvent.ACTION_CANCEL -> {
                suppressUntilUp = false
                pulling = false
                if (!state.isRefreshing) cancelPull(rv)
            }
        }
    }

    /** React：dampened = min(maxPull, deltaY × resistance=0.5)，内容 translateY。 */
    private fun applyPull(rv: RecyclerView, dy: Float) {
        val dampened = (dy * 0.5f).coerceIn(0f, maxPullPx.toFloat())
        if (state.pullDistance == dampened) return
        state.pullDistance = dampened
        rv.translationY = dampened
    }

    private fun cancelPull(rv: RecyclerView) {
        if (state.pullDistance <= 0f && rv.translationY == 0f) return
        state.pullDistance = 0f
        rv.animate().translationY(0f)
            .setDuration(300L)
            .setInterpolator(PULL_SETTLE_INTERPOLATOR)
            .start()
    }

    private fun triggerRefresh(rv: RecyclerView) {
        pulling = false
        state.pullDistance = thresholdPx.toFloat()
        // 内容钉在阈值处（React：refreshing 时 translateY = threshold），等完成回调
        rv.translationY = thresholdPx.toFloat()
        rv.animate().cancel()
        onRefresh()
    }
}

/**
 * 刷新完成：指示器打勾（isComplete 窗口 800ms，对齐 React COMPLETE_DELAY），期间内容
 * **保持下移**给指示器留空位（React 同款：complete 超时后内容才弹回）。
 *
 * 两个必须的状态复位（2026-09-20 用户报障「圆环卡在卡片上」的根因）：
 *  - [PullToRefreshState.pullDistance] 归零——否则指示器在 isComplete 结束后按
 *    「拉距/2」永久钉在阈值一半的位置，叠在图片上不消失；
 *  - 内容回位动画放在复位回调里（此前立即弹回，打勾的 800ms 里指示器悬在内容上）。
 */
fun finishPullToRefresh(rv: RecyclerView, state: PullToRefreshState, thresholdPx: Int) {
    state.isRefreshing = false
    state.isComplete = true
    state.pullDistance = thresholdPx.toFloat()
    rv.translationY = thresholdPx.toFloat()
    rv.animate().cancel()
    rv.postDelayed({
        state.isComplete = false
        state.pullDistance = 0f
        rv.animate().translationY(0f)
            .setDuration(300L)
            .setInterpolator(PULL_SETTLE_INTERPOLATOR)
            .start()
    }, 800L)
}

private const val DOT_COUNT = 12
private const val INDICATOR_SIZE = 40f
private const val TRACK_RADIUS = 13f
private const val DOT_RADIUS = 2.2f

/**
 * 下拉指示器：12 圆点环（React `PullToRefreshIndicator` 的移植）——跟随手指
 * （y = 拉距/2）、刷新时钉在阈值/2 并轮转呼吸、完成画勾、复位上移隐藏。
 */
@Composable
fun PullToRefreshIndicator(
    state: PullToRefreshState,
    thresholdPx: Float,
    modifier: Modifier = Modifier,
) {
    val colors = AuroraTheme.colors
    // 刷新中的逐点呼吸（React pull-dot-fade + stagger 的近似）：一个相位轮转出明暗梯度
    val phase by rememberInfiniteTransition(label = "ptr").animateFloat(
        initialValue = 0f,
        targetValue = DOT_COUNT.toFloat(),
        animationSpec = infiniteRepeatable(tween(1400, easing = LinearEasing)),
        label = "phase",
    )
    Box(modifier.fillMaxSize()) {
        Canvas(
            Modifier
                .align(Alignment.TopCenter)
                .size(40.dp)
                // y 位移在 placement 阶段读 state（跟手零重组）；隐藏位 = 容器上方一整个环高
                .layout { measurable, _ ->
                    val p = measurable.measure(Constraints.fixed(40.dp.roundToPx(), 40.dp.roundToPx()))
                    val busy = state.isRefreshing || state.isComplete
                    val ty = when {
                        busy -> thresholdPx / 2f
                        state.pullDistance > 0f -> state.pullDistance / 2f
                        else -> -p.height.toFloat()
                    }
                    layout(p.width, p.height) {
                        p.placeRelative(0, ty.roundToInt())
                    }
                },
        ) {
            // 空闲态直接不画：此前藏在上方的画布会从 Box 透出、叠在工具栏上
            //（2026-09-20 用户报障「选择时圆环出现在顶部工具栏中」）
            if (!(state.isRefreshing || state.isComplete) && state.pullDistance <= 0f) return@Canvas
            val dotColor = colors.primary
            val progress = if (thresholdPx <= 0f) 0f else (state.pullDistance / thresholdPx).coerceIn(0f, 1f)
            val activeDots = ceil(progress * DOT_COUNT)
            val trackR = size.minDimension * (TRACK_RADIUS / INDICATOR_SIZE)
            val dotR = size.minDimension * (DOT_RADIUS / INDICATOR_SIZE)
            val center = Offset(size.width / 2f, size.height / 2f)
            for (i in 0 until DOT_COUNT) {
                val angle = (i * 360f / DOT_COUNT - 90f) * Math.PI.toFloat() / 180f
                val pos = center + Offset(trackR * cos(angle), trackR * sin(angle))
                var alpha = 0.15f
                var scale = 0.7f
                when {
                    state.isComplete -> {
                        alpha = 0f
                        scale = 0f
                    }

                    state.isRefreshing -> {
                        // 相位头之后的点依次衰减
                        val d = ((i - floor(phase)) % DOT_COUNT + DOT_COUNT) % DOT_COUNT
                        alpha = 0.25f + 0.75f * (d / (DOT_COUNT - 1))
                        scale = 1f
                    }

                    i < activeDots -> {
                        alpha = 1f
                        scale = 1.15f
                    }

                    else -> {
                        // 当前点亮起中的分数进度
                        val frac = (progress * DOT_COUNT) - floor(progress * DOT_COUNT)
                        alpha = frac.coerceIn(0.15f, 1f)
                        scale = 0.9f + 0.25f * frac
                    }
                }
                drawCircle(
                    color = dotColor.copy(alpha = alpha * 0.85f),
                    radius = dotR * scale,
                    center = pos,
                )
            }
            if (state.isComplete) {
                drawCircle(
                    color = dotColor.copy(alpha = 0.12f),
                    radius = trackR,
                    center = center,
                )
                val check = Path()
                check.moveTo(center.x - trackR * 0.46f, center.y + trackR * 0.04f)
                check.lineTo(center.x - trackR * 0.12f, center.y + trackR * 0.38f)
                check.lineTo(center.x + trackR * 0.54f, center.y - trackR * 0.31f)
                drawPath(
                    check,
                    color = dotColor.copy(alpha = 0.9f),
                    style = Stroke(width = dotR * 1.36f, cap = StrokeCap.Round, join = StrokeJoin.Round),
                )
            }
        }
    }
}
