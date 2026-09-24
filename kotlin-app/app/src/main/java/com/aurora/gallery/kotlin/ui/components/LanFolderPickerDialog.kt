package com.aurora.gallery.kotlin.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import com.aurora.gallery.kotlin.LanBrowseResult
import com.aurora.gallery.kotlin.ui.theme.AuroraTheme

/**
 * LAN 目录选择弹窗的用途（决定标题文案/底部确认按钮/是否显示图片行）：
 *  - [LanPickerMode.MOVE]：移动目标目录（显示目录行 + 「移动到这里」）；
 *  - [LanPickerMode.COPY]：复制目标目录（显示目录行 + 「复制到这里」）；
 *  - [LanPickerMode.AVATAR]：选一张远端图当头像（目录行 + 图片行，点图即走，无确认钮）。
 */
enum class LanPickerMode { MOVE, COPY, AVATAR }

/**
 * LAN 目录选择弹窗（M6a 阶段 6：互联态文件操作的远端目标/头像选择器）。宿主一句话接线：
 * [browse] 转 `GalleryViewModel.browseLanPath`、[thumbnailUrlOf] 转缩略图 URL 构造器，
 * 组件只消费 LanBrowseResult/LanRemoteFolder/LanRemoteImage 数据类型，**不持有**
 * LanClient/LanManager（网络层不进 UI，组件可独立预览/测试）。
 *
 * 形制对齐 [LanTopicPickerDialog]（AlertDialog + panel 底圆角滚动列表 + 48dp 行 +
 * 翡翠 Wifi 标识），「导航 + 底部确认」的交互语汇对齐本地 [TargetPickerDialog]
 * （移动到这里/复制到这里），但数据源完全不同：那边是本地 MediaStore 相册扁平表，
 * 这边是远端 browse 逐层下钻的目录树。
 *
 * 为什么用显式导航栈、绝不字符串拼父路径：path 是契约 §0 的**不透明字符串**
 * （不解析、不规范化、不拼接，LanClient.kt 同款铁律）——客户端看不见分隔符约定/编码
 * 规则/服务端规范化逻辑，从子路径拼「父路径」在特殊目录名或服务端规则变化下必碎。
 * 所以导航历史用 `List<String?>` 栈（null = 共享根，与 browse 的 path 入参一一对应）：
 * 进目录 push(path)，「上一级」pop 历史栈，是纯记忆操作而非字符串运算。
 *
 * 为什么没有「新建目录」入口（对齐本地 TargetPickerDialog 的「+ 新建相册」在此缺席）：
 * 契约没有 mkdir 端点，move/copy 的 target_dir 必须是服务端**已存在**的目录（不存在时
 * 服务端 404）。选择器只能在既有目录树里导航，选中的永远是真实存在的节点。
 *
 * 顶部目录名尾段（substringAfterLast('/')）**仅用于显示**——请求构造只用栈里保存的
 * 原样 path，绝不把显示文本回传参与请求（GalleryViewModel/LanClient 已有同款先例）。
 */
