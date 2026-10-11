package com.aurora.gallery.kotlin

import android.net.Uri
import android.os.Build
import android.util.Log
import android.widget.Toast
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch
import org.json.JSONObject

// 缓存清理 + 备份导出/导入簇（拆分清单第 26 刀，⑥ 第 1 刀）：设置面板存储 Section 的
// 宿主侧取数与写操作——缓存体积统计/清理、备份 JSON 导出（MediaStore Downloads）与
// 导入（SAF 选文件 → 词表/人物/专题按 id 去重合并），4 个扩展函数落地（§5.1 手法，
// 接收者 MainActivity；原分节注释「—— M4b 2.3 设置面板：缓存清理 + 备份导出/导入 ——」随簇迁移）。
// importBackupLauncher（registerForActivityResult 字段）不能搬（字段无法落在扩展上），
// 留在原类、经 internal 扩展 importBackupFrom 回流；viewModel 字段随本刀降 internal。

internal fun MainActivity.computeCacheSizeText(): String {
    fun dirSize(dir: java.io.File): Long =
        dir.walkBottomUp().filter { it.isFile }.sumOf { it.length() }
    val cacheDir = cacheDir
    val total = if (cacheDir.exists()) dirSize(cacheDir) else 0L
    // M4c：去掉 M4b 的「=」前缀（测试反馈观感异常），改「约」表达估算值语义
    return when {
        total >= 1L shl 20 -> "约 %.1f MB".format(total.toDouble() / (1L shl 20))
        total >= 1024 -> "约 %.1f KB".format(total.toDouble() / 1024)
        else -> "$total B"
    }
}

internal fun MainActivity.clearCache() {
    lifecycleScope.launch {
        val freed = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
            fun dirSize(dir: java.io.File): Long =
                dir.walkBottomUp().filter { it.isFile }.sumOf { it.length() }
            val before = if (cacheDir.exists()) dirSize(cacheDir) else 0L
            cacheDir.deleteRecursively()
            cacheDir.mkdirs()
            before
        }
        Toast.makeText(
            this@clearCache,
            "缓存已清理（释放 %.1f MB）".format(freed.toDouble() / (1L shl 20)),
            Toast.LENGTH_SHORT,
        ).show()
    }
}

internal fun MainActivity.importBackupFrom(uri: Uri) {
    lifecycleScope.launch {
        val report = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
            var tagsAdded = 0
            var peopleAdded = 0
            var topicsAdded = 0
            try {
                val text = contentResolver.openInputStream(uri)?.use { input ->
                    input.readBytes().toString(Charsets.UTF_8)
                } ?: throw IllegalStateException("openInputStream failed")
                val json = org.json.JSONObject(text)
                val tags = json.optJSONArray("tags")
                val existingIds = HashSet<String>()
                if (tags != null) {
                    val grouped = uniffi.aurora_core.getGroupedTags(viewModel.settings.value.language)
                    grouped.forEach { g -> g.tags.forEach { existingIds.add(it.tag) } }
                    for (i in 0 until tags.length()) {
                        val tag = tags.getString(i).trim()
                        if (tag.isNotEmpty() && tag !in existingIds) {
                            uniffi.aurora_core.addTagToVocabulary(tag)
                            tagsAdded++
                        }
                    }
                }
                val people = json.optJSONObject("people")
                if (people != null) {
                    val existing = uniffi.aurora_core.getAllPeople().associateBy { it.id }
                    for (key in people.keys()) {
                        if (key in existing) continue
                        val p = people.getJSONObject(key)
                        uniffi.aurora_core.upsertPerson(
                            uniffi.aurora_core.FfiPerson(
                                id = p.optString("id", key),
                                name = p.optString("name", key),
                                coverFileId = "",
                                count = 0,
                                description = p.optString("description").takeIf { it.isNotEmpty() },
                                faceBox = null,
                                updatedAt = null,
                                characterTagName = null,
                                characterTagIndex = null,
                            ),
                        )
                        peopleAdded++
                    }
                }
                val topics = json.optJSONObject("topics")
                if (topics != null) {
                    val existing = uniffi.aurora_core.getAllTopics().associateBy { it.id }
                    for (key in topics.keys()) {
                        if (key in existing) continue
                        val t = topics.getJSONObject(key)
                        val peopleIds = mutableListOf<String>()
                        t.optJSONArray("peopleIds")?.let { arr ->
                            for (i in 0 until arr.length()) peopleIds.add(arr.getString(i))
                        }
                        val now = System.currentTimeMillis()
                        uniffi.aurora_core.upsertTopic(
                            uniffi.aurora_core.FfiTopic(
                                id = t.optString("id", key),
                                parentId = t.optString("parentId").takeIf { it.isNotEmpty() },
                                name = t.optString("name", key),
                                description = t.optString("description").takeIf { it.isNotEmpty() },
                                topicType = t.optString("type", "TOPIC").ifEmpty { "TOPIC" },
                                coverFileId = null,
                                backgroundFileId = null,
                                coverCrop = null,
                                peopleIds = peopleIds,
                                fileIds = emptyList(),
                                sourceUrl = null,
                                createdAt = now,
                                updatedAt = now,
                                sourceType = null,
                                workName = null,
                                workNameCn = null,
                                fileCount = 0,
                            ),
                        )
                        topicsAdded++
                    }
                }
                "已导入：词表 +$tagsAdded，人物 +$peopleAdded，专题 +$topicsAdded"
            } catch (e: Exception) {
                Log.w("AuroraKotlin", "[Settings] import backup failed", e)
                "导入失败（格式或读取错误）"
            }
        }
        if (report.startsWith("已导入")) viewModel.refreshTagSnapshots()
        Toast.makeText(this@importBackupFrom, report, Toast.LENGTH_LONG).show()
    }
}

