package com.aurora.gallery.kotlin.ui.components

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.wrapContentHeight
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import android.Manifest
import android.content.pm.PackageManager
import android.widget.Toast
import androidx.core.content.ContextCompat
import com.aurora.gallery.kotlin.LanManager
import com.aurora.gallery.kotlin.LanQr
import com.aurora.gallery.kotlin.LanServerManager
import com.aurora.gallery.kotlin.LanServerSnapshot
import com.aurora.gallery.kotlin.LanState
import com.aurora.gallery.kotlin.state.AiSettings
import com.aurora.gallery.kotlin.state.AppSettings
import com.aurora.gallery.kotlin.state.LanSavedServer
import com.aurora.gallery.kotlin.state.SortDirection
import com.aurora.gallery.kotlin.state.SortOption
import com.aurora.gallery.kotlin.state.toAiConfig
import com.aurora.gallery.kotlin.ui.theme.AuroraTheme
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch

/**
 * 设置界面（M4c 重构：形制与控件双对齐桌面 SettingsModal/GeneralPanel/AboutPanel，
 * D26 双形态 + D27 项目范围）。
 *
 * 形制按屏宽断点（沿用 FileGrid/FoldersOverview 的 `screenWidthDp >= 600` 惯例，补高度
 * 条件 ≥480dp——横屏手机放不下双栏对话框，归全屏页形态）：
 *  - 平板：桌面式双栏对话框——左分类导航（panel 底、图标+文字、选中 primary 15% 底）
 *    + 右内容滚动区（content 底），nav 底部「完成」，整体 rounded 16dp；
 *  - 手机：独立全屏设置页——顶栏（返回 + 「设置」）+ 单列滚动，系统返回键关闭。
 *
 * 分类对齐桌面导航（React 安卓端同款五类；AI视觉/性能是桌面专属，两端都不显示）：
 * 常规 / 存储 / AI 智能 / 局域网共享 / 关于。局域网共享已随 M6a（D16）落地
 * （连接 + 扫码 + 最近服务器 + 设备名 + M6a 阶段 7 的对等服务端开关）；
 * AI 智能与存储类的主色调数据库管理仍为占位（随 M6b）。
 *
 * 控件图形化（2.6）：主题三档预览卡（Sun/Moon/Monitor + 选中角标）、视图模式与
 * 分组方式图标卡、排序方式/方向带图标按钮组（+勾），全部对齐桌面 GeneralPanel 的
 * lucide 引用（路径见 [AuroraIcons]）。关于页对齐桌面 AboutPanel：软件信息大卡
 * （渐变底 + logo + 版本/稳定版徽标）、技术栈版本三卡、相关链接两卡、致谢页脚。
 */
@Composable
fun SettingsHost(
    settings: AppSettings,
    cacheSizeText: String,
    appVersion: String,
    /** M6a 阶段 3：LAN 连接状态机（面板与侧栏共用同一 StateFlow 快照）。 */
    lan: LanManager,
    /**
     * M6a 阶段 7：对等服务端单例（「允许桌面浏览本机」开关的数据源与操作口）。
     * 未 init（null）时该 Section 退化为不渲染。
     */
    lanServer: LanServerManager?,
    /** M6a 阶段 4：连接成功后「浏览共享文件」入口（宿主关面板并进 LAN 总览）。 */
    onLanBrowseClick: () -> Unit = {},
    onLanguageChange: (String) -> Unit,
    onThemeChange: (String) -> Unit,
    onDefaultLayoutChange: (LayoutMode) -> Unit,
    onDefaultSortChange: (SortOption, SortDirection) -> Unit,
    onDefaultGroupByChange: (GroupBy) -> Unit,
    onClearCache: () -> Unit,
    onExportBackup: () -> Unit,
    onImportBackup: () -> Unit,
    onOpenUrl: (String) -> Unit,
    /** M6b 阶段 2：AI 设置的即时保存口（面板逐项变更即提交，对齐 GeneralContent 惯例）。 */
    onAiSettingsChange: (AiSettings) -> Unit,
    onDismiss: () -> Unit,
) {
    // 平板形态需宽高都够：横屏手机（宽 ≥600 但高仅 ~411dp）放不下双栏对话框
    //（M4c 实测底部溢出），落到全屏页形态。断点取 FileGrid 惯例 600dp + 高度 480dp。
    val isTablet = LocalConfiguration.current.screenWidthDp >= 600 &&
        LocalConfiguration.current.screenHeightDp >= 480
    if (isTablet) {
        SettingsTabletDialog(
            settings = settings,
            cacheSizeText = cacheSizeText,
            appVersion = appVersion,
            lan = lan,
            lanServer = lanServer,
            onLanBrowseClick = onLanBrowseClick,
            onLanguageChange = onLanguageChange,
            onThemeChange = onThemeChange,
            onDefaultLayoutChange = onDefaultLayoutChange,
            onDefaultSortChange = onDefaultSortChange,
            onDefaultGroupByChange = onDefaultGroupByChange,
            onClearCache = onClearCache,
            onExportBackup = onExportBackup,
            onImportBackup = onImportBackup,
            onOpenUrl = onOpenUrl,
            onAiSettingsChange = onAiSettingsChange,
            onDismiss = onDismiss,
        )
    } else {
        SettingsPhonePage(
            settings = settings,
            cacheSizeText = cacheSizeText,
            appVersion = appVersion,
            lan = lan,
            lanServer = lanServer,
            onLanBrowseClick = onLanBrowseClick,
            onLanguageChange = onLanguageChange,
            onThemeChange = onThemeChange,
            onDefaultLayoutChange = onDefaultLayoutChange,
            onDefaultSortChange = onDefaultSortChange,
            onDefaultGroupByChange = onDefaultGroupByChange,
            onClearCache = onClearCache,
            onExportBackup = onExportBackup,
            onImportBackup = onImportBackup,
            onOpenUrl = onOpenUrl,
            onAiSettingsChange = onAiSettingsChange,
            onDismiss = onDismiss,
        )
    }
}

// —— 分类 ——

private enum class SettingsCategory(
    val label: String,
    val icon: ImageVector,
    /** M6 未落地类：导航可见、内容为占位说明页（D16/D27）。 */
    val placeholder: Boolean = false,
) {
    GENERAL("常规", IconSliders),
    STORAGE("存储", IconDatabase),
    // M6b 阶段 2：AI 面板落地（D16 尾款），不再是占位类
    AI("AI 智能", IconBot),
    // M6a 阶段 3 起 LAN 面板落地（连接/扫码/最近服务器），不再是占位类
    LAN("局域网共享", IconWifi),
    ABOUT("关于", IconInfo),
}

/**
 * 分类内容分发。平板（右内容区）与手机（单列）共用同一套分区，保证两端改的是同一处。
 */
@Composable
private fun CategoryContent(
    categories: List<SettingsCategory>,
    settings: AppSettings,
    cacheSizeText: String,
    appVersion: String,
    /** false = 不渲染与分类同名的首个节标题（手机二级页：顶栏已是分类名，重复）。 */
    includeSectionHeaders: Boolean = true,
    lan: LanManager,
    /** M6a 阶段 7：对等服务端单例（未 init 时 LAN 面板的对等 Section 不渲染）。 */
    lanServer: LanServerManager?,
    /** M6a 阶段 4：连接成功后「浏览共享文件」入口（宿主关面板并进 LAN 总览）。 */
    onLanBrowseClick: () -> Unit = {},
    onLanguageChange: (String) -> Unit,
    onThemeChange: (String) -> Unit,
    onDefaultLayoutChange: (LayoutMode) -> Unit,
    onDefaultSortChange: (SortOption, SortDirection) -> Unit,
    onDefaultGroupByChange: (GroupBy) -> Unit,
    onClearCache: () -> Unit,
    onExportBackup: () -> Unit,
    onImportBackup: () -> Unit,
    onOpenUrl: (String) -> Unit,
    /** M6b 阶段 2：AI 设置的即时保存口（面板逐项变更即提交，对齐 GeneralContent 惯例）。 */
    onAiSettingsChange: (AiSettings) -> Unit,
) {
    if (SettingsCategory.GENERAL in categories) {
        GeneralContent(
            settings = settings,
            includeSectionHeaders = includeSectionHeaders,
            onLanguageChange = onLanguageChange,
            onThemeChange = onThemeChange,
            onDefaultLayoutChange = onDefaultLayoutChange,
            onDefaultSortChange = onDefaultSortChange,
            onDefaultGroupByChange = onDefaultGroupByChange,
        )
    }
    if (SettingsCategory.STORAGE in categories) {
        StorageContent(
            cacheSizeText = cacheSizeText,
            includeSectionHeaders = includeSectionHeaders,
            onClearCache = onClearCache,
            onExportBackup = onExportBackup,
            onImportBackup = onImportBackup,
        )
    }
    if (SettingsCategory.AI in categories) {
        AiContent(
            settings = settings,
            includeSectionHeaders = includeSectionHeaders,
            onAiSettingsChange = onAiSettingsChange,
        )
    }
    if (SettingsCategory.LAN in categories) {
        // M6a 阶段 3：连接状态/手输/扫码/最近服务器/设备名；阶段 7 起再加「允许桌面
        // 浏览本机」对等服务端开关（lanServer 未 init 时该 Section 不渲染）。
        // 阶段 4 起连接成功后提供「浏览共享文件」入口。
        LanContent(
            lan = lan,
            lanServer = lanServer,
            includeSectionHeaders = includeSectionHeaders,
            onBrowseClick = onLanBrowseClick,
        )
    }
    if (SettingsCategory.ABOUT in categories) {
        AboutContent(
            appVersion = appVersion,
            includeSectionHeaders = includeSectionHeaders,
            onOpenUrl = onOpenUrl,
            onAiSettingsChange = onAiSettingsChange,
        )
    }
}

