package com.aurora.gallery.kotlin

import android.content.Context
import android.util.Log
import uniffi.aurora_core.AiConfig
import uniffi.aurora_core.AiInputItem
import uniffi.aurora_core.AiProvider
import uniffi.aurora_core.AiRenameItem
import uniffi.aurora_core.AiSearchFilter
import uniffi.aurora_core.AiTaskCallback
import uniffi.aurora_core.SearchItem
import uniffi.aurora_core.aiAnalyzeFiles
import uniffi.aurora_core.aiApplySearchFilter
import uniffi.aurora_core.aiCancelTask
import uniffi.aurora_core.aiGenerateFileNames
import uniffi.aurora_core.aiRewriteSearchQuery
import uniffi.aurora_core.deleteTags
import uniffi.aurora_core.getFileMetadata
import uniffi.aurora_core.getFileTags
import uniffi.aurora_core.getGroupedTags
import uniffi.aurora_core.listFolders
import uniffi.aurora_core.listImages
import uniffi.aurora_core.upsertFileMetadata
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * M6b 1.3 冒烟钩子：对宿主 mock provider（Temp/m6b-mock-ai.mjs，10.0.2.2:18081）跑
 * AI 编排全链——分析（写库+词表+进度）、改名（只产名字）、搜索改写+过滤、取消。
 *
 * 只挂调试广播，不进主链路：
 * ```
 * adb shell am broadcast -a aurora.debug.AI_SMOKE --es mode analyze --es provider openai
 * adb shell am broadcast -a aurora.debug.AI_SMOKE --es mode cancel   # 走 /slow（8s/张）
 * adb shell am broadcast -a aurora.debug.AI_SMOKE --es mode rename
 * adb shell am broadcast -a aurora.debug.AI_SMOKE --es mode search
 * ```
 * 分析会写真实库图的元数据与标签——先行读出旧行，测试后还原（原无行则写全 null 行，
 * FfiSmoke 同款容忍）；mock 标签词统一 mock 前缀，用 deleteTags 清理。
 * 每行日志带 nonce，看不到 `[AiSmoke <nonce>]` 就是没跑到新代码。
 */
private const val AI_SMOKE_TAG = "AuroraKotlin"

fun runAiSmoke(context: Context, nonce: String, mode: String, provider: String, slow: Boolean) {
    Thread({
        try {
            Log.i(AI_SMOKE_TAG, "[AiSmoke $nonce] begin mode=$mode provider=$provider slow=$slow")
            val images = listFolders().asSequence().flatMap { listImages(it.id) }.take(3).toList()
            if (images.size < 3) {
                Log.w(AI_SMOKE_TAG, "[AiSmoke $nonce] SKIP：库里不足三张图（${images.size}）")
                return@Thread
            }
            val uriById = images.associate { it.id to it.contentUri }
            val cfg = mockConfig(provider, slow)
            when (mode) {
                "analyze" -> smokeAnalyze(context, nonce, cfg, images, uriById)
                "cancel" -> smokeCancel(context, nonce, cfg, images, uriById)
                "rename" -> smokeRename(context, nonce, cfg, images, uriById)
                "search" -> smokeSearch(nonce, cfg)
                else -> Log.w(AI_SMOKE_TAG, "[AiSmoke $nonce] 未知 mode=$mode")
            }
            Log.i(AI_SMOKE_TAG, "[AiSmoke $nonce] end")
        } catch (e: Throwable) {
            Log.e(AI_SMOKE_TAG, "[AiSmoke $nonce] CRASH ${e.javaClass.simpleName}: ${e.message}", e)
        }
    }, "ai-smoke").start()
}

/** mock provider 配置：三 provider 都指向宿主 18081，路径形态由各 provider 分支自拼。 */
private fun mockConfig(provider: String, slow: Boolean): AiConfig {
    val base = if (slow) "http://10.0.2.2:18081/slow" else "http://10.0.2.2:18081"
    val p = when (provider) {
        "ollama" -> AiProvider.OLLAMA
        "lmstudio" -> AiProvider.LM_STUDIO
        else -> AiProvider.OPEN_AI
    }
    return AiConfig(
        provider = p,
        openaiEndpoint = "$base/v1",
        openaiApiKey = "sk-mock",
        openaiModel = "mock-model",
        ollamaEndpoint = base,
        ollamaModel = "mock-model",
        lmstudioEndpoint = base,
        lmstudioModel = "mock-model",
        systemPrompt = null,
        autoTag = true,
        autoDescription = true,
        enhancePersonDescription = false,
        enableOcr = true,
        enableTranslation = true,
        language = "zh",
    )
}

