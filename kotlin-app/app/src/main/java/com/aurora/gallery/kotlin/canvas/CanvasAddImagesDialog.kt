package com.aurora.gallery.kotlin.canvas

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.aurora.gallery.kotlin.ThumbnailLoader
import com.aurora.gallery.kotlin.ui.components.IconCheck
import com.aurora.gallery.kotlin.ui.components.IconImages
import com.aurora.gallery.kotlin.ui.components.IconLayoutTemplate
import com.aurora.gallery.kotlin.ui.components.IconUser
import com.aurora.gallery.kotlin.ui.components.auroraIcon
import com.aurora.gallery.kotlin.ui.theme.AuroraTheme
import java.text.Collator
import java.util.Locale
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import uniffi.aurora_core.Folder
import uniffi.aurora_core.FfiTopic
import uniffi.aurora_core.Image
import uniffi.aurora_core.TagGroup

/**
 * 添加图片弹窗（M5 3.3 桌面形态移植，2026-09-24）：对齐 React AddImageModal.tsx 的
 * 桌面分支（非 isAndroid 分支）五段布局 —— 头部标题+关闭（:882-893）、左侧类目栏
 * （:898-1025 类目按钮 + 树形列表）、右侧搜索行 + 网格（:1028-1335）、已选信息条
 * （:1338-1360）、底部操作区（:1391-1423）。替换原「chips 行 + 网格」收敛版。
 *
 * 数据管线与选择语义原样保留（原 CanvasScreen.AddImagesToCanvasDialog）：onLoad 四类
 * 数据源 "all"/"folder"/"topic"/"tag"、容量 CANVAS_CAPACITY − store.count 钳制、
 * 已在画布恒勾 + Toast「这张已在画布中」、超容量 Toast「最多还可加 N 张」、确认时
 * 构造 CanvasPackSource(id, width?:1000f, height?:750f, contentUri) 回调。
 *
 * 桌面 → 触屏适配决策（desktop-to-android 铁律，均 2026-09-24 定）：
 *  - 选中态常显：整格 20% 主色罩 + 居中主色圆 Check（桌面 :849-855 同款），无 hover；
 *  - 键盘 Enter 搜索 → 输入即过滤（当前列表 contains，纯 UI 侧，TopBar TagsFilterSheet
 *    :1104-1105 口径）；ESC 关闭 → Dialog 返回键关闭；点击外部关闭（:671-679）→ 遮罩点击；
 *  - 全部可点元素命中 ≥48dp（类目行/树行/搜索框/头部关闭/底部按钮均为 48dp，网格格
 *    ≥120dp），字号全 sp，无 hover/快捷键依赖；
 *  - 桌面固定 5 列网格 → Adaptive(120dp)：平板密度接近 5 列、小屏自然减列不硬撑；
 *  - 桌面「人物」类目（:581/:960-969）本端无 people 数据源：按仓库可见占位先例
 *    （TreeSidebar「网络」Section 置灰可见 + MainActivity toastSoon 点击反馈）做置灰行，
 *    点击 Toast「人物功能尚未上线」，不出空网格；
 *  - 左栏无「全部」条目：打开弹窗默认 scope="all"（内部数据源语义）+ 选中「本地相册」
 *    组直接显示全部图片，树区顶部保留「未筛选来源，显示全部图片」提示，点具体
 *    相册/专题/标签后切换来源（2026-09-24 用户反馈）；
 *  - 桌面排序/分组菜单（:1066-1180）与分页（:1363-1386）未移植：分页是 react-window
 *    虚拟滚动的配套（LazyVerticalGrid 自带虚拟化），排序/分组属网格增强，保持数据管线
 *    最小不动。
 */
