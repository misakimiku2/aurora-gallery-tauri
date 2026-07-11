package com.aurora.gallery

import android.content.Context
import android.graphics.Matrix
import android.graphics.RectF
import android.util.AttributeSet
import android.view.GestureDetector
import android.view.MotionEvent
import android.view.ScaleGestureDetector
import android.view.VelocityTracker
import android.view.ViewConfiguration
import android.widget.OverScroller
import androidx.appcompat.widget.AppCompatImageView
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

/**
 * 支持双击缩放、pinch-zoom、pan、fling 的 ImageView。
 * 矩阵变换通过 [Matrix] 实现，避免创建中间 Bitmap。
 *
 * 旋转通过 [rotationDegrees] 字段管理（90 度递增），通过 [setRotationDegrees] 设置。
 * 旋转后重新计算 fit scale 和居中位置。
 *
 * 当 scale 处于 fit 状态且用户水平拖动超过 [SWIPE_THRESHOLD] 时，会通过
 * [OnSwipeOutListener] 通知父级触发翻页，避免与 pan 冲突。
 */
class ZoomableImageView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
    defStyleAttr: Int = 0,
) : AppCompatImageView(context, attrs, defStyleAttr) {

    interface OnSwipeOutListener {
        /** 用户在 fit 状态下水平拖动超出阈值。direction=-1 表示上一张，1 表示下一张。 */
        fun onSwipeOut(direction: Int, dx: Float)
        /** 翻页拖动进行中，dx 为相对起点的水平位移（正=向右=上一张，负=向左=下一张）。 */
        fun onSwipeDrag(dx: Float)
        /** 翻页拖动结束。dx 为最终位移，velocityX 为水平速度。父级决定翻页或回弹。 */
        fun onSwipeEnd(dx: Float, velocityX: Float)
        /** 单击（非双击）。 */
        fun onSingleTapConfirmed()
        /** 长按。 */
 fun onLongPressConfirmed()
        /** 触摸开始（ACTION_DOWN）。父级可在此取消残留的 ViewPropertyAnimator（如回弹动画），防止与新拖动冲突导致抖动。 */
        fun onTouchDown() {}
        /** 垂直拖动进行中，dy 为相对起点的垂直位移（正=向下=收起抽屉，负=向上=呼出抽屉）。 */
        fun onVerticalSwipeDrag(dy: Float) {}
        /** 垂直拖动结束。dy 为最终位移，velocityY 为垂直速度。父级决定打开/关闭或回弹。 */
        fun onVerticalSwipeEnd(dy: Float, velocityY: Float) {}
    }

    /** fit-to-screen 时的缩放比例 */
    private var fitScale = 1f
    /** 当前缩放比例（相对于 fit） */
    private var currentScale = 1f
    /** 用户平移偏移 */
    private var translateX = 0f
    private var translateY = 0f
    /** 旋转角度（0/90/180/270） */
    private var rotationDegrees = 0

    /** 是否处于双击缩放动画中 */
    private var isAnimating = false

    /**
     * 抽屉填充进度：0=适应(fit, 留白)，1=填充(fill, 裁剪)。
     * 抽屉打开时由 NativeGalleryView.toggleDrawer 动画驱动 0→1，关闭时 1→0。
     * resetToCenter 据此在 minScale 和 maxScale 之间插值。
     */
    var drawerFillProgress = 0f

    /**
     * 抽屉打开前的全屏视图宽度。resetToCenter 计算 fitS 时使用此值（固定），
     * 而 fillS 使用当前 vw（随抽屉宽度变化）。这样抽屉展开过程中 fitScale 单调
     * 变化，避免横屏图片因 vw 减小导致 fitS 先降后升的"缩小再还原"现象。
     * 由 NativeGalleryView.applyDrawerProgress 设置为 NativeGalleryView.width。
     */
    var drawerFullWidth = 0f

    private val scaledDrawableRect = RectF()
    private val displayRect = RectF()

    var swipeOutListener: OnSwipeOutListener? = null

    /** 是否允许翻页手势（仅在 fit 状态下允许） */
    var allowSwipe = true
    /** 是否允许双击/双指缩放（抽屉打开时禁止，避免缩放与 drawerFillProgress 填充逻辑冲突） */
    var allowZoom = true
    /** 本次手势是否已判定为翻页手势（水平主导） */
    private var swipeTriggered = false
    /** 翻页手势进行中：此时图片跟随手指 X 平移，松手决定翻页/回弹 */
    private var swipeDragging = false
    /** 翻页手势起始 X */
    private var swipeStartX = 0f
    /** 翻页拖动累计偏移 */
    private var swipeDx = 0f
    /** 本次手势是否已判定为垂直滑动（抽屉控制） */
    private var verticalSwipeTriggered = false
    /** 垂直滑动进行中：此时回调父级控制抽屉，松手决定打开/关闭或回弹 */
    private var verticalSwipeDragging = false
    /** 垂直手势起始 Y（rawY，避免 e1 被 recycle） */
    private var swipeStartY = 0f
    /** 垂直拖动累计偏移 */
    private var verticalSwipeDy = 0f

    private val touchSlop = ViewConfiguration.get(context).scaledTouchSlop
    private val swipeThreshold = resources.displayMetrics.widthPixels * 0.15f
    /** 翻页触发阈值：拖动距离超过屏幕宽度的 25% 即翻页 */
    private val swipeTriggerThreshold = resources.displayMetrics.widthPixels * 0.25f
    /** 翻页速度阈值：松手时水平速度超过此值即翻页 */
    private val swipeVelocityThreshold = 500f

    private val scaleDetector = ScaleGestureDetector(context, object : ScaleGestureDetector.SimpleOnScaleGestureListener() {
        override fun onScaleBegin(detector: ScaleGestureDetector): Boolean {
            if (!allowZoom) {
                return false
            }
            isAnimating = false
            // 取消正在进行的 fling，避免 flingRunnable 在 scale 期间覆盖 translate
            scroller.abortAnimation()
            removeCallbacks(flingRunnable)
            // 重置 swipe 标志，避免双指缩放前 onScroll 误触发的翻页/抽屉拖动
            // 在 ACTION_UP 时被提交（onSwipeEnd/onVerticalSwipeEnd）
            swipeTriggered = false
            swipeDragging = false
            verticalSwipeTriggered = false
            verticalSwipeDragging = false
            return true
        }
        override fun onScale(detector: ScaleGestureDetector): Boolean {
            val factor = detector.scaleFactor
            val newScale = currentScale * factor
            // 限制缩放范围 [1, MAX_SCALE]
            val clamped = newScale.coerceIn(0.85f, MAX_SCALE)
            // 中心点缩放：基于手指中点
            val focusX = detector.focusX
            val focusY = detector.focusY
            // 调整 translate 使得 focusX/Y 处的图像点保持不变
            val scaleDelta = clamped / currentScale
            translateX = focusX - (focusX - translateX) * scaleDelta
            translateY = focusY - (focusY - translateY) * scaleDelta
            currentScale = clamped
            // 缩放后 clamp 到边界，避免快速收拢时图片飞出屏幕（focus 在边缘时
            // 缩放公式会把 translate 拉向边缘，缩小后图片变小可能完全脱离屏幕）
            clampTranslateToBounds()
            applyMatrix()
            return true
        }
        override fun onScaleEnd(detector: ScaleGestureDetector) {
            // 缩放回弹到 1.0 if 用户缩小到 < 1
            if (currentScale < 1f) {
                animateScaleTo(1f)
            }
        }
    })

    private val gestureDetector = GestureDetector(context, object : GestureDetector.SimpleOnGestureListener() {
        override fun onSingleTapConfirmed(e: MotionEvent): Boolean {
            swipeOutListener?.onSingleTapConfirmed()
            return true
        }
        override fun onDoubleTap(e: MotionEvent): Boolean {
            if (!allowZoom) {
                return false
            }
            // 取消正在进行的 fling，避免 flingRunnable 在动画期间覆盖 translate
            scroller.abortAnimation()
            removeCallbacks(flingRunnable)
            if (currentScale > 1.01f) {
                animateScaleTo(1f)
            } else {
                // 双击时基于双击点缩放到 2x，然后到 MAX_SCALE
                val next = when {
                    currentScale < 1.5f -> 2f
                    else -> MAX_SCALE
                }
                animateScaleTo(next, e.x, e.y)
            }
            return true
        }
        override fun onLongPress(e: MotionEvent) {
            swipeOutListener?.onLongPressConfirmed()
        }
        override fun onScroll(e1: MotionEvent?, e2: MotionEvent, distanceX: Float, distanceY: Float): Boolean {
            if (isAnimating) return false
            // 双指缩放进行中时不处理 scroll（翻页/垂直滑动/平移），避免误触发
            if (scaleDetector.isInProgress) return false
            // fit 状态（未放大）：判定是否为水平或垂直滑动主导
            if (allowSwipe && currentScale <= 1.01f) {
                // 使用 rawX/rawY 计算，避免 e1 被 recycle 导致坐标跳动
                val currentRawX = e2.rawX
                val currentRawY = e2.rawY
                val totalDx = currentRawX - swipeStartX
                val totalDy = currentRawY - swipeStartY
                // 水平为主且超过 slop，进入翻页拖动模式
                if (!swipeTriggered && !verticalSwipeTriggered && abs(totalDx) > touchSlop && abs(totalDx) > abs(totalDy) * 1.5f) {
                    swipeTriggered = true
                    swipeDragging = true
                    // 重置起点为当前位置，使拖动偏移从 0 开始，避免 touchSlop 范围内的瞬间跳变
                    swipeStartX = currentRawX
                }
                // 垂直为主且超过 slop，进入抽屉拖动模式
                // 排除屏幕顶部/底部边缘区域（系统状态栏下拉、返回主界面手势）
                val screenHeight = resources.displayMetrics.heightPixels
                val edgeZone = resources.displayMetrics.density * 24
                val startInVerticalEdge = swipeStartY < edgeZone || swipeStartY > screenHeight - edgeZone
                if (!swipeTriggered && !verticalSwipeTriggered && !startInVerticalEdge && abs(totalDy) > touchSlop && abs(totalDy) > abs(totalDx) * 1.5f) {
                    verticalSwipeTriggered = true
                    verticalSwipeDragging = true
                    swipeStartY = currentRawY
                }
                if (swipeDragging) {
                    swipeDx = currentRawX - swipeStartX
                    swipeOutListener?.onSwipeDrag(swipeDx)
                    return true
                }
                if (verticalSwipeDragging) {
                    verticalSwipeDy = currentRawY - swipeStartY
                    swipeOutListener?.onVerticalSwipeDrag(verticalSwipeDy)
                    return true
                }
                return true // fit 状态下消费事件但不平移
            }
            // 已放大：跟随手指平移，但 clamp 到边界内（图片不能完全脱离屏幕边缘）
            translateX -= distanceX
            translateY -= distanceY
            clampTranslateToBounds()
            applyMatrix()
            return true
        }
        override fun onFling(e1: MotionEvent?, e2: MotionEvent, velocityX: Float, velocityY: Float): Boolean {
            if (currentScale <= 1.01f) return false
            val d = drawable ?: return false
            val vw = width.toFloat()
            val vh = height.toFloat()
            if (vw <= 0f || vh <= 0f) return false
            val isRotated = rotationDegrees == 90 || rotationDegrees == 270
            val logicW = (if (isRotated) d.intrinsicHeight else d.intrinsicWidth).toFloat() * fitScale * currentScale
            val logicH = (if (isRotated) d.intrinsicWidth else d.intrinsicHeight).toFloat() * fitScale * currentScale
            // fling 边界：图片不能完全脱离屏幕
            val minX: Float
            val maxX: Float
            if (logicW <= vw) {
                val center = (vw - logicW) / 2f
                minX = center; maxX = center
            } else {
                minX = vw - logicW; maxX = 0f
            }
            val minY: Float
            val maxY: Float
            if (logicH <= vh) {
                val center = (vh - logicH) / 2f
                minY = center; maxY = center
            } else {
                minY = vh - logicH; maxY = 0f
            }
            scroller.abortAnimation()
            removeCallbacks(flingRunnable)
            scroller.fling(
                translateX.toInt(), translateY.toInt(),
                velocityX.toInt(), velocityY.toInt(),
                minX.toInt(), maxX.toInt(), minY.toInt(), maxY.toInt()
            )
            post(flingRunnable)
            return true
        }
    })

    private val scroller = OverScroller(context)
    private val flingRunnable = object : Runnable {
        override fun run() {
            if (scroller.computeScrollOffset()) {
                translateX = scroller.currX.toFloat()
                translateY = scroller.currY.toFloat()
                applyMatrix()
                postOnAnimation(this)
            }
        }
    }

    private var velocityTracker: VelocityTracker? = null

    init {
        scaleType = ScaleType.MATRIX
    }

    override fun setImageDrawable(drawable: android.graphics.drawable.Drawable?) {
        // 停止旧 drawable 的帧动画（如 animated WebP/GIF 的 AnimatedImageDrawable）
        (getDrawable() as? android.graphics.drawable.Animatable)?.stop()
        super.setImageDrawable(drawable)
        if (drawable != null) {
            // 启动新 drawable 的帧动画（AnimatedImageDrawable 需显式 start 才会播放）
            (drawable as? android.graphics.drawable.Animatable)?.start()
            if (width > 0 && height > 0) {
                resetToCenter()
            } else {
                post { resetToCenter() }
            }
        }
    }

    /**
     * 计算并应用缩放使图片居中显示。
     *
     * 缩放模式由 [drawerFillProgress] 控制：
     * - 0 = fit（min scale，整图可见，留白）
     * - 1 = fill（max scale，填满视图，裁剪）
     * 中间值在两者间线性插值，实现抽屉展开/收起时图片平滑放大/缩小。
     */
    fun resetToCenter() {
        val d = drawable ?: return
        val vw = width.toFloat()
        val vh = height.toFloat()
        if (vw <= 0f || vh <= 0f) return
        val dw = d.intrinsicWidth.toFloat()
        val dh = d.intrinsicHeight.toFloat()
        if (dw <= 0f || dh <= 0f) return

        // 计算旋转后的逻辑尺寸
        val isRotated = rotationDegrees == 90 || rotationDegrees == 270
        val logicW = if (isRotated) dh else dw
        val logicH = if (isRotated) dw else dh

        // fitS 基于全屏宽度（固定），避免抽屉展开 vw 减小时 fitS 先降后升；
        // fillS 基于当前 vw（随抽屉宽度变化），实现"填充剩余区域"
        val fitVw = if (drawerFullWidth > 0f) drawerFullWidth else vw
        val fitS = min(fitVw / logicW, vh / logicH)
        val fillS = max(vw / logicW, vh / logicH)
        fitScale = fitS + (fillS - fitS) * drawerFillProgress
        currentScale = 1f
        translateX = (vw - logicW * fitScale) / 2f
        translateY = (vh - logicH * fitScale) / 2f
        applyMatrix()
    }

    private fun applyMatrix() {
        val m = Matrix()
        // 先移动到原点，缩放，旋转，再平移到 translate
        val d = drawable ?: return
        val dw = d.intrinsicWidth.toFloat()
        val dh = d.intrinsicHeight.toFloat()
        if (dw <= 0f || dh <= 0f) return

        val isRotated = rotationDegrees == 90 || rotationDegrees == 270
        val logicW = if (isRotated) dh else dw
        val logicH = if (isRotated) dw else dh

        // 1. 把 drawable 移到原点
        m.postTranslate(-dw / 2f, -dh / 2f)
        // 2. 旋转（绕原点）
        if (rotationDegrees != 0) {
            m.postRotate(rotationDegrees.toFloat())
        }
        // 3. 缩放（fitScale * currentScale）
        val totalScale = fitScale * currentScale
        m.postScale(totalScale, totalScale)
        // 4. 平移到 translate 位置（注意旋转后 width/height 互换）
        m.postTranslate(translateX + logicW * totalScale / 2f, translateY + logicH * totalScale / 2f)

        imageMatrix = m

        // 更新 displayRect 供边界检测
        scaledDrawableRect.set(0f, 0f, logicW * totalScale, logicH * totalScale)
        displayRect.set(scaledDrawableRect)
        displayRect.offset(translateX, translateY)
    }

    /** 平滑缩放到指定 scale（相对于 fit）。 */
    private fun animateScaleTo(targetScale: Float, focusX: Float = width / 2f, focusY: Float = height / 2f) {
        // 取消正在进行的 fling，避免 flingRunnable 在动画期间覆盖 translate
        scroller.abortAnimation()
        removeCallbacks(flingRunnable)
        isAnimating = true
        val startScale = currentScale
        val startTx = translateX
        val startTy = translateY
        val scaleDelta = targetScale / startScale
        // 缩到 fit (targetScale<=1)：直接用 fit 居中位置作为 target，避免 focus 公式算出偏离 fit 的 translate
        // 导致缩到 1x 后图片未居中（下方留白）。放大时用 focus 公式保持点击点不动。
        val targetTx: Float
        val targetTy: Float
        val useFitCenter = targetScale <= 1.001f
        if (useFitCenter) {
            val d = drawable ?: return
            val vw = width.toFloat()
            val vh = height.toFloat()
            if (vw > 0f && vh > 0f) {
                val isRotated = rotationDegrees == 90 || rotationDegrees == 270
                val logicW = (if (isRotated) d.intrinsicHeight else d.intrinsicWidth).toFloat()
                val logicH = (if (isRotated) d.intrinsicWidth else d.intrinsicHeight).toFloat()
                targetTx = (vw - logicW * fitScale) / 2f
                targetTy = (vh - logicH * fitScale) / 2f
            } else {
                targetTx = focusX - (focusX - startTx) * scaleDelta
                targetTy = focusY - (focusY - startTy) * scaleDelta
            }
        } else {
            // 让 focusX/Y 处的图像点保持不变
            targetTx = focusX - (focusX - startTx) * scaleDelta
            targetTy = focusY - (focusY - startTy) * scaleDelta
        }
        val startTime = android.os.SystemClock.uptimeMillis()
        val duration = 250L
        post(object : Runnable {
            override fun run() {
                val t = ((android.os.SystemClock.uptimeMillis() - startTime) / duration.toFloat()).coerceIn(0f, 1f)
                // ease-out
                val eased = 1f - (1f - t) * (1f - t)
                currentScale = startScale + (targetScale - startScale) * eased
                translateX = startTx + (targetTx - startTx) * eased
                translateY = startTy + (targetTy - startTy) * eased
                applyMatrix()
                if (t < 1f) {
                    postOnAnimation(this)
                } else {
                    isAnimating = false
                    if (currentScale < 1f) {
                        animateScaleTo(1f)
                    } else if (currentScale > 1.01f) {
                        // 放大结束后确保图像在边界内（focus 缩放只保证点击点不动，不保证整体在边界内）
                        bounceBackToBounds()
                    }
                }
            }
        })
    }

    /** 设置 90 度递增的旋转角度。会重置缩放和平移。 */
    fun setRotationDegrees(degrees: Int) {
        rotationDegrees = ((degrees % 360) + 360) % 360
        resetToCenter()
    }

    fun getRotationDegrees(): Int = rotationDegrees

    /** 重置缩放和位置到 fit 状态（不改变旋转）。 */
    fun resetZoom() {
        if (isAnimating) return
        animateScaleTo(1f)
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        scaleDetector.onTouchEvent(event)
        gestureDetector.onTouchEvent(event)
        if (event.actionMasked == MotionEvent.ACTION_DOWN) {
            velocityTracker = VelocityTracker.obtain()
            swipeTriggered = false // 重置翻页标志，允许本次手势再次触发
            swipeDragging = false
            verticalSwipeTriggered = false
            verticalSwipeDragging = false
            // 记录起始 X/Y（使用 rawX/rawY 避免被 recycle）
            swipeStartX = event.rawX
            swipeStartY = event.rawY
            // 通知父级取消残留动画（如回弹），防止 ViewPropertyAnimator 与新拖动冲突导致抖动
            swipeOutListener?.onTouchDown()
        }
        velocityTracker?.addMovement(event)
        if (event.actionMasked == MotionEvent.ACTION_UP || event.actionMasked == MotionEvent.ACTION_CANCEL) {
            // 翻页拖动结束：通知父级
            if (swipeDragging) {
                swipeDragging = false
                val vx = velocityTracker?.let { it.computeCurrentVelocity(1000); it.xVelocity } ?: 0f
                swipeOutListener?.onSwipeEnd(swipeDx, vx)
            }
            // 垂直拖动结束：通知父级
            if (verticalSwipeDragging) {
                verticalSwipeDragging = false
                val vy = velocityTracker?.let { it.computeCurrentVelocity(1000); it.yVelocity } ?: 0f
                swipeOutListener?.onVerticalSwipeEnd(verticalSwipeDy, vy)
            }
            // 检查是否需要回弹
            // 注意：isAnimating 期间（双击缩放动画正在跑）不要触发 bounceBackToBounds，
            // 否则 bounce 会基于中间帧 scale 算出错误的 target，覆盖双击缩放的 target。
            // 双击缩放动画结束后会自行调用 bounceBackToBounds（见 animateScaleTo）。
            if (!isAnimating && currentScale > 1.01f) {
                bounceBackToBounds()
            }
            velocityTracker?.recycle()
            velocityTracker = null
        }
        return true
    }

    /**
     * 将 translateX/Y 同步 clamp 到合法边界内，使图片不能完全脱离屏幕边缘。
     * - 图片某边长 ≤ 视图：该方向居中（translate = (v - logic)/2）
     * - 图片某边长 > 视图：translate 限制在 [v - logic, 0]（图片至少贴住一条边）
     * 用于 onScroll 拖动期间实时约束，避免图片飞出屏幕。
     */
    private fun clampTranslateToBounds() {
        val d = drawable ?: return
        val vw = width.toFloat()
        val vh = height.toFloat()
        if (vw <= 0f || vh <= 0f) return
        val isRotated = rotationDegrees == 90 || rotationDegrees == 270
        val logicW = (if (isRotated) d.intrinsicHeight else d.intrinsicWidth).toFloat() * fitScale * currentScale
        val logicH = (if (isRotated) d.intrinsicWidth else d.intrinsicHeight).toFloat() * fitScale * currentScale
        if (logicW <= vw) {
            translateX = (vw - logicW) / 2f
        } else {
            translateX = translateX.coerceIn(vw - logicW, 0f)
        }
        if (logicH <= vh) {
            translateY = (vh - logicH) / 2f
        } else {
            translateY = translateY.coerceIn(vh - logicH, 0f)
        }
    }

    /** 当缩放超过 1 时，平移到边界外则回弹到边界。 */
    private fun bounceBackToBounds() {
        val vw = width.toFloat()
        val vh = height.toFloat()
        if (vw <= 0f || vh <= 0f) return
        val d = drawable ?: return
        val isRotated = rotationDegrees == 90 || rotationDegrees == 270
        val logicW = (if (isRotated) d.intrinsicHeight else d.intrinsicWidth).toFloat() * fitScale * currentScale
        val logicH = (if (isRotated) d.intrinsicWidth else d.intrinsicHeight).toFloat() * fitScale * currentScale
        if (logicW <= 0f || logicH <= 0f) return

        var targetX = translateX
        var targetY = translateY
        if (logicW <= vw) {
            targetX = (vw - logicW) / 2f
        } else {
            if (translateX > 0) targetX = 0f
            else if (translateX < vw - logicW) targetX = vw - logicW
        }
        if (logicH <= vh) {
            targetY = (vh - logicH) / 2f
        } else {
            if (translateY > 0) targetY = 0f
            else if (translateY < vh - logicH) targetY = vh - logicH
        }
        if (abs(targetX - translateX) < 1f && abs(targetY - translateY) < 1f) return
        // 简单平滑
        isAnimating = true
        val startX = translateX
        val startY = translateY
        val startTime = android.os.SystemClock.uptimeMillis()
        val duration = 200L
        post(object : Runnable {
            override fun run() {
                val t = ((android.os.SystemClock.uptimeMillis() - startTime) / duration.toFloat()).coerceIn(0f, 1f)
                val eased = 1f - (1f - t) * (1f - t)
                translateX = startX + (targetX - startX) * eased
                translateY = startY + (targetY - startY) * eased
                applyMatrix()
                if (t < 1f) {
                    postOnAnimation(this)
                } else {
                    isAnimating = false
                    applyMatrix()
                }
            }
        })
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        if (w > 0 && h > 0) {
            if (currentScale > 1.01f) {
                // 放大状态下尺寸变化（如 immersive 切换隐藏/显示 status bar 导致窗口尺寸变化），
                // 保留用户的缩放状态，只重新计算 fitScale 并 clamp translate 到新边界。
                // 仅在 fit 状态（currentScale≈1）时才 resetToCenter。
                val d = drawable ?: return
                val vw = w.toFloat()
                val vh = h.toFloat()
                val isRotated = rotationDegrees == 90 || rotationDegrees == 270
                val logicW = (if (isRotated) d.intrinsicHeight else d.intrinsicWidth).toFloat()
                val logicH = (if (isRotated) d.intrinsicWidth else d.intrinsicHeight).toFloat()
                val fitVw = if (drawerFullWidth > 0f) drawerFullWidth else vw
                val fitS = min(fitVw / logicW, vh / logicH)
                val fillS = max(vw / logicW, vh / logicH)
                fitScale = fitS + (fillS - fitS) * drawerFillProgress
                clampTranslateToBounds()
                applyMatrix()
            } else {
                resetToCenter()
            }
        }
    }

    companion object {
        private const val MAX_SCALE = 8f
    }
}
