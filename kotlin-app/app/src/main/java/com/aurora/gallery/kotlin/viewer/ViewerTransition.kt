package com.aurora.gallery.kotlin.viewer

import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.drawable.BitmapDrawable
import android.graphics.drawable.Drawable
import android.os.SystemClock
import android.provider.Settings
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.view.animation.Interpolator
import android.view.animation.PathInterpolator
import android.widget.FrameLayout
import android.widget.ImageView
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * 查看器进出过渡（2026-10-08）。
 *
 * 解决的问题：点网格图片 → 全屏查看器是**硬切**（一帧之内网格没了、查看器有了），退出同理。
 * 系统相册那类应用的做法是共享元素式放大：卡片里那张图原地放大铺满屏幕，退出时缩回卡片。
 *
 * 为什么不用 `makeSceneTransitionAnimation`：查看器不是 Activity 也不是 Fragment，它是
 * Compose 条件层里的一个 `AndroidView`（D7 定案，见 [NativeViewerLayer]），系统过渡动画的
 * activity 生命周期根本不会为它触发。所以自己画：
 *
 *  1. 往 `android.R.id.content` 末尾挂一个全屏覆盖层（在 ComposeView 之上，同时盖住网格与
 *     查看器两层），它自己画「逐渐变暗的底色」+「从卡片矩形插值到整屏的那张图」；
 *  2. 进入期间查看器整层 **INVISIBLE**（见 [NativeGalleryView.holdHiddenForTransition]）——
 *     不是 GONE：照常测量/布局/取图，揭幕那一帧就已经是最终几何，不会再动一下；
 *  3. 到位后揭幕 + 覆盖层那张图淡出（底色与真图逐位对齐，交接看不出来）；
 *  4. 退出反着来：覆盖层接管（查看器先藏），图缩回卡片、底色退亮，动画结束才真的
 *     [NativeGalleryView.close] + 关组合层——期间网格一直活着，不存在「先黑一下再回网格」。
 *
 * 落点精度：进入动画的**终点矩形逐帧重读**真图的实际显示矩形（[Spec.liveEnd]），高清图
 * 上屏那一刻落点自动换成实测值——库里记的宽高可能被 EXIF 旋转反过来，只靠预测会落歪。
 *
 * 节奏 = 三次贝塞尔（[PathInterpolator] 就是 cubic-bezier 的实现）：
 *  - 进入 `cubic-bezier(0.05, 0.7, 0.1, 1)`（emphasized decelerate：起步快、尾部长）320ms
 *  - 退出 `cubic-bezier(0.3, 0, 0.8, 0.15)`（emphasized accelerate：起步慢、收尾快）260ms
 * 与捏合换档 FLIP 的 `cubic-bezier(0.22, 1, 0.36, 1)` 同族，是本应用既有的动效语言。
 */

/** 网格卡片封面的圆角（dp），与 [com.aurora.gallery.kotlin.ui.components.buildPhotoView] 同一个值。 */
const val PHOTO_COVER_RADIUS_DP = 12f

private const val ENTER_DURATION_MS = 320L
private const val EXIT_DURATION_MS = 260L

/**
 * 展开到位后最多再等多久让高清图上屏（超时照样揭幕，等于今天的行为）。
 *
 * 为什么给到 900ms 而不是贴着动画时长：到位之后覆盖层上停的是**放大版的卡片缩略图**，
 * 系统相册本来就是这个样子（糊一下再变清晰）；反过来，提前揭幕看到的是查看器的空占位底，
 * 图再凭空跳出来。模拟器实测 1080×1920 截图的解码要 300~800ms，400ms 会经常踩空。
 */
private const val ENTER_HOLD_MS = 900L

/** 揭幕时覆盖层那张图的淡出时长。 */
private const val ENTER_FADE_MS = 110L

private val ENTER_EASING = PathInterpolator(0.05f, 0.7f, 0.1f, 1f)
private val EXIT_EASING = PathInterpolator(0.3f, 0f, 0.8f, 0.15f)

/**
 * 「网格卡片可见矩形」的查询通道（退出动画的落点）。
 *
 * 网格是 Compose 里的 `AndroidView`，查看器的关闭却由 Activity 侧的监听器发起，中间隔着一层
 * 组合——所以由 [com.aurora.gallery.kotlin.ui.components.FileGrid] 在 factory 里把查询函数
 * 注册进来、dispose 时摘掉，宿主只在关闭那一刻调一次。返回**窗口坐标**。
 */
class PhotoRectQuery {
    var query: ((String, RectF) -> Boolean)? = null

