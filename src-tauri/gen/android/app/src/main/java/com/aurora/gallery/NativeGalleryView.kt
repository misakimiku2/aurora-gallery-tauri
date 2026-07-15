package com.aurora.gallery

import android.app.AlertDialog
import android.app.Dialog
import android.content.Context
import android.graphics.Color
import android.graphics.drawable.Drawable
import android.text.method.ScrollingMovementMethod
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.text.InputType
import android.util.Log
import android.view.HapticFeedbackConstants
import android.view.KeyEvent
import android.view.LayoutInflater
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.ViewPropertyAnimator
import android.view.animation.AccelerateDecelerateInterpolator
import android.view.animation.PathInterpolator
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.GridLayout
import android.widget.ImageButton
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import coil.ImageLoader
import coil.decode.GifDecoder
import coil.decode.ImageDecoderDecoder
import coil.disk.DiskCache
import coil.memory.MemoryCache
import coil.request.ImageRequest
import coil.size.Precision
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.abs

/**
 * 全屏原生图片查看器。覆盖在 WebView 之上，使用 Coil 加载图片，绕开 WebView 渲染管线。
 *
 * 调用方通过 [open] 传入图片列表和起始索引；通过 [navigate] 切换；通过 [close] 关闭。
 * 事件通过 [Listener] 回调到 MainActivity，再通过 evaluateJavascript 通知 WebView。
 *
 * 切换动画：旧图滑出 + 新图滑入同时进行，150ms。
 * 加载策略：先加载 256px 缩略图（如果提供），原图就绪后渐变替换。
 */
