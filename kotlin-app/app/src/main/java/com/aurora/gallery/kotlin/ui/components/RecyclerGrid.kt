package com.aurora.gallery.kotlin.ui.components

import android.content.Context
import android.graphics.Rect
import android.util.AttributeSet
import android.util.Log
import android.view.InputDevice
import android.view.MotionEvent
import android.view.ScaleGestureDetector
import android.view.View
import android.view.ViewGroup
import android.view.animation.PathInterpolator
import android.widget.ImageView
import androidx.core.view.doOnLayout
import androidx.recyclerview.widget.GridLayoutManager
import androidx.recyclerview.widget.RecyclerView
import androidx.recyclerview.widget.StaggeredGridLayoutManager
import java.lang.ref.WeakReference
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.roundToInt

private const val TAG = "AuroraKotlin"

/**
 * FLIP 换档动画参数，逐项对齐 React 版 `src/components/FileGrid.tsx` 的捏合换档分支
 *（`flipAnimParamsRef = { duration: 240, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' }`）。
 * 注意：面板开合（宽度变化）分支是 300ms ease-out，是另一条路径，不要混用本常量。
 */
internal const val FLIP_DURATION_MS = 240L
internal val FLIP_INTERPOLATOR = PathInterpolator(0.22f, 1f, 0.36f, 1f)

/**
 * 正方形 ImageView。
 *
 * **只在高度为 WRAP_CONTENT（未显式指定）时**把高度强制成与宽度一致（网格封面）；
 * 一旦显式指定了高度（瀑布流按宽高比、自适应行按行高），就尊重那个高度，不再强行拉成正方形。
 * 这样同一个 cover 视图能在「网格正方形」与「瀑布流/自适应可变高度」之间正确复用。
 */
class SquareImageView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
    defStyleAttr: Int = 0,
) : ImageView(context, attrs, defStyleAttr) {
    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val lp = layoutParams
        val forceSquare = lp == null || lp.height == ViewGroup.LayoutParams.WRAP_CONTENT
        if (forceSquare) {
            super.onMeasure(widthMeasureSpec, widthMeasureSpec)
        } else {
            super.onMeasure(widthMeasureSpec, heightMeasureSpec)
        }
    }

    /**
     * 内容级 requestLayout 降级为重绘。`setImageBitmap`（占位→位图）改变 intrinsic 尺寸
     * 时 ImageView 会 requestLayout 并沿视图树上抛：一次**异步**缩略图落地 = 整个
     * RecyclerView 全量重布局。瀑布流下重布局会 strip 掉全部预填再重建（回收池装不下、
     * 大量重新 inflate），重建又触发新的图片加载/占位切换——自持的重布局风暴，是
     * 快速滚动掉帧的直接来源。封面尺寸始终由 layoutParams 显式控制（bind 时赋值、
     * fill 紧接着按新值测量），内容变化不需要重新布局，重绘即可；首测前（尚未有尺寸）
     * 仍正常上抛。
     */
    override fun requestLayout() {
        if (measuredWidth <= 0 || measuredHeight <= 0) {
            super.requestLayout()
        } else {
            invalidate()
        }
    }
}

/**
 * 网格间距：gap 均匀摊到每列左右（**等间距**），非首行加顶部间距。
 * 四周的 padding 由 RecyclerView 自身的 padding 负责。[spanCount] 可变（三档捏合换档时更新）。
 *
 * 为什么不用「非首列加左间距」：那会让首列内容宽 = inner/span、其余列 = inner/span - gap，
 * 列宽不一致（差一个 gap），封面（正方形）与捏合目标列宽都算不准——封面变非正方形长条、
 * 捏合松手后要纠偏跳位。等间距让每列内容宽度一致 = (inner - (span-1)*gap)/span，
 * 正好等于 `applyCellWidth` 的 cellPx 与 `PinchFlipController` 的 newCellW。
 */
class GridSpacingDecoration(
    /** 当前列数（三档捏合换档时更新）。 */
    var spanCount: Int,
    /** 单元格间距。手机 10dp / 平板 16dp，对齐 React 版 `layout.worker.ts` 的 GAP。 */
    val gapPx: Int,
) : RecyclerView.ItemDecoration() {
    override fun getItemOffsets(
        outRect: Rect,
        view: View,
        parent: RecyclerView,
        state: RecyclerView.State,
    ) {
        val position = parent.getChildAdapterPosition(view)
        if (position == RecyclerView.NO_POSITION) return
        outRect.set(0, 0, 0, 0)

        val lm = parent.layoutManager
        if (lm is StaggeredGridLayoutManager) {
            // 瀑布流：列号必须用 LayoutParams.spanIndex（item 不等高，会被放到最短列，
            // `position % spanCount` 是错的——会导致列宽不一致、两张图贴在一起）。
            // 满宽的 header 不加间距；首行（各列第一个 item）不加顶部间距，其余加。
            val lp = view.layoutParams as? StaggeredGridLayoutManager.LayoutParams
            if (lp != null && lp.isFullSpan) return
            val span = lm.spanCount
            val column = lp?.spanIndex ?: (position % span)
            outRect.left = gapPx * column / span
            outRect.right = gapPx * (span - 1 - column) / span
            outRect.top = if (position >= span) gapPx else 0
            return
        }

        // 网格：等间距（gap 均匀摊到每列左右），每列内容宽度一致。
        val span = spanCount
        val column = position % span
        val row = position / span
        outRect.left = gapPx * column / span
        outRect.right = gapPx * (span - 1 - column) / span
        outRect.top = if (row > 0) gapPx else 0
    }
}

