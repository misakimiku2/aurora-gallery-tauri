package com.aurora.gallery.kotlin.ui.components

import android.os.Handler
import android.os.Looper
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.grid.LazyGridItemInfo
import androidx.compose.foundation.lazy.grid.LazyGridState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.recyclerview.widget.RecyclerView
import kotlin.math.ceil
import kotlin.math.roundToInt


// —— 尺寸常量（dp）——
/**
 * 拇指宽度（静止）。手机上要能用手指按住，4dp 那种「细条」按不住（2026-10-08 指挥官实测：
 * 完全点不到）。这里取 8dp 常驻——它是一条**悬浮在内容上的滑块**，不是嵌在界面里的滑槽。
 */
private val THUMB_WIDTH_DP = 16.dp

/** 拇指宽度（拖动中）：加粗是「抓住了」的唯一视觉反馈。 */
private val THUMB_ACTIVE_WIDTH_DP = 20.dp

/**
 * 拇指**固定**高度（不随内容多少变长变短）——指挥官 2026-10-08 定的：就按最小那一档，
 * 一眼就能认出是「滑块」而不是「滚动进度条」。
 */
private val THUMB_HEIGHT_DP = 36.dp

/** 拇指距容器右缘。 */
private val THUMB_MARGIN_DP = 3.dp

/** 轨道上下留白：拇指不贴顶/贴底，避免与顶栏浮层、底部操作条打架。 */
private val TRACK_PADDING_DP = 6.dp

/** 触摸热区宽度（自右缘向左）。 */
private val TOUCH_WIDTH_DP = 44.dp

/**
 * 条目数阈值：少于这个数**根本不显示滚动条**（2026-10-08 指挥官定）。内容就一屏多一点点
 * 时，一条滑块除了挡视线没有任何用处。
 */
private const val MIN_ITEM_COUNT = 100

/** 两端小三角的底边宽（× 拇指宽）与高（× 拇指宽）。 */
private const val ARROW_WIDTH_RATIO = 0.46f
private const val ARROW_HEIGHT_RATIO = 0.32f

// —— 时序常量 ——
/** 停止滚动后多久隐藏。 */
private const val AUTO_HIDE_MS = 900L

private const val FADE_IN_MS = 100
private const val FADE_OUT_MS = 320

/**
 * 滚动度量源：controller **只认这个接口**，不关心底下是原生 RecyclerView（网格/文件夹）
 * 还是 Compose LazyVerticalGrid（专题/标签）。
 *
 * 两套实现见 [RvScrollMetrics] 与 [LazyGridScrollMetrics]。
 */
interface ScrollMetrics {
    /** 条目总数：少于 [MIN_ITEM_COUNT] 时滚动条整体不显示。 */
    val itemCount: Int

    /** 内容总高（px，估算值即可）。 */
    val scrollRangePx: Int

    /** 视口高（px）。 */
    val scrollExtentPx: Int

    /** 当前滚动偏移（px）。 */
    val scrollOffsetPx: Int

    /** 按像素增量滚动（正 = 内容上移 / 页面往下走）。 */
    fun scrollByPx(dy: Int)

    /** 拖动开始时掐掉惯性。Lazy 系列没有惯性可掐，空实现即可。 */
    fun stopScroll()

    /**
     * 安装滚动通知。返回一个卸载函数（不需要通知的返回 `{}`）。三个回调分工不同，别合并：
     *  - [onGeometry]：**任何**滚动都要刷几何（含程序化 scrollBy，如拖动、换档 FLIP、
     *    恢复滚动位置）——只更新 [GridScrollbarController.progress] 的底账，不点亮；
     *  - [onActive]：**用户**在滚（手指 DRAGGING / 惯性 SETTLING）：点亮 + 续期；
     *  - [onIdle]：滚动停下：到点隐藏。
     *
     * 分开是必须的：拖动滚动条走的是 `scrollBy`（状态恒为 IDLE），若几何只在"用户滚动"
     * 时刷新，则拖动全程 progress 不动 —— 松手那一下滑块会跳回拖动前的位置
     *（2026-10-08 指挥官实测：「我一松手它就滚回了原来的位置」）。
     */
    fun installNotifications(
        onGeometry: () -> Unit,
        onActive: () -> Unit,
        onIdle: () -> Unit,
    ): () -> Unit
}

