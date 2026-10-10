package com.aurora.gallery.kotlin

import android.content.ContentUris
import android.provider.MediaStore
import android.util.Log
import androidx.compose.runtime.snapshotFlow
import androidx.lifecycle.viewModelScope
import com.aurora.gallery.kotlin.state.AppState
import com.aurora.gallery.kotlin.state.LAN_FOLDER_ID_PREFIX
import com.aurora.gallery.kotlin.state.LAN_SEARCH_FOLDER_ID
import com.aurora.gallery.kotlin.state.SortDirection
import com.aurora.gallery.kotlin.state.SortOption
import com.aurora.gallery.kotlin.state.ViewMode
import com.aurora.gallery.kotlin.state.localPersonIdOrNull
import com.aurora.gallery.kotlin.ui.components.ROOT_FOLDER_DISPLAY_NAME
import com.aurora.gallery.kotlin.ui.components.sortImages
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import uniffi.aurora_core.Folder
import uniffi.aurora_core.Image
import uniffi.aurora_core.MediaImage
import uniffi.aurora_core.getAllFileMetadata
import uniffi.aurora_core.getAllFileTags
import uniffi.aurora_core.getGroupedTags
import uniffi.aurora_core.getTopicFiles
import uniffi.aurora_core.listFolders
import uniffi.aurora_core.listImages
import uniffi.aurora_core.listImagesByIds
import uniffi.aurora_core.listImagesByTags

