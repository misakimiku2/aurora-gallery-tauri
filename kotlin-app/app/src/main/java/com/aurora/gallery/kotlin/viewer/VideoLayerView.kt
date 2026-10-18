package com.aurora.gallery.kotlin.viewer

// 视频 P3-A2.5：查看器的视频层本体（ExoPlayer + TextureView + 双行播控 + 全套手势）。
// 宿主见 NativeGalleryViewVideo.kt（同步/翻页避让的胶水）与 NativeGalleryView（装配与生命周期）。

import android.app.Activity
import android.content.Context
import android.graphics.Bitmap
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
import androidx.media3.common.PlaybackParameters
import androidx.media3.common.Player
import androidx.media3.common.VideoSize
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.DefaultLoadControl
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.upstream.DefaultAllocator
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
        /**
         * 倍速档清单：与桌面端同一张表（UI 子文档 §3「0.5 / 1 / 1.25 / 1.5 / 2」）。
         * 触屏没有悬停菜单，所以不像桌面那样弹列表，照本层既有形制「点一下切一档 + 浮层报档名」。
         */
        private val SPEEDS = listOf(
            0.5f to "0.5x",
            1f to "1x",
            1.25f to "1.25x",
            1.5f to "1.5x",
            2f to "2x",
        )
        /**
         * 拖拽节流的落地间隔。**必须是节流不能是去抖**，见 [scheduleScrub]。
         *
         * 200ms 是实施方案给的值，**不是模拟器量出来最好的**：200 与 300 两档平均都落后目标
         * ~1.6 段（分不出好坏），而绝对滞后量不准——`screenrecord` 与模拟器软解抢 CPU，
         * 同一条拖拽换一种测量法能给出 1.6~2.5 秒的区间。**跟手度只能真机判**：
         * 嫌拖拽发涩就往小调，画面跟不上目标就往 300~500ms 调大。
         */
        private const val SCRUB_THROTTLE_MS = 200L
        /**
         * 两段式横滑改时间（照 MX Player 的 slow seek）。**满屏宽不再等于整条时间轴**：
         * 一小时的片子划四分之一屏就跳 15 分钟，冲到手忙（真机第十轮报的）。
         * 本轮第一发 = 全长的 10%（粗调），5 秒内接着划的每一发 = 全长的 1% 再夹进 10~60 秒（细调）。
         *
         * ⚠️ [DRAG_TWO_STAGE_MIN_MS] 以内**完全不启用**，保持原来的 1:1 —— 这个库里的主力形态
         * 是几秒到几十秒的手机录屏，给它们套上比例尺等于把短片灵敏度废掉。
         */
        private const val DRAG_TWO_STAGE_MIN_MS = 120_000L
        private const val DRAG_COARSE_FRACTION = 0.10
        private const val DRAG_FINE_FRACTION = 0.01
        private const val DRAG_FINE_MIN_MS = 10_000L
        private const val DRAG_FINE_MAX_MS = 60_000L
        /** 隔这么久没再横滑，就退回「本轮第一发」的粗调档 */
        private const val DRAG_SESSION_RESET_MS = 5_000L
        /**
         * 远端（LAN）缓冲档：**上限 10 秒 / 48MB，两者取先到者**。库默认是 50 秒
         * （`MIN`/`MAX_BUFFER_MS` 都是 50000，混合轨分配器上限 `DEFAULT_MUXED_BUFFER_SIZE`
         * ≈ 137MB），本地读文件无所谓，走 WiFi 就是每次起播几十 MB 的突发——视频之间连续翻页
         * 会自动起播（第八轮），「停两秒就切走」每条都要付一次，所以必须压。
         *
         * **实际囤到的是几秒由码率说了算，不是那 10 秒**：这批库里的录屏实测 64~92 Mbps
         * ≈ 8~11.5 MB/s（ffprobe，见《视频拖拽实时预览-实施方案》§2），48MB 只够 **4~6 秒**，
         * `REMOTE_BUFFER_MS` 那档在这批素材上根本到不了。上一版是 16MB，注释里写的「10 秒」
         * 是假的——算术上只有 1.4~2.1 秒，往后拖基本一定拖出缓冲。抬到 48MB 换的就是
         * 「往前拖多数落在缓冲内 = 瞬发」这条手感；代价是 LAN 播放峰值内存 ~16MB → ~48MB
         * （一台播放器跨页复用，不累积）。
         *
         * ⚠️ 「48MB ≈ 4~6 秒」仍是 `字节 ÷ 实测码率` 的算术，**没量过**；弱网与更高码率下
         * 够不够只能真机读 `logcat -s AuroraVideo` 里 READY 那行的实际囤积秒数。
         */
        private const val REMOTE_BUFFER_MS = 10_000
        private const val REMOTE_TARGET_BUFFER_BYTES = 48 * 1024 * 1024
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
    private val speedChip: TextView
    private val loopBtn: ImageButton
    private val gestureHint: TextView

    private val mainHandler = Handler(Looper.getMainLooper())

    /**
     * 播放器按「本地 / 远端」两档缓冲建，切档时**重建一台**（见 [ensurePlayerProfile]）。
     * 初建走本地档：属性初始化时 `context` 还是构造参数，不碰任何未落定的字段。
     */
    private var player: ExoPlayer = buildPlayer(remote = false)
    private var playerRemote = false
    /** 监听器只能挂一次、换档要重挂，所以存成字段给 [buildPlayer] 复用。 */
    private var playerListener: Player.Listener? = null
    /** 音量手势的值要跨档保留：换档重建播放器会把 `volume` 打回 1.0。 */
    private var volumeLevel = 1f

    private fun buildLoadControl(remote: Boolean): DefaultLoadControl {
        // 本地档 = 库默认（50 秒 / 混合轨上限 ~137MB）：读的是自己的文件，
        // 多囤只有好处，不占网络。
        if (!remote) return DefaultLoadControl.Builder().build()
        return DefaultLoadControl.Builder()
            .setAllocator(DefaultAllocator(true, REMOTE_TARGET_BUFFER_BYTES))
            .setBufferDurationsMs(
                /* minBufferMs = */ REMOTE_BUFFER_MS,
                /* maxBufferMs = */ REMOTE_BUFFER_MS,
                /* bufferForPlaybackMs = */ 1500,
                /* bufferForPlaybackAfterRebufferMs = */ 3000,
            )
            .build()
    }

    private fun buildPlayer(remote: Boolean): ExoPlayer =
        ExoPlayer.Builder(context)
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(C.USAGE_MEDIA)
                    .setContentType(C.AUDIO_CONTENT_TYPE_MOVIE)
                    .build(),
                /* handleAudioFocus = */ true,
            )
            .setHandleAudioBecomingNoisy(true)
            .setLoadControl(buildLoadControl(remote))
            .build()
            .also { p ->
                playerListener?.let { p.addListener(it) }
                // 换档后同一块 surface 要重新交给新播放器，否则新档位永远不出画
                surface?.let { p.setVideoSurface(it) }
                p.volume = volumeLevel
            }

    /**
     * 按「这一项是不是 LAN」对齐播放器档位。**只在真的换档时重建**（本地↔远端之间翻页
     * 才会发生，同一段浏览里几乎不会来回切），且只在 `bind()` 里、起播之前调——
     * 播放中途换档要重建解码器，代价与风险都不该付。
     */
    private fun ensurePlayerProfile(remote: Boolean) {
        if (playerRemote == remote) return
        Log.i(TAG, "播放器缓冲档位 -> remote=$remote（${if (remote) "${REMOTE_BUFFER_MS}ms / ${REMOTE_TARGET_BUFFER_BYTES / 1048576}MB" else "库默认"}）")
        runCatching { player.release() }
        player = buildPlayer(remote)
        playerRemote = remote
    }

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
    /** 倍速档索引，默认 1x。**归本层字段管**，每次 [start] 重新下发给播放器，
     *  不依赖 media3 在 `stop()`/`clearMediaItems()` 之后还留着多少状态。*/
    private var speedIdx = SPEEDS.indexOfFirst { it.first == 1f }

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

    /**
     * 竖屏窄宽形制：把倍速与画面大小两颗从播控条摘掉，动作改走宿主「更多」菜单
     * （验收人 2026-10-18 真机：右组会压到下一条视频上）。由宿主在形制收敛处唯一写入，
     * 与顶栏收敛同一个判据（`isCompactPortrait`），两条不会走岔。
     */
    var compactControls = false
        set(value) {
            if (field == value) return
            field = value
            val target = if (value) GONE else VISIBLE
            speedChip.visibility = target
            scaleChip.visibility = target
        }

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

    // —— 拖拽实时预览（画面跟着进度走）——
    //
    // 两条入口（播控条的 SeekBar 与画面上的横滑）**共用下面这一个节流器**，不复制第二份。

    /** 待执行的拖拽目标（毫秒），`-1` = 没有待执行的 */
    private var pendingScrubMs = -1L
    /** 上一次真正落地的时刻（uptimeMillis），节流窗口的起点 */
    private var lastScrubApplyAt = 0L
    /** 拖之前的播放意图，松手照它续播。`stopPlayback` 必须一起归零，见那里。 */
    private var scrubWasPlaying = false
    /** 本轮横滑是否已进入细调档（两段式慢搜的第二段），见 [scrubScaleMs] */
    private var fineScrub = false
    /** 上一次横滑落下的时刻（uptimeMillis），用来判本轮还是不是"接着划" */
    private var lastScrubGestureAt = 0L

    /**
     * 节流的落地动作。**每次现读 [player]**：换缓冲档位会重建播放器（[ensurePlayerProfile]），
     * 把实例存进 Runnable 就会在换档后 seek 到已 release 的那台上。
     */
    private val scrubApply = Runnable {
        val target = pendingScrubMs
        if (target >= 0L) {
            pendingScrubMs = -1L
            lastScrubApplyAt = android.os.SystemClock.uptimeMillis()
            if (playbackStarted) {
                Log.d(TAG, "scrub -> ${target}ms (started=$playbackStarted playing=${player.isPlaying})")
                player.seekTo(target)
            }
        }
    }

    /**
     * 开始拖拽：记下播放意图并把播放器停住。
     *
     * 敢停是因为**暂停态 `seekTo()` 会渲染目标帧**（2026-10-18 模拟器实测：停在 SEG2，
     * 一拖画面立刻变 SEG6、再拖变 SEG1，松手后隔两秒再截图不动 = 全程真暂停）。
     * 这条在 MagicOS/EMUI 的硬解上还没验，只能真机判（实施方案 §4.0 / §6）。
     */
    private fun beginScrub() {
        userDragging = true
        lastScrubApplyAt = 0L   // 拖拽第一发不该先空等一个节流窗口
        refreshBufferingBar()   // 手指一落地就把转圈收掉，别在拖的过程中反复闪
        scrubWasPlaying = playbackStarted && player.playWhenReady
        if (scrubWasPlaying) player.playWhenReady = false
        showChrome()
    }

    /**
     * 横滑改时间的**比例尺**：满屏宽代表多少毫秒。原来等于整条时间轴，长片上划一下
     * 跳十几分钟（真机第十轮报的），所以分粗调/细调两档，理由见 [DRAG_TWO_STAGE_MIN_MS]。
     */
    private fun scrubScaleMs(durationMs: Long): Long = when {
        durationMs <= DRAG_TWO_STAGE_MIN_MS -> durationMs
        fineScrub -> (durationMs * DRAG_FINE_FRACTION).toLong()
            .coerceIn(DRAG_FINE_MIN_MS, DRAG_FINE_MAX_MS)
        else -> (durationMs * DRAG_COARSE_FRACTION).toLong()
    }

    /**
     * 每次横滑起手调一次，决定这一发是粗调还是细调。**只服务画面横滑那条**：
     * 底部进度条是绝对定位（手指直接落到目标点），给它套比例尺反而够不到片尾。
     */
    private fun markScrubGesture() {
        val now = android.os.SystemClock.uptimeMillis()
        fineScrub = now - lastScrubGestureAt <= DRAG_SESSION_RESET_MS
        lastScrubGestureAt = now
    }

    /**
     * 拖出新目标：**节流**（每 [SCRUB_THROTTLE_MS] 最多落地一次），不是去抖。
     *
     * 实施方案原本写的「每来一发就 removeCallbacks + postDelayed」是去抖：手指连续移动时
     * 每一发都把计时器往后推，seek 永远不落地（2026-10-18 模拟器实测：6 秒慢拖，中途两张
     * 截图画面纹丝不动，只有松手才跳）。这里改成窗口满了就地 seek、没满才排到窗口余下的
     * 时间，既保证「只追最新目标」，又保证拖拽过程中每 200ms 一定出一帧。
     */
    private fun scheduleScrub(targetMs: Long) {
        pendingScrubMs = targetMs
        val wait = SCRUB_THROTTLE_MS - (android.os.SystemClock.uptimeMillis() - lastScrubApplyAt)
        mainHandler.removeCallbacks(scrubApply)
        if (wait <= 0L) scrubApply.run() else mainHandler.postDelayed(scrubApply, wait)
    }

    /**
     * 结束拖拽（松手 / 撤销）。[targetMs] 为 `null` = 撤销：位置不回滚（与亮度、音量
     * 那条同一口径），只撤掉待执行的节流；否则把节流立刻落地到这个最终位置。
     * 两种收尾都照 [scrubWasPlaying] 续播——撤销的是「这次拖拽」，不是「他要播」。
     */
    private fun endScrub(targetMs: Long?) {
        val resume = scrubWasPlaying
        scrubWasPlaying = false
        userDragging = false
        lastScrubApplyAt = 0L
        mainHandler.removeCallbacks(scrubApply)
        pendingScrubMs = -1L
        if (playbackStarted) {
            if (targetMs != null) player.seekTo(targetMs)
            if (resume) player.playWhenReady = true
            // ticker 只在 isPlaying 时自续，拖拽期间是暂停的所以它不会自己跑，必须补一发
            mainHandler.post(ticker)
        }
        scheduleChromeHide()
        // 松手后重新判一次：真落在未缓冲处就该把转圈还回来（拖拽期间被它压掉了）
        refreshBufferingBar()
    }

    /** 换条/换档/退出：把拖拽状态整个归零。**漏了会串台**——翻页后那条待执行的 seek
     *  会把上一条的时间拖到新的一条上（实施方案 §4.3）。 */
    private fun resetScrub() {
        mainHandler.removeCallbacks(scrubApply)
        pendingScrubMs = -1L
        scrubWasPlaying = false
        // 换条之后"本轮"就重新开始，不该带着上一条的细调档
        fineScrub = false
        lastScrubGestureAt = 0L
    }

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
                    if (!fromUser) return
                    positionText.text = formatVideoDuration(value.toLong())
                    // 拖拽中画面跟着走：只把目标交给节流器，绝不在回调里直接 seek
                    if (playbackStarted) scheduleScrub(value.toLong())
                }

                override fun onStartTrackingTouch(bar: SeekBar) = beginScrub()

                override fun onStopTrackingTouch(bar: SeekBar) = endScrub(bar.progress.toLong())
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
            // 无底：与其余播控键同一形制（验收人 2026-10-18：圆角矩形框是多余的一层）
            background = null
            contentDescription = "画面大小"
            setOnClickListener {
                cycleSurfaceMode()
                showChrome()
            }
        }
        // 倍速档：钮面直接是数字（档位本身就是可读的值，比图标好认）
        speedChip = TextView(context).apply {
            val size = dp(44f).toInt()
            // 与 scaleChip 一样在 rightGroup（LinearLayout）里，参数类型必须是 LinearLayout.LayoutParams
            layoutParams = LinearLayout.LayoutParams(size, size)
            gravity = Gravity.CENTER
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
            typeface = android.graphics.Typeface.DEFAULT_BOLD
            includeFontPadding = false
            background = null
            contentDescription = "倍速"
            text = SPEEDS[speedIdx].second
            setTextColor(inkColor)
            setOnClickListener {
                cycleSpeed()
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
        // 右侧一组：倍速 · 画面大小 · 循环
        val rightGroup = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            layoutParams = LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT).apply {
                gravity = Gravity.END or Gravity.CENTER_VERTICAL
            }
            addView(speedChip)
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

        // 存成字段而不是匿名传入：换缓冲档位会重建播放器，新那台要重挂同一个监听器
        playerListener = object : Player.Listener {
            override fun onPlaybackStateChanged(state: Int) {
                refreshBufferingBar()
                if (state == Player.STATE_READY) {
                    syncDurationText()
                    // 缓冲档真正生效的上限是字节不是秒，实际囤几秒只能这样读出来（§3 的诚实登记）
                    Log.i(
                        TAG,
                        "READY remote=$playerRemote position=${player.currentPosition}ms " +
                            "囤了 ${(player.bufferedPosition - player.currentPosition) / 1000.0}s",
                    )
                }
                // LAN 往后拖的手感 = 这一行出现的次数（实施方案 §4.4，模拟器那条量不出来）
                if (state == Player.STATE_BUFFERING && playbackStarted) {
                    Log.i(TAG, "BUFFERING remote=$playerRemote position=${player.currentPosition}ms")
                }
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
                Log.i(
                    TAG,
                    "VideoSize 编码 ${videoSize.width}x${videoSize.height} " +
                        "unapplied=${videoSize.unappliedRotationDegrees} sar=${videoSize.pixelWidthHeightRatio}",
                )
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
        }.also { player.addListener(it) }

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
     * 取**当前正在显示**的那一帧（A5.5.2「从当前帧设为封面」的数据源）。
     *
     * `TextureView.getBitmap()` 在还没出过帧时返回 null（静态位、纯缓冲都算），所以调用方
     * 必须接受失败——把封面设成黑场比不设糟得多。拿到的是**已按旋转渲染好**的显示尺寸。
     */
    fun currentFrame(): Bitmap? =
        if (!firstFrameRendered) null else runCatching { surfaceView.bitmap }.getOrNull()

    /**
     * 绑定当前项。**不预加载**：只记 URL，数据要等 [start] 才拉——LAN 的录屏动辄上百 MB，
     * 翻页路过就开下整片的代价不可接受（Coil 那条大图请求就是前车之鉴）。
     *
     * [width]/[height] 是服务端 browse 已经给过的容器宽高（A3 那轮补的）：先用它把几何摆正，
     * 等 `onVideoSizeChanged` 再按解码器口径精修。
     */
    fun bind(fileId: String, url: String, durationMs: Long, width: Int, height: Int, remote: Boolean) {
        if (boundFileId == fileId) {
            refreshLayerState()
            return
        }
        detach()
        if (url.isEmpty()) return
        // 档位换在这（起播之前）：本地与 LAN 的缓冲预算不同，见 [ensurePlayerProfile]
        ensurePlayerProfile(remote)
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
        resetSurface()
        boundFileId = null
        mediaUrl = ""
        fallbackDurationMs = 0L
    }

    /**
     * 把 TextureView 摘掉重挂，逼它换一块全新的 SurfaceTexture。
     *
     * **为什么必须这么干**：TextureView 的内容不由视图树说了算——`player.stop()` 之后，
     * 上一只视频**最后一次解码的帧还留在 surface 里**，而这一层在静态位是透明的（要让
     * 底下图片视图里的封面透出来），于是那块旧帧就盖在封面上面，表现成「切了页，封面还是
     * 上一条视频」。
     *
     * 用 `GONE`/`alpha=0` 也能藏住它，但那两条会让 TextureView 不参与绘制，
     * SurfaceTexture 就不创建（`updateLayer()` 只在 draw 里跑）——起播要多等一次
     * `onSurfaceTextureAvailable`，把「按播放到出画」这条热路径拖慢。摘掉重挂既清掉旧帧、
     * 视图又始终可见，surface 在下一帧就重建好；旧的按 `onSurfaceTextureDestroyed`
     * 返回 true 的既有约定交还系统。
     */
    private fun resetSurface() {
        val lp = surfaceView.layoutParams ?: return
        removeView(surfaceView)
        addView(surfaceView, 0, lp)
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
        // 每次起播都重下倍速：本层只认 speedIdx 这一个真源，不赌 stop() 之后播放器还剩什么
        applySpeed()
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
                dragStartLevel = if (ev.x < width / 2f) currentBrightness() else volumeLevel
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
            if (dragAxis == DragAxis.HORIZONTAL) { beginScrub(); markScrubGesture() }
        }
        when (dragAxis) {
            DragAxis.HORIZONTAL -> if (playbackStarted) {
                val duration = contentDurationMs
                // 满屏宽 = 一个比例尺，不再等于整条时间轴；分档理由见 scrubScaleMs
                val scale = scrubScaleMs(duration)
                // 全程按 Float 算再收口：dx(Float) / 屏宽 * 时长(Long) 混着 coerceIn(0L,..) 编不过
                val target = (dragStartPositionMs + dx / max(width, 1).toFloat() * scale)
                    .coerceIn(0f, duration.toFloat())
                    .toLong()
                seekBar.max = duration.toInt().coerceAtLeast(1)
                seekBar.progress = target.toInt()
                positionText.text = formatVideoDuration(target)
                // 档位要看得见，否则"同样划一下怎么跳得不一样多"完全成谜
                val mode = if (duration > DRAG_TWO_STAGE_MIN_MS) {
                    if (fineScrub) " · 细调" else " · 粗调"
                } else ""
                showHint("${formatVideoDuration(target)} / ${formatVideoDuration(duration)}$mode")
                // 与播控条那条同一个节流器：画面跟着进度走
                scheduleScrub(target)
            }

            DragAxis.BRIGHTNESS, DragAxis.VOLUME -> {
                // 上滑增大：整屏行程 = 0..1
                val level = (dragStartLevel - dy / max(height, 1)).coerceIn(0f, 1f)
                val percent = (level * 100).toInt()
                if (dragAxis == DragAxis.BRIGHTNESS) {
                    applyBrightness(level)
                    showHint("亮度 $percent%")
                } else {
                    // 存字段再下发：换档重建播放器时要把音量带过去（见 [buildPlayer]）
                    volumeLevel = level
                    player.volume = level
                    showHint("音量 $percent%")
                }
            }

            DragAxis.NONE -> {}
        }
    }

    private fun finishDrag(ev: MotionEvent) {
        if (dragAxis == DragAxis.HORIZONTAL) {
            endScrub(seekBar.progress.toLong())
            if (!playbackStarted) {
                // 静态位横滑 = 翻页（与图片那条 25% 屏宽同口径；快滑另有 onFling 兜住）
                val dx = ev.x - dragStartX
                if (abs(dx) > width * PAGE_DRAG_RATIO) onPageRequest?.invoke(if (dx < 0) 1 else -1)
            }
        }
        dragAxis = DragAxis.NONE
        // onFling 在抬手前就把 dragAxis 抹成 NONE，上面那条收尾走不到；不兜住 userDragging
        // 会留在 true，而 ticker 在它为非真时整段跳过——下一条起播后进度条再也不动
        if (userDragging) endScrub(null)
        mainHandler.removeCallbacks(hideHint)
        mainHandler.postDelayed(hideHint, HINT_HIDE_MS)
    }

    /** 多指一出现就把单指判定撤掉：待执行的 seek 撤掉，已 seek 过去的位置不回滚
     *  （与亮度/音量那条同一口径），但「拖之前在播」要还回去。 */
    private fun cancelDrag() {
        if (dragAxis == DragAxis.HORIZONTAL) endScrub(null)
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

    /**
     * 点一下换一档。与循环那颗同一口径：**档位跨页保留**（换到下一条视频仍是这个倍速），
     * 不跟着 bind 归 1——两条都是「用户按过一次就该记住」的档，不是每条片子自己的属性。
     *
     * 公开：竖屏时本层的这两颗钮收进宿主「更多」菜单，菜单行直接调这里（[speedLabel] 给行标题）。
     */
    fun cycleSpeed() {
        speedIdx = (speedIdx + 1) % SPEEDS.size
        applySpeed()
        showHint("倍速 ${SPEEDS[speedIdx].second}")
    }

    /** 单参 [PlaybackParameters] 的 pitch 固定 1.0（查 media3 1.4.1 字节码确认），2x 不会把声音变尖。 */
    private fun applySpeed() {
        val (speed, label) = SPEEDS[speedIdx]
        speedChip.text = label
        player.playbackParameters = PlaybackParameters(speed)
        Log.d(TAG, "倍速 -> $label (started=$playbackStarted)")
        refreshSpeedTint()
    }

    /** 1x 随 chrome 墨色，其余档染主色——钮面只有数字，不染色看不出当前不是原速。 */
    private fun refreshSpeedTint() {
        speedChip.setTextColor(if (SPEEDS[speedIdx].first == 1f) inkColor else accentColor)
    }

    /** 当前倍速档文字：宿主把这一档挪进「更多」菜单时给行标题（行首图标固定，值在文字里）。 */
    fun speedLabel(): String = SPEEDS[speedIdx].second

    /** 当前画面档的文字与图标：同上，图标沿用播控条那颗的图形，菜单行跟着档位变。 */
    fun surfaceModeLabel(): String = surfaceMode.label
    fun surfaceModeIcon(): Int = surfaceMode.iconRes

    fun cycleSurfaceMode() {
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
        // 拖拽状态必须一起归零：`detach()`（换页/关闭/进幻灯片）走的就是这里，不归零就会
        // 把上一条那条待执行的 seek 拖到新的一条上（实施方案 §4.3）
        resetScrub()
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
     * 拖拽中也不算：`onIsPlayingChanged(false)` 会因为暂停把工具栏叫回来，那时不能让
     * 收起计时在用户还按着进度条的时候生效（实施方案 §4.1 坑 3）。
     */
    private val wantsToWatch: Boolean
        get() = playbackStarted && player.playWhenReady && !userDragging &&
            player.playbackState != Player.STATE_ENDED

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

    /**
     * 缓冲转圈的显隐。**拖拽期间不显示**：每一发 seek 落到未缓冲处都会进一次 `STATE_BUFFERING`，
     * 转圈就在手指底下一遍遍出现又消失，看着像"越拖越卡"。桌面那条早就改成
     * 「拖拽中不显示、用时间文字代替」（设计方案 §14.7 ③），安卓一直漏了，所以两端不一致。
     *
     * 松手时 [endScrub] 会再调一次，真需要等的缓冲照样转得出来——这里只是不在用户正拖的时候吵他。
     */
    private fun refreshBufferingBar() {
        bufferingBar.visibility =
            if (playbackStarted && !userDragging && player.playbackState == Player.STATE_BUFFERING) {
                VISIBLE
            } else {
                GONE
            }
    }

    /** 单一出口：所有状态变化之后都走这里把显隐与底色落定。 */
    private fun refreshLayerState() {
        val bound = boundFileId != null
        visibility = if (bound && !drawerOccluded) VISIBLE else GONE
        refreshBufferingBar()
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
        refreshSpeedTint()
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
