package com.aurora.gallery.dialogs

import android.app.Dialog
import android.content.Context
import android.graphics.Color
import android.text.Editable
import android.text.InputType
import android.text.TextWatcher
import android.text.TextUtils
import android.util.Log
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.Window
import android.widget.BaseAdapter
import android.widget.EditText
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ListView
import android.widget.TextView
import com.aurora.gallery.R
import org.json.JSONObject

/** 文件夹节点数据 */
data class FolderNode(
    val id: String,
    val name: String,
    val parentId: String?,
    val children: MutableList<String> = mutableListOf()
)

/** 文件夹树数据 */
data class FolderTreeData(val roots: List<String>, val folders: Map<String, FolderNode>)

/**
 * 文件夹选择弹窗（UI 与 WebView FolderPickerModal 一致）。
 *
 * 用法：
 * ```kotlin
 * FolderPickerDialog(
 *     context = context,
 *     theme = this,
 *     type = "copy", // 或 "move"
 *     fileId = item.fileId,
 *     folderTreeJson = json,
 *     onConfirm = { fileId, targetId, type -> ... }
 * ).show()
 * ```
 */
class FolderPickerDialog(
    private val context: Context,
    private val theme: DialogTheme,
    private val type: String,
    private val fileId: String,
    private val folderTreeJson: String,
    private val onConfirm: (fileId: String, targetFolderId: String, type: String) -> Unit
) {
    fun show() {
        val tree = parseFolderTree(folderTreeJson) ?: return
        val density = DialogUtils.density(context)

        val dialog = Dialog(context)
        dialog.requestWindowFeature(Window.FEATURE_NO_TITLE)
        dialog.setCancelable(true)
        dialog.window?.setBackgroundDrawable(android.graphics.drawable.ColorDrawable(Color.TRANSPARENT))

        // 状态
        val expandedIds = mutableSetOf<String>().apply { addAll(tree.roots) }
        val selectedId = arrayOf<String?>(null)
        val searchQuery = arrayOf("")

        val container = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            background = DialogUtils.createRoundedBg(theme.colorDialogBg(), 12f, theme.colorBorder(), 1f, context)
            setPadding((density * 16).toInt(), (density * 16).toInt(), (density * 16).toInt(), (density * 12).toInt())
        }

        // 标题
        container.addView(TextView(context).apply {
            text = if (type == "copy") "复制到文件夹..." else "移动到文件夹..."
            setTextColor(theme.colorTextPrimary())
            textSize = 18f
            paint.isFakeBoldText = true
            setPadding(0, 0, 0, (density * 12).toInt())
        })

        // 搜索框
        val searchRow = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            background = DialogUtils.createRoundedBg(theme.colorTextBoxBg(), 8f, theme.colorBorder(), 1f, context)
            setPadding((density * 8).toInt(), (density * 6).toInt(), (density * 8).toInt(), (density * 6).toInt())
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply {
                bottomMargin = (density * 12).toInt()
            }
        }
        searchRow.addView(ImageView(context).apply {
            setImageResource(R.drawable.ic_lucide_search)
            setColorFilter(theme.colorTextSecondary())
            setPadding(0, 0, (density * 6).toInt(), 0)
        })
        val searchInput = EditText(context).apply {
            setTextColor(theme.colorTextPrimary())
            setHintTextColor(theme.colorHint())
            textSize = 14f
            background = null
            maxLines = 1
            inputType = InputType.TYPE_CLASS_TEXT
            hint = "搜索..."
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
        }
        searchRow.addView(searchInput)
        val clearBtn = ImageView(context).apply {
            setImageResource(R.drawable.ic_lucide_x)
            setColorFilter(theme.colorTextSecondary())
            setPadding((density * 4).toInt(), 0, 0, 0)
            visibility = View.GONE
        }
        searchRow.addView(clearBtn)
        container.addView(searchRow)

        // 文件夹树容器
        val treeContainer = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            background = DialogUtils.createRoundedBg(theme.colorTextBoxBg(), 8f, theme.colorBorder(), 1f, context)
            setPadding((density * 4).toInt(), (density * 4).toInt(), (density * 4).toInt(), (density * 4).toInt())
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0).apply {
                weight = 1f
            }
        }
        val listView = ListView(context).apply {
            divider = null
            dividerHeight = 0
        }
        treeContainer.addView(listView)
        container.addView(treeContainer)

        // 按钮行
        val buttonRow = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.END
            setPadding(0, (density * 12).toInt(), 0, 0)
        }
        val confirmBtn = DialogUtils.createDialogButton(context, theme, "确认", isPrimary = true) {
            selectedId[0]?.let { targetId ->
                onConfirm(fileId, targetId, type)
                dialog.dismiss()
            }
        }
        confirmBtn.alpha = 0.5f
        confirmBtn.isEnabled = false
        buttonRow.addView(DialogUtils.createDialogButton(context, theme, "取消", isPrimary = false) { dialog.dismiss() })
        buttonRow.addView(confirmBtn)
        container.addView(buttonRow)

        // Adapter
        val onNodeClick: (String) -> Unit = { id ->
            selectedId[0] = id
            confirmBtn.alpha = 1f
            confirmBtn.isEnabled = true
            // 必须用 updateData 同步 Adapter 内部的 selectedId 字段，
            // 仅调 notifyDataSetChanged() 会用旧 selectedId（null）重绘，高亮不显示
            (listView.adapter as? FolderTreeAdapter)?.updateData(
                flattenVisibleNodes(tree, expandedIds, searchQuery[0]),
                expandedIds,
                selectedId[0]
            )
        }
        val onToggleClick: (String) -> Unit = { id ->
            if (expandedIds.contains(id)) expandedIds.remove(id) else expandedIds.add(id)
            (listView.adapter as? FolderTreeAdapter)?.updateData(
                flattenVisibleNodes(tree, expandedIds, searchQuery[0]),
                expandedIds,
                selectedId[0]
            )
        }
        val adapter = FolderTreeAdapter(
            context, theme,
            flattenVisibleNodes(tree, expandedIds, ""),
            expandedIds,
            selectedId[0],
            onNodeClick,
            onToggleClick
        )
        listView.adapter = adapter

        // 搜索框监听
        searchInput.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
            override fun afterTextChanged(s: Editable?) {
                searchQuery[0] = s?.toString() ?: ""
                clearBtn.visibility = if (searchQuery[0].isNotEmpty()) View.VISIBLE else View.GONE
                val newExpanded = if (searchQuery[0].isNotEmpty()) {
                    computeExpandedForSearch(tree, searchQuery[0])
                } else {
                    tree.roots.toMutableSet()
                }
                expandedIds.clear()
                expandedIds.addAll(newExpanded)
                adapter.updateData(
                    flattenVisibleNodes(tree, expandedIds, searchQuery[0]),
                    expandedIds,
                    selectedId[0]
                )
            }
        })
        clearBtn.setOnClickListener { searchInput.setText("") }

        dialog.setContentView(container)
        dialog.show()
        val screenWidth = context.resources.displayMetrics.widthPixels
        val screenHeight = context.resources.displayMetrics.heightPixels
        val widthPx = minOf((screenWidth * 0.9).toInt(), (360 * density).toInt())
        val heightPx = maxOf((screenHeight - 200 * density).toInt(), (400 * density).toInt())
        dialog.window?.setLayout(widthPx, heightPx)
    }

    private fun parseFolderTree(json: String): FolderTreeData? {
        return try {
            val obj = JSONObject(json)
            val roots = mutableListOf<String>()
            val folders = mutableMapOf<String, FolderNode>()
            val rootsArr = obj.getJSONArray("roots")
            for (i in 0 until rootsArr.length()) roots.add(rootsArr.getString(i))
            val foldersArr = obj.getJSONArray("folders")
            for (i in 0 until foldersArr.length()) {
                val f = foldersArr.getJSONObject(i)
                val id = f.getString("id")
                val name = f.getString("name")
                val parentId = if (f.isNull("parentId") || !f.has("parentId")) null else f.getString("parentId")
                val children = mutableListOf<String>()
                val childrenArr = f.optJSONArray("children")
                if (childrenArr != null) {
                    for (j in 0 until childrenArr.length()) children.add(childrenArr.getString(j))
                }
                folders[id] = FolderNode(id, name, parentId, children)
            }
            FolderTreeData(roots, folders)
        } catch (e: Exception) {
            Log.e("FolderPickerDialog", "parseFolderTree failed", e)
            null
        }
    }

    private fun flattenVisibleNodes(
        tree: FolderTreeData,
        expandedIds: Set<String>,
        searchQuery: String
    ): List<Pair<FolderNode, Int>> {
        val result = mutableListOf<Pair<FolderNode, Int>>()
        val query = searchQuery.trim().lowercase()
        val matchingSet = if (query.isNotEmpty()) computeMatchingSet(tree, query) else null
        fun shouldExpand(nodeId: String): Boolean {
            if (expandedIds.contains(nodeId)) return true
            if (matchingSet != null) {
                val node = tree.folders[nodeId] ?: return false
                return node.children.any { childId -> matchingSet.contains(childId) || shouldExpand(childId) }
            }
            return false
        }
        fun dfs(nodeId: String, depth: Int) {
            val node = tree.folders[nodeId] ?: return
            if (matchingSet != null && !matchingSet.contains(nodeId)) return
            result.add(node to depth)
            if (shouldExpand(nodeId)) {
                node.children.forEach { childId -> dfs(childId, depth + 1) }
            }
        }
        tree.roots.forEach { rootId -> dfs(rootId, 0) }
        return result
    }

    private fun computeMatchingSet(tree: FolderTreeData, query: String): Set<String> {
        val matching = mutableSetOf<String>()
        val parentMap = mutableMapOf<String, String>()
        tree.folders.values.forEach { node ->
            node.children.forEach { childId -> parentMap[childId] = node.id }
        }
        fun addAncestors(id: String) {
            var current = id
            while (true) {
                matching.add(current)
                val parent = parentMap[current] ?: break
                if (matching.contains(parent)) break
                current = parent
            }
        }
        tree.folders.values.forEach { node ->
            if (node.name.lowercase().contains(query)) addAncestors(node.id)
        }
        return matching
    }

    private fun computeExpandedForSearch(tree: FolderTreeData, query: String): Set<String> {
        val matching = computeMatchingSet(tree, query)
        val result = mutableSetOf<String>()
        val parentMap = mutableMapOf<String, String>()
        tree.folders.values.forEach { node ->
            node.children.forEach { childId -> parentMap[childId] = node.id }
        }
        matching.forEach { id ->
            var current = parentMap[id]
            while (current != null) {
                result.add(current)
                current = parentMap[current]
            }
        }
        return result
    }

    /** 文件夹树 Adapter */
    private class FolderTreeAdapter(
        private val context: Context,
        private val theme: DialogTheme,
        private var nodes: List<Pair<FolderNode, Int>>,
        private var expandedIds: Set<String>,
        private var selectedId: String?,
        private val onNodeClick: (String) -> Unit,
        private val onToggleClick: (String) -> Unit
    ) : BaseAdapter() {

        fun updateData(newNodes: List<Pair<FolderNode, Int>>, newExpandedIds: Set<String>, newSelectedId: String?) {
            nodes = newNodes
            expandedIds = newExpandedIds
            selectedId = newSelectedId
            notifyDataSetChanged()
        }

        override fun getCount(): Int = nodes.size
        override fun getItem(position: Int): Any = nodes[position]
        override fun getItemId(position: Int): Long = position.toLong()

        override fun getView(position: Int, convertView: View?, parent: ViewGroup?): View {
            val (node, depth) = nodes[position]
            val density = DialogUtils.density(context)
            val isSelected = selectedId == node.id
            val row = LinearLayout(context).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                val hPad = (depth * 16 * density).toInt() + (density * 8).toInt()
                val vPad = (density * 10).toInt()
                setPadding(hPad, vPad, (density * 8).toInt(), vPad)
                setBackgroundColor(if (isSelected) theme.colorAccent() else Color.TRANSPARENT)
                setOnClickListener { onNodeClick(node.id) }
            }
            row.addView(ImageView(context).apply {
                val hasChildren = node.children.isNotEmpty()
                if (hasChildren) {
                    setImageResource(if (expandedIds.contains(node.id)) R.drawable.ic_lucide_chevron_down else R.drawable.ic_lucide_chevron_right)
                    setColorFilter(theme.colorTextSecondary())
                }
                setPadding((density * 4).toInt(), (density * 4).toInt(), (density * 4).toInt(), (density * 4).toInt())
                setOnClickListener { onToggleClick(node.id) }
            })
            row.addView(ImageView(context).apply {
                setImageResource(R.drawable.ic_lucide_folder)
                setColorFilter(if (isSelected) Color.WHITE else theme.colorAccent())
                setPadding((density * 4).toInt(), 0, (density * 8).toInt(), 0)
            })
            row.addView(TextView(context).apply {
                text = node.name
                setTextColor(if (isSelected) Color.WHITE else theme.colorTextPrimary())
                textSize = 14f
                maxLines = 1
                ellipsize = TextUtils.TruncateAt.END
            })
            return row
        }
    }
}