/** 三档列数：0=小、1=中、2=大。容器宽度用 dp（对齐 React 版 CSS 像素），公式 w/150、w/220、w/330。 */
fun targetCols(containerWidthDp: Int, level: Int): Int {
    val w = max(containerWidthDp, 1)
    return when (level) {
        0 -> max(3, (w / 150f).roundToInt())
        2 -> max(1, (w / 330f).roundToInt())
        else -> max(2, (w / 220f).roundToInt())
    }
}

/**
 * 双指捏合换档监听器（基于 [ScaleGestureDetector]，正确区分单指滚动/双指缩放）。
 * 一次手势至多一档（对齐 React 版 STEP_THRESHOLD=1.08），切换后锁定防跳档。
 *
 * **多指期间完全接管事件（修复「捏合时页面仍会滑动」）**：
 * 仅靠 `scaleDetector.isInProgress` 会有两个漏口——
 *  1. 两指落下后若先整体平移，span 变化未过 ScaleGestureDetector 的 slop，scale 尚未 begin，
 *     事件被放行给 RecyclerView → 页面跟着两指滑动；
 *  2. 捏合结束一指抬起后 scale 立即 end，剩下那根手指继续移动 → 页面突然继续滑动。
 * 因此监听器自己跟踪 pointer 数：第二指落下即进入多指态并 `stopScroll()`，
 * 从多指回落到单指时抑制到全部抬起（连 ACTION_UP 也吃掉，防 RV 用失真速度 fling）。
 *
 * **档位在松手时才切换**（[onPinchEnd]），捏合过程中只回调 [onPinchProgress] 供
 * [PinchZoomController] 做跟手 transform——这样捏合期间完全不碰布局，既跟手又避开了
 * 「requestLayout 被 RV 吞掉导致布局不刷新」这个坑。
 *
 * **必须同时注册为 [View.OnTouchListener] 与 [RecyclerView.OnItemTouchListener]**：
 * 第一根手指的落点决定事件走哪条分发路径——
 *  - 落在网格间隙/内边距上：没有子 View 消费 DOWN，`mFirstTouchTarget == null`，
 *    事件直接进 `RecyclerView.onTouchEvent`，只有 [View.OnTouchListener] 能看到
 *    （`OnItemTouchListener.onInterceptTouchEvent` 只在 ACTION_DOWN 被调一次）；
 *  - 落在 item 上：item 因 clickable 消费了 DOWN，事件先给 item；RV 只有在判定为拖拽
 *    拦截之后才会调 `OnTouchListener`——**那时滚动已经启动了**。只有
 *    [RecyclerView.OnItemTouchListener] 能在每个事件上提前拦截。
 * 两条路径共用同一状态机，用 (eventTime, action) 去重，避免同一事件被处理两次。
 */
