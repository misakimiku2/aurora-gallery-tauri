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

/**
 * 认证时上报的本机对等服务端信息（M6a 阶段 7 双向连接融合）：随 `verify` 的
 * `peer_server` 字段带给桌面端，桌面收到后自动反向连接本机——React
 * lanClientApi.authenticate 的 peerServer 参数同款。body 字段名是 snake_case 的
 * `peer_server`/`access_code`（契约现状，逐字对齐不「纠正」）。
 */
data class LanPeerServer(val port: Int, val accessCode: String)

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
     *
     * 2026-10 协议扩展：browse/all_image_folders 带 `sort_by`/`sort_dir` 时，
     * 服务端按该口径从直接子图里选第一张（卡片封面随排序变化）；缺省（旧服务端）
     * 维持历史口径（modified DESC / 名称序，两接口历史上不同）。
     */
    val previewPath: String? = null,
    /**
     * 服务端 `latest_created_at`（2026-10 协议扩展）：**直接子图** MAX(created_at)
     * （秒级，不递归嵌套；无直接子图或旧服务端 = 0 = 无日期，sortFolders 恒排最后）。
     * 「按时间排序 = 内容最新」的数据源，对齐本地 list_folders 的 Folder.createdAt。
     */
    val latestCreatedAt: Long = 0,
)

