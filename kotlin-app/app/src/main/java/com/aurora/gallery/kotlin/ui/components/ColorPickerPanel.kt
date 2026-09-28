package com.aurora.gallery.kotlin.ui.components

import android.content.Context
import androidx.compose.animation.core.EaseOut
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.layout
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.aurora.gallery.kotlin.ui.theme.AuroraTheme
import kotlinx.coroutines.flow.debounce
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.drop
import kotlin.math.roundToInt

/**
 * 颜色搜索取色面板（HSV 版，对齐 React `src/components/MobileColorPickerSheet.tsx`）。
 *
 * 取代 M6b 阶段 3 的「预设 14 色点一下就搜」形制：SV 面板 + Hue 滑块 + 当前色/hex 输入
 * + 预设 16 色 + 最近使用 + RGB/HSV 只读，与桌面 `ColorPickerPopover` 的取色口径一致
 * （桌面是浮层、安卓是面板，两者的 HSV 语义与预设色表逐字同源）。
 *
 * **两种宿主形态（2026-09-28 用户要求）**：平板 = 右侧推挤面板（[ColorPickerPane]，
 * 与 React `RightPanel.tsx` 的 20rem 容器同旨，与侧栏互斥）；手机（竖屏/横屏）= 底部
 * 弹层（TopBar 内的 ModalBottomSheet 承载本内容）。形态判据只有一套：
 * `isTabletForm`（宽 ≥600dp 且高 ≥480dp），见 `FormFactor.kt`。
 *
 * **实时搜索（对齐 React 的防抖双计时）**：颜色变化 300ms 防抖后回调 [onColorChange]
 * （宿主发起全库 CIEDE2000 搜索）；1.5s 防抖后才写「最近使用」，避免拖拽经过的中间色
 * 被记录。两条流都 `drop(1)`——首帧是打开时的初值，打开面板本身不该顶掉已有结果
 * （React 用 lastProcessedHexRef 守同一件事）。
 */