class PinchGridSpanListener(
    context: Context,
    private val onPinchStart: (focusX: Float, focusY: Float) -> Unit,
    private val onPinchProgress: (scale: Float, focusX: Float, focusY: Float) -> Unit,
    private val onPinchEnd: (scale: Float) -> Unit,
) : View.OnTouchListener, RecyclerView.OnItemTouchListener {

    private var initialSpan = 0f

    /** 当前处于多指（≥2 指）手势中。 */
    private var multiTouch = false
    /** 多指已降到单指，但手指尚未全部抬起——继续拦截，避免残余手指带出滚动。 */
    private var suppressUntilUp = false
    /** 本手势期间拦截过，抬起事件也要吃掉（见 handle 的 ACTION_UP 分支）。 */
    private var consumeUp = false

    private var lastEventTime = -1L
    private var lastAction = -1

    /** 当前未走完的注入链条（防重叠，见 [debugInjectPinch]）。 */
    private var pendingInjection: Runnable? = null

    /** 事件到达的 RecyclerView（调试注入用）。 */
    private var rvRef: WeakReference<RecyclerView>? = null

    /** 手势无关的 RV 引用（调试注入用）：[rvRef] 只在真实触摸事件经过 [handle] 时才赋值。 */
    private var debugRvRef: WeakReference<RecyclerView>? = null

    /** Debug 注入钩子：挂载时记录宿主 RV，使 [debugInjectPinch] 不依赖先发生过真实触摸。 */
    internal fun debugAttachRv(rv: RecyclerView) {
        debugRvRef = WeakReference(rv)
    }

    private val scaleDetector = ScaleGestureDetector(context, object : ScaleGestureDetector.SimpleOnScaleGestureListener() {
        override fun onScaleBegin(detector: ScaleGestureDetector): Boolean {
            initialSpan = detector.currentSpan
            onPinchStart(detector.focusX, detector.focusY)
            return true
        }

        override fun onScale(detector: ScaleGestureDetector): Boolean {
            if (initialSpan > 0f) {
                onPinchProgress(detector.currentSpan / initialSpan, detector.focusX, detector.focusY)
            }
            return true
        }

        override fun onScaleEnd(detector: ScaleGestureDetector) {
            if (initialSpan > 0f) {
                onPinchEnd(detector.currentSpan / initialSpan)
            }
            initialSpan = 0f
        }
    })

    /** 是否需要拦截当前事件（吃掉即阻止 RecyclerView 滚动）。 */
    private val blocking: Boolean
        get() = multiTouch || suppressUntilUp || consumeUp || scaleDetector.isInProgress

    override fun onTouch(v: View, event: MotionEvent): Boolean {
        handle(v as RecyclerView, event)
        return blocking
    }

    override fun onInterceptTouchEvent(rv: RecyclerView, e: MotionEvent): Boolean {
        handle(rv, e)
        // 返回 true → RV 调 cancelTouch()（置 IDLE、停 fling）并把后续事件交给本监听器
        return blocking
    }

    override fun onTouchEvent(rv: RecyclerView, e: MotionEvent) {
        handle(rv, e)
    }

    override fun onRequestDisallowInterceptTouchEvent(disallowIntercept: Boolean) = Unit

    /** 用 (eventTime, action) 去重：`View.dispatchTouchEvent` 总是优先 `OnTouchListener`，
     *  返回 true 时 `onTouchEvent` 不再执行，正常不会重复；去重只是防边界情况下
     *  ScaleGestureDetector 被喂两次同一事件导致 span 计算错乱。 */
    private fun handle(rv: RecyclerView, event: MotionEvent) {
        if (event.eventTime == lastEventTime && event.actionMasked == lastAction) return
        lastEventTime = event.eventTime
        lastAction = event.actionMasked
        rvRef = WeakReference(rv)

        scaleDetector.onTouchEvent(event)

        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                multiTouch = false
                suppressUntilUp = false
                consumeUp = false
            }

            MotionEvent.ACTION_POINTER_DOWN -> {
                if (event.pointerCount >= 2) {
                    multiTouch = true
                    // 第一根手指往往已经让 RecyclerView 进入滚动/fling，第二指落下时立刻刹停，
                    // 否则整个捏合过程中页面会一直带着惯性滑动。
                    rv.stopScroll()
                    rv.parent?.requestDisallowInterceptTouchEvent(true)
                    Log.d(TAG, "[Pinch] multi-touch start: pointers=${event.pointerCount}")
                }
            }

            MotionEvent.ACTION_POINTER_UP -> {
                // ACTION_POINTER_UP 时 pointerCount 仍含抬起的那根，≤2 表示抬起后只剩 1 指
                if (multiTouch && event.pointerCount <= 2) {
                    suppressUntilUp = true
                }
            }

            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                // 先取 blocking（此时 multiTouch 尚未复位），再清状态
                consumeUp = blocking
                multiTouch = false
                suppressUntilUp = false
            }
        }
    }

    companion object {
        private const val STEP_THRESHOLD = 1.08f

        /** 最近挂载的捏合监听器（仅模拟器调试注入用，见 MainActivity 的 PINCH 广播）。 */
        @JvmStatic
        internal var lastInstance: WeakReference<PinchGridSpanListener>? = null
            private set
    }

    init {
        lastInstance = WeakReference(this)
    }

    /**
     * **调试注入（合成双指触摸，走真实事件分发路径）**：构造两指 MotionEvent 逐帧
     * `dispatchTouchEvent` 给 RV——与 [debugInjectPinch] 直接调生产回调不同，这条路径
     * 经过 OnItemTouchListener / ScaleGestureDetector / 多指接管 / stopScroll 的完整
     * 真实逻辑，并带随机抖动与「中途抬指→再落指」（真实手指常见，直接回调注入
     * 覆盖不到），用于复现真实手势才出现的预览闪烁。
     *
     * @param targetScale 末跨度 / 起始跨度，<1 收拢（列数变多）、>1 张开
     */
    fun debugInjectTouchPinch(targetScale: Float, frames: Int = 55, seed: Long = 42) {
        val rv = rvRef?.get() ?: debugRvRef?.get() ?: return
        val w = rv.width.toFloat()
        val h = rv.height.toFloat()
        val d0 = minOf(w, h) * 0.5f
        val d1 = d0 * targetScale
        val rnd = java.util.Random(seed)

        /** 第 frame 帧时两指坐标（focus 缓慢漂移 + 每帧随机抖动 → scale 非单调）。 */
        fun pts(frame: Int, twoFingers: Boolean): List<Pair<Float, Float>> {
            val frac = frame.toFloat() / frames
            val d = d0 + (d1 - d0) * frac
            val cx = w / 2f + 40f * frac
            val cy = h / 2f + 24f * (1f - frac)
            val jx = (rnd.nextFloat() - 0.5f) * 14f
            val jy = (rnd.nextFloat() - 0.5f) * 14f
            val p1 = Pair(cx - d / 2 + jx, cy + jy)
            return if (twoFingers) {
                val p2 = Pair(cx + d / 2 - jx, cy - jy * 0.6f)
                listOf(p1, p2)
            } else listOf(p1)
        }

        fun mev(
            action: Int,
            pts: List<Pair<Float, Float>>,
            ids: IntArray,
            downTime: Long,
        ): MotionEvent {
            val props = arrayOfNulls<MotionEvent.PointerProperties>(pts.size)
            val coords = arrayOfNulls<MotionEvent.PointerCoords>(pts.size)
            for (i in pts.indices) {
                props[i] = MotionEvent.PointerProperties().apply {
                    id = ids[i]
                    toolType = MotionEvent.TOOL_TYPE_FINGER
                }
                coords[i] = MotionEvent.PointerCoords().apply {
                    x = pts[i].first
                    y = pts[i].second
                    pressure = 1f
                    size = 1f
                }
            }
            return MotionEvent.obtain(
                downTime, android.os.SystemClock.uptimeMillis(), action, pts.size, props, coords,
                0, 0, 1f, 1f, 0, 0, InputDevice.SOURCE_TOUCHSCREEN, 0,
            )
        }

        val downTime = android.os.SystemClock.uptimeMillis()
        val liftFrame = (frames * 0.55f).toInt() // 中途抬指再落指的帧
        fun at(frame: Int, block: () -> Unit) {
            rv.postDelayed({ block() }, frame * 16L)
        }

        at(0) { rv.dispatchTouchEvent(mev(MotionEvent.ACTION_DOWN, pts(0, false), intArrayOf(0), downTime)) }
        at(1) {
            val p = pts(1, true)
            rv.dispatchTouchEvent(
                mev((1 shl MotionEvent.ACTION_POINTER_INDEX_SHIFT) or MotionEvent.ACTION_POINTER_DOWN, p, intArrayOf(0, 1), downTime),
            )
        }
        for (f in 2..frames) {
            at(f) {
                val two = f % liftFrame != 0 // liftFrame 那帧只留单指（模拟中途抬指）
                val alive = if (two) intArrayOf(0, 1) else intArrayOf(0)
                var action = MotionEvent.ACTION_MOVE
                var ids = alive
                var list = pts(f, two)
                if (f == liftFrame - 1 && liftFrame in 3 until frames) {
                    // 抬起第二指：POINTER_UP（actionIndex=1）
                    list = pts(f, true)
                    ids = intArrayOf(0, 1)
                    action = (1 shl MotionEvent.ACTION_POINTER_INDEX_SHIFT) or MotionEvent.ACTION_POINTER_UP
                } else if (f == liftFrame + 1 && liftFrame in 3 until frames - 2) {
                    // 第二指重新落下
                    list = pts(f, true)
                    ids = intArrayOf(0, 1)
                    action = (1 shl MotionEvent.ACTION_POINTER_INDEX_SHIFT) or MotionEvent.ACTION_POINTER_DOWN
                }
                rv.dispatchTouchEvent(mev(action, list, ids, downTime))
            }
        }
        at(frames + 1) {
            val p = pts(frames + 1, true)
            rv.dispatchTouchEvent(
                mev((1 shl MotionEvent.ACTION_POINTER_INDEX_SHIFT) or MotionEvent.ACTION_POINTER_UP, p, intArrayOf(0, 1), downTime),
            )
        }
        at(frames + 2) {
            rv.dispatchTouchEvent(mev(MotionEvent.ACTION_UP, pts(frames + 2, false), intArrayOf(0), downTime))
        }
    }

    /**
     * **调试注入**（仅模拟器验证用）：不走真实触摸，按 [stepDelayMs] 间隔驱动生产捏合回调，
     * 从 1.0 线性缩放到 [targetScale] 后松手。scale < 1 收拢（列数变多），> 1 张开（列数变少）。
     *
     * 每步的实际耗时可能超过 [stepDelayMs]（预览插值要 measure/layout 全部可见 child），
     * 用 [pendingInjection] 摘掉上一条未走完的链条，防止两次注入的 start/end 交叠——
     * 滞后的 onPinchEnd 会把新手势中途 settle 掉（真实手指不可能产生这种重叠）。
     */
    fun debugInjectPinch(targetScale: Float, steps: Int = 12, stepDelayMs: Long = 16) {
        val rv = rvRef?.get() ?: debugRvRef?.get() ?: return
        // 真实双指手势会在第二指落下时 stopScroll；注入路径也要刹停，否则惯性滚动
        // 会让 begin() 记录的锚点位置在预览期间失效。
        rv.stopScroll()
        rv.removeCallbacks(pendingInjection)
        initialSpan = 1000f
        onPinchStart(0f, 0f)
        var i = 1
        val step = object : Runnable {
            override fun run() {
                if (i > steps) {
                    onPinchEnd(targetScale)
                    initialSpan = 0f
                    return
                }
                val s = 1f + (targetScale - 1f) * i / steps
                onPinchProgress(s, 0f, 0f)
                i++
                rv.postDelayed(this, stepDelayMs)
            }
        }
        pendingInjection = step
        rv.postDelayed(step, stepDelayMs)
    }
}

