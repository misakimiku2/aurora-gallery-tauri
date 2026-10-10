package com.aurora.gallery.kotlin

import android.content.ContentUris
import android.content.ContentValues
import android.os.Build
import android.provider.MediaStore
import android.util.Log
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import uniffi.aurora_core.generateId
import uniffi.aurora_core.listImages
import uniffi.aurora_core.upsertMediaImage

// 2026-10-10 从 `GalleryViewModel.kt` 拆出：文件操作这一簇（MediaStore 写原语）整体搬到这里，
// 用**扩展函数**落（套路同 GalleryViewModelPeople.kt——Kotlin 没有 partial class）。只搬 `fun`；
// 状态字段（deleteConsentFallback / bucketRelPathCache）与原类私有助手留在原类，被本簇用到的
// 助手在原类里降为 internal。扩展函数体内访问 companion 成员要限定（GalleryViewModel.TAG）。

// ===== M4b 1.1 本地库文件操作（MediaStore 写原语）=====
//
// 与桌面 file_operations.rs 不同源（那边是文件系统语义 + 路径哈希迁移元数据；这边
// 是 MediaStore 行操作），实现不互抄。三个原语都收 **content uri**（UI 边界把
// file id 解析成 uri 只做一次，写授权也要用同一批 uri），公共纪律：
//  - **先改后授权**（2026-09-28 改，用户要求「编辑直接生效，不弹系统窗」）：一律先
//    直接 update/delete；只有系统抛 RecoverableSecurityException 的行（非本应用创建
//    且未授权过）才交给宿主弹一次批量授权、允许后重试那几行。App 自有/已授权过的行
//    全程零弹窗，且授权是持久的——同一行只会弹一次。复制是 insert 新行（App 拥有
//    新行），本来就不要授权；
//  - 重命名/移动只改 MediaStore 行的 DISPLAY_NAME/RELATIVE_PATH，_id 与 content_uri
//    不变 → file_id 不变 → 元数据自然还挂着（规划五要点②），不写任何迁移代码；
//  - 全部 Dispatchers.IO + 逐条 try/catch（成功多少算多少，被系统拦下的不算失败）；
//  - 完成后主动 scanAndReconcile + reloadImages：observer 的 1s 防抖会兜底，但主动
//    触发让 UI 即时反映，不赌时序（五要点③「UI 不能等下次扫描才变」）。

/**
 * 系统要求用户授权才能改这一行（API 29+ 的 RecoverableSecurityException）。
 *
 * 判定走类名字符串而非 `e is RecoverableSecurityException`：minSdk 24，直接引用该类
 * 在旧设备上一旦执行到判定指令就会 NoClassDefFoundError（SDK 守卫只能保证不执行到，
 * 字符串判定连这层依赖都不留）。
 */
internal fun GalleryViewModel.isWriteConsentRequired(e: Throwable): Boolean =
    Build.VERSION.SDK_INT >= 29 &&
        e.javaClass.name == "android.app.RecoverableSecurityException"

/** 逐个执行 [write]：成功的收进 okItems，被系统拦下的收进 blocked（不计失败）。IO 线程调用。 */
internal fun <T> GalleryViewModel.runWriteBatch(
    items: List<T>,
    uriOf: (T) -> android.net.Uri,
    write: (T) -> Boolean,
): Pair<List<T>, List<T>> {
    val okItems = ArrayList<T>()
    val blocked = ArrayList<T>()
    for (item in items) {
        try {
            if (write(item)) okItems += item
        } catch (e: Exception) {
            if (isWriteConsentRequired(e)) {
                Log.i(GalleryViewModel.TAG, "[FileOp] system consent required: ${uriOf(item)}")
                blocked += item
            } else {
                Log.w(GalleryViewModel.TAG, "[FileOp] write failed: ${uriOf(item)}", e)
            }
        }
    }
    return okItems to blocked
}

