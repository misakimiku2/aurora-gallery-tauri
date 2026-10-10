package com.aurora.gallery.kotlin

import android.util.Log
import androidx.lifecycle.viewModelScope
import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import uniffi.aurora_core.Image
import uniffi.aurora_core.setFileTags
import uniffi.aurora_core.upsertTopic

// 2026-10-10 从 `GalleryViewModel.kt` 拆出：M6a 阶段 5（在线元数据 / 人物 / 专题）与阶段 6
// （互联态文件操作）两簇整体搬到这里，用**扩展函数**落（套路同 GalleryViewModelPeople.kt /
// GalleryViewModelFileOps.kt / GalleryViewModelQPaths.kt / GalleryViewModelColors.kt /
// GalleryViewModelAiTasks.kt / GalleryViewModelLanBrowse.kt——Kotlin 没有 partial class）。
//
// 只搬 `fun`（11 个：saveLanFileUpdates / createLanTopic / deleteLanTopic /
// addSelectionToLanTopic / renameLanPerson / browseLanPath / renameLanFile / deleteLanFiles /
// moveLanFiles / copyLanFiles / batchLanFileOp）。两簇的会话态在阶段 4/5 的缓存区（原类），
// 本文件只读写；被本簇用到的 LAN 扩展（reloadLanPeople / reloadLanTopics /
// rebuildLanRemoteTagGroups / refreshLanFolder 等）已在第 8 刀落 internal，故本刀**无需再降权**。
//
// 本簇无 object 表达式，不需要第 6、7 刀那套 `val vm = this` 捕获。

// ===== M6a 阶段 5：在线元数据 / 人物 / 专题（写路径走 LanClient）=====
//
// 契约 §6：客户端不监听桌面 data-changed 事件，写操作成功后以**响应条目**做本地乐观
// 更新 + 对应列表重拉。D31 数据层铁律落点：以下函数**绝不**触本地库/本地词表/本地
// 过滤——不调 saveFileUpdates / upsertTopic / setFileTags / reloadTagState /
// reloadTopics 等任何本地写路径；远端词表的新词只进 lanMetaByPath / lanRemoteTagGroups
// 内存缓存，桌面词表由服务端自行维护。

/**
 * 保存远端文件元数据（标签/描述/来源网址；契约 §2.2 整行读改写）。[tags] null =
 * 不改、空列表 = 显式清空（[LanMetadataPatch] 同义）；[description]/[sourceUrl]
 * null = 不改；[sourceUrls] 是来源网址**全集**（多值，整体覆盖，空列表 = 清空），
 * 给了它就以它为准。成功：响应条目整行覆盖 [lanMetaByPath] 并重算 [lanRemoteTagGroups]
 * （乐观更新，不重拉全量）；失败（含 401/403/网络）：Log.w + onDone(false)，缓存不动。
 */
internal fun GalleryViewModel.saveLanFileUpdates(
    path: String,
    tags: List<String>? = null,
    description: String? = null,
    sourceUrl: String? = null,
    sourceUrls: List<String>? = null,
    onDone: (Boolean) -> Unit = {},
) {
    val session = lan.currentSession()
    if (session == null) {
        onDone(false)
        return
    }
    viewModelScope.launch {
        val result = withContext(Dispatchers.IO) {
            runCatching {
                session.client.putMetadata(
                    session.base, session.token, path,
                    LanMetadataPatch(
                        tags = tags,
                        description = description,
                        sourceUrl = sourceUrl,
                        sourceUrls = sourceUrls,
                    ),
                )
            }
        }
        val updated = result.getOrNull() ?: run {
            Log.w(GalleryViewModel.TAG, "[Lan] 元数据保存失败 path 尾=…${path.takeLast(12)}：${result.exceptionOrNull()?.message}")
            onDone(false)
            return@launch
        }
        // 乐观更新：响应条目即服务端整行（以响应里的 path 为身份刷新，契约 §0）
        lanMetaByPath.value = lanMetaByPath.value + (updated.path to updated)
        rebuildLanRemoteTagGroups()
        Log.i(GalleryViewModel.TAG, "[Lan] 元数据已保存 path 尾=…${updated.path.takeLast(12)} tags=${updated.tags.size}")
        onDone(true)
    }
}

