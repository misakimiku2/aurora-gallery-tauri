package com.aurora.gallery.kotlin.viewer

import com.aurora.gallery.kotlin.R
import android.content.Context
import android.graphics.Color
import android.graphics.RectF
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
    /** DialogTheme 委托实例（第 21 刀）：默认自建即可，init 里 bind 到本类可变状态 */
    paletteContract: PaletteContract = PaletteContract(),
) : FrameLayout(context),
    // 取值 lambda 每次调用读最新字段：palette 随暗色主题切换整体重赋，不能构造期捕获；
    // 超类型委托表达式引用不到 this 的属性，故经构造参数传入并在 init 里 bind
    DialogTheme by paletteContract {

    init {
        paletteContract.bind(paletteNow = { palette }, darkNow = { isDarkTheme })
    }

    interface Listener {
        /**
         * 用户请求关闭查看器。
         *
         * [animate]（2026-10-08）：true = 用户主动退出（返回键 / 顶栏返回），宿主可以据此做
         * 「图片缩回网格卡片」的退出过渡；false = 删除、移出之后的连带关闭——那一张在网格里
         * 已经没了，缩回一张不存在的卡片是假动作，必须直接硬关。
         */
        fun onClose(animate: Boolean = true)
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

    // internal：进出过渡与加载簇已拆到 NativeGalleryViewTransitions.kt（第 25 刀）
    internal val imageLoader: ImageLoader by lazy {
        // M5 1.2 起与画布共享进程级实例（D25：同内存缓存 + 同磁盘缓存 journal；
        // 配置原样搬进 SharedCoil，行为不变）
        SharedCoil.get(context)
    }

    // internal：手势翻图簇已拆到 NativeGalleryViewGestures.kt（第 23 刀）
    internal val images = mutableListOf<ImageItem>()
    // internal：手势翻图簇已拆到 NativeGalleryViewGestures.kt（第 23 刀）
    internal var currentIndex = 0
    // internal：手势翻图簇已拆到 NativeGalleryViewGestures.kt（第 23 刀）
    internal var isAnimating = AtomicBoolean(false)
    // internal：抽屉装配簇已拆到 NativeGalleryViewDrawer.kt（第 22 刀）
    internal var isImmersive = false
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
    // internal：生命周期布局簇已拆到 NativeGalleryViewLayout.kt（第 24 刀）
    internal var statusBarInsetPx = 0
    private var slideshowIntervalMs = 5000L
    private var slideshowTransition = "fade"
    private var slideshowRandom = false
    private var slideshowZoom = false
    /** 当前挂载的幻灯片全屏覆盖层；非 null 表示幻灯片正在播放。 */
    private var slideshowView: SlideshowView? = null
    // internal：手势翻图簇已拆到 NativeGalleryViewGestures.kt（第 23 刀）
    internal var rotationDegrees = 0
    // 主题：true=深色，false=浅色。开关来自宿主传入的 options("isDark")，与 Compose 侧
    // AuroraTheme(darkTheme=) 同一个值；颜色一律走 AuroraPalette 那张唯一的表。
    private var isDarkTheme = false
        set(value) {
            field = value
            palette = AuroraPalettes.of(value)
        }
    // internal：抽屉装配簇已拆到 NativeGalleryViewDrawer.kt（第 22 刀）
    internal var palette: AuroraPalette = AuroraPalettes.of(isDarkTheme)
    // 查看器是否打开（open 时设 true，close 时设 false）
    // internal：手势翻图簇已拆到 NativeGalleryViewGestures.kt（第 23 刀）
    internal var isOpen = false

    // —— 旋转屏幕（2026-10-07，取代原「旋转图片」钮）——
    /** 当前钉屏方向（SCREEN_ORIENTATION_SENSOR_*）；null=跟随系统。 */
    private var pinnedOrientation: Int? = null
    /** 钉屏前的 requestedOrientation，还原时写回（不假定 UNSPECIFIED，宿主未来若锁向也不破坏）。 */
    private var savedRequestedOrientation =
        android.content.pm.ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED

    // —— 内容区钉扎（2026-10-06 报障：沉浸切换隐藏/恢复系统栏的窗口 resize 分两段落位
    // （avd_honor29 实测底部先收、顶部后收），图片在变高/变矮的容器里各重居中一次，
    // 肉眼可见「先下后上」。把图片双 buffer 与顶栏/缩略图条/底部信息的可用区用锚矩形
    // 钉住：系统栏被隐藏期间黑底向四周扩展，各视图的屏幕位置与尺寸逐帧不变（10-07
    // 真机报障「退出沉浸后顶部文件名跳动」= 顶栏随窗口顶边分段回落，一并由钉扎消除）
    // ——ZoomableImageView 视图尺寸恒定，onSizeChanged 不触发 resetToCenter，缩放
    // 状态也不丢）——
    // internal：生命周期布局簇已拆到 NativeGalleryViewLayout.kt（第 24 刀）
    internal var imageAnchorTopAbs = 0
    // internal：生命周期布局簇已拆到 NativeGalleryViewLayout.kt（第 24 刀）
    internal var imageAnchorBottomAbs = 0
    // internal：生命周期布局簇已拆到 NativeGalleryViewLayout.kt（第 24 刀）
    internal var imageAnchorValid = false
    // 锚时刻各钉扎子视图的本地 top/bottom（还原分段中按锚绝对矩形回摆）
    // internal：生命周期布局簇已拆到 NativeGalleryViewLayout.kt（第 24 刀）
    internal class ChromePin(val view: View, val top: Int, val bottom: Int)
    // internal：生命周期布局簇已拆到 NativeGalleryViewLayout.kt（第 24 刀）
    internal val chromePins = ArrayList<ChromePin>()
    // 切换保持期：切换/还原的 resize 分段期间（实测 ~1s，MagicUI 更碎）onLayout 禁止
    // 重锚，否则还原半程又按中途几何重居中一次。3s > 任何实测分段落位时长。
    // internal：生命周期布局簇已拆到 NativeGalleryViewLayout.kt（第 24 刀）
    internal var imagePinHoldUntil = 0L

    /**
     * 加载代号（[loadIntoView] 每轮递增）。Coil 的 lambda target 请求不挂在视图的
     * requestManager 上（RealImageLoader.enqueue 只登记 ViewTarget），翻页/重载不会
     * 取消它们——快速连续翻页时上一张图的缩略图/高清图回调可能迟于本轮落地。
     * 回调比对视图上的 [ZoomableImageView.boundLoadGeneration]，代号不符整体作废，
     * 防止旧图被画到新图上。
     */
    // internal：进出过渡与加载簇已拆到 NativeGalleryViewTransitions.kt（第 25 刀）
    internal var loadGeneration = 0

    /**
     * LAN 编辑门禁位（M6a 阶段 6，allow_edit）：直通时 LAN 项才出现删除入口（顶栏删除键
     * + 「更多」菜单项），403 门禁态两者都隐（门禁关闭时删除对远端不可用）。var + 宿主
     * 写入而非构造参：实例跟 Activity 走（Coil 缓存不随进出查看器重建），门禁位随每次
     * 目录 browse 尾随同步，宿主在组合/更新时把最新值推进来即可（setSlideshow 同款先例）。
     */
    var lanAllowEdit: Boolean = false

    // internal：抽屉装配簇已拆到 NativeGalleryViewDrawer.kt（第 22 刀）
    internal fun colorBg() = palette.main
    // DialogTheme 的 15 个 colorXxx()/isDarkTheme() 取值实现已抽到 PaletteContract.kt
    // （拆分清单第 21 刀），本类以 `DialogTheme by PaletteContract(...)` 委托实现；
    // colorPanel 仍走接口默认实现（palette.panel 同值），取舍见 PaletteContract 的 KDoc。
    /** 主背景上加一层透明度（顶栏 / 缩略图条 / 底信息条的半透底） */
    // internal：抽屉装配簇已拆到 NativeGalleryViewDrawer.kt（第 22 刀）
    internal fun colorBgAlpha(alpha: Int): Int = withAlpha(palette.main, alpha)
    /** 抽屉预览图的占位底 */
    private fun colorPlaceholder() = palette.placeholderBg
    /** 主色调提取中的脉冲骨架块 */
    private fun colorSkeleton() = palette.skeletonBg
    /** 色块描边 */
    private fun colorHairline() = palette.hairline

    var listener: Listener? = null

    // UI 引用
    // internal：抽屉装配簇已拆到 NativeGalleryViewDrawer.kt（第 22 刀）
    internal val primaryView: ZoomableImageView
    // internal：抽屉装配簇已拆到 NativeGalleryViewDrawer.kt（第 22 刀）
    internal val secondaryView: ZoomableImageView // 用于切换动画时的另一张
    // internal：进出过渡与加载簇已拆到 NativeGalleryViewTransitions.kt（第 25 刀）
    internal val progressBar: ProgressBar
    // internal：抽屉装配簇已拆到 NativeGalleryViewDrawer.kt（第 22 刀）
    internal val topBar: LinearLayout
    // internal：抽屉装配簇已拆到 NativeGalleryViewDrawer.kt（第 22 刀）
    lateinit internal var titleView: TextView
    // internal：抽屉装配簇已拆到 NativeGalleryViewDrawer.kt（第 22 刀）
    lateinit internal var moreBtn: ImageView
    // internal：抽屉装配簇已拆到 NativeGalleryViewDrawer.kt（第 22 刀）
    lateinit internal var slideshowBtn: ImageView
    // 旋转屏幕/图片信息钮提成成员：竖屏收敛（applyTopBarFormFactor）要在 buildTopBar 之外
    // 按形制重设可见性，不能停留在 buildTopBar 的局部 val（slideshowBtn/deleteBtn 先例）。
    // internal：抽屉装配簇已拆到 NativeGalleryViewDrawer.kt（第 22 刀）
    lateinit internal var screenRotateBtn: ImageView
    // internal：抽屉装配簇已拆到 NativeGalleryViewDrawer.kt（第 22 刀）
    lateinit internal var infoBtn: ImageView
    // internal：抽屉装配簇已拆到 NativeGalleryViewDrawer.kt（第 22 刀）
    lateinit internal var deleteBtn: ImageView
    /** 顶栏是否已构建（第 22 刀：扩展函数摸不到 backing field，护栏收进成员） */
    internal fun isTopBarBuilt(): Boolean = this::slideshowBtn.isInitialized
    // internal：抽屉装配簇已拆到 NativeGalleryViewDrawer.kt（第 22 刀）
    internal val bottomInfo: LinearLayout
    private val bottomInfoText: TextView
    // internal：抽屉装配簇已拆到 NativeGalleryViewDrawer.kt（第 22 刀）
    internal val thumbnailStrip: RecyclerView
    // internal：手势翻图簇已拆到 NativeGalleryViewGestures.kt（第 23 刀）
    internal val thumbnailAdapter: ThumbnailStripAdapter
    // 抽屉引用
    // internal：抽屉装配簇已拆到 NativeGalleryViewDrawer.kt（第 22 刀）
    internal val metadataDrawer: LinearLayout
    // internal：抽屉装配簇已拆到 NativeGalleryViewDrawer.kt（第 22 刀）
    internal val drawerScrollView: ScrollView
    private val drawerContainer: LinearLayout
    /** 拖拽把手条：竖屏底部面板形制的滑动暗示（横屏右缘抽屉形制下 GONE） */
    // internal：抽屉装配簇已拆到 NativeGalleryViewDrawer.kt（第 22 刀）
    internal val drawerHandleStrip: LinearLayout
    // internal：抽屉装配簇已拆到 NativeGalleryViewDrawer.kt（第 22 刀）
    internal val drawerHandleView: View
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
    // internal：抽屉装配簇已拆到 NativeGalleryViewDrawer.kt（第 22 刀）
    internal var drawerOpen = false
    /** 正在提取主色调的 fileId，非 null 时抽屉显示 loading 占位 */
    // internal：手势翻图簇已拆到 NativeGalleryViewGestures.kt（第 23 刀）
    internal var loadingPaletteFileId: String? = null
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
    // internal：抽屉装配簇已拆到 NativeGalleryViewDrawer.kt（第 22 刀）
    internal var drawerWidthAnimator: android.animation.ValueAnimator? = null
    /** 垂直跟手开始时抽屉是否打开 */
    // internal：手势翻图簇已拆到 NativeGalleryViewGestures.kt（第 23 刀）
    internal var drawerDragStartOpen = false
    /** 垂直跟手开始时的抽屉进度（0=关闭, 1=打开） */
    // internal：手势翻图簇已拆到 NativeGalleryViewGestures.kt（第 23 刀）
    internal var drawerDragStartProgress = 0f
    /** 抽屉打开前的沉浸状态，抽屉关闭时恢复（确保沉浸模式下开关抽屉仍回到沉浸） */
    // internal：抽屉装配簇已拆到 NativeGalleryViewDrawer.kt（第 22 刀）
    internal var immersiveBeforeDrawer = false
    /**
     * 抽屉视觉进度（0=关闭, 1=打开）的权威值，applyDrawerProgress 每帧写入。
     * 横屏与 ZoomableImageView.drawerFillProgress 保持同步（图片分栏压缩渲染消费它）；
     * 竖屏底部面板是纯覆盖层、不碰图片（drawerFillProgress 恒 0，面板开着时双击缩放/
     * 换图 resetToCenter 仍按 fit 走，不会被面板进度带成 fill 裁剪），面板进度只记这里。
     * 跟手起始（onTouchDown）与 toggleDrawer 的动画起点必须读它——竖屏若读
     * drawerFillProgress 恒得 0，松手后继续拖会被方向限制钳在 0 跟丢手指。
     */
    // internal：抽屉装配簇已拆到 NativeGalleryViewDrawer.kt（第 22 刀）
    internal var drawerPanelProgress = 0f
    /** 当前已应用的抽屉形制（null=尚未应用过）；与 isCompactPortrait 不一致即重设（幂等短路用）。 */
    // internal：抽屉装配簇已拆到 NativeGalleryViewDrawer.kt（第 22 刀）
    internal var drawerFormPortrait: Boolean? = null
    /** 竖屏形制因根视图尚无尺寸（首次 open 时 GONE 未布局，2/3 高算不出）而挂起，onSizeChanged 补应用。 */
    // internal：抽屉装配簇已拆到 NativeGalleryViewDrawer.kt（第 22 刀）
    internal var drawerFormFactorPending = false
    /** 翻页拖动中，邻接视图（上一张/下一张）是否已加载并可见 */
    // internal：手势翻图簇已拆到 NativeGalleryViewGestures.kt（第 23 刀）
    internal var swipeAdjacentPrepared = false
    /** 邻接视图方向：-1 = 上一张（左侧），1 = 下一张（右侧） */
    // internal：手势翻图簇已拆到 NativeGalleryViewGestures.kt（第 23 刀）
    internal var swipeAdjacentDirection = 0
    /** 滑动期间缓存的屏幕宽度，避免每帧调用 width.toFloat() */
    // internal：手势翻图簇已拆到 NativeGalleryViewGestures.kt（第 23 刀）
    internal var swipeCachedWidth = 0f
    /** 滑动期间缓存的邻接视图引用，避免每帧调用 adjacentView() */
    // internal：手势翻图簇已拆到 NativeGalleryViewGestures.kt（第 23 刀）
    internal var swipeCachedAdjacentView: ZoomableImageView? = null

    // internal：手势翻图簇已拆到 NativeGalleryViewGestures.kt（第 23 刀）
    internal var activeView: ZoomableImageView
        get() = if (primaryView.tag == "active") primaryView else secondaryView
        set(value) {
            primaryView.tag = if (value === primaryView) "active" else "idle"
            secondaryView.tag = if (value === secondaryView) "active" else "idle"
        }

    /** 获取非活跃视图（用于翻页拖动时显示邻接图） */
    // internal：手势翻图簇已拆到 NativeGalleryViewGestures.kt（第 23 刀）
    internal fun adjacentView(): ZoomableImageView = if (primaryView.tag == "active") secondaryView else primaryView

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
    // internal：抽屉装配簇已拆到 NativeGalleryViewDrawer.kt（第 22 刀）
    internal val isCompactPortrait: Boolean
        get() = com.aurora.gallery.kotlin.ui.isCompactWidth(resources.configuration) &&
            resources.configuration.orientation == android.content.res.Configuration.ORIENTATION_PORTRAIT

    /**
     * 抽屉开合行程（px）：横屏=右缘抽屉宽 320dp（沿 X 轴滑入滑出），竖屏=底部面板高
     * =根高×2/3（沿 Y 轴上滑/下滑）。实时计算不缓存：竖屏行程跟根高走，旋转后必须取
     * 新值（用户拍板：2/3 用根 View 实际高，不写死 dp）。根视图还没量出尺寸时退化用
     * 屏幕高的 2/3——只发生在布局前的落位，onSizeChanged 后 applyDrawerFormFactor 的
     * params 比对会以真实根高纠正。
     */
    // internal：抽屉装配簇已拆到 NativeGalleryViewDrawer.kt（第 22 刀）
    internal val drawerExtentPx: Int
        get() {
            if (!isCompactPortrait) return (resources.displayMetrics.density * 320).toInt()
            val h = height
            return if (h > 0) h * 2 / 3 else resources.displayMetrics.heightPixels * 2 / 3
        }

    override fun onConfigurationChanged(newConfig: android.content.res.Configuration?) {
        super.onConfigurationChanged(newConfig)
        // manifest 声明 orientation|screenSize configChanges，查看器打开中旋转时
        // Activity/View 都不重建，只有这里收得到通知——竖屏收敛即时随形制重算，
        // 消除「顶栏维持旧形制、菜单却按新形制出项」的二者不一致（deleteBtn 的
        // 显隐归 updateTitle 一处管，一并重跑；空序列有护栏）。查看器关闭（未
        // attach）时收不到也无需收——open() 末尾的幂等重调兜底。
        applyTopBarFormFactor()
        // 旋转屏幕钮描述随当前方向刷新（未钉屏时用户转设备：横→竖文案要从
        // 「竖屏查看」变回「横屏查看」，钉屏态则恒「还原屏幕方向」）
        updateScreenRotateButtonIcon()
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

    // internal：手势翻图簇已拆到 NativeGalleryViewGestures.kt（第 23 刀）
    internal val touchSlopForSwipe = android.view.ViewConfiguration.get(context).scaledTouchSlop.toFloat()

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
        // 主线程占用计时：进出过渡那 320ms 里覆盖层要靠这条链活着，open() 的同步重活
        // （缩略图条 submit / 抽屉重建 / 发图）压进动画窗口就会把帧数打掉（真机报「只有两帧」）
        val openStartedAt = android.os.SystemClock.uptimeMillis()
        // 上次会话的沉浸态残留检测：实例跨打开复用（Coil 缓存随实例走），若上次经
        // 兜底 BackHandler 之外任何未走 close() 的路径退出，isImmersive=true、顶栏
        // 停在滑出位、系统状态栏残留隐藏会全部带进本次（真机报障：重开查看器状态
        // 栏已被隐藏）。isOpen（查看器开着被重入）时不属于残留，不动。
        val staleImmersive = !isOpen && isImmersive
        // 旋转屏幕残留守卫（staleImmersive 同款）：上次经未走 close() 的路径退出时，
        // 钉屏方向会把整个应用带歪——重开查看器前先还原。
        if (!isOpen && pinnedOrientation != null) {
            Log.w("NativeViewer", "open: stale pinned orientation leaked from previous session, restoring")
            restoreScreenOrientation()
        }
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

        // 过渡挂起位（2026-10-08）：宿主在打开查看器前置了 holdHiddenForTransition，这一段
        // 整层先 INVISIBLE（不是 GONE——照样测量/布局、照常取图），由覆盖层的放大动画
        // 到位后经 [revealAfterTransition] 揭幕。chrome 同步归零，揭幕时淡入——顶栏/缩略图条
        // 若跟着图片一起就位，会出现「工具栏先闪一下再没」的杂乱感。
        alpha = 1f
        applyTransitionChrome(held = holdHiddenForTransition)
        visibility = if (holdHiddenForTransition) INVISIBLE else VISIBLE
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
        // 旋转屏幕钮描述按打开时的屏幕方向刷新（构造默认「横屏查看」在横屏/平板打开
        // 时会过期，同 applyTopBarFormFactor 的过期问题）
        updateScreenRotateButtonIcon()
        // 抽屉形制幂等重设（M8b-8）：同顶栏「构造时判的形制会过期」；竖屏 2/3 高度依赖
        // 根尺寸，首次 open 根视图 GONE 未布局时挂起，onSizeChanged 补应用
        applyDrawerFormFactor()
        updateTitle()
        // 旋转还原后重开的保底：上一轮钉横屏退出时首帧同步可能落在 Compose 驱动的
        // 布局 pass 里，margin 修正的 requestLayout 被 AndroidView 宿主吞掉（宿主尺寸
        // 未变就不向上传播）→ 渲染停在旧 margin。这里 post 到 pass 外再无条件请求一次
        // 真实布局（setLayoutParams 恒触发 requestLayout，无相等短路），让下一帧
        // onLayout→syncStatusBarInset 按当前方向落定。
        mainHandler.post {
            if (!isOpen) return@post
            topBar.layoutParams = topBar.layoutParams
        }
        if (autoStartSlideshow) setSlideshow(true)
        Log.i(
            "NativeViewer",
            "open() 同步耗时=${android.os.SystemClock.uptimeMillis() - openStartedAt}ms " +
                "heldForTransition=$holdHiddenForTransition",
        )
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
    // internal：抽屉装配簇已拆到 NativeGalleryViewDrawer.kt（第 22 刀）
    internal fun applyTheme() {
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

    // —— 进出过渡动画（2026-10-08，覆盖层本体见 [ViewerTransition]）——

    /**
     * 过渡挂起位：true 时 [open] 把整层置 INVISIBLE，等覆盖层的放大动画到位后由
     * [revealAfterTransition] 揭幕。宿主在写「打开查看器」状态**之前**置位（open 由组合层
     * 在稍后的帧里触发，晚于这里），本类只读它一次、揭幕时清零。
     */
    var holdHiddenForTransition = false

    /**
     * 当前这张图在**窗口坐标系**里的显示矩形（覆盖层的进入落点 / 退出口起点）。
     * 图还没上屏或还没布局时返回 false，由调用方退回预测矩形或干脆硬切。
     */
    fun currentImageRect(out: RectF): Boolean = activeView.windowDisplayRect(out)

    /** 当前显示的 drawable——覆盖层要画的就是它。空壳位图按没有处理（见 [showsContent]）。 */
    fun currentImageDrawable(): Drawable? = activeView.drawable?.takeIf { isOpen && it.showsContent() }

    /** 当前这张的 fileId（宿主拿它回查网格卡片矩形，作为退出动画的落点）。 */
    fun transitionFileId(): String? = images.getOrNull(currentIndex)?.fileId

    /**
     * 覆盖层底色：取查看器自己的背景色值。收尾那一刻两层交接，颜色必须逐位相同才看不出来
     * ——沉浸态下本类把背景涂黑（[applyTheme] 的 isImmersive 分支），这里也就跟着黑。
     */
    fun transitionScrimColor(): Int =
        (background as? android.graphics.drawable.ColorDrawable)?.color ?: Color.BLACK

    /**
     * 揭幕（进入动画到位时由覆盖层调）：显形 + 重夺焦点 + chrome 淡入。
     *
     * 焦点要在这里再要一次：INVISIBLE 的视图拿不到焦点（`requestFocus` 内部要求
     * visibility==VISIBLE），而 [open] 那次请求正好落在挂起期——错过它就没有按键梯子，
     * 返回键只能走 [NativeViewerLayer] 的兜底 BackHandler。
     */
    fun revealAfterTransition() {
        holdHiddenForTransition = false
        if (!isOpen) return
        visibility = VISIBLE
        requestFocus()
        for (v in transitionChrome()) {
            if (v.alpha < 1f) {
                v.animate().alpha(1f)
                    .setDuration(TRANSITION_CHROME_MS)
                    .setInterpolator(TRANSITION_CHROME_EASING)
                    .start()
            }
        }
    }

    /**
     * 退出动画起步：整层藏起来，屏幕交给覆盖层那张飞回卡片的图。
     *
     * 用 INVISIBLE 不用 GONE：几何、当前 index、已解码的图全部留在原地，动画结束才真的
     * [close]——中途被打断（用户又点了一张）也只需要 close 一次，不存在半程脏状态。
     */
    fun hideForTransition() {
        holdHiddenForTransition = false
        if (!isOpen) return
        visibility = INVISIBLE
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
        // 旋转屏幕还原（2026-10-07）：钉横屏只在查看器前台成立，退出写回原方向——
        // 否则网格/画布会停在查看器钉下的横屏
        restoreScreenOrientation()
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

    // internal：抽屉装配簇已拆到 NativeGalleryViewDrawer.kt（第 22 刀）
    internal fun updateTitle() {
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
    // internal：抽屉装配簇已拆到 NativeGalleryViewDrawer.kt（第 22 刀）
    internal fun topBarHideTranslation(progress: Float = 1f): Float {
        val loc = IntArray(2)
        getLocationInWindow(loc)
        return -(loc[1] + topBar.bottom) * progress
    }

    // internal：手势翻图簇已拆到 NativeGalleryViewGestures.kt（第 23 刀）
    internal fun toggleImmersive() {
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

    /**
     * 旋转屏幕（2026-10-07 取代「旋转图片」钮）：按点击时刻的屏幕方向**翻转到另一侧**——
     * 竖屏点进横屏（SENSOR_LANDSCAPE）、横屏点进竖屏（SENSOR_PORTRAIT）。翻转而非单向钉
     * 横屏，是平板验收报障的修正：平板本就横屏，钉 SENSOR_LANDSCAPE 是视觉无操作
     *（「平板点了没反应」），翻转后每次点击都有可见的方向切换，平板用户也借此获得
     * 竖幅图的竖屏查看。查看器顶栏/抽屉形制由 onConfigurationChanged 幂等跟进——
     * manifest 声明 orientation|screenSize configChanges，旋转不重建。
     * 只在查看器前台生效：close() 与 open() 残留守卫都会 restoreScreenOrientation()
     * 写回钉屏前的 requestedOrientation（还原跟随系统，不写死竖屏），应用其余界面
     * 方向不受影响。
     */
    // internal：抽屉装配簇已拆到 NativeGalleryViewDrawer.kt（第 22 刀）
    internal fun toggleScreenOrientation() {
        val activity = context as? android.app.Activity ?: return
        if (pinnedOrientation == null) {
            savedRequestedOrientation = activity.requestedOrientation
        }
        pinnedOrientation =
            if (resources.configuration.orientation == android.content.res.Configuration.ORIENTATION_LANDSCAPE)
                android.content.pm.ActivityInfo.SCREEN_ORIENTATION_SENSOR_PORTRAIT
            else
                android.content.pm.ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
        activity.requestedOrientation = pinnedOrientation!!
        updateScreenRotateButtonIcon()
    }

    /** 还原屏幕方向（幂等）：只在钉过屏时写回，避免覆盖宿主/系统的既有取向。 */
    private fun restoreScreenOrientation() {
        val pinned = pinnedOrientation ?: return
        pinnedOrientation = null
        (context as? android.app.Activity)?.requestedOrientation = savedRequestedOrientation
        updateScreenRotateButtonIcon()
    }

    /**
     * 按钮描述按当前屏幕方向给出点击去向：竖屏点=「横屏查看」、横屏点=「竖屏查看」
     *（图标共用 rotate_cw；updateSlideshowButtonIcon 先例）。查看器内按钮是纯翻转
     * 循环、每次点击都有可见方向切换，不区分钉屏态——「还原跟随系统」只发生在
     * close()/open() 残留守卫，不占按钮语义。
     */
    // internal：抽屉装配簇已拆到 NativeGalleryViewDrawer.kt（第 22 刀）
    internal fun updateScreenRotateButtonIcon() {
        if (!this::screenRotateBtn.isInitialized) return
        screenRotateBtn.contentDescription =
            if (resources.configuration.orientation == android.content.res.Configuration.ORIENTATION_LANDSCAPE) "竖屏查看"
            else "横屏查看"
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
    // internal：抽屉装配簇已拆到 NativeGalleryViewDrawer.kt（第 22 刀）
    internal fun showDeleteConfirmDialog() {
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
            // 序列空了的连带关闭：这张在网格里已经没了，退出过渡没有落点，硬关（animate=false）
            listener?.onClose(animate = false)
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
            // 同 confirmDelete：图已被移出当前序列，退出动画没有落点，硬关
            listener?.onClose(animate = false)
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

    // internal：抽屉装配簇已拆到 NativeGalleryViewDrawer.kt（第 22 刀）
    internal fun showMoreMenu(anchor: View) {
        val item = images.getOrNull(currentIndex) ?: return
        // M5 3.2：「加入画布」仅平板显示（D28）；LAN 图不走画布取流管线，一并隐藏
        val isTablet = resources.configuration.screenWidthDp >= 600 &&
            resources.configuration.screenHeightDp >= 480
        val canvasItem = MoreMenuItem("加入画布", colorTextPrimary(), iconRes = R.drawable.ic_lucide_frame) {
            listener?.onAddToCanvas(item.fileId)
        }
        // 竖屏收敛（applyTopBarFormFactor）收起的三个动作补进菜单头部：幻灯片/横屏查看/
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
                add(MoreMenuItem("横屏查看", colorTextPrimary(), iconRes = R.drawable.ic_lucide_rotate_cw) { toggleScreenOrientation() })
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
    // internal：抽屉装配簇已拆到 NativeGalleryViewDrawer.kt（第 22 刀）
    internal fun shareCurrentImage() {
        val item = images.getOrNull(currentIndex) ?: return
        if (item.isLan) {
            Toast.makeText(context, "无法分享局域网图片", Toast.LENGTH_SHORT).show()
            return
        }
        listener?.onShare(item.path)
    }

    // ====== 幻灯片（委托给独立全屏覆盖层 SlideshowView）======
    /** 标记幻灯片启动时是否由本组件隐藏了系统状态栏（查看器已沉浸时为 false，退出时据此恢复）。 */
    // internal：生命周期布局簇已拆到 NativeGalleryViewLayout.kt（第 24 刀）
    internal var slideshowHidSystemUi = false

    private fun slideshowConfig() = SlideshowView.SlideshowConfig(
        intervalMs = slideshowIntervalMs,
        transition = slideshowTransition,
        isRandom = slideshowRandom,
        enableZoom = slideshowZoom
    )

    /** 顶栏播放按钮回调：未播放则启动，播放中则退出（播放时按钮被覆盖，实际仅触发启动）。 */
    // internal：抽屉装配簇已拆到 NativeGalleryViewDrawer.kt（第 22 刀）
    internal fun toggleSlideshow() {
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

    // internal：抽屉装配簇已拆到 NativeGalleryViewDrawer.kt（第 22 刀）
    internal fun updateSlideshowButtonIcon() {
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
        // internal：进出过渡与加载簇已拆到 NativeGalleryViewTransitions.kt（第 25 刀）
        internal const val TAG = "NativeGalleryView"
        /** 翻页动画贝塞尔曲线插值器：快速进场 → 接近中心时平滑减速 */
        // internal：手势翻图簇已拆到 NativeGalleryViewGestures.kt（第 23 刀）
        internal val SWIPE_INTERPOLATOR = PathInterpolator(0f, 0f, 0.2f, 1f)
        /** 进出过渡揭幕时 chrome 的淡入时长与节奏（见 [revealAfterTransition]） */
        private const val TRANSITION_CHROME_MS = 140L
        private val TRANSITION_CHROME_EASING = PathInterpolator(0.05f, 0.7f, 0.1f, 1f)
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
        // internal：生命周期布局簇已拆到 NativeGalleryViewLayout.kt（第 24 刀）
        internal const val DRAWER_TOP_PAD_DP = 12f
        /**
         * 顶栏顶边与状态栏底边之间的间距（dp）。2026-10-07 用户拍板「状态栏下方就是顶部
         * 工具栏、中间不要有空隙」→ 0。原 8dp 是 2026-09-27 对齐图库卡片形制的内缩。
         */
        // internal：抽屉装配簇已拆到 NativeGalleryViewDrawer.kt（第 22 刀）
        internal const val TOP_BAR_TOP_GAP_DP = 0f
    }

    /** 翻页间隔的像素值 */
    // internal：手势翻图簇已拆到 NativeGalleryViewGestures.kt（第 23 刀）
    internal val swipeGapPx: Float get() = resources.displayMetrics.density * SWIPE_GAP_DP
}