/**
 * 三个原语共用的「先改后授权」流程：先直写一批 → 全过就结束（[onDone] 一次）；
 * 有被拦下的则把「被拦的 uri + 重试闭包」交给 [onBlocked]（宿主决定弹窗），授权后
 * 只重试这批并把两次计数合并回 [onDone]——成功的那批不重复执行。
 *
 * [onDone] 因此**在整批最终结束后才回调一次**（Toast 只弹一次）。宿主若不打算请求
 * 授权（如 API < 30 的删除没有对应 API），不要调 retry，自行收尾。
 *
 * 体感（2026-10-07 荣耀真机）：26k 行的全量对账要 ~4s，UI 不能等它——写完先
 * [optimistic] 更新内存网格、立刻 [onDone]，对账挪进后台协程（[refreshAfterWriteAsync]，
 * MediaStore observer 防抖兜底也在）；对账完成后的 reloadImages 会用权威数据覆盖
 * 乐观结果，两者幂等。
 */
internal suspend fun <T> GalleryViewModel.writeWithConsentFallback(
    items: List<T>,
    uriOf: (T) -> android.net.Uri,
    write: (T) -> Boolean,
    onDone: (Int) -> Unit,
    onBlocked: (List<android.net.Uri>, retry: () -> Unit) -> Unit,
    optimistic: (List<T>) -> Unit = {},
) {
    val first = withContext(Dispatchers.IO) { runWriteBatch(items, uriOf, write) }
    val okItems = first.first
    val blocked = first.second
    debugLog("writeBatch ok=${okItems.size} blocked=${blocked.size}/${items.size}")
    if (blocked.isEmpty()) {
        optimistic(okItems)
        refreshAfterWriteAsync()
        onDone(okItems.size)
        return
    }
    onBlocked(blocked.map(uriOf)) {
        viewModelScope.launch {
            val retried = withContext(Dispatchers.IO) { runWriteBatch(blocked, uriOf, write) }
            val retriedOk = retried.first
            if (retried.second.isNotEmpty()) {
                Log.w(GalleryViewModel.TAG, "[FileOp] ${retried.second.size} item(s) still blocked after consent")
            }
            if (retriedOk.isNotEmpty()) optimistic(retriedOk)
            refreshAfterWriteAsync()
            onDone(okItems.size + retriedOk.size)
        }
    }
}

/** 选中集上下文菜单/查看器共用：把文件 id 解析成 content uri（读索引，不挑当前视图）。 */
fun GalleryViewModel.resolveFileUris(fileIds: Collection<String>, onReady: (List<android.net.Uri>) -> Unit) {
    viewModelScope.launch {
        val uris = resolveUris(fileIds).map { it.second }
        debugLog("resolveFileUris ids=$fileIds -> ${uris.size} uris")
        onReady(uris)
    }
}

/**
 * 选中集（图片和/或总览的文件夹卡片）展开成**图片 id 列表**（M4b 1.4 复制/移动的
 * 前置；文件夹读库展开，与 [resolveSelectionUris] 同源同语义）。
 */
fun GalleryViewModel.resolveSelectionFileIds(ids: Set<String>, onReady: (List<String>) -> Unit) {
    viewModelScope.launch {
        val out = withContext(Dispatchers.IO) {
            val folderById = folders.value.associateBy { it.id }
            val out = ArrayList<String>(ids.size)
            for (id in ids) {
                if (folderById.containsKey(id)) {
                    listImages(id).forEach { out += it.id }
                } else {
                    out += id
                }
            }
            out
        }
        onReady(out)
    }
}

/**
 * 重命名（改 DISPLAY_NAME）。[targets] = (uri, 新名)。
 *
 * **直接 update MediaStore 行**（慢图浏览同款体验，2026-09-28 终版）：App 自有/
 * 已授权过的行直接改成功；非本应用创建的行被系统拦下（华为不认 MANAGE_MEDIA）
 * 时，把被拦的 uri 交给 [onBlocked]——宿主发一次 `MediaStore.createWriteRequest`
 * 申请，用户同意后 retry 直写成功。**授权是持久的**：同一行只弹一次，之后永久
 * 直写。曾经试过「换名复制+删源」绕过弹窗（全静默），验收后否决：行为不直观、
 * file_id 变化、非标准目录（Huawei Share/ 等）失败，且源删除回执不可靠会造成
 * 「报失败但实际成功」的假失败。`_id` 不变 → file_id 不变 → 元数据自然挂着
 * （规划五要点②），不需要任何迁移。
 */