@Composable
internal fun AddImagesToCanvasDialog(
    store: CanvasStore,
    thumbnailLoader: ThumbnailLoader,
    folders: List<Folder>,
    topics: List<FfiTopic>,
    tagGroups: List<TagGroup>,
    onLoad: (scope: String, key: String, onReady: (List<Image>) -> Unit) -> Unit,
    onDismiss: () -> Unit,
    onConfirm: (List<CanvasPackSource>) -> Unit,
) {
    val colors = AuroraTheme.colors
    val context = LocalContext.current
    val config = LocalConfiguration.current

    // —— 数据管线（原收敛版原样保留）——
    var scope by remember { mutableStateOf("all") }
    var scopeKey by remember { mutableStateOf("") }
    var images by remember { mutableStateOf<List<Image>?>(null) }
    var checked by remember { mutableStateOf<Set<String>>(emptySet()) }
    val capacity = CANVAS_CAPACITY - store.count
    val inCanvas = remember { store.itemById.keys.toSet() }

    // —— 桌面形态导航状态 ——
    // 默认选中「本地相册」组；初始 scope 恒为 "all"（下方）= 打开即全量图片。
    // 「全部」不再是左栏条目，只是内部数据源语义（2026-09-24 用户反馈）
    var activeCategory by remember { mutableStateOf("folders") }
    var expandedTopics by remember { mutableStateOf<Set<String>>(emptySet()) }
    var query by remember { mutableStateOf("") }

    val collator = remember { Collator.getInstance(Locale.CHINA) }

    // 专题树（桌面 treeNodes :243-274 的扁平化）：FfiTopic.parentId 建层级，孤儿
    // （parentId 指向不存在的专题）提为根避免消失；zh-CN 排序对齐桌面 localeCompare
    val topicChildrenById = remember(topics) { topics.groupBy { it.parentId } }
    val topicRoots = remember(topics) {
        val ids = topics.mapTo(HashSet()) { it.id }
        topics.filter { it.parentId == null || it.parentId !in ids }
            .sortedWith(compareBy(collator) { it.name })
    }
    val topicNodes = remember(topicRoots, topicChildrenById, expandedTopics) {
        val out = mutableListOf<PickerNode>()
        fun walk(node: FfiTopic, depth: Int) {
            val children = topicChildrenById[node.id].orEmpty().sortedWith(compareBy(collator) { it.name })
            out.add(PickerNode("topic", node.id, node.name, depth, children.isNotEmpty(), node.fileCount.toLong()))
            if (node.id in expandedTopics) children.forEach { walk(it, depth + 1) }
        }
        topicRoots.forEach { walk(it, 0) }
        out.toList()
    }
    // 相册（MediaStore bucket 天然扁平，桌面 :218-241 的父子树端上无层级可建）
    val folderNodes = remember(folders) {
        folders.sortedWith(compareBy(collator) { it.name })
            .map { PickerNode("folder", it.id, it.name, 0, false, it.imageCount) }
    }
    // 标签保持 Rust 原序（M4a 1.2「组序/组内序 UI 不许再排」），计数用 TagEntry.count
    val tagNodes = remember(tagGroups) {
        tagGroups.flatMap { g -> g.tags.map { PickerNode("tag", it.tag, it.tag, 0, false, it.count) } }
    }

    fun selectSource(s: String, k: String) {
        // 同一来源重复点击不清空已选（对齐桌面重复点节点保留 selectedIds 的行为）
        if (s == scope && k == scopeKey) return
        scope = s
        scopeKey = k
        checked = emptySet()
    }

    // 类目切换（桌面 handleCategoryChange :568-575 清树展开/搜索）；相册/专题进入时
    // 默认选中首项（桌面默认选中效果 :719-729 同款）。已在该组再点 = 保持当前来源，
    // 默认 scope="all" 的全量视图不被打断
    fun switchCategory(cat: String) {
        if (activeCategory == cat) return
        activeCategory = cat
        expandedTopics = emptySet()
        query = ""
        when (cat) {
            "folders" -> folders.firstOrNull()?.let { selectSource("folder", it.id) } ?: selectSource("folder", "")
            "topics" -> topicRoots.firstOrNull()?.let { selectSource("topic", it.id) } ?: selectSource("topic", "")
            "tags" -> selectSource("tag", "")
        }
    }

    fun onNodeClick(node: PickerNode) {
        when (node.kind) {
            // 有子专题时整行点击同时展开/收起 + 选中（桌面 :783-788 同款）
            "topic" -> {
                if (node.hasChildren) {
                    expandedTopics =
                        if (node.key in expandedTopics) expandedTopics - node.key else expandedTopics + node.key
                }
                selectSource("topic", node.key)
            }
            "folder" -> selectSource("folder", node.key)
            else -> selectSource("tag", node.key)
        }
    }

    LaunchedEffect(scope, scopeKey) {
        images = null
        onLoad(scope, scopeKey) { list -> images = list }
    }

    // 搜索只过滤当前列表（桌面 isAndroid 分支 :1040-1048 即输即筛的同款语义）
    val visible = images?.filter { query.isBlank() || it.name.contains(query, ignoreCase = true) }
    val visibleCount = visible?.size ?: 0

    fun confirmChecked() {
        val sources = images
            ?.filter { it.id in checked }
            ?.map { img ->
                CanvasPackSource(
                    id = img.id,
                    width = img.width?.toFloat() ?: 1000f,
                    height = img.height?.toFloat() ?: 750f,
                    contentUri = img.contentUri,
                )
            }
            .orEmpty()
        onConfirm(sources)
    }

    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        // 桌面 w-full max-w-6xl h-[85vh]（:877）→ 宽 ≤ 屏宽−32（遮罩四周留 16dp）且
        // ≤1152dp，高 85vh 且不超屏；矮屏整体缩小、内部滚动，不设硬下限避免溢出屏外
        // （SettingsTabletDialog :609-612 同思路）
        val dialogWidth = (config.screenWidthDp - 32).coerceAtMost(1152).dp
        val dialogHeight = (config.screenHeightDp * 85 / 100).coerceAtMost(config.screenHeightDp - 48).dp
        // 左栏：平板保持桌面 w-56 = 224dp；窄屏（Compact <600dp）收窄到 148dp 给网格留空间
        val railWidth = if (config.screenWidthDp < 600) 148.dp else 224.dp

        // 点遮罩关闭（桌面 handleClickOutside :671-679）；内容层挂空 clickable 阻断冒泡
        Box(
            Modifier
                .fillMaxSize()
                .background(Color.Black.copy(alpha = 0.5f))
                .clickable(
                    interactionSource = remember { MutableInteractionSource() },
                    indication = null,
                    onClick = onDismiss,
                ),
            contentAlignment = Alignment.Center,
        ) {
            Surface(
                modifier = Modifier
                    .width(dialogWidth)
                    .height(dialogHeight)
                    .clickable(
                        interactionSource = remember { MutableInteractionSource() },
                        indication = null,
                        onClick = {},
                    ),
                shape = RoundedCornerShape(12.dp),
                color = colors.content,
                shadowElevation = 8.dp,
            ) {
                Column {
                    // —— 头部（桌面 :882-893：图标 + 标题 + 关闭钮）——
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .background(colors.panel)
                            .padding(start = 16.dp, end = 8.dp, top = 4.dp, bottom = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Icon(IconImages, contentDescription = null, tint = colors.primary, modifier = Modifier.size(20.dp))
                        Spacer(Modifier.width(8.dp))
                        Text(
                            "添加图片到画布",
                            fontSize = 18.sp,
                            fontWeight = FontWeight.Bold,
                            color = colors.textPrimary,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.weight(1f),
                        )
                        // 关闭钮：视觉 20dp、命中 48dp（触屏规范）
                        Box(
                            Modifier
                                .size(48.dp)
                                .clip(RoundedCornerShape(12.dp))
                                .clickable(onClickLabel = "关闭") { onDismiss() },
                            contentAlignment = Alignment.Center,
                        ) {
                            Icon(DlgIconX, contentDescription = "关闭", tint = colors.textSecondary, modifier = Modifier.size(20.dp))
                        }
                    }
                    Box(Modifier.fillMaxWidth().height(1.dp).background(colors.border))

                    // —— 主体（桌面 :896-1387）——
                    Row(Modifier.weight(1f)) {
                        // 左类目栏 w-56 = 224dp（桌面 :898-1025；窄屏收窄见 railWidth 注）
                        Column(
                            Modifier
                                .width(railWidth)
                                .fillMaxHeight()
                                .background(colors.panel),
                        ) {
                            // 类目按钮（桌面 :936-981 p-2 space-y-1），顺序对齐桌面 rail：
                            // 本地相册、人物、专题、标签（2026-09-24 用户指定）
                            Column(
                                Modifier.padding(8.dp),
                                verticalArrangement = Arrangement.spacedBy(4.dp),
                            ) {
                                CategoryButton("本地相册", DlgIconFolder, colors.primary, activeCategory == "folders") { switchCategory("folders") }
                                // 人物占位行（桌面 :960-969；本端数据源未接）：紫 accent 同主界面
                                // 人物 Section（TreeSidebar SECTION_PURPLE #A855F7 同值），文字置灰 +
                                // 点击 Toast（toastSoon 式可见占位），不进选择态、不出空网格
                                Row(
                                    Modifier
                                        .fillMaxWidth()
                                        .height(48.dp)
                                        .clip(RoundedCornerShape(8.dp))
                                        .clickable(onClickLabel = "人物") {
                                            android.widget.Toast.makeText(
                                                context, "人物功能尚未上线", android.widget.Toast.LENGTH_SHORT,
                                            ).show()
                                        }
                                        .padding(horizontal = 12.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                ) {
                                    Icon(IconUser, contentDescription = null, tint = PEOPLE_PURPLE, modifier = Modifier.size(18.dp))
                                    Spacer(Modifier.width(8.dp))
                                    Text(
                                        "人物",
                                        fontSize = 14.sp,
                                        fontWeight = FontWeight.Medium,
                                        color = colors.textSecondary,
                                        maxLines = 1,
                                        overflow = TextOverflow.Ellipsis,
                                    )
                                }
                                CategoryButton("专题", IconLayoutTemplate, colors.topicPink, activeCategory == "topics") { switchCategory("topics") }
                                CategoryButton("标签", DlgIconTag, colors.primary, activeCategory == "tags") { switchCategory("tags") }
                            }
                            Box(Modifier.fillMaxWidth().height(1.dp).background(colors.border))
                            val nodes = when (activeCategory) {
                                "folders" -> folderNodes
                                "topics" -> topicNodes
                                "tags" -> tagNodes
                                else -> emptyList()
                            }
                            // 默认 scope="all"（无左栏条目的内部来源）时顶部保留「未筛选来源」
                            // 提示，下方照常列出当前组节点供点选切换来源
                            Column(Modifier.fillMaxSize()) {
                                if (scope == "all") {
                                    Text(
                                        "未筛选来源，显示全部图片",
                                        fontSize = 12.sp,
                                        color = colors.textSecondary,
                                        modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp),
                                    )
                                }
                                LazyColumn(
                                    Modifier.weight(1f),
                                    contentPadding = PaddingValues(vertical = 4.dp),
                                ) {
                                    items(nodes, key = { "${it.kind}:${it.key}" }) { node ->
                                        PickerNodeRow(
                                            node = node,
                                            selected = node.kind == scope && node.key == scopeKey,
                                            expanded = node.key in expandedTopics,
                                            accent = if (node.kind == "topic") colors.topicPink else colors.primary,
                                            onClick = { onNodeClick(node) },
                                        )
                                    }
                                }
                            }
                        }
                        // 桌面 border-r（:898）
                        Box(Modifier.width(1.dp).fillMaxHeight().background(colors.border))

                        // 右侧（桌面 :1028-1387）
                        Column(Modifier.weight(1f)) {
                            // 搜索行（桌面 :1030-1065；排序/分组菜单未移植，见文件头说明）
                            Row(Modifier.fillMaxWidth().padding(16.dp)) {
                                Row(
                                    Modifier
                                        .weight(1f)
                                        .height(48.dp)
                                        .clip(RoundedCornerShape(24.dp))
                                        .background(colors.surface)
                                        .border(
                                            1.dp,
                                            if (query.isNotEmpty()) colors.primary else Color.Transparent,
                                            RoundedCornerShape(24.dp),
                                        )
                                        .padding(horizontal = 16.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                ) {
                                    Icon(DlgIconSearch, contentDescription = null, tint = Color(colors.palette.hint), modifier = Modifier.size(16.dp))
                                    Spacer(Modifier.width(8.dp))
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
                                                    Text("搜索文件名…", fontSize = 14.sp, color = colors.textSecondary)
                                                }
                                                inner()
                                            }
                                        },
                                    )
                                    if (query.isNotEmpty()) {
                                        // 清词钮（桌面 :1056-1063）：视觉 14dp、命中 48dp
                                        Box(
                                            Modifier
                                                .size(48.dp)
                                                .clip(CircleShape)
                                                .clickable(onClickLabel = "清除搜索") { query = "" },
                                            contentAlignment = Alignment.Center,
                                        ) {
                                            Icon(DlgIconX, contentDescription = "清除搜索", tint = Color(colors.palette.hint), modifier = Modifier.size(14.dp))
                                        }
                                    }
                                }
                            }

                            // 网格区（桌面 :1182-1335：网格/空态/加载）
                            Box(Modifier.fillMaxWidth().weight(1f)) {
                                when {
                                    visible == null -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                                        Text("加载中…", fontSize = 14.sp, color = colors.textSecondary)
                                    }
                                    visible.isEmpty() -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                                        Column(horizontalAlignment = Alignment.CenterHorizontally) {
                                            Icon(
                                                IconImages,
                                                contentDescription = null,
                                                tint = colors.textSecondary,
                                                modifier = Modifier.size(64.dp).alpha(0.2f),
                                            )
                                            Spacer(Modifier.height(16.dp))
                                            Text(
                                                // 桌面 :1187-1196：未选节点与无图两种文案
                                                //（scope="all" 是默认全量视图，不算「未选节点」）
                                                if (scopeKey.isEmpty() && scope != "all") "请选择左侧项目查看图片" else "暂无图片",
                                                fontSize = 14.sp,
                                                color = colors.textSecondary,
                                            )
                                        }
                                    }
                                    else -> LazyVerticalGrid(
                                        columns = GridCells.Adaptive(120.dp),
                                        contentPadding = PaddingValues(16.dp),
                                        verticalArrangement = Arrangement.spacedBy(12.dp),
                                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                                        modifier = Modifier.fillMaxSize(),
                                    ) {
                                        items(visible, key = { it.id }) { img ->
                                            val already = img.id in inCanvas
                                            val isChecked = img.id in checked || already
                                            PickerCell(
                                                image = img,
                                                checked = isChecked,
                                                alreadyInCanvas = already,
                                                enabled = already || isChecked || checked.size < capacity,
                                                thumbnailLoader = thumbnailLoader,
                                                onToggle = {
                                                    when {
                                                        already -> android.widget.Toast.makeText(
                                                            context, "这张已在画布中", android.widget.Toast.LENGTH_SHORT,
                                                        ).show()
                                                        img.id in checked -> checked = checked - img.id
                                                        checked.size < capacity -> checked = checked + img.id
                                                        else -> android.widget.Toast.makeText(
                                                            context, "最多还可加 $capacity 张", android.widget.Toast.LENGTH_SHORT,
                                                        ).show()
                                                    }
                                                },
                                            )
                                        }
                                    }
                                }
                            }

                            // 已选信息条（桌面 :1338-1360：左已选数 + 右总计/上限）
                            val totalImageCount = store.count + checked.size
                            val atLimit = totalImageCount >= CANVAS_CAPACITY
                            Box(Modifier.fillMaxWidth().height(1.dp).background(colors.border))
                            Row(
                                Modifier
                                    .fillMaxWidth()
                                    .background(colors.panel)
                                    .padding(horizontal = 16.dp, vertical = 10.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Text("已选择: ", fontSize = 14.sp, color = colors.textSecondary)
                                Text("${checked.size}", fontSize = 14.sp, fontWeight = FontWeight.SemiBold, color = colors.primary)
                                Text(" 张图片", fontSize = 14.sp, color = colors.textSecondary)
                                if (visibleCount > 0) {
                                    Spacer(Modifier.width(8.dp))
                                    Text("(共找到: $visibleCount)", fontSize = 12.sp, color = Color(colors.palette.hint))
                                }
                                Spacer(Modifier.weight(1f))
                                Text(
                                    "总计: $totalImageCount / $CANVAS_CAPACITY",
                                    fontSize = 14.sp,
                                    fontWeight = FontWeight.Medium,
                                    color = if (atLimit) Color(colors.palette.danger) else colors.textSecondary,
                                )
                                if (atLimit) {
                                    Spacer(Modifier.width(6.dp))
                                    Text("(已达到上限)", fontSize = 12.sp, color = Color(colors.palette.danger))
                                }
                            }
                        }
                    }

                    // —— 底部操作区（桌面 :1391-1423）——
                    Box(Modifier.fillMaxWidth().height(1.dp).background(colors.border))
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .background(colors.panel)
                            .padding(horizontal = 16.dp, vertical = 8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text("画布中: ", fontSize = 14.sp, color = colors.textSecondary)
                        Text("${store.count}", fontSize = 14.sp, fontWeight = FontWeight.Medium, color = colors.textPrimary)
                        Text(" 张", fontSize = 14.sp, color = colors.textSecondary)
                        Spacer(Modifier.weight(1f))
                        // 清除选择（桌面 :1399-1406：红 X，空选禁用 opacity-30）
                        Box(
                            Modifier
                                .size(48.dp)
                                .clip(RoundedCornerShape(8.dp))
                                .clickable(enabled = checked.isNotEmpty(), onClickLabel = "清除选择") { checked = emptySet() },
                            contentAlignment = Alignment.Center,
                        ) {
                            Icon(
                                DlgIconX,
                                contentDescription = "清除选择",
                                tint = Color(colors.palette.danger).copy(alpha = if (checked.isEmpty()) 0.3f else 1f),
                                modifier = Modifier.size(20.dp),
                            )
                        }
                        Spacer(Modifier.width(12.dp))
                        // 取消（桌面 :1407-1412：白底描边圆角）
                        Box(
                            Modifier
                                .height(48.dp)
                                .clip(RoundedCornerShape(8.dp))
                                .background(colors.content)
                                .border(1.dp, colors.border, RoundedCornerShape(8.dp))
                                .clickable(onClickLabel = "取消") { onDismiss() }
                                .padding(horizontal = 20.dp),
                            contentAlignment = Alignment.Center,
                        ) {
                            Text("取消", fontSize = 14.sp, fontWeight = FontWeight.Medium, color = colors.textPrimary)
                        }
                        Spacer(Modifier.width(12.dp))
                        // 确认添加（桌面 :1413-1421：bg-blue-600 主钮 + Check 图标 + (N)，
                        // 空选禁用 opacity-50；blue-600 = primaryDeep token）
                        val confirmEnabled = checked.isNotEmpty()
                        Row(
                            Modifier
                                .height(48.dp)
                                .clip(RoundedCornerShape(8.dp))
                                .background(if (confirmEnabled) colors.primaryDeep else colors.primaryDeep.copy(alpha = 0.5f))
                                .clickable(enabled = confirmEnabled, onClickLabel = "确认添加") { confirmChecked() }
                                .padding(horizontal = 20.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Icon(IconCheck, contentDescription = null, tint = Color.White, modifier = Modifier.size(16.dp))
                            Spacer(Modifier.width(6.dp))
                            Text(
                                if (checked.isEmpty()) "确认添加" else "确认添加 (${checked.size})",
                                fontSize = 14.sp,
                                fontWeight = FontWeight.Bold,
                                color = Color.White,
                            )
                        }
                    }
                }
            }
        }
    }
}

