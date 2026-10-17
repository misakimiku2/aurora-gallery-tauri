package com.aurora.gallery.kotlin.viewer

// 视频 P3-A2.5：查看器的视频层本体（ExoPlayer + TextureView + 双行播控 + 全套手势）。
// 宿主见 NativeGalleryViewVideo.kt（同步/翻页避让的胶水）与 NativeGalleryView（装配与生命周期）。

import android.app.Activity
import android.content.Context
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.util.TypedValue
import android.view.GestureDetector
import android.view.Gravity
import android.view.MotionEvent
import android.view.ScaleGestureDetector
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
import androidx.media3.common.VideoSize
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import com.aurora.gallery.kotlin.R
import com.aurora.gallery.kotlin.ui.components.formatVideoDuration
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

/**
 * 视频层（P3-A2 起播 + A2.5 播控重做）。
 *
 * **为什么是 TextureView 而不是 SurfaceView**：SurfaceView 走独立的硬件视频平面，安卓上的
 * 表现与桌面端刚踩过三刀的「硬件视频层盖住工具条」同源（`d015f6a4d` / `37a189381`）——
 * z 序不由视图树说了算，控件压不住画面。TextureView 参与普通合成，顶栏/播控条永远画在它上面。
 *
 * **本层在绑定期间吃掉画面区的触摸**（A2.5 拍板的手势表）：横滑=进度、左半竖滑=亮度、
 * 右半竖滑=音量、双指捏合=居中缩放、单击=显隐工具栏。因此图片那套「横滑翻页 / 竖滑抽屉」
 * 在视频上不再可用，翻页改走播控条的上一条/下一条键、抽屉改走顶栏信息钮。
 * 代价如实登记在 P3 清单 §6。
 *
 * **画面几何自己算**（`applySurfaceGeometry`）：四档比例 + 捏合倍率全部折算成 TextureView
 * 的布局尺寸，居中摆放。TextureView 把解码缓冲**拉伸填满自身边界**，所以「拉伸」档就是
 * 让边界=媒体区、而「适应/裁切/1:1」三档把边界摆成视频宽高比——正因为几何已经自己算，
 * media3-ui 的 `AspectRatioFrameLayout` 不再需要（少一份依赖与资源）。
 */
@UnstableApi
internal class VideoLayerView(context: Context) : FrameLayout(context) {

    /**
     * 画面大小四档，循环顺序按验收人给的清单：1:1 → 适应屏幕 → 拉伸 → 裁切 →（回到 1:1）。
     * 钮面用图形图标（验收人：不要文字档名），[label] 只在切换瞬间的浮层里出现一次。
     */
    enum class SurfaceMode(val label: String, val iconRes: Int) {
        ONE_TO_ONE("1:1（原始像素）", R.drawable.ic_video_actual_size),
        FIT("适应屏幕", R.drawable.ic_video_fit),
        FILL("拉伸铺满", R.drawable.ic_video_stretch),
        ZOOM("裁切填满", R.drawable.ic_video_crop),
    }

    companion object {
        private const val TAG = "AuroraVideo"
        /** 起播后静置多久收起工具栏（验收人：1-2 秒，取上限）。 */
        private const val CHROME_IDLE_MS = 2000L
        private const val TICK_MS = 250L
        private const val MAX_SCALE = 4f
        /** 捏合下限：0.3 而不是 1——「只能放大不能缩小」是验收人报的第一条（下限钉在 1
         *  就等于把缩小整个动作吃掉了），四档里 1:1/裁切/拉伸 的基准本来就溢出，更要能缩。*/
        private const val MIN_SCALE = 0.3f
        private const val HINT_HIDE_MS = 600L
        /** IDLE 态横滑翻页的判定，与图片那条同一档（ZoomableImageView 用 25% 屏宽） */
        private const val PAGE_DRAG_RATIO = 0.25f
        private const val PAGE_FLING_VELOCITY = 500f
    }

