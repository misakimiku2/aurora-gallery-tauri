package com.aurora.gallery.kotlin

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.IOException
import java.net.URI
import java.net.URLEncoder

/**
 * M6a 阶段 3/5：LAN 客户端数据层（纯 HTTP，无 UI）。阶段 5 补在线元数据/人物/专题
 * 端点（契约 §2/§3/§4；写请求的 body 字段名 snake_case 与 camelCase 混用是契约现状，
 * 逐字对齐不「纠正」）。
 *
 * 协议逐字对齐 `docs/Android/Kotlin版/M6a互联契约定稿.md`（= 桌面服务端现状）：
 *  - token 走 `Authorization: Bearer <token>` header；缩略图/大图例外（`?token=` query）；
 *  - 错误统一 `{"error": ...}` + HTTP 状态码，401 = token 缺失/非法/过期；
 *  - **path 是不透明字符串**（共享根相对路径）——不解析、不规范化、不拼接，原样回传；
 *  - query 编码用 `%20` 形态（URLEncoder 后把 `+` 换 `%20`，对齐 React 的
 *    encodeURIComponent；0.7 spike 实测服务端对 `+` 形态 404）。
 *
 * 全部请求 15s 超时（OkHttpClient 级别配置，见 [LanManager] 构造）。风格对齐
 * GalleryViewModel 的「属性 + suspend + IO」惯例：suspend 函数内 withContext(IO)。
 */

/** HTTP 非 2xx（契约 §7 错误码总表）。[code]==401 时调用方必须立即清 token。 */
class LanHttpException(val code: Int, body: String) :
    IOException("HTTP $code: ${body.take(200)}")

private val JSON_MEDIA = "application/json; charset=utf-8".toMediaType()

/** `POST /api/auth/verify` 响应（200 + `success:false` = 访问码被拒，不映射非 2xx）。 */
data class LanAuthResult(
    val success: Boolean,
    val token: String?,
    /** 服务端会话时长（SESSION 3600s 语义）；客户端不倒计时，仅处理 401。 */
    val expiresIn: Long,
    val serverName: String?,
    val error: String?,
)

/** 远端目录（BrowseItem 的 folder 形态：`size` = 图片数，React imageCount 同口径）。 */
data class LanRemoteFolder(
    val name: String,
    /** 不透明 path，原样保留（browse/缩略图都吃它）。 */
    val path: String,
    val imageCount: Long,
    /**
     * 服务端 `preview_images[0]`（契约 §1 既有字段；阶段 4 顺手解析）：LAN 总览卡片
     * 封面用（对齐 React folderItemToFileNode 的 coverImagePath = previewRemotes[0]）。
     * 服务端不带时为 null，卡片退化为占位底。
     */
    val previewPath: String? = null,
)

/** 远端图片/视频项（BrowseItem 的 file 形态；`type`=="video" 的项阶段 4 网格过滤）。 */
data class LanRemoteImage(
    val name: String,
    val path: String,
    val type: String,
    val size: Long,
)

/** `GET /api/browse` / `GET /api/search` 的响应（两者同形，契约 §1）。 */
data class LanBrowseResult(
    val currentPath: String,
    val folders: List<LanRemoteFolder>,
    val images: List<LanRemoteImage>,
    val allowEdit: Boolean,
    val allowUpload: Boolean,
)

/** `GET /api/all_image_folders` 响应（`root_images` = 共享根级散图，阶段 4 的 `__lan_root_images__`）。 */
data class LanAllFoldersResult(
    val folders: List<LanRemoteFolder>,
    val rootImages: List<LanRemoteImage>,
    val allowEdit: Boolean,
    val allowUpload: Boolean,
)

/** 写操作响应（文件系统级失败也是 200 + `success:false`，契约风格基准）。 */
data class LanOperationResult(
    val success: Boolean,
    val error: String?,
)

// —— M6a 阶段 5：在线元数据 / 人物 / 专题（契约 §2/§3/§4）——

/**
 * 远端元数据行（`POST /api/metadata/batch` 的 item 与 `PUT /api/metadata` 的响应同形，
 * 契约 §2）。[path] 不透明原样保留（契约 §0 铁律）；tags 是**远端桌面**词表口径的词
 * ——只进会话缓存，绝不并入安卓本地词表（D31 数据层铁律）。
 */
