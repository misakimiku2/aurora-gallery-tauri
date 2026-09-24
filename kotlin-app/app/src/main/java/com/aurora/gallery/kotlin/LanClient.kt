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
 * M6a 阶段 3：LAN 客户端数据层（纯 HTTP，无 UI）。
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

    // —— URL 拼接（token 进 query，缩略图/大图专用；Coil 的 URL 模型需要）——

    fun thumbnailUrl(base: String, token: String, remotePath: String, size: Int = 256): String =
        "$base/api/thumbnail?path=${lanQueryEncode(remotePath)}&size=$size&token=${lanQueryEncode(token)}"

    fun imageUrl(base: String, token: String, remotePath: String): String =
        "$base/api/image?path=${lanQueryEncode(remotePath)}&token=${lanQueryEncode(token)}"

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
            LanRemoteFolder(name = name, path = path, imageCount = o.optLong("size", 0L))
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