@Composable
fun ColorPickerPanelContent(
    /** 初值（宿主在面板打开瞬间取的当前过滤色快照；null = 白色）。 */
    initialHex: String?,
    /** 颜色落定（防抖后）→ 宿主发起颜色搜索。 */
    onColorChange: (String) -> Unit,
    /** 关闭（「完成」按钮；手机底部弹层/平板右侧面板各自收起）。 */
    onClose: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = AuroraTheme.colors
    val context = LocalContext.current
    val density = LocalDensity.current

    var hsv by remember { mutableStateOf(hexToHsv(initialHex ?: DEFAULT_PICKER_HEX)) }
    val currentHex = remember(hsv) { hsvToHex(hsv) }
    var hexInput by remember { mutableStateOf(currentHex.removePrefix("#")) }
    var recent by remember { mutableStateOf(loadRecentColors(context)) }
    var svSize by remember { mutableStateOf(IntSize.Zero) }
    var hueSize by remember { mutableStateOf(IntSize.Zero) }

    // 外部初值（面板打开时的过滤色快照）→ HSV。面板常驻不卸载，故只在 initialHex 变化
    // 时同步一次；面板内拖拽产生的同值回流不会重置拖拽中的 HSV。
    LaunchedEffect(initialHex) {
        initialHex?.let { hsv = hexToHsv(it) }
    }
    // hex 跟随当前色（React useEffect on currentHex 同旨）
    LaunchedEffect(currentHex) { hexInput = currentHex.removePrefix("#") }

    val latestOnColorChange by rememberUpdatedState(onColorChange)
    // 300ms 防抖搜索（拖拽停顿才搜，避免每帧一次全库扫描）。
    // **必须读 hsv（State 委托）而不是 currentHex**：后者是普通局部 val，LaunchedEffect
    // (Unit) 的闭包捕获的是首次组合的值，重组后的新值 snapshotFlow 永远看不到——实测
    // 表现为取色后搜索一次都不触发（2026-09-28 模拟器验证发现后修复）。
    LaunchedEffect(Unit) {
        snapshotFlow { hsvToHex(hsv) }
            .drop(1)
            .distinctUntilChanged()
            .debounce(COLOR_SEARCH_DEBOUNCE_MS)
            .collect { hex -> latestOnColorChange(hex) }
    }
    // 1.5s 防抖写最近使用（React 同值：只记停下来的颜色）
    LaunchedEffect(Unit) {
        snapshotFlow { hsvToHex(hsv) }
            .drop(1)
            .distinctUntilChanged()
            .debounce(RECENT_WRITE_DEBOUNCE_MS)
            .collect { hex ->
                addRecentColor(context, hex)
                recent = loadRecentColors(context)
            }
    }

    fun updateSv(offset: Offset) {
        val w = svSize.width.toFloat().coerceAtLeast(1f)
        val h = svSize.height.toFloat().coerceAtLeast(1f)
        hsv = hsv.copy(
            s = (offset.x / w).coerceIn(0f, 1f),
            v = (1f - offset.y / h).coerceIn(0f, 1f),
        )
    }

    fun updateHue(offset: Offset) {
        val w = hueSize.width.toFloat().coerceAtLeast(1f)
        hsv = hsv.copy(h = ((offset.x / w).coerceIn(0f, 1f)) * 360f)
    }

    Column(modifier.fillMaxHeight().background(colors.panel)) {
        // 标题（React 面板头：只有标题，收起走底部「完成」）
        Text(
            "按颜色搜索",
            fontWeight = FontWeight.SemiBold,
            fontSize = 15.sp,
            color = colors.textPrimary,
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp),
        )
        Box(Modifier.fillMaxWidth().height(1.dp).background(colors.border))

        Column(
            Modifier
                .weight(1f)
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
        ) {
            // —— SV 面板：底=hue 纯色，横叠白→透明（S），纵叠透明→黑（V）——
            val dotPx = with(density) { SV_DOT_DP.toPx() }
            Box(
                Modifier
                    .fillMaxWidth()
                    .height(SV_PANEL_HEIGHT_DP)
                    .clip(RoundedCornerShape(10.dp))
                    .background(Color.hsv(hsv.h, 1f, 1f))
                    .onSizeChanged { svSize = it }
                    .pointerInputCompat { updateSv(it) },
            ) {
                Box(
                    Modifier
                        .fillMaxWidth()
                        .height(SV_PANEL_HEIGHT_DP)
                        .background(Brush.horizontalGradient(listOf(Color.White, Color.Transparent))),
                )
                Box(
                    Modifier
                        .fillMaxWidth()
                        .height(SV_PANEL_HEIGHT_DP)
                        .background(Brush.verticalGradient(listOf(Color.Transparent, Color.Black))),
                )
                Box(
                    Modifier.offset {
                        val w = svSize.width.toFloat()
                        val h = svSize.height.toFloat()
                        IntOffset(
                            x = (hsv.s * w - dotPx / 2).roundToInt().coerceIn(0, (w - dotPx).roundToInt().coerceAtLeast(0)),
                            y = ((1f - hsv.v) * h - dotPx / 2).roundToInt().coerceIn(0, (h - dotPx).roundToInt().coerceAtLeast(0)),
                        )
                    }
                        .size(SV_DOT_DP)
                        .clip(CircleShape)
                        .background(Color(android.graphics.Color.parseColor(currentHex)))
                        .border(2.dp, Color.White, CircleShape),
                )
            }

            Spacer(Modifier.height(14.dp))

            // —— Hue 滑块 ——
            Text("色相", fontSize = 12.sp, color = colors.textSecondary)
            Spacer(Modifier.height(6.dp))
            val cursorPx = with(density) { HUE_CURSOR_WIDTH_DP.toPx() }
            Box(
                Modifier
                    .fillMaxWidth()
                    .height(HUE_BAR_HEIGHT_DP + 6.dp)
                    .onSizeChanged { hueSize = it }
                    .pointerInputCompat { updateHue(it) },
            ) {
                Box(
                    Modifier
                        .align(Alignment.CenterStart)
                        .fillMaxWidth()
                        .height(HUE_BAR_HEIGHT_DP)
                        .clip(RoundedCornerShape(HUE_BAR_HEIGHT_DP / 2))
                        .background(
                            Brush.horizontalGradient(
                                listOf(
                                    Color.Red, Color.Yellow, Color.Green,
                                    Color.Cyan, Color.Blue, Color.Magenta, Color.Red,
                                ),
                            ),
                        ),
                )
                Box(
                    Modifier
                        .offset {
                            val w = hueSize.width.toFloat()
                            val x = ((hsv.h / 360f) * w - cursorPx / 2)
                                .roundToInt()
                                .coerceIn(0, (w - cursorPx).roundToInt().coerceAtLeast(0))
                            IntOffset(x, 0)
                        }
                        .width(HUE_CURSOR_WIDTH_DP)
                        .height(HUE_BAR_HEIGHT_DP + 6.dp)
                        .clip(RoundedCornerShape(HUE_CURSOR_WIDTH_DP / 2))
                        .background(Color.White)
                        .border(1.dp, colors.border, RoundedCornerShape(HUE_CURSOR_WIDTH_DP / 2)),
                )
            }

            Spacer(Modifier.height(14.dp))

            // —— 当前色 + hex 输入 ——
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(
                    Modifier
                        .size(44.dp)
                        .clip(RoundedCornerShape(8.dp))
                        .background(Color(android.graphics.Color.parseColor(currentHex)))
                        .border(1.dp, colors.border, RoundedCornerShape(8.dp)),
                )
                Spacer(Modifier.width(12.dp))
                Row(
                    Modifier
                        .weight(1f)
                        .height(40.dp)
                        .clip(RoundedCornerShape(8.dp))
                        .background(colors.surface)
                        .border(1.dp, colors.border, RoundedCornerShape(8.dp))
                        .padding(horizontal = 10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text("#", fontSize = 14.sp, color = colors.textSecondary)
                    Spacer(Modifier.width(4.dp))
                    BasicTextField(
                        value = hexInput,
                        onValueChange = { raw ->
                            val v = raw.filter { it.isDigit() || it in 'a'..'f' || it in 'A'..'F' }
                                .take(6)
                            hexInput = v
                            if (v.length == 6) hsv = hexToHsv("#$v")
                        },
                        singleLine = true,
                        textStyle = TextStyle(fontSize = 14.sp, color = colors.textPrimary),
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }

            Spacer(Modifier.height(16.dp))

            // —— 预设 16 色（React CLASSIC_PRESETS 逐字照抄，8 列 × 2 行）——
            Text("预设", fontSize = 12.sp, color = colors.textSecondary)
            Spacer(Modifier.height(8.dp))
            PRESET_COLORS.chunked(PRESET_COLUMNS).forEach { row ->
                SwatchRow(
                    hexes = row,
                    currentHex = currentHex,
                    onPick = { hsv = hexToHsv(it) },
                )
                Spacer(Modifier.height(8.dp))
            }

            // —— 最近使用（SharedPreferences，上限 16）——
            if (recent.isNotEmpty()) {
                Text("最近使用", fontSize = 12.sp, color = colors.textSecondary)
                Spacer(Modifier.height(8.dp))
                recent.chunked(PRESET_COLUMNS).forEach { row ->
                    SwatchRow(
                        hexes = row,
                        currentHex = currentHex,
                        onPick = { hsv = hexToHsv(it) },
                    )
                    Spacer(Modifier.height(8.dp))
                }
            }

            // —— RGB / HSV 只读（React 同款两行）——
            val rgb = android.graphics.Color.parseColor(currentHex)
            Text(
                "RGB: ${(rgb shr 16) and 0xFF}, ${(rgb shr 8) and 0xFF}, ${rgb and 0xFF}",
                fontSize = 12.sp,
                color = colors.textSecondary,
            )
            Text(
                "HSV: ${hsv.h.roundToInt()}°, ${(hsv.s * 100).roundToInt()}%, ${(hsv.v * 100).roundToInt()}%",
                fontSize = 12.sp,
                color = colors.textSecondary,
            )
            Spacer(Modifier.height(8.dp))
        }

        Box(Modifier.fillMaxWidth().height(1.dp).background(colors.border))
        // 底部「完成」（实时搜索已自动触发，这里只负责收起；React 同款单按钮）
        Box(
            Modifier
                .padding(16.dp)
                .fillMaxWidth()
                .height(42.dp)
                .clip(RoundedCornerShape(8.dp))
                .background(colors.surface)
                .border(1.dp, colors.border, RoundedCornerShape(8.dp))
                .clickable(onClick = onClose),
            contentAlignment = Alignment.Center,
        ) {
            Text("完成", fontSize = 14.sp, fontWeight = FontWeight.Medium, color = colors.textPrimary)
        }
    }
}

/**
 * 平板右侧取色面板容器（推挤式，对齐 React `RightPanel.tsx` 的 `width: 0 → 20rem`）。
 *
 * 与 [SidebarPane] 同构同参数（内容恒按全宽测量、收合只动画宽度 + 反向位移），取色面板
 * 与侧栏互斥开合（见 `AppState.toggleColorPicker`），不会同时挤占主内容宽度。内容常驻不
 * 卸载——收起态由 0 宽裁剪隐藏（20-09-20 二轮真机教训：卸载后展开要从零组合，首帧巨重）。
 */
@Composable
fun ColorPickerPane(
    visible: Boolean,
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit,
) {
    val colors = AuroraTheme.colors
    val density = LocalDensity.current
    val fullWidthPx = remember(density) { with(density) { COLOR_PANEL_WIDTH_DP.roundToPx() } }
    val progress = animateFloatAsState(
        targetValue = if (visible) 1f else 0f,
        animationSpec = tween(durationMillis = PANEL_ANIMATE_MS, easing = EaseOut),
        label = "colorPanelProgress",
    )

    Box(
        modifier
            .fillMaxHeight()
            .clipToBounds()
            .layout { measurable, constraints ->
                val p = progress.value
                val width = (fullWidthPx * p).roundToInt()
                // 内容恒按全宽测量：测量约束逐帧不变，深度测量命中缓存跳过
                val placeable = measurable.measure(
                    constraints.copy(minWidth = fullWidthPx, maxWidth = fullWidthPx),
                )
                layout(width, constraints.maxHeight) {
                    // 与 React 同款：内容左移 (1-p)·全宽，左缘随 width 收缩裁剪（右侧滑入）
                    placeable.placeRelative(x = width - fullWidthPx, y = 0)
                }
            }
            .background(colors.panel),
    ) {
        content()
    }
}

/** 一行色块（[PRESET_COLUMNS] 列均分；当前色画 primary 外圈，浅色补边框）。 */
@Composable
private fun SwatchRow(
    hexes: List<String>,
    currentHex: String,
    onPick: (String) -> Unit,
) {
    val colors = AuroraTheme.colors
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Start) {
        hexes.forEach { hex ->
            val selected = currentHex.equals(hex, ignoreCase = true)
            val fill = Color(android.graphics.Color.parseColor(hex))
            // 白/银与浅色面板底融为一体，补 1dp 边框免得看不见
            val needsEdge = hex == "#ffffff" || hex == "#d3d3d3"
            // 命中区挂在外层整格（40dp 高，色块本体 28dp 居中）——色块按 React 的 24px
            // 视觉尺寸，直接把 clickable 挂 28dp 圆上触控偏小
            Box(
                Modifier
                    .weight(1f)
                    .height(SWATCH_HIT_HEIGHT_DP)
                    .clickable { onPick(hex) },
                contentAlignment = Alignment.Center,
            ) {
                Box(
                    Modifier
                        .size(SWATCH_SIZE_DP)
                        .clip(CircleShape)
                        .background(fill)
                        .then(
                            if (selected) {
                                Modifier.border(2.dp, colors.primary, CircleShape)
                            } else if (needsEdge) {
                                Modifier.border(1.dp, colors.border, CircleShape)
                            } else {
                                Modifier
                            },
                        ),
                )
            }
        }
        // 末行不足 PRESET_COLUMNS 个时占位，保持列宽一致（weight 已均分，补空 weight）
        repeat(PRESET_COLUMNS - hexes.size) { Spacer(Modifier.weight(1f)) }
    }
}

