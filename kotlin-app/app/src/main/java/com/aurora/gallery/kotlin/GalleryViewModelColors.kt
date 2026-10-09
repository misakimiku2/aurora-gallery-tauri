package com.aurora.gallery.kotlin

import android.util.Log
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import uniffi.aurora_core.ColorBatchCallback
import uniffi.aurora_core.ColorPixels
import uniffi.aurora_core.batchExtractColors
import uniffi.aurora_core.cancelColorTask
import uniffi.aurora_core.cleanupColorNonexistent
import uniffi.aurora_core.colorDbStats
import uniffi.aurora_core.deleteColorErrorFiles
import uniffi.aurora_core.extractAndSaveColors
import uniffi.aurora_core.getColorErrorFiles
import uniffi.aurora_core.getColorsByFilePaths
import uniffi.aurora_core.initColorDb
import uniffi.aurora_core.listImages
import uniffi.aurora_core.listImagesByIds
import uniffi.aurora_core.pauseColorTask
import uniffi.aurora_core.retryColorErrorFiles
import uniffi.aurora_core.resumeColorTask
import uniffi.aurora_core.searchByColor
import java.io.File

// 2026-10-10 从 `GalleryViewModel.kt` 拆出：M6b 阶段 3 颜色库任务层这一簇（提取/搜索/批量/
// 统计的入口与私有助手）整体搬到这里，用**扩展函数**落（套路同 GalleryViewModelPeople.kt /
// GalleryViewModelFileOps.kt / GalleryViewModelQPaths.kt——Kotlin 没有 partial class）。
//
// 只搬 `fun`。状态全部留在原类：8 个对外 Compose 状态、2 个嵌套 data class（ColorDbStatsUi /
// ColorTaskState，外部按 GalleryViewModel.ColorDbStatsUi 引用，本文件要写限定名）与 5 个私有
// 字段——扩展函数没有幕后字段，状态搬不出来。被本簇用到的成员（含 scanNotifier / aiToast）
// 在原类里降为 internal。
//
// ⚠️ `object : ColorBatchCallback` 内部**拿不到扩展接收者**（Kotlin 规则：object 表达式不继承
// 外层扩展函数的隐式接收者，lambda 才继承），故 startColorBatchExtract 里先 `val vm = this`
// 捕获，object 内一律 `vm.xxx`。

/** 颜色库幂等初始化（FFI 进程级单槽；首次建库，重复 init=switch 幂等）。 */
private suspend fun GalleryViewModel.ensureColorDb() {
    if (colorDbReady) return
    colorDbMutex.withLock {
        if (!colorDbReady) {
            withContext(Dispatchers.IO) { initColorDb(File(appContext.filesDir, "colors.db").absolutePath) }
            colorDbReady = true
        }
    }
}

/** 颜色库文件本体（面板「数据库大小」也按此路径统计）。 */
private fun GalleryViewModel.colorDbFile(): File = File(appContext.filesDir, "colors.db")

/**
 * colors.db + WAL + SHM 的磁盘占用字节数（对齐桌面 StoragePanel 的
 * `dbSize + walSize`：SQLite 写入大多先落在 WAL，只算主库会严重低估）。
 */
private fun GalleryViewModel.colorDbSizeBytes(): Long {
    val base = colorDbFile()
    return listOf(base, File(base.parentFile, "colors.db-wal"), File(base.parentFile, "colors.db-shm"))
        .sumOf { runCatching { it.length() }.getOrDefault(0L) }
}

/**
 * content URI → 下采样 RGBA 像素（最长边 ≈256px，core 提取算法不再缩放）。
 * null = 非本地 content URI（LAN 项的 http URL）/开流失败/解码失败。
 * getPixels 逐像素装包（ARGB→RGBA）；半透明 PNG 受 Bitmap premultiplied 影响有
 * 轻微色偏——照片主色调语义下可忽略（登记）。
 */
