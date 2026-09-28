package com.aurora.gallery.kotlin.ui.components

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
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
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.aurora.gallery.kotlin.LanServerSnapshot
import com.aurora.gallery.kotlin.state.AiSettings
import com.aurora.gallery.kotlin.state.AppSettings
import com.aurora.gallery.kotlin.state.WelcomeFlowState
import com.aurora.gallery.kotlin.state.WelcomeStep
import com.aurora.gallery.kotlin.ui.isCompactWidth
import com.aurora.gallery.kotlin.ui.theme.AuroraTheme
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** 双端下载页（与桌面端欢迎页二维码同源：update/android.json homepage 主源，双平台安装包同仓发布）。 */
private const val DOWNLOAD_PAGE_URL = "https://gitee.com/misakimiku2/aurora_gallery/releases"

/**
 * 欢迎向导（启动流程优化 2026-09-29，设计文档 docs/启动欢迎流程优化-设计方案.md 4.x）：
 * 首启时由宿主以全屏覆盖层渲染于主界面之上，四步对齐桌面 WelcomeModal——
 * 权限（拒绝兜底=去系统设置）→ 偏好（主题/语言）→ AI 设置（可跳）→ 互联（可跳）。
 *
 * 文案按 [language]（settings.language）在组合内即时切中/英——主界面其余 UI 仍是
 * 中文硬编码（既有惯例），欢迎页自备字典保证自身完整双语，全量 i18n 另案。
 * 触控目标 ≥48dp（desktop-to-android 规范）；返回手势经 BackHandler 走步骤回退，
 * 无死路。状态机见 [WelcomeFlowState]（纯 Kotlin，JUnit 覆盖）。
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
    val colors = AuroraTheme.colors
    val compact = isCompactWidth(LocalConfiguration.current)

    BackHandler(enabled = state.canBack) { onStateChange(state.back()) }
    // 状态机走到 DONE（互联步「开始使用」推进）即收尾：写 onboarded + 揭幕主界面
    LaunchedEffect(state.step) {
        if (state.step == WelcomeStep.DONE) onFinish()
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

    Box(Modifier.fillMaxSize().background(colors.main)) {
        if (compact) {
            Column(Modifier.fillMaxSize()) {
                BrandContent(Modifier.fillMaxWidth(), compact = true, title = title, desc = desc, step = state.step)
                StepContent(
                    Modifier.weight(1f), text, state, permissionDenied, theme, language, ai, lanSnapshot,
                    onThemeChange, onLanguageChange, onAiChange, aiTestConnection, enableLanServer,
                    onRequestPermission, onOpenAppSettings,
                )
                BottomBar(Modifier, text, state, onStateChange)
            }
        } else {
            Row(Modifier.fillMaxSize()) {
                BrandContent(Modifier.width(320.dp).fillMaxHeight(), compact = false, title = title, desc = desc, step = state.step)
                Column(Modifier.weight(1f).fillMaxHeight()) {
                    StepContent(
                        Modifier.weight(1f), text, state, permissionDenied, theme, language, ai, lanSnapshot,
                        onThemeChange, onLanguageChange, onAiChange, aiTestConnection, enableLanServer,
                        onRequestPermission, onOpenAppSettings,
                    )
                    BottomBar(Modifier, text, state, onStateChange)
                }
            }
        }
    }
}

/** 品牌区：手机=顶部横幅（compact），平板横屏=左侧整列（对齐桌面左半栏）。 */
@Composable
private fun BrandContent(modifier: Modifier, compact: Boolean, title: String, desc: String, step: WelcomeStep) {
    Column(
        modifier
            .background(Brush.verticalGradient(listOf(Color(0xFF2563EB), Color(0xFF4F46E5))))
            .padding(if (compact) 20.dp else 28.dp),
        verticalArrangement = if (compact) Arrangement.spacedBy(16.dp) else Arrangement.SpaceBetween,
    ) {
        Column {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(
                    Modifier.size(36.dp).clip(CircleShape).background(Color.White.copy(alpha = 0.22f)),
                    contentAlignment = Alignment.Center,
                ) {
                    Text("A", color = Color.White, fontSize = 20.sp, fontWeight = FontWeight.Bold)
                }
                Spacer(Modifier.width(10.dp))
                Text("AURORA", color = Color.White, fontSize = 18.sp, fontWeight = FontWeight.Bold, letterSpacing = 2.sp)
            }
            if (compact) {
                Text(title, color = Color.White, fontSize = 22.sp, fontWeight = FontWeight.Bold)
                Text(desc, color = Color.White.copy(alpha = 0.85f), fontSize = 14.sp, lineHeight = 20.sp)
            }
        }
        if (!compact) {
            Text(title, color = Color.White, fontSize = 26.sp, fontWeight = FontWeight.Bold)
            Spacer(Modifier.height(8.dp))
            Text(desc, color = Color.White.copy(alpha = 0.85f), fontSize = 14.sp, lineHeight = 20.sp)
        }
        WfStepDots(step)
    }
}