internal class FlipSnapshot(
    val anchorPos: Int,
    val anchorTop: Int,
    /** 锚点 item 换档**前**的宽度。列数变了列宽必然变，用它判断布局是否已刷新。 */
    val anchorWidth: Int,
    val oldLefts: Map<Int, Float>,
    val oldTops: Map<Int, Float>,
    /**
     * 捕获时的**视觉宽度**（layout 宽 × scaleX）。收尾 FLIP 的起始 scale = 视觉宽 / 新布局宽，
     * 保证松手瞬间卡片视觉宽度连续。旧实现直接沿用捕获时的 scaleX：scale 是相对旧布局宽的，
     * 叠到新布局宽上会先跳一下再动画（视觉宽从预览值突变为 新宽×预览scale）。
     */
    val oldVisualWidths: Map<Int, Float>,
)

/** 布局未刷新时的最大重试次数（约 3 帧，超过就放弃动画，避免死循环）。 */
private const val MAX_LAYOUT_RETRY = 3

/**
 * FLIP 第一步：记录锚点与所有可见 item 的旧屏幕位置，并清掉上一轮残留动画。
 *
 * 旧位置要**叠加当前 translation**——连续换档时上一轮动画可能还没跑完，
 * 记录视觉位置才不会跳。
 */
internal fun captureFlip(rv: RecyclerView, anchorPos: Int, anchorTop: Int): FlipSnapshot? {
    if (anchorPos == RecyclerView.NO_POSITION) return null
    val anchorWidth = rv.layoutManager?.findViewByPosition(anchorPos)?.width ?: 0
    val oldLefts = HashMap<Int, Float>()
    val oldTops = HashMap<Int, Float>()
    val oldVisualWidths = HashMap<Int, Float>()
    for (i in 0 until rv.childCount) {
        val child = rv.getChildAt(i)
        val pos = rv.getChildAdapterPosition(child)
        if (pos == RecyclerView.NO_POSITION) continue
        oldLefts[pos] = child.left + child.translationX
        oldTops[pos] = child.top + child.translationY
        oldVisualWidths[pos] = child.width * child.scaleX
    }
    for (i in 0 until rv.childCount) {
        val child = rv.getChildAt(i)
        child.animate().cancel()
        child.translationX = 0f
        child.translationY = 0f
        // 捏合跟手缩放留下的 scale 也要清：换档后单元格尺寸由新列数决定，
        // 沿用旧的 scale 会让卡片停在错误的尺寸上。
        child.scaleX = 1f
        child.scaleY = 1f
    }
    return FlipSnapshot(anchorPos, anchorTop, anchorWidth, oldLefts, oldTops, oldVisualWidths)
}

