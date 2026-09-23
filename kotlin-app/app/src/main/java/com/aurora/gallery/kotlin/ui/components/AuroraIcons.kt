package com.aurora.gallery.kotlin.ui.components

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.PathBuilder
import androidx.compose.ui.graphics.vector.path
import androidx.compose.ui.unit.dp

/**
 * Aurora 自绘图标集（M4c 2.6）：lucide 线性风格（24 视口 / 2 线宽 / 圆头），与 TopBar
 * 同一套画法。TopBar 自 M1 起自带一份 builder——M4c 设置界面图形化需要十几个新图标，
 * builder 上移至此共享（TopBar 的既有图标引用不变，仅 builder 换来源）。
 *
 * 图标名对齐桌面 lucide-react 引用（SettingsModal 导航 / GeneralPanel 卡片 /
 * AboutPanel 区块），路径按 lucide 24 视口手写；无法 1:1 的（Brain→Bot、Github→Code）
 * 用同语义简形，见各图标注释。
 */
internal const val AURORA_STROKE = 2f

internal fun auroraIcon(
    name: String,
    block: PathBuilder.() -> Unit,
): ImageVector = ImageVector.Builder(
    name = name,
    defaultWidth = 24.dp,
    defaultHeight = 24.dp,
    viewportWidth = 24f,
    viewportHeight = 24f,
).apply {
    path(
        stroke = SolidColor(Color.Black),
        strokeLineWidth = AURORA_STROKE,
        strokeLineCap = StrokeCap.Round,
        strokeLineJoin = StrokeJoin.Round,
    ) { block() }
}.build()

/** 在 [PathBuilder] 上画圆角矩形（lucide 的 rect rx）。 */
internal fun PathBuilder.roundedRect(x: Float, y: Float, w: Float, h: Float, r: Float) {
    moveTo(x + r, y)
    lineTo(x + w - r, y)
    arcTo(r, r, 0f, false, true, x + w, y + r)
    lineTo(x + w, y + h - r)
    arcTo(r, r, 0f, false, true, x + w - r, y + h)
    lineTo(x + r, y + h)
    arcTo(r, r, 0f, false, true, x, y + h - r)
    lineTo(x, y + r)
    arcTo(r, r, 0f, false, true, x + r, y)
    close()
}

/** 以 [cx],[cy] 为圆心、[r] 为半径画整圆（两段半圆弧）。 */
internal fun PathBuilder.fullCircle(cx: Float, cy: Float, r: Float) {
    moveTo(cx - r, cy)
    arcTo(r, r, 0f, true, true, cx + r, cy)
    arcTo(r, r, 0f, true, true, cx - r, cy)
}

/** 微线段当圆点（stroke 圆头放大成可见小点，lucide 的 h.02 技巧）。 */
internal fun PathBuilder.dot(cx: Float, cy: Float) {
    moveTo(cx, cy)
    lineTo(cx + 0.01f, cy)
}

// —— 设置导航（SettingsModal.tsx:67-118 的 lucide 引用）——

/** lucide sliders-horizontal（常规导航/设置标题）。 */
internal val IconSliders: ImageVector by lazy {
    auroraIcon("Sliders") {
        moveTo(21f, 4f)
        lineTo(14f, 4f)
        moveTo(10f, 4f)
        lineTo(3f, 4f)
        moveTo(21f, 12f)
        lineTo(12f, 12f)
        moveTo(8f, 12f)
        lineTo(3f, 12f)
        moveTo(21f, 20f)
        lineTo(16f, 20f)
        moveTo(12f, 20f)
        lineTo(3f, 20f)
        moveTo(14f, 2f)
        lineTo(14f, 6f)
        moveTo(8f, 10f)
        lineTo(8f, 14f)
        moveTo(16f, 18f)
        lineTo(16f, 22f)
    }
}

/** lucide database（存储导航/主色调占位）。椭圆用 cubic 等价（PathBuilder 无弧顶椭圆原语）。 */
internal val IconDatabase: ImageVector by lazy {
    auroraIcon("Database") {
        moveTo(3f, 5f)
        curveTo(3f, 6.66f, 7f, 8f, 12f, 8f)
        curveTo(17f, 8f, 21f, 6.66f, 21f, 5f)
        curveTo(21f, 3.34f, 17f, 2f, 12f, 2f)
        curveTo(7f, 2f, 3f, 3.34f, 3f, 5f)
        close()
        moveTo(3f, 5f)
        lineTo(3f, 19f)
        curveTo(3f, 20.66f, 7f, 22f, 12f, 22f)
        curveTo(17f, 22f, 21f, 20.66f, 21f, 19f)
        lineTo(21f, 5f)
        moveTo(3f, 12f)
        curveTo(3f, 13.66f, 7f, 15f, 12f, 15f)
        curveTo(17f, 15f, 21f, 13.66f, 21f, 12f)
    }
}