private class SmokeCallback(
    private val context: Context,
    private val uriById: Map<String, String>,
    val doneIds: MutableList<String> = mutableListOf(),
    val failedNotes: MutableList<String> = mutableListOf(),
    var progressCalls: Int = 0,
    var finishedState: String? = null,
    var finishedMessage: String? = null,
) : AiTaskCallback {
    override fun readBytes(fileId: String): ByteArray? = uriById[fileId]?.let {
        context.contentResolver.openInputStream(android.net.Uri.parse(it))?.use { s -> s.readBytes() }
    }

    override fun onProgress(current: UInt, total: UInt) {
        progressCalls++
        Log.i(AI_SMOKE_TAG, "[AiSmoke] progress $current/$total")
    }

    override fun onFileDone(fileId: String, ok: Boolean, note: String) {
        Log.i(AI_SMOKE_TAG, "[AiSmoke] fileDone $fileId ok=$ok note=$note")
        if (ok) doneIds.add(fileId) else failedNotes.add(note)
    }

    override fun onFinished(state: String, message: String) {
        finishedState = state
        finishedMessage = message
        Log.i(AI_SMOKE_TAG, "[AiSmoke] finished state=$state msg=$message")
    }
}

/** 读字节回调（改名任务与进度/完成上报复用同一实现形状）。 */
private fun readBytesOf(context: Context, uriById: Map<String, String>) =
    { fileId: String ->
        uriById[fileId]?.let {
            context.contentResolver.openInputStream(android.net.Uri.parse(it))?.use { s -> s.readBytes() }
        }
    }

private fun smokeAnalyze(
    context: Context,
    nonce: String,
    cfg: AiConfig,
    images: List<uniffi.aurora_core.Image>,
    uriById: Map<String, String>,
) {
    val oldMetas = images.map { it.id to getFileMetadata(it.id) }
    val cb = SmokeCallback(context, uriById)
    aiAnalyzeFiles(
        cfg,
        images.map { AiInputItem(fileId = it.id, path = it.contentUri, name = it.name) },
        "smoke-$nonce",
        cb,
    )

    check(cb.finishedState == "completed") { "finished 期望 completed 实得 ${cb.finishedState}（${cb.finishedMessage}）" }
    check(cb.doneIds.size == 3) { "成功数期望 3 实得 ${cb.doneIds.size}，失败=${cb.failedNotes}" }
    check(cb.progressCalls >= 1) { "进度回调缺失" }
    for (img in images) {
        val meta = getFileMetadata(img.id) ?: throw AssertionError("[AiSmoke $nonce] ${img.name} 元数据未写入")
        check(meta.description == "Mock description for smoke test") { "${img.name} description=${meta.description}" }
        // category=旧值透传（AI 不产出 category；sceneCategory 只进 aiData——TS 语义）
        check(meta.category == null) { "${img.name} category=${meta.category}" }
        check(meta.aiData?.contains("0.95") == true) { "${img.name} aiData 缺 confidence=${meta.aiData}" }
        check(meta.aiData?.contains("\"sceneCategory\":\"photo\"") == true) { "${img.name} aiData 缺 sceneCategory=${meta.aiData}" }
        val tags = getFileTags(img.id)
        check("mockalpha" in tags && "mockbeta" in tags) { "${img.name} tags=$tags" }
    }
    Log.i(AI_SMOKE_TAG, "[AiSmoke $nonce] PASS analyze：3 图写库+词表+进度全对（provider=${cfg.provider}）")
    restore(context, nonce, images, oldMetas)
}

private fun smokeCancel(
    context: Context,
    nonce: String,
    cfg: AiConfig,
    images: List<uniffi.aurora_core.Image>,
    uriById: Map<String, String>,
) {
    val oldMetas = images.map { it.id to getFileMetadata(it.id) }
    val cb = SmokeCallback(context, uriById)
    val taskId = "smoke-cancel-$nonce"
    val worker = Thread {
        aiAnalyzeFiles(cfg, images.map { AiInputItem(fileId = it.id, path = it.contentUri, name = it.name) }, taskId, cb)
    }
    worker.start()
    // 等第一张完成（mock slow=8s/张），再取消——第 2 张迭代首查 cancel，应停在 1 done
    val deadline = System.currentTimeMillis() + 30_000
    while (cb.doneIds.isEmpty() && System.currentTimeMillis() < deadline) Thread.sleep(300)
    check(cb.doneIds.isNotEmpty()) { "30s 内第一张未完成，取消用例失据" }
    val cancelled = aiCancelTask(taskId)
    worker.join(90_000)
    check(cancelled) { "aiCancelTask 返回 false（任务不在册）" }
    check(cb.finishedState == "cancelled") { "finished 期望 cancelled 实得 ${cb.finishedState}" }
    // 语义=迭代首查生效、在途请求不打断：取消时在途的那张会跑完（1 或 2 张），但绝不起第 3 张
    check(cb.doneIds.size in 1..2) { "取消后成功数期望 1..2 实得 ${cb.doneIds.size}" }
    Log.i(AI_SMOKE_TAG, "[AiSmoke $nonce] PASS cancel：${cb.doneIds.size} 张完成即停，未跑满 3 张")
    restore(context, nonce, images, oldMetas)
}

