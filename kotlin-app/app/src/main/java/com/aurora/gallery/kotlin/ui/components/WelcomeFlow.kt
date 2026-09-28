package com.aurora.gallery.kotlin.ui.components

import androidx.activity.compose.BackHandler
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.aurora.gallery.kotlin.LanServerSnapshot
import com.aurora.gallery.kotlin.state.AiSettings
import com.aurora.gallery.kotlin.state.AppSettings
import com.aurora.gallery.kotlin.state.WelcomeFlowState
import com.aurora.gallery.kotlin.state.WelcomeStep
import com.aurora.gallery.kotlin.ui.isCompactWidth
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** 双端下载页（与桌面端欢迎页二维码同源：update/android.json homepage 主源，双平台安装包同仓发布）。 */
private const val DOWNLOAD_PAGE_URL = "https://gitee.com/misakimiku2/aurora_gallery/releases"

/**
 * 欢迎向导（启动流程优化 2026-09-29；三轮反馈起视觉全面对齐桌面 WelcomeModal）：
 *
 * - 装饰背景：点阵纹理 + 四枚径向渐变色斑（透明度呼吸脉冲对齐桌面 animate-pulse；
 *   径向渐变免 Modifier.blur，全 API 档一致）；
 * - 居中悬浮圆角卡片：平板横屏 = 左蓝品牌栏/右内容区各半（对齐桌面 md:flex-row、500px 卡），
 *   手机竖屏 = 上品牌横幅/下内容（卡片化带边距）；
 * - 配色取桌面 Tailwind 灰系/蓝系逐值（[wfC] 浅/深两档），不走 AuroraPalette；
 * - AuroraLogoMark = 桌面 Logo.tsx SVG 逐元素 Canvas 复刻；
 * - 状态机 [WelcomeFlowState]（纯 Kotlin，JUnit 覆盖）与宿主接线不变。
 *
 * 触控目标 ≥48dp（desktop-to-android 规范）；返回手势经 BackHandler 走步骤回退；
 * 文案按 [language] 在组合内即时切中/英（主界面全量 i18n 另案）。
 */
@Composable
fun WelcomeFlow(
    state: WelcomeFlowState,
    onStateChange: (WelcomeFlowState) -> Unit,
    permissionDenied: Boolean,
    theme: String,
    language: String,
    ai: AiSettings,
    lanSnapshot: LanServerSnapshot?,
    darkTheme: Boolean,
    onThemeChange: (String) -> Unit,
    onLanguageChange: (String) -> Unit,
    onAiChange: (AiSettings) -> Unit,
    aiTestConnection: suspend (AiSettings) -> Result<Unit>,
    enableLanServer: suspend () -> Boolean,
    onRequestPermission: () -> Unit,
    onOpenAppSettings: () -> Unit,
    onFinish: () -> Unit,
) {
    val text = welText(language)
    val c = wfC(darkTheme)
    val compact = isCompactWidth(LocalConfiguration.current)

    // AI 步草稿提升到本层（对齐桌面语义：点「下一步」才提交，跳过不落盘；回退后重进以已存值重置）
    var aiDraft by remember(state.step) { mutableStateOf(ai) }

    BackHandler(enabled = state.canBack) { onStateChange(state.back()) }
    // 状态机走到 DONE（互联步「开始使用」推进）即收尾：写 onboarded + 揭幕主界面
    LaunchedEffect(state.step) {
        if (state.step == WelcomeStep.DONE) onFinish()
    }

    // 下一步：AI 步先提交草稿（跳过路径走 state.skip() 不经过这里，故不落盘）
    val handleNext = {
        if (state.step == WelcomeStep.AI && aiDraft != ai) onAiChange(aiDraft)
        onStateChange(state.next())
    }

    val title = when (state.step) {
        WelcomeStep.PERMISSION -> text.permissionTitle
        WelcomeStep.PREFERENCES -> text.preferencesTitle
        WelcomeStep.AI -> text.aiTitle
        WelcomeStep.CONNECT -> text.connectTitle
        WelcomeStep.DONE -> ""
    }
    val desc = when (state.step) {
        WelcomeStep.PERMISSION -> text.permissionDesc
        WelcomeStep.PREFERENCES -> text.preferencesDesc
        WelcomeStep.AI -> text.aiDesc
        WelcomeStep.CONNECT -> text.connectDesc
        WelcomeStep.DONE -> ""
    }

    Box(Modifier.fillMaxSize().background(c.pageBg)) {
        WfDecoratedBackground(c)
        Box(
            Modifier
                .align(Alignment.Center)
                .padding(16.dp)
                .navigationBarsPadding()
                .then(
                    if (compact) {
                        Modifier.fillMaxSize()
                    } else {
                        Modifier.width(720.dp).height(520.dp)
                    },
                )
                .shadow(
                    elevation = 16.dp,
                    shape = RoundedCornerShape(16.dp),
                    ambientColor = Color(0x1A000000),
                    spotColor = Color(0x33111827),
                )
                .clip(RoundedCornerShape(16.dp))
                .background(c.cardBg)
                .border(1.dp, c.border, RoundedCornerShape(16.dp)),
        ) {
            if (compact) {
                Column(Modifier.fillMaxSize()) {
                    BrandPanel(
                        Modifier.fillMaxWidth(), compact = true, title = title, desc = desc,
                        step = state.step, downloadLabel = null,
                        onDotClick = { onStateChange(state.goTo(it)) },
                    )
                    Column(Modifier.weight(1f).fillMaxWidth().background(c.rightBg)) {
                        StepContent(
                            Modifier.weight(1f), c, text, state, permissionDenied, theme, language, aiDraft,
                            lanSnapshot, onThemeChange, onLanguageChange, { aiDraft = it }, aiTestConnection,
                            enableLanServer, onRequestPermission, onOpenAppSettings, compact = true,
                        )
                        BottomBar(Modifier, c, text, state, onStateChange, handleNext, compact = true)
                    }
                }
            } else {
                Row(Modifier.fillMaxSize()) {
                    BrandPanel(
                        Modifier.fillMaxHeight().width(360.dp), compact = false, title = title, desc = desc,
                        step = state.step,
                        downloadLabel = text.scanDownloadAndroid.takeIf { state.step == WelcomeStep.CONNECT },
                        onDotClick = { onStateChange(state.goTo(it)) },
                    )
                    Column(Modifier.weight(1f).fillMaxHeight().background(c.rightBg)) {
                        StepContent(
                            Modifier.weight(1f), c, text, state, permissionDenied, theme, language, aiDraft,
                            lanSnapshot, onThemeChange, onLanguageChange, { aiDraft = it }, aiTestConnection,
                            enableLanServer, onRequestPermission, onOpenAppSettings, compact = false,
                        )
                        BottomBar(Modifier, c, text, state, onStateChange, handleNext, compact = false)
                    }
                }
            }
        }
    }
}

