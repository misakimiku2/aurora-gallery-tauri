package com.aurora.gallery.kotlin.ui.components

import android.util.Log
import androidx.compose.animation.core.EaseOut
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.systemGestureExclusion
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.changedToUp
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.util.VelocityTracker
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.aurora.gallery.kotlin.ui.theme.AuroraTheme
import kotlin.math.abs

/**
 * 手机端侧栏抽屉宿主（M8b 任务 1.2/1.3，D45 拍板的「平移式跟手抽屉」第三形态）。
 *
 * **与平板推挤的本质区别（形态分叉优先于压缩，清单 §1.1）**：展开时主内容不重排不重测
 * ——内容整体 `translationX` 往右平移（graphicsLayer 只进绘制/属性阶段，FileGrid 列数
 * 与瀑布流布局抽屉全程不变、无 FLIP），右缘溢出屏外为预期、不收缩内容宽度；面板从左缘
 * 滑入。平板路径（[SidebarPane] 推挤式宽度动画）零改动，两者在宿主层按 !isTablet 分叉。
 *
 * **跟手（任务 1.3）**：边缘手势做在宿主根层的 pointerInput（父层与子节点共享事件流，
 * 未定夺前不消费任何事件）——关态只认左缘手势带（[EDGE_BAND_WIDTH_DP]）内按下；拖拽
 * 位移过触摸 slop 后按主导方向定夺：横向 → 接管抽屉（此后每帧消费、子节点滚动/点击
 * 自然取消），纵向 → 全程让位（网格照常滚）。优先级 = 捏合 > 边缘带 > 滚动：第二指
 * 落下即放弃（捏合三档照常）。开态全域可左滑关闭（面板列表纵向滚动不受影响）。松手
 * 按速度方向吸附，慢速按最近锚点，动画时长对齐面板动画（[PANEL_ANIMATE_MS]，两套
 * 参数勿混用的纪律同 SidebarPane）。
 *
 * **性能纪律（SidebarPane 15fps 教训的等价遵守）**：进度只在 graphicsLayer 块（绘制
 * 阶段）与手势 snapTo 中读取，组合期零订阅——内容/面板/遮罩动画全程零重组零重测；
 * 面板与内容都按最终尺寸一次测量组合后常驻，开合只动 translation。遮罩的显隐用
 * [scrimVisible] 布尔门控（而非 `progress > 0` 逐帧重组），alpha 走 graphicsLayer。
 *
 * **状态复用（清单 §1.3 组件复用不复制）**：开合状态就是 `AppState.layout
 * .isSidebarVisible`（TopBar 侧栏钮/返回链/程序性开合共用），本组件只负责把它渲染成
 * 抽屉形态；sidebar/content 两个槽由宿主传入与平板完全相同的组合（TreeSidebar 六
 * Section 原样复用，仅宽度档不同）。
 *
 * 程序性开合（TopBar 钮/返回键/scrim 点击）与手势松手的吸附共用一条动画驱动：
 * settleTarget 非 null 即从当前进度收敛到锚点（open 不变的松手也要收敛，故手势松手
 * 直接置 target）；手势拖拽期间（dragging=true）动画写值被抑制，进度由手势直驱。
 */