/**
 * 建远端专题（契约 §4.2；id 服务端生成，description 仅非 null 才带上）。成功后重拉
 * topics() 刷新 [lanTopics]（重拉失败保留旧列表），新建的 [LanTopic] 回给调用方
 * （进详情/提示用）；失败回 null。
 */
internal fun GalleryViewModel.createLanTopic(name: String, description: String? = null, onDone: (LanTopic?) -> Unit = {}) {
    val trimmed = name.trim()
    val session = lan.currentSession()
    if (trimmed.isEmpty() || session == null) {
        onDone(null)
        return
    }
    viewModelScope.launch {
        val result = withContext(Dispatchers.IO) {
            runCatching { session.client.createTopic(session.base, session.token, trimmed, description) }
        }
        val topic = result.getOrNull() ?: run {
            Log.w(GalleryViewModel.TAG, "[Lan] 建专题失败：${result.exceptionOrNull()?.message}")
            onDone(null)
            return@launch
        }
        reloadLanTopics(session)
        Log.i(GalleryViewModel.TAG, "[Lan] 专题已建 id=${topic.id}")
        onDone(topic)
    }
}

/**
 * 删远端专题（契约 §4.3，级联删成员关联、图片本身不受影响）。成功后重拉 topics()；
 * 404（专题不存在）与其余失败同口径：Log.w + onDone(false)。
 */
internal fun GalleryViewModel.deleteLanTopic(topicId: String, onDone: (Boolean) -> Unit = {}) {
    val session = lan.currentSession()
    if (session == null) {
        onDone(false)
        return
    }
    viewModelScope.launch {
        val result = withContext(Dispatchers.IO) {
            runCatching { session.client.deleteTopic(session.base, session.token, topicId) }
        }
        val ok = result.getOrNull()?.success == true
        if (!ok) {
            Log.w(
                GalleryViewModel.TAG,
                "[Lan] 删专题失败 id=$topicId：${result.exceptionOrNull()?.message ?: result.getOrNull()?.error}",
            )
            onDone(false)
            return@launch
        }
        reloadLanTopics(session)
        Log.i(GalleryViewModel.TAG, "[Lan] 专题已删 id=$topicId")
        onDone(true)
    }
}

/**
 * 把选中集（远端 path 列表）归入远端专题（契约 §4.4；本入口只加**文件**成员，
 * peopleIds 恒空——加人物成员阶段 6 再接）。[paths] 为空直接回 false（两数组都空
 * 是服务端 400）。成功后重拉 topics()（fileCount 才会新）。
 */
internal fun GalleryViewModel.addSelectionToLanTopic(topicId: String, paths: List<String>, onDone: (Boolean) -> Unit = {}) {
    if (paths.isEmpty()) {
        onDone(false)
        return
    }
    val session = lan.currentSession()
    if (session == null) {
        onDone(false)
        return
    }
    viewModelScope.launch {
        val result = withContext(Dispatchers.IO) {
            runCatching {
                session.client.addTopicMembers(session.base, session.token, topicId, paths, emptyList())
            }
        }
        val members = result.getOrNull()
        if (members?.success != true) {
            Log.w(GalleryViewModel.TAG, "[Lan] 归入专题失败 topic=$topicId：${result.exceptionOrNull()?.message ?: "success=false"}")
            onDone(false)
            return@launch
        }
        reloadLanTopics(session)
        Log.i(GalleryViewModel.TAG, "[Lan] 已归入专题 topic=$topicId fileCount=${members.fileCount}")
        onDone(true)
    }
}

/**
 * 重命名 / 换头像 / 改描述远端人物（契约 §3.2 整行读改写；三个可变字段任选，null =
 * 不改，[avatarPath] 是共享根相对 path——服务端内部换算 cover_file_id，客户端只碰
 * path）。404 = 人物不存在（服务端已删）、其余失败同口径：Log.w + onDone(false)。
 * 成功后重拉 people() 刷新 [lanPeople]（重拉失败保留旧列表）。
 */
