package com.aurora.gallery.kotlin

import android.net.Uri
import android.util.Log
import androidx.lifecycle.viewModelScope
import com.aurora.gallery.kotlin.state.toAiConfig
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import uniffi.aurora_core.AiInputItem
import uniffi.aurora_core.AiRenameCallback
import uniffi.aurora_core.AiRenameItem
import uniffi.aurora_core.AiTaskCallback
import uniffi.aurora_core.Image
import uniffi.aurora_core.SearchItem
import uniffi.aurora_core.aiAnalyzeFiles
import uniffi.aurora_core.aiApplySearchFilter
import uniffi.aurora_core.aiCancelTask
import uniffi.aurora_core.aiGenerateFileNames
import uniffi.aurora_core.aiRewriteSearchQuery
import uniffi.aurora_core.getAllFileMetadata
import uniffi.aurora_core.getAllFileTags
import uniffi.aurora_core.listImages
import uniffi.aurora_core.listImagesByIds

// 2026-10-10 从 `GalleryViewModel.kt` 拆出：M6b 阶段 2 AI 任务层这一簇（分析/改名/搜索的
// 编排入口与私有助手）整体搬到这里，用**扩展函数**落（套路同 GalleryViewModelPeople.kt /
// GalleryViewModelFileOps.kt / GalleryViewModelQPaths.kt / GalleryViewModelColors.kt
// ——Kotlin 没有 partial class）。
//
// 只搬 `fun`。状态全部留在原类：嵌套 data class（AiTaskState，外部按
// GalleryViewModel.AiTaskState 引用，本文件要写限定名）、5 个对外 Compose 状态与 2 个私有
// 字段（aiJob / wd14Cancelled）——扩展函数没有幕后字段，状态搬不出来。aiJob 与
// wd14Cancelled 还被 LAN 侧 startWd14PersonPipeline 用到，故在原类降为 internal。
//
// ⚠️ `object : AiTaskCallback` / `object : AiRenameCallback` 内部**拿不到扩展接收者**
// （object 表达式不继承外层扩展函数的隐式接收者，lambda 才继承），两个入口各自先
// `val vm = this` 捕获，回调体一律 `vm.xxx`。

// —— M6b 阶段 2：AI 任务层（编排/取消/搜索改写在 core ai_task，本层=状态+入口+落库后刷新）——

/** AI 搜索态整体清理（关开关/清搜索词共用）。 */
internal fun GalleryViewModel.clearAiSearch() {
    aiSearchIds.value = null
    aiSearchResultImages.value = null
}

/** AI 搜索开关（持久化；关=清命中集回到普通文本过滤）。 */
internal fun GalleryViewModel.setAiSearchEnabled(enabled: Boolean) {
    settings.value = settings.value.copy(aiSearchEnabled = enabled)
    settingsStore.save(settings.value)
    if (!enabled) clearAiSearch()
}

/** AI 设置面板的逐项保存口（SettingsDialog 的 onAiSettingsChange 落点）。 */
internal fun GalleryViewModel.updateAiSettings(ai: com.aurora.gallery.kotlin.state.AiSettings) {
    settings.value = settings.value.copy(ai = ai)
    settingsStore.save(settings.value)
}

// internal 而非 private：颜色库簇已拆到 GalleryViewModelColors.kt（扩展函数）里要用
internal fun GalleryViewModel.aiToast(msg: String) {
    android.widget.Toast.makeText(appContext, msg, android.widget.Toast.LENGTH_SHORT).show()
}

/** 入口友好拦截（core 侧错误也能读，这里省一次网络往返）。 */
private fun GalleryViewModel.aiEndpointBlank(): Boolean {
    val ai = settings.value.ai
    return when (ai.provider) {
        "ollama" -> ai.ollamaEndpoint.isBlank()
        "lmstudio" -> ai.lmstudioEndpoint.isBlank()
        else -> ai.openaiEndpoint.isBlank()
    }
}

/**
 * 通知「取消」action 的落点：core 取消注册表置位，下一张迭代首查生效（在途一张跑完）。
 * M8b 阶段 3（遗留 #8）：WD14 人物管线（`lan-wd14-` 前缀）是 Kotlin 侧自管循环、
 * 不在 core 注册表里，分流到 [wd14Cancelled] 本地标志（同样下一张迭代首查生效）；
 * 其余前缀（ai-analyze 等）仍走 core 注册表，路径不变。
 */
internal fun GalleryViewModel.cancelAiTask() {
    val st = aiTaskState.value ?: return
    if (st.taskId.startsWith("lan-wd14")) {
        wd14Cancelled.set(true)
        return
    }
    runCatching { aiCancelTask(st.taskId) }
}