data class LanMetadataItem(
    val path: String,
    val tags: List<String>,
    val description: String,
    val sourceUrl: String,
)

/**
 * `PUT /api/metadata` 的 patch（契约 §2.2）：字段 `null` = 不改（JSON 里**省略该字段**，
 * 绝不写 null——服务端把 null 与缺省同看待，但省略是契约明文形态）；[tags] 传空列表 =
 * 显式清空（写 `[]`），与「不改」是两回事。
 */
data class LanMetadataPatch(
    val tags: List<String>? = null,
    val description: String? = null,
    val sourceUrl: String? = null,
)

/**
 * 远端人物（`GET /api/people` 的 item，Person 模型 camelCase 原样序列化，契约 §3）。
 * 只留客户端要用的字段：`coverFileId` 是桌面 file_id（**不解析不使用**，头像走
 * `/api/thumbnail?path=`）；`faceBox`/`updatedAt`/`characterTagIndex` 暂无消费方，同样不解析。
 */
data class LanPerson(
    val id: String,
    val name: String,
    /** 远端库内贴着该人物标签的图片数（Long 对齐 FFI/TagEntry 的计数口径）。 */
    val count: Long,
    val description: String?,
    /** 人物背后的角色标签名（远端词表口径，可 null）。 */
    val characterTagName: String?,
)

/**
 * 远端专题（`GET /api/topics` 的 item，Topic 模型 camelCase 原样序列化，契约 §4）。
 * `fileIds` 恒为 `[]` 不解析（成员走关联表懒加载），数量看 [fileCount]。
 */
data class LanTopic(
    val id: String,
    val parentId: String?,
    val name: String,
    val description: String?,
    val fileCount: Long,
)

/** 成员调整响应（`POST /api/topic/members` 与 DELETE 单成员；[fileCount] = 调整后该专题的缓存成员数）。 */
data class LanTopicMembersResult(
    val success: Boolean,
    val fileCount: Long,
)

/**
 * LAN HTTP 客户端。方法参数显式传 base/token（不持可变连接态——状态归 [LanManager]）。
 * [base] 形如 `http://192.168.31.87:8080`（无尾斜杠，调用方归一化）。
 */
class LanClient(private val http: OkHttpClient) {

    /** 认证换 token。body 字段名 `code`（0.7 spike 实测，不是 access_code）。 */
    suspend fun verify(base: String, code: String, deviceName: String, deviceId: String): LanAuthResult =
        withContext(Dispatchers.IO) {
            val body = JSONObject()
                .put("code", code)
                .put("device_name", deviceName)
                .put("device_id", deviceId)
            val req = Request.Builder()
                .url("$base/api/auth/verify")
                .post(body.toString().toRequestBody(JSON_MEDIA))
                .build()
            http.newCall(req).execute().use { resp ->
                val text = resp.body?.string().orEmpty()
                if (!resp.isSuccessful) throw LanHttpException(resp.code, text)
                val json = JSONObject(text)
                LanAuthResult(
                    success = json.optBoolean("success"),
                    token = json.optString("token").takeIf { it.isNotEmpty() },
                    expiresIn = json.optLong("expires_in", 0L),
                    serverName = json.optString("server_name").takeIf { it.isNotEmpty() },
                    error = json.optString("error").takeIf { it.isNotEmpty() },
                )
            }
        }

    /** 浏览远端目录。[path] 原样进 query，不做任何加工。 */
    suspend fun browse(base: String, token: String, path: String): LanBrowseResult =
        parseBrowse(getJson(base, token, "/api/browse?path=${lanQueryEncode(path)}"))

    /** 搜索（契约 §1：`GET /api/search?q=&scope=`，响应与 browse 同形）。 */
    suspend fun search(base: String, token: String, query: String, scope: String? = null): LanBrowseResult {
        var path = "/api/search?q=${lanQueryEncode(query)}"
        if (!scope.isNullOrBlank()) path += "&scope=${lanQueryEncode(scope)}"
        return parseBrowse(getJson(base, token, path))
    }

