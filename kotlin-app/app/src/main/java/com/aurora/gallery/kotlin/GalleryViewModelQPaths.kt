package com.aurora.gallery.kotlin

import android.content.ContentUris
import android.content.ContentValues
import android.os.Build
import android.provider.MediaStore
import android.util.Log
import androidx.lifecycle.viewModelScope
import com.aurora.gallery.kotlin.state.ViewMode
import com.aurora.gallery.kotlin.ui.components.ROOT_FOLDER_DISPLAY_NAME
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import uniffi.aurora_core.MediaImage
import uniffi.aurora_core.deleteIndexEntries
import uniffi.aurora_core.generateId
import uniffi.aurora_core.getAllFileTags
import uniffi.aurora_core.getFileMetadata
import uniffi.aurora_core.getTopicFiles
import uniffi.aurora_core.listFolders
import uniffi.aurora_core.listImagesByIds
import uniffi.aurora_core.setFileTags
import uniffi.aurora_core.setTopicFiles
import uniffi.aurora_core.upsertFileMetadata
import uniffi.aurora_core.upsertMediaImage

// 2026-10-10 从 `GalleryViewModel.kt` 拆出：Q（Android 10）传统视图文件路径原语这一簇整体
// 搬到这里，用**扩展函数**落（套路同 GalleryViewModelPeople.kt / GalleryViewModelFileOps.kt
// ——Kotlin 没有 partial class）。只搬 `fun`；状态字段（lastFolderCardsRefreshAt）与原类私有
// 助手留在原类，被本簇用到的助手在原类里降为 internal。扩展函数体内访问 companion 成员要
// 限定（GalleryViewModel.TAG）。

// ===== Q（Android 10）传统视图文件路径原语 =====
//
// 华为 Q MediaProvider 的 update/insert 主目录白名单（allowed [DCIM, Pictures]）
// 对 legacy 应用**没有豁免**——delete 有（2026-10-07 荣耀 TNY-AL00 实测：legacy 下
// delete 直删成功，update/insert 非标准目录抛 IllegalArgumentException: Primary
// directory ... not allowed）。标准目录内 MediaStore 原语照常成功且保 _id，所以顺序
// 一律「先 MediaStore，被拒才走这里」：Q 传统存储视图下 sdcardfs 对应用全盘可写，
// 文件系统变更走 File 直写（Q 传统文件管理器的标准姿势），MediaStore 行靠 MediaScanner
// 重扫收尾。_id 必变 → 元数据/标签/专题成员关系搬家（migrateMetadataAndTagsToNewUri）。

/** SDK 29 且本包走传统存储语义（targetSdk ≤ 29 + manifest requestLegacyExternalStorage）。
 *  **不查 Environment.isExternalStorageLegacy()**：EMUI 上该 API 依赖进程的挂载命名
 *  空间，覆盖安装后的过渡态进程会误报 false（2026-10-07 实测：同一包内 delete 豁免
 *  与重命名成功并存、isLegacy 却 false），而 File 原语失败本身无副作用（renameTo/
 *  copyTo 返回 false），让实际操作说话比赌 API 可靠。 */
private fun GalleryViewModel.isQLegacyFileStorage(): Boolean =
    Build.VERSION.SDK_INT == 29 && appContext.applicationInfo.targetSdkVersion <= 29

/** 行的 DATA 全路径（传统视图下可读）。 */
// internal 而非 private：文件夹改名的时间戳登记（MainActivityFileOps）按旧路径派生
// 新路径要用
internal fun GalleryViewModel.queryDataPath(uri: android.net.Uri): String? =
    appContext.contentResolver.query(
        uri, arrayOf(MediaStore.Images.Media.DATA), null, null, null,
    )?.use { if (it.moveToFirst()) it.getString(0) else null }

/** 按绝对路径（_data）现查行条目 uri（图片/视频两集合都扫，canonical 形式与
 *  scanMediaStore 同构——generateId 必须同值）。两集合都没有 = 行不存在，返回 null。 */