/**
 * SV/Hue 的取色手势：**按下即取色**（对齐 React 的 onPointerDown 立即取色），拖拽全程
 * 跟随。**不用 `detectDragGestures`**——它的 onDragStart 要过了 touch slop 才回调，
 * 纯点击（tap）取不到色，与 React 版「点一下 SV 面板就跳过去」的手感不一致。
 *
 * 全程消费事件：父层的 verticalScroll 拿不到后续 move，取色期间面板不会跟着滚
 * （父层滚动与取色争用同一根手指，必须二选一）。
 */
private fun Modifier.pointerInputCompat(onPosition: (Offset) -> Unit): Modifier =
    this.pointerInput(Unit) {
        awaitEachGesture {
            val down = awaitFirstDown(requireUnconsumed = false)
            down.consume()
            onPosition(down.position)
            while (true) {
                val event = awaitPointerEvent()
                val change = event.changes.firstOrNull { it.id == down.id } ?: break
                if (!change.pressed) break
                onPosition(change.position)
                change.consume()
            }
        }
    }

internal data class HsvColor(val h: Float, val s: Float, val v: Float)

/** hex → HSV（android.graphics 的 RGBToHSV，与 React `rgbToHsv` 同算法）。 */
private fun hexToHsv(hex: String): HsvColor {
    val rgb = runCatching { android.graphics.Color.parseColor(hex) }
        .getOrDefault(android.graphics.Color.WHITE)
    val out = FloatArray(3)
    android.graphics.Color.RGBToHSV((rgb shr 16) and 0xFF, (rgb shr 8) and 0xFF, rgb and 0xFF, out)
    return HsvColor(out[0], out[1], out[2])
}