    /** 全部含图目录 + 根级散图（侧栏网络 Section / 阶段 4 LAN 总览的数据源）。 */
    suspend fun allImageFolders(base: String, token: String): LanAllFoldersResult =
        withContext(Dispatchers.IO) {
            val json = getJson(base, token, "/api/all_image_folders")
            LanAllFoldersResult(
                folders = parseFolders(json.optJSONArray("folders")),
                rootImages = parseItems(json.optJSONArray("root_images")),
                allowEdit = json.optBoolean("allow_edit"),
                allowUpload = json.optBoolean("allow_upload"),
            )
        }

    /** 心跳（保持服务端设备在线判定；失败/401 由 LanManager 计数处理）。 */
    suspend fun heartbeat(base: String, token: String) {
        getJson(base, token, "/api/heartbeat")
    }

    /** 登出（清理链路第一步；会话多半已无效，失败由调用方忽略）。 */
    suspend fun logout(base: String, token: String) {
        withContext(Dispatchers.IO) {
            val req = Request.Builder()
                .url("$base/api/auth/logout")
                .header("Authorization", "Bearer $token")
                .post(ByteArray(0).toRequestBody(null))
                .build()
            http.newCall(req).execute().use { resp ->
                val text = resp.body?.string().orEmpty()
                if (!resp.isSuccessful) throw LanHttpException(resp.code, text)
            }
        }
    }

    /**
     * 上传（multipart，字段 `file` + `target_dir`，契约 §1）。阶段 4 才有 UI 入口，
     * 数据层先就位。contentLength 由 okhttp 自动带。
     */
    suspend fun upload(
        base: String,
        token: String,
        fileName: String,
        mimeType: String,
        bytes: ByteArray,
        targetDir: String,
    ): LanOperationResult = withContext(Dispatchers.IO) {
        val body = MultipartBody.Builder()
            .setType(MultipartBody.FORM)
            .addFormDataPart("file", fileName, bytes.toRequestBody(mimeType.toMediaType()))
            .addFormDataPart("target_dir", targetDir)
            .build()
        val req = Request.Builder()
            .url("$base/api/upload")
            .header("Authorization", "Bearer $token")
            .post(body)
            .build()
        http.newCall(req).execute().use { resp ->
            val text = resp.body?.string().orEmpty()
            if (resp.code == 401) throw LanHttpException(401, text)
            if (!resp.isSuccessful) throw LanHttpException(resp.code, text)
            val json = JSONObject(text)
            LanOperationResult(
                success = json.optBoolean("success"),
                error = json.optString("error").takeIf { it.isNotEmpty() },
            )
        }
    }

    // —— M6a 阶段 5：在线元数据 / 人物 / 专题（契约 §2/§3/§4；写端点吃 allow_edit 门禁）——

    /**
     * 批量读元数据（契约 §2.1）：响应 `items` 与 [paths] **同序同数量**（查无元数据的
     * path 给空默认项，绝不因个别 path 失败整批报错——服务端口径）。
     */
    suspend fun metadataBatch(base: String, token: String, paths: List<String>): List<LanMetadataItem> {
        val body = JSONObject().put("paths", org.json.JSONArray(paths))
        val json = sendJson(base, token, "POST", "/api/metadata/batch", body)
        return parseMetadataItems(json.optJSONArray("items"))
    }

    /**
     * 单文件整行读改写（契约 §2.2）：[patch] 里非 null 的字段才进 JSON（省略 = 不改）。
     * 响应 200 = 更新后的完整条目（裸对象无包装）；400 = JSON 非法 / path 越出共享根，
     * 403 = allow_edit 门禁关闭，均抛 [LanHttpException]。
     */
    suspend fun putMetadata(base: String, token: String, path: String, patch: LanMetadataPatch): LanMetadataItem {
        val patchJson = JSONObject()
            .putOpt("tags", patch.tags?.let { org.json.JSONArray(it) })
            .putOpt("description", patch.description)
            .putOpt("source_url", patch.sourceUrl)
        val body = JSONObject().put("path", path).put("patch", patchJson)
        return parseMetadataItem(sendJson(base, token, "PUT", "/api/metadata", body))
    }

    /** 全部远端人物（契约 §3.1；`coverFileId` 桌面 file_id 不解析，见 [LanPerson]）。 */
    suspend fun people(base: String, token: String): List<LanPerson> {
        val json = getJson(base, token, "/api/people")
        return parsePeople(json.optJSONArray("people"))
    }