@Composable
fun LanFolderPickerDialog(
    mode: LanPickerMode,
    /** 单次远端 browse（宿主转 GalleryViewModel.browseLanPath）；path null/空 = 共享根。 */
    browse: (path: String?, onReady: (LanBrowseResult?) -> Unit) -> Unit,
    /** 远端缩略图 URL 构造器（AVATAR 模式图片行用；未连接回 null，行退化占位底）。 */
    thumbnailUrlOf: (remotePath: String) -> String?,
    onDismiss: () -> Unit,
    /** MOVE/COPY 模式：确认目标目录。[targetDir] 为 opaque path（根级 = ""，MainActivity 先例）。 */
    onPickFolder: (targetDir: String) -> Unit,
    /** AVATAR 模式：选中一张远端图。 */
    onPickImage: (imagePath: String, imageName: String) -> Unit,
) {
    val colors = AuroraTheme.colors
    // 显式导航栈（null = 共享根），见 KDoc「为什么不能拼父路径」。
    var stack by remember { mutableStateOf(listOf<String?>(null)) }
    // 「重试」要点燃同一条 LaunchedEffect：current 没变，只能靠额外 key 重触发。
    var retryTick by remember { mutableIntStateOf(0) }
    var loading by remember { mutableStateOf(true) }
    var failed by remember { mutableStateOf(false) }
    var result by remember { mutableStateOf<LanBrowseResult?>(null) }
    val current = stack.last()

    LaunchedEffect(current, retryTick) {
        val requested = current
        loading = true
        failed = false
        browse(requested) { res ->
            // 过期响应过滤：快速进出目录时，旧目录的回包不得覆盖新目录的状态
            //（比较的是栈顶原样 path，不解析不规范化）。
            if (stack.lastOrNull() == requested) {
                result = res
                failed = res == null
                loading = false
            }
        }
    }

    val title = when (mode) {
        LanPickerMode.MOVE -> "移动到网络目录"
        LanPickerMode.COPY -> "复制到网络目录"
        LanPickerMode.AVATAR -> "选择头像图片"
    }
    // AVATAR 点图即走，没有底部确认钮。
    val confirmLabel = when (mode) {
        LanPickerMode.MOVE -> "移动到这里"
        LanPickerMode.COPY -> "复制到这里"
        LanPickerMode.AVATAR -> null
    }
    // 顶部目录名只是显示文案，绝不回传参与请求（见 KDoc）。
    val currentName = when {
        current == null -> "共享根"
        else -> current.substringAfterLast('/').ifEmpty { current }
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = {
            Column {
                // 顶部：当前位置 +「上一级」（栈深 1 = 已在共享根，无上级可回，禁用）。
                Row(
                    Modifier
                        .fillMaxWidth()
                        .defaultMinSize(minHeight = 48.dp)
                        .padding(horizontal = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(
                        imageVector = IconWifi,
                        contentDescription = null,
                        tint = SECTION_EMERALD,
                        modifier = Modifier.size(16.dp),
                    )
                    Spacer(Modifier.size(10.dp))
                    Text(
                        currentName,
                        fontSize = 15.sp,
                        fontWeight = FontWeight.SemiBold,
                        color = colors.textPrimary,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f),
                    )
                    TextButton(
                        enabled = stack.size > 1,
                        onClick = { stack = stack.dropLast(1) },
                    ) {
                        Text(
                            "上一级",
                            color = if (stack.size > 1) colors.primary else colors.textSecondary,
                        )
                    }
                }
                // 列表容器：loading/错误/内容共用同一个圆角面板，切换状态不跳形。
                Column(
                    Modifier
                        .fillMaxWidth()
                        .heightIn(max = 420.dp)
                        .clip(RoundedCornerShape(12.dp))
                        .background(colors.panel)
                        .padding(6.dp)
                        .verticalScroll(rememberScrollState()),
                ) {
                    when {
                        loading -> {
                            Row(
                                Modifier
                                    .fillMaxWidth()
                                    .defaultMinSize(minHeight = 48.dp)
                                    .padding(horizontal = 8.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                CircularProgressIndicator(
                                    modifier = Modifier.size(16.dp),
                                    strokeWidth = 2.dp,
                                    color = colors.primary,
                                )
                                Spacer(Modifier.size(10.dp))
                                Text(
                                    "正在读取目录…",
                                    fontSize = 14.sp,
                                    color = colors.textSecondary,
                                )
                            }
                        }
                        failed -> {
                            Text(
                                "读取目录失败，请检查网络连接后重试。",
                                fontSize = 14.sp,
                                color = colors.textSecondary,
                                modifier = Modifier.padding(horizontal = 8.dp, vertical = 12.dp),
                            )
                            TextButton(onClick = { retryTick++ }) {
                                Text("重试", color = colors.primary)
                            }
                        }
                        else -> {
                            val folders = result?.folders.orEmpty()
                            // 图片行仅 AVATAR 模式出现；type=="video" 的项不显示——
                            // 全 App 对视频的支持未定（阶段 4 远端网格同款过滤先例），
                            // 头像选择只认非视频项。共享根级散图就是 browse(null) 返回的
                            // images，同一份数据自然列出，无需特判。
                            val images = if (mode == LanPickerMode.AVATAR) {
                                result?.images.orEmpty().filter { it.type != "video" }
                            } else {
                                emptyList()
                            }
                            if (folders.isEmpty() && images.isEmpty()) {
                                Text(
                                    if (mode == LanPickerMode.AVATAR) {
                                        "此目录下没有可选的图片。"
                                    } else {
                                        "此目录下没有子目录，可以直接在当前位置完成操作。"
                                    },
                                    fontSize = 14.sp,
                                    color = colors.textSecondary,
                                    modifier = Modifier.padding(horizontal = 8.dp, vertical = 12.dp),
                                )
                            }
                            // 目录行：三种模式都显示（AVATAR 也要能下钻找图）。
                            folders.forEach { folder ->
                                Row(
                                    Modifier
                                        .fillMaxWidth()
                                        .defaultMinSize(minHeight = 48.dp)
                                        .clip(RoundedCornerShape(8.dp))
                                        .clickable { stack = stack + folder.path }
                                        .padding(horizontal = 8.dp, vertical = 8.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                ) {
                                    Spacer(Modifier.size(12.dp))
                                    Icon(
                                        imageVector = IconWifi,
                                        contentDescription = null,
                                        tint = SECTION_EMERALD,
                                        modifier = Modifier.size(16.dp),
                                    )
                                    Spacer(Modifier.size(10.dp))
                                    Text(
                                        folder.name,
                                        fontSize = 15.sp,
                                        color = colors.textPrimary,
                                        maxLines = 1,
                                        overflow = TextOverflow.Ellipsis,
                                        modifier = Modifier.weight(1f),
                                    )
                                    Text(
                                        folder.imageCount.toString(),
                                        fontSize = 12.sp,
                                        color = colors.textSecondary,
                                    )
                                    Spacer(Modifier.size(8.dp))
                                }
                            }
                            // 图片行（仅 AVATAR）：点图直接 onPickImage，无二级确认。
                            images.forEach { img ->
                                Row(
                                    Modifier
                                        .fillMaxWidth()
                                        .defaultMinSize(minHeight = 48.dp)
                                        .clip(RoundedCornerShape(8.dp))
                                        .clickable { onPickImage(img.path, img.name) }
                                        .padding(horizontal = 8.dp, vertical = 8.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                ) {
                                    Spacer(Modifier.size(12.dp))
                                    // 48dp 缩略图；thumbnailUrlOf 回 null（未连接）时
                                    // AsyncImage 不出图，行退化为底色占位，不阻塞选择。
                                    Box(
                                        Modifier
                                            .size(48.dp)
                                            .clip(CircleShape)
                                            .background(colors.border),
                                    ) {
                                        AsyncImage(
                                            model = thumbnailUrlOf(img.path),
                                            contentDescription = img.name,
                                            contentScale = ContentScale.Crop,
                                            modifier = Modifier.fillMaxSize(),
                                        )
                                    }
                                    Spacer(Modifier.size(10.dp))
                                    Text(
                                        img.name,
                                        fontSize = 15.sp,
                                        color = colors.textPrimary,
                                        maxLines = 1,
                                        overflow = TextOverflow.Ellipsis,
                                        modifier = Modifier.weight(1f),
                                    )
                                    Spacer(Modifier.size(8.dp))
                                }
                            }
                        }
                    }
                }
            }
        },
        confirmButton = {
            // MOVE/COPY 的确认（TargetPickerDialog 语汇）：落在当前栈顶目录。
            // loading 中禁用——目录还没读出来就确认是选了个没见过的位置。
            if (confirmLabel != null) {
                TextButton(
                    enabled = !loading,
                    onClick = { onPickFolder(current ?: "") },
                ) {
                    Text(
                        confirmLabel,
                        color = if (!loading) colors.primaryDeep else colors.textSecondary,
                    )
                }
            }
            TextButton(onClick = onDismiss) { Text("取消", color = colors.textPrimary) }
        },
    )
}
