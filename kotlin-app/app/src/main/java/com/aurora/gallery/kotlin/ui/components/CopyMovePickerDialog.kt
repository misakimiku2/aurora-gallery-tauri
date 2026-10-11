package com.aurora.gallery.kotlin.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedTextField
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
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.path
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.aurora.gallery.kotlin.LanRemoteFolder
import com.aurora.gallery.kotlin.ui.theme.AuroraTheme
import uniffi.aurora_core.Folder

/**
 * 复制/移动的**统一目标选择器**（2026-10-11，双根树；取代 TargetPickerDialog 的本地
 * 扁平表与 LanFolderPickerDialog 的 MOVE/COPY 导航栈——用户口径「不区分网络和本机」）。
 *
 * 交互形制（桌面 FolderPickerModal 的树形语汇 + 触屏同位）：
 *  - **两个根**：「本机」（默认展开，MediaStore 相册扁平表）与「网络」（默认收起，
 *    远端 browse 懒加载的缩进树，desktop-to-android 规范「树形视图→缩进展开列表」）；
 *    根行整行点击 = 展开/收起（用户表述的直译）。
 *  - **子目录行**：左侧三角（48dp 命中）= 展开/收起（首展时 browse 拉子目录，失败行
 *    内重试）；行主体点击 = **选定**为目标（primary 高亮）——三角管浏览、行管选定，
 *    两个动作不打架。远端行首屏固定「共享根目录」一行（目标 = ""，对齐旧 LAN 弹窗
 *    栈顶即共享根的能力）。
 *  - **本机相册行**：叶子（MediaStore bucket 无子层），行主体点击 = 选定。
 *  - 底部确认钮「复制到这里/移动到这里」落在选定目标上；无选定 = 禁用。
 *  - 「+ 新建相册」只挂本机根下（契约无 mkdir；1.3 懒创建链路不变：就地输入名字，
 *    确认即执行，宿主做重名合并拦截）。
 *
 * 数据纪律：远端 path 是契约 §0 的不透明字符串——树以 path 为 key 存子目录，**绝不
 * 拼父路径**；「上一级」这种字符串运算在树形里天然不存在（展开/收起都是集合操作）。
 * 网络层不进组件：[browse] 由宿主转 GalleryViewModel.browseLanPath（不动门禁位），
 * 失败回 null 由行内「重试」兜底。
 *
 * 主题：containerColor 显式走 [AuroraTheme.colors.dialogBg]（2026-10-11 弹窗主题色
 * 修复——M3 AlertDialog 默认容器色是 Material 基线，与 Aurora 色板不符）。
 */
