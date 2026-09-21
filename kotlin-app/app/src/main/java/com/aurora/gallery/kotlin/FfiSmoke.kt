package com.aurora.gallery.kotlin

import android.util.Log
import uniffi.aurora_core.FfiCoverCrop
import uniffi.aurora_core.FfiFaceBox
import uniffi.aurora_core.FfiFileMetadata
import uniffi.aurora_core.FfiPerson
import uniffi.aurora_core.FfiTopic
import uniffi.aurora_core.addFilesToTopic
import uniffi.aurora_core.addTagsToFiles
import uniffi.aurora_core.deletePerson
import uniffi.aurora_core.deleteTopic
import uniffi.aurora_core.getAllFileMetadata
import uniffi.aurora_core.getAllFileTags
import uniffi.aurora_core.getAllPeople
import uniffi.aurora_core.getAllTopics
import uniffi.aurora_core.getFileMetadata
import uniffi.aurora_core.getFileTags
import uniffi.aurora_core.getFilesByTag
import uniffi.aurora_core.getTopicFiles
import uniffi.aurora_core.getTopicFilesPaginated
import uniffi.aurora_core.listFolders
import uniffi.aurora_core.listImages
import uniffi.aurora_core.setFileTags
import uniffi.aurora_core.upsertFileMetadata
import uniffi.aurora_core.upsertPerson
import uniffi.aurora_core.upsertTopic

/**
 * M4a 0.3：0.1 新导出的人物 / 专题 / 元数据 FFI 读写冒烟。
 *
 * 只挂调试广播，不进主链路：
 * `adb shell am broadcast -a aurora.debug.FFI_SMOKE`
 *
 * 每行日志都带本轮 nonce —— 看不到 `[FfiSmoke <nonce>]` 就是没跑到新代码，
 * 不是「跑过了但没输出」。
 */
private const val TAG = "AuroraKotlin"

fun runFfiSmoke(nonce: String) {
    Thread({
        try {
            Log.i(TAG, "[FfiSmoke $nonce] begin")
            smokePerson(nonce)
            smokeTopic(nonce)
            smokeFileMetadata(nonce)
            smokeMissingRow(nonce)
            smokeTags(nonce)
            Log.i(TAG, "[FfiSmoke $nonce] end")
        } catch (e: Throwable) {
            Log.e(TAG, "[FfiSmoke $nonce] CRASH ${e.javaClass.simpleName}: ${e.message}", e)
        }
    }, "ffi-smoke").start()
}

private fun check(nonce: String, field: String, expected: Any?, actual: Any?) {
    if (expected != actual) {
        throw AssertionError("[$nonce] $field 期望 $expected 实得 $actual")
    }
}

private fun report(nonce: String, label: String, fields: List<Pair<String, Pair<Any?, Any?>>>) {
    val bad = fields.filter { it.second.first != it.second.second }
    if (bad.isNotEmpty()) {
        throw AssertionError(
            "[$nonce] $label: " + bad.joinToString { "${it.first} 期望 ${it.second.first} 实得 ${it.second.second}" }
        )
    }
}

private fun smokePerson(nonce: String) {
    val id = "smoke-$nonce-person"
    val written = FfiPerson(
        id = id,
        name = "张三 \"zhang\" \\ san",
        coverFileId = "cover-文件-1",
        count = 7,
        description = "含 emoji 🌸 与 换行\n描述",
        faceBox = FfiFaceBox(0.1, -0.2, 1234.5, 0.0),
        updatedAt = 1_700_000_000,
        characterTagName = "角色名",
        characterTagIndex = -3,
    )
    upsertPerson(written)
    val read = getAllPeople().firstOrNull { it.id == id }
        ?: throw AssertionError("[$nonce] person 写进去读不回来")
    val fields = listOf(
        "name" to (written.name to read.name),
        "coverFileId" to (written.coverFileId to read.coverFileId),
        "count" to (written.count to read.count),
        "description" to (written.description to read.description),
        "faceBox" to (written.faceBox to read.faceBox),
        "updatedAt" to (written.updatedAt to read.updatedAt),
        "characterTagName" to (written.characterTagName to read.characterTagName),
        "characterTagIndex" to (written.characterTagIndex to read.characterTagIndex),
    )
    report(nonce, "person", fields)
    deletePerson(id)
    val gone = getAllPeople().none { it.id == id }
    Log.i(TAG, "[FfiSmoke $nonce] PASS person ${fields.size} 字段一致 + delete 生效=$gone")
}