/**
 * 等布局**真正**按新 spanCount 刷新后才执行 [doFlip]，没刷新就等下一帧重试。
 *
 * 背景（2026-09-02 定位）：`AndroidView.update` **有可能在 View 的 layout 阶段被触发**
 *（Compose 的 measure/layout 引起的重组）。此时 `RecyclerView` 重写过的 `requestLayout()`
 * 会把请求吞掉——`mInterceptRequestLayoutDepth > 0` 时只置 `mLayoutWasDefered` 而不调
 * `super.requestLayout()`，于是布局不刷新。FLIP 随后对着**旧布局**算 delta，全部小于 1px
 * 被跳过，表现就是「换档偶发无动画、直接硬切」（日志：`children == oldCount` 且全 skipped）。
 *
 * 判据用锚点 item 的宽度：列数变了列宽必然变，宽度没变说明布局还没跟上。
 * 连续快速捏合时后一次换档可能把 spanCount 改回原值，此时宽度永远不变，重试耗尽后放弃动画。
 * [layoutApplied] 允许调用方替换判据——瀑布流冷启动路径必须替换（预览的真实 measure/layout
 * 会把捕获到的宽度改写成目标值，宽度判据永远不成立，见 animateStaggeredSpanChange）。
 */
internal fun runFlipWhenLayoutApplied(
    rv: RecyclerView,
    snap: FlipSnapshot,
    tag: String,
    attempt: Int,
    /** 布局已按新档位刷新的判据；缺省用「锚点宽度变化」。 */
    layoutApplied: ((RecyclerView) -> Boolean)? = null,
    doFlip: () -> Unit,
) {
    // doOnLayout = 每次 draw 前的回调，天然跨帧（上一次实现用 rv.post 做重试，
    // 三次 retry 会挤在同一帧、全在布局刷新之前用完，这里改成递归注册下一次）。
    rv.doOnLayout {
        val applied = layoutApplied?.invoke(rv) ?: run {
            val currentWidth = rv.layoutManager?.findViewByPosition(snap.anchorPos)?.width ?: 0
            snap.anchorWidth <= 0 || currentWidth != snap.anchorWidth
        }
        if (applied) {
            doFlip()
        } else if (attempt < MAX_LAYOUT_RETRY) {
            Log.d(TAG, "[$tag] layout not applied yet, retry #${attempt + 1}")
            // 同步换档那次 requestLayout 可能被吞（update 恰落在 layout 阶段），
            // 而 doOnLayout 在 draw 前、不在 layout 阶段，这里补一次一定生效。
            rv.requestLayout()
            runFlipWhenLayoutApplied(rv, snap, tag, attempt + 1, layoutApplied, doFlip)
        } else {
            Log.d(TAG, "[$tag] give up: layout never applied")
        }
    }
}

