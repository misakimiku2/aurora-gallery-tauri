package com.aurora.gallery.kotlin

import android.app.Application
import android.content.ContentUris
import android.content.ContentValues
import android.database.ContentObserver
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import android.util.Log
import androidx.compose.runtime.mutableStateOf
import androidx.core.content.ContextCompat
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.aurora.gallery.kotlin.state.AppState
import com.aurora.gallery.kotlin.state.LayoutVisibility
import com.aurora.gallery.kotlin.state.ViewMode
import com.aurora.gallery.kotlin.ui.components.ROOT_FOLDER_DISPLAY_NAME
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import uniffi.aurora_core.FfiFileMetadata
import uniffi.aurora_core.FfiTopic
import uniffi.aurora_core.Folder
import uniffi.aurora_core.Image
import uniffi.aurora_core.MediaImage
import uniffi.aurora_core.TagGroup
import uniffi.aurora_core.addFilesToTopic
import uniffi.aurora_core.addTagsToFiles
import uniffi.aurora_core.deleteTopic as deleteTopicFfi
import uniffi.aurora_core.getAllFileMetadata
import uniffi.aurora_core.getAllFileTags
import uniffi.aurora_core.getAllTopics
import uniffi.aurora_core.getGroupedTags
import uniffi.aurora_core.getFileMetadata
import uniffi.aurora_core.getTopicFiles
import uniffi.aurora_core.initDb
import uniffi.aurora_core.listFolders
import uniffi.aurora_core.listImages
import uniffi.aurora_core.listImagesByIds
import uniffi.aurora_core.listImagesByTags
import uniffi.aurora_core.removeFileFromTopic
import uniffi.aurora_core.setFileTags
import uniffi.aurora_core.upsertFileMetadata
import uniffi.aurora_core.upsertMediaImages
import uniffi.aurora_core.upsertTopic
import java.io.File
import java.util.UUID

/**
 * 应用数据与 UI 状态的持有者（ViewModel：生存期跨越旋转等配置变更重建）。
 *
 * 此前 folders / images / scanning / AppState / ThumbnailLoader 全挂在 MainActivity
 * 字段上，而旋转默认销毁重建 Activity（Manifest 未声明 configChanges），一次旋转 =
 * 状态全丢 + 全量重扫 + 缩略图内存缓存清空。上移到 ViewModel 后三者都跨重建保留，
 * [startScanIfNeeded] 的 scanStarted 守卫让重建后的 onCreate 不再重跑扫描。
 * 进程死亡仍会重置，持久化待后续里程碑评估。
 *
 * 热更新：通过 [mediaStoreObserver] 监听 MediaStore 变更（注册跟随 MainActivity 的
 * onStart/onStop），外部增删图片防抖后自动重跑扫描管道，应用开着无需重启即可看到新图。
 */
class GalleryViewModel(app: Application, initialLayout: LayoutVisibility) : ViewModel() {

    private val appContext = app.applicationContext

    val folders = mutableStateOf<List<Folder>>(emptyList())
    val images = mutableStateOf<List<Image>>(emptyList())
    val scanning = mutableStateOf(false)

    // —— M4a 2.0 标签数据层 ——
    //
    // 三份快照的唯一读源：查看器抽屉（2.2）、侧栏标签 Section（3.1）、标签过滤（4.1）
    // 都只读这三个，不许自己去查库。分头查就是三份缓存配三套失效时机，写完之后必然
    // 有一处是旧的。
    //
    // 唯一写者是 [reloadTagState]（全量重算，不做增量）：标签量级是「千」不是「万」，
    // 一次 SQL 分组比维护增量正确性便宜。

    /** `file_id` → 该文件上的标签，保持库里的先后顺序（`file_tags` 是安卓侧唯一真源）。 */
    val tagsByFile = mutableStateOf<Map<String, List<String>>>(emptyMap())

    /** `file_id` → 元数据行。只有**编辑过**的文件才在这一列里有行，所以量很小。 */
    val metadataById = mutableStateOf<Map<String, FfiFileMetadata>>(emptyMap())

    /** 侧栏要看的分组 + 计数。**顺序由 Rust 定**，UI 侧不再排（清单 §1「排序规则只许有一套」）。 */
    val tagGroups = mutableStateOf<List<TagGroup>>(emptyList())

    // —— M4a 3.2 专题数据层 ——
    // 与标签快照同一条纪律：总览/详情/选择弹窗三处都读这两份，唯一写者是 [reloadTopics]，
    // 所有专题写操作（建/归入/移除）落库后必须调它刷新，不许自己改列表。

    /** 全部专题（Rust `get_all_topics`）。列表口径用 [FfiTopic.fileCount]（fileIds 懒加载恒空）。 */
    val topics = mutableStateOf<List<FfiTopic>>(emptyList())

    /** 专题封面解析：coverFileId → Image（一次 `list_images_by_ids` 取齐）。 */
    val coverImagesById = mutableStateOf<Map<String, Image>>(emptyMap())

    /** [reloadImages] 上次取数用的序列源（folder|tags|topic 的复合 key），区分「换视图」与「同一视图热刷新」。 */
    private var loadedImagesKey: String? = null

    /** 应用级 UI 状态（3.1）：标签页 / 导航历史 / 选中 / 档位 / 面板可见性。 */
    val appState = AppState(initialLayout = initialLayout)

    val thumbnailLoader = ThumbnailLoader(appContext)

    /** 本次 ViewModel 生存期内是否已启动过扫描；旋转重建复用同一实例，直接跳过重扫。 */
    private var scanStarted = false

    /**
     * 初始扫描协程。热刷新在它结束前触发时 join 等待：既不重复跑管道，也不丢扫描
     * 期间落地的变更（扫完后再对账一次）。isCompleted==true 即回前台兜底可安全运行。
     */
    private var initialScanJob: Job? = null