/**
 * 左蓝品牌栏（桌面 bg-blue-600 纯色 + 蓝右下/紫左上装饰圆 + 白字 + 步骤条）。
 * 手机竖屏 compact=true 为卡片顶部横幅。[downloadLabel] 非空时在步骤条上方展示
 * 「扫码下载安卓端」二维码（平板互联步，对齐桌面第 4 步左栏入口）。
 */
@Composable
private fun BrandPanel(
    modifier: Modifier,
    compact: Boolean,
    title: String,
    desc: String,
    step: WelcomeStep,
    downloadLabel: String?,
    onDotClick: (WelcomeStep) -> Unit,
) {
    Box(
        modifier
            .background(Color(0xFF2563EB))
            .clipToBounds(),
    ) {
        // 装饰圆（桌面 -bottom-20 -right-20 blur-3xl 圆的径向渐变替代）
        Box(
            Modifier
                .align(Alignment.BottomEnd)
                .size(180.dp)
                .offset(x = 60.dp, y = 60.dp)
                .background(Brush.radialGradient(listOf(Color(0x803B82F6), Color.Transparent))),
        )
        Box(
            Modifier
                .align(Alignment.TopStart)
                .size(140.dp)
                .offset(x = (-40).dp, y = (-30).dp)
                .background(Brush.radialGradient(listOf(Color(0x4DA855F7), Color.Transparent))),
        )
        Column(
            // 平板=左侧整列（fillMaxSize 撑满卡高）；手机=顶部横幅（必须 wrap 高度，
            // 否则 fillMaxSize 会把整张卡吃光、内容区与底栏被挤出屏幕）
            Modifier
                .then(if (compact) Modifier.fillMaxWidth() else Modifier.fillMaxSize())
                .padding(if (compact) 24.dp else 28.dp),
            verticalArrangement = Arrangement.SpaceBetween,
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                AuroraLogoMark(size = if (compact) 36.dp else 40.dp)
                Spacer(Modifier.width(10.dp))
                Text(
                    "AURORA",
                    color = Color.White,
                    fontSize = 18.sp,
                    fontWeight = FontWeight.Bold,
                    letterSpacing = 2.sp,
                )
            }
            if (compact) {
                Spacer(Modifier.height(12.dp))
                Text(title, color = Color.White, fontSize = 22.sp, fontWeight = FontWeight.Bold, lineHeight = 28.sp)
                Spacer(Modifier.height(4.dp))
                Text(desc, color = Color(0xFFDBEAFE).copy(alpha = 0.9f), fontSize = 14.sp, lineHeight = 20.sp)
            }
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                if (!compact) {
                    Text(title, color = Color.White, fontSize = 26.sp, fontWeight = FontWeight.Bold, lineHeight = 34.sp)
                    Spacer(Modifier.height(4.dp))
                    Text(desc, color = Color(0xFFDBEAFE).copy(alpha = 0.9f), fontSize = 14.sp, lineHeight = 20.sp)
                }
                // 手机紧凑档：横幅按内容撑高、外层 SpaceBetween 无余量可分配——
                // 描述文字与步骤条之间必须显式留白，否则会直接贴在一起
                if (compact) Spacer(Modifier.height(18.dp))
                if (downloadLabel != null) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        WfQrImage(DOWNLOAD_PAGE_URL, size = 72.dp)
                        Spacer(Modifier.width(10.dp))
                        Text(
                            downloadLabel,
                            color = Color(0xFFDBEAFE),
                            fontSize = 13.sp,
                            lineHeight = 18.sp,
                            modifier = Modifier.weight(1f),
                        )
                    }
                }
                WfStepDots(step, onDotClick)
            }
        }
    }
}

/**
 * 桌面同款 Aurora logo（Logo.tsx SVG 逐元素 Canvas 复刻）：靛→紫→粉对角渐变圆角方块
 * + 双白色波浪 + 高光圆点。桌面另有 feDropShadow 蓝色投影，Canvas 无模糊近似省略。
 */
