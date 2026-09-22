package com.aurora.gallery.kotlin.ui.components

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.aurora.gallery.kotlin.state.AppSettings
import com.aurora.gallery.kotlin.state.SortDirection
import com.aurora.gallery.kotlin.state.SortOption
import com.aurora.gallery.kotlin.ui.theme.AuroraTheme

/**
 * 设置界面（M4c 重构：形制对齐桌面 SettingsModal，D21 双形态）。
 *
 * 形制按屏宽断点（沿用 FileGrid/FoldersOverview 的 `screenWidthDp >= 600` 惯例）：
 *  - 平板：桌面式双栏对话框——左分类导航（panel 底、选中 primary 15% 底）+ 右内容滚动区
 *    （content 底），nav 底部「完成」，整体 rounded 16dp、宽 ≤720dp、高 屏高−120dp；
 *  - 手机：独立全屏设置页——顶栏（返回 + 「设置」）+ 单列滚动，系统返回键关闭。
 *
 * 分类只渲染已实现的三类（对应桌面 7 类的筛选结论，D22）：通用（语言/主题 + 默认布局
 * 四项）、存储（缓存清理/备份导入导出）、关于（版本/链接/致谢）。AI、局域网共享随 M6
 * （D16）在导航加项。
 *
 * 项目范围（D22，修订 D19）：主题三档为 M4c 新增（点亮 AuroraPalette.dark，见 MainActivity
 * 的生效链）；「开机自启/退出行为/folderIconStyle/动画开关/调试日志」不做（桌面专属或无
 * 对应能力）；「主色调数据库管理」随 M6 颜色链路。
 */
@Composable
fun SettingsHost(
    settings: AppSettings,
    cacheSizeText: String,
    appVersion: String,
    onLanguageChange: (String) -> Unit,
    onThemeChange: (String) -> Unit,
    onDefaultLayoutChange: (LayoutMode) -> Unit,
    onDefaultSortChange: (SortOption, SortDirection) -> Unit,
    onDefaultGroupByChange: (GroupBy) -> Unit,
    onClearCache: () -> Unit,
    onExportBackup: () -> Unit,
    onImportBackup: () -> Unit,
    onOpenUrl: (String) -> Unit,
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
            onLanguageChange = onLanguageChange,
            onThemeChange = onThemeChange,
            onDefaultLayoutChange = onDefaultLayoutChange,
            onDefaultSortChange = onDefaultSortChange,
            onDefaultGroupByChange = onDefaultGroupByChange,
            onClearCache = onClearCache,
            onExportBackup = onExportBackup,
            onImportBackup = onImportBackup,
            onOpenUrl = onOpenUrl,
            onDismiss = onDismiss,
        )
    } else {
        SettingsPhonePage(
            settings = settings,
            cacheSizeText = cacheSizeText,
            appVersion = appVersion,
            onLanguageChange = onLanguageChange,
            onThemeChange = onThemeChange,
            onDefaultLayoutChange = onDefaultLayoutChange,
            onDefaultSortChange = onDefaultSortChange,
            onDefaultGroupByChange = onDefaultGroupByChange,
            onClearCache = onClearCache,
            onExportBackup = onExportBackup,
            onImportBackup = onImportBackup,
            onOpenUrl = onOpenUrl,
            onDismiss = onDismiss,
        )
    }
}

// —— 分类 ——

private enum class SettingsCategory(val label: String) {
    GENERAL("通用"),
    STORAGE("存储"),
    ABOUT("关于"),
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
    onLanguageChange: (String) -> Unit,
    onThemeChange: (String) -> Unit,
    onDefaultLayoutChange: (LayoutMode) -> Unit,
    onDefaultSortChange: (SortOption, SortDirection) -> Unit,
    onDefaultGroupByChange: (GroupBy) -> Unit,
    onClearCache: () -> Unit,
    onExportBackup: () -> Unit,
    onImportBackup: () -> Unit,
    onOpenUrl: (String) -> Unit,
) {
    if (SettingsCategory.GENERAL in categories) {
        GeneralContent(
            settings = settings,
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
            onClearCache = onClearCache,
            onExportBackup = onExportBackup,
            onImportBackup = onImportBackup,
        )
    }
    if (SettingsCategory.ABOUT in categories) {
        AboutContent(appVersion = appVersion, onOpenUrl = onOpenUrl)
    }
}