private fun smokeTopic(nonce: String) {
    val id = "smoke-$nonce-topic"
    val written = FfiTopic(
        id = id,
        parentId = null,
        name = "专题 名\"含引号\"",
        description = "描述",
        topicType = "album",
        coverFileId = "cover-1",
        backgroundFileId = null,
        coverCrop = FfiCoverCrop(1.5, 2.5, 100.0, 200.0),
        peopleIds = emptyList(),
        fileIds = emptyList(),
        sourceUrl = "https://example.com/路径?查询=1",
        createdAt = 1_600_000_000,
        updatedAt = 1_700_000_000,
        sourceType = "manual",
        workName = "work",
        workNameCn = "作品名",
        fileCount = 3,
    )
    upsertTopic(written)
    val read = getAllTopics().firstOrNull { it.id == id }
        ?: throw AssertionError("[$nonce] topic 写进去读不回来")
    val fields = listOf(
        "name" to (written.name to read.name),
        "description" to (written.description to read.description),
        "topicType" to (written.topicType to read.topicType),
        "coverFileId" to (written.coverFileId to read.coverFileId),
        "backgroundFileId" to (written.backgroundFileId to read.backgroundFileId),
        "coverCrop" to (written.coverCrop to read.coverCrop),
        "sourceUrl" to (written.sourceUrl to read.sourceUrl),
        "createdAt" to (written.createdAt to read.createdAt),
        "updatedAt" to (written.updatedAt to read.updatedAt),
        "sourceType" to (written.sourceType to read.sourceType),
        "workName" to (written.workName to read.workName),
        "workNameCn" to (written.workNameCn to read.workNameCn),
        "fileCount" to (written.fileCount to read.fileCount),
    )
    report(nonce, "topic", fields)

    // 懒加载契约：列表查询不填 fileIds，计数看 fileCount（清单 0.1 点名的坑）
    val members = listOf("smoke-$nonce-f1", "smoke-$nonce-f2", "smoke-$nonce-f3")
    addFilesToTopic(id, members)
    check(nonce, "列表里 fileIds 仍为空", true, getAllTopics().first { it.id == id }.fileIds.isEmpty())
    check(nonce, "getTopicFiles 成员", members, getTopicFiles(id).sorted())
    val page = getTopicFilesPaginated(id, 1, 2)
    check(nonce, "分页 total 值与类型(Long)", 3L, page.total)
    check(nonce, "分页 offset=1 命中", true, page.files.first() in members)

    deleteTopic(id)
    val gone = getAllTopics().none { it.id == id } && getTopicFiles(id).isEmpty()
    Log.i(TAG, "[FfiSmoke $nonce] PASS topic ${fields.size} 字段一致 + 懒加载/分页 + delete 级联=$gone")
}

private fun smokeFileMetadata(nonce: String) {
    val id = "smoke-$nonce-meta"
    val written = FfiFileMetadata(
        fileId = id,
        path = "content://media/external/images/media/999",
        description = "描述 with 中文",
        sourceUrl = "https://example.com",
        aiData = """{"wd14":["a",1],"嵌套":{"k":[1,2]}}""",
        category = "插画",
        updatedAt = 1_700_000_000,
    )
    upsertFileMetadata(written)
    val read = getFileMetadata(id) ?: throw AssertionError("[$nonce] metadata 写进去读不回来")
    val fields = listOf(
        "fileId" to (written.fileId to read.fileId),
        "path" to (written.path to read.path),
        "description" to (written.description to read.description),
        "sourceUrl" to (written.sourceUrl to read.sourceUrl),
        "aiData" to (written.aiData to read.aiData),
        "category" to (written.category to read.category),
        "updatedAt" to (written.updatedAt to read.updatedAt),
    )
    report(nonce, "metadata", fields)
    check(nonce, "全表读得到本行", true, getAllFileMetadata().any { it.fileId == id })
    Log.i(TAG, "[FfiSmoke $nonce] PASS metadata ${fields.size} 字段一致")
}