fun GalleryViewModel.renameFiles(
    targets: List<Pair<android.net.Uri, String>>,
    onDone: (Int) -> Unit = {},
    onBlocked: (List<android.net.Uri>, retry: () -> Unit) -> Unit = { _, _ -> },
) {
    if (targets.isEmpty()) {
        onDone(0)
        return
    }
    viewModelScope.launch {
        writeWithConsentFallback(
            items = targets,
            uriOf = { it.first },
            write = { (uri, newName) ->
                val values = ContentValues().apply {
                    put(MediaStore.Images.Media.DISPLAY_NAME, newName)
                }
                // 华为 Q 的 update 白名单对 legacy 没豁免：标准目录 MediaStore 成功
                // （保 _id），被拒（白名单外）再走 Q 传统视图的文件路径直写
                val mediaOk = try {
                    appContext.contentResolver.update(uri, values, null, null).also {
                        if (it <= 0) Log.w(GalleryViewModel.TAG, "[FileOp] update returned $it, fallback to file: $uri")
                    } > 0
                } catch (e: Exception) {
                    if (isWriteConsentRequired(e)) throw e
                    Log.w(GalleryViewModel.TAG, "[FileOp] update threw, fallback to file: $uri", e)
                    false
                }
                mediaOk || legacyRenameViaFile(uri, newName)
            },
            onDone = { n ->
                Log.i(GalleryViewModel.TAG, "[FileOp] renamed=$n/${targets.size}")
                onDone(n)
            },
            onBlocked = onBlocked,
            optimistic = { okItems -> optimisticRenameInGrid(okItems) },
        )
    }
}

/**
 * 移动到目标相册（改 RELATIVE_PATH 跨 bucket）。[targetRelPath] 由宿主解析好传入
 * （既有相册的 RELATIVE_PATH 或新相册的 `Pictures/<名字>`，见 resolveFolderRelPath /
 * MainActivity 的新建相册分支）。与 [renameFiles] 同款：直写 + 被拦时经 [onBlocked]
 * 走 createWriteRequest 申请（授权持久），不复制不删源。
 *
 * 收尾：成功 n>0 时先把移动的行按 MediaStore 现值 upsert 一遍（索引里的归属才跟得上
 * 这次跨 bucket，否则卡片要等全量对账才变），再重算总览卡片并 bump 涉及的文件夹活动
 * 时间，与 Q 路径移动（[GalleryViewModelQPaths.registerRowAndMigrateAsync]）一致 ——
 * 「操作过就排前面」的排序语义对移动同样成立。
 */