/** 通用类：通用（语言/主题）+ 默认布局（视图/排序/方向/分组）两节，结构对齐桌面 GeneralPanel。 */
@Composable
private fun GeneralContent(
    settings: AppSettings,
    onLanguageChange: (String) -> Unit,
    onThemeChange: (String) -> Unit,
    onDefaultLayoutChange: (LayoutMode) -> Unit,
    onDefaultSortChange: (SortOption, SortDirection) -> Unit,
    onDefaultGroupByChange: (GroupBy) -> Unit,
) {
    SettingsSection("通用")
    SettingsCard {
        SettingsRow(label = "语言") {
            SettingsChoice(
                options = listOf("中文" to AppSettings.LANGUAGE_ZH, "English" to AppSettings.LANGUAGE_EN),
                current = settings.language,
                onSelect = onLanguageChange,
            )
        }
        SettingsRow(label = "主题") {
            SettingsChoice(
                options = listOf(
                    "浅色" to AppSettings.THEME_LIGHT,
                    "深色" to AppSettings.THEME_DARK,
                    "跟随系统" to AppSettings.THEME_SYSTEM,
                ),
                current = settings.theme,
                onSelect = onThemeChange,
            )
        }
    }

    SettingsSection("默认布局")
    SettingsCard {
        SettingsRow(label = "默认视图") {
            SettingsChoice(
                options = listOf("网格" to LayoutMode.GRID, "自适应" to LayoutMode.ADAPTIVE, "瀑布流" to LayoutMode.MASONRY),
                current = settings.defaultLayout,
                onSelect = onDefaultLayoutChange,
            )
        }
        SettingsRow(label = "默认排序") {
            SettingsChoice(
                options = listOf("按名称" to SortOption.NAME, "按时间" to SortOption.DATE, "按大小" to SortOption.SIZE),
                current = settings.defaultSortBy,
                onSelect = { onDefaultSortChange(it, settings.defaultSortDirection) },
            )
        }
        SettingsRow(label = "排序方向") {
            SettingsChoice(
                options = listOf("降序" to SortDirection.DESC, "升序" to SortDirection.ASC),
                current = settings.defaultSortDirection,
                onSelect = { onDefaultSortChange(settings.defaultSortBy, it) },
            )
        }
        SettingsRow(label = "默认分组") {
            SettingsChoice(
                options = listOf("无" to GroupBy.NONE, "类型" to GroupBy.TYPE, "日期" to GroupBy.DATE),
                current = settings.defaultGroupBy,
                onSelect = onDefaultGroupByChange,
            )
        }
    }
}

/** 存储类：缓存清理 + 数据备份，能力沿用 M4b 实现（字段对齐 React 导出格式）。 */
@Composable
private fun StorageContent(
    cacheSizeText: String,
    onClearCache: () -> Unit,
    onExportBackup: () -> Unit,
    onImportBackup: () -> Unit,
) {
    SettingsSection("存储")
    SettingsCard {
        SettingsRow(label = "缓存（缩略图 + 查看器）", value = cacheSizeText) {
            SettingsAction("清理缓存", onClearCache)
        }
    }

    SettingsSection("数据备份")
    SettingsCard {
        SettingsRow(label = "标签 / 人物 / 专题元数据") {
            SettingsAction("导出", onExportBackup)
            Spacer(Modifier.size(4.dp))
            SettingsAction("导入", onImportBackup)
        }
    }
}