/** 批量 AI 分析（多选/文件夹/查看器单张共用入口）。完成后重算三快照+重拉当前视图。 */
internal fun GalleryViewModel.startAiAnalysis(fileIds: List<String>) {
    // object : AiTaskCallback / AiRenameCallback 内部拿不到扩展接收者（object 表达式不继承
    // 外层扩展函数的隐式接收者，lambda 才继承），先捕获成 vm 供回调体使用。
    val vm = this
    if (aiTaskState.value != null) {
        aiToast("AI 任务进行中，可从通知栏取消")
        return
    }
    if (fileIds.isEmpty()) return
    if (aiEndpointBlank()) {
        aiToast("请先在「设置 → AI 智能」配置服务地址")
        return
    }
    val cfg = settings.value.ai.toAiConfig(settings.value.language)
    aiJob = viewModelScope.launch {
        val taskId = "ai-analyze-${System.currentTimeMillis()}"
        val targets = withContext(Dispatchers.IO) { listImagesByIds(fileIds) }
        aiTaskState.value = GalleryViewModel.AiTaskState("AI 分析", taskId, 0, targets.size)
        scanNotifier.aiProgress("AI 分析", 0, targets.size)
        var failed = 0
        withContext(Dispatchers.IO) {
            aiAnalyzeFiles(
                cfg,
                targets.map { AiInputItem(fileId = it.id, path = it.contentUri, name = it.name) },
                taskId,
                object : AiTaskCallback {
                    override fun readBytes(fileId: String): ByteArray? = runCatching {
                        targets.firstOrNull { it.id == fileId }?.contentUri?.let { uri ->
                            vm.appContext.contentResolver.openInputStream(Uri.parse(uri))?.use { it.readBytes() }
                        }
                    }.getOrNull()

                    override fun onProgress(current: UInt, total: UInt) {
                        vm.aiTaskState.value = GalleryViewModel.AiTaskState("AI 分析", taskId, current.toInt(), total.toInt())
                        vm.scanNotifier.aiProgress("AI 分析", current.toInt(), total.toInt())
                    }

                    override fun onFileDone(fileId: String, ok: Boolean, note: String) {
                        if (!ok) {
                            failed++
                            Log.w(GalleryViewModel.TAG, "[Ai] analyze fail $fileId: $note")
                        }
                    }

                    override fun onFinished(state: String, message: String) {
                        vm.aiTaskState.value = null
                        vm.scanNotifier.aiDone(
                            when (state) {
                                "completed" -> if (failed == 0) "分析完成 $message" else "分析完成 $message（$failed 张失败）"
                                "cancelled" -> "已取消（$message）"
                                else -> "分析失败：$message"
                            },
                        )
                    }
                },
            )
        }
        // 标签/描述/词表已落库：三快照重算（内部失败容忍）+当前视图重拉（抽屉数据源）
        reloadTagState()
        reloadImages()
    }
}

/** 文件夹卡片「AI 分析相册」（总览选中入口；扁平 bucket 无需递归，M4b D18）。 */
internal fun GalleryViewModel.startAiFolderAnalysis(folderIds: List<String>) {
    viewModelScope.launch {
        val ids = withContext(Dispatchers.IO) {
            folderIds.flatMap { fid -> runCatching { listImages(fid) }.getOrDefault(emptyList()) }
                .map { it.id }
                .distinct()
        }
        if (ids.isEmpty()) {
            aiToast("所选相册没有图片")
            return@launch
        }
        startAiAnalysis(ids)
    }
}

/**
 * 批量 AI 重命名：AI 只产名字（core 不碰库不改文件），提案经 [aiRenameProposals]
 * 由宿主弹确认；真正改名=批量授权一次+M4b renameFiles（见 applyAiRenameProposals）。
 */