    /** 串行化「扫描 → 对账 → 刷新」管道：初始扫描与热刷新不并发写库。 */
    private val scanMutex = Mutex()

    /** MediaStore 变更通知的防抖协程：通知风暴只留最后一次，平静 [MEDIA_CHANGE_DEBOUNCE_MS] 后对账一次。 */
    private var mediaChangeJob: Job? = null

    /**
     * MediaStore 变更监听（注册/注销跟随 onStart/onStop，见 MainActivity）：应用开着时
     * 外部新增/删除/修改图片（相机、截图、MTP 拷入）也能热更新，不再需要重启应用刷新。
     */
    private val mediaStoreObserver = object : ContentObserver(null) {
        override fun onChange(selfChange: Boolean, uri: Uri?) {
            // 拷入一批文件会连发一串通知：取消重建防抖任务，等通知流平静后合并成一次重扫
            mediaChangeJob?.cancel()
            mediaChangeJob = viewModelScope.launch {
                delay(MEDIA_CHANGE_DEBOUNCE_MS)
                // 初始扫描若还在跑，等它结束再补一次对账（变更可能落在扫描查询之后，不能丢）
                initialScanJob?.join()
                hotRefresh()
            }
        }
    }

    init {
        // 初始化 Rust 数据库（filesDir 下）；DB_POOL 已初始化时 Rust 侧 set 幂等忽略
        initDb(File(appContext.filesDir, "aurora.db").absolutePath)
    }

    /**
     * 扫描 MediaStore 并刷新索引，「先旧后新」：库里已有上次的数据就立即上屏，
     * 全量查询 + upsert 转后台跑，完成后再刷新列表。只有空库（首次启动）才用
     * 全屏扫描页挡住——启动感知耗时从「全量扫描」降到「一次本地查询」。
     */
    fun startScanIfNeeded() {
        if (scanStarted) return
        scanStarted = true
        initialScanJob = viewModelScope.launch {
            val cached = withContext(Dispatchers.IO) { orderFoldersForOverview(listFolders()) }
            folders.value = cached
            // 标签快照走本地库、不依赖 MediaStore，先于全量扫描发布：否则扫描那几秒里
            // 侧栏标签区是空的，重进应用的标签要等扫描跑完才回来。专题同理（3.2）。
            reloadTagState()
            reloadTopics()
            if (cached.isEmpty()) scanning.value = true
            try {
                scanAndReconcile()
            } catch (e: Exception) {
                // 扫描/入库失败时保留缓存列表（M1 阶段 1 简单容错）
                Log.w(TAG, "[Scan] failed", e)
            } finally {
                scanning.value = false
            }
        }
    }

    /** 注册 MediaStore 监听；notifyForDescendants=true 以捕获具体图片条目 URI 的通知。 */
    fun startMediaStoreObservation() {
        appContext.contentResolver.registerContentObserver(
            MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
            true,
            mediaStoreObserver,
        )
    }

    /** 注销 MediaStore 监听并丢弃未触发的防抖任务（后台期间不做无谓重扫）。 */
    fun stopMediaStoreObservation() {
        appContext.contentResolver.unregisterContentObserver(mediaStoreObserver)
        mediaChangeJob?.cancel()
        mediaChangeJob = null
    }

    /**
     * 回前台兜底（MainActivity.onStart）：后台期间（监听已注销）MediaStore 的增删在
     * 这里补上。初始扫描尚未完成的冷启动是纯重复（初始扫描读的就是当下的库），跳过；
     * 无实质变化时 adapter 的幂等守卫不会 notifyDataSetChanged，界面纹丝不动。
     */
    fun refreshFromForeground() {
        if (initialScanJob?.isCompleted != true) return
        hotRefresh()
    }

    /** 热刷新主体：重跑全量管道 + 刷新当前文件夹列表；失败只记日志，不影响已上屏数据。 */
    private fun hotRefresh() {
        if (!hasMediaPermission()) return
        viewModelScope.launch {
            try {
                val t0 = android.os.SystemClock.elapsedRealtime()
                scanAndReconcile()
                Log.i(TAG, "[Scan] hot refresh cost=${android.os.SystemClock.elapsedRealtime() - t0}ms total")
                reloadImages()
            } catch (e: Exception) {
                Log.w(TAG, "[Scan] hot refresh failed", e)
            }
        }
    }

    /**
     * 手动刷新（4.4 下拉刷新的入口）：同 [hotRefresh] 的管道，但完成时可回调——
     * 指示器等它落勾。[onDone] 在主线程回调，失败也回调（界面照常复位）。
     */
    fun refreshManual(onDone: () -> Unit = {}) {
        if (!hasMediaPermission()) {
            onDone()
            return
        }
        viewModelScope.launch {
            try {
                scanAndReconcile()
                reloadImages()
                Log.i(TAG, "[Scan] manual refresh done")
            } catch (e: Exception) {
                Log.w(TAG, "[Scan] manual refresh failed", e)
            }
            onDone()
        }
    }

    /**
     * 把选中集合解析成可分享/删除的 content:// URI 列表（4.2）。选中项可能是图片
     * （文件夹内网格）也可能是文件夹（总览）——文件夹展开为其下全部图片（读库，
     * 与网格同源）。[onReady] 在主线程回调；空列表时也回调（调用方自行忽略）。
     */
    fun resolveSelectionUris(ids: Set<String>, onReady: (List<android.net.Uri>) -> Unit) {
        viewModelScope.launch {
            val uris = withContext(Dispatchers.IO) {
                val imgById = images.value.associateBy { it.id }
                val folderById = folders.value.associateBy { it.id }
                val out = ArrayList<android.net.Uri>(ids.size)
                for (id in ids) {
                    imgById[id]?.let { out += android.net.Uri.parse(it.contentUri) }
                        ?: folderById[id]?.let { folder ->
                            listImages(folder.id).forEach { out += android.net.Uri.parse(it.contentUri) }
                        }
                }
                out
            }
            onReady(uris)
        }
    }

