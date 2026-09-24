package com.aurora.gallery.kotlin.ui.components

import androidx.compose.animation.core.EaseOut
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.keyframes
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.wrapContentWidth
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
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
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.path
import androidx.compose.ui.layout.layout
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.aurora.gallery.kotlin.ui.theme.AuroraTheme
import kotlin.math.roundToInt
import uniffi.aurora_core.Folder
import uniffi.aurora_core.TagGroup

/**
 * 左侧数据面板（3.4 侧栏 / 3.5 面板开合，对齐 React `SidebarPane.tsx` + `TreeSidebar.tsx`）。
 *
 * [SidebarPane] = 开合动画壳：对齐 React 同名组件的「外层 width 16rem↔0 + 内层固定宽
 * translateX(-100%)」推挤式动画——宽度收缩把右侧内容（含 TopBar）同步推开，内容层只
 * 平移不重排（React 用 willChange:transform 常驻合成层避免逐帧重绘，Compose 的
 * graphicsLayer 同效），300ms ease-out（§9.1：面板开合动画参数与捏合 FLIP 的 240ms
 * 是两套，勿混用）。进度到 0 时不组合内容，开合结束即释放。
 *
 * [TreeSidebar] = 六 Section 骨架（矩阵表 2：三端全部保留；内容按里程碑逐步填充）：
 * 专题 / 本地相册(文件夹) / 网络 / 人物 / 标签 / 画布。
 *
 * **展开语义（2026-09-20 用户要求，对齐桌面）**：只有真正有列表内容的 Section 才有
 * 展开——本地相册 / 人物 / 标签；专题、画布、网络（未连接）**没有展开按钮**（chevron
 * 用 opacity-0 占位保持对齐，桌面 TopicSection/CanvasSection 同款），行本身也不可点
 * （桌面点击是导航到对应视图，M1 尚无这些视图）。`activeSection` 互斥展开，初始展开
 * 文件夹（对齐 React `setActiveSection(prev => prev === x ? null : x)`）。
 *
/**
 * **头部点击语义（M4a 3.2 起，对齐桌面）**：本地相册头部点击 = 回主界面（React
 * onNavigateHome）；人物/标签头部行主体点击 = 进对应总览（React
 * onNavigateAllPeople / onNavigateAllTags，3.2），展开/收起只走 chevron 独立命中区
 * （40×52dp）；专题 M4a 3.2 后半接总览，当前整行不可点。
 *
 * **选中态（对齐桌面 isSelected）**：本地相册 = 未进任何文件夹（根）；人物/标签 =
 * 正处于对应总览视图，底色按 Section 各自的彩（桌面 PeopleSection 紫 #a855f7、
 * TagSection 蓝 = 全局 primary），不再是同一把蓝。
 */
 *
 * **滚动结构（2026-09-20 用户报障「展开子文件夹能把整个面板都滚走」）**：对齐 React
 * 版侧栏——外层 Column **不可滚动**（React 根节点 `overflow-hidden`），Section 头恒定
 * 可见；展开分区的列表自己内部滚动，高度用 `weight(1f, fill = false)` 封顶 = 面板高
 * − 全部固定 Section 的剩余空间（React 的 listCap 实测逻辑同义），内容不足时只占内容
 * 高。互斥展开保证任意时刻至多一个加权列表存在。
 *
 * 数据来源与对应展示（M4a 3.1 起）：
 *  - 本地相册：MediaStore bucket 扁平列表（真实数据），点击进文件夹（复用 openFolder
 *    历史导航），当前文件夹蓝底白字高亮（对齐 React 树节点 `bg-blue-600 text-white`），
 *    选中行文件名超宽时**来回滚动**展示全名（对齐 React MarqueeText，见 [MarqueeText]）；
 *    **总览态（currentFolderId == null）头部自身高亮**（对齐 React FolderSection 的
 *    `isSelected = 单根 && currentFolderId === 根`）；头部**不显示计数**（React
 *    FolderSection 头部本就无计数；人物/标签保留）；
 *  - 标签：Rust `get_grouped_tags` 的分组 + 计数（[tagGroups]），顺序原样渲染、UI 不再
 *    排第二遍；点击行 = 单选替换筛选（[onTagClick]）；
 *  - 人物：数据源在 M6（人脸识别 / AI 打标 / 互联态读桌面库），本轮只有空态文案；
 *  - 网络 M6、专题与画布见规划 §6 的归属。
 *
 * 视觉参数对齐 React 的 `isAndroid` 分支（WebView 安卓端形态）：Section 头 52dp、
 * 水平外距 12dp（React `margin: '0 12px'`）+ 圆角 8dp 底、图标 18dp、标题 14sp 粗体
 * （React `text-sm font-bold`）、Section 间 8dp（React `mt-2`）；灰阶用桌面同款
 * text-gray-500/600/400 而非全局 token（桌面树文案比 token 更浅，见各常量注释）。
 * 文件夹行图标缩进 = Section 图标 + 4dp（对齐桌面树节点与头部图标的 +4px 关系）。
 */
/** 侧栏宽度（React w-64 = 16rem；设计约定无对应 token，直接取同值）。 */
val SIDEBAR_WIDTH_DP = 256.dp

/** 面板开合动画时长（React SidebarPane `width 300ms ease-out`；与捏合 FLIP 240ms 是两套）。 */
internal const val PANEL_ANIMATE_MS = 300

