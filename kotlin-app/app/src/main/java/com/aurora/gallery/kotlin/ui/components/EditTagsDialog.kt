package com.aurora.gallery.kotlin.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.aurora.gallery.kotlin.ui.theme.AuroraTheme

/**
 * 标签编辑弹窗（M4a 4.3 长按菜单的「编辑标签…」）。与查看器的 TagEditDialog（M3 D9
 * 随查看器并入的 View 体系弹窗）**各自实现、行为对齐**（D13 的口径在 4.2 改期后只剩
 * 这一对），写入走同一条 [com.aurora.gallery.kotlin.GalleryViewModel.saveFileUpdates]
 * ——这里只收集标签集合，落库与快照重算都在那条唯一路径里。
 *
 * 与桌面 EditTagsModal 的同位差：不做批量管理（词表增删改在侧栏/标签总览），只做
 * 「已选 chips 增删 + 输入新词 + 词表建议」，够「给这张图改标签」这一个动作。
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun EditTagsDialog(
    fileName: String?,
    currentTags: List<String>,
    /** 词表建议（tagGroups 展平，Rust 排好的组序原样）。 */
    vocabulary: List<String>,
    onDismiss: () -> Unit,
    /** 保存：整体替换该文件的标签集合（`setFileTags` 语义）。 */
    onSave: (List<String>) -> Unit,
) {
    val colors = AuroraTheme.colors
    val pending = remember { mutableStateListOf<String>().apply { addAll(currentTags) } }
    var input by remember { mutableStateOf("") }

    fun addFromInput() {
        val t = input.trim()
        if (t.isNotEmpty() && pending.none { it.equals(t, ignoreCase = true) }) pending.add(t)
        input = ""
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("编辑标签") },
        text = {
            Column(
                Modifier
                    .heightIn(max = 380.dp)
                    .verticalScroll(rememberScrollState()),
            ) {
                if (fileName != null) {
                    Text(
                        fileName,
                        fontSize = 12.sp,
                        color = colors.textSecondary,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    Spacer(Modifier.size(8.dp))
                }
                if (pending.isEmpty()) {
                    Text("暂无标签", fontSize = 13.sp, color = colors.textSecondary)
                } else {
                    FlowRow(
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                        verticalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        pending.forEach { tag ->
                            TagPill(
                                text = tag,
                                trailing = "✕",
                                trailingDesc = "移除标签 $tag",
                                onTrailing = { pending.remove(tag) },
                            )
                        }
                    }
                }
                Spacer(Modifier.size(12.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    OutlinedTextField(
                        value = input,
                        onValueChange = { input = it },
                        singleLine = true,
                        placeholder = { Text("新标签", color = colors.textSecondary) },
                        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                        keyboardActions = KeyboardActions(onDone = { addFromInput() }),
                        modifier = Modifier.weight(1f),
                    )
                    Spacer(Modifier.size(8.dp))
                    // 添加按钮：48dp 触控目标（desktop-to-android 规范下限）
                    Box(
                        Modifier
                            .size(48.dp)
                            .clip(RoundedCornerShape(12.dp))
                            .clickable { addFromInput() },
                        contentAlignment = Alignment.Center,
                    ) {
                        Text("+", fontSize = 22.sp, color = colors.textPrimary)
                    }
                }
                // 词表建议：输入为空给词表头部，有输入给包含匹配（各限 12 个，弹窗不放全量）
                val suggestions = remember(pending.size, input, vocabulary) {
                    val base = vocabulary.filter { v -> pending.none { it.equals(v, ignoreCase = true) } }
                    if (input.isBlank()) base.take(12)
                    else base.filter { it.contains(input.trim(), ignoreCase = true) }.take(12)
                }
                if (suggestions.isNotEmpty()) {
                    Spacer(Modifier.size(12.dp))
                    Text(
                        "词表",
                        fontSize = 12.sp,
                        fontWeight = FontWeight.Bold,
                        color = colors.textSecondary,
                    )
                    Spacer(Modifier.size(6.dp))
                    FlowRow(
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                        verticalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        suggestions.forEach { s ->
                            TagPill(
                                text = s,
                                trailing = "+",
                                trailingDesc = "添加标签 $s",
                                onTrailing = {
                                    pending.add(s)
                                    input = ""
                                },
                            )
                        }
                    }
                }
            }
        },
        confirmButton = {
            TextButton(onClick = { onSave(pending.toList()) }) {
                Text("保存", color = colors.primaryDeep)
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text("取消", color = colors.textPrimary)
            }
        },
    )
}

/** 标签小胶囊：文字 + 尾部动作符（✕ 移除 / ＋ 添加），命中区 40dp。 */
@Composable
private fun TagPill(
    text: String,
    trailing: String,
    trailingDesc: String,
    onTrailing: () -> Unit,
) {
    val colors = AuroraTheme.colors
    Row(
        Modifier
            .clip(RoundedCornerShape(8.dp))
            .background(colors.subtle)
            .padding(horizontal = 10.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(text, fontSize = 13.sp, color = colors.textPrimary, maxLines = 1)
        Spacer(Modifier.size(4.dp))
        Box(
            Modifier
                .size(40.dp)
                .clickable(onClick = onTrailing),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                trailing,
                fontSize = 14.sp,
                color = colors.textSecondary,
                modifier = Modifier.padding(horizontal = 10.dp),
            )
        }
    }
}