    private val surfaceView: TextureView
    private val bufferingBar: ProgressBar
    private val playFab: ImageButton
    private val chrome: LinearLayout
    private val positionText: TextView
    private val durationText: TextView
    private val seekBar: SeekBar
    private val prevBtn: ImageButton
    private val playPauseBtn: ImageButton
    private val nextBtn: ImageButton
    private val rotateBtn: ImageButton
    private val scaleChip: ImageButton
    private val loopBtn: ImageButton
    private val gestureHint: TextView

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
    private var chromeHidden = false
    private var userDragging = false
    private var surface: Surface? = null

    /** 解码器给的显示尺寸（已按 rotation 与 SAR 折算成"看起来"的宽高） */
    private var videoW = 0
    private var videoH = 0
    private var surfaceMode = SurfaceMode.FIT
    private var userScale = 1f

    /** 首帧之前封面仍透在底下（本层不画底）；之后才用 [letterboxColor] 填信箱区。 */
    private var letterboxColor = Color.TRANSPARENT
    /** 当前 chrome 墨色与主色（循环钮开/关要就地换色，不能等整轮重涂） */
    private var inkColor = Color.WHITE
    private var accentColor = Color.WHITE
    private val letterboxBg = GradientDrawable()

    var onPlayError: ((String) -> Unit)? = null
    /** 顶栏跟着播控条一起显隐（顶栏归查看器持有，这里只发信号）。 */
    var onChromeHiddenChange: ((Boolean) -> Unit)? = null
    /** 静态位横滑翻页：-1=上一条，1=下一条（本层不吃图片视图的手势，翻页得回宿主做）。 */
    var onPageRequest: ((Int) -> Unit)? = null
    /** 左下角的旋转屏幕钮：翻转的是宿主钉的屏幕方向，本层只发信号。 */
    var onRotateRequest: (() -> Unit)? = null

    val isBound: Boolean get() = boundFileId != null

    // —— 手势状态 ——

    private enum class DragAxis { NONE, HORIZONTAL, BRIGHTNESS, VOLUME }

    private var dragAxis = DragAxis.NONE
    private var dragStartX = 0f
    private var dragStartY = 0f
    private var dragStartPositionMs = 0L
    private var dragStartLevel = 0.5f
    private var lastScaleUpAt = 0L
    private val touchSlop = android.view.ViewConfiguration.get(context).scaledTouchSlop

    init {
        background = letterboxBg

        surfaceView = TextureView(context).apply {
            layoutParams = LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT).apply {
                gravity = Gravity.CENTER
            }
            surfaceTextureListener = object : TextureView.SurfaceTextureListener {
                override fun onSurfaceTextureAvailable(st: android.graphics.SurfaceTexture, w: Int, h: Int) {
                    val s = Surface(st)
                    surface = s
                    player.setVideoSurface(s)
                }

                override fun onSurfaceTextureSizeChanged(st: android.graphics.SurfaceTexture, w: Int, h: Int) {}

                /** 返回 true = 销毁权交还系统。本层 GONE（抽屉/退出让位）时必走到这里。 */
                override fun onSurfaceTextureDestroyed(st: android.graphics.SurfaceTexture): Boolean {
                    player.clearVideoSurface()
                    surface?.release()
                    surface = null
                    return true
                }

                override fun onSurfaceTextureUpdated(st: android.graphics.SurfaceTexture) {}
            }
        }
        addView(surfaceView)