internal fun GalleryViewModel.renameLanPerson(
    personId: String,
    name: String? = null,
    description: String? = null,
    avatarPath: String? = null,
    onDone: (Boolean) -> Unit = {},
) {
    val trimmedName = name?.trim()
    val session = lan.currentSession()
    if (session == null ||
        (trimmedName == null && description == null && avatarPath == null) ||
        trimmedName?.isEmpty() == true
    ) {
        onDone(false)
        return
    }
    viewModelScope.launch {
        val result = withContext(Dispatchers.IO) {
            runCatching {
                session.client.putPerson(session.base, session.token, personId, trimmedName, avatarPath, description)
            }
        }
        if (result.getOrNull() == null) {
            Log.w(GalleryViewModel.TAG, "[Lan] 人物更新失败 id=$personId：${result.exceptionOrNull()?.message}")
            onDone(false)
            return@launch
        }
        reloadLanPeople(session)
        Log.i(GalleryViewModel.TAG, "[Lan] 人物已更新 id=$personId")
        onDone(true)
    }
}

// ===== M6a 阶段 6：互联态文件操作（rename/delete/move/copy；写路径走 LanClient）=====
//
// 契约 §1/§5：客户端不监听桌面 data-changed 事件，写成功后以响应里的新 path/逐项
// 结果维护会话缓存（换 key / 移除 / 补最小条目）+ refreshLanFolder/refreshLanRoots
// 重拉。目录纪律同阶段 5：只动 lan* 内存缓存，绝不触本地库/本地词表（D31）。

/**
 * 一次性远端目录 browse（目录选择器等临时场景用）：**不改会话态与门禁位**——
 * [reloadLanImages] 的门禁同步是「当前浏览视图」语义，弹窗里的顺手 browse 不能动
 * 主界面的开关。[path] null/空串 = 共享根（服务端 handle_browse 对缺省/空串/`/` 同
 * 看待，unwrap_or_default 归零，空 `?path=` 即可）。失败（401/404/网络）回 null，
 * 调用方按「浏览不了」兜底。
 */
internal fun GalleryViewModel.browseLanPath(path: String?, onReady: (LanBrowseResult?) -> Unit) {
    val session = lan.currentSession()
    if (session == null) {
        onReady(null)
        return
    }
    viewModelScope.launch {
        val result = withContext(Dispatchers.IO) {
            runCatching { session.client.browse(session.base, session.token, path ?: "") }
        }
        result.getOrNull()?.let { onReady(it) } ?: run {
            Log.w(
                GalleryViewModel.TAG,
                "[Lan] 临时 browse 失败 path 尾=…${(path ?: "").takeLast(12)}：${result.exceptionOrNull()?.message}",
            )
            onReady(null)
        }
    }
}

/**
 * 同目录改名远端文件（契约 §1；[newName] 是裸文件名，目录由服务端拼）。403/404/409
 * 走异常（runCatching 接住），FS 级失败是 200+success:false——两种失败形态同回
 * onDone(false, null)，缓存不动。成功：lanRootImages/lanLibraryImages/lanMetaByPath
 * 以响应新 path **换 key**（path 是身份，旧 key 不换就是幽灵条目），再
 * refreshLanFolder（当前目录重拉）+ refreshLanRoots（总览/侧栏计数）。
 */
internal fun GalleryViewModel.renameLanFile(oldPath: String, newName: String, onDone: (ok: Boolean, newPath: String?) -> Unit) {
    val trimmed = newName.trim()
    val session = lan.currentSession()
    if (session == null || trimmed.isEmpty()) {
        onDone(false, null)
        return
    }
    viewModelScope.launch {
        val result = withContext(Dispatchers.IO) {
            runCatching { session.client.rename(session.base, session.token, oldPath, trimmed) }
        }
        val renamed = result.getOrNull() ?: run {
            Log.w(GalleryViewModel.TAG, "[Lan] 改名失败 path 尾=…${oldPath.takeLast(12)}：${result.exceptionOrNull()?.message}")
            onDone(false, null)
            return@launch
        }
        // 成功响应必带新 path；success=false 或缺新 path 都按失败处理——拿旧 path
        // 冒充新身份会把「换 key」做成自我污染
        val newPath = renamed.newPath
        if (!renamed.success || newPath == null) {
            Log.w(GalleryViewModel.TAG, "[Lan] 改名失败 path 尾=…${oldPath.takeLast(12)}：${renamed.error ?: "success=false"}")
            onDone(false, null)
            return@launch
        }
        // 换 key：列表按 path 定位替换；两个 map 保持原序换 key 重插（LinkedHashMap）
        lanRootImages.value = lanRootImages.value.map {
            if (it.path == oldPath) it.copy(path = newPath, name = trimmed) else it
        }
        val library = LinkedHashMap<String, LanRemoteImage>(lanLibraryImages.value.size)
        lanLibraryImages.value.forEach { (p, img) ->
            library[if (p == oldPath) newPath else p] =
                if (p == oldPath) img.copy(path = newPath, name = trimmed) else img
        }
        lanLibraryImages.value = library
        lanMetaByPath.value[oldPath]?.let { meta ->
            lanMetaByPath.value = lanMetaByPath.value - oldPath + (newPath to meta.copy(path = newPath))
        }
        Log.i(GalleryViewModel.TAG, "[Lan] 已改名 …${oldPath.takeLast(12)} → …${newPath.takeLast(12)}")
        refreshLanFolder()
        refreshLanRoots()
        onDone(true, newPath)
    }
}

