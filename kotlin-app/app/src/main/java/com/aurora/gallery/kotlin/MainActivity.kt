package com.aurora.gallery.kotlin

import android.Manifest
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.MediaStore
import android.util.Log
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.result.IntentSenderRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp
import com.aurora.gallery.kotlin.ui.components.FileGrid
import com.aurora.gallery.kotlin.ui.components.CreateTopicDialog
import com.aurora.gallery.kotlin.ui.components.EditTagsDialog
import com.aurora.gallery.kotlin.ui.components.PeopleOverview
import com.aurora.gallery.kotlin.ui.components.SelectionBar
import com.aurora.gallery.kotlin.ui.components.SelectionMoreAction
import com.aurora.gallery.kotlin.ui.components.TagsOverview
import com.aurora.gallery.kotlin.ui.components.TargetPickerDialog
import com.aurora.gallery.kotlin.ui.components.TopicChildrenSection
import com.aurora.gallery.kotlin.ui.components.TopicCollapsibleDetail
import com.aurora.gallery.kotlin.ui.components.TopicDashedEmpty
import com.aurora.gallery.kotlin.ui.components.TopicHero
import com.aurora.gallery.kotlin.ui.components.TopicSectionHeader
import com.aurora.gallery.kotlin.ui.components.TopicSortOption
import com.aurora.gallery.kotlin.ui.components.TopicsOverview
import com.aurora.gallery.kotlin.ui.components.TopicPickerDialog
import com.aurora.gallery.kotlin.ui.components.SettingsHost
import com.aurora.gallery.kotlin.ui.components.SidebarPane
import com.aurora.gallery.kotlin.ui.components.TopBar
import com.aurora.gallery.kotlin.ui.components.TreeSidebar
import com.aurora.gallery.kotlin.ui.components.filterFolders
import com.aurora.gallery.kotlin.ui.components.rememberDisplayImages
import com.aurora.gallery.kotlin.ui.components.sortFolders
import com.aurora.gallery.kotlin.ui.components.sortTopicsForDisplay
import com.aurora.gallery.kotlin.ui.components.FoldersOverview
import com.aurora.gallery.kotlin.ui.components.PinchGridSpanListener
import com.aurora.gallery.kotlin.ui.components.PullToRefreshIndicator
import com.aurora.gallery.kotlin.ui.components.PullToRefreshState
import com.aurora.gallery.kotlin.ui.theme.AuroraTheme
import com.aurora.gallery.kotlin.ui.theme.AuroraPalettes
import android.view.View
import com.aurora.gallery.kotlin.viewer.NativeGalleryView
import com.aurora.gallery.kotlin.viewer.ViewerLayerHost
import com.aurora.gallery.kotlin.viewer.applyViewerTheme
import com.aurora.gallery.kotlin.viewer.dialogs.RenameDialog
import com.aurora.gallery.kotlin.state.AppState
import com.aurora.gallery.kotlin.state.AppSettings
import com.aurora.gallery.kotlin.ui.components.GroupBy
import com.aurora.gallery.kotlin.state.LayoutVisibility
import com.aurora.gallery.kotlin.state.SortDirection
import com.aurora.gallery.kotlin.state.SortOption
import com.aurora.gallery.kotlin.state.ViewMode
import uniffi.aurora_core.Folder
import uniffi.aurora_core.Image
import uniffi.aurora_core.TagGroup
import org.json.JSONException
import org.json.JSONObject

class MainActivity : ComponentActivity() {

    /** M4b 2.1 设置面板开合（侧栏「设置」行触发；对话框在 setContent 里渲染）。 */
    private var showSettings by mutableStateOf(false)

    /**
     * 系统深色档快照（M4c）：settings.theme = "system" 时的实际档位来源。manifest 声明了
     * uiMode configChange（切系统深浅不重建 Activity），系统档变化只有
     * [onConfigurationChanged] 能接住——onCreate 先取一次初值供冷启动定档。
     */
    private var systemDark by mutableStateOf(false)

    /**
     * 数据与 UI 状态都住在 GalleryViewModel（跨旋转重建保留）。factory 只在 ViewModel
     * 首次创建时求值，这里的横竖屏判断即初始面板可见性，旋转后不会被重算覆盖。
     */
    private val viewModel: GalleryViewModel by viewModels {
        GalleryViewModel.factory(
            application,
            LayoutVisibility(
                isSidebarVisible =
                    resources.configuration.orientation != Configuration.ORIENTATION_PORTRAIT,
            ),
        )
    }