@Composable
fun PhoneSidebarDrawerHost(
    /** 抽屉开合（复用 AppState.layout.isSidebarVisible）。 */
    open: Boolean,
    /** 开合上报（松手吸附 / 遮罩点击；宿主落到 AppState）。 */
    onOpenChange: (Boolean) -> Unit,
    /**
     * 手势开关：选择模式/查看器/画布沉浸态 = false（D45 对齐平板沉浸语义——抽屉关闭
     * 且边缘手势禁用，关闭动作由宿主在这些态进入时程序性完成）。
     */
    gesturesEnabled: Boolean,
    /** 悬浮卡片壳内缩量（与平板卡片壳同源，见 [APP_CARD_INSET_DP]）。 */
    cardInset: Dp,
    /** 抽屉面板内容（与平板同一套 TreeSidebar 组合，宽度档由宿主定）。 */
    modifier: Modifier = Modifier,
    sidebar: @Composable () -> Unit,
    /** 主内容（与平板同一套 TopBar + 视图 Column；平移不重排）。 */
    content: @Composable () -> Unit,
) {
    val colors = AuroraTheme.colors
    val density = LocalDensity.current
    val configuration = LocalConfiguration.current
    // 面板宽度：屏宽 82%（v3 拍板带 78–85% 内取档，非全屏、右缘留主内容作关闭暗示）；
    // 超宽屏（横屏手机 ~920dp）封顶 420dp 保持抽屉形制，竖屏主测档不触顶
    val panelWidthDp = remember(configuration.screenWidthDp) {
        phoneSidebarPanelWidthDp(configuration.screenWidthDp)
    }
    val panelWidthPx = with(density) { panelWidthDp.roundToPx() }

    // 进度 = 可写 State（手势在受限指针作用域内直写，不能调挂起的 snapTo）；
    // 收敛动画由 settleTarget 驱动（见下方 LaunchedEffect），拖拽中动画写值被抑制。
    var progress by remember { mutableFloatStateOf(if (open) 1f else 0f) }
    var settleTarget by remember { mutableStateOf<Float?>(null) }
    var dragging by remember { mutableStateOf(false) }
    var scrimVisible by remember { mutableStateOf(open) }
    val latestOnOpenChange by rememberUpdatedState(onOpenChange)

    // 程序性开合（TopBar 钮/返回键/scrim 点击/沉浸态收起）：open 变化 → 收敛到锚点
    LaunchedEffect(open) {
        if (open) scrimVisible = true
        if (!dragging) settleTarget = if (open) 1f else 0f
    }
    // 唯一动画执行器：settleTarget 非 null 即从当前值收敛（松手吸附同走此路）。
    // 帧循环手写（EaseOut 同面板动画曲线）；拖拽中（dragging）不写值——进度归手势直驱。
    LaunchedEffect(settleTarget) {
        val target = settleTarget ?: return@LaunchedEffect
        val from = progress
        if (abs(target - from) < 0.0001f) {
            if (target == 0f) scrimVisible = false
            settleTarget = null
            return@LaunchedEffect
        }
        val durationNanos = PANEL_ANIMATE_MS * 1_000_000L
        val startNanos = withFrameNanos { it }
        while (true) {
            val linear = ((withFrameNanos { it } - startNanos).toFloat() / durationNanos)
                .coerceIn(0f, 1f)
            if (!dragging) progress = from + (target - from) * EaseOut.transform(linear)
            if (linear >= 1f) break
        }
        if (target == 0f) scrimVisible = false
        settleTarget = null
    }

    Box(
        modifier
            .fillMaxSize()
            .then(
                if (gesturesEnabled) {
                    Modifier.pointerInput(panelWidthPx) {
                        val edgeBandPx = EDGE_BAND_WIDTH_DP.toPx()
                        val slopPx = viewConfiguration.touchSlop
                        val snapVelocityPx = SNAP_VELOCITY_DP_PER_S.dp.toPx()
                        awaitEachGesture {
                            val down = awaitFirstDown(
                                requireUnconsumed = false,
                                pass = PointerEventPass.Initial,
                            )
                            // 上一次手势被 pointerInput 重启等异常中断时留下的拖拽态兜底复位
                            if (dragging) {
                                dragging = false
                                settleTarget = if (progress >= 0.5f) 1f else 0f
                            }
                            val startProgress = progress
                            // 控制权预判：关态只认左缘手势带；开态全域（面板左滑关闭/遮罩拖拽）
                            if (startProgress < 0.9f && down.position.x > edgeBandPx) {
                                return@awaitEachGesture
                            }
                            var controlling = false
                            val trackedId = down.id
                            val tracker = VelocityTracker()
                            tracker.addPosition(down.uptimeMillis, down.position)
                            while (true) {
                                // Initial pass（隧道层）：祖先先于子节点看到事件——接管后在此消费，
                                // RecyclerView interop 根本收不到后续事件，从根上消掉「消费已
                                // 被认领的流 → interop 取消风暴 → 事件延迟成批晚到」的争用
                                // （Main pass 实测复现）。纵向让位时不消费，子节点照常。
                                val event = awaitPointerEvent(PointerEventPass.Initial)
                                val tracked =
                                    event.changes.firstOrNull { it.id == trackedId }
                                        ?: return@awaitEachGesture
                                if (!controlling) {
                                    // 捏合优先（任务 1.3：捏合 > 边缘带 > 滚动）：第二指落下即放弃
                                    if (event.changes.size > 1) return@awaitEachGesture
                                    val dx = tracked.position.x - down.position.x
                                    val dy = tracked.position.y - down.position.y
                                    if (abs(dx) > slopPx || abs(dy) > slopPx) {
                                        if (abs(dx) > abs(dy)) {
                                            controlling = true
                                            dragging = true
                                            scrimVisible = true
                                            settleTarget = null
                                        } else {
                                            // 纵向意图：全程未消费，网格滚动照常
                                            return@awaitEachGesture
                                        }
                                    }
                                }
                                if (controlling) {
                                    // 接管：全部消费（子节点滚动/捏合/点击自然取消，第二指也吞掉）
                                    event.changes.forEach { it.consume() }
                                    try {
                                        tracker.addPosition(tracked.uptimeMillis, tracked.position)
                                        progress = (startProgress +
                                            (tracked.position.x - down.position.x) / panelWidthPx)
                                            .coerceIn(0f, 1f)
                                        // 松手判定用 !pressed 兜底：合成事件流（input swipe/部分
                                        // 触控板驱动）的 Release 帧 changedToUp 可能为 false
                                        if (tracked.changedToUp() || !tracked.pressed) {
                                            val velocity = tracker.calculateVelocity().x
                                            val target = when {
                                                velocity > snapVelocityPx -> 1f
                                                velocity < -snapVelocityPx -> 0f
                                                else -> if (progress >= 0.5f) 1f else 0f
                                            }
                                            Log.i(
                                                "AuroraDrawer",
                                                "snap -> ${if (target == 1f) "open" else "closed"} " +
                                                    "(velocity=${velocity.toInt()}px/s, progress=$progress)",
                                            )
                                            dragging = false
                                            settleTarget = target
                                            latestOnOpenChange(target == 1f)
                                            return@awaitEachGesture
                                        }
                                    } catch (e: Exception) {
                                        Log.e("AuroraDrawer", "drag loop exception", e)
                                        dragging = false
                                        settleTarget = if (progress >= 0.5f) 1f else 0f
                                        return@awaitEachGesture
                                    }
                                } else if (tracked.changedToUp()) {
                                    return@awaitEachGesture
                                }
                            }
                        }
                    }
                } else {
                    Modifier
                },
            ),
    ) {
        // 左缘手势带的手势排除（任务 1.3）：手势导航下屏幕左缘是系统返回手势区，不申请
        // 排除的话抽屉呼出永远抢不过系统 back（avd_ai1 API 35 实测 x=8px 滑动直接退出
        // 应用）。系统对手势排除限高 200dp/边——按上限取竖直居中段保证全量生效，带内
        // 其余段（顶部/底部）让给系统返回。本宿主根层=全屏（卡片内缩在内部承载），
        // 排除区在此可以直接贴到 x=0；若挂在卡片壳内会被祖先 clip 裁掉外缘（实测裁成
        // x=21..63，系统返回手势从空隙照样抢走）。仅关态申请；开态左缘无呼出语义。
        // 无指针输入修饰符，不参与命中，不影响内容交互。
        if (!open && gesturesEnabled) {
            Box(
                Modifier
                    .align(Alignment.CenterStart)
                    .width(EDGE_BAND_WIDTH_DP)
                    .height(SYSTEM_GESTURE_EXCLUSION_MAX_DP)
                    .systemGestureExclusion(),
            )
        }
        // 悬浮卡片壳（与平板卡片壳同形制）：主界面内缩 navigationBars+cardInset 裁圆角，
        // 手势层在壳之外=全屏，左缘 0..cardInset 段的呼出才接得到
        Box(
            Modifier
                .fillMaxSize()
                .navigationBarsPadding()
                .padding(cardInset)
                .clip(RoundedCornerShape(12.dp))
                .background(colors.content),
        ) {
            // 主内容：整体平移，测量/布局全程不变（FileGrid 列数与瀑布流零重排）
            Box(
                Modifier
                    .fillMaxSize()
                    .graphicsLayer { translationX = panelWidthPx * progress },
            ) {
                content()
            }
            // 遮罩：开合或拖拽期间存在（布尔门控防逐帧重组），alpha 在绘制阶段跟进度；
            // enabled=open：收起动画/未开状态下不挡内容点击
            if (scrimVisible) {
                Box(
                    Modifier
                        .fillMaxSize()
                        .graphicsLayer { alpha = SCRIM_MAX_ALPHA * progress }
                        .background(Color.Black)
                        .clickable(
                            interactionSource = remember { MutableInteractionSource() },
                            indication = null,
                            enabled = open,
                        ) {
                            Log.i("AuroraDrawer", "scrim tap -> close")
                            latestOnOpenChange(false)
                        },
                )
            }
            // 抽屉面板：固定宽度一次测量组合常驻，位移走 graphicsLayer（对齐 SidebarPane
            // 「内容常驻不卸载」的教训——收起后从零组合首帧巨重）
            Box(
                Modifier
                    .fillMaxHeight()
                    .width(panelWidthDp)
                    .graphicsLayer {
                        translationX = -panelWidthPx * (1f - progress)
                        shadowElevation = PANEL_SHADOW_ELEVATION_DP.dp.toPx()
                    }
                    .background(colors.panel),
            ) {
                sidebar()
            }
        }
    }
}

