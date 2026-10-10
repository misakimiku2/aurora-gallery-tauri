package com.aurora.gallery.kotlin.ui.components

import android.app.Activity
import android.app.Dialog
import android.graphics.Bitmap
import android.graphics.Outline
import android.graphics.drawable.ColorDrawable
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.PixelCopy
import android.view.View
import android.view.ViewOutlineProvider
import android.view.ViewGroup
import android.view.Window
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.BlurEffect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.TileMode
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.path
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.ComposeView
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.findViewTreeLifecycleOwner
import androidx.lifecycle.setViewTreeLifecycleOwner
import androidx.savedstate.findViewTreeSavedStateRegistryOwner
import androidx.savedstate.setViewTreeSavedStateRegistryOwner
import com.aurora.gallery.kotlin.ui.theme.AuroraTheme
import com.aurora.gallery.kotlin.ui.theme.LocalAuroraColors
import kotlin.math.roundToInt

/**
 * 桌面同款弹出菜单容器（毛玻璃，2026-09-20）：w-48(192dp) + 90% 半透明 panel 底 +
 * subtle 描边 + rounded-lg + 背景实时模糊，锚定在按钮正下方并右对齐
 * （React `top-full right-0 mt-2`；React 侧 = bg-[#fafafa]/90 + backdrop-blur-md）。
 *
 * **实现为什么是原生 `android.app.Dialog` 小窗口 + PixelCopy 快照**：桌面的
 * backdrop-blur 模糊的是「菜单背后那一块」背景。Compose `Popup` 拿不到背后像素；
 * 窗口级 FLAG_BLUR_BEHIND 依赖系统的交叉窗口模糊开关（省电模式/关闭动画/部分 OEM
 * 会禁用，实测用户的平板上不生效）。定稿方案：窗口大小 = 菜单边界，菜单尺寸就绪后
 * 用 PixelCopy 从**宿主窗口**拷贝菜单正后方的区域（PixelCopy 只拷宿主自己的
 * surface，不含弹层本身），GPU 模糊后垫在 90% 面板底之下——与桌面观感逐像素等价，
 * 不依赖任何系统开关；拷贝失败（API<26 等）退化为纯半透明底。
 *
 * 弹层是独立组合，ComposeView 挂宿主 ViewTree 的 Lifecycle/SavedState owners；
 * 内容与关闭回调经 rememberUpdatedState 取最新值。点外部/返回键触发
 * [onDismissRequest]；选项点击后不收起（调用方控制 expanded，对齐 React 可连续
 * 调字段/方向/分组）。高度上限 = 锚点下方到屏幕底缘的可用空间（2026-09-28 起，
 * 原固定 480dp 会把空间充足时的长菜单也截进滚动区）；真放不下时内部滚动兜底。
 */