private fun GalleryViewModel.decodeRgba(contentUri: String, maxSide: Int = 256): ColorPixels? {
    if (!contentUri.startsWith("content:")) return null
    return runCatching {
        val resolver = appContext.contentResolver
        val uri = android.net.Uri.parse(contentUri)
        val bounds = android.graphics.BitmapFactory.Options().apply { inJustDecodeBounds = true }
        resolver.openInputStream(uri)?.use { android.graphics.BitmapFactory.decodeStream(it, null, bounds) }
        val w = bounds.outWidth
        val h = bounds.outHeight
        if (w <= 0 || h <= 0) return null
        var sample = 1
        while (maxOf(w, h) / sample > maxSide) sample *= 2
        val opts = android.graphics.BitmapFactory.Options().apply { inSampleSize = sample }
        val bmp = resolver.openInputStream(uri)?.use {
            android.graphics.BitmapFactory.decodeStream(it, null, opts)
        } ?: return null
        val iw = bmp.width
        val ih = bmp.height
        val pixels = IntArray(iw * ih)
        bmp.getPixels(pixels, 0, iw, 0, 0, iw, ih)
        bmp.recycle()
        val rgba = ByteArray(iw * ih * 4)
        for (i in pixels.indices) {
            val p = pixels[i]
            rgba[i * 4] = ((p shr 16) and 0xFF).toByte()
            rgba[i * 4 + 1] = ((p shr 8) and 0xFF).toByte()
            rgba[i * 4 + 2] = (p and 0xFF).toByte()
            rgba[i * 4 + 3] = ((p shr 24) and 0xFF).toByte()
        }
        ColorPixels(width = iw.toUInt(), height = ih.toUInt(), rgba = rgba)
    }.getOrNull()
}

/** 单张提取主色调并落库（查看器手动按钮/自动提取共用）。成功增量进 [colorPalettesById]；失败回调 null。 */
internal fun GalleryViewModel.extractPalette(fileId: String, contentUri: String, onDone: (List<String>?) -> Unit = {}) {
    if (!inFlightPalettes.add(fileId)) return
    viewModelScope.launch {
        val hexes: List<String>? = try {
            ensureColorDb()
            withContext(Dispatchers.IO) {
                val px = decodeRgba(contentUri) ?: throw IllegalStateException("无法读取图像像素")
                extractAndSaveColors(fileId, px.width, px.height, px.rgba)
            }
        } catch (e: Exception) {
            Log.w(GalleryViewModel.TAG, "[Color] extract failed fileId=$fileId", e)
            null
        } finally {
            inFlightPalettes.remove(fileId)
        }
        if (hexes != null) {
            colorPalettesById.value = colorPalettesById.value + (fileId to hexes)
        }
        onDone(hexes)
    }
}

/** 全库批读主色调进 [colorPalettesById]（查看器打开前的暖缓存；只补缺不覆盖已有）。 */
internal fun GalleryViewModel.refreshPaletteCache() {
    viewModelScope.launch {
        runCatching {
            ensureColorDb()
            withContext(Dispatchers.IO) {
                val ids = allImageIds()
                if (ids.isEmpty()) return@withContext
                val rows = getColorsByFilePaths(ids)
                val map = colorPalettesById.value.toMutableMap()
                ids.forEachIndexed { i, id -> rows.getOrNull(i)?.let { map[id] = it } }
                colorPalettesById.value = map
            }
        }.onFailure { Log.w(GalleryViewModel.TAG, "[Color] palette cache refresh failed", it) }
    }
}

/** 全库 file id 清单（相册枚举去重；与 performAiSearch 的全库惯用法同源）。 */
private fun GalleryViewModel.allImageIds(): List<String> =
    folders.value
        .flatMap { f -> runCatching { listImages(f.id) }.getOrDefault(emptyList()) }
        .map { it.id }
        .distinct()