    /**
     * API < 30 的删除兜底（[MainActivity] 走 MediaStore.createDeleteRequest 的前置系统
     * 弹窗需要 API 30）：直接逐条 contentResolver.delete。本应用自建的媒体可删成功；
     * 三方媒体的共享存储删除在无 WRITE 权限时抛 SecurityException/Reject——逐条
     * try/catch，成功多少算多少，失败只记日志。
     */
    fun deleteDirect(uris: List<android.net.Uri>, onDone: (Int) -> Unit = {}) {
        viewModelScope.launch {
            val deleted = withContext(Dispatchers.IO) {
                var n = 0
                for (uri in uris) {
                    try {
                        if (appContext.contentResolver.delete(uri, null, null) > 0) n++
                    } catch (e: Exception) {
                        Log.w(TAG, "[Delete] direct delete failed: $uri", e)
                    }
                }
                n
            }
            Log.i(TAG, "[Delete] direct deleted=$deleted/${uris.size}")
            onDone(deleted)
        }
    }

    // ===== M4b 1.1 本地库文件操作（MediaStore 写原语）=====
    //
    // 与桌面 file_operations.rs 不同源（那边是文件系统语义 + 路径哈希迁移元数据；这边
    // 是 MediaStore 行操作），实现不互抄。三个原语都收 **content uri**（UI 边界把
    // file id 解析成 uri 只做一次，写授权也要用同一批 uri），公共纪律：
    //  - 授权在宿主（[MainActivity.requestWriteAccess]，createWriteRequest 攒一批一次弹）；
    //    复制是 insert 新行（App 拥有新行），不需要写授权；
    //  - 重命名/移动只改 MediaStore 行的 DISPLAY_NAME/RELATIVE_PATH，_id 与 content_uri
    //    不变 → file_id 不变 → 元数据自然还挂着（规划五要点②），不写任何迁移代码；
    //  - 全部 Dispatchers.IO + 逐条 try/catch（deleteDirect 同款，成功多少算多少）；
    //  - 完成后主动 scanAndReconcile + reloadImages：observer 的 1s 防抖会兜底，但主动
    //    触发让 UI 即时反映，不赌时序（五要点③「UI 不能等下次扫描才变」）。

    /** 选中集上下文菜单/查看器共用：把文件 id 解析成 content uri（读索引，不挑当前视图）。 */
    fun resolveFileUris(fileIds: Collection<String>, onReady: (List<android.net.Uri>) -> Unit) {
        viewModelScope.launch {
            onReady(resolveUris(fileIds).map { it.second })
        }
    }

    /**
     * 重命名（改 DISPLAY_NAME）。[targets] = (uri, 新名)；调用方先过宿主授权（单选场景
     * 只有一个 uri，同样走 [MainActivity.requestWriteAccess] 一条路径）。
     */
    fun renameFiles(targets: List<Pair<android.net.Uri, String>>, onDone: (Int) -> Unit = {}) {
        if (targets.isEmpty()) {
            onDone(0)
            return
        }
        viewModelScope.launch {
            val n = withContext(Dispatchers.IO) {
                var count = 0
                for ((uri, newName) in targets) {
                    try {
                        val values = ContentValues().apply {
                            put(MediaStore.Images.Media.DISPLAY_NAME, newName)
                        }
                        if (appContext.contentResolver.update(uri, values, null, null) > 0) count++
                    } catch (e: Exception) {
                        Log.w(TAG, "[FileOp] rename failed $uri -> $newName", e)
                    }
                }
                count
            }
            Log.i(TAG, "[FileOp] renamed=$n/${targets.size}")
            if (n > 0) refreshAfterWrite()
            onDone(n)
        }
    }

    /**
     * 移动到目标相册（改 RELATIVE_PATH 跨 bucket）。[targetRelPath] 由宿主解析好传入
     * （既有相册的 RELATIVE_PATH 或新相册的 `Pictures/<名字>`，见 resolveFolderRelPath /
     * MainActivity 的新建相册分支）；授权（批量一次）由调用方先行完成。
     */
    fun moveFiles(uris: List<android.net.Uri>, targetRelPath: String, onDone: (Int) -> Unit = {}) {
        if (uris.isEmpty()) {
            onDone(0)
            return
        }
        val relPath = targetRelPath.ensureTrailingSlash()
        viewModelScope.launch {
            val n = withContext(Dispatchers.IO) {
                var count = 0
                for (uri in uris) {
                    try {
                        val values = ContentValues()
                        if (Build.VERSION.SDK_INT >= 29) {
                            values.put(MediaStore.Images.Media.RELATIVE_PATH, relPath)
                        } else {
                            // API < 29 没有 RELATIVE_PATH 列：按旧语义直接改 DATA 全路径
                            val name = queryDisplayName(uri) ?: continue
                            values.put(MediaStore.Images.Media.DATA, legacyDataPath(relPath, name))
                        }
                        if (appContext.contentResolver.update(uri, values, null, null) > 0) count++
                    } catch (e: Exception) {
                        Log.w(TAG, "[FileOp] move failed $uri -> $relPath", e)
                    }
                }
                count
            }
            Log.i(TAG, "[FileOp] moved=$n/${uris.size} -> $relPath")
            if (n > 0) refreshAfterWrite()
            onDone(n)
        }
    }

