package com.aurora.gallery.kotlin.ui.components

import android.content.Context
import android.graphics.Rect
import android.util.AttributeSet
import android.view.MotionEvent
import android.view.ScaleGestureDetector
import android.view.View
import android.view.animation.PathInterpolator
import android.widget.ImageView
import androidx.core.view.doOnLayout
import androidx.recyclerview.widget.GridLayoutManager
import androidx.recyclerview.widget.RecyclerView
import kotlin.math.max
import kotlin.math.roundToInt

/** 正方形 ImageView：高度恒等于宽度（onMeasure 用 widthMeasureSpec 同时作为高度）。 */
class SquareImageView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
    defStyleAttr: Int = 0,
) : ImageView(context, attrs, defStyleAttr) {
    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        super.onMeasure(widthMeasureSpec, widthMeasureSpec)
    }
}

/**
 * 网格间距：非首列加左间距、非首行加顶部间距。
 * 四周的 padding 由 RecyclerView 自身的 padding 负责。[spanCount] 可变（三档捏合换档时更新）。
 */
class GridSpacingDecoration(
    var spanCount: Int,
    private val gapPx: Int,
) : RecyclerView.ItemDecoration() {
    override fun getItemOffsets(
        outRect: Rect,
        view: View,
        parent: RecyclerView,
        state: RecyclerView.State,
    ) {
        val position = parent.getChildAdapterPosition(view)
        if (position == RecyclerView.NO_POSITION) return
        val column = position % spanCount
        val row = position / spanCount
        outRect.left = if (column > 0) gapPx else 0
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
 */
class PinchGridSpanListener(
    context: Context,
    private val currentLevel: () -> Int,
    private val onLevelChange: (Int) -> Unit,
) : View.OnTouchListener {
    private var startLevel = -1
    private var stepped = false
    private var initialSpan = 0f
    private val scaleDetector = ScaleGestureDetector(context, object : ScaleGestureDetector.SimpleOnScaleGestureListener() {
        override fun onScaleBegin(detector: ScaleGestureDetector): Boolean {
            startLevel = currentLevel()
            stepped = false
            initialSpan = detector.currentSpan
            return true
        }

        override fun onScale(detector: ScaleGestureDetector): Boolean {
            if (!stepped && initialSpan > 0f) {
                val totalScale = detector.currentSpan / initialSpan
                if (totalScale > STEP_THRESHOLD) {
                    stepped = true
                    onLevelChange(startLevel + 1)
                } else if (totalScale < 1f / STEP_THRESHOLD) {
                    stepped = true
                    onLevelChange(startLevel - 1)
                }
            }
            return true
        }
    })

    override fun onTouch(v: View, event: MotionEvent): Boolean {
        scaleDetector.onTouchEvent(event)
        // 缩放进行中返回 true 拦截（阻止 RecyclerView 滚动），否则交回 RecyclerView
        return scaleDetector.isInProgress
    }

    companion object {
        private const val STEP_THRESHOLD = 1.08f
    }
}

/**
 * 换档 + FLIP 动画（锚点保持，对齐 React 版）：记录锚点 + item 旧位置 → 换档 →
 * 恢复到锚点 offset → 反向位移 → 动画归位（换档无跳变）。
 */
fun animateSpanChange(
    rv: RecyclerView,
    lm: GridLayoutManager,
    decoration: GridSpacingDecoration,
    newSpan: Int,
) {
    if (newSpan == lm.spanCount) return

    // First：记录锚点（视口首个可见 item + 偏移）与所有可见 item 旧位置
    val anchorPos = lm.findFirstVisibleItemPosition()
    val anchorTop = if (anchorPos == RecyclerView.NO_POSITION) 0
        else (lm.findViewByPosition(anchorPos)?.top ?: 0)
    val oldTops = HashMap<Int, Int>()
    for (i in 0 until rv.childCount) {
        val child = rv.getChildAt(i)
        val pos = rv.getChildAdapterPosition(child)
        if (pos != RecyclerView.NO_POSITION) oldTops[pos] = child.top
    }

    // Last：换档 + 更新间距
    lm.spanCount = newSpan
    decoration.spanCount = newSpan
    rv.invalidateItemDecorations()

    // 布局完成后：锚点恢复，再做 FLIP
    rv.doOnLayout {
        if (anchorPos != RecyclerView.NO_POSITION) {
            lm.scrollToPositionWithOffset(anchorPos, anchorTop)
        }
        // 等滚动后的布局，再做 FLIP 动画
        rv.doOnLayout {
            for (i in 0 until rv.childCount) {
                val child = rv.getChildAt(i)
                val pos = rv.getChildAdapterPosition(child)
                val oldTop = oldTops[pos] ?: continue
                val delta = oldTop - child.top
                if (delta != 0) {
                    child.translationY = delta.toFloat()
                    child.animate()
                        .translationY(0f)
                        .setDuration(300)
                        .setInterpolator(PathInterpolator(0.4f, 0f, 0.2f, 1f))
                        .start()
                }
            }
        }
    }
}

/** dp → px（View 体系用像素）。 */
internal fun Context.dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

/** px → dp（列数计算对齐 React 版 CSS 像素）。 */
internal fun Context.pxToDp(px: Int): Int = (px / resources.displayMetrics.density).roundToInt()