        bufferingBar = ProgressBar(context, null, android.R.attr.progressBarStyleLarge).apply {
            layoutParams = LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT).apply {
                gravity = Gravity.CENTER
            }
            indeterminateTintList = android.content.res.ColorStateList.valueOf(Color.WHITE)
            visibility = GONE
        }
        addView(bufferingBar)

        gestureHint = TextView(context).apply {
            layoutParams = LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT).apply {
                gravity = Gravity.TOP or Gravity.CENTER_HORIZONTAL
                topMargin = dp(72f).toInt()
            }
            setTextColor(Color.WHITE)
            textSize = 14f
            gravity = Gravity.CENTER
            val padH = dp(12f).toInt()
            val padV = dp(6f).toInt()
            setPadding(padH, padV, padH, padV)
            background = GradientDrawable().apply {
                cornerRadius = dp(14f)
                setColor(Color.parseColor("#B3000000"))
            }
            visibility = GONE
        }
        addView(gestureHint)

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

        // —— 播控条：上行进度、下行按钮（验收人 2026-10-17：进度条在按钮**上方**）——
        positionText = timeText("00:00")
        durationText = timeText("--:--")
        seekBar = SeekBar(context).apply {
            layoutParams = LinearLayout.LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f)
            setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
                override fun onProgressChanged(bar: SeekBar, value: Int, fromUser: Boolean) {
                    if (fromUser) positionText.text = formatVideoDuration(value.toLong())
                }

                override fun onStartTrackingTouch(bar: SeekBar) {
                    userDragging = true
                    showChrome()
                }

                override fun onStopTrackingTouch(bar: SeekBar) {
                    userDragging = false
                    player.seekTo(bar.progress.toLong())
                    mainHandler.post(ticker)
                    scheduleChromeHide()
                }
            })
        }
        val progressRow = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT,
            )
            addView(positionText)
            addView(seekBar)
            addView(durationText)
        }
        prevBtn = controlButton(R.drawable.ic_lucide_skip_back, 18f, "上一条") { onPageRequest?.invoke(-1) }
        playPauseBtn = controlButton(R.drawable.ic_lucide_play, 18f, "播放/暂停") { togglePlay() }
        nextBtn = controlButton(R.drawable.ic_lucide_skip_forward, 18f, "下一条") { onPageRequest?.invoke(1) }
        val transport = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER
            layoutParams = LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT).apply {
                gravity = Gravity.CENTER
            }
            addView(prevBtn)
            addView(playPauseBtn)
            addView(nextBtn)
        }
        // 画面大小档：图形图标、放这一行的**最右**（验收人 2026-10-17 第二轮）
        scaleChip = ImageButton(context).apply {
            val size = dp(44f).toInt()
            // 它在 rightGroup（LinearLayout）里，参数类型必须是 LinearLayout.LayoutParams
            layoutParams = LinearLayout.LayoutParams(size, size)
            setImageResource(surfaceMode.iconRes)
            scaleType = android.widget.ImageView.ScaleType.CENTER_INSIDE
            val pad = dp(11f).toInt()
            setPadding(pad, pad, pad, pad)
            background = GradientDrawable().apply {
                cornerRadius = dp(12f)
                setColor(Color.parseColor("#40000000"))
            }
            contentDescription = "画面大小"
            setOnClickListener {
                cycleSurfaceMode()
                showChrome()
            }
        }
        rotateBtn = controlButton(R.drawable.ic_lucide_rotate_cw, 0f, "旋转屏幕") {
            onRotateRequest?.invoke()
            showChrome()
        }
        rotateBtn.layoutParams = LayoutParams(dp(44f).toInt(), dp(44f).toInt()).apply {
            gravity = Gravity.START or Gravity.CENTER_VERTICAL
            marginStart = dp(2f).toInt()
        }
        loopBtn = controlButton(R.drawable.ic_lucide_repeat, 0f, "循环播放") {
            val on = toggleLoop()
            refreshLoopTint()
            showHint(if (on) "循环播放：开" else "循环播放：关")
            showChrome()
        }
        // 右侧一组：画面大小档 + 循环（验收人：循环挪到画面大小右边）
        val rightGroup = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            layoutParams = LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT).apply {
                gravity = Gravity.END or Gravity.CENTER_VERTICAL
            }
            addView(scaleChip)
            addView(loopBtn)
        }
        val buttonRow = FrameLayout(context).apply {
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, dp(48f).toInt(),
            )
            addView(transport)
            addView(rightGroup)
            // 旋转屏幕从顶栏挪到这里的最左（验收人：底部播控条左下角）
            addView(rotateBtn)
        }
        chrome = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
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
            addView(progressRow)
            addView(buttonRow)
        }
        addView(chrome)

        player.addListener(object : Player.Listener {
            override fun onPlaybackStateChanged(state: Int) {
                bufferingBar.visibility =
                    if (playbackStarted && state == Player.STATE_BUFFERING) VISIBLE else GONE
                if (state == Player.STATE_READY) syncDurationText()
                // 播完把工具栏叫回来：停在末帧上没有下一步动作可看，藏着键反而按不到档位
                if (state == Player.STATE_ENDED) showChrome()
            }

            override fun onIsPlayingChanged(playing: Boolean) {
                playPauseBtn.setImageResource(if (playing) R.drawable.ic_lucide_pause else R.drawable.ic_lucide_play)
                mainHandler.removeCallbacks(ticker)
                mainHandler.post(ticker)
                if (playing) {
                    scheduleChromeHide()
                } else if (!player.playWhenReady) {
                    // 真·暂停才把工具栏叫回来；缓冲卡顿不算暂停，不该打断正在收起的 chrome
                    showChrome()
                }
            }

            override fun onVideoSizeChanged(videoSize: VideoSize) {
                if (videoSize.width <= 0 || videoSize.height <= 0) return
                val sar = if (videoSize.pixelWidthHeightRatio > 0f) videoSize.pixelWidthHeightRatio else 1f
                val wide = videoSize.width * sar
                val tall = videoSize.height.toFloat()
                // unappliedRotationDegrees = 还没作用到 width/height 上的那圈旋转（媒体文档
                // 里的 rotate 位），90/270 时显示宽高要互换
                if (abs(videoSize.unappliedRotationDegrees % 180) == 90) {
                    videoW = tall.toInt(); videoH = wide.toInt()
                } else {
                    videoW = wide.toInt(); videoH = tall.toInt()
                }
                applySurfaceGeometry()
            }

            override fun onRenderedFirstFrame() {
                firstFrameRendered = true
                refreshLayerState()
            }

            override fun onPlayerError(error: PlaybackException) {
                Log.e(TAG, "播放失败: url=$mediaUrl code=${error.errorCodeName}", error)
                stopPlayback()
                onPlayError?.invoke(error.errorCodeName)
            }
        })

        refreshLayerState()
    }

    /**
     * 位置/缓冲/时长三件事一起推（media3 1.4 的 TimeBar 已无 setPlayer，没有 PlayerView
     * 帮忙自驱）。声明必须排在 init 之后：属性按书写顺序初始化，早于各视图赋值会在
     * definite assignment 上直接编译不过。
     */
    private val ticker = object : Runnable {
        override fun run() {
            if (!playbackStarted) return
            val duration = contentDurationMs
            // currentPosition 在片尾可以略微越过 duration（实测 10950 > 10831），而
            // coerceIn 遇到反序区间直接抛 IllegalArgumentException 把主线程崩掉——先各自夹好
            val raw = player.currentPosition.coerceAtLeast(0L)
            val position = if (duration > 0L) min(raw, duration) else raw
            if (!userDragging) {
                seekBar.max = max(duration, 1L).toInt()
                seekBar.progress = position.toInt()
                val buffered = max(player.bufferedPosition.coerceAtLeast(0L), position)
                seekBar.secondaryProgress = (if (duration > 0L) min(buffered, duration) else buffered).toInt()
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
     * [width]/[height] 是服务端 browse 已经给过的容器宽高（A3 那轮补的）：先用它把几何摆正，
     * 等 `onVideoSizeChanged` 再按解码器口径精修。
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
        videoW = max(width, 0)
        videoH = max(height, 0)
        userScale = 1f
        applySurfaceGeometry()
        refreshLayerState()
    }

    /** 换页/关闭/进幻灯片/退出过渡：彻底停掉这一路视频（不后台出声）。 */
    fun detach() {
        stopPlayback()
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
     * 播控条那一条上——两种形制都与本层的几何对不上。抽屉只要离开全关位就藏本层并
     * 暂停，回到 0 再由同一入口交还。
     */
    fun setDrawerOccluded(occluded: Boolean) {
        if (drawerOccluded == occluded) return
        drawerOccluded = occluded
        if (occluded && player.isPlaying) player.pause()
        refreshLayerState()
    }

    /** 顶栏循环钮的落点：单条循环（图库里短视频反复放最常用）。返回新状态给按钮上色。 */
    fun toggleLoop(): Boolean {
        player.repeatMode = if (player.repeatMode == Player.REPEAT_MODE_ONE) {
            Player.REPEAT_MODE_OFF
        } else {
            Player.REPEAT_MODE_ONE
        }
        return player.repeatMode == Player.REPEAT_MODE_ONE
    }

    /** 起播（中央播放键与播控条的播放钮都走这里）。 */
    fun start() {
        val url = mediaUrl
        if (boundFileId == null || url.isEmpty()) return
        if (!playbackStarted) {
            player.setMediaItem(MediaItem.fromUri(Uri.parse(url)))
            player.prepare()
            playbackStarted = true
            seekBar.max = contentDurationMs.toInt().coerceAtLeast(1)
            syncDurationText()
        }
        if (player.playbackState == Player.STATE_ENDED) player.seekTo(0L)
        player.playWhenReady = true
        scheduleChromeHide()
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
    }

    // —— 触摸与手势 ——

    private val tapDetector = GestureDetector(context, object : GestureDetector.SimpleOnGestureListener() {
        override fun onSingleTapConfirmed(e: MotionEvent): Boolean {
            // 捏合抬手后 GestureDetector 可能补一个单击，吞掉否则「缩放完工具栏自己跳出来」
            if (android.os.SystemClock.uptimeMillis() - lastScaleUpAt < 200L) return true
            if (chromeHidden) showChrome() else hideChromeNow()
            return true
        }

        override fun onFling(e1: MotionEvent?, e2: MotionEvent, velocityX: Float, velocityY: Float): Boolean {
            if (playbackStarted || dragAxis != DragAxis.HORIZONTAL) return false
            val from = e1 ?: return false
            if (abs(velocityX) < PAGE_FLING_VELOCITY || abs(from.x - e2.x) < touchSlop) return false
            onPageRequest?.invoke(if (velocityX < 0) 1 else -1)
            dragAxis = DragAxis.NONE
            return true
        }
    })

    private val scaleDetector = ScaleGestureDetector(context,
        object : ScaleGestureDetector.SimpleOnScaleGestureListener() {
            override fun onScale(detector: ScaleGestureDetector): Boolean {
                // 「跟图片一样，只是居中缩放」：只改倍率，锚点恒在中心，不做焦点跟随
                userScale = (userScale * detector.scaleFactor).coerceIn(MIN_SCALE, MAX_SCALE)
                applySurfaceGeometry()
                return true
            }

            /** 第二指一落地就放弃单指判定：否则「先落一指、略微移动再补第二指」这个
             *  最常见起手式会被当成竖滑，捏合过程中突然把亮度/音量改了（验收人第二条）。*/
            override fun onScaleBegin(detector: ScaleGestureDetector): Boolean {
                cancelDrag()
                return true
            }

            override fun onScaleEnd(detector: ScaleGestureDetector) {
                lastScaleUpAt = android.os.SystemClock.uptimeMillis()
                // 接近基准位就吸附上去，省得停在 1.03 这种既不是原样也看不出差别的位置
                if (abs(userScale - 1f) < 0.06f) userScale = 1f
                applySurfaceGeometry()
            }
        })

    override fun onTouchEvent(ev: MotionEvent): Boolean {
        if (!isBound) return false
        scaleDetector.onTouchEvent(ev)
        tapDetector.onTouchEvent(ev)
        when (ev.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                dragAxis = DragAxis.NONE
                dragStartX = ev.x
                dragStartY = ev.y
                dragStartPositionMs = player.currentPosition.coerceAtLeast(0L)
                dragStartLevel = if (ev.x < width / 2f) currentBrightness() else player.volume
            }

            MotionEvent.ACTION_MOVE ->
                if (ev.pointerCount > 1 || scaleDetector.isInProgress) cancelDrag() else handleDrag(ev)

            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> finishDrag(ev)
        }
        return true
    }

    private fun handleDrag(ev: MotionEvent) {
        val dx = ev.x - dragStartX
        val dy = ev.y - dragStartY
        if (dragAxis == DragAxis.NONE) {
            if (max(abs(dx), abs(dy)) < touchSlop) return
            dragAxis = if (abs(dx) > abs(dy)) DragAxis.HORIZONTAL
            else if (dragStartX < width / 2f) DragAxis.BRIGHTNESS else DragAxis.VOLUME
            if (dragAxis == DragAxis.HORIZONTAL) userDragging = true
        }
        when (dragAxis) {
            DragAxis.HORIZONTAL -> if (playbackStarted) {
                val duration = contentDurationMs
                // 全程按 Float 算再收口：dx(Float) / 屏宽 * 时长(Long) 混着 coerceIn(0L,..) 编不过
                val target = (dragStartPositionMs + dx / max(width, 1).toFloat() * duration)
                    .coerceIn(0f, duration.toFloat())
                    .toLong()
                seekBar.max = duration.toInt().coerceAtLeast(1)
                seekBar.progress = target.toInt()
                positionText.text = formatVideoDuration(target)
                showHint("${formatVideoDuration(target)} / ${formatVideoDuration(duration)}")
            }

            DragAxis.BRIGHTNESS, DragAxis.VOLUME -> {
                // 上滑增大：整屏行程 = 0..1
                val level = (dragStartLevel - dy / max(height, 1)).coerceIn(0f, 1f)
                val percent = (level * 100).toInt()
                if (dragAxis == DragAxis.BRIGHTNESS) {
                    applyBrightness(level)
                    showHint("亮度 $percent%")
                } else {
                    player.volume = level
                    showHint("音量 $percent%")
                }
            }

            DragAxis.NONE -> {}
        }
    }

    private fun finishDrag(ev: MotionEvent) {
        if (dragAxis == DragAxis.HORIZONTAL) {
            userDragging = false
            if (playbackStarted) {
                player.seekTo(seekBar.progress.toLong())
                mainHandler.post(ticker)
            } else {
                // 静态位横滑 = 翻页（与图片那条 25% 屏宽同口径；快滑另有 onFling 兜住）
                val dx = ev.x - dragStartX
                if (abs(dx) > width * PAGE_DRAG_RATIO) onPageRequest?.invoke(if (dx < 0) 1 else -1)
            }
            scheduleChromeHide()
        }
        dragAxis = DragAxis.NONE
        mainHandler.removeCallbacks(hideHint)
        mainHandler.postDelayed(hideHint, HINT_HIDE_MS)
    }

    /** 多指一出现就把单指判定撤掉：进度拖拽要交回 ticker，亮度/音量已经改的不再回滚。 */
    private fun cancelDrag() {
        if (dragAxis == DragAxis.HORIZONTAL) userDragging = false
        dragAxis = DragAxis.NONE
    }

    /** 亮度是本窗口的属性，退出视频必须还原成「跟随系统」，否则整个 App 被留在暗档。 */
    private fun applyBrightness(level: Float) {
        val window = (context as? Activity)?.window ?: return
        val attrs = window.attributes
        attrs.screenBrightness = level
        window.attributes = attrs
    }

    private fun currentBrightness(): Float {
        val attrs = (context as? Activity)?.window?.attributes ?: return 0.5f
        // -1 = 跟随系统，读不到真实档位，从中间起步（再拖就是相对这个起点算）
        return if (attrs.screenBrightness > 0f) attrs.screenBrightness else 0.5f
    }

    private fun restoreBrightness() {
        val window = (context as? Activity)?.window ?: return
        val attrs = window.attributes
        if (attrs.screenBrightness in 0f..1f) {
            attrs.screenBrightness = -1f
            window.attributes = attrs
        }
    }

    // —— 画面几何（四档 + 捏合倍率） ——

    /** 循环钮：开着染主色、关着随 chrome 墨色（图标本身不带状态，只靠颜色区分）。 */
    private fun refreshLoopTint() {
        loopBtn.setColorFilter(if (player.repeatMode == Player.REPEAT_MODE_ONE) accentColor else inkColor)
    }

    private fun cycleSurfaceMode() {
        surfaceMode = SurfaceMode.entries[(surfaceMode.ordinal + 1) % SurfaceMode.entries.size]
        userScale = 1f
        scaleChip.setImageResource(surfaceMode.iconRes)
        applySurfaceGeometry()
        // 图标本身不带字，切换瞬间用浮层报一次档名（否则用户不知道按到了哪一档）
        showHint("画面：${surfaceMode.label}")
    }

    /**
     * 把「档位 × 捏合倍率」折算成 TextureView 的边界尺寸。TextureView 会把解码缓冲
     * 拉伸填满自身边界，所以边界比 = 视频比时就是「适应/裁切/1:1」，边界 = 媒体区时是「拉伸」。
     *
     * 写在 onMeasure 里（改 lp 但不 requestLayout）：本层尺寸变化、档位变化、捏合都会
     * 走到这里，而在 onSizeChanged 里 setLayoutParams 属于「布局期间请求重排」，会多绕一帧。
     */
    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        (surfaceView.layoutParams as? LayoutParams)?.let { lp ->
            val (w, h) = surfaceBoxSize(measureSpecSize(widthMeasureSpec), measureSpecSize(heightMeasureSpec))
            lp.width = w
            lp.height = h
        }
        super.onMeasure(widthMeasureSpec, heightMeasureSpec)
    }

    private fun measureSpecSize(spec: Int): Int =
        if (MeasureSpec.getMode(spec) == MeasureSpec.UNSPECIFIED) 0 else MeasureSpec.getSize(spec)

    /** 返回 (宽,高)；[LayoutParams.MATCH_PARENT] 表示「还没拿到视频比例，先铺满」。 */
    private fun surfaceBoxSize(areaW: Int, areaH: Int): Pair<Int, Int> {
        if (areaW <= 0 || areaH <= 0) return LayoutParams.MATCH_PARENT to LayoutParams.MATCH_PARENT
        if (videoW <= 0 || videoH <= 0) {
            // 比例未知（本地视频没元数据 / 还没出首帧）：铺满，等 onVideoSizeChanged 再修
            return LayoutParams.MATCH_PARENT to LayoutParams.MATCH_PARENT
        }
        val fitScale = min(areaW.toFloat() / videoW, areaH.toFloat() / videoH)
        val (w, h) = when (surfaceMode) {
            SurfaceMode.FIT -> (videoW * fitScale) to (videoH * fitScale)
            SurfaceMode.ZOOM -> {
                val cover = max(areaW.toFloat() / videoW, areaH.toFloat() / videoH)
                (videoW * cover) to (videoH * cover)
            }
            // 1:1 = 一个视频像素一个屏幕像素（比屏幕大由父层裁掉，居中）
            SurfaceMode.ONE_TO_ONE -> videoW.toFloat() to videoH.toFloat()
            SurfaceMode.FILL -> areaW.toFloat() to areaH.toFloat()
        }
        return (w * userScale).toInt().coerceAtLeast(1) to (h * userScale).toInt().coerceAtLeast(1)
    }

    private fun applySurfaceGeometry() {
        requestLayout()
    }

    // —— 内部 ——

    private val contentDurationMs: Long
        get() {
            val d = player.duration
            return if (d > 0L) d else fallbackDurationMs
        }

    private fun stopPlayback() {
        mainHandler.removeCallbacks(ticker)
        if (playbackStarted) {
            player.playWhenReady = false
            player.stop()
            player.clearMediaItems()
        }
        playbackStarted = false
        firstFrameRendered = false
        userDragging = false
        dragAxis = DragAxis.NONE
        // 下一条必须带着「工具栏可见」起步：上一条是滑到自动收起状态里退出/翻页的，
        // 不归零就会开成一条没有播控条也没有播放键的黑屏
        chromeHidden = false
        gestureHint.visibility = GONE
        bufferingBar.visibility = GONE
        seekBar.progress = 0
        seekBar.secondaryProgress = 0
        // 时间文字必须随 bind 归零：tick 只在 playing 期间跑，换到下一条若停在缓冲态，
        // 不归零就会把上一条的 00:34 顶在一条 10 秒的片子上（实测踩过）
        positionText.text = "00:00"
        restoreBrightness()
        refreshLayerState()
    }

    private fun controlButton(iconRes: Int, gapDp: Float, description: String, onClick: () -> Unit): ImageButton =
        ImageButton(context).apply {
            val size = dp(44f).toInt()
            // 三个传输键各自左右留 gapDp（验收人：再分开一些）——相邻两键之间 = 2×gap
            val gap = dp(gapDp).toInt()
            layoutParams = LinearLayout.LayoutParams(size, size).apply {
                marginStart = gap
                marginEnd = gap
            }
            setImageResource(iconRes)
            scaleType = android.widget.ImageView.ScaleType.CENTER_INSIDE
            val pad = dp(9f).toInt()
            setPadding(pad, pad, pad, pad)
            background = null
            contentDescription = description
            setOnClickListener {
                onClick()
                showChrome()
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

    private fun showHint(text: String) {
        gestureHint.text = text
        gestureHint.visibility = VISIBLE
        // 每次出现都重新计时：拖动过程中连续调用不能把计时器续成永不消失
        mainHandler.removeCallbacks(hideHint)
        mainHandler.postDelayed(hideHint, HINT_HIDE_MS)
    }

    private val hideHint = Runnable { gestureHint.visibility = GONE }

    /**
     * 收起计时的判据是「用户要看」（playWhenReady）而不是「正在出帧」（isPlaying）：
     * 模拟器软解 3440×1440@60 常年停在缓冲态，按 isPlaying 收就永远收不起来（实测踩过）。
     * 播完停在 ENDED 也不算「要看」——那时收掉工具栏，用户点哪儿都只剩唤回/收起，
     * 画面大小与循环这些档位键反而按不到（实测踩过）。
     */
    private val wantsToWatch: Boolean
        get() = playbackStarted && player.playWhenReady && player.playbackState != Player.STATE_ENDED

    private fun scheduleChromeHide() {
        mainHandler.removeCallbacks(hideChrome)
        if (wantsToWatch) mainHandler.postDelayed(hideChrome, CHROME_IDLE_MS)
    }

    private val hideChrome = Runnable { if (wantsToWatch) hideChromeNow() }

    private fun hideChromeNow() {
        chromeHidden = true
        applyChromeVisibility()
    }

    private fun showChrome() {
        chromeHidden = false
        applyChromeVisibility()
        scheduleChromeHide()
    }

    private fun applyChromeVisibility() {
        chrome.animate().cancel()
        chrome.alpha = if (chromeHidden) 0f else 1f
        chrome.visibility = if (chromeHidden) INVISIBLE else VISIBLE
        playFab.visibility = if (isBound && !playbackStarted && !chromeHidden) VISIBLE else GONE
        // 只有绑定期间本层才持有工具栏的显隐权；未绑定时发信号会和图片的沉浸态抢顶栏
        if (isBound) onChromeHiddenChange?.invoke(chromeHidden)
    }

    /** 单一出口：所有状态变化之后都走这里把显隐与底色落定。 */
    private fun refreshLayerState() {
        val bound = boundFileId != null
        visibility = if (bound && !drawerOccluded) VISIBLE else GONE
        bufferingBar.visibility = if (playbackStarted && player.playbackState == Player.STATE_BUFFERING) VISIBLE else GONE
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
        inkColor = textColor
        this.accentColor = accentColor
        for (v in listOf(prevBtn, playPauseBtn, nextBtn, playFab, rotateBtn)) v.setColorFilter(textColor)
        refreshLoopTint()
        positionText.setTextColor(textColor)
        durationText.setTextColor(textColor)
        scaleChip.setColorFilter(textColor)
        chrome.background = GradientDrawable().apply {
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
