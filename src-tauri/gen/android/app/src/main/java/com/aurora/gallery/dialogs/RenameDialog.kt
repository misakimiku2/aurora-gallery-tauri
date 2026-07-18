package com.aurora.gallery.dialogs

import android.app.AlertDialog
import android.content.Context
import android.widget.EditText

/**
 * 重命名弹窗（使用系统 AlertDialog）。
 *
 * 用法：
 * ```kotlin
 * RenameDialog(
 *     context = context,
 *     currentName = item.name,
 *     onConfirm = { newName -> ... }
 * ).show()
 * ```
 */
class RenameDialog(
    private val context: Context,
    private val currentName: String,
    private val onConfirm: (String) -> Unit
) {
    fun show() {
        val input = EditText(context).apply {
            setText(currentName)
            setSingleLine(true)
            setPadding(48, 24, 48, 24)
        }
        AlertDialog.Builder(context)
            .setTitle("重命名")
            .setView(input)
            .setPositiveButton("保存") { _, _ ->
                val newName = input.text.toString().trim()
                if (newName.isNotEmpty() && newName != currentName) {
                    onConfirm(newName)
                }
            }
            .setNegativeButton("取消", null)
            .show()
    }
}