@Composable
private fun AuroraLogoMark(size: Dp) {
    Canvas(Modifier.size(size)) {
        val s = this.size.width / 256f
        drawRoundRect(
            brush = Brush.linearGradient(
                colors = listOf(Color(0xFF4F46E5), Color(0xFF8B5CF6), Color(0xFFEC4899)),
                start = Offset(0f, 256f),
                end = Offset(256f, 0f),
            ),
            topLeft = Offset(32f * s, 32f * s),
            size = Size(192f * s, 192f * s),
            cornerRadius = CornerRadius(48f * s, 48f * s),
        )
        val wave1 = Path().apply {
            moveTo(32f * s, 138f * s)
            cubicTo(70f * s, 100f * s, 186f * s, 196f * s, 224f * s, 158f * s)
        }
        drawPath(wave1, Color.White.copy(alpha = 0.4f), style = Stroke(width = 20f * s, cap = StrokeCap.Round))
        val wave2 = Path().apply {
            moveTo(32f * s, 110f * s)
            cubicTo(80f * s, 70f * s, 176f * s, 166f * s, 224f * s, 126f * s)
        }
        drawPath(wave2, Color.White.copy(alpha = 0.6f), style = Stroke(width = 12f * s, cap = StrokeCap.Round))
        drawCircle(Color.White.copy(alpha = 0.95f), radius = 14f * s, center = Offset(176f * s, 80f * s))
    }
}

/** 装饰背景：点阵（桌面 40px 网格 1.5px 点）+ 四枚色斑。 */
@Composable
private fun WfDecoratedBackground(c: WfC) {
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val w = maxWidth
        val h = maxHeight
        Canvas(Modifier.fillMaxSize()) {
            val step = 40.dp.toPx()
            val r = 1.5.dp.toPx()
            var y = 0f
            while (y <= size.height) {
                var x = 0f
                while (x <= size.width) {
                    drawCircle(c.dotGrid, r, Offset(x, y))
                    x += step
                }
                y += step
            }
        }
        // 桌面四枚色斑的方位/尺寸/动画时长逐一对齐（top-left 蓝 / bottom-right 紫 / top-right 青 / bottom-left 靛）
        WfBlob(c.blobBlue, Modifier.align(Alignment.TopStart).size(w * 0.6f, h * 0.6f).offset(x = -w * 0.10f, y = -h * 0.10f), 7000, 0)
        WfBlob(c.blobPurple, Modifier.align(Alignment.BottomEnd).size(w * 0.7f, h * 0.7f).offset(x = w * 0.10f, y = h * 0.10f), 10000, 2000)
        WfBlob(c.blobCyan, Modifier.align(Alignment.TopEnd).size(w * 0.45f, h * 0.45f).offset(x = -w * 0.10f, y = h * 0.20f), 13000, 4000)
        WfBlob(c.blobIndigo, Modifier.align(Alignment.BottomStart).size(w * 0.4f, h * 0.4f).offset(x = w * 0.10f, y = -h * 0.20f), 9000, 1000)
    }
}

/** 单枚色斑：径向渐变（免 blur 全档一致）+ 透明度呼吸（对齐桌面 animate-pulse）。 */
@Composable
private fun WfBlob(color: Color, modifier: Modifier, periodMs: Int, delayMs: Int) {
    val transition = rememberInfiniteTransition(label = "wfBlob")
    val pulse by transition.animateFloat(
        initialValue = 0.55f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(
            animation = tween(periodMs, delayMs, easing = LinearEasing),
            repeatMode = RepeatMode.Reverse,
        ),
        label = "wfBlobAlpha",
    )
    Box(
        modifier
            .graphicsLayer { alpha = pulse }
            .background(Brush.radialGradient(listOf(color, Color.Transparent))),
    )
}

@Composable
private fun StepContent(
    modifier: Modifier,
    c: WfC,
    text: WelText,
    state: WelcomeFlowState,
    permissionDenied: Boolean,
    theme: String,
    language: String,
    ai: AiSettings,
    lanSnapshot: LanServerSnapshot?,
    onThemeChange: (String) -> Unit,
    onLanguageChange: (String) -> Unit,
    onAiChange: (AiSettings) -> Unit,
    aiTestConnection: suspend (AiSettings) -> Result<Unit>,
    enableLanServer: suspend () -> Boolean,
    onRequestPermission: () -> Unit,
    onOpenAppSettings: () -> Unit,
    compact: Boolean,
) {
    // Box 居中：内容短（权限/偏好步）时像桌面 justify-center/m-auto 一样垂直居中，
    // 内容长（AI 步三输入框）时撑满并可滚——两种形态一套结构
    Box(modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
        Column(
            Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                // 平板卡大、内容居中后仍要离边框有呼吸感（桌面 p-8 = 32px）；手机紧凑档收窄
                .padding(
                    horizontal = if (compact) 24.dp else 32.dp,
                    vertical = if (compact) 20.dp else 28.dp,
                ),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            when (state.step) {
                WelcomeStep.PERMISSION -> PermissionStep(c, text, permissionDenied, onRequestPermission, onOpenAppSettings)
                WelcomeStep.PREFERENCES -> PreferencesStep(c, text, theme, language, onThemeChange, onLanguageChange)
                WelcomeStep.AI -> AiStep(c, text, ai, onAiChange, aiTestConnection)
                WelcomeStep.CONNECT -> ConnectStep(c, text, lanSnapshot, enableLanServer)
                WelcomeStep.DONE -> {}
            }
        }
    }
}

