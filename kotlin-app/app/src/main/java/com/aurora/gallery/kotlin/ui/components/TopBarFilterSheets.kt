package com.aurora.gallery.kotlin.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.aurora.gallery.kotlin.state.DateFilter
import com.aurora.gallery.kotlin.state.DateFilterMode
import com.aurora.gallery.kotlin.ui.theme.AuroraTheme
import uniffi.aurora_core.TagGroup
import java.util.Calendar

/**
 * 日期筛选底部弹层：自绘月历（对齐 React `CalendarWidget` 的安卓 bottom-sheet 形态）。
 *
 * 点击语义逐条对齐 `handleDateClick`：
 *  - 尚无 start 或已有完整区间 → 本次点击设为 start，清空 end；
 *  - 已有 start 无 end → 早于 start 则与新点互换，否则设为 end；
 *  - 选中变更立即上报（React `onUpdate` 即时生效，无需确认）。
 * 每天的 epoch 取**当地 12:00**（React 同款手法，避免时区滚日导致的比较错位）。
 */
@Composable
internal fun DateFilterSheet(
    filter: DateFilter,
    onFilterChange: (DateFilter) -> Unit,
    onDone: () -> Unit,
) {
    val colors = AuroraTheme.colors

    var viewYear by remember {
        mutableIntStateOf(
            if (filter.start != null) epochToYear(filter.start)
            else Calendar.getInstance().get(Calendar.YEAR),
        )
    }
    var viewMonth by remember {
        mutableIntStateOf(
            if (filter.start != null) epochToMonth(filter.start)
            else Calendar.getInstance().get(Calendar.MONTH),
        )
    }

    Column(
        Modifier
            .fillMaxWidth()
            .verticalScroll(rememberScrollState())
            .navigationBarsPadding()
            .padding(horizontal = 20.dp)
            .padding(bottom = 12.dp),
    ) {
        Row(
            Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                "${viewYear}年${viewMonth + 1}月",
                fontWeight = FontWeight.Bold,
                fontSize = 16.sp,
                color = colors.textPrimary,
            )
            Spacer(Modifier.weight(1f))
            Box(
                Modifier
                    .size(36.dp)
                    .clip(RoundedCornerShape(18.dp))
                    .clickable {
                        if (viewMonth == 0) { viewMonth = 11; viewYear -= 1 } else viewMonth -= 1
                    },
                contentAlignment = Alignment.Center,
            ) {
                Text("‹", fontSize = 20.sp, color = colors.textSecondary)
            }
            Box(
                Modifier
                    .size(36.dp)
                    .clip(RoundedCornerShape(18.dp))
                    .clickable {
                        if (viewMonth == 11) { viewMonth = 0; viewYear += 1 } else viewMonth += 1
                    },
                contentAlignment = Alignment.Center,
            ) {
                Text("›", fontSize = 20.sp, color = colors.textSecondary)
            }
        }
        Spacer(Modifier.height(12.dp))
        Row(Modifier.fillMaxWidth()) {
            listOf("日", "一", "二", "三", "四", "五", "六").forEach { d ->
                Text(
                    d,
                    modifier = Modifier.weight(1f),
                    textAlign = TextAlign.Center,
                    fontSize = 11.sp,
                    fontWeight = FontWeight.Bold,
                    color = colors.textSecondary,
                )
            }
        }
        Spacer(Modifier.height(4.dp))
        val cells = remember(viewYear, viewMonth) { buildMonthCells(viewYear, viewMonth) }
        // 区间带（对齐 React CalendarWidget）：in-range 格子画**整格宽的方形背景**，
        // 相邻格子无缝相接；首/尾日在圆点下画半格连接带（50% 硬停渐变，React 的
        // from-50% to-blue-100 同款）——此前把带圆角的背景画在每个格子自己的 Box 里，
        // 接缝处有圆角缺口、首尾没有连接，选区看起来断成数截（2026-09-17 用户报障）。
        val bandColor = colors.primary.copy(alpha = 0.12f)
        for (row in 0 until 6) {
            Row(Modifier.fillMaxWidth()) {
                cells.drop(row * 7).take(7).forEach { cell ->
                    val selected = cell.epoch == filter.start || cell.epoch == filter.end
                    val inRange = filter.start != null && filter.end != null &&
                        cell.epoch > filter.start && cell.epoch < filter.end
                    // 起止点与整段区间重合（start==end，同一天点两次）时不画连接带
                    val isRangeStart = filter.start != null && filter.end != null &&
                        cell.epoch == filter.start && filter.start != filter.end
                    val isRangeEnd = filter.start != null && filter.end != null &&
                        cell.epoch == filter.end && filter.start != filter.end
                    val bandModifier = when {
                        inRange -> Modifier.background(bandColor)
                        isRangeStart -> Modifier.background(
                            Brush.horizontalGradient(0.5f to Color.Transparent, 0.5f to bandColor),
                        )
                        isRangeEnd -> Modifier.background(
                            Brush.horizontalGradient(0.5f to bandColor, 0.5f to Color.Transparent),
                        )
                        else -> Modifier
                    }
                    Box(
                        Modifier
                            .weight(1f)
                            .height(40.dp)
                            .padding(vertical = 2.dp)
                            .then(bandModifier)
                            .clickable {
                                onFilterChange(
                                    if (filter.start == null || filter.end != null) {
                                        // 开新区间（对齐 handleDateClick 第一分支）
                                        filter.copy(start = cell.epoch, end = null)
                                    } else if (cell.epoch < filter.start) {
                                        // 早于 start：与新点互换
                                        filter.copy(start = cell.epoch, end = filter.start)
                                    } else {
                                        filter.copy(end = cell.epoch)
                                    },
                                )
                                if (cell.monthOffset != 0) {
                                    var m = viewMonth + cell.monthOffset
                                    var y = viewYear
                                    if (m < 0) { m = 11; y -= 1 }
                                    if (m > 11) { m = 0; y += 1 }
                                    viewMonth = m
                                    viewYear = y
                                }
                            },
                        contentAlignment = Alignment.Center,
                    ) {
                        Box(
                            Modifier
                                .size(32.dp)
                                .clip(CircleShape)
                                .background(if (selected) colors.primary else Color.Transparent),
                            contentAlignment = Alignment.Center,
                        ) {
                            Text(
                                cell.day.toString(),
                                fontSize = 12.sp,
                                fontWeight = FontWeight.Medium,
                                color = when {
                                    selected -> Color.White
                                    cell.monthOffset != 0 -> colors.textSecondary.copy(alpha = 0.45f)
                                    else -> colors.textPrimary
                                },
                            )
                        }
                    }
                }
            }
        }
        Spacer(Modifier.height(12.dp))
        Text("按以下日期筛选", fontSize = 11.sp, fontWeight = FontWeight.Bold, color = colors.textSecondary)
        Spacer(Modifier.height(8.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            DateModeChip(
                text = "创建时间",
                selected = filter.mode == DateFilterMode.CREATED,
                onClick = { onFilterChange(filter.copy(mode = DateFilterMode.CREATED)) },
                modifier = Modifier.weight(1f),
            )
            DateModeChip(
                text = "修改时间",
                selected = filter.mode == DateFilterMode.UPDATED,
                onClick = { onFilterChange(filter.copy(mode = DateFilterMode.UPDATED)) },
                modifier = Modifier.weight(1f),
            )
        }
        Spacer(Modifier.height(12.dp))
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Box(
                Modifier
                    .weight(1f)
                    .height(40.dp)
                    .clip(RoundedCornerShape(10.dp))
                    .border(1.dp, colors.subtle, RoundedCornerShape(10.dp))
                    .clickable { onFilterChange(DateFilter()) },
                contentAlignment = Alignment.Center,
            ) {
                Text("清除筛选", fontSize = 14.sp, color = colors.textSecondary)
            }
            Box(
                Modifier
                    .weight(1f)
                    .height(40.dp)
                    .clip(RoundedCornerShape(10.dp))
                    .background(colors.primary)
                    .clickable(onClick = onDone),
                contentAlignment = Alignment.Center,
            ) {
                Text("完成", fontSize = 14.sp, fontWeight = FontWeight.Medium, color = Color.White)
            }
        }
    }
}