/**
 * [SidebarPane] = 开合动画壳：对齐 React 同名组件的「外层 width 16rem↔0 + 内层固定宽
 * translateX(-100%)」推挤式动画——宽度收缩把右侧内容（含 TopBar）同步推开，内容层只
 * 平移不重排，300ms ease-out（§9.1：面板开合动画参数与捏合 FLIP 的 240ms 是两套，
 * 勿混用）。
 *
 * **性能关键（2026-09-20 真机 15fps 卡顿的教训）**：动画进度**只在自定义 layout 的
 * 测量块里读取**（layout 阶段订阅，不进组合 → 动画期间零重组），且内容恒按**全宽**
 * 测量（约束逐帧恒定 → Compose 复用测量缓存，侧栏文字/图标零重排）。首版用
 * `Modifier.width(全宽×进度)` 逐帧改约束、内层 `width(256.dp)` 又被父约束压缩，
 * 等于每帧全量重排侧栏文本——模拟器上被宿主机性能掩盖，真机只有约 15fps。
 *
 * **内容常驻不卸载（2026-09-20 二轮真机反馈）**：曾做「收起后卸载内容」，结果展开
 * 要从零组合整棵侧栏树，首帧巨重——表现为「按下后侧栏不立即展开」，而收起因内容
 * 本就在组合里故即时，方向不对称。改为组合一次后常驻（收起态由 0 宽裁剪隐藏），
 * 开/收都只是动画目标值翻转，即点即动。
 */
@Composable
fun SidebarPane(
    visible: Boolean,
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit,
) {
    val colors = AuroraTheme.colors
    val density = LocalDensity.current
    val fullWidthPx = remember(density) { with(density) { SIDEBAR_WIDTH_DP.roundToPx() } }

    // 首次组合即目标值（animateFloatAsState 初值 = 首个 target）：横屏初始展开不播动画，
    // 与 LayoutVisibility 的「横屏开侧栏」初始值配套
    val progress = animateFloatAsState(
        targetValue = if (visible) 1f else 0f,
        animationSpec = tween(durationMillis = PANEL_ANIMATE_MS, easing = EaseOut),
        label = "sidebarProgress",
    )

    Box(
        modifier
            .fillMaxHeight()
            .clipToBounds()
            .layout { measurable, constraints ->
                val p = progress.value
                val width = (fullWidthPx * p).roundToInt()
                // 内容恒按全宽测量：测量约束逐帧不变，深度测量命中缓存跳过
                val placeable = measurable.measure(
                    constraints.copy(minWidth = fullWidthPx, maxWidth = fullWidthPx),
                )
                layout(width, constraints.maxHeight) {
                    // 与 React 同款：内容左移 (1-p)·全宽，右缘随 width 收缩裁剪
                    placeable.placeRelative(x = width - fullWidthPx, y = 0)
                }
            }
            .background(colors.panel),
    ) {
        content()
    }
}

/**
 * 可互斥展开的 Section（M6a 阶段 3 起：网络在 connected 时恢复展开语义——承载远端
 * 目录树入口（D31：网络栏只管本地/网络文件夹区分，标签/人物/专题的远端条目在各自
 * Section）；未连接/专题/画布不参与展开）。
 */
private enum class SidebarSection { FOLDERS, NETWORK, PEOPLE, TAGS }

/** 文件夹排序（侧栏头部循环切换，4 态对齐 React handleToggleFolderSort 的循环序）。 */
private enum class FolderSort(val label: String) {
    NAME_ASC("名称"), NAME_DESC("名称"), DATE_DESC("时间"), DATE_ASC("时间");
}