    private val requestPermission = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        if (granted) viewModel.startScanIfNeeded()
        requestNotificationPermissionIfNeeded()
    }

    /**
     * 4.2 删除：MediaStore.createDeleteRequest 的系统确认弹窗结果。用户允许后 MediaStore
     * 变更经 ContentObserver 自动重扫对账（GalleryViewModel.mediaStoreObserver），这里只
     * 负责退出编辑模式（对齐 React 确认后 handleExitAndroidSelectionMode 的时点）。
     */
    private val deleteLauncher = registerForActivityResult(
        ActivityResultContracts.StartIntentSenderForResult()
    ) { result ->
        if (result.resultCode == RESULT_OK) {
            viewModel.appState.exitSelectionMode()
        }
    }

    // —— M4b 1.1 文件操作的批量授权（重命名/移动走 createWriteRequest，复制不弹）——

    /** [requestWriteAccess] 发起的系统授权弹窗回来后要继续的动作（一次一条）。 */
    private var pendingWriteCallback: (() -> Unit)? = null

    /**
     * createWriteRequest 的弹窗结果：允许 → 继续挂起的写操作；拒绝 → 只提示，动作丢弃。
     * 授权针对**一批** uri（多选攒一次请求，规划五要点①），继续时整批一起执行。
     */
    private val writeLauncher = registerForActivityResult(
        ActivityResultContracts.StartIntentSenderForResult()
    ) { result ->
        val callback = pendingWriteCallback
        pendingWriteCallback = null
        if (result.resultCode == RESULT_OK) {
            callback?.invoke()
        } else {
            Toast.makeText(this, "未获系统写入授权，操作已取消", Toast.LENGTH_SHORT).show()
        }
    }

    /** API < 30 的写权限兜底（manifest WRITE_EXTERNAL_STORAGE maxSdkVersion=29）。 */
    private val writePermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        val callback = pendingWriteCallback
        pendingWriteCallback = null
        if (granted) {
            callback?.invoke()
        } else {
            Toast.makeText(this, "未获存储写权限，操作已取消", Toast.LENGTH_SHORT).show()
        }
    }

    /**
     * 对一批文件请求 MediaStore 写授权（改已有行：重命名/移动），允许后继续 [onGranted]。
     * API ≥ 30 走 createWriteRequest（已授权过的行系统直接放行，不重复弹窗）；< 30 走
     * WRITE_EXTERNAL_STORAGE 运行时权限。复制（insert 新行）不经过这里。
     */
    private fun requestWriteAccess(uris: List<Uri>, onGranted: () -> Unit) {
        if (uris.isEmpty()) return
        if (Build.VERSION.SDK_INT >= 30) {
            try {
                pendingWriteCallback = onGranted
                val pi = MediaStore.createWriteRequest(contentResolver, uris.distinct())
                writeLauncher.launch(IntentSenderRequest.Builder(pi.intentSender).build())
            } catch (e: Exception) {
                pendingWriteCallback = null
                Log.w("AuroraKotlin", "[FileOp] createWriteRequest failed", e)
                Toast.makeText(this, "授权请求失败", Toast.LENGTH_SHORT).show()
            }
        } else {
            val permission = Manifest.permission.WRITE_EXTERNAL_STORAGE
            if (ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED) {
                onGranted()
            } else {
                pendingWriteCallback = onGranted
                writePermissionLauncher.launch(permission)
            }
        }
    }

    /**
     * 文件操作统一入口：先按 file id 解析出 content uri（读索引），再过写授权，允许后
     * 把 uri 交给 [op]。复制不走这里（无授权），直接调 [GalleryViewModel.copyFiles]。
     */
    private fun fileOpWithWriteAccessUris(fileIds: Collection<String>, op: (List<Uri>) -> Unit) {
        viewModel.resolveFileUris(fileIds) { uris ->
            if (uris.isEmpty()) {
                Toast.makeText(this, "没有可操作的文件", Toast.LENGTH_SHORT).show()
            } else {
                requestWriteAccess(uris) { op(uris) }
            }
        }
    }

    private fun fileOpWithWriteAccess(fileIds: Collection<String>, op: () -> Unit) {
        fileOpWithWriteAccessUris(fileIds) { op() }
    }

    // —— M4b 2.3 设置面板：缓存清理 + 备份导出/导入 ——

    private fun computeCacheSizeText(): String {
        fun dirSize(dir: java.io.File): Long =
            dir.walkBottomUp().filter { it.isFile }.sumOf { it.length() }
        val cacheDir = cacheDir
        val total = if (cacheDir.exists()) dirSize(cacheDir) else 0L
        // M4c：去掉 M4b 的「=」前缀（测试反馈观感异常），改「约」表达估算值语义
        return when {
            total >= 1L shl 20 -> "约 %.1f MB".format(total.toDouble() / (1L shl 20))
            total >= 1024 -> "约 %.1f KB".format(total.toDouble() / 1024)
            else -> "$total B"
        }
    }

    private fun clearCache() {
        lifecycleScope.launch {
            val freed = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
                fun dirSize(dir: java.io.File): Long =
                    dir.walkBottomUp().filter { it.isFile }.sumOf { it.length() }
                val before = if (cacheDir.exists()) dirSize(cacheDir) else 0L
                cacheDir.deleteRecursively()
                cacheDir.mkdirs()
                before
            }
            Toast.makeText(
                this@MainActivity,
                "缓存已清理（释放 %.1f MB）".format(freed.toDouble() / (1L shl 20)),
                Toast.LENGTH_SHORT,
            ).show()
        }
    }

    /** 备份导入（2.3）：SAF 选 JSON → 词表并集 + 人物/专题按 id 去重合并（React 同语义）。 */
    private val importBackupLauncher = registerForActivityResult(
        ActivityResultContracts.OpenDocument()
    ) { uri ->
        if (uri != null) importBackupFrom(uri)
    }

    private fun importBackupFrom(uri: Uri) {
        lifecycleScope.launch {
            val report = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
                var tagsAdded = 0
                var peopleAdded = 0
                var topicsAdded = 0
                try {
                    val text = contentResolver.openInputStream(uri)?.use { input ->
                        input.readBytes().toString(Charsets.UTF_8)
                    } ?: throw IllegalStateException("openInputStream failed")
                    val json = org.json.JSONObject(text)
                    val tags = json.optJSONArray("tags")
                    val existingIds = HashSet<String>()
                    if (tags != null) {
                        val grouped = uniffi.aurora_core.getGroupedTags(viewModel.settings.value.language)
                        grouped.forEach { g -> g.tags.forEach { existingIds.add(it.tag) } }
                        for (i in 0 until tags.length()) {
                            val tag = tags.getString(i).trim()
                            if (tag.isNotEmpty() && tag !in existingIds) {
                                uniffi.aurora_core.addTagToVocabulary(tag)
                                tagsAdded++
                            }
                        }
                    }
                    val people = json.optJSONObject("people")
                    if (people != null) {
                        val existing = uniffi.aurora_core.getAllPeople().associateBy { it.id }
                        for (key in people.keys()) {
                            if (key in existing) continue
                            val p = people.getJSONObject(key)
                            uniffi.aurora_core.upsertPerson(
                                uniffi.aurora_core.FfiPerson(
                                    id = p.optString("id", key),
                                    name = p.optString("name", key),
                                    coverFileId = "",
                                    count = 0,
                                    description = p.optString("description").takeIf { it.isNotEmpty() },
                                    faceBox = null,
                                    updatedAt = null,
                                    characterTagName = null,
                                    characterTagIndex = null,
                                ),
                            )
                            peopleAdded++
                        }
                    }
                    val topics = json.optJSONObject("topics")
                    if (topics != null) {
                        val existing = uniffi.aurora_core.getAllTopics().associateBy { it.id }
                        for (key in topics.keys()) {
                            if (key in existing) continue
                            val t = topics.getJSONObject(key)
                            val peopleIds = mutableListOf<String>()
                            t.optJSONArray("peopleIds")?.let { arr ->
                                for (i in 0 until arr.length()) peopleIds.add(arr.getString(i))
                            }
                            val now = System.currentTimeMillis()
                            uniffi.aurora_core.upsertTopic(
                                uniffi.aurora_core.FfiTopic(
                                    id = t.optString("id", key),
                                    parentId = t.optString("parentId").takeIf { it.isNotEmpty() },
                                    name = t.optString("name", key),
                                    description = t.optString("description").takeIf { it.isNotEmpty() },
                                    topicType = t.optString("type", "TOPIC").ifEmpty { "TOPIC" },
                                    coverFileId = null,
                                    backgroundFileId = null,
                                    coverCrop = null,
                                    peopleIds = peopleIds,
                                    fileIds = emptyList(),
                                    sourceUrl = null,
                                    createdAt = now,
                                    updatedAt = now,
                                    sourceType = null,
                                    workName = null,
                                    workNameCn = null,
                                    fileCount = 0,
                                ),
                            )
                            topicsAdded++
                        }
                    }
                    "已导入：词表 +$tagsAdded，人物 +$peopleAdded，专题 +$topicsAdded"
                } catch (e: Exception) {
                    Log.w("AuroraKotlin", "[Settings] import backup failed", e)
                    "导入失败（格式或读取错误）"
                }
            }
            if (report.startsWith("已导入")) viewModel.refreshTagSnapshots()
            Toast.makeText(this@MainActivity, report, Toast.LENGTH_LONG).show()
        }
    }

    /** 备份导出（2.3，字段对齐 React StoragePanel 导出：词表 + 人物 + 简化专题）。 */
    private fun exportBackup() {
        lifecycleScope.launch {
            val json = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
                val grouped = uniffi.aurora_core.getGroupedTags(viewModel.settings.value.language)
                val tags = grouped.flatMap { g -> g.tags.map { it.tag } }
                val people = uniffi.aurora_core.getAllPeople()
                val topics = uniffi.aurora_core.getAllTopics()
                val peopleJson = org.json.JSONObject()
                people.forEach { p ->
                    peopleJson.put(
                        p.id,
                        org.json.JSONObject()
                            .put("name", p.name)
                            .put("description", p.description ?: JSONObject.NULL)
                            .put("count", p.count),
                    )
                }
                val topicsJson = org.json.JSONObject()
                topics.forEach { t ->
                    topicsJson.put(
                        t.id,
                        org.json.JSONObject()
                            .put("id", t.id)
                            .put("name", t.name)
                            .put("parentId", t.parentId ?: JSONObject.NULL)
                            .put("description", t.description ?: JSONObject.NULL)
                            .put("type", t.topicType ?: "TOPIC")
                            .put("peopleIds", org.json.JSONArray(t.peopleIds)),
                    )
                }
                org.json.JSONObject()
                    .put("tags", org.json.JSONArray(tags))
                    .put("people", peopleJson)
                    .put("topics", topicsJson)
                    .toString(2)
            }
            try {
                val fileName = "aurora_metadata_backup_${java.text.SimpleDateFormat("yyyy-MM-dd", java.util.Locale.US).format(java.util.Date())}.json"
                val values = android.content.ContentValues().apply {
                    put(android.provider.MediaStore.Downloads.DISPLAY_NAME, fileName)
                    put(android.provider.MediaStore.Downloads.MIME_TYPE, "application/json")
                    if (Build.VERSION.SDK_INT >= 29) {
                        put(android.provider.MediaStore.Downloads.RELATIVE_PATH, "Download/")
                        put(android.provider.MediaStore.Downloads.IS_PENDING, 1)
                    }
                }
                val collection = if (Build.VERSION.SDK_INT >= 29) {
                    android.provider.MediaStore.Downloads.EXTERNAL_CONTENT_URI
                } else {
                    Uri.parse("${android.os.Environment.getExternalStoragePublicDirectory(android.os.Environment.DIRECTORY_DOWNLOADS)}/$fileName")
                }
                val uri = contentResolver.insert(collection, values)
                    ?: throw IllegalStateException("insert failed")
                contentResolver.openOutputStream(uri)?.use { out ->
                    out.write(json.toByteArray())
                } ?: throw IllegalStateException("openOutputStream failed")
                if (Build.VERSION.SDK_INT >= 29) {
                    contentResolver.update(uri, android.content.ContentValues().apply {
                        put(android.provider.MediaStore.Downloads.IS_PENDING, 0)
                    }, null, null)
                }
                Toast.makeText(this@MainActivity, "已导出到 Download/$fileName", Toast.LENGTH_LONG).show()
            } catch (e: Exception) {
                Log.w("AuroraKotlin", "[Settings] export backup failed", e)
                Toast.makeText(this@MainActivity, "导出失败", Toast.LENGTH_SHORT).show()
            }
        }
    }
    // —— M4b 1.4/1.3 复制/移动/重命名的宿主执行（网格与查看器共用一条写入路径）——
    // 弹窗层状态（目标选择器/合并确认/重命名目标）在 App() 组合里；这里只提供
    // 「已确定目标后的执行」：解析 RELATIVE_PATH、批量授权、调写原语、反馈。

    /** 复制/移动到既有相册（folderId 现场解析 RELATIVE_PATH）。 */
    private fun performCopyMoveToFolder(
        fileIds: List<String>,
        targetFolderId: String,
        type: String,
        onFinished: () -> Unit = {},
    ) {
        viewModel.resolveFolderRelPath(targetFolderId) { relPath ->
            if (relPath == null) {
                Toast.makeText(this, "无法解析目标相册路径", Toast.LENGTH_SHORT).show()
                return@resolveFolderRelPath
            }
            performCopyMove(fileIds, relPath, type, onFinished)
        }
    }

    /** 复制/移动到**新相册**（1.3 懒创建：RELATIVE_PATH 指向 `Pictures/<名字>`，落地文件才产生 Folder 行）。 */
    private fun performCopyMoveToNewAlbum(
        fileIds: List<String>,
        albumName: String,
        type: String,
        onFinished: () -> Unit = {},
    ) {
        if (albumName.isEmpty() || albumName == "." || albumName == ".." ||
            albumName.contains('/') || albumName.contains('\\')
        ) {
            Toast.makeText(this, "相册名不能包含 / \\ 等路径字符", Toast.LENGTH_SHORT).show()
            return
        }
        performCopyMove(fileIds, "Pictures/$albumName", type, onFinished)
    }

    private fun performCopyMove(
        fileIds: List<String>,
        relPath: String,
        type: String,
        onFinished: () -> Unit = {},
    ) {
        viewModel.resolveFileUris(fileIds) { uris ->
            // M4b 诊断日志：fileId 与 uri 的对应关系是「移错文件」类问题的第一现场
            Log.w("AuroraFileOp", "performCopyMove type=$type relPath=$relPath ids=$fileIds uris=$uris")
            if (uris.isEmpty()) {
                Toast.makeText(this, "没有可操作的文件", Toast.LENGTH_SHORT).show()
                return@resolveFileUris
            }
            val report: (Int) -> Unit = { n ->
                Toast.makeText(
                    this,
                    when {
                        n == 0 -> if (type == "copy") "复制失败" else "移动失败"
                        else -> (if (type == "copy") "已复制 " else "已移动 ") + "$n 张"
                    },
                    Toast.LENGTH_SHORT,
                ).show()
                if (n > 0) onFinished()
            }
            if (type == "copy") {
                // 复制静默完成（insert 新行只要读权限，规划五要点②的不对称）
                viewModel.copyFiles(uris, relPath, report)
            } else {
                // 移动要过系统写授权（批量一次弹窗），App 侧文案不替系统说话
                requestWriteAccess(uris) { viewModel.moveFiles(uris, relPath, report) }
            }
        }
    }

    // —— M3 查看器（D7：Compose 条件层承载，实例由本 Activity 持有）——

    /**
     * 查看器实例跟 Activity 走、不跟组合走：它的 Coil ImageLoader 挂着 30% 内存缓存与
     * 200MB 磁盘缓存，`destroy()` 会把它 shutdown，所以每次进出查看器重建实例等于每次
     * 清空缓存（4.2 要盯的内存台阶正来自这种重建）。
     */
    private var viewer: NativeGalleryView? = null

    private fun ensureViewer(): NativeGalleryView = viewer ?: NativeGalleryView(this).also {
        it.listener = viewerListener(it)
        viewer = it
    }

    private fun viewerListener(view: NativeGalleryView) = object : NativeGalleryView.Listener {
        override fun onClose() {
            view.close()
            viewModel.appState.closeViewer()
        }

        /**
         * 3.3：翻页跟到当前这张。不回写的话转屏重建 Activity 后会回到「进入时那张」，
         * 而不是用户正在看的那张。
         */
        override fun onNavigate(index: Int) {
            view.fileIdAt(index)?.let { viewModel.appState.viewerNavigated(it) }
        }

        /** 3.3：沉浸是纯系统 UI 控制，M3 就做。 */
        override fun onImmersiveToggle(immersive: Boolean) = setImmersiveMode(immersive)

        /**
         * 3.2 删除：查看器自己已经把这张从它的序列里摘掉并前进到下一张（confirmDelete），
         * 宿主只负责发起真正的删除请求。确认弹窗是查看器内的 `DeleteConfirmDialog`
         * （与网格 4.2 的应用内确认同一形态），不走 [onDeleteSelection] 那条网格链路。
         * 删完的索引对账交给既有 ContentObserver 重扫。
         */
        override fun onDelete(fileId: String) {
            viewModel.resolveSelectionUris(setOf(fileId)) { uris -> requestDelete(uris) }
        }

        /** 3.2 分享：单图版，复用网格那套 ACTION_SEND_MULTIPLE。 */
        override fun onShare(filePath: String) {
            if (filePath.isEmpty()) {
                // 防御分支（正常路径 filePath 恒非空）；文件操作归 M4b
                toastSoon("分享", "M4b")
                return
            }
            shareUris(listOf(Uri.parse(filePath)))
        }

        /** 3.3：幻灯片配置查看器已就地生效（能播、能设间隔），M3 没有设置持久层可写。 */
        override fun onUpdateSlideshowConfig(configJson: String) {
            Log.i("AuroraViewer", "slideshow config applied: $configJson")
        }

        // —— 以下入口的能力归属已按 M4 拆分重标（M4a 4.3）：查看器的复制/移动走
        // MediaStore（M4b 1.5 已落地）；颜色/主色调链路归 M6；onMore/onEditTags/
        // onLongPress 三个死回调已随 6.1 收口从 Listener 删除——

        /**
         * M4a 2.1：查看器三个编辑弹窗的落库分支。键与语义见
         * [NativeGalleryView.Listener.onUpdateFile] 的契约注释。
         *
         * 本方法是「查看器协议 → 数据层」的唯一适配点：解析在这里做，落库与快照重算在
         * [GalleryViewModel.saveFileUpdates]，元数据面板（4.2）直接调后者、不经过这里。
         */
        override fun onUpdateFile(fileId: String, updatesJson: String) {
            val updates = try {
                JSONObject(updatesJson)
            } catch (e: JSONException) {
                Log.w("AuroraKotlin", "[Edit] updatesJson 解析失败: $updatesJson", e)
                Toast.makeText(this@MainActivity, "保存失败", Toast.LENGTH_SHORT).show()
                return
            }
            val tags = updates.optJSONArray("tags")?.let { arr ->
                // getString 而非 optString：契约里 tags 恒为字符串数组（见 Listener 注释），
                // 元素类型不对时宁可让这次保存炸在日志里，也不静默丢掉一个标签。
                List(arr.length()) { arr.getString(it) }
            }
            val description = if (updates.has("description")) updates.getString("description") else null
            val sourceUrl = if (updates.has("sourceUrl")) updates.getString("sourceUrl") else null
            if (tags == null && description == null && sourceUrl == null) {
                // 走到这里的实际只有 `{"name": …}`（查看器的重命名弹窗）：重命名改的是
                // MediaStore 的 DISPLAY_NAME（M4b 1.5 接通写原语，先过批量写授权），
                // 元数据行挂在同一 file_id 上不动（规划五要点②）。查看器已就地更新了
                // 自己列表里的名字，失败时靠重扫对账纠正。
                val newName = updates.optString("name")
                if (newName.isNotEmpty()) {
                    fileOpWithWriteAccessUris(listOf(fileId)) { uris ->
                        viewModel.renameFiles(listOf(uris.first() to newName)) { n ->
                            if (n == 0) {
                                Toast.makeText(this@MainActivity, "重命名失败", Toast.LENGTH_SHORT).show()
                            }
                        }
                    }
                }
                return
            }
            viewModel.saveFileUpdates(fileId, tags, description, sourceUrl) { ok ->
                if (!ok) Toast.makeText(this@MainActivity, "保存失败", Toast.LENGTH_SHORT).show()
            }
        }

        override fun onColorSearch(colorHex: String) = toastSoon("按颜色搜索", "M6")
        override fun onExtractPalette(fileId: String, filePath: String) = toastSoon("主色调提取", "M6")

        /** M4b 1.5：查看器「更多」的复制/移动 → FolderPickerDialog（folderTree 从 VM 快照构造）。 */
        override fun onCopyToFolder(fileId: String) {
            view.showFolderPickerDialog("copy", fileId, folderTreeJson()) { name ->
                onViewerNewAlbum(fileId, name, "copy")
            }
        }

        override fun onMoveToFolder(fileId: String) {
            view.showFolderPickerDialog("move", fileId, folderTreeJson()) { name ->
                onViewerNewAlbum(fileId, name, "move")
            }
        }

        /**
         * M4b 1.5：查看器弹窗确认（1.4 的 onFolderPickerConfirm 从 Toast 改为真执行；
         * move 时查看器自己已把这张从序列里摘掉，宿主只管落库，失败靠重扫对账纠正）。
         */
        override fun onFolderPickerConfirm(fileId: String, targetFolderId: String, type: String) {
            performCopyMoveToFolder(listOf(fileId), targetFolderId, type)
        }
    }

    /** FolderPickerDialog 的 folderTreeJson：Kotlin 侧是扁平 bucket 列表（D18），全为根节点。 */
    private fun folderTreeJson(): String {
        val folders = viewModel.folders.value
        val folderArr = org.json.JSONArray()
        val roots = org.json.JSONArray()
        folders.forEach { f ->
            roots.put(f.id)
            folderArr.put(
                org.json.JSONObject()
                    .put("id", f.id)
                    .put("name", f.name)
                    .put("parentId", JSONObject.NULL)
                    .put("children", org.json.JSONArray()),
            )
        }
        return org.json.JSONObject()
            .put("roots", roots)
            .put("folders", folderArr)
            .toString()
    }

    /**
     * 查看器侧「+ 新建相册」（M4b 1.3，与网格侧同一语义）：重名 → View 体系的合并确认
     * （D13：弹窗两处实现、写入路径只有一条）；不重名 → 校验后建在 Pictures/<名字>。
     */
    private fun onViewerNewAlbum(fileId: String, albumName: String, type: String) {
        val existing = viewModel.folders.value.firstOrNull { it.name == albumName }
        if (existing != null) {
            android.app.AlertDialog.Builder(this)
                .setTitle("合并到已有相册")
                .setMessage("已有同名相册「${existing.name}」（${existing.imageCount} 张）。将把所选文件并入该相册。")
                .setPositiveButton("并入") { d, _ ->
                    d.dismiss()
                    performCopyMoveToFolder(listOf(fileId), existing.id, type)
                }
                .setNegativeButton("取消", null)
                .show()
            return
        }
        performCopyMoveToNewAlbum(listOf(fileId), albumName, type)
    }

    /** 未落地能力的可见占位（M3 3.3：静默无响应在真机上会被当成 bug 报回来）。 */
    private fun toastSoon(feature: String, milestone: String) {
        Toast.makeText(this, "$feature 将随 $milestone 提供", Toast.LENGTH_SHORT).show()
    }

    /**
     * 3.3 沉浸：从 React 壳 `setImmersiveMode` 平移（那边是 overlay 的窗口标志，这里是
     * Activity 窗口——D7 ③ 下查看器就在 Activity 的视图树里，系统栏控制天然归到窗口层）。
     * 首次进入前记下状态栏原色，退出时还原。
     */
    private var savedStatusBarColor: Int? = null

    private fun setImmersiveMode(immersive: Boolean) {
        val window = this.window
        if (immersive) {
            if (savedStatusBarColor == null) savedStatusBarColor = window.statusBarColor
            WindowCompat.setDecorFitsSystemWindows(window, false)
        } else {
            WindowCompat.setDecorFitsSystemWindows(window, true)
            savedStatusBarColor?.let { window.statusBarColor = it }
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            window.insetsController?.let { controller ->
                if (immersive) {
                    controller.hide(android.view.WindowInsets.Type.systemBars())
                    controller.systemBarsBehavior =
                        android.view.WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
                } else {
                    controller.show(android.view.WindowInsets.Type.systemBars())
                }
            }
        } else {
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility = if (immersive) {
                @Suppress("DEPRECATION")
                (View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                    or View.SYSTEM_UI_FLAG_FULLSCREEN
                    or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                    or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                    or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                    or View.SYSTEM_UI_FLAG_LAYOUT_STABLE)
            } else {
                @Suppress("DEPRECATION")
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE
            }
        }
        if (immersive) window.statusBarColor = android.graphics.Color.TRANSPARENT
    }

    // —— M4c 主题管线 ——

    /** settings.theme → 是否深色（M4c）。"system" 跟随 [systemDark]；组合内调用可触发重组。 */
    private fun isDarkTheme(): Boolean = when (viewModel.settings.value.theme) {
        AppSettings.THEME_DARK -> true
        AppSettings.THEME_LIGHT -> false
        else -> systemDark
    }

    private fun isSystemDark(): Boolean =
        (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) ==
            Configuration.UI_MODE_NIGHT_YES

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        systemDark =
            (newConfig.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
    }

    /**
     * 窗口层主题同步（M4c）：窗口底色 = palette.content——edge-to-edge 下系统栏镂空区露的
     * 也是这层；statusBarColor 在 API 35+ 被 edge-to-edge 忽略，低版本写它对齐观感。状态栏
     * 图标深浅随档切。查看器沉浸会自行接管/还原状态栏色，这里写的是非沉浸基准值，
     * SideEffect 每次重组幂等重写，两条路径最终一致。
     */
    private fun applyWindowTheme(dark: Boolean) {
        val palette = AuroraPalettes.of(dark)
        window.setBackgroundDrawable(android.graphics.drawable.ColorDrawable(palette.content))
        @Suppress("DEPRECATION")
        window.statusBarColor = palette.content
        WindowCompat.getInsetsController(window, window.decorView)
            ?.isAppearanceLightStatusBars = !dark
    }

    /** 应用版本（关于页显示，M4c）：PackageManager 取 versionName，失败退空串。 */
    private val appVersion: String by lazy {
        try {
            packageManager.getPackageInfo(packageName, 0).versionName ?: ""
        } catch (_: Exception) {
            ""
        }
    }

    /** 关于页外链（GitHub/Issues，M4c）：系统浏览器打开；无浏览器等失败仅提示。 */
    private fun openExternalUrl(url: String) {
        runCatching {
            startActivity(
                android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(url)),
            )
        }.onFailure {
            Toast.makeText(this, "无法打开链接", Toast.LENGTH_SHORT).show()
        }
    }

    override fun onDestroy() {
        viewer?.destroy()
        viewer = null
        super.onDestroy()
    }

    // —— M4b 1.4 排查：确认触摸事件是否进入应用（收口时删）——
    override fun dispatchTouchEvent(ev: android.view.MotionEvent): Boolean {
        if (ev.action == android.view.MotionEvent.ACTION_DOWN) {
            Log.i("AuroraMenu", "dispatch DOWN x=${ev.x.toInt()} y=${ev.y.toInt()}")
        }
        return super.dispatchTouchEvent(ev)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // M4c 主题生效链的源头：先取系统深浅档（"system" 用），再按设置档把窗口底色
        // 在首帧前上好——深色档冷启动不闪白。
        systemDark = isSystemDark()
        applyWindowTheme(isDarkTheme())

        setContent {
            // 主题档由设置驱动（M4c，D23）：settings.theme 直接选档，"system" 跟随
            // [systemDark]。XML 主题（Theme.AuroraKotlin = Material.Light）只作进程兜底，
            // 运行期窗口底色/状态栏外观经 [applyWindowTheme] 与调色板同步；网格与查看器
            // 同读一张 AuroraPalette（FileGrid 走 Compose 注入色 + applyThemeColors 重绑，
            // 查看器经 applyViewerTheme 下次 open 生效）。取代 M1 的「固定浅色 + XML 必须
            // 一致」约束——那约束防的「深调色板画在白窗底」现在由窗口底色同步根除。
            val dark = isDarkTheme()
            AuroraTheme(darkTheme = dark) {
                SideEffect {
                    applyWindowTheme(dark)
                    applyViewerTheme(dark)
                }
                val appState = viewModel.appState
                val tab = appState.activeTab
                // 当前该显示哪批图（文件夹 / 标签命中 / 专题成员）：导航与标签筛选都收敛到
                // 这一个触发点。协程随 key 变化自动取消，所以「点进 B 还没查完」不会把 A
                // 的结果盖上去——旧 openFolder 里手写的竞态守卫由结构化并发兜住了。
                LaunchedEffect(tab.viewMode, tab.folderId, tab.activeTags, tab.activeTopicId) {
                    viewModel.reloadImages()
                }
                // 展示序列在这一层求值，网格与查看器共用同一个结果（2.2：进入的 startIndex
                // 必须落在过滤后的序列上，两处各算一遍会有漂移风险）。M4b 阶段 3 起
                // scope 文本搜索的数据源（标签/元数据快照 + 所属文件夹名）一并喂入。
                val currentFolderName = appState.activeTab.folderId?.let { id ->
                    viewModel.folders.value.firstOrNull { it.id == id }?.name
                }.orEmpty()
                val displayImages = rememberDisplayImages(
                    viewModel.images.value,
                    appState.activeTab,
                    appState.sortBy,
                    appState.sortDirection,
                    tagsByFile = viewModel.tagsByFile.value,
                    metadataById = viewModel.metadataById.value,
                    viewFolderName = currentFolderName,
                )
                Box(Modifier.fillMaxSize().statusBarsPadding()) {
                    App(
                        state = appState,
                        folders = viewModel.folders.value,
                        images = viewModel.images.value,
                        displayImages = displayImages,
                        tagGroups = viewModel.tagGroups.value,
                        topics = viewModel.topics.value,
                        coverImagesById = viewModel.coverImagesById.value,
                        scanning = viewModel.scanning.value,
                        thumbnailLoader = viewModel.thumbnailLoader,
                        onFolderClick = { viewModel.openFolder(it) },
                        onTopicClick = { viewModel.appState.openTopic(it.id) },
                        onCreateTopic = { name, parentId -> viewModel.createTopic(name, parentId) },
                        onAddToTopic = { topicId, ids ->
                            viewModel.addFilesToTopic(topicId, ids) { ok ->
                                Toast.makeText(
                                    this@MainActivity,
                                    if (ok) "已加入专题" else "加入专题失败",
                                    Toast.LENGTH_SHORT,
                                ).show()
                                if (ok) viewModel.appState.exitSelectionMode()
                            }
                        },
                        onRemoveFromTopic = { topicId, ids ->
                            viewModel.removeFilesFromTopic(topicId, ids) { ok ->
                                Toast.makeText(
                                    this@MainActivity,
                                    if (ok) "已从专题移除" else "移除失败",
                                    Toast.LENGTH_SHORT,
                                ).show()
                                if (ok) viewModel.appState.exitSelectionMode()
                            }
                        },
                        onShareSelection = { ids ->
                            viewModel.resolveSelectionUris(ids) { uris ->
                                if (uris.isNotEmpty()) shareUris(uris)
                            }
                        },
                        onDeleteSelection = { ids ->
                            viewModel.resolveSelectionUris(ids) { uris ->
                                if (uris.isNotEmpty()) requestDelete(uris)
                            }
                        },
                        // —— M4a 4.3 长按菜单的标签三项（数据在 VM 快照，落库走唯一写入口）——
                        tagsByFile = viewModel.tagsByFile.value,
                        onCopyTags = { ids ->
                            val merged = LinkedHashSet<String>()
                            ids.forEach { id -> viewModel.tagsByFile.value[id]?.let(merged::addAll) }
                            viewModel.appState.copiedTags = merged
                            Toast.makeText(
                                this@MainActivity,
                                if (merged.isEmpty()) "所选图片没有标签" else "已复制 ${merged.size} 个标签",
                                Toast.LENGTH_SHORT,
                            ).show()
                        },
                        onPasteTags = { ids ->
                            if (viewModel.appState.copiedTags.isEmpty()) {
                                Toast.makeText(this@MainActivity, "剪贴板里还没有标签，先用「复制标签」复制一份", Toast.LENGTH_SHORT).show()
                            } else {
                                viewModel.pasteTagsToFiles(ids) { ok ->
                                    Toast.makeText(
                                        this@MainActivity,
                                        if (ok) "已粘贴标签" else "粘贴失败",
                                        Toast.LENGTH_SHORT,
                                    ).show()
                                }
                            }
                        },
                        onSaveFileTags = { fileId, tags ->
                            viewModel.saveFileUpdates(fileId, tags = tags) { ok ->
                                if (!ok) Toast.makeText(this@MainActivity, "保存失败", Toast.LENGTH_SHORT).show()
                            }
                        },
                        // —— M4a 4.3 专题长按菜单（重命名/删除）与详情「设为封面」——
                        onRenameTopic = { topic, name ->
                            viewModel.renameTopic(topic, name) { ok ->
                                Toast.makeText(
                                    this@MainActivity,
                                    if (ok) "已重命名" else "重命名失败",
                                    Toast.LENGTH_SHORT,
                                ).show()
                            }
                        },
                        onDeleteTopic = { topic ->
                            viewModel.deleteTopic(topic) { ok ->
                                if (ok) {
                                    // 删的是正在看的专题（总览里删根专题时 activeTopicId
                                    // 必为 null；详情里删的是子专题，不动 activeTopicId）
                                    if (appState.activeTab.activeTopicId == topic.id) {
                                        appState.updateActiveTab { it.copy(activeTopicId = null) }
                                    }
                                    Toast.makeText(this@MainActivity, "专题已删除", Toast.LENGTH_SHORT).show()
                                } else {
                                    Toast.makeText(this@MainActivity, "删除失败", Toast.LENGTH_SHORT).show()
                                }
                            }
                        },
                        onSetTopicCover = { topicId, fileId ->
                            viewModel.setTopicCover(topicId, fileId) { ok ->
                                Toast.makeText(
                                    this@MainActivity,
                                    if (ok) "已设为封面" else "设置封面失败",
                                    Toast.LENGTH_SHORT,
                                ).show()
                            }
                        },
                        // —— M4b 1.4/1.3 文件操作（弹窗在 App 内，执行在宿主）——
                        onCopyMoveFiles = { fileIds, folderId, type ->
                            performCopyMoveToFolder(fileIds, folderId, type) {
                                appState.exitSelectionMode()
                            }
                        },
                        onCopyMoveToNewAlbum = { fileIds, albumName, type ->
                            performCopyMoveToNewAlbum(fileIds, albumName, type) {
                                appState.exitSelectionMode()
                            }
                        },
                        onResolveSelectionFileIds = { ids, onReady ->
                            viewModel.resolveSelectionFileIds(ids, onReady)
                        },
                        onRenameFile = { fileId, newName ->
                            fileOpWithWriteAccessUris(listOf(fileId)) { uris ->
                                viewModel.renameFiles(listOf(uris.first() to newName)) { n ->
                                    Toast.makeText(
                                        this@MainActivity,
                                        if (n > 0) "已重命名" else "重命名失败",
                                        Toast.LENGTH_SHORT,
                                    ).show()
                                }
                            }
                        },
                        onOpenSettings = { showSettings = true },
                        onPullRefresh = { onComplete -> viewModel.refreshManual(onComplete) },
                    )
                // 查看器叠在主内容之上，且不随网格的「扫描中」分支被拆掉（见 ViewerLayerHost）
                ViewerLayerHost(
                    state = appState,
                    displayImages = displayImages,
                    viewerProvider = ::ensureViewer,
                    parentName = currentFolderName,
                    tagsByFile = viewModel.tagsByFile.value,
                    metadataById = viewModel.metadataById.value,
                )
                // M4c：设置宿主（平板 ≥600dp 桌面式双栏对话框 / 手机全屏设置页，D21 双形态）
                if (showSettings) {
                    SettingsHost(
                        settings = viewModel.settings.value,
                        cacheSizeText = computeCacheSizeText(),
                        appVersion = appVersion,
                        onLanguageChange = { viewModel.setLanguage(it) },
                        onThemeChange = { viewModel.setTheme(it) },
                        onDefaultLayoutChange = { viewModel.applyDefaultLayout(it) },
                        onDefaultSortChange = { by, dir -> viewModel.applyDefaultSort(by, dir) },
                        onDefaultGroupByChange = { viewModel.applyDefaultGroupBy(it) },
                        onClearCache = { clearCache() },
                        onExportBackup = { exportBackup() },
                        onImportBackup = { importBackupLauncher.launch(arrayOf("application/json")) },
                        onOpenUrl = { openExternalUrl(it) },
                        onDismiss = { showSettings = false },
                    )
                }
                }
            }
        }

        requestMediaPermissionIfNeeded()

        // 模拟器/Debug 构建：注册捏合注入广播（验证 FLIP 用，走生产回调链；Release 不注册）
        if (isEmulator() || applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE != 0) {
            ContextCompat.registerReceiver(
                this,
                pinchDebugReceiver,
                IntentFilter("aurora.debug.PINCH"),
                ContextCompat.RECEIVER_EXPORTED,
            )
            ContextCompat.registerReceiver(
                this,
                ffiDebugReceiver,
                IntentFilter("aurora.debug.FFI_SMOKE"),
                ContextCompat.RECEIVER_EXPORTED,
            )
            ContextCompat.registerReceiver(
                this,
                fileOpDebugReceiver,
                IntentFilter("aurora.debug.FILEOP"),
                ContextCompat.RECEIVER_EXPORTED,
            )
        }
    }

    /** 4.2 分享：系统分享面板（多图 ACTION_SEND_MULTIPLE，content:// URI + 读授权）。 */
    private fun shareUris(uris: List<Uri>) {
        val intent = Intent(Intent.ACTION_SEND_MULTIPLE).apply {
            type = "image/*"
            putParcelableArrayListExtra(Intent.EXTRA_STREAM, ArrayList(uris))
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        startActivity(Intent.createChooser(intent, "分享图片"))
    }

    /**
     * 4.2 删除：API ≥ 30 走 MediaStore.createDeleteRequest（系统弹窗逐批授权，无需
     * 写权限）；< 30 无该 API，退化为直接逐条删（本应用自建媒体可成，三方媒体被拒
     * 只记日志，见 GalleryViewModel.deleteDirect）。完成后的索引对账都由 MediaStore
     * observer 自动完成。
     */
    private fun requestDelete(uris: List<Uri>) {
        if (uris.isEmpty()) return
        if (Build.VERSION.SDK_INT >= 30) {
            try {
                val pi = MediaStore.createDeleteRequest(contentResolver, uris)
                deleteLauncher.launch(IntentSenderRequest.Builder(pi.intentSender).build())
            } catch (e: Exception) {
                Log.w("AuroraKotlin", "[Delete] createDeleteRequest failed", e)
                Toast.makeText(this, "删除请求失败", Toast.LENGTH_SHORT).show()
            }
        } else {
            viewModel.deleteDirect(uris)
        }
    }

    /**
     * MediaStore 监听跟随前台生存期：后台不收通知（省电，也不做无谓重扫）。
     * 回前台时兜底对账一次——后台期间（监听已注销）MediaStore 的增删在这里补上；
     * 无实质变化时各 adapter 的幂等守卫不会 notifyDataSetChanged，界面纹丝不动。
     */
    override fun onStart() {
        super.onStart()
        viewModel.startMediaStoreObservation()
        viewModel.refreshFromForeground()
    }

    override fun onStop() {
        super.onStop()
        viewModel.stopMediaStoreObservation()
    }

    /**
     * 模拟器验证钩子：`adb shell am broadcast -a aurora.debug.PINCH --es scale 0.75`
     * 触发一次完整的捏合手势（走生产回调链），scale<1 收拢 / >1 张开。
     * `--es mode touch` 走合成双指 MotionEvent 的真实事件分发路径（含中途抬指/抖动）。
     */
    private val pinchDebugReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            val scale = intent.getStringExtra("scale")?.toFloatOrNull() ?: 0.75f
            val steps = intent.getStringExtra("steps")?.toIntOrNull() ?: 12
            val mode = intent.getStringExtra("mode") ?: "callback"
            val seed = intent.getStringExtra("seed")?.toLongOrNull() ?: 42L
            Log.i("AuroraKotlin", "[DebugPinch] inject mode=$mode scale=$scale steps=$steps seed=$seed")
            val listener = PinchGridSpanListener.lastInstance?.get() ?: return
            if (mode == "touch") listener.debugInjectTouchPinch(scale, steps, seed)
            else listener.debugInjectPinch(scale, steps)
        }
    }

    /**
     * M4a 0.3 冒烟钩子：`adb shell am broadcast -a aurora.debug.FFI_SMOKE`
     * 跑一遍 0.1 新导出的人物/专题/元数据读写（含「读不存在的行返回 null」的失败路径），
     * 结果只进日志。nonce 用来确认日志确实出自本轮。
     */
    private val ffiDebugReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            runFfiSmoke(intent.getStringExtra("nonce") ?: System.currentTimeMillis().toString())
        }
    }

    /**
     * M4b 1.1 冒烟钩子：UI 入口（1.4/1.5）落地前用 adb 直接驱动写原语（含真实批量授权
     * 弹窗），结果进日志 + Toast。uri 可用 `adb shell content query --uri
     * content://media/external/images/media --projection _id,_display_name,relative_path` 取。
     * ```
     * adb shell am broadcast -a aurora.debug.FILEOP --es op move \
     *   --es uris "content://media/external/images/media/1,content://media/external/images/media/2" \
     *   --es target "Pictures/Dst"        # rename 另加 --es name renamed.jpg；copy 无需授权
     * ```
     */
    private val fileOpDebugReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            val op = intent.getStringExtra("op") ?: return
            val uris = intent.getStringExtra("uris")
                ?.split(',')
                ?.mapNotNull { it.trim().takeIf(String::isNotEmpty) }
                ?.map(Uri::parse)
                .orEmpty()
            val target = intent.getStringExtra("target").orEmpty()
            Log.i("AuroraKotlin", "[DebugFileOp] op=$op uris=$uris target=$target")
            val report: (String) -> Unit = { msg ->
                Log.i("AuroraKotlin", "[DebugFileOp] $msg")
                Toast.makeText(this@MainActivity, msg, Toast.LENGTH_SHORT).show()
            }
            when (op) {
                "rename" -> {
                    val name = intent.getStringExtra("name") ?: return
                    val uri = uris.firstOrNull() ?: return
                    requestWriteAccess(listOf(uri)) {
                        viewModel.renameFiles(listOf(uri to name)) { n -> report("重命名完成 $n") }
                    }
                }
                "move" -> requestWriteAccess(uris) {
                    viewModel.moveFiles(uris, target) { n -> report("移动完成 $n") }
                }
                "copy" -> viewModel.copyFiles(uris, target) { n -> report("复制完成 $n") }
            }
        }
    }

    private fun isEmulator(): Boolean =
        Build.FINGERPRINT.startsWith("generic") ||
            Build.FINGERPRINT.startsWith("unknown") ||
            Build.MODEL.contains("Emulator") ||
            Build.MODEL.contains("Android SDK built for") ||
            Build.HARDWARE.contains("goldfish") ||
            Build.HARDWARE.contains("ranchu") ||
            Build.PRODUCT.contains("sdk")

    /** 阶段 5：通知权限（API 33+ 运行时请求；拒绝则扫描通知静默不发，不影响功能）。 */
    private val notificationPermission = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { /* 拒绝也不阻断：通知只是增强 */ }

    private fun requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    private fun requestMediaPermissionIfNeeded() {
        val permission = if (Build.VERSION.SDK_INT >= 33) {
            Manifest.permission.READ_MEDIA_IMAGES
        } else {
            Manifest.permission.READ_EXTERNAL_STORAGE
        }
        if (checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED) {
            viewModel.startScanIfNeeded()
            requestNotificationPermissionIfNeeded()
        } else {
            requestPermission.launch(permission)
        }
    }
}