    /**
     * 复制到目标相册（insert 新行 + 字节流拷贝）。不需要写授权（App 拥有新行，只要读
     * 权限）。元数据/标签搬运在 1.2（FFI 导出 generateId 后补）。
     */
    fun copyFiles(uris: List<android.net.Uri>, targetRelPath: String, onDone: (Int) -> Unit = {}) {
        if (uris.isEmpty()) {
            onDone(0)
            return
        }
        val relPath = targetRelPath.ensureTrailingSlash()
        viewModelScope.launch {
            val n = withContext(Dispatchers.IO) {
                var count = 0
                for (source in uris) {
                    try {
                        val uri = insertImageCopy(source, relPath) ?: continue
                        appContext.contentResolver.openInputStream(source)?.use { input ->
                            appContext.contentResolver.openOutputStream(uri)?.use { output ->
                                input.copyTo(output)
                            } ?: throw IllegalStateException("openOutputStream failed: $uri")
                        } ?: throw IllegalStateException("openInputStream failed: $source")
                        count++
                    } catch (e: Exception) {
                        Log.w(TAG, "[FileOp] copy failed $source -> $relPath", e)
                    }
                }
                count
            }
            Log.i(TAG, "[FileOp] copied=$n/${uris.size} -> $relPath")
            if (n > 0) refreshAfterWrite()
            onDone(n)
        }
    }

    /** 逐条写操作后的主动刷新（防抖 observer 只是兜底）。 */
    private suspend fun refreshAfterWrite() {
        try {
            scanAndReconcile()
            reloadImages()
        } catch (e: Exception) {
            Log.w(TAG, "[FileOp] post-write refresh failed", e)
        }
    }

    /** file_id → content uri（FFI 索引为源，概览页 stale 的 images.value 不掺和）。 */
    private suspend fun resolveUris(fileIds: Collection<String>): List<Pair<String, android.net.Uri>> =
        withContext(Dispatchers.IO) {
            val byId = listImagesByIds(fileIds.toList()).associateBy { it.id }
            fileIds.mapNotNull { id -> byId[id]?.let { id to android.net.Uri.parse(it.contentUri) } }
        }

    /** 源行的 DISPLAY_NAME（API < 29 移动时拼 DATA 用）。 */
    private fun queryDisplayName(uri: android.net.Uri): String? =
        appContext.contentResolver.query(
            uri,
            arrayOf(MediaStore.Images.Media.DISPLAY_NAME),
            null, null, null,
        )?.use { if (it.moveToFirst()) it.getString(0) else null }

    /** insert 一行并返回新 uri（携带源的尺寸/日期等列；R+ 走 VOLUME_EXTERNAL_PRIMARY）。 */
    private fun insertImageCopy(source: android.net.Uri, relPath: String): android.net.Uri? {
        val resolver = appContext.contentResolver
        val projection = arrayOf(
            MediaStore.Images.Media.DISPLAY_NAME,
            MediaStore.Images.Media.MIME_TYPE,
            MediaStore.Images.Media.WIDTH,
            MediaStore.Images.Media.HEIGHT,
            MediaStore.Images.Media.SIZE,
            MediaStore.Images.Media.DATE_ADDED,
            MediaStore.Images.Media.DATE_MODIFIED,
        )
        resolver.query(source, projection, null, null, null)?.use { c ->
            if (!c.moveToFirst()) return null
            val name = c.getString(0) ?: return null
            val values = ContentValues().apply {
                put(MediaStore.Images.Media.DISPLAY_NAME, name)
                if (!c.isNull(1)) put(MediaStore.Images.Media.MIME_TYPE, c.getString(1))
                if (!c.isNull(2)) put(MediaStore.Images.Media.WIDTH, c.getInt(2))
                if (!c.isNull(3)) put(MediaStore.Images.Media.HEIGHT, c.getInt(3))
                put(MediaStore.Images.Media.SIZE, if (c.isNull(4)) 0L else c.getLong(4))
                if (!c.isNull(5)) put(MediaStore.Images.Media.DATE_ADDED, c.getLong(5))
                if (!c.isNull(6)) put(MediaStore.Images.Media.DATE_MODIFIED, c.getLong(6))
                if (Build.VERSION.SDK_INT >= 29) {
                    put(MediaStore.Images.Media.RELATIVE_PATH, relPath)
                } else {
                    put(MediaStore.Images.Media.DATA, legacyDataPath(relPath, name))
                }
            }
            val collection = if (Build.VERSION.SDK_INT >= 29) {
                MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
            } else {
                MediaStore.Images.Media.EXTERNAL_CONTENT_URI
            }
            return resolver.insert(collection, values)
        }
        return null
    }

    /** API < 29 的目标全路径（共享存储根 + RELATIVE_PATH 语义 + 文件名）。 */
    private fun legacyDataPath(relPath: String, name: String): String {
        val base = android.os.Environment.getExternalStorageDirectory().absolutePath
        return "$base/$relPath/$name"
    }

    private fun String.ensureTrailingSlash(): String =
        if (isEmpty() || endsWith('/')) this else "$this/"

    /**
     * 媒体读权限检查。ViewModel 里兜这道闸是因为热刷新的入口（ContentObserver）在本类里：
     * 无权限时 MediaStore 查询只返回本应用自有的条目，拿这种残缺快照去对账会把整个索引清空。
     * 权限字符串须与 MainActivity.requestMediaPermissionIfNeeded 保持一致。
     */
    private fun hasMediaPermission(): Boolean {
        val permission = if (Build.VERSION.SDK_INT >= 33) {
            "android.permission.READ_MEDIA_IMAGES"
        } else {
            android.Manifest.permission.READ_EXTERNAL_STORAGE
        }
        return ContextCompat.checkSelfPermission(appContext, permission) ==
            android.content.pm.PackageManager.PERMISSION_GRANTED
    }

    /** 全量管道：MediaStore 快照 → Rust 幂等对账入库 → 刷新总览文件夹列表 + 标签快照。 */
    private suspend fun scanAndReconcile() = scanMutex.withLock {
        val t0 = android.os.SystemClock.elapsedRealtime()
        val imgs = withContext(Dispatchers.IO) { scanMediaStore() }
        Log.i(TAG, "[Scan] MediaStore rows=${imgs.size} cost=${android.os.SystemClock.elapsedRealtime() - t0}ms")
        withContext(Dispatchers.IO) { upsertMediaImages(imgs) }
        Log.i(TAG, "[Scan] reconcile upsert cost=${android.os.SystemClock.elapsedRealtime() - t0}ms total")
        folders.value = withContext(Dispatchers.IO) { orderFoldersForOverview(listFolders()) }
        Log.i(TAG, "[Scan] folders=${folders.value.size} cost=${android.os.SystemClock.elapsedRealtime() - t0}ms total")
        // 对账可能清掉孤儿行（含 file_tags 指向的 file_id），标签快照跟着重算，
        // 否则侧栏会数出几个网格里点不出来的标签。专题成员同理（topic_files 的孤儿），
        // fileCount 一并刷新。
        reloadTagState()
        reloadTopics()
    }