@Composable
fun TreeSidebar(
    folders: List<Folder>,
    currentFolderId: String?,
    onFolderClick: (Folder) -> Unit,
    onNavigateHome: () -> Unit = {},
    /**
     * 标签分组 + 计数，Rust `get_grouped_tags` 的原样返回。**组的先后、组内标签的先后
     * 都以它为准**，UI 侧不再排第二遍（清单 §1「排序规则只许有一套」）。这里必须是
     * `List` 而不是 `Map`——Kotlin 的 Map 不保序，用 Map 传就等于把顺序丢了再让 UI 猜。
     */
    tagGroups: List<TagGroup> = emptyList(),
    /** 当前生效的标签筛选（单选替换，见 `AppState.toggleTagFilter`）。 */
    activeTags: List<String> = emptyList(),
    onTagClick: (String) -> Unit = {},
    /** 人物 Section 头部行主体点击 = 进人物总览（M4a 3.2，对齐 React onNavigateAllPeople）。 */
    onPeopleOverviewClick: () -> Unit = {},
    /** 标签 Section 头部行主体点击 = 进标签总览（对齐 React onNavigateAllTags）。 */
    onTagsOverviewClick: () -> Unit = {},
    /** 专题 Section 整行点击 = 进专题总览（M4a 3.2，对齐桌面 TopicSection onNavigateTopics）。 */
    onTopicsOverviewClick: () -> Unit = {},
    /** 正处于人物/标签/专题总览视图（对应 Section 头部按各自的彩高亮）。 */
    peopleOverviewSelected: Boolean = false,
    tagsOverviewSelected: Boolean = false,
    topicsOverviewSelected: Boolean = false,
    /**
     * 正处于文件夹总览（`ViewMode.FOLDERS_OVERVIEW`）。本地相册头部的「根选中」必须是
     * 「folderId == null **且** 在总览」两个条件同时成立——4.1 起标签筛选视图 folderId
     * 也是 null（跨文件夹的全库标签结果），只看前者会跟人物/标签总览的高亮同屏双亮。
     */
    foldersOverviewSelected: Boolean = false,
    /**
     * 正处于文件夹内部（`ViewMode.BROWSER`）。文件夹行的选中高亮以此为开关：
     * `openOverview` 按 React 语义保留 folderId（返回时回到原文件夹），但人已经在
     * 专题/标签总览里，行再亮着就会跟专题粉/标签蓝同屏双亮（3.2 验收反馈 ②）。
     */
    browserActive: Boolean = false,
    /** 画布 Section 头部行主体点击 = 进画布视图（M5；平板专属，见 showCanvas）。 */
    onCanvasClick: (() -> Unit)? = null,
    /** 正处于画布视图（Section 头部按画布绿高亮）。 */
    canvasSelected: Boolean = false,
    /**
     * 画布行显隐（M5 D28）：画布是平板专属能力，手机侧栏不渲染这一行
     * （判定在宿主：宽 ≥600dp 且高 ≥480dp）。
     */
    showCanvas: Boolean = true,
    /** 设置行点击（M4b 2.1；面板由宿主承载）。 */
    onSettingsClick: (() -> Unit)? = null,
    // —— M6a 阶段 3：网络 Section 的连接态（宿主把 LanManager.snapshot 的 StateFlow
    //    collect 成普通值传入，不轮询）——
    /** LAN 会话已连接（CONNECTED）。决定 Wifi 图标/可展开与远端目录列表显隐。 */
    lanConnected: Boolean = false,
    /** 远端含图目录（allImageFolders 结果，原样渲染；排序在数据层/Rust 同口径不重排）。 */
    lanFolders: List<com.aurora.gallery.kotlin.LanRemoteFolder> = emptyList(),
    /** 远端目录行点击（阶段 4 的 LAN 总览入口；本阶段宿主给 Toast 占位）。 */
    onLanFolderClick: (com.aurora.gallery.kotlin.LanRemoteFolder) -> Unit = {},
    modifier: Modifier = Modifier,
) {
    var activeSection by remember { mutableStateOf<SidebarSection?>(SidebarSection.FOLDERS) }
    var folderSort by remember { mutableStateOf(FolderSort.NAME_ASC) }

    val sortedFolders = remember(folders, folderSort) {
        when (folderSort) {
            FolderSort.NAME_ASC -> folders.sortedBy { it.name.lowercase() }
            FolderSort.NAME_DESC -> folders.sortedByDescending { it.name.lowercase() }
            FolderSort.DATE_DESC -> folders.sortedByDescending { it.modifiedAt }
            FolderSort.DATE_ASC -> folders.sortedBy { it.modifiedAt }
        }
    }
    // Section 头部的计数 = 词表里的标签条数（React 侧栏 TagSection 头部同口径）
    val tagCount = tagGroups.sumOf { it.tags.size }

    Column(
        modifier
            .fillMaxHeight()
            .width(SIDEBAR_WIDTH_DP)
            .padding(top = 10.dp, bottom = 16.dp),
    ) {
        // 专题：M4a 3.2 起整行可点 = 进专题总览（对齐桌面 TopicSection 的 onNavigateTopics，
        // 无展开语义；行尾的 + 新建入口在总览页内常驻——触屏没有 hover）
        SectionHeader(
            title = "专题",
            icon = IconLayout,
            iconTint = SECTION_PINK,
            expanded = false,
            onClick = onTopicsOverviewClick,
            expandable = false,
            selected = topicsOverviewSelected,
            selectedColor = TOPIC_SELECT_PINK,
        )

        // React 各 Section 容器 mt-2（首个除外）：Section 间 8dp 空隙
        Spacer(Modifier.height(8.dp))
        SectionHeader(
            title = "本地相册",
            icon = IconHardDrive,
            iconTint = SECTION_BLUE,
            expanded = activeSection == SidebarSection.FOLDERS,
            // 总览态 = 桌面的「根目录选中」：头部蓝底白字。必须同时要求真的在总览视图
            //（见参数注释：标签筛选视图 folderId 同为 null）
            selected = currentFolderId == null && foldersOverviewSelected,
            // 头部点击 = 回主界面（2026-09-20 用户要求，对齐 React onNavigateHome）；
            // 展开/收起只走 chevron 独立命中区
            onClick = onNavigateHome,
            onChevronClick = {
                activeSection = if (activeSection == SidebarSection.FOLDERS) null else SidebarSection.FOLDERS
            },
            trailing = {
                SortCycleButton(
                    sort = folderSort,
                    selected = currentFolderId == null && foldersOverviewSelected,
                    onClick = {
                        // 名称升 → 名称降 → 时间降 → 时间升 → 名称升（对齐 React 循环序）
                        folderSort = when (folderSort) {
                            FolderSort.NAME_ASC -> FolderSort.NAME_DESC
                            FolderSort.NAME_DESC -> FolderSort.DATE_DESC
                            FolderSort.DATE_DESC -> FolderSort.DATE_ASC
                            FolderSort.DATE_ASC -> FolderSort.NAME_ASC
                        }
                    },
                )
            },
        )
        if (activeSection == SidebarSection.FOLDERS) {
            if (sortedFolders.isEmpty()) {
                EmptyHint("暂无文件夹")
            } else {
                // 分区内滚动（对齐 React 列表容器的 maxHeight + overflow-y-auto）：
                // weight(fill=false) 封顶到「面板高 − 其余固定 Section」，内容不足时只占内容高
                Column(
                    Modifier
                        .weight(1f, fill = false)
                        .verticalScroll(rememberScrollState())
                        .clipToBounds(),
                ) {
                    sortedFolders.forEach { folder ->
                        FolderRow(
                            folder = folder,
                            selected = browserActive && folder.id == currentFolderId,
                            onClick = { onFolderClick(folder) },
                        )
                    }
                }
            }
        }

        Spacer(Modifier.height(8.dp))
        // 网络（M6a 阶段 3 接通）：connected → Wifi 图标 + 可展开，展开显示远端目录列表
        //（行点击=阶段 4 的 LAN 总览，本阶段 Toast 占位）；未连接维持 M1 骨架
        //（WifiOff 灰、无展开按钮，2026-09-20 用户要求）。
        val lanExpandable = lanConnected
        SectionHeader(
            title = "网络",
            icon = if (lanConnected) IconWifi else IconWifiOff,
            iconTint = if (lanConnected) SECTION_EMERALD else SECTION_GRAY,
            expanded = lanExpandable && activeSection == SidebarSection.NETWORK,
            onClick = null,
            expandable = lanExpandable,
            onChevronClick = if (lanExpandable) {
                {
                    activeSection =
                        if (activeSection == SidebarSection.NETWORK) null else SidebarSection.NETWORK
                }
            } else {
                null
            },
        )
        if (lanConnected && activeSection == SidebarSection.NETWORK) {
            if (lanFolders.isEmpty()) {
                EmptyHint("暂无共享目录")
            } else {
                Column(
                    Modifier
                        .weight(1f, fill = false)
                        .verticalScroll(rememberScrollState())
                        .clipToBounds(),
                ) {
                    lanFolders.forEach { folder ->
                        LanFolderRow(folder = folder, onClick = { onLanFolderClick(folder) })
                    }
                }
            }
        }

        Spacer(Modifier.height(8.dp))
        SectionHeader(
            title = "人物",
            icon = IconBrain,
            iconTint = SECTION_PURPLE,
            count = 0,
            expanded = activeSection == SidebarSection.PEOPLE,
            // 行主体点击 = 进人物总览（3.2，对齐桌面 onNavigateAllPeople）；展开只走 chevron
            onClick = onPeopleOverviewClick,
            onChevronClick = {
                activeSection = if (activeSection == SidebarSection.PEOPLE) null else SidebarSection.PEOPLE
            },
            selected = peopleOverviewSelected,
            selectedColor = SECTION_PURPLE,
        )
        if (activeSection == SidebarSection.PEOPLE) {
            EmptyHint("暂无人物")
        }

        Spacer(Modifier.height(8.dp))
        SectionHeader(
            title = "标签",
            icon = IconTagBadge,
            iconTint = SECTION_BLUE,
            count = tagCount,
            expanded = activeSection == SidebarSection.TAGS,
            // 行主体点击 = 进标签总览（对齐桌面 onNavigateAllTags）；展开只走 chevron
            onClick = onTagsOverviewClick,
            onChevronClick = {
                activeSection = if (activeSection == SidebarSection.TAGS) null else SidebarSection.TAGS
            },
            selected = tagsOverviewSelected,
        )
        if (activeSection == SidebarSection.TAGS) {
            if (tagGroups.isEmpty()) {
                EmptyHint("暂无标签")
            } else {
                Column(
                    Modifier
                        .weight(1f, fill = false)
                        .verticalScroll(rememberScrollState())
                        .clipToBounds(),
                ) {
                    // 分组结构照搬 Rust 的返回：组名一行不可点的分隔标题，组内是标签行
                    tagGroups.forEach { group ->
                        TagGroupHeader(group.key)
                        group.tags.forEach { entry ->
                            TagRow(
                                tag = entry.tag,
                                count = entry.count,
                                selected = entry.tag in activeTags,
                                onClick = { onTagClick(entry.tag) },
                            )
                        }
                    }
                }
            }
        }

        Spacer(Modifier.height(8.dp))
        // 画布：入口可点进画布视图（无展开语义，对齐桌面 CanvasSection）；
        // 手机不渲染（D28 平板专属，M5）
        if (showCanvas) {
            SectionHeader(
                title = "画布",
                icon = IconScanMidline,
                iconTint = SECTION_EMERALD,
                expanded = false,
                onClick = onCanvasClick,
                selected = canvasSelected,
                selectedColor = SECTION_EMERALD,
                expandable = false,
            )
        }

        Spacer(Modifier.height(8.dp))
        // 设置（M4b 2.1）：入口在侧栏底部（React 在工具栏齿轮，触屏收敛到侧栏避免
        // TopBar 过挤）；无展开语义
        SectionHeader(
            title = "设置",
            icon = IconSettings,
            iconTint = AuroraTheme.colors.textSecondary,
            expanded = false,
            onClick = onSettingsClick,
            expandable = false,
        )
    }
}