// internal 而非 private：改名时间戳重灌（reapplyRenamedRowStamps）要用
internal fun GalleryViewModel.queryRowUriByDataPath(path: String): android.net.Uri? {
    val collections = listOf(
        MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
        MediaStore.Video.Media.EXTERNAL_CONTENT_URI,
    )
    for (coll in collections) {
        val id = runCatching {
            appContext.contentResolver.query(
                coll, arrayOf(MediaStore.Images.Media._ID),
                "${MediaStore.MediaColumns.DATA}=?", arrayOf(path), null,
            )?.use { c -> if (c.moveToFirst()) c.getLong(0) else null }
        }.getOrNull() ?: continue
        return ContentUris.withAppendedId(coll, id)
    }
    return null
}

/** 共享存储根 + RELATIVE_PATH 语义 → 目录 File（legacyDataPath 的 File 版）。 */
private fun GalleryViewModel.qRelDir(relPath: String): java.io.File =
    java.io.File(android.os.Environment.getExternalStorageDirectory(), relPath.trimEnd('/'))

/** 同名冲突自动后缀（对齐 MediaStore 的 "name (1).ext" 去重行为）。 */
private fun GalleryViewModel.resolveConflictName(dir: java.io.File, name: String): java.io.File {
    var dst = java.io.File(dir, name)
    if (!dst.exists()) return dst
    val dot = name.lastIndexOf('.')
    val base = if (dot > 0) name.substring(0, dot) else name
    val ext = if (dot > 0) name.substring(dot) else ""
    var i = 1
    while (dst.exists()) {
        dst = java.io.File(dir, "$base ($i)$ext")
        i++
    }
    return dst
}

/**
 * 同步扫描新路径拿行 uri：回调缺 uri 时按 _data 现查兜底（EMUI 扫描时序不稳）。
 * EMUI 的 MediaScanner 回调可能迟到/丢失（非标准目录 + 部分 MIME 更慢），这里
 * 轮询两轮：每轮 scanFile 后按 _data 短间隔查询三次；全部落空返回 null（调用方
 * 决定回滚/重试——复制场景文件已拷贝，只有确认扫不出才回收）。
 */
/** scanner 回调 uri 归一化（八轮根因修复，2026-11-18）：MediaScannerConnection 回调
 *  给的是 `external_primary` 形态，全量扫描（scanMediaStore）拼的是 `external` 形态
 *  ——file_id 按 content_uri 字符串算，同一行两种形态两个 id → 索引重复行，且单行
 *  upsert 进的台账（RECENT_MEDIA_UPSERTS，文件在就保）让幻影**整场会话存活**：
 *  用户视角「文件夹数字翻倍」（Eh/image 120 文件卡片显示 240 实案），app 重启后台账
 *  清空、下一次对账才收敛回真身数。按路径段判集合后重拼成全量同款。 */
private fun canonicalMediaUri(uri: android.net.Uri): android.net.Uri? {
    val id = runCatching { ContentUris.parseId(uri) }.getOrNull() ?: return null
    val coll = if (uri.pathSegments.contains("video")) {
        MediaStore.Video.Media.EXTERNAL_CONTENT_URI
    } else {
        MediaStore.Images.Media.EXTERNAL_CONTENT_URI
    }
    return ContentUris.withAppendedId(coll, id)
}

private fun GalleryViewModel.scanFileSync(file: java.io.File): android.net.Uri? {
    val path = file.absolutePath
    var result: android.net.Uri? = null
    for (attempt in 1..2) {
        val latch2 = java.util.concurrent.CountDownLatch(1)
        android.media.MediaScannerConnection.scanFile(
            appContext, arrayOf(path), arrayOf("image/*"),
        ) { _, uri ->
            result = uri?.let { canonicalMediaUri(it) }
            latch2.countDown()
        }
        if (latch2.await(10, java.util.concurrent.TimeUnit.SECONDS) && result != null) {
            return result
        }
        // 回调没来/没带 uri：按 _data 轮询现查（扫描可能已完成只是回调丢了）
        for (retry in 1..3) {
            queryRowUriByPath(path)?.let {
                return it
            }
            Thread.sleep(500)
        }
        debugLog("scanFileSync attempt $attempt missed: $path")
        Log.i(GalleryViewModel.TAG, "[FileOp] scan attempt $attempt missed: $path")
    }
    return queryRowUriByPath(path)
}

/** 按 DATA 全路径查行的规范 uri（external 形式，与全量扫描同款——八轮起 images 查
 *  不到再查 video：scanFileSync 的兜底路径对视频行原来必落空，回调丢了就登记失败）。 */