/**
 * 批量删远端文件（契约 §1 `DELETE /api/file`）：逐个顺序删（上传同款「逐个而非并发」
 * 先例，进度可读、服务端压力小；单条失败不中断批次，失败明细进日志）。全部完成后把
 * **真正删掉的** path 从三份会话缓存移除（失败项留在原地，UI 还能看见、可重试），
 * 再 refreshLanFolder + refreshLanRoots。onDone 的 (ok, fail) 不等重拉完成。
 */
internal fun GalleryViewModel.deleteLanFiles(paths: List<String>, onDone: (ok: Int, fail: Int) -> Unit) {
    val session = lan.currentSession()
    if (session == null || paths.isEmpty()) {
        onDone(0, paths.size)
        return
    }
    viewModelScope.launch {
        var okCount = 0
        val failedPaths = mutableSetOf<String>()
        paths.forEach { path ->
            val result = withContext(Dispatchers.IO) {
                runCatching { session.client.deleteFile(session.base, session.token, path) }
            }
            val item = result.getOrNull()
            if (item?.success == true) {
                okCount++
            } else {
                failedPaths += path
                Log.w(
                    GalleryViewModel.TAG,
                    "[Lan] 删除失败 path 尾=…${path.takeLast(12)}：" +
                        "${result.exceptionOrNull()?.message ?: item?.error ?: "success=false"}",
                )
            }
        }
        if (okCount > 0) {
            val deleted = paths.toSet() - failedPaths
            lanRootImages.value = lanRootImages.value.filter { it.path !in deleted }
            lanLibraryImages.value = lanLibraryImages.value.filterKeys { it !in deleted }
            lanMetaByPath.value = lanMetaByPath.value.filterKeys { it !in deleted }
            Log.i(GalleryViewModel.TAG, "[Lan] 批量删除完成 ok=$okCount fail=${failedPaths.size}")
            refreshLanFolder()
            refreshLanRoots()
        } else {
            Log.w(GalleryViewModel.TAG, "[Lan] 批量删除全部失败（${paths.size} 项），缓存不动")
        }
        onDone(okCount, paths.size - okCount)
    }
}

/**
 * 批量移动远端文件进 [targetDir]（契约 §5.1）：一次 [LanClient.moveFiles]，items 与
 * paths 同序逐项落账——成功项旧 path 出三缓存、新 path 补最小条目；目标目录不存在
 * 是整批 404（HTTP 异常，全批未动）。
 */
internal fun GalleryViewModel.moveLanFiles(paths: List<String>, targetDir: String, onDone: (ok: Int, fail: Int, firstError: String?) -> Unit) {
    val session = lan.currentSession()
    if (session == null || paths.isEmpty()) {
        onDone(0, paths.size, null)
        return
    }
    batchLanFileOp(
        label = "移动",
        removeSource = true,
        paths = paths,
        targetDir = targetDir,
        session = session,
        request = { session.client.moveFiles(session.base, session.token, paths, targetDir) },
        onDone = onDone,
    )
}

/**
 * 批量复制远端文件进 [targetDir]（契约 §5.2）：与 [moveLanFiles] 同形，差异在缓存
 * 语义——旧条目**保留**（本体没动），新条目按响应 new_path（重名自动改名后的实际
 * 落盘路径）插入；副本元数据由服务端迁移，metadataBatch 回读即可带原 tags。
 */