class NativeGalleryView @JvmOverloads constructor(
    context: Context,
) : FrameLayout(context) {

    interface Listener {
        /** 用户点击了关闭按钮。 */
        fun onClose()
        /** 当前图片索引变化（用户操作或幻灯片）。 */
        fun onNavigate(index: Int)
        /** 用户点击了"更多"按钮，需要切换回 WebView 模式查看高级功能。 */
        fun onMore(fileId: String)
        /** 用户点击了删除按钮。 */
        fun onDelete(fileId: String)
        /** 用户点击了"在文件夹中显示"。 */
        fun onShowInFolder(fileId: String)
        /** 用户点击了"复制到文件夹"。 */
        fun onCopyToFolder(fileId: String)
        /** 用户点击了"移动到文件夹"。 */
        fun onMoveToFolder(fileId: String)
        /** 用户点击了"AI 分析"。 */
        fun onAIAnalyze(fileId: String)
        /** 用户点击了"编辑标签"。 */
        fun onEditTags(fileId: String)
        /** 用户长按图片。 */
        fun onLongPress(fileId: String)
        /** 用户切换了沉浸模式。immersive=true 表示进入沉浸，false 表示退出。 */
        fun onImmersiveToggle(immersive: Boolean)
        /** 用户在原生层编辑了文件元数据（tags/description 等），JSON 字符串形如 {"tags":[...]} */
        fun onUpdateFile(fileId: String, updatesJson: String)
        /** 用户点击了抽屉里的调色板色块，请求按该颜色搜索。colorHex 形如 "#RRGGBB"。 */
        fun onColorSearch(colorHex: String)
        /** 用户点击了"提取主色调"按钮，请求对该图片提取主色调。 */
        fun onExtractPalette(fileId: String, filePath: String)
    }

    data class ImageItem(
        val path: String,        // 本地：文件路径；LAN：完整 HTTP URL
        val fileId: String,
        val name: String,
        val width: Int,
        val height: Int,
        val isLan: Boolean,
        val thumbnailUrl: String?, // LAN 缩略图 URL 或本地缩略图路径
        // 元数据（用于抽屉展示）
        val size: Long = 0,
        val format: String = "",
        val createdAt: String = "",
        val updatedAt: String = "",
        val tags: List<String> = emptyList(),
        val description: String = "",
        val sourceUrl: String = "",
        val palette: List<String> = emptyList(),
        val aiTags: List<String> = emptyList(),
        val aiDescription: String = "",
        val aiSceneCategory: String = "",
        val aiObjects: List<String> = emptyList(),
        val parentName: String = "",
    )

    private val mainHandler = Handler(Looper.getMainLooper())

    private val imageLoader: ImageLoader by lazy {
        ImageLoader.Builder(context)
            .memoryCache {
                MemoryCache.Builder(context).maxSizePercent(0.30).build()
            }
            .diskCache {
                DiskCache.Builder()
                    .directory(File(context.cacheDir, "coil_viewer_cache"))
                    .maxSizeBytes(200L * 1024 * 1024)
                    .build()
            }
            .crossfade(false)
            .precision(Precision.INEXACT)
            .components {
                // API 28+: ImageDecoderDecoder 支持 animated WebP + animated GIF（硬件解码）
                // API < 28: GifDecoder 仅支持 animated GIF（软件解码，无 animated WebP 支持）
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                    add(ImageDecoderDecoder.Factory())
                } else {
                    add(GifDecoder.Factory())
                }
            }
            .build()
    }

    private val images = mutableListOf<ImageItem>()
    private var currentIndex = 0
    private var isAnimating = AtomicBoolean(false)
    private var isImmersive = false
    private var isSlideshowActive = false
    private var slideshowIntervalMs = 5000L
    private var slideshowTransition = "fade"
    private var rotationDegrees = 0
    // 主题：true=深色，false=浅色
    private var isDarkTheme = true
    // 查看器是否打开（open 时设 true，close 时设 false）
    private var isOpen = false

    // 主题颜色（与 WebView 一致）
    // 注意：tailwind.config.js 中 gray 色板已被 colors.neutral 覆盖，新增组件必须使用 neutral 值，不可用 Tailwind 默认 gray 值
    // neutral 色板映射：50=#FAFAFA 100=#F5F5F5 200=#E5E5E5 400=#A3A3A3 500=#737373 700=#404040 800=#262626 900=#171717
    // 自定义扩展：750=#333333 850=#1E1E1E 950=#0A0A0A
    private fun colorBg() = if (isDarkTheme) Color.parseColor("#171717") else Color.parseColor("#E5E5E5")
    private fun colorPanel() = if (isDarkTheme) Color.parseColor("#171717") else Color.parseColor("#FFFFFF")
    private fun colorBorder() = if (isDarkTheme) Color.parseColor("#262626") else Color.parseColor("#E5E7EB")
    private fun colorTextPrimary() = if (isDarkTheme) Color.parseColor("#F3F4F6") else Color.parseColor("#262626")
    private fun colorTextSecondary() = if (isDarkTheme) Color.parseColor("#9CA3AF") else Color.parseColor("#6B7280")
    private fun colorAccent() = Color.parseColor("#3B82F6")
    private fun colorTagBg() = if (isDarkTheme) Color.parseColor("#1E3A8A33") else Color.parseColor("#EFF6FF")
    private fun colorTagText() = if (isDarkTheme) Color.parseColor("#93C5FD") else Color.parseColor("#2563EB")
    private fun colorTagBorder() = if (isDarkTheme) Color.parseColor("#1E40AF55") else Color.parseColor("#DBEAFE")
    private fun colorTextBoxBg() = if (isDarkTheme) Color.parseColor("#262626") else Color.parseColor("#F9FAFB")
    private fun colorDialogBg() = if (isDarkTheme) Color.parseColor("#1E1E1E") else Color.parseColor("#FFFFFF")
    private fun colorButtonSecondaryBg() = if (isDarkTheme) Color.parseColor("#404040") else Color.parseColor("#E5E7EB")
    private fun colorButtonSecondaryText() = if (isDarkTheme) Color.parseColor("#A3A3A3") else Color.parseColor("#404040")
    // 提示文本颜色（比次文字更淡，纯色无透明度）
    private fun colorHint() = if (isDarkTheme) Color.parseColor("#6B7280") else Color.parseColor("#9CA3AF")

    var listener: Listener? = null

    // UI 引用
    private val primaryView: ZoomableImageView
    private val secondaryView: ZoomableImageView // 用于切换动画时的另一张
    private val progressBar: ProgressBar
    private val topBar: LinearLayout
    lateinit private var titleView: TextView
    private val bottomInfo: LinearLayout
    private val bottomInfoText: TextView
    private val thumbnailStrip: RecyclerView
    private val thumbnailAdapter: ThumbnailStripAdapter
    // 抽屉引用
    private val metadataDrawer: LinearLayout
    private val drawerScrollView: ScrollView
    private val drawerContainer: LinearLayout
    private val drawerPreviewImage: android.widget.ImageView
    private val drawerNameView: TextView
    private val drawerFolderView: TextView
    private val drawerPaletteLayout: LinearLayout
    private val drawerDetailsGrid: GridLayout
    private val drawerTagsLayout: LinearLayout
    private val drawerDescView: TextView
    private val drawerSourceUrlView: TextView
    private var drawerOpen = false
    /** 正在提取主色调的 fileId，非 null 时抽屉显示 loading 占位 */
    private var loadingPaletteFileId: String? = null
    /** 用户设置：浏览时自动提取主色调。开启时 palette 为空显示 loading 而非按钮 */
    private var autoExtractPalette = false
    /** 自动提取失败的 fileId 集合，失败后显示"提取主色调"按钮供用户手动重试 */
    private val failedPaletteFileIds = mutableSetOf<String>()
    /** 抽屉宽度动画，close() 时取消防止残留更新 */
    private var drawerWidthAnimator: android.animation.ValueAnimator? = null
    /** 垂直跟手开始时抽屉是否打开 */
    private var drawerDragStartOpen = false
    /** 垂直跟手开始时的抽屉进度（0=关闭, 1=打开） */
    private var drawerDragStartProgress = 0f
    /** 抽屉打开前的沉浸状态，抽屉关闭时恢复（确保沉浸模式下开关抽屉仍回到沉浸） */
    private var immersiveBeforeDrawer = false
    /** 翻页拖动中，邻接视图（上一张/下一张）是否已加载并可见 */
    private var swipeAdjacentPrepared = false
    /** 邻接视图方向：-1 = 上一张（左侧），1 = 下一张（右侧） */
    private var swipeAdjacentDirection = 0
    /** 滑动期间缓存的屏幕宽度，避免每帧调用 width.toFloat() */
    private var swipeCachedWidth = 0f
    /** 滑动期间缓存的邻接视图引用，避免每帧调用 adjacentView() */
    private var swipeCachedAdjacentView: ZoomableImageView? = null

    private var activeView: ZoomableImageView
        get() = if (primaryView.tag == "active") primaryView else secondaryView
        set(value) {
            primaryView.tag = if (value === primaryView) "active" else "idle"
            secondaryView.tag = if (value === secondaryView) "active" else "idle"
        }

    /** 获取非活跃视图（用于翻页拖动时显示邻接图） */
    private fun adjacentView(): ZoomableImageView = if (primaryView.tag == "active") secondaryView else primaryView

    init {
        setBackgroundColor(colorBg())
        // 允许窗口获取焦点以接收按键事件（返回键收起抽屉/关闭查看器）
        isFocusable = true
        isFocusableInTouchMode = true

        // 主图层（双 buffer，用于切换动画）
        primaryView = ZoomableImageView(context).apply {
            layoutParams = LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT)
            scaleType = android.widget.ImageView.ScaleType.MATRIX
            visibility = VISIBLE
            tag = "active"
        }
        secondaryView = ZoomableImageView(context).apply {
            layoutParams = LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT)
            scaleType = android.widget.ImageView.ScaleType.MATRIX
            visibility = GONE
            tag = "idle"
        }
        addView(primaryView)
        addView(secondaryView)

        // 进度条
        progressBar = ProgressBar(context, null, android.R.attr.progressBarStyleLarge).apply {
            layoutParams = LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT).apply {
                gravity = android.view.Gravity.CENTER
            }
            visibility = GONE
            indeterminateTintList = android.content.res.ColorStateList.valueOf(Color.WHITE)
        }
        addView(progressBar)

        // 顶栏
        topBar = buildTopBar()
        addView(topBar)

        // 底部信息栏
        bottomInfo = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply {
                gravity = android.view.Gravity.BOTTOM
            }
            setBackgroundColor(if (isDarkTheme) Color.parseColor("#CC171717") else Color.parseColor("#CCE5E5E5"))
            setPadding(32, 24, 32, 32)
            visibility = GONE
        }
        bottomInfoText = TextView(context).apply {
            setTextColor(colorTextPrimary())
            textSize = 13f
        }
        bottomInfo.addView(bottomInfoText)
        addView(bottomInfo)

        // 缩略图条
        thumbnailAdapter = ThumbnailStripAdapter(context, imageLoader) { index ->
            if (index != currentIndex && !isAnimating.get()) {
                val direction = if (index > currentIndex) 1 else -1
                val steps = abs(index - currentIndex)
                repeat(steps) {
                    navigate(direction, animate = false)
                }
            }
        }
        thumbnailStrip = RecyclerView(context).apply {
            layoutParams = LayoutParams(LayoutParams.MATCH_PARENT, (resources.displayMetrics.density * 96).toInt()).apply {
                gravity = android.view.Gravity.BOTTOM
            }
            layoutManager = LinearLayoutManager(context, LinearLayoutManager.HORIZONTAL, false)
            adapter = thumbnailAdapter
            setBackgroundColor(if (isDarkTheme) Color.parseColor("#E6171717") else Color.parseColor("#E6E5E5E5"))
            setPadding(24, 12, 24, 12)
            visibility = GONE
        }
        addView(thumbnailStrip)

        // 右侧元数据抽屉（宽度 20rem = 320dp，对齐 MetadataPanel）
        val drawerWidthPx = (resources.displayMetrics.density * 320).toInt()
        metadataDrawer = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = LayoutParams(drawerWidthPx, LayoutParams.MATCH_PARENT).apply {
                gravity = android.view.Gravity.END or android.view.Gravity.TOP
            }
            setBackgroundColor(colorPanel())
            // 左边框分隔线
            background = android.graphics.drawable.GradientDrawable().apply {
                orientation = android.graphics.drawable.GradientDrawable.Orientation.LEFT_RIGHT
                setColors(intArrayOf(colorBorder(), colorPanel()))
            }
            setPadding((resources.displayMetrics.density * 16).toInt(), (resources.displayMetrics.density * 16).toInt(), (resources.displayMetrics.density * 16).toInt(), (resources.displayMetrics.density * 16).toInt())
            translationX = drawerWidthPx.toFloat() // 初始屏幕外
            // 消费触摸事件，防止穿透到下层 ZoomableImageView
            isClickable = true
            isFocusable = true
        }
        drawerScrollView = ScrollView(context).apply {
            layoutParams = LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, 0).apply {
                weight = 1f
            }
            isClickable = true
            // 隐藏滚动条
            isVerticalScrollBarEnabled = false
            isHorizontalScrollBarEnabled = false
        }
        drawerContainer = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            isClickable = true
        }
        drawerScrollView.addView(drawerContainer)
        metadataDrawer.addView(drawerScrollView)

        // Section 1: 文件名（大号、加粗）
        drawerNameView = TextView(context).apply {
            setTextColor(colorTextPrimary())
            textSize = 20f
            paint.isFakeBoldText = true
            setPadding(0, 0, 0, 4)
            text = "—"
        }
        drawerContainer.addView(drawerNameView)

        // Section 2: 文件夹名（小号、次要色）
        drawerFolderView = TextView(context).apply {
            setTextColor(colorTextSecondary())
            textSize = 12f
            setPadding(0, 0, 0, 16)
            text = "—"
        }
        drawerContainer.addView(drawerFolderView)

        // Section 3: 全览图（圆角、固定高度）
        drawerPreviewImage = android.widget.ImageView(context).apply {
            layoutParams = LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, (resources.displayMetrics.density * 180).toInt()).apply {
                bottomMargin = (resources.displayMetrics.density * 16).toInt()
            }
            scaleType = android.widget.ImageView.ScaleType.FIT_CENTER
            setBackgroundColor(if (isDarkTheme) Color.parseColor("#262626") else Color.parseColor("#F3F4F6"))
            clipToOutline = true
            outlineProvider = object : android.view.ViewOutlineProvider() {
                override fun getOutline(view: View, outline: android.graphics.Outline) {
                    val r = resources.displayMetrics.density * 12
                    outline.setRoundRect(0, 0, view.width, view.height, r)
                }
            }
        }
        drawerContainer.addView(drawerPreviewImage)

        // Section 4: 主色调（标题 + 圆形色块横排，单行显示，缩到 20dp 适配 8 个）
        drawerContainer.addView(buildSectionTitle("主色调", iconRes = R.drawable.ic_lucide_palette))
        drawerPaletteLayout = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = android.view.Gravity.CENTER
            layoutParams = LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply {
                bottomMargin = (resources.displayMetrics.density * 16).toInt()
            }
        }
        drawerContainer.addView(drawerPaletteLayout)

        // Section 5: 文件信息
        drawerContainer.addView(buildSectionTitle("文件信息", iconRes = R.drawable.ic_lucide_info))
        drawerDetailsGrid = GridLayout(context).apply {
            layoutParams = LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply {
                bottomMargin = (resources.displayMetrics.density * 16).toInt()
            }
            columnCount = 2
            useDefaultMargins = true
        }
        drawerContainer.addView(drawerDetailsGrid)

        // Section 6: 标签（胶囊形状）
        drawerContainer.addView(buildSectionTitle("标签", iconRes = R.drawable.ic_lucide_tag))
        drawerTagsLayout = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply {
                bottomMargin = (resources.displayMetrics.density * 16).toInt()
            }
        }
        drawerContainer.addView(drawerTagsLayout)

        // Section 7: 描述文本框（点击可编辑）
        drawerContainer.addView(buildSectionTitle("描述", iconRes = R.drawable.ic_lucide_file_text))
        drawerDescView = TextView(context).apply {
            setTextColor(colorTextPrimary())
            setHintTextColor(colorHint())
            textSize = 13f
            setPadding((resources.displayMetrics.density * 12).toInt(), (resources.displayMetrics.density * 12).toInt(), (resources.displayMetrics.density * 12).toInt(), (resources.displayMetrics.density * 12).toInt())
            // 斜体 hint（占位提示），正文不斜体
            val hintSpan = android.text.SpannableString("添加描述...")
            hintSpan.setSpan(
                android.text.style.StyleSpan(android.graphics.Typeface.ITALIC),
                0, hintSpan.length,
                android.text.Spanned.SPAN_EXCLUSIVE_EXCLUSIVE
            )
            setHint(hintSpan)
            minimumHeight = (resources.displayMetrics.density * 80).toInt()
            background = android.graphics.drawable.GradientDrawable().apply {
                cornerRadius = resources.displayMetrics.density * 8
                setColor(colorTextBoxBg())
                setStroke((resources.displayMetrics.density * 1).toInt(), colorBorder())
            }
            movementMethod = ScrollingMovementMethod()
            setLineSpacing(0f, 1.4f)
            isClickable = true
            setOnClickListener { showDescriptionEditDialog() }
            layoutParams = LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply {
                bottomMargin = (resources.displayMetrics.density * 16).toInt()
            }
        }
        drawerContainer.addView(drawerDescView)

        // Section 8: 来源网址（点击可编辑）
        drawerContainer.addView(buildSectionTitle("来源网址", iconRes = R.drawable.ic_lucide_globe))
        drawerSourceUrlView = TextView(context).apply {
            setTextColor(colorAccent())
            setHintTextColor(colorHint())
            textSize = 13f
            setPadding((resources.displayMetrics.density * 12).toInt(), (resources.displayMetrics.density * 12).toInt(), (resources.displayMetrics.density * 12).toInt(), (resources.displayMetrics.density * 12).toInt())
            // 斜体 hint（占位提示）
            val hintSpan = android.text.SpannableString("https://...")
            hintSpan.setSpan(
                android.text.style.StyleSpan(android.graphics.Typeface.ITALIC),
                0, hintSpan.length,
                android.text.Spanned.SPAN_EXCLUSIVE_EXCLUSIVE
            )
            setHint(hintSpan)
            minimumHeight = (resources.displayMetrics.density * 44).toInt()
            background = android.graphics.drawable.GradientDrawable().apply {
                cornerRadius = resources.displayMetrics.density * 8
                setColor(colorTextBoxBg())
                setStroke((resources.displayMetrics.density * 1).toInt(), colorBorder())
            }
            setSingleLine(true)
            ellipsize = android.text.TextUtils.TruncateAt.END
            isClickable = true
            setOnClickListener { showSourceUrlEditDialog() }
            layoutParams = LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply {
                bottomMargin = (resources.displayMetrics.density * 16).toInt()
            }
        }
        drawerContainer.addView(drawerSourceUrlView)

        addView(metadataDrawer)

        setupZoomableListeners(primaryView)
        setupZoomableListeners(secondaryView)
    }

    private fun buildTopBar(): LinearLayout {
        // 状态栏高度
        val statusBarHeight = run {
            val resId = resources.getIdentifier("status_bar_height", "dimen", "android")
            if (resId > 0) resources.getDimensionPixelSize(resId) else 0
        }
        return LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            layoutParams = LayoutParams(LayoutParams.MATCH_PARENT, (resources.displayMetrics.density * 56).toInt() + statusBarHeight).apply {
                gravity = android.view.Gravity.TOP
            }
            setBackgroundColor(if (isDarkTheme) Color.parseColor("#CC171717") else Color.parseColor("#CCE5E5E5"))
            setPadding(24, statusBarHeight, 24, 0)
            gravity = android.view.Gravity.CENTER_VERTICAL

            val closeBtn = makeImageButton("✕") { listener?.onClose() }
            titleView = TextView(context).apply {
                setTextColor(colorTextPrimary())
                textSize = 14f
                gravity = android.view.Gravity.CENTER
                layoutParams = LinearLayout.LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f)
                maxLines = 1
                ellipsize = android.text.TextUtils.TruncateAt.MIDDLE
                setPadding(24, 0, 24, 0)
            }
            val rotateBtn = makeImageButton("⟳") { rotateCurrent() }
            val infoBtn = makeImageButton("ⓘ") { toggleDrawer() }
            val moreBtn = makeImageButton("⋮") { showMoreMenu() }

            addView(closeBtn)
            addView(titleView)
            addView(rotateBtn)
            addView(infoBtn)
            addView(moreBtn)
        }
    }

    private fun makeImageButton(text: String, onClick: () -> Unit): TextView {
        return TextView(context).apply {
            this.text = text
            setTextColor(colorTextPrimary())
            textSize = 24f
            setPadding(20, 20, 20, 20)
            layoutParams = LinearLayout.LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT)
            setOnClickListener { onClick() }
        }
    }

    private fun buildSectionTitle(title: String, weight: Float = 0f, iconRes: Int? = null): TextView {
        val density = resources.displayMetrics.density
        return TextView(context).apply {
            text = title
            setTextColor(colorTextSecondary())
            textSize = 11f
            paint.isFakeBoldText = true
            if (iconRes != null) {
                val drawable = context.getDrawable(iconRes)
                drawable?.setTint(colorTextSecondary())
                val iconSize = (density * 12).toInt()
                drawable?.setBounds(0, 0, iconSize, iconSize)
                setCompoundDrawablesRelative(drawable, null, null, null)
                compoundDrawablePadding = (density * 6).toInt()
            }
            setPadding(0, (density * 16).toInt(), 0, (density * 8).toInt())
            layoutParams = LinearLayout.LayoutParams(0, LayoutParams.WRAP_CONTENT, weight).apply {
                if (weight == 0f) width = LayoutParams.MATCH_PARENT
            }
        }
    }

    private fun makeTextButton(text: String, onClick: () -> Unit): TextView {
        return TextView(context).apply {
            this.text = text
            setTextColor(colorAccent())
            textSize = 12f
            setPadding((resources.displayMetrics.density * 12).toInt(), (resources.displayMetrics.density * 8).toInt(), 0, (resources.displayMetrics.density * 8).toInt())
            setOnClickListener { onClick() }
        }
    }

    /**
     * 根据 progress（0=关闭, 1=打开）应用抽屉视觉状态。
     * progress 驱动：抽屉位移、图片宽度、填充缩放、topBar/缩略图条/底部信息同步隐藏（全屏样式）。
     */
    private fun applyDrawerProgress(progress: Float) {
        val drawerWidthPx = (resources.displayMetrics.density * 320)
        val totalWidth = width.toFloat()
        val imageW = (totalWidth - progress * drawerWidthPx).toInt().coerceAtLeast(0)

        // 抽屉位移
        metadataDrawer.translationX = (1f - progress) * drawerWidthPx
        // 图片宽度 + 填充进度（在 layoutParams 之前设置，确保 onSizeChanged→resetToCenter 读到最新值）
        primaryView.drawerFillProgress = progress
        secondaryView.drawerFillProgress = progress
        // 抽屉展开时禁止图片缩放（双击/双指），避免缩放与 drawerFillProgress 填充逻辑冲突
        val allowZoom = progress <= 0.01f
        primaryView.allowZoom = allowZoom
        secondaryView.allowZoom = allowZoom
        // 设置全屏宽度基准，供 resetToCenter 计算 fitS（固定），避免 vw 减小时 fitS 先降后升
        primaryView.drawerFullWidth = totalWidth
        secondaryView.drawerFullWidth = totalWidth
        primaryView.layoutParams = LayoutParams(imageW, LayoutParams.MATCH_PARENT)
        secondaryView.layoutParams = LayoutParams(imageW, LayoutParams.MATCH_PARENT)
        // topBar 向上滑出（沉浸模式下始终保持隐藏，不受抽屉进度影响）
        if (topBar.height > 0) {
            topBar.translationY = if (isImmersive) -topBar.height.toFloat() else -topBar.height * progress
        }
        // 缩略图条向下滑出（沉浸模式下始终保持隐藏）
        if (thumbnailStrip.height > 0) {
            thumbnailStrip.translationY = if (isImmersive) height.toFloat() else thumbnailStrip.height.toFloat() * progress
        }
        // 底部信息向下滑出（沉浸模式下始终保持隐藏）
        if (bottomInfo.visibility == VISIBLE && bottomInfo.height > 0) {
            bottomInfo.translationY = if (isImmersive) height.toFloat() else bottomInfo.height.toFloat() * progress
        }
    }

    /**
     * 动画抽屉到目标状态。[open] 目标状态，[fromProgress] 起始进度（用于跟手松手后从当前位置动画）。
     */
    private fun animateDrawerTo(open: Boolean, fromProgress: Float) {
        val targetProgress = if (open) 1f else 0f
        val drawerWidthPx = (resources.displayMetrics.density * 320)
        val totalWidth = width.toFloat()
        val duration = 280L

        drawerWidthAnimator?.cancel()
        val animator = android.animation.ValueAnimator.ofFloat(fromProgress, targetProgress)
        drawerWidthAnimator = animator
        animator.duration = duration
        animator.interpolator = AccelerateDecelerateInterpolator()
        animator.addUpdateListener { anim ->
            applyDrawerProgress(anim.animatedValue as Float)
        }
        var cancelled = false
        animator.addListener(object : android.animation.AnimatorListenerAdapter() {
            override fun onAnimationCancel(animation: android.animation.Animator) {
                cancelled = true
            }
            override fun onAnimationEnd(animation: android.animation.Animator) {
                drawerWidthAnimator = null
                if (cancelled) return
                // 精确设置最终状态
                applyDrawerProgress(targetProgress)
                val finalW = if (open) (totalWidth - drawerWidthPx).toInt().coerceAtLeast(0) else LayoutParams.MATCH_PARENT
                primaryView.layoutParams = LayoutParams(finalW, LayoutParams.MATCH_PARENT)
                secondaryView.layoutParams = LayoutParams(finalW, LayoutParams.MATCH_PARENT)
                if (open) {
                    // 抽屉打开：隐藏系统状态栏，但不改变 isImmersive（保留单次点击的沉浸状态）
                    listener?.onImmersiveToggle(true)
                } else {
                    // 抽屉关闭：恢复抽屉打开前的沉浸状态
                    isImmersive = immersiveBeforeDrawer
                    listener?.onImmersiveToggle(immersiveBeforeDrawer)
                    // 还原背景色：若之前在沉浸模式则保持黑色，否则还原主题色
                    setBackgroundColor(if (immersiveBeforeDrawer) Color.BLACK else colorBg())
                }
            }
        })
        animator.start()
    }

    private fun toggleDrawer() {
        if (!drawerOpen) {
            // 即将打开抽屉——保存当前沉浸状态，关闭时恢复
            immersiveBeforeDrawer = isImmersive
        }
        drawerOpen = !drawerOpen
        val currentProgress = primaryView.drawerFillProgress
        animateDrawerTo(drawerOpen, fromProgress = currentProgress)
    }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val w = MeasureSpec.getSize(widthMeasureSpec)
        val h = MeasureSpec.getSize(heightMeasureSpec)
        // 抽屉打开时旋转屏幕：onSizeChanged 在 layout 之后被调用，此时设置子 View
        // layoutParams 不会在当前 pass 生效（子 View 已用旧 layoutParams 完成测量），
        // 导致连续旋转时 layoutParams 永远落后一帧（log 证实：portrait 设 1072 但实测
        // 2120，下一次 landscape 才测得 1072）。在 onMeasure 中提前设置，确保子 View
        // 在本次测量就用正确宽度。width>0 且 w!=width 表示尺寸真正变化（旋转），
        // 避免动画期间的 requestLayout 触发的 onMeasure 覆盖动画中间值。
        if (w > 0 && h > 0 && drawerOpen && width > 0 && w != width) {
            drawerWidthAnimator?.cancel()
            val drawerWidthPx = (resources.displayMetrics.density * 320).toInt()
            val imageW = (w - drawerWidthPx).coerceAtLeast(0)
            primaryView.layoutParams = LayoutParams(imageW, LayoutParams.MATCH_PARENT)
            secondaryView.layoutParams = LayoutParams(imageW, LayoutParams.MATCH_PARENT)
        }
        super.onMeasure(widthMeasureSpec, heightMeasureSpec)
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        if (w <= 0 || h <= 0) return
        if (!drawerOpen) return
        drawerWidthAnimator?.cancel()
        if (topBar.height > 0) {
            topBar.translationY = -topBar.height.toFloat()
        }
    }

    /**
     * 旋转屏幕时由 MainActivity.onConfigurationChanged 调用。
     * TYPE_APPLICATION_PANEL 窗口在 Activity 处理 configChanges 时可能不会自动 resize，
     * 需要由 Activity 主动调用 updateViewLayout 强制窗口适配新屏幕尺寸，
     * 随后 onSizeChanged 会被触发，内部完成 primaryView 宽度更新。
     */
    fun handleRotation() {
        // 如果抽屉关闭，primaryView 是 MATCH_PARENT，会自动适配；无需处理
        // 如果抽屉打开，等待 onSizeChanged 触发后由其处理 layoutParams 更新
    }

    private fun buildDetailCell(label: String, value: String, iconRes: Int? = null): LinearLayout {
        val density = resources.displayMetrics.density
        return LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = GridLayout.LayoutParams().apply {
                width = 0
                height = LayoutParams.WRAP_CONTENT
                columnSpec = GridLayout.spec(GridLayout.UNDEFINED, 1, 1f)
            }
            setPadding(0, 0, (density * 12).toInt(), (density * 8).toInt())
            addView(TextView(context).apply {
                text = label
                setTextColor(colorTextSecondary())
                textSize = 10f
                if (iconRes != null) {
                    val drawable = context.getDrawable(iconRes)
                    drawable?.setTint(colorTextSecondary())
                    val iconSize = (density * 10).toInt()
                    drawable?.setBounds(0, 0, iconSize, iconSize)
                    setCompoundDrawablesRelative(drawable, null, null, null)
                    compoundDrawablePadding = (density * 4).toInt()
                }
            })
            addView(TextView(context).apply {
                text = value
                setTextColor(colorTextPrimary())
                textSize = 12f
                maxLines = 2
                setPadding(0, 2, 0, 0)
            })
        }
    }

    private fun updateDrawer(item: ImageItem) {
        Log.i(TAG, "updateDrawer: fileId=${item.fileId}, paletteSize=${item.palette.size}, loadingPaletteFileId=$loadingPaletteFileId")
        // Section 1: 文件名
        drawerNameView.text = item.name

        // Section 2: 文件夹名
        drawerFolderView.text = item.parentName.ifEmpty { "—" }

        // Section 3: 全览图（用 Coil 加载缩略图或原图）
        val previewUrl = item.thumbnailUrl ?: item.path
        val req = ImageRequest.Builder(context)
            .data(if (item.isLan) previewUrl else File(item.path))
            .target(drawerPreviewImage)
            .precision(Precision.INEXACT)
            .build()
        imageLoader.enqueue(req)

        // Section 4: 主色调（圆形色块横排，单行，点击触发颜色搜索）
        // 显式取消子 view 的动画（AlphaAnimation INFINITE 不会随 removeAllViews 自动停止）
        for (i in 0 until drawerPaletteLayout.childCount) {
            drawerPaletteLayout.getChildAt(i).clearAnimation()
        }
        drawerPaletteLayout.removeAllViews()
        // 安全兜底：如果 item 有 palette 但 loadingPaletteFileId 仍指向它，清除 loading
        if (item.palette.isNotEmpty() && loadingPaletteFileId == item.fileId) {
            loadingPaletteFileId = null
        }
        // loading 条件：
        // 1. 手动点击按钮触发提取（loadingPaletteFileId 指向当前文件）
        // 2. 开启"浏览时自动提取主色调"且 palette 为空且未失败（自动提取即将/正在进行）
        val isLoadingPalette = loadingPaletteFileId == item.fileId ||
            (autoExtractPalette && item.palette.isEmpty() && !failedPaletteFileIds.contains(item.fileId))
        if (isLoadingPalette) {
            // 提取中：显示脉冲占位
            val colorSize = (resources.displayMetrics.density * 28).toInt()
            val colorGap = (resources.displayMetrics.density * 8).toInt()
            repeat(8) {
                drawerPaletteLayout.addView(View(context).apply {
                    layoutParams = LinearLayout.LayoutParams(colorSize, colorSize).apply {
                        marginEnd = colorGap
                    }
                    val drawable = android.graphics.drawable.GradientDrawable().apply {
                        shape = android.graphics.drawable.GradientDrawable.OVAL
                        // 使用与背景对比度更高的颜色，确保呼吸动画清晰可见
                        setColor(if (isDarkTheme) Color.parseColor("#404040") else Color.parseColor("#D4D4D4"))
                    }
                    background = drawable
                    val anim = android.view.animation.AlphaAnimation(0.2f, 0.9f).apply {
                        duration = 800
                        repeatMode = android.view.animation.Animation.REVERSE
                        repeatCount = android.view.animation.Animation.INFINITE
                    }
                    startAnimation(anim)
                })
            }
        } else if (item.palette.isEmpty()) {
            // 无主色调且未在提取中：
            // - 未开启"浏览时自动提取"→ 显示按钮供用户手动触发
            // - 开启了自动提取但失败了→ 显示按钮供用户手动重试
            val extractButton = TextView(context).apply {
                text = "提取主色调"
                setTextColor(colorTagText())
                textSize = 11f
                setPadding((resources.displayMetrics.density * 12).toInt(), (resources.displayMetrics.density * 6).toInt(), (resources.displayMetrics.density * 12).toInt(), (resources.displayMetrics.density * 6).toInt())
                background = createRoundedBg(colorTagBg(), 10f, colorTagBorder(), 1f)
                isClickable = true
                isFocusable = true
                setOnClickListener {
                    Log.i(TAG, "Extract palette clicked: ${item.fileId}")
                    loadingPaletteFileId = item.fileId
                    updateDrawer(item) // 立即显示 loading
                    listener?.onExtractPalette(item.fileId, item.path)
                }
            }
            drawerPaletteLayout.addView(extractButton)
        } else {
            val colorSize = (resources.displayMetrics.density * 28).toInt()
            val colorGap = (resources.displayMetrics.density * 8).toInt()
            item.palette.forEach { hex ->
                drawerPaletteLayout.addView(View(context).apply {
                    layoutParams = LinearLayout.LayoutParams(colorSize, colorSize).apply {
                        marginEnd = colorGap
                    }
                    val drawable = android.graphics.drawable.GradientDrawable().apply {
                        shape = android.graphics.drawable.GradientDrawable.OVAL
                        setColor(runCatching { Color.parseColor(hex) }.getOrDefault(Color.GRAY))
                        setStroke((resources.displayMetrics.density * 1).toInt(), if (isDarkTheme) Color.parseColor("#1FFFFFFF") else Color.parseColor("#10000000"))
                    }
                    background = drawable
                    isClickable = true
                    isFocusable = true
                    // 按下视觉反馈
                    val pressedScale = 1.15f
                    setOnTouchListener { v, event ->
                        when (event.action) {
                            android.view.MotionEvent.ACTION_DOWN -> {
                                v.animate().scaleX(pressedScale).scaleY(pressedScale).setDuration(100).start()
                                v.alpha = 0.8f
                            }
                            android.view.MotionEvent.ACTION_UP, android.view.MotionEvent.ACTION_CANCEL -> {
                                v.animate().scaleX(1f).scaleY(1f).setDuration(100).start()
                                v.alpha = 1f
                            }
                        }
                        false // 让 OnClickListener 继续处理点击
                    }
                    setOnClickListener {
                        Log.i(TAG, "Color chip clicked: $hex")
                        listener?.onColorSearch(hex)
                    }
                })
            }
        }

        // Section 5: 文件信息
        drawerDetailsGrid.removeAllViews()
        drawerDetailsGrid.addView(buildDetailCell("格式", item.format.uppercase().ifEmpty { "—" }, R.drawable.ic_lucide_file_text))
        drawerDetailsGrid.addView(buildDetailCell("大小", formatFileSize(item.size), R.drawable.ic_lucide_hard_drive))
        drawerDetailsGrid.addView(buildDetailCell("尺寸", if (item.width > 0 && item.height > 0) "${item.width}×${item.height}" else "—", R.drawable.ic_lucide_image))
        drawerDetailsGrid.addView(buildDetailCell("创建", formatDate(item.createdAt), R.drawable.ic_lucide_calendar))
        drawerDetailsGrid.addView(buildDetailCell("修改", formatDate(item.updatedAt), R.drawable.ic_lucide_clock))

        // Section 6: 标签（胶囊形状 + 编辑按钮）
        drawerTagsLayout.removeAllViews()
        val tagFlow = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            layoutParams = LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT)
        }
        item.tags.forEach { tag ->
            val chip = TextView(context).apply {
                text = tag
                setTextColor(colorTagText())
                textSize = 11f
                setPadding((resources.displayMetrics.density * 10).toInt(), (resources.displayMetrics.density * 6).toInt(), (resources.displayMetrics.density * 10).toInt(), (resources.displayMetrics.density * 6).toInt())
                val drawable = android.graphics.drawable.GradientDrawable().apply {
                    cornerRadius = resources.displayMetrics.density * 14
                    setColor(colorTagBg())
                    setStroke((resources.displayMetrics.density * 1).toInt(), colorTagBorder())
                }
                background = drawable
                layoutParams = LinearLayout.LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT).apply {
                    marginEnd = (resources.displayMetrics.density * 6).toInt()
                    bottomMargin = (resources.displayMetrics.density * 6).toInt()
                }
            }
            tagFlow.addView(chip)
        }
        // 编辑标签按钮（排列在标签后面，使用按钮样式与标签胶囊区分）
        val editTagButton = TextView(context).apply {
            text = "+ 编辑标签"
            setTextColor(colorButtonSecondaryText())
            textSize = 11f
            setPadding((resources.displayMetrics.density * 12).toInt(), (resources.displayMetrics.density * 6).toInt(), (resources.displayMetrics.density * 12).toInt(), (resources.displayMetrics.density * 6).toInt())
            background = createRoundedBg(colorButtonSecondaryBg(), 10f, colorBorder(), 1f)
            isClickable = true
            setOnClickListener { showTagEditDialog() }
            layoutParams = LinearLayout.LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT).apply {
                marginEnd = (resources.displayMetrics.density * 6).toInt()
                bottomMargin = (resources.displayMetrics.density * 6).toInt()
            }
        }
        tagFlow.addView(editTagButton)
        drawerTagsLayout.addView(tagFlow)

        // Section 7: 描述（空时显示 hint）
        drawerDescView.text = item.description

        // Section 8: 来源网址（空时显示 hint）
        drawerSourceUrlView.text = item.sourceUrl
    }

    private fun formatFileSize(bytes: Long): String {
        if (bytes <= 0) return "—"
        val kb = bytes / 1024.0
        if (kb < 1024) return String.format("%.1f KB", kb)
        val mb = kb / 1024.0
        if (mb < 1024) return String.format("%.1f MB", mb)
        return String.format("%.2f GB", mb / 1024.0)
    }

    private fun formatDate(iso: String): String {
        if (iso.isEmpty()) return "—"
        return runCatching {
            // 简单截取 YYYY-MM-DD 部分
            val idx = iso.indexOf('T')
            if (idx > 0) iso.substring(0, idx) else iso.substring(0, minOf(10, iso.length))
        }.getOrDefault(iso)
    }

    private fun setupZoomableListeners(view: ZoomableImageView) {
        view.swipeOutListener = object : ZoomableImageView.OnSwipeOutListener {
            override fun onSwipeOut(direction: Int, dx: Float) {}
            override fun onSwipeDrag(dx: Float) {
                if (isAnimating.get()) return
                if (dx == 0f) return
                val actView = activeView
                actView.translationX = dx
                val dir = if (dx > 0) -1 else 1
                val adjacentIndex = currentIndex + dir
                if (adjacentIndex < 0 || adjacentIndex >= images.size) return
                if (!swipeAdjacentPrepared || swipeAdjacentDirection != dir) {
                    prepareSwipeAdjacent(dir)
                }
                val adj = swipeCachedAdjacentView
                if (adj != null && swipeAdjacentPrepared && swipeAdjacentDirection == dir) {
                    adj.translationX = dx + dir * swipeCachedWidth
                }
            }
            override fun onSwipeEnd(dx: Float, velocityX: Float) {
                if (isAnimating.get()) return
                val threshold = resources.displayMetrics.density * SWIPE_THRESHOLD_DP
                val shouldNavigate = abs(dx) > threshold || (abs(velocityX) > SWIPE_VELOCITY_THRESHOLD && abs(dx) > touchSlopForSwipe)
                val dir = if (dx > 0) -1 else 1
                if (shouldNavigate && dx != 0f) {
                    val adjacentIndex = currentIndex + dir
                    if (swipeAdjacentPrepared && swipeAdjacentDirection == dir && adjacentIndex in 0 until images.size) {
                        performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY)
                        navigateFromSwipe(dir)
                    } else if (adjacentIndex in 0 until images.size) {
                        performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY)
                        cleanupSwipeAdjacentImmediate()
                        navigate(dir)
                    } else {
                        bounceBackSwipe(dir)
                    }
                } else {
                    if (swipeAdjacentPrepared) {
                        bounceBackSwipe(dir)
                    } else {
                        activeView.animate()
                            .translationX(0f)
                            .setDuration(250)
                            .setInterpolator(SWIPE_INTERPOLATOR)
                            .withEndAction { setSwipeHardwareLayers(false) }
                            .start()
                    }
                }
            }
            override fun onTouchDown() {
                if (isAnimating.get()) return
                val actView = activeView
                actView.animate().cancel()
                actView.translationX = 0f
                cleanupSwipeAdjacentImmediate()
                // 记录抽屉跟手起始状态，供 onVerticalSwipeDrag/End 使用
                drawerDragStartOpen = drawerOpen
                drawerDragStartProgress = primaryView.drawerFillProgress
                if (!drawerOpen) {
                    // 可能即将通过垂直手势打开抽屉——保存沉浸状态
                    immersiveBeforeDrawer = isImmersive
                }
                // 取消正在进行的抽屉动画，跟手接管
                drawerWidthAnimator?.cancel()
                drawerWidthAnimator = null
            }
            override fun onSingleTapConfirmed() {
                if (drawerOpen) return
                toggleImmersive()
            }
            override fun onVerticalSwipeDrag(dy: Float) {
                if (isAnimating.get()) return
                val drawerWidthPx = (resources.displayMetrics.density * 320)
                // progress = startProgress - dy / drawerWidth
                // 向上滑（dy<0）→ progress 增大 → 抽屉打开
                // 向下滑（dy>0）→ progress 减小 → 抽屉关闭
                var progress = (drawerDragStartProgress - dy / drawerWidthPx).coerceIn(0f, 1f)
                // 方向限制：抽屉打开时只允许向关闭方向（progress 减小），
                // 抽屉关闭时只允许向打开方向（progress 增大），反向滑动无效果
                if (drawerDragStartOpen) {
                    progress = progress.coerceAtMost(drawerDragStartProgress)
                } else {
                    progress = progress.coerceAtLeast(drawerDragStartProgress)
                }
                applyDrawerProgress(progress)
            }
            override fun onVerticalSwipeEnd(dy: Float, velocityY: Float) {
                if (isAnimating.get()) return
                val drawerWidthPx = (resources.displayMetrics.density * 320)
                var currentProgress = (drawerDragStartProgress - dy / drawerWidthPx).coerceIn(0f, 1f)
                // 应用与 drag 相同的方向限制
                if (drawerDragStartOpen) {
                    currentProgress = currentProgress.coerceAtMost(drawerDragStartProgress)
                } else {
                    currentProgress = currentProgress.coerceAtLeast(drawerDragStartProgress)
                }
                // 判断目标状态：根据当前进度和速度
                val targetOpen = if (drawerDragStartOpen) {
                    !(currentProgress < 0.5f || velocityY > 500f)
                } else {
                    currentProgress > 0.5f || velocityY < -500f
                }
                drawerOpen = targetOpen
                animateDrawerTo(targetOpen, fromProgress = currentProgress)
            }
            override fun onLongPressConfirmed() {
                performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
                val item = images.getOrNull(currentIndex) ?: return
                listener?.onLongPress(item.fileId)
            }
        }
    }

    /** 滑动期间启用/禁用硬件层，将视图渲染缓存为 GPU 纹理，使 translationX 变为纯纹理位移。 */
    private fun setSwipeHardwareLayers(enabled: Boolean) {
        val layerType = if (enabled) View.LAYER_TYPE_HARDWARE else View.LAYER_TYPE_NONE
        primaryView.setLayerType(layerType, null)
        secondaryView.setLayerType(layerType, null)
    }

    /**
     * 返回当前图片视图的实际宽度。抽屉打开时 primaryView/secondaryView 宽度被压缩，
     * 翻页滑动需基于压缩后的宽度计算邻接图位置，否则图片会滑出错误的距离。
     * 视图未测量时回退到 NativeGalleryView 自身宽度。
     */
    private fun effectiveViewWidth(): Float {
        val pw = primaryView.width
        return if (pw > 0) pw.toFloat() else width.toFloat()
    }

    private fun prepareSwipeAdjacent(dir: Int) {
        val adjacentIndex = currentIndex + dir
        if (adjacentIndex < 0 || adjacentIndex >= images.size) return
        val cw = effectiveViewWidth()
        val span = cw + swipeGapPx
        val adj = adjacentView()
        adj.animate().cancel()
        loadIntoView(adj, adjacentIndex, rotation = 0, showProgress = false)
        adj.translationX = dir * span
        adj.visibility = VISIBLE
        swipeAdjacentPrepared = true
        swipeAdjacentDirection = dir
        swipeCachedWidth = span
        swipeCachedAdjacentView = adj
        setSwipeHardwareLayers(true)
    }

    private fun navigateFromSwipe(direction: Int) {
        val newIndex = currentIndex + direction
        if (newIndex < 0 || newIndex >= images.size) {
            bounceBackSwipe(direction)
            return
        }
        currentIndex = newIndex
        rotationDegrees = 0
        // 切换图片时清除主色调 loading 状态（与 navigateTo 一致）
        loadingPaletteFileId = null

        isAnimating.set(true)
        val outgoing = activeView
        val incoming = adjacentView()
        activeView = incoming

        val cw = effectiveViewWidth() + swipeGapPx
        val duration = 280L
        outgoing.animate()
            .translationX(-direction * cw)
            .setDuration(duration)
            .setInterpolator(SWIPE_INTERPOLATOR)
            .withEndAction {
                outgoing.translationX = 0f
                outgoing.visibility = GONE
                outgoing.setImageDrawable(null)
            }
            .start()
        incoming.animate()
            .translationX(0f)
            .setDuration(duration)
            .setInterpolator(SWIPE_INTERPOLATOR)
            .withEndAction {
                isAnimating.set(false)
                swipeAdjacentPrepared = false
                swipeAdjacentDirection = 0
                swipeCachedAdjacentView = null
                swipeCachedWidth = 0f
                setSwipeHardwareLayers(false)
                listener?.onNavigate(currentIndex)
                preloadNeighbors()
                thumbnailAdapter.highlight(currentIndex)
            }
            .start()

        updateTitle()
    }

    private fun bounceBackSwipe(dir: Int) {
        val cw = swipeCachedWidth
        val duration = 280L
        activeView.animate()
            .translationX(0f)
            .setDuration(duration)
            .setInterpolator(SWIPE_INTERPOLATOR)
            .withEndAction {
                setSwipeHardwareLayers(false)
            }
            .start()
        if (swipeAdjacentPrepared) {
            val adj = swipeCachedAdjacentView ?: adjacentView()
            adj.animate()
                .translationX(dir * cw)
                .setDuration(duration)
                .setInterpolator(SWIPE_INTERPOLATOR)
                .withEndAction {
                    adj.translationX = 0f
                    adj.visibility = GONE
                    adj.setImageDrawable(null)
                    swipeAdjacentPrepared = false
                    swipeAdjacentDirection = 0
                    swipeCachedAdjacentView = null
                    swipeCachedWidth = 0f
                }
                .start()
        }
    }

    private fun cleanupSwipeAdjacentImmediate() {
        if (swipeAdjacentPrepared) {
            val adj = swipeCachedAdjacentView ?: adjacentView()
            adj.animate().cancel()
            adj.translationX = 0f
            adj.visibility = GONE
            adj.setImageDrawable(null)
            swipeAdjacentPrepared = false
            swipeAdjacentDirection = 0
        }
        swipeCachedAdjacentView = null
        swipeCachedWidth = 0f
        setSwipeHardwareLayers(false)
    }

    private val touchSlopForSwipe = android.view.ViewConfiguration.get(context).scaledTouchSlop.toFloat()

    /** 处理返回键：优先收起抽屉，其次关闭查看器。 */
    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (event.keyCode == KeyEvent.KEYCODE_BACK) {
            if (event.action == KeyEvent.ACTION_UP) {
                if (drawerOpen) {
                    closeDrawer()
                } else if (isOpen) {
                    listener?.onClose()
                }
            }
            return true
        }
        return super.dispatchKeyEvent(event)
    }

    /** 抽屉是否打开（供 MainActivity onBackPressed 查询）。 */
    fun isDrawerOpen(): Boolean = isOpen && drawerOpen

    /** 收起抽屉（供外部调用）。 */
    fun closeDrawer() {
        if (!drawerOpen) return
        toggleDrawer()
    }

    /** 查看器是否已打开。 */
    fun isOpen(): Boolean = isOpen

    /** 打开查看器，显示 [startIndex] 位置的图片。 */
    fun open(images: List<ImageItem>, startIndex: Int, options: JSONObject?) {
        Log.i("NativeViewer", "open called: images=${images.size}, startIndex=$startIndex, options=$options, alreadyOpen=$isOpen, currentIdx=$currentIndex")
        val skipReload = isOpen && startIndex == currentIndex && this.images.size == images.size
        this.images.clear()
        this.images.addAll(images)
        this.currentIndex = startIndex.coerceIn(0, images.size - 1)
        this.rotationDegrees = 0
        this.isOpen = true
        options?.optJSONObject("slideshow")?.let { sl ->
            isSlideshowActive = sl.optBoolean("enabled", false)
            slideshowIntervalMs = sl.optLong("interval", 5000L)
            slideshowTransition = sl.optString("transition", "fade")
        }
        // 主题
        if (options?.has("isDark") == true) {
            isDarkTheme = options.optBoolean("isDark", true)
            applyTheme()
        }

        thumbnailAdapter.submit(images, currentIndex)

        visibility = VISIBLE
        alpha = 1f
        requestFocus()
        if (skipReload) {
            Log.i("NativeViewer", "open: skipping reload, already at index $currentIndex (onNavigate re-entry)")
        } else {
            loadCurrent(animateIn = false)
        }
        updateTitle()
        if (isSlideshowActive) startSlideshowLoop()
    }

    /** 应用当前主题到所有 UI 元素。 */
    private fun applyTheme() {
        // 沉浸模式下保持黑色背景（切换图片时 open() 重入会调用 applyTheme，不应重置为主题色）
        setBackgroundColor(if (isImmersive) Color.BLACK else colorBg())
        // 顶栏/底栏/缩略图条背景
        topBar.setBackgroundColor(if (isDarkTheme) Color.parseColor("#CC171717") else Color.parseColor("#CCE5E5E5"))
        bottomInfo.setBackgroundColor(if (isDarkTheme) Color.parseColor("#CC171717") else Color.parseColor("#CCE5E5E5"))
        thumbnailStrip.setBackgroundColor(if (isDarkTheme) Color.parseColor("#E6171717") else Color.parseColor("#E6E5E5E5"))
        // 顶栏所有文字（按钮+标题）
        titleView.setTextColor(colorTextPrimary())
        for (i in 0 until topBar.childCount) {
            (topBar.getChildAt(i) as? TextView)?.setTextColor(colorTextPrimary())
        }
        bottomInfoText.setTextColor(colorTextPrimary())
        // 抽屉
        metadataDrawer.setBackgroundColor(colorPanel())
        drawerNameView.setTextColor(colorTextPrimary())
        drawerFolderView.setTextColor(colorTextSecondary())
        drawerPreviewImage.setBackgroundColor(if (isDarkTheme) Color.parseColor("#262626") else Color.parseColor("#F3F4F6"))
        drawerDescView.setTextColor(colorTextPrimary())
        drawerDescView.setHintTextColor(colorHint())
        drawerDescView.background = android.graphics.drawable.GradientDrawable().apply {
            cornerRadius = resources.displayMetrics.density * 8
            setColor(colorTextBoxBg())
            setStroke((resources.displayMetrics.density * 1).toInt(), colorBorder())
        }
        drawerSourceUrlView.setTextColor(colorAccent())
        drawerSourceUrlView.setHintTextColor(colorHint())
        drawerSourceUrlView.background = android.graphics.drawable.GradientDrawable().apply {
            cornerRadius = resources.displayMetrics.density * 8
            setColor(colorTextBoxBg())
            setStroke((resources.displayMetrics.density * 1).toInt(), colorBorder())
        }
        // 重新刷新当前图片的抽屉内容（标题色块等会用到主题色）
        images.getOrNull(currentIndex)?.let { updateDrawer(it) }
    }

    fun close() {
        stopSlideshowLoop()
        cleanupSwipeAdjacentImmediate()
        activeView.animate().cancel()
        activeView.translationX = 0f
        // 清除图片以停止 animated WebP/GIF 帧动画，避免关闭后仍消耗 CPU
        primaryView.setImageDrawable(null)
        secondaryView.setImageDrawable(null)
        isOpen = false
        drawerOpen = false
        // 清除主色调 loading 状态，防止下次打开时残留
        loadingPaletteFileId = null
        // 清除自动提取失败记录，下次打开重新尝试
        failedPaletteFileIds.clear()
        // 取消抽屉宽度动画并重置视觉状态（可能正在动画中）
        drawerWidthAnimator?.cancel()
        drawerWidthAnimator = null
        val drawerW = (resources.displayMetrics.density * 320)
        metadataDrawer.animate().cancel()
        metadataDrawer.translationX = drawerW
        primaryView.layoutParams = LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT)
        secondaryView.layoutParams = LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT)
        // 重置填充进度，下次打开时从 fit 开始
        primaryView.drawerFillProgress = 0f
        secondaryView.drawerFillProgress = 0f
        // 恢复缩放许可（抽屉已关闭）
        primaryView.allowZoom = true
        secondaryView.allowZoom = true
        // 恢复系统状态栏（沉浸或抽屉打开时状态栏被隐藏）
        if (isImmersive || drawerOpen) {
            listener?.onImmersiveToggle(false)
        }
        isImmersive = false
        // 沉浸模式背景为黑色，关闭时还原主题色，避免下次打开残留黑色
        setBackgroundColor(colorBg())
        topBar.translationY = 0f
        thumbnailStrip.translationY = 0f
        bottomInfo.translationY = 0f
        visibility = GONE
    }

    fun destroy() {
        stopSlideshowLoop()
        imageLoader.shutdown()
    }

    /** 切换到上一张/下一张。[direction] -1=prev, 1=next。 */
    fun navigate(direction: Int, animate: Boolean = true) {
        if (isAnimating.get()) return
        if (images.isEmpty()) return
        val newIndex = currentIndex + direction
        if (newIndex < 0 || newIndex >= images.size) return
        navigateTo(newIndex, animate)
    }

    fun navigateTo(newIndex: Int, animate: Boolean = true) {
        if (isAnimating.get()) return
        if (newIndex == currentIndex) return
        if (newIndex < 0 || newIndex >= images.size) return

        // 安全清理：若跟手滑动残留了邻接视图，先复位
        cleanupSwipeAdjacentImmediate()
        activeView.animate().cancel()
        activeView.translationX = 0f

        val direction = if (newIndex > currentIndex) 1 else -1
        currentIndex = newIndex
        rotationDegrees = 0
        // 切换图片时清除主色调 loading 状态
        loadingPaletteFileId = null

        if (!animate) {
            listener?.onNavigate(currentIndex)
            loadCurrent(animateIn = false)
            updateTitle()
            thumbnailAdapter.highlight(currentIndex)
            return
        }

        isAnimating.set(true)
        val outgoing = activeView
        val incoming = if (outgoing === primaryView) secondaryView else primaryView
        activeView = incoming

        val cw = effectiveViewWidth() + swipeGapPx
        // incoming 从右侧/左侧滑入
        incoming.translationX = direction * cw
        incoming.visibility = VISIBLE
        loadIntoView(incoming, currentIndex)

        val duration = 280L
        outgoing.animate()
            .translationX(-direction * cw)
            .setDuration(duration)
            .setInterpolator(SWIPE_INTERPOLATOR)
            .withEndAction {
                outgoing.translationX = 0f
                outgoing.visibility = GONE
                outgoing.setImageDrawable(null)
            }
            .start()
        incoming.animate()
            .translationX(0f)
            .setDuration(duration)
            .setInterpolator(SWIPE_INTERPOLATOR)
            .withEndAction {
                isAnimating.set(false)
                listener?.onNavigate(currentIndex)
                preloadNeighbors()
                thumbnailAdapter.highlight(currentIndex)
            }
            .start()

        updateTitle()
    }

    private fun loadCurrent(animateIn: Boolean) {
        loadIntoView(activeView, currentIndex)
        preloadNeighbors()
    }

    private fun loadIntoView(view: ZoomableImageView, index: Int, rotation: Int = rotationDegrees, showProgress: Boolean = true) {
        val item = images.getOrNull(index) ?: return
        if (showProgress) progressBar.visibility = VISIBLE
        Log.i(TAG, "loadIntoView: index=$index, name=${item.name}, isLan=${item.isLan}, path=${item.path}, thumbUrl=${item.thumbnailUrl}")

        // 先加载缩略图（如果有），再加载原图
        val thumbUrl = item.thumbnailUrl
        if (!thumbUrl.isNullOrEmpty()) {
            val thumbRequest = ImageRequest.Builder(context)
                .data(thumbUrl)
                .target(view)
                .precision(Precision.INEXACT)
                .build()
            imageLoader.enqueue(thumbRequest)
        }

        val request = ImageRequest.Builder(context)
            .data(if (item.isLan) item.path else File(item.path))
            .target(
                onSuccess = { drawable ->
                    if (showProgress) progressBar.visibility = GONE
                    view.setImageDrawable(drawable)
                    view.setRotationDegrees(rotation)
                },
                onError = { _ ->
                    if (showProgress) progressBar.visibility = GONE
                    Log.e(TAG, "failed to load index=$index name=${item.name} path=${item.path}")
                    Toast.makeText(context, "Failed to load ${item.name}", Toast.LENGTH_SHORT).show()
                }
            )
            .precision(Precision.INEXACT)
            .build()
        imageLoader.enqueue(request)
    }

    private fun preloadNeighbors() {
        // 预加载当前 ±1 张到 memory cache
        for (offset in intArrayOf(1, -1, 2, -2)) {
            val idx = currentIndex + offset
            if (idx < 0 || idx >= images.size) continue
            val item = images[idx]
            val request = ImageRequest.Builder(context)
                .data(if (item.isLan) item.path else File(item.path))
                .precision(Precision.INEXACT)
                .build()
            imageLoader.enqueue(request)
        }
    }

    private fun updateTitle() {
        val item = images.getOrNull(currentIndex) ?: run {
            titleView.text = ""
            return
        }
        titleView.text = "${currentIndex + 1} / ${images.size}  ·  ${item.name}"
        // 底部信息
        val sizeStr = if (item.width > 0 && item.height > 0) "${item.width}×${item.height}" else "—"
        bottomInfoText.text = "${item.name}\n$sizeStr"
        // 同步抽屉
        updateDrawer(item)
    }

    private fun toggleImmersive() {
        // 抽屉打开时不允许进入/退出沉浸
        if (drawerOpen) return
        isImmersive = !isImmersive
        val targetTop = if (isImmersive) -topBar.height.toFloat() else 0f
        val targetBottom = if (isImmersive) height.toFloat() else 0f
        val targetInfo = if (isImmersive) height.toFloat() else 0f
        topBar.animate().translationY(targetTop).setDuration(200).start()
        thumbnailStrip.animate().translationY(targetBottom - thumbnailStrip.translationY).setDuration(200).start()
        if (bottomInfo.visibility == VISIBLE) {
            bottomInfo.animate().translationY(targetInfo - bottomInfo.translationY).setDuration(200).start()
        }
        // 背景色与顶栏动画同步过渡：进入沉浸→黑色，退出沉浸→主题色
        val fromColor = if (isImmersive) colorBg() else Color.BLACK
        val toColor = if (isImmersive) Color.BLACK else colorBg()
        val colorAnim = android.animation.ValueAnimator.ofObject(android.animation.ArgbEvaluator(), fromColor, toColor)
        colorAnim.duration = 200
        colorAnim.addUpdateListener { anim -> setBackgroundColor(anim.animatedValue as Int) }
        colorAnim.start()
        listener?.onImmersiveToggle(isImmersive)
    }

    private fun rotateCurrent() {
        rotationDegrees = (rotationDegrees + 90) % 360
        activeView.setRotationDegrees(rotationDegrees)
    }

    private fun toggleBottomInfo() {
        bottomInfo.visibility = if (bottomInfo.visibility == VISIBLE) GONE else VISIBLE
        if (bottomInfo.visibility == VISIBLE) {
            bottomInfo.translationY = 0f
        }
    }

    /** 创建圆角矩形背景 drawable */
    private fun createRoundedBg(bgColor: Int, cornerRadiusDp: Float, borderColor: Int? = null, strokeWidthDp: Float = 0f): android.graphics.drawable.GradientDrawable {
        val density = resources.displayMetrics.density
        return android.graphics.drawable.GradientDrawable().apply {
            shape = android.graphics.drawable.GradientDrawable.RECTANGLE
            setColor(bgColor)
            cornerRadius = cornerRadiusDp * density
            if (borderColor != null) setStroke((strokeWidthDp * density).toInt(), borderColor)
        }
    }

    /** 设置斜体提示文本（hint），用于区分占位提示与正文输入 */
    private fun setItalicHint(editText: EditText, hintText: String) {
        val spannable = android.text.SpannableString(hintText)
        spannable.setSpan(
            android.text.style.StyleSpan(android.graphics.Typeface.ITALIC),
            0, hintText.length,
            android.text.Spanned.SPAN_EXCLUSIVE_EXCLUSIVE
        )
        editText.setHint(spannable)
        editText.setHintTextColor(colorHint())
    }

    /** 创建弹窗按钮（主/次样式） */
    private fun createDialogButton(text: String, isPrimary: Boolean, onClick: () -> Unit): TextView {
        val density = resources.displayMetrics.density
        return TextView(context).apply {
            this.text = text
            textSize = 13f
            gravity = android.view.Gravity.CENTER
            setTextColor(if (isPrimary) Color.WHITE else colorButtonSecondaryText())
            setPadding((density * 20).toInt(), (density * 10).toInt(), (density * 20).toInt(), (density * 10).toInt())
            background = createRoundedBg(
                if (isPrimary) colorAccent() else colorButtonSecondaryBg(),
                8f,
                if (isPrimary) null else colorBorder(),
                if (isPrimary) 0f else 1f
            )
            setOnClickListener { onClick() }
            layoutParams = LinearLayout.LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT).apply {
                marginStart = (density * 8).toInt()
            }
        }
    }

    private fun showTagEditDialog() {
        val item = images.getOrNull(currentIndex) ?: return
        val localTags = item.tags.toMutableList()
        val density = resources.displayMetrics.density

        val dialog = Dialog(context)
        dialog.requestWindowFeature(android.view.Window.FEATURE_NO_TITLE)
        dialog.setCancelable(true)
        dialog.window?.setBackgroundDrawable(android.graphics.drawable.ColorDrawable(Color.TRANSPARENT))

        val dialogView = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            background = createRoundedBg(colorDialogBg(), 16f)
            setPadding((density * 24).toInt(), (density * 24).toInt(), (density * 24).toInt(), (density * 16).toInt())
        }

        // 标题
        dialogView.addView(TextView(context).apply {
            text = "编辑标签"
            setTextColor(colorTextPrimary())
            textSize = 16f
            paint.isFakeBoldText = true
            setPadding(0, 0, 0, (density * 16).toInt())
        })

        // 标签列表
        val chipsBox = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT)
        }
        dialogView.addView(chipsBox)

        // 输入行
        val inputRow = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            layoutParams = LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply {
                topMargin = (density * 12).toInt()
            }
            gravity = android.view.Gravity.CENTER_VERTICAL
        }
        val input = EditText(context).apply {
            setTextColor(colorTextPrimary())
            textSize = 14f
            background = createRoundedBg(colorTextBoxBg(), 8f, colorBorder(), 1f)
            setPadding((density * 12).toInt(), (density * 12).toInt(), (density * 12).toInt(), (density * 12).toInt())
            layoutParams = LinearLayout.LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f)
            setSingleLine(true)
        }
        setItalicHint(input, "新标签")
        val widthPx = (380 * density).toInt()
        val maxHeightPx = (450 * density).toInt()
        // 标签增删后重新测量弹窗高度（自适应）
        fun relayoutTagDialog() {
            dialogView.measure(
                View.MeasureSpec.makeMeasureSpec(widthPx, View.MeasureSpec.EXACTLY),
                View.MeasureSpec.makeMeasureSpec(maxHeightPx, View.MeasureSpec.AT_MOST)
            )
            dialog.window?.setLayout(widthPx, dialogView.measuredHeight)
        }
        val addButton = TextView(context).apply {
            text = "+"
            setTextColor(Color.WHITE)
            textSize = 18f
            gravity = android.view.Gravity.CENTER
            background = createRoundedBg(colorAccent(), 8f)
            setOnClickListener {
                val tag = input.text.toString().trim()
                if (tag.isNotEmpty() && tag !in localTags) {
                    localTags.add(tag)
                    input.text.clear()
                    refreshTagChips(chipsBox, localTags) { removedTag ->
                        localTags.remove(removedTag)
                        refreshTagChips(chipsBox, localTags) {}
                        relayoutTagDialog()
                    }
                    relayoutTagDialog()
                }
            }
            layoutParams = LinearLayout.LayoutParams((density * 44).toInt(), (density * 44).toInt()).apply {
                marginStart = (density * 8).toInt()
            }
        }
        inputRow.addView(input)
        inputRow.addView(addButton)
        dialogView.addView(inputRow)

        refreshTagChips(chipsBox, localTags) { removedTag ->
            localTags.remove(removedTag)
            refreshTagChips(chipsBox, localTags) {}
            relayoutTagDialog()
        }

        // 按钮行
        val buttonRow = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = android.view.Gravity.END
            layoutParams = LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply {
                topMargin = (density * 20).toInt()
            }
        }
        buttonRow.addView(createDialogButton("取消", isPrimary = false) { dialog.dismiss() })
        buttonRow.addView(createDialogButton("保存", isPrimary = true) {
            val idx2 = images.indexOfFirst { it.fileId == item.fileId }
            if (idx2 >= 0) {
                images[idx2] = images[idx2].copy(tags = localTags.toList())
            }
            val json = JSONObject().apply { put("tags", JSONArray(localTags)) }
            listener?.onUpdateFile(item.fileId, json.toString())
            images.getOrNull(idx2)?.let { updateDrawer(it) }
            dialog.dismiss()
        })
        dialogView.addView(buttonRow)

        dialog.setContentView(dialogView)
        dialog.show()
        relayoutTagDialog()
    }

    private fun refreshTagChips(container: LinearLayout, tags: List<String>, onRemove: (String) -> Unit) {
        container.removeAllViews()
        val density = resources.displayMetrics.density
        if (tags.isEmpty()) {
            container.addView(TextView(context).apply {
                text = "（无标签）"
                setTextColor(colorTextSecondary())
                textSize = 13f
                setPadding(0, (density * 8).toInt(), 0, (density * 8).toInt())
            })
            return
        }
        tags.forEach { tag ->
            val row = LinearLayout(context).apply {
                orientation = LinearLayout.HORIZONTAL
                // WRAP_CONTENT 让胶囊只占内容宽度（缩短）
                layoutParams = LinearLayout.LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT).apply {
                    topMargin = (density * 6).toInt()
                }
                gravity = android.view.Gravity.CENTER_VERTICAL
                val drawable = android.graphics.drawable.GradientDrawable().apply {
                    cornerRadius = density * 16
                    setColor(colorTagBg())
                    setStroke((density * 1).toInt(), colorTagBorder())
                }
                background = drawable
                // 放大内边距以符合触控操作
                setPadding((density * 14).toInt(), (density * 10).toInt(), (density * 10).toInt(), (density * 10).toInt())
            }
            row.addView(TextView(context).apply {
                text = tag
                setTextColor(colorTagText())
                textSize = 14f
                maxEms = 14
                ellipsize = android.text.TextUtils.TruncateAt.END
                setSingleLine(true)
            })
            // 放大删除按钮触控区
            val removeBtn = TextView(context).apply {
                text = "✕"
                setTextColor(Color.parseColor("#EF4444"))
                textSize = 15f
                val minTouch = (density * 32).toInt()
                minWidth = minTouch
                minHeight = minTouch
                gravity = android.view.Gravity.CENTER
                setOnClickListener { onRemove(tag) }
            }
            row.addView(removeBtn)
            container.addView(row)
        }
    }

    private fun showDescriptionEditDialog() {
        val item = images.getOrNull(currentIndex) ?: return
        val density = resources.displayMetrics.density

        val dialog = Dialog(context)
        dialog.requestWindowFeature(android.view.Window.FEATURE_NO_TITLE)
        dialog.setCancelable(true)
        dialog.window?.setBackgroundDrawable(android.graphics.drawable.ColorDrawable(Color.TRANSPARENT))

        val dialogView = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            background = createRoundedBg(colorDialogBg(), 16f)
            setPadding((density * 24).toInt(), (density * 24).toInt(), (density * 24).toInt(), (density * 16).toInt())
        }

        // 标题
        dialogView.addView(TextView(context).apply {
            text = "编辑描述"
            setTextColor(colorTextPrimary())
            textSize = 16f
            paint.isFakeBoldText = true
            setPadding(0, 0, 0, (density * 16).toInt())
        })

        // 多行输入框（正文非斜体，从左上角开始）
        val input = EditText(context).apply {
            setTextColor(colorTextPrimary())
            textSize = 13f
            inputType = InputType.TYPE_TEXT_FLAG_MULTI_LINE or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
            // 文字从左上角开始（修复水平居中 + 上下空位问题）
            gravity = android.view.Gravity.TOP or android.view.Gravity.START
            minLines = 4
            maxLines = 8
            setText(item.description)
            background = createRoundedBg(colorTextBoxBg(), 8f, colorBorder(), 1f)
            setPadding((density * 12).toInt(), (density * 12).toInt(), (density * 12).toInt(), (density * 12).toInt())
            setLineSpacing(0f, 1.4f)
            layoutParams = LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT)
        }
        setItalicHint(input, "添加描述...")
        dialogView.addView(input)

        // 按钮行
        val buttonRow = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = android.view.Gravity.END
            layoutParams = LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply {
                topMargin = (density * 20).toInt()
            }
        }
        buttonRow.addView(createDialogButton("取消", isPrimary = false) { dialog.dismiss() })
        buttonRow.addView(createDialogButton("保存", isPrimary = true) {
            val newDesc = input.text.toString().trim()
            val idx2 = images.indexOfFirst { it.fileId == item.fileId }
            if (idx2 >= 0) {
                images[idx2] = images[idx2].copy(description = newDesc)
            }
            val json = JSONObject().apply { put("description", newDesc) }
            listener?.onUpdateFile(item.fileId, json.toString())
            images.getOrNull(idx2)?.let { updateDrawer(it) }
            dialog.dismiss()
        })
        dialogView.addView(buttonRow)

        dialog.setContentView(dialogView)
        dialog.show()
        val widthPx = (380 * density).toInt()
        val maxHeightPx = (520 * density).toInt()
        dialogView.measure(
            View.MeasureSpec.makeMeasureSpec(widthPx, View.MeasureSpec.EXACTLY),
            View.MeasureSpec.makeMeasureSpec(maxHeightPx, View.MeasureSpec.AT_MOST)
        )
        dialog.window?.setLayout(widthPx, dialogView.measuredHeight)
    }

    private fun showSourceUrlEditDialog() {
        val item = images.getOrNull(currentIndex) ?: return
        val density = resources.displayMetrics.density

        val dialog = Dialog(context)
        dialog.requestWindowFeature(android.view.Window.FEATURE_NO_TITLE)
        dialog.setCancelable(true)
        dialog.window?.setBackgroundDrawable(android.graphics.drawable.ColorDrawable(Color.TRANSPARENT))

        val dialogView = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            background = createRoundedBg(colorDialogBg(), 16f)
            setPadding((density * 24).toInt(), (density * 24).toInt(), (density * 24).toInt(), (density * 16).toInt())
        }

        // 标题
        dialogView.addView(TextView(context).apply {
            text = "编辑来源网址"
            setTextColor(colorTextPrimary())
            textSize = 16f
            paint.isFakeBoldText = true
            setPadding(0, 0, 0, (density * 16).toInt())
        })

        // 单行输入框
        val input = EditText(context).apply {
            setTextColor(colorTextPrimary())
            textSize = 13f
            setText(item.sourceUrl)
            background = createRoundedBg(colorTextBoxBg(), 8f, colorBorder(), 1f)
            setPadding((density * 12).toInt(), (density * 12).toInt(), (density * 12).toInt(), (density * 12).toInt())
            setSingleLine(true)
            inputType = InputType.TYPE_TEXT_VARIATION_URI
            layoutParams = LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT)
        }
        setItalicHint(input, "https://...")
        dialogView.addView(input)

        // 按钮行
        val buttonRow = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = android.view.Gravity.END
            layoutParams = LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply {
                topMargin = (density * 20).toInt()
            }
        }
        buttonRow.addView(createDialogButton("取消", isPrimary = false) { dialog.dismiss() })
        buttonRow.addView(createDialogButton("保存", isPrimary = true) {
            val newUrl = input.text.toString().trim()
            val idx2 = images.indexOfFirst { it.fileId == item.fileId }
            if (idx2 >= 0) {
                images[idx2] = images[idx2].copy(sourceUrl = newUrl)
            }
            val json = JSONObject().apply { put("sourceUrl", newUrl) }
            listener?.onUpdateFile(item.fileId, json.toString())
            images.getOrNull(idx2)?.let { updateDrawer(it) }
            dialog.dismiss()
        })
        dialogView.addView(buttonRow)

        dialog.setContentView(dialogView)
        dialog.show()
        val widthPx = (380 * density).toInt()
        val maxHeightPx = (300 * density).toInt()
        dialogView.measure(
            View.MeasureSpec.makeMeasureSpec(widthPx, View.MeasureSpec.EXACTLY),
            View.MeasureSpec.makeMeasureSpec(maxHeightPx, View.MeasureSpec.AT_MOST)
        )
        dialog.window?.setLayout(widthPx, dialogView.measuredHeight)
    }

    private fun showMoreMenu() {
        val item = images.getOrNull(currentIndex) ?: return
        val options = arrayOf("删除", "在文件夹中显示", "重命名", "旋转保存", "AI 分析", "复制到文件夹", "移动到文件夹")
        AlertDialog.Builder(context)
            .setTitle(item.name)
            .setItems(options) { _, which ->
                when (which) {
                    0 -> listener?.onDelete(item.fileId)
                    1 -> listener?.onShowInFolder(item.fileId)
                    2 -> showRenameDialog()
                    3 -> {
                        // 旋转保存：需要 EXIF 写入，暂未实现
                        Toast.makeText(context, "旋转保存功能开发中", Toast.LENGTH_SHORT).show()
                    }
                    4 -> listener?.onAIAnalyze(item.fileId)
                    5 -> listener?.onCopyToFolder(item.fileId)
                    6 -> listener?.onMoveToFolder(item.fileId)
                }
            }
            .show()
    }

    private fun showRenameDialog() {
        val item = images.getOrNull(currentIndex) ?: return
        val input = EditText(context).apply {
            setText(item.name)
            setSingleLine(true)
            setPadding(48, 24, 48, 24)
        }
        AlertDialog.Builder(context)
            .setTitle("重命名")
            .setView(input)
            .setPositiveButton("保存") { _, _ ->
                val newName = input.text.toString().trim()
                if (newName.isNotEmpty() && newName != item.name) {
                    val idx = images.indexOfFirst { it.fileId == item.fileId }
                    if (idx >= 0) {
                        images[idx] = item.copy(name = newName)
                        updateTitle()
                    }
                    val json = JSONObject().apply { put("name", newName) }
                    listener?.onUpdateFile(item.fileId, json.toString())
                }
            }
            .setNegativeButton("取消", null)
            .show()
    }

    // ====== 幻灯片 ======
    private val slideshowRunnable = object : Runnable {
        override fun run() {
            if (!isSlideshowActive) return
            if (currentIndex < images.size - 1) {
                navigateTo(currentIndex + 1, animate = true)
            } else {
                navigateTo(0, animate = true)
            }
            mainHandler.postDelayed(this, slideshowIntervalMs)
        }
    }

    private fun startSlideshowLoop() {
        mainHandler.postDelayed(slideshowRunnable, slideshowIntervalMs)
    }

    private fun stopSlideshowLoop() {
        mainHandler.removeCallbacks(slideshowRunnable)
        isSlideshowActive = false
    }

    fun setSlideshow(enabled: Boolean) {
        if (enabled == isSlideshowActive) return
        isSlideshowActive = enabled
        if (enabled) startSlideshowLoop() else stopSlideshowLoop()
    }

    fun setRotation(degrees: Int) {
        rotationDegrees = ((degrees % 360) + 360) % 360
        activeView.setRotationDegrees(rotationDegrees)
    }

    /** React 端更新某个 ImageItem 的元数据（实时同步）。 */
    fun updateItem(fileId: String, updates: JSONObject) {
        val idx = images.indexOfFirst { it.fileId == fileId }
        if (idx < 0) return
        val item = images[idx]
        var newItem = item
        // 同步"浏览时自动提取主色调"开关到 native
        if (updates.has("autoExtractPalette")) {
            autoExtractPalette = updates.optBoolean("autoExtractPalette", false)
        }
        // 处理自动提取失败标记：失败时加入集合显示按钮，成功时从集合移除
        if (updates.has("paletteLoadFailed")) {
            if (updates.optBoolean("paletteLoadFailed", false)) {
                failedPaletteFileIds.add(fileId)
            } else {
                failedPaletteFileIds.remove(fileId)
            }
        }
        if (updates.has("tags")) {
            val arr = updates.optJSONArray("tags")
            val list = mutableListOf<String>()
            if (arr != null) for (i in 0 until arr.length()) list.add(arr.optString(i))
            newItem = newItem.copy(tags = list)
        }
        if (updates.has("description")) {
            newItem = newItem.copy(description = updates.optString("description", ""))
        }
        if (updates.has("name")) {
            newItem = newItem.copy(name = updates.optString("name", newItem.name))
        }
        if (updates.has("palette")) {
            val arr = updates.optJSONArray("palette")
            val list = mutableListOf<String>()
            if (arr != null) for (i in 0 until arr.length()) list.add(arr.optString(i))
            newItem = newItem.copy(palette = list)
            Log.i(TAG, "updateItem: received palette for $fileId, size=${list.size}, loadingPaletteFileId=$loadingPaletteFileId")
            // 收到主色调数据，清除 loading 状态
            if (loadingPaletteFileId == fileId) {
                loadingPaletteFileId = null
                Log.i(TAG, "updateItem: cleared loadingPaletteFileId for $fileId")
            }
            // 收到非空 palette 表示提取成功，从失败集合中移除
            if (list.isNotEmpty()) {
                failedPaletteFileIds.remove(fileId)
            }
        }
        if (updates.has("aiData")) {
            val ai = updates.optJSONObject("aiData")
            if (ai != null) {
                var aiTags = newItem.aiTags
                var aiDesc = newItem.aiDescription
                var aiScene = newItem.aiSceneCategory
                var aiObjs = newItem.aiObjects
                if (ai.has("tags")) {
                    val arr = ai.optJSONArray("tags")
                    val list = mutableListOf<String>()
                    if (arr != null) for (i in 0 until arr.length()) list.add(arr.optString(i))
                    aiTags = list
                }
                aiDesc = ai.optString("description", aiDesc)
                aiScene = ai.optString("sceneCategory", aiScene)
                if (ai.has("objects")) {
                    val arr = ai.optJSONArray("objects")
                    val list = mutableListOf<String>()
                    if (arr != null) for (i in 0 until arr.length()) list.add(arr.optString(i))
                    aiObjs = list
                }
                newItem = newItem.copy(aiTags = aiTags, aiDescription = aiDesc, aiSceneCategory = aiScene, aiObjects = aiObjs)
            }
        }
        images[idx] = newItem
        if (idx == currentIndex) {
            updateDrawer(newItem)
            if (updates.has("name")) updateTitle()
        }
    }

    /** 由外部（如内存压力）通知清空 cache。 */
    fun clearMemoryCache() {
        imageLoader.memoryCache?.clear()
    }

    companion object {
        private const val TAG = "NativeGalleryView"
        /** 翻页动画贝塞尔曲线插值器：快速进场 → 接近中心时平滑减速 */
        private val SWIPE_INTERPOLATOR = PathInterpolator(0f, 0f, 0.2f, 1f)
        /** 翻页触发距离阈值（dp），固定值不受横竖屏影响 */
        private const val SWIPE_THRESHOLD_DP = 32f
        /** 翻页触发速度阈值 */
        private const val SWIPE_VELOCITY_THRESHOLD = 200f
        /** 翻页时两张图片之间的视觉间隔（dp），避免竖屏下图片紧贴 */
        private const val SWIPE_GAP_DP = 16f
    }

    /** 翻页间隔的像素值 */
    private val swipeGapPx: Float get() = resources.displayMetrics.density * SWIPE_GAP_DP
}