/** 原生 RecyclerView 版度量源。 */
class RvScrollMetrics(private val rv: RecyclerView) : ScrollMetrics {
    override val itemCount: Int get() = rv.adapter?.itemCount ?: 0
    override val scrollRangePx: Int get() = rv.computeVerticalScrollRange()
    override val scrollExtentPx: Int get() = rv.computeVerticalScrollExtent()
    override val scrollOffsetPx: Int get() = rv.computeVerticalScrollOffset()
    override fun scrollByPx(dy: Int) = rv.scrollBy(0, dy)
    override fun stopScroll() = rv.stopScroll()

    override fun installNotifications(
        onGeometry: () -> Unit,
        onActive: () -> Unit,
        onIdle: () -> Unit,
    ): () -> Unit {
        val listener = object : RecyclerView.OnScrollListener() {
            override fun onScrolled(rv: RecyclerView, dx: Int, dy: Int) {
                onGeometry()
                // 点亮只看滚动状态、不看 dy：换档 FLIP / 锚点修正 / 恢复位置都是程序化
                // scrollBy，同样派发 dy≠0 但不改变状态，拿 dy 判定会在捏合换档时莫名亮一下。
                if (rv.scrollState != RecyclerView.SCROLL_STATE_IDLE) onActive()
            }

            override fun onScrollStateChanged(rv: RecyclerView, newState: Int) {
                onGeometry()
                if (newState == RecyclerView.SCROLL_STATE_IDLE) onIdle() else onActive()
            }
        }
        rv.addOnScrollListener(listener)
        return { rv.removeOnScrollListener(listener) }
    }
}

/**
 * Compose `LazyVerticalGrid` 版度量源。
 *
 * Lazy 系列没有 RV 那套 `computeVerticalScroll*`，只能估算。**估算口径是这套东西的命门**
 *（2026-10-08 指挥官实测：「松手后滑块会回弹，拖得越远弹得越多；只有标签页有，专题/人物没有」），
 * 踩过三版，记下来免得再走回头路：
 *
 *  - ❌ 第一版：`视口高 ÷ 可见行数` 当行高 —— 这值随可见行数漂，又被乘上"首个可见项的行号"
 *    （几百）→ 误差放大几百倍。
 *  - ❌ 第二版：改用**相邻行首 offset 差**（真实行高、中位数抗异形行）——行高是准了，但
 *    "行号"仍用 `item.index ÷ 列数` 算，而**组标题也是 item、也占 index** →
 *    **每跨过一个标题行号就少算一行**，误差随滚动**线性累积**（所以"拖得越远弹越多"）；
 *    停下那一刻 index 跨行，同一处被算出两个值 → 回弹。专题/人物没有标题行才看不出来。
 *  - ✅ 现在：**可见项增量法**。每次读几何时，拿「上一帧所有可见项」与本帧比对，找到**任意一个
 *    两帧都可见的项**——它在视口里的位移**就是**内容位移（精确到像素，与行高/组标题无关）。
 *    只取单个锚点不行：快速拖动两帧之间能跨十几行，锚点会掉出视口；用"任一共同项"命中率就高得多。
 *    一个共同项都没有（跨了整屏）才退回"行号 × 行高"估算（一次性误差）。幂等：同帧重复读位移为 0。
 *
 * 列数用「可见行里最多有多少个 item」反推（Adaptive 不暴露列数）。
 */
class LazyGridScrollMetrics(private val state: LazyGridState) : ScrollMetrics {
    private val info get() = state.layoutInfo