@Composable
fun App(
    state: AppState,
    folders: List<Folder>,
    images: List<Image>,
    /** 展示序列（过滤+排序后）由组合根算好传入：查看器的进入序列必须是同一条（M3 2.2）。 */
    displayImages: List<Image>,
    /** 侧栏标签 Section 的分组 + 计数（Rust 算好的顺序原样渲染，M4a 3.1）。 */
    tagGroups: List<TagGroup>,
    /** 全部专题（M4a 3.2 总览网格）。 */
    topics: List<uniffi.aurora_core.FfiTopic>,
    /** coverFileId → Image（专题卡片封面）。 */
    coverImagesById: Map<String, Image>,
    scanning: Boolean,
    thumbnailLoader: ThumbnailLoader,
    onFolderClick: (Folder) -> Unit,
    /** 点专题卡片 = 进专题详情（3.2）。 */
    onTopicClick: (uniffi.aurora_core.FfiTopic) -> Unit,
    /** 新建专题（3.2；parentId null=根专题，非 null=在该专题下建子专题）。 */
    onCreateTopic: (String, String?) -> Unit,
    /** 3.2 归入：把选中图加入专题（宿主落库 + 反馈）。 */
    onAddToTopic: (topicId: String, fileIds: Set<String>) -> Unit,
    /** 3.2 对称操作：从专题移除选中图。 */
    onRemoveFromTopic: (topicId: String, fileIds: Set<String>) -> Unit,
    /** 4.2 分享：解析选中项为 URI 后由宿主拉起系统分享面板。 */
    onShareSelection: (Set<String>) -> Unit,
    /** 4.2 删除：解析选中项为 URI 后由宿主发起删除请求（含系统确认）。 */
    onDeleteSelection: (Set<String>) -> Unit,
    /** 4.3 编辑标签弹窗的数据源：file_id → 标签（VM 快照原样）。 */
    tagsByFile: Map<String, List<String>>,
    /** 4.3 复制标签：选中集标签并集存应用内剪贴板（宿主做，反馈也在这里）。 */
    onCopyTags: (Set<String>) -> Unit,
    /** 4.3 粘贴标签：剪贴板标签合并进选中集（1.1 批量原语，宿主落库）。 */
    onPasteTags: (Set<String>) -> Unit,
    /** 4.3 编辑标签保存：单文件标签整体替换（2.1 的 saveFileUpdates，唯一写入口）。 */
    onSaveFileTags: (String, List<String>) -> Unit,
    /** 4.3 专题重命名落库（upsertTopic 整行写）。 */
    onRenameTopic: (uniffi.aurora_core.FfiTopic, String) -> Unit = { _, _ -> },
    /** 4.3 专题删除落库（递归删子专题）。 */
    onDeleteTopic: (uniffi.aurora_core.FfiTopic) -> Unit = {},
    /** 4.3 设为专题封面（详情选择模式的触屏同位入口）。 */
    onSetTopicCover: (topicId: String, fileId: String) -> Unit = { _, _ -> },
    // —— M4b 1.4 文件操作（网格入口；执行在宿主，弹窗状态在本组合）——
    /** 复制/移动到既有相册（宿主解析 RELATIVE_PATH + 授权 + 调写原语）。 */
    onCopyMoveFiles: (fileIds: List<String>, targetFolderId: String, type: String) -> Unit = { _, _, _ -> },
    /** 复制/移动到**新相册**（1.3 懒创建；宿主校验名字后建在 Pictures/<名字>）。 */
    onCopyMoveToNewAlbum: (fileIds: List<String>, albumName: String, type: String) -> Unit = { _, _, _ -> },
    /** 总览选中的文件夹卡片展开成成员图片 id（复制/移动/删除的统一前置）。 */
    onResolveSelectionFileIds: (Set<String>, (List<String>) -> Unit) -> Unit = { _, _ -> },
    /** 网格重命名（1.4 单选菜单项；宿主过写授权后改 DISPLAY_NAME）。 */
    onRenameFile: (fileId: String, newName: String) -> Unit = { _, _ -> },
    /** 打开设置面板（M4b 2.1；对话框由宿主层渲染）。 */
    onOpenSettings: () -> Unit = {},
    /** 4.4 下拉刷新：宿主触发扫描，完成时回调 [onComplete]（指示器落勾）。 */
    onPullRefresh: ((onComplete: () -> Unit) -> Unit),
) {
    // 活动标签驱动 UI：folderId × folders 得出当前文件夹；viewMode 决定总览或文件夹网格
    val tab = state.activeTab
    val currentFolder = tab.folderId?.let { id -> folders.firstOrNull { it.id == id } }
    val context = LocalContext.current
    val density = LocalDensity.current
    // M4c D21：横屏手机 = 宽 ≥600dp 且高 <480dp——设置双形态断点外的第三形态，
    // 侧栏「设置」行被裁切，入口挂顶栏（onOpenSettings 传 TopBar）
    val isLandscapePhone = LocalConfiguration.current.let {
        it.screenWidthDp >= 600 && it.screenHeightDp < 480
    }
    // 4.4 下拉刷新的触发阈值（80dp，React threshold 同值）
    val ptrThresholdPx = with(density) { 80.dp.toPx() }

    // 4.3 返回链需要读取/关闭搜索胶囊（React 里是 searchInput focused 的判断），提升到这里
    var searchOpen by remember { mutableStateOf(false) }
    // 4.2 删除确认弹窗
    var showDeleteConfirm by remember { mutableStateOf(false) }
    // M4a 3.2 新建专题弹窗（TopicsOverview 的「新建专题」按钮触发）
    var showCreateTopic by remember { mutableStateOf(false) }
    // M4a 3.2 专题选择弹窗（选择模式「更多」→「加入专题…」触发）
    var showTopicPicker by remember { mutableStateOf(false) }
    // M4a 4.3 「更多」菜单开合（受控）：长按已选中项时从网格侧打开
    var moreExpanded by remember { mutableStateOf(false) }
    // M4a 4.3 编辑标签弹窗的目标文件（单选菜单项触发）
    var editTagsFileId by remember { mutableStateOf<String?>(null) }
    // M4a 4.3 专题卡片长按菜单 → 重命名 / 删除确认弹窗的目标
    var renameTopicState by remember { mutableStateOf<uniffi.aurora_core.FfiTopic?>(null) }
    var deleteTopicState by remember { mutableStateOf<uniffi.aurora_core.FfiTopic?>(null) }
    // M4b 1.4 目标选择器（copy|move + 已展开成图片 id 的操作集）
    var pickerType by remember { mutableStateOf<String?>(null) }
    var pickerFileIds by remember { mutableStateOf<List<String>>(emptyList()) }
    // M4b 1.3 新建相册的重名合并确认（相册 + 待执行的 type/fileIds）
    var albumMerge by remember { mutableStateOf<Triple<uniffi.aurora_core.Folder, String, List<String>>?>(null) }
    // M4b 1.4 网格重命名的目标文件（单选菜单项触发；弹窗复用查看器 RenameDialog 形制）
    var renameFileId by remember { mutableStateOf<String?>(null) }
    // 3.2④ 建专题弹窗的目标父级：总览按钮=null（根专题），详情子专题区=当前专题
    var createTopicParent by remember { mutableStateOf<String?>(null) }
    // 4.4 下拉刷新状态（overview 与 browser 共用一个实例：同一时刻只有一个网格在组合）
    val ptrState = remember { PullToRefreshState() }

    if (scanning) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Text("扫描中…")
        }
        return
    }

    // 工具按钮按视图提供（2026-09-17 起）：文件夹内部 = 搜索/排序/视图/日期全量；
    // 总览 = 搜索（按文件夹名过滤）+ 排序 + 日期筛选（Folder.createdAt/modifiedAt，
    // Rust list_folders 子查询提供）。排序字段/方向是应用级状态（对齐 React：总览与
    // 文件网格共用同一 sortBy/sortDirection）。总览的视图循环（React folderLayoutMode）
    // 不做——文件夹卡片是等比正方形，adaptive/masonry 视觉与 grid 等价。
    //
    // 标签视图（M4a 4.1）走的也是 BROWSER + 网格，只是序列源换成「标签命中的全库图片」，
    // 所以这里不能只看 currentFolder 是否存在——在总览直接点标签时 folderId 为 null。
    val tagFilterTitle = tab.activeTags.joinToString("、") { it }
    val inBrowser =
        tab.viewMode == ViewMode.BROWSER && (currentFolder != null || tagFilterTitle.isNotEmpty())
    // M4a 3.2 总览：侧栏人物/标签/专题 Section 头部进入；专题详情 = TOPICS_OVERVIEW + activeTopicId
    val inTagsOverview = tab.viewMode == ViewMode.TAGS_OVERVIEW
    val inPeopleOverview = tab.viewMode == ViewMode.PEOPLE_OVERVIEW
    val inTopicsOverview = tab.viewMode == ViewMode.TOPICS_OVERVIEW
    // M4b 阶段 4：画布占位视图（入口已达成，视图本体归 M5）
    val inCanvas = tab.viewMode == ViewMode.CANVAS
    val inTopicsList = inTopicsOverview && tab.activeTopicId == null
    val inTopicDetail = inTopicsOverview && tab.activeTopicId != null
    val currentTopicName = tab.activeTopicId?.let { id ->
        topics.firstOrNull { it.id == id }?.name
    }
    // 当前详情的专题（3.3 Hero 用；activeTopicId 悬空时详情分支给兜底空态）
    val currentTopic = tab.activeTopicId?.let { id -> topics.firstOrNull { it.id == id } }
    // 3.2④ 两层专题（对齐桌面：顶层只显示根专题 TopicModule:860；子专题区只渲染在根
    // 专题详情 :945/:2072——子专题里没有这个区，子专题不能再建子专题）
    val rootTopics = topics.filter { it.parentId == null }
    val childTopics = tab.activeTopicId?.let { id -> topics.filter { it.parentId == id } } ?: emptyList()
    // 当前详情里的专题是否根专题（子专题详情不渲染子专题区/建子专题入口）
    val currentTopicIsRoot = tab.activeTopicId?.let { id ->
        topics.firstOrNull { it.id == id }?.parentId == null
    } ?: false

    // —— M4a 3.3 专题排序 + 总览搜索（对齐桌面 TopicModule）——
    // 排序：桌面 localStorage `aurora_topic_sort_mode/order` 同语义。M4b 2.1 起并入
    // SettingsStore（旧 `aurora_topics` 键只读迁移）。比较逻辑在 sortTopicsForDisplay。
    val topicSortStore = remember { com.aurora.gallery.kotlin.state.SettingsStore(context) }
    var topicSort by remember {
        mutableStateOf(
            if (topicSortStore.loadTopicSortByName()) TopicSortOption.NAME else TopicSortOption.TIME,
        )
    }
    var topicSortAscending by remember { mutableStateOf(topicSortStore.loadTopicSortAscending()) }
    // 总览搜索：按名称过滤根专题（桌面 topics-overview 的顶栏搜索同款）
    val topicQuery = tab.searchQuery.trim()
    val visibleRootTopics = remember(rootTopics, topicQuery) {
        if (topicQuery.isEmpty()) rootTopics
        else rootTopics.filter { it.name.contains(topicQuery, ignoreCase = true) }
    }
    val sortedRootTopics = remember(visibleRootTopics, topicSort, topicSortAscending) {
        sortTopicsForDisplay(visibleRootTopics, topicSort, topicSortAscending)
    }
    // 子专题横排沿用同一排序（桌面子专题区有独立的排序按钮，平板收敛为一份）
    val sortedChildTopics = remember(childTopics, topicSort, topicSortAscending) {
        sortTopicsForDisplay(childTopics, topicSort, topicSortAscending)
    }

    // 「更多」菜单项（3.2 归入入口 + M4a 4.3 收口的标签三项 + M4b 1.4 文件操作三项；
    // 桌面同位是文件右键菜单 ContextMenu.tsx 的文件分支——「添加到主题 / 编辑标签 /
    // 复制标签 / 粘贴标签 / 重命名 / 复制到 / 移动到」；AI/比较归 M6）：
    //  - 文件夹网格里多选 → 加入专题 / 粘贴标签 / 复制到 / 移动到，单选另有 编辑标签 / 复制标签 / 重命名
    //  - 专题详情里多选 → 从专题移除（对称操作）
    //  - 总览选中的是文件夹卡片 → 复制到 / 移动到 / 删除（成员展开后落写原语）
    val inFoldersOverview = !(inBrowser || inTagsOverview || inPeopleOverview || inTopicsOverview)
    val moreActions = when {
        inBrowser -> buildList {
            add(SelectionMoreAction("加入专题…") { showTopicPicker = true })
            if (tab.selectedFileIds.size == 1) {
                add(SelectionMoreAction("编辑标签…") { editTagsFileId = tab.selectedFileIds.first() })
                add(SelectionMoreAction("复制标签") { onCopyTags(tab.selectedFileIds) })
            }
            add(SelectionMoreAction("粘贴标签") { onPasteTags(tab.selectedFileIds) })
            add(SelectionMoreAction("复制到…") {
                pickerType = "copy"
                pickerFileIds = tab.selectedFileIds.toList()
            })
            add(SelectionMoreAction("移动到…") {
                pickerType = "move"
                pickerFileIds = tab.selectedFileIds.toList()
            })
            if (tab.selectedFileIds.size == 1) {
                add(SelectionMoreAction("重命名…") { renameFileId = tab.selectedFileIds.first() })
            }
        }
        inTopicDetail && tab.activeTopicId != null && tab.selectedFileIds.isNotEmpty() -> buildList {
            if (tab.selectedFileIds.size == 1) {
                add(SelectionMoreAction("编辑标签…") { editTagsFileId = tab.selectedFileIds.first() })
                add(SelectionMoreAction("复制标签") { onCopyTags(tab.selectedFileIds) })
                // 桌面「设置专题封面」的触屏同位（桌面在专题卡片右键弹选图器，
                // 平板收敛为「详情里选中一张成员图 → 设为封面」，见 TopicsOverview KDoc）
                add(SelectionMoreAction("设为封面") {
                    onSetTopicCover(tab.activeTopicId!!, tab.selectedFileIds.first())
                })
            }
            add(SelectionMoreAction("粘贴标签") { onPasteTags(tab.selectedFileIds) })
            add(SelectionMoreAction("从专题移除") {
                onRemoveFromTopic(tab.activeTopicId!!, tab.selectedFileIds)
            })
        }
        inFoldersOverview && tab.selectedFileIds.isNotEmpty() -> buildList {
            add(SelectionMoreAction("复制到…") {
                onResolveSelectionFileIds(tab.selectedFileIds) { ids ->
                    pickerType = "copy"
                    pickerFileIds = ids
                }
            })
            add(SelectionMoreAction("移动到…") {
                onResolveSelectionFileIds(tab.selectedFileIds) { ids ->
                    pickerType = "move"
                    pickerFileIds = ids
                }
            })
            add(SelectionMoreAction("删除") { showDeleteConfirm = true })
        }
        else -> emptyList()
    }

    // 总览数据管道：过滤（搜索词/日期）→ 排序（「根目录图片」恒置顶在 sortFolders 内保证）。
    // remember 键齐备：任一条件变化才重算，文件夹列表量级小、开销可忽略。
    val displayFolders = remember(folders, tab.searchQuery, tab.dateFilter, state.sortBy, state.sortDirection) {
        filterFolders(
            sortFolders(folders, state.sortBy, state.sortDirection),
            tab.searchQuery,
            tab.dateFilter,
        )
    }

    // 3.2 数据管道：搜索/日期过滤 → 排序（分组在 FileGrid 内部完成）。提前到组合根算：
    // 4.1/4.2 的选择处理与选择栏计数在两个分支外就要用（展示序列 = 范围选择/全选的
    // 输入，选择栏 total = 当前展示数量），M3 查看器的进入序列也共用这一条。
    // 范围选择/全选的输入（当前展示顺序）。rememberUpdatedState：长按回调经 adapter 的
    // 首帧闭包转发，这里保证它读到的是最新展示序列
    val currentImageIds = rememberUpdatedState(displayImages.map { it.id })
    val currentFolderIds = rememberUpdatedState(displayFolders.map { it.id })

    // —— 4.1 编辑模式的操作语义（对齐 React useFileSelection 的安卓分支 + App.tsx 的
    //    handleFolder* 系列；框选按 2026-09-20 用户决定平板不做）——
    val onImageClick: (Image) -> Unit = { img ->
        if (state.selectionMode) state.toggleSelectedInMode(img.id) else state.openViewer(img.id)
    }
    val onImageLongPress: (Image) -> Unit = { img ->
        when {
            !state.selectionMode -> state.enterSelectionMode(img.id)
            img.id !in tab.selectedFileIds -> state.rangeSelect(img.id, currentImageIds.value)
            // 已选中项长按 = 打开选中集菜单（M4a 4.3 收口 M1 占位；桌面同位是文件
            // 右键菜单，菜单本体在选择栏「更多」按钮处展开）
            else -> moreExpanded = true
        }
    }
    val onFolderCardClick: (Folder) -> Unit = { folder ->
        if (state.selectionMode) state.toggleSelectedInMode(folder.id) else onFolderClick(folder)
    }
    val onFolderCardLongPress: (Folder) -> Unit = { folder ->
        when {
            !state.selectionMode -> state.enterSelectionMode(folder.id)
            folder.id !in tab.selectedFileIds -> state.rangeSelect(folder.id, currentFolderIds.value)
            // 已选中卡片长按 = 打开选中集菜单（M4b 1.4：复制到/移动到/删除；此前
            // 「更多」在总览是 Toast 占位）
            else -> moreExpanded = true
        }
    }

    // —— M4a 3.1 / 4.1 侧栏与弹层点标签 = 单选筛选 ——
    // 序列源随之切换（见 GalleryViewModel.reloadImages：有标签 = 全库按标签取，
    // 无标签 = 当前文件夹），取数由组合根那条 LaunchedEffect 统一触发。
    val onTagClick: (String) -> Unit = { tag -> state.toggleTagFilter(tag) }

    // —— 4.3 返回手势链（D5 后：关弹层→关搜索→退选择→返回上级→总览再退=系统默认）。
    // 排序菜单/日期弹层/标签弹层是独立窗口（Dialog/BottomSheet），系统返回先被它们
    // 自己消费，不进本链。
    // M3 3.1：查看器插在「退选择模式」之前。它自带 dispatchKeyEvent 的梯子（幻灯片→抽屉→
    // 关闭）与 NativeViewerLayer 的 BackHandler，本链在查看器开着时整条让位——
    // 一次 back 只退一层，退的是查看器，不是 goBack()。
    BackHandler(enabled = tab.viewingFileId == null && (searchOpen || state.selectionMode || tab.history.canBack)) {
        when {
            searchOpen -> {
                // 对齐 React close-android-search：清词 + 关胶囊
                state.setSearchQuery("")
                searchOpen = false
            }

            state.selectionMode -> state.exitSelectionMode()

            else -> state.goBack()
        }
    }

    // 3.5 面板开合：侧栏在左、内容（TopBar + 网格）在右，开关时侧栏宽度收缩把内容
    // 推挤过去（SidebarPane 内做 300ms ease-out 动画，对齐 React SidebarPane）。
    Row(Modifier.fillMaxSize()) {
        SidebarPane(
            visible = state.layout.isSidebarVisible,
            modifier = Modifier.fillMaxHeight(),
        ) {
            // 侧栏文件夹列表用全量 folders：TopBar 搜索词只过滤总览网格（对齐 React
            // 侧栏树不被工具栏搜索过滤）
            TreeSidebar(
                folders = folders,
                currentFolderId = tab.folderId,
                onFolderClick = onFolderClick,
                // 头部点击 = 回主界面（React onNavigateHome，2026-09-20 用户要求）
                onNavigateHome = { state.navigateHome() },
                tagGroups = tagGroups,
                activeTags = tab.activeTags,
                onTagClick = onTagClick,
                // 人物/标签/专题 Section 头部 = 进对应总览（M4a 3.2）
                onPeopleOverviewClick = { state.openOverview(ViewMode.PEOPLE_OVERVIEW) },
                onTagsOverviewClick = { state.openOverview(ViewMode.TAGS_OVERVIEW) },
                onTopicsOverviewClick = { state.openOverview(ViewMode.TOPICS_OVERVIEW) },
                peopleOverviewSelected = inPeopleOverview,
                tagsOverviewSelected = inTagsOverview,
                topicsOverviewSelected = inTopicsOverview,
                foldersOverviewSelected = tab.viewMode == ViewMode.FOLDERS_OVERVIEW,
                // 画布行：点击进占位视图（M4b 阶段 4）
                onCanvasClick = { state.openCanvas() },
                canvasSelected = inCanvas,
                // 设置行：打开设置面板（M4b 2.1）
                onSettingsClick = onOpenSettings,
                browserActive = inBrowser,
                modifier = Modifier.fillMaxHeight(),
            )
        }
        Column(Modifier.weight(1f).fillMaxHeight()) {
            // 4.2 编辑模式：选择栏替换 TopBar（对齐 React ToolbarPane 的二选一结构）
            if (state.selectionMode) {
            SelectionBar(
                selectedCount = tab.selectedFileIds.size,
                // 专题详情（3.2）与文件夹网格同为图片选择；文件夹总览选的是文件夹
                totalCount = if (inBrowser || inTopicDetail) displayImages.size else displayFolders.size,
                    onToggleSelectAll = {
                        val ids = if (inBrowser) currentImageIds.value else currentFolderIds.value
                        if (tab.selectedFileIds.size >= ids.size) state.deselectAll()
                        else state.selectAll(ids)
                    },
                    onExit = { state.exitSelectionMode() },
                    onDelete = { showDeleteConfirm = true },
                    onShare = { onShareSelection(tab.selectedFileIds) },
                    onMore = {
                        // 各选择视图的 moreActions 已全部非空（M4b 1.4 收口：总览的
                        // 复制到/移动到/删除），这里只剩空集兜底，不再有 Toast 占位
                    },
                    moreActions = moreActions,
                    moreExpanded = moreExpanded,
                    onMoreExpandedChange = {
                        // M4b 1.4 排查日志：谁在开/关选中集菜单
                        Log.i("AuroraMenu", "moreExpanded -> $it")
                        moreExpanded = it
                    },
                    modifier = Modifier.fillMaxWidth(),
                )
            } else {
                TopBar(
                    title = when {
                        tagFilterTitle.isNotEmpty() -> "标签 · $tagFilterTitle"
                        inTagsOverview -> "标签"
                        inPeopleOverview -> "人物"
                        inTopicDetail -> currentTopicName ?: "专题"
                        inTopicsList -> "专题"
                        inCanvas -> "画布"
                        else -> currentFolder?.name ?: "文件夹"
                    },
                    canBack = tab.history.canBack,
                    onBack = { state.goBack() },
                    // 总览是从别处推入历史栈的位置，可退；文件夹总览（栈底）不显示返回键
                    showBack = inBrowser || inTagsOverview || inPeopleOverview || inTopicsOverview || inCanvas,
                    sidebarVisible = state.layout.isSidebarVisible,
                    onToggleSidebar = { state.toggleSidebar() },
                    searchQuery = tab.searchQuery,
                    onSearchQueryChange = { state.setSearchQuery(it) },
                    searchOpen = searchOpen,
                    onSearchOpenChange = { searchOpen = it },
                    searchPlaceholder = when {
                        inTagsOverview -> "搜索标签"
                        inTopicsList -> "搜索专题"
                        inBrowser -> "搜索图片"
                        else -> "搜索文件夹"
                    },
                    // M4b 阶段 3：scope 下拉只在 BROWSER（文件夹内/标签筛选）显示，
                    // 对齐 React 在 people/tags 总览隐藏；总览按文件夹名过滤无 scope 语义
                    searchScope = tab.searchScope,
                    onSearchScopeChange = { state.setSearchScope(it) },
                    showScope = inBrowser,
                    dateFilter = tab.dateFilter,
                    onDateFilterChange = { state.setDateFilter(it) },
                    sortBy = state.sortBy,
                    onSortChange = { state.sortBy = it },
                    sortDirection = state.sortDirection,
                    onSortDirectionToggle = {
                        state.sortDirection =
                            if (state.sortDirection == SortDirection.ASC) SortDirection.DESC else SortDirection.ASC
                    },
                    groupBy = state.groupBy,
                    onGroupByChange = { state.groupBy = it },
                    layoutMode = tab.layoutMode,
                    onLayoutModeChange = { mode -> state.updateActiveTab { it.copy(layoutMode = mode) } },
                    // 标签弹层与侧栏标签区同一份数据、同一个点击行为（M4a 3.1 / 4.1）
                    tagGroups = tagGroups,
                    activeTags = tab.activeTags,
                    onTagClick = onTagClick,
                    showSearch = true,
                    // 专题视图下顶栏只留 搜索/返回/侧栏开关（桌面 TopBar :1256/:1521/:1563
                    // 在 topics-overview 隐藏排序/日期/标签，专题自己的排序在页头菜单里）；
                    // 视图切换（grid/adaptive/masonry）= 文件夹网格与专题详情共用
                    showSortMenu = !inTopicsOverview,
                    showViewMode = inBrowser || inTopicDetail,
                    showDateFilter = !inTopicsOverview,
                    showGroupBy = inBrowser,
                    showTags = !inTopicsOverview,
                    // M4c D21：横屏手机侧栏底部「设置」行被裁切不可达，设置入口挂顶栏兜底
                    onOpenSettings = if (isLandscapePhone) {
                        { onOpenSettings() }
                    } else {
                        null
                    },
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            when {
                // M4a 3.2 标签总览：分组标签卡片网格，点卡片 = 进该标签的筛选视图。
                // 数据是本地库的词表（reloadTagState 快照），无 MediaStore 依赖，不接下拉刷新。
                inTagsOverview -> TagsOverview(
                    tagGroups = tagGroups,
                    onTagClick = onTagClick,
                    searchQuery = tab.searchQuery,
                    initialScrollAnchor = state.tagsOverviewScrollAnchor,
                    onScrollChanged = { state.tagsOverviewScrollAnchor = it },
                    emptyText = if (tab.searchQuery.isNotBlank()) "无匹配标签" else "暂无标签",
                    modifier = Modifier.fillMaxWidth().weight(1f),
                )
                // 人物总览：D11=③ 的空壳（数据源在 M6），只有正确空态
                inPeopleOverview -> PeopleOverview(Modifier.fillMaxWidth().weight(1f))
                // 专题总览列表（3.2 落地；3.3 页头排序 + 搜索对齐桌面；3.3fix 列数预测防跳档）
                inTopicsList -> TopicsOverview(
                    topics = sortedRootTopics,
                    coverImages = coverImagesById,
                    thumbnailLoader = thumbnailLoader,
                    onTopicClick = { onTopicClick(it) },
                    onCreateTopic = {
                        createTopicParent = null
                        showCreateTopic = true
                    },
                    onRenameTopic = { renameTopicState = it },
                    onDeleteTopic = { deleteTopicState = it },
                    sortOption = topicSort,
                    sortAscending = topicSortAscending,
                    onSortChange = { option, ascending ->
                        topicSort = option
                        topicSortAscending = ascending
                        topicSortStore.saveTopicSort(option == TopicSortOption.NAME, ascending)
                    },
                    sidebarVisible = state.layout.isSidebarVisible,
                    initialScrollAnchor = state.topicsOverviewScrollAnchor,
                    onScrollChanged = { state.topicsOverviewScrollAnchor = it },
                    modifier = Modifier.fillMaxWidth().weight(1f),
                )
                // 专题详情（3.2④ 两层落地；3.3 对齐桌面详情：Hero 头图 + 区块化；
                // 3.3fix 起 Hero/区块头可随滚动收起、图片区整页接续——见 TopicCollapsibleDetail）
                inTopicDetail -> {
                    if (currentTopic == null) {
                        // activeTopicId 悬空（专题被删后的竞态窗口）；reloadTopics 会收敛
                        Column(Modifier.fillMaxWidth().weight(1f)) {
                            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                                Text("专题不存在", color = AuroraTheme.colors.textSecondary)
                            }
                        }
                    } else if (displayImages.isEmpty()) {
                        // 空态没有滚动主体，头部不需要收起逻辑
                        Column(Modifier.fillMaxWidth().weight(1f)) {
                            TopicHero(
                                topic = currentTopic,
                                coverImage = currentTopic.coverFileId?.let { coverImagesById[it] },
                                thumbnailLoader = thumbnailLoader,
                                modifier = Modifier.fillMaxWidth(),
                            )
                            if (currentTopicIsRoot) {
                                TopicChildrenSection(
                                    children = sortedChildTopics,
                                    coverImages = coverImagesById,
                                    thumbnailLoader = thumbnailLoader,
                                    onChildClick = { onTopicClick(it) },
                                    onCreateChild = {
                                        createTopicParent = tab.activeTopicId
                                        showCreateTopic = true
                                    },
                                    onRenameChild = { renameTopicState = it },
                                    onDeleteChild = { deleteTopicState = it },
                                    modifier = Modifier.fillMaxWidth(),
                                )
                            }
                            TopicSectionHeader(
                                icon = com.aurora.gallery.kotlin.ui.components.IconImages,
                                iconTint = com.aurora.gallery.kotlin.ui.components.TOPIC_SECTION_GREEN,
                                title = "图片",
                                modifier = Modifier.fillMaxWidth(),
                            )
                            Box(
                                Modifier.weight(1f).fillMaxWidth().padding(horizontal = 24.dp),
                                contentAlignment = Alignment.TopCenter,
                            ) {
                                val hasCondition =
                                    tab.searchQuery.isNotBlank() || tab.dateFilter.start != null
                                val emptyText = when {
                                    hasCondition -> "无匹配图片"
                                    tagFilterTitle.isNotEmpty() -> "标签「$tagFilterTitle」下没有图片"
                                    else -> "专题里还没有图片"
                                }
                                TopicDashedEmpty(
                                    icon = com.aurora.gallery.kotlin.ui.components.IconImages,
                                    text = emptyText,
                                    modifier = Modifier.fillMaxWidth().padding(top = 4.dp),
                                )
                            }
                        }
                    } else {
                        TopicCollapsibleDetail(
                            resetKey = tab.activeTopicId,
                            modifier = Modifier.fillMaxWidth().weight(1f),
                            header = {
                                TopicHero(
                                    topic = currentTopic,
                                    coverImage = currentTopic.coverFileId?.let { coverImagesById[it] },
                                    thumbnailLoader = thumbnailLoader,
                                    modifier = Modifier.fillMaxWidth(),
                                )
                                if (currentTopicIsRoot) {
                                    TopicChildrenSection(
                                        children = sortedChildTopics,
                                        coverImages = coverImagesById,
                                        thumbnailLoader = thumbnailLoader,
                                        onChildClick = { onTopicClick(it) },
                                        onCreateChild = {
                                            createTopicParent = tab.activeTopicId
                                            showCreateTopic = true
                                        },
                                        onRenameChild = { renameTopicState = it },
                                        onDeleteChild = { deleteTopicState = it },
                                        modifier = Modifier.fillMaxWidth(),
                                    )
                                }
                                TopicSectionHeader(
                                    icon = com.aurora.gallery.kotlin.ui.components.IconImages,
                                    iconTint = com.aurora.gallery.kotlin.ui.components.TOPIC_SECTION_GREEN,
                                    title = "图片",
                                    modifier = Modifier.fillMaxWidth(),
                                )
                            },
                            body = { topInsetPx, onScrolled ->
                                // 换专题（根↔子）不卸载详情子树，RV 会带着旧滚动位置；
                                // overlay 架构里头部收起量 = 滚动累计，必须整体重挂对齐
                                key(tab.activeTopicId) {
                                    FileGrid(
                                        images = displayImages,
                                        selectedIds = tab.selectedFileIds,
                                        thumbnailLoader = thumbnailLoader,
                                        onItemClick = onImageClick,
                                        onItemLongClick = onImageLongPress,
                                        layoutMode = tab.layoutMode,
                                        // 桌面专题图片区无分组（TopicFileGrid 无分组概念）
                                        groupBy = GroupBy.NONE,
                                        level = state.gridLevel,
                                        onLevelChange = { state.gridLevel = it },
                                        sidebarVisible = state.layout.isSidebarVisible,
                                        pullToRefreshState = null,
                                        topInsetPx = topInsetPx,
                                        onScrolled = onScrolled,
                                        modifier = Modifier.fillMaxSize(),
                                    )
                                }
                            },
                        )
                    }
                }
                // M4b 阶段 4：画布占位视图（验收标准「画布入口可点进（视图本体仍属
                // M5）」；M3 3.3 可见占位口径——静默空屏在真机会被当成 bug 报回来）
                inCanvas -> Box(Modifier.fillMaxWidth().weight(1f), contentAlignment = Alignment.Center) {
                    Text("画布视图将随 M5 提供", color = AuroraTheme.colors.textSecondary)
                }
                // 文件夹内网格（选择/查看器共用同一展示序列）
                inBrowser -> {                    if (displayImages.isEmpty()) {
                        Box(Modifier.fillMaxWidth().weight(1f), contentAlignment = Alignment.Center) {
                            val hasCondition = tab.searchQuery.isNotBlank() || tab.dateFilter.start != null
                            val emptyText = when {
                                hasCondition -> "无匹配图片"
                                tagFilterTitle.isNotEmpty() -> "标签「$tagFilterTitle」下没有图片"
                                else -> "文件夹为空"
                            }
                            Text(emptyText, color = AuroraTheme.colors.textSecondary)
                        }
                    } else {
                        Box(Modifier.fillMaxWidth().weight(1f).clipToBounds()) {
                            FileGrid(
                                images = displayImages,
                                selectedIds = tab.selectedFileIds,
                                thumbnailLoader = thumbnailLoader,
                                onItemClick = onImageClick,
                                onItemLongClick = onImageLongPress,
                                layoutMode = tab.layoutMode,
                                groupBy = state.groupBy,
                                level = state.gridLevel,
                                onLevelChange = { state.gridLevel = it },
                                sidebarVisible = state.layout.isSidebarVisible,
                                pullToRefreshState = ptrState,
                                onPullToRefresh = onPullRefresh,
                                modifier = Modifier.fillMaxSize(),
                            )
                            // 4.4 指示器覆盖在网格上层（pointer-events 由 Canvas 天然不拦截触摸）
                            PullToRefreshIndicator(
                                state = ptrState,
                                thresholdPx = ptrThresholdPx,
                                modifier = Modifier.fillMaxSize(),
                            )
                        }
                    }
                }
                // 文件夹总览（栈底 / 主界面）
                else -> {
                    // clipToBounds：指示器空闲时藏在容器上方（负偏移），不裁剪会透出到工具栏
                    Box(Modifier.fillMaxWidth().weight(1f).clipToBounds()) {
                        FoldersOverview(
                            folders = displayFolders,
                            thumbnailLoader = thumbnailLoader,
                            onFolderClick = onFolderCardClick,
                            onFolderLongClick = onFolderCardLongPress,
                            level = state.gridLevel,
                            onLevelChange = { state.gridLevel = it },
                            // 3.5 列数预测：侧栏开合时按目标状态最终宽度一次性收敛列数
                            sidebarVisible = state.layout.isSidebarVisible,
                            // 4.1 选中态：总览的文件夹卡片同样高亮（边框 + 勾）
                            selectedIds = tab.selectedFileIds,
                            // 滚动位置恢复：离开总览（进文件夹）前记录的位置在重建时归位
                            initialScrollTop = state.overviewScrollTop,
                            onScrollChanged = { state.overviewScrollTop = it },
                            emptyText = if (tab.searchQuery.isNotBlank() || tab.dateFilter.start != null) "无匹配文件夹"
                            else "暂无文件夹",
                            pullToRefreshState = ptrState,
                            onPullToRefresh = onPullRefresh,
                            modifier = Modifier.fillMaxSize(),
                        )
                        // 4.4 指示器覆盖在网格上层（pointer-events 由 Canvas 天然不拦截触摸）
                        PullToRefreshIndicator(
                            state = ptrState,
                            thresholdPx = ptrThresholdPx,
                            modifier = Modifier.fillMaxSize(),
                        )
                    }
                }
            }
        }
    }

    if (showCreateTopic) {
        CreateTopicDialog(
            onDismiss = { showCreateTopic = false },
            onConfirm = { name ->
                showCreateTopic = false
                onCreateTopic(name, createTopicParent)
            },
        )
    }

    // M4a 4.3 专题重命名（卡片长按菜单触发；同一弹窗组件复用为重命名形制）
    renameTopicState?.let { topic ->
        CreateTopicDialog(
            title = "重命名专题",
            initialName = topic.name,
            confirmLabel = "重命名",
            onDismiss = { renameTopicState = null },
            onConfirm = { name ->
                renameTopicState = null
                onRenameTopic(topic, name)
            },
        )
    }

    // M4a 4.3 专题删除确认（桌面右键「删除」同位；根专题连带子专题一起删）
    deleteTopicState?.let { topic ->
        val childCount = topics.count { it.parentId == topic.id }
        AlertDialog(
            onDismissRequest = { deleteTopicState = null },
            title = { Text("删除专题") },
            text = {
                Text(
                    if (childCount > 0) {
                        "确定删除「${topic.name}」吗？其 $childCount 个子专题将一并删除，图片本身不受影响。"
                    } else {
                        "确定删除「${topic.name}」吗？图片本身不受影响。"
                    },
                    color = AuroraTheme.colors.textPrimary,
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    deleteTopicState = null
                    onDeleteTopic(topic)
                }) {
                    Text("删除", color = Color(0xFFEF4444))
                }
            },
            dismissButton = {
                TextButton(onClick = { deleteTopicState = null }) {
                    Text("取消", color = AuroraTheme.colors.textPrimary)
                }
            },
        )
    }

    if (showTopicPicker) {
        TopicPickerDialog(
            topics = topics,
            onDismiss = { showTopicPicker = false },
            onPick = { topic ->
                showTopicPicker = false
                onAddToTopic(topic.id, tab.selectedFileIds)
            },
        )
    }

    // —— M4b 1.4 目标相册选择器 + 1.3 新建相册（含重名合并拦截）——
    pickerType?.let { type ->
        TargetPickerDialog(
            folders = folders,
            type = type,
            onDismiss = { pickerType = null },
            onPickFolder = { folder ->
                val fileIds = pickerFileIds
                pickerType = null
                onCopyMoveFiles(fileIds, folder.id, type)
            },
            onPickNewAlbum = { name ->
                val fileIds = pickerFileIds
                pickerType = null
                // 细则 iii：与已有相册同名 → 合并确认，不静默合并；确认后并入该相册
                // 实际的 RELATIVE_PATH（可能是 DCIM 等非 Pictures 目录）
                val existing = folders.firstOrNull { it.name == name }
                if (existing != null) albumMerge = Triple(existing, type, fileIds)
                else onCopyMoveToNewAlbum(fileIds, name, type)
            },
        )
    }

    albumMerge?.let { (folder, type, fileIds) ->
        AlertDialog(
            onDismissRequest = { albumMerge = null },
            title = { Text("合并到已有相册") },
            text = {
                Text(
                    "已有同名相册「${folder.name}」（${folder.imageCount} 张）。将把所选 ${fileIds.size} 个文件并入该相册。",
                    color = AuroraTheme.colors.textPrimary,
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    albumMerge = null
                    onCopyMoveFiles(fileIds, folder.id, type)
                }) {
                    Text("并入", color = AuroraTheme.colors.primaryDeep)
                }
            },
            dismissButton = {
                TextButton(onClick = { albumMerge = null }) {
                    Text("取消", color = AuroraTheme.colors.textPrimary)
                }
            },
        )
    }

    // M4b 1.4 网格重命名：复用查看器的 RenameDialog 形制（View 体系弹窗，一次性；
    // 从 LaunchedEffect 拉起，先清状态——取消即整条流程结束）
    LaunchedEffect(renameFileId) {
        val fid = renameFileId ?: return@LaunchedEffect
        renameFileId = null
        val currentName = images.firstOrNull { it.id == fid }?.name ?: ""
        RenameDialog(
            context = context,
            currentName = currentName,
            onConfirm = { newName -> onRenameFile(fid, newName) },
        ).show()
    }

    // M4a 4.3 编辑标签（长按菜单单选项触发）；保存走 2.1 的唯一写入口
    editTagsFileId?.let { fid ->
        EditTagsDialog(
            fileName = images.firstOrNull { it.id == fid }?.name,
            currentTags = tagsByFile[fid].orEmpty(),
            vocabulary = tagGroups.flatMap { group -> group.tags.map { it.tag } },
            onDismiss = { editTagsFileId = null },
            onSave = { tags ->
                editTagsFileId = null
                onSaveFileTags(fid, tags)
            },
        )
    }

    if (showDeleteConfirm) {
        val n = tab.selectedFileIds.size
        AlertDialog(
            onDismissRequest = { showDeleteConfirm = false },
            title = { Text("删除所选") },
            text = {
                Text(
                    if (inBrowser || inTopicDetail) "确定删除所选的 $n 张图片吗？删除后可尝试在系统相册的回收站中找回。"
                    else "确定删除所选 $n 个文件夹内的全部图片吗？删除后可尝试在系统相册的回收站中找回。",
                    color = AuroraTheme.colors.textPrimary,
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    showDeleteConfirm = false
                    onDeleteSelection(tab.selectedFileIds)
                }) {
                    Text("删除", color = Color(0xFFEF4444))
                }
            },
            dismissButton = {
                TextButton(onClick = { showDeleteConfirm = false }) {
                    Text("取消", color = AuroraTheme.colors.textPrimary)
                }
            },
        )
    }
}