@Composable
private fun StepContent(
    modifier: Modifier,
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
) {
    val colors = AuroraTheme.colors
    Column(
        modifier
            .fillMaxWidth()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = if (LocalConfiguration.current.screenWidthDp < 600) 20.dp else 32.dp, vertical = 24.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        when (state.step) {
            WelcomeStep.PERMISSION -> PermissionStep(text, permissionDenied, onRequestPermission, onOpenAppSettings)
            WelcomeStep.PREFERENCES -> PreferencesStep(text, theme, language, onThemeChange, onLanguageChange)
            WelcomeStep.AI -> AiStep(text, ai, onAiChange, aiTestConnection)
            WelcomeStep.CONNECT -> ConnectStep(text, lanSnapshot, enableLanServer)
            WelcomeStep.DONE -> Text("", color = colors.textSecondary)
        }
    }
}

@Composable
private fun BottomBar(
    modifier: Modifier,
    text: WelText,
    state: WelcomeFlowState,
    onStateChange: (WelcomeFlowState) -> Unit,
) {
    Row(
        modifier
            .fillMaxWidth()
            .navigationBarsPadding()
            .padding(horizontal = 24.dp, vertical = 16.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (state.canSkip) {
            Text(
                text.skipHint,
                fontSize = 14.sp,
                color = AuroraTheme.colors.textSecondary,
                modifier = Modifier
                    .heightIn(min = 48.dp)
                    .clickable { onStateChange(state.skip()) }
                    .padding(horizontal = 8.dp, vertical = 14.dp),
            )
        } else {
            Spacer(Modifier.width(1.dp))
        }
        val enabled = state.step != WelcomeStep.PERMISSION
        WfPrimaryButton(if (state.isLast) text.finish else text.next, enabled = enabled) {
            onStateChange(state.next())
        }
    }
}

// ===== 各步内容 =====

@Composable
private fun PermissionStep(
    text: WelText,
    permissionDenied: Boolean,
    onRequestPermission: () -> Unit,
    onOpenAppSettings: () -> Unit,
) {
    val colors = AuroraTheme.colors
    Box(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(16.dp))
            .background(colors.panel)
            .border(1.dp, colors.border, RoundedCornerShape(16.dp))
            .padding(20.dp),
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Text(text.permissionBody, fontSize = 14.sp, lineHeight = 21.sp, color = colors.textPrimary)
            if (permissionDenied) {
                Text(text.permissionDeniedHint, fontSize = 13.sp, lineHeight = 19.sp, color = colors.textSecondary)
                WfSecondaryButton(text.openSettings, onClick = onOpenAppSettings)
            }
            WfPrimaryButton(text.authorize, onClick = onRequestPermission, modifier = Modifier.fillMaxWidth())
        }
    }
}

@Composable
private fun PreferencesStep(
    text: WelText,
    theme: String,
    language: String,
    onThemeChange: (String) -> Unit,
    onLanguageChange: (String) -> Unit,
) {
    val colors = AuroraTheme.colors
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(text.themeLabel, fontSize = 13.sp, fontWeight = FontWeight.Bold, color = colors.textSecondary)
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            WfChip(text.themeLight, theme == AppSettings.THEME_LIGHT, Modifier.weight(1f)) { onThemeChange(AppSettings.THEME_LIGHT) }
            WfChip(text.themeDark, theme == AppSettings.THEME_DARK, Modifier.weight(1f)) { onThemeChange(AppSettings.THEME_DARK) }
            WfChip(text.themeSystem, theme == AppSettings.THEME_SYSTEM, Modifier.weight(1f)) { onThemeChange(AppSettings.THEME_SYSTEM) }
        }
        Spacer(Modifier.height(8.dp))
        Text(text.languageLabel, fontSize = 13.sp, fontWeight = FontWeight.Bold, color = colors.textSecondary)
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            WfChip("中文", language != AppSettings.LANGUAGE_EN, Modifier.weight(1f)) { onLanguageChange(AppSettings.LANGUAGE_ZH) }
            WfChip("English", language == AppSettings.LANGUAGE_EN, Modifier.weight(1f)) { onLanguageChange(AppSettings.LANGUAGE_EN) }
        }
    }
}

private val AI_PROVIDERS = listOf("openai" to "OpenAI", "ollama" to "Ollama", "lmstudio" to "LM Studio")