    /**
     * 重命名 / 换头像 / 改描述远端人物（契约 §3.2，整行读改写）。除 [id] 外只写非 null
     * 字段；[avatarPath] 是共享根相对 path（**不是** file_id，字段名契约现状就是 snake_case
     * 的 `avatar_path`）。响应 = 更新后的裸 Person；404 = 人物 id 不存在（自然抛 [LanHttpException]）。
     */
    suspend fun putPerson(
        base: String,
        token: String,
        id: String,
        name: String?,
        avatarPath: String?,
        description: String?,
    ): LanPerson {
        val body = JSONObject()
            .put("id", id)
            .putOpt("name", name)
            .putOpt("avatar_path", avatarPath)
            .putOpt("description", description)
        return parsePerson(sendJson(base, token, "PUT", "/api/person", body))
    }

    /** 全部远端专题（契约 §4.1；`fileIds` 恒为 `[]` 不解析，数量看 [LanTopic.fileCount]）。 */
    suspend fun topics(base: String, token: String): List<LanTopic> {
        val json = getJson(base, token, "/api/topics")
        return parseTopics(json.optJSONArray("topics"))
    }

    /** 建专题（契约 §4.2）：响应 = 新建后的完整 Topic 裸对象（id 服务端生成）。 */
    suspend fun createTopic(base: String, token: String, name: String, description: String?): LanTopic {
        val body = JSONObject()
            .put("name", name)
            .putOpt("description", description)
            .put("parent_id", JSONObject.NULL)
        return parseTopic(sendJson(base, token, "POST", "/api/topic", body))
    }

    /** 删专题（契约 §4.3）：query 传 id（与 `DELETE /api/file?path=` 的 query 风格一致）。 */
    suspend fun deleteTopic(base: String, token: String, id: String): LanOperationResult {
        val json = deleteJson(base, token, "/api/topic?id=${lanQueryEncode(id)}")
        return LanOperationResult(
            success = json.optBoolean("success"),
            error = json.optString("error").takeIf { it.isNotEmpty() },
        )
    }

    /**
     * 归属调整·增（契约 §4.4）：两个数组**至少一个非空是调用方责任**（都空是服务端 400；
     * 这里两数组恒带，空数组就是空数组，不省略字段）。
     */
    suspend fun addTopicMembers(
        base: String,
        token: String,
        topicId: String,
        paths: List<String>,
        peopleIds: List<String>,
    ): LanTopicMembersResult {
        val body = JSONObject()
            .put("topic_id", topicId)
            .put("paths", org.json.JSONArray(paths))
            .put("people_ids", org.json.JSONArray(peopleIds))
        return parseTopicMembersResult(sendJson(base, token, "POST", "/api/topic/members", body))
    }

    /** 归属调整·删单文件成员（契约 §4.5 的 `path` 形态，query 二选一）。 */
    suspend fun removeTopicMemberFile(base: String, token: String, topicId: String, path: String): LanTopicMembersResult =
        parseTopicMembersResult(
            deleteJson(
                base, token,
                "/api/topic/members?topic_id=${lanQueryEncode(topicId)}&path=${lanQueryEncode(path)}",
            ),
        )

    /** 归属调整·删单人物成员（契约 §4.5 的 `people_id` 形态）。 */
    suspend fun removeTopicMemberPerson(base: String, token: String, topicId: String, peopleId: String): LanTopicMembersResult =
        parseTopicMembersResult(
            deleteJson(
                base, token,
                "/api/topic/members?topic_id=${lanQueryEncode(topicId)}&people_id=${lanQueryEncode(peopleId)}",
            ),
        )

    // —— URL 拼接（token 进 query，缩略图/大图专用；Coil 的 URL 模型需要）——

    fun thumbnailUrl(base: String, token: String, remotePath: String, size: Int = 256): String =
        "$base/api/thumbnail?path=${lanQueryEncode(remotePath)}&size=$size&token=${lanQueryEncode(token)}"

    fun imageUrl(base: String, token: String, remotePath: String): String =
        "$base/api/image?path=${lanQueryEncode(remotePath)}&token=${lanQueryEncode(token)}"