/** 左栏树节点（桌面 TreeNode :49-58 的触屏子集：相册无层级、人物无数据源）。 */
private data class PickerNode(
    /** "folder" | "topic" | "tag"（同时是 onLoad scope 的前缀语义） */
    val kind: String,
    /** folderId / topicId / tagName，即 onLoad 的 key */
    val key: String,
    val name: String,
    val depth: Int,
    val hasChildren: Boolean,
    /** 现成计数字段（Folder.imageCount / FfiTopic.fileCount / TagEntry.count），null 不显示 */
    val count: Long?,
)

/**
 * 左栏类目行（桌面 :937-980 的 px-3 py-2 rounded-lg 按钮）：选中 = 主色 15% 底 +
 * 强调色图标/文字（桌面 bg-blue-100 / bg-pink-100 同位；专题用 topicPink）。
 * 行高 48dp 保命中（桌面 py-2≈36px，触屏放大）。
 */
@Composable
private fun CategoryButton(
    label: String,
    icon: ImageVector,
    accent: Color,
    selected: Boolean,
    onClick: () -> Unit,
) {
    val colors = AuroraTheme.colors
    Row(
        Modifier
            .fillMaxWidth()
            .height(48.dp)
            .clip(RoundedCornerShape(8.dp))
            .background(if (selected) colors.primary.copy(alpha = 0.15f) else Color.Transparent)
            .clickable(onClickLabel = label, onClick = onClick)
            .padding(horizontal = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            icon,
            contentDescription = null,
            tint = if (selected) accent else colors.textSecondary,
            modifier = Modifier.size(18.dp),
        )
        Spacer(Modifier.width(8.dp))
        Text(
            label,
            fontSize = 14.sp,
            fontWeight = FontWeight.Medium,
            color = if (selected) accent else colors.textPrimary,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

/**
 * 左栏树行（桌面 renderTreeNode :780-816）：左缘选中条（桌面 border-l-2 border-blue-500
 * :792）+ 深度缩进（桌面 12+depth*16 → 12+depth*14）+ 展开箭头（仅专题有子级时）+
 * 类目图标（强调色常显）+ 名称 + 右侧计数徽标。整行命中 48dp。
 */
@Composable
private fun PickerNodeRow(
    node: PickerNode,
    selected: Boolean,
    expanded: Boolean,
    accent: Color,
    onClick: () -> Unit,
) {
    val colors = AuroraTheme.colors
    Row(
        Modifier
            .fillMaxWidth()
            .height(48.dp)
            .background(if (selected) colors.primary.copy(alpha = 0.10f) else Color.Transparent)
            .clickable(onClickLabel = node.name, onClick = onClick),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.width(3.dp).height(24.dp).background(if (selected) colors.primary else Color.Transparent))
        Spacer(Modifier.width((9 + node.depth * 14).coerceAtMost(60).dp))
        if (node.hasChildren) {
            Icon(
                if (expanded) DlgIconChevronDown else DlgIconChevronRight,
                contentDescription = if (expanded) "收起" else "展开",
                tint = Color(colors.palette.hint),
                modifier = Modifier.size(14.dp),
            )
            Spacer(Modifier.width(4.dp))
        } else {
            // 无子级节点与箭头对齐的占位（桌面 :805 的空位 div）
            Spacer(Modifier.width(18.dp))
        }
        val icon = when (node.kind) {
            "topic" -> IconLayoutTemplate
            "tag" -> DlgIconTag
            else -> DlgIconFolder
        }
        Icon(icon, contentDescription = null, tint = accent, modifier = Modifier.size(16.dp))
        Spacer(Modifier.width(8.dp))
        Text(
            node.name,
            fontSize = 14.sp,
            color = colors.textPrimary,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        // 计数徽标（桌面 :810-814：右对齐 text-xs，选中变主色；注意是总量口径，
        // 桌面的「可添加数」需逐图排除已在画布，端上无现成统计）
        node.count?.let {
            Text(it.toString(), fontSize = 12.sp, color = if (selected) colors.primary else Color(colors.palette.hint))
            Spacer(Modifier.width(12.dp))
        }
    }
}

/**
 * 弹窗网格单元（桌面 :826-863 虚拟滚动行内单元）：2dp 选中描边（blue-500，未选透明）
 * + 方形缩略图 + 名称条。选中态 = 整格 20% 主色罩 + 居中 28dp 主色圆 Check（:849-855），
 * 常显不依赖 hover；已在画布恒勾 + 黑 35% 压暗 + 灰色勾（触屏语义：可见但不可重复加，
 * 点击弹 Toast）。整格可点，命中 ≥120dp。
 */
@Composable
private fun PickerCell(
    image: Image,
    checked: Boolean,
    alreadyInCanvas: Boolean,
    enabled: Boolean,
    thumbnailLoader: ThumbnailLoader,
    onToggle: () -> Unit,
) {
    val colors = AuroraTheme.colors
    Column(
        Modifier
            .clip(RoundedCornerShape(8.dp))
            .border(2.dp, if (checked) colors.primary else Color.Transparent, RoundedCornerShape(8.dp))
            .clickable(enabled = enabled, onClickLabel = image.name, onClick = onToggle),
    ) {
        Box(
            Modifier
                .fillMaxWidth()
                .aspectRatio(1f)
                .background(Color(colors.palette.placeholderBg)),
            contentAlignment = Alignment.Center,
        ) {
            val imageId = remember(image.contentUri) { thumbnailLoader.extractImageId(image.contentUri) }
            val bmp by produceState<android.graphics.Bitmap?>(initialValue = null, imageId) {
                value = withContext(Dispatchers.IO) { thumbnailLoader.loadFastLimited(imageId) }
            }
            bmp?.let {
                Image(
                    bitmap = it.asImageBitmap(),
                    contentDescription = image.name,
                    modifier = Modifier.fillMaxSize(),
                )
            } ?: CircularProgressIndicator(
                modifier = Modifier.size(20.dp),
                strokeWidth = 2.dp,
                color = colors.primary,
            )
            if (alreadyInCanvas) {
                // 压暗层（触屏替代桌面「直接从列表排除」的语义，保留可见性 + 恒勾）
                Box(Modifier.matchParentSize().background(Color.Black.copy(alpha = 0.35f)))
            }
            if (checked) {
                Box(Modifier.matchParentSize().background(colors.primary.copy(alpha = 0.2f)))
                Box(
                    Modifier
                        .size(28.dp)
                        .clip(CircleShape)
                        .background(if (alreadyInCanvas) Color(colors.palette.hint) else colors.primary),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(IconCheck, contentDescription = null, tint = Color.White, modifier = Modifier.size(16.dp))
                }
            }
        }
        // 名称条（桌面 :857-861：p-2 bg-gray-50 border-t text-xs truncate）
        Box(Modifier.fillMaxWidth().height(1.dp).background(colors.border))
        Text(
            image.name,
            fontSize = 12.sp,
            color = colors.textSecondary,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier
                .fillMaxWidth()
                .background(colors.panel)
                .padding(horizontal = 8.dp, vertical = 6.dp),
        )
    }
}

/**
 * 人物 accent（桌面 AddImageModal people headerBg/menuIcon 紫 #A855F7；与 TreeSidebar
 * 的 SECTION_PURPLE :779 同值——那边是 private 就地持有，本文件同先例就近持有一份）。
 */
private val PEOPLE_PURPLE = Color(0xFFA855F7)

// —— 弹窗自绘图标（lucide 线性风格 24 视口 / 2 线宽 / 圆头；路径与 TreeSidebar/TopBar
//    的私有版本同笔画，2026-09-24 就近持有，Layout/Check/Images 复用共享 internal 版）——

/** lucide folder。 */
private val DlgIconFolder: ImageVector by lazy {
    auroraIcon("DlgFolder") {
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

/** lucide tag（标签牌 + 铆点；铆点用微线段放大成可见小点）。 */
private val DlgIconTag: ImageVector by lazy {
    auroraIcon("DlgTag") {
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

/** lucide search。 */
private val DlgIconSearch: ImageVector by lazy {
    auroraIcon("DlgSearch") {
        moveTo(3f, 11f)
        arcTo(8f, 8f, 0f, true, true, 19f, 11f)
        arcTo(8f, 8f, 0f, true, true, 3f, 11f)
        close()
        moveTo(21f, 21f)
        lineTo(16.65f, 16.65f)
    }
}

/** lucide x。 */
private val DlgIconX: ImageVector by lazy {
    auroraIcon("DlgX") {
        moveTo(18f, 6f)
        lineTo(6f, 18f)
        moveTo(6f, 6f)
        lineTo(18f, 18f)
    }
}

/** lucide chevron-right（专题树收起态）。 */
private val DlgIconChevronRight: ImageVector by lazy {
    auroraIcon("DlgChevronRight") {
        moveTo(9f, 18f)
        lineTo(15f, 12f)
        lineTo(9f, 6f)
    }
}

/** lucide chevron-down（专题树展开态）。 */
private val DlgIconChevronDown: ImageVector by lazy {
    auroraIcon("DlgChevronDown") {
        moveTo(6f, 9f)
        lineTo(12f, 15f)
        lineTo(18f, 9f)
    }
}