@Composable
private fun AiStep(
    text: WelText,
    ai: AiSettings,
    onAiChange: (AiSettings) -> Unit,
    aiTestConnection: suspend (AiSettings) -> Result<Unit>,
) {
    val colors = AuroraTheme.colors
    val scope = rememberCoroutineScope()
    // 草稿只在「下一步」时提交（跳过不落盘）；离开该步即弃（重进以已保存值重置）——对齐桌面
    var draft by remember { mutableStateOf(ai) }
    var testing by remember { mutableStateOf(false) }
    var testOk by remember { mutableStateOf<Boolean?>(null) }

    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            AI_PROVIDERS.forEach { (id, label) ->
                WfChip(label, draft.provider == id, Modifier.weight(1f)) {
                    draft = draft.copy(provider = id)
                    testOk = null
                }
            }
        }
        WfTextField(
            label = text.aiEndpoint,
            value = aiEndpointOf(draft),
            onValueChange = { v -> draft = withEndpoint(draft, v) },
            hint = "http://127.0.0.1:1234",
        )
        if (draft.provider == "openai") {
            WfTextField(
                label = text.aiApiKey,
                value = draft.openaiApiKey,
                onValueChange = { v -> draft = draft.copy(openaiApiKey = v) },
                hint = "sk-…",
            )
        }
        WfTextField(
            label = text.aiModel,
            value = aiModelOf(draft),
            onValueChange = { v -> draft = withModel(draft, v) },
            hint = "",
        )
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            WfSecondaryButton(if (testing) text.aiTesting else text.aiTest, enabled = !testing) {
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
                    color = Color(if (testOk == true) 0xFF16A34A else 0xFFEF4444),
                )
            }
        }
        Text(
            text.aiHint,
            fontSize = 12.sp,
            lineHeight = 17.sp,
            color = colors.textSecondary,
        )
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
    text: WelText,
    lanSnapshot: LanServerSnapshot?,
    enableLanServer: suspend () -> Boolean,
) {
    val colors = AuroraTheme.colors
    val scope = rememberCoroutineScope()
    val enabled = lanSnapshot?.enabled == true
    var starting by remember { mutableStateOf(false) }
    var failed by remember { mutableStateOf(false) }

    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Row(
            Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(14.dp))
                .background(colors.panel)
                .border(1.dp, colors.border, RoundedCornerShape(14.dp))
                .padding(horizontal = 16.dp, vertical = 12.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(text.connectEnable, fontSize = 15.sp, fontWeight = FontWeight.Bold, color = colors.textPrimary)
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
                colors = SwitchDefaults.colors(checkedTrackColor = colors.primary),
            )
        }
        if (starting) {
            Text(text.connectStarting, fontSize = 13.sp, color = colors.textSecondary)
        }
        if (failed) {
            Text(text.connectFailed, fontSize = 13.sp, color = Color(0xFFEF4444))
        }
        if (enabled && lanSnapshot?.running == true) {
            Box(
                Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(14.dp))
                    .background(colors.panel)
                    .border(1.dp, colors.border, RoundedCornerShape(14.dp))
                    .padding(16.dp),
            ) {
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(text.connectRunning, fontSize = 13.sp, fontWeight = FontWeight.Bold, color = Color(0xFF16A34A))
                    Text("http://${lanSnapshot.ip}:${lanSnapshot.port}", fontSize = 15.sp, color = colors.textPrimary)
                    Text("${text.connectAccessCode}：${lanSnapshot.accessCode}", fontSize = 13.sp, color = colors.textSecondary)
                    Text(text.connectHint, fontSize = 12.sp, lineHeight = 17.sp, color = colors.textSecondary)
                }
            }
        }
        DesktopDownloadCard(text)
    }
}