    // —— 可见项增量法维护的绝对偏移（px）——
    private var cachedOffset = 0f

    /** 上一帧可见项的 index → 视口内顶边（含负值）。 */
    private var lastVisibleTops: Map<Int, Int> = emptyMap()

    /** 行首项：同一 offset.y 下 index 最小的那个（行内第一个）。 */
    private fun rowLeaders(visible: List<LazyGridItemInfo>): List<LazyGridItemInfo> =
        visible.groupBy { it.offset.y }
            .map { (_, items) -> items.minBy { it.index } }
            .sortedBy { it.index }

    /** 列数：可见行中最多的一项数（行不完整时取最大，仍等于列数）。 */
    private fun spanCount(visible: List<LazyGridItemInfo>): Int =
        if (visible.isEmpty()) 1
        else visible.groupBy { it.offset.y }.values.maxOf { it.size }.coerceAtLeast(1)

    private fun viewportPx(): Int = info.viewportEndOffset - info.viewportStartOffset

    /** 真实行高：相邻行首的 offset 差取中位数；可见行不足两行时退回视口均分。 */
    private fun rowHeightPx(leaders: List<LazyGridItemInfo>): Float {
        if (leaders.size >= 2) {
            val diffs = (1 until leaders.size)
                .map { (leaders[it].offset.y - leaders[it - 1].offset.y).toFloat() }
                .filter { it > 1f }
                .sorted()
            if (diffs.isNotEmpty()) return diffs[diffs.size / 2]
        }
        return viewportPx().toFloat() / leaders.size.coerceAtLeast(1)
    }

    /** 锚点丢失时的兜底估算：行号 × 行高（受组标题行影响，但只在丢锚点那一帧用一次）。 */
    private fun estimateOffset(visible: List<LazyGridItemInfo>): Float {
        val leaders = rowLeaders(visible)
        val first = leaders.firstOrNull() ?: return cachedOffset
        val span = spanCount(visible)
        return ((first.index / span) * rowHeightPx(leaders) - first.offset.y).coerceAtLeast(0f)
    }

    override val itemCount: Int get() = info.totalItemsCount

    override val scrollRangePx: Int
        get() {
            val visible = info.visibleItemsInfo
            if (visible.isEmpty()) return 0
            val span = spanCount(visible)
            val rows = ceil(info.totalItemsCount.toFloat() / span)
            return (rows * rowHeightPx(rowLeaders(visible))).roundToInt()
        }

    override val scrollExtentPx: Int get() = viewportPx()

    override val scrollOffsetPx: Int
        get() {
            val visible = info.visibleItemsInfo
            if (visible.isEmpty()) return cachedOffset.roundToInt().coerceAtLeast(0)

            val prevTops = lastVisibleTops
            if (prevTops.isNotEmpty()) {
                // 任意一个两帧都可见的项：它的视口位移就是内容位移（精确）
                val common = visible.firstOrNull { prevTops.containsKey(it.index) }
                cachedOffset = if (common != null) {
                    (cachedOffset + (prevTops.getValue(common.index) - common.offset.y))
                        .coerceAtLeast(0f)
                } else {
                    estimateOffset(visible)
                }
            } else {
                cachedOffset = estimateOffset(visible)
            }

            // 记下本帧全部可见项，供下次比对（幂等：同一帧重复读时位移为 0）
            lastVisibleTops = visible.associate { it.index to it.offset.y }
            return cachedOffset.roundToInt()
        }

    override fun scrollByPx(dy: Int) {
        // dispatchRawDelta 是 ScrollableState 的同步入口，不需要协程；
        // animateScrollBy/scrollBy 是 suspend，在拖动回调里用不了。
        //
        // 符号：与我们全链路约定的 dy 一致（正 = 内容上移 / 页面往后走），**不要取负**。
        // 2026-10-08 模拟器实测踩过的坑：一开始怀疑方向相反加了负号，结果往下拖滑块
        // 页面反而回顶部；补日志后确认是「那次压根没命中滑块（起点落在滑块外，被当成
        // 页面回滚）」，方向本来就是对的。
        state.dispatchRawDelta(dy.toFloat())
    }