fun GalleryViewModel.moveFiles(
    uris: List<android.net.Uri>,
    targetRelPath: String,
    onDone: (Int) -> Unit = {},
    onBlocked: (List<android.net.Uri>, retry: () -> Unit) -> Unit = { _, _ -> },
) {
    if (uris.isEmpty()) {
        onDone(0)
        return
    }
    val relPath = targetRelPath.ensureTrailingSlash()
    viewModelScope.launch {
        // 「操作过就排前面」的卡片基准快照：[bumpActivityForChangedFolders] 拿它与写后
        // 重算的卡片做 diff（移动使源计数减、目标计数加，双端都命中）来挑该 bump 的
        // 文件夹——所以必须在写之前抓。
        val beforeFolders = folders.value
        writeWithConsentFallback(
            items = uris,
            uriOf = { it },
            write = write@{ uri ->
                val values = ContentValues()
                if (Build.VERSION.SDK_INT >= 29) {
                    values.put(MediaStore.Images.Media.RELATIVE_PATH, relPath)
                } else {
                    // API < 29 没有 RELATIVE_PATH 列：按旧语义直接改 DATA 全路径
                    val name = queryDisplayName(uri) ?: return@write false
                    values.put(MediaStore.Images.Media.DATA, legacyDataPath(relPath, name))
                }
                // 与 renameFiles 同款：MediaStore 被华为 Q 白名单拒绝时走文件路径直写
                val mediaOk = try {
                    appContext.contentResolver.update(uri, values, null, null).also {
                        if (it <= 0) Log.w(GalleryViewModel.TAG, "[FileOp] update returned $it, fallback to file: $uri")
                    } > 0
                } catch (e: Exception) {
                    if (isWriteConsentRequired(e)) throw e
                    Log.w(GalleryViewModel.TAG, "[FileOp] update threw, fallback to file: $uri", e)
                    false
                }
                mediaOk || legacyMoveViaFile(uri, relPath)
            },
            onDone = { n ->
                Log.i(GalleryViewModel.TAG, "[FileOp] moved=$n/${uris.size} -> $relPath")
                if (n > 0) {
                    // 与 Q 路径移动的收尾同款（GalleryViewModelQPaths.registerRowAndMigrateAsync
                    // 的 deleteSource 分支）：把涉及的文件夹活动时间刷为当前，让「操作过就排
                    // 前面」对移动同样成立。补上前只有删除 / 复制 / Q 路径移动三条写路径会
                    // bump，MediaStore 直写的移动（R+ 主路径）缺这一步——自 3a0effd77 上线起
                    // 就有，后果是移动后目标文件夹不会被顶到排序前面。
                    viewModelScope.launch {
                        // 移动改的是行的**归属**，而索引里这条行仍挂在旧 parent_id 上（要等
                        // 下一次全量对账才刷新）——不先修正，list_folders 算出的聚合与写前
                        // 一致，下面的 diff 挑不出任何变化、bump 空转。这里照 registerRow 的
                        // 做法按 MediaStore 现值单行 upsert：移动前后 _id 与 content_uri 不变
                        // （file_id 由 content_uri 算出），所以是覆盖同一行，不留重复行。
                        withContext(Dispatchers.IO) {
                            for (uri in uris) {
                                val img = runCatching { mediaImageOf(uri) }.getOrNull() ?: continue
                                runCatching { upsertMediaImage(img) }
                                    .onFailure {
                                        Log.w(
                                            GalleryViewModel.TAG,
                                            "[FileOp] single-row upsert after move failed: $uri",
                                            it,
                                        )
                                    }
                            }
                        }
                        // force=true 同删除路径：走防抖会跳过重算，那样 diff 还是拿不到新卡片
                        refreshFolderCards(force = true)
                        bumpActivityForChangedFolders(beforeFolders)
                    }
                }
                onDone(n)
            },
            onBlocked = onBlocked,
            optimistic = { okItems -> optimisticRemoveFromGrid(okItems) },
        )
    }
}

/**
 * 复制到目标相册（insert 新行 + 字节流拷贝 + **元数据/标签搬运**）。不需要写授权
 * （App 拥有新行，只要读权限）。
 *
 * 搬运（M4b 1.2 方案 A，规划五要点④「副本带着原标签」）：新 uri 经 FFI `generateId`
 * 算出新 file_id（与扫描对账同一纯函数，必然同值），源行的 file_metadata 读出后
 * copy 成新行、源标签 `setFileTags` 写到新 id。顺序安全性：此时副本行已在 MediaStore，
 * 写后的对账（[refreshAfterWrite]）会把新 id 纳入 file_index——先写的元数据/标签
 * 不会被当孤儿清掉。
 */
fun GalleryViewModel.copyFiles(uris: List<android.net.Uri>, targetRelPath: String, onDone: (Int) -> Unit = {}) {
    if (uris.isEmpty()) {
        onDone(0)
        return
    }
    val relPath = targetRelPath.ensureTrailingSlash()
    debugLog("copyFiles: begin target=$relPath count=${uris.size}")
    viewModelScope.launch {
        val okCount = withContext(Dispatchers.IO) {
            var count = 0
            for (source in uris) {
                try {
                    if (copyOneWithMetadata(source, relPath)) count++
                } catch (e: Exception) {
                    Log.w(GalleryViewModel.TAG, "[FileOp] copy failed $source -> $relPath", e)
                }
            }
            count
        }
        Log.i(GalleryViewModel.TAG, "[FileOp] copied=$okCount/${uris.size} -> $relPath")
        debugLog("copyFiles: done ok=$okCount/${uris.size} -> $relPath")
        // 与删除/移动同款：onDone 不等对账（副本进当前网格的显示交给后台对账——
        // 拿不到「目标 = 当前文件夹」的可靠判定，不做乐观插入）
        refreshAfterWriteAsync()
        onDone(okCount)
    }
}