/**
 * AI 智能面板（M6b 阶段 2，替换 M4c 的 AI placeholder；D38=桌面 AISettingsPanel 子集）。
 * 内容：provider 三选、按 provider 的 endpoint/model（openai 另有 apiKey 密文框）、
 * 测试连接 + 刷新模型（core 同步 FFI 走 IO 线程）、五任务开关（人物描述增强随
 * autoDescription 联动禁用——桌面语义）、系统提示词多行框。
 * 桌面差异登记（D38）：prompt 预设管理/在线服务预设不带；悬空设置
 * targetLanguage/confidenceThreshold 不复制（翻译目标语言=通用面板的语言设置）。
 * 变更即提交（onAiSettingsChange），对齐 GeneralContent 的逐项即时保存惯例。
 */
@Composable
private fun AiContent(
    settings: AppSettings,
    includeSectionHeaders: Boolean,
    onAiSettingsChange: (AiSettings) -> Unit,
) {
    val colors = AuroraTheme.colors
    val ai = settings.ai
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    // 测试连接/刷新模型的忙碌态与反馈（内联错误一行，成功 Toast）
    var testing by remember { mutableStateOf(false) }
    var fetchingModels by remember { mutableStateOf(false) }
    var modelChoices by remember { mutableStateOf<List<String>?>(null) }
    var inlineError by remember { mutableStateOf<String?>(null) }

    fun update(transform: (AiSettings) -> AiSettings) = onAiSettingsChange(transform(ai))
    fun currentEndpoint(): String = when (ai.provider) {
        "ollama" -> ai.ollamaEndpoint
        "lmstudio" -> ai.lmstudioEndpoint
        else -> ai.openaiEndpoint
    }

    if (includeSectionHeaders) SettingsSection("AI 智能", IconBot)

    Column(Modifier.padding(top = 12.dp)) {
        SettingsLabel("服务商", topPadding = 0)
        Row(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            listOf(
                "openai" to "OpenAI 兼容",
                "ollama" to "Ollama",
                "lmstudio" to "LM Studio",
            ).forEach { (id, label) ->
                AiProviderOption(
                    label = label,
                    selected = ai.provider == id,
                    onClick = {
                        inlineError = null
                        update { it.copy(provider = id) }
                    },
                )
            }
        }

        // 按 provider 显示对应配置（桌面 AISettingsPanel 同款分支）
        when (ai.provider) {
            "openai" -> {
                SettingsLabel("服务地址")
                LanTextField(
                    value = ai.openaiEndpoint,
                    onValueChange = { v -> update { it.copy(openaiEndpoint = v) } },
                    hint = "https://api.openai.com/v1",
                )
                SettingsLabel("API Key")
                Surface(
                    modifier = Modifier.fillMaxWidth().padding(top = 8.dp).height(48.dp),
                    shape = RoundedCornerShape(8.dp),
                    color = colors.surface,
                    border = BorderStroke(1.dp, colors.border),
                ) {
                    BasicTextField(
                        value = ai.openaiApiKey,
                        onValueChange = { v -> update { it.copy(openaiApiKey = v) } },
                        singleLine = true,
                        textStyle = TextStyle(fontSize = 14.sp, color = colors.textPrimary),
                        cursorBrush = SolidColor(colors.primary),
                        visualTransformation = androidx.compose.ui.text.input.PasswordVisualTransformation(),
                        modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp).wrapContentHeight(Alignment.CenterVertically),
                        decorationBox = { inner ->
                            Box(Modifier.wrapContentHeight(align = Alignment.CenterVertically)) {
                                if (ai.openaiApiKey.isEmpty()) {
                                    Text("sk-...", fontSize = 14.sp, color = colors.textSecondary, maxLines = 1)
                                }
                                inner()
                            }
                        },
                    )
                }
                SettingsLabel("模型")
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.weight(1f)) {
                        LanTextField(
                            value = ai.openaiModel,
                            onValueChange = { v -> update { it.copy(openaiModel = v) } },
                            hint = "gpt-4o",
                        )
                    }
                    Spacer(Modifier.size(8.dp))
                    LanSecondaryButton("刷新模型", enabled = !fetchingModels, onClick = {
                        if (ai.openaiEndpoint.isBlank()) {
                            inlineError = "请先填写服务地址"
                        } else {
                            fetchingModels = true
                            inlineError = null
                            scope.launch {
                                val cfg = ai.toAiConfig(settings.language)
                                val result = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
                                    runCatching { uniffi.aurora_core.aiFetchModels(cfg) }
                                }
                                fetchingModels = false
                                result.fold(
                                    onSuccess = { models ->
                                        if (models.isEmpty()) inlineError = "服务未返回模型列表" else modelChoices = models
                                    },
                                    onFailure = { e -> inlineError = e.message ?: "获取模型列表失败" },
                                )
                            }
                        }
                    })
                }
            }
            "ollama" -> {
                SettingsLabel("服务地址")
                LanTextField(
                    value = ai.ollamaEndpoint,
                    onValueChange = { v -> update { it.copy(ollamaEndpoint = v) } },
                    hint = "http://127.0.0.1:11434",
                )
                SettingsLabel("模型")
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.weight(1f)) {
                        LanTextField(
                            value = ai.ollamaModel,
                            onValueChange = { v -> update { it.copy(ollamaModel = v) } },
                            hint = "llava",
                        )
                    }
                    Spacer(Modifier.size(8.dp))
                    LanSecondaryButton("刷新模型", enabled = !fetchingModels, onClick = {
                        if (ai.ollamaEndpoint.isBlank()) {
                            inlineError = "请先填写服务地址"
                        } else {
                            fetchingModels = true
                            inlineError = null
                            scope.launch {
                                val cfg = ai.toAiConfig(settings.language)
                                val result = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
                                    runCatching { uniffi.aurora_core.aiFetchModels(cfg) }
                                }
                                fetchingModels = false
                                result.fold(
                                    onSuccess = { models ->
                                        if (models.isEmpty()) inlineError = "服务未返回模型列表" else modelChoices = models
                                    },
                                    onFailure = { e -> inlineError = e.message ?: "获取模型列表失败" },
                                )
                            }
                        }
                    })
                }
            }
            else -> {
                SettingsLabel("服务地址")
                LanTextField(
                    value = ai.lmstudioEndpoint,
                    onValueChange = { v -> update { it.copy(lmstudioEndpoint = v) } },
                    hint = "http://127.0.0.1:1234",
                )
                SettingsLabel("模型")
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.weight(1f)) {
                        LanTextField(
                            value = ai.lmstudioModel,
                            onValueChange = { v -> update { it.copy(lmstudioModel = v) } },
                            hint = "先在 LM Studio 里加载模型",
                        )
                    }
                    Spacer(Modifier.size(8.dp))
                    LanSecondaryButton("刷新模型", enabled = !fetchingModels, onClick = {
                        if (ai.lmstudioEndpoint.isBlank()) {
                            inlineError = "请先填写服务地址"
                        } else {
                            fetchingModels = true
                            inlineError = null
                            scope.launch {
                                val cfg = ai.toAiConfig(settings.language)
                                val result = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
                                    runCatching { uniffi.aurora_core.aiFetchModels(cfg) }
                                }
                                fetchingModels = false
                                result.fold(
                                    onSuccess = { models ->
                                        if (models.isEmpty()) inlineError = "服务未返回模型列表" else modelChoices = models
                                    },
                                    onFailure = { e -> inlineError = e.message ?: "获取模型列表失败" },
                                )
                            }
                        }
                    })
                }
            }
        }

        Row(Modifier.padding(top = 12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            LanPrimaryButton(if (testing) "测试中…" else "测试连接", enabled = !testing, onClick = {
                if (currentEndpoint().isBlank()) {
                    inlineError = "请先填写服务地址"
                } else {
                    testing = true
                    inlineError = null
                    scope.launch {
                        val cfg = ai.toAiConfig(settings.language)
                        val result = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
                            runCatching { uniffi.aurora_core.aiCheckConnection(cfg) }
                        }
                        testing = false
                        result.fold(
                            onSuccess = { Toast.makeText(context, "连接成功", Toast.LENGTH_SHORT).show() },
                            onFailure = { e -> inlineError = e.message ?: "连接失败" },
                        )
                    }
                }
            })
        }
        if (inlineError != null) {
            Text(
                inlineError!!,
                fontSize = 12.sp,
                // Compose 色板未带 danger（AuroraColorScheme 无该角色）——用浅档 danger
                // 字面色，仅此一行内联错误文案使用（登记）
                color = Color(0xFFEF4444),
                modifier = Modifier.padding(top = 8.dp),
            )
        }

        SettingsLabel("任务开关")
        SettingsCard {
            SettingsRow("自动打标签", "分析时把 AI 产出的标签写入词表") {
                Switch(checked = ai.autoTag, onCheckedChange = { v -> update { it.copy(autoTag = v) } })
            }
            SettingsRow("自动生成描述", "分析时写入图片描述") {
                Switch(checked = ai.autoDescription, onCheckedChange = { v -> update { it.copy(autoDescription = v) } })
            }
            // 桌面语义：父开关关闭时人物描述增强不可用
            SettingsRow("人物描述增强", "描述提示词加入人物语境") {
                Switch(
                    checked = ai.enhancePersonDescription && ai.autoDescription,
                    enabled = ai.autoDescription,
                    onCheckedChange = { v -> update { it.copy(enhancePersonDescription = v) } },
                )
            }
            SettingsRow("OCR 识别", "提取图片中的文字") {
                Switch(checked = ai.enableOcr, onCheckedChange = { v -> update { it.copy(enableOcr = v) } })
            }
            SettingsRow("自动翻译", "翻译识别出的文字") {
                Switch(checked = ai.enableTranslation, onCheckedChange = { v -> update { it.copy(enableTranslation = v) } })
            }
        }

        SettingsLabel("系统提示词")
        Surface(
            modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
            shape = RoundedCornerShape(8.dp),
            color = colors.surface,
            border = BorderStroke(1.dp, colors.border),
        ) {
            BasicTextField(
                value = ai.systemPrompt,
                onValueChange = { v -> update { it.copy(systemPrompt = v) } },
                textStyle = TextStyle(fontSize = 14.sp, color = colors.textPrimary),
                cursorBrush = SolidColor(colors.primary),
                modifier = Modifier.fillMaxWidth().heightIn(min = 96.dp).padding(12.dp),
                decorationBox = { inner ->
                    Box {
                        if (ai.systemPrompt.isEmpty()) {
                            Text("自定义系统提示词（可选）", fontSize = 14.sp, color = colors.textSecondary)
                        }
                        inner()
                    }
                },
            )
        }

        Text(
            "翻译目标语言跟随「常规」面板的语言设置；任务进度可在通知栏取消。",
            fontSize = 12.sp,
            color = colors.textSecondary,
            modifier = Modifier.padding(top = 12.dp, bottom = 8.dp),
        )
    }

    // 模型选择（刷新成功后弹出；点击即写回当前 provider 的 model）
    modelChoices?.let { models ->
        AlertDialog(
            onDismissRequest = { modelChoices = null },
            title = { Text("选择模型") },
            text = {
                Column(Modifier.verticalScroll(rememberScrollState())) {
                    models.forEach { m ->
                        Text(
                            m,
                            fontSize = 14.sp,
                            color = colors.textPrimary,
                            modifier = Modifier
                                .fillMaxWidth()
                                .clickable {
                                    modelChoices = null
                                    when (ai.provider) {
                                        "ollama" -> update { it.copy(ollamaModel = m) }
                                        "lmstudio" -> update { it.copy(lmstudioModel = m) }
                                        else -> update { it.copy(openaiModel = m) }
                                    }
                                }
                                .padding(vertical = 12.dp),
                        )
                    }
                }
            },
            confirmButton = {
                TextButton(onClick = { modelChoices = null }) { Text("取消") }
            },
        )
    }
}