private fun GalleryViewModel.queryRowUriByPath(path: String): android.net.Uri? {
    for (coll in arrayOf(
        MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
        MediaStore.Video.Media.EXTERNAL_CONTENT_URI,
    )) {
        val uri = appContext.contentResolver.query(
            coll,
            arrayOf(MediaStore.Images.Media._ID),
            "${MediaStore.Images.Media.DATA}=?",
            arrayOf(path), null,
        )?.use { c ->
            if (c.moveToFirst()) ContentUris.withAppendedId(coll, c.getLong(0)) else null
        }
        if (uri != null) return uri
    }
    return null
}

/**
 * 旧 id 的元数据/标签（[includeTopic]=true 时再加专题成员关系）搬到新 uri。
 * copyFiles 副本与 Q 文件路径原语共用；IO 线程调用。
 */
// internal 而非 private：文件操作簇在 GalleryViewModelFileOps.kt（扩展函数）里要用
internal fun GalleryViewModel.migrateMetadataAndTagsToNewUri(
    sourceUri: android.net.Uri,
    newUri: android.net.Uri,
    includeTopic: Boolean,
) {
    val newId = generateId(newUri.toString())
    val sourceId = generateId(sourceUri.toString())
    if (newId == sourceId) return
    getFileMetadata(sourceId)?.let { meta ->
        upsertFileMetadata(meta.copy(fileId = newId, path = newUri.toString()))
    }
    getAllFileTags().firstOrNull { it.fileId == sourceId }?.tags?.let { tags ->
        if (tags.isNotEmpty()) setFileTags(newId, tags)
    }
    if (!includeTopic) return
    // 专题成员表按 file_id 记录，_id 变化后旧成员在对账时会被当孤儿清掉，需同步搬家
    for (topic in topics.value) {
        runCatching {
            val members = getTopicFiles(topic.id)
            if (sourceId in members) {
                setTopicFiles(topic.id, members.map { if (it == sourceId) newId else it })
            }
        }.onFailure { Log.w(GalleryViewModel.TAG, "[FileOp] topic migrate failed topic=${topic.id}", it) }
    }
}

/** Q 传统视图改名：File.renameTo + 元数据搬家；行登记/旧行清理**后台**（EMUI 对
 *  非标准目录的扫描回调能迟到几十秒，同步等会让 toast/UI 一起卡住）。 */
// internal 而非 private：文件操作簇在 GalleryViewModelFileOps.kt（扩展函数）里要用
internal fun GalleryViewModel.legacyRenameViaFile(uri: android.net.Uri, newName: String): Boolean {
    if (!isQLegacyFileStorage()) {
        Log.w(GalleryViewModel.TAG, "[FileOp] legacy rename skipped: not Q legacy storage")
        return false
    }
    val data = queryDataPath(uri)
    if (data == null) {
        Log.w(GalleryViewModel.TAG, "[FileOp] legacy rename: row gone (data null) $uri")
        return false
    }
    val src = java.io.File(data)
    if (!src.isFile) {
        Log.w(GalleryViewModel.TAG, "[FileOp] legacy rename: source missing $data")
        return false
    }
    val dst = resolveConflictName(src.parentFile, newName)
    if (!src.renameTo(dst)) {
        Log.w(GalleryViewModel.TAG, "[FileOp] legacy rename: renameTo failed ${src.absolutePath} -> ${dst.absolutePath}")
        return false
    }
    registerRowAndMigrateAsync(uri, dst, includeTopic = true, deleteSource = true)
    return true
}

/** Q 传统视图移动：跨目录 renameTo（同卷）+ 元数据搬家；行登记/旧行清理后台。
 *  [stamps]：文件夹改名复用本函数时传改前行时间戳——重建行走 MediaScanner 登记，
 *  两列时间都会变成登记时刻（DATE_ADDED 是总览时间排序键的直接来源，见
 *  [MovedRowStamps]），不保真改名照样置顶。保真三棒：文件 mtime 对齐（扫描更新按
 *  mtime 回填 date_modified）+ 行列追写 + 索引 upsert 值覆盖
 *  （见 [registerRowAndMigrateAsync]）。
 *  [bumpActivity]：moveFiles 的开关穿透——目录改名换 bucket 后聚合必变（源减目标
 *  增），registerRow 的「聚合变了就 bump」会把改名当移动戳 now 再经过户带到新
 *  id → 照样置顶（2026-11-18 三轮实测抓到），改名传 false。 */