@Composable
internal fun AuroraDropdown(
    expanded: Boolean,
    anchorBoundsInWindow: Rect,
    onDismissRequest: () -> Unit,
    /**
     * 菜单水平对齐端：true（默认）=菜单右缘贴锚点右缘（工具栏按钮都在屏幕右半区）；
     * false=菜单左缘贴锚点左缘（桌面 scope 菜单的 left-0 同款）——scope 钮在胶囊最左缘，
     * 右对齐公式（锚点右缘−192dp）在手机上会算出负 x 把菜单推出屏外。
     */
    alignToAnchorEnd: Boolean = true,
    content: @Composable ColumnScope.() -> Unit,
) {
    val context = LocalContext.current
    val view = LocalView.current
    val density = LocalDensity.current
    // 状态栏 inset 修正（M8b 验收反馈）：锚点 boundsInWindow() 以主窗口（targetSdk 35
    // 强制 edge-to-edge，frame=[0,0][屏]）为原点，而 Dialog 应用子窗口的 y 相对父窗口
    // 内容框（状态栏之下，dumpsys 实测 parent=[0,142]…）——不扣除状态栏高度，菜单整体
    // 下坠一个状态栏（avd_ai1 实测 142px≈54dp）。
    val statusTopPx = remember {
        runCatching {
            androidx.core.view.WindowInsetsCompat.toWindowInsetsCompat(view.rootWindowInsets)
                .getInsets(androidx.core.view.WindowInsetsCompat.Type.statusBars()).top
        }.getOrDefault(0)
    }
    val latestOnDismiss by rememberUpdatedState(onDismissRequest)
    val latestContent by rememberUpdatedState(content)
    val latestAnchor by rememberUpdatedState(anchorBoundsInWindow)
    // 宿主色板（M8b-12 用户拍板：深色主题下弹层不再固定浅色样式）。AuroraDropdown
    // 组合在应用根 AuroraTheme 内，此处取到的就是宿主当前主题；DisposableEffect 块
    // 不是 Composable 作用域，须在这里先取。Dialog 独立组合会继承 CompositionLocal，
    // 但要在 setContent 里用 CompositionLocalProvider 覆盖回宿主值（原来在这里被
    // AuroraTheme(darkTheme=false) 固定浅色——那是 M4b 时「弹层默认跟随系统而主界面
    // 跟随用户设置」两者错位的反向修补，如今宿主主题即唯一事实）。
    val hostColors = AuroraTheme.colors
    val dialogRef = remember { mutableStateOf<Dialog?>(null) }

    if (!expanded) return

    // show/dismiss 只跟随 [expanded]；锚点经 rememberUpdatedState 在下方
    // LaunchedEffect 里跟随更新——不作为本 effect 的 key（侧栏开合动画期间锚点
    // 逐帧变化，作为 key 会让窗口反复重建）
    DisposableEffect(expanded) {
        val menuWidth = with(density) { 192.dp.roundToPx() }
        val gap = with(density) { 8.dp.roundToPx() }
        val outlineRadius = with(density) { 8.dp.toPx() }
        val elevation = with(density) { 8.dp.toPx() }

        val dialog = Dialog(context)
        dialog.requestWindowFeature(Window.FEATURE_NO_TITLE)
        dialog.setCanceledOnTouchOutside(true)
        // M4b 1.4 排查日志：系统侧 dismiss（点外部/返回）都会走到这里；配合宿主的
        // expanded 状态日志能定位「菜单自己关了」是谁触发的
        dialog.setOnDismissListener {
            android.util.Log.i("AuroraMenu", "AuroraDropdown dismissed -> onDismissRequest")
            latestOnDismiss()
        }

        val composeView = ComposeView(context).apply {
            // 弹层是独立组合：挂宿主 Activity 的生命周期/状态注册表，Recomposer 才有宿主
            // （lifecycle 2.8 起 ViewTreeLifecycleOwner 类为 internal，只能走 ktx 扩展函数）
            view.findViewTreeLifecycleOwner()?.let { setViewTreeLifecycleOwner(it) }
            view.findViewTreeSavedStateRegistryOwner()?.let { setViewTreeSavedStateRegistryOwner(it) }
            setContent {
                // 弹层随宿主主题（M8b-12）：覆盖回宿主色板，深色主题下弹层=深色半透明
                // 板+浅字；大括号与原 AuroraTheme(darkTheme=false) 一一对应，体未改
                CompositionLocalProvider(LocalAuroraColors provides hostColors) {
                    var backdrop by remember { mutableStateOf<Bitmap?>(null) }
                    var menuHeightPx by remember { mutableIntStateOf(0) }

                    // 毛玻璃背景快照：菜单尺寸就绪后拷贝菜单正后方的宿主画面
                    val activityWindow = (context as? Activity)?.window
                    LaunchedEffect(menuHeightPx) {
                        val host = activityWindow ?: return@LaunchedEffect
                        if (menuHeightPx <= 0 || backdrop != null) return@LaunchedEffect
                        if (Build.VERSION.SDK_INT < 26) return@LaunchedEffect
                        val anchor = latestAnchor
                        // 左对齐=菜单左缘贴锚点左缘（桌面 left-0）；右对齐=菜单右缘贴锚点右缘
                        val left = (
                            if (alignToAnchorEnd) anchor.right - menuWidth else anchor.left
                            ).roundToInt().coerceAtLeast(0)
                        val top = (anchor.bottom.roundToInt() + gap).coerceAtLeast(0)
                        val decor = host.decorView
                        val width = minOf(menuWidth, decor.width - left)
                        val height = minOf(menuHeightPx, decor.height - top)
                        if (width <= 0 || height <= 0) return@LaunchedEffect
                        val rect = android.graphics.Rect(left, top, left + width, top + height)
                        val snapshot = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
                        PixelCopy.request(
                            host,
                            rect,
                            snapshot,
                            { result ->
                                if (result == PixelCopy.SUCCESS) {
                                    // GPU BlurEffect 仅 31+ 生效（997 行守卫）；26-30 上
                                    // 快照原样清晰垫底=「毛玻璃消失只剩透明」（荣耀
                                    // Android 10 真机报障）——先在位图层面糊掉再垫底
                                    backdrop = if (Build.VERSION.SDK_INT >= 31) snapshot
                                    else blurBackdropSnapshot(context, snapshot)
                                }
                            },
                            Handler(Looper.getMainLooper()),
                        )
                    }

                    Box(Modifier.width(192.dp)) {
                        // 高度上限 = 锚点下缘到屏幕底缘的实际可用空间（留 16dp 底距），
                        // 而非旧的固定 480dp——480dp 会把 10 项的长按菜单（≈496dp）在
                        // 下方空间充足时也截进滚动区、末行裁半（2026-09-28 用户反馈：
                        // 屏幕高度够就应完整展示全部内容，不需要滚动）。空间真不够
                        // （矮屏/横屏/锚点贴底）时上限随之收紧并保底 120dp，
                        // verticalScroll 仍是安全阀。坐标口径：锚点是宿主窗口系、
                        // 屏高是全屏系，宿主 edge-to-edge 两系原点一致，statusTop 不用扣。
                        val menuMaxHeight = with(density) {
                            val bottomMargin = 16.dp.toPx()
                            val gapPx = 8.dp.toPx()
                            (context.resources.displayMetrics.heightPixels -
                                latestAnchor.bottom.roundToInt() - gapPx - bottomMargin)
                                .coerceAtLeast(with(density) { 120.dp.toPx() })
                                .toDp()
                        }
                        // 模糊后的背景快照垫底；菜单打开期间内容区不可交互，
                        // 快照与实时画面等价（对齐桌面 backdrop-blur 的静态语义）
                        backdrop?.let { bmp ->
                            Image(
                                bitmap = bmp.asImageBitmap(),
                                contentDescription = null,
                                contentScale = ContentScale.FillBounds,
                                modifier = Modifier
                                    .matchParentSize()
                                    .clip(RoundedCornerShape(8.dp))
                                    .graphicsLayer {
                                        if (Build.VERSION.SDK_INT >= 31) {
                                            val r = 12.dp.toPx() // ≈ 桌面 backdrop-blur-md
                                            renderEffect = BlurEffect(r, r, TileMode.Clamp)
                                        }
                                    },
                            )
                        }
                        Column(
                            Modifier
                                .onSizeChanged { menuHeightPx = it.height }
                                .fillMaxWidth()
                                .heightIn(max = menuMaxHeight)
                                .verticalScroll(rememberScrollState())
                                .clip(RoundedCornerShape(8.dp))
                                // 2026-09-20 用户要求更透：桌面 /90 基础上降到 /75。
                                // M8b 验收反馈二轮：75% 太透（文字与底层网格互相干扰），
                                // 提到 /90 回到桌面同值（背景仍有 PixelCopy 毛玻璃垫底）
                                .background(AuroraTheme.colors.panel.copy(alpha = 0.9f))
                                .border(1.dp, AuroraTheme.colors.subtle, RoundedCornerShape(8.dp))
                                .padding(vertical = 8.dp),
                            content = { latestContent() },
                        )
                    }
                }
            }
        }
        dialog.setContentView(
            composeView,
            ViewGroup.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT),
        )
        dialog.window?.let { w ->
            w.setBackgroundDrawable(ColorDrawable(android.graphics.Color.TRANSPARENT))
            w.setDimAmount(0f)
            w.setGravity(Gravity.TOP or Gravity.START)
            // 窗口坐标按整个屏幕计（浮动窗口默认的 TOP 会被状态栏下移）
            if (Build.VERSION.SDK_INT >= 30) {
                w.setDecorFitsSystemWindows(false)
            } else {
                @Suppress("DEPRECATION")
                w.decorView.systemUiVisibility =
                    View.SYSTEM_UI_FLAG_LAYOUT_STABLE or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
            }
            w.setLayout(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
            )
            w.attributes.x = (
                if (alignToAnchorEnd) anchorBoundsInWindow.right - menuWidth
                else anchorBoundsInWindow.left
                ).roundToInt().coerceAtLeast(0)
            w.attributes.y = (anchorBoundsInWindow.bottom - statusTopPx).roundToInt() + gap
            // 圆角窗口投影（Compose shadow 会画在窗口外被裁掉，改用窗口级 elevation）
            w.decorView.outlineProvider = object : ViewOutlineProvider() {
                override fun getOutline(v: View, outline: Outline) {
                    outline.setRoundRect(0, 0, v.width, v.height, outlineRadius)
                }
            }
            w.setElevation(elevation)
        }
        dialogRef.value = dialog
        dialog.show()

        onDispose {
            dialog.dismiss()
            dialogRef.value = null
        }
    }

    // 锚点位移（侧栏开合把按钮推移）时跟随窗口位置
    LaunchedEffect(anchorBoundsInWindow) {
        dialogRef.value?.window?.let { w ->
            val menuWidth = with(density) { 192.dp.roundToPx() }
            val gap = with(density) { 8.dp.roundToPx() }
            w.attributes = w.attributes.apply {
                x = (
                    if (alignToAnchorEnd) anchorBoundsInWindow.right - menuWidth
                    else anchorBoundsInWindow.left
                    ).roundToInt().coerceAtLeast(0)
                y = (anchorBoundsInWindow.bottom - statusTopPx).roundToInt() + gap
            }
        }
    }
}