/** FLIP 最后一步：二维反向位移 → 240ms / `cubic-bezier(0.22,1,0.36,1)` 动画归位。 */
internal fun playFlip(rv: RecyclerView, snap: FlipSnapshot, tag: String, durationMs: Long) {
    var animated = 0
    var missing = 0
    var skipped = 0
    var maxDelta = 0f
    var maxDeltaPos = -1
    for (i in 0 until rv.childCount) {
        val child = rv.getChildAt(i)
        val pos = rv.getChildAdapterPosition(child)
        val oldTop = snap.oldTops[pos]
        val oldLeft = snap.oldLefts[pos]
        if (oldTop == null || oldLeft == null) {
            // 换档后新进视口的 item 没有旧位置，正常，不参与动画
            missing++
            continue
        }
        // 收尾动画的起始 scale = 捕获时视觉宽 / 新布局宽，松手瞬间视觉宽度连续；
        // 跟手缩放（GRID 预览）与手动布局预览（瀑布流预览，scale=1）统一由该式覆盖。
        // 动画把 scale 归位 1——卡片最终尺寸由布局决定，动画只是补齐中间那段时间。
        val oldVisualW = snap.oldVisualWidths[pos] ?: child.width.toFloat()
        val startScale = if (child.width > 0) (oldVisualW / child.width).coerceIn(0.05f, 20f) else 1f
        val deltaX = oldLeft - child.left
        val deltaY = oldTop - child.top
        if (abs(deltaX) < 1f && abs(deltaY) < 1f && abs(startScale - 1f) < 0.01f) {
            skipped++
            continue
        }
        val d = max(abs(deltaX), abs(deltaY))
        if (d > maxDelta) {
            maxDelta = d
            maxDeltaPos = pos
        }
        child.pivotX = 0f
        child.pivotY = 0f
        child.translationX = deltaX
        child.translationY = deltaY
        child.scaleX = startScale
        child.scaleY = startScale
        child.animate()
            .translationX(0f)
            .translationY(0f)
            .scaleX(1f)
            .scaleY(1f)
            .setDuration(durationMs)
            .setInterpolator(FLIP_INTERPOLATOR)
            .start()
        animated++
    }
    Log.d(
        TAG,
        "[$tag] anchor=${snap.anchorPos}@${snap.anchorTop} children=${rv.childCount} " +
            "oldCount=${snap.oldTops.size} animated=$animated missing=$missing skipped=$skipped " +
            "maxDelta=$maxDelta@$maxDeltaPos",
    )
}

/**
 * 等布局稳定后再执行 [action]。
 *
 * `doOnLayout` 用 OnPreDraw，理论上触发时布局已是新的；但换档路径上会有**多次**
 * requestLayout（spanCount、decoration、封面高度分别在几处触发），若其中某次在 OnPreDraw
 * 之后才被处理，FLIP 就会对着旧布局算 delta——表现为「换档偶发无动画，直接硬切」。
 * 这里多确认一轮：仍有 pending layout 就再等一次。
 */
internal fun afterStableLayout(rv: RecyclerView, action: () -> Unit) {
    rv.doOnLayout {
        if (rv.isLayoutRequested) {
            rv.doOnLayout { action() }
        } else {
            action()
        }
    }
}

/** 锚点精确归位：布局后用 `scrollBy` 修正（同步生效，不必再等一帧）。 */
internal fun fixAnchor(rv: RecyclerView, anchorPos: Int, anchorTop: Int) {
    if (anchorPos == RecyclerView.NO_POSITION) return
    val view = rv.layoutManager?.findViewByPosition(anchorPos) ?: return
    val drift = view.top - anchorTop
    Log.d(
        TAG,
        "[FLIP] fixAnchor anchorPos=$anchorPos anchorTop=$anchorTop viewTop=${view.top} drift=$drift",
    )
    if (drift != 0) rv.scrollBy(0, drift)
}

/**
 * 网格（[GridLayoutManager]）换档 + FLIP 动画，逐项对齐 React 版 `FileGrid.tsx`
 * 的 WAAPI 分支：记录锚点与旧屏幕位置 → 换档 → 把锚点恢复到原屏幕位置 →
 * 对每个 item 做**二维**反向位移 → 归位动画。
 *
 * 捏合路径（[pinchAnchor] 非空）的预览是 PinchFlipController 的真实 measure/layout：
 * progress=1 与新 span 的真实布局逐位一致，收尾 FLIP 位移为零、零跳变（与瀑布流冷启动一致）。
 *
 * 与 React 版的对齐点（此前缺前三项，是「动画看起来不一样」的直接原因）：
 *  1. **二维位移**：列数变化同时改变 item 的 x 与 y，只动 Y 会丢掉横向归位，
 *     网格看起来是「整排上下滑」而不是「每张卡滑向新格位」；
 *  2. **240ms**（React 捏合分支）而非 300ms（300ms 是面板开合分支）；
 *  3. **cubic-bezier(0.22, 1, 0.36, 1)**（React 捏合分支）而非 Material standard；
 *  4. 锚点恢复：`scrollToPositionWithOffset` 的 offset 语义是「decorated start 到 RV 起始边的
 *     距离」，与 view.top 差一个行 inset 与 padding，这里先按 offset 粗定位、布局后再用
 *     `scrollBy` 精确修正；
 *  5. 只给 |delta| ≥ 1px 的 item 起动画，动画结束 transform 归零（等价 React 的 `fill: 'none'`）。
 */