// internal 而非 private：文件操作簇在 GalleryViewModelFileOps.kt（扩展函数）里要用
internal fun GalleryViewModel.legacyMoveViaFile(
    uri: android.net.Uri,
    relPath: String,
    stamps: MovedRowStamps? = null,
    bumpActivity: Boolean = true,
): Boolean {
    if (!isQLegacyFileStorage()) {
        Log.w(GalleryViewModel.TAG, "[FileOp] legacy move skipped: not Q legacy storage")
        return false
    }
    val data = queryDataPath(uri)
    if (data == null) {
        Log.w(GalleryViewModel.TAG, "[FileOp] legacy move: row gone (data null) $uri")
        return false
    }
    val src = java.io.File(data)
    if (!src.isFile) {
        Log.w(GalleryViewModel.TAG, "[FileOp] legacy move: source missing $data")
        return false
    }
    val dstDir = qRelDir(relPath)
    // 同目录移动 = 无操作（用户在当前相册里选了它自己当目标）；MediaStore 版 update
    // 同值会被系统当 0 行变更 → 误报失败，这里显式放行。
    if (src.parentFile == dstDir) return true
    if (!dstDir.isDirectory && !dstDir.mkdirs()) {
        Log.w(GalleryViewModel.TAG, "[FileOp] legacy move: mkdirs failed ${dstDir.absolutePath}")
        return false
    }
    val dst = resolveConflictName(dstDir, src.name)
    // 八轮实测（2026-11-18）：EMUI 对第三方删视频行弹「检测到极光图库删除了视频，已
    // 成功拦截」——重建路径删旧行每视频触发一次，但文件是 renameTo 挪走的、从未删除，
    // 通知是纯提示。试过 DATA 单列原地更新绕开删除：华为 provider 对 DATA 变更返回
    // 成功后**异步搬文件**，与调用方任何后续文件操作赛跑，赛输即行被 provider 一致性
    // 回收（实测两行全灭、文件裸奔磁盘）——此路不通，维持 renameTo+重建口径。
    if (!src.renameTo(dst)) {
        Log.w(GalleryViewModel.TAG, "[FileOp] legacy move: renameTo failed ${src.absolutePath} -> ${dst.absolutePath}")
        return false
    }
    registerRowAndMigrateAsync(
        uri, dst, includeTopic = true, deleteSource = true,
        stampsOverride = stamps, bumpActivity = bumpActivity,
    )
    return true
}

/** Q 传统视图复制：文件流拷到目标目录；行登记 + 元数据/标签搬运**后台**。 */
// internal 而非 private：文件操作簇在 GalleryViewModelFileOps.kt（扩展函数）里要用
internal fun GalleryViewModel.legacyCopyToDir(
    source: android.net.Uri,
    relPath: String,
    overrideName: String?,
): java.io.File? {
    val data = queryDataPath(source)
    if (data == null) {
        Log.w(GalleryViewModel.TAG, "[FileOp] legacy copy: row gone (data null) $source")
        debugLog("legacyCopy: row gone (data null) $source")
        return null
    }
    val src = java.io.File(data)
    if (!src.isFile) {
        Log.w(GalleryViewModel.TAG, "[FileOp] legacy copy: source missing $data")
        debugLog("legacyCopy: source missing $data")
        return null
    }
    val dstDir = qRelDir(relPath)
    if (!dstDir.isDirectory && !dstDir.mkdirs()) {
        Log.w(GalleryViewModel.TAG, "[FileOp] legacy copy: mkdirs failed ${dstDir.absolutePath}")
        debugLog("legacyCopy: mkdirs failed ${dstDir.absolutePath}")
        return null
    }
    val name = resolveConflictName(dstDir, overrideName ?: src.name).name
    val dst = java.io.File(dstDir, name)
    try {
        src.copyTo(dst, overwrite = false)
    } catch (e: Exception) {
        Log.w(GalleryViewModel.TAG, "[FileOp] legacy copy: copyTo failed $src -> $dst", e)
        debugLog("legacyCopy: copyTo failed $src -> $dst: $e")
        return null
    }
    debugLog("legacyCopy: copied $src -> $dst")
    return dst
}

