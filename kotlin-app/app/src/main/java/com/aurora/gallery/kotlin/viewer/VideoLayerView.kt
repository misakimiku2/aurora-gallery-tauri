package com.aurora.gallery.kotlin.viewer

// 视频 P3-A2：查看器的视频层本体（ExoPlayer + TextureView + 一行播控条）。
// 宿主见 NativeGalleryViewVideo.kt（同步/翻页避让的胶水）与 NativeGalleryView（装配与生命周期）。

import android.content.Context
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.Surface
import android.view.TextureView
import android.widget.FrameLayout
import android.widget.ImageButton
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.SeekBar
import android.widget.TextView
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.common.VideoSize
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.AspectRatioFrameLayout
import com.aurora.gallery.kotlin.R
import com.aurora.gallery.kotlin.ui.components.formatVideoDuration

/**
 * 视频层（P3-A2）。
 *
 * **为什么是 TextureView 而不是 SurfaceView**：SurfaceView 走独立的硬件视频平面，安卓上的
 * 表现与桌面端刚踩过三刀的「硬件视频层盖住工具条」同源（`d015f6a4d` / `37a189381`）——
 * z 序不由视图树说了算，控件压不住画面。TextureView 参与普通合成，顶栏/播控条永远画在它上面。
 *
 * **为什么不拦触摸**：本层自身不可点击，除播控条与中央播放键之外，触摸都落不下去——
 * `ViewGroup` 的 ACTION_DOWN 会沿 z 序往下找**第一个消费事件的子树**，于是横滑翻页、
 * 竖滑抽屉、双击缩放那些既有手势全部原样命中下层的 [ZoomableImageView]，本层不重写一套。
 *
 * **状态机（只有两个可见形态）**：
 *  - IDLE（绑定但未播）：只有中央播放键，背景透明 → 下层封面图照常可见，退出过渡取
 *    Drawable 的 `currentImageDrawable()` 因此一行都不用改（视频项的封面本来就上屏）。
 *  - STARTED（按过播放）：TextureView 出画 + 底部播控条；**首帧渲染后**本层才转不透明底，
 *    信箱区于是与图片同一套主题色（对齐 UI 设计 §2「渲染区底色跟随主题」），而起播前的
 *    等待期不会先闪一块纯色。
 *
 * **进度条用原生 SeekBar 而不是 media3 的 DefaultTimeBar**：1.4.1 的 TimeBar 已经没有
 * `setPlayer()`（那是 ExoPlayer 2.x 的API），自驱要每帧推 position/buffered/duration 三件事；
 * 原生 SeekBar 的 `secondaryProgress` 正好就是缓冲段，语义一一对应，少引一份 UI 依赖的不确定性。
 */
@UnstableApi
internal class VideoLayerView(context: Context) : FrameLayout(context) {

    companion object {
        private const val TAG = "AuroraVideo"
        /** 播控条自动收起的静置时长；桌面端影院态用 1.5s，触屏误触更贵，取更长。 */
        private const val CHROME_IDLE_MS = 3500L
        private const val SEEK_STEP_MS = 5_000L
        private const val TICK_MS = 250L
    }

    private val aspectBox: AspectRatioFrameLayout
    private val textureView: TextureView
    private val bufferingBar: ProgressBar
    private val playFab: ImageButton
    private val controlBar: LinearLayout
    private val rewindBtn: ImageButton
    private val playPauseBtn: ImageButton
    private val forwardBtn: ImageButton
    private val positionText: TextView
    private val durationText: TextView
    private val seekBar: SeekBar

    private val mainHandler = Handler(Looper.getMainLooper())

    private val player: ExoPlayer = ExoPlayer.Builder(context)
        .setAudioAttributes(
            AudioAttributes.Builder()
                .setUsage(C.USAGE_MEDIA)
                .setContentType(C.AUDIO_CONTENT_TYPE_MOVIE)
                .build(),
            /* handleAudioFocus = */ true,
        )
        .setHandleAudioBecomingNoisy(true)
        .build()

    private var boundFileId: String? = null
    private var mediaUrl: String = ""
    private var fallbackDurationMs: Long = 0L
    private var playbackStarted = false
    private var firstFrameRendered = false
    private var drawerOccluded = false
    private var chromeVisible = true
    private var chromeHidden = false
    private var userDragging = false
    private var surface: Surface? = null