/** 小节标题（React `px-3 py-1 text-xs font-bold text-gray-400 uppercase`）。 */
@Composable
internal fun AuroraMenuHeader(text: String) {
    val colors = AuroraTheme.colors
    Text(
        text,
        Modifier.padding(horizontal = 12.dp, vertical = 4.dp),
        fontSize = 12.sp,
        fontWeight = FontWeight.Bold,
        color = colors.textSecondary,
    )
}

/**
 * 二级子菜单头部（M8b 验收反馈：排序/分组拆二级）：左返回箭头（点回主菜单）+ 标题，
 * React TopBar 手机竖屏子菜单的「back + 标题」头部同位。
 */
@Composable
internal fun AuroraSubmenuHeader(text: String, onBack: () -> Unit) {
    val colors = AuroraTheme.colors
    Row(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 8.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier
                .size(40.dp)
                .clip(RoundedCornerShape(8.dp))
                .clickable(onClick = onBack),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                imageVector = IconChevronLeft,
                contentDescription = "返回",
                tint = colors.textSecondary,
                modifier = Modifier.size(16.dp),
            )
        }
        Text(
            text,
            fontSize = 12.sp,
            fontWeight = FontWeight.Bold,
            color = colors.textSecondary,
        )
    }
}

/**
 * 菜单条目（React `mx-2 px-4 py-2 rounded text-sm hover:bg-blue-600 hover:text-white`）：
 * 按压 = 蓝底白字（触屏的 hover 等价物）；[checked] 画选中勾（常规蓝色、按压白色），
 * [leading] 是文字前的前导图标槽（非空时后跟 6dp 间距），[trailing] 是非勾选型尾部图标
 * （如升降序的箭头）。行高 ≥48dp（触屏最小命中目标）。
 */