    /**
     * 当前这份查询的主人（网格实例的私有令牌）。
     *
     * 宿主把同一个 holder 传给多个 FileGrid 调用点（文件夹页 / 专题详情页），切换时后挂的会
     * 覆盖前一个的注册；前一个 dispose 时若无条件擦除就会把**新格子的查询**一起擦掉，表现为
     * 切完页面再关查看器时退出动画静默失效。比对过主人再摘。
     */
    var owner: Any? = null
}

/** 一次过渡的输入。两个矩形都是**窗口坐标**，本类换算到覆盖层坐标系。 */
internal class Spec(
    val startRect: RectF,
    val endRect: RectF,
    val drawable: Drawable,
    val scrimColor: Int,
    /** 底色 alpha 起止（0..255）：进入 0→255，退出 255→0。 */
    val scrimFrom: Int,
    val scrimTo: Int,
    /** 图本身 alpha 的终点：255 = 不淡出；0 = 查不到落点时的收尾淡出。 */
    val imageTo: Int,
    val cornerFrom: Float,
    val cornerTo: Float,
    val durationMs: Long,
    val easing: Interpolator,
    /** 逐帧重读终点矩形（进入动画用；高清图上屏后把落点换成实测值）。 */
    val liveEnd: ((RectF) -> Boolean)? = null,
    /** 到位后最多再等这么久让 [liveEnd] 出真值。 */
    val holdMs: Long = 0L,
    /** 收尾动作之后，覆盖层的图再淡出多久（进入动画揭幕时给真图让位）。 */
    val fadeOutMs: Long = 0L,
    val onEnd: () -> Unit,
)

/**
 * 覆盖层的挂载与调度。宿主（MainActivity）持有一份，挂在 `android.R.id.content` 上。
 *
 * 同一时刻只有一段过渡：新的一段开始时先 [finishNow] 掉旧的，并且**必定执行旧那段的收尾
 * 动作**——进入中途被抢时查看器还 INVISIBLE，退出中途被抢时组合层还挂着，跳过收尾就是
 * 黑屏卡住或把脏状态带进下一次 open。
 */
class ViewerTransition(private val contentRoot: ViewGroup) {

    private val density = contentRoot.context.resources.displayMetrics.density
    private var overlay: Overlay? = null

    /** 是否有一段过渡正在跑。 */
    val isRunning: Boolean get() = overlay != null

    /**
     * 进入：卡片封面放大成全屏查看器里的那张图。
     *
     * 返回 false = 条件不满足（系统关了动画 / 卡片上还没有位图 / 落点算不出来），调用方按
     * 老样子硬切。返回 true 时覆盖层**已经挂上**，调用方必须紧接着置位
     * [NativeGalleryView.holdHiddenForTransition] 再打开查看器——否则真图会在底色还透明的
     * 那几帧里直接顶掉网格，动画等于白做。
     */
    fun startEnter(
        cover: ImageView,
        scrimColor: Int,
        predictedEnd: RectF,
        liveEnd: (RectF) -> Boolean,
        onReveal: () -> Unit,
    ): Boolean {
        val drawable = cover.drawable ?: return false
        val start = windowRectOf(cover) ?: return false
        if (predictedEnd.width() <= 0f || predictedEnd.height() <= 0f) return false
        return run(
            Spec(
                startRect = start,
                endRect = predictedEnd,
                drawable = drawable,
                scrimColor = scrimColor,
                scrimFrom = 0,
                scrimTo = 255,
                imageTo = 255,
                cornerFrom = PHOTO_COVER_RADIUS_DP * density,
                cornerTo = 0f,
                durationMs = ENTER_DURATION_MS,
                easing = ENTER_EASING,
                liveEnd = liveEnd,
                holdMs = ENTER_HOLD_MS,
                fadeOutMs = ENTER_FADE_MS,
                onEnd = onReveal,
            ),
        )
    }

    /**
     * 退出：查看器里那张图缩回网格卡片。
     *
     * 查不到卡片落点时由调用方给一个「屏幕中央的缩小版」矩形并把 [fadeImage] 置 true
     * （图边缩边淡，底色同步退掉，收尾同样看不出来）——比直接硬切有交代。
     */
    fun startExit(
        startRect: RectF,
        drawable: Drawable,
        endRect: RectF,
        scrimColor: Int,
        fadeImage: Boolean,
        onFinish: () -> Unit,
    ): Boolean = run(
        Spec(
            startRect = startRect,
            endRect = endRect,
            drawable = drawable,
            scrimColor = scrimColor,
            scrimFrom = 255,
            scrimTo = 0,
            imageTo = if (fadeImage) 0 else 255,
            cornerFrom = 0f,
            cornerTo = PHOTO_COVER_RADIUS_DP * density,
            durationMs = EXIT_DURATION_MS,
            easing = EXIT_EASING,
            onEnd = onFinish,
        ),
    )