/**
 * lucide bot→brain（AI 智能导航）。取 TreeSidebar「人物」Section 的 IconBrain（M4a 的
 * 贝塞尔脑叶，观感对齐桌面 Brain）作为共享版，替换原 Bot 简形。
 */
internal val IconBot: ImageVector by lazy {
    auroraIcon("Brain") {
        // 左脑叶：顶 → 左上凸 → 左缘 → 左下凸 → 底 → 回中缝
        moveTo(12f, 5f)
        curveTo(10.9f, 3.9f, 8.6f, 3.9f, 7.2f, 5.1f)
        curveTo(5.2f, 5.6f, 4.1f, 7.7f, 4.9f, 9.6f)
        curveTo(3.4f, 10.9f, 3.3f, 13.3f, 4.7f, 14.7f)
        curveTo(4.5f, 16.9f, 6.3f, 18.8f, 8.5f, 18.7f)
        curveTo(9.4f, 19.7f, 11.2f, 19.8f, 12f, 18.6f)
        close()
        // 右脑叶（镜像）
        moveTo(12f, 5f)
        curveTo(13.1f, 3.9f, 15.4f, 3.9f, 16.8f, 5.1f)
        curveTo(18.8f, 5.6f, 19.9f, 7.7f, 19.1f, 9.6f)
        curveTo(20.6f, 10.9f, 20.7f, 13.3f, 19.3f, 14.7f)
        curveTo(19.5f, 16.9f, 17.7f, 18.8f, 15.5f, 18.7f)
        curveTo(14.6f, 19.7f, 12.8f, 19.8f, 12f, 18.6f)
        close()
        // 中缝细节（对齐 lucide 中部 V 形曲线）
        moveTo(15f, 13f)
        curveTo(13.8f, 12.2f, 12.5f, 10.8f, 12f, 9.2f)
        curveTo(11.5f, 10.8f, 10.2f, 12.2f, 9f, 13f)
    }
}

/** lucide wifi（局域网共享导航）。三段弧用 cubic 近似（quad→cubic 换算，2/3 控制点）。 */
internal val IconWifi: ImageVector by lazy {
    auroraIcon("Wifi") {
        moveTo(2f, 9f)
        curveTo(8.67f, 4f, 15.33f, 4f, 22f, 9f)
        moveTo(5f, 12.5f)
        curveTo(9.67f, 8.83f, 14.33f, 8.83f, 19f, 12.5f)
        moveTo(8.5f, 16f)
        curveTo(10.83f, 14.13f, 13.17f, 14.13f, 15.5f, 16f)
        dot(12f, 19.5f)
    }
}

/** lucide info（关于导航）。 */
internal val IconInfo: ImageVector by lazy {
    auroraIcon("Info") {
        fullCircle(12f, 12f, 10f)
        moveTo(12f, 16f)
        lineTo(12f, 12f)
        dot(12f, 8f)
    }
}

// —— 常规页：语言 / 外观（主题卡）——

/** lucide globe（语言按钮）。经线两条 cubic 弧。 */
internal val IconGlobe: ImageVector by lazy {
    auroraIcon("Globe") {
        fullCircle(12f, 12f, 10f)
        moveTo(2f, 12f)
        lineTo(22f, 12f)
        moveTo(12f, 2f)
        curveTo(14.67f, 8.67f, 14.67f, 15.33f, 12f, 22f)
        moveTo(12f, 2f)
        curveTo(9.33f, 8.67f, 9.33f, 15.33f, 12f, 22f)
    }
}

/** lucide sun（主题卡·浅色）：圆 + 8 根射线。 */
internal val IconSun: ImageVector by lazy {
    auroraIcon("Sun") {
        fullCircle(12f, 12f, 4f)
        moveTo(12f, 2f)
        lineTo(12f, 4f)
        moveTo(12f, 20f)
        lineTo(12f, 22f)
        moveTo(4.93f, 4.93f)
        lineTo(6.34f, 6.34f)
        moveTo(17.66f, 17.66f)
        lineTo(19.07f, 19.07f)
        moveTo(2f, 12f)
        lineTo(4f, 12f)
        moveTo(20f, 12f)
        lineTo(22f, 12f)
        moveTo(4.93f, 19.07f)
        lineTo(6.34f, 17.66f)
        moveTo(17.66f, 6.34f)
        lineTo(19.07f, 4.93f)
    }
}