/**
 * File 原语的收尾（**后台**）：等 MediaStore 把新路径登记成行（EMUI 对非标准目录的
 * 扫描回调能迟到几十秒——同步等会把 toast/UI 一起卡住，2026-10-07 真机体感），拿到
 * 新 uri 后删旧行 + 元数据/标签/专题搬家。登记失败只记日志：文件已落盘，后续系统
 * 扫描/对账兜底，旧行由对账按死行清出索引。
 */
// internal 而非 private：文件操作簇在 GalleryViewModelFileOps.kt（扩展函数）里要用
internal fun GalleryViewModel.registerRowAndMigrateAsync(
    srcUri: android.net.Uri,
    dstFile: java.io.File,
    includeTopic: Boolean,
    deleteSource: Boolean,
    optimisticInsertIntoView: Boolean = false,
    /** 文件夹改名的内容时间保真（见 [legacyMoveViaFile] doc）；null = 不干预。 */
    stampsOverride: MovedRowStamps? = null,
    /** 聚合变化时是否 bump 活动时间（见 [legacyMoveViaFile] doc）；改名传 false。 */
    bumpActivity: Boolean = true,
) {
    viewModelScope.launch(Dispatchers.IO) {
        val t0 = android.os.SystemClock.elapsedRealtime()
        // 操作前的总览快照（move/rename 的活动时间 diff 用）。IO 上读 Compose state
        // 有先例：resolveSelectionFileIds 同样在 withContext(IO) 里读 folders.value。
        val beforeFolders = folders.value
        val newUri = try {
            // 内容时间保真第一棒：把搬移后文件的 mtime 对齐改前 DATE_MODIFIED——实测
            // provider 的扫描登记/扫描更新按**文件 mtime** 回填 date_modified（shell
            // 探针验证：touch 改 mtime → 扫描 → 行值跟着变），renameTo 本就保留 mtime，
            // 绝大多数情况两者同值，这里强制对齐行值保证一致。非标准目录上行列追写
            // 受华为白名单限制时，这条 mtime 路线是唯一可靠回填通道。
            if (stampsOverride != null) {
                runCatching { dstFile.setLastModified(stampsOverride.modified * 1000) }
                    .onFailure { Log.w(GalleryViewModel.TAG, "[FileOp] mtime restore failed: ${dstFile.absolutePath}", it) }
            }
            scanFileSync(dstFile)
        } catch (e: Exception) {
            Log.w(GalleryViewModel.TAG, "[FileOp] row register scan threw: ${dstFile.absolutePath}", e)
            null
        }
        if (newUri == null) {
            Log.w(GalleryViewModel.TAG, "[FileOp] row register failed after retries: ${dstFile.absolutePath}")
            return@launch
        }
        // 内容时间保真第二棒：MediaScanner 重建的新行两列时间 = 登记时刻（date_modified
        // 即便有 mtime 对齐，insert 仍用 now——实测），追写回改前值。否则下一次全量对账
        // 读 MediaStore 把 now 灌进索引，改名卡片再次置顶（索引层的覆盖只能撑到对账）。
        // 追写被拦时重扫一次：mtime 已对齐，扫描更新按 mtime 回填 date_modified。
        if (stampsOverride != null) {
            val cur = queryRowStamps(newUri)
            if (cur != null && (cur.modified != stampsOverride.modified || cur.added != stampsOverride.added)) {
                runCatching {
                    appContext.contentResolver.update(
                        newUri,
                        ContentValues().apply {
                            put(MediaStore.Images.Media.DATE_MODIFIED, stampsOverride.modified)
                            put(MediaStore.Images.Media.DATE_ADDED, stampsOverride.added)
                        },
                        null, null,
                    )
                }.onFailure { Log.w(GalleryViewModel.TAG, "[FileOp] date stamps restore failed: $newUri", it) }
                val cur2 = queryRowStamps(newUri)
                if (cur2 != null && cur2.modified != stampsOverride.modified) {
                    runCatching { scanFileSync(dstFile) }
                }
            }
        }
        if (deleteSource) {
            // 只适用于 rename/move：旧路径上的文件已随 renameTo 消失，旧行是死行，
            // 直删（Q legacy 下 delete 放行）避免幽灵索引。**复制绝不走这里**——
            // 复制的 srcUri 是用户的原图，删了就是把原图送进回收站（2026-10-07
            // 真机踩过：三操作统一收尾时把删源带给了 copy）。
            runCatching { appContext.contentResolver.delete(srcUri, null, null) }
                .onFailure { Log.w(GalleryViewModel.TAG, "[FileOp] old row delete failed: $srcUri", it) }
        }
        // 增量 upsert 单行进索引：网格读 file_index，等全量对账（2.6 万行约 4s，
        // 且 MediaStore 观察者的防抖扫描还会再排一次）才可见＝「复制完好几秒不
        // 显示」。scanner 一登记就地入库，随后打开目标文件夹即时可见；陈旧行仍
        // 归全量对账清理（upsert_media_image 不做快照清理，见其 doc）。
        val img = runCatching { mediaImageOf(newUri) }.getOrNull()
            ?.let {
                if (stampsOverride != null) it.copy(dateModified = stampsOverride.modified, dateAdded = stampsOverride.added)
                else it
            }
        if (img != null) {
            runCatching { upsertMediaImage(img) }
                .onFailure { Log.w(GalleryViewModel.TAG, "[FileOp] single-row upsert failed: $newUri", it) }
            if (optimisticInsertIntoView) optimisticApplyCopiedRow(img)
        } else {
            Log.w(GalleryViewModel.TAG, "[FileOp] mediaImageOf null: $newUri")
        }
        debugLog(
            "registerRow: ${dstFile.name} scan=${android.os.SystemClock.elapsedRealtime() - t0}ms " +
                "upserted=${img != null} uri=$newUri",
        )
        migrateMetadataAndTagsToNewUri(srcUri, newUri, includeTopic)
        if (deleteSource) {
            // move/rename：旧路径的行随 MediaStore 删除已消失，索引里还是死行
            // （源文件夹计数虚高、封面可能指着死行）——立即摘掉；对账稍后以权威
            // 快照覆盖（幂等）。
            runCatching { deleteIndexEntries(listOf(generateId(srcUri.toString()))) }
                .onFailure { Log.w(GalleryViewModel.TAG, "[FileOp] old index row delete failed: $srcUri", it) }
            // 十一轮：改名流程（stampsOverride != null）**不逐行重算总览卡片**——桥接卡
            // 已冻结显示，每行一次 listFolders（~百毫秒）纯属性能税（313 张实案 ≈ 300
            // 次重算），还放大迁移期的网格 recomposition 抖动；settle 由对账驱动
            // （mergeRenameBridge），卡片稳如老狗。普通移动没有桥接，源卡片计数必须
            // 逐行回正，照旧刷。
            if (stampsOverride == null) refreshFolderCards()
            // 移动的源与目标文件夹计数一减一增，diff 双双命中；重命名不改变聚合
            // （同文件夹同文件数），不 bump——它的内容时间也未变，排序位置不动。
            // 2026-11-18 补：目录改名（legacy 重建行走新 bucket）聚合**会**变（源减
            // 目标增），diff 必命中 → 曾经每行 bump 一次 now，再经过户把 now 带给新
            // id → 改名卡片置顶（三轮实测抓到）。bump 与否交给调用方（moveFiles 的
            // bumpActivity 开关）：移动照旧 bump，改名不 bump。
            if (bumpActivity) bumpActivityForChangedFolders(beforeFolders)
        }
        // 正停在某个本地视图就地刷新（之后才进目标文件夹的场景由 openFolder 首发+重查覆盖）
        withContext(Dispatchers.Main) { reloadImages() }
    }
}