/** 失败路径：不存在的 file_id 必须是 `null`，不能是异常或进程退出。 */
private fun smokeMissingRow(nonce: String) {
    val missing = getFileMetadata("smoke-$nonce-不存在的 id")
    check(nonce, "缺行返回 null", null, missing)
    Log.i(TAG, "[FfiSmoke $nonce] PASS 缺行返回 null（AuroraError 未误抛）")
}

/**
 * M4a 1.1：标签四原语 + 批量粘贴。用库里真实的图（file_id 与 `generate_id(content_uri)`
 * 对得上），否则只测了合成 id 等于没测。
 */
private fun smokeTags(nonce: String) {
    // 惰性取两张就够：全量 flatMap 会把每个相册都查一遍，和启动扫描抢锁
    val images = listFolders().asSequence().flatMap { listImages(it.id) }.take(2).toList()
    if (images.size < 2) {
        Log.w(TAG, "[FfiSmoke $nonce] SKIP tags：库里不足两张图（${images.size}）")
        return
    }
    val (f1, f2) = images.map { it.id }
    val shared = "冒烟$nonce-风景"
    val only1 = "冒烟$nonce-猫 \"带引号\" \\反斜杠 🌸"
    val pasted = "冒烟$nonce-旅行"

    setFileTags(f1, listOf(shared, only1))
    setFileTags(f2, listOf(shared))
    check(nonce, "按标签取文件（两张图共用一个标签）", listOf(f1, f2).sorted(), getFilesByTag(shared).sorted())
    check(nonce, "读回单图标签含顺序", listOf(shared, only1), getFileTags(f1))
    check(nonce, "另一张图只有共享标签", listOf(shared), getFileTags(f2))
    check(nonce, "没人用的标签返回空表", emptyList<String>(), getFilesByTag("冒烟$nonce-不存在"))

    // 整行覆盖陷阱：写描述走的是 file_metadata，不得把 file_tags 里的标签冲掉
    val meta = getFileMetadata(f1) ?: FfiFileMetadata(
        fileId = f1,
        path = images[0].contentUri,
        description = null,
        sourceUrl = null,
        aiData = null,
        category = null,
        updatedAt = null,
    )
    upsertFileMetadata(meta.copy(description = "冒烟描述 $nonce"))
    check(nonce, "写描述后标签没被冲掉", listOf(shared, only1), getFileTags(f1))
    check(nonce, "写描述确实生效", "冒烟描述 $nonce", getFileMetadata(f1)?.description)

    addTagsToFiles(listOf(f1, f2), listOf(pasted, shared))
    check(nonce, "批量粘贴：已有成员不重复、新标签追加在尾", listOf(shared, only1, pasted), getFileTags(f1))
    check(nonce, "批量粘贴：第二张图", listOf(shared, pasted), getFileTags(f2))
    check(nonce, "批量粘贴后按标签取文件", listOf(f1, f2).sorted(), getFilesByTag(pasted).sorted())
    check(nonce, "全量映射读得到", true, getAllFileTags().any { it.fileId == f1 && it.tags == listOf(shared, only1, pasted) })

    setFileTags(f1, emptyList())
    setFileTags(f2, emptyList())
    val purged = getFilesByTag(shared).isEmpty() && getFilesByTag(pasted).isEmpty()
    Log.i(TAG, "[FfiSmoke $nonce] PASS tags 四原语+批量粘贴，成员行已清空=$purged（3 个冒烟词留在词表，1.2 的 remove_tag 落地后清）")
}