/** 关于类（M4c 新增，对齐桌面 AboutPanel 的可移植子集）：版本 + 链接 + 致谢。检查更新不做（APK 侧载无更新渠道，D22）。 */
@Composable
private fun AboutContent(
    appVersion: String,
    onOpenUrl: (String) -> Unit,
) {
    SettingsSection("关于")
    SettingsCard {
        Row(
            Modifier
                .fillMaxWidth()
                .defaultMinSize(minHeight = 52.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f)) {
                Text("Aurora 图库", fontSize = 16.sp, fontWeight = FontWeight.Bold, color = AuroraTheme.colors.textPrimary)
                Text("Kotlin 原生版", fontSize = 12.sp, color = AuroraTheme.colors.textSecondary)
            }
            Surface(shape = RoundedCornerShape(8.dp), color = AuroraTheme.colors.primary.copy(alpha = 0.15f)) {
                Text(
                    "v$appVersion",
                    fontSize = 12.sp,
                    fontWeight = FontWeight.Bold,
                    color = AuroraTheme.colors.primary,
                    modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
                )
            }
        }
        SettingsLinkRow(label = "GitHub 仓库", value = "misakimiku2/aurora-gallery-tauri") {
            onOpenUrl("https://github.com/misakimiku2/aurora-gallery-tauri")
        }
        SettingsLinkRow(label = "问题反馈", value = "Issues") {
            onOpenUrl("https://github.com/misakimiku2/aurora-gallery-tauri/issues")
        }
    }
    Text(
        "Made with ❤ by MISAKIMIKU",
        fontSize = 12.sp,
        color = AuroraTheme.colors.textSecondary,
        modifier = Modifier
            .fillMaxWidth()
            .padding(top = 16.dp),
        textAlign = androidx.compose.ui.text.style.TextAlign.Center,
    )
}

// —— 平板：桌面式双栏对话框 ——

@Composable
private fun SettingsTabletDialog(
    settings: AppSettings,
    cacheSizeText: String,
    appVersion: String,
    onLanguageChange: (String) -> Unit,
    onThemeChange: (String) -> Unit,
    onDefaultLayoutChange: (LayoutMode) -> Unit,
    onDefaultSortChange: (SortOption, SortDirection) -> Unit,
    onDefaultGroupByChange: (GroupBy) -> Unit,
    onClearCache: () -> Unit,
    onExportBackup: () -> Unit,
    onImportBackup: () -> Unit,
    onOpenUrl: (String) -> Unit,
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
                        SlidersIcon(tint = colors.primary)
                        Spacer(Modifier.size(8.dp))
                        Text("设置", fontSize = 18.sp, fontWeight = FontWeight.Bold, color = colors.textPrimary)
                    }
                    SettingsCategory.entries.forEach { category ->
                        val selected = category == current
                        Row(
                            Modifier
                                .padding(horizontal = 8.dp)
                                .fillMaxWidth()
                                .height(52.dp)
                                .clip(RoundedCornerShape(8.dp))
                                .background(if (selected) colors.primary.copy(alpha = 0.15f) else Color.Transparent)
                                .clickable { current = category }
                                .padding(start = 12.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
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
                        onLanguageChange = onLanguageChange,
                        onThemeChange = onThemeChange,
                        onDefaultLayoutChange = onDefaultLayoutChange,
                        onDefaultSortChange = onDefaultSortChange,
                        onDefaultGroupByChange = onDefaultGroupByChange,
                        onClearCache = onClearCache,
                        onExportBackup = onExportBackup,
                        onImportBackup = onImportBackup,
                        onOpenUrl = onOpenUrl,
                    )
                }
            }
        }
    }
}

// —— 手机：全屏设置页 ——

@Composable
private fun SettingsPhonePage(
    settings: AppSettings,
    cacheSizeText: String,
    appVersion: String,
    onLanguageChange: (String) -> Unit,
    onThemeChange: (String) -> Unit,
    onDefaultLayoutChange: (LayoutMode) -> Unit,
    onDefaultSortChange: (SortOption, SortDirection) -> Unit,
    onDefaultGroupByChange: (GroupBy) -> Unit,
    onClearCache: () -> Unit,
    onExportBackup: () -> Unit,
    onImportBackup: () -> Unit,
    onOpenUrl: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    val colors = AuroraTheme.colors
    // 本页只在 showSettings 时组合，且组合序在主返回链之后——back 先关设置页
    BackHandler(onBack = onDismiss)
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
                        .clickable(onClick = onDismiss),
                    contentAlignment = Alignment.Center,
                ) {
                    BackArrowIcon(tint = colors.textPrimary)
                }
                Text("设置", fontSize = 18.sp, fontWeight = FontWeight.Bold, color = colors.textPrimary)
            }
            Column(
                Modifier
                    .weight(1f)
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = 16.dp)
                    .padding(bottom = 24.dp),
            ) {
                CategoryContent(
                    categories = SettingsCategory.entries.toList(),
                    settings = settings,
                    cacheSizeText = cacheSizeText,
                    appVersion = appVersion,
                    onLanguageChange = onLanguageChange,
                    onThemeChange = onThemeChange,
                    onDefaultLayoutChange = onDefaultLayoutChange,
                    onDefaultSortChange = onDefaultSortChange,
                    onDefaultGroupByChange = onDefaultGroupByChange,
                    onClearCache = onClearCache,
                    onExportBackup = onExportBackup,
                    onImportBackup = onImportBackup,
                    onOpenUrl = onOpenUrl,
                )
            }
        }
    }
}