/** 行级时间戳对现查（DATE_MODIFIED/DATE_ADDED，秒，一次查询）：文件夹改名的「内容
 *  时间保真」源/校验两用。行没了返回 null。 */
// internal 而非 private：文件操作簇在 GalleryViewModelFileOps.kt（扩展函数）里要用
internal fun GalleryViewModel.queryRowStamps(uri: android.net.Uri): MovedRowStamps? =
    runCatching {
        appContext.contentResolver.query(
            uri,
            arrayOf(MediaStore.Images.Media.DATE_MODIFIED, MediaStore.Images.Media.DATE_ADDED),
            null, null, null,
        )?.use { c ->
            if (c.moveToFirst()) MovedRowStamps(
                modified = if (c.isNull(0)) 0L else c.getLong(0),
                added = if (c.isNull(1)) 0L else c.getLong(1),
            ) else null
        }
    }.getOrNull()

/** 行级 BUCKET_ID 现查（字符串化，generate_id 口径同 Rust 对账）：文件夹改名的
 *  新 folder id 现查用。行没了（legacy 重建后旧 uri 已删）返回 null。 */
// internal 而非 private：文件操作簇在 MainActivityFileOps.kt（扩展函数）里要用
internal fun GalleryViewModel.queryBucketId(uri: android.net.Uri): String? =
    runCatching {
        appContext.contentResolver.query(
            uri,
            arrayOf(MediaStore.Images.Media.BUCKET_ID),
            null, null, null,
        )?.use { c ->
            if (c.moveToFirst() && !c.isNull(0)) c.getLong(0).toString() else null
        }
    }.getOrNull()