private fun smokeRename(
    context: Context,
    nonce: String,
    cfg: AiConfig,
    images: List<uniffi.aurora_core.Image>,
    uriById: Map<String, String>,
) {
    val names = mutableListOf<Pair<String, String>>()
    val read = readBytesOf(context, uriById)
    var finished: String? = null
    val latch = CountDownLatch(1)
    aiGenerateFileNames(
        cfg,
        images.map { AiRenameItem(fileId = it.id, name = it.name) },
        "smoke-rename-$nonce",
        object : uniffi.aurora_core.AiRenameCallback {
            override fun readBytes(fileId: String): ByteArray? = read(fileId)
            override fun onProgress(current: UInt, total: UInt) {
                Log.i(AI_SMOKE_TAG, "[AiSmoke] rename progress $current/$total")
            }

            override fun onFileDone(fileId: String, ok: Boolean, note: String) {
                if (!ok) Log.w(AI_SMOKE_TAG, "[AiSmoke] rename failed $fileId: $note")
            }

            override fun onName(fileId: String, newName: String) {
                Log.i(AI_SMOKE_TAG, "[AiSmoke] name $fileId -> $newName")
                names.add(fileId to newName)
            }

            override fun onFinished(state: String, message: String) {
                finished = state
                latch.countDown()
            }
        },
    )
    check(latch.await(120, TimeUnit.SECONDS)) { "改名任务 120s 未完成" }
    check(finished == "completed") { "rename finished=$finished" }
    check(names.size == 3 && names.all { it.second == "雪山风光照" }) { "rename 结果=$names" }
    Log.i(AI_SMOKE_TAG, "[AiSmoke $nonce] PASS rename：3 名产出且清理一致（改名本身走 M4b 管线，不在本钩子）")
}

private fun smokeSearch(nonce: String, cfg: AiConfig) {
    val filter = aiRewriteSearchQuery(cfg, "mountain photos at dusk")
    check(filter.keywords == listOf("mock")) { "keywords=${filter.keywords}" }
    check(filter.description == "mock filter description") { "description=${filter.description}" }
    check(filter.originalQuery == "mountain photos at dusk") { "originalQuery=${filter.originalQuery}" }
    // apply 用合成数据做确定性断言（TS 语义：keywords 匹配 tags/description、不匹配文件名；
    // filter.description 是额外 AND 条件——f1 双条件全中、f2 只中 keywords 应被滤掉）
    val hits = aiApplySearchFilter(
        filter,
        listOf(
            SearchItem(fileId = "f1", name = "mountain.jpg", tags = emptyList(), description = "a mock filter description scene"),
            SearchItem(fileId = "f2", name = "cat.jpg", tags = listOf("mocktag"), description = null),
            SearchItem(fileId = "f3", name = "dog.jpg", tags = emptyList(), description = null),
        ),
    )
    check(hits == listOf("f1")) { "apply hits=$hits" }
    Log.i(AI_SMOKE_TAG, "[AiSmoke $nonce] PASS search：改写 filter 原样回流+apply 按 TS AND 语义命中")
}

/** 还原元数据（原无行写全 null 行）+ 清 mock 词表词。 */
private fun restore(
    context: Context,
    nonce: String,
    images: List<uniffi.aurora_core.Image>,
    oldMetas: List<Pair<String, uniffi.aurora_core.FfiFileMetadata?>>,
) {
    for ((id, old) in oldMetas) {
        val img = images.first { it.id == id }
        upsertFileMetadata(
            old ?: uniffi.aurora_core.FfiFileMetadata(
                fileId = id,
                path = img.contentUri,
                description = null,
                sourceUrl = null,
                aiData = null,
                category = null,
                updatedAt = null,
            ),
        )
    }
    val grouped = getGroupedTags("zh").flatMap { it.tags }.map { it.tag }
    val mocks = grouped.filter { it.startsWith("mock") }
    if (mocks.isNotEmpty()) deleteTags(mocks)
    Log.i(AI_SMOKE_TAG, "[AiSmoke $nonce] restore：元数据已还原，mock 词清理 ${mocks.size} 个")
}