    /** 首帧之前封面仍透在底下（本层不画底）；之后才用 [letterboxColor] 填信箱区。 */
    private var letterboxColor = Color.TRANSPARENT
    private val letterboxBg = GradientDrawable()

    var onPlayError: ((String) -> Unit)? = null

    /** 起播/复位回调（动态位 ↔ 静态位切换），宿主用它锁掉下层封面的缩放手势。 */
    var onStartedChange: ((Boolean) -> Unit)? = null

    val isBound: Boolean get() = boundFileId != null
    val isPlaying: Boolean get() = player.isPlaying
    val isStarted: Boolean get() = playbackStarted

    init {
        // 本层不吃触摸（见类注释）：只有播控条与播放键自己吃
        isClickable = false
        isFocusable = false
        background = letterboxBg

        textureView = TextureView(context).apply {
            layoutParams = LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT)
            surfaceTextureListener = object : TextureView.SurfaceTextureListener {
                override fun onSurfaceTextureAvailable(st: android.graphics.SurfaceTexture, w: Int, h: Int) {
                    val s = Surface(st)
                    surface = s
                    player.setVideoSurface(s)
                }

                override fun onSurfaceTextureSizeChanged(st: android.graphics.SurfaceTexture, w: Int, h: Int) {}

                /** 返回 true = 销毁权交还系统。本层 GONE（抽屉/翻页让位）时必走到这里。 */
                override fun onSurfaceTextureDestroyed(st: android.graphics.SurfaceTexture): Boolean {
                    player.clearVideoSurface()
                    surface?.release()
                    surface = null
                    return true
                }

                override fun onSurfaceTextureUpdated(st: android.graphics.SurfaceTexture) {}
            }
        }
        aspectBox = AspectRatioFrameLayout(context).apply {
            // FIT 模式下 AspectRatioFrameLayout 把**自己**量成视频比例（不是把子视图居中），
            // 所以居中必须由父层的 gravity 给——实测缺这一行时画面贴顶、下方空一大条
            layoutParams = LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT).apply {
                gravity = Gravity.CENTER
            }
            setResizeMode(AspectRatioFrameLayout.RESIZE_MODE_FIT)
            addView(textureView)
        }
        addView(aspectBox)

        bufferingBar = ProgressBar(context, null, android.R.attr.progressBarStyleLarge).apply {
            layoutParams = LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT).apply {
                gravity = Gravity.CENTER
            }
            indeterminateTintList = android.content.res.ColorStateList.valueOf(Color.WHITE)
            visibility = GONE
        }
        addView(bufferingBar)

        playFab = ImageButton(context).apply {
            val size = dp(72f).toInt()
            layoutParams = LayoutParams(size, size).apply { gravity = Gravity.CENTER }
            setImageResource(R.drawable.ic_lucide_play)
            scaleType = android.widget.ImageView.ScaleType.CENTER_INSIDE
            val pad = dp(20f).toInt()
            setPadding(pad + dp(2f).toInt(), pad, pad, pad)
            background = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                setColor(Color.parseColor("#99000000"))
            }
            contentDescription = "播放"
            setOnClickListener { start() }
        }
        addView(playFab)

        controlBar = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            layoutParams = LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply {
                gravity = Gravity.BOTTOM
                marginStart = dp(12f).toInt()
                marginEnd = dp(12f).toInt()
                bottomMargin = dp(12f).toInt()
            }
            val padV = dp(4f).toInt()
            val padH = dp(8f).toInt()
            setPadding(padH, padV, padH, padV)
            visibility = GONE
        }
        rewindBtn = controlButton(R.drawable.ic_lucide_rotate_ccw, "后退 5 秒") { seekBy(-SEEK_STEP_MS) }
        playPauseBtn = controlButton(R.drawable.ic_lucide_play, "播放/暂停") { togglePlay() }
        forwardBtn = controlButton(R.drawable.ic_lucide_rotate_cw, "前进 5 秒") { seekBy(SEEK_STEP_MS) }
        positionText = timeText("00:00")
        durationText = timeText("--:--")
        seekBar = SeekBar(context).apply {
            layoutParams = LinearLayout.LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f)
            setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
                override fun onProgressChanged(bar: SeekBar, value: Int, fromUser: Boolean) {
                    // 拖拽中只更新时间文字，松手才真 seek（对齐 UI 设计 §3 进度条那条：
                    // 连续 seek 请求会把 LAN 的 Range 连接打爆）
                    if (fromUser) positionText.text = formatVideoDuration(value.toLong())
                }

                override fun onStartTrackingTouch(bar: SeekBar) {
                    userDragging = true
                    showChromeTemporarily()
                }

                override fun onStopTrackingTouch(bar: SeekBar) {
                    userDragging = false
                    player.seekTo(bar.progress.toLong())
                    mainHandler.post(ticker)
                }
            })
        }
        controlBar.addView(rewindBtn)
        controlBar.addView(playPauseBtn)
        controlBar.addView(forwardBtn)
        controlBar.addView(positionText)
        controlBar.addView(seekBar)
        controlBar.addView(durationText)
        addView(controlBar)

        player.addListener(object : Player.Listener {
            override fun onPlaybackStateChanged(state: Int) {
                bufferingBar.visibility =
                    if (playbackStarted && state == Player.STATE_BUFFERING) VISIBLE else GONE
                if (state == Player.STATE_READY) syncDurationText()
            }

            override fun onIsPlayingChanged(playing: Boolean) {
                playPauseBtn.setImageResource(if (playing) R.drawable.ic_lucide_pause else R.drawable.ic_lucide_play)
                mainHandler.removeCallbacks(ticker)
                if (playing) {
                    mainHandler.post(ticker)
                    scheduleChromeHide()
                } else {
                    showChromeTemporarily()
                    mainHandler.post(ticker)
                }
            }

            override fun onVideoSizeChanged(videoSize: VideoSize) {
                if (videoSize.width <= 0 || videoSize.height <= 0) return
                val sar = if (videoSize.pixelWidthHeightRatio > 0f) videoSize.pixelWidthHeightRatio else 1f
                val wide = videoSize.width * sar
                val tall = videoSize.height.toFloat()
                // unappliedRotationDegrees = 还没作用到 width/height 上的那圈旋转（媒体文档
                // 里的 rotate 位），90/270 时显示宽高要互换
                val rotated = videoSize.unappliedRotationDegrees % 180 == 90
                val ratio = if (rotated) tall / wide else wide / tall
                if (ratio.isFinite() && ratio > 0f && ratio < 100f) aspectBox.setAspectRatio(ratio)
            }

            override fun onRenderedFirstFrame() {
                firstFrameRendered = true
                refreshLayerState()
            }

            override fun onPlayerError(error: PlaybackException) {
                Log.e(TAG, "播放失败: url=$mediaUrl code=${error.errorCodeName}", error)
                stopPlayback(resetToCover = true)
                onPlayError?.invoke(error.errorCodeName)
            }
        })

        refreshLayerState()
    }

    /**
     * 位置/缓冲/时长三件事一起推——media3 1.4 的 TimeBar 已无 `setPlayer()`，
     * PlayerView 那套自驱在这里落地成一个 250ms 的 tick。声明排在 init 之后是必须的：
     * 属性按书写顺序初始化，早于各视图赋值会在 definite assignment 上直接编译不过。
     */
    private val ticker = object : Runnable {
        override fun run() {
            if (!playbackStarted) return
            val position = player.currentPosition.coerceAtLeast(0L)
            val duration = contentDurationMs
            if (!userDragging) {
                seekBar.max = duration.toInt().coerceAtLeast(1)
                seekBar.progress = position.coerceAtMost(duration).toInt()
                seekBar.secondaryProgress = player.bufferedPosition.coerceIn(position, duration).toInt()
                positionText.text = formatVideoDuration(position)
            }
            if (player.isPlaying) mainHandler.postDelayed(this, TICK_MS)
        }
    }

    // —— 宿主 API ——

    /**
     * 绑定当前项。**不预加载**：只记 URL，数据要等 [start] 才拉——LAN 的录屏动辄上百 MB，
     * 翻页路过就开下整片的代价不可接受（Coil 那条大图请求就是前车之鉴）。
     *
     * [width]/[height] 是服务端 browse 已经给过的容器宽高（A3 那轮补的）：先用它把适配框
     * 摆正，等 `onVideoSizeChanged` 再按解码器口径精修。不预置的话，首帧之前
     * AspectRatioFrameLayout 比例未知 = 满幅拉伸（实测起播那一瞬画面被纵向拉长）。
     */
    fun bind(fileId: String, url: String, durationMs: Long, width: Int, height: Int) {
        if (boundFileId == fileId) {
            refreshLayerState()
            return
        }
        detach()
        if (url.isEmpty()) return
        boundFileId = fileId
        mediaUrl = url
        fallbackDurationMs = durationMs
        if (width > 0 && height > 0) aspectBox.setAspectRatio(width.toFloat() / height)
        refreshLayerState()
    }

    /** 换页/关闭/进幻灯片/退出过渡：彻底停掉这一路视频（不后台出声，见 UI 设计 §3）。 */
    fun detach() {
        stopPlayback(resetToCover = true)
        boundFileId = null
        mediaUrl = ""
        fallbackDurationMs = 0L
    }

    /** Activity 销毁路径。 */
    fun release() {
        detach()
        runCatching { player.release() }
    }

    /** Activity 退到后台：出声的东西不能留到后台。回前台不自动续播，停在暂停帧上。 */
    fun pauseForBackground() {
        if (player.isPlaying) player.pause()
    }

    /**
     * 抽屉拖拽期间让位：横屏抽屉把图片区压窄并让封面切填充裁切，竖屏底部面板直接压在
     * 播控条那一条上——两种形制都与本层的信箱几何对不上。抽屉只要离开全关位就藏本层并
     * 暂停，回到 0 再由同一入口交还。
     */
    fun setDrawerOccluded(occluded: Boolean) {
        if (drawerOccluded == occluded) return
        drawerOccluded = occluded
        if (occluded && player.isPlaying) player.pause()
        refreshLayerState()
    }

    /**
     * 画面本身的一次单击。返回 true = 本次单击已被视频语义消化（宿主就不再走图片那条
     * 「单击=沉浸切换」）。IDLE 时起播，播放中则播/停——对齐 UI 设计 §3「点画面本身也切换，
     * 与图片查看器的点击语义要区分开」。
     */
    fun handleTap(): Boolean {
        if (boundFileId == null) return false
        if (!playbackStarted) start() else togglePlay()
        return true
    }

    /** 起播（中央播放键与单击画面都走这里）。 */
    fun start() {
        val url = mediaUrl
        if (boundFileId == null || url.isEmpty()) return
        if (!playbackStarted) {
            player.setMediaItem(MediaItem.fromUri(Uri.parse(url)))
            player.prepare()
            playbackStarted = true
            chromeVisible = true
            seekBar.max = contentDurationMs.toInt().coerceAtLeast(1)
            syncDurationText()
            onStartedChange?.invoke(true)
        }
        if (player.playbackState == Player.STATE_ENDED) player.seekTo(0L)
        player.playWhenReady = true
        refreshLayerState()
    }

    fun togglePlay() {
        if (!playbackStarted) {
            start()
            return
        }
        if (player.playbackState == Player.STATE_ENDED) {
            player.seekTo(0L)
            player.playWhenReady = true
            return
        }
        if (player.isPlaying) player.pause() else player.play()
        refreshLayerState()
    }

    // —— 内部 ——

    private fun seekBy(deltaMs: Long) {
        if (!playbackStarted) return
        val target = (player.currentPosition + deltaMs).coerceIn(0L, contentDurationMs)
        player.seekTo(target)
        mainHandler.post(ticker)
        showChromeTemporarily()
    }

    /** 播放器给的时长优先，未 READY 时退回服务端 browse 已经告诉我们的 duration_ms。 */
    private val contentDurationMs: Long
        get() {
            val d = player.duration
            return if (d > 0L) d else fallbackDurationMs
        }

    private fun stopPlayback(resetToCover: Boolean) {
        val wasStarted = playbackStarted
        mainHandler.removeCallbacks(ticker)
        if (playbackStarted) {
            player.playWhenReady = false
            player.stop()
            player.clearMediaItems()
        }
        playbackStarted = false
        firstFrameRendered = false
        chromeHidden = false
        chromeVisible = true
        userDragging = false
        bufferingBar.visibility = GONE
        seekBar.progress = 0
        seekBar.secondaryProgress = 0
        // 时间文字必须一起归零：tick 只在 playing 期间跑，换到下一条后若停在缓冲态，
        // 不归零就会把上一条的 00:34 顶在一条 10 秒的片子上（实测踩过）
        positionText.text = "00:00"
        if (wasStarted) onStartedChange?.invoke(false)
        if (resetToCover) refreshLayerState()
    }

    private fun controlButton(iconRes: Int, description: String, onClick: () -> Unit): ImageButton =
        ImageButton(context).apply {
            val size = dp(44f).toInt()
            layoutParams = LinearLayout.LayoutParams(size, size)
            setImageResource(iconRes)
            scaleType = android.widget.ImageView.ScaleType.CENTER_INSIDE
            val pad = dp(10f).toInt()
            setPadding(pad, pad, pad, pad)
            background = null
            contentDescription = description
            setOnClickListener {
                onClick()
                showChromeTemporarily()
            }
        }

    private fun timeText(initial: String): TextView = TextView(context).apply {
        text = initial
        setTextColor(Color.WHITE)
        textSize = 12f
        val pad = dp(6f).toInt()
        setPadding(pad, 0, pad, 0)
        includeFontPadding = false
        // 定宽居中：秒位在 00→10 之间跳动时不要把进度条挤得来回晃
        minWidth = dp(52f).toInt()
        gravity = Gravity.CENTER
    }

    private fun dp(v: Float): Float =
        TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, resources.displayMetrics)

    private fun syncDurationText() {
        durationText.text = formatVideoDuration(contentDurationMs).ifEmpty { "--:--" }
    }

    private fun scheduleChromeHide() {
        mainHandler.removeCallbacks(hideChrome)
        if (!chromeHidden && player.isPlaying) mainHandler.postDelayed(hideChrome, CHROME_IDLE_MS)
    }

    private val hideChrome = Runnable {
        if (!player.isPlaying) return@Runnable
        chromeHidden = true
        applyChromeVisibility()
    }

    private fun showChromeTemporarily() {
        chromeHidden = false
        applyChromeVisibility()
        scheduleChromeHide()
    }

    private fun applyChromeVisibility() {
        val show = chromeVisible && !chromeHidden
        controlBar.animate().cancel()
        controlBar.alpha = if (show) 1f else 0f
        controlBar.visibility = if (!playbackStarted) GONE else if (show) VISIBLE else INVISIBLE
    }

    /** 单一出口：所有状态变化之后都走这里把显隐与底色落定。 */
    private fun refreshLayerState() {
        val bound = boundFileId != null
        visibility = if (bound && !drawerOccluded) VISIBLE else GONE
        playFab.visibility = if (bound && !playbackStarted) VISIBLE else GONE
        aspectBox.visibility = if (playbackStarted) VISIBLE else GONE
        letterboxBg.setColor(if (firstFrameRendered) letterboxColor else Color.TRANSPARENT)
        applyChromeVisibility()
        if (bound) syncDurationText()
    }

    /**
     * 主题/沉浸态重涂：信箱底取查看器当前背景色值（沉浸态那个是纯黑，与
     * [NativeGalleryView.applyTheme] 的分支同源），文字图标走主文字色，播控条底走背景加透明度。
     */
    fun applyPalette(bgColor: Int, textColor: Int, panelColor: Int, accentColor: Int) {
        letterboxColor = bgColor
        for (v in listOf(rewindBtn, playPauseBtn, forwardBtn, playFab)) v.setColorFilter(textColor)
        positionText.setTextColor(textColor)
        durationText.setTextColor(textColor)
        controlBar.background = GradientDrawable().apply {
            cornerRadius = dp(12f)
            setColor(panelColor)
        }
        seekBar.progressTintList = android.content.res.ColorStateList.valueOf(accentColor)
        seekBar.secondaryProgressTintList = android.content.res.ColorStateList.valueOf(withAlpha(textColor, 0x55))
        seekBar.progressBackgroundTintList = android.content.res.ColorStateList.valueOf(withAlpha(textColor, 0x33))
        seekBar.thumbTintList = android.content.res.ColorStateList.valueOf(textColor)
        refreshLayerState()
    }

    private fun withAlpha(color: Int, alpha: Int): Int =
        (color and 0x00FFFFFF) or ((alpha and 0xFF) shl 24)
}
