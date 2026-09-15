package com.aurora.gallery.kotlin

import android.app.Application
import android.content.ContentUris
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import android.util.Log
import androidx.compose.runtime.mutableStateOf
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.aurora.gallery.kotlin.state.AppState
import com.aurora.gallery.kotlin.state.LayoutVisibility
import com.aurora.gallery.kotlin.state.ViewMode
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
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
        viewModelScope.launch {
            val cached = withContext(Dispatchers.IO) { listFolders() }
            folders.value = cached
            if (cached.isEmpty()) scanning.value = true
            try {
                val t0 = android.os.SystemClock.elapsedRealtime()
                val imgs = withContext(Dispatchers.IO) { scanMediaStore() }
                Log.i(TAG, "[Scan] MediaStore rows=${imgs.size} cost=${android.os.SystemClock.elapsedRealtime() - t0}ms")
                withContext(Dispatchers.IO) { upsertMediaImages(imgs) }
                Log.i(TAG, "[Scan] reconcile upsert cost=${android.os.SystemClock.elapsedRealtime() - t0}ms total")
                folders.value = withContext(Dispatchers.IO) { listFolders() }
                Log.i(TAG, "[Scan] folders=${folders.value.size} cost=${android.os.SystemClock.elapsedRealtime() - t0}ms total")
            } catch (e: Exception) {
                // 扫描/入库失败时保留缓存列表（M1 阶段 1 简单容错）
                Log.w(TAG, "[Scan] failed", e)
            } finally {
                scanning.value = false
            }
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
                        bucketName = c.getString(bucketNameCol) ?: "",
                    )
                )
            }
        }
        return result
    }

    companion object {
        private const val TAG = "AuroraKotlin"

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