    /**
     * 查看器编辑弹窗的**唯一**落库入口（M4a 2.1）。参数为 `null` 表示这次没编辑这一项，
     * 与「编辑成空串」是两回事（清空描述是 `""`，不是 `null`）。
     *
     * 标签走 `setFileTags` 整体替换（`file_tags` 是安卓侧唯一真源，见 1.1）；描述与来源
     * 网址走**读-改-写**：`upsertFileMetadata` 是整行 `ON CONFLICT DO UPDATE`，拿半空的
     * 行去写会把另一边的字段冲掉。合并只在 Rust 之外做这一次，元数据面板（4.2）复用本函数，
     * 不再各拼一遍整行。
     */
    fun saveFileUpdates(
        fileId: String,
        tags: List<String>? = null,
        description: String? = null,
        sourceUrl: String? = null,
        onDone: (Boolean) -> Unit = {},
    ) {
        // path 在新建元数据行时才用得上（库里已有行则整行读回来了）。在主线程读
        // images.value，不进 IO 块——Compose state 不该在别的线程读。
        val contentUri = images.value.firstOrNull { it.id == fileId }?.contentUri.orEmpty()
        viewModelScope.launch {
            val ok = withContext(Dispatchers.IO) {
                runCatching {
                    if (tags != null) setFileTags(fileId, tags)
                    if (description != null || sourceUrl != null) {
                        val row = getFileMetadata(fileId) ?: FfiFileMetadata(
                            fileId = fileId,
                            path = contentUri,
                            description = null,
                            sourceUrl = null,
                            aiData = null,
                            category = null,
                            updatedAt = null,
                        )
                        upsertFileMetadata(
                            row.copy(
                                description = description ?: row.description,
                                sourceUrl = sourceUrl ?: row.sourceUrl,
                            )
                        )
                    }
                }.also {
                    if (it.isFailure) {
                        // 不弹「保存成功」的假反馈：这里失败=用户编辑的内容没了
                        Log.w(TAG, "[Edit] save failed fileId=$fileId", it.exceptionOrNull())
                    }
                }.isSuccess
            }
            // 只有真写进去才重算快照：失败时重算会把库里旧值当新值刷回界面
            if (ok) reloadTagState()
            onDone(ok)
        }
    }

    /**
     * 批量粘贴标签（M4a 4.3 长按菜单的「粘贴标签」）：把应用内剪贴板
     * （[AppState.copiedTags]）里的标签合并进选中集每个文件——1.1 的批量原语
     * `add_tags_to_files` 单事务完成，已有成员不重复、新标签追加尾部。合并语义与
     * 桌面 `handlePasteTags`（`useTags.ts:83`）一致；落库成功才重算快照。
     */
    fun pasteTagsToFiles(fileIds: Set<String>, onDone: (Boolean) -> Unit = {}) {
        val tags = appState.copiedTags.toList()
        if (fileIds.isEmpty() || tags.isEmpty()) {
            onDone(false)
            return
        }
        viewModelScope.launch {
            val ok = withContext(Dispatchers.IO) {
                runCatching { addTagsToFiles(fileIds.toList(), tags) }
                    .also {
                        if (it.isFailure) Log.w(TAG, "[Edit] paste tags failed", it.exceptionOrNull())
                    }
                    .isSuccess
            }
            if (ok) reloadTagState()
            onDone(ok)
        }
    }

    /**
     * 重命名专题（M4a 4.3 长按菜单；桌面 TopicModule 右键「重命名」同位）。FFI 没有
     * 专门的 rename 导出，走 `upsertTopic` 整行写——它只写元数据行、不动成员关联
     * （3.2 的自动封面同款路径已实证），快照里的 [topic] 直接 copy 即可。
     */
    fun renameTopic(topic: FfiTopic, newName: String, onDone: (Boolean) -> Unit = {}) {
        val trimmed = newName.trim()
        if (trimmed.isEmpty()) {
            onDone(false)
            return
        }
        viewModelScope.launch {
            val ok = withContext(Dispatchers.IO) {
                runCatching {
                    upsertTopic(topic.copy(name = trimmed, updatedAt = System.currentTimeMillis()))
                }.also {
                    if (it.isFailure) Log.w(TAG, "[Topics] rename failed", it.exceptionOrNull())
                }.isSuccess
            }
            if (ok) reloadTopics()
            onDone(ok)
        }
    }

    /**
     * 删除专题（M4a 4.3 长按菜单；桌面右键「删除」同位）。`delete_topic` 只删该专题的
     * topics / topic_files / topic_people 三表行、**不级联子专题**，这里先把子专题
     * （两层模型下只此一层）递归删掉再删自己；图片本身不受影响。删的是当前详情正打开
     * 的专题时，宿主负责把 activeTopicId 清掉回列表。
     */
    fun deleteTopic(topic: FfiTopic, onDone: (Boolean) -> Unit = {}) {
        viewModelScope.launch {
            val ok = withContext(Dispatchers.IO) {
                runCatching {
                    getAllTopics().filter { it.parentId == topic.id }.forEach { child ->
                        deleteTopicFfi(child.id)
                    }
                    deleteTopicFfi(topic.id)
                }.also {
                    if (it.isFailure) Log.w(TAG, "[Topics] delete failed id=${topic.id}", it.exceptionOrNull())
                }.isSuccess
            }
            if (ok) reloadTopics()
            onDone(ok)
        }
    }

