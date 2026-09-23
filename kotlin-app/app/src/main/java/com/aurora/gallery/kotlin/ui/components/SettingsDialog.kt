package com.aurora.gallery.kotlin.ui.components

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
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
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.aurora.gallery.kotlin.state.AppSettings
import com.aurora.gallery.kotlin.state.SortDirection
import com.aurora.gallery.kotlin.state.SortOption
import com.aurora.gallery.kotlin.ui.theme.AuroraTheme

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
 * 常规 / 存储 / AI 智能 / 局域网共享 / 关于。AI 与局域网共享随 M6（D16）落地，
 * 本次按「未落地能力的可见占位」先例渲染图标导航 + 占位说明页；存储类的主色调
 * 数据库管理同样占位（M6 颜色链路）。
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

private enum class SettingsCategory(
    val label: String,
    val icon: ImageVector,
    /** M6 未落地类：导航可见、内容为占位说明页（D16/D27）。 */
    val placeholder: Boolean = false,
) {
    GENERAL("常规", IconSliders),
    STORAGE("存储", IconDatabase),
    AI("AI 智能", IconBot, placeholder = true),
    LAN("局域网共享", IconWifi, placeholder = true),
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
    if (SettingsCategory.AI in categories) {
        PlaceholderContent(
            sectionTitle = "AI 智能",
            sectionIcon = IconBot,
            icon = IconBot,
            title = "AI 任务",
            description = "将随 M6 提供：自动打标签 / 描述生成 / 语义搜索与模型配置",
        )
    }
    if (SettingsCategory.LAN in categories) {
        PlaceholderContent(
            sectionTitle = "局域网共享",
            sectionIcon = IconWifi,
            icon = IconWifiOff,
            title = "桌面互联",
            description = "将随 M6 提供：局域网共享 / 扫码连接 / 文件互传",
        )
    }
    if (SettingsCategory.ABOUT in categories) {
        AboutContent(appVersion = appVersion, onOpenUrl = onOpenUrl)
    }
}

/** 常规类：常规（语言）+ 外观（主题）+ 默认布局设置三节，结构与文案对齐桌面 GeneralPanel。 */
@Composable
private fun GeneralContent(
    settings: AppSettings,
    onLanguageChange: (String) -> Unit,
    onThemeChange: (String) -> Unit,
    onDefaultLayoutChange: (LayoutMode) -> Unit,
    onDefaultSortChange: (SortOption, SortDirection) -> Unit,
    onDefaultGroupByChange: (GroupBy) -> Unit,
) {
    SettingsSection("常规")
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

    SettingsSection("主色调数据库", icon = IconDatabase)
    SettingsPlaceholderCard(
        icon = IconPalette,
        title = "主色调提取与数据库管理",
        description = "将随 M6 提供：提取任务控制 / 统计与状态分布 / 错误文件管理",
    )

    SettingsSection("数据备份")
    SettingsCard {
        SettingsRow(label = "标签 / 人物 / 专题元数据") {
            SettingsAction("导出", onExportBackup)
            Spacer(Modifier.size(4.dp))
            SettingsAction("导入", onImportBackup)
        }
    }
}

/** M6 未落地类的占位页（对齐 M4b 1.5「未落地能力的可见占位」先例：可见、可解释、不误导）。 */
@Composable
private fun PlaceholderContent(
    sectionTitle: String,
    sectionIcon: ImageVector,
    icon: ImageVector,
    title: String,
    description: String,
) {
    SettingsSection(sectionTitle, icon = sectionIcon)
    SettingsPlaceholderCard(icon = icon, title = title, description = description)
}

/** 关于类（对齐桌面 AboutPanel 版式）：软件信息大卡 + 技术栈版本三卡 + 相关链接 + 致谢。检查更新不做（D27）。 */
@Composable
private fun AboutContent(
    appVersion: String,
    onOpenUrl: (String) -> Unit,
) {
    val colors = AuroraTheme.colors
    SettingsSection("关于", icon = IconInfo)
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
private fun SettingsAction(label: String, onClick: () -> Unit) {
    TextButton(onClick = onClick) {
        Text(label, fontSize = 13.sp, color = AuroraTheme.colors.primary)
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