    override fun stopScroll() = Unit

    override fun installNotifications(
        onGeometry: () -> Unit,
        onActive: () -> Unit,
        onIdle: () -> Unit,
    ): () -> Unit =
        {} // Lazy 侧由宿主的 snapshotFlow 驱动（见 rememberLazyScrollbar）
}

/**
 * 页面级拖拽滚动条的**状态桥**：一头接滚动容器（[ScrollMetrics]），一头接 Compose 绘制层。
 *
 * 为什么要有这么个桥：网格是原生 RV（对齐系统相册的滚动性能），专题/标签是 Compose
 * LazyVerticalGrid，而滚动条要跟着主题走、要能被拖，统一放在 Compose 层最省事；但滚动量
 * 只有容器自己知道。本类把「容器滚动量 → Compose state → 画布重绘」和「画布上的拖动 →
 * 容器滚动」两条路打通，两种容器共用同一套显示/隐藏与拖动手感。
 *
 * 两条性能纪律（别改）：
 *  1. [active] 只在「滚动开始 / 到点隐藏」翻转时各写一次——**滚动全程不写**，滚动期间不
 *     触发任何重组（否则每帧重组整页，滚动必然掉帧）。
 *  2. [progress] / [thumbFraction] 每帧写，但只在 Canvas 的 draw 阶段读 → Compose 只做
 *     draw invalidation，跳过 composition 与 layout。
 *
 * 生命周期：宿主在容器就绪时 [attach]、在 DisposableEffect 里 [detach]。每个组合实例各持
 * 一份（只管自己装的那一套通知），所以「旧组合 dispose」与「新组合 attach」谁先谁后都不会
 * 互相摘错监听器。
 */
@Stable
class GridScrollbarController {
    private val handler = Handler(Looper.getMainLooper())
    private var sink: ScrollMetrics? = null
    private var uninstall: (() -> Unit)? = null
    private var pendingHide: Runnable? = null

    /** 是否该显示（滚动中 / 拖动中）。见类注释：只在翻转时写。 */
    var active by mutableStateOf(false)
        private set

    /** 拇指顶端在轨道内的比例 0..1。 */
    var progress by mutableFloatStateOf(0f)
        private set

    /** 拇指长度 / 轨道长度（= 视口 / 内容）。≥1 = 内容不足一屏，不显示。 */
    var thumbFraction by mutableFloatStateOf(1f)
        private set

    /** 是否正在被拖动：拖动期间保持显示（不受自动隐藏影响）+ 拇指加粗。 */
    var dragging by mutableStateOf(false)
        private set

    /**
     * 拖动期间拇指的**视觉** top（px，相对容器顶）：由手指位移逐帧累加，
     * 与 RV 那套 `computeVerticalScroll*` 的估算值解耦（估算值在瀑布流/自适应下不准，
     * 拿它画拇指会出现「手指走了、拇指没跟」）。松手后交回 [progress] 驱动。
     */
    var dragThumbTop by mutableFloatStateOf(0f)
        private set

    /** 拖动期间命中层**冻结**的 top（px）：节点不动，局部坐标才稳定（见 [beginDrag]）。 */
    var hitFrozenTop by mutableFloatStateOf(0f)
        private set

    /** 绑定滚动容器并同步一次几何。重复 attach 同一个 sink 是幂等的。 */
    fun attach(metrics: ScrollMetrics) {
        if (this.sink === metrics) {
            sync()
            return
        }
        detach()
        sink = metrics
        uninstall = metrics.installNotifications(::sync, ::show, ::scheduleHide)
        sync()
    }

