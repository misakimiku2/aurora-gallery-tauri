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
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.aurora.gallery.kotlin.ui.theme.AuroraTheme
import uniffi.aurora_core.Folder

/**
 * 复制/移动的**目标相册选择器**（M4b 1.4/1.3）。数据源 = `viewModel.folders`（扁平
 * bucket 列表，D18），形制对齐 TopicPickerDialog（列表 + panel 底圆角容器）。底部常驻
 * 「+ 新建相册」入口（1.3 懒创建：不在选择器外提供独立的建空相册入口），点开就地变成
 * 名字输入行；确认后由宿主做重名合并拦截（细则 iii）再落 MediaStore。
 *
 * 顶部「搜索相册」框（位置对齐桌面 FolderPickerModal：标题下、列表上）按名字过滤
 * （[filterFoldersForSearch]，大小写不敏感），仅过滤展示不改选择语义；右侧清词钮。
 *
 * 与查看器的 View 体系 FolderPickerDialog 是两处实现（D13 先例：不强合），但写入路径
 * 只有一条（GalleryViewModel 的写原语）。
 */
@Composable
fun TargetPickerDialog(
    folders: List<Folder>,
    /** "copy" | "move"（标题与宿主执行分支共用）。 */
    type: String,
    onDismiss: () -> Unit,
    /** 选中既有相册。 */
    onPickFolder: (Folder) -> Unit,
    /** 「+ 新建相册」输入名字确认（宿主做合并拦截与校验）。 */
    onPickNewAlbum: (String) -> Unit,
) {
    val colors = AuroraTheme.colors
    var enteringName by remember { mutableStateOf(false) }
    var name by remember { mutableStateOf(TextFieldValue("")) }
    var query by remember { mutableStateOf("") }
    val searchFocus = remember { FocusRequester() }
    val visibleFolders = filterFoldersForSearch(folders, query)

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(if (type == "copy") "复制到相册" else "移动到相册") },
        text = {
            Column {
                // 搜索框（位置对齐桌面 FolderPickerModal：标题下、列表上；形制对齐
                // CanvasAddImagesDialog 的搜索行）。整行可点唤起键盘（触控目标 48dp），
                // 有词时描边转主色；清词钮视觉 14dp、命中 48dp。
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
                        imageVector = TargetPickerIconSearch,
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
                                imageVector = TargetPickerIconX,
                                contentDescription = "清除搜索",
                                tint = colors.textSecondary,
                                modifier = Modifier.size(14.dp),
                            )
                        }
                    }
                }
                Spacer(Modifier.size(10.dp))
                Column(
                    Modifier
                        .heightIn(max = 340.dp)
                        .clip(RoundedCornerShape(12.dp))
                        .background(colors.panel)
                        .padding(6.dp)
                        .verticalScroll(rememberScrollState()),
                ) {
                    if (visibleFolders.isEmpty()) {
                        Text(
                            if (folders.isEmpty()) "暂无相册" else "无匹配相册",
                            fontSize = 14.sp,
                            color = colors.textSecondary,
                            modifier = Modifier.padding(horizontal = 8.dp, vertical = 12.dp),
                        )
                    }
                    visibleFolders.forEach { folder ->
                        Row(
                            Modifier
                                .fillMaxWidth()
                                .defaultMinSize(minHeight = 48.dp)
                                .clip(RoundedCornerShape(8.dp))
                                .clickable { onPickFolder(folder) }
                                .padding(horizontal = 8.dp, vertical = 8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Icon(
                                imageVector = TargetPickerIconFolder,
                                contentDescription = null,
                                tint = colors.primary,
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
                        }
                    }
                }
                if (enteringName) {
                    Spacer(Modifier.size(12.dp))
                    OutlinedTextField(
                        value = name,
                        onValueChange = { name = it },
                        singleLine = true,
                        placeholder = { Text("相册名称（建在 Pictures 下）", color = colors.textSecondary) },
                        modifier = Modifier.fillMaxWidth(),
                    )
                } else {
                    Spacer(Modifier.size(8.dp))
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .defaultMinSize(minHeight = 48.dp)
                            .clip(RoundedCornerShape(8.dp))
                            .clickable { enteringName = true }
                            .padding(horizontal = 8.dp, vertical = 8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Icon(
                            imageVector = TargetPickerIconPlus,
                            contentDescription = null,
                            tint = colors.primary,
                            modifier = Modifier.size(16.dp),
                        )
                        Spacer(Modifier.size(10.dp))
                        Text(
                            "新建相册",
                            fontSize = 15.sp,
                            fontWeight = FontWeight.SemiBold,
                            color = colors.primary,
                        )
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
            }
            TextButton(onClick = onDismiss) { Text("取消", color = colors.textPrimary) }
        },
    )
}

// ---- 自绘图标：lucide 线性风格（同 SelectionBar.kt 的 selIconBuilder，按文件就近持有一份）----

private fun pickerIconBuilder(
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
        strokeLineWidth = 2f,
        strokeLineCap = StrokeCap.Round,
        strokeLineJoin = StrokeJoin.Round,
    ) { block() }
}.build()

/** lucide folder。 */
private val TargetPickerIconFolder: ImageVector by lazy {
    pickerIconBuilder("PickerFolder") {
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

/** lucide plus。 */
private val TargetPickerIconPlus: ImageVector by lazy {
    pickerIconBuilder("PickerPlus") {
        moveTo(12f, 5f)
        lineTo(12f, 19f)
        moveTo(5f, 12f)
        lineTo(19f, 12f)
    }
}

/** lucide search。 */
private val TargetPickerIconSearch: ImageVector by lazy {
    pickerIconBuilder("PickerSearch") {
        moveTo(3f, 11f)
        arcTo(8f, 8f, 0f, true, true, 19f, 11f)
        arcTo(8f, 8f, 0f, true, true, 3f, 11f)
        close()
        moveTo(21f, 21f)
        lineTo(16.65f, 16.65f)
    }
}

/** lucide x。 */
private val TargetPickerIconX: ImageVector by lazy {
    pickerIconBuilder("PickerX") {
        moveTo(18f, 6f)
        lineTo(6f, 18f)
        moveTo(6f, 6f)
        lineTo(18f, 18f)
    }
}

/**
 * 搜索过滤纯函数（供 JVM 单测）：名字包含查询即命中（大小写不敏感）；查询 trim 后
 * 为空 = 原样返回全量。
 */
internal fun filterFoldersForSearch(folders: List<Folder>, query: String): List<Folder> {
    val q = query.trim()
    if (q.isEmpty()) return folders
    return folders.filter { it.name.contains(q, ignoreCase = true) }
}
