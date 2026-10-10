package com.aurora.gallery.kotlin.ui.components

import android.app.Activity
import android.app.Dialog
import android.graphics.Bitmap
import android.graphics.Outline
import android.graphics.drawable.ColorDrawable
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.PixelCopy
import android.view.View
import android.view.ViewOutlineProvider
import android.view.ViewGroup
import android.view.Window
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.BlurEffect
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.TileMode
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.path
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.ComposeView
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.findViewTreeLifecycleOwner
import androidx.lifecycle.setViewTreeLifecycleOwner
import androidx.savedstate.findViewTreeSavedStateRegistryOwner
import androidx.savedstate.setViewTreeSavedStateRegistryOwner
import com.aurora.gallery.kotlin.state.DateFilter
import com.aurora.gallery.kotlin.state.DateFilterMode
import com.aurora.gallery.kotlin.state.SearchScope
import com.aurora.gallery.kotlin.state.SortDirection
import com.aurora.gallery.kotlin.state.SortOption
import com.aurora.gallery.kotlin.ui.theme.AuroraTheme
import com.aurora.gallery.kotlin.ui.theme.LocalAuroraColors
import uniffi.aurora_core.TagGroup
import java.util.Calendar
import java.util.Locale
import kotlin.math.roundToInt

/**
 * 顶栏（3.2，对齐 React `TopBar.tsx` 的 `isAndroid` 分支：平板横屏形态）。
 *
 * 布局 = [侧栏开关] [返回] [搜索开关] [标题 / 搜索胶囊] [排序菜单 | 视图循环 | 日期筛选 | 标签筛选 | 取色搜索]：
 *  - 侧栏开关：3.5 面板开合入口，开启时蓝色高亮（React 同款 PanelLeft 图标置最左）；
 *  - 返回：走页内历史（[com.aurora.gallery.kotlin.state.AppState.goBack]），栈底禁用，
 *    禁用条件对齐 React `history.currentIndex <= 0`；总览（主界面）整键隐藏（2026-09-20
 *    用户要求：主界面不需要返回按键，[showBack] 控制）；
 *  - 搜索：点开替换标题为胶囊（React `isSearchOpen`），关闭时清空 query（对齐 React
 *    `onSetToolbarQuery('')` + close）；标签筛选已由 4.1 的标签弹层承载（SearchScope.TAG
 *    走 activeTags 序列源），文本搜索的 scope 下拉（全部/文件/标签/文件夹）不做，归 M4b；
 *  - 排序菜单：排序字段/方向 + 分组方式（React sortMenuOpen 的菜单，选项不点走不收）；
 *  - 视图排布：三档循环按钮（2026-09-20 用户要求：改回切换式、不弹菜单）——
 *    grid → adaptive → masonry（模式集合 = React isAndroid 分支，无 list）；
 *  - 日期筛选：底部弹层月历（React 安卓分支的 CalendarWidget bottom sheet），
 *    区间选择语义逐条对齐：首点设 start（清 end）、次点补 end（早于 start 则互换）、
 *    再点重新开始；
 *  - 标签筛选：底部弹层标签面板（React TagsWidget 的 bottom-sheet 形态）：标题 + 总数
 *    徽标、搜索框、按 [TagGroup] 分组展示的 chips。**组序与组内序都取 Rust
 *    `get_grouped_tags` 的原样**（M4a 1.2 起 UI 侧不再自己排，见清单 §1）；chips 可点，
 *    点下去 = 单选筛选（与侧栏标签行同一个 [onTagClick]）；
 *  - 取色搜索（M6b 阶段 3，D39 双入口的 TopBar 侧；2026-09-28 升级为 HSV 取色器，
 *    对齐 React `MobileColorPickerSheet.tsx`）：SV 面板 + Hue 滑块 + hex 输入 + 预设
 *    16 色 + 最近使用，颜色变化 300ms 防抖后实时搜索（[onColorSearch]，互斥清 AI 态
 *    由宿主处理），弹层/面板不再「点一下就收起」（收起走底部「完成」）。
 *    **形态分宿主**：平板 = 右侧推挤面板（宿主承载，本组件只发 [onToggleColorPanel]），
 *    手机竖屏/横屏 = 本组件内的底部弹层。胶囊内色点芯片（[colorSearchHex] 非 null 时
 *    显示）展示过滤态，点击 = [onClearColorSearch] 清除。
 *
 * 与 React 版的差异（均有意为之，见各处注释）：颜色搜索已落地（TopBar 取色按钮 +
 * HSV 取色器，形态分宿主见上）。工具按钮按视图提供
 * （2026-09-17 起）：文件夹内部 = 搜索/排序/视图/日期全量；总览 = 搜索（按文件夹名过滤，
 * React 总览搜索是全局文件搜索、Kotlin M1 无此管道）+ 排序 + 日期筛选（Folder 带
 * createdAt/modifiedAt 后接入）；总览的视图循环（folderLayoutMode）判定不做——文件夹
 * 卡片是等比正方形，adaptive/masonry 视觉与 grid 等价，三档捏合已覆盖尺寸调整。
 *
 * **手机竖屏「更多」菜单合并（M8b 1.4，D44：无底部导航、导航由 TopBar+侧栏两件套
 * 承载，精简顶部工具栏替代）**：isPhonePortrait（窄宽 + 竖屏）下排序/视图/日期/标签/
 * 取色五个低频入口收进 MoreVertical「更多」菜单（React TopBar.tsx:601-602 同位参照；
 * 排序子菜单内容扁平并入本菜单，底部弹层类项目点开即收起菜单）——高频的 侧栏开关/
 * 返回/搜索 保持直挂。横屏手机（宽 ≥600dp）沿用全量按钮形制。
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun TopBar(
    title: String,
    canBack: Boolean,
    onBack: () -> Unit,
    searchQuery: String,
    onSearchQueryChange: (String) -> Unit,
    /**
     * 搜索胶囊开合（4.3 提升到宿主）：返回手势链需要在「退选择 / 返回上级」之前先关搜索
     * （对齐 React handleAndroidBackPress 的 searchInput 分支），因此不能留在本组件内部。
     */
    searchOpen: Boolean,
    onSearchOpenChange: (Boolean) -> Unit,
    /** 搜索胶囊的占位文案（M8b-17 起与桌面端同链：人物/标签总览 → AI 态 → scope 驱动，由宿主计算传入）。 */
    searchPlaceholder: String = "搜索...",
    /** 搜索范围（M4b 阶段 3：scope 下拉，对齐 React TopBar :968-999）。 */
    searchScope: SearchScope = SearchScope.ALL,
    onSearchScopeChange: (SearchScope) -> Unit = {},
    /** 是否显示 scope 下拉（仅 BROWSER 视图；对齐 React 在 people/tags 总览隐藏）。 */
    showScope: Boolean = false,
    /**
     * M6b 阶段 2：AI 搜索开关（桌面 TopBar 紫色 AI 图标的触屏同位）。开=回车提交走
     * core 改写+全库过滤（onAiSearchSubmit），文本/日期过滤被命中集顶替；关=普通文本搜索。
     */
    aiSearchEnabled: Boolean = false,
    onAiSearchToggle: () -> Unit = {},
    onAiSearchSubmit: (String) -> Unit = {},
    aiSearchBusy: Boolean = false,
    /** M6b 阶段 5：LAN 态回车提交分流（非 null=LAN 搜索，宿主分流文件名/CLIP；null=本地语义）。 */
    onLanSearchSubmit: ((String) -> Unit)? = null,
    /**
     * M6b 阶段 3：取色搜索（桌面 `ColorPickerPopover` 的触屏同位，D39 双入口的
     * TopBar 侧；查看器抽屉色块为另一入口）。[showColorSearch] 与 [showSearch] 同域
     * （本地 BROWSER 视图才显示）。
     *
     * 2026-09-28 起取色器升级为 HSV 版（对齐 React `MobileColorPickerSheet.tsx`：
     * SV 面板 + Hue 滑块 + hex 输入 + 预设 16 色 + 最近使用），并按形态分宿主：
     * 平板（[com.aurora.gallery.kotlin.ui.isTabletForm]）= 右侧推挤面板（宿主承载，
     * 本组件只通过 [onToggleColorPanel] 触发、用 [colorPanelOpen] 画高亮）；其余形态
     * （手机竖屏/横屏）= 本组件内的底部弹层（[ColorPickerPanelContent] 同一个内容
     * 组合，只是容器不同）。颜色变化 300ms 防抖后实时搜索，不再「点一下就收起」。
     */
    showColorSearch: Boolean = false,
    /** 非 null = 颜色过滤态：胶囊内显示色点芯片（比较不分大小写）。 */
    colorSearchHex: String? = null,
    /** 颜色落定（面板内防抖后）→ 宿主发起颜色搜索 + 清 AI 态。 */
    onColorSearch: (String) -> Unit = {},
    /**
     * 平板右侧取色面板的开合态（宿主持有；非平板形态恒 false——那时由本组件的底部
     * 弹层承担，[colorSheetOpen] 是组件内私有态）。仅用于按钮/菜单项的高亮。
     */
    colorPanelOpen: Boolean = false,
    /** 平板形态下点取色入口 = 开关右侧面板（宿主翻转 AppState.layout）。 */
    onToggleColorPanel: () -> Unit = {},
    /** 胶囊色点芯片点击清除（整颗芯片可点）。 */
    onClearColorSearch: () -> Unit = {},
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
    /** 侧栏可见性（侧栏开关按钮的高亮态，3.5）。 */
    sidebarVisible: Boolean,
    onToggleSidebar: () -> Unit,
    /**
     * 标签分组 + 计数，Rust `get_grouped_tags` 的原样返回（组序、组内序都不许 UI 再排）。
     * 与侧栏标签 Section 同源——两处是同一份数据的两个视图，不是两份缓存。
     */
    tagGroups: List<TagGroup> = emptyList(),
    /** 当前生效的标签筛选，弹层里给 chips 画选中态。 */
    activeTags: List<String> = emptyList(),
    /** 点 chips：与侧栏标签行同一条 [AppState.toggleTagFilter]。 */
    onTagClick: (String) -> Unit = {},
    /** 是否显示返回键（总览 = false，主界面不提供返回按键）。 */
    showBack: Boolean = true,
    /** 是否显示搜索开关（文件夹内部与总览都提供；总览按文件夹名过滤）。 */
    showSearch: Boolean,
    /** 是否显示排序菜单（总览也提供，字段经 [sortChoices] 收窄）。 */
    showSortMenu: Boolean,
    /**
     * 排序菜单**体**的注入位（2026-10-08 指挥官：进入人物界面时顶栏那颗钮要换成当前
     * 视图对应的排序语义，而不是各留一颗）。null = 图片排序那套（排序方式 + 升降序 +
     * 分组方式）；非 null 时横屏那颗钮和手机竖屏「更多 → 排序方式」二级都渲染它——
     * 两处都要接，否则手机上人物排序会整个丢掉入口。
     */
    sortMenuContent: (@Composable ColumnScope.() -> Unit)? = null,
    /** 是否显示视图循环按钮（仅文件夹内部视图；总览暂只支持网格）。 */
    showViewMode: Boolean,
    /** 是否显示日期筛选（2026-09-17 起总览也提供：按 Folder 的代表日期筛文件夹）。 */
    showDateFilter: Boolean,
    /** 是否显示标签筛选按钮（React 同款默认展示，仅 topics 视图隐藏——Kotlin 无该视图）。 */
    showTags: Boolean = true,
    /** 排序菜单可选字段。 */
    sortChoices: List<SortOption> = listOf(SortOption.NAME, SortOption.DATE, SortOption.SIZE),
    /** 排序菜单是否含分组小节（总览是文件夹卡片，无分组概念，对齐 React 总览隐藏 groupBy）。 */
    showGroupBy: Boolean = true,
    /**
     * 设置入口兜底（M4c D21）：仅横屏手机（宽 ≥600dp 且高 <480dp）传入——这一形态侧栏
     * 固定 Section 总高超屏、底部「设置」行被裁切不可达（M2 侧栏结构封版，不在其上动刀），
     * 设置入口临时挂到顶栏。平板/竖屏手机走侧栏入口，传 null 不渲染。
     */
    onOpenSettings: (() -> Unit)? = null,
    /**
     * 视图专属动作按钮（M6a 阶段 4：LAN 视图的上传入口；null = 不渲染）。
     * [actionEnabled] = false 时按钮呈置灰态、点击仍回调（宿主 Toast 说明置灰原因，
     * 对齐「入口置灰 + 提示需桌面端开启」的验收口径）。
     */
    actionIcon: ImageVector? = null,
    actionContentDescription: String = "",
    actionEnabled: Boolean = true,
    onActionClick: (() -> Unit)? = null,
    modifier: Modifier = Modifier,
) {
    val colors = AuroraTheme.colors
    var sortMenuOpen by remember { mutableStateOf(false) }
    var dateSheetOpen by remember { mutableStateOf(false) }
    var tagsSheetOpen by remember { mutableStateOf(false) }
    var colorSheetOpen by remember { mutableStateOf(false) }
    // M8b 1.4：手机竖屏「更多」菜单（D44 精简顶部工具栏）。窄宽 + 竖屏双条件——横屏
    // 手机（宽 ≥600dp）屏宽够，五个按钮保持直挂
    val isPhonePortrait = LocalConfiguration.current.let {
        com.aurora.gallery.kotlin.ui.isCompactWidth(it) &&
            it.orientation == android.content.res.Configuration.ORIENTATION_PORTRAIT
    }
    // 2026-09-28：取色器的宿主形态判据（唯一一套，见 FormFactor.kt）——平板走右侧
    // 推挤面板，其余（手机竖屏/横屏）走本组件的底部弹层。手机竖屏明确要求「从下方弹起」；
    // 横屏手机高 <480dp，右侧面板会把主内容挤没，同样走底部。
    val useRightColorPanel = com.aurora.gallery.kotlin.ui.isTabletForm(LocalConfiguration.current)
    val colorPanelActive = colorSheetOpen || colorPanelOpen
    // 合并菜单开合（受控于 MoreVertical 按钮；与 sortMenu 互斥由 UI 流程保证）
    var moreMenuOpen by remember { mutableStateOf(false) }
    // 二级子菜单态（M8b 验收反馈：排序方式/分组方式拆成二级菜单）：0=主菜单 1=排序 2=分组
    var moreSubmenu by remember { mutableStateOf(0) }
    var moreAnchor by remember { mutableStateOf(Rect.Zero) }

    Row(
        modifier = modifier
            .fillMaxWidth()
            .height(56.dp)
            .background(colors.panel)
            .padding(horizontal = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        TopBarButton(
            highlighted = sidebarVisible,
            onClick = onToggleSidebar,
        ) {
            Icon(
                imageVector = IconPanelLeft,
                contentDescription = "侧栏开关",
                // 开启时蓝色高亮（对齐 React：isSidebarVisible ? 'text-blue-500' : gray）
                tint = if (sidebarVisible) colors.primary else colors.textSecondary,
                modifier = Modifier.size(18.dp),
            )
        }
        // 手机竖屏 searchOpen 时隐藏返回（2026-09-27 用户报障：竖屏搜索输入区过窄）：
        // 输入态下胶囊内 X 与系统返回手势（宿主返回链先关搜索）都承担退出，此钮纯冗余，
        // 让出 44dp 给输入区；平板/横屏维持原样。
        if (showBack && !(isPhonePortrait && searchOpen)) {
            TopBarButton(enabled = canBack, onClick = onBack) {
                Icon(
                    imageVector = IconChevronLeft,
                    contentDescription = "返回",
                    tint = if (canBack) colors.textPrimary else colors.textSecondary.copy(alpha = 0.4f),
                    modifier = Modifier.size(20.dp),
                )
            }
        }
        // 搜索钮（M8b 验收反馈：竖屏手机移到标题右侧——两侧钮对称时标题屏幕居中；
        // 平板/横屏维持标题左侧原形制零回归）。searchOpen 时钮隐藏，胶囊占中栏。
        val searchButton: @Composable () -> Unit = {
            if (showSearch && !searchOpen) {
                TopBarButton(onClick = {
                    android.util.Log.i("AuroraMenu", "TopBar search click -> open")
                    onSearchOpenChange(true)
                }) {
                    Icon(
                        imageVector = IconSearch,
                        contentDescription = "搜索",
                        tint = if (searchOpen) colors.primary else colors.textSecondary,
                        modifier = Modifier.size(19.dp),
                    )
                }
            }
        }
        // 竖屏标题真居中（M8b 验收反馈三轮：总览页左侧少返回钮，标题被顶偏）——两侧
        // 按钮数量不齐时在轻的一侧补 44dp 占位（与 TopBarButton compact 同宽），使标题
        // weight 盒左右对称：剩余空间居中=屏幕居中。searchOpen 时搜索/更多钮隐藏，计数
        // 随之；平板/横屏不加占位（原形制零回归）。
        val showSearchBtn = showSearch && !searchOpen
        val showMoreBtn = isPhonePortrait && !searchOpen &&
            (showSortMenu || showViewMode || showDateFilter || showTags || showColorSearch)
        val showActionBtn = actionIcon != null && onActionClick != null
        val leftBtnCount = 1 + (if (showBack) 1 else 0)
        val rightBtnCount = if (isPhonePortrait) {
            (if (showSearchBtn) 1 else 0) + (if (showActionBtn) 1 else 0) + (if (showMoreBtn) 1 else 0)
        } else {
            0
        }
        // 配平占位只服务标题居中（searchOpen 时标题已被胶囊替换，占位只会白吃胶囊宽度
        // ——2026-09-27 用户报障：竖屏搜索态输入区只剩占位文字宽的一小条）
        if (isPhonePortrait && !searchOpen) {
            repeat((rightBtnCount - leftBtnCount).coerceAtLeast(0)) {
                Spacer(Modifier.width(44.dp))
            }
        }
        if (!isPhonePortrait) searchButton()
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
                    placeholder = searchPlaceholder,
                    scope = searchScope,
                    onScopeChange = onSearchScopeChange,
                    showScope = showScope,
                    onClose = {
                        onSearchQueryChange("")
                        onSearchOpenChange(false)
                    },
                    aiSearchEnabled = aiSearchEnabled,
                    onAiSearchToggle = onAiSearchToggle,
                    onAiSearchSubmit = onAiSearchSubmit,
                    aiSearchBusy = aiSearchBusy,
                    colorSearchHex = colorSearchHex,
                    onClearColorSearch = onClearColorSearch,
                    onLanSearchSubmit = onLanSearchSubmit,
                )
            }
        }
        if (isPhonePortrait && !searchOpen) {
            repeat((leftBtnCount - rightBtnCount).coerceAtLeast(0)) {
                Spacer(Modifier.width(44.dp))
            }
        }
        if (isPhonePortrait) searchButton()
        if (showSortMenu && !searchOpen && !isPhonePortrait) { // 手机竖屏收进「更多」菜单（1.4）
            var sortAnchor by remember { mutableStateOf(Rect.Zero) }
            Box(Modifier.onGloballyPositioned { sortAnchor = it.boundsInWindow() }) {
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
                // 桌面同款弹出面板（对齐 React 桌面 sortMenu 的 w-48 + panel/90 + border +
                // 大柔和投影 + 小节标题 + 蓝底悬停项）；毛玻璃 = 原生小窗口的窗口级背景模糊
                AuroraDropdown(
                    expanded = sortMenuOpen,
                    anchorBoundsInWindow = sortAnchor,
                    onDismissRequest = { sortMenuOpen = false },
                ) {
                    // 视图自带排序语义时（人物总览）整节换成注入的菜单体；否则走图片排序
                    if (sortMenuContent != null) {
                        sortMenuContent()
                    } else {
                        AuroraMenuHeader("排序方式")
                        sortChoices.forEach { opt ->
                            AuroraMenuItem(
                                text = when (opt) {
                                    SortOption.NAME -> "按名称"
                                    SortOption.DATE -> "按时间"
                                    SortOption.SIZE -> "按大小"
                                },
                                checked = sortBy == opt,
                                onClick = { onSortChange(opt) },
                            )
                        }
                        AuroraMenuDivider()
                        AuroraMenuItem(
                            text = if (sortDirection == SortDirection.ASC) "升序" else "降序",
                            onClick = onSortDirectionToggle,
                            // 升序 = 箭头朝上（React 同款 rotate）
                            trailing = {
                                Icon(
                                    imageVector = IconArrowDownUp,
                                    contentDescription = null,
                                    tint = AuroraTheme.colors.textSecondary,
                                    modifier = Modifier.size(14.dp).rotate(if (sortDirection == SortDirection.ASC) 180f else 0f),
                                )
                            },
                        )
                        if (showGroupBy) {
                            AuroraMenuDivider()
                            AuroraMenuHeader("分组方式")
                            val groupLabels = mapOf(
                                GroupBy.NONE to "无",
                                GroupBy.TYPE to "类型",
                                GroupBy.DATE to "日期",
                            )
                            groupLabels.forEach { (opt, label) ->
                                AuroraMenuItem(
                                    text = label,
                                    checked = groupBy == opt,
                                    onClick = { onGroupByChange(opt) },
                                )
                            }
                        }
                    }
                }
            }
        }
        if (showViewMode && !searchOpen && !isPhonePortrait) {
            TopBarButton(
                onClick = {
                    // 三档循环（2026-09-20 用户要求改回切换式按钮，不弹菜单）：
                    // grid → adaptive → masonry → grid（模式集合 = React isAndroid 分支）
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
                    contentDescription = "视图排布",
                    tint = colors.textSecondary,
                    modifier = Modifier.size(18.dp),
                )
            }
        }
        if (showDateFilter && !searchOpen && !isPhonePortrait) {
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
        if (showTags && !searchOpen && !isPhonePortrait) {
            TopBarButton(
                highlighted = tagsSheetOpen,
                onClick = { tagsSheetOpen = true },
            ) {
                Icon(
                    imageVector = IconTag,
                    contentDescription = "标签筛选",
                    tint = if (tagsSheetOpen) colors.primary else colors.textSecondary,
                    modifier = Modifier.size(18.dp),
                )
            }
        }
        // M6b 阶段 3：取色搜索入口（桌面 ColorPickerPopover 的触屏同位；2026-09-28 起
        // 升级为 HSV 取色器，形态分宿主见 [useRightColorPanel]）。
        // 高亮只随面板/弹层开合（2026-09-28 用户反馈：颜色过滤生效≠功能被启用，按钮
        // 常亮/菜单打勾会被误读成开关态——过滤态由搜索胶囊内的色点芯片展示与清除，
        // 查看器色块入口发起的搜索同样不会点亮这里）。
        // searchOpen 时隐藏：手机屏宽下主 Row 固定图标已把中栏挤到 ~60dp，再留取色按钮
        // SearchPill 会坍缩成圆（实测）。
        if (showColorSearch && !searchOpen && !isPhonePortrait) {
            TopBarButton(
                highlighted = colorPanelActive,
                onClick = {
                    if (useRightColorPanel) onToggleColorPanel() else colorSheetOpen = true
                },
            ) {
                Icon(
                    imageVector = IconPalette,
                    contentDescription = "按颜色搜索",
                    tint = if (colorPanelActive) colors.primary else colors.textSecondary,
                    modifier = Modifier.size(18.dp),
                )
            }
        }
        // M8b 1.4：手机竖屏「更多」菜单（D44）。低频五入口收进一处（React TopBar.tsx:601-602
        // 同位），排序子菜单内容扁平并入；底部弹层类项目点开即收菜单（checked 型项保持
        // 菜单不收，与排序菜单连续调参同口径）。
        if (isPhonePortrait && !searchOpen &&
            (showSortMenu || showViewMode || showDateFilter || showTags || showColorSearch)
        ) {
            Box(Modifier.onGloballyPositioned { moreAnchor = it.boundsInWindow() }) {
                TopBarButton(
                    highlighted = moreMenuOpen,
                    onClick = { moreMenuOpen = !moreMenuOpen },
                ) {
                    Icon(
                        imageVector = IconMoreVertical,
                        contentDescription = "更多",
                        tint = if (moreMenuOpen) colors.primary else colors.textSecondary,
                        // 20dp（M8b 验收反馈：三点字形视觉偏小，比其余 18dp 钮大一号）
                        modifier = Modifier.size(20.dp),
                    )
                }
                AuroraDropdown(
                    expanded = moreMenuOpen,
                    anchorBoundsInWindow = moreAnchor,
                    onDismissRequest = {
                        moreMenuOpen = false
                        moreSubmenu = 0
                    },
                ) {
                    when (moreSubmenu) {
                        // 排序方式二级（M8b 验收反馈：从扁平菜单拆出；含升降序切换）
                        1 -> {
                            AuroraSubmenuHeader("排序方式") { moreSubmenu = 0 }
                            // 竖屏同样接注入位：不接的话人物总览在手机上会整个没有排序入口
                            if (sortMenuContent != null) {
                                sortMenuContent()
                            } else {
                                sortChoices.forEach { opt ->
                                    AuroraMenuItem(
                                        text = when (opt) {
                                            SortOption.NAME -> "按名称"
                                            SortOption.DATE -> "按时间"
                                            SortOption.SIZE -> "按大小"
                                        },
                                        checked = sortBy == opt,
                                        onClick = { onSortChange(opt) },
                                    )
                                }
                                AuroraMenuDivider()
                                AuroraMenuItem(
                                    text = if (sortDirection == SortDirection.ASC) "升序" else "降序",
                                    onClick = onSortDirectionToggle,
                                    trailing = {
                                        Icon(
                                            imageVector = IconArrowDownUp,
                                            contentDescription = null,
                                            tint = AuroraTheme.colors.textSecondary,
                                            modifier = Modifier.size(14.dp)
                                                .rotate(if (sortDirection == SortDirection.ASC) 180f else 0f),
                                        )
                                    },
                                )
                            }
                        }
                        // 分组方式二级
                        2 -> {
                            AuroraSubmenuHeader("分组方式") { moreSubmenu = 0 }
                            val groupLabels = mapOf(
                                GroupBy.NONE to "无",
                                GroupBy.TYPE to "类型",
                                GroupBy.DATE to "日期",
                            )
                            groupLabels.forEach { (opt, label) ->
                                AuroraMenuItem(
                                    text = label,
                                    checked = groupBy == opt,
                                    onClick = { onGroupByChange(opt) },
                                )
                            }
                        }
                        // 主菜单：排序/分组为二级入口（带右箭头），其余直挂
                        else -> {
                            if (showSortMenu) {
                                AuroraMenuItem(
                                    text = "排序方式",
                                    leading = {
                                        Icon(
                                            imageVector = IconArrowDownUp,
                                            contentDescription = null,
                                            tint = AuroraTheme.colors.textSecondary,
                                            modifier = Modifier.size(16.dp),
                                        )
                                    },
                                    trailing = {
                                        Icon(
                                            imageVector = IconChevronRight,
                                            contentDescription = null,
                                            tint = AuroraTheme.colors.textSecondary,
                                            modifier = Modifier.size(14.dp),
                                        )
                                    },
                                    onClick = { moreSubmenu = 1 },
                                )
                                if (showGroupBy) {
                                    AuroraMenuItem(
                                        text = "分组方式",
                                        trailing = {
                                            Icon(
                                                imageVector = IconChevronRight,
                                                contentDescription = null,
                                                tint = AuroraTheme.colors.textSecondary,
                                                modifier = Modifier.size(14.dp),
                                            )
                                        },
                                        onClick = { moreSubmenu = 2 },
                                    )
                                }
                            }
                            if (showViewMode) {
                                AuroraMenuDivider()
                                AuroraMenuItem(
                                    text = "视图：" + when (layoutMode) {
                                        LayoutMode.GRID -> "网格"
                                        LayoutMode.ADAPTIVE -> "自适应"
                                        LayoutMode.MASONRY -> "瀑布流"
                                    },
                                    onClick = {
                                        val cycle = LayoutMode.values()
                                        onLayoutModeChange(cycle[(cycle.indexOf(layoutMode) + 1) % cycle.size])
                                    },
                                    leading = {
                                        Icon(
                                            imageVector = when (layoutMode) {
                                                LayoutMode.GRID -> IconGrid
                                                LayoutMode.ADAPTIVE -> IconLayoutGrid
                                                LayoutMode.MASONRY -> IconLayoutTemplate
                                            },
                                            contentDescription = null,
                                            tint = AuroraTheme.colors.textSecondary,
                                            modifier = Modifier.size(16.dp),
                                        )
                                    },
                                )
                            }
                            if (showDateFilter) {
                                AuroraMenuDivider()
                                AuroraMenuItem(
                                    text = "日期筛选",
                                    checked = dateFilter.start != null,
                                    leading = {
                                        Icon(
                                            imageVector = IconCalendar,
                                            contentDescription = null,
                                            tint = AuroraTheme.colors.textSecondary,
                                            modifier = Modifier.size(16.dp),
                                        )
                                    },
                                    onClick = {
                                        moreMenuOpen = false
                                        moreSubmenu = 0
                                        dateSheetOpen = true
                                    },
                                )
                            }
                            if (showTags) {
                                AuroraMenuDivider()
                                AuroraMenuItem(
                                    text = "标签筛选",
                                    leading = {
                                        Icon(
                                            imageVector = IconTag,
                                            contentDescription = null,
                                            tint = AuroraTheme.colors.textSecondary,
                                            modifier = Modifier.size(16.dp),
                                        )
                                    },
                                    onClick = {
                                        moreMenuOpen = false
                                        moreSubmenu = 0
                                        tagsSheetOpen = true
                                    },
                                )
                            }
                            if (showColorSearch) {
                                AuroraMenuDivider()
                                // 不画选中勾（2026-09-28 用户反馈）：颜色过滤生效≠功能被
                                // 启用，勾会被误读成开关态；过滤态由胶囊色点芯片承担
                                AuroraMenuItem(
                                    text = "按颜色搜索",
                                    leading = {
                                        Icon(
                                            imageVector = IconPalette,
                                            contentDescription = null,
                                            tint = AuroraTheme.colors.textSecondary,
                                            modifier = Modifier.size(16.dp),
                                        )
                                    },
                                    onClick = {
                                        moreMenuOpen = false
                                        moreSubmenu = 0
                                        if (useRightColorPanel) onToggleColorPanel() else colorSheetOpen = true
                                    },
                                )
                            }
                        }
                    }
                }
            }
        }
        // 视图专属动作（M6a 阶段 4：LAN 上传入口）。置灰态降低不透明度、仍可点击（宿主提示）。
        if (actionIcon != null && onActionClick != null) {
            TopBarButton(onClick = onActionClick) {
                Icon(
                    imageVector = actionIcon,
                    contentDescription = actionContentDescription,
                    tint = if (actionEnabled) colors.textSecondary else colors.textSecondary.copy(alpha = 0.35f),
                    modifier = Modifier.size(18.dp),
                )
            }
        }
        if (onOpenSettings != null) {
            TopBarButton(
                onClick = onOpenSettings,
            ) {
                Icon(
                    imageVector = IconSettings2,
                    contentDescription = "设置",
                    tint = colors.textSecondary,
                    modifier = Modifier.size(18.dp),
                )
            }
        }
    }

    if (dateSheetOpen) {
        ModalBottomSheet(
            onDismissRequest = { dateSheetOpen = false },
            containerColor = AuroraTheme.colors.panel,
            // 打开即全展（2026-09-17 用户报障：横屏上半开锚点 ≈ 半屏高，月历下方的
            // 模式 chips 与按钮整段在屏幕外，看起来「被遮挡不完整」；内容本就放得下，
            // React 版 bottom sheet 也是全高。verticalScroll 保留作字体放大后的安全阀）。
            sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        ) {
            DateFilterSheet(
                filter = dateFilter,
                onFilterChange = onDateFilterChange,
                onDone = { dateSheetOpen = false },
            )
        }
    }

    if (tagsSheetOpen) {
        ModalBottomSheet(
            onDismissRequest = { tagsSheetOpen = false },
            containerColor = AuroraTheme.colors.panel,
            // 同日期弹层的教训：内容型弹层打开即全展，否则横屏下半开锚点截断
            sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        ) {
            TagsFilterSheet(
                tagGroups = tagGroups,
                activeTags = activeTags,
                onTagClick = { tag ->
                    onTagClick(tag)
                    tagsSheetOpen = false
                },
                onDone = { tagsSheetOpen = false },
            )
        }
    }

    // 手机形态（竖屏/横屏）的取色弹层：与平板右侧面板同一个内容组合（ColorPickerPanel
    // .ColorPickerPanelContent），只是容器是底部 sheet（2026-09-28 用户要求：手机竖屏
    // 从下方弹起）。弹层每次打开都是新组合，初值直接取当前过滤色。
    if (colorSheetOpen) {
        ModalBottomSheet(
            onDismissRequest = { colorSheetOpen = false },
            containerColor = AuroraTheme.colors.panel,
            // 同日期/标签弹层的教训：内容型弹层打开即全展，否则横屏下半开锚点截断
            sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        ) {
            ColorPickerPanelContent(
                initialHex = colorSearchHex,
                onColorChange = onColorSearch,
                onClose = { colorSheetOpen = false },
                // 内容本身 fillMaxHeight（滚动区靠 weight 撑开，需要确定高度），这里给
                // 80% 屏高上限：手机竖屏弹层不该顶满整屏（React 版当初就是因为
                // bottom sheet 几乎占满屏才改的右侧面板，见 docs/Android/安卓端颜色
                // 搜索与主色调提取优化记录.md §13.1），留下主内容作关闭暗示。
                modifier = Modifier
                    .navigationBarsPadding()
                    .heightIn(max = (LocalConfiguration.current.screenHeightDp * 0.8f).dp),
            )
        }
    }
}