@Composable
private fun BottomBar(
    modifier: Modifier,
    c: WfC,
    text: WelText,
    state: WelcomeFlowState,
    onStateChange: (WelcomeFlowState) -> Unit,
    onNext: () -> Unit,
    compact: Boolean,
) {
    Column(
        modifier
            .fillMaxWidth()
            .padding(horizontal = if (compact) 24.dp else 32.dp),
    ) {
        // 桌面同款分隔线（border-t border-gray-100）
        Box(Modifier.fillMaxWidth().height(1.dp).background(c.divider))
        Row(
            Modifier
                .fillMaxWidth()
                // 底栏与卡底留白（桌面 mt-6 pt-6 pb-8 量级）：胶囊按钮不再贴着卡片下边缘
                .padding(
                    top = if (compact) 10.dp else 14.dp,
                    bottom = if (compact) 12.dp else 20.dp,
                )
                .navigationBarsPadding(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (state.canSkip) {
                Text(
                    text.skip,
                    fontSize = 14.sp,
                    color = c.skipText,
                    modifier = Modifier
                        .heightIn(min = 48.dp)
                        .clickable { onStateChange(state.skip()) }
                        .padding(horizontal = 8.dp, vertical = 14.dp),
                )
            } else {
                Spacer(Modifier.width(1.dp))
            }
            // 桌面同款胶囊主按钮（浅色 bg-gray-900 白字 / 深色 bg-white 黑字）
            val enabled = state.step != WelcomeStep.PERMISSION
            val pillShape = RoundedCornerShape(50)
            Row(
                Modifier
                    .heightIn(min = 48.dp)
                    .clip(pillShape)
                    .background(if (enabled) c.pillBg else c.disabledBg)
                    .clickable(enabled = enabled) { onNext() }
                    .padding(horizontal = 24.dp, vertical = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Text(
                    if (state.isLast) text.finish else text.next,
                    fontSize = 14.sp,
                    fontWeight = FontWeight.Bold,
                    color = if (enabled) c.pillText else c.disabledText,
                )
                Icon(
                    imageVector = IconChevronRight,
                    contentDescription = null,
                    tint = if (enabled) c.pillText else c.disabledText,
                    modifier = Modifier.size(16.dp),
                )
            }
        }
    }
}

// ===== 各步内容（桌面 WelcomeModal 右栏逐块对齐）=====

@Composable
private fun PermissionStep(
    c: WfC,
    text: WelText,
    permissionDenied: Boolean,
    onRequestPermission: () -> Unit,
    onOpenAppSettings: () -> Unit,
) {
    Column(
        Modifier.fillMaxWidth(),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        // 桌面 step1 同款大圆图标
        Box(
            Modifier.size(64.dp).clip(CircleShape).background(c.blueIconBg),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                imageVector = IconImage,
                contentDescription = null,
                tint = c.blueIconFg,
                modifier = Modifier.size(28.dp),
            )
        }
        Text(
            text.permissionBody,
            fontSize = 14.sp,
            lineHeight = 21.sp,
            color = c.textPrimary,
            textAlign = TextAlign.Center,
        )
        if (permissionDenied) {
            Text(
                text.permissionDeniedHint,
                fontSize = 13.sp,
                lineHeight = 19.sp,
                color = c.textSecondary,
                textAlign = TextAlign.Center,
            )
            WfSecondaryButton(c, text.openSettings, onClick = onOpenAppSettings)
        }
        WfBlueButton(c, text.authorize, onClick = onRequestPermission, modifier = Modifier.fillMaxWidth())
    }
}

@Composable
private fun PreferencesStep(
    c: WfC,
    text: WelText,
    theme: String,
    language: String,
    onThemeChange: (String) -> Unit,
    onLanguageChange: (String) -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(text.languageLabel, fontSize = 14.sp, fontWeight = FontWeight.Bold, color = c.label)
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            WfChip(c, "中文", language != AppSettings.LANGUAGE_EN, Modifier.weight(1f)) { onLanguageChange(AppSettings.LANGUAGE_ZH) }
            WfChip(c, "English", language == AppSettings.LANGUAGE_EN, Modifier.weight(1f)) { onLanguageChange(AppSettings.LANGUAGE_EN) }
        }
        Spacer(Modifier.height(8.dp))
        Text(text.themeLabel, fontSize = 14.sp, fontWeight = FontWeight.Bold, color = c.label)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            WfChip(c, text.themeLight, theme == AppSettings.THEME_LIGHT, Modifier.weight(1f), icon = IconSun) { onThemeChange(AppSettings.THEME_LIGHT) }
            WfChip(c, text.themeDark, theme == AppSettings.THEME_DARK, Modifier.weight(1f), icon = IconMoon) { onThemeChange(AppSettings.THEME_DARK) }
            WfChip(c, text.themeSystem, theme == AppSettings.THEME_SYSTEM, Modifier.weight(1f), icon = IconMonitor) { onThemeChange(AppSettings.THEME_SYSTEM) }
        }
    }
}

/** 三档 AI 服务商（openai 档显示为「在线」，对齐设置面板 AISettingsPanel 语义）。 */
private data class WfProvider(val id: String, val label: String, val icon: ImageVector)
private val AI_PROVIDERS = listOf(
    WfProvider("openai", "Online", IconGlobe),
    WfProvider("ollama", "Ollama", IconBot),
    WfProvider("lmstudio", "LM Studio", IconMonitor),
)