    /** 解绑：摘通知、撤隐藏计时、复位显示状态。组合销毁 / 容器换宿主时调用。 */
    fun detach() {
        uninstall?.invoke()
        uninstall = null
        sink = null
        cancelPendingHide()
        active = false
        dragging = false
        progress = 0f
        thumbFraction = 1f
    }

    /** Lazy 系列用：由宿主的 snapshotFlow 在滚动中调用（显示 + 续期），见各页面接线。 */
    fun notifyScrollActive() {
        sync()
        show()
    }

    /** Lazy 系列用：滚动停下（[LazyGridState.isScrollInProgress] 转 false）时调用。 */
    fun notifyScrollIdle() = scheduleHide()

    /**
     * 拖动开始。
     *
     * [thumbTopPx] 是按下那一刻拇指在容器内的 top（px），它同时用作两件事：
     *  - [hitFrozenTop]：命中层**在整段拖动里冻结在这个位置**；
     *  - [dragThumbTop] 的初值：视觉拇指从这里开始跟着手指走。
     *
     * 为什么要冻结命中层（2026-10-08 实测「拖动时页面疯狂上下抖动」的根因）：
     * Compose 的 `PointerInputChange.position` 是**相对该 pointerInput 节点的局部坐标**。
     * 若命中层跟着 `progress` 走，手指不动时节点也在移动 → 同一手指的局部 y 持续变化 →
     * 被算成「手指在反向移动」→ 反向滚 → progress 反向 → 节点反向移动 → 再算成反向……
     * 典型的自激震荡，表现为页面疯狂上下抖。冻结节点后局部坐标稳定，delta 才是真实位移。
     */
    internal fun beginDrag(thumbTopPx: Float) {
        dragging = true
        hitFrozenTop = thumbTopPx
        dragThumbTop = thumbTopPx
        // 掐掉惯性（手指接管，别让上一次 fling 跟手指打架）
        sink?.stopScroll()
        show()
    }

    /** 拖动结束：交还自动隐藏（松手后仍亮着，到点淡出）。 */
    internal fun endDrag() {
        dragging = false
        show()
    }

    /**
     * 把「拇指在轨道里的位移」换算成「内容的位移」并滚过去（增量式，1:1 跟手）。
     *
     * 走增量而不是「按目标比例绝对定位」：三种布局模式（网格/瀑布流/自适应）的
     * `computeVerticalScrollRange` 都是**估算值**（等高网格准，瀑布流与自适应按平均高度
     * 估），绝对定位会把估算误差累积成「拖一点、跳一大段」。增量式每帧只按
     * `dy / trackSpan × (range − extent)` 推一小段，误差不累积，手感线性。
     */
    internal fun dragBy(trackSpanPx: Float, deltaPx: Float) {
        val sink = this.sink ?: return
        if (trackSpanPx <= 0f) return
        val span = (sink.scrollRangePx - sink.scrollExtentPx).toFloat()
        if (span <= 0f) return
        val dy = deltaPx / trackSpanPx * span
        if (dy == 0f) return
        sink.scrollByPx(dy.roundToInt())
        // 视觉拇指按手指位移跟手（clamp 交给绘制层，那里才有轨道几何）
        dragThumbTop += deltaPx
        // 程序化 scrollBy 不改滚动状态，RV 那边不会走「用户滚动」分支——这里显式刷一次
        // 几何，否则松手时 progress 还停在拖动前，滑块会跳回去。
        sync()
        // 滚到尽头时不再有滚动通知，计时器不会自己续上——这里续一次，
        // 否则「拖到顶/底停住不动」会看到滚动条立刻消失。
        show()
    }