internal fun animateSpanChange(
    rv: RecyclerView,
    lm: GridLayoutManager,
    decoration: GridSpacingDecoration,
    newSpan: Int,
    durationMs: Long = FLIP_DURATION_MS,
    /** 捏合预览的锚点（position + 钳制后的目标 top）；非捏合路径传 null。 */
    pinchAnchor: PinchAnchor? = null,
) {    if (newSpan == lm.spanCount) return
    val oldSpan = lm.spanCount

    val anchorPos = pinchAnchor?.pos?.takeIf { it != RecyclerView.NO_POSITION }
        ?: lm.findFirstVisibleItemPosition()
    val anchorTop = when {
        anchorPos == RecyclerView.NO_POSITION -> 0
        pinchAnchor != null -> pinchAnchor.top
        else -> (lm.findViewByPosition(anchorPos)?.top ?: 0)
    }
    val snap = captureFlip(rv, anchorPos, anchorTop)

    if (snap == null) return

    // Last：同步换档 + 更新间距，并在同一次 requestLayout 里把锚点粗定位回去。
    // （scrollToPositionWithOffset 只是登记 pending 位置，与本次 layout 一起生效。）
    //
    // 必须同步：`lm.spanCount` 立即变化，同一帧后续的 update 才会因 `spanCount == newSpan`
    // 直接 return，不会重复触发换档。requestLayout 若因「update 落在 layout 阶段」被 RV 吞掉，
    // 由 runFlipWhenLayoutApplied 在 draw 前补一次。
    lm.spanCount = newSpan
    decoration.spanCount = newSpan
    rv.invalidateItemDecorations()
    // offset 语义 = 锚点 decorated start 到 RV 起始边的距离；view.top 是内容坐标
    //（行 inset 在其外侧），先扣掉首行 inset 让粗定位尽量准，残余由 fixAnchor 精确修正。
    val anchorRowInset = if (anchorPos / newSpan > 0) decoration.gapPx else 0
    lm.scrollToPositionWithOffset(anchorPos, anchorTop - anchorRowInset - rv.paddingTop)

    Log.d(
        TAG,
        "[FLIP] span $oldSpan -> $newSpan anchorPos=$anchorPos anchorTop=$anchorTop " +
            "paddingTop=${rv.paddingTop} offset=${anchorTop - anchorRowInset - rv.paddingTop} " +
            "firstVisible=${lm.findFirstVisibleItemPosition()} pinchAnchor=${pinchAnchor != null}",
    )
    // 布局已刷新判据：捏合预览（真实 measure/layout）会把锚点宽度改写成目标档位的期望值，
    // 默认的「宽度发生变化」判据会失效；改用「锚点所在列的新档位期望宽度」——旧 span 的
    // 真实布局与预览态都不可能恰好等于它，只有新 span 的真实布局能命中。
    val expectedCol = anchorPos % newSpan
    val borders = PinchFlipController.gridSpanBorders(
        rv.width - rv.paddingLeft - rv.paddingRight,
        newSpan,
    )
    val li = decoration.gapPx * expectedCol / newSpan
    val ri = decoration.gapPx * (newSpan - 1 - expectedCol) / newSpan
    val expectedAnchorWidth = borders[expectedCol + 1] - borders[expectedCol] - li - ri

    runFlipWhenLayoutApplied(
        rv,
        snap,
        "FLIP",
        0,
        layoutApplied = { rv2 ->
            rv2.layoutManager?.findViewByPosition(anchorPos)?.width == expectedAnchorWidth
        },
    ) {
        // 连续快速换档时 snap 可能已被更新的换档覆盖，拿它对着现在的布局算 delta 会把
        // 卡片甩到错误位置（「上半屏正常，下半屏全乱」）。直接放弃这次 FLIP。
        if (lm.spanCount != newSpan) {
            Log.d(TAG, "[FLIP] superseded (span now ${lm.spanCount}, wanted $newSpan), skip")
            return@runFlipWhenLayoutApplied
        }
        Log.d(
            TAG,
            "[FLIP] layout-applied anchorPos=$anchorPos anchorTop=$anchorTop " +
                "nowTop=${lm.findViewByPosition(anchorPos)?.top} " +
                "firstVisible=${lm.findFirstVisibleItemPosition()}",
        )
        fixAnchor(rv, anchorPos, anchorTop)
        playFlip(rv, snap, "FLIP", durationMs)
    }
}

/** 瀑布流捏合预览的锚点快照（position + 捏合中的屏幕 top），供松手换档无缝衔接。 */
internal class PinchAnchor(val pos: Int, val top: Int)

/**
 * 瀑布流（[StaggeredGridLayoutManager]）换档 + FLIP，动画参数与 [animateSpanChange] 完全一致。
 *
 * **换档即换 LayoutManager（冷启动布局）**。1.3.2 的 Staggered 保留旧 children 重布局时，
 * `scrollToPositionWithOffset` 的 offset 语义经过旧 decoratedStart 折算、旧 span 列线又混进
 * 新列数的布局，真实布局和捏合预览的目标位置对不上——表现为松手后整个网格再跳一下。
 * 换上全新 LM 后首个布局没有任何旧状态：从锚点起铺、逐个放入最短列（`getNextSpan` 的
 * LAYOUT_END 分支），与 `MasonryPinchController` 的离线模拟逐位一致，FLIP 收尾就是最终布局。
 *
 * [pinchAnchor]：捏合预览的锚点。松手换档必须保持**同一个锚点**停在**同一屏幕位置**，
 * 预览与收尾才无缝；非捏合路径传 null，退回「top 最小的可见图」扫描（跳过满宽 header）。
 */