/** AI 服务商三选卡（选中蓝边+浅蓝底，对齐 SettingsIconOption 的选中语言）。 */
@Composable
private fun AiProviderOption(label: String, selected: Boolean, onClick: () -> Unit) {
    val colors = AuroraTheme.colors
    Surface(
        shape = RoundedCornerShape(8.dp),
        color = if (selected) colors.primary.copy(alpha = 0.08f) else colors.surface,
        border = BorderStroke(1.dp, if (selected) colors.primary else colors.border),
    ) {
        Box(
            Modifier
                .defaultMinSize(minHeight = 48.dp)
                .clickable(onClick = onClick)
                .padding(horizontal = 12.dp, vertical = 12.dp),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                label,
                fontSize = 13.sp,
                fontWeight = FontWeight.Medium,
                color = if (selected) colors.primary else colors.textPrimary,
            )
        }
    }
}

/**
 * 局域网共享面板（M6a 阶段 3，替换 M4c 的 LAN placeholder）。形制对齐 M4c 既有面板
 * （SettingsSection/SettingsCard/SettingsLabel + 48dp 触屏目标），内容五块：
 * 连接状态行（未连接/连接中/已连 server_name/重连中 + 错误行）、服务器地址 + 访问码
 * 手输 fallback、扫码连接（前台 UI 入口起 CaptureActivity——spike 实测广播入口会被
 * 三星 BAL 拦截）、最近服务器一键连 + 设备名、对等服务端开关（M6a 阶段 7：
 * 「允许桌面浏览本机」，[lanServer] 未 init 时该节退化为不渲染）。
 */
@Composable
private fun LanContent(
    lan: LanManager,
    lanServer: LanServerManager?,
    includeSectionHeaders: Boolean = true,
    onBrowseClick: () -> Unit = {},
) {
    val colors = AuroraTheme.colors
    val context = LocalContext.current
    val snap by lan.snapshot.collectAsState()

    // 表单预填：最近服务器第一条（一键重连的落点）；没有就空着
    var address by remember { mutableStateOf(lan.savedServers().firstOrNull()?.let { "${it.host}:${it.port}" } ?: "") }
    var accessCode by remember { mutableStateOf(lan.savedServers().firstOrNull()?.accessCode ?: "") }
    var deviceName by remember { mutableStateOf(lan.deviceName()) }
    var savedServers by remember { mutableStateOf(lan.savedServers()) }
    // 连接成功（可能来自扫码/一键连）后刷新最近服务器列表
    LaunchedEffect(snap.state) {
        if (snap.state == LanState.CONNECTED) savedServers = lan.savedServers()
    }

    // —— 扫码（zxing ScanContract；CAMERA 运行时权限先过一遍，CaptureActivity 自身也会请求）——
    val scanLauncher = rememberLauncherForActivityResult(ScanContract()) { result ->
        val raw = result.contents
        if (raw == null) {
            Toast.makeText(context, "已取消扫码", Toast.LENGTH_SHORT).show()
            return@rememberLauncherForActivityResult
        }
        val qr = LanQr.parse(raw)
        if (qr == null) {
            Toast.makeText(context, "二维码不是 Aurora 互联格式｜原文：$raw", Toast.LENGTH_LONG).show()
        } else {
            // 解析结果填入连接表单并自动连（桌面契约 code 可能为空 → 保留手输框里的）
            address = if (qr.port == LanQr.DEFAULT_LAN_PORT) qr.host else "${qr.host}:${qr.port}"
            if (qr.code != null) accessCode = qr.code
            Toast.makeText(context, "已识别 ${qr.host}:${qr.port}，正在连接…", Toast.LENGTH_SHORT).show()
            lan.connect(address, accessCode)
        }
    }
    val cameraPermissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        if (granted) scanLauncher.launch(scanOptions()) else Toast.makeText(
            context, "未获相机权限，无法扫码", Toast.LENGTH_SHORT,
        ).show()
    }
    fun startScan() {
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) ==
            PackageManager.PERMISSION_GRANTED
        ) {
            scanLauncher.launch(scanOptions())
        } else {
            cameraPermissionLauncher.launch(Manifest.permission.CAMERA)
        }
    }

    if (includeSectionHeaders) {
        SettingsSection("连接", icon = IconWifi)
    } else {
        Spacer(Modifier.size(4.dp))
    }
    SettingsCard {
        // 连接状态行
        SettingsRow(label = "连接状态", value = lanStatusText(snap)) {
            if (snap.state == LanState.DISCONNECTED) {
                SettingsAction("连接", enabled = address.isNotBlank() && accessCode.isNotBlank()) {
                    lan.connect(address, accessCode)
                }
            } else {
                SettingsAction("断开", enabled = snap.state != LanState.CONNECTING) {
                    lan.disconnect()
                }
            }
        }
        snap.error?.let { err ->
            Text(
                err,
                fontSize = 12.sp,
                color = Color(colors.palette.danger),
                modifier = Modifier.padding(bottom = 6.dp),
            )
        }
        // M6a 阶段 4：连接成功后的真导航入口（关设置面板 → LAN 文件夹总览）
        if (snap.state == LanState.CONNECTED) {
            SettingsRow(label = "浏览共享文件", value = "远端目录与图片") {
                SettingsAction("进入", enabled = true) { onBrowseClick() }
            }
        }
    }

    SettingsLabel("服务器地址", topPadding = 16)
    LanTextField(
        value = address,
        onValueChange = { address = it },
        hint = "ip 或 ip:port（如 192.168.31.87:8080）",
    )
    SettingsLabel("访问码")
    LanTextField(
        value = accessCode,
        onValueChange = { accessCode = it },
        hint = "桌面端共享页的 4 位访问码",
    )
    Row(
        Modifier
            .fillMaxWidth()
            .padding(top = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        LanSecondaryButton(label = "扫码连接", modifier = Modifier.weight(1f), onClick = ::startScan)
        LanPrimaryButton(
            label = "连接",
            enabled = address.isNotBlank() && accessCode.isNotBlank() &&
                snap.state != LanState.CONNECTING && snap.state != LanState.CONNECTED,
            modifier = Modifier.weight(1f),
            onClick = { lan.connect(address, accessCode) },
        )
        LanSecondaryButton(
            label = "断开",
            enabled = snap.state == LanState.CONNECTED || snap.state == LanState.RECONNECTING,
            modifier = Modifier.weight(1f),
            onClick = { lan.disconnect() },
        )
    }

    if (savedServers.isNotEmpty()) {
        SettingsSection("最近服务器", icon = IconRefreshCcw)
        SettingsCard {
            savedServers.forEachIndexed { index, server ->
                if (index > 0) {
                    Box(
                        Modifier
                            .fillMaxWidth()
                            .height(1.dp)
                            .background(colors.border),
                    )
                }
                LanSavedServerRow(
                    server = server,
                    onClick = {
                        address = "${server.host}:${server.port}"
                        server.accessCode?.let { accessCode = it }
                        lan.connect(address, accessCode)
                    },
                )
            }
        }
    }

    SettingsSection("设备", icon = IconGlobe)
    SettingsCard {
        Row(
            Modifier
                .fillMaxWidth()
                .defaultMinSize(minHeight = 52.dp)
                .padding(vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                "设备名",
                fontSize = 15.sp,
                color = colors.textPrimary,
                modifier = Modifier.padding(end = 12.dp),
            )
            LanTextField(
                value = deviceName,
                onValueChange = { deviceName = it },
                hint = "桌面端设备列表里显示的名字",
                modifier = Modifier.weight(1f),
                // 失焦且确实改了才落库（认证时随 verify 上报）
                onEditCommitted = { lan.setDeviceName(it) },
            )
        }
    }

    // —— M6a 阶段 7：对等服务端开关（lanServer 未 init 时退化为不渲染该节）——
    // 未 init 的兜底 Flow 只为让 collectAsState 有合法接收方，快照恒为默认值、不消费
    val serverSnap by (lanServer?.snapshot ?: remember { MutableStateFlow(LanServerSnapshot()) }).collectAsState()
    val scope = rememberCoroutineScope()
    if (lanServer != null) {
        // 开/关共用一条切换路径：开 = 起服务端（持久化 enabled=true），关 = 停（enabled=false）
        val toggleServer: (Boolean) -> Unit = { checked ->
            if (checked) {
                scope.launch {
                    // setEnabledOn 是 suspend（起 HTTP + 前台服务可能失败），走协程不阻塞组合
                    val ok = lanServer.setEnabledOn(autoEnable = true)
                    Toast.makeText(
                        context,
                        if (ok) "本机共享已开启" else "服务端启动失败（端口被占用？）",
                        Toast.LENGTH_SHORT,
                    ).show()
                }
            } else {
                lanServer.stop(persistOff = true)
                Toast.makeText(context, "已停止共享", Toast.LENGTH_SHORT).show()
            }
        }
        SettingsSection("允许桌面浏览本机", icon = IconMonitor)
        SettingsCard {
            // 开关行：行高 ≥48dp 触屏目标，整行可点（Switch 在行尾）
            Row(
                Modifier
                    .fillMaxWidth()
                    .defaultMinSize(minHeight = 48.dp)
                    .clickable { toggleServer(!serverSnap.enabled) },
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(Modifier.weight(1f)) {
                    Text("允许桌面浏览本机", fontSize = 15.sp, color = colors.textPrimary)
                    Text(
                        "桌面端可反向浏览本机图库",
                        fontSize = 12.sp,
                        color = colors.textSecondary,
                    )
                }
                Switch(
                    checked = serverSnap.enabled,
                    onCheckedChange = toggleServer,
                )
            }
            if (serverSnap.enabled) {
                // 展开详情：地址 / 访问码 / 已连设备 / 重新生成访问码（对齐 React 同名面板）
                Text(
                    if (serverSnap.ip != null) {
                        "已开启 · http://${serverSnap.ip}:${serverSnap.port}"
                    } else {
                        "已开启 · 获取本机 IP 失败"
                    },
                    fontSize = 12.sp,
                    color = colors.textSecondary,
                    modifier = Modifier.padding(top = 8.dp),
                )
                Text(
                    "访问码 ${serverSnap.accessCode}",
                    fontSize = 12.sp,
                    color = colors.textSecondary,
                    modifier = Modifier.padding(top = 4.dp),
                )
                Text(
                    "已连接设备：${serverSnap.deviceCount} 台",
                    fontSize = 12.sp,
                    color = colors.textSecondary,
                    modifier = Modifier.padding(top = 4.dp),
                )
                TextButton(
                    onClick = {
                        lanServer.regenerateAccessCode()
                        Toast.makeText(context, "已重新生成访问码", Toast.LENGTH_SHORT).show()
                    },
                    modifier = Modifier
                        .padding(top = 4.dp)
                        .heightIn(min = 48.dp),
                ) {
                    Text("重新生成访问码", fontSize = 13.sp, color = colors.primary)
                }
            } else {
                Text(
                    "开启后，同一局域网的桌面端可在连接时自动发现并浏览本机图库",
                    fontSize = 12.sp,
                    color = colors.textSecondary,
                    modifier = Modifier.padding(top = 6.dp, bottom = 6.dp),
                )
            }
        }
    }
}