@Composable
private fun AiStep(
    c: WfC,
    text: WelText,
    draft: AiSettings,
    onDraftChange: (AiSettings) -> Unit,
    aiTestConnection: suspend (AiSettings) -> Result<Unit>,
) {
    val scope = rememberCoroutineScope()
    var testing by remember { mutableStateOf(false) }
    var testOk by remember { mutableStateOf<Boolean?>(null) }

    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            AI_PROVIDERS.forEach { p ->
                WfChip(
                    c,
                    if (p.id == "openai") text.aiProviderOnline else p.label,
                    draft.provider == p.id,
                    Modifier.weight(1f),
                    icon = p.icon,
                ) {
                    onDraftChange(draft.copy(provider = p.id))
                    testOk = null
                }
            }
        }
        WfTextField(
            c,
            label = text.aiEndpoint,
            value = aiEndpointOf(draft),
            onValueChange = { v -> onDraftChange(withEndpoint(draft, v)) },
            hint = "http://127.0.0.1:1234",
        )
        if (draft.provider == "openai") {
            WfTextField(
                c,
                label = text.aiApiKey,
                value = draft.openaiApiKey,
                onValueChange = { v -> onDraftChange(draft.copy(openaiApiKey = v)) },
                hint = "sk-…",
            )
        }
        WfTextField(
            c,
            label = text.aiModel,
            value = aiModelOf(draft),
            onValueChange = { v -> onDraftChange(withModel(draft, v)) },
            hint = "",
        )
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            WfSecondaryButton(c, if (testing) text.aiTesting else text.aiTest, enabled = !testing) {
                if (aiEndpointOf(draft).isNotBlank()) {
                    testing = true
                    testOk = null
                    scope.launch {
                        val r = aiTestConnection(draft)
                        testing = false
                        testOk = r.isSuccess
                    }
                }
            }
            if (testOk != null) {
                Text(
                    if (testOk == true) text.aiConnected else text.aiDisconnected,
                    fontSize = 13.sp,
                    fontWeight = FontWeight.Bold,
                    color = if (testOk == true) c.success else c.danger,
                )
            }
        }
        Text(text.aiHint, fontSize = 12.sp, lineHeight = 17.sp, color = c.textSecondary)
    }
}

private fun aiEndpointOf(ai: AiSettings): String = when (ai.provider) {
    "ollama" -> ai.ollamaEndpoint
    "lmstudio" -> ai.lmstudioEndpoint
    else -> ai.openaiEndpoint
}

private fun withEndpoint(ai: AiSettings, v: String): AiSettings = when (ai.provider) {
    "ollama" -> ai.copy(ollamaEndpoint = v)
    "lmstudio" -> ai.copy(lmstudioEndpoint = v)
    else -> ai.copy(openaiEndpoint = v)
}

private fun aiModelOf(ai: AiSettings): String = when (ai.provider) {
    "ollama" -> ai.ollamaModel
    "lmstudio" -> ai.lmstudioModel
    else -> ai.openaiModel
}

private fun withModel(ai: AiSettings, v: String): AiSettings = when (ai.provider) {
    "ollama" -> ai.copy(ollamaModel = v)
    "lmstudio" -> ai.copy(lmstudioModel = v)
    else -> ai.copy(openaiModel = v)
}

@Composable
private fun ConnectStep(
    c: WfC,
    text: WelText,
    lanSnapshot: LanServerSnapshot?,
    enableLanServer: suspend () -> Boolean,
) {
    val scope = rememberCoroutineScope()
    val enabled = lanSnapshot?.enabled == true
    var starting by remember { mutableStateOf(false) }
    var failed by remember { mutableStateOf(false) }

    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        // 开关卡（桌面同款灰底圆角行）
        Row(
            Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(12.dp))
                .background(c.sectionBg)
                .padding(horizontal = 16.dp, vertical = 14.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(text.connectEnable, fontSize = 14.sp, fontWeight = FontWeight.Bold, color = c.textPrimary)
            Switch(
                checked = enabled,
                enabled = !starting,
                onCheckedChange = {
                    starting = true
                    failed = false
                    scope.launch {
                        val ok = enableLanServer()
                        starting = false
                        failed = !ok
                    }
                },
                colors = SwitchDefaults.colors(checkedTrackColor = Color(0xFF2563EB)),
            )
        }
        if (starting) {
            Text(text.connectStarting, fontSize = 13.sp, color = c.textSecondary)
        }
        if (failed) {
            Text(text.connectFailed, fontSize = 13.sp, color = c.danger)
        }
        if (enabled && lanSnapshot?.running == true) {
            WfSectionCard(c) {
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(text.connectRunning, fontSize = 13.sp, fontWeight = FontWeight.Bold, color = c.success)
                    Text("http://${lanSnapshot.ip}:${lanSnapshot.port}", fontSize = 15.sp, color = c.textPrimary)
                    Text("${text.connectAccessCode}：${lanSnapshot.accessCode}", fontSize = 13.sp, color = c.textSecondary)
                    Text(text.connectHint, fontSize = 12.sp, lineHeight = 17.sp, color = c.textSecondary)
                }
            }
        }
        DesktopDownloadCard(c, text)
    }
}

/** 桌面端下载入口（与桌面欢迎页「扫码下载安卓端」对映）：展示下载页链接 + 复制按钮。 */
@Composable
private fun DesktopDownloadCard(c: WfC, text: WelText) {
    val clipboard = LocalClipboardManager.current
    val scope = rememberCoroutineScope()
    var copied by remember { mutableStateOf(false) }

    WfSectionCard(c) {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(text.desktopDownloadTitle, fontSize = 14.sp, fontWeight = FontWeight.Bold, color = c.textPrimary)
            Text(text.desktopDownloadHint, fontSize = 12.sp, lineHeight = 17.sp, color = c.textSecondary)
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    DOWNLOAD_PAGE_URL,
                    fontSize = 12.sp,
                    fontFamily = FontFamily.Monospace,
                    color = c.blue,
                    modifier = Modifier.weight(1f),
                )
                WfSecondaryButton(c, if (copied) text.desktopDownloadCopied else text.desktopDownloadCopy) {
                    clipboard.setText(AnnotatedString(DOWNLOAD_PAGE_URL))
                    copied = true
                    scope.launch {
                        delay(1500)
                        copied = false
                    }
                }
            }
        }
    }
}

// ===== 小组件（桌面 WelcomeModal 样式逐块对齐）=====

@Composable
private fun WfSectionCard(c: WfC, content: @Composable () -> Unit) {
    Box(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(c.sectionBg)
            .border(1.dp, c.border, RoundedCornerShape(12.dp))
            .padding(16.dp),
    ) {
        content()
    }
}