/** 备份导出（2.3，字段对齐 React StoragePanel 导出：词表 + 人物 + 简化专题）。 */
internal fun MainActivity.exportBackup() {
    lifecycleScope.launch {
        val json = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
            val grouped = uniffi.aurora_core.getGroupedTags(viewModel.settings.value.language)
            val tags = grouped.flatMap { g -> g.tags.map { it.tag } }
            val people = uniffi.aurora_core.getAllPeople()
            val topics = uniffi.aurora_core.getAllTopics()
            val peopleJson = org.json.JSONObject()
            people.forEach { p ->
                peopleJson.put(
                    p.id,
                    org.json.JSONObject()
                        .put("name", p.name)
                        .put("description", p.description ?: JSONObject.NULL)
                        .put("count", p.count),
                )
            }
            val topicsJson = org.json.JSONObject()
            topics.forEach { t ->
                topicsJson.put(
                    t.id,
                    org.json.JSONObject()
                        .put("id", t.id)
                        .put("name", t.name)
                        .put("parentId", t.parentId ?: JSONObject.NULL)
                        .put("description", t.description ?: JSONObject.NULL)
                        .put("type", t.topicType ?: "TOPIC")
                        .put("peopleIds", org.json.JSONArray(t.peopleIds)),
                )
            }
            org.json.JSONObject()
                .put("tags", org.json.JSONArray(tags))
                .put("people", peopleJson)
                .put("topics", topicsJson)
                .toString(2)
        }
        try {
            val fileName = "aurora_metadata_backup_${java.text.SimpleDateFormat("yyyy-MM-dd", java.util.Locale.US).format(java.util.Date())}.json"
            val values = android.content.ContentValues().apply {
                put(android.provider.MediaStore.Downloads.DISPLAY_NAME, fileName)
                put(android.provider.MediaStore.Downloads.MIME_TYPE, "application/json")
                if (Build.VERSION.SDK_INT >= 29) {
                    put(android.provider.MediaStore.Downloads.RELATIVE_PATH, "Download/")
                    put(android.provider.MediaStore.Downloads.IS_PENDING, 1)
                }
            }
            val collection = if (Build.VERSION.SDK_INT >= 29) {
                android.provider.MediaStore.Downloads.EXTERNAL_CONTENT_URI
            } else {
                Uri.parse("${android.os.Environment.getExternalStoragePublicDirectory(android.os.Environment.DIRECTORY_DOWNLOADS)}/$fileName")
            }
            val uri = contentResolver.insert(collection, values)
                ?: throw IllegalStateException("insert failed")
            contentResolver.openOutputStream(uri)?.use { out ->
                out.write(json.toByteArray())
            } ?: throw IllegalStateException("openOutputStream failed")
            if (Build.VERSION.SDK_INT >= 29) {
                contentResolver.update(uri, android.content.ContentValues().apply {
                    put(android.provider.MediaStore.Downloads.IS_PENDING, 0)
                }, null, null)
            }
            Toast.makeText(this@exportBackup, "已导出到 Download/$fileName", Toast.LENGTH_LONG).show()
        } catch (e: Exception) {
            Log.w("AuroraKotlin", "[Settings] export backup failed", e)
            Toast.makeText(this@exportBackup, "导出失败", Toast.LENGTH_SHORT).show()
        }
    }
}
