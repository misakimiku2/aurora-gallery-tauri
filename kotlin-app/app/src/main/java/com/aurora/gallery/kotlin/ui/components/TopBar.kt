package com.aurora.gallery.kotlin.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
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
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.path
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.aurora.gallery.kotlin.state.DateFilter
import com.aurora.gallery.kotlin.state.DateFilterMode
import com.aurora.gallery.kotlin.state.SortDirection
import com.aurora.gallery.kotlin.state.SortOption
import com.aurora.gallery.kotlin.ui.theme.AuroraTheme
import java.util.Calendar
import java.util.Locale

/**
 * 顶栏（3.2，对齐 React `TopBar.tsx` 的 `isAndroid` 分支：平板横屏形态）。
 *
 * 布局 = [返回] [搜索开关] [标题 / 搜索胶囊] [排序菜单 | 视图循环 | 日期筛选]：
 *  - 返回：走页内历史（[com.aurora.gallery.kotlin.state.AppState.goBack]），栈底禁用，
 *    禁用条件对齐 React `history.currentIndex <= 0`；
 *  - 搜索：点开替换标题为胶囊（React `isSearchOpen`），关闭时清空 query（对齐 React
 *    `onSetToolbarQuery('')` + close）；M1 只做文件名过滤，scope 下拉随 M2 标签补；
 *  - 排序菜单：排序字段/方向 + 分组方式（React sortMenuOpen 的菜单，选项不点走不收）；
 *  - 视图循环：grid → adaptive → masonry（React `isAndroid` 分支的三档循环，无 list）；
 *  - 日期筛选：底部弹层月历（React 安卓分支的 CalendarWidget bottom sheet），
 *    区间选择语义逐条对齐：首点设 start（清 end）、次点补 end（早于 start 则互换）、
 *    再点重新开始。
 *
 * 与 React 版的差异（均有意为之，见各处注释）：M1 无侧栏（3.4）故无侧栏开关；无色板
 * 搜索（M6）；标签过滤（M2）；文件夹总览的视图循环/排序（React 的 folderLayoutMode，
 * Kotlin 总览暂只支持网格）不提供——[showBrowserTools] 只在文件夹内部视图为 true。
 * 手机竖屏的「更多」菜单合并（isPhonePortrait）随手机适配再做。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TopBar(
    title: String,
    canBack: Boolean,
    onBack: () -> Unit,
    searchQuery: String,
    onSearchQueryChange: (String) -> Unit,
    dateFilter: DateFilter,
    onDateFilterChange: (DateFilter) -> Unit,
    sortBy: SortOption,
    onSortChange: (SortOption) -> Unit,
    sortDirection: SortDirection,
    onSortDirectionToggle: () -> Unit,
    groupBy: GroupBy,
    onGroupByChange: (GroupBy) -> Unit,
    layoutMode: LayoutMode,
    onLayoutModeChange: (LayoutMode) -> Unit,
    /** 是否显示浏览器工具（搜索/排序/视图/日期）：仅在文件夹内部视图为 true。 */
    showBrowserTools: Boolean,
    modifier: Modifier = Modifier,
) {
    val colors = AuroraTheme.colors
    var searchOpen by remember { mutableStateOf(false) }
    var sortMenuOpen by remember { mutableStateOf(false) }
    var dateSheetOpen by remember { mutableStateOf(false) }

    Row(
        modifier = modifier
            .fillMaxWidth()
            .height(56.dp)
            .background(colors.panel)
            .padding(horizontal = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        TopBarButton(enabled = canBack, onClick = onBack) {
            Icon(
                imageVector = IconChevronLeft,
                contentDescription = "返回",
                tint = if (canBack) colors.textPrimary else colors.textSecondary.copy(alpha = 0.4f),
                modifier = Modifier.size(20.dp),
            )
        }
        if (showBrowserTools && !searchOpen) {
            TopBarButton(onClick = { searchOpen = true }) {
                Icon(
                    imageVector = IconSearch,
                    contentDescription = "搜索",
                    tint = if (searchOpen) colors.primary else colors.textSecondary,
                    modifier = Modifier.size(19.dp),
                )
            }
        }
        Box(Modifier.weight(1f), contentAlignment = Alignment.Center) {
            if (!searchOpen) {
                Text(
                    text = title,
                    fontWeight = FontWeight.Medium,
                    fontSize = 15.sp,
                    color = colors.textPrimary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            } else {
                SearchPill(
                    query = searchQuery,
                    onQueryChange = onSearchQueryChange,
                    onClose = {
                        onSearchQueryChange("")
                        searchOpen = false
                    },
                )
            }
        }
        if (showBrowserTools) {
            Box {
                TopBarButton(
                    highlighted = sortMenuOpen,
                    onClick = { sortMenuOpen = !sortMenuOpen },
                ) {
                    Icon(
                        imageVector = IconArrowDownUp,
                        contentDescription = "排序",
                        tint = if (sortMenuOpen) colors.primary else colors.textSecondary,
                        modifier = Modifier.size(18.dp),
                    )
                }
                // 选项点击后不收起（对齐 React：可连续调字段/方向/分组，点外部才关）
                DropdownMenu(expanded = sortMenuOpen, onDismissRequest = { sortMenuOpen = false }) {
                    val sortLabels = mapOf(
                        SortOption.NAME to "名称",
                        SortOption.DATE to "日期",
                        SortOption.SIZE to "大小",
                    )
                    sortLabels.forEach { (opt, label) ->
                        DropdownMenuItem(
                            text = { Text(label, color = if (sortBy == opt) colors.primary else colors.textPrimary, fontSize = 14.sp) },
                            trailingIcon = {
                                if (sortBy == opt) {
                                    Icon(CheckMark, contentDescription = null, tint = colors.primary, modifier = Modifier.size(16.dp))
                                }
                            },
                            onClick = { onSortChange(opt) },
                        )
                    }
                    HorizontalDivider(color = colors.subtle)
                    DropdownMenuItem(
                        text = {
                            Text(
                                if (sortDirection == SortDirection.ASC) "升序" else "降序",
                                color = colors.textPrimary,
                                fontSize = 14.sp,
                            )
                        },
                        trailingIcon = {
                            Icon(
                                imageVector = IconArrowDownUp,
                                contentDescription = null,
                                tint = colors.textSecondary,
                                // 升序 = 箭头朝上（React 同款 rotate）
                                modifier = Modifier.size(14.dp).rotate(if (sortDirection == SortDirection.ASC) 180f else 0f),
                            )
                        },
                        onClick = onSortDirectionToggle,
                    )
                    HorizontalDivider(color = colors.subtle)
                    DropdownMenuItem(
                        text = { Text("分组", fontSize = 11.sp, fontWeight = FontWeight.Bold, color = colors.textSecondary) },
                        enabled = false,
                        onClick = {},
                    )
                    val groupLabels = mapOf(
                        GroupBy.NONE to "无",
                        GroupBy.TYPE to "类型",
                        GroupBy.DATE to "日期",
                    )
                    groupLabels.forEach { (opt, label) ->
                        DropdownMenuItem(
                            text = { Text(label, color = if (groupBy == opt) colors.primary else colors.textPrimary, fontSize = 14.sp) },
                            trailingIcon = {
                                if (groupBy == opt) {
                                    Icon(CheckMark, contentDescription = null, tint = colors.primary, modifier = Modifier.size(16.dp))
                                }
                            },
                            onClick = { onGroupByChange(opt) },
                        )
                    }
                }
            }
            TopBarButton(
                onClick = {
                    // 安卓端三档循环（React isAndroid 分支）：grid → adaptive → masonry → grid
                    val cycle = LayoutMode.values()
                    onLayoutModeChange(cycle[(cycle.indexOf(layoutMode) + 1) % cycle.size])
                },
            ) {
                Icon(
                    imageVector = when (layoutMode) {
                        LayoutMode.GRID -> IconGrid
                        LayoutMode.ADAPTIVE -> IconLayoutGrid
                        LayoutMode.MASONRY -> IconLayoutTemplate
                    },
                    contentDescription = "视图模式",
                    tint = colors.textSecondary,
                    modifier = Modifier.size(18.dp),
                )
            }
            TopBarButton(
                highlighted = dateSheetOpen,
                onClick = { dateSheetOpen = true },
            ) {
                Icon(
                    imageVector = IconCalendar,
                    contentDescription = "日期筛选",
                    // 有筛选时高亮（对齐 React：filterMenuOpen || dateFilter.start）
                    tint = if (dateSheetOpen || dateFilter.start != null) colors.primary else colors.textSecondary,
                    modifier = Modifier.size(18.dp),
                )
            }
        }
    }

    if (dateSheetOpen) {
        ModalBottomSheet(
            onDismissRequest = { dateSheetOpen = false },
            containerColor = AuroraTheme.colors.panel,
        ) {
            DateFilterSheet(
                filter = dateFilter,
                onFilterChange = onDateFilterChange,
                onDone = { dateSheetOpen = false },
            )
        }
    }
}

/** 顶栏圆角按钮（对齐 React 安卓 `w-10 h-10 rounded-xl hover:bg-surface`）。 */
@Composable
private fun TopBarButton(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    highlighted: Boolean = false,
    content: @Composable () -> Unit,
) {
    val colors = AuroraTheme.colors
    Box(
        modifier = modifier
            .size(40.dp)
            .clip(RoundedCornerShape(12.dp))
            .background(if (highlighted) colors.surface else Color.Transparent)
            .clickable(enabled = enabled, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        content()
    }
}

/** 搜索胶囊（React 安卓 `isSearchOpen` 时的中央输入；自动聚焦弹键盘，X 关闭并清词）。 */
@Composable
private fun SearchPill(
    query: String,
    onQueryChange: (String) -> Unit,
    onClose: () -> Unit,
) {
    val colors = AuroraTheme.colors
    val focusRequester = remember { FocusRequester() }
    LaunchedEffect(Unit) { focusRequester.requestFocus() }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 8.dp)
            .height(40.dp)
            .background(colors.surface, RoundedCornerShape(50))
            .border(1.dp, colors.subtle, RoundedCornerShape(50))
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
            onValueChange = onQueryChange,
            singleLine = true,
            textStyle = TextStyle(color = colors.textPrimary, fontSize = 14.sp),
            cursorBrush = SolidColor(colors.primary),
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
            modifier = Modifier.weight(1f).focusRequester(focusRequester),
            decorationBox = { inner ->
                Box(contentAlignment = Alignment.CenterStart) {
                    if (query.isEmpty()) {
                        Text("搜索图片", color = colors.textSecondary, fontSize = 14.sp)
                    }
                    inner()
                }
            },
        )
        Spacer(Modifier.size(8.dp))
        Box(
            Modifier
                .size(28.dp)
                .clip(CircleShape)
                .clickable(onClick = onClose),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                imageVector = IconX,
                contentDescription = "关闭搜索",
                tint = colors.textSecondary,
                modifier = Modifier.size(16.dp),
            )
        }
    }
}

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
private fun DateFilterSheet(
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
        for (row in 0 until 6) {
            Row(Modifier.fillMaxWidth()) {
                cells.drop(row * 7).take(7).forEach { cell ->
                    val selected = cell.epoch == filter.start || cell.epoch == filter.end
                    val inRange = filter.start != null && filter.end != null &&
                        cell.epoch > filter.start && cell.epoch < filter.end
                    Box(
                        Modifier
                            .weight(1f)
                            .height(40.dp)
                            .padding(vertical = 2.dp)
                            .clip(RoundedCornerShape(6.dp))
                            .background(if (inRange) colors.primary.copy(alpha = 0.12f) else Color.Transparent)
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
                        val isSelected = selected
                        Box(
                            Modifier
                                .size(32.dp)
                                .clip(CircleShape)
                                .background(if (isSelected) colors.primary else Color.Transparent),
                            contentAlignment = Alignment.Center,
                        ) {
                            Text(
                                cell.day.toString(),
                                fontSize = 12.sp,
                                fontWeight = FontWeight.Medium,
                                color = when {
                                    isSelected -> Color.White
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

// ---- 自绘图标：lucide 线性风格（对齐 React 版 lucide-react 图标，24 视口 / 2 线宽 / 圆头）----

private const val STROKE = 2f

private fun iconBuilder(
    name: String,
    block: androidx.compose.ui.graphics.vector.PathBuilder.() -> Unit,
): ImageVector = ImageVector.Builder(
    name = name,
    defaultWidth = 24.dp,
    defaultHeight = 24.dp,
    viewportWidth = 24f,
    viewportHeight = 24f,
).apply {
    path(
        stroke = SolidColor(Color.Black),
        strokeLineWidth = STROKE,
        strokeLineCap = StrokeCap.Round,
        strokeLineJoin = StrokeJoin.Round,
    ) { block() }
}.build()

/** 在 [PathBuilder] 上画圆角矩形（lucide 的 rect rx）。 */
private fun androidx.compose.ui.graphics.vector.PathBuilder.roundedRect(x: Float, y: Float, w: Float, h: Float, r: Float) {
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

private val IconChevronLeft: ImageVector by lazy {
    iconBuilder("ChevronLeft") {
        moveTo(15f, 18f)
        lineTo(9f, 12f)
        lineTo(15f, 6f)
    }
}

private val IconSearch: ImageVector by lazy {
    iconBuilder("Search") {
        // circle(11, 11, r=8)
        moveTo(3f, 11f)
        arcTo(8f, 8f, 0f, true, true, 19f, 11f)
        arcTo(8f, 8f, 0f, true, true, 3f, 11f)
        close()
        moveTo(21f, 21f)
        lineTo(16.65f, 16.65f)
    }
}

private val IconX: ImageVector by lazy {
    iconBuilder("X") {
        moveTo(18f, 6f)
        lineTo(6f, 18f)
        moveTo(6f, 6f)
        lineTo(18f, 18f)
    }
}

private val IconArrowDownUp: ImageVector by lazy {
    iconBuilder("ArrowDownUp") {
        // lucide arrow-down-up：左列向下箭头 + 右列向上箭头
        moveTo(3f, 16f)
        lineTo(7f, 20f)
        lineTo(11f, 16f)
        moveTo(7f, 20f)
        lineTo(7f, 4f)
        moveTo(21f, 8f)
        lineTo(17f, 4f)
        lineTo(13f, 8f)
        moveTo(17f, 4f)
        lineTo(17f, 20f)
    }
}

private val IconCalendar: ImageVector by lazy {
    iconBuilder("Calendar") {
        roundedRect(3f, 4f, 18f, 18f, 2f)
        moveTo(8f, 2f)
        lineTo(8f, 6f)
        moveTo(16f, 2f)
        lineTo(16f, 6f)
        moveTo(3f, 10f)
        lineTo(21f, 10f)
    }
}

private val IconGrid: ImageVector by lazy {
    iconBuilder("Grid") {
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

private val IconLayoutGrid: ImageVector by lazy {
    iconBuilder("LayoutGrid") {
        roundedRect(3f, 3f, 7f, 7f, 1f)
        roundedRect(14f, 3f, 7f, 7f, 1f)
        roundedRect(14f, 14f, 7f, 7f, 1f)
        roundedRect(3f, 14f, 7f, 7f, 1f)
    }
}

private val IconLayoutTemplate: ImageVector by lazy {
    iconBuilder("LayoutTemplate") {
        roundedRect(3f, 3f, 18f, 18f, 2f)
        moveTo(3f, 9f)
        lineTo(21f, 9f)
        moveTo(9f, 21f)
        lineTo(9f, 9f)
    }
}

/** 菜单勾选（material 核心图标集中的 Check，与 lucide 视觉一致）。 */
private val CheckMark: ImageVector by lazy {
    ImageVector.Builder(
        name = "Check",
        defaultWidth = 24.dp,
        defaultHeight = 24.dp,
        viewportWidth = 24f,
        viewportHeight = 24f,
    ).apply {
        path(
            stroke = SolidColor(Color.Black),
            strokeLineWidth = 2.5f,
            strokeLineCap = StrokeCap.Round,
            strokeLineJoin = StrokeJoin.Round,
        ) {
            moveTo(4f, 12.5f)
            lineTo(9.5f, 18f)
            lineTo(20f, 6.5f)
        }
    }.build()
}
