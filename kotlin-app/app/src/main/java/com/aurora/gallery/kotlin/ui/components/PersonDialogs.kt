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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.aurora.gallery.kotlin.ui.theme.AuroraTheme
import uniffi.aurora_core.FfiPerson

/**
 * 人物总览的**弹窗层**（远端改名/改描述、「添加到人物」选择器）。
 *
 * 2026-10-09 从 `TagsOverview.kt` 拆出。两个弹窗是宿主（`MainActivity`）直接消费的入口，
 * 保持 `public`；它们只依赖 [FfiPerson] 与主题，不碰卡片层。
 */

/**
 * 远端人物输入弹窗（M6a 阶段 5）：复用 [CreateTopicDialog] 的形制（AlertDialog +
 * OutlinedTextField + 确认/取消），重命名与改描述共用一个组件。[allowEmpty] =
 * 允许空串确认（改描述的空串 = 清空描述，契约 §3.2 的整行写语义）；重命名恒 false。
 */
@Composable
fun LanPersonEditDialog(
    title: String,
    initialText: String,
    placeholder: String,
    confirmLabel: String,
    onDismiss: () -> Unit,
    onConfirm: (String) -> Unit,
    allowEmpty: Boolean = false,
) {
    val colors = AuroraTheme.colors
    var text by remember { mutableStateOf(initialText) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = {
            OutlinedTextField(
                value = text,
                onValueChange = { text = it },
                singleLine = true,
                placeholder = { Text(placeholder, color = colors.textSecondary) },
            )
        },
        confirmButton = {
            TextButton(
                enabled = allowEmpty || text.isNotBlank(),
                onClick = { onConfirm(text.trim()) },
            ) {
                Text(
                    confirmLabel,
                    color = if (allowEmpty || text.isNotBlank()) colors.primaryDeep else colors.textSecondary,
                )
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text("取消", color = colors.textPrimary)
            }
        },
    )
}

/**
 * 「添加到人物」选择弹窗（桌面 `AddToPersonModal` 的触屏同位）：搜索框 + **多选**人物
 * 列表 + 底部「添加」。多选而非单选是照桌面口径——一批图往往同属几个人物，一次勾完
 * 比来回点 N 次少 N-1 步（VM `addFilesToLocalPersons` 本来就吃 id 列表）。
 *
 * 形制（AlertDialog + 48dp 行 + 圆角面板列表）沿用同仓 `TopicPickerDialog`，不新造视觉。
 * 行首是首字符圆点而非真头像：弹窗里人物量级小、且这一层的任务是「认名字」不是「认脸」。
 */
@Composable
fun PersonPickerDialog(
    people: List<FfiPerson>,
    onDismiss: () -> Unit,
    onPick: (List<String>) -> Unit,
    /** 标题与确认文案（宿主按「加入 / 解绑」两种语义给）。 */
    title: String = "添加到人物",
    confirmLabel: String = "添加",
    emptyHint: String = "暂无人物。先在人物页点「新建人物」建一个，再把图加进来。",
) {
    val colors = AuroraTheme.colors
    var query by remember { mutableStateOf("") }
    var selected by remember { mutableStateOf(setOf<String>()) }
    val filtered = remember(people, query) {
        val q = query.trim()
        if (q.isEmpty()) people else people.filter { it.name.contains(q, ignoreCase = true) }
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = {
            if (people.isEmpty()) {
                Text(emptyHint, color = colors.textSecondary)
            } else {
                Column {
                    OutlinedTextField(
                        value = query,
                        onValueChange = { query = it },
                        singleLine = true,
                        placeholder = { Text("搜索人物", color = colors.textSecondary) },
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Spacer(Modifier.height(8.dp))
                    if (filtered.isEmpty()) {
                        Text(
                            "没有匹配「$query」的人物",
                            color = colors.textSecondary,
                            modifier = Modifier.padding(vertical = 12.dp),
                        )
                    } else {
                        LazyColumn(
                            Modifier
                                .fillMaxWidth()
                                .heightIn(max = 340.dp)
                                .clip(RoundedCornerShape(12.dp))
                                .background(colors.panel),
                        ) {
                            items(
                                count = filtered.size,
                                key = { i -> filtered[i].id },
                            ) { i ->
                                val person = filtered[i]
                                val checked = person.id in selected
                                Row(
                                    Modifier
                                        .fillMaxWidth()
                                        .defaultMinSize(minHeight = 48.dp)
                                        .clip(RoundedCornerShape(8.dp))
                                        .clickable {
                                            selected = if (checked) selected - person.id
                                            else selected + person.id
                                        }
                                        .padding(horizontal = 8.dp, vertical = 8.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                ) {
                                    Spacer(Modifier.size(4.dp))
                                    Box(
                                        Modifier
                                            .size(28.dp)
                                            .clip(CircleShape)
                                            .background(colors.surface)
                                            .border(1.dp, colors.subtle, CircleShape),
                                        contentAlignment = Alignment.Center,
                                    ) {
                                        Text(
                                            person.name.take(1),
                                            fontSize = 13.sp,
                                            fontWeight = FontWeight.Medium,
                                            color = colors.primary,
                                        )
                                    }
                                    Spacer(Modifier.size(10.dp))
                                    Text(
                                        person.name,
                                        fontSize = 15.sp,
                                        color = colors.textPrimary,
                                        maxLines = 1,
                                        overflow = TextOverflow.Ellipsis,
                                        modifier = Modifier.weight(1f),
                                    )
                                    Text(
                                        "${person.count}",
                                        fontSize = 12.sp,
                                        color = colors.textSecondary,
                                    )
                                    Spacer(Modifier.size(10.dp))
                                    Text(
                                        if (checked) "✓" else "",
                                        fontSize = 16.sp,
                                        fontWeight = FontWeight.Bold,
                                        color = colors.primaryDeep,
                                    )
                                }
                            }
                        }
                    }
                }
            }
        },
        confirmButton = {
            TextButton(
                enabled = selected.isNotEmpty(),
                onClick = { onPick(selected.toList()) },
            ) {
                Text(
                    if (selected.isEmpty()) confirmLabel else "$confirmLabel（${selected.size}）",
                    color = if (selected.isNotEmpty()) colors.primaryDeep else colors.textSecondary,
                )
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text("取消", color = colors.textPrimary)
            }
        },
    )
}