/** 按颜色搜索（查看器色块/TopBar 取色器共用）：命中集顶替文本过滤（AI 搜索同管线，互斥清理）。 */
internal fun GalleryViewModel.startColorSearch(hex: String) {
    // 搜索进行中又来新色（HSV 面板防抖连发）：只记下最新色，本轮收尾后补跑一次——
    // 直接丢弃会让「面板上停下来的颜色」与实际过滤色不一致（末次调用被吞）。
    if (colorSearchBusy.value) {
        pendingColorHex = hex
        return
    }
    viewModelScope.launch {
        colorSearchBusy.value = true
        clearAiSearch() // 与 AI 命中集互斥：颜色命中顶替 AI 命中（反向互斥见 performAiSearch）
        try {
            ensureColorDb()
            val ids = withContext(Dispatchers.IO) { searchByColor(hex) }
            colorSearchIds.value = ids.toSet()
            colorSearchHex.value = hex
            colorSearchResultImages.value =
                if (ids.isEmpty()) emptyList() else withContext(Dispatchers.IO) { listImagesByIds(ids) }
            aiToast("按颜色搜索命中 ${ids.size} 张")
        } catch (e: Exception) {
            Log.w(GalleryViewModel.TAG, "[Color] search failed hex=$hex", e)
            aiToast("颜色搜索失败：${e.message ?: "未知错误"}")
        } finally {
            colorSearchBusy.value = false
            // 补跑搜索期间到达的最新色（见函数头的 pendingColorHex 说明）
            val next = pendingColorHex?.also { pendingColorHex = null }
            if (next != null && !next.equals(hex, ignoreCase = true)) startColorSearch(next)
        }
    }
}

/** 颜色过滤态清理（清搜索词/关搜索胶囊共用）。 */
internal fun GalleryViewModel.clearColorSearch() {
    colorSearchIds.value = null
    colorSearchHex.value = null
    colorSearchResultImages.value = emptyList()
}

/**
 * 主色调节刷新：先清一次磁盘上已不存在的路径残留（桌面同语义；file_id 键保留），
 * 再读统计 + 错误数 + 图库总数 + 库文件占用（后两项供面板的「数据库大小」与
 * 「尚未入库图片数」——桌面取当前目录图片数，安卓的提取面向全库，故取全库量）。
 */
internal fun GalleryViewModel.refreshColorPanel() {
    viewModelScope.launch {
        runCatching {
            ensureColorDb()
            withContext(Dispatchers.IO) {
                cleanupColorNonexistent()
                val s = colorDbStats()
                colorStats.value = GalleryViewModel.ColorDbStatsUi(
                    total = s.total.toInt(),
                    pending = s.pending.toInt(),
                    extracted = s.extracted.toInt(),
                    error = s.error.toInt(),
                    libraryImages = allImageIds().size,
                    dbSizeBytes = colorDbSizeBytes(),
                )
                colorErrorCount.value = getColorErrorFiles().size
            }
        }.onFailure { Log.w(GalleryViewModel.TAG, "[Color] panel refresh failed", it) }
    }
}

/**
 * 批量提取全库主色调（StoragePanel「开始提取」）：逐张 请求像素→提取→落库，
 * 锁步泵在本协程的 IO 线程驱动回调；单张失败只记日志（行标 error 供错误文件管理）。
 * 进度/终态同步通知栏（ScanNotifier.colorProgress/colorDone，暂停/恢复由通知按钮
 * 与面板双入口控制）。
 */
