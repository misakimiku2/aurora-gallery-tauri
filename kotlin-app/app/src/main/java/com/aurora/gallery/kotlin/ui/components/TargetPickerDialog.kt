package com.aurora.gallery.kotlin.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.path
import androidx.compose.ui.text.font.FontWeight
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

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(if (type == "copy") "复制到相册" else "移动到相册") },
        text = {
            Column {
                Column(
                    Modifier
                        .heightIn(max = 340.dp)
                        .clip(RoundedCornerShape(12.dp))
                        .background(colors.panel)
                        .padding(6.dp)
                        .verticalScroll(rememberScrollState()),
                ) {
                    if (folders.isEmpty()) {
                        Text(
                            "暂无相册",
                            fontSize = 14.sp,
                            color = colors.textSecondary,
                            modifier = Modifier.padding(horizontal = 8.dp, vertical = 12.dp),
                        )
                    }
                    folders.forEach { folder ->
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