/** lucide moon（主题卡·深色）：a6,6 弧到 (21,12)（sweep 0）+ a9,9 大弧回起点（sweep 1）。 */
internal val IconMoon: ImageVector by lazy {
    auroraIcon("Moon") {
        moveTo(12f, 3f)
        arcTo(6.36f, 6.36f, 0f, false, false, 21f, 12f)
        arcTo(9f, 9f, 0f, true, true, 12f, 3f)
    }
}

/** lucide monitor（主题卡·跟随系统）。 */
internal val IconMonitor: ImageVector by lazy {
    auroraIcon("Monitor") {
        roundedRect(2f, 3f, 20f, 14f, 2f)
        moveTo(8f, 21f)
        lineTo(16f, 21f)
        moveTo(12f, 17f)
        lineTo(12f, 21f)
    }
}

/** lucide palette（外观节标题/主色调占位）。外圆留底部缺口 + 三个色点（cubic 描形）。 */
internal val IconPalette: ImageVector by lazy {
    auroraIcon("Palette") {
        moveTo(12f, 22f)
        curveTo(6.49f, 22f, 2f, 17.51f, 2f, 12f)
        curveTo(2f, 6.49f, 6.49f, 2f, 12f, 2f)
        curveTo(17.51f, 2f, 22f, 6.49f, 22f, 12f)
        curveTo(22f, 13.1f, 21.1f, 14f, 20f, 14f)
        lineTo(17f, 14f)
        curveTo(15.9f, 14f, 15f, 14.9f, 15f, 16f)
        curveTo(15f, 16.53f, 15.21f, 17.01f, 15.55f, 17.36f)
        curveTo(15.91f, 17.72f, 16.13f, 18.22f, 16.13f, 18.78f)
        curveTo(16.13f, 19.88f, 15.24f, 20.78f, 14.13f, 20.78f)
        lineTo(12f, 22f)
        close()
        dot(7.5f, 10.5f)
        dot(12f, 7.5f)
        dot(16.5f, 10.5f)
    }
}

// —— 默认布局：视图模式卡 / 排序按钮组 / 分组卡 ——

/** lucide grid-3x3（视图卡·网格 / 分组卡·按类型）。 */
internal val IconGrid3: ImageVector by lazy {
    auroraIcon("Grid3") {
        roundedRect(3f, 3f, 18f, 18f, 2f)
        moveTo(3f, 9f)
        lineTo(21f, 9f)
        moveTo(3f, 15f)
        lineTo(21f, 15f)
        moveTo(9f, 3f)
        lineTo(9f, 21f)
        moveTo(15f, 3f)
        lineTo(15f, 21f)
    }
}

/** lucide layout-grid（视图卡·自适应 / 默认布局节标题）：2×2 圆角方块。 */
internal val IconLayoutGrid: ImageVector by lazy {
    auroraIcon("LayoutGrid") {
        roundedRect(3f, 3f, 7f, 7f, 1f)
        roundedRect(14f, 3f, 7f, 7f, 1f)
        roundedRect(3f, 14f, 7f, 7f, 1f)
        roundedRect(14f, 14f, 7f, 7f, 1f)
    }
}

/** lucide layout-template（视图卡·瀑布流）。 */
internal val IconLayoutTemplate: ImageVector by lazy {
    auroraIcon("LayoutTemplate") {
        roundedRect(3f, 3f, 18f, 18f, 2f)
        moveTo(3f, 9f)
        lineTo(21f, 9f)
        moveTo(9f, 21f)
        lineTo(9f, 9f)
    }
}

/** lucide type（排序·按名称）。 */
internal val IconType: ImageVector by lazy {
    auroraIcon("Type") {
        moveTo(4f, 7f)
        lineTo(4f, 4f)
        lineTo(20f, 4f)
        lineTo(20f, 7f)
        moveTo(9f, 20f)
        lineTo(15f, 20f)
        moveTo(12f, 4f)
        lineTo(12f, 20f)
    }
}