internal fun GalleryViewModel.startColorBatchExtract() {
    // 先把扩展接收者捕获成 vm：object 表达式不继承外层扩展函数的隐式接收者（lambda 才继承），
    // 下面的 object : ColorBatchCallback 回调体里一律走 vm.xxx。
    val vm = this
    if (colorTaskState.value != null) {
        aiToast("提取任务进行中")
        return
    }
    viewModelScope.launch {
        val imagesById = withContext(Dispatchers.IO) {
            folders.value
                .flatMap { f -> runCatching { listImages(f.id) }.getOrDefault(emptyList()) }
                .distinctBy { it.id }
                .associateBy { it.id }
        }
        if (imagesById.isEmpty()) {
            aiToast("没有可提取的图片")
            return@launch
        }
        try {
            ensureColorDb()
        } catch (e: Exception) {
            Log.w(GalleryViewModel.TAG, "[Color] batch init db failed", e)
            aiToast("颜色库初始化失败：${e.message ?: "未知错误"}")
            return@launch
        }
        val taskId = "color-batch-${System.currentTimeMillis()}"
        colorTaskId = taskId
        colorTaskState.value = GalleryViewModel.ColorTaskState(0, imagesById.size, false)
        scanNotifier.colorProgress(0, imagesById.size, false)
        var finished = "completed" to ""
        try {
            withContext(Dispatchers.IO) {
                batchExtractColors(imagesById.keys.toList(), taskId, object : ColorBatchCallback {
                    override fun readPixels(fileId: String): ColorPixels? =
                        imagesById[fileId]?.let { vm.decodeRgba(it.contentUri) }

                    override fun onProgress(current: UInt, total: UInt) {
                        vm.colorTaskState.value =
                            vm.colorTaskState.value?.copy(current = current.toInt(), total = total.toInt())
                        vm.scanNotifier.colorProgress(
                            current.toInt(),
                            total.toInt(),
                            vm.colorTaskState.value?.paused ?: false,
                        )
                    }

                    override fun onFileDone(fileId: String, ok: Boolean, note: String) {
                        if (!ok) Log.w(GalleryViewModel.TAG, "[Color] batch file failed fileId=$fileId: $note")
                    }

                    override fun onFinished(state: String, message: String) {
                        finished = state to message
                    }
                })
            }
        } catch (e: Exception) {
            Log.w(GalleryViewModel.TAG, "[Color] batch extract crashed", e)
            finished = "error" to (e.message ?: "未知错误")
        }
        colorTaskId = null
        colorTaskState.value = null
        refreshColorPanel()
        refreshPaletteCache()
        val doneMessage = when (finished.first) {
            "completed" -> "提取完成（${finished.second}）"
            "cancelled" -> "已取消（${finished.second}）"
            else -> "失败：${finished.second}"
        }
        scanNotifier.colorDone(doneMessage)
        aiToast("主色调$doneMessage")
    }
}

/** 暂停批量提取（下一张迭代边界生效；paused 为本层状态机标志，通知按钮组随之刷新）。 */
internal fun GalleryViewModel.pauseColorBatch() {
    val id = colorTaskId ?: return
    if (pauseColorTask(id)) {
        colorTaskState.value = colorTaskState.value?.copy(paused = true)
        colorTaskState.value?.let { scanNotifier.colorProgress(it.current, it.total, true) }
    }
}

internal fun GalleryViewModel.resumeColorBatch() {
    val id = colorTaskId ?: return
    if (resumeColorTask(id)) {
        colorTaskState.value = colorTaskState.value?.copy(paused = false)
        colorTaskState.value?.let { scanNotifier.colorProgress(it.current, it.total, false) }
    }
}

/** 取消批量提取（在途一张跑完；终态经 onFinished 清任务态）。 */
internal fun GalleryViewModel.cancelColorBatch() {
    colorTaskId?.let { cancelColorTask(it) }
}

/** 错误文件三操作（重试=重新入队/删除=移除记录/清理=清磁盘上已不存在的路径记录）。 */
internal fun GalleryViewModel.retryColorErrors() = colorErrorOp { retryColorErrorFiles() }

internal fun GalleryViewModel.deleteColorErrors() = colorErrorOp { deleteColorErrorFiles() }

internal fun GalleryViewModel.cleanupColorRecords() = colorErrorOp { cleanupColorNonexistent() }

private fun GalleryViewModel.colorErrorOp(op: () -> UInt) {
    viewModelScope.launch {
        runCatching {
            ensureColorDb()
            withContext(Dispatchers.IO) { op() }
        }.onSuccess { n ->
            aiToast("操作完成（$n 条）")
            refreshColorPanel()
        }.onFailure {
            Log.w(GalleryViewModel.TAG, "[Color] error-file op failed", it)
            aiToast("操作失败：${it.message ?: "未知错误"}")
        }
    }
}

/** 自动提取开关（查看器翻图自动提取；设置持久化，UI 在存储面板主色调节）。 */
internal fun GalleryViewModel.setAutoExtractPalette(enabled: Boolean) {
    settings.value = settings.value.copy(autoExtractPalette = enabled)
    settingsStore.save(settings.value)
}