    /**
     * 把成员图设为专题封面（M4a 4.3；桌面「设置专题封面」的触屏同位——桌面在专题
     * 卡片右键弹选图，平板入口在专题详情：选中一张成员图 → 更多菜单「设为封面」）。
     * 走 `upsertTopic` 整行写，同 [renameTopic] 的安全性论证。
     */
    fun setTopicCover(topicId: String, fileId: String, onDone: (Boolean) -> Unit = {}) {
        viewModelScope.launch {
            val topic = topics.value.firstOrNull { it.id == topicId }
            if (topic == null) {
                onDone(false)
                return@launch
            }
            val ok = withContext(Dispatchers.IO) {
                runCatching {
                    upsertTopic(
                        topic.copy(coverFileId = fileId, updatedAt = System.currentTimeMillis()),
                    )
                }.also {
                    if (it.isFailure) Log.w(TAG, "[Topics] set cover failed", it.exceptionOrNull())
                }.isSuccess
            }
            if (ok) reloadTopics()
            onDone(ok)
        }
    }

    /**
     * 重算 [topics] / [coverImagesById]。调用点：启动（先于扫描，专题读本地库不等
     * MediaStore）、对账尾部（删除图片会留下孤儿成员，fileCount 要跟上）、以及每个
     * 专题写操作（建/归入/移除）落库之后。
     */
    suspend fun reloadTopics() {
        try {
            val list = withContext(Dispatchers.IO) { getAllTopics() }
            topics.value = list
            // 封面一次取齐：有 coverFileId 的专题通常寥寥（新专题没有封面），
            // 空列表就不发查询。个别封面图已删除时 listImagesByIds 静默跳过，
            // 该专题退回占位图。
            val coverIds = list.mapNotNull { it.coverFileId }.distinct()
            coverImagesById.value =
                if (coverIds.isEmpty()) emptyMap()
                else withContext(Dispatchers.IO) { listImagesByIds(coverIds) }
                    .associateBy { it.id }
            Log.i(TAG, "[Topics] reload count=${list.size} covers=${coverImagesById.value.size}")
        } catch (e: Exception) {
            Log.w(TAG, "[Topics] reload failed", e)
        }
    }

    /**
     * 新建专题（M4a 3.2，对齐 React `handleCreateTopic(parentId, name)`）。[parentId]
     * 为 null = 根专题（专题总览的「新建专题」按钮）；非 null = 在该专题详情里建
     * **子专题**（子专题区头部的按钮，桌面 TopicModule.tsx:2108 同位）。
     * type 恒 "TOPIC"（React 默认值）；成员为空，不调 set_topic_files（与 React 同注：
     * upsert_topic 只写元数据）。桌面严格两层：子专题详情不再渲染子专题区（UI 层约束，
     * 这里不拦——万一将来要三层，数据层不用动）。
     */
    fun createTopic(name: String, parentId: String? = null, onDone: (Boolean) -> Unit = {}) {
        val trimmed = name.trim()
        if (trimmed.isEmpty()) {
            onDone(false)
            return
        }
        viewModelScope.launch {
            val now = System.currentTimeMillis()
            val topic = FfiTopic(
                id = UUID.randomUUID().toString(),
                parentId = parentId,
                name = trimmed,
                description = null,
                topicType = "TOPIC",
                coverFileId = null,
                backgroundFileId = null,
                coverCrop = null,
                peopleIds = emptyList(),
                fileIds = emptyList(),
                sourceUrl = null,
                createdAt = now,
                updatedAt = now,
                sourceType = null,
                workName = null,
                workNameCn = null,
                fileCount = 0,
            )
            val ok = withContext(Dispatchers.IO) {
                runCatching { upsertTopic(topic) }.also {
                    if (it.isFailure) Log.w(TAG, "[Topics] create failed", it.exceptionOrNull())
                }.isSuccess
            }
            if (ok) reloadTopics()
            onDone(ok)
        }
    }

    /**
     * 把一批图归入专题（M4a 3.2 的「归入」入口；Rust 原语在 1.1 同款语义：已在内成员
     * 不重复、新成员追加尾部）。归入后成员计数变了，[reloadTopics] 必须跑。
     *
     * **首图自动成封面**（对齐桌面 `useTopics.ts:89-99`）：专题还没有封面时，把成员里
     * 第一张图片设为封面——否则总览卡片一直是占位图（3.2 验收反馈 ①）。upsert_topic
     * 只写元数据行、不动成员关联（桌面同注），所以追加这条 upsert 是安全的。
     */
    fun addFilesToTopic(topicId: String, fileIds: Set<String>, onDone: (Boolean) -> Unit = {}) {
        if (fileIds.isEmpty()) {
            onDone(false)
            return
        }
        viewModelScope.launch {
            val ok = withContext(Dispatchers.IO) {
                runCatching {
                    addFilesToTopic(topicId, fileIds.toList())
                    // 无封面 → 成员按加入次序的第一张图（getTopicFiles 保序，
                    // listImagesByIds 只回图片、缺失 id 静默跳过）
                    val topic = topics.value.firstOrNull { it.id == topicId }
                    if (topic != null && topic.coverFileId == null) {
                        val members = getTopicFiles(topicId)
                        val firstImage = members.takeIf { it.isNotEmpty() }
                            ?.let { listImagesByIds(it) }
                            ?.firstOrNull()
                        if (firstImage != null) {
                            upsertTopic(
                                topic.copy(
                                    coverFileId = firstImage.id,
                                    updatedAt = System.currentTimeMillis(),
                                )
                            )
                        }
                    }
                }.also {
                    if (it.isFailure) Log.w(TAG, "[Topics] addFiles failed", it.exceptionOrNull())
                }.isSuccess
            }
            if (ok) reloadTopics()
            onDone(ok)
        }
    }