/**
 * 单文件复制原语：insert 新行（[overrideName] 覆盖名字，改名即「换名复制」）+
 * 字节流拷贝 + 元数据/标签搬运。返回成功与否。
 *
 * 流拷贝失败时回收刚 insert 的行（App 自有行可直接删）——不回收会留 0 字节孤儿，
 * 对账把它当真文件抬进索引（真机踩过）。元数据/标签搬运失败只记日志，不回滚。
 *
 * 华为 Q 的 insert 白名单（allowed [DCIM, Pictures]）对 legacy 没豁免：白名单内走
 * MediaStore insert（新 uri 即刻可用，元数据同步搬）；被拒走 Q 传统视图文件路径
 * 复制——**副本落盘即成功**，行登记 + 元数据搬运交给 [registerRowAndMigrateAsync]
 * 后台（EMUI 扫描回调对非标准目录能迟到几十秒，同步等会让「已复制」姗姗来迟）。
 */
internal fun GalleryViewModel.copyOneWithMetadata(
    source: android.net.Uri,
    relPath: String,
    overrideName: String? = null,
): Boolean {
    val uri = try {
        insertImageCopy(source, relPath, overrideName)
    } catch (e: Exception) {
        Log.w(GalleryViewModel.TAG, "[FileOp] insert rejected, fallback to file: $source", e)
        debugLog("copyOne: insert rejected, fallback to file: $e")
        null
    }
    if (uri == null) {
        // insert 抛异常（华为 Q 白名单拒绝非标准目录）**或返回 null**（华为对部分
        // insert 不抛异常直接回 null——2026-10-07 真机 webp 源复制 4/4 死在这里，
        // 旧码只兜异常不兜 null）都走 Q 传统视图文件复制：副本落盘即成功。
        debugLog("copyOne: insert null, fallback to file: $source -> $relPath")
        val dst = legacyCopyToDir(source, relPath, overrideName) ?: return false
        // deleteSource=false：复制的 srcUri 是用户的原图，删了就是「复制变移动」
        // optimisticInsertIntoView=true：副本行入库后就地插进目标文件夹视图 +
        // 总览卡片（桌面同款「扫完即插」，见 [optimisticApplyCopiedRow]）
        registerRowAndMigrateAsync(
            source, dst, includeTopic = false, deleteSource = false,
            optimisticInsertIntoView = true,
        )
        return true
    }
    try {
        appContext.contentResolver.openInputStream(source)?.use { input ->
            appContext.contentResolver.openOutputStream(uri)?.use { output ->
                input.copyTo(output)
            } ?: throw IllegalStateException("openOutputStream failed: $uri")
        } ?: throw IllegalStateException("openInputStream failed: $source")
    } catch (e: Exception) {
        debugLog("copyOne stream failed $source -> $uri: $e")
        Log.w(GalleryViewModel.TAG, "[FileOp] copy stream failed $source -> $uri", e)
        runCatching { appContext.contentResolver.delete(uri, null, null) }
        return false
    }
    // uri 必须重导成扫描管道同款规范形式：insert 返回的是 external_primary 形式，
    // 与 scanMediaStore 拼的 external 形式指向同一行但字符串不同 → generateId 哈希
    // 不同 → 元数据写到索引永远对不上的孤儿 id 上（本轮实测踩过）。元数据/标签搬运
    // 与 copyFiles 同语义（不含专题——副本不自动加入源文件的专题）。
    val canonicalUri = runCatching {
        ContentUris.withAppendedId(
            MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
            ContentUris.parseId(uri),
        )
    }.getOrNull()
    if (canonicalUri != null) {
        runCatching { migrateMetadataAndTagsToNewUri(source, canonicalUri, includeTopic = false) }
            .onFailure { Log.w(GalleryViewModel.TAG, "[FileOp] metadata copy failed $source -> $uri", it) }
        // 与 legacy 分支同口径：新行立即增量 upsert 进索引 + 「扫完即插」进当前
        // 视图（目标文件夹随后打开即时可见，正停着则原地出现；都不必等全量对账）
        runCatching {
            mediaImageOf(canonicalUri)?.let {
                upsertMediaImage(it)
                optimisticApplyCopiedRow(it)
            }
        }.onFailure { Log.w(GalleryViewModel.TAG, "[FileOp] single-row upsert failed: $canonicalUri", it) }
    }
    return true
}