@Composable
private fun WfStepDots(step: WelcomeStep, onDotClick: (WelcomeStep) -> Unit) {
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        WelcomeStep.entries.filter { it != WelcomeStep.DONE }.forEach { s ->
            // 可点回退（对齐桌面 onclick={s < step && setStep(s)}）：靠前的条点击跳回该步，
            // 当前/靠后/权限步为死区（不响应，视觉也不变）。条本身不放大命中区，仅整条可点。
            val clickable = s.ordinal < step.ordinal && s != WelcomeStep.PERMISSION
            Box(
                Modifier
                    .size(width = 28.dp, height = 6.dp)
                    .clip(RoundedCornerShape(3.dp))
                    .background(
                        when {
                            s == step -> Color.White
                            s.ordinal < step.ordinal -> Color.White.copy(alpha = 0.7f)
                            else -> Color.White.copy(alpha = 0.3f)
                        },
                    )
                    .then(
                        if (clickable) {
                            Modifier.clickable { onDotClick(s) }
                        } else {
                            Modifier
                        },
                    ),
            )
        }
    }
}

/** 主操作（bg-blue-600 白字圆角 + 蓝色软投影，桌面 selectFolder/授权按钮同款）。 */
@Composable
private fun WfBlueButton(c: WfC, text: String, modifier: Modifier = Modifier, enabled: Boolean = true, onClick: () -> Unit) {
    val shape = RoundedCornerShape(12.dp)
    Box(
        modifier
            .heightIn(min = 48.dp)
            .shadow(elevation = 8.dp, shape = shape, ambientColor = Color(0x473B82F6), spotColor = Color(0x663B82F6))
            .clip(shape)
            .background(if (enabled) c.blue else c.disabledBg)
            .clickable(enabled = enabled) { onClick() }
            .padding(horizontal = 24.dp, vertical = 12.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text,
            fontSize = 15.sp,
            fontWeight = FontWeight.Bold,
            color = if (enabled) Color.White else c.disabledText,
            textAlign = TextAlign.Center,
        )
    }
}