/** 桌面端下载入口（与桌面欢迎页「扫码下载安卓端」对映）：展示下载页链接 + 复制按钮。 */
@Composable
private fun DesktopDownloadCard(text: WelText) {
    val colors = AuroraTheme.colors
    val clipboard = LocalClipboardManager.current
    val scope = rememberCoroutineScope()
    var copied by remember { mutableStateOf(false) }

    Box(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .background(colors.panel)
            .border(1.dp, colors.border, RoundedCornerShape(14.dp))
            .padding(16.dp),
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(text.desktopDownloadTitle, fontSize = 15.sp, fontWeight = FontWeight.Bold, color = colors.textPrimary)
            Text(text.desktopDownloadHint, fontSize = 12.sp, lineHeight = 17.sp, color = colors.textSecondary)
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    DOWNLOAD_PAGE_URL,
                    fontSize = 12.sp,
                    fontFamily = FontFamily.Monospace,
                    color = colors.primary,
                    modifier = Modifier.weight(1f),
                )
                WfSecondaryButton(if (copied) text.desktopDownloadCopied else text.desktopDownloadCopy) {
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

// ===== 小组件（自包含样式；SettingsDialog 的 Lan* 系为文件私有不可跨文件复用）=====

@Composable
private fun WfStepDots(step: WelcomeStep) {
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        WelcomeStep.entries.filter { it != WelcomeStep.DONE }.forEach { s ->
            // 纯指示器（不可点）：移动端回退走系统返回手势（BackHandler），避免 <48dp 命中区
            Box(
                Modifier
                    .size(width = 26.dp, height = 6.dp)
                    .clip(RoundedCornerShape(3.dp))
                    .background(
                        if (s == step) Color.White else Color.White.copy(alpha = if (s.ordinal < step.ordinal) 0.7f else 0.3f),
                    ),
            )
        }
    }
}

@Composable
private fun WfPrimaryButton(text: String, enabled: Boolean = true, modifier: Modifier = Modifier, onClick: () -> Unit) {
    val colors = AuroraTheme.colors
    Box(
        modifier
            .heightIn(min = 48.dp)
            .clip(RoundedCornerShape(12.dp))
            .background(if (enabled) colors.primaryDeep else colors.subtle)
            .clickable(enabled = enabled) { onClick() }
            .padding(horizontal = 28.dp, vertical = 12.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text,
            fontSize = 15.sp,
            fontWeight = FontWeight.Bold,
            color = if (enabled) Color.White else colors.textSecondary,
        )
    }
}

@Composable
private fun WfSecondaryButton(text: String, enabled: Boolean = true, onClick: () -> Unit) {
    val colors = AuroraTheme.colors
    Box(
        Modifier
            .heightIn(min = 48.dp)
            .clip(RoundedCornerShape(12.dp))
            .background(Color(colors.palette.buttonSecondaryBg))
            .border(1.dp, colors.border, RoundedCornerShape(12.dp))
            .clickable(enabled = enabled) { onClick() }
            .padding(horizontal = 20.dp, vertical = 12.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(text, fontSize = 14.sp, fontWeight = FontWeight.Bold, color = Color(colors.palette.buttonSecondaryText))
    }
}

@Composable
private fun WfChip(text: String, selected: Boolean, modifier: Modifier = Modifier, onClick: () -> Unit) {
    val colors = AuroraTheme.colors
    Box(
        modifier
            .heightIn(min = 48.dp)
            .clip(RoundedCornerShape(12.dp))
            // 选中态=实心 primary 底 + 白字（对齐侧栏「本地相册」选中惯例）：
            // dark 档 primaryWeak 是浅蓝底，配 primary 蓝字对比不足（模拟器实测发现）
            .background(if (selected) colors.primary else Color.Transparent)
            .border(
                1.dp,
                if (selected) colors.primary else colors.border,
                RoundedCornerShape(12.dp),
            )
            .clickable { onClick() }
            .padding(horizontal = 12.dp, vertical = 12.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text,
            fontSize = 14.sp,
            fontWeight = if (selected) FontWeight.Bold else FontWeight.Normal,
            color = if (selected) Color.White else colors.textPrimary,
        )
    }
}

@Composable
private fun WfTextField(label: String, value: String, onValueChange: (String) -> Unit, hint: String) {
    val colors = AuroraTheme.colors
    Column {
        Text(label, fontSize = 12.sp, fontWeight = FontWeight.Bold, color = colors.textSecondary)
        Spacer(Modifier.height(4.dp))
        Box(
            Modifier
                .fillMaxWidth()
                .heightIn(min = 48.dp)
                .clip(RoundedCornerShape(10.dp))
                .background(Color(colors.palette.textBoxBg))
                .border(1.dp, colors.border, RoundedCornerShape(10.dp))
                .padding(horizontal = 12.dp, vertical = 12.dp),
            contentAlignment = Alignment.CenterStart,
        ) {
            if (value.isEmpty() && hint.isNotEmpty()) {
                Text(hint, fontSize = 15.sp, color = Color(colors.palette.hint))
            }
            BasicTextField(
                value = value,
                onValueChange = onValueChange,
                singleLine = true,
                textStyle = TextStyle(fontSize = 15.sp, color = colors.textPrimary),
                cursorBrush = SolidColor(colors.primary),
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}

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
    val next: String,
    val finish: String,
    val skipHint: String,
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
        themeLabel = "THEME",
        themeLight = "Light",
        themeDark = "Dark",
        themeSystem = "System",
        languageLabel = "LANGUAGE",
        aiTitle = "AI Analysis (Optional)",
        aiDesc = "Configure an AI provider for auto-tagging, descriptions and smart search.",
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
        next = "Next",
        finish = "Start using",
        skipHint = "Skip, set up later in Settings",
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
        themeLabel = "主题",
        themeLight = "浅色",
        themeDark = "深色",
        themeSystem = "跟随系统",
        languageLabel = "语言",
        aiTitle = "AI 智能分析（可选）",
        aiDesc = "配置 AI 服务商，启用自动标签、图片描述与智能搜索。",
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
        next = "下一步",
        finish = "开始使用",
        skipHint = "跳过，稍后在设置中配置",
    )
