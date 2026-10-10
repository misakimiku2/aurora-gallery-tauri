package com.aurora.gallery.kotlin

import android.util.Log
import androidx.lifecycle.viewModelScope
import com.aurora.gallery.kotlin.state.AppState
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import uniffi.aurora_core.FfiTopic
import uniffi.aurora_core.addFilesToTopic
import uniffi.aurora_core.addTagsToFiles
// 与成员函数 deleteTopic 同名：uniffi 顶层函数必须起别名，否则解析到本文件的扩展函数
import uniffi.aurora_core.deleteTopic as deleteTopicFfi
import uniffi.aurora_core.getAllTopics
import uniffi.aurora_core.getTopicFiles
import uniffi.aurora_core.listImagesByIds
import uniffi.aurora_core.removeFileFromTopic
import uniffi.aurora_core.upsertTopic
import java.util.UUID

// 2026-10-10 从 `GalleryViewModel.kt` 拆出（第 12 刀）：「标签 / 专题 CRUD」一簇整体搬到这里，
// 用**扩展函数**落（套路同 GalleryViewModelFileOps.kt——Kotlin 没有 partial class）。只搬 `fun`；
// 状态一律留在原类（tagGroups / topics / coverImagesById / appState …），本簇只读不持有——
// 扩展函数没有幕后字段，搬不出来。扩展函数体内访问 companion 成员要限定：GalleryViewModel.TAG。
/**
 * 批量粘贴标签（M4a 4.3 长按菜单的「粘贴标签」）：把应用内剪贴板
 * （[AppState.copiedTags]）里的标签合并进选中集每个文件——1.1 的批量原语
 * `add_tags_to_files` 单事务完成，已有成员不重复、新标签追加尾部。合并语义与
 * 桌面 `handlePasteTags`（`useTags.ts:83`）一致；落库成功才重算快照。
 */
fun GalleryViewModel.pasteTagsToFiles(fileIds: Set<String>, onDone: (Boolean) -> Unit = {}) {
    val tags = appState.copiedTags.toList()
    if (fileIds.isEmpty() || tags.isEmpty()) {
        onDone(false)
        return
    }
    this.viewModelScope.launch {
        val ok = withContext(Dispatchers.IO) {
            runCatching { addTagsToFiles(fileIds.toList(), tags) }
                .also {
                    if (it.isFailure) Log.w(GalleryViewModel.TAG, "[Edit] paste tags failed", it.exceptionOrNull())
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
fun GalleryViewModel.renameTopic(topic: FfiTopic, newName: String, onDone: (Boolean) -> Unit = {}) {
    val trimmed = newName.trim()
    if (trimmed.isEmpty()) {
        onDone(false)
        return
    }
    this.viewModelScope.launch {
        val ok = withContext(Dispatchers.IO) {
            runCatching {
                upsertTopic(topic.copy(name = trimmed, updatedAt = System.currentTimeMillis()))
            }.also {
                if (it.isFailure) Log.w(GalleryViewModel.TAG, "[Topics] rename failed", it.exceptionOrNull())
            }.isSuccess
        }
        if (ok) reloadTopics()
        onDone(ok)
    }
}

/**
 * 删除专题（M4a 4.3 长按菜单；桌面右键「删除」同位）。core 的 `delete_topic` 现在
 * 自己会**级联删整棵子树**（2026-09-29 起，桌面那边漏了这一步所以收进公共层），
 * 这里这段按 parentId 的预删因此变成兜底——重复删一个已不存在的 id 是 no-op，
 * 保留着不影响正确性。图片本身不受影响。删的是当前详情正打开的专题时，
 * 宿主负责把 activeTopicId 清掉回列表。
 */
fun GalleryViewModel.deleteTopic(topic: FfiTopic, onDone: (Boolean) -> Unit = {}) {
    this.viewModelScope.launch {
        val ok = withContext(Dispatchers.IO) {
            runCatching {
                getAllTopics().filter { it.parentId == topic.id }.forEach { child ->
                    deleteTopicFfi(child.id)
                }
                deleteTopicFfi(topic.id)
            }.also {
                if (it.isFailure) Log.w(GalleryViewModel.TAG, "[Topics] delete failed id=${topic.id}", it.exceptionOrNull())
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
fun GalleryViewModel.setTopicCover(topicId: String, fileId: String, onDone: (Boolean) -> Unit = {}) {
    this.viewModelScope.launch {
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
                if (it.isFailure) Log.w(GalleryViewModel.TAG, "[Topics] set cover failed", it.exceptionOrNull())
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
suspend fun GalleryViewModel.reloadTopics() {
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
        Log.i(GalleryViewModel.TAG, "[Topics] reload count=${list.size} covers=${coverImagesById.value.size}")
    } catch (e: Exception) {
        Log.w(GalleryViewModel.TAG, "[Topics] reload failed", e)
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
fun GalleryViewModel.createTopic(name: String, parentId: String? = null, onDone: (Boolean) -> Unit = {}) {
    val trimmed = name.trim()
    if (trimmed.isEmpty()) {
        onDone(false)
        return
    }
    this.viewModelScope.launch {
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
                if (it.isFailure) Log.w(GalleryViewModel.TAG, "[Topics] create failed", it.exceptionOrNull())
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
fun GalleryViewModel.addFilesToTopic(topicId: String, fileIds: Set<String>, onDone: (Boolean) -> Unit = {}) {
    if (fileIds.isEmpty()) {
        onDone(false)
        return
    }
    this.viewModelScope.launch {
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
                if (it.isFailure) Log.w(GalleryViewModel.TAG, "[Topics] addFiles failed", it.exceptionOrNull())
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
fun GalleryViewModel.removeFilesFromTopic(topicId: String, fileIds: Set<String>, onDone: (Boolean) -> Unit = {}) {
    if (fileIds.isEmpty()) {
        onDone(false)
        return
    }
    this.viewModelScope.launch {
        val ok = withContext(Dispatchers.IO) {
            var success = 0
            for (id in fileIds) {
                try {
                    removeFileFromTopic(topicId, id)
                    success++
                } catch (e: Exception) {
                    Log.w(GalleryViewModel.TAG, "[Topics] removeFile failed id=$id", e)
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
                    Log.w(GalleryViewModel.TAG, "[Topics] cover re-point failed", e)
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