@Composable
private fun WfSecondaryButton(c: WfC, text: String, enabled: Boolean = true, onClick: () -> Unit) {
    val shape = RoundedCornerShape(10.dp)
    Box(
        Modifier
            .heightIn(min = 48.dp)
            .clip(shape)
            .background(c.inputBg)
            .border(1.dp, c.inputBorder, shape)
            .clickable(enabled = enabled) { onClick() }
            .padding(horizontal = 20.dp, vertical = 12.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(text, fontSize = 14.sp, fontWeight = FontWeight.Bold, color = c.textPrimary)
    }
}

/** 选中态对齐桌面 chip：蓝边 + blue-50/blue-900@20% 底 + 蓝字（深浅两档都可读）。 */
@Composable
private fun WfChip(
    c: WfC,
    text: String,
    selected: Boolean,
    modifier: Modifier = Modifier,
    icon: ImageVector? = null,
    onClick: () -> Unit,
) {
    val shape = RoundedCornerShape(10.dp)
    val fg = if (selected) c.blueText else c.textPrimary
    Column(
        modifier
            .heightIn(min = 48.dp)
            .clip(shape)
            .background(if (selected) c.blueChipBg else Color.Transparent)
            .border(1.dp, if (selected) c.blue else c.border, shape)
            .clickable { onClick() }
            .padding(horizontal = 6.dp, vertical = 6.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        if (icon != null) {
            Icon(
                imageVector = icon,
                contentDescription = null,
                tint = fg,
                modifier = Modifier.size(16.dp),
            )
            Spacer(Modifier.height(2.dp))
        }
        Text(
            text,
            fontSize = 13.sp,
            fontWeight = if (selected) FontWeight.Bold else FontWeight.Normal,
            color = fg,
            maxLines = 1,
        )
    }
}

@Composable
private fun WfTextField(c: WfC, label: String, value: String, onValueChange: (String) -> Unit, hint: String) {
    Column {
        Text(label, fontSize = 12.sp, fontWeight = FontWeight.Bold, color = c.textSecondary)
        Spacer(Modifier.height(4.dp))
        val shape = RoundedCornerShape(8.dp)
        Box(
            Modifier
                .fillMaxWidth()
                .heightIn(min = 48.dp)
                .clip(shape)
                .background(c.inputBg)
                .border(1.dp, c.inputBorder, shape)
                .padding(horizontal = 12.dp, vertical = 12.dp),
            contentAlignment = Alignment.CenterStart,
        ) {
            if (value.isEmpty() && hint.isNotEmpty()) {
                Text(hint, fontSize = 15.sp, color = c.hint)
            }
            BasicTextField(
                value = value,
                onValueChange = onValueChange,
                singleLine = true,
                textStyle = TextStyle(fontSize = 15.sp, color = c.textPrimary),
                cursorBrush = SolidColor(c.blue),
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}

/**
 * 二维码：本地 zxing 生成（离线可用、无网络依赖；桌面端用 qrserver 外链——国内网络
 * 实测加载不出白块，安卓端改本地渲染，qrserver 不再使用）。
 */
@Composable
private fun WfQrImage(url: String, size: Dp) {
    val density = androidx.compose.ui.platform.LocalDensity.current
    val px = with(density) { ((size - 12.dp).toPx()).toInt().coerceAtLeast(8) }
    val bitmap = remember(url, px) { generateQrBitmap(url, px) }
    Box(
        Modifier
            .size(size)
            .clip(RoundedCornerShape(8.dp))
            .background(Color.White)
            .padding(6.dp),
        contentAlignment = Alignment.Center,
    ) {
        androidx.compose.foundation.Image(
            bitmap = bitmap,
            contentDescription = "Android download QR",
            modifier = Modifier.fillMaxSize(),
        )
    }
}

private fun generateQrBitmap(content: String, sizePx: Int): androidx.compose.ui.graphics.ImageBitmap {
    val hints = mapOf(
        com.google.zxing.EncodeHintType.MARGIN to 0,
        com.google.zxing.EncodeHintType.CHARACTER_SET to "UTF-8",
    )
    val matrix = com.google.zxing.qrcode.QRCodeWriter()
        .encode(content, com.google.zxing.BarcodeFormat.QR_CODE, sizePx, sizePx, hints)
    val pixels = IntArray(sizePx * sizePx)
    for (y in 0 until sizePx) {
        for (x in 0 until sizePx) {
            pixels[y * sizePx + x] = if (matrix.get(x, y)) 0xFF111827.toInt() else 0xFFFFFFFF.toInt()
        }
    }
    return android.graphics.Bitmap.createBitmap(sizePx, sizePx, android.graphics.Bitmap.Config.ARGB_8888)
        .apply { setPixels(pixels, 0, sizePx, 0, 0, sizePx, sizePx) }
        .asImageBitmap()
}

/**
 * 欢迎页配色：桌面 WelcomeModal 的 Tailwind 灰系/蓝系逐值对齐（浅/深两档）。
 * 不走 AuroraPalette——桌面该卡片本身用的就是 Tailwind 原色（bg-gray-50/border-gray-200…）。
 */
private data class WfC(
    val pageBg: Color,
    val cardBg: Color,
    val rightBg: Color,
    val border: Color,
    val divider: Color,
    val inputBorder: Color,
    val inputBg: Color,
    val sectionBg: Color,
    val label: Color,
    val textPrimary: Color,
    val textSecondary: Color,
    val skipText: Color,
    val hint: Color,
    val pillBg: Color,
    val pillText: Color,
    val blue: Color,
    val blueText: Color,
    val blueChipBg: Color,
    val blueIconBg: Color,
    val blueIconFg: Color,
    val disabledBg: Color,
    val disabledText: Color,
    val success: Color,
    val danger: Color,
    val dotGrid: Color,
    val blobBlue: Color,
    val blobPurple: Color,
    val blobCyan: Color,
    val blobIndigo: Color,
)

private fun wfC(dark: Boolean): WfC = if (dark) WfC(
    pageBg = Color(0xFF030712),      // gray-950
    cardBg = Color(0xFF111827),      // gray-900
    rightBg = Color(0xFF111827),     // gray-900
    border = Color(0xFF1F2937),      // gray-800
    divider = Color(0xFF1F2937),     // gray-800
    inputBorder = Color(0xFF374151), // gray-700
    inputBg = Color(0xFF1F2937),     // gray-800
    sectionBg = Color(0xFF1F2937),   // gray-800
    label = Color(0xFFD1D5DB),       // gray-300
    textPrimary = Color(0xFFF9FAFB), // gray-50
    textSecondary = Color(0xFF9CA3AF), // gray-400
    skipText = Color(0xFF9CA3AF),
    hint = Color(0xFF6B7280),        // gray-500
    pillBg = Color.White,            // dark:bg-white
    pillText = Color(0xFF111827),
    blue = Color(0xFF3B82F6),        // border-blue-500
    blueText = Color(0xFF60A5FA),    // dark:text-blue-400
    blueChipBg = Color(0x331E3A8A),  // dark:bg-blue-900/20
    blueIconBg = Color(0x4D1E3A8A),  // dark:bg-blue-900/30
    blueIconFg = Color(0xFF60A5FA),  // dark:text-blue-400
    disabledBg = Color(0xFF374151),
    disabledText = Color(0xFF9CA3AF),
    success = Color(0xFF4ADE80),     // green-400
    danger = Color(0xFFEF4444),
    dotGrid = Color(0x1A93C5FD),     // blue-300/10
    blobBlue = Color(0x262563EB),    // dark:bg-blue-600/15
    blobPurple = Color(0x269333EA),  // purple-600/15
    blobCyan = Color(0x1A0891B2),    // cyan-600/10
    blobIndigo = Color(0x334F46E5),  // indigo-600/20
) else WfC(
    pageBg = Color.White,
    cardBg = Color.White,
    rightBg = Color(0xFFF9FAFB),     // gray-50
    border = Color(0xFFE5E7EB),      // gray-200
    divider = Color(0xFFF3F4F6),     // gray-100（桌面底栏分隔线 border-gray-100）
    inputBorder = Color(0xFFE5E7EB),
    inputBg = Color.White,
    sectionBg = Color(0xFFF3F4F6),   // gray-100
    label = Color(0xFF374151),       // gray-700
    textPrimary = Color(0xFF111827), // gray-900
    textSecondary = Color(0xFF6B7280), // gray-500
    skipText = Color(0xFF9CA3AF),    // gray-400
    hint = Color(0xFF9CA3AF),
    pillBg = Color(0xFF111827),      // bg-gray-900
    pillText = Color.White,
    blue = Color(0xFF2563EB),        // blue-600
    blueText = Color(0xFF2563EB),    // text-blue-600
    blueChipBg = Color(0xFFEFF6FF),  // bg-blue-50
    blueIconBg = Color(0xFFDBEAFE),  // bg-blue-100
    blueIconFg = Color(0xFF2563EB),
    disabledBg = Color(0xFFE5E7EB),
    disabledText = Color(0xFF9CA3AF),
    success = Color(0xFF16A34A),     // green-600
    danger = Color(0xFFEF4444),
    dotGrid = Color(0x1A1E3A8A),     // blue-900/10
    blobBlue = Color(0x4D60A5FA),    // blue-400/30
    blobPurple = Color(0x4DC084FC),  // purple-400/30
    blobCyan = Color(0x4022D3EE),    // cyan-400/25
    blobIndigo = Color(0x4D818CF8),  // indigo-400/30
)

// ===== 双语文案（组合内字典：主界面全量 i18n 另案，见设计文档 4.2 范围约束）=====

private data class WelText(
    val permissionTitle: String,
    val permissionDesc: String,
    val permissionBody: String,
    val permissionDeniedHint: String,
    val authorize: String,
    val openSettings: String,
    val preferencesTitle: String,
    val preferencesDesc: String,
    val themeLabel: String,
    val themeLight: String,
    val themeDark: String,
    val themeSystem: String,
    val languageLabel: String,
    val aiTitle: String,
    val aiDesc: String,
    val aiProviderOnline: String,
    val aiEndpoint: String,
    val aiApiKey: String,
    val aiModel: String,
    val aiTest: String,
    val aiTesting: String,
    val aiConnected: String,
    val aiDisconnected: String,
    val aiHint: String,
    val connectTitle: String,
    val connectDesc: String,
    val connectEnable: String,
    val connectStarting: String,
    val connectRunning: String,
    val connectFailed: String,
    val connectAccessCode: String,
    val connectHint: String,
    val desktopDownloadTitle: String,
    val desktopDownloadHint: String,
    val desktopDownloadCopy: String,
    val desktopDownloadCopied: String,
    val scanDownloadAndroid: String,
    val next: String,
    val finish: String,
    val skip: String,
)

private fun welText(language: String): WelText =
    if (language == AppSettings.LANGUAGE_EN) WelText(
        permissionTitle = "Welcome to Aurora Gallery",
        permissionDesc = "Allow access to your photos to build your library.",
        permissionBody = "Aurora Gallery needs to read the photos and screenshots on this device to display them in your library. Images are only scanned locally and never uploaded.",
        permissionDeniedHint = "Permission was denied. You can enable it in system settings → Permissions.",
        authorize = "Grant & Continue",
        openSettings = "Open system settings",
        preferencesTitle = "Personalize",
        preferencesDesc = "Pick a theme and language for the app.",
        themeLabel = "Theme",
        themeLight = "Light",
        themeDark = "Dark",
        themeSystem = "System",
        languageLabel = "Language",
        aiTitle = "AI Analysis (Optional)",
        aiDesc = "Configure an AI provider for auto-tagging, descriptions and smart search.",
        aiProviderOnline = "Online",
        aiEndpoint = "Endpoint",
        aiApiKey = "API Key",
        aiModel = "Model",
        aiTest = "Test connection",
        aiTesting = "Testing…",
        aiConnected = "Connected",
        aiDisconnected = "Connection failed",
        aiHint = "Skip now and configure later in Settings → AI. Fields are saved when you tap Next.",
        connectTitle = "Mobile Connect (Optional)",
        connectDesc = "Enable LAN sharing so your desktop can browse & download this phone's images.",
        connectEnable = "Enable LAN sharing",
        connectStarting = "Starting…",
        connectRunning = "Sharing is on",
        connectFailed = "Failed to start. Retry later in Settings → LAN sharing.",
        connectAccessCode = "Access code",
        connectHint = "On the desktop, open Settings → LAN sharing → Connect Android device and enter the address and code above.",
        desktopDownloadTitle = "Get the desktop app",
        desktopDownloadHint = "Open the link below in a browser on your PC to download the desktop version.",
        desktopDownloadCopy = "Copy link",
        desktopDownloadCopied = "Copied",
        scanDownloadAndroid = "Scan to get the mobile app",
        next = "Next",
        finish = "Start using",
        skip = "Skip",
    )
    else WelText(
        permissionTitle = "欢迎使用极光图库",
        permissionDesc = "允许读取照片，开始建立你的图库。",
        permissionBody = "极光图库需要读取设备上的照片与截图，才能在图库中展示它们。所有扫描均在本机完成，不会上传任何图片。",
        permissionDeniedHint = "授权被拒绝。可前往系统设置 → 权限，开启「照片和视频」后返回。",
        authorize = "授权并继续",
        openSettings = "去系统设置授权",
        preferencesTitle = "个性化设置",
        preferencesDesc = "选择应用的主题与语言。",
        themeLabel = "颜色主题",
        themeLight = "浅色",
        themeDark = "深色",
        themeSystem = "跟随系统",
        languageLabel = "界面语言",
        aiTitle = "AI 智能分析（可选）",
        aiDesc = "配置 AI 服务商，启用自动标签、图片描述与智能搜索。",
        aiProviderOnline = "在线",
        aiEndpoint = "服务地址",
        aiApiKey = "API Key",
        aiModel = "模型",
        aiTest = "测试连接",
        aiTesting = "测试中…",
        aiConnected = "已连接",
        aiDisconnected = "连接失败",
        aiHint = "也可以跳过，稍后在「设置 → AI」中配置；点「下一步」时才会保存。",
        connectTitle = "移动端互联（可选）",
        connectDesc = "开启局域网共享后，桌面端即可浏览与下载本机图片。",
        connectEnable = "开启局域网共享",
        connectStarting = "启动中…",
        connectRunning = "共享已开启",
        connectFailed = "启动失败，请稍后在「设置 → 局域网共享」中重试。",
        connectAccessCode = "访问码",
        connectHint = "在桌面端打开「设置 → 局域网共享 → 连接安卓设备」，填入上方地址与访问码即可连接。",
        desktopDownloadTitle = "下载桌面端",
        desktopDownloadHint = "在电脑浏览器打开下方链接，即可下载桌面版。",
        desktopDownloadCopy = "复制链接",
        desktopDownloadCopied = "已复制",
        scanDownloadAndroid = "扫码下载安卓端",
        next = "下一步",
        finish = "开始使用",
        skip = "跳过",
    )