/**
 * Section 头部（React 各 Section 头的通用形制）：水平外距 12dp（React `margin: '0 12px'`）
 * + 圆角 8dp 可点区（React `rounded-lg`）、高 52dp（触屏；React 安卓分支 55px 同量级）、
 * chevron + 彩色 Section 图标（18dp）+ 大写粗体灰字标题（14sp）+ 计数 + 尾部操作位。
 * 图标与配色逐一对应桌面端 TreeSidebar——专题 Layout 粉、本地相册 HardDrive 蓝、
 * 网络 WifiOff 灰（断连态）、人物 Brain 紫、标签 Tag 蓝、画布 Scan 绿。
 *
 * [selected] = 该 Section 处于「根选中」态（React 头部 `bg-blue-600 text-white` 同形）：
 * 底色取 [selectedColor]（null = 全局 primary 蓝；人物紫、专题粉各自传），文字/图标/
 * chevron 一并变白。
 *
 * [expandable] = false 时没有展开语义（专题/画布/未连接的网络，2026-09-20 用户要求）：
 * chevron 以 opacity-0 占位保持对齐（桌面 TopicSection/CanvasSection 同款）。
 * [onClick] = 行主体点击（null = 行不可点，无涟漪）；[onChevronClick] 非空时 chevron
 * 有 40×52dp 独立命中区（桌面 expand-icon 分区点击同款），展开/收起走它而不走行点击。
 */
