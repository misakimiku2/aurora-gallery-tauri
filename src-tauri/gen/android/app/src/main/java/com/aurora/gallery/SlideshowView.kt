package com.aurora.gallery

import android.content.Context
import android.graphics.Color
import android.graphics.drawable.Animatable
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.KeyEvent
import android.view.View
import android.view.ViewPropertyAnimator
import android.view.animation.AccelerateDecelerateInterpolator
import android.widget.FrameLayout
import android.widget.ImageView
import coil.ImageLoader
import coil.request.ImageRequest
import coil.size.Precision
import android.net.Uri
import java.io.File

/**
 * 独立全屏幻灯片播放覆盖层。
 *
 * 作为 [NativeGalleryView] 的子视图在播放时叠加到顶层，覆盖查看器的所有 chrome
 * （顶栏/缩略图/抽屉），提供纯净的全屏播放体验。
 *
 * 交互：
 * - 单击 → 切换播放/暂停
 * - 返回键 → 退出（通过 [Listener.onSlideshowExit] 把当前索引同步回查看器）
 *
 * 图片加载复用外部传入的 [ImageLoader] 实例，从而共享查看器的内存缓存。
 *
 * 循环鲁棒性：[slideshowRunnable] 把推进逻辑包进 try/catch，无论是否异常都重新调度，
 * 避免因单次异常导致循环"静默死亡"（按钮仍显示暂停但不再推进的历史 bug）。
 */