    /**
     * 便捷方法（阶段 4「保存到设备」/缩略图磁盘分支共用）：GET 一个**完整 URL** 并返回
     * 原始字节。缩略图/大图 URL 自带 token in query（见上），不需要 header；URL 由
     * [thumbnailUrl]/[imageUrl] 拼出，调用方不自己拼。
     */
    suspend fun fetchBytes(url: String): ByteArray = withContext(Dispatchers.IO) {
        val req = Request.Builder().url(url).get().build()
        http.newCall(req).execute().use { resp ->
            if (!resp.isSuccessful) {
                throw LanHttpException(resp.code, resp.body?.string().orEmpty())
            }
            resp.body?.bytes() ?: ByteArray(0)
        }
    }

    // —— 内部 ——

    private suspend fun getJson(base: String, token: String, urlPath: String): JSONObject =
        withContext(Dispatchers.IO) {
            val req = Request.Builder()
                .url("$base$urlPath")
                .header("Authorization", "Bearer $token")
                .get()
                .build()
            http.newCall(req).execute().use { resp ->
                val text = resp.body?.string().orEmpty()
                if (!resp.isSuccessful) throw LanHttpException(resp.code, text)
                JSONObject(text)
            }
        }

    /** POST/PUT 一个 JSON body 并解析 JSON 响应（401/非 2xx 统一抛 [LanHttpException]，[getJson] 同款）。 */
    private suspend fun sendJson(base: String, token: String, method: String, urlPath: String, body: JSONObject): JSONObject =
        withContext(Dispatchers.IO) {
            val req = Request.Builder()
                .url("$base$urlPath")
                .header("Authorization", "Bearer $token")
                .method(method, body.toString().toRequestBody(JSON_MEDIA))
                .build()
            http.newCall(req).execute().use { resp ->
                val text = resp.body?.string().orEmpty()
                if (!resp.isSuccessful) throw LanHttpException(resp.code, text)
                JSONObject(text)
            }
        }

    /** DELETE（无请求体，参数走 query）并解析 JSON 响应；错误口径同 [getJson]。 */
    private suspend fun deleteJson(base: String, token: String, urlPath: String): JSONObject =
        withContext(Dispatchers.IO) {
            val req = Request.Builder()
                .url("$base$urlPath")
                .header("Authorization", "Bearer $token")
                .method("DELETE", null)
                .build()
            http.newCall(req).execute().use { resp ->
                val text = resp.body?.string().orEmpty()
                if (!resp.isSuccessful) throw LanHttpException(resp.code, text)
                JSONObject(text)
            }
        }

    private fun parseMetadataItems(arr: org.json.JSONArray?): List<LanMetadataItem> {
        arr ?: return emptyList()
        return (0 until arr.length()).mapNotNull { i -> arr.optJSONObject(i)?.let(::parseMetadataItem) }
    }

    private fun parseMetadataItem(o: JSONObject): LanMetadataItem = LanMetadataItem(
        path = o.optString("path"),
        tags = o.optJSONArray("tags")?.let { a -> (0 until a.length()).map { a.optString(it) } } ?: emptyList(),
        description = o.optString("description"),
        sourceUrl = o.optString("source_url"),
    )

    private fun parsePeople(arr: org.json.JSONArray?): List<LanPerson> {
        arr ?: return emptyList()
        return (0 until arr.length()).mapNotNull { i ->
            arr.optJSONObject(i)?.takeIf { it.optString("id").isNotEmpty() }?.let(::parsePerson)
        }
    }

    private fun parsePerson(o: JSONObject): LanPerson = LanPerson(
        id = o.optString("id"),
        name = o.optString("name"),
        count = o.optLong("count", 0L),
        description = o.optString("description").takeIf { it.isNotEmpty() },
        characterTagName = o.optString("characterTagName").takeIf { it.isNotEmpty() },
    )

    private fun parseTopics(arr: org.json.JSONArray?): List<LanTopic> {
        arr ?: return emptyList()
        return (0 until arr.length()).mapNotNull { i ->
            arr.optJSONObject(i)?.takeIf { it.optString("id").isNotEmpty() }?.let(::parseTopic)
        }
    }

    private fun parseTopic(o: JSONObject): LanTopic = LanTopic(
        id = o.optString("id"),
        parentId = o.optString("parentId").takeIf { it.isNotEmpty() },
        name = o.optString("name"),
        description = o.optString("description").takeIf { it.isNotEmpty() },
        fileCount = o.optLong("fileCount", 0L),
    )

    private fun parseTopicMembersResult(json: JSONObject): LanTopicMembersResult = LanTopicMembersResult(
        success = json.optBoolean("success"),
        fileCount = json.optLong("file_count", 0L),
    )