@Composable
private fun SectionHeader(
    title: String,
    icon: ImageVector,
    iconTint: Color,
    expanded: Boolean,
    onClick: (() -> Unit)?,
    count: Int? = null,
    selected: Boolean = false,
    selectedColor: Color? = null,
    expandable: Boolean = true,
    onChevronClick: (() -> Unit)? = null,
    trailing: (@Composable () -> Unit)? = null,
) {
    val colors = AuroraTheme.colors
    val selectionBg = selectedColor ?: colors.primary
    Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp)) {
        Row(
            Modifier
                .fillMaxWidth()
                .height(52.dp)
                .clip(RoundedCornerShape(8.dp))
                .background(if (selected) selectionBg else Color.Transparent)
                .then(
                    if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier,
                )
                .padding(start = 8.dp, end = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            // chevron 命中区：40×52dp（触屏最小目标），居中放置 18dp 图标——图标起点
            // 由此落在 8+40 = 48dp，与后续 Section 图标对齐
            Box(
                Modifier
                    .width(40.dp)
                    .height(52.dp)
                    .then(
                        if (expandable && onChevronClick != null) {
                            Modifier.clickable(onClick = onChevronClick)
                        } else {
                            Modifier
                        },
                    ),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    imageVector = IconChevronDown,
                    contentDescription = null,
                    // 非选中 chevron = React 继承自容器的 text-gray-600；选中态随头部变白
                    tint = if (selected) Color.White else SIDEBAR_GRAY_600,
                    // 收起 = 朝右（-90°），展开 = 朝下（对齐 React ChevronRight/ChevronDown 切换）；
                    // 不可展开的 Section 用 opacity-0 占位（对齐桌面）
                    modifier = Modifier
                        .size(18.dp)
                        .graphicsLayer { alpha = if (expandable) 1f else 0f }
                        .rotate(if (expanded) 0f else -90f),
                )
            }
            Icon(
                imageVector = icon,
                contentDescription = null,
                tint = if (selected) Color.White else iconTint,
                modifier = Modifier.size(18.dp),
            )
            Spacer(Modifier.size(10.dp))
            Text(
                title,
                // React 安卓分支 text-sm font-bold tracking-wider text-gray-500
                fontSize = 14.sp,
                fontWeight = FontWeight.Bold,
                letterSpacing = 1.sp,
                color = if (selected) Color.White else SIDEBAR_GRAY_500,
            )
            if (count != null) {
                Spacer(Modifier.size(4.dp))
                Text(
                    "($count)",
                    fontSize = 14.sp,
                    fontWeight = FontWeight.Bold,
                    color = if (selected) Color.White else SIDEBAR_GRAY_500,
                )
            }
            Spacer(Modifier.weight(1f))
            if (trailing != null) {
                trailing()
            }
        }
    }
}

/**
 * 文件夹行（React 树节点：Folder 图标 + 名称；选中 = 蓝底白字圆角，React `bg-blue-600
 * text-white rounded-lg`；未选中文字 text-gray-600）。缩进：图标起点 = Section 图标
 * +4dp（对齐桌面树节点与头部图标的 +4px 层级关系），名称与头部标题左缘基本对齐。
 * 整行 48dp 触控目标。
 */
@Composable
private fun FolderRow(folder: Folder, selected: Boolean, onClick: () -> Unit) {
    val colors = AuroraTheme.colors
    Row(Modifier.padding(horizontal = 12.dp, vertical = 1.dp)) {
        Row(
            Modifier
                .fillMaxWidth()
                .height(48.dp)
                .clip(RoundedCornerShape(8.dp))
                .background(if (selected) colors.primary else Color.Transparent)
                .clickable(onClick = onClick)
                .padding(start = 40.dp, end = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                imageVector = IconFolder,
                contentDescription = null,
                tint = if (selected) Color.White else colors.primary,
                modifier = Modifier.size(18.dp),
            )
            Spacer(Modifier.size(10.dp))
            MarqueeText(
                text = folder.name,
                // 选中行文件名超宽时来回滚动展示全名（React 树节点 MarqueeText active=isSelected）
                active = selected,
                color = if (selected) Color.White else SIDEBAR_GRAY_600,
                fontSize = 14.sp,
                modifier = Modifier.weight(1f),
            )
        }
    }
}

/**
 * 远端目录行（网络 Section 展开列表，M6a 阶段 3）：形态对齐 [FolderRow]（48dp 触屏
 * 目标、图标缩进同层级），图标/文字用网络翡翠与更浅灰区分本地来源（D31：网络栏只
 * 区分本地/网络文件夹）。点击行为是阶段 4 的 LAN 总览，本阶段由宿主 Toast 占位。
 */