/** lucide calendar（排序·按时间 / 分组卡·按日期）。 */
internal val IconCalendarDays: ImageVector by lazy {
    auroraIcon("CalendarDays") {
        moveTo(8f, 2f)
        lineTo(8f, 6f)
        moveTo(16f, 2f)
        lineTo(16f, 6f)
        roundedRect(3f, 4f, 18f, 18f, 2f)
        moveTo(3f, 10f)
        lineTo(21f, 10f)
    }
}

/** lucide hard-drive（排序·按大小 / 本地相册 Section；TreeSidebar M1 版上移共享）。 */
internal val IconHardDrive: ImageVector by lazy {
    auroraIcon("HardDrive") {
        moveTo(5.45f, 5.11f)
        lineTo(2f, 12f)
        lineTo(2f, 18f)
        arcTo(2f, 2f, 0f, false, true, 4f, 20f)
        lineTo(20f, 20f)
        arcTo(2f, 2f, 0f, false, true, 22f, 18f)
        lineTo(22f, 12f)
        lineTo(18.55f, 5.11f)
        arcTo(2f, 2f, 0f, false, true, 16.76f, 4f)
        lineTo(7.24f, 4f)
        arcTo(2f, 2f, 0f, false, true, 5.45f, 5.11f)
        close()
        moveTo(2f, 12f)
        lineTo(22f, 12f)
        // 指示灯两点（圆头线帽放大成点）
        moveTo(6f, 16f)
        lineTo(6.01f, 16f)
        moveTo(10f, 16f)
        lineTo(10.01f, 16f)
    }
}

/** lucide arrow-up（排序方向·升序）。 */
internal val IconArrowUp: ImageVector by lazy {
    auroraIcon("ArrowUp") {
        moveTo(12f, 19f)
        lineTo(12f, 5f)
        moveTo(5f, 12f)
        lineTo(12f, 5f)
        lineTo(19f, 12f)
    }
}

/** lucide arrow-down（排序方向·降序）。 */
internal val IconArrowDown: ImageVector by lazy {
    auroraIcon("ArrowDown") {
        moveTo(12f, 5f)
        lineTo(12f, 19f)
        moveTo(19f, 12f)
        lineTo(12f, 19f)
        lineTo(5f, 12f)
    }
}

/** lucide layers（分组卡·不分组）。 */
internal val IconLayers: ImageVector by lazy {
    auroraIcon("Layers") {
        moveTo(12f, 2f)
        lineTo(2f, 7f)
        lineTo(12f, 12f)
        lineTo(22f, 7f)
        lineTo(12f, 2f)
        close()
        moveTo(2f, 17f)
        lineTo(12f, 22f)
        lineTo(22f, 17f)
        moveTo(2f, 12f)
        lineTo(12f, 17f)
        lineTo(22f, 12f)
    }
}

/** lucide check（选中角标/按钮勾）。 */
internal val IconCheck: ImageVector by lazy {
    auroraIcon("Check") {
        moveTo(20f, 6f)
        lineTo(9f, 17f)
        lineTo(4f, 12f)
    }
}

// —— 占位页 / 存储节 ——

/**
 * lucide wifi-off（局域网共享占位页大图标 / 网络 Section 断连态；TreeSidebar M3 调过的
 * 完整版上移共享：两段残弧 + 底部点 + 斜杠，16dp 观感一致）。
 */
internal val IconWifiOff: ImageVector by lazy {
    auroraIcon("WifiOff") {
        // 底部点
        moveTo(12f, 20f)
        lineTo(12.01f, 20f)
        // 内弧（完整）
        moveTo(8.5f, 16.43f)
        curveTo(9.9f, 15.1f, 14.1f, 15.1f, 15.5f, 16.43f)
        // 中弧左残段（斜杠截断）
        moveTo(5f, 12.86f)
        curveTo(6.6f, 12.1f, 8.3f, 11.2f, 10.17f, 10.17f)
        // 中弧右残段
        moveTo(19f, 12.86f)
        curveTo(18.4f, 12.4f, 17.7f, 11.9f, 16.99f, 11.34f)
        // 外弧左残段
        moveTo(2f, 8.82f)
        curveTo(3.3f, 8.1f, 4.6f, 7.1f, 6.18f, 6.18f)
        // 外弧右残段
        moveTo(22f, 8.82f)
        curveTo(18f, 7.2f, 14.3f, 5.7f, 10.71f, 5.06f)
        // 斜杠
        moveTo(2f, 2f)
        lineTo(22f, 22f)
    }
}

