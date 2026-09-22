package com.aurora.gallery.kotlin.ui.components

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.aurora.gallery.kotlin.state.AppSettings
import com.aurora.gallery.kotlin.state.SortDirection
import com.aurora.gallery.kotlin.state.SortOption
import com.aurora.gallery.kotlin.ui.theme.AuroraTheme

/**
 * 设置面板（M4b 2.1/2.2/2.3，D19 圈定的项目范围；形制对齐 React SettingsModal 的
 * 分区标题 + 行选项，承载用 AlertDialog）。
 *
 * 分区：
 *  - 通用：语言（标签 collation，M4a 顺延项 1）/默认布局/默认排序（持久化到
 *    SharedPreferences，2.1）；
 *  - 存储：缓存清理（网格缩略图目录 + 查看器 Coil 磁盘缓存）、备份导出/导入
 *    （词表 + 人物 + 专题元数据，字段对齐 React StoragePanel 的导出 JSON）。
 *
 * 不做（D19 登记）：主题暗色（Kotlin 恒浅色）、自启动/退出行为（桌面专属）、
 * folderIconStyle、animateOnSelect（无对应卡片动画）、调试日志（Kotlin 无对应开关面）。
 */
@Composable
fun SettingsDialog(
    settings: AppSettings,
    cacheSizeText: String,
    onLanguageChange: (String) -> Unit,
    onDefaultLayoutChange: (LayoutMode) -> Unit,
    onDefaultSortChange: (SortOption, SortDirection) -> Unit,
    onClearCache: () -> Unit,
    onExportBackup: () -> Unit,
    onImportBackup: () -> Unit,
    onDismiss: () -> Unit,
) {
    val colors = AuroraTheme.colors
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("设置") },
        text = {
            Column(
                Modifier
                    .heightIn(max = 520.dp)
                    .verticalScroll(rememberScrollState()),
            ) {
                SettingsSection("通用")
                SettingsRow(label = "语言") {
                    SettingsChoice(
                        options = listOf("中文" to AppSettings.LANGUAGE_ZH, "English" to AppSettings.LANGUAGE_EN),
                        current = settings.language,
                        onSelect = onLanguageChange,
                    )
                }
                SettingsRow(label = "默认布局") {
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

                SettingsSection("存储")
                SettingsRow(label = "缓存（缩略图 + 查看器）", value = cacheSizeText) {
                    SettingsAction("清理缓存", onClearCache)
                }
                SettingsRow(label = "数据备份（词表 / 人物 / 专题）") {
                    SettingsAction("导出", onExportBackup)
                    Spacer(Modifier.padding(horizontal = 4.dp))
                    SettingsAction("导入", onImportBackup)
                }
            }
        },
        confirmButton = {
            TextButton(onClick = onDismiss) { Text("关闭", color = colors.textPrimary) }
        },
    )
}

@Composable
private fun SettingsSection(title: String) {
    Text(
        text = title,
        fontSize = 14.sp,
        fontWeight = FontWeight.Bold,
        color = AuroraTheme.colors.textSecondary,
        modifier = Modifier.padding(top = 12.dp, bottom = 4.dp),
    )
}

@Composable
private fun SettingsRow(
    label: String,
    value: String? = null,
    content: @Composable () -> Unit,
) {
    Row(
        Modifier
            .fillMaxWidth()
            .defaultMinSize(minHeight = 48.dp)
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

@Composable
private fun <T> SettingsChoice(
    options: List<Pair<String, T>>,
    current: T,
    onSelect: (T) -> Unit,
) {
    val colors = AuroraTheme.colors
    Row {
        options.forEach { (label, value) ->
            val selected = value == current
            Text(
                text = label,
                fontSize = 13.sp,
                fontWeight = if (selected) FontWeight.Bold else FontWeight.Normal,
                color = if (selected) colors.primary else colors.textSecondary,
                modifier = Modifier
                    .defaultMinSize(minHeight = 40.dp)
                    .clip(RoundedCornerShape(8.dp))
                    .clickable { onSelect(value) }
                    .padding(horizontal = 10.dp, vertical = 8.dp),
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