@Composable
fun CopyMovePickerDialog(
    /** "copy" | "move"（标题与宿主执行分支共用）。 */
    type: String,
    /** 本机根的相册扁平表（viewModel.folders 原样）。 */
    localFolders: List<Folder>,
    /** 网络根可用性（LAN 会话未连接 = 整根禁用 + 「未连接桌面端」副文案）。 */
    lanAvailable: Boolean,
    /** 单次远端 browse（宿主转 browseLanPath）；path null = 共享根。失败回 null。 */
    browse: (path: String?, onReady: (com.aurora.gallery.kotlin.LanBrowseResult?) -> Unit) -> Unit,
    onDismiss: () -> Unit,
    /** 选定本机相册为目标。 */
    onPickLocalFolder: (Folder) -> Unit,
    /** 「+ 新建相册」输入名字确认（宿主做合并拦截与校验，确认即执行）。 */
    onPickNewAlbum: (String) -> Unit,
    /** 选定远端目录为目标（opaque path；共享根 = ""）。 */
    onPickLanFolder: (targetDir: String) -> Unit,
) {
    val colors = AuroraTheme.colors
    // 手风琴语义：两个根恒在顶部，同一时刻只展开一个（展开一个自动收起另一个）——
    // 子层永远紧跟根行可见，不会互相把对方埋进滚动区（2026-10-11 实测长相册表下的教训）
    var localExpanded by remember { mutableStateOf(true) }
    var lanExpanded by remember { mutableStateOf(false) }
    var selected by remember { mutableStateOf<CopyMoveTarget?>(null) }
    // 本机相册搜索（M4b 1.4 既有能力平移：只过滤本机列表，远端树不做名字搜索）
    var query by remember { mutableStateOf("") }
    val searchFocus = remember { FocusRequester() }
    // 「+ 新建相册」就地输入（1.3 懒创建，确认即执行）
    var enteringName by remember { mutableStateOf(false) }
    var name by remember { mutableStateOf(TextFieldValue("")) }

    // —— LAN 树状态：path → 直接子目录；展开/加载/失败三个集合（全集合操作，无字符串运算）——
    var lanChildren by remember { mutableStateOf<Map<String, List<LanRemoteFolder>>>(emptyMap()) }
    var lanExpandedDirs by remember { mutableStateOf<Set<String>>(emptySet()) }
    var lanLoading by remember { mutableStateOf<Set<String>>(emptySet()) }
    var lanFailed by remember { mutableStateOf<Set<String>>(emptySet()) }

    fun loadLanChildren(dirPath: String) {
        lanLoading = lanLoading + dirPath
        lanFailed = lanFailed - dirPath
        browse(dirPath.takeIf { it.isNotEmpty() }) { res ->
            lanLoading = lanLoading - dirPath
            if (res != null) {
                lanChildren = lanChildren + (dirPath to res.folders)
            } else {
                lanFailed = lanFailed + dirPath
            }
        }
    }

    fun toggleLanDir(dirPath: String) {
        if (dirPath in lanExpandedDirs) {
            lanExpandedDirs = lanExpandedDirs - dirPath
        } else {
            lanExpandedDirs = lanExpandedDirs + dirPath
            if (dirPath !in lanChildren && dirPath !in lanLoading) loadLanChildren(dirPath)
        }
    }

    // 展开态 → 可见行序列（深度优先拍平，避免组合内递归）。共享根的首行在这里不参与
    // 拍平（渲染层固定画），key "" 只作 lanChildren 的根键。
    data class LanRow(val folder: LanRemoteFolder, val depth: Int)
    val visibleLanRows = remember(lanChildren, lanExpandedDirs) {
        buildList {
            fun walk(parent: String, depth: Int) {
                for (f in lanChildren[parent].orEmpty()) {
                    add(LanRow(f, depth))
                    if (f.path in lanExpandedDirs) walk(f.path, depth + 1)
                }
            }
            walk("", 0)
        }
    }

    val visibleLocalFolders = filterFoldersForSearch(localFolders, query)
    val title = if (type == "copy") "复制到文件夹" else "移动到文件夹"
    val confirmLabel = if (type == "copy") "复制到这里" else "移动到这里"

    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = colors.dialogBg,
        title = { Text(title) },
        text = {
            Column {
                // 本机相册搜索框（M4b 1.4 既有形制平移：整行可点唤键盘、清词钮 48dp）
                Row(
                    Modifier
                        .fillMaxWidth()
                        .height(48.dp)
                        .clip(RoundedCornerShape(8.dp))
                        .background(colors.surface)
                        .border(
                            1.dp,
                            if (query.isNotEmpty()) colors.primary else colors.border,
                            RoundedCornerShape(8.dp),
                        )
                        .clickable(onClickLabel = "搜索相册") { searchFocus.requestFocus() }
                        .padding(horizontal = 12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(
                        imageVector = IconSearch,
                        contentDescription = null,
                        tint = colors.textSecondary,
                        modifier = Modifier.size(16.dp),
                    )
                    Spacer(Modifier.width(8.dp))
                    BasicTextField(
                        value = query,
                        onValueChange = { query = it },
                        singleLine = true,
                        textStyle = TextStyle(color = colors.textPrimary, fontSize = 15.sp),
                        cursorBrush = SolidColor(colors.primary),
                        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                        modifier = Modifier
                            .weight(1f)
                            .focusRequester(searchFocus),
                        decorationBox = { inner ->
                            Box(contentAlignment = Alignment.CenterStart) {
                                if (query.isEmpty()) {
                                    Text("搜索相册…", fontSize = 15.sp, color = colors.textSecondary)
                                }
                                inner()
                            }
                        },
                    )
                    if (query.isNotEmpty()) {
                        Box(
                            Modifier
                                .size(48.dp)
                                .clip(CircleShape)
                                .clickable(onClickLabel = "清除搜索") { query = "" },
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
                Spacer(Modifier.size(10.dp))
                // 树容器：**两个根行恒在顶部**（本机相册再多也不会把网络根埋进滚动区），
                // 各自的子层挂在自己根行的下方；同一个圆角面板内滚动（形制对齐旧弹窗）
                Column(
                    Modifier
                        .heightIn(max = 420.dp)
                        .clip(RoundedCornerShape(12.dp))
                        .background(colors.panel)
                        .padding(6.dp)
                        .verticalScroll(rememberScrollState()),
                ) {
                    // —— 本机根（默认展开；根行整行点击 = 展开/收起，手风琴互斥）——
                    RootRow(
                        icon = CopyMoveIconFolder,
                        iconTint = colors.primary,
                        title = "本机",
                        subtitle = null,
                        expanded = localExpanded,
                        enabled = true,
                        selected = false,
                        onClick = {
                            localExpanded = !localExpanded
                            if (localExpanded) lanExpanded = false
                        },
                        onToggle = {
                            localExpanded = !localExpanded
                            if (localExpanded) lanExpanded = false
                        },
                    )
                    // —— 网络根（默认收起；未连接禁用；展开自动收起本机）——
                    RootRow(
                        icon = IconWifi,
                        iconTint = SECTION_EMERALD,
                        title = "网络",
                        subtitle = if (lanAvailable) null else "未连接桌面端",
                        expanded = lanExpanded,
                        enabled = lanAvailable,
                        selected = false,
                        onClick = if (lanAvailable) {
                            {
                                lanExpanded = !lanExpanded
                                if (lanExpanded) {
                                    localExpanded = false
                                    if ("" !in lanChildren && "" !in lanLoading) loadLanChildren("")
                                }
                            }
                        } else null,
                        onToggle = if (lanAvailable) {
                            {
                                lanExpanded = !lanExpanded
                                if (lanExpanded) {
                                    localExpanded = false
                                    if ("" !in lanChildren && "" !in lanLoading) loadLanChildren("")
                                }
                            }
                        } else null,
                    )
                    // —— 本机根子层：相册叶子 + 「+ 新建相册」——
                    if (localExpanded) {
                        if (visibleLocalFolders.isEmpty()) {
                            TreeHintRow(if (localFolders.isEmpty()) "暂无相册" else "无匹配相册")
                        }
                        visibleLocalFolders.forEach { folder ->
                            // 相册行 = 叶子目标：主体点击 = 选定（无子层，无三角）
                            LeafRow(
                                icon = CopyMoveIconAlbum,
                                iconTint = colors.primary,
                                title = folder.name,
                                trailing = folder.imageCount.toString(),
                                indent = 16,
                                selected = selected is CopyMoveTarget.LocalFolder &&
                                    (selected as CopyMoveTarget.LocalFolder).folder.id == folder.id,
                                onClick = { selected = CopyMoveTarget.LocalFolder(folder) },
                            )
                        }
                        // 「+ 新建相册」（仅本机根；1.3 懒创建——确认即执行，不走选定态）
                        if (enteringName) {
                            Row(
                                Modifier
                                    .fillMaxWidth()
                                    .defaultMinSize(minHeight = 48.dp)
                                    .padding(start = 16.dp, end = 4.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                OutlinedTextField(
                                    value = name,
                                    onValueChange = { name = it },
                                    singleLine = true,
                                    placeholder = {
                                        Text("相册名称（建在 Pictures 下）", color = colors.textSecondary)
                                    },
                                    modifier = Modifier.weight(1f),
                                )
                            }
                        } else {
                            LeafRow(
                                icon = IconPlus,
                                iconTint = colors.primary,
                                title = "新建相册",
                                trailing = null,
                                indent = 16,
                                selected = false,
                                onClick = { enteringName = true },
                                titleColor = colors.primary,
                                titleWeight = FontWeight.SemiBold,
                            )
                        }
                    }
                    // —— 网络根子层：共享根 + 远端目录树（懒加载 browse）——
                    if (lanExpanded && lanAvailable) {
                        // 共享根 = 合法目标（旧 LAN 弹窗栈顶即共享根；"" 进请求原样传）
                        LeafRow(
                            icon = IconWifi,
                            iconTint = SECTION_EMERALD,
                            title = "共享根目录",
                            trailing = null,
                            indent = 16,
                            selected = selected is CopyMoveTarget.LanDir &&
                                (selected as CopyMoveTarget.LanDir).path.isEmpty(),
                            onClick = { selected = CopyMoveTarget.LanDir("") },
                        )
                        if ("" in lanLoading) {
                            TreeLoadingRow()
                        } else if ("" in lanFailed) {
                            TreeHintRow("读取失败，点击重试", indent = 1, onClick = { loadLanChildren("") })
                        }
                        visibleLanRows.forEach { row ->
                            val expanded = row.folder.path in lanExpandedDirs
                            val loading = row.folder.path in lanLoading
                            val failed = row.folder.path in lanFailed
                            // 子目录行：三角 = 展开/收起（懒加载）；主体 = 选定
                            DirRow(
                                title = row.folder.name,
                                trailing = row.folder.imageCount.toString(),
                                depth = row.depth,
                                expanded = expanded,
                                selected = selected is CopyMoveTarget.LanDir &&
                                    (selected as CopyMoveTarget.LanDir).path == row.folder.path,
                                onToggle = { toggleLanDir(row.folder.path) },
                                onSelect = { selected = CopyMoveTarget.LanDir(row.folder.path) },
                            )
                            if (loading) TreeLoadingRow(row.depth + 1)
                            if (failed) {
                                TreeHintRow(
                                    "读取失败，点击重试",
                                    indent = row.depth + 1,
                                    onClick = { loadLanChildren(row.folder.path) },
                                )
                            }
                        }
                    }
                }
            }
        },
        confirmButton = {
            if (enteringName) {
                TextButton(
                    enabled = name.text.isNotBlank(),
                    onClick = { onPickNewAlbum(name.text.trim()) },
                ) {
                    Text(
                        "继续",
                        color = if (name.text.isNotBlank()) colors.primaryDeep else colors.textSecondary,
                    )
                }
            } else {
                TextButton(
                    enabled = selected != null,
                    onClick = {
                        when (val t = selected) {
                            is CopyMoveTarget.LocalFolder -> onPickLocalFolder(t.folder)
                            is CopyMoveTarget.LanDir -> onPickLanFolder(t.path)
                            null -> Unit
                        }
                    },
                ) {
                    Text(
                        confirmLabel,
                        color = if (selected != null) colors.primaryDeep else colors.textSecondary,
                    )
                }
            }
            TextButton(onClick = onDismiss) { Text("取消", color = colors.textPrimary) }
        },
    )
}

/** 选定目标：本机相册 / 远端目录（opaque path，共享根 = ""）。 */
private sealed interface CopyMoveTarget {
    data class LocalFolder(val folder: Folder) : CopyMoveTarget
    data class LanDir(val path: String) : CopyMoveTarget
}

/**
 * 根行（本机/网络）：图标 + 名字 + 副文案，行主体与右侧三角都触发 [onToggle]/
 * [onClick]（根层「点击即展开/收起」，用户口径的直译；根自身不作选定目标）。
 */
@Composable
private fun RootRow(
    icon: ImageVector,
    iconTint: Color,
    title: String,
    subtitle: String?,
    expanded: Boolean,
    enabled: Boolean,
    selected: Boolean,
    onClick: (() -> Unit)?,
    onToggle: (() -> Unit)?,
) {
    val colors = AuroraTheme.colors
    Row(
        Modifier
            .fillMaxWidth()
            .defaultMinSize(minHeight = 48.dp)
            .clip(RoundedCornerShape(8.dp))
            .background(if (selected) colors.primary.copy(alpha = 0.12f) else Color.Transparent)
            .clickable(enabled = enabled && onClick != null, onClickLabel = title) { onClick?.invoke() }
            .padding(horizontal = 8.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            imageVector = icon,
            contentDescription = null,
            tint = if (enabled) iconTint else colors.textSecondary.copy(alpha = 0.4f),
            modifier = Modifier.size(16.dp),
        )
        Spacer(Modifier.size(10.dp))
        Column(Modifier.weight(1f)) {
            Text(
                title,
                fontSize = 15.sp,
                fontWeight = FontWeight.SemiBold,
                color = if (enabled) colors.textPrimary else colors.textSecondary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            if (subtitle != null) {
                Text(subtitle, fontSize = 12.sp, color = colors.textSecondary)
            }
        }
        // 三角命中区 48dp（视觉 16dp）：根行整行可点，这里保底展开/收起的独立命中
        Box(
            Modifier
                .size(48.dp)
                .clip(CircleShape)
                .clickable(
                    enabled = enabled && onToggle != null,
                    onClickLabel = if (expanded) "收起" else "展开",
                ) { onToggle?.invoke() },
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                imageVector = IconChevronRight,
                contentDescription = if (expanded) "收起" else "展开",
                tint = colors.textSecondary,
                modifier = Modifier
                    .size(16.dp)
                    .rotate(if (expanded) 90f else 0f),
            )
        }
    }
}

/**
 * 目录行（网络树）：左缩进 + 三角（展开/收起，48dp 命中）+ 名称/计数；主体点击 = 选定。
 */
@Composable
private fun DirRow(
    title: String,
    trailing: String?,
    depth: Int,
    expanded: Boolean,
    selected: Boolean,
    onToggle: () -> Unit,
    onSelect: () -> Unit,
) {
    val colors = AuroraTheme.colors
    Row(
        Modifier
            .fillMaxWidth()
            .defaultMinSize(minHeight = 48.dp)
            .clip(RoundedCornerShape(8.dp))
            .background(if (selected) colors.primary.copy(alpha = 0.12f) else Color.Transparent)
            .clickable(onClickLabel = "选择$title") { onSelect() }
            .padding(start = (16 + depth * 16).dp, end = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier
                .size(48.dp)
                .clip(CircleShape)
                .clickable(onClickLabel = if (expanded) "收起目录" else "展开目录") { onToggle() },
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                imageVector = IconChevronRight,
                contentDescription = if (expanded) "收起目录" else "展开目录",
                tint = colors.textSecondary,
                modifier = Modifier
                    .size(16.dp)
                    .rotate(if (expanded) 90f else 0f),
            )
        }
        Icon(
            imageVector = IconWifi,
            contentDescription = null,
            tint = SECTION_EMERALD,
            modifier = Modifier.size(16.dp),
        )
        Spacer(Modifier.size(10.dp))
        Text(
            title,
            fontSize = 15.sp,
            color = colors.textPrimary,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        if (trailing != null) {
            Text(trailing, fontSize = 12.sp, color = colors.textSecondary)
            Spacer(Modifier.size(8.dp))
        }
    }
}

/** 叶子行（本机相册/新建相册/共享根）：无子层，主体点击 = 选定或动作。 */
@Composable
private fun LeafRow(
    icon: ImageVector,
    iconTint: Color,
    title: String,
    trailing: String?,
    indent: Int,
    selected: Boolean,
    onClick: () -> Unit,
    titleColor: Color = AuroraTheme.colors.textPrimary,
    titleWeight: FontWeight = FontWeight.Normal,
) {
    val colors = AuroraTheme.colors
    Row(
        Modifier
            .fillMaxWidth()
            .defaultMinSize(minHeight = 48.dp)
            .clip(RoundedCornerShape(8.dp))
            .background(if (selected) colors.primary.copy(alpha = 0.12f) else Color.Transparent)
            .clickable(onClickLabel = title) { onClick() }
            .padding(start = indent.dp, end = 8.dp, top = 8.dp, bottom = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            imageVector = icon,
            contentDescription = null,
            tint = iconTint,
            modifier = Modifier.size(16.dp),
        )
        Spacer(Modifier.size(10.dp))
        Text(
            title,
            fontSize = 15.sp,
            fontWeight = titleWeight,
            color = titleColor,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        if (trailing != null) {
            Text(trailing, fontSize = 12.sp, color = colors.textSecondary)
        }
    }
}

/** 树内加载指示行（与目录行同缩进形制）。 */
@Composable
private fun TreeLoadingRow(indent: Int = 0) {
    val colors = AuroraTheme.colors
    Row(
        Modifier
            .fillMaxWidth()
            .defaultMinSize(minHeight = 48.dp)
            .padding(start = (16 + indent * 16).dp, end = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        CircularProgressIndicator(
            modifier = Modifier.size(16.dp),
            strokeWidth = 2.dp,
            color = colors.primary,
        )
        Spacer(Modifier.size(10.dp))
        Text("正在读取目录…", fontSize = 14.sp, color = colors.textSecondary)
    }
}

/** 树内提示行（空态/失败重试；[onClick] null = 纯提示；[indent] 层级缩进，与行同形制）。 */
@Composable
private fun TreeHintRow(text: String, indent: Int = 0, onClick: (() -> Unit)? = null) {
    val colors = AuroraTheme.colors
    val modifier = if (onClick != null) {
        Modifier
            .fillMaxWidth()
            .defaultMinSize(minHeight = 48.dp)
            .clip(RoundedCornerShape(8.dp))
            .clickable(onClickLabel = "重试") { onClick() }
            .padding(horizontal = 8.dp, vertical = 12.dp)
    } else {
        Modifier
            .fillMaxWidth()
            .padding(start = (16 + indent * 16).dp, end = 8.dp, top = 12.dp, bottom = 12.dp)
    }
    Text(
        text,
        fontSize = 14.sp,
        color = if (onClick != null) colors.primary else colors.textSecondary,
        modifier = modifier,
    )
}

// ---- 自绘图标（共享图标已上移 AuroraIcons.kt；这里只补目标选择器专属的旧画法两颗）----

/** lucide folder（本机根行；与旧 TargetPickerIconFolder 同几何）。 */
private val CopyMoveIconFolder: ImageVector by lazy {
    auroraIcon("CopyMoveFolder") {
        moveTo(20f, 20f)
        lineTo(4f, 20f)
        arcTo(2f, 2f, 0f, false, true, 2f, 18f)
        lineTo(2f, 6f)
        arcTo(2f, 2f, 0f, false, true, 4f, 4f)
        lineTo(9f, 4f)
        lineTo(11f, 6f)
        lineTo(20f, 6f)
        arcTo(2f, 2f, 0f, false, true, 22f, 8f)
        lineTo(22f, 18f)
        arcTo(2f, 2f, 0f, false, true, 20f, 20f)
        close()
    }
}

/** lucide folder-open 变体（本机相册叶子行；与根行的闭合形制做视觉区分）。 */
private val CopyMoveIconAlbum: ImageVector by lazy {
    auroraIcon("CopyMoveAlbum") {
        moveTo(20f, 20f)
        lineTo(4f, 20f)
        arcTo(2f, 2f, 0f, false, true, 2f, 18f)
        lineTo(2f, 6f)
        arcTo(2f, 2f, 0f, false, true, 4f, 4f)
        lineTo(9f, 4f)
        lineTo(11f, 6f)
        lineTo(20f, 6f)
        arcTo(2f, 2f, 0f, false, true, 22f, 8f)
        lineTo(22f, 18f)
        arcTo(2f, 2f, 0f, false, true, 20f, 20f)
        close()
        moveTo(2f, 12f)
        lineTo(22f, 12f)
    }
}

/**
 * 搜索过滤纯函数（供 JVM 单测；自 TargetPickerDialog 平移）：名字包含查询即命中
 * （大小写不敏感）；查询 trim 后为空 = 原样返回全量。
 */
internal fun filterFoldersForSearch(folders: List<Folder>, query: String): List<Folder> {
    val q = query.trim()
    if (q.isEmpty()) return folders
    return folders.filter { it.name.contains(q, ignoreCase = true) }
}
