package com.aurora.gallery.kotlin.viewer

import com.aurora.gallery.kotlin.R
import android.content.Context
import android.graphics.Color
import android.graphics.drawable.Drawable
import android.text.method.ScrollingMovementMethod
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.animation.AccelerateDecelerateInterpolator
import android.view.animation.PathInterpolator
import android.widget.FrameLayout
import android.widget.GridLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import android.net.Uri
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.aurora.gallery.kotlin.ui.theme.AuroraPalette
import com.aurora.gallery.kotlin.ui.theme.AuroraPalettes
import com.aurora.gallery.kotlin.ui.theme.withAlpha
import coil.ImageLoader
import coil.decode.GifDecoder
import coil.decode.ImageDecoderDecoder
import coil.request.ImageRequest
import coil.size.Precision
import com.aurora.gallery.kotlin.viewer.dialogs.DeleteConfirmDialog
import com.aurora.gallery.kotlin.viewer.dialogs.DescriptionEditDialog
import com.aurora.gallery.kotlin.viewer.dialogs.DialogTheme
import com.aurora.gallery.kotlin.viewer.dialogs.DialogUtils
import com.aurora.gallery.kotlin.viewer.dialogs.FolderPickerDialog
import com.aurora.gallery.kotlin.viewer.dialogs.MoreMenuItem
import com.aurora.gallery.kotlin.viewer.dialogs.MoreMenuPopup
import com.aurora.gallery.kotlin.viewer.dialogs.RenameDialog
import com.aurora.gallery.kotlin.viewer.dialogs.SlideshowConfig
import com.aurora.gallery.kotlin.viewer.dialogs.SlideshowSettingsDialog
import com.aurora.gallery.kotlin.viewer.dialogs.SourceUrlEditDialog
import com.aurora.gallery.kotlin.viewer.dialogs.TagEditDialog
import org.json.JSONArray
import org.json.JSONObject
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
) : FrameLayout(context), DialogTheme {

    interface Listener {
        /** 用户点击了关闭按钮。 */
        fun onClose()
        /** 当前图片索引变化（用户操作或幻灯片）。 */
        fun onNavigate(index: Int)
        /**
         * 用户在删除确认弹窗点了确认（查看器已把该图从自己的序列摘除并前进）。
         * [isLan]（M6a 阶段 6）标记被删项是否远端项：宿主按它分流远端 DELETE /api/file
         * 与本地 MediaStore 链路——两条链路的身份语义不同（远端=path、本地=file_id），
         * 不能靠调用方上下文推断，必须随事件显式携带。
         */
        fun onDelete(fileId: String, isLan: Boolean)
        /** 用户点击了"复制到文件夹"。 */
        fun onCopyToFolder(fileId: String)
        /** 用户点击了"移动到文件夹"。 */
        fun onMoveToFolder(fileId: String)
        /**
         * 用户在原生层编辑了文件元数据。`updatesJson` 是 **camelCase** 的 JSON 对象，
         * 且**只带用户这次编辑过的那几个键**——缺键=不改，不是清空。
         *
         * 键集合（M4a 2.1 定死，改弹窗时同步改这里）：
         *  - `tags`: `string[]`，该文件的标签**全集**（整体替换语义，宿主走 `setFileTags`）；
         *  - `description`: `string`，可为空串（=清空描述）；
         *  - `sourceUrl`: `string`，同上（**旧单值，现已不单独发**）；
         *  - `sourceUrls`: `string[]`，来源网址**全集**（P1(b) 多值，整体覆盖语义，
         *    空数组 = 清空）。**只看这一键**：同时给两个键时以数组为准，本类只发数组；
         *  - `name`: `string`，查看器重命名弹窗。宿主**不写元数据行**（重命名改的是
         *    MediaStore 的 `DISPLAY_NAME`，归 M4b），只给可见占位。
         *
         * [isLan]（M6a 阶段 5）：被编辑项是否远端项（查看器自己知道 item.isLan）。
         * true 时宿主必须走 LAN 写路径（saveLanFileUpdates → PUT /api/metadata），
         * **绝不落本地 FFI**（D31 数据层铁律的守门员分支）；`name` 键只可能来自
         * 本地重命名弹窗（LAN 项菜单不含重命名），恒伴随 isLan=false。
         *
         * 合并与整行读改写都在宿主侧（`GalleryViewModel.saveFileUpdates` /
         * `saveLanFileUpdates`），本类不做任何落库判断，只负责把编辑结果原样报出去。
         */
        fun onUpdateFile(fileId: String, updatesJson: String, isLan: Boolean)
        /** 用户点击了抽屉里的调色板色块，请求按该颜色搜索。colorHex 形如 "#RRGGBB"。 */
        fun onColorSearch(colorHex: String)
        /** 用户点击了"提取主色调"按钮，请求对该图片提取主色调。 */
        fun onExtractPalette(fileId: String, filePath: String)
        /** 用户点击了分享按钮。filePath 为本地文件路径。 */
        fun onShare(filePath: String)
        /** 用户在原生层修改了幻灯片设置，JSON 形如 {"interval":5000,"transition":"fade","isRandom":false,"enableZoom":false} */
        fun onUpdateSlideshowConfig(configJson: String)
        /** 用户在文件夹选择弹窗中确认了目标文件夹。type: "copy" 或 "move" */
        fun onFolderPickerConfirm(fileId: String, targetFolderId: String, type: String)
        // M5 3.2：用户点击了「加入画布」（仅平板显示此菜单项，D28）
        fun onAddToCanvas(fileId: String)
        /** M6b 阶段 2：用户点击了「AI 分析」（仅本地项显示此菜单项；单张入口）。 */
        fun onAiAnalyze(fileId: String)
        /**
         * M6b 阶段 5（D36）：用户点击了「在桌面找相似」（仅本地项显示此菜单项）——
         * 本地图字节上传桌面 CLIP embed 后搜桌面库，宿主把命中集装进 LAN 搜索结果
         * 虚拟目录并切视图；未连接/桌面模型未就绪由宿主 Toast 拦截。
         */
        fun onFindSimilar(fileId: String)
        /**
         * M6a 阶段 4（D34）：用户点击了「保存到设备」（仅 isLan 项显示此菜单项）。
         * [remotePath] 为远端不透明 path（宿主只取尾段当文件名，不回传服务端）；
         * [imageUrl] 为大图 URL（token 进 query，宿主直接下载）。
         */
        fun onSaveToDevice(remotePath: String, imageUrl: String)
    }

    data class ImageItem(
        val path: String,        // 本地：文件路径；LAN：完整 HTTP URL
        val fileId: String,
        val name: String,
        val width: Int,
        val height: Int,
        val isLan: Boolean,
        val thumbnailUrl: String?, // LAN 缩略图 URL 或本地缩略图路径
        val contentUri: String = "", // 本地图片的 content:// URI（优先使用，兼容 Scoped Storage）
        // 元数据（用于抽屉展示）
        val size: Long = 0,
        val format: String = "",
        val createdAt: String = "",
        val updatedAt: String = "",
        val tags: List<String> = emptyList(),
        val description: String = "",
        /** 首条来源网址（老读者用，与 [sourceUrls] 首项一致） */
        val sourceUrl: String = "",
        /** 全部来源网址（P1(b) 多值），抽屉逐条显示、编辑弹窗整体覆盖 */
        val sourceUrls: List<String> = emptyList(),
        val palette: List<String> = emptyList(),
        val aiTags: List<String> = emptyList(),
        val aiDescription: String = "",
        val aiSceneCategory: String = "",
        val aiObjects: List<String> = emptyList(),
        val parentName: String = "",
    )

    private val mainHandler = Handler(Looper.getMainLooper())

    private val imageLoader: ImageLoader by lazy {
        // M5 1.2 起与画布共享进程级实例（D25：同内存缓存 + 同磁盘缓存 journal；
        // 配置原样搬进 SharedCoil，行为不变）
        SharedCoil.get(context)
    }

    private val images = mutableListOf<ImageItem>()
    private var currentIndex = 0
    private var isAnimating = AtomicBoolean(false)
    private var isImmersive = false
    /**
     * 沉浸态系统栏接管回调（宿主注入，2026-10-07 B2 定稿）：true=隐藏系统栏并把窗口色
     * 置黑，false=还原。查看器容器恒**真全屏**（不吃 insets，见 MainActivity 组合根），
     * 所以翻转系统栏不引起容器 resize——「图片位置上下变动」由此从机制上消失，钉扎只
     * 留作非 e2e 窗口（低版本会真 resize）的兜底。
     */
    var onImmersiveBarsChange: ((Boolean) -> Unit)? = null
    /**
     * 状态栏高度（权威值，只信窗口 insets）。B2 后查看器容器顶=窗口顶（真全屏），顶栏
     * 必须自补这段，否则标题/按钮钻进状态栏与挖孔区；不读 `status_bar_height` 资源
     * （被挖孔顶高，avd_honor29 实测 182 vs 实际 90）。
     * 沉浸期间 insets 归零——**冻结上一个真值**，否则顶栏会在滑出途中被抽掉一截。
     */
    private var statusBarInsetPx = 0
    private var slideshowIntervalMs = 5000L
    private var slideshowTransition = "fade"
    private var slideshowRandom = false
    private var slideshowZoom = false
    /** 当前挂载的幻灯片全屏覆盖层；非 null 表示幻灯片正在播放。 */
    private var slideshowView: SlideshowView? = null
    private var rotationDegrees = 0
    // 主题：true=深色，false=浅色。开关来自宿主传入的 options("isDark")，与 Compose 侧
    // AuroraTheme(darkTheme=) 同一个值；颜色一律走 AuroraPalette 那张唯一的表。
    private var isDarkTheme = false
        set(value) {
            field = value
            palette = AuroraPalettes.of(value)
        }
    private var palette: AuroraPalette = AuroraPalettes.of(isDarkTheme)
    // 查看器是否打开（open 时设 true，close 时设 false）
    private var isOpen = false

    // —— 内容区钉扎（2026-10-06 报障：沉浸切换隐藏/恢复系统栏的窗口 resize 分两段落位
    // （avd_honor29 实测底部先收、顶部后收），图片在变高/变矮的容器里各重居中一次，
    // 肉眼可见「先下后上」。把图片双 buffer 与顶栏/缩略图条/底部信息的可用区用锚矩形
    // 钉住：系统栏被隐藏期间黑底向四周扩展，各视图的屏幕位置与尺寸逐帧不变（10-07
    // 真机报障「退出沉浸后顶部文件名跳动」= 顶栏随窗口顶边分段回落，一并由钉扎消除）
    // ——ZoomableImageView 视图尺寸恒定，onSizeChanged 不触发 resetToCenter，缩放
    // 状态也不丢）——
    private var imageAnchorTopAbs = 0
    private var imageAnchorBottomAbs = 0
    private var imageAnchorValid = false
    // 锚时刻各钉扎子视图的本地 top/bottom（还原分段中按锚绝对矩形回摆）
    private class ChromePin(val view: View, val top: Int, val bottom: Int)
    private val chromePins = ArrayList<ChromePin>()
    // 切换保持期：切换/还原的 resize 分段期间（实测 ~1s，MagicUI 更碎）onLayout 禁止
    // 重锚，否则还原半程又按中途几何重居中一次。3s > 任何实测分段落位时长。
    private var imagePinHoldUntil = 0L

    /**
     * 加载代号（[loadIntoView] 每轮递增）。Coil 的 lambda target 请求不挂在视图的
     * requestManager 上（RealImageLoader.enqueue 只登记 ViewTarget），翻页/重载不会
     * 取消它们——快速连续翻页时上一张图的缩略图/高清图回调可能迟于本轮落地。
     * 回调比对视图上的 [ZoomableImageView.boundLoadGeneration]，代号不符整体作废，
     * 防止旧图被画到新图上。
     */
    private var loadGeneration = 0

    /**
     * LAN 编辑门禁位（M6a 阶段 6，allow_edit）：直通时 LAN 项才出现删除入口（顶栏删除键
     * + 「更多」菜单项），403 门禁态两者都隐（门禁关闭时删除对远端不可用）。var + 宿主
     * 写入而非构造参：实例跟 Activity 走（Coil 缓存不随进出查看器重建），门禁位随每次
     * 目录 browse 尾随同步，宿主在组合/更新时把最新值推进来即可（setSlideshow 同款先例）。
     */
    var lanAllowEdit: Boolean = false

    private fun colorBg() = palette.main
    // colorPanel 不在此处私有定义：DialogTheme 接口已带默认实现（palette.panel 同值），
    // Kotlin 里私有成员与父类同签名共存会被拒（VIRTUAL_MEMBER_HIDDEN），删掉后调用点
    // 落回接口默认实现，语义零变化。
    override fun isDarkTheme(): Boolean = isDarkTheme
    override fun colorBorder(): Int = palette.border
    override fun colorTextPrimary(): Int = palette.textPrimary
    override fun colorTextSecondary(): Int = palette.textSecondary
    override fun colorAccent(): Int = palette.primary
    override fun colorTagBg(): Int = palette.tagBg
    override fun colorTagText(): Int = palette.tagText
    override fun colorTagBorder(): Int = palette.tagBorder
    override fun colorTextBoxBg(): Int = palette.textBoxBg
    override fun colorDialogBg(): Int = palette.dialogBg
    override fun colorMenuBg(): Int = palette.menuBg
    override fun colorButtonSecondaryBg(): Int = palette.buttonSecondaryBg
    override fun colorButtonSecondaryText(): Int = palette.buttonSecondaryText
    // 提示文本颜色（比次文字更淡，纯色无透明度）
    override fun colorHint(): Int = palette.hint
    override fun colorDanger(): Int = palette.danger
    /** 主背景上加一层透明度（顶栏 / 缩略图条 / 底信息条的半透底） */
    private fun colorBgAlpha(alpha: Int): Int = withAlpha(palette.main, alpha)
    /** 抽屉预览图的占位底 */
    private fun colorPlaceholder() = palette.placeholderBg
    /** 主色调提取中的脉冲骨架块 */
    private fun colorSkeleton() = palette.skeletonBg
    /** 色块描边 */
    private fun colorHairline() = palette.hairline

    var listener: Listener? = null

    // UI 引用
    private val primaryView: ZoomableImageView
    private val secondaryView: ZoomableImageView // 用于切换动画时的另一张
    private val progressBar: ProgressBar
    private val topBar: LinearLayout
    lateinit private var titleView: TextView
    lateinit private var moreBtn: ImageView
    lateinit private var slideshowBtn: ImageView
    // 旋转/图片信息钮提成成员：竖屏收敛（applyTopBarFormFactor）要在 buildTopBar 之外
    // 按形制重设可见性，不能停留在 buildTopBar 的局部 val（slideshowBtn/deleteBtn 先例）。
    lateinit private var rotateBtn: ImageView
    lateinit private var infoBtn: ImageView
    lateinit private var deleteBtn: ImageView
    private val bottomInfo: LinearLayout
    private val bottomInfoText: TextView
    private val thumbnailStrip: RecyclerView
    private val thumbnailAdapter: ThumbnailStripAdapter
    // 抽屉引用
    private val metadataDrawer: LinearLayout
    private val drawerScrollView: ScrollView
    private val drawerContainer: LinearLayout
    /** 拖拽把手条：竖屏底部面板形制的滑动暗示（横屏右缘抽屉形制下 GONE） */
    private val drawerHandleStrip: LinearLayout
    private val drawerHandleView: View
    private val drawerPreviewImage: android.widget.ImageView
    private val drawerNameView: TextView
    private val drawerFolderView: TextView
    private val drawerPaletteLayout: LinearLayout
    /** Section 4 标题（M6b 阶段 3：LAN 项随内容一起整节隐藏）。 */
    private lateinit var drawerPaletteTitleView: View
    private val drawerDetailsGrid: GridLayout
    private val drawerTagsLayout: LinearLayout
    private val drawerDescView: TextView
    /** Section 8 的容器：来源网址可以有多条（P1(b)），每条一行，空时显示一行斜体 hint。 */
    private val drawerSourceUrlLayout: LinearLayout
    /** M6b 阶段 2：AI 分析节（标题+内容整体隐藏/显示；无 AI 数据时整节不占位）。 */
    private lateinit var drawerAiSection: LinearLayout
    private lateinit var drawerAiLayout: LinearLayout
    private var drawerOpen = false
    /** 正在提取主色调的 fileId，非 null 时抽屉显示 loading 占位 */
    private var loadingPaletteFileId: String? = null
    /**
     * 用户设置：浏览时自动提取主色调。开启时 palette 为空显示 loading 而非按钮。
     * 提取本身由宿主（ViewerLayerHost/MainActivity）驱动——查看器只表达显示态。
     * M6b 阶段 3 起宿主可写（此前 React 壳经 updateItem 同步，原生壳用属性直写）。
     */
    var autoExtractPalette = false
    /**
     * 桌面词表快照（M6b 阶段 5 / D40：GET /api/vocab）：LAN 项标签编辑弹窗的建议源
     *（本地项维持无词表现状）。实例跟 Activity 走，宿主在组合时推进（autoExtractPalette 同款）。
     */
    var lanVocab: List<String> = emptyList()
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
    /**
     * 抽屉视觉进度（0=关闭, 1=打开）的权威值，applyDrawerProgress 每帧写入。
     * 横屏与 ZoomableImageView.drawerFillProgress 保持同步（图片分栏压缩渲染消费它）；
     * 竖屏底部面板是纯覆盖层、不碰图片（drawerFillProgress 恒 0，面板开着时双击缩放/
     * 换图 resetToCenter 仍按 fit 走，不会被面板进度带成 fill 裁剪），面板进度只记这里。
     * 跟手起始（onTouchDown）与 toggleDrawer 的动画起点必须读它——竖屏若读
     * drawerFillProgress 恒得 0，松手后继续拖会被方向限制钳在 0 跟丢手指。
     */
    private var drawerPanelProgress = 0f
    /** 当前已应用的抽屉形制（null=尚未应用过）；与 isCompactPortrait 不一致即重设（幂等短路用）。 */
    private var drawerFormPortrait: Boolean? = null
    /** 竖屏形制因根视图尚无尺寸（首次 open 时 GONE 未布局，2/3 高算不出）而挂起，onSizeChanged 补应用。 */
    private var drawerFormFactorPending = false
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
            setBackgroundColor(colorBgAlpha(0xCC))
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
            setBackgroundColor(colorBgAlpha(0xE6))
            setPadding(24, 12, 24, 12)
            visibility = GONE
        }
        addView(thumbnailStrip)

        // 元数据抽屉，默认横屏形制：右缘 320dp（宽 20rem，对齐 MetadataPanel）。
        // 竖屏底部面板形制（全宽×根高 2/3、钉底、圆角）由 applyDrawerFormFactor 幂等切换，
        // 首次布局/onConfigurationChanged/open() 都会走到。
        val drawerWidthPx = (resources.displayMetrics.density * 320).toInt()
        metadataDrawer = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = LayoutParams(drawerWidthPx, LayoutParams.MATCH_PARENT).apply {
                gravity = android.view.Gravity.END or android.view.Gravity.TOP
            }
            setPadding((resources.displayMetrics.density * 16).toInt(), (resources.displayMetrics.density * 16).toInt(), (resources.displayMetrics.density * 16).toInt(), (resources.displayMetrics.density * 16).toInt())
            translationX = drawerWidthPx.toFloat() // 初始屏幕外
            // 消费触摸事件，防止穿透到下层 ZoomableImageView
            isClickable = true
            isFocusable = true
        }
        // 面板顶缘拖拽条（M8b-9 用户拍板：从面板顶部——把手区——往下滑同样关闭）：
        // 视觉把手 32×4dp 外扩为 32dp 高整宽触控条（触控热区达标）。条排在
        // drawerScrollView 之前——拖它不会带动内容滚动；LinearLayout 里 GONE 不占位，
        // 横屏右缘抽屉内容排布零变化。拖拽跟手逻辑见 setupHandleDrag。
        // 显隐只切条（drawerHandleStrip）：内层把手 View 恒 VISIBLE——M8b-9 曾把
        // GONE 留在内层导致竖屏把手消失（M8b-10 用户报）。orientation 必须显式
        // HORIZONTAL：LinearLayout 默认横排，配合 CENTER 条内把手水平居中。
        drawerHandleStrip = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = android.view.Gravity.CENTER
            // 高度 32→20dp（2026-10-07 用户：竖屏抽屉「文件名上方的操作区太高」）。
            // 热区仍是整宽 1080px×60px，拖拽手感不受影响；把手 4dp 居中，上下各留 8dp。
            layoutParams = LinearLayout.LayoutParams(
                LayoutParams.MATCH_PARENT,
                (resources.displayMetrics.density * DRAWER_HANDLE_STRIP_DP).toInt(),
            )
            visibility = GONE
            isClickable = true
        }
        drawerHandleView = View(context).apply {
            layoutParams = LinearLayout.LayoutParams(
                (resources.displayMetrics.density * 32).toInt(),
                (resources.displayMetrics.density * 4).toInt(),
            )
        }
        drawerHandleStrip.addView(drawerHandleView)
        setupHandleDrag()
        metadataDrawer.addView(drawerHandleStrip)
        // 抽屉背景唯一出处（M8b-8）：构建、applyTheme 重涂、applyDrawerFormFactor 换形制
        // 三处共用，不再各自 setBackgroundColor/重建背景——否则深浅色切换或换形制会把
        // 渐变边/顶部圆角互相抹掉
        applyDrawerBackground()
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
            setBackgroundColor(colorPlaceholder())
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
        // LAN 项整节隐藏（M6b 阶段 3，颜色库键语义=file_id 只覆盖本地文件，与 AI 节「LAN
        // 恒不出现」同款）；标题存引用供 updateDrawer 按 item.isLan 切换可见性。
        buildSectionTitle("主色调", iconRes = R.drawable.ic_lucide_palette).also {
            drawerPaletteTitleView = it
            drawerContainer.addView(it)
        }
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
            // 不开 useDefaultMargins：格子现在是写死的列宽（两列正好铺满内容宽），
            // 默认 margin 会把第二列挤出去。列间距由每格自身的右内边距给。
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

        // Section 8: 来源网址（可多条，每条一行；点任意一行进编辑弹窗）
        drawerContainer.addView(buildSectionTitle("来源网址", iconRes = R.drawable.ic_lucide_globe))
        drawerSourceUrlLayout = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply {
                bottomMargin = (resources.displayMetrics.density * 16).toInt()
            }
        }
        drawerContainer.addView(drawerSourceUrlLayout)

        // Section 9: AI 分析（M6b 阶段 2；无 AI 数据整节 GONE）。标题+内容包一层便于整节隐藏
        drawerAiSection = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT)
            visibility = View.GONE
        }
        drawerAiSection.addView(buildSectionTitle("AI 分析", iconRes = R.drawable.ic_lucide_info))
        drawerAiLayout = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply {
                bottomMargin = (resources.displayMetrics.density * 16).toInt()
            }
        }
        drawerAiSection.addView(drawerAiLayout)
        drawerContainer.addView(drawerAiSection)

        addView(metadataDrawer)

        setupZoomableListeners(primaryView)
        setupZoomableListeners(secondaryView)
    }

    /**
     * 竖屏手机形制判定：窄宽（screenWidthDp<600，ui/FormFactor.kt 的 isCompactWidth）
     * + 竖屏双条件，与图库 TopBar.kt:253 的 isPhonePortrait 同一套判据——横屏手机宽
     * ≥600dp 不收敛，平板 7 钮直挂零回归。get() 实时读 configuration：查看器实例随
     * Activity 存活（manifest 声明 orientation|screenSize configChanges，旋转不重建），
     * 构造时判一次会在旋转后过期。
     */
    private val isCompactPortrait: Boolean
        get() = com.aurora.gallery.kotlin.ui.isCompactWidth(resources.configuration) &&
            resources.configuration.orientation == android.content.res.Configuration.ORIENTATION_PORTRAIT

    /**
     * 抽屉开合行程（px）：横屏=右缘抽屉宽 320dp（沿 X 轴滑入滑出），竖屏=底部面板高
     * =根高×2/3（沿 Y 轴上滑/下滑）。实时计算不缓存：竖屏行程跟根高走，旋转后必须取
     * 新值（用户拍板：2/3 用根 View 实际高，不写死 dp）。根视图还没量出尺寸时退化用
     * 屏幕高的 2/3——只发生在布局前的落位，onSizeChanged 后 applyDrawerFormFactor 的
     * params 比对会以真实根高纠正。
     */
    private val drawerExtentPx: Int
        get() {
            if (!isCompactPortrait) return (resources.displayMetrics.density * 320).toInt()
            val h = height
            return if (h > 0) h * 2 / 3 else resources.displayMetrics.heightPixels * 2 / 3
        }

    /**
     * 按竖屏形制收敛/展开顶栏次级钮（幻灯片/旋转/图片信息）。删除键的显隐不在这里管：
     * 它要叠加 LAN 编辑门禁（updateTitle），两处各写一半会互相覆盖，归 updateTitle 一处。
     * 收敛用 GONE 而非不 addView：slideshowBtn/deleteBtn 是 lateinit 成员，
     * updateSlideshowButtonIcon、applyTheme 的 childCount 遍历、沉浸/抽屉动画都握着引用，
     * GONE 后 FrameLayout/LinearLayout 遍历 childCount 仍安全。
     */
    private fun applyTopBarFormFactor() {
        if (!this::slideshowBtn.isInitialized) return
        val collapsed = isCompactPortrait
        slideshowBtn.visibility = if (collapsed) GONE else VISIBLE
        rotateBtn.visibility = if (collapsed) GONE else VISIBLE
        infoBtn.visibility = if (collapsed) GONE else VISIBLE
    }

    /**
     * 抽屉背景唯一出处（M8b-8）。按形制给：
     * - 横屏/平板：左缘分隔线渐变（LEFT_RIGHT，border→panel），即原构建时写死的那个；
     * - 竖屏：panel 实色 + 顶部两角 16dp 圆角（底部直角贴屏幕边，用户拍板：不用渐变边）。
     * 把手条的着色也归这里（colorBorder 随主题），深浅色切换一并重涂。
     */
    private fun applyDrawerBackground() {
        if (isCompactPortrait) {
            // 纯平直角面板（M8b-10 用户拍板：顶部圆角去掉）——面板全宽钉底，与顶部
            // 图片带平直衔接；单一 panel 实色，无描边无圆角
            metadataDrawer.background = android.graphics.drawable.GradientDrawable().apply {
                setColor(colorPanel())
            }
        } else {
            metadataDrawer.background = android.graphics.drawable.GradientDrawable().apply {
                orientation = android.graphics.drawable.GradientDrawable.Orientation.LEFT_RIGHT
                setColors(intArrayOf(colorBorder(), colorPanel()))
            }
        }
        drawerHandleView.background = android.graphics.drawable.GradientDrawable().apply {
            setColor(colorBorder())
            cornerRadius = resources.displayMetrics.density * 2
        }
    }

    /**
     * 按形制重设信息抽屉容器（M8b-8，用户拍板）：
     * - 手机竖屏（isCompactPortrait）：底部上滑面板——全宽 × 根高 2/3、gravity BOTTOM、
     *   顶部两角圆角、带拖拽把手条；抽屉是纯覆盖层，图片布局完全不动；
     * - 横屏手机/平板：右缘 320dp × 全高抽屉，原样（零回归）。
     *
     * 与 applyTopBarFormFactor 同款幂等思路，但除形制标志外还要比对 params：旋转后根高
     * 变了，竖屏 2/3 高度必须跟着重算（标志没变、尺寸变了）。根视图尚无尺寸时（首次
     * open() 时 GONE 未布局，height=0）挂起，onSizeChanged 拿到真实尺寸后补应用。
     * 调用点：onConfigurationChanged、open() 末尾、onSizeChanged；init 只上背景。
     */
    private fun applyDrawerFormFactor() {
        val portrait = isCompactPortrait
        val drawerWidthPx = (resources.displayMetrics.density * 320).toInt()
        val lp = metadataDrawer.layoutParams
        // 幂等：形制一致且 params 已是目标值才短路（params 比对是旋转后 2/3 高重算的钩子）
        val paramsMatch = if (portrait) {
            height > 0 && lp.width == LayoutParams.MATCH_PARENT && lp.height == height * 2 / 3
        } else {
            lp.width == drawerWidthPx && lp.height == LayoutParams.MATCH_PARENT
        }
        if (drawerFormPortrait == portrait && paramsMatch && !drawerFormFactorPending) return
        if (portrait && height <= 0) {
            // 2/3 高度依赖根 View 实际高（不写死 dp），还没量出来就先挂起
            drawerFormFactorPending = true
            return
        }
        drawerFormFactorPending = false
        drawerFormPortrait = portrait
        if (portrait) {
            // 竖屏底部面板。图片带复位成「全高、fit 无裁切」基线（progress=0）——压缩与
            // fill 插值由 applyDrawerProgress 竖屏分支按进度重放（M8b-9 用户拍板的让位
            // 语义：面板打开时图片沾满顶部带，同平板图片让位左栏）。进度先于 layoutParams
            // 写（applyDrawerProgress 同款顺序约定：params 触发的下一轮布局里
            // resetToCenter 要读到归零后的 drawerFillProgress）
            primaryView.drawerFillProgress = 0f
            secondaryView.drawerFillProgress = 0f
            primaryView.drawerFullWidth = 0f
            secondaryView.drawerFullWidth = 0f
            primaryView.allowZoom = true
            secondaryView.allowZoom = true
            if (primaryView.layoutParams.width != LayoutParams.MATCH_PARENT) {
                primaryView.layoutParams = LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT)
                secondaryView.layoutParams = LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT)
            }
            metadataDrawer.layoutParams = LayoutParams(LayoutParams.MATCH_PARENT, height * 2 / 3).apply {
                gravity = android.view.Gravity.BOTTOM
            }
        } else {
            // 横屏/平板：右缘抽屉原样。图片压缩宽度不在这里写——抽屉开着时调用方会紧跟
            // applyDrawerProgress 按当前进度重放（含图片压缩），关着时本就该 MATCH_PARENT
            metadataDrawer.layoutParams = LayoutParams(drawerWidthPx, LayoutParams.MATCH_PARENT).apply {
                gravity = android.view.Gravity.END or android.view.Gravity.TOP
            }
        }
        applyDrawerBackground()
        // 把手拖拽条只属于底部面板形制（横屏右缘抽屉无下滑关闭语义）
        drawerHandleStrip.visibility = if (portrait) VISIBLE else GONE
        // 形制决定抽屉顶边是否在窗口顶（横屏全高抽屉要让状态栏），换形制即重算
        applyDrawerTopInset()
        // 位移落回「关闭」位：换了形制/尺寸，旧轴向位移值作废（横屏的 translationX=320
        // 在竖屏全宽面板下会露出一条竖条，反之面板整条悬在屏上）；抽屉开着时调用方
        //（onConfigurationChanged/onSizeChanged）会紧跟 applyDrawerProgress 按当前进度
        // 重放视觉——旋转中态直接落位，不要求动画过渡（用户拍板）
        parkDrawer()
    }

    /**
     * 抽屉归位（关闭位）——**按抽屉自己的实测尺寸**下移/右移，而不是再算一遍
     * `height*2/3`。
     *
     * 真机实锤（2026-10-07 B2-2，荣耀 Magic2 / API29）：要完全藏住必须
     * `translationY == 抽屉高`；而 `height*2/3` 是**按调用时刻的根高**算的，抽屉的
     * layoutParams 高度又是**另一个时刻**写的。进出沉浸时窗口内容帧在 [96,2340]（高
     * 2244）与 [0,2340]（高 2340）之间跳，两次各取一个根高 → 差 96px（状态栏高），
     * 露出 96×2/3 = **64px** 的面板顶边（#2A2A2A=palette.panel，逐行 std=0 的纯色带，
     * 盖住图片；抽屉把手在条下方 42..54px 处，正好被屏幕底边裁掉，所以看着是空条）。
     * 未进过沉浸时根高没变过 → 无错位 → 从不出现，与「只在这台机上、只有进出全屏后才有」
     * 完全吻合。改用自身尺寸后，无论何时调用都精确藏住，错位从机制上不可能。
     */
    private fun parkDrawer() {
        if (isCompactPortrait) {
            metadataDrawer.translationX = 0f
            // 未布局时（height=0）退回按根高估算，避免写成 0 让面板整块露在屏上
            val h = metadataDrawer.height.takeIf { it > 0 } ?: drawerExtentPx
            metadataDrawer.translationY = h.toFloat()
        } else {
            metadataDrawer.translationY = 0f
            val w = metadataDrawer.width.takeIf { it > 0 } ?: drawerExtentPx
            metadataDrawer.translationX = w.toFloat()
        }
    }

    /**
     * 面板顶缘拖拽（M8b-9 用户拍板：从面板顶部——把手区——往下滑同样关闭）。跟手公式
     * 与图片区 onVerticalSwipeDrag 同式（下拖减进度=关、上拖加进度=开），方向限制取
     * 「只许向关闭方向」（条只在面板开着时摸得到），松手按位置过半或下甩速度吸附——
     * 与 onVerticalSwipeEnd 同阈值。条在 drawerScrollView 之前，拖它不会带动内容滚动。
     */
    private fun setupHandleDrag() {
        var startY = 0f
        var startProgress = 0f
        var tracking = false
        var tracker: android.view.VelocityTracker? = null
        drawerHandleStrip.setOnTouchListener { _, event ->
            when (event.actionMasked) {
                android.view.MotionEvent.ACTION_DOWN -> {
                    startY = event.rawY
                    startProgress = drawerPanelProgress
                    tracking = true
                    tracker?.recycle()
                    tracker = android.view.VelocityTracker.obtain()
                    tracker?.addMovement(event)
                    // 取消进行中的抽屉动画，跟手接管（onTouchDown 同款）
                    drawerWidthAnimator?.cancel()
                    drawerWidthAnimator = null
                    true
                }
                android.view.MotionEvent.ACTION_MOVE -> {
                    if (tracking) {
                        tracker?.addMovement(event)
                        val p = (startProgress - (event.rawY - startY) / drawerExtentPx)
                            .coerceIn(0f, startProgress)
                        applyDrawerProgress(p)
                    }
                    true
                }
                android.view.MotionEvent.ACTION_UP, android.view.MotionEvent.ACTION_CANCEL -> {
                    if (tracking) {
                        tracker?.addMovement(event)
                        tracker?.computeCurrentVelocity(1000)
                        val p = (startProgress - (event.rawY - startY) / drawerExtentPx)
                            .coerceIn(0f, startProgress)
                        drawerOpen = !(p < 0.5f || (tracker?.yVelocity ?: 0f) > 500f)
                        animateDrawerTo(drawerOpen, fromProgress = p)
                        tracking = false
                    }
                    tracker?.recycle()
                    tracker = null
                    true
                }
                else -> false
            }
        }
    }

    override fun onConfigurationChanged(newConfig: android.content.res.Configuration?) {
        super.onConfigurationChanged(newConfig)
        // manifest 声明 orientation|screenSize configChanges，查看器打开中旋转时
        // Activity/View 都不重建，只有这里收得到通知——竖屏收敛即时随形制重算，
        // 消除「顶栏维持旧形制、菜单却按新形制出项」的二者不一致（deleteBtn 的
        // 显隐归 updateTitle 一处管，一并重跑；空序列有护栏）。查看器关闭（未
        // attach）时收不到也无需收——open() 末尾的幂等重调兜底。
        applyTopBarFormFactor()
        updateTitle()
        // 抽屉形制跟进（M8b-8）：查看器开着旋转时抽屉直接落位到新形制（右缘抽屉↔底部
        // 面板，不要求动画过渡——用户拍板）；幂等重设，开着时按当前进度重放视觉。
        // 进度读 drawerPanelProgress（面板进度权威值）；横屏形制靠 applyDrawerProgress
        // 横屏分支把图片压缩宽度一起重放。
        applyDrawerFormFactor()
        // 旋转后旧锚属于旧方向：失效自愈为不钉扎（原行为），非沉浸静止后由
        // applyImageAreaPin 重录
        imageAnchorValid = false
        if (drawerOpen) {
            drawerWidthAnimator?.cancel()
            applyDrawerProgress(drawerPanelProgress)
        }
    }

    private fun buildTopBar(): LinearLayout {
        val density = resources.displayMetrics.density
        return LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            // topMargin 8dp + 行高 56dp 对齐图库卡片形制（2026-09-27 验收）。2026-10-07
            // B1 定稿后组合根 statusBarsPadding 常驻（查看器不再隐藏系统栏，组合根
            // padding 不会归零），原生侧**勿**再自加状态栏高度——双重内缩会重演
            // 「顶栏偏低」；也勿读 status_bar_height 资源（被挖孔顶高，avd_honor29
            // 实测 182 vs 实际 90）。
            layoutParams = LayoutParams(LayoutParams.MATCH_PARENT, (density * 56).toInt()).apply {
                gravity = android.view.Gravity.TOP
                topMargin = (density * 8).toInt()
            }
            setBackgroundColor(colorBgAlpha(0x4D))
            // 水平 16dp 对齐图库 TopBar 按钮起点（Row horizontal 8dp + 卡片边 8dp）；原 24px。
            setPadding((density * 16).toInt(), 0, (density * 16).toInt(), 0)
            gravity = android.view.Gravity.CENTER_VERTICAL

            // M8b 阶段 3（遗留 #2）：顶栏各键补中文 contentDescription（TalkBack 可读）。
            val closeBtn = makeIconButton(R.drawable.ic_lucide_arrow_left, contentDescription = "返回") { listener?.onClose() }
            titleView = TextView(context).apply {
                setTextColor(colorTextPrimary())
                textSize = 18f
                gravity = android.view.Gravity.CENTER_VERTICAL or android.view.Gravity.START
                layoutParams = LinearLayout.LayoutParams(0, LayoutParams.MATCH_PARENT, 1f).apply {
                    marginStart = (resources.displayMetrics.density * 4).toInt()
                }
                maxLines = 1
                ellipsize = android.text.TextUtils.TruncateAt.MIDDLE
                setPadding(0, 0, (resources.displayMetrics.density * 8).toInt(), 0)
            }
            // M8b 阶段 3（遗留 #2）：播放钮只服务幻灯片（视频支持 D47 拍板不做），语义
            // 定为「幻灯片播放」而非「播放」；播/停两态的图标与描述由
            // updateSlideshowButtonIcon 随播放态同步。
            slideshowBtn = makeIconButton(R.drawable.ic_lucide_play, contentDescription = "幻灯片播放") { toggleSlideshow() }
            rotateBtn = makeIconButton(R.drawable.ic_lucide_rotate_cw, contentDescription = "旋转") { rotateCurrent() }
            infoBtn = makeIconButton(R.drawable.ic_lucide_info, contentDescription = "图片信息") { toggleDrawer() }
            deleteBtn = makeIconButton(R.drawable.ic_lucide_trash, tintColor = colorDanger(), contentDescription = "删除") { showDeleteConfirmDialog() }
            val shareBtn = makeIconButton(R.drawable.ic_lucide_share, contentDescription = "分享") { shareCurrentImage() }
            moreBtn = makeIconButton(R.drawable.ic_lucide_more_vertical, contentDescription = "更多") { showMoreMenu(moreBtn) }

            addView(closeBtn)
            addView(titleView)
            addView(slideshowBtn)
            addView(rotateBtn)
            addView(infoBtn)
            addView(deleteBtn)
            addView(shareBtn)
            addView(moreBtn)
            // 竖屏手机 7 钮+标题挤爆（标题缩成 m5...png，2026-09-27 验收）：按形制收敛
            // 次级钮，只留 返回|标题|分享|更多；被收动作在「更多」菜单头部补位（showMoreMenu）。
            applyTopBarFormFactor()
        }
    }

    private fun makeImageButton(text: String, onClick: () -> Unit): TextView {
        val density = resources.displayMetrics.density
        val pad = (density * 14).toInt()
        return TextView(context).apply {
            this.text = text
            setTextColor(colorTextPrimary())
            textSize = 24f
            setPadding(pad, pad, pad, pad)
            layoutParams = LinearLayout.LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT)
            setOnClickListener { onClick() }
        }
    }

    /**
     * 顶栏图标按钮构造器。M8b 阶段 3（遗留 #2）：补可选 [contentDescription]——纯图标
     * ImageView 没有文本，此前 TalkBack 只能读出空白，无障碍不可用。默认 null 保持
     * 旧调用行为不变，顶栏各键的中文描述由 buildTopBar 调用处显式给出。
     */
    private fun makeIconButton(
        drawableRes: Int,
        tintColor: Int = colorTextPrimary(),
        contentDescription: String? = null,
        onClick: () -> Unit,
    ): ImageView {
        val density = resources.displayMetrics.density
        // 2026-09-27 验收（触控目标）：固定 48×48dp 命中盒（移动端硬规范下限；原
        // wrap_content+10dp padding = 44dp 视觉=44dp 触控，不达标）。14dp 内边距下
        // ImageView 默认 FIT_CENTER 把 24dp lucide 图标缩到 48−2×14=20dp 视觉——与
        // 图库 TopBarButton 的 20dp 图标 + 48dp 命中盒完全同带。
        val pad = (density * 14).toInt()
        return ImageView(context).apply {
            setImageResource(drawableRes)
            setColorFilter(tintColor)
            setPadding(pad, pad, pad, pad)
            layoutParams = LinearLayout.LayoutParams((density * 48).toInt(), (density * 48).toInt())
            // M8b 阶段 3（遗留 #2）：无障碍语义；null 时维持旧行为（无描述）
            this.contentDescription = contentDescription
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
     * progress 驱动：抽屉位移（轴向/行程随形制，见 [drawerExtentPx]）、图片宽度、填充缩放、
     * topBar/缩略图条/底部信息同步隐藏（全屏样式）。
     *
     * M8b-8 方向化：横屏抽屉与图片分栏（抽屉挤占图片宽度）；竖屏底部面板是纯覆盖层，
     * 图片完全不动（用户拍板）——imageW 压缩、drawerFillProgress、drawerFullWidth、
     * layoutParams 写回、allowZoom 锁全部只走横屏分支，竖屏只位移面板。图片渲染消费的
     * drawerFillProgress 竖屏恒 0：面板开着时双击缩放/换图 resetToCenter 仍按 fit 走；
     * 面板自身进度权威值记 [drawerPanelProgress]（两种形制都写）。
     */
    private fun applyDrawerProgress(progress: Float) {
        drawerPanelProgress = progress
        val extent = drawerExtentPx
        val totalWidth = width.toFloat()
        if (!isCompactPortrait) {
            // 横屏：抽屉从右缘滑入 + 图片宽度压缩（分栏）
            val imageW = (totalWidth - progress * extent).toInt().coerceAtLeast(0)
            // 抽屉位移
            metadataDrawer.translationX = (1f - progress) * extent
            metadataDrawer.translationY = 0f
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
        } else {
            // 竖屏：底部面板从屏幕底外上滑；图片带高度同步压缩到面板让出的顶部——
            // M8b-9 用户拍板的让位语义（平板=图片沾满左栏、竖屏=沾满顶部带）。
            // drawerFillProgress 驱动 fit→fill 插值：开满时图片填满顶部带（宽贴满、
            // 上下居中裁切）；进度先于 params 写，onSizeChanged→resetToCenter 读到
            // 最新值（横屏分支同款顺序约定）。drawerFullWidth 竖屏不写（宽度恒定，
            // fitVw=vw，vh 收缩使 fitS 单调下降无「先降后升」）
            val imageH = (height - progress * extent).toInt().coerceAtLeast(0)
            metadataDrawer.translationY = (1f - progress) * extent
            metadataDrawer.translationX = 0f
            primaryView.drawerFillProgress = progress
            secondaryView.drawerFillProgress = progress
            // 抽屉展开时禁止图片缩放（双击/双指），避免缩放与 drawerFillProgress 填充
            // 逻辑冲突（横屏同款）
            val allowZoom = progress <= 0.01f
            primaryView.allowZoom = allowZoom
            secondaryView.allowZoom = allowZoom
            primaryView.layoutParams = LayoutParams(LayoutParams.MATCH_PARENT, imageH)
            secondaryView.layoutParams = LayoutParams(LayoutParams.MATCH_PARENT, imageH)
        }
        // topBar 向上滑出（沉浸模式下始终保持隐藏，不受抽屉进度影响）。滑出量一律含
        // 容器顶的窗口偏移（=状态栏高度）：B1 后系统栏常驻，只滑 -bottom 会停在状态
        // 栏区内露出按钮（M8b-8「滑一个身位≠移出屏幕」同源教训，横竖屏统一走窗口坐标）。
        if (topBar.height > 0) {
            topBar.translationY = topBarHideTranslation(if (isImmersive) 1f else progress)
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
     * 行程用 [drawerExtentPx]（竖屏=面板高 2/3 根高、横屏=320dp）。竖屏底部面板结束时不
     * 联动系统状态栏、不动背景色、不消费 immersiveBeforeDrawer（用户拍板：纯覆盖层、
     * 底部面板不需要隐藏状态栏，保持简单）；横屏保持原逻辑。
     */
    private fun animateDrawerTo(open: Boolean, fromProgress: Float) {
        val targetProgress = if (open) 1f else 0f
        val portrait = isCompactPortrait
        val extent = drawerExtentPx
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
                if (portrait) {
                    // 竖屏：底部面板纯覆盖层——不隐藏系统状态栏、背景色不动
                    return
                }
                val finalW = if (open) (totalWidth - extent).toInt().coerceAtLeast(0) else LayoutParams.MATCH_PARENT
                primaryView.layoutParams = LayoutParams(finalW, LayoutParams.MATCH_PARENT)
                secondaryView.layoutParams = LayoutParams(finalW, LayoutParams.MATCH_PARENT)
                if (open) {
                    // 抽屉打开：系统栏本就随会话隐藏（2026-10-07 模型），无需也不可再切换
                    // （不改 isImmersive，保留单次点击的沉浸状态）
                } else {
                    // 抽屉关闭：恢复抽屉打开前的沉浸状态。横屏抽屉打开期间不改
                    // isImmersive，也没动过背景与系统栏，这里只需把它落回权威值
                    isImmersive = immersiveBeforeDrawer
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
        // 动画起点读面板进度权威值（M8b-8）：横屏与 drawerFillProgress 同步；竖屏
        // drawerFillProgress 恒 0，读它会让「开着再关」的动画从关闭位跳变
        val currentProgress = drawerPanelProgress
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
            if (!isCompactPortrait) {
                // 横屏：抽屉开着旋转要提前把压缩宽度写进子 View layoutParams（上方注释的
                // 「落后一帧」问题对图片压缩宽度同样成立）
                val imageW = (w - drawerExtentPx).coerceAtLeast(0)
                primaryView.layoutParams = LayoutParams(imageW, LayoutParams.MATCH_PARENT)
                secondaryView.layoutParams = LayoutParams(imageW, LayoutParams.MATCH_PARENT)
            } else {
                // 竖屏：底部面板高=新根高 2/3、图片带高=根高−面板高，都要在本测量 pass
                // 生效（同款落后一帧问题；用 spec 高 h 而非 height 属性——此刻属性还是
                // 旧值）。视觉重放（位移/fill 进度/沉浸联动）由 onSizeChanged 的
                // applyDrawerFormFactor+applyDrawerProgress 完成
                metadataDrawer.layoutParams = LayoutParams(LayoutParams.MATCH_PARENT, h * 2 / 3).apply {
                    gravity = android.view.Gravity.BOTTOM
                }
                val imageH = (h - h * 2 / 3).coerceAtLeast(0)
                primaryView.layoutParams = LayoutParams(LayoutParams.MATCH_PARENT, imageH)
                secondaryView.layoutParams = LayoutParams(LayoutParams.MATCH_PARENT, imageH)
            }
        }
        super.onMeasure(widthMeasureSpec, heightMeasureSpec)
    }

    override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
        super.onLayout(changed, left, top, right, bottom)
        // 状态栏高度随窗口 insets 走（旋转/挖孔/分屏都会变）：每次布局同步一次，值变了
        // 才改 topMargin/padding（幂等，不会与布局互相触发成环）
        syncStatusBarInset()
        // 抽屉停车自愈（B2-2）：关闭态每帧按自身实测尺寸重新归位。params 高度与位移的
        // 写入时机可能跨过一次根高变化（进出沉浸），自愈让错位不可能存活到下一帧。
        // 开着/动画中一律不碰——那两种状态的位移由 applyDrawerProgress 管。
        if (!drawerOpen && drawerWidthAnimator == null && drawerPanelProgress <= 0f) parkDrawer()
        applyImageAreaPin()
    }

    // —— 状态栏高度自补（B2：容器真全屏后由本类自己让位）——

    /**
     * 从窗口 insets 读状态栏高度。归零（沉浸隐藏中 / 尚未 attach）时保留上一个真值——
     * 冻结是刻意的，见 [statusBarInsetPx]。值变了才落 margin/padding。
     */
    private fun syncStatusBarInset() {
        // 沉浸期间 insets 归零——冻结上一真值：按 0 重算会把顶栏**抽上去**一整个状态栏
        //（真机报障「退出沉浸时标题跳动」的同源坑）。
        if (isChromeHidden()) return
        val insets = androidx.core.view.ViewCompat.getRootWindowInsets(this) ?: return
        val statusTop = insets.getInsets(androidx.core.view.WindowInsetsCompat.Type.statusBars()).top
        val loc = IntArray(2)
        getLocationInWindow(loc)
        // ⚠ 关键：**减掉本容器自己在窗口内的顶偏移**。insets 的 statusBars 是相对**窗口**的，
        // 而本容器未必从窗口顶开始——非 e2e 窗口（荣耀 Magic2 / API29 实测）容器顶本就是 96
        //（状态栏让位由窗口完成），再自加 96 就是「双重内缩」→ 顶栏凭空低一整个状态栏
        // （B1 注释早就警告过这条，B2 自补时踩了）。于是顶栏的屏幕顶恒 =
        // max(容器顶, 状态栏底) + 8dp，e2e 与非 e2e 两种窗口下都落在同一位置。
        val need = (statusTop - loc[1]).coerceAtLeast(0)
        if (need != statusBarInsetPx) {
            statusBarInsetPx = need
            applyTopBarTopMargin()
            applyDrawerTopInset()
        }
    }

    /** 顶栏 topMargin = 状态栏高度 + 8dp（8dp 是 2026-09-27 验收的图库卡片形制内缩）。 */
    private fun applyTopBarTopMargin() {
        val lp = topBar.layoutParams as? LayoutParams ?: return
        val want = statusBarInsetPx + (resources.displayMetrics.density * 8).toInt()
        if (lp.topMargin != want) {
            lp.topMargin = want
            topBar.layoutParams = lp
        }
    }

    /**
     * 抽屉顶部让位：横屏/平板的右缘抽屉是全高（顶=窗口顶），内容必须避开状态栏；
     * 竖屏底部面板钉在屏幕下缘、顶边本就在屏内，不加。
     */
    private fun applyDrawerTopInset() {
        val d = resources.displayMetrics.density
        val side = (d * 16).toInt()
        // 竖屏底部面板：顶内边距 16→12dp（与把手条 32→20dp 一起，把「面板顶→文件名」
        // 从 48dp 收到 32dp）。横屏右缘全高抽屉额外让出状态栏（见 statusBarInsetPx）。
        val top = if (isCompactPortrait) (d * DRAWER_TOP_PAD_DP).toInt() else side + statusBarInsetPx
        if (metadataDrawer.paddingTop != top) metadataDrawer.setPadding(side, top, side, side)
    }

    /**
     * 内容区钉扎：非沉浸静止时锚=当前屏幕矩形与各 chrome 子视图的本地矩形（同值赋值
     * 零开销）；系统栏被本查看器隐藏期间（含还原分段中），把图片双 buffer 与缩略图条/
     * 底部信息直接 layout 回各自的锚矩形——窗口分段 resize 时黑底向四周补位，全部内容
     * 的屏幕位置与尺寸逐帧不变（laid-out 尺寸恒定，ZoomableImageView 的 onSizeChanged
     * 不触发，resetToCenter 不重跑，缩放状态也不丢）。用 child.layout 同帧纠偏而非
     * padding/params：不产生 requestLayout 二次遍历，无「先按旧几何摆、下一帧再修正」
     * 的闪烁。幻灯片隐藏系统栏（不改 isImmersive）走同一钉扎。顶栏只在还原分段钉
     * （沉浸期间钉扎会顶住滑出量，见循环内注）。旋转后旧锚属于旧方向：失效自愈为
     * 不钉扎（原行为），非沉浸静止后重录。
     */
    private fun applyImageAreaPin() {
        if (width <= 0 || height <= 0) return
        val loc = IntArray(2)
        getLocationOnScreen(loc)
        val now = android.os.SystemClock.uptimeMillis()
        if (!isChromeHidden() && now >= imagePinHoldUntil) {
            imageAnchorTopAbs = loc[1]
            imageAnchorBottomAbs = loc[1] + height
            chromePins.clear()
            for (v in pinnedChromeChildren()) {
                if (v.height > 0 && v.width > 0) chromePins.add(ChromePin(v, v.top, v.bottom))
            }
            imageAnchorValid = true
        }
        if (!imageAnchorValid) return
        // 抽屉 fill/压缩有自己的图片几何（显式宽高与进度动画），不叠加钉扎
        if (drawerOpen || drawerWidthAnimator != null || drawerPanelProgress > 0f) return
        // 各子视图锚矩形随锚顶边平移回摆；clamp 进当前几何，锚异常时退化为不钉扎
        val deltaY = imageAnchorTopAbs - loc[1]
        for (p in chromePins) {
            // 顶栏在系统栏被本查看器隐藏期间不钉（2026-10-07 荣耀真机回归实锤）：滑出量
            // -topBar.bottom 按自然布局校准，钉扎却把布局按回锚位（+deltaY），两者相减
            // 恰好漏出 ~状态栏高的一条——标题/图标的下缘碎片恒驻沉浸态屏幕顶端。隐藏
            // 期间滑出交还 translationY 全权负责；退出还原分段（!isChromeHidden 且保持
            // 期内）照旧钉住，顶栏在窗口分段回落时逐帧不动（防「文件名跳动」）。
            if (p.view === topBar && isChromeHidden()) continue
            val t = (p.top + deltaY).coerceIn(0, height)
            val b = (p.bottom + deltaY).coerceIn(0, height)
            if (p.view.top != t || p.view.bottom != b) p.view.layout(p.view.left, t, p.view.right, b)
        }
    }

    /** 参与钉扎的 chrome：图片双 buffer + 顶栏 + 缩略图条 + 底部信息（幻灯片覆盖层除外）。 */
    private fun pinnedChromeChildren(): List<View> = listOf(primaryView, secondaryView, topBar, thumbnailStrip, bottomInfo)

    /** 系统栏当前是否由本查看器隐藏（沉浸切换或幻灯片覆盖，二者都不改对方标志）。 */
    private fun isChromeHidden(): Boolean = isImmersive || slideshowHidSystemUi

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        if (w <= 0 || h <= 0) return
        val sizeChanged = w != oldw || h != oldh
        // 抽屉形制跟进（M8b-8）：applyDrawerFormFactor 幂等（形制+params 都匹配才短路），
        // 竖屏 2/3 高度随根高重算；首次 open 挂起的形制（根视图此前 GONE 无尺寸）在这补应用。
        // 关着也要跑：旋转后面板 params 若停留在旧根高的 2/3，重开时会用错高度
        if (sizeChanged || drawerFormFactorPending) {
            drawerWidthAnimator?.cancel()
            applyDrawerFormFactor()
        }
        // 沉浸 chrome 权威重申（2026-10-06 荣耀真机）：尺寸变化时按 isImmersive 瞬时
        // 落位，防止滑出动画被布局时序冻在半程；toggleImmersive 的 postDelayed 是动画
        // 路径的第二道兜底。
        if (sizeChanged && topBar.height > 0) {
            topBar.translationY = topBarHideTranslation(if (isImmersive) 1f else 0f)
            if (isImmersive) {
                if (thumbnailStrip.height > 0) thumbnailStrip.translationY = height.toFloat()
                if (bottomInfo.visibility == VISIBLE) bottomInfo.translationY = height.toFloat()
            }
        }
        if (!drawerOpen) return
        // 抽屉开着时尺寸变化：按当前进度直接落位（旋转中态，无动画——用户拍板）。
        // 进度读 drawerPanelProgress（面板进度权威值，两形制通用；竖屏 drawerFillProgress
        // 恒 0 不能作面板状态）。横屏分支顺带按新宽度重放图片压缩
        if (sizeChanged) {
            applyDrawerProgress(drawerPanelProgress)
        }
        if (topBar.height > 0) {
            topBar.translationY = topBarHideTranslation(if (isImmersive) 1f else 0f)
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

    /**
     * 文件信息的一格。
     *
     * **列宽写死，不用 GridLayout 权重**：权重只在 GridLayout 自己重新测量时才分给子
     * view，而抽屉每次换图都是「往一个已经测过的 GridLayout 里换子 view」——它自己的
     * 测量尺寸不变，于是新加进来的格子停在 0x0。平板探针实测：翻页后开抽屉
     * `cells=[0x0 ×5]` 而 `grid=612x255`（旧尺寸），改成写死列宽后翻页路径正常了。
     * 抽屉内容宽恒为 320dp − 左右各 16dp padding，两列各 144dp。
     *
     * ⚠ 这**没有**修完抽屉延迟显示：退出查看器再进来时格子仍是 0x0（三节一起空），
     * 那条的现场与线索记在 M4a 清单 §8。
     */
    private fun buildDetailCell(label: String, value: String, iconRes: Int? = null): LinearLayout {
        val density = resources.displayMetrics.density
        val cellWidth = ((DRAWER_WIDTH_DP - 32f) / 2f * density).toInt()
        return LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = GridLayout.LayoutParams().apply {
                width = cellWidth
                height = LayoutParams.WRAP_CONTENT
                columnSpec = GridLayout.spec(GridLayout.UNDEFINED, 1)
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
        val previewSrc = if (item.isLan) CoilSource(previewUrl, null, null) else coilSourceOf(item, "preview")
        val req = coilSource(ImageRequest.Builder(context), previewSrc)
            .target(drawerPreviewImage)
            .precision(Precision.INEXACT)
            .build()
        imageLoader.enqueue(req)

        // Section 4: 主色调（圆形色块横排，单行，点击触发颜色搜索）
        // LAN 项整节隐藏：颜色库键语义=file_id 只覆盖本地文件，远端项提取必然失败
        // （M6b 阶段 3，与 AI 分析节「LAN 不出现」同款守门）。
        val paletteVisible = !item.isLan
        drawerPaletteTitleView.visibility = if (paletteVisible) VISIBLE else GONE
        drawerPaletteLayout.visibility = if (paletteVisible) VISIBLE else GONE
        // 显式取消子 view 的动画（AlphaAnimation INFINITE 不会随 removeAllViews 自动停止）
        for (i in 0 until drawerPaletteLayout.childCount) {
            drawerPaletteLayout.getChildAt(i).clearAnimation()
        }
        drawerPaletteLayout.removeAllViews()
        if (paletteVisible) {
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
                        setColor(colorSkeleton())
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
                // 命中区补到 48dp（移动端规范下限；原文字 + 上下 6dp padding 只有约 33dp）
                gravity = Gravity.CENTER
                minHeight = (resources.displayMetrics.density * 48).toInt()
                background = DialogUtils.createRoundedBg(colorTagBg(), 10f, colorTagBorder(), 1f, context)
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
                        setStroke((resources.displayMetrics.density * 1).toInt(), colorHairline())
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
        } // if (paletteVisible)：LAN 项 Section 4 为空，Section 5 起正常渲染

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
            // 与上面「提取主色调」同一条：命中区补到 48dp
            gravity = Gravity.CENTER
            minHeight = (resources.displayMetrics.density * 48).toInt()
            background = DialogUtils.createRoundedBg(colorButtonSecondaryBg(), 10f, colorBorder(), 1f, context)
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

        // Section 8: 来源网址（可多条，逐行；一条都没有时留一行斜体 hint 占位）
        drawerSourceUrlLayout.removeAllViews()
        val urls = item.sourceUrls.ifEmpty { listOf("") }
        urls.forEach { url -> drawerSourceUrlLayout.addView(buildSourceUrlRow(url)) }

        // Section 9: AI 分析（M6b 阶段 2）：场景分类小字 + AI 描述 + AI 标签胶囊。
        // 只读展示（无编辑按钮）——AI 字段的权威源在 aiData，编辑入口归 AI 任务重跑；
        // LAN 项数据层不给 AI 字段（远端契约无 aiData），整节自动隐藏。
        drawerAiLayout.removeAllViews()
        val hasAi = item.aiTags.isNotEmpty() || item.aiDescription.isNotEmpty() || item.aiSceneCategory.isNotEmpty()
        drawerAiSection.visibility = if (hasAi) View.VISIBLE else View.GONE
        if (hasAi) {
            if (item.aiSceneCategory.isNotEmpty()) {
                drawerAiLayout.addView(TextView(context).apply {
                    text = "场景：${item.aiSceneCategory}" +
                        if (item.aiObjects.isNotEmpty()) " · ${item.aiObjects.joinToString("、")}" else ""
                    setTextColor(colorTextSecondary())
                    textSize = 12f
                    layoutParams = LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply {
                        bottomMargin = (resources.displayMetrics.density * 6).toInt()
                    }
                })
            }
            if (item.aiDescription.isNotEmpty()) {
                drawerAiLayout.addView(TextView(context).apply {
                    text = item.aiDescription
                    setTextColor(colorTextPrimary())
                    textSize = 13f
                    setLineSpacing(0f, 1.4f)
                    layoutParams = LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply {
                        bottomMargin = (resources.displayMetrics.density * 6).toInt()
                    }
                })
            }
            if (item.aiTags.isNotEmpty()) {
                val aiTagFlow = LinearLayout(context).apply {
                    orientation = LinearLayout.HORIZONTAL
                    layoutParams = LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT)
                }
                item.aiTags.forEach { tag ->
                    aiTagFlow.addView(TextView(context).apply {
                        text = tag
                        setTextColor(colorTagText())
                        textSize = 11f
                        setPadding(
                            (resources.displayMetrics.density * 10).toInt(),
                            (resources.displayMetrics.density * 6).toInt(),
                            (resources.displayMetrics.density * 10).toInt(),
                            (resources.displayMetrics.density * 6).toInt(),
                        )
                        background = android.graphics.drawable.GradientDrawable().apply {
                            cornerRadius = resources.displayMetrics.density * 14
                            setColor(colorTagBg())
                            setStroke((resources.displayMetrics.density * 1).toInt(), colorTagBorder())
                        }
                        layoutParams = LinearLayout.LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT).apply {
                            marginEnd = (resources.displayMetrics.density * 6).toInt()
                            bottomMargin = (resources.displayMetrics.density * 6).toInt()
                        }
                    })
                }
                drawerAiLayout.addView(aiTagFlow)
            }
        }
        // 修复 M4a §8「抽屉延迟显示」：换图重建子树时查看器可能还没完成重新挂载后的首次
        // 布局（退出再进的 open() 路径，实例是复用的），addView 的 requestLayout 传不到
        // 宿主布局轮次；即便传到了，重新挂载后抽屉 specs 与上轮相同，View.measure 会整个
        // 跳过抽屉子树（实测：drawer.onLayout 有、drawer.onMeasure 无），新格子停在 0x0
        // ——表现为「文件信息/标签/按钮空白一拍，直到沉浸切换改了根尺寸才亮」。
        // 兜底：自己已经量好就直接量摆一遍（幂等）；否则挂一次性布局监听，等本查看器
        // 下一次 layout（重新挂载后的首轮必然发生）再量摆。不用 ViewTreeObserver 的
        // PreDraw：detach/attach 边缘它在哪条 observer 上触发不可靠（实测注册了不触发）。
        removeOnLayoutChangeListener(drawerLayoutFixer)
        if (isLaidOut && width > 0 && height > 0 && !isLayoutRequested) {
            measureAndLayoutDrawerNow()
        } else {
            addOnLayoutChangeListener(drawerLayoutFixer)
        }
    }

    /** 抽屉子树兜底量摆的一次性监听（[updateDrawer] 尾注说明的机制）。 */
    private val drawerLayoutFixer = object : OnLayoutChangeListener {
        override fun onLayoutChange(
            v: View, l: Int, t: Int, r: Int, b: Int,
            oldL: Int, oldT: Int, oldR: Int, oldB: Int,
        ) {
            v.removeOnLayoutChangeListener(this)
            measureAndLayoutDrawerNow()
        }
    }

    /**
     * 主动测量并摆放抽屉子树（[updateDrawer] 的兜底）。
     * forceLayout 必须递归到每个后代：只标抽屉自己不够——中间层（ScrollView/容器/
     * GridLayout）的 specs 与上轮相同、又没有 FORCE_LAYOUT 时，会在各自那一层把
     * measure 跳掉，下探半路就停（实测 open.post 时格子仍 0x0）。
     */
    private fun measureAndLayoutDrawerNow() {
        if (!isAttachedToWindow || width <= 0 || height <= 0) return
        forceLayoutRecursive(metadataDrawer)
        val lp = metadataDrawer.layoutParams
        // spec 取 layoutParams 的确定值（MATCH_PARENT 回退根尺寸）：两形制都从这里量出
        // 最终宽高——横屏宽=320dp/高=全高，竖屏宽=全宽/高=根高 2/3
        val wSpec = MeasureSpec.makeMeasureSpec(if (lp.width >= 0) lp.width else width, MeasureSpec.EXACTLY)
        val hSpec = MeasureSpec.makeMeasureSpec(if (lp.height >= 0) lp.height else height, MeasureSpec.EXACTLY)
        metadataDrawer.measure(wSpec, hSpec)
        if (isCompactPortrait) {
            // 竖屏：钉底——面板上缘 = 根高 − 面板高
            metadataDrawer.layout(0, height - metadataDrawer.measuredHeight, width, height)
        } else {
            metadataDrawer.layout(width - metadataDrawer.measuredWidth, 0, width, metadataDrawer.measuredHeight)
        }
    }

    private fun forceLayoutRecursive(view: View) {
        view.forceLayout()
        if (view is ViewGroup) {
            for (i in 0 until view.childCount) {
                forceLayoutRecursive(view.getChildAt(i))
            }
        }
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
                // 切换成功路径不放触觉反馈（M8b-11 用户报真机每切一张震一下）：翻页是
                // 高频手势，系统相册类应用也不在切换处振动；模拟器无振动马达复现不了，
                // 代码路径两端一致。长按的 LONG_PRESS 触觉保留（低频手势确认，见
                // onLongPressConfirmed）。React 版移植时就带这声振动（M3 284d90113），
                // 模拟器验收从未暴露。
                if (shouldNavigate && dx != 0f) {
                    val adjacentIndex = currentIndex + dir
                    if (swipeAdjacentPrepared && swipeAdjacentDirection == dir && adjacentIndex in 0 until images.size) {
                        navigateFromSwipe(dir)
                    } else if (adjacentIndex in 0 until images.size) {
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
                // 取消正在进行的抽屉动画，跟手接管——取消后必须按权威进度回写
                // drawerOpen：松手判定（onVerticalSwipeEnd/把手拖拽/toggleDrawer）先把
                // drawerOpen 置为目标值再起 280ms 动画，动画若在这里被下一次触摸取消，
                // onAnimationEnd 因 cancelled 早退、面板停在取消时刻的 progress，标志与
                // 视觉就此脱钩（面板视觉已关而 drawerOpen 恒 true），此后所有单击被
                // onSingleTapConfirmed/toggleImmersive 的 drawerOpen 护栏静默吞掉——
                // 真机「点击图片不进全屏且零反应」的根因（2026-10-06 荣耀/华为报障）
                drawerWidthAnimator?.cancel()
                drawerWidthAnimator = null
                drawerOpen = drawerPanelProgress > 0.5f
                // 记录抽屉跟手起始状态，供 onVerticalSwipeDrag/End 使用。
                // 进度读 drawerPanelProgress（面板进度权威值）：竖屏 drawerFillProgress
                // 恒 0，读它会让松手后的继续拖动被方向限制钳在 0 跟丢手指
                drawerDragStartOpen = drawerOpen
                drawerDragStartProgress = drawerPanelProgress
                if (!drawerOpen) {
                    // 可能即将通过垂直手势打开抽屉——保存沉浸状态
                    immersiveBeforeDrawer = isImmersive
                }
            }
            override fun onSingleTapConfirmed() {
                Log.i("NativeViewer", "onSingleTapConfirmed: drawerOpen=$drawerOpen isImmersive=$isImmersive isOpen=$isOpen")
                if (drawerOpen) return
                // 幻灯片播放时本视图被 SlideshowView 覆盖，不会收到此回调
                toggleImmersive()
            }
            override fun onVerticalSwipeDrag(dy: Float) {
                if (isAnimating.get()) return
                // 行程随形制（M8b-8）：横屏=320dp（右缘抽屉），竖屏=根高 2/3（底部面板）。
                // 轴向虽不同，progress 语义一致：上滑（dy<0）→ progress 增大 → 抽屉打开，
                // 下滑（dy>0）→ 关闭——竖屏面板从屏底外上滑，方向天然成立
                var progress = (drawerDragStartProgress - dy / drawerExtentPx).coerceIn(0f, 1f)
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
                var currentProgress = (drawerDragStartProgress - dy / drawerExtentPx).coerceIn(0f, 1f)
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
                // M4b 6.1 收口：长按仅保留触感反馈——查看器的全部操作已在「⋮」菜单
                // 承载（删除/重命名/复制到/移动到/幻灯片），无独立的上下文菜单需求
                //（桌面查看器也无长按菜单同位项）。
                performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
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
                when {
                    slideshowView != null -> slideshowView?.exit()
                    drawerOpen -> closeDrawer()
                    isOpen -> listener?.onClose()
                }
            }
            return true
        }
        return super.dispatchKeyEvent(event)
    }

    /** 抽屉是否打开（供 MainActivity onBackPressed 查询）。 */
    fun isDrawerOpen(): Boolean = isOpen && drawerOpen

    /** 当前序列里第 [index] 张的 fileId（宿主用它把 viewingFileId 跟到正在看的那张）。 */
    fun fileIdAt(index: Int): String? = images.getOrNull(index)?.fileId

    /** 幻灯片是否正在播放（供 MainActivity onBackPressed 查询）。 */
    fun isSlideshowPlaying(): Boolean = slideshowView != null

    /**
     * 退出幻灯片。走 SlideshowView 自己的 exit 而不是 [setSlideshow]`(false)`：
     * 后者只摘覆盖层，会把幻灯片已经翻到的位置丢掉。
     */
    fun exitSlideshow() {
        slideshowView?.exit()
    }

    /** 收起抽屉（供外部调用）。 */
    fun closeDrawer() {
        if (!drawerOpen) return
        toggleDrawer()
    }

    /** 查看器是否已打开。 */
    fun isOpen(): Boolean = isOpen

    /** 当前是否处于沉浸（真全屏）态。宿主从后台回前台时据此重申系统栏。 */
    fun isImmersiveNow(): Boolean = isImmersive

    /**
     * 外部强制设定沉浸态（同值/抽屉开着时短路）。走 [toggleImmersive] 同一条路径——
     * 背景、系统栏、chrome 滑出三件事必须一起动，不能各写一半。
     */
    fun setImmersive(enabled: Boolean) {
        if (enabled == isImmersive) return
        if (drawerOpen) return
        toggleImmersive()
    }

    /** 打开查看器，显示 [startIndex] 位置的图片。 */
    fun open(images: List<ImageItem>, startIndex: Int, options: JSONObject?) {
        Log.i("NativeViewer", "open called: images=${images.size}, startIndex=$startIndex, options=$options, alreadyOpen=$isOpen, currentIdx=$currentIndex")
        // 上次会话的沉浸态残留检测：实例跨打开复用（Coil 缓存随实例走），若上次经
        // 兜底 BackHandler 之外任何未走 close() 的路径退出，isImmersive=true、顶栏
        // 停在滑出位、系统状态栏残留隐藏会全部带进本次（真机报障：重开查看器状态
        // 栏已被隐藏）。isOpen（查看器开着被重入）时不属于残留，不动。
        val staleImmersive = !isOpen && isImmersive
        val skipReload = isOpen && startIndex == currentIndex && this.images.size == images.size
        this.images.clear()
        this.images.addAll(images)
        this.currentIndex = startIndex.coerceIn(0, images.size - 1)
        this.rotationDegrees = 0
        this.isOpen = true
        var autoStartSlideshow = false
        options?.optJSONObject("slideshow")?.let { sl ->
            autoStartSlideshow = sl.optBoolean("enabled", false)
            slideshowIntervalMs = sl.optLong("interval", 5000L)
            slideshowTransition = sl.optString("transition", "fade")
            slideshowRandom = sl.optBoolean("isRandom", false)
            slideshowZoom = sl.optBoolean("enableZoom", false)
        }
        // 主题
        if (options?.has("isDark") == true) {
            isDarkTheme = options.optBoolean("isDark", false)
            applyTheme()
        }

        thumbnailAdapter.submit(images, currentIndex)

        visibility = VISIBLE
        alpha = 1f
        requestFocus()
        if (staleImmersive) {
            Log.w("NativeViewer", "open: stale immersive state leaked from previous session, restoring chrome")
            isImmersive = false
            topBar.translationY = 0f
            thumbnailStrip.translationY = 0f
            if (bottomInfo.visibility == VISIBLE) bottomInfo.translationY = 0f
            setBackgroundColor(colorBg())
            // 系统栏一并还原：残留的那次沉浸把栏藏了，宿主侧的隐藏标记也要跟着清
            onImmersiveBarsChange?.invoke(false)
        }
        if (skipReload) {
            Log.i("NativeViewer", "open: skipping reload, already at index $currentIndex (onNavigate re-entry)")
        } else {
            loadCurrent(animateIn = false)
        }
        // 竖屏收敛随形制重算：实例随 Activity 存活（manifest configChanges 不重建），
        // buildTopBar 构造时判的可见性在「关着查看器旋转再打开」后会过期；幂等重设。
        applyTopBarFormFactor()
        // 抽屉形制幂等重设（M8b-8）：同顶栏「构造时判的形制会过期」；竖屏 2/3 高度依赖
        // 根尺寸，首次 open 根视图 GONE 未布局时挂起，onSizeChanged 补应用
        applyDrawerFormFactor()
        updateTitle()
        if (autoStartSlideshow) setSlideshow(true)
    }

    /**
     * M8b 阶段 3（遗留 #5，D26 边界登记项销账）：主题档变化时由宿主（MainActivity 的
     * 主题 SideEffect）即时推进——此前色值只存进 viewerOptions、等下次 [open] 才经
     * [applyTheme] 生效，查看器开着切主题（跟随系统的深浅档在查看器前台时被切换）
     * 就得「收掉重开才换色」。
     *
     * 实现：先写 [isDarkTheme]（顺带切 palette），已打开才补 [applyTheme] 全量重涂
     * （未打开时无需重涂，open() 本就会按 options 重放主题）。同值幂等短路：宿主
     * SideEffect 在每次重组都会跑，不短路会把 updateDrawer/Coil 请求整体重放。
     */
    fun applyThemeNow(dark: Boolean) {
        if (dark == isDarkTheme) return
        isDarkTheme = dark
        if (!isOpen) return
        applyTheme()
    }

    /** 应用当前主题到所有 UI 元素。 */
    private fun applyTheme() {
        // 沉浸态背景恒黑（翻页/切主题的重涂不该把剧场态刷回主题色）
        setBackgroundColor(if (isImmersive) Color.BLACK else colorBg())
        // 顶栏/底栏/缩略图条背景
        topBar.setBackgroundColor(colorBgAlpha(0x4D))
        bottomInfo.setBackgroundColor(colorBgAlpha(0xCC))
        thumbnailStrip.setBackgroundColor(colorBgAlpha(0xE6))
        // 顶栏所有文字（按钮+标题）
        titleView.setTextColor(colorTextPrimary())
        for (i in 0 until topBar.childCount) {
            when (val child = topBar.getChildAt(i)) {
                is TextView -> child.setTextColor(colorTextPrimary())
                is ImageView -> child.setColorFilter(colorTextPrimary())
            }
        }
        // 删除按钮保持红色（覆盖上面的统一着色）
        if (this::deleteBtn.isInitialized) {
            deleteBtn.setColorFilter(colorDanger())
        }
        bottomInfoText.setTextColor(colorTextPrimary())
        // 抽屉（M8b-8：重涂收敛到 applyDrawerBackground——原 setBackgroundColor(纯色) 会把
        // 横屏渐变边/竖屏顶部圆角抹掉；把手条颜色也随主题走）
        applyDrawerBackground()
        drawerNameView.setTextColor(colorTextPrimary())
        drawerFolderView.setTextColor(colorTextSecondary())
        drawerPreviewImage.setBackgroundColor(colorPlaceholder())
        thumbnailAdapter.placeholderColor = palette.surface
        drawerDescView.setTextColor(colorTextPrimary())
        drawerDescView.setHintTextColor(colorHint())
        drawerDescView.background = android.graphics.drawable.GradientDrawable().apply {
            cornerRadius = resources.displayMetrics.density * 8
            setColor(colorTextBoxBg())
            setStroke((resources.displayMetrics.density * 1).toInt(), colorBorder())
        }
        // 来源网址是动态行数，逐行重涂（条数随图片变，不能只涂写死的那一行的引用）
        repeat(drawerSourceUrlLayout.childCount) { i ->
            val row = drawerSourceUrlLayout.getChildAt(i) as? TextView ?: return@repeat
            row.setTextColor(colorAccent())
            row.setHintTextColor(colorHint())
            row.background = android.graphics.drawable.GradientDrawable().apply {
                cornerRadius = resources.displayMetrics.density * 8
                setColor(colorTextBoxBg())
                setStroke((resources.displayMetrics.density * 1).toInt(), colorBorder())
            }
        }
        // 重新刷新当前图片的抽屉内容（标题色块等会用到主题色）
        images.getOrNull(currentIndex)?.let { updateDrawer(it) }
    }

    fun close() {
        cleanupSlideshow()
        cleanupSwipeAdjacentImmediate()
        activeView.animate().cancel()
        activeView.translationX = 0f
        // 清除图片以停止 animated WebP/GIF 帧动画，避免关闭后仍消耗 CPU
        primaryView.setImageDrawable(null)
        secondaryView.setImageDrawable(null)
        isOpen = false
        // 清除主色调 loading 状态，防止下次打开时残留
        loadingPaletteFileId = null
        // 清除自动提取失败记录，下次打开重新尝试
        failedPaletteFileIds.clear()
        // 取消抽屉宽度动画并重置视觉状态（可能正在动画中）
        drawerWidthAnimator?.cancel()
        drawerWidthAnimator = null
        metadataDrawer.animate().cancel()
        // 关闭位按形制落轴（M8b-8）：竖屏面板藏屏幕下方（行程=面板自身高），横屏抽屉藏
        // 右缘（行程=面板自身宽）——竖屏形制只写 translationX=320 会留一条全宽面板竖在
        // 屏内。位移一律取抽屉自身实测尺寸（见 parkDrawer），不重算根高 2/3
        parkDrawer()
        primaryView.layoutParams = LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT)
        secondaryView.layoutParams = LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT)
        // 重置填充进度，下次打开时从 fit 开始
        primaryView.drawerFillProgress = 0f
        secondaryView.drawerFillProgress = 0f
        // 面板进度权威值同步归零（面板已落回关闭位）
        drawerPanelProgress = 0f
        // 恢复缩放许可（抽屉已关闭）
        primaryView.allowZoom = true
        secondaryView.allowZoom = true
        // B2：系统栏由本类按沉浸态自行接管（不再是会话模型），关闭时必须还原——
        // 否则「沉浸中退出查看器」会把隐藏的系统栏带进网格。
        onImmersiveBarsChange?.invoke(false)
        // drawerOpen 清零仍须在背景色还原之前：横屏抽屉打开不改 isImmersive，
        // 背景色分支依赖最终标志位。
        isImmersive = false
        drawerOpen = false
        // 沉浸模式背景为黑色，关闭时还原主题色，避免下次打开残留黑色
        setBackgroundColor(colorBg())
        topBar.translationY = 0f
        thumbnailStrip.translationY = 0f
        bottomInfo.translationY = 0f
        visibility = GONE
    }

    fun destroy() {
        cleanupSlideshow()
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

    /**
     * 大图数据源（D8 A 案）。本地 `content://` 一律由宿主开流喂给 Coil，
     * 不让 URI 进解码器——理由见 [imageSourceFor]。
     */
    private fun coilSourceOf(item: ImageItem, variant: String = "full"): CoilSource =
        imageSourceFor(item, context.contentResolver, variant)

    private fun loadCurrent(animateIn: Boolean) {
        loadIntoView(activeView, currentIndex)
        preloadNeighbors()
    }

    private fun loadIntoView(view: ZoomableImageView, index: Int, rotation: Int = rotationDegrees, showProgress: Boolean = true) {
        val item = images.getOrNull(index) ?: return
        if (showProgress) progressBar.visibility = VISIBLE
        Log.i(TAG, "loadIntoView: index=$index, name=${item.name}, isLan=${item.isLan}, path=${item.path}, thumbUrl=${item.thumbnailUrl}")

        // 本轮请求代号：写进视图，迟到的过期回调（上一张图的缩略图/高清图）据此作废
        val generation = ++loadGeneration
        view.boundLoadGeneration = generation
        view.isFullResShown = false

        // 先加载缩略图（如果有），再加载原图
        val thumbUrl = item.thumbnailUrl
        if (!thumbUrl.isNullOrEmpty()) {
            val thumbRequest = ImageRequest.Builder(context)
                .data(thumbUrl)
                // lambda target + 守卫，不再用 .target(view)（ImageViewTarget 会绕过守卫
                // 直接上屏）：预加载已把高清图送进内存缓存时，高清图先到、缩略图后到，
                // 迟到的缩略图会把已显示的高清图覆盖回低清——就是「切页后永远停在缩略图」
                .target(
                    onSuccess = { drawable ->
                        if (view.boundLoadGeneration != generation) {
                            Log.i(TAG, "discard stale thumbnail: index=$index name=${item.name}")
                            return@target
                        }
                        if (view.isFullResShown) {
                            Log.i(TAG, "skip late thumbnail: index=$index name=${item.name}")
                            return@target
                        }
                        view.setImageDrawable(drawable)
                    },
                )
                .precision(Precision.INEXACT)
                .build()
            imageLoader.enqueue(thumbRequest)
        }

        val request = coilSource(ImageRequest.Builder(context), coilSourceOf(item))
            .target(
                onSuccess = { drawable ->
                    if (view.boundLoadGeneration != generation) {
                        Log.i(TAG, "discard stale full: index=$index name=${item.name} (view now on gen ${view.boundLoadGeneration})")
                        return@target
                    }
                    view.isFullResShown = true
                    if (showProgress) progressBar.visibility = GONE
                    Log.i(TAG, "full ready: index=$index name=${item.name} ${drawable.intrinsicWidth}x${drawable.intrinsicHeight}")
                    view.setImageDrawable(drawable)
                    view.setRotationDegrees(rotation)
                },
                onError = { _ ->
                    if (view.boundLoadGeneration != generation) {
                        Log.i(TAG, "discard stale full error: index=$index name=${item.name}")
                        return@target
                    }
                    if (showProgress) progressBar.visibility = GONE
                    // 失败原因由 Coil 的 logger 以堆栈形式打出（见 imageLoader 的 .logger(...)）：
                    // 这个 target 重载拿不到 throwable，只记「加载失败」在真机上等于查不了
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
            val request = coilSource(ImageRequest.Builder(context), coilSourceOf(item))
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
        titleView.text = item.name
        // M6a 阶段 6：LAN 项的顶栏删除键按编辑门禁位显隐——allow_edit 直通时与本地同款
        // 确认弹窗 → confirmDelete（查看器自己摘项前进，宿主 onDelete 分流远端删除链路）；
        // 403 门禁态仍隐藏（门禁关闭时删除对远端不可用，M4a「不适用的项不出现」先例）。
        // 分享保留入口（shareCurrentImage 内 !isLan 拦截）。
        // 竖屏收敛后删除键不直挂（动作收进「更多」菜单），与 LAN 编辑门禁取并：任一
        // 命中即隐——不加竖屏条件的话，本行每次 open/navigate 都会把收敛掉的删除键
        // 重新点亮。横屏/平板只有门禁条件，行为与原来一致。
        deleteBtn.visibility = if (isCompactPortrait || (item.isLan && !lanAllowEdit)) GONE else VISIBLE
        // 底部信息
        val sizeStr = if (item.width > 0 && item.height > 0) "${item.width}×${item.height}" else "—"
        bottomInfoText.text = "${item.name}\n$sizeStr"
        // 同步抽屉
        updateDrawer(item)
    }

    /**
     * 顶栏移出「窗口」所需的 translationY（progress<1 时为部分行程，抽屉进度用）。
     * B1 模型下查看器容器顶=状态栏高度（组合根 statusBarsPadding 常驻、系统栏全程
     * 显示），滑出量必须含这段窗口顶偏移，否则顶栏底部停在状态栏区内、按钮仍露出
     * （`-topBar.bottom` 只对容器顶=0 的全屏形态成立）。与抽屉进度分支「行程加根
     * 自身的窗口顶偏移」同源（M8b-8：滑一个身位≠移出屏幕）。用容器（无 translation）
     * 的窗口坐标，不能用 topBar 自己的（其值含进行中的 translationY，二次调用会漂移）。
     */
    private fun topBarHideTranslation(progress: Float = 1f): Float {
        val loc = IntArray(2)
        getLocationInWindow(loc)
        return -(loc[1] + topBar.bottom) * progress
    }

    private fun toggleImmersive() {
        // 抽屉打开时不允许进入/退出沉浸
        if (drawerOpen) return
        Log.i("NativeViewer", "toggleImmersive: isImmersive=$isImmersive -> ${!isImmersive}")
        // 钉扎保持期：进/出的 resize 分段落位期间 onLayout 不重锚，图片全程钉在
        // 进入前矩形上（见 applyImageAreaPin）。e2e 窗口本就不 resize（零位移由容器
        // 恒全屏保证），这层只兜非 e2e 低版本窗口的真 resize。
        imagePinHoldUntil = android.os.SystemClock.uptimeMillis() + 3000
        isImmersive = !isImmersive
        // B2：沉浸=真全屏剧场态——背景转纯黑 + 系统栏隐藏；退出两者一并还原。
        // 容器恒全屏（不吃 insets），故隐藏系统栏不引起任何 resize，图片全程不动。
        setBackgroundColor(if (isImmersive) Color.BLACK else colorBg())
        onImmersiveBarsChange?.invoke(isImmersive)
        val targetTop = if (isImmersive) topBarHideTranslation() else 0f
        val targetBottom = if (isImmersive) height.toFloat() else 0f
        val targetInfo = if (isImmersive) height.toFloat() else 0f
        topBar.animate().translationY(targetTop).setDuration(200).start()
        thumbnailStrip.animate().translationY(targetBottom - thumbnailStrip.translationY).setDuration(200).start()
        if (bottomInfo.visibility == VISIBLE) {
            bottomInfo.animate().translationY(targetInfo - bottomInfo.translationY).setDuration(200).start()
        }
        // 2026-10-07 B2 定稿（取代同日 B1）：沉浸=真全屏——系统栏隐藏 + 背景纯黑 +
        // chrome 滑出，退出三者一并还原。B1 的「只动 chrome」被推翻是因为它满足不了
        // 「像系统相册那样全屏」；它防的两件事改由结构兜住：
        // ① 图片位移——容器恒全屏不吃 insets，翻转系统栏零 resize（B1 是躲开 resize）；
        // ② EMUI 手势条面板异色块——宿主在还原分支先写回主题色再 show，瞬态系统面板
        //   的底色(=主题默认色)与还原后的查看器底色同色，接缝不可见（见 MainActivity
        //   setViewerImmersiveBars）。
        // MagicUI 真机：滑出动画曾因窗口 resize 冻在半程，200ms 动画结束后按权威状态
        // 瞬时落位一次（onSizeChanged 的重申是尺寸变化路径的兜底，此处是动画路径的
        // 兜底，两处都以 isImmersive 为唯一事实）。
        topBar.postDelayed({
            if (!isOpen || topBar.height <= 0) return@postDelayed
            topBar.translationY = if (isImmersive) topBarHideTranslation() else 0f
        }, 240)
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

    /** 创建圆角矩形背景 drawable（已迁移至 DialogUtils.createRoundedBg，保留供非弹窗代码使用） */
    private fun createRoundedBg(bgColor: Int, cornerRadiusDp: Float, borderColor: Int? = null, strokeWidthDp: Float = 0f): android.graphics.drawable.GradientDrawable {
        return DialogUtils.createRoundedBg(bgColor, cornerRadiusDp, borderColor, strokeWidthDp, context)
    }

    private fun showTagEditDialog() {
        val item = images.getOrNull(currentIndex) ?: return
        TagEditDialog(
            context = context,
            theme = this,
            initialTags = item.tags,
            // M6b 阶段 5（D40）：LAN 项建议=桌面词表（两套词表不混，本地项维持现状）
            vocabulary = if (item.isLan) lanVocab else emptyList(),
            onSave = { newTags ->
                val idx = images.indexOfFirst { it.fileId == item.fileId }
                if (idx >= 0) {
                    images[idx] = images[idx].copy(tags = newTags)
                }
                val json = JSONObject().apply { put("tags", JSONArray(newTags)) }
                listener?.onUpdateFile(item.fileId, json.toString(), item.isLan)
                images.getOrNull(idx)?.let { updateDrawer(it) }
            }
        ).show()
    }

    private fun showDescriptionEditDialog() {
        val item = images.getOrNull(currentIndex) ?: return
        DescriptionEditDialog(
            context = context,
            theme = this,
            initialDesc = item.description,
            onSave = { newDesc ->
                val idx = images.indexOfFirst { it.fileId == item.fileId }
                if (idx >= 0) {
                    images[idx] = images[idx].copy(description = newDesc)
                }
                val json = JSONObject().apply { put("description", newDesc) }
                listener?.onUpdateFile(item.fileId, json.toString(), item.isLan)
                images.getOrNull(idx)?.let { updateDrawer(it) }
            }
        ).show()
    }

    /** 来源网址的一行（空串 = 占位 hint 行）。点它进编辑弹窗，与单条时代一致。 */
    private fun buildSourceUrlRow(url: String): TextView = TextView(context).apply {
        setTextColor(colorAccent())
        setHintTextColor(colorHint())
        textSize = 13f
        val pad = (resources.displayMetrics.density * 12).toInt()
        setPadding(pad, pad, pad, pad)
        // 斜体 hint（占位提示）
        val hintSpan = android.text.SpannableString("https://...")
        hintSpan.setSpan(
            android.text.style.StyleSpan(android.graphics.Typeface.ITALIC),
            0, hintSpan.length,
            android.text.Spanned.SPAN_EXCLUSIVE_EXCLUSIVE
        )
        setHint(hintSpan)
        text = url
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
            bottomMargin = (resources.displayMetrics.density * 6).toInt()
        }
    }

    private fun showSourceUrlEditDialog() {
        val item = images.getOrNull(currentIndex) ?: return
        SourceUrlEditDialog(
            context = context,
            theme = this,
            initialUrls = item.sourceUrls,
            onSave = { newUrls ->
                val idx = images.indexOfFirst { it.fileId == item.fileId }
                if (idx >= 0) {
                    // 首条跟着数组走，老读者（sourceUrl）与列表不会分叉
                    images[idx] = images[idx].copy(
                        sourceUrls = newUrls,
                        sourceUrl = newUrls.firstOrNull().orEmpty(),
                    )
                }
                // 多值是权威：只带数组（空数组 = 清空），宿主侧据此整体覆盖
                val json = JSONObject().apply {
                    put("sourceUrls", JSONArray(newUrls))
                }
                listener?.onUpdateFile(item.fileId, json.toString(), item.isLan)
                images.getOrNull(idx)?.let { updateDrawer(it) }
            }
        ).show()
    }

    private fun showSlideshowSettingsDialog() {
        SlideshowSettingsDialog(
            context = context,
            theme = this,
            initialConfig = SlideshowConfig(
                intervalMs = slideshowIntervalMs,
                transition = slideshowTransition,
                isRandom = slideshowRandom,
                enableZoom = slideshowZoom
            ),
            onConfirm = { newConfig ->
                slideshowIntervalMs = newConfig.intervalMs
                slideshowTransition = newConfig.transition
                slideshowZoom = newConfig.enableZoom
                slideshowRandom = newConfig.isRandom
                // 若幻灯片正在运行，把新配置应用到 SlideshowView（重置定时器/Ken Burns）
                slideshowView?.updateConfig(slideshowConfig())
                // 通知前端同步设置
                val json = JSONObject().apply {
                    put("interval", slideshowIntervalMs)
                    put("transition", slideshowTransition)
                    put("isRandom", slideshowRandom)
                    put("enableZoom", slideshowZoom)
                }
                listener?.onUpdateSlideshowConfig(json.toString())
            }
        ).show()
    }

    /**
     * 显示删除确认弹窗（UI 与 WebView 的 ConfirmModal 一致）。
     * 确认后调用 confirmDelete 执行：从 images 列表移除 + 切换下一张 + 通知 JS 删除文件。
     */
    private fun showDeleteConfirmDialog() {
        val item = images.getOrNull(currentIndex) ?: return
        DeleteConfirmDialog(
            context = context,
            theme = this,
            fileName = item.name,
            onConfirm = { confirmDelete(item.fileId) }
        ).show()
    }

    /**
     * 执行删除：从 images 列表移除 → 通知 JS 删除文件 → 切换到下一张（或关闭查看器）。
     */
    private fun confirmDelete(fileId: String) {
        val idx = images.indexOfFirst { it.fileId == fileId }
        if (idx < 0) return
        // 摘项前先记 isLan：宿主靠它分流远端 DELETE 与本地 MediaStore 链路（身份语义不同）
        val isLan = images[idx].isLan
        images.removeAt(idx)
        // 通知 JS 端真正删除文件（不再弹 ConfirmModal）
        listener?.onDelete(fileId, isLan)
        if (images.isEmpty()) {
            listener?.onClose()
            return
        }
        // 调整 currentIndex
        if (currentIndex >= images.size) {
            currentIndex = images.size - 1
        } else if (idx < currentIndex) {
            // 删除的是当前图之前的图，currentIndex 需要前移以保持指向同一张
            currentIndex -= 1
        }
        loadCurrent(animateIn = false)
        updateTitle()
        listener?.onNavigate(currentIndex)
    }

    /**
     * 执行移动后从 images 列表移除（类似 confirmDelete 但不调 onDelete）。
     * JS 端会处理实际文件移动 + state.files 更新。
     */
    private fun confirmMoveOut(fileId: String) {
        val idx = images.indexOfFirst { it.fileId == fileId }
        if (idx < 0) return
        images.removeAt(idx)
        if (images.isEmpty()) {
            listener?.onClose()
            return
        }
        if (currentIndex >= images.size) {
            currentIndex = images.size - 1
        } else if (idx < currentIndex) {
            currentIndex -= 1
        }
        loadCurrent(animateIn = false)
        updateTitle()
        listener?.onNavigate(currentIndex)
    }

    /**
     * 显示文件夹选择弹窗（UI 与 WebView FolderPickerModal 一致）。
     * 用户选择目标文件夹后调用 listener?.onFolderPickerConfirm(fileId, targetId, type)。
     * type: "copy" 或 "move"；move 时确认后还会从当前列表移除该图片。
     * M4b 1.3：[onNewAlbumPicked] 透传给弹窗的「+ 新建相册」（名字输入确认后回调并
     * 关闭弹窗；宿主做重名合并拦截与落库）。
     */
    fun showFolderPickerDialog(
        type: String,
        fileId: String,
        folderTreeJson: String,
        onNewAlbumPicked: ((albumName: String) -> Unit)? = null,
    ) {
        if (images.indexOfFirst { it.fileId == fileId } < 0) return
        FolderPickerDialog(
            context = context,
            theme = this,
            type = type,
            fileId = fileId,
            folderTreeJson = folderTreeJson,
            onConfirm = { _, targetId, confirmedType ->
                listener?.onFolderPickerConfirm(fileId, targetId, confirmedType)
                if (confirmedType == "move") {
                    confirmMoveOut(fileId)
                }
            },
            onNewAlbumPicked = onNewAlbumPicked,
        ).show()
    }

    private fun showMoreMenu(anchor: View) {
        val item = images.getOrNull(currentIndex) ?: return
        // M5 3.2：「加入画布」仅平板显示（D28）；LAN 图不走画布取流管线，一并隐藏
        val isTablet = resources.configuration.screenWidthDp >= 600 &&
            resources.configuration.screenHeightDp >= 480
        val canvasItem = MoreMenuItem("加入画布", colorTextPrimary(), iconRes = R.drawable.ic_lucide_frame) {
            listener?.onAddToCanvas(item.fileId)
        }
        // 竖屏收敛（applyTopBarFormFactor）收起的三个动作补进菜单头部：幻灯片/旋转/
        // 图片信息——与顶栏收敛一一对应，播放中文案随态切「幻灯片暂停」（isSlideshowPlaying
        // 与顶栏 updateSlideshowButtonIcon 同源，图标随态切 pause/play）；删除菜单里
        // 本就有（置底），不重复加。非竖屏该列表为空，菜单与原状完全一致。
        val collapsedItems = if (isCompactPortrait) {
            buildList<MoreMenuItem> {
                add(
                    MoreMenuItem(
                        if (isSlideshowPlaying()) "幻灯片暂停" else "幻灯片播放",
                        colorTextPrimary(),
                        iconRes = if (isSlideshowPlaying()) R.drawable.ic_lucide_pause else R.drawable.ic_lucide_play,
                    ) { toggleSlideshow() }
                )
                add(MoreMenuItem("旋转", colorTextPrimary(), iconRes = R.drawable.ic_lucide_rotate_cw) { rotateCurrent() })
                add(MoreMenuItem("图片信息", colorTextPrimary(), iconRes = R.drawable.ic_lucide_info) { toggleDrawer() })
            }
        } else {
            emptyList()
        }
        // 2026-09-27 验收（M8b-8）：菜单项全线配 lucide 图标（色随文字，删除红=图标红）；
        // 「删除」是危险动作，统一挪到菜单最底部（远离高频区防误触，桌面 ContextMenu 同位）。
        MoreMenuPopup(
            context = context,
            theme = this,
            anchor = anchor,
            menuItems = if (item.isLan) {
                // M6a 阶段 6：LAN 项的菜单——「保存到设备」（D34）与「幻灯片设置」之外，
                // 编辑门禁位直通时补上「删除」（本地同款确认弹窗 → confirmDelete，宿主
                // onDelete 分流远端链路）；403 门禁态不出现（M4a「不适用的项不出现」先例）。
                // 重命名/复制到/移动到依旧不出现：重命名会迁移远端身份（path 即 fileId），
                // 查看器序列按 path 定位会整体失效，登记为范围决策（重命名收在 LAN 网格）；
                // 复制/移动需要远端目录选择器，查看器内暂不挂 LanFolderPicker（网格选中集
                // 已可批量操作）。加入画布走本地取流管线，同样不适用。
                buildList {
                    addAll(collapsedItems)
                    add(
                        MoreMenuItem("保存到设备", colorTextPrimary(), iconRes = R.drawable.ic_lucide_download) {
                            listener?.onSaveToDevice(item.fileId, item.path)
                        }
                    )
                    add(MoreMenuItem("幻灯片设置", colorTextPrimary(), iconRes = R.drawable.ic_lucide_settings_2) {
                        showSlideshowSettingsDialog()
                    })
                    if (lanAllowEdit) {
                        add(MoreMenuItem("删除", colorDanger(), iconRes = R.drawable.ic_lucide_trash) {
                            showDeleteConfirmDialog()
                        })
                    }
                }
            } else {
                buildList {
                    addAll(collapsedItems)
                    if (isTablet) add(canvasItem)
                    // M6b 阶段 2：AI 分析（本地项；桌面查看器菜单同位。LAN 项不出现——
                    // 分析写本地库，对远端图无意义）
                    add(
                        MoreMenuItem("AI 分析", colorTextPrimary(), iconRes = R.drawable.ic_lucide_sparkles) {
                            listener?.onAiAnalyze(item.fileId)
                        }
                    )
                    // M6b 阶段 5（D36）：以图搜图——本地图字节 → 桌面 CLIP embed → 相似图
                    //（结果进 LAN 搜索结果虚拟目录；未连接/桌面模型未就绪宿主 Toast 拦截）
                    add(
                        MoreMenuItem("在桌面找相似", colorTextPrimary(), iconRes = R.drawable.ic_lucide_scan_search) {
                            listener?.onFindSimilar(item.fileId)
                        }
                    )
                    add(MoreMenuItem("重命名", colorTextPrimary(), iconRes = R.drawable.ic_lucide_pencil) {
                        showRenameDialog()
                    })
                    add(
                        MoreMenuItem("复制到文件夹", colorTextPrimary(), iconRes = R.drawable.ic_lucide_copy) {
                            listener?.onCopyToFolder(item.fileId)
                        }
                    )
                    add(
                        MoreMenuItem("移动到文件夹", colorTextPrimary(), iconRes = R.drawable.ic_lucide_folder_input) {
                            listener?.onMoveToFolder(item.fileId)
                        }
                    )
                    add(MoreMenuItem("幻灯片设置", colorTextPrimary(), iconRes = R.drawable.ic_lucide_settings_2) {
                        showSlideshowSettingsDialog()
                    })
                    add(MoreMenuItem("删除", colorDanger(), iconRes = R.drawable.ic_lucide_trash) {
                        showDeleteConfirmDialog()
                    })
                }
            }
        ).show()
    }

    private fun showRenameDialog() {
        val item = images.getOrNull(currentIndex) ?: return
        // 范围决策（M6a 阶段 6，非遗漏）：查看器不做 LAN 重命名——重命名会迁移远端身份
        // （path 即 fileId），查看器序列/抽屉/缩略图条全按 path 定位，就地改名等于整份
        // 序列失效；重命名入口收在 LAN 网格（单选「更多 → 重命名…」）。这层护栏保证
        // 远端 path 永远到不了本地 MediaStore 重命名链路。
        if (item.isLan) return
        RenameDialog(
            context = context,
            currentName = item.name,
            onConfirm = { newName ->
                val idx = images.indexOfFirst { it.fileId == item.fileId }
                if (idx >= 0) {
                    images[idx] = item.copy(name = newName)
                    updateTitle()
                }
                val json = JSONObject().apply { put("name", newName) }
                // 本地入口恒 false（见 Listener.onUpdateFile 注释：LAN 项不可达重命名）
                listener?.onUpdateFile(item.fileId, json.toString(), false)
            }
        ).show()
    }

    // ====== 分享 ======
    private fun shareCurrentImage() {
        val item = images.getOrNull(currentIndex) ?: return
        if (item.isLan) {
            Toast.makeText(context, "无法分享局域网图片", Toast.LENGTH_SHORT).show()
            return
        }
        listener?.onShare(item.path)
    }

    // ====== 幻灯片（委托给独立全屏覆盖层 SlideshowView）======
    /** 标记幻灯片启动时是否由本组件隐藏了系统状态栏（查看器已沉浸时为 false，退出时据此恢复）。 */
    private var slideshowHidSystemUi = false

    private fun slideshowConfig() = SlideshowView.SlideshowConfig(
        intervalMs = slideshowIntervalMs,
        transition = slideshowTransition,
        isRandom = slideshowRandom,
        enableZoom = slideshowZoom
    )

    /** 顶栏播放按钮回调：未播放则启动，播放中则退出（播放时按钮被覆盖，实际仅触发启动）。 */
    private fun toggleSlideshow() {
        if (slideshowView != null) slideshowView?.exit() else startSlideshow()
    }

    /** 创建并挂载 SlideshowView 全屏覆盖层，立即开始播放。 */
    private fun startSlideshow() {
        if (images.isEmpty()) return
        if (slideshowView != null) return
        val sv = SlideshowView(
            context = context,
            imageLoader = imageLoader,
            images = images.toList(),
            startIndex = currentIndex,
            config = slideshowConfig(),
            listener = object : SlideshowView.Listener {
                override fun onSlideshowExit(currentIndex: Int) {
                    onSlideshowExited(currentIndex)
                }
            }
        )
        slideshowView = sv
        addView(sv, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
        sv.start()
        updateSlideshowButtonIcon()
        // 幻灯片覆盖层是黑底全屏，系统栏必须跟着走（否则一条状态栏横在剧场中间）。
        // B2 下翻转系统栏不引起容器 resize（容器恒全屏），位移风险由结构兜住。
        // slideshowHidSystemUi 同时是钉扎门（isChromeHidden：期间不重锚/不钉顶栏）。
        slideshowHidSystemUi = !isImmersive
        if (slideshowHidSystemUi) {
            imagePinHoldUntil = android.os.SystemClock.uptimeMillis() + 3000
            onImmersiveBarsChange?.invoke(true)
        }
    }

    /** 幻灯片正常退出：同步当前索引到查看器并恢复 UI。 */
    private fun onSlideshowExited(exitIndex: Int) {
        val synced = if (images.isEmpty()) 0 else exitIndex.coerceIn(0, images.size - 1)
        val changed = synced != currentIndex
        currentIndex = synced
        rotationDegrees = 0
        loadingPaletteFileId = null
        // 先移除覆盖层并恢复系统状态栏
        cleanupSlideshow()
        // 加载幻灯片停止时的图片到查看器
        loadCurrent(animateIn = false)
        updateTitle()
        thumbnailAdapter.highlight(currentIndex)
        if (changed) listener?.onNavigate(currentIndex)
    }

    /** 移除幻灯片覆盖层并复位覆盖态标志（系统栏由会话接管，此处不动；供 close/destroy 调用）。 */
    private fun cleanupSlideshow() {
        val sv = slideshowView ?: return
        removeView(sv)
        slideshowView = null
        updateSlideshowButtonIcon()
        if (slideshowHidSystemUi) {
            imagePinHoldUntil = android.os.SystemClock.uptimeMillis() + 3000
            slideshowHidSystemUi = false
            // 只在查看器自身不沉浸时还原——沉浸态的系统栏归 toggleImmersive 管，
            // 这里抢着 show 会把沉浸态的隐藏状态抹掉
            if (!isImmersive) onImmersiveBarsChange?.invoke(false)
        }
    }

    private fun updateSlideshowButtonIcon() {
        val playing = slideshowView != null
        slideshowBtn.setImageResource(if (playing) R.drawable.ic_lucide_pause else R.drawable.ic_lucide_play)
        // M8b 阶段 3（遗留 #2）：无障碍描述与图标同步——播放中=「幻灯片暂停」，未播=「幻灯片播放」。
        slideshowBtn.contentDescription = if (playing) "幻灯片暂停" else "幻灯片播放"
    }

    /** 外部（MainActivity/React）切换幻灯片开关。 */
    fun setSlideshow(enabled: Boolean) {
        if (enabled) {
            if (slideshowView == null) startSlideshow()
        } else {
            slideshowView?.exit()
        }
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
        /** 元数据抽屉宽度（dp）。文件信息格子按它算列宽，见 [buildDetailCell]。 */
        private const val DRAWER_WIDTH_DP = 320f
        /**
         * 竖屏抽屉顶缘把手条高度（dp）。拖拽热区，整宽×此高（32≈96px 原值偏高，
         * 2026-10-07 用户要求收窄「文件名上方的操作区」→ 20）。
         */
        private const val DRAWER_HANDLE_STRIP_DP = 20f
        /** 竖屏抽屉顶部内边距（dp）：16→12，与把手条一起把「面板顶→文件名」48dp→32dp。 */
        private const val DRAWER_TOP_PAD_DP = 12f
    }

    /** 翻页间隔的像素值 */
    private val swipeGapPx: Float get() = resources.displayMetrics.density * SWIPE_GAP_DP
}