// —— 关于页（AboutPanel 区块引用）——

/** lucide code（技术栈版本节标题 / GitHub 卡：源代码语义）。 */
internal val IconCode: ImageVector by lazy {
    auroraIcon("Code") {
        moveTo(16f, 18f)
        lineTo(22f, 12f)
        lineTo(16f, 6f)
        moveTo(8f, 6f)
        lineTo(2f, 12f)
        lineTo(8f, 18f)
    }
}

/** lucide external-link（相关链接节标题）。 */
internal val IconExternalLink: ImageVector by lazy {
    auroraIcon("ExternalLink") {
        moveTo(18f, 13f)
        lineTo(18f, 19f)
        arcTo(2f, 2f, 0f, false, true, 16f, 21f)
        lineTo(5f, 21f)
        arcTo(2f, 2f, 0f, false, true, 3f, 19f)
        lineTo(3f, 8f)
        arcTo(2f, 2f, 0f, false, true, 5f, 6f)
        lineTo(11f, 6f)
        moveTo(15f, 3f)
        lineTo(21f, 3f)
        lineTo(21f, 9f)
        moveTo(10f, 14f)
        lineTo(21f, 3f)
    }
}

/** lucide shield（问题反馈卡）。 */
internal val IconShield: ImageVector by lazy {
    auroraIcon("Shield") {
        moveTo(12f, 2f)
        curveTo(14f, 4f, 17f, 4.6f, 20f, 4.6f)
        lineTo(20f, 12f)
        curveTo(20f, 17f, 17f, 20.2f, 12f, 22f)
        curveTo(7f, 20.2f, 4f, 17f, 4f, 12f)
        lineTo(4f, 4.6f)
        curveTo(7f, 4.6f, 10f, 4f, 12f, 2f)
        close()
    }
}

/** 实心红心（致谢页脚，fill 不 stroke——单独 builder；曲线同 PathBuilder 的 curveTo）。 */
internal val IconHeartFill: ImageVector by lazy {
    ImageVector.Builder(
        name = "HeartFill",
        defaultWidth = 24.dp,
        defaultHeight = 24.dp,
        viewportWidth = 24f,
        viewportHeight = 24f,
    ).apply {
        path(fill = SolidColor(Color.Black)) {
            moveTo(12f, 21f)
            curveTo(10f, 19.5f, 2f, 14.5f, 2f, 8.8f)
            curveTo(2f, 5.6f, 4.5f, 3f, 7.6f, 3f)
            curveTo(9.4f, 3f, 11f, 3.9f, 12f, 5.3f)
            curveTo(13f, 3.9f, 14.6f, 3f, 16.4f, 3f)
            curveTo(19.5f, 3f, 22f, 5.6f, 22f, 8.8f)
            curveTo(22f, 14.5f, 14f, 19.5f, 12f, 21f)
            close()
        }
    }.build()
}

// —— 画布菜单 / 画布工具（CanvasMenu、沉浸态、添加图片等引用）——

/** lucide scan（画布菜单「查看全部」）：四角括号。 */
internal val IconScan: ImageVector by lazy {
    auroraIcon("Scan") {
        moveTo(3f, 7f)
        lineTo(3f, 5f)
        arcTo(2f, 2f, 0f, false, true, 5f, 3f)
        lineTo(7f, 3f)
        moveTo(17f, 3f)
        lineTo(19f, 3f)
        arcTo(2f, 2f, 0f, false, true, 21f, 5f)
        lineTo(21f, 7f)
        moveTo(21f, 17f)
        lineTo(21f, 19f)
        arcTo(2f, 2f, 0f, false, true, 19f, 21f)
        lineTo(17f, 21f)
        moveTo(7f, 21f)
        lineTo(5f, 21f)
        arcTo(2f, 2f, 0f, false, true, 3f, 19f)
        lineTo(3f, 17f)
    }
}

/** lucide refresh-ccw（画布菜单「重置」）：逆时针双弧箭头（弧均 sweep=false）。 */
internal val IconRefreshCcw: ImageVector by lazy {
    auroraIcon("RefreshCcw") {
        moveTo(21f, 12f)
        arcTo(9f, 9f, 0f, false, false, 12f, 3f)
        arcTo(9.75f, 9.75f, 0f, false, false, 5.26f, 5.74f)
        lineTo(3f, 8f)
        moveTo(3f, 3f)
        lineTo(3f, 8f)
        lineTo(8f, 8f)
        moveTo(3f, 12f)
        arcTo(9f, 9f, 0f, false, false, 12f, 21f)
        arcTo(9.75f, 9.75f, 0f, false, false, 18.74f, 18.26f)
        lineTo(21f, 16f)
        moveTo(16f, 16f)
        lineTo(21f, 16f)
        lineTo(21f, 21f)
    }
}