/** 远端图片/视频项（BrowseItem 的 file 形态；`type`=="video" 的项阶段 4 网格过滤）。 */
data class LanRemoteImage(
    val name: String,
    val path: String,
    val type: String,
    val size: Long,
    /**
     * 服务端 `created_at`（2026-10 协议扩展，秒级；缺省/旧服务端 = 0 = 无日期）。
     * 0 语义与本地一致：查看器抽屉显示「—」、日期分组落 Unknown、DATE 排序按无日期。
     */
    val createdAt: Long = 0,
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

/** rename 响应（成功时 [newPath] = 新共享根相对路径；FS 级失败 200+success:false）。 */
data class LanRenameResult(val success: Boolean, val newPath: String?, val error: String?)

/** move/copy 批量结果的 item（与请求 paths 同序一一对应；copy 重名自动改名）。 */
data class LanFileOpItem(val path: String, val success: Boolean, val newPath: String?, val error: String?)

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
    /** 全量来源网址（P1(b) 多值）。服务端旧版不返回该字段时按 [sourceUrl] 兜成一条。 */
    val sourceUrls: List<String> = emptyList(),
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
    /**
     * 多值来源网址（整体覆盖语义）。**给了它就以它为准**：只发 `source_urls`，
     * 不再发 `source_url`（服务端同时收到时以多值为准，两个都发是废话）。
     * 空列表 = 显式清空——与 `null`（不改）是两回事。
     */
    val sourceUrls: List<String>? = null,
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

// —— M6b 阶段 4/5：AI 视觉计算端点（D36/D37）+ D40 读端点（契约 §8）——

/**
 * WD14 单个角色标签命中（契约 §8.1 `character_tags` 的 item）：[work] = 服务端
 * `extract_work_name` 归组出的作品名（无归组 null）。
 */
data class Wd14CharacterTag(val tag: String, val score: Double, val work: String?)

/**
 * `POST /api/ai/wd14/classify` 响应（契约 §8.1）：阈值服务端固定 0.1，客户端不二次
 * 过滤；两列都由服务端按概率降序排好。
 */
data class Wd14Classification(
    /** category==0 的普通标签。 */
    val generalTags: List<String>,
    /** category==4 的角色标签。 */
    val characterTags: List<Wd14CharacterTag>,
)

/** CLIP 检索单条命中（契约 §8.2/8.3；[path] 不透明原样保留——§0 身份铁律同款）。 */
data class LanClipHit(val path: String, val score: Double)

/**
 * `GET /api/topic/members` 响应（契约 §8.4，D40 读端点）：[files] = 成员文件 path、
 * [people] = 成员人物 id——topic_files / topic_people 关联表的读半边。注意与写响应
 * [LanTopicMembersResult] 是两个形状（那边是 success + file_count）。
 */
data class LanTopicMembers(val files: List<String>, val people: List<String>)

/**
 * LAN HTTP 客户端。方法参数显式传 base/token（不持可变连接态——状态归 [LanManager]）。
 * [base] 形如 `http://192.168.31.87:8080`（无尾斜杠，调用方归一化）。
 */
class LanClient(private val http: OkHttpClient) {

    /**
     * 认证换 token。body 字段名 `code`（0.7 spike 实测，不是 access_code）。
     * [peerServer] 非 null 时 body 多带 `peer_server`（本机对等服务端信息，M6a 阶段 7
     * 双向连接融合；putOpt 风格，null 即省略该字段）。
     */
    suspend fun verify(
        base: String,
        code: String,
        deviceName: String,
        deviceId: String,
        peerServer: LanPeerServer? = null,
    ): LanAuthResult =
        withContext(Dispatchers.IO) {
            val body = JSONObject()
                .put("code", code)
                .put("device_name", deviceName)
                .put("device_id", deviceId)
                .putOpt(
                    "peer_server",
                    peerServer?.let {
                        JSONObject().put("port", it.port).put("access_code", it.accessCode)
                    },
                )
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

    /**
     * 浏览远端目录。[path] 原样进 query，不做任何加工。
     *
     * [sortBy]/[sortDir]（2026-10 协议扩展，可省略）：服务端排序口径 `name|date|size`
     * 与 `asc|desc`——带上时 folder 的 preview_images[0] 按该口径选（封面随排序）；
     * 省略时与旧服务端行为完全一致。image 项的 `created_at` 无论是否带参都会返回
     * （新服务端），旧服务端不带 → createdAt=0 无日期兜底。
     */
    suspend fun browse(
        base: String,
        token: String,
        path: String,
        sortBy: String? = null,
        sortDir: String? = null,
    ): LanBrowseResult =
        parseBrowse(getJson(base, token, buildBrowseQuery("/api/browse", listOf("path" to lanQueryEncode(path)), sortBy, sortDir)))

    /** 搜索（契约 §1：`GET /api/search?q=&scope=`，响应与 browse 同形）。 */
    suspend fun search(base: String, token: String, query: String, scope: String? = null): LanBrowseResult {
        var path = "/api/search?q=${lanQueryEncode(query)}"
        if (!scope.isNullOrBlank()) path += "&scope=${lanQueryEncode(scope)}"
        return parseBrowse(getJson(base, token, path))
    }

    /**
     * 全部含图目录 + 根级散图（侧栏网络 Section / 阶段 4 LAN 总览的数据源）。
     * [sortBy]/[sortDir] 语义同 [browse]（2026-10 协议扩展）。
     */
    suspend fun allImageFolders(
        base: String,
        token: String,
        sortBy: String? = null,
        sortDir: String? = null,
    ): LanAllFoldersResult =
        withContext(Dispatchers.IO) {
            val json = getJson(base, token, buildBrowseQuery("/api/all_image_folders", emptyList(), sortBy, sortDir))
            LanAllFoldersResult(
                folders = parseFolders(json.optJSONArray("folders")),
                rootImages = parseItems(json.optJSONArray("root_images")),
                allowEdit = json.optBoolean("allow_edit"),
                allowUpload = json.optBoolean("allow_upload"),
            )
        }

    /** browse/all_image_folders 的 query 串：[pairs] 基础参数 + 可选 sort_by/sort_dir。 */
    private fun buildBrowseQuery(
        endpoint: String,
        pairs: List<Pair<String, String>>,
        sortBy: String?,
        sortDir: String?,
    ): String {
        var query = pairs.joinToString("&") { (k, v) -> "$k=$v" }
        if (query.isNotEmpty()) query = "?$query"
        if (!sortBy.isNullOrBlank()) query += "${if (query.isEmpty()) "?" else "&"}sort_by=${lanQueryEncode(sortBy)}"
        if (!sortDir.isNullOrBlank()) query += "${if (query.isEmpty()) "?" else "&"}sort_dir=${lanQueryEncode(sortDir)}"
        return "$endpoint$query"
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
        // 多值优先：给了 source_urls 就只发它（服务端以多值为准）；只给单值时发旧的
        // source_url（服务端按「覆盖成只有这一条」处理）。putOpt 遇 null 不写该键。
        if (patch.sourceUrls != null) {
            patchJson.putOpt("source_urls", org.json.JSONArray(patch.sourceUrls))
        } else {
            patchJson.putOpt("source_url", patch.sourceUrl)
        }
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

    // —— M6a 阶段 6：互联态文件操作（契约 §1 rename/delete / §5 move/copy；全吃 allow_edit 门禁）——

    /**
     * 同目录改名（契约 §1）：[newName] 是**裸文件名**，目录由服务端自己拼——path 是不透明
     * 字符串，客户端不解析不拼接。403 = allow_edit 门禁关闭、404 = 源不存在、409 = 目标
     * 重名，均抛 [LanHttpException]；**文件系统级失败也是 200**（success=false + error，
     * 调用方两种形态都要判）。成功时 [LanRenameResult.newPath] = 新共享根相对路径：
     * rename 后 file_id 必变，调用方以新 path 刷新缓存（path 身份铁律，契约 §0）。
     */
    suspend fun rename(base: String, token: String, oldPath: String, newName: String): LanRenameResult {
        val body = JSONObject().put("old_path", oldPath).put("new_name", newName)
        val json = sendJson(base, token, "POST", "/api/rename", body)
        return LanRenameResult(
            success = json.optBoolean("success"),
            // optString 空串归 null：失败形态没有 path 字段，成功形态必带
            newPath = json.optString("path").takeIf { it.isNotEmpty() },
            error = json.optString("error").takeIf { it.isNotEmpty() },
        )
    }

    /**
     * 删远端文件（契约 §1）：query 传 path（与 [deleteTopic] 同风格）。403 = 门禁关闭、
     * 404 = 文件不存在，均抛 [LanHttpException]；FS 级失败（占用/权限等）200 + success=false。
     */
    suspend fun deleteFile(base: String, token: String, path: String): LanOperationResult {
        val json = deleteJson(base, token, "/api/file?path=${lanQueryEncode(path)}")
        return LanOperationResult(
            success = json.optBoolean("success"),
            error = json.optString("error").takeIf { it.isNotEmpty() },
        )
    }

    /**
     * 批量移动进 [targetDir]（契约 §5.1；body 字段 `paths`/`target_dir` 的 snake_case 是
     * 契约现状，不「纠正」）。响应 `items` 与 [paths] 同序一一对应：目标已存在该项失败
     * （服务端不覆盖不自动改名）、源不存在也是 item 级失败——但 **target_dir 不存在是
     * 整个请求 404**（连同 401/403 抛 [LanHttpException]），与 item 级失败是两种形态，
     * 调用方分开处理。成功项 new_path = target_dir/原文件名。
     */
    suspend fun moveFiles(base: String, token: String, paths: List<String>, targetDir: String): List<LanFileOpItem> {
        val body = JSONObject()
            .put("paths", org.json.JSONArray(paths))
            .put("target_dir", targetDir)
        return parseFileOpItems(sendJson(base, token, "POST", "/api/file/move", body))
    }

    /**
     * 批量复制进 [targetDir]（契约 §5.2）：与 [moveFiles] 同形，差异在冲突语义——重名
     * **自动改名**（name_copy.ext / name_copy2.ext），new_path = 实际落盘路径（元数据随
     * copy 迁移，副本在桌面库带原 tags）。
     */
    suspend fun copyFiles(base: String, token: String, paths: List<String>, targetDir: String): List<LanFileOpItem> {
        val body = JSONObject()
            .put("paths", org.json.JSONArray(paths))
            .put("target_dir", targetDir)
        return parseFileOpItems(sendJson(base, token, "POST", "/api/file/copy", body))
    }

    // —— M6b 阶段 4/5：AI 视觉计算端点（D36/D37）+ D40 读端点（契约 §8）——
    //
    // 全部为纯计算/纯查询（§8.0）：图片字节过桌面内存可以、落桌面库不行，也不触发
    // data-changed。§8.1–8.3 不受 allow_edit/allow_upload 门禁；503（模型未下载/加载
    // 失败/嵌入索引不存在）走统一错误形态 `{"error": ...}`，直接抛 [LanHttpException]
    // ——调用方读 code==503 提示「桌面端模型/索引未就绪」。

    /**
     * WD14 标签推理（契约 §8.1）：multipart 单文件字段 `file`（对齐 [upload] 先例），
     * 服务端写系统临时目录喂模型、用后即删（契约 §8 临时文件例外，不算落库）。
     * [fileName]/[mimeType] 只进 multipart 头（服务端按字节喂模型，名字无语义）。
     * 503 = WD14 模型未就绪（需桌面 AI 视觉面板下载并生成过模型文件）。
     */
    suspend fun wd14Classify(
        base: String,
        token: String,
        bytes: ByteArray,
        fileName: String = "image.jpg",
        mimeType: String = "image/jpeg",
    ): Wd14Classification = withContext(Dispatchers.IO) {
        val body = MultipartBody.Builder()
            .setType(MultipartBody.FORM)
            .addFormDataPart("file", fileName, bytes.toRequestBody(mimeType.toMediaType()))
            .build()
        val req = Request.Builder()
            .url("$base/api/ai/wd14/classify")
            .header("Authorization", "Bearer $token")
            .post(body)
            .build()
        http.newCall(req).execute().use { resp ->
            val text = resp.body?.string().orEmpty()
            if (!resp.isSuccessful) throw LanHttpException(resp.code, text)
            val json = JSONObject(text)
            Wd14Classification(
                generalTags = stringList(json.optJSONArray("general_tags")),
                characterTags = parseWd14CharacterTags(json.optJSONArray("character_tags")),
            )
        }
    }

    /**
     * CLIP 文本语义搜索（契约 §8.2）：响应 `hits` 服务端已按 score 降序、截断至
     * [maxResults]（缺省 100，上限 500）。503 = 当前库无嵌入索引 / 模型加载失败。
     */
    suspend fun clipSearchText(
        base: String,
        token: String,
        query: String,
        minScore: Double = 0.2,
        maxResults: Int = 100,
    ): List<LanClipHit> {
        val body = JSONObject()
            .put("query", query)
            .put("min_score", minScore)
            .put("max_results", maxResults)
        val json = sendJson(base, token, "POST", "/api/ai/clip/search_text", body)
        return parseClipHits(json.optJSONArray("hits"))
    }

    /**
     * CLIP 以图搜图（契约 §8.3）：multipart 字段 `file`（对齐 [wd14Classify]）；查询
     * 向量服务端**不入**嵌入索引（纯计算）。响应与 [clipSearchText] 同形，503 同口径。
     */
    suspend fun clipSearchImage(
        base: String,
        token: String,
        bytes: ByteArray,
        fileName: String = "image.jpg",
        mimeType: String = "image/jpeg",
    ): List<LanClipHit> = withContext(Dispatchers.IO) {
        val body = MultipartBody.Builder()
            .setType(MultipartBody.FORM)
            .addFormDataPart("file", fileName, bytes.toRequestBody(mimeType.toMediaType()))
            .build()
        val req = Request.Builder()
            .url("$base/api/ai/clip/search_image")
            .header("Authorization", "Bearer $token")
            .post(body)
            .build()
        http.newCall(req).execute().use { resp ->
            val text = resp.body?.string().orEmpty()
            if (!resp.isSuccessful) throw LanHttpException(resp.code, text)
            parseClipHits(JSONObject(text).optJSONArray("hits"))
        }
    }

    /** 专题成员枚举（契约 §8.4）：关联表直读，404 = 专题不存在（抛 [LanHttpException]）。 */
    suspend fun topicMembers(base: String, token: String, topicId: String): LanTopicMembers {
        val json = getJson(base, token, "/api/topic/members?topic_id=${lanQueryEncode(topicId)}")
        return LanTopicMembers(
            files = stringList(json.optJSONArray("files")),
            people = stringList(json.optJSONArray("people")),
        )
    }

    /**
     * 人物图片列表（契约 §8.5）：`paths` = 关联该人物的文件 path（空关联 → 200 空数组；
     * 404 = 人物不存在抛 [LanHttpException]）。
     */
    suspend fun peopleMembers(base: String, token: String, personId: String): List<String> {
        val json = getJson(base, token, "/api/people/members?person_id=${lanQueryEncode(personId)}")
        return stringList(json.optJSONArray("paths"))
    }

    /** 桌面词表读（契约 §8.6）：`tags` = 桌面 customTags，与安卓本地词表两套不混、只读作建议。 */
    suspend fun vocab(base: String, token: String): List<String> {
        val json = getJson(base, token, "/api/vocab")
        return stringList(json.optJSONArray("tags"))
    }

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

    /** JSON 字符串数组 → List<String>（缺省/非数组回空表）。 */
    private fun stringList(arr: org.json.JSONArray?): List<String> {
        arr ?: return emptyList()
        return (0 until arr.length()).map { arr.optString(it) }
    }

    /** WD14 `character_tags`（契约 §8.1：tag/score/work；work 空串归 null）。 */
    private fun parseWd14CharacterTags(arr: org.json.JSONArray?): List<Wd14CharacterTag> {
        arr ?: return emptyList()
        return (0 until arr.length()).mapNotNull { i ->
            arr.optJSONObject(i)?.let { o ->
                Wd14CharacterTag(
                    tag = o.optString("tag"),
                    score = o.optDouble("score", 0.0),
                    work = o.optString("work").takeIf { it.isNotEmpty() },
                )
            }
        }
    }

    /** CLIP 检索 `hits`（契约 §8.2：服务端按 score 降序返回；path 缺失的畸形项跳过）。 */
    private fun parseClipHits(arr: org.json.JSONArray?): List<LanClipHit> {
        arr ?: return emptyList()
        return (0 until arr.length()).mapNotNull { i ->
            val o = arr.optJSONObject(i) ?: return@mapNotNull null
            val path = o.optString("path")
            if (path.isEmpty()) return@mapNotNull null
            LanClipHit(path = path, score = o.optDouble("score", 0.0))
        }
    }

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
        sourceUrls = o.optJSONArray("source_urls")
            ?.let { a -> (0 until a.length()).map { a.optString(it) }.filter { it.isNotBlank() } }
            ?: o.optString("source_url").takeIf { it.isNotBlank() }?.let(::listOf)
            ?: emptyList(),
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

    /** move/copy 响应的 `items`（契约 §5：与请求同序一一对应，逐项带 success/new_path/error）。 */
    private fun parseFileOpItems(json: JSONObject): List<LanFileOpItem> {
        val arr = json.optJSONArray("items") ?: return emptyList()
        return (0 until arr.length()).mapNotNull { i ->
            arr.optJSONObject(i)?.let { o ->
                LanFileOpItem(
                    path = o.optString("path"),
                    success = o.optBoolean("success"),
                    newPath = o.optString("new_path").takeIf { it.isNotEmpty() },
                    error = o.optString("error").takeIf { it.isNotEmpty() },
                )
            }
        }
    }

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
                // 2026-10 协议扩展：直接子图最新创建时间（旧服务端缺省 0 = 无日期）
                latestCreatedAt = o.optLong("latest_created_at", 0L),
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
                // 2026-10 协议扩展：图片创建时间（旧服务端缺省 0 = 无日期）
                createdAt = o.optLong("created_at", 0L),
            )
        }
    }
}

/**
 * query 编码（0.7 spike 的 queryEncode 逻辑原样上移；lanQueryEncode 命名自
 * spike 冒烟件 LanSmoke.kt——该文件已随阶段 8 销账删除，函数名保留）：URLEncoder 是表单口径（空格→`+`），React
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