private fun scanOptions(): ScanOptions = ScanOptions().apply {
    setDesiredBarcodeFormats(ScanOptions.QR_CODE)
    setPrompt("对准桌面端显示的二维码")
    setBeepEnabled(false)
}

/** 连接状态行文案（0.2 基准四态 + 已连接附 server_name）。 */
private fun lanStatusText(snap: com.aurora.gallery.kotlin.LanSnapshot): String = when (snap.state) {
    LanState.DISCONNECTED -> "未连接"
    LanState.CONNECTING -> "连接中…"
    LanState.CONNECTED -> "已连接 · ${snap.serverName ?: "${snap.host}:${snap.port}"}"
    LanState.RECONNECTING -> "重连中…（每 ${com.aurora.gallery.kotlin.LanTiming.RETRY_INTERVAL_SECS}s 重试）"
}

/** 常规类：常规（语言）+ 外观（主题）+ 默认布局设置三节，结构与文案对齐桌面 GeneralPanel。 */
@Composable
private fun GeneralContent(
    settings: AppSettings,
    includeSectionHeaders: Boolean = true,
    onLanguageChange: (String) -> Unit,
    onThemeChange: (String) -> Unit,
    onDefaultLayoutChange: (LayoutMode) -> Unit,
    onDefaultSortChange: (SortOption, SortDirection) -> Unit,
    onDefaultGroupByChange: (GroupBy) -> Unit,
) {
    if (includeSectionHeaders) {
        SettingsSection("常规")
    } else {
        Spacer(Modifier.size(4.dp))
    }
    SettingsLabel("语言")
    Row(Modifier.padding(top = 8.dp)) {
        SettingsIconOption(
            icon = IconGlobe,
            label = "中文",
            selected = settings.language == AppSettings.LANGUAGE_ZH,
            onClick = { onLanguageChange(AppSettings.LANGUAGE_ZH) },
        )
        Spacer(Modifier.size(12.dp))
        SettingsIconOption(
            icon = IconGlobe,
            label = "English",
            selected = settings.language == AppSettings.LANGUAGE_EN,
            onClick = { onLanguageChange(AppSettings.LANGUAGE_EN) },
        )
    }

    SettingsSection("外观", icon = IconPalette)
    SettingsLabel("主题")
    Row(
        Modifier
            .fillMaxWidth()
            .padding(top = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        ThemePreviewCard(
            label = "浅色",
            icon = IconSun,
            selected = settings.theme == AppSettings.THEME_LIGHT,
            preview = { Box(Modifier.fillMaxSize().background(Color.White)) },
            onClick = { onThemeChange(AppSettings.THEME_LIGHT) },
            modifier = Modifier.weight(1f),
        )
        ThemePreviewCard(
            label = "深色",
            icon = IconMoon,
            selected = settings.theme == AppSettings.THEME_DARK,
            preview = { Box(Modifier.fillMaxSize().background(Color(0xFF111827))) },
            onClick = { onThemeChange(AppSettings.THEME_DARK) },
            modifier = Modifier.weight(1f),
        )
        ThemePreviewCard(
            label = "跟随系统",
            icon = IconMonitor,
            selected = settings.theme == AppSettings.THEME_SYSTEM,
            preview = {
                Box(
                    Modifier
                        .fillMaxSize()
                        .background(
                            Brush.verticalGradient(listOf(Color(0xFFE5E7EB), Color(0xFF374151))),
                        ),
                )
            },
            onClick = { onThemeChange(AppSettings.THEME_SYSTEM) },
            modifier = Modifier.weight(1f),
        )
    }

    SettingsSection("默认布局设置", icon = IconLayoutGrid)
    SettingsLabel("默认视图模式")
    Row(
        Modifier
            .fillMaxWidth()
            .padding(top = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        SettingsIconCard(
            icon = IconGrid3,
            label = "网格",
            selected = settings.defaultLayout == LayoutMode.GRID,
            onClick = { onDefaultLayoutChange(LayoutMode.GRID) },
            modifier = Modifier.weight(1f),
        )
        SettingsIconCard(
            icon = IconLayoutGrid,
            label = "自适应",
            selected = settings.defaultLayout == LayoutMode.ADAPTIVE,
            onClick = { onDefaultLayoutChange(LayoutMode.ADAPTIVE) },
            modifier = Modifier.weight(1f),
        )
        SettingsIconCard(
            icon = IconLayoutTemplate,
            label = "瀑布流",
            selected = settings.defaultLayout == LayoutMode.MASONRY,
            onClick = { onDefaultLayoutChange(LayoutMode.MASONRY) },
            modifier = Modifier.weight(1f),
        )
    }

    // 排序方式 + 排序方向双列（对齐桌面 grid-cols-2；手机 411dp 宽下单列 ~180dp 仍放得下）
    Row(
        Modifier
            .fillMaxWidth()
            .padding(top = 16.dp),
        horizontalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Column(Modifier.weight(1f)) {
            SettingsLabel("默认排序方式")
            Column(Modifier.padding(top = 8.dp)) {
                SettingsOptionButton(
                    icon = IconType,
                    label = "按名称",
                    selected = settings.defaultSortBy == SortOption.NAME,
                    onClick = { onDefaultSortChange(SortOption.NAME, settings.defaultSortDirection) },
                )
                SettingsOptionButton(
                    icon = IconCalendarDays,
                    label = "按时间",
                    selected = settings.defaultSortBy == SortOption.DATE,
                    onClick = { onDefaultSortChange(SortOption.DATE, settings.defaultSortDirection) },
                )
                SettingsOptionButton(
                    icon = IconHardDrive,
                    label = "按大小",
                    selected = settings.defaultSortBy == SortOption.SIZE,
                    onClick = { onDefaultSortChange(SortOption.SIZE, settings.defaultSortDirection) },
                )
            }
        }
        Column(Modifier.weight(1f)) {
            SettingsLabel("默认排序方向")
            Column(Modifier.padding(top = 8.dp)) {
                SettingsOptionButton(
                    icon = IconArrowUp,
                    label = "升序",
                    selected = settings.defaultSortDirection == SortDirection.ASC,
                    onClick = { onDefaultSortChange(settings.defaultSortBy, SortDirection.ASC) },
                )
                SettingsOptionButton(
                    icon = IconArrowDown,
                    label = "降序",
                    selected = settings.defaultSortDirection == SortDirection.DESC,
                    onClick = { onDefaultSortChange(settings.defaultSortBy, SortDirection.DESC) },
                )
            }
        }
    }

    SettingsLabel("默认分组方式", topPadding = 16)
    Row(
        Modifier
            .fillMaxWidth()
            .padding(top = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        SettingsIconCard(
            icon = IconLayers,
            label = "不分组",
            selected = settings.defaultGroupBy == GroupBy.NONE,
            onClick = { onDefaultGroupByChange(GroupBy.NONE) },
            modifier = Modifier.weight(1f),
        )
        SettingsIconCard(
            icon = IconGrid3,
            label = "按类型",
            selected = settings.defaultGroupBy == GroupBy.TYPE,
            onClick = { onDefaultGroupByChange(GroupBy.TYPE) },
            modifier = Modifier.weight(1f),
        )
        SettingsIconCard(
            icon = IconCalendarDays,
            label = "按日期",
            selected = settings.defaultGroupBy == GroupBy.DATE,
            onClick = { onDefaultGroupByChange(GroupBy.DATE) },
            modifier = Modifier.weight(1f),
        )
    }
}

/** 存储类：缓存清理（M4b 能力换新形制）+ 主色调数据库占位（M6 颜色链路）+ 数据备份。 */
@Composable
private fun StorageContent(
    cacheSizeText: String,
    includeSectionHeaders: Boolean = true,
    onClearCache: () -> Unit,
    onExportBackup: () -> Unit,
    onImportBackup: () -> Unit,
) {
    if (includeSectionHeaders) {
        SettingsSection("存储")
    } else {
        Spacer(Modifier.size(4.dp))
    }
    SettingsCard {
        SettingsRow(label = "缓存（缩略图 + 查看器）", value = cacheSizeText) {
            SettingsAction("清理缓存", onClick = onClearCache)
        }
    }

    SettingsSection("主色调数据库", icon = IconDatabase)
    SettingsPlaceholderCard(
        icon = IconPalette,
        title = "主色调提取与数据库管理",
        description = "将随 M6b 提供：提取任务控制 / 统计与状态分布 / 错误文件管理",
    )

    SettingsSection("数据备份")
    SettingsCard {
        SettingsRow(label = "标签 / 人物 / 专题元数据") {
            SettingsAction("导出", onClick = onExportBackup)
            Spacer(Modifier.size(4.dp))
            SettingsAction("导入", onClick = onImportBackup)
        }
    }
}

/** M6 未落地类的占位页（对齐 M4b 1.5「未落地能力的可见占位」先例：可见、可解释、不误导）。 */
@Composable
private fun PlaceholderContent(
    sectionTitle: String,
    sectionIcon: ImageVector,
    includeSectionHeaders: Boolean = true,
    icon: ImageVector,
    title: String,
    description: String,
) {
    if (includeSectionHeaders) {
        SettingsSection(sectionTitle, icon = sectionIcon)
    }
    SettingsPlaceholderCard(icon = icon, title = title, description = description)
}

/** 关于类（对齐桌面 AboutPanel 版式）：软件信息大卡 + 技术栈版本三卡 + 相关链接 + 致谢。检查更新不做（D27）。 */
@Composable
private fun AboutContent(
    appVersion: String,
    includeSectionHeaders: Boolean = true,
    onOpenUrl: (String) -> Unit,
    /** M6b 阶段 2：AI 设置的即时保存口（面板逐项变更即提交，对齐 GeneralContent 惯例）。 */
    onAiSettingsChange: (AiSettings) -> Unit,
) {
    val colors = AuroraTheme.colors
    if (includeSectionHeaders) {
        SettingsSection("关于", icon = IconInfo)
    }
    // 软件信息卡：渐变底（桌面 from-blue-500/10 to-purple-500/10 rounded-2xl）
    Box(
        Modifier
            .fillMaxWidth()
            .padding(top = 12.dp)
            .background(
                Brush.linearGradient(
                    listOf(
                        colors.primary.copy(alpha = 0.10f),
                        colors.topicPink.copy(alpha = 0.10f),
                    ),
                ),
                RoundedCornerShape(16.dp),
            )
            .border(1.dp, colors.border, RoundedCornerShape(16.dp))
            .padding(20.dp),
    ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                // logo：极光渐变圆角块 + 白色首字母（桌面 AuroraLogo 的 Kotlin 近似）
                Box(
                    Modifier
                        .size(56.dp)
                        .clip(RoundedCornerShape(14.dp))
                        .background(
                            Brush.linearGradient(
                                listOf(
                                    colors.topicGradientStart,
                                    colors.topicGradientEnd,
                                    colors.topicPink,
                                ),
                            ),
                        ),
                    contentAlignment = Alignment.Center,
                ) {
                    Text("A", fontSize = 26.sp, fontWeight = FontWeight.Bold, color = Color.White)
                }
                Spacer(Modifier.size(16.dp))
                Column {
                    Text(
                        "Aurora Gallery",
                        fontSize = 20.sp,
                        fontWeight = FontWeight.Bold,
                        color = colors.textPrimary,
                    )
                    Text(
                        "现代化的图片管理与浏览工具",
                        fontSize = 12.sp,
                        color = colors.textSecondary,
                        modifier = Modifier.padding(top = 2.dp, bottom = 6.dp),
                    )
                    Row {
                        SettingsBadge("v$appVersion", bg = colors.primary.copy(alpha = 0.20f), fg = colors.primary)
                        Spacer(Modifier.size(8.dp))
                        SettingsBadge("稳定版", bg = Color(0x3366BB6A), fg = Color(0xFF66BB6A))
                    }
                }
            }
        }

    // 技术栈版本三卡（桌面 grid-cols-3：应用版本 / Tauri / React → Kotlin 对应）
    SettingsSubLabel("技术栈版本", icon = IconCode, topPadding = 20)
    Row(
        Modifier
            .fillMaxWidth()
            .padding(top = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        SettingsValueCard("应用版本", appVersion, Modifier.weight(1f))
        SettingsValueCard("Compose", "2024.09", Modifier.weight(1f))
        SettingsValueCard("内核", "Rust · UniFFI", Modifier.weight(1f))
    }

    // 相关链接两卡（桌面 grid-cols-2）
    SettingsSubLabel("相关链接", icon = IconExternalLink, topPadding = 20)
    Row(
        Modifier
            .fillMaxWidth()
            .padding(top = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        SettingsLinkCard(
            icon = IconCode,
            title = "GitHub",
            subtitle = "查看源代码",
            onClick = { onOpenUrl("https://github.com/misakimiku2/aurora-gallery-tauri") },
            modifier = Modifier.weight(1f),
        )
        SettingsLinkCard(
            icon = IconShield,
            title = "问题反馈",
            subtitle = "报告 Bug 或建议",
            onClick = { onOpenUrl("https://github.com/misakimiku2/aurora-gallery-tauri/issues") },
            modifier = Modifier.weight(1f),
        )
    }

    // 致谢页脚（桌面：居中 + 顶部 border-t）
    Row(
        Modifier
            .fillMaxWidth()
            .padding(top = 24.dp)
            .background(colors.border)
            .padding(top = 1.dp)
            .background(colors.content)
            .padding(top = 12.dp),
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text("Made with", fontSize = 12.sp, color = colors.textSecondary)
        Spacer(Modifier.size(3.dp))
        androidx.compose.material3.Icon(
            imageVector = IconHeartFill,
            contentDescription = null,
            tint = Color(0xFFEF4444),
            modifier = Modifier.size(12.dp),
        )
        Spacer(Modifier.size(3.dp))
        Text("by", fontSize = 12.sp, color = colors.textSecondary)
        Spacer(Modifier.size(3.dp))
        Text("MISAKIMIKU", fontSize = 12.sp, fontWeight = FontWeight.Medium, color = colors.textPrimary)
    }
}

// —— 平板：桌面式双栏对话框 ——

@Composable
private fun SettingsTabletDialog(
    settings: AppSettings,
    cacheSizeText: String,
    appVersion: String,
    lan: LanManager,
    lanServer: LanServerManager?,
    onLanBrowseClick: () -> Unit = {},
    onLanguageChange: (String) -> Unit,
    onThemeChange: (String) -> Unit,
    onDefaultLayoutChange: (LayoutMode) -> Unit,
    onDefaultSortChange: (SortOption, SortDirection) -> Unit,
    onDefaultGroupByChange: (GroupBy) -> Unit,
    onClearCache: () -> Unit,
    onExportBackup: () -> Unit,
    onImportBackup: () -> Unit,
    onOpenUrl: (String) -> Unit,
    /** M6b 阶段 2：AI 设置的即时保存口（面板逐项变更即提交，对齐 GeneralContent 惯例）。 */
    onAiSettingsChange: (AiSettings) -> Unit,
    onDismiss: () -> Unit,
) {
    var current by remember { mutableStateOf(SettingsCategory.GENERAL) }
    val colors = AuroraTheme.colors
    val config = LocalConfiguration.current
    // 对齐桌面 SettingsModal 比例：w-900 / h-100vh−200px / 左导航 w-64 → 这里宽 ≤720dp、
    // 高 = 屏高−120dp（上限扣系统栏，矮屏整体缩小、内部滚动，不设硬下限避免溢出屏外）。
    val dialogWidth = ((config.screenWidthDp - 64).coerceAtMost(720)).dp
    val dialogHeight = ((config.screenHeightDp - 120).coerceAtMost(config.screenHeightDp - 48)).dp

    androidx.compose.ui.window.Dialog(
        onDismissRequest = onDismiss,
        properties = androidx.compose.ui.window.DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Surface(
            modifier = Modifier
                .width(dialogWidth)
                .height(dialogHeight),
            shape = RoundedCornerShape(16.dp),
            color = colors.content,
            shadowElevation = 8.dp,
        ) {
            Row {
                // 左分类导航（桌面 bg-panel w-64）
                Column(
                    Modifier
                        .width(200.dp)
                        .fillMaxHeight()
                        .background(colors.panel),
                ) {
                    Row(
                        Modifier.padding(start = 16.dp, top = 20.dp, bottom = 12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        androidx.compose.material3.Icon(
                            imageVector = IconSliders,
                            contentDescription = null,
                            tint = colors.primary,
                            modifier = Modifier.size(20.dp),
                        )
                        Spacer(Modifier.size(8.dp))
                        Text("设置", fontSize = 18.sp, fontWeight = FontWeight.Bold, color = colors.textPrimary)
                    }
                    SettingsCategory.entries.forEach { category ->
                        val selected = category == current
                        Row(
                            Modifier
                                .padding(horizontal = 8.dp)
                                .fillMaxWidth()
                                .height(50.dp)
                                .clip(RoundedCornerShape(8.dp))
                                .background(if (selected) colors.primary.copy(alpha = 0.15f) else Color.Transparent)
                                .clickable { current = category }
                                .padding(start = 12.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            androidx.compose.material3.Icon(
                                imageVector = category.icon,
                                contentDescription = null,
                                tint = if (selected) colors.primary else colors.textSecondary,
                                modifier = Modifier.size(17.dp),
                            )
                            Spacer(Modifier.size(12.dp))
                            Text(
                                category.label,
                                fontSize = 14.sp,
                                fontWeight = if (selected) FontWeight.Bold else FontWeight.Normal,
                                color = if (selected) colors.primary else colors.textSecondary,
                            )
                        }
                    }
                    Spacer(Modifier.weight(1f))
                    // 底部「完成」（桌面 nav 底同位）
                    Box(
                        Modifier
                            .padding(12.dp)
                            .fillMaxWidth()
                            .height(44.dp)
                            .clip(RoundedCornerShape(8.dp))
                            .background(colors.surface)
                            .clickable(onClick = onDismiss),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text("完成", fontSize = 14.sp, color = colors.textPrimary)
                    }
                }
                // 右内容滚动区（桌面 flex-1 p-8 overflow-y-auto）
                Column(
                    Modifier
                        .weight(1f)
                        .verticalScroll(rememberScrollState())
                        .padding(horizontal = 24.dp, vertical = 20.dp),
                ) {
                    CategoryContent(
                        categories = listOf(current),
                        settings = settings,
                        cacheSizeText = cacheSizeText,
                        appVersion = appVersion,
                        lan = lan,
                        lanServer = lanServer,
                        onLanBrowseClick = onLanBrowseClick,
                        onLanguageChange = onLanguageChange,
                        onThemeChange = onThemeChange,
                        onDefaultLayoutChange = onDefaultLayoutChange,
                        onDefaultSortChange = onDefaultSortChange,
                        onDefaultGroupByChange = onDefaultGroupByChange,
                        onClearCache = onClearCache,
                        onExportBackup = onExportBackup,
                        onImportBackup = onImportBackup,
                        onOpenUrl = onOpenUrl,
                        onAiSettingsChange = onAiSettingsChange,
                    )
                }
            }
        }
    }
}

// —— 手机：两级全屏设置页（一级分类导航 / 二级分类内容，2026-09-23 验收人反馈：
//    全部内容堆一页太杂乱；平板双栏本身就是「导航 + 内容」二级结构，不动） ——

@Composable
private fun SettingsPhonePage(
    settings: AppSettings,
    cacheSizeText: String,
    appVersion: String,
    lan: LanManager,
    lanServer: LanServerManager?,
    onLanBrowseClick: () -> Unit = {},
    onLanguageChange: (String) -> Unit,
    onThemeChange: (String) -> Unit,
    onDefaultLayoutChange: (LayoutMode) -> Unit,
    onDefaultSortChange: (SortOption, SortDirection) -> Unit,
    onDefaultGroupByChange: (GroupBy) -> Unit,
    onClearCache: () -> Unit,
    onExportBackup: () -> Unit,
    onImportBackup: () -> Unit,
    onOpenUrl: (String) -> Unit,
    /** M6b 阶段 2：AI 设置的即时保存口（面板逐项变更即提交，对齐 GeneralContent 惯例）。 */
    onAiSettingsChange: (AiSettings) -> Unit,
    onDismiss: () -> Unit,
) {
    val colors = AuroraTheme.colors
    // null = 一级导航页；非 null = 二级分类内容页。back 逐级退（二级→一级→关设置）
    var current by remember { mutableStateOf<SettingsCategory?>(null) }
    // 本页只在 showSettings 时组合，且组合序在主返回链之后——back 先于主返回链消费
    BackHandler {
        if (current != null) current = null else onDismiss()
    }
    Surface(Modifier.fillMaxSize(), color = colors.content) {
        Column(
            Modifier
                .fillMaxSize()
                .systemBarsPadding(),
        ) {
            Row(
                Modifier
                    .fillMaxWidth()
                    .height(56.dp)
                    .padding(start = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box(
                    Modifier
                        .size(48.dp)
                        .clip(CircleShape)
                        .clickable {
                            if (current != null) current = null else onDismiss()
                        },
                    contentAlignment = Alignment.Center,
                ) {
                    BackArrowIcon(tint = colors.textPrimary)
                }
                Text(
                    current?.label ?: "设置",
                    fontSize = 18.sp,
                    fontWeight = FontWeight.Bold,
                    color = colors.textPrimary,
                )
            }
            val page = current
            if (page == null) {
                // 一级：分类导航（图标 + 标题 + 右箭头）。默认无底色，按压时才上灰（验收
                // 人反馈常驻灰底像全部选中；不用 ripple，底色变化与平板选中态同语言）
                Column(
                    Modifier
                        .weight(1f)
                        .verticalScroll(rememberScrollState())
                        .padding(horizontal = 16.dp)
                        .padding(top = 8.dp),
                ) {
                    SettingsCategory.entries.forEach { category ->
                        val navInteraction = remember { MutableInteractionSource() }
                        val pressed by navInteraction.collectIsPressedAsState()
                        Surface(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(bottom = 8.dp),
                            shape = RoundedCornerShape(12.dp),
                            color = if (pressed) colors.surface else Color.Transparent,
                        ) {
                            Row(
                                Modifier
                                    .fillMaxWidth()
                                    .clickable(
                                        interactionSource = navInteraction,
                                        indication = null,
                                    ) { current = category }
                                    .padding(horizontal = 14.dp, vertical = 14.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                androidx.compose.material3.Icon(
                                    imageVector = category.icon,
                                    contentDescription = null,
                                    tint = colors.primary,
                                    modifier = Modifier.size(20.dp),
                                )
                                Spacer(Modifier.size(14.dp))
                                Text(
                                    category.label,
                                    fontSize = 15.sp,
                                    fontWeight = FontWeight.Medium,
                                    color = colors.textPrimary,
                                    modifier = Modifier.weight(1f),
                                )
                                ChevronIcon(tint = colors.textSecondary)
                            }
                        }
                    }
                }
            } else {
                // 二级：该分类内容（平板与手机共用同一 CategoryContent；顶栏已是分类名，
                // 首个同名节标题不再渲染）
                Column(
                    Modifier
                        .weight(1f)
                        .verticalScroll(rememberScrollState())
                        .padding(horizontal = 16.dp)
                        .padding(bottom = 24.dp),
                ) {
                    CategoryContent(
                        categories = listOf(page),
                        settings = settings,
                        cacheSizeText = cacheSizeText,
                        appVersion = appVersion,
                        includeSectionHeaders = false,
                        lan = lan,
                        lanServer = lanServer,
                        onLanBrowseClick = onLanBrowseClick,
                        onLanguageChange = onLanguageChange,
                        onThemeChange = onThemeChange,
                        onDefaultLayoutChange = onDefaultLayoutChange,
                        onDefaultSortChange = onDefaultSortChange,
                        onDefaultGroupByChange = onDefaultGroupByChange,
                        onClearCache = onClearCache,
                        onExportBackup = onExportBackup,
                        onImportBackup = onImportBackup,
                        onOpenUrl = onOpenUrl,
                        onAiSettingsChange = onAiSettingsChange,
                    )
                }
            }
        }
    }
}

// —— 构建块（样式对齐桌面 token：panel/content/surface/subtle/primary 取自 AuroraTheme.colors）——

/**
 * 节标题：18sp 粗体 + 底部分隔线（对齐桌面 `text-lg font-bold border-subtle pb-2`）；
 * [icon] 非空时前置 20dp primary 色图标（外观/默认布局/关于节，对齐桌面 flex items-center）。
 */
@Composable
private fun SettingsSection(title: String, icon: ImageVector? = null) {
    Column(Modifier.padding(top = 20.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            if (icon != null) {
                androidx.compose.material3.Icon(
                    imageVector = icon,
                    contentDescription = null,
                    tint = AuroraTheme.colors.primary,
                    modifier = Modifier.size(18.dp),
                )
                Spacer(Modifier.size(8.dp))
            }
            Text(
                title,
                fontSize = 18.sp,
                fontWeight = FontWeight.Bold,
                color = AuroraTheme.colors.textPrimary,
            )
        }
        Box(
            Modifier
                .fillMaxWidth()
                .padding(top = 8.dp)
                .height(1.dp)
                .background(AuroraTheme.colors.border),
        )
    }
}

/** 节内字段标题（桌面 `text-sm font-bold text-gray-700`）。 */
@Composable
private fun SettingsLabel(text: String, topPadding: Int = 12) {
    Text(
        text,
        fontSize = 13.sp,
        fontWeight = FontWeight.Bold,
        color = AuroraTheme.colors.textPrimary,
        modifier = Modifier.padding(top = topPadding.dp),
    )
}

/** 小节标题（关于页二级，桌面 `text-sm font-semibold` + 16dp 图标）。 */
@Composable
private fun SettingsSubLabel(text: String, icon: ImageVector, topPadding: Int) {
    Row(
        Modifier.padding(top = topPadding.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        androidx.compose.material3.Icon(
            imageVector = icon,
            contentDescription = null,
            tint = AuroraTheme.colors.textSecondary,
            modifier = Modifier.size(14.dp),
        )
        Spacer(Modifier.size(6.dp))
        Text(
            text,
            fontSize = 13.sp,
            fontWeight = FontWeight.SemiBold,
            color = AuroraTheme.colors.textPrimary,
        )
    }
}

/** 卡片容器（对齐桌面 `bg-surface rounded-xl p-4`）。 */
@Composable
private fun SettingsCard(content: @Composable () -> Unit) {
    Surface(
        modifier = Modifier
            .fillMaxWidth()
            .padding(top = 12.dp),
        shape = RoundedCornerShape(12.dp),
        color = AuroraTheme.colors.surface,
    ) {
        Column(Modifier.padding(horizontal = 16.dp, vertical = 6.dp)) { content() }
    }
}

/** 设置行：左标签（+ 可选灰字值），右控件。行高 ≥48dp 触屏目标。 */
@Composable
private fun SettingsRow(
    label: String,
    value: String? = null,
    content: @Composable () -> Unit,
) {
    Row(
        Modifier
            .fillMaxWidth()
            .defaultMinSize(minHeight = 52.dp)
            .padding(vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(label, fontSize = 15.sp, color = AuroraTheme.colors.textPrimary)
            if (value != null) {
                Text(value, fontSize = 12.sp, color = AuroraTheme.colors.textSecondary)
            }
        }
        content()
    }
}

/**
 * 带图标横排按钮（对齐桌面语言/排序按钮：`rounded border`，选中蓝边 + blue-50 底 +
 * 蓝字）。选中时右侧带勾（排序按钮组桌面同款）。
 */
@Composable
private fun SettingsIconOption(
    icon: ImageVector,
    label: String,
    selected: Boolean,
    onClick: () -> Unit,
    showCheck: Boolean = false,
) {
    val colors = AuroraTheme.colors
    Surface(
        shape = RoundedCornerShape(8.dp),
        color = if (selected) colors.primary.copy(alpha = 0.08f) else Color.Transparent,
        border = androidx.compose.foundation.BorderStroke(
            1.dp,
            if (selected) colors.primary else colors.border,
        ),
    ) {
        Row(
            Modifier
                .clickable(onClick = onClick)
                .padding(horizontal = 12.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            androidx.compose.material3.Icon(
                imageVector = icon,
                contentDescription = null,
                tint = if (selected) colors.primary else colors.textSecondary,
                modifier = Modifier.size(15.dp),
            )
            Spacer(Modifier.size(8.dp))
            Text(
                label,
                fontSize = 13.sp,
                fontWeight = if (selected) FontWeight.Bold else FontWeight.Normal,
                color = if (selected) colors.primary else colors.textPrimary,
            )
            if (showCheck && selected) {
                Spacer(Modifier.size(10.dp))
                androidx.compose.material3.Icon(
                    imageVector = IconCheck,
                    contentDescription = null,
                    tint = colors.primary,
                    modifier = Modifier.size(13.dp),
                )
            }
        }
    }
}

/**
 * 竖排选项按钮（排序方式/方向，桌面 `w-full flex items-center px-3 py-2 rounded-lg border`）：
 * 选中蓝边 + primary 8% 底 + 蓝字 + 右侧勾。
 */
@Composable
private fun SettingsOptionButton(
    icon: ImageVector,
    label: String,
    selected: Boolean,
    onClick: () -> Unit,
) {
    val colors = AuroraTheme.colors
    Surface(
        modifier = Modifier
            .fillMaxWidth()
            .padding(bottom = 8.dp),
        shape = RoundedCornerShape(8.dp),
        color = if (selected) colors.primary.copy(alpha = 0.08f) else Color.Transparent,
        border = androidx.compose.foundation.BorderStroke(
            1.dp,
            if (selected) colors.primary else colors.border,
        ),
    ) {
        Row(
            Modifier
                .fillMaxWidth()
                .clickable(onClick = onClick)
                .padding(horizontal = 12.dp, vertical = 11.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            androidx.compose.material3.Icon(
                imageVector = icon,
                contentDescription = null,
                tint = if (selected) colors.primary else colors.textSecondary,
                modifier = Modifier.size(15.dp),
            )
            Spacer(Modifier.size(10.dp))
            Text(
                label,
                fontSize = 13.sp,
                fontWeight = if (selected) FontWeight.Bold else FontWeight.Normal,
                color = if (selected) colors.primary else colors.textPrimary,
                modifier = Modifier.weight(1f),
            )
            if (selected) {
                androidx.compose.material3.Icon(
                    imageVector = IconCheck,
                    contentDescription = null,
                    tint = colors.primary,
                    modifier = Modifier.size(13.dp),
                )
            }
        }
    }
}

/**
 * 图标卡（默认视图模式/分组方式，桌面 `flex flex-col items-center p-3 rounded-lg border-2`）：
 * 上图标下文字，选中 2dp 蓝边 + blue-50 底。
 */
@Composable
private fun SettingsIconCard(
    icon: ImageVector,
    label: String,
    selected: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = AuroraTheme.colors
    Surface(
        modifier = modifier,
        shape = RoundedCornerShape(10.dp),
        color = if (selected) colors.primary.copy(alpha = 0.08f) else Color.Transparent,
        border = androidx.compose.foundation.BorderStroke(
            if (selected) 2.dp else 1.dp,
            if (selected) colors.primary else colors.border,
        ),
    ) {
        Column(
            Modifier
                .fillMaxWidth()
                .clickable(onClick = onClick)
                .padding(horizontal = 8.dp, vertical = 12.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            androidx.compose.material3.Icon(
                imageVector = icon,
                contentDescription = null,
                tint = if (selected) colors.primary else colors.textSecondary,
                modifier = Modifier.size(22.dp),
            )
            Spacer(Modifier.size(6.dp))
            Text(
                label,
                fontSize = 12.sp,
                fontWeight = if (selected) FontWeight.Bold else FontWeight.Normal,
                color = if (selected) colors.primary else colors.textSecondary,
            )
        }
    }
}

/**
 * 主题预览卡（对齐桌面 GeneralPanel:164-187）：预览块（[preview] 插槽）+ 下方档位名，
 * 选中 2dp 蓝边 + 右上角蓝圆白勾角标。
 */
@Composable
private fun ThemePreviewCard(
    label: String,
    icon: ImageVector,
    selected: Boolean,
    preview: @Composable () -> Unit,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = AuroraTheme.colors
    Box(modifier = modifier) {
        Surface(
            modifier = Modifier.fillMaxWidth(),
            shape = RoundedCornerShape(10.dp),
            color = Color.Transparent,
            border = androidx.compose.foundation.BorderStroke(
                if (selected) 2.dp else 1.dp,
                if (selected) colors.primary else colors.border,
            ),
        ) {
            Column(
                Modifier
                    .fillMaxWidth()
                    .clickable(onClick = onClick)
                    .padding(6.dp),
            ) {
                Box(
                    Modifier
                        .fillMaxWidth()
                        .height(64.dp)
                        .clip(RoundedCornerShape(6.dp)),
                ) {
                    preview()
                    Box(contentAlignment = Alignment.Center, modifier = Modifier.matchParentSize()) {
                        androidx.compose.material3.Icon(
                            imageVector = icon,
                            contentDescription = null,
                            tint = colors.textSecondary,
                            modifier = Modifier.size(22.dp),
                        )
                    }
                }
                Text(
                    label,
                    fontSize = 12.sp,
                    fontWeight = if (selected) FontWeight.Bold else FontWeight.Medium,
                    color = if (selected) colors.primary else colors.textSecondary,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(top = 6.dp, bottom = 2.dp),
                    textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                )
            }
        }
        if (selected) {
            Box(
                Modifier
                    .align(Alignment.TopEnd)
                    .padding(6.dp)
                    .size(16.dp)
                    .clip(CircleShape)
                    .background(colors.primary),
                contentAlignment = Alignment.Center,
            ) {
                androidx.compose.material3.Icon(
                    imageVector = IconCheck,
                    contentDescription = null,
                    tint = Color.White,
                    modifier = Modifier.size(10.dp),
                )
            }
        }
    }
}

/** 徽标（版本/稳定版，桌面 `px-2.5 py-1 rounded-full text-xs`）。 */
@Composable
private fun SettingsBadge(text: String, bg: Color, fg: Color) {
    Surface(shape = CircleShape, color = bg) {
        Text(
            text,
            fontSize = 11.sp,
            fontWeight = FontWeight.Medium,
            color = fg,
            modifier = Modifier.padding(horizontal = 10.dp, vertical = 3.dp),
        )
    }
}

/** 值卡（技术栈版本三卡，桌面 `bg-surface rounded-xl p-4 border`）。 */
@Composable
private fun SettingsValueCard(label: String, value: String, modifier: Modifier = Modifier) {
    val colors = AuroraTheme.colors
    Surface(modifier = modifier, shape = RoundedCornerShape(12.dp), color = colors.surface) {
        Column(Modifier.padding(horizontal = 12.dp, vertical = 10.dp)) {
            Text(label, fontSize = 11.sp, color = colors.textSecondary)
            Text(
                value,
                fontSize = 14.sp,
                fontWeight = FontWeight.SemiBold,
                color = colors.textPrimary,
                modifier = Modifier.padding(top = 2.dp),
            )
        }
    }
}

/** 链接卡（相关链接，桌面 `flex items-center gap-3 p-4 bg-surface rounded-xl border`）。 */
@Composable
private fun SettingsLinkCard(
    icon: ImageVector,
    title: String,
    subtitle: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = AuroraTheme.colors
    Surface(
        modifier = modifier,
        shape = RoundedCornerShape(12.dp),
        color = colors.surface,
        border = androidx.compose.foundation.BorderStroke(1.dp, colors.border),
    ) {
        Row(
            Modifier
                .fillMaxWidth()
                .clickable(onClick = onClick)
                .padding(horizontal = 12.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            androidx.compose.material3.Icon(
                imageVector = icon,
                contentDescription = null,
                tint = colors.textSecondary,
                modifier = Modifier.size(18.dp),
            )
            Spacer(Modifier.size(10.dp))
            Column {
                Text(title, fontSize = 13.sp, fontWeight = FontWeight.Medium, color = colors.textPrimary)
                Text(subtitle, fontSize = 11.sp, color = colors.textSecondary)
            }
        }
    }
}

/** M6 占位卡（图标 + 标题 + 说明，虚线感交给颜色弱化；不响应点击）。 */
@Composable
private fun SettingsPlaceholderCard(
    icon: ImageVector,
    title: String,
    description: String,
) {
    val colors = AuroraTheme.colors
    Surface(
        modifier = Modifier
            .fillMaxWidth()
            .padding(top = 12.dp),
        shape = RoundedCornerShape(12.dp),
        color = colors.surface.copy(alpha = 0.5f),
        border = androidx.compose.foundation.BorderStroke(1.dp, colors.border),
    ) {
        Column(
            Modifier
                .fillMaxWidth()
                .padding(vertical = 20.dp, horizontal = 16.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            androidx.compose.material3.Icon(
                imageVector = icon,
                contentDescription = null,
                tint = colors.textSecondary.copy(alpha = 0.6f),
                modifier = Modifier.size(32.dp),
            )
            Text(
                title,
                fontSize = 14.sp,
                fontWeight = FontWeight.SemiBold,
                color = colors.textSecondary,
                modifier = Modifier.padding(top = 10.dp),
            )
            Text(
                description,
                fontSize = 12.sp,
                color = colors.textSecondary.copy(alpha = 0.8f),
                modifier = Modifier.padding(top = 4.dp),
                textAlign = androidx.compose.ui.text.style.TextAlign.Center,
            )
        }
    }
}

@Composable
private fun SettingsAction(label: String, enabled: Boolean = true, onClick: () -> Unit) {
    TextButton(enabled = enabled, onClick = onClick) {
        Text(
            label,
            fontSize = 13.sp,
            color = if (enabled) AuroraTheme.colors.primary else AuroraTheme.colors.textSecondary,
        )
    }
}

// —— LAN 面板专用构件（M6a 阶段 3；M4c 面板此前没有文本输入，这里按同一 token 体系补）——

/**
 * 单行文本框（Surface 48dp 触屏目标 + BasicTextField；token 取 AuroraTheme 同表）。
 * [onEditCommitted] 非空 = 失焦且内容有变时回调（设备名的落库时点）。
 */
@Composable
private fun LanTextField(
    value: String,
    onValueChange: (String) -> Unit,
    hint: String,
    modifier: Modifier = Modifier,
    onEditCommitted: ((String) -> Unit)? = null,
) {
    val colors = AuroraTheme.colors
    Surface(
        modifier = modifier
            .fillMaxWidth()
            .padding(top = 8.dp)
            .height(48.dp),
        shape = RoundedCornerShape(8.dp),
        color = colors.surface,
        border = BorderStroke(1.dp, colors.border),
    ) {
        BasicTextField(
            value = value,
            onValueChange = onValueChange,
            singleLine = true,
            textStyle = TextStyle(fontSize = 14.sp, color = colors.textPrimary),
            cursorBrush = SolidColor(colors.primary),
            modifier = Modifier
                .fillMaxWidth()
                .onFocusChanged { state ->
                    // 失焦且内容有变才提交（设备名落库时点；FocusState 无 isActive 这类
                    // 组合态可判，isFocused 足够——失焦即视为编辑结束）
                    if (!state.isFocused) onEditCommitted?.invoke(value)
                }
                .padding(horizontal = 12.dp)
                .wrapContentHeight(align = Alignment.CenterVertically),
            decorationBox = { inner ->
                Box(Modifier.wrapContentHeight(align = Alignment.CenterVertically)) {
                    if (value.isEmpty()) {
                        Text(hint, fontSize = 14.sp, color = colors.textSecondary, maxLines = 1)
                    }
                    inner()
                }
            },
        )
    }
}

/** 主按钮（连接）：primary 底白字，48dp 触屏目标。 */
@Composable
private fun LanPrimaryButton(
    label: String,
    enabled: Boolean = true,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = AuroraTheme.colors
    Surface(
        modifier = modifier.height(48.dp),
        shape = RoundedCornerShape(8.dp),
        color = if (enabled) colors.primary else colors.surface,
        enabled = enabled,
        onClick = onClick,
    ) {
        Box(contentAlignment = Alignment.Center, modifier = Modifier.fillMaxSize()) {
            Text(
                label,
                fontSize = 14.sp,
                fontWeight = FontWeight.Bold,
                color = if (enabled) Color.White else colors.textSecondary,
            )
        }
    }
}

/** 次按钮（扫码连接/断开）：surface 底 + border 描边，48dp 触屏目标。 */
@Composable
private fun LanSecondaryButton(
    label: String,
    enabled: Boolean = true,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = AuroraTheme.colors
    Surface(
        modifier = modifier.height(48.dp),
        shape = RoundedCornerShape(8.dp),
        color = colors.surface,
        border = BorderStroke(1.dp, if (enabled) colors.border else colors.border.copy(alpha = 0.5f)),
        enabled = enabled,
        onClick = onClick,
    ) {
        Box(contentAlignment = Alignment.Center, modifier = Modifier.fillMaxSize()) {
            Text(
                label,
                fontSize = 14.sp,
                color = if (enabled) colors.textPrimary else colors.textSecondary,
            )
        }
    }
}

/** 最近服务器行（host:port + 名称/访问码副行；整行 52dp 触屏目标，点击一键连）。 */
@Composable
private fun LanSavedServerRow(server: LanSavedServer, onClick: () -> Unit) {
    val colors = AuroraTheme.colors
    Row(
        Modifier
            .fillMaxWidth()
            .height(52.dp)
            .clickable(onClick = onClick),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            imageVector = IconWifi,
            contentDescription = null,
            tint = colors.primary,
            modifier = Modifier.size(15.dp),
        )
        Spacer(Modifier.size(10.dp))
        Column(Modifier.weight(1f)) {
            Text(
                "${server.host}:${server.port}",
                fontSize = 14.sp,
                color = colors.textPrimary,
                maxLines = 1,
            )
            Text(
                listOfNotNull(server.name, server.accessCode?.let { "码 $it" }).joinToString(" · "),
                fontSize = 11.sp,
                color = colors.textSecondary,
                maxLines = 1,
            )
        }
        Text("连接", fontSize = 13.sp, color = colors.primary)
    }
}

// —— 自绘小图标（触屏端无 material-icons 依赖，与 TopBar/TreeSidebar 同一套画法）——

/** 返回箭头（‹）。 */
@Composable
private fun BackArrowIcon(tint: Color) {
    Canvas(Modifier.size(22.dp)) {
        val s = size
        val w = s.width * 0.11f
        drawLine(
            tint,
            Offset(s.width * 0.62f, s.height * 0.18f),
            Offset(s.width * 0.32f, s.height * 0.5f),
            w,
            cap = StrokeCap.Round,
        )
        drawLine(
            tint,
            Offset(s.width * 0.32f, s.height * 0.5f),
            Offset(s.width * 0.62f, s.height * 0.82f),
            w,
            cap = StrokeCap.Round,
        )
    }
}

/** 右箭头（›），一级导航行尾用。 */
@Composable
private fun ChevronIcon(tint: Color) {
    Canvas(Modifier.size(16.dp)) {
        val s = size
        val w = s.width * 0.13f
        drawLine(
            tint,
            Offset(s.width * 0.35f, s.height * 0.2f),
            Offset(s.width * 0.68f, s.height * 0.5f),
            w,
            cap = StrokeCap.Round,
        )
        drawLine(
            tint,
            Offset(s.width * 0.68f, s.height * 0.5f),
            Offset(s.width * 0.35f, s.height * 0.8f),
            w,
            cap = StrokeCap.Round,
        )
    }
}
