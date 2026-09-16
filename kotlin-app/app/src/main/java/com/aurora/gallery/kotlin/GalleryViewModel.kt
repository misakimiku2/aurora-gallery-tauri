package com.aurora.gallery.kotlin

import android.app.Application
import android.content.ContentUris
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
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import uniffi.aurora_core.Folder
import uniffi.aurora_core.Image
import uniffi.aurora_core.MediaImage
import uniffi.aurora_core.initDb
import uniffi.aurora_core.listFolders
import uniffi.aurora_core.listImages
import uniffi.aurora_core.upsertMediaImages
import java.io.File

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
            val cached = withContext(Dispatchers.IO) { listFolders() }
            folders.value = cached
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
                reloadActiveFolderImages()
            } catch (e: Exception) {
                Log.w(TAG, "[Scan] hot refresh failed", e)
            }
        }
    }

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

    /** 全量管道：MediaStore 快照 → Rust 幂等对账入库 → 刷新总览文件夹列表。 */
    private suspend fun scanAndReconcile() = scanMutex.withLock {
        val t0 = android.os.SystemClock.elapsedRealtime()
        val imgs = withContext(Dispatchers.IO) { scanMediaStore() }
        Log.i(TAG, "[Scan] MediaStore rows=${imgs.size} cost=${android.os.SystemClock.elapsedRealtime() - t0}ms")
        withContext(Dispatchers.IO) { upsertMediaImages(imgs) }
        Log.i(TAG, "[Scan] reconcile upsert cost=${android.os.SystemClock.elapsedRealtime() - t0}ms total")
        folders.value = withContext(Dispatchers.IO) { listFolders() }
        Log.i(TAG, "[Scan] folders=${folders.value.size} cost=${android.os.SystemClock.elapsedRealtime() - t0}ms total")
    }

    /** 停在文件夹内时重查该文件夹（对账后库里内容可能已增删）；在总览则是 no-op。 */
    private suspend fun reloadActiveFolderImages() {
        val tab = appState.activeTab
        val folderId = tab.folderId ?: return
        if (tab.viewMode != ViewMode.BROWSER) return
        val imgs = withContext(Dispatchers.IO) { listImages(folderId) }
        // 查询期间用户可能已导航走，过期结果直接丢弃（同 openFolder 的竞态守卫）
        val t = appState.activeTab
        if (t.viewMode == ViewMode.BROWSER && t.folderId == folderId) {
            images.value = imgs
        }
    }

    fun openFolder(folder: Folder) {
        // 导航走 TabState.history（推历史栈 + 切 BROWSER + 清选中），见 AppState.openFolder
        appState.openFolder(folder.id)
        // 同步清空旧文件夹内容：listImages 在 IO 线程返回前，组合仍拿着旧 images 渲染，
        // 表现为「点进 B 先闪现 A 的网格再换内容」。清空后中间帧是空白而非错误内容。
        images.value = emptyList()
        viewModelScope.launch {
            val imgs = withContext(Dispatchers.IO) { listImages(folder.id) }
            // 查询期间可能已返回总览/进入其他文件夹，过期结果直接丢弃
            val tab = appState.activeTab
            if (tab.viewMode == ViewMode.BROWSER && tab.folderId == folder.id) {
                images.value = imgs
            }
        }
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
                            ?: ROOT_BUCKET_DISPLAY_NAME,
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

        /** 根目录散落文件的虚拟文件夹名（MediaStore 的 bucket_display_name 为 NULL，对齐 React 版命名）。 */
        private const val ROOT_BUCKET_DISPLAY_NAME = "根目录图片"

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