/** 顶栏圆角按钮（React 安卓 `w-10 h-10 rounded-xl hover:bg-surface`；命中区扩到 48dp 触屏最小目标）。 */
@Composable
private fun TopBarButton(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    highlighted: Boolean = false,
    content: @Composable () -> Unit,
) {
    val colors = AuroraTheme.colors
    // 手机窄屏收 44dp：8 个固定图标（M6b 阶段 3 加取色后）在 411dp 屏上会把中栏挤到
    // ~20dp，标题缩略成「…」、SearchPill 坍缩成圆。44dp 视觉 + Compose 的
    // minimumInteractiveComponentSize 自动把命中区扩回 48dp（相邻轻微重叠，可接受）；
    // 平板（≥600dp）保持 48dp 桌面形制。（M8b 1.4 起「更多」合并后竖屏固定图标只剩
    // 侧栏/返回/搜索/更多 4 个；判据收敛 1.1。）
    val compact = com.aurora.gallery.kotlin.ui.isCompactWidth(LocalConfiguration.current)
    Box(
        modifier = modifier
            .size(if (compact) 44.dp else 48.dp)
            .clip(RoundedCornerShape(12.dp))
            .background(if (highlighted) colors.surface else Color.Transparent)
            .clickable(enabled = enabled, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        content()
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
private fun TagsFilterSheet(
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

// ---- 自绘图标：lucide 线性风格（对齐 React 版 lucide-react 图标，24 视口 / 2 线宽 / 圆头）----
// M4c 2.6：builder 上移 [AuroraIcons]（设置页图形化复用同一套画法），此处仅别名转发。

private fun iconBuilder(
    name: String,
    block: androidx.compose.ui.graphics.vector.PathBuilder.() -> Unit,
): ImageVector = auroraIcon(name, block)

// internal：AuroraSubmenuHeader（已拆到 AuroraDropdown.kt，第 17 刀）引用
internal val IconChevronLeft: ImageVector by lazy {
    iconBuilder("ChevronLeft") {
        moveTo(15f, 18f)
        lineTo(9f, 12f)
        lineTo(15f, 6f)
    }
}

// IconChevronRight 已上移 AuroraIcons.kt 共享，本文件直接引用同包共享版本。

/** lucide more-vertical：竖排三点（M8b 1.4 手机竖屏「更多」菜单按钮）。 */
// M8b 验收反馈二轮：三点原用「0.01 单位线段+圆头笔帽」画（同 SelectionBar M4b 反馈前的
// 旧技法），直径 ≈2 视口单位，20dp 下渲染出 ≈1.7dp 的点，用户对比选择栏同款图标偏小。
// 对齐 SelIconMore（r=2 实心圆，直径 4 视口单位 ≈3.3dp），双处「更多」视觉一致。
private val IconMoreVertical: ImageVector by lazy {
    ImageVector.Builder(
        name = "MoreVertical",
        defaultWidth = 24.dp,
        defaultHeight = 24.dp,
        viewportWidth = 24f,
        viewportHeight = 24f,
    ).apply {
        path(fill = SolidColor(Color.Black)) {
            listOf(5f, 12f, 19f).forEach { cy ->
                // 实心圆 r=2：两个 arcTo 半圆拼整圆（NonZero 填充下互不干扰）
                moveTo(10f, cy)
                arcTo(2f, 2f, 0f, false, true, 14f, cy)
                arcTo(2f, 2f, 0f, false, true, 10f, cy)
                close()
            }
        }
    }.build()
}

/** lucide panel-left：面板外框 + 左分隔竖线（侧栏开关，React TopBar 最左按钮同款）。 */
private val IconPanelLeft: ImageVector by lazy {
    iconBuilder("PanelLeft") {
        roundedRect(3f, 3f, 18f, 18f, 2f)
        moveTo(9f, 3f)
        lineTo(9f, 21f)
    }
}

/** lucide tag：标签牌 + 铆点（标签筛选按钮）。 */
// IconTag 已上移 AuroraIcons.kt 共享（2026-09-28 长按菜单图形化顺带收编，几何不变），
// 本文件直接引用同包共享版本。

/** lucide settings-2：双横线 + 双旋钮（设置入口，M4c 横屏手机顶栏兜底）。 */
private val IconSettings2: ImageVector by lazy {
    iconBuilder("Settings2") {
        moveTo(20f, 7f)
        lineTo(11f, 7f)
        moveTo(14f, 17f)
        lineTo(5f, 17f)
        // circle(17, 6, r=3)
        moveTo(14f, 6f)
        arcTo(3f, 3f, 0f, true, true, 20f, 6f)
        arcTo(3f, 3f, 0f, true, true, 14f, 6f)
        // circle(7, 17, r=3)
        moveTo(4f, 17f)
        arcTo(3f, 3f, 0f, true, true, 10f, 17f)
        arcTo(3f, 3f, 0f, true, true, 4f, 17f)
    }
}

// internal：SearchPill.kt 与筛选 Sheet（第 19 刀）共用（第 18 刀降权）
internal val IconSearch: ImageVector by lazy {
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

// internal：SearchPill.kt 与筛选 Sheet（第 19 刀）共用（第 18 刀降权）
internal val IconX: ImageVector by lazy {
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

// IconLayoutGrid / IconLayoutTemplate（视图排布按钮的自适应/瀑布流档）已上移
// AuroraIcons.kt 共享（M4c 2.6），本文件直接引用同包共享版本。