// 2026-10-11 从 `GalleryViewModel.kt` 拆出（第 13 刀）：「序列源与重载」这一簇整体搬到这里，
// 用**扩展函数**落（套路同 GalleryViewModelFileOps.kt——Kotlin 没有 partial class）。只搬 `fun`；
// 状态字段（localCoverKey / localCoverJob）与 companion 成员留在原类，访问一律写限定名。

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
suspend fun GalleryViewModel.reloadImages() {
    val tab = appState.activeTab
    // —— M6a 阶段 4：LAN 序列源分流（并列入口，M4a 序列源先例）——
    // folderId 带 lan 前缀 = 远端目录（或虚拟根/成员筛选虚拟目录），走 LanClient/会话态；
    // M6b 阶段 5：LAN 搜索结果虚拟目录（__lan_search__）不带 lan: 前缀（纯内部 id），
    // 这里显式并进分流，否则会落到本地 listImages 分支把网格清空。
    if (tab.viewMode == ViewMode.BROWSER &&
        (tab.folderId?.startsWith(LAN_FOLDER_ID_PREFIX) == true || tab.folderId == LAN_SEARCH_FOLDER_ID)
    ) {
        reloadLanImages(tab.folderId!!)
        return
    }
    val topicId = if (tab.viewMode == ViewMode.TOPICS_OVERVIEW) tab.activeTopicId else null
    // 本地人物筛选虚拟目录（`__person__:<id>`）。与 topicId 同为「成员集序列源」，
    // 优先级压在标签之前：人物是全库概念，进人物视图时 activeTags 已由 openFolder 归零。
    val personId = tab.folderId?.localPersonIdOrNull()
    val byTag = tab.activeTags.isNotEmpty()
    if (topicId == null) {
        if (tab.viewMode != ViewMode.BROWSER) return
        if (!byTag && tab.folderId == null) return
    }
    // 换视图的 key 必须覆盖三条序列源的所有输入
    val key = sequenceKey(tab.folderId, tab.activeTags, topicId)
    // 只在**序列源换了**（进文件夹 / 改筛选 / 换专题）时先清空：否则从 B 切回 A 的
    // 那一帧会闪现上一个视图的内容。热刷新（MediaStore 变更）key 不变，不能清——清了就是闪白。
    // 清空的同时置 [imagesPending]（「还没查完」≠「真的空」，空态文案由它压住不闪
    // 「文件夹为空」）；有缓存先首发缓存再查（进目录第一帧就出网格，M8b-23），落地后对账。
    if (key != loadedImagesKey) {
        images.value = imagesCacheByKey[key] ?: emptyList()
        imagesPending.value = true
    }
    loadedImagesKey = key
    val imgs = try {
        withContext(Dispatchers.IO) {
            when {
                topicId != null -> {
                    val memberIds = getTopicFiles(topicId)
                    if (memberIds.isEmpty()) emptyList() else listImagesByIds(memberIds)
                }
                personId != null -> {
                    val memberIds = localPersonMemberIds(personId)
                    if (memberIds.isEmpty()) emptyList() else listImagesByIds(memberIds)
                }
                byTag -> listImagesByTags(tab.activeTags)
                else -> listImages(tab.folderId!!)
            }
        }
    } catch (e: Exception) {
        // 取数失败留空网格而不是旧内容：旧的可能是**另一个视图**的，比空着更误导
        Log.w(GalleryViewModel.TAG, "[Load] images failed topic=$topicId byTag=$byTag folderId=${tab.folderId}", e)
        // 还停在这个序列源上就把 pending 放下来，让空态文案恢复可见（不放=空态被永久吞掉）
        if (activeSequenceKey() == key) imagesPending.value = false
        return
    }
    // 取数期间用户可能已经导航走或改了筛选，过期结果直接丢弃
    if (activeSequenceKey() == key) {
        images.value = imgs
        cachePutImages(key, imgs)
        imagesPending.value = false
        // 诊断（2026-10-07 复制可见性排查）：每次取数落一条，folder + 条数 +
        // 是否含刚复制的行（由调用方上下文推断）。华为吞 logcat，这是唯一取证面。
        debugLog("reloadImages: folder=${tab.folderId} tags=$byTag topic=$topicId person=$personId n=${imgs.size}")
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
suspend fun GalleryViewModel.reloadTagState() {
    try {
        val snapshot = withContext(Dispatchers.IO) {
            Triple(getAllFileTags(), getAllFileMetadata(), getGroupedTags(settings.value.language))
        }
        tagsByFile.value = snapshot.first.associate { it.fileId to it.tags }
        metadataById.value = snapshot.second.associateBy { it.fileId }
        tagGroups.value = snapshot.third
        Log.i(GalleryViewModel.TAG, "[Tags] reload groups=${tagGroups.value.size} taggedFiles=${tagsByFile.value.size} meta=${metadataById.value.size}")
    } catch (e: Exception) {
        Log.w(GalleryViewModel.TAG, "[Tags] reload failed", e)
    }
}

/**
 * 总览排序：「根目录图片」虚拟文件夹恒置顶，其余保持 listFolders 的字典序不变
 * （sortedBy 稳定排序）。总览 TopBar 的排序菜单（sortFolders）在其上再排，置顶规则
 * 两处都做，压在用户排序之上。
 */
// internal 而非 private：Q 路径原语簇已拆到 GalleryViewModelQPaths.kt（扩展函数）里要用
internal fun GalleryViewModel.orderFoldersForOverview(list: List<Folder>): List<Folder> {
    // EMUI 对存储根目录散文件的 bucket_display_name 返回字面 "0"（AOSP 为 NULL，
    // scanMediaStore 只兜了 NULL）：索引里根目录 Folder 行的 name 因此是 "0"——
    // 总览卡片/浏览器标题/目标选择器显示 "0」，且按 ROOT_FOLDER_DISPLAY_NAME
    // 匹配的置顶规则（本函数与 GridModels.sortFolders 双保险）全部失效。
    // 按**路径**（= 外部存储根本身）认根目录并归一名字：路径判定不受 bucket 名字
    // quirks 影响，也不会误伤真名叫 "0" 的子文件夹（它们的 path 不是存储根）。
    val storageRoot = android.os.Environment.getExternalStorageDirectory().absolutePath
    val normalized = list.map { f ->
        if (f.path == storageRoot && f.name != ROOT_FOLDER_DISPLAY_NAME) {
            f.copy(name = ROOT_FOLDER_DISPLAY_NAME)
        } else {
            f
        }
    }
    return if (normalized.any { it.name == ROOT_FOLDER_DISPLAY_NAME })
        normalized.sortedBy { it.name != ROOT_FOLDER_DISPLAY_NAME }
    else normalized
}

// ===== 2026-10 排序改造：本地总览封面随排序重选 =====
//
// list_folders 的 cover_uri 固定按 modified DESC 选第一张（Rust FFI 保持不动——
// uniffi 绑定是手工生成后入库的（kotlin-app/app/src/main/java/uniffi/aurora_core/），
// 改签名要手工重生成，故选 Kotlin 层重选而非改 FFI）。总览封面要随排序口径变化，
// 在这里逐文件夹 list_images 取直接子图，按当前 (sortBy, sortDirection) 内存排序
// 取第一张（比较语义与 GridModels.sortImages 一致：name 不区分大小写 / date=createdAt
// / size=字节；排序稳定，同键保持 modified DESC 原序）。

/**
 * 按当前排序口径重算总览封面（IO 协程；仅在排序方式或文件夹列表变化时执行一次，
 * 不逐帧跑——[localCoverKey] 守卫 + [localCoverJob] 取消旧算）。init 里经
 * snapshotFlow 订阅 (sortBy, sortDirection, folders) 触发。
 */
internal fun GalleryViewModel.refreshLocalOverviewCovers(sortBy: SortOption, direction: SortDirection, foldersNow: List<Folder>) {
    val key = "${sortBy.name}|${direction.name}|${foldersNow.size}|${foldersNow.hashCode()}"
    if (key == localCoverKey) return
    localCoverKey = key
    localCoverJob?.cancel()
    localCoverJob = this.viewModelScope.launch {
        val computed = withContext(Dispatchers.IO) {
            foldersNow.mapNotNull { f ->
                val imgs = try {
                    listImages(f.id)
                } catch (e: Exception) {
                    Log.w(GalleryViewModel.TAG, "[Covers] list_images 失败 folder=${f.name}", e)
                    emptyList()
                }
                pickCoverBySort(imgs, sortBy, direction)?.let { f.id to it }
            }.toMap()
        }
        localCoverOverrides.value = computed
        Log.d(GalleryViewModel.TAG, "[Covers] 总览封面重算 ${computed.size}/${foldersNow.size}（$sortBy $direction）")
    }
}

/** 排序口径下直接子图的第一张的封面（复用 [sortImages] 的比较器，语义单一来源）。 */
private fun GalleryViewModel.pickCoverBySort(imgs: List<Image>, sortBy: SortOption, direction: SortDirection): String? =
    sortImages(imgs, sortBy, direction).firstOrNull()?.contentUri

fun GalleryViewModel.openFolder(folder: Folder) {
    // 导航走 TabState.history（推历史栈 + 切 BROWSER + 清选中），见 AppState.openFolder。
    // 取数不在这里：M4a 4.1 起统一由组合根的 LaunchedEffect(viewMode, folderId,
    // activeTags) 触发 [reloadImages]，导航与筛选共用一个触发点。
    //
    // M8b-23 唯一例外：序列的**同步首发**。LaunchedEffect 在重组之后才跑，清空/取数
    // 都慢一帧——进文件夹的头一两帧只能看到空列表，空态文案就被误亮出来（用户报障）。
    // 这里在切导航之前同步把 images 备好：
    //  - 缓存命中（近期看过的目录）→ 直接首发缓存并预写 loadedImagesKey，第一帧就是
    //    网格；随后 reloadImages 因 key 相同不清空，查询落地后对账纠偏（SWR）。
    //  - 未命中 → 同步清空 + 置 pending：第一帧既不给上一个视图的内容，也不闪
    //    「文件夹为空」，只有一小段空白。
    // key 已在载（侧栏点当前目录这类不触发重查的入口）则原地不动，别把网格清了。
    // key 形态必须与 reloadImages 的分流/拼装一致（LAN 分流含虚拟搜索目录）。
    if (tabSequenceDiffers(folder.id)) {
        val isLan = folder.id.startsWith(LAN_FOLDER_ID_PREFIX) || folder.id == LAN_SEARCH_FOLDER_ID
        val key = if (isLan) lanSequenceKey(folder.id) else sequenceKey(folder.id, emptyList(), null)
        val cached = imagesCacheByKey[key]
        images.value = cached ?: emptyList()
        imagesPending.value = cached == null
        loadedImagesKey = key
    }
    appState.openFolder(folder.id)
}

/** 目标目录的序列源是否与当前已载入的不同（[openFolder] 首发的前置判定）。 */
private fun GalleryViewModel.tabSequenceDiffers(folderId: String): Boolean {
    val tab = appState.activeTab
    if (tab.viewMode != ViewMode.BROWSER) return true
    val isLan = folderId.startsWith(LAN_FOLDER_ID_PREFIX) || folderId == LAN_SEARCH_FOLDER_ID
    val tabIsLan = tab.folderId?.startsWith(LAN_FOLDER_ID_PREFIX) == true || tab.folderId == LAN_SEARCH_FOLDER_ID
    if (isLan != tabIsLan) return true
    return if (isLan) tab.folderId != folderId
    else tab.folderId != folderId || tab.activeTags.isNotEmpty() || tab.activeTopicId != null
}

internal fun GalleryViewModel.scanMediaStore(): List<MediaImage> {
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