/**
 * 单行查询 → [MediaImage]（[registerRowAndMigrateAsync] 增量 upsert 用）。投影与
 * [scanMediaStore] 全量扫描逐列一致——file_id（content_uri 的 md5）与 bucket 派生
 * 口径必须和全量扫描相同，否则同文件会算出两个 id、索引出重复行。
 *
 * A5 起这条铁律多一层含义：**`contentUri` 不能自己拼成图片集合**。原来这里无论进来
 * 的是哪个集合的 URI，都用 `Images.Media.EXTERNAL_CONTENT_URI + id` 重拼——视频行会
 * 被算成一个图片 URI 的 md5，与全量扫描那条视频行的 id 对不上，索引里就多出一条
 * 「同文件两个身份」。现在直接沿用传进来的 URI（三个调用点给的都已是带 id 的条目 URI），
 * 拿不到 id 就返回 null，由调用方按失败处理。
 */
// internal 而非 private：文件操作簇在 GalleryViewModelFileOps.kt（扩展函数）里要用
internal fun GalleryViewModel.mediaImageOf(uri: android.net.Uri): MediaImage? {
    // 传进来的必须是带 id 的条目 URI（三个调用点都满足）；拿不到 id 就没有可靠身份，返回 null
    if (runCatching { ContentUris.parseId(uri) }.isFailure) return null
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
    return appContext.contentResolver.query(uri, projection, null, null, null)?.use { c ->
        if (!c.moveToFirst()) return@use null
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
        // DURATION 只有视频集合有，图片集合上这一列不存在 → 按「列在不在」判，不能 throw
        val durationCol = c.getColumnIndex(MediaStore.Video.Media.DURATION)
        val id = c.getLong(idCol)
        MediaImage(
            id = id,
            contentUri = uri.toString(),
            path = c.getString(dataCol) ?: "",
            name = c.getString(nameCol) ?: "",
            size = c.getLong(sizeCol),
            dateAdded = c.getLong(addedCol),
            dateModified = c.getLong(modifiedCol),
            width = if (c.isNull(widthCol)) null else c.getInt(widthCol),
            height = if (c.isNull(heightCol)) null else c.getInt(heightCol),
            mimeType = c.getString(mimeCol) ?: "",
            bucketId = c.getLong(bucketIdCol).toString(),
            // 与 scanMediaStore 同口径：存储根目录散落文件 bucket_display_name 为 NULL
            bucketName = c.getString(bucketNameCol)?.takeUnless { it.isBlank() }
            ?: ROOT_FOLDER_DISPLAY_NAME,
            durationMs = if (durationCol >= 0 && !c.isNull(durationCol)) c.getLong(durationCol) else null,
        )
    }
}