    /**
     * 从专题移除一批图（3.2 详情页的对称操作；归属关系在 topic_files，不动图片本身）。
     * Rust 原语是单文件的，这里在一个 IO 块里逐条调——选择集通常是个位数，且失败要
     * 逐条记日志而不是整体回滚（没有事务要求：成员关系本就是一行一条）。
     *
     * **封面改指**：桌面移除成员不处理封面（coverFileId 留着已移出的图，卡片还显示它），
     * 这里按修正语义处理——封面在被移除集合里时改指剩余成员的第一张图，专题空了才清空。
     */
    fun removeFilesFromTopic(topicId: String, fileIds: Set<String>, onDone: (Boolean) -> Unit = {}) {
        if (fileIds.isEmpty()) {
            onDone(false)
            return
        }
        viewModelScope.launch {
            val ok = withContext(Dispatchers.IO) {
                var success = 0
                for (id in fileIds) {
                    try {
                        removeFileFromTopic(topicId, id)
                        success++
                    } catch (e: Exception) {
                        Log.w(TAG, "[Topics] removeFile failed id=$id", e)
                    }
                }
                val allRemoved = success == fileIds.size
                // 封面改指（失败也应尝试：能删多少算多少，封面指向已移出的图更难看）
                val topic = topics.value.firstOrNull { it.id == topicId }
                if (allRemoved && topic?.coverFileId != null && topic.coverFileId in fileIds) {
                    try {
                        val remaining = getTopicFiles(topicId)
                        val nextCover = remaining.takeIf { it.isNotEmpty() }
                            ?.let { listImagesByIds(it) }
                            ?.firstOrNull()
                        upsertTopic(
                            topic.copy(
                                coverFileId = nextCover?.id,
                                updatedAt = System.currentTimeMillis(),
                            )
                        )
                    } catch (e: Exception) {
                        Log.w(TAG, "[Topics] cover re-point failed", e)
                    }
                }
                allRemoved
            }
            if (ok) {
                reloadTopics()
                reloadImages()
            }
            onDone(ok)
        }
    }

    /**
     * 当前视图该显示哪些图，**唯一的取数口**（M4a 4.1 / 3.2）。
     *
     * 三条序列源：
     *  - 专题详情（TOPICS_OVERVIEW + activeTopicId）→ `getTopicFiles` 成员 id 经
     *    `list_images_by_ids` 补齐（成员次序 = 详情网格次序 = 加入次序）；
     *  - 有标签筛选 → Rust 按标签取**全库**图片（`list_images_by_tags`）。不能只筛当前
     *    文件夹：侧栏标签上的计数是全库口径，点进去只剩本文件夹那几张的话，同一屏上
     *    「5」和「2 张」自相矛盾。
     *  - 否则 → 当前文件夹的图片；没有文件夹（总览）就不取，保留上一次的结果没有意义。
     *
     * 挂起函数，由 `MainActivity` 的
     * `LaunchedEffect(viewMode, folderId, activeTags, activeTopicId)` 触发——导航与筛选
     * 都收敛到这一个触发点，不再各处自己 launch 一份。
     */
    suspend fun reloadImages() {
        val tab = appState.activeTab
        val topicId = if (tab.viewMode == ViewMode.TOPICS_OVERVIEW) tab.activeTopicId else null
        val byTag = tab.activeTags.isNotEmpty()
        if (topicId == null) {
            if (tab.viewMode != ViewMode.BROWSER) return
            if (!byTag && tab.folderId == null) return
        }
        // 换视图的 key 必须覆盖三条序列源的所有输入
        val key = buildString {
            append("f=").append(tab.folderId ?: "-")
            append("|g=").append(tab.activeTags.joinToString(","))
            append("|t=").append(topicId ?: "-")
        }
        // 只在**序列源换了**（进文件夹 / 改筛选 / 换专题）时先清空：否则从 B 切回 A 的
        // 那一帧会闪现上一个视图的内容。热刷新（MediaStore 变更）key 不变，不能清——清了就是闪白。
        if (key != loadedImagesKey) images.value = emptyList()
        loadedImagesKey = key
        val imgs = try {
            withContext(Dispatchers.IO) {
                when {
                    topicId != null -> {
                        val memberIds = getTopicFiles(topicId)
                        if (memberIds.isEmpty()) emptyList() else listImagesByIds(memberIds)
                    }
                    byTag -> listImagesByTags(tab.activeTags)
                    else -> listImages(tab.folderId!!)
                }
            }
        } catch (e: Exception) {
            // 取数失败留空网格而不是旧内容：旧的可能是**另一个视图**的，比空着更误导
            Log.w(TAG, "[Load] images failed topic=$topicId byTag=$byTag folderId=${tab.folderId}", e)
            return
        }
        // 取数期间用户可能已经导航走或改了筛选，过期结果直接丢弃
        val now = appState.activeTab
        val nowTopic = if (now.viewMode == ViewMode.TOPICS_OVERVIEW) now.activeTopicId else null
        val nowKey = buildString {
            append("f=").append(now.folderId ?: "-")
            append("|g=").append(now.activeTags.joinToString(","))
            append("|t=").append(nowTopic ?: "-")
        }
        if (nowKey == key) {
            images.value = imgs
        }
    }

    /**
     * 重算 [tagsByFile] / [metadataById] / [tagGroups] 三份快照。
     *
     * 调用点只有两处：扫描对账之后（[scanAndReconcile] 尾部），以及元数据/标签落库之后
     * （2.1 的写入路径）。**挂起函数**而非 launch-and-forget：写入方要在快照落地后再
     * 刷新界面，否则「编辑完关掉重开」会读到上一次的快照。
     *
     * 失败只记日志并保留旧快照——三份快照任一读失败都不该把界面清成空的。
     */
    suspend fun reloadTagState() {
        try {
            val snapshot = withContext(Dispatchers.IO) {
                Triple(getAllFileTags(), getAllFileMetadata(), getGroupedTags(TAG_LOCALE))
            }
            tagsByFile.value = snapshot.first.associate { it.fileId to it.tags }
            metadataById.value = snapshot.second.associateBy { it.fileId }
            tagGroups.value = snapshot.third
            Log.i(TAG, "[Tags] reload groups=${tagGroups.value.size} taggedFiles=${tagsByFile.value.size} meta=${metadataById.value.size}")
        } catch (e: Exception) {
            Log.w(TAG, "[Tags] reload failed", e)
        }
    }