    /** 从容器读一次几何。滚动中每帧都会走到，只写 progress/thumbFraction（draw 阶段读）。 */
    fun sync() {
        val sink = this.sink ?: run {
            thumbFraction = 1f
            return
        }
        // 条目太少不显示（2026-10-08 指挥官定：一屏多一点的内容挂条滑块没有意义）
        if (sink.itemCount < MIN_ITEM_COUNT) {
            thumbFraction = 1f
            progress = 0f
            return
        }
        val range = sink.scrollRangePx
        val extent = sink.scrollExtentPx
        if (range <= 0 || extent <= 0 || range <= extent) {
            // 内容不足一屏（或容器还没量出几何）：不显示
            thumbFraction = 1f
            progress = 0f
            return
        }
        thumbFraction = (extent.toFloat() / range.toFloat()).coerceIn(0f, 1f)
        progress = (sink.scrollOffsetPx.toFloat() / (range - extent).toFloat()).coerceIn(0f, 1f)

    }

    private fun show() {
        active = true
        postHide()
    }

    /** 滚动停下（状态回到 IDLE）：到点淡出。 */
    private fun scheduleHide() = postHide()

    private fun postHide() {
        cancelPendingHide()
        val r = Runnable { if (!dragging) active = false }
        pendingHide = r
        handler.postDelayed(r, AUTO_HIDE_MS)
    }

    private fun cancelPendingHide() {
        pendingHide?.let { handler.removeCallbacks(it) }
        pendingHide = null
    }
}

/**
 * 页面级拖拽滚动条：滚动时出现，停止滚动 ~0.9s 后淡出；按住拇指可拖动整页。
 *
 * 用法：与网格 AndroidView 同层叠放（Box），宿主把 controller 在 AndroidView 的 factory 里
 * attach、在 DisposableEffect 里 detach。
 *
 * ## 触摸策略（2026-10-08 踩过的坑，别改回去）
 *
 * `AndroidComposeView.dispatchTouchEvent` 的判定是「事件有没有被派发到**任意一个**
 * PointerInputModifier 节点」——`dispatchedToAPointerInputModifier == true` 就直接
 * `return true`，**不再往下传给原生子 View**。也就是说：只要网格上方压着一个带
 * `pointerInput` 的 Compose 节点，**无论它有没有 consume**，嵌在下面的原生 RecyclerView
 * 都收不到任何触摸（实测：整页滚不动、点不动）。项目里 PullToRefreshIndicator 那句
 * 「Canvas 天然不拦截触摸」是同一条规则的反面——它没挂 pointerInput 才安全。
 *
 * 因此这里分两层：
 *  - **绘制层** = 全屏 Canvas，**不挂 pointerInput** → 画在网格之上，但完全不参与事件派发；
 *  - **命中层** = 只有拇指那么大（[TOUCH_WIDTH_DP] × 拇指高），且**只在滚动条可见时才存在于
 *    组合里**。页面静止时它连节点都没有 → 网格 100% 正常；可见的那 0.9s 内也只有拇指那一小块
 *    会接管触摸。
 *
 * ## 拖动期间命中层必须冻结（2026-10-08 实测「拖动时页面疯狂上下抖动」）
 *
 * `PointerInputChange.position` 是**相对该 pointerInput 节点的局部坐标**。命中层若跟着滚动
 * 走，手指不动时节点也在动 → 局部 y 持续漂移 → 被算成「手指在反向移动」→ 反向滚 → 又反向……
 * 自激震荡。所以拖动期间命中层冻在按下时的位置（[GridScrollbarController.hitFrozenTop]），
 * 视觉拇指另走 [GridScrollbarController.dragThumbTop]（按手指位移累加，跟手）。
 */
/**
 * Lazy 网格（标签 / 人物 / 专题）的滚动条接线：一段代码三处复用，别各写一遍。
 *
 * 与 RV 侧的差别只有「谁来通知在滚」：RV 自己有 OnScrollListener，Lazy 只能靠宿主组合里的
 * snapshotFlow 盯 `isScrollInProgress`（顺带把首条目下标/偏移放进 key，位置一变就刷新几何）。
 */