@Composable
internal fun AuroraMenuItem(
    text: String,
    onClick: () -> Unit,
    checked: Boolean = false,
    leading: (@Composable () -> Unit)? = null,
    trailing: (@Composable () -> Unit)? = null,
    /** 覆盖文字色（危险项红色等）；按压态仍强制白字。 */
    textColor: Color? = null,
) {
    val colors = AuroraTheme.colors
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    Row(
        Modifier
            .padding(horizontal = 8.dp, vertical = 1.dp)
            .fillMaxWidth()
            .clip(RoundedCornerShape(4.dp))
            .background(if (pressed) colors.primary else Color.Transparent)
            .clickable(interactionSource = interaction, indication = null, onClick = onClick)
            .padding(horizontal = 16.dp)
            .heightIn(min = 48.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // 前导图标与文字成组左靠（React 菜单 icon+label 同款）；右侧留给勾/尾部图标
        Row(verticalAlignment = Alignment.CenterVertically) {
            if (leading != null) {
                leading()
                Spacer(Modifier.width(6.dp))
            }
            Text(text, fontSize = 14.sp, color = when {
                pressed -> Color.White
                textColor != null -> textColor
                else -> colors.textPrimary
            })
        }
        when {
            checked -> Icon(
                CheckMark,
                contentDescription = null,
                tint = if (pressed) Color.White else colors.primary,
                modifier = Modifier.size(14.dp),
            )
            trailing != null -> trailing()
        }
    }
}

/** 分隔线（React `border-t border-black/5 my-1`；subtle = gray-200 观感一致）。 */
@Composable
internal fun AuroraMenuDivider() {
    HorizontalDivider(
        Modifier.padding(vertical = 4.dp),
        color = AuroraTheme.colors.subtle,
    )
}

/** 菜单勾选（material 核心图标集中的 Check，与 lucide 视觉一致）。 */
private val CheckMark: ImageVector by lazy {
    ImageVector.Builder(
        name = "Check",
        defaultWidth = 24.dp,
        defaultHeight = 24.dp,
        viewportWidth = 24f,
        viewportHeight = 24f,
    ).apply {
        path(
            stroke = SolidColor(Color.Black),
            strokeLineWidth = 2.5f,
            strokeLineCap = StrokeCap.Round,
            strokeLineJoin = StrokeJoin.Round,
        ) {
            moveTo(4f, 12.5f)
            lineTo(9.5f, 18f)
            lineTo(20f, 6.5f)
        }
    }.build()
}