internal fun GalleryViewModel.copyLanFiles(paths: List<String>, targetDir: String, onDone: (ok: Int, fail: Int, firstError: String?) -> Unit) {
    val session = lan.currentSession()
    if (session == null || paths.isEmpty()) {
        onDone(0, paths.size, null)
        return
    }
    batchLanFileOp(
        label = "复制",
        removeSource = false,
        paths = paths,
        targetDir = targetDir,
        session = session,
        request = { session.client.copyFiles(session.base, session.token, paths, targetDir) },
        onDone = onDone,
    )
}

/**
 * move/copy 的公共体：一次批量请求 → items 逐项落缓存（[removeSource] 区分 move 删
 * 旧 / copy 留旧）→ 新 path 元数据回读 upsert → 远端词表重算 → 刷新当前目录与总览。
 * HTTP 级失败（404 = 目标目录不存在、403 = 门禁关闭、401 = 会话失效）整批未动，
 * onDone(0, paths.size, message)；item 级失败（源不存在/目标已存在）只计 fail，
 * 首个错误随 onDone 回给调用方做提示。
 */
private fun GalleryViewModel.batchLanFileOp(
    label: String,
    removeSource: Boolean,
    paths: List<String>,
    targetDir: String,
    session: LanManager.LanSession,
    request: suspend () -> List<LanFileOpItem>,
    onDone: (ok: Int, fail: Int, firstError: String?) -> Unit,
) {
    viewModelScope.launch {
        val result = withContext(Dispatchers.IO) {
            runCatching { request() }
        }
        val items = result.getOrNull() ?: run {
            Log.w(
                GalleryViewModel.TAG,
                "[Lan] 批量${label}失败 target 尾=…${targetDir.takeLast(12)}：${result.exceptionOrNull()?.message}",
            )
            onDone(0, paths.size, result.exceptionOrNull()?.message)
            return@launch
        }
        var okCount = 0
        var firstError: String? = null
        val stalePaths = mutableSetOf<String>()
        val freshEntries = LinkedHashMap<String, LanRemoteImage>()
        items.forEach { item ->
            if (!item.success) {
                if (firstError == null) firstError = item.error
                return@forEach
            }
            val newPath = item.newPath ?: return@forEach // 契约成功项必带，防御不拦主流程
            okCount++
            if (removeSource) stalePaths += item.path
            // 最小条目的 size 从旧条目沿用；旧条目查不到（视频项/过期缓存）就不补——
            // 凭空造 size=0 的假条目，不如留给 refreshLanRoots 的全量重建兜底
            val old = lanLibraryImages.value[item.path]
                ?: lanRootImages.value.firstOrNull { it.path == item.path }
            if (old != null) {
                freshEntries[newPath] = LanRemoteImage(
                    name = newPath.substringAfterLast('/'),
                    path = newPath,
                    type = "image",
                    size = old.size,
                )
            }
        }
        if (removeSource && stalePaths.isNotEmpty()) {
            lanRootImages.value = lanRootImages.value.filter { it.path !in stalePaths }
            lanLibraryImages.value = lanLibraryImages.value.filterKeys { it !in stalePaths }
            lanMetaByPath.value = lanMetaByPath.value.filterKeys { it !in stalePaths }
        }
        if (freshEntries.isNotEmpty()) {
            lanLibraryImages.value = lanLibraryImages.value + freshEntries
            // 新位置元数据回读 upsert（move/copy 服务端都迁移元数据）：tag 筛选视图从
            // lanMetaByPath 取数，缺行 = 新位置从 tag 视图漏项
            val metaPaths = freshEntries.keys.toList()
            val meta = withContext(Dispatchers.IO) {
                runCatching { session.client.metadataBatch(session.base, session.token, metaPaths) }
            }
            meta.getOrNull()?.forEach { lanMetaByPath.value = lanMetaByPath.value + (it.path to it) }
                ?: Log.w(GalleryViewModel.TAG, "[Lan] ${label}后元数据回读失败（${metaPaths.size} 项），tag 视图暂缺待重连补齐")
            // 新元数据可能带来新词/新计数，远端词表分组跟着重算（纯函数，只动内存）
            rebuildLanRemoteTagGroups()
        }
        Log.i(
            GalleryViewModel.TAG,
            "[Lan] 批量${label}完成 ok=$okCount fail=${items.size - okCount} target 尾=…${targetDir.takeLast(12)}",
        )
        refreshLanFolder()
        refreshLanRoots()
        onDone(okCount, items.size - okCount, firstError)
    }
}