class SlideshowView(
    context: Context,
    private val imageLoader: ImageLoader,
    private val images: List<NativeGalleryView.ImageItem>,
    startIndex: Int,
    private var config: SlideshowConfig,
    private val listener: Listener
) : FrameLayout(context) {

    interface Listener {
        /** 幻灯片退出，把幻灯片停止时的当前索引同步给查看器。 */
        fun onSlideshowExit(currentIndex: Int)
    }

    /** 幻灯片配置。 */
    data class SlideshowConfig(
        val intervalMs: Long,
        val transition: String, // "none" | "fade" | "slide"
        val isRandom: Boolean,
        val enableZoom: Boolean
    )

    private val mainHandler = Handler(Looper.getMainLooper())
    private var currentIndex = if (images.isEmpty()) 0 else startIndex.coerceIn(0, images.size - 1)
    private var isPlaying = false
    private var isExiting = false
    /** 过渡代际：每次开始新过渡自增，过期的图片加载回调据此作废，避免竞态。 */
    private var transitionGen = 0
    private var kenBurnsAnimator: ViewPropertyAnimator? = null

    private val viewA: ImageView
    private val viewB: ImageView
    private var activeView: ImageView
    private val playIndicator: ImageView

    init {
        setBackgroundColor(Color.BLACK)
        isFocusable = true
        isFocusableInTouchMode = true

        viewA = createImageView()
        viewB = createImageView()
        addView(viewA)
        addView(viewB)
        activeView = viewA

        // 暂停时显示的播放指示器（提示单击恢复）
        playIndicator = ImageView(context).apply {
            setImageResource(R.drawable.ic_lucide_play)
            setColorFilter(Color.WHITE)
            alpha = 0f
            visibility = GONE
            val pad = (resources.displayMetrics.density * 20).toInt()
            setPadding(pad, pad, pad, pad)
            background = android.graphics.drawable.GradientDrawable().apply {
                shape = android.graphics.drawable.GradientDrawable.OVAL
                setColor(Color.argb(120, 0, 0, 0))
            }
            layoutParams = LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT).apply {
                gravity = android.view.Gravity.CENTER
            }
        }
        addView(playIndicator)

        // 单击切换播放/暂停（指示器不消费触摸事件，单击穿透到本容器）
        setOnClickListener { togglePlay() }
    }

    private fun createImageView(): ImageView = ImageView(context).apply {
        layoutParams = LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT)
        scaleType = ImageView.ScaleType.FIT_CENTER
        visibility = GONE
    }

    /** 启动幻灯片：加载起始图并开始定时循环。 */
    fun start() {
        if (images.isEmpty()) {
            exit()
            return
        }
        loadInitial()
        isPlaying = true
        scheduleNext()
    }

    private fun loadInitial() {
        val gen = ++transitionGen
        activeView.visibility = VISIBLE
        activeView.alpha = 1f
        activeView.scaleX = 1f
        activeView.scaleY = 1f
        activeView.translationX = 0f
        loadImage(activeView, currentIndex) {
            if (gen != transitionGen) return@loadImage
            if (config.enableZoom) startKenBurns(activeView)
        }
    }

    private fun togglePlay() {
        if (isExiting) return
        if (!isPlaying) {
            // 恢复播放
            isPlaying = true
            playIndicator.animate().alpha(0f).setDuration(150)
                .withEndAction { playIndicator.visibility = GONE }.start()
            if (config.enableZoom) startKenBurns(activeView)
            scheduleNext()
        } else {
            // 暂停
            isPlaying = false
            mainHandler.removeCallbacks(slideshowRunnable)
            cancelKenBurns()
            playIndicator.visibility = VISIBLE
            playIndicator.alpha = 0f
            playIndicator.animate().alpha(1f).setDuration(150).start()
        }
    }

    /** 退出幻灯片。 */
    fun exit() {
        if (isExiting) return
        isExiting = true
        isPlaying = false
        mainHandler.removeCallbacks(slideshowRunnable)
        cancelKenBurns()
        (activeView.drawable as? Animatable)?.stop()
        val idx = currentIndex
        listener.onSlideshowExit(idx)
    }

    /** 运行中应用新配置（设置对话框确定后调用）。 */
    fun updateConfig(newConfig: SlideshowConfig) {
        this.config = newConfig
        if (!isPlaying) return
        if (newConfig.enableZoom) {
            startKenBurns(activeView)
        } else {
            cancelKenBurns()
        }
        // 重置定时器以应用新间隔
        scheduleNext()
    }

    private fun scheduleNext() {
        mainHandler.removeCallbacks(slideshowRunnable)
        if (isPlaying) {
            mainHandler.postDelayed(slideshowRunnable, config.intervalMs)
        }
    }

    private val slideshowRunnable = object : Runnable {
        override fun run() {
            if (!isPlaying) return
            try {
                advance()
            } catch (t: Throwable) {
                Log.e(TAG, "slideshow advance failed", t)
            }
            // 始终重新调度，避免异常导致循环静默死亡
            scheduleNext()
        }
    }

    private fun advance() {
        if (images.size <= 1) return
        cancelKenBurns()
        val nextIndex = if (config.isRandom && images.size > 1) {
            var r: Int
            do { r = (0 until images.size).random() } while (r == currentIndex)
            r
        } else {
            if (currentIndex < images.size - 1) currentIndex + 1 else 0
        }
        when (config.transition) {
            "none" -> instantTransition(nextIndex)
            "slide" -> slideTransition(nextIndex)
            else -> fadeTransition(nextIndex) // "fade"
        }
    }

    private fun fadeTransition(nextIndex: Int) {
        val gen = ++transitionGen
        val outgoing = activeView
        val incoming = if (outgoing === viewA) viewB else viewA
        activeView = incoming
        currentIndex = nextIndex

        outgoing.animate().cancel()
        incoming.animate().cancel()
        incoming.alpha = 0f
        incoming.translationX = 0f
        incoming.scaleX = 1f
        incoming.scaleY = 1f
        incoming.visibility = VISIBLE
        loadImage(incoming, nextIndex) {
            if (gen != transitionGen) return@loadImage
            val duration = 400L
            incoming.animate().alpha(1f).setDuration(duration).withEndAction {
                if (gen != transitionGen) return@withEndAction
                outgoing.visibility = GONE
                (outgoing.drawable as? Animatable)?.stop()
                outgoing.setImageDrawable(null)
                outgoing.alpha = 1f
                // 回收视图：重置缩放，供下次作为 incoming 使用（淡出期间保持缩放）
                outgoing.scaleX = 1f
                outgoing.scaleY = 1f
                if (config.enableZoom) startKenBurns(incoming)
            }.start()
            outgoing.animate().alpha(0f).setDuration(duration).start()
        }
    }

    private fun slideTransition(nextIndex: Int) {
        val gen = ++transitionGen
        val outgoing = activeView
        val incoming = if (outgoing === viewA) viewB else viewA
        activeView = incoming
        currentIndex = nextIndex
        val direction = 1 // 下一张从右侧进入
        val cw = width.toFloat().coerceAtLeast(1f)

        outgoing.animate().cancel()
        incoming.animate().cancel()
        incoming.alpha = 1f
        incoming.scaleX = 1f
        incoming.scaleY = 1f
        incoming.translationX = direction * cw
        incoming.visibility = VISIBLE
        loadImage(incoming, nextIndex) {
            if (gen != transitionGen) return@loadImage
            val duration = 280L
            incoming.animate().translationX(0f).setDuration(duration).withEndAction {
                if (gen != transitionGen) return@withEndAction
                outgoing.visibility = GONE
                (outgoing.drawable as? Animatable)?.stop()
                outgoing.setImageDrawable(null)
                outgoing.translationX = 0f
                outgoing.scaleX = 1f
                outgoing.scaleY = 1f
                if (config.enableZoom) startKenBurns(incoming)
            }.start()
            outgoing.animate().translationX(-direction * cw).setDuration(duration).start()
        }
    }

    private fun instantTransition(nextIndex: Int) {
        val gen = ++transitionGen
        val outgoing = activeView
        val incoming = if (outgoing === viewA) viewB else viewA
        activeView = incoming
        currentIndex = nextIndex
        incoming.alpha = 1f
        incoming.translationX = 0f
        incoming.scaleX = 1f
        incoming.scaleY = 1f
        incoming.visibility = VISIBLE
        loadImage(incoming, nextIndex) {
            if (gen != transitionGen) return@loadImage
            outgoing.visibility = GONE
            (outgoing.drawable as? Animatable)?.stop()
            outgoing.setImageDrawable(null)
            outgoing.scaleX = 1f
            outgoing.scaleY = 1f
            if (config.enableZoom) startKenBurns(incoming)
        }
    }

    private fun loadImage(view: ImageView, index: Int, onSuccess: () -> Unit) {
        val item = images.getOrNull(index) ?: run { onSuccess(); return }
        val request = ImageRequest.Builder(context)
            .data(if (item.isLan) item.path else if (item.contentUri.isNotEmpty()) Uri.parse(item.contentUri) else File(item.path))
            .target(
                onSuccess = { drawable ->
                    view.setImageDrawable(drawable)
                    (drawable as? Animatable)?.start()
                    onSuccess()
                },
                onError = { _ ->
                    Log.e(TAG, "slideshow load failed: index=$index name=${item.name} path=${item.path}")
                    onSuccess() // 继续推进，避免卡住
                }
            )
            .precision(Precision.INEXACT)
            .build()
        imageLoader.enqueue(request)
    }

    private fun startKenBurns(view: View) {
        // 视图尚未布局（width=0）时 pivot 会落到左上角，导致首张从左上角放大。
        // 延迟到布局完成后再启动。
        if (view.width == 0 || view.height == 0) {
            view.post {
                if (isPlaying && config.enableZoom && view === activeView && !isExiting) {
                    startKenBurns(view)
                }
            }
            return
        }
        cancelKenBurns()
        // 从当前缩放值继续放大到 1.15（首张为 1f；暂停恢复时为中间值，避免回弹）
        val startScale = view.scaleX.coerceIn(1f, 1.15f)
        if (startScale >= 1.149f) return // 已接近最大，无需再放
        view.scaleX = startScale
        view.scaleY = startScale
        view.pivotX = view.width / 2f
        view.pivotY = view.height / 2f
        kenBurnsAnimator = view.animate()
            .scaleX(1.15f)
            .scaleY(1.15f)
            .setDuration(config.intervalMs)
            .setInterpolator(AccelerateDecelerateInterpolator())
        kenBurnsAnimator?.start()
    }

    private fun cancelKenBurns() {
        // 仅取消动画器，不重置 scale——切换图片时旧图应保持当前缩放步调淡出，
        // 而不是瞬间还原为 1。回收视图（隐藏）时由调用方重置 scale。
        kenBurnsAnimator?.cancel()
        kenBurnsAnimator = null
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        // 作为防御性兜底：实际 BACK 由父级 NativeGalleryView.dispatchKeyEvent 委托调用 exit()
        if (event.keyCode == KeyEvent.KEYCODE_BACK && event.action == KeyEvent.ACTION_UP) {
            exit()
            return true
        }
        return super.dispatchKeyEvent(event)
    }

    companion object {
        private const val TAG = "SlideshowView"
    }
}