// —— 构建块（样式对齐桌面 token：面板 panel / 内容 content / 卡片 surface / 强调 primary）——

/** 节标题：18sp 粗体 + 底部分隔线（对齐桌面 `text-lg font-bold border-subtle pb-2`）。 */
@Composable
private fun SettingsSection(title: String) {
    Column(Modifier.padding(top = 20.dp)) {
        Text(
            title,
            fontSize = 18.sp,
            fontWeight = FontWeight.Bold,
            color = AuroraTheme.colors.textPrimary,
            modifier = Modifier.padding(bottom = 8.dp),
        )
        Box(
            Modifier
                .fillMaxWidth()
                .height(1.dp)
                .background(AuroraTheme.colors.border),
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

/** 链接行（关于页）：整行可点，右侧箭头。 */
@Composable
private fun SettingsLinkRow(label: String, value: String, onClick: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .defaultMinSize(minHeight = 48.dp)
            .clip(RoundedCornerShape(8.dp))
            .clickable(onClick = onClick),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, fontSize = 15.sp, color = AuroraTheme.colors.textPrimary, modifier = Modifier.weight(1f))
        Text(value, fontSize = 12.sp, color = AuroraTheme.colors.textSecondary)
        Spacer(Modifier.size(4.dp))
        ChevronIcon(tint = AuroraTheme.colors.textSecondary)
    }
}

/** 选项芯片：选中 primary 15% 底 + primary 粗体（对齐桌面 `bg-blue-500/15 text-blue-600`）。 */
@Composable
private fun <T> SettingsChoice(
    options: List<Pair<String, T>>,
    current: T,
    onSelect: (T) -> Unit,
) {
    val colors = AuroraTheme.colors
    Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        options.forEach { (label, value) ->
            val selected = value == current
            Box(
                Modifier
                    .heightIn(min = 40.dp)
                    .clip(RoundedCornerShape(8.dp))
                    .background(if (selected) colors.primary.copy(alpha = 0.15f) else Color.Transparent)
                    .clickable { onSelect(value) }
                    .padding(horizontal = 10.dp, vertical = 8.dp),
                contentAlignment = Alignment.CenterStart,
            ) {
                Text(
                    label,
                    fontSize = 13.sp,
                    fontWeight = if (selected) FontWeight.Bold else FontWeight.Normal,
                    color = if (selected) colors.primary else colors.textSecondary,
                )
            }
        }
    }
}

@Composable
private fun SettingsAction(label: String, onClick: () -> Unit) {
    TextButton(onClick = onClick) {
        Text(label, fontSize = 13.sp, color = AuroraTheme.colors.primary)
    }
}

// —— 自绘小图标（触屏端无 material-icons 依赖，与 TreeSidebar 同一套画法）——
// 三个图标都是简单线段/圆点：画布 22~24dp 内按比例取点，圆头笔画对齐桌面 lucide 线性风格。

/** 滑杆图标（设置标题，对齐侧栏「设置」Section 的 sliders 图形）。 */
@Composable
private fun SlidersIcon(tint: Color) {
    Canvas(Modifier.size(18.dp)) {
        val s = size
        val w = s.width * 0.11f
        drawLine(tint, Offset(0f, s.height * 0.32f), Offset(s.width, s.height * 0.32f), w, cap = StrokeCap.Round)
        drawLine(tint, Offset(0f, s.height * 0.68f), Offset(s.width, s.height * 0.68f), w, cap = StrokeCap.Round)
        drawCircle(tint, radius = s.width * 0.17f, center = Offset(s.width * 0.62f, s.height * 0.32f))
        drawCircle(tint, radius = s.width * 0.17f, center = Offset(s.width * 0.38f, s.height * 0.68f))
    }
}

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

/** 右箭头（›），链接行用。 */
@Composable
private fun ChevronIcon(tint: Color) {
    Canvas(Modifier.size(14.dp)) {
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