    /** 立刻跑完当前这段（含它的收尾动作）。没有过渡在跑时是空操作。 */
    fun finishNow() {
        overlay?.forceFinish()
    }

    private fun run(spec: Spec): Boolean {
        if (!animationsEnabled()) return false
        if (!spec.drawable.showsContent()) return false
        if (spec.endRect.width() <= 0f || spec.endRect.height() <= 0f) return false
        finishNow()
        val o = Overlay(spec) { removeOverlay() }
        overlay = o
        Log.i(
            "AuroraViewer",
            "[Tx] ${if (spec.liveEnd != null) "enter" else "exit"} dur=${spec.durationMs} " +
                "from=${spec.startRect.toShortString()} to=${spec.endRect.toShortString()} " +
                "scrim=${Integer.toHexString(spec.scrimColor)} hold=${spec.holdMs} fade=${spec.fadeOutMs}",
        )
        contentRoot.addView(
            o,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            ),
        )
        o.start()
        return true
    }

    private fun removeOverlay() {
        val o = overlay ?: return
        overlay = null
        if (o.parent === contentRoot) contentRoot.removeView(o)
    }

    /** 系统「动画时长比例」=0（无障碍里的「移除动画」）时不自己加动画，尊重系统设置。 */
    private fun animationsEnabled(): Boolean = runCatching {
        Settings.Global.getFloat(
            contentRoot.context.contentResolver,
            Settings.Global.ANIMATOR_DURATION_SCALE,
            1f,
        )
    }.getOrDefault(1f) != 0f

    /** 视图在**窗口坐标系**里的矩形；还没布局时返回 null（不该为它编一个落点）。 */
    internal fun windowRectOf(view: View): RectF? {
        if (view.width <= 0 || view.height <= 0) return null
        val loc = IntArray(2)
        view.getLocationInWindow(loc)
        return RectF(
            loc[0].toFloat(), loc[1].toFloat(),
            (loc[0] + view.width).toFloat(), (loc[1] + view.height).toFloat(),
        )
    }

    /**
     * 覆盖层：帧驱动的画布，画「变暗的底色」+「插值矩形里 center-crop 的那张图」。
     *
     * 用 `postOnAnimation` 自跑循环而不是 [android.animation.ValueAnimator]，是因为进入动画
     * 要在到位之后继续逐帧追 [Spec.liveEnd]（高清图上屏才肯定落点），到位→等待→淡出三段
     * 共用一个循环，不必让三个动画器互相踩。
     */
    private inner class Overlay(
        private val spec: Spec,
        private val onGone: () -> Unit,
    ) : View(contentRoot.context) {

        private val paint = Paint(Paint.FILTER_BITMAP_FLAG)
        private val clipPath = Path()
        private val rect = RectF()
        private val live = RectF()

        /** 起止矩形已换算到覆盖层自己的坐标系（= contentRoot 坐标系）。 */
        private val from = RectF()
        private val to = RectF()
        private val rootLoc = IntArray(2)

        private var running = false
        private var handedOff = false
        private var startedAt = 0L
        private var phaseAt = 0L
        private var eased = 0f
        private var endResolved = spec.liveEnd == null
        private var scrimAlpha = spec.scrimFrom
        private var imageAlpha = 255
        private var radius = spec.cornerFrom
        private var phase = PHASE_RUN

        init {
            // 覆盖层只画不吃事件：触摸穿透到下面的层（进入期查看器 INVISIBLE 不接触摸，
            // 退出期网格照常可点——中途点另一张就是打断这段、起下一段）。
            isClickable = false
            isFocusable = false
            isFocusableInTouchMode = false
            // 放大的是卡片那张小位图，缩放比远超 1，不做双线性过滤就是一坨锯齿块
            (spec.drawable as? BitmapDrawable)?.isFilterBitmap = true
            // 换算基准取**父容器**（contentRoot，已在窗口里）的窗口位置：本视图此刻还没
            // attach，对自己 getLocationInWindow 只会拿到 (0,0)，等于没换算。
            contentRoot.getLocationInWindow(rootLoc)
            from.set(spec.startRect)
            from.offset(-rootLoc[0].toFloat(), -rootLoc[1].toFloat())
            to.set(spec.endRect)
            to.offset(-rootLoc[0].toFloat(), -rootLoc[1].toFloat())
            rect.set(from)
        }

        fun start() {
            running = true
            startedAt = SystemClock.uptimeMillis()
            phaseAt = startedAt
            postOnAnimation(frame)
        }

        /** 外部打断：跳到收尾状态、交付收尾动作、摘掉自己。收尾动作只可能交付一次。 */
        fun forceFinish() {
            handOff()
            stopDrawing()
        }

        /**
         * 停画并摘掉自己。
         *
         * 必须把 drawable 的 alpha 还原成 255 再走：绘制源是**网格那张卡片的 drawable 本体**
         * （不是副本），淡出阶段把它留在了半透明或全透明上，不还原的话那张卡片之后就一直
         * 透明地挂在网格里。
         */
        private fun stopDrawing() {
            running = false
            phase = PHASE_IDLE
            spec.drawable.alpha = 255
            onGone()
        }

        // 显式标类型：这个 Runnable 在自己的初始化表达式里被引用（repost 下一帧），
        // 不写类型时编译器会掉进循环推断（Type checking has run into a recursive problem）。
        private val frame: Runnable = object : Runnable {
            override fun run() {
                if (!running) return
                val now = SystemClock.uptimeMillis()
                when (phase) {
                    PHASE_RUN -> {
                        val t = ((now - startedAt).toFloat() / spec.durationMs).coerceIn(0f, 1f)
                        eased = spec.easing.getInterpolation(t)
                        refreshEnd()
                        if (t >= 1f) {
                            // 到位：落点已实测到（或压根不需要实测）就立刻交接，否则 HOLD 等图
                            if (endResolved) arrive() else { phase = PHASE_HOLD; phaseAt = now }
                        }
                    }

                    PHASE_HOLD -> {
                        refreshEnd()
                        if (endResolved || now - phaseAt >= spec.holdMs) {
                            eased = 1f
                            arrive()
                        }
                    }

                    PHASE_FADE -> {
                        val ft = ((now - phaseAt).toFloat() / spec.fadeOutMs).coerceIn(0f, 1f)
                        applyFrame(fadeMul = 1f - ft)
                        invalidate()
                        if (ft >= 1f) {
                            stopDrawing()
                        } else {
                            postOnAnimation(this)
                        }
                        return
                    }
                }
                applyFrame()
                invalidate()
                // `this` 就是这个 Runnable：自指必须用 this，写属性名会撞上「自己的初始化器里
                // 还没初始化完」
                if (running && phase != PHASE_IDLE) postOnAnimation(this)
            }
        }

        /**
         * 逐帧问一次「真图上屏了吗」。图一上屏就认定到位（可以交接），但**落点只在差得远时
         * 才改用实测值**。
         *
         * 为什么不能无条件采信实测：查看器刚打开那几百毫秒里自己的布局还在落定（首帧图片区
         * 比稳态矮一截，模拟器实测到 top=0 而稳态是 top=95），拿这个过渡值去改写预测矩形，
         * 反而会把本来算准的落点拽歪、揭幕那一帧看到图跳一下。差得远（>8%，典型是元数据宽高
         * 被 EXIF 旋转反了过来，或宽高压根没记）才值得改。
         */
        private fun refreshEnd() {
            val provider = spec.liveEnd ?: run { endResolved = true; return }
            if (endResolved) return
            if (!provider(live) || live.width() <= 0f || live.height() <= 0f) return
            endResolved = true
            if (materiallyDifferent(to, live)) {
                to.set(live)
                to.offset(-rootLoc[0].toFloat(), -rootLoc[1].toFloat())
            }
        }

        /** 尺寸或长宽比差一成以上 = 预测真的错了（不是布局在抖）。 */
        private fun materiallyDifferent(a: RectF, b: RectF): Boolean {
            val ra = a.width() / a.height()
            val rb = b.width() / b.height()
            if (ra <= 0f || rb <= 0f) return true
            val aspectGap = abs(ra - rb) / max(ra, rb)
            val sizeGap = max(
                abs(a.width() - b.width()) / max(a.width(), b.width()),
                abs(a.height() - b.height()) / max(a.height(), b.height()),
            )
            return aspectGap > 0.08f || sizeGap > 0.08f
        }

        /** 到位交接：跑收尾动作（揭幕 / 真关闭），进入动画再让自己的图淡出给真图让位。 */
        private fun arrive() {
            // resolved=false = 到时间也没等到真图（首帧用的还是预测落点），排查落点歪时看这条
            Log.i(
                "AuroraViewer",
                "[Tx] arrive liveResolved=$endResolved rect=${rect.toShortString()} " +
                    "elapsed=${SystemClock.uptimeMillis() - startedAt}ms",
            )
            applyFrame()
            handOff()
            if (spec.fadeOutMs > 0L) {
                phase = PHASE_FADE
                phaseAt = SystemClock.uptimeMillis()
            } else {
                stopDrawing()
            }
        }

        private fun handOff() {
            if (handedOff) return
            handedOff = true
            spec.onEnd()
        }

        /**
         * [fadeMul] = 揭幕淡出系数（1 = 不淡），**只作用于图**。
         *
         * 底色在交接那一刻直接归零，不参与淡出：它的活是把网格压暗到和查看器底色同一个颜色，
         * 而揭幕后的查看器本身就带着这个底色。淡出期间再留着一层半透明底色，等于给刚露出来的
         * 真图蒙纱——两层同时淡会在淡出中段把整体提亮一档（模拟器实测：交叉溶解中途暗部像素
         * 从 110 万掉到 1 万，肉眼就是「闪一下白」）。底色先掉、图后淡，中间每一帧底下都是真图，
         * 溶解才是干净的。
         */
        private fun applyFrame(fadeMul: Float = 1f) {
            scrimAlpha =
                if (fadeMul >= 1f) lerpInt(spec.scrimFrom, spec.scrimTo, eased) else 0
            imageAlpha = (lerpInt(255, spec.imageTo, eased) * fadeMul).roundToInt().coerceIn(0, 255)
            radius = spec.cornerFrom + (spec.cornerTo - spec.cornerFrom) * eased
            rect.set(
                from.left + (to.left - from.left) * eased,
                from.top + (to.top - from.top) * eased,
                from.right + (to.right - from.right) * eased,
                from.bottom + (to.bottom - from.bottom) * eased,
            )
        }

        override fun onDraw(canvas: Canvas) {
            if (scrimAlpha > 0) {
                paint.color = Color.argb(
                    scrimAlpha,
                    Color.red(spec.scrimColor),
                    Color.green(spec.scrimColor),
                    Color.blue(spec.scrimColor),
                )
                canvas.drawRect(0f, 0f, width.toFloat(), height.toFloat(), paint)
            }
            if (imageAlpha <= 0 || rect.width() <= 0f || rect.height() <= 0f) return
            val d = spec.drawable
            val saved = canvas.save()
            if (radius > 0.5f) {
                clipPath.reset()
                clipPath.addRoundRect(rect, radius, radius, Path.Direction.CW)
                canvas.clipPath(clipPath)
            } else {
                canvas.clipRect(rect)
            }
            // center-crop：卡片本来就是 CENTER_CROP，起点那帧与网格逐位重合；
            // 放大过程中裁剪量逐渐松开，落到终点就是整图可见。
            val sw = d.intrinsicWidth.toFloat()
            val sh = d.intrinsicHeight.toFloat()
            if (sw > 0f && sh > 0f) {
                val s = max(rect.width() / sw, rect.height() / sh)
                val dw = sw * s
                val dh = sh * s
                d.setBounds(
                    (rect.centerX() - dw / 2f).roundToInt(),
                    (rect.centerY() - dh / 2f).roundToInt(),
                    (rect.centerX() + dw / 2f).roundToInt(),
                    (rect.centerY() + dh / 2f).roundToInt(),
                )
            } else {
                d.setBounds(
                    rect.left.roundToInt(), rect.top.roundToInt(),
                    rect.right.roundToInt(), rect.bottom.roundToInt(),
                )
            }
            d.alpha = imageAlpha
            d.draw(canvas)
            canvas.restoreToCount(saved)
        }
    }

    private fun lerpInt(a: Int, b: Int, t: Float): Int = (a + (b - a) * t).roundToInt()

    private companion object {
        const val PHASE_RUN = 0
        const val PHASE_HOLD = 1
        const val PHASE_FADE = 2
        const val PHASE_IDLE = 3
    }
}

/**
 * drawable 上真的有位图——不能拿 `!= null` 判：Coil 清屏后的 `setImageBitmap(null)` 留下的是
 * 包着 null bitmap 的 BitmapDrawable（FileGrid.showsBitmap 同款实锤），拿它当源就是画一帧空气。
 */
internal fun Drawable.showsContent(): Boolean = if (this is BitmapDrawable) bitmap != null else true