@Composable
private fun LanFolderRow(
    folder: com.aurora.gallery.kotlin.LanRemoteFolder,
    onClick: () -> Unit,
) {
    val colors = AuroraTheme.colors
    Row(Modifier.padding(horizontal = 12.dp, vertical = 1.dp)) {
        Row(
            Modifier
                .fillMaxWidth()
                .height(48.dp)
                .clip(RoundedCornerShape(8.dp))
                .clickable(onClick = onClick)
                .padding(start = 40.dp, end = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                imageVector = IconFolder,
                contentDescription = null,
                tint = SECTION_EMERALD,
                modifier = Modifier.size(18.dp),
            )
            Spacer(Modifier.size(10.dp))
            Text(
                folder.name,
                fontSize = 14.sp,
                color = SIDEBAR_GRAY_600,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            if (folder.imageCount > 0) {
                Spacer(Modifier.size(8.dp))
                Text(
                    folder.imageCount.toString(),
                    fontSize = 10.sp,
                    color = SIDEBAR_GRAY_500,
                    modifier = Modifier
                        .clip(RoundedCornerShape(8.dp))
                        .background(colors.surface)
                        .padding(horizontal = 6.dp, vertical = 1.dp),
                )
            }
        }
    }
}

/**
 * 侧栏行文本（对齐 React `MarqueeText.tsx`）：
 *  - 未激活（[active] = false）或未溢出：普通截断显示省略号，零动画开销；
 *  - 激活且内容超宽：**来回滚动**展示全名——桌面 keyframes 为 ease-in-out alternate、
 *    两端各驻留 12%、时长 = 溢出量 / 32px·s（clamp 3.5~12s），此处逐项对齐
 *    （溢出量换算为 dp 后计算，与 CSS px 同尺度）。
 *
 * 溢出检测：全名宽度用 **TextMeasurer 无约束测量**——Text 自身会被父容器宽度钳住，
 * 直接量 Text 得到的恒为容器宽、溢出恒为 0（桌面靠 scrollWidth 拿完整内容宽度，
 * Compose 等价物就是无约束测量）；容器宽由外层 Box 的 onSizeChanged 上报。
 * 滚动态的 Text 用 wrapContentWidth(unbounded) 让全名完整排版、由外层 Box 裁剪，
 * translationX 来回平移。
 */
@Composable
private fun MarqueeText(
    text: String,
    active: Boolean,
    color: Color,
    fontSize: TextUnit,
    modifier: Modifier = Modifier,
) {
    val density = LocalDensity.current
    val textMeasurer = rememberTextMeasurer()
    var containerWidthPx by remember { mutableIntStateOf(0) }
    val textWidthPx = remember(text, fontSize, textMeasurer) {
        textMeasurer.measure(
            text = text,
            style = TextStyle(fontSize = fontSize),
            maxLines = 1,
            softWrap = false,
            constraints = Constraints(),
        ).size.width
    }
    val overflowPx = textWidthPx - containerWidthPx
    val scrolling = active && overflowPx > 0

    Box(modifier.clipToBounds().onSizeChanged { containerWidthPx = it.width }) {
        if (scrolling) {
            // 溢出 dp / 32px·s，对齐桌面 MarqueeText speed=32、clamp(3.5s, 12s)
            val durationMs = with(density) {
                ((overflowPx.toDp().value / 32f).coerceIn(3.5f, 12f) * 1000).toInt()
            }
            val target = -overflowPx.toFloat()
            val shift = rememberInfiniteTransition(label = "marquee").animateFloat(
                initialValue = 0f,
                targetValue = target,
                animationSpec = infiniteRepeatable(
                    animation = keyframes {
                        durationMillis = durationMs
                        0f at 0
                        // 两端各驻留 12%（桌面 keyframes 的 0%/12% 与 88%/100% 驻留段）
                        0f at durationMs * 12 / 100
                        target at durationMs * 88 / 100 using FastOutSlowInEasing
                        target at durationMs
                    },
                    repeatMode = RepeatMode.Reverse,
                ),
                label = "marqueeShift",
            )
            Text(
                text,
                color = color,
                fontSize = fontSize,
                maxLines = 1,
                softWrap = false,
                // 全名完整排版（实际裁剪由外层 Box 的 clipToBounds 负责）
                overflow = TextOverflow.Clip,
                modifier = Modifier
                    .wrapContentWidth(align = Alignment.Start, unbounded = true)
                    .graphicsLayer { translationX = shift.value },
            )
        } else {
            Text(
                text,
                color = color,
                fontSize = fontSize,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

/**
 * 分组标题行（A…Z / #）。React 那边组名出现在顶栏标签弹层（`TopBar.tsx:224`）与标签总览
 * （`TagsList.tsx:219`）两处，都是**不可点**的分隔标题，这里同口径。
 */
@Composable
private fun TagGroupHeader(key: String) {
    Text(
        key,
        Modifier
            .fillMaxWidth()
            .padding(start = 28.dp, top = 10.dp, bottom = 2.dp, end = 12.dp),
        fontSize = 11.sp,
        fontWeight = FontWeight.Bold,
        letterSpacing = 1.sp,
        color = SIDEBAR_GRAY_400,
    )
}

/**
 * 标签行（React 侧栏 TagSection 的行形态：Tag 图标 + 名称 + 右侧计数徽标，
 * `TreeSidebar.tsx:778-786`）。选中态与文件夹行同一套（蓝底白字），计数徽标在选中时
 * 换半透明白底保持可读；计数为 0 = 只在词表里、还没贴到任何文件上，照样出行（同 React，
 * 它就是要给「先建词后贴图」留位置）。整行 48dp 触控目标。
 */
@Composable
private fun TagRow(tag: String, count: Long, selected: Boolean, onClick: () -> Unit) {
    val colors = AuroraTheme.colors
    Row(Modifier.padding(horizontal = 12.dp, vertical = 1.dp)) {
        Row(
            Modifier
                .fillMaxWidth()
                .height(48.dp)
                .clip(RoundedCornerShape(8.dp))
                .background(if (selected) colors.primary else Color.Transparent)
                .clickable(onClick = onClick)
                .padding(start = 16.dp, end = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                imageVector = IconTagSmall,
                contentDescription = null,
                tint = if (selected) Color.White else SIDEBAR_GRAY_600,
                modifier = Modifier.size(12.dp),
            )
            Spacer(Modifier.size(8.dp))
            Text(
                tag,
                fontSize = 14.sp,
                color = if (selected) Color.White else SIDEBAR_GRAY_600,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            Spacer(Modifier.size(8.dp))
            Text(
                count.toString(),
                fontSize = 10.sp,
                color = if (selected) Color.White else SIDEBAR_GRAY_500,
                modifier = Modifier
                    .clip(RoundedCornerShape(8.dp))
                    .background(
                        if (selected) Color.White.copy(alpha = 0.25f) else colors.surface
                    )
                    .padding(horizontal = 6.dp, vertical = 1.dp),
            )
        }
    }
}

/** 空态提示（React 各 Section 的 `text-xs text-gray-400 italic`）。 */
@Composable
private fun EmptyHint(text: String) {
    Text(
        text,
        Modifier.padding(start = 40.dp, top = 4.dp, bottom = 8.dp),
        fontSize = 12.sp,
        fontStyle = FontStyle.Italic,
        color = SIDEBAR_GRAY_400,
    )
}

/**
 * 排序循环按钮（React FolderSection 头部的排序图标；图标随方向翻转示意降序）。
 * 命中区 48dp（行高 52dp 内的触屏最小目标）；[selected] 时图标随头部变白
 * （React `isSelected ? 'text-white/80' : 'text-gray-400'`）。
 */
@Composable
private fun SortCycleButton(sort: FolderSort, onClick: () -> Unit, selected: Boolean = false) {
    val colors = AuroraTheme.colors
    val descending = sort == FolderSort.NAME_DESC || sort == FolderSort.DATE_DESC
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    Box(
        Modifier
            .size(48.dp)
            .clip(RoundedCornerShape(8.dp))
            .background(if (pressed) colors.surface else Color.Transparent)
            .clickable(interactionSource = interaction, indication = null, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            imageVector = IconArrowUpDown,
            contentDescription = "排序：${sort.label}${if (descending) "降序" else "升序"}",
            tint = when {
                selected -> Color.White.copy(alpha = 0.8f)
                pressed -> colors.primary
                else -> SIDEBAR_GRAY_400
            },
            modifier = Modifier.size(18.dp).rotate(if (descending) 180f else 0f),
        )
    }
}

// ---- 自绘图标：lucide 线性风格（与 TopBar.kt 同款绘制参数；图标就近各自文件持有）----

// Section 图标配色（对齐 React TreeSidebar 的 tailwind 色：专题 pink-500、相册/标签
// blue-500、人物 purple-500、画布 emerald-500、网络断连 gray-400）
private val SECTION_PINK = Color(0xFFEC4899)
private val SECTION_BLUE = Color(0xFF3B82F6)
private val SECTION_PURPLE = Color(0xFFA855F7)
private val SECTION_EMERALD = Color(0xFF10B981)
private val SECTION_GRAY = Color(0xFF9CA3AF)

/** 专题 Section 选中底色（桌面 TopicSection isSelected 的 #ee5ea5，比 pink-500 浅一档）。 */
private val TOPIC_SELECT_PINK = Color(0xFFEE5EA5)

// 侧栏文字灰阶（对齐 React 侧栏的 tailwind gray 色阶，非全局 token：桌面树文案比
// token 的 textSecondary #737373 更具层次——标题 gray-500、行文字 gray-600、空态 gray-400）
private val SIDEBAR_GRAY_500 = Color(0xFF6B7280)
private val SIDEBAR_GRAY_600 = Color(0xFF4B5563)
private val SIDEBAR_GRAY_400 = Color(0xFF9CA3AF)

private const val STROKE = 2f

// roundedRect 扩展已上移 AuroraIcons.kt 共享（M4c 2.6），本文件沿用同名共享版本。

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

private val IconChevronDown: ImageVector by lazy {
    iconBuilder("ChevronDown") {
        moveTo(6f, 9f)
        lineTo(12f, 15f)
        lineTo(18f, 9f)
    }
}

/** lucide Layout（专题 Section；与 TopBar 的 LayoutTemplate 同形）。 */
private val IconLayout: ImageVector by lazy {
    iconBuilder("Layout") {
        roundedRect(3f, 3f, 18f, 18f, 2f)
        moveTo(3f, 9f)
        lineTo(21f, 9f)
        moveTo(9f, 21f)
        lineTo(9f, 9f)
    }
}

// IconHardDrive / IconWifiOff（本地相册/网络 Section）已上移 AuroraIcons.kt 共享
// （M4c 2.6），本文件直接引用同包共享版本。

/**
 * lucide WifiOff（网络 Section 断连态；圆弧用三次贝塞尔近似 lucide 的椭圆弧，
 * 16dp 显示尺寸下观感一致：两段残弧 + 底部点 + 左上到右下斜杠）。
 */
/**
 * lucide Brain（人物 Section；两个对称脑叶 + 中缝细节，lucide 的 8 段小弧在 16dp 下
 * 并入轮廓——贝塞尔近似脑叶云形，观感对齐桌面）。
 */
private val IconBrain: ImageVector by lazy {
    iconBuilder("Brain") {
        // 左脑叶：顶 → 左上凸 → 左缘 → 左下凸 → 底 → 回中缝
        moveTo(12f, 5f)
        curveTo(10.9f, 3.9f, 8.6f, 3.9f, 7.2f, 5.1f)
        curveTo(5.2f, 5.6f, 4.1f, 7.7f, 4.9f, 9.6f)
        curveTo(3.4f, 10.9f, 3.3f, 13.3f, 4.7f, 14.7f)
        curveTo(4.5f, 16.9f, 6.3f, 18.8f, 8.5f, 18.7f)
        curveTo(9.4f, 19.7f, 11.2f, 19.8f, 12f, 18.6f)
        close()
        // 右脑叶（镜像）
        moveTo(12f, 5f)
        curveTo(13.1f, 3.9f, 15.4f, 3.9f, 16.8f, 5.1f)
        curveTo(18.8f, 5.6f, 19.9f, 7.7f, 19.1f, 9.6f)
        curveTo(20.6f, 10.9f, 20.7f, 13.3f, 19.3f, 14.7f)
        curveTo(19.5f, 16.9f, 17.7f, 18.8f, 15.5f, 18.7f)
        curveTo(14.6f, 19.7f, 12.8f, 19.8f, 12f, 18.6f)
        close()
        // 中缝细节（对齐 lucide 中部 V 形曲线）
        moveTo(15f, 13f)
        curveTo(13.8f, 12.2f, 12.5f, 10.8f, 12f, 9.2f)
        curveTo(11.5f, 10.8f, 10.2f, 12.2f, 9f, 13f)
    }
}

/** lucide Tag（标签 Section；含铆点）。 */
private val IconTagBadge: ImageVector by lazy {
    iconBuilder("TagBadge") {
        moveTo(12.586f, 2.586f)
        arcTo(2f, 2f, 0f, false, false, 11.172f, 2f)
        lineTo(4f, 2f)
        arcTo(2f, 2f, 0f, false, false, 2f, 4f)
        lineTo(2f, 11.172f)
        arcTo(2f, 2f, 0f, false, false, 2.586f, 12.586f)
        lineTo(11.29f, 21.29f)
        arcTo(2.426f, 2.426f, 0f, false, false, 14.71f, 21.29f)
        lineTo(21.29f, 14.71f)
        arcTo(2.426f, 2.426f, 0f, false, false, 21.29f, 11.29f)
        close()
        moveTo(7.5f, 7.5f)
        lineTo(7.51f, 7.5f)
    }
}

/** lucide Scan + 中线（画布 Section 变体；与 AuroraIcons 的标准 IconScan 区分）。 */
private val IconScanMidline: ImageVector by lazy {
    iconBuilder("Scan") {
        moveTo(3f, 7f)
        lineTo(3f, 5f)
        arcTo(2f, 2f, 0f, false, true, 5f, 3f)
        lineTo(7f, 3f)
        moveTo(17f, 3f)
        lineTo(19f, 3f)
        arcTo(2f, 2f, 0f, false, true, 21f, 5f)
        lineTo(21f, 7f)
        moveTo(21f, 17f)
        lineTo(21f, 19f)
        arcTo(2f, 2f, 0f, false, true, 19f, 21f)
        lineTo(17f, 21f)
        moveTo(7f, 21f)
        lineTo(5f, 21f)
        arcTo(2f, 2f, 0f, false, true, 3f, 19f)
        lineTo(3f, 17f)
        moveTo(7f, 12f)
        lineTo(17f, 12f)
    }
}

/** lucide sliders-horizontal（设置行）：三条横线 + 滑块圆点。 */
private val IconSettings: ImageVector by lazy {
    iconBuilder("SettingsSliders") {
        moveTo(21f, 4f)
        lineTo(14f, 4f)
        moveTo(10f, 4f)
        lineTo(3f, 4f)
        moveTo(12f, 2f)
        lineTo(12.01f, 2f)
        moveTo(21f, 12f)
        lineTo(12f, 12f)
        moveTo(8f, 12f)
        lineTo(3f, 12f)
        moveTo(10f, 10f)
        lineTo(10.01f, 10f)
        moveTo(21f, 20f)
        lineTo(16f, 20f)
        moveTo(12f, 20f)
        lineTo(3f, 20f)
        moveTo(14f, 18f)
        lineTo(14.01f, 18f)
    }
}

/** lucide folder。 */
private val IconFolder: ImageVector by lazy {
    iconBuilder("Folder") {
        moveTo(20f, 20f)
        arcTo(2f, 2f, 0f, false, false, 22f, 18f)
        lineTo(22f, 8f)
        arcTo(2f, 2f, 0f, false, false, 20f, 6f)
        lineTo(12.1f, 6f)
        arcTo(2f, 2f, 0f, false, true, 10.41f, 5.1f)
        lineTo(9.6f, 3.9f)
        arcTo(2f, 2f, 0f, false, false, 7.93f, 3f)
        lineTo(4f, 3f)
        arcTo(2f, 2f, 0f, false, false, 2f, 5f)
        lineTo(2f, 18f)
        arcTo(2f, 2f, 0f, false, false, 4f, 20f)
        close()
    }
}

/** lucide tag（主路径；小尺寸省铆点）。 */
private val IconTagSmall: ImageVector by lazy {
    iconBuilder("TagSmall") {
        moveTo(12.586f, 2.586f)
        arcTo(2f, 2f, 0f, false, false, 11.172f, 2f)
        lineTo(4f, 2f)
        arcTo(2f, 2f, 0f, false, false, 2f, 4f)
        lineTo(2f, 11.172f)
        arcTo(2f, 2f, 0f, false, false, 2.586f, 12.586f)
        lineTo(11.29f, 21.29f)
        arcTo(2.426f, 2.426f, 0f, false, false, 14.71f, 21.29f)
        lineTo(21.29f, 14.71f)
        arcTo(2.426f, 2.426f, 0f, false, false, 21.29f, 11.29f)
        close()
    }
}

/** lucide arrow-down-up（排序循环；同 TopBar 的 ArrowDownUp 绘制）。 */
private val IconArrowUpDown: ImageVector by lazy {
    iconBuilder("ArrowUpDown") {
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