/** 面板宽度占屏宽比例（v3 拍板带 78–85% 内取档；执行定档 82%，avd_ai1 ≈337dp）。 */
private const val PANEL_WIDTH_FRACTION = 0.82f

/** 面板宽度封顶（横屏手机等超宽屏保持抽屉形制；竖屏主测档 337dp 不触顶）。 */
private val PANEL_WIDTH_MAX_DP = 420.dp

/**
 * 手机抽屉面板宽（屏宽 82% 封顶 420dp）：抽屉宿主与宿主侧 [TreeSidebar] 的宽度档共用
 * 此式——面板宽与内容宽必须同源，否则面板右侧会留出空带。
 */
internal fun phoneSidebarPanelWidthDp(screenWidthDp: Int): Dp =
    (screenWidthDp * PANEL_WIDTH_FRACTION).coerceAtMost(PANEL_WIDTH_MAX_DP.value).dp

/** 左缘手势带宽度（任务 1.3：约 20–24dp 区间取 24dp）。 */
internal val EDGE_BAND_WIDTH_DP = 24.dp

/** 系统手势排除的高度上限（Android 10+ 每边 200dp）；按上限申请保证全量生效。 */
private val SYSTEM_GESTURE_EXCLUSION_MAX_DP = 200.dp

/**
 * 悬浮卡片壳的内缩量（App() 主界面 `.padding(8.dp)` 的共享单源）：左缘手势排除区需要
 * 负偏移抵消它贴到屏幕物理边缘。
 */
internal val APP_CARD_INSET_DP = 8.dp

/** 松手吸附速度阈值（方向吸附；低于则按最近锚点），dp/s。 */
private const val SNAP_VELOCITY_DP_PER_S = 350f

/** 遮罩最深不透明度（React 抽屉常见量级；透明度全程跟进度）。 */
private const val SCRIM_MAX_ALPHA = 0.4f

/** 面板右缘投影（抽屉浮层暗示；平板推挤侧栏无投影，形态区分的一部分）。 */
private const val PANEL_SHADOW_ELEVATION_DP = 12