    private fun parseBrowse(json: JSONObject): LanBrowseResult = LanBrowseResult(
        currentPath = json.optString("current_path"),
        folders = parseFolders(json.optJSONArray("folders")),
        images = parseItems(json.optJSONArray("images")),
        allowEdit = json.optBoolean("allow_edit"),
        allowUpload = json.optBoolean("allow_upload"),
    )

    private fun parseFolders(arr: org.json.JSONArray?): List<LanRemoteFolder> {
        arr ?: return emptyList()
        return (0 until arr.length()).mapNotNull { i ->
            val o = arr.optJSONObject(i) ?: return@mapNotNull null
            val name = o.optString("name")
            val path = o.optString("path")
            if (name.isEmpty() || path.isEmpty()) return@mapNotNull null
            LanRemoteFolder(
                name = name,
                path = path,
                imageCount = o.optLong("size", 0L),
                previewPath = o.optJSONArray("preview_images")?.optString(0)?.takeIf { it.isNotEmpty() },
            )
        }
    }

    private fun parseItems(arr: org.json.JSONArray?): List<LanRemoteImage> {
        arr ?: return emptyList()
        return (0 until arr.length()).mapNotNull { i ->
            val o = arr.optJSONObject(i) ?: return@mapNotNull null
            val path = o.optString("path")
            if (path.isEmpty()) return@mapNotNull null
            LanRemoteImage(
                name = o.optString("name"),
                path = path,
                type = o.optString("type", "image"),
                size = o.optLong("size", 0L),
            )
        }
    }
}

/**
 * query 编码（0.7 spike 的 queryEncode 逻辑原样上移；改名 lanQueryEncode 避开
 * LanSmoke.kt 同包文件内同名私有函数）：URLEncoder 是表单口径（空格→`+`），React
 * 基准用 encodeURIComponent（空格→`%20`）；服务端对 `+` 形态 404（spike 实测），
 * 故统一 replace 成 `%20`。
 */
internal fun lanQueryEncode(raw: String): String =
    URLEncoder.encode(raw, "UTF-8").replace("+", "%20")

/**
 * 二维码 / 手输地址解析（逐条对齐 React `qrParseUtils.ts`，0.2 基准）：
 * 桌面契约 JSON `{"type":"aurora-lan","url":"http://ip:port","code":"4位"}`，
 * 兼容旧版纯 URL（默认端口 [DEFAULT_LAN_PORT]）。
 */
object LanQr {

    const val DEFAULT_LAN_PORT = 8080

    data class Data(val host: String, val port: Int, val code: String?)

    /** JSON 形态优先（type=aurora-lan），不成再按纯 URL 解析；两者都不成返回 null。 */
    fun parse(raw: String): Data? {
        val trimmed = raw.trim()
        if (trimmed.isEmpty()) return null
        if (trimmed.startsWith("{")) {
            val json = runCatching { JSONObject(trimmed) }.getOrNull()
            if (json != null && json.optString("type") == "aurora-lan") {
                val url = json.optString("url")
                if (url.isNotEmpty()) {
                    parseServerUrl(url)?.let { (host, port) ->
                        return Data(host, port, json.optString("code").takeIf { it.isNotEmpty() })
                    }
                }
            }
            // JSON 非法或缺字段：按 qrParseUtils 落到纯 URL 解析
        }
        val (host, port) = parseServerUrl(trimmed) ?: return null
        return Data(host, port, null)
    }

    /** `ip` / `ip:port` / `http(s)://ip[:port]` → host:port（无端口用默认 8080）。 */
    fun parseServerUrl(raw: String): Pair<String, Int>? {
        val trimmed = raw.trim()
        if (trimmed.isEmpty()) return null
        val withScheme =
            if (trimmed.startsWith("http://", ignoreCase = true) ||
                trimmed.startsWith("https://", ignoreCase = true)
            ) trimmed
            else "http://$trimmed"
        val uri = runCatching { URI(withScheme) }.getOrNull() ?: return null
        val host = uri.host?.takeIf { it.isNotEmpty() } ?: return null
        val port = if (uri.port > 0) uri.port else DEFAULT_LAN_PORT
        if (port !in 1..65535) return null
        return host to port
    }
}