/**
 * 既有相册的 folder_id → RELATIVE_PATH（移动/复制的目标值）。folder.id =
 * generate_id(bucket_id)（Rust 对账同款）。
 *
 * 首选本地索引：[folders] 快照里 Folder.path 就是该 bucket 的绝对目录（索引 Folder
 * 行的 path 列），换个前缀即 RELATIVE_PATH——零成本。旧码全量遍历 MediaStore 的
 * (BUCKET_ID, RELATIVE_PATH) 反查，2.6 万行老机繁忙时实测 4.9s，选完目标要干等
 * 这么久才动工（2026-10-07 真机报障「等了很久才出现复制成功通知」）。快照未命中
 * （理论上的瞬时态）才落 MediaStore 遍历兜底；空相册按 1.3 懒创建语义本就不存在，
 * 查不到返回 null 由调用方提示。
 */
fun GalleryViewModel.resolveFolderRelPath(folderId: String, onReady: (String?) -> Unit) {
    debugLog("resolveFolderRelPath: begin $folderId")
    viewModelScope.launch {
        // folders 是 Compose state，主线程读（与 saveFileUpdates 读 images.value 同规矩）
        val fromIndex = folders.value.firstOrNull { it.id == folderId }?.path
            ?.let { folderAbsPathToRelPath(it) }
        val relPath = fromIndex ?: withContext(Dispatchers.IO) {
            bucketRelPathCache?.get(folderId) ?: run {
                val map = HashMap<String, String>()
                var hit: String? = null
                appContext.contentResolver.query(
                    MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
                    arrayOf(
                        MediaStore.Images.Media.BUCKET_ID,
                        MediaStore.Images.Media.RELATIVE_PATH,
                    ),
                    null, null, null,
                )?.use { c ->
                    val bucketCol = c.getColumnIndexOrThrow(MediaStore.Images.Media.BUCKET_ID)
                    val relCol = c.getColumnIndexOrThrow(MediaStore.Images.Media.RELATIVE_PATH)
                    while (c.moveToNext()) {
                        val bucketId = c.getLong(bucketCol).toString()
                        val rp = c.getString(relCol)
                        map[bucketId] = rp
                        if (generateId(bucketId) == folderId) hit = rp
                    }
                }
                bucketRelPathCache = map
                hit
            }
        }
        debugLog("resolveFolderRelPath: done $folderId -> $relPath")
        onReady(relPath)
    }
}

/** 索引 Folder.path（绝对目录，如 /storage/emulated/0/Pictures/X）→ 复制/移动用的
 *  RELATIVE_PATH 语义（Pictures/X/）。根目录（路径即外部存储根）映射成 "/"（与
 *  MediaStore RELATIVE_PATH 一致）。不在外部存储根下（理论上不可达）返回 null，
 *  由调用方走 MediaStore 遍历兜底。 */
internal fun GalleryViewModel.folderAbsPathToRelPath(absPath: String): String? {
    val root = android.os.Environment.getExternalStorageDirectory().absolutePath
    val rel = when {
        absPath == root -> "/"
        absPath.startsWith("$root/") -> absPath.removePrefix("$root/")
        else -> return null
    }
    return rel.ensureTrailingSlash()
}

/** 逐条写操作后的主动刷新——**后台跑**：乐观更新已让 UI 即时反映，副本/新路径的
 *  单行 upsert 已让网格即时可见；全量对账（26k 行约 2.4s，老机）合并进
 *  [scheduleHotRefresh] 的防抖窗口，一次写操作只跑一次（旧码立即起跑 + 观察者
 *  防抖各一次，串成 3 次全量扫描把 UI 拖卡）。 */
internal fun GalleryViewModel.refreshAfterWriteAsync() {
    scheduleHotRefresh()
}

// 从原类的成员扩展搬来：顶层扩展函数没有 dispatch receiver，成员扩展 String.ensureTrailingSlash()
// 在扩展函数体里调不到，只能一起落到顶层（只被本簇用）。
internal fun String.ensureTrailingSlash(): String =
    if (isEmpty() || endsWith('/')) this else "$this/"