/** HSV → hex（小写 `#rrggbb`，与 Rust `search_by_color` 的入参形制一致）。 */
private fun hsvToHex(hsv: HsvColor): String {
    val argb = android.graphics.Color.HSVToColor(floatArrayOf(hsv.h, hsv.s, hsv.v))
    return String.format(java.util.Locale.US, "#%06x", argb and 0xFFFFFF)
}

/**
 * 预设 16 色（桌面 / React `MobileColorPickerSheet` 的 `CLASSIC_PRESETS` 逐字照抄，
 * 8 列 × 2 行；取代 M6b 阶段 3 那套桌面 `ColorPickerPopover` 的 14 色板）。
 */
private val PRESET_COLORS = listOf(
    "#ff0000", "#ff7f00", "#ffff00", "#00ff00",
    "#00ffff", "#0000ff", "#7f00ff", "#ff00ff",
    "#ffffff", "#d3d3d3", "#808080", "#404040",
    "#000000", "#8b4513", "#ff69b4", "#ffb6c1",
)

/** 预设/最近使用的列数（React `grid-cols-8` 同值）。 */
private const val PRESET_COLUMNS = 8

/** 「最近使用」上限（React `colorUtils.ts` 同值 16）。 */
private const val RECENT_MAX = 16

/** 颜色搜索防抖（React `MobileColorPickerSheet` 同值 300ms）。 */
private const val COLOR_SEARCH_DEBOUNCE_MS = 300L