/**
 * 桌面同款「扫完即插」的完整版：复制落库后（upsert 成功即可调用）做两件事——
 * 1. **网格**：当前正停在目标文件夹 → 副本行并进 images 内存列表 + 缓存（对齐
 *    桌面 `useFileOperations.handleCopyFiles` 的 `scanFile(实际路径, 目标文件夹)`
 *    + `setState`：新节点即时进视图，不等任何重扫）；
 * 2. **总览卡片**：目标文件夹的 imageCount / 封面 / 时间戳按索引聚合口径就地更新。
 *
 * 为什么卡片也要就地更新：封面来自 [folders] 快照（Rust `list_folders` 的聚合
 * 子查询：封面 = modified_at 最新的子图），而快照只有全量对账才重算——复制后
 * 干等 1s 防抖 + 2.4s 扫描，总览封面都没反应（2026-10-08 真机反馈：「文件已
 * 在文件夹里，但文件夹预览缩略图要等几秒」）。副本的 mtime 即复制时刻，恒为
 * 全文件夹最新 → 换封面。
 *
 * 派生规则与 Rust `list_folders` 逐条对齐（count=COUNT、时间=MAX、封面=ORDER
 * BY modified_at DESC LIMIT 1），下次对账以权威数据覆盖（幂等）。排序交给展示
 * 管道；新相册（folders 里还没有行）跳过，交给对账建卡。
 */
// internal 而非 private：文件操作簇在 GalleryViewModelFileOps.kt（扩展函数）里要用
internal fun GalleryViewModel.optimisticApplyCopiedRow(img: MediaImage) {
    viewModelScope.launch {
        val row = withContext(Dispatchers.IO) {
            listImagesByIds(listOf(generateId(img.contentUri))).firstOrNull()
        } ?: return@launch
        val folderId = generateId(img.bucketId)
        // 活动时间先戳：复制进文件夹 = 操作过它（新图内容时间通常也已=现在，双保险）
        bumpFolderActivity(listOf(folderId))
        val tab = appState.activeTab
        // 1. 网格：正停在目标文件夹才插（排序由 rememberDisplayImages 重算）
        if (tab.viewMode == ViewMode.BROWSER && tab.folderId == folderId &&
            images.value.none { it.id == row.id }
        ) {
            val key = sequenceKey(tab.folderId, tab.activeTags, tab.activeTopicId)
            images.value = images.value + row
            cachePutImages(key, images.value)
        }
        // 2. 总览卡片：按 list_folders 聚合口径就地更新
        val current = folders.value.firstOrNull { it.id == folderId } ?: return@launch
        val updated = current.copy(
            imageCount = current.imageCount + 1,
            createdAt = maxOf(current.createdAt, row.createdAt),
            modifiedAt = maxOf(current.modifiedAt, row.modifiedAt),
            // 封面 = modified_at 最新的子图；副本 mtime 即此刻 >= 当前 MAX 即换封面
            coverUri = if (row.modifiedAt >= current.modifiedAt) row.contentUri
            else current.coverUri,
        )
        folders.value = folders.value.map { if (it.id == folderId) updated else it }
        debugLog(
            "optimisticApply: ${row.name} folder=$folderId " +
                "coverSwapped=${updated.coverUri != current.coverUri}",
        )
    }
}

/**
 * 总览卡片就地刷新（删除/移动/重命名的即时收尾）：重跑 `list_folders` 聚合。
 *
 * 删除后卡片为什么不动的根因：封面/计数/时间戳都来自 [folders] 快照，而快照只有
 * 全量对账才重算；更要命的是索引里被删文件的行还在（对账是快照语义，陈行下次
 * 对账才清）——所以删除后不光卡片旧，连计数都还没减。这里先摘旧行（见
 * [deleteIndexEntries] 调用点）再重算：聚合子查询有 (parent_id, file_type,
 * modified_at) 复合索引覆盖，全量约百毫秒（老机），比等 1s 防抖 + 2.4s 扫描快
 * 一个量级。与对账幂等（对账稍后以权威数据覆盖同一结果）。
 */
internal suspend fun GalleryViewModel.refreshFolderCards(force: Boolean = false) {
    val now = android.os.SystemClock.elapsedRealtime()
    if (!force && now - lastFolderCardsRefreshAt < 500) return
    lastFolderCardsRefreshAt = now
    val refreshed = withContext(Dispatchers.IO) { orderFoldersForOverview(listFolders()) }
    // 桥接合并：改名后到对账建好新 Folder 行之前，索引里查不到改名后的卡片——
    // 不补回会出现「改名后卡片消失好一会才回来」（2026-11-18 用户实测）
    folders.value = mergeRenameBridge(refreshed)
    debugLog("refreshFolderCards: n=${folders.value.size}")
}