internal fun GalleryViewModel.startAiRename(fileIds: List<String>) {
    // object : AiTaskCallback / AiRenameCallback 内部拿不到扩展接收者（object 表达式不继承
    // 外层扩展函数的隐式接收者，lambda 才继承），先捕获成 vm 供回调体使用。
    val vm = this
    if (aiTaskState.value != null) {
        aiToast("AI 任务进行中，可从通知栏取消")
        return
    }
    if (fileIds.isEmpty()) return
    if (aiEndpointBlank()) {
        aiToast("请先在「设置 → AI 智能」配置服务地址")
        return
    }
    val cfg = settings.value.ai.toAiConfig(settings.value.language)
    aiJob = viewModelScope.launch {
        val taskId = "ai-rename-${System.currentTimeMillis()}"
        val targets = withContext(Dispatchers.IO) { listImagesByIds(fileIds) }
        aiTaskState.value = GalleryViewModel.AiTaskState("AI 重命名", taskId, 0, targets.size)
        scanNotifier.aiProgress("AI 重命名", 0, targets.size)
        val proposals = mutableListOf<Triple<Image, String, String>>()
        var failed = 0
        withContext(Dispatchers.IO) {
            aiGenerateFileNames(
                cfg,
                targets.map { AiRenameItem(fileId = it.id, name = it.name) },
                taskId,
                object : AiRenameCallback {
                    override fun readBytes(fileId: String): ByteArray? = runCatching {
                        targets.firstOrNull { it.id == fileId }?.contentUri?.let { uri ->
                            vm.appContext.contentResolver.openInputStream(Uri.parse(uri))?.use { it.readBytes() }
                        }
                    }.getOrNull()

                    override fun onProgress(current: UInt, total: UInt) {
                        vm.aiTaskState.value = GalleryViewModel.AiTaskState("AI 重命名", taskId, current.toInt(), total.toInt())
                        vm.scanNotifier.aiProgress("AI 重命名", current.toInt(), total.toInt())
                    }

                    override fun onFileDone(fileId: String, ok: Boolean, note: String) {
                        if (!ok) {
                            failed++
                            Log.w(GalleryViewModel.TAG, "[Ai] rename fail $fileId: $note")
                        }
                    }

                    override fun onName(fileId: String, newName: String) {
                        targets.firstOrNull { it.id == fileId }?.let { img ->
                            proposals.add(Triple(img, img.name, newName))
                        }
                    }

                    override fun onFinished(state: String, message: String) {
                        vm.aiTaskState.value = null
                        vm.scanNotifier.aiDone(
                            when (state) {
                                "completed" -> "改名提案就绪 ${proposals.size} 张" + if (failed > 0) "（$failed 张失败）" else ""
                                "cancelled" -> "已取消（$message）"
                                else -> "AI 重命名失败：$message"
                            },
                        )
                    }
                },
            )
        }
        if (proposals.isNotEmpty()) {
            aiRenameProposals.value = proposals.toList()
        } else {
            aiToast("AI 未产出可用的改名提案" + if (failed > 0) "（$failed 张失败）" else "")
        }
    }
}

/** 应用改名提案（确认弹窗「应用」）：走 M4b 重命名管线（直写+兜底授权由它负责）。 */
internal fun GalleryViewModel.applyAiRenameProposals(
    targets: List<Pair<android.net.Uri, String>>,
    onDone: (Int) -> Unit = {},
    onBlocked: (List<android.net.Uri>, retry: () -> Unit) -> Unit = { _, _ -> },
) {
    aiRenameProposals.value = null
    renameFiles(targets, onDone, onBlocked)
}

/** AI 搜索：query → core 改写（一次 HTTP）→ 全库过滤 → 命中集自带全库序列驱动网格。 */
internal fun GalleryViewModel.performAiSearch(query: String) {
    if (query.isBlank()) {
        clearAiSearch()
        return
    }
    if (aiEndpointBlank()) {
        aiToast("请先在「设置 → AI 智能」配置服务地址")
        return
    }
    val cfg = settings.value.ai.toAiConfig(settings.value.language)
    viewModelScope.launch {
        aiSearchBusy.value = true
        clearColorSearch() // 与颜色过滤互斥：AI 命中顶替颜色命中（反向互斥见 startColorSearch）
        try {
            val ids = withContext(Dispatchers.IO) {
                val filter = aiRewriteSearchQuery(cfg, query)
                val tags = getAllFileTags().associate { it.fileId to it.tags }
                val meta = getAllFileMetadata().associateBy { it.fileId }
                val items = folders.value
                    .flatMap { f -> runCatching { listImages(f.id) }.getOrDefault(emptyList()) }
                    .map {
                        SearchItem(
                            fileId = it.id,
                            name = it.name,
                            tags = tags[it.id].orEmpty(),
                            description = meta[it.id]?.description,
                        )
                    }
                aiApplySearchFilter(filter, items)
            }
            aiSearchIds.value = ids.toSet()
            aiSearchResultImages.value = withContext(Dispatchers.IO) { listImagesByIds(ids) }
            aiToast("AI 搜索命中 ${ids.size} 张")            } catch (e: Exception) {
            Log.w(GalleryViewModel.TAG, "[Ai] search failed", e)
            aiToast("AI 搜索失败：${e.message ?: "未知错误"}")
        } finally {
            aiSearchBusy.value = false
        }
    }
}