    /**
     * 总览排序：「根目录图片」虚拟文件夹恒置顶，其余保持 listFolders 的字典序不变
     * （sortedBy 稳定排序）。总览 TopBar 的排序菜单（sortFolders）在其上再排，置顶规则
     * 两处都做，压在用户排序之上。
     */
    private fun orderFoldersForOverview(list: List<Folder>): List<Folder> =
        if (list.any { it.name == ROOT_FOLDER_DISPLAY_NAME })
            list.sortedBy { it.name != ROOT_FOLDER_DISPLAY_NAME }
        else list

    fun openFolder(folder: Folder) {
        // 导航走 TabState.history（推历史栈 + 切 BROWSER + 清选中），见 AppState.openFolder。
        // 取数不在这里：M4a 4.1 起统一由组合根的 LaunchedEffect(viewMode, folderId,
        // activeTags) 触发 [reloadImages]，导航与筛选共用一个触发点。
        appState.openFolder(folder.id)
    }

    private fun scanMediaStore(): List<MediaImage> {
        val result = mutableListOf<MediaImage>()
        val projection = arrayOf(
            MediaStore.Images.Media._ID,
            MediaStore.Images.Media.DISPLAY_NAME,
            MediaStore.Images.Media.DATA,
            MediaStore.Images.Media.SIZE,
            MediaStore.Images.Media.DATE_ADDED,
            MediaStore.Images.Media.DATE_MODIFIED,
            MediaStore.Images.Media.WIDTH,
            MediaStore.Images.Media.HEIGHT,
            MediaStore.Images.Media.MIME_TYPE,
            MediaStore.Images.Media.BUCKET_ID,
            MediaStore.Images.Media.BUCKET_DISPLAY_NAME,
        )
        appContext.contentResolver.query(
            MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
            projection,
            null,
            null,
            "${MediaStore.Images.Media.DATE_MODIFIED} DESC"
        )?.use { c ->
            val idCol = c.getColumnIndexOrThrow(MediaStore.Images.Media._ID)
            val nameCol = c.getColumnIndexOrThrow(MediaStore.Images.Media.DISPLAY_NAME)
            val dataCol = c.getColumnIndexOrThrow(MediaStore.Images.Media.DATA)
            val sizeCol = c.getColumnIndexOrThrow(MediaStore.Images.Media.SIZE)
            val addedCol = c.getColumnIndexOrThrow(MediaStore.Images.Media.DATE_ADDED)
            val modifiedCol = c.getColumnIndexOrThrow(MediaStore.Images.Media.DATE_MODIFIED)
            val widthCol = c.getColumnIndexOrThrow(MediaStore.Images.Media.WIDTH)
            val heightCol = c.getColumnIndexOrThrow(MediaStore.Images.Media.HEIGHT)
            val mimeCol = c.getColumnIndexOrThrow(MediaStore.Images.Media.MIME_TYPE)
            val bucketIdCol = c.getColumnIndexOrThrow(MediaStore.Images.Media.BUCKET_ID)
            val bucketNameCol = c.getColumnIndexOrThrow(MediaStore.Images.Media.BUCKET_DISPLAY_NAME)

            while (c.moveToNext()) {
                val id = c.getLong(idCol)
                result.add(
                    MediaImage(
                        id = id,
                        contentUri = ContentUris.withAppendedId(
                            MediaStore.Images.Media.EXTERNAL_CONTENT_URI, id
                        ).toString(),
                        path = c.getString(dataCol) ?: "",
                        name = c.getString(nameCol) ?: "",
                        size = c.getLong(sizeCol),
                        dateAdded = c.getLong(addedCol),
                        dateModified = c.getLong(modifiedCol),
                        width = if (c.isNull(widthCol)) null else c.getInt(widthCol),
                        height = if (c.isNull(heightCol)) null else c.getInt(heightCol),
                        mimeType = c.getString(mimeCol) ?: "",
                        bucketId = c.getLong(bucketIdCol).toString(),
                        // 存储根目录散落文件的 bucket_display_name 为 NULL，兜底成虚拟文件夹名
                        //（对齐 React 版 __android_root_images__ 的「根目录图片」）
                        bucketName = c.getString(bucketNameCol)?.takeUnless { it.isBlank() }
                        ?: ROOT_FOLDER_DISPLAY_NAME,
                    )
                )
            }
        }
        return result
    }

    companion object {
        private const val TAG = "AuroraKotlin"

        /** MediaStore 变更通知的防抖窗口：拷入一批文件时通知连发，等平静后再合并成一次重扫。 */
        private const val MEDIA_CHANGE_DEBOUNCE_MS = 1_000L

        /**
         * 标签分组/组内排序用的 locale。Kotlin 侧的语言开关随 M4b 的设置面板才存在，
         * 本轮恒 `zh`（与 React 版 `settings.language` 默认值一致）。
         */
        private const val TAG_LOCALE = "zh"

        /**
         * factory 只在 ViewModel 首次创建时求值：旋转重建复用已有实例，不会重跑，
         * 所以 initialLayout 里的横竖屏判断就是「首次进入时的初始面板可见性」。
         */
        fun factory(app: Application, initialLayout: LayoutVisibility): ViewModelProvider.Factory =
            object : ViewModelProvider.Factory {
                @Suppress("UNCHECKED_CAST")
                override fun <T : ViewModel> create(modelClass: Class<T>): T =
                    GalleryViewModel(app, initialLayout) as T
            }
    }
}