/** lucide magnet（画布菜单「吸附功能」）。 */
internal val IconMagnet: ImageVector by lazy {
    auroraIcon("Magnet") {
        moveTo(6f, 15f)
        lineTo(2f, 11f)
        lineTo(8.75f, 4.23f)
        arcTo(7.79f, 7.79f, 0f, false, true, 19.75f, 15.23f)
        lineTo(13f, 22f)
        lineTo(9f, 18f)
        lineTo(15.39f, 11.64f)
        arcTo(2.14f, 2.14f, 0f, false, false, 12.39f, 8.64f)
        lineTo(6f, 15f)
        moveTo(5f, 8f)
        lineTo(9f, 12f)
        moveTo(12f, 15f)
        lineTo(16f, 19f)
    }
}

/** lucide trash-2（画布菜单「移除/清空」）：垃圾桶 + 两竖线。 */
internal val IconTrash2: ImageVector by lazy {
    auroraIcon("Trash2") {
        moveTo(3f, 6f)
        lineTo(21f, 6f)
        moveTo(19f, 6f)
        lineTo(19f, 20f)
        curveTo(19f, 21f, 18f, 22f, 17f, 22f)
        lineTo(7f, 22f)
        curveTo(6f, 22f, 5f, 21f, 5f, 20f)
        lineTo(5f, 6f)
        moveTo(8f, 6f)
        lineTo(8f, 4f)
        curveTo(8f, 3f, 9f, 2f, 10f, 2f)
        lineTo(14f, 2f)
        curveTo(15f, 2f, 16f, 3f, 16f, 4f)
        lineTo(16f, 6f)
        moveTo(10f, 11f)
        lineTo(10f, 17f)
        moveTo(14f, 11f)
        lineTo(14f, 17f)
    }
}

/** lucide maximize（画布菜单「查看此图/放置到顶层」等）：四角外扩括号。 */
internal val IconMaximize: ImageVector by lazy {
    auroraIcon("Maximize") {
        moveTo(8f, 3f)
        lineTo(5f, 3f)
        arcTo(2f, 2f, 0f, false, false, 3f, 5f)
        lineTo(3f, 8f)
        moveTo(21f, 8f)
        lineTo(21f, 5f)
        arcTo(2f, 2f, 0f, false, false, 19f, 3f)
        lineTo(16f, 3f)
        moveTo(3f, 16f)
        lineTo(3f, 19f)
        arcTo(2f, 2f, 0f, false, false, 5f, 21f)
        lineTo(8f, 21f)
        moveTo(16f, 21f)
        lineTo(19f, 21f)
        arcTo(2f, 2f, 0f, false, false, 21f, 19f)
        lineTo(21f, 16f)
    }
}

/** lucide minimize-2（画布沉浸退出态）：双向内收斜箭头。 */
internal val IconMinimize2: ImageVector by lazy {
    auroraIcon("Minimize2") {
        moveTo(4f, 14f)
        lineTo(10f, 14f)
        lineTo(10f, 20f)
        moveTo(20f, 10f)
        lineTo(14f, 10f)
        lineTo(14f, 4f)
        moveTo(14f, 10f)
        lineTo(21f, 3f)
        moveTo(3f, 21f)
        lineTo(10f, 14f)
    }
}

/** lucide plus（画布「添加图片」按钮）。 */
internal val IconPlus: ImageVector by lazy {
    auroraIcon("Plus") {
        moveTo(5f, 12f)
        lineTo(19f, 12f)
        moveTo(12f, 5f)
        lineTo(12f, 19f)
    }
}

/** lucide maximize-2（画布沉浸进入态）：双向外扩斜箭头。 */
internal val IconMaximize2: ImageVector by lazy {
    auroraIcon("Maximize2") {
        moveTo(15f, 3f)
        lineTo(21f, 3f)
        lineTo(21f, 9f)
        moveTo(9f, 21f)
        lineTo(3f, 21f)
        lineTo(3f, 15f)
        moveTo(21f, 3f)
        lineTo(14f, 10f)
        moveTo(3f, 21f)
        lineTo(10f, 14f)
    }
}
