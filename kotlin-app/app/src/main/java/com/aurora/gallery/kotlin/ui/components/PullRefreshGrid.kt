package com.aurora.gallery.kotlin.ui.components

import android.view.MotionEvent
import android.view.ViewConfiguration
import android.view.animation.DecelerateInterpolator
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp
import androidx.recyclerview.widget.RecyclerView
import com.aurora.gallery.kotlin.ui.theme.AuroraTheme
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.cos
import kotlin.math.floor
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
 * 指示器是 Compose 侧 40dp 圆点环（12 点、主蓝）：拉距经 React 同款逐帧低通后只在
 * graphicsLayer/draw 阶段被读取，跟手零重组、**零重排**（在 `Modifier.layout` 里读会连带
 * 兄弟 AndroidView 每帧重量 RecyclerView，见 [PullToRefreshIndicator]）。
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

    /** 本次手势是否已掐掉残留的归位动画（每手势一次，不逐帧 cancel）。 */
    private var settleAnimCancelled = false

    /** 本手势不再参与（多指捏合 / 刷新中）：到全部抬起为止。 */
    private var suppressUntilUp = false
    private var startAtTop = false
    private var touchSlopPx = 0

    override fun onInterceptTouchEvent(rv: RecyclerView, ev: MotionEvent): Boolean {
        when (ev.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                downY = ev.y
                pulling = false
                settleAnimCancelled = false
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
                        // 起拉瞬间把基准点挪到手指当前位置：拉距从 0 连续爬升。不挪的话
                        // 拦截那一帧内容会突然跳 2×slop×0.5 px（React 从第一个 move 就跟着走，
                        // 没有这一跳）。
                        downY = ev.y
                        applyPull(rv, 0f)
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
        if (!settleAnimCancelled) {
            // 上一次弹回的 ViewPropertyAnimator 可能仍在跑（刷新完成 300ms 内立刻再下拉必撞）：
            // 它逐帧回写 translationY，会盖掉这里跟手的直接赋值 → 内容来回抖。
            settleAnimCancelled = true
            rv.animate().cancel()
        }
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
        // 先停掉可能仍在跑的弹回动画，再把内容钉到阈值（React：refreshing 时 translateY
        // = threshold）等完成回调；顺序反了会被动画在本帧覆盖回半途。
        rv.animate().cancel()
        rv.translationY = thresholdPx.toFloat()
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
    rv.animate().cancel()
    rv.translationY = thresholdPx.toFloat()
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

/** React rAF tick 的 `diff * 0.35`（每帧向目标拉距靠拢的比例）。 */
private const val SMOOTH_FACTOR = 0.35f

/** 刷新中一轮轮转的时长（React `pull-dot-fade` 1200~1640ms 的近似，同 fix3）。 */
private const val SPIN_DURATION_MS = 1400f

/** 首帧没有参照时间时的兜底帧长（60fps）。 */
private const val DEFAULT_FRAME_MS = 16L

/**
 * 下拉指示器：12 圆点环（React `PullToRefreshIndicator` 的移植）——跟随手指
 * （y = 拉距/2）、刷新时钉在阈值/2 并轮转呼吸、完成画勾、复位上移隐藏。
 *
 * 跟手用 [animDistance]（拉距的逐帧低通值，React rAF `animDistance` 同款），位移与淡入
 * 都只走 `graphicsLayer`/draw 阶段：既无重组也无重排，且位移保留浮点不量化到整像素。
 */
@Composable
fun PullToRefreshIndicator(
    state: PullToRefreshState,
    thresholdPx: Float,
    modifier: Modifier = Modifier,
) {
    val colors = AuroraTheme.colors
    val sizePx = with(LocalDensity.current) { INDICATOR_SIZE.dp.toPx() }
    val animDistance = remember { mutableFloatStateOf(0f) }
    // 刷新中的轮转相位（单位＝点）：React `pull-dot-fade` + 逐点 stagger 的近似
    val phase = remember { mutableFloatStateOf(0f) }

    // React 的 rAF tick 逐字移植：每帧向原始拉距靠拢 35%、差值不足 0.3px 时对齐后停手。
    // 协程里读 state 不产生订阅，因此跟手期间零重组、零重排（只有 layer/draw 失效）。
    LaunchedEffect(state, thresholdPx) {
        var lastFrameNanos = 0L
        while (true) {
            val now = withFrameNanos { it }
            val dtMs = if (lastFrameNanos == 0L) DEFAULT_FRAME_MS else (now - lastFrameNanos) / 1_000_000L
            lastFrameNanos = now
            val busy = state.isRefreshing || state.isComplete
            val cur = animDistance.floatValue
            val target = if (busy) thresholdPx else state.pullDistance
            val diff = target - cur
            if (abs(diff) > 0.3f) {
                animDistance.floatValue = cur + diff * SMOOTH_FACTOR
            } else if (cur != target) {
                animDistance.floatValue = target
            }
            if (busy) {
                val p = (phase.floatValue + dtMs * DOT_COUNT / SPIN_DURATION_MS) % DOT_COUNT
                phase.floatValue = p
            }
        }
    }

    Box(modifier.fillMaxSize()) {
        Canvas(
            Modifier
                .align(Alignment.TopCenter)
                .size(INDICATOR_SIZE.dp)
                // 位移语义对齐 React（transform: translateY(...- size/2)，**圆心**定位）：
                //  - 拉动中：圆心 = 拉距/2 → 圆环从容器上缘被逐渐「拉出来」（顶部先露）；
                //  - 刷新/完成：圆心钉在阈值/2（与满拉位置无缝衔接）；
                //  - 空闲：整体藏在容器上方（由外层 Box 的 clipToBounds 裁掉）。
                .graphicsLayer {
                    val d = animDistance.floatValue
                    val busy = state.isRefreshing || state.isComplete
                    translationY = when {
                        busy -> (thresholdPx - sizePx) / 2f
                        d > 0f -> d / 2f - sizePx / 2f
                        else -> -sizePx
                    }
                    // 淡入（React idle→show 的 opacity 200ms 近似）：拉距前 20% 内 0→1，
                    // 消除「圆环在顶边直接弹出」的闪烁感
                    alpha = if (busy) 1f else (d / (thresholdPx * 0.2f)).coerceIn(0f, 1f)
                },
        ) {
            val d = animDistance.floatValue
            val busy = state.isRefreshing || state.isComplete
            // 空闲态直接不画：藏在上方的画布会从 Box 透出、叠在工具栏上
            //（2026-09-20 用户报障「选择时圆环出现在顶部工具栏中」）
            if (!busy && d <= 0f) return@Canvas
            val dotColor = colors.primary
            val progress = if (thresholdPx <= 0f) 0f else (d / thresholdPx).coerceIn(0f, 1f)
            val activeDots = ceil(progress * DOT_COUNT).toInt()
            val frac = progress * DOT_COUNT - floor(progress * DOT_COUNT)
            val head = floor(phase.floatValue)
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
                        val off = ((i - head) % DOT_COUNT + DOT_COUNT) % DOT_COUNT
                        alpha = 0.25f + 0.75f * (off / (DOT_COUNT - 1))
                        scale = 1f
                    }

                    i < activeDots -> {
                        alpha = 1f
                        scale = 1.15f
                    }

                    // 只有进度头**紧邻的那一颗**按分数点亮（React `index === activeDots`）；
                    // 其余尾部点恒定淡出。此前 else 把 frac 套给了所有 i ≥ activeDots 的点，
                    // frac 随拉距锯齿 0→1 循环十几轮 → 一整圈点同步明暗，即「一闪一闪」。
                    i == activeDots -> {
                        alpha = if (progress > 0f) frac else 0.15f
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