internal fun animateStaggeredSpanChange(
    rv: RecyclerView,
    oldLm: StaggeredGridLayoutManager,
    decoration: GridSpacingDecoration,
    newSpan: Int,
    durationMs: Long = FLIP_DURATION_MS,
    isFullSpanAt: (Int) -> Boolean = { false },
    gapPx: Int = 0,
    pinchAnchor: PinchAnchor? = null,
    /** 每轮布局（含预填）末尾重放捏合预览几何，与 createLayoutManager 的接线一致。 */
    previewRestorer: (() -> Unit)? = null,
) {
    if (newSpan == oldLm.spanCount) return
    val oldSpan = oldLm.spanCount

    var anchorPos = RecyclerView.NO_POSITION
    var anchorTop = 0
    if (pinchAnchor != null && pinchAnchor.pos != RecyclerView.NO_POSITION &&
        pinchAnchor.pos < (rv.adapter?.itemCount ?: 0)
    ) {
        anchorPos = pinchAnchor.pos
        anchorTop = pinchAnchor.top
    } else {
        for (i in 0 until rv.childCount) {
            val child = rv.getChildAt(i)
            val pos = rv.getChildAdapterPosition(child)
            if (pos == RecyclerView.NO_POSITION || isFullSpanAt(pos)) continue
            if (anchorPos == RecyclerView.NO_POSITION || child.top < anchorTop) {
                anchorPos = pos
                anchorTop = child.top
            }
        }
    }
    val snap = captureFlip(rv, anchorPos, anchorTop)
    if (snap == null) return

    // 冷启动：换全新 LM（旧 children 全部回收、span 记账从零开始），锚点经 pending scroll
    // 定位——首个布局从锚点位置起铺满视口，与捏合模拟同构；随后 fixAnchor 精确对齐，
    // 其中的 scrollBy 还会顺带把锚点上方未铺的区域按同一规则补齐。
    val newLm = AuroraStaggeredLayoutManager(newSpan, isFullSpanAt, gapPx)
    newLm.previewRestorer = previewRestorer
    rv.layoutManager = newLm
    decoration.spanCount = newSpan
    rv.invalidateItemDecorations()
    newLm.scrollToPositionWithOffset(anchorPos, anchorTop - rv.paddingTop)

    Log.d(
        TAG,
        "[FLIP] staggered cold-start span $oldSpan -> $newSpan anchorPos=$anchorPos " +
            "anchorTop=$anchorTop pinchAnchor=${pinchAnchor != null}",
    )
    runFlipWhenLayoutApplied(
        rv,
        snap,
        "FLIP",
        0,
        // 冷启动换档不能默认用「锚点宽度变化」判据：捏合预览（真实 measure/layout）把卡片
        // 宽度改写成了目标档位值，captureFlip 记录的就是它——新布局一刷新宽度必然相等，
        // 默认判据会误判「未刷新」并把 fixAnchor/playFlip 一路重试到放弃。换全新 LM 后
        // 子 View 全部回收，「LM 已是新的且有子 View」就是首个冷启动布局完成的确凿信号。
        layoutApplied = { it.layoutManager === newLm && it.childCount > 0 },
    ) {
        // 连续快速换档：执行时档位/LM 已被更新的换档覆盖，snapshot 全过期，放弃本次动画
        val current = rv.layoutManager as? StaggeredGridLayoutManager
        if (current !== newLm || current.spanCount != newSpan) {
            Log.d(TAG, "[FLIP] superseded (lm now $current), skip")
            return@runFlipWhenLayoutApplied
        }
        fixAnchor(rv, anchorPos, anchorTop)
        // playFlip 必须与 fixAnchor 同帧：fixAnchor 的 scrollBy（锚点被滚动边界钳制时可达
        // 半屏）立即生效，playFlip 设置的反向 translation 是它的视觉补偿——两者分处两帧，
        // 中间帧会裸露出未被补偿的位移（表现为「松手跳一下」）。
        playFlip(rv, snap, "FLIP", durationMs)
        // fixAnchor 的 scrollBy 若有位移会走增量 fill 路径、回收手工预填的 view；
        // 视口下方的预填由 AuroraStaggeredLayoutManager 在每轮 onLayoutChildren 末尾自动补，
        // 本次 requestLayout 的那轮布局就会补上，无需再单独置位。
        // 必须先失效锚点：冷启动给 AnchorInfo 留下了 mOffset=锚点top + mInvalidateOffsets=true
        // 的陈旧状态，直接重布局会把所有列线 seed 到锚点 top、内容整体下跳一个 inset。
        // invalidateSpanAssignments 让下次布局走「从当前子 View 重算锚点」的标准路径，位置不变。
        newLm.invalidateSpanAssignments()
        rv.requestLayout()
    }
}

/** 持有 RecyclerView 引用，供捏合回调使用。用普通 holder 而非 state，避免赋值触发重组。 */
internal class RvHolder {
    var rv: RecyclerView? = null
}

/**
 * 清掉 FLIP 动画 / 捏合跟手缩放残留的 transform（Adapter.onBindViewHolder 调用，防止复用错位）。
 *
 * scale 也要清——捏合结束后若不清，复用到别的 item 上会带着上一次的缩放。
 * 捏合进行中的复用不受影响：`applyToNewChild` 紧接着会重新写上正确的 transform。
 */
internal fun resetFlipTransform(view: View) {
    if (view.translationX != 0f || view.translationY != 0f ||
        view.scaleX != 1f || view.scaleY != 1f
    ) {
        view.animate().cancel()
        view.translationX = 0f
        view.translationY = 0f
        view.scaleX = 1f
        view.scaleY = 1f
        view.pivotX = view.width / 2f
        view.pivotY = view.height / 2f
    }
}

/** dp → px（View 体系用像素）。 */
internal fun Context.dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

/** px → dp（列数计算对齐 React 版 CSS 像素）。 */
internal fun Context.pxToDp(px: Int): Int = (px / resources.displayMetrics.density).roundToInt()