@Composable
private fun DateModeChip(text: String, selected: Boolean, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val colors = AuroraTheme.colors
    Box(
        modifier
            .clip(RoundedCornerShape(8.dp))
            .background(if (selected) colors.primary.copy(alpha = 0.12f) else Color.Transparent)
            .border(1.dp, if (selected) colors.primary else colors.subtle, RoundedCornerShape(8.dp))
            .clickable(onClick = onClick)
            .padding(vertical = 8.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text,
            fontSize = 13.sp,
            fontWeight = FontWeight.Medium,
            color = if (selected) colors.primary else colors.textSecondary,
        )
    }
}

/**
 * 标签筛选底部弹层（React `TagsWidget` 的 bottom-sheet 形态）：标题 + 总数徽标、
 * 搜索框（大小写不敏感 contains 过滤，X 清词）、按 [TagGroup] 分组展示 chips。
 *
 * 两处口径写死在这里，别改回去：
 *  - **组序与组内序 = Rust 给的原样**（M4a 1.2 把分组排序收进了 `collate::group_tags`，
 *    UI 再排就是全项目第三套标签排序规则）；组名按 `tagGroups` 的出现顺序渲染，不再
 *    `keys.sorted()`；
 *  - 搜索框的过滤（React 的 `tagSearchQuery`）**留在 UI 侧**：输入即时响应，不该每个
 *    字符过一次 FFI（清单 1.2 的定案）。
 *
 * chips 可点（点下去 = 单选筛选并收起弹层），选中态与侧栏标签行同一套语义。
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun TagsFilterSheet(
    tagGroups: List<TagGroup>,
    activeTags: List<String>,
    onTagClick: (String) -> Unit,
    onDone: () -> Unit,
) {
    val colors = AuroraTheme.colors
    var query by remember { mutableStateOf("") }

    // 只过滤组内成员、不动组的顺序；整组被过滤空的组不显示
    val filtered = remember(tagGroups, query) {
        if (query.isBlank()) tagGroups
        else tagGroups
            .map { group ->
                group.copy(tags = group.tags.filter { it.tag.contains(query, ignoreCase = true) })
            }
            .filter { it.tags.isNotEmpty() }
    }
    val totalTags = filtered.sumOf { it.tags.size }

    Column(
        Modifier
            .fillMaxWidth()
            .verticalScroll(rememberScrollState())
            .navigationBarsPadding()
            .padding(horizontal = 20.dp)
            .padding(bottom = 12.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                "所有标签",
                fontWeight = FontWeight.Bold,
                fontSize = 16.sp,
                color = colors.textPrimary,
            )
            Spacer(Modifier.size(8.dp))
            Text(
                totalTags.toString(),
                Modifier
                    .clip(RoundedCornerShape(50))
                    .background(colors.surface)
                    .padding(horizontal = 8.dp, vertical = 1.dp),
                fontSize = 11.sp,
                color = colors.textSecondary,
            )
            Spacer(Modifier.weight(1f))
            Box(
                Modifier
                    // 关闭是弹层里唯一的退出入口，命中区按移动端下限给到 48dp
                    .size(48.dp)
                    .clip(RoundedCornerShape(24.dp))
                    .clickable(onClick = onDone),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    imageVector = IconX,
                    contentDescription = "关闭",
                    tint = colors.textSecondary,
                    modifier = Modifier.size(18.dp),
                )
            }
        }
        Spacer(Modifier.height(12.dp))
        // 搜索框（React TagsWidget 头部的 input；过滤即打即筛）
        Row(
            Modifier
                .fillMaxWidth()
                .height(40.dp)
                .background(colors.surface, RoundedCornerShape(8.dp))
                .border(1.dp, colors.subtle, RoundedCornerShape(8.dp))
                .padding(horizontal = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                imageVector = IconSearch,
                contentDescription = null,
                tint = colors.textSecondary,
                modifier = Modifier.size(16.dp),
            )
            Spacer(Modifier.size(8.dp))
            BasicTextField(
                value = query,
                onValueChange = { query = it },
                singleLine = true,
                textStyle = TextStyle(color = colors.textPrimary, fontSize = 14.sp),
                cursorBrush = SolidColor(colors.primary),
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                modifier = Modifier.weight(1f),
                decorationBox = { inner ->
                    Box(contentAlignment = Alignment.CenterStart) {
                        if (query.isEmpty()) {
                            Text("搜索标签", color = colors.textSecondary, fontSize = 14.sp)
                        }
                        inner()
                    }
                },
            )
            if (query.isNotEmpty()) {
                Box(
                    Modifier
                        .size(28.dp)
                        .clip(CircleShape)
                        .clickable { query = "" },
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(
                        imageVector = IconX,
                        contentDescription = "清除搜索",
                        tint = colors.textSecondary,
                        modifier = Modifier.size(14.dp),
                    )
                }
            }
        }
        Spacer(Modifier.height(16.dp))
        if (totalTags == 0) {
            Text(
                if (query.isBlank()) "暂无标签" else "未找到标签",
                Modifier.fillMaxWidth().padding(vertical = 16.dp),
                textAlign = TextAlign.Center,
                fontSize = 12.sp,
                color = colors.textSecondary,
            )
        } else {
            filtered.forEach { group ->
                Column(Modifier.fillMaxWidth().padding(bottom = 16.dp)) {
                    Text(
                        group.key,
                        Modifier.fillMaxWidth().padding(bottom = 6.dp),
                        fontSize = 12.sp,
                        fontWeight = FontWeight.Bold,
                        color = colors.textSecondary,
                    )
                    // 底部 1dp 分隔（React 组头的 border-b）
                    Box(Modifier.fillMaxWidth().height(1.dp).background(colors.subtle))
                    Spacer(Modifier.height(8.dp))
                    FlowRow(
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        group.tags.forEach { entry ->
                            val selected = entry.tag in activeTags
                            Text(
                                entry.tag,
                                Modifier
                                    .clip(RoundedCornerShape(6.dp))
                                    .background(
                                        if (selected) colors.primary
                                        else colors.primary.copy(alpha = 0.08f)
                                    )
                                    .border(
                                        1.dp,
                                        if (selected) colors.primary
                                        else colors.primary.copy(alpha = 0.2f),
                                        RoundedCornerShape(6.dp),
                                    )
                                    // 命中区：文字 chip 本体只有约 30dp 高，补到 48dp 下限
                                    // （视觉尺寸不变，padding 计入可点区）
                                    .clickable { onTagClick(entry.tag) }
                                    .padding(horizontal = 12.dp, vertical = 14.dp),
                                fontSize = 14.sp,
                                color = if (selected) Color.White else colors.primary,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                    }
                }
            }
        }
    }
}

/** 月历格子：月份偏移（-1 上月 / 0 当月 / +1 下月）+ 当日 12:00 的 epoch 秒。 */
private data class DayCell(val day: Int, val monthOffset: Int, val epoch: Long)