@Composable
internal fun rememberLazyScrollbar(gridState: LazyGridState): GridScrollbarController {
    val controller = remember { GridScrollbarController() }
    DisposableEffect(controller) { onDispose { controller.detach() } }
    LaunchedEffect(controller, gridState) {
        controller.attach(LazyGridScrollMetrics(gridState))
        snapshotFlow {
            Triple(
                gridState.firstVisibleItemIndex,
                gridState.firstVisibleItemScrollOffset,
                gridState.isScrollInProgress,
            )
        }.collect { (_, _, inProgress) ->
            // 每次都刷几何（含程序化滚动），只在用户滚动时点亮
            controller.sync()
            if (inProgress) controller.notifyScrollActive() else controller.notifyScrollIdle()
        }
    }
    return controller
}

@Composable
fun GridScrollbar(
    controller: GridScrollbarController,
    modifier: Modifier = Modifier,
    /** 拇指颜色（宿主传主题色，保持与页面一致）。 */
    color: Color,
    /** 两端小三角的颜色：拇指是不透明实色，三角用内容底色镂空出来才看得清。 */
    indicatorColor: Color,
    /** 拇指不透明度（静止）。悬浮感来自「没有滑槽」，不是靠淡化——默认给足实色。 */
    thumbAlpha: Float = 1f,
) {
    val density = LocalDensity.current
    val thumbW = with(density) { THUMB_WIDTH_DP.toPx() }
    val activeW = with(density) { THUMB_ACTIVE_WIDTH_DP.toPx() }
    val margin = with(density) { THUMB_MARGIN_DP.toPx() }
    val padV = with(density) { TRACK_PADDING_DP.toPx() }
    val touchW = with(density) { TOUCH_WIDTH_DP.toPx() }
    // 高度固定（2026-10-08 指挥官定）：不随内容多少变长变短
    val thumbH = with(density) { THUMB_HEIGHT_DP.toPx() }

    // 容器尺寸：只在尺寸变化时写一次（onSizeChanged），不是每帧
    var hostSize by remember { mutableStateOf(IntSize.Zero) }
    val visible = controller.active || controller.dragging
    // 该不该显示：内容够长（thumbFraction<1 表示 range>extent，且条目数达标——见 sync）
    val scrollable = controller.thumbFraction < 1f
    val alpha by animateFloatAsState(
        targetValue = if (visible && scrollable) 1f else 0f,
        animationSpec = tween(durationMillis = if (visible) FADE_IN_MS else FADE_OUT_MS),
        label = "scrollbarAlpha",
    )

    // 拇指几何放在组合期算：只依赖容器尺寸（高度固定、与内容无关）。
    // 随帧变化的只有 progress，交给命中层的 offset lambda（placement 阶段读取 →
    // 只 invalidate placement，不触发重组）。
    val trackH = (hostSize.height.toFloat() - padV * 2f).coerceAtLeast(0f)
    val trackSpan = (trackH - thumbH).coerceAtLeast(1f)
    // 组合期更新、闭包里读最新值：不进 pointerInput 的 key（见命中层的注释）
    val currentTrackSpan = rememberUpdatedState(trackSpan)
    Box(modifier = modifier.fillMaxSize().onSizeChanged { hostSize = it }) {
        // 绘制层（无 pointerInput：见上）
        Canvas(modifier = Modifier.fillMaxSize()) {
            if (alpha <= 0.004f) return@Canvas
            val frac = controller.thumbFraction
            if (frac >= 1f) return@Canvas
            val drawTrackH = size.height - padV * 2
            if (drawTrackH <= 0f) return@Canvas

            val w = if (controller.dragging) activeW else thumbW
            val drawThumbH = thumbH
            val x = size.width - margin - w
            val radius = CornerRadius(w / 2f, w / 2f)

            // 只有一条悬浮的滑块，不画滑槽（轨道）——“进度”由滑块位置本身表达
            val top = if (controller.dragging) {
                // 跟手：按手指位移走，与 RV 估算值解耦；越界由这里钳住
                controller.dragThumbTop.coerceIn(padV, (padV + drawTrackH - drawThumbH).coerceAtLeast(padV))
            } else {
                padV + (drawTrackH - drawThumbH) * controller.progress
            }
            drawRoundRect(
                color = color.copy(alpha = thumbAlpha * alpha),
                topLeft = Offset(x, top),
                size = Size(w, drawThumbH),
                cornerRadius = radius,
            )
            // 两端的上下小三角（滑块本身就是不透明实色，三角用内容底色镂空）
            val arrowW = w * ARROW_WIDTH_RATIO
            val arrowH = w * ARROW_HEIGHT_RATIO
            if (drawThumbH >= arrowH * 2f + w * 0.9f) {
                val cx = x + w / 2f
                val inset = w * 0.34f
                // 上三角：顶点在上
                drawPath(
                    path = Path().apply {
                        moveTo(cx, top + inset)
                        lineTo(cx - arrowW / 2f, top + inset + arrowH)
                        lineTo(cx + arrowW / 2f, top + inset + arrowH)
                        close()
                    },
                    color = indicatorColor.copy(alpha = alpha),
                )
                // 下三角：顶点在下
                val bottom = top + drawThumbH - inset
                drawPath(
                    path = Path().apply {
                        moveTo(cx, bottom)
                        lineTo(cx - arrowW / 2f, bottom - arrowH)
                        lineTo(cx + arrowW / 2f, bottom - arrowH)
                        close()
                    },
                    color = indicatorColor.copy(alpha = alpha),
                )
            }
    }

        // 命中层：只在「可见且内容够长」时进组合（静止时连节点都没有 → 页面触摸零影响），
        // 尺寸 = 拇指本身（44dp × 36dp）。拖动期间位置**冻结**，不跟着滚动走。
        if (visible && scrollable && trackH > thumbH) {
            Spacer(
                Modifier
                    .offset {
                        IntOffset(
                            (hostSize.width - touchW).roundToInt(),
                            // 冻结（见 KDoc）：节点一动，局部坐标就漂，delta 会自激出反向位移
                            (
                                if (controller.dragging) {
                                    controller.hitFrozenTop
                                } else {
                                    padV + trackSpan * controller.progress
                                }
                                ).roundToInt(),
                        )
                    }
                    .size(width = TOUCH_WIDTH_DP, height = with(density) { thumbH.toDp() })
                    // key **只有 controller**：trackSpan 绝不能进 key——滚动时 thumbFraction
                    // （= extent/range，LM 的估算值）会变 → trackSpan 变 → 协程被重启 →
                    // 正在进行的拖动被打断、endDrag 永远不执行、dragging 卡在 true
                    //（表现：顶部拖不动 + 松手后滚动条定在原地不跟随页面）。
                    // trackSpan 的最新值改由 rememberUpdatedState 在闭包里读。
                    .pointerInput(controller) {
                        awaitPointerEventScope {
                            while (true) {
                                val down = awaitFirstDown(requireUnconsumed = false)
                                // 节点本身就是拇指，落在这里即视为按住了拇指
                                down.consume()
                                controller.beginDrag(padV + currentTrackSpan.value * controller.progress)
                                try {
                                    var lastY = down.position.y
                                    while (true) {
                                        val event = awaitPointerEvent(PointerEventPass.Main)
                                        val change =
                                            event.changes.firstOrNull { it.id == down.id } ?: break
                                        if (!change.pressed) break
                                        val delta = change.position.y - lastY
                                        lastY = change.position.y
                                        if (delta != 0f) {
                                            change.consume()
                                            controller.dragBy(currentTrackSpan.value, delta)
                                        }
                                    }
                                } finally {
                                    // 兜底：协程被取消（节点离场 / 手势被系统收走）时也必须
                                    // 复位 dragging，否则命中层会永久冻结、拇指不再跟随页面
                                    controller.endDrag()
                                }
                            }
                        }
                    },
            )
        }
    }
}