/** 最近使用写入防抖（React 同值 1500ms）。 */
private const val RECENT_WRITE_DEBOUNCE_MS = 1500L

/** 右侧面板宽度（React `RightPanel` 的 20rem ≈ 320dp，取 300dp 给主内容留档）。 */
val COLOR_PANEL_WIDTH_DP: Dp = 300.dp

private val SV_PANEL_HEIGHT_DP = 168.dp
private val SV_DOT_DP = 18.dp
private val HUE_BAR_HEIGHT_DP = 32.dp
private val HUE_CURSOR_WIDTH_DP = 14.dp
private val SWATCH_SIZE_DP = 28.dp
private val SWATCH_HIT_HEIGHT_DP = 40.dp
private const val DEFAULT_PICKER_HEX = "#ffffff"

/** 最近使用的持久化文件（独立于 `aurora_settings`：这是取色器的使用痕迹，不是设置项）。 */
private const val RECENT_PREFS_NAME = "aurora_color_search"
private const val RECENT_PREFS_KEY = "recent"

private fun loadRecentColors(context: Context): List<String> =
    context.getSharedPreferences(RECENT_PREFS_NAME, Context.MODE_PRIVATE)
        .getString(RECENT_PREFS_KEY, null)
        ?.split(',')
        ?.map { it.trim().lowercase() }
        ?.filter { it.length == 7 && it.startsWith("#") && it.drop(1).all { c -> c.isDigit() || c in 'a'..'f' } }
        ?.distinct()
        ?.take(RECENT_MAX)
        ?: emptyList()

private fun addRecentColor(context: Context, hex: String) {
    val normalized = hex.lowercase()
    val next = (listOf(normalized) + loadRecentColors(context)).distinct().take(RECENT_MAX)
    context.getSharedPreferences(RECENT_PREFS_NAME, Context.MODE_PRIVATE)
        .edit()
        .putString(RECENT_PREFS_KEY, next.joinToString(","))
        .apply()
}