private fun dayEpoch(year: Int, month0: Int, day: Int): Long {
    val cal = Calendar.getInstance()
    cal.clear()
    cal.set(year, month0, day, 12, 0, 0)
    return cal.timeInMillis / 1000L
}

private fun epochToYear(epoch: Long?): Int {
    val cal = Calendar.getInstance()
    cal.timeInMillis = (epoch ?: return 1970) * 1000L
    return cal.get(Calendar.YEAR)
}

private fun epochToMonth(epoch: Long?): Int {
    val cal = Calendar.getInstance()
    cal.timeInMillis = (epoch ?: return 0) * 1000L
    return cal.get(Calendar.MONTH)
}

/** 42 格（6 行 × 7 列）月历单元，含前后月补位（对齐 React CalendarWidget 的补格规则）。 */
private fun buildMonthCells(year: Int, month0: Int): List<DayCell> {
    val cal = Calendar.getInstance()
    cal.clear()
    cal.set(year, month0, 1)
    val firstDayOffset = cal.get(Calendar.DAY_OF_WEEK) - Calendar.SUNDAY // 0=周日
    val daysInMonth = cal.getActualMaximum(Calendar.DAY_OF_MONTH)

    val prev = cal.apply { add(Calendar.MONTH, -1) }
    val daysInPrev = prev.getActualMaximum(Calendar.DAY_OF_MONTH)

    val out = ArrayList<DayCell>(42)
    for (i in 0 until firstDayOffset) {
        val day = daysInPrev - firstDayOffset + 1 + i
        out += DayCell(day, -1, dayEpoch(if (month0 == 0) year - 1 else year, if (month0 == 0) 11 else month0 - 1, day))
    }
    for (day in 1..daysInMonth) {
        out += DayCell(day, 0, dayEpoch(year, month0, day))
    }
    var nextDay = 1
    while (out.size < 42) {
        out += DayCell(nextDay, 1, dayEpoch(if (month0 == 11) year + 1 else year, if (month0 == 11) 0 else month0 + 1, nextDay))
        nextDay++
    }
    return out
}
