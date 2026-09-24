package com.aurora.gallery.kotlin

import android.content.Context
import android.util.Log
import fi.iki.elonen.NanoHTTPD
import fi.iki.elonen.NanoHTTPD.IHTTPSession
import fi.iki.elonen.NanoHTTPD.Method
import fi.iki.elonen.NanoHTTPD.Response
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.util.UUID

/**
 * M6a 阶段 7：对等服务端 HTTP 引擎（NanoHTTPD 子类，路由 + 鉴权 + CORS）。
 *
 * 行为逐条对齐 `src-tauri/src/android/server/handlers.rs`（React 安卓版基准，逐字对齐不自创）：
 *  - 只有 10 个 API 端点 + 根路径信息，**无任何写文件端点**（MediaStore 只读，协议现状）；
 *  - 错误统一 `{"error": "<msg>"}` + 对应状态码；auth 访问码被拒是 **200 + success:false**
 *    （不映射 401！Rust 同款——401 只出现在 token 缺失/非法/过期）；
 *  - 缩略图/大图 token 双通道（`Authorization: Bearer` 优先，`?token=` 回退，对齐
 *    extract_token_with_fallback）；其余 JSON 端点 Bearer 必需；
 *  - browse / all_image_folders 必须带 `allow_edit:false`/`allow_upload:false`（MediaStore
 *    只读），search **不带**这两个字段（Rust 是 None → serde 省略）；
 *  - devices 时间戳为秒（Rust as_secs 口径），只含 last_active 距今 ≤15s 的在线设备；
 *  - 每个响应（含错误与 OPTIONS 预检）统一带 CORS 三头（Rust 版 CorsLayer Any 的对应物，
 *    桌面 webview 跨域 fetch 必需）。
 *
 * NanoHTTPD 每连接一线程，MediaStore 查询直接在 serve 线程跑（阻塞无碍）。HTTP 层不持
 * 状态：会话/设备表与配置全部经 [Deps] 委托给 [LanServerManager]。日志纪律：token 只打
 * 尾 4 位，**访问码绝不整串入日志**。tag = "AuroraLanServer"。
 */
class LanServerHttp(private val appContext: Context, private val deps: Deps) :
    NanoHTTPD(LanServerManager.DEFAULT_PORT) {

    /**
     * 会话/设备/配置回调面（由 LanServerManager 实现；HTTP 线程并发调用，实现方须线程安全）。
     */
    interface Deps {
        /** 当前访问码（每请求现读：改码即时生效，对齐 Rust 每请求读 config）。 */
        fun accessCode(): String

        /** server_name（auth 响应字段；空则整个字段省略，对齐 serde skip_serializing_if）。 */
        fun serverName(): String

        /** 建会话：同 device_id 覆盖旧会话（旧 token 一并失效，lan_share/session.rs 语义）。 */
        fun createSession(deviceId: String, deviceName: String, ip: String): LanServerSession

        /** 注册/刷新设备行（connected_at/last_active_at = 当前秒）。 */
        fun registerDevice(session: LanServerSession, deviceType: String)

        /** 校验 token → 有效会话（内部已 touch 会话 lastActive）；无效/过期返回 null。 */
        fun validateToken(token: String): LanServerSession?

        /** 鉴权成功的请求 touch 设备活动时间（对齐 update_activity）。 */
        fun touchDevice(deviceId: String)

        /** 登出：按 token 删会话并返回被删会话；token 未知返回 null（响应仍 200）。 */
        fun removeSessionByToken(token: String): LanServerSession?

        /** 删设备行（登出会话后连带）。 */
        fun removeDevice(deviceId: String)

        /** 在线设备（last_active 距今 ≤15s，对齐 lan_share ONLINE_TIMEOUT_SECS）。 */
        fun onlineDevices(): List<LanConnectedDevice>

        /** 设备列表变化（认证/登出/清理）→ manager 刷新 snapshot.deviceCount。 */
        fun onDevicesChanged()

        /**
         * 双向配对事件（Rust emit_peer_pairing 范式）：桌面认证携带 peer_server 时触发。
         * **回调里不做 loopback 过滤**——那是 React 消费侧 + Kotlin 接线侧的职责。
         */
        fun notifyPeerPairing(host: String, port: Int, accessCode: String, deviceName: String)
    }

    /** 启动（daemon 线程模式；绑定失败抛 IOException 由 manager 捕获映射 false）。 */
    fun startUp() {
        start(NanoHTTPD.SOCKET_READ_TIMEOUT, true)
    }

    /** 停止（含关闭全部活动连接；重复调用无害）。 */
    fun shutDown() {
        runCatching { stop() }
    }

    // —— 路由总入口（异常兜底 + 统一 CORS） ——

    override fun serve(session: IHTTPSession): Response {
        val resp = try {
            route(session)
        } catch (e: Exception) {
            Log.w(TAG, "[LanServer] 请求处理异常 uri=${session.uri}: ${e.javaClass.simpleName}: ${e.message}")
            jsonError(Response.Status.INTERNAL_ERROR, "Internal server error")
        }
        return withCors(resp)
    }

    private fun route(s: IHTTPSession): Response {
        // 预检（桌面 webview 跨域 fetch）：200 空体，CORS 头由 serve 统一补
        if (s.method == Method.OPTIONS) {
            return NanoHTTPD.newFixedLengthResponse(Response.Status.OK, NanoHTTPD.MIME_PLAINTEXT, "")
        }
        val uri = s.uri ?: ""
        return when (uri) {
            "/" -> requireMethod(s, Method.GET) { rootInfo() }
            "/api/auth/verify" -> requireMethod(s, Method.POST) { handleAuth(s) }
            "/api/auth/logout" -> requireMethod(s, Method.POST) { handleLogout(s) }
            "/api/browse" -> requireMethod(s, Method.GET) { handleBrowse(s) }
            "/api/palette" -> requireMethod(s, Method.GET) { handlePalette(s) }
            "/api/all_image_folders" -> requireMethod(s, Method.GET) { handleAllImageFolders(s) }
            "/api/search" -> requireMethod(s, Method.GET) { handleSearch(s) }
            "/api/thumbnail" -> requireMethod(s, Method.GET) { handleThumbnail(s) }
            "/api/image" -> requireMethod(s, Method.GET) { handleImage(s) }
            "/api/devices" -> requireMethod(s, Method.GET) { handleDevices(s) }
            "/api/heartbeat" -> requireMethod(s, Method.GET) { handleHeartbeat(s) }
            else -> jsonError(Response.Status.NOT_FOUND, "Not found")
        }
    }

    private fun requireMethod(s: IHTTPSession, expected: Method, body: () -> Response): Response =
        if (s.method == expected) body()
        else jsonError(Response.Status.METHOD_NOT_ALLOWED, "Method not allowed")

    // —— 认证（对齐 handle_auth / handle_logout） ——

    /** POST /api/auth/verify：code 换 token；携带 peer_server 时触发双向配对回调。 */
    private fun handleAuth(s: IHTTPSession): Response {
        val raw = readBody(s)
        val body = raw?.let { b -> runCatching { JSONObject(b) }.getOrNull() }
            ?: return jsonError(Response.Status.BAD_REQUEST, "Invalid JSON body")

        val code = if (body.isNull("code")) "" else body.optString("code")
        if (code != deps.accessCode()) {
            // 访问码被拒是 200 + success:false（Rust AuthResponse，不是 401！）
            Log.w(TAG, "[LanServer] 认证失败 - 访问码不匹配（来自 ${clientIp(s)}）")
            return json(JSONObject().put("success", false).put("error", "Invalid access code"))
        }

        var deviceId = if (body.isNull("device_id")) "" else body.optString("device_id")
        deviceId = deviceId.trim()
        if (deviceId.isEmpty()) deviceId = UUID.randomUUID().toString()
        // device_name 缺省（JSON null / 缺字段）→ "Device-<id前8>"；显式空串保留（Rust Some("") 同款）
        val reportedName: String? = if (body.isNull("device_name")) null else body.optString("device_name")
        val deviceName = reportedName ?: "Device-${deviceId.take(8)}"
        val ip = clientIp(s)

        val session = deps.createSession(deviceId, deviceName, ip)
        deps.registerDevice(session, parseDeviceType(s.headers["user-agent"] ?: ""))
        deps.onDevicesChanged()

        // 双向连接融合：对端携带了服务端信息 → 通知本机前端自动反向连接
        val peer = body.optJSONObject("peer_server")
        if (peer != null) {
            val peerCode = if (peer.isNull("access_code")) "" else peer.optString("access_code")
            val peerPort = peer.optInt("port")
            if (ip.isNotEmpty() && peerCode.isNotEmpty()) {
                Log.i(TAG, "[LanServer] 收到对端服务端信息，请求双向配对 - 对端 $ip:$peerPort")
                deps.notifyPeerPairing(ip, peerPort, peerCode, deviceName)
            }
        }

        Log.i(
            TAG,
            "[LanServer] 认证成功 - 设备 $deviceName (${deviceId.take(8)}…) IP: $ip" +
                " token=…${session.token.takeLast(4)}",
        )
        val resp = JSONObject()
            .put("success", true)
            .put("token", session.token)
            .put("expires_in", LanTiming.SESSION_SECS)
        // server_name 空 → 整个字段省略（serde skip_serializing_if 同款）
        val serverName = deps.serverName()
        if (serverName.isNotEmpty()) resp.put("server_name", serverName)
        return json(resp)
    }

    /**
     * POST /api/auth/logout：只对 header 格式缺失 401（对齐 Rust extract_token 的两条消息）；
     * token 未知**也返回 200** `{"success": true}`（handle_logout 同款）。
     */
    private fun handleLogout(s: IHTTPSession): Response {
        val header = s.headers["authorization"]
            ?: return jsonError(Response.Status.UNAUTHORIZED, "Missing authorization header")
        if (!header.startsWith("Bearer ")) {
            return jsonError(Response.Status.UNAUTHORIZED, "Invalid authorization format")
        }
        val removed = deps.removeSessionByToken(header.substring(7))
        if (removed != null) {
            deps.removeDevice(removed.deviceId)
            deps.onDevicesChanged()
            Log.i(TAG, "[LanServer] 设备登出 - ${removed.deviceName} (${removed.deviceId.take(8)}…)")
        }
        return json(JSONObject().put("success", true))
    }

    // —— 浏览/搜索/调色板 ——

    /** GET /api/browse：path 空 = 根全量（folders + 根级散图），否则按 BUCKET_ID 浏览。 */
    private fun handleBrowse(s: IHTTPSession): Response = withAuth(s) { auth ->
        deps.touchDevice(auth.deviceId)
        val bucketId = s.parms["path"] ?: ""
        if (bucketId.isEmpty()) {
            val (folders, rootImages) = try {
                LanMediaSource.scanAll(appContext)
            } catch (e: Exception) {
                Log.w(TAG, "[LanServer] MediaStore 扫描失败: ${e.message}")
                return@withAuth jsonError(Response.Status.INTERNAL_ERROR, "MediaStore scan failed")
            }
            return@withAuth json(
                JSONObject()
                    .put("current_path", "")
                    .put("folders", JSONArray(folders))
                    .put("images", JSONArray(rootImages))
                    .put("allow_edit", false)
                    .put("allow_upload", false),
            )
        }
        val images = try {
            LanMediaSource.browseBucket(appContext, bucketId)
        } catch (e: Exception) {
            Log.w(TAG, "[LanServer] 文件夹浏览失败: ${e.message}")
            return@withAuth jsonError(Response.Status.INTERNAL_ERROR, "MediaStore browse failed")
        }
        Log.d(TAG, "[LanServer] 浏览成功 - BUCKET_ID=$bucketId 返回 ${images.size} 张图片")
        json(
            JSONObject()
                .put("current_path", bucketId)
                .put("folders", JSONArray())
                .put("images", JSONArray(images))
                .put("allow_edit", false)
                .put("allow_upload", false),
        )
    }

    /** GET /api/all_image_folders：folders + root_images + allow_edit/allow_upload（恒 false，必须带）。 */
    private fun handleAllImageFolders(s: IHTTPSession): Response = withAuth(s) { auth ->
        deps.touchDevice(auth.deviceId)
        val (folders, rootImages) = try {
            LanMediaSource.scanAll(appContext)
        } catch (e: Exception) {
            Log.w(TAG, "[LanServer] MediaStore 扫描失败: ${e.message}")
            return@withAuth jsonError(Response.Status.INTERNAL_ERROR, "MediaStore scan failed")
        }
        Log.i(TAG, "[LanServer] all_image_folders 成功 - ${folders.size} 个文件夹, ${rootImages.size} 张根目录图片")
        json(
            JSONObject()
                .put("folders", JSONArray(folders))
                .put("root_images", JSONArray(rootImages))
                .put("allow_edit", false)
                .put("allow_upload", false),
        )
    }

    /**
     * GET /api/search?q=&scope=：响应与 browse 同形但 **不带 allow_edit/allow_upload**
     * （Rust 是 None → serde 省略），current_path 为 `search:<q>`。
     */
    private fun handleSearch(s: IHTTPSession): Response = withAuth(s) { auth ->
        deps.touchDevice(auth.deviceId)
        val q = s.parms["q"] ?: ""
        val images = try {
            LanMediaSource.searchImages(appContext, q)
        } catch (e: Exception) {
            Log.w(TAG, "[LanServer] 搜索失败: ${e.message}")
            return@withAuth jsonError(Response.Status.INTERNAL_ERROR, "Search failed")
        }
        Log.d(TAG, "[LanServer] 搜索完成 - 命中 ${images.size} 张")
        json(
            JSONObject()
                .put("current_path", "search:$q")
                .put("folders", JSONArray())
                .put("images", JSONArray(images)),
        )
    }

    /** GET /api/palette：安卓端无调色板数据恒空列表（Rust handle_palette 同款不 touch 设备）。 */
    private fun handlePalette(s: IHTTPSession): Response = withAuth(s) { _ ->
        json(JSONObject().put("palette", JSONArray()))
    }

    // —— 字节端点（token 双通道） ——

    /** GET /api/thumbnail?path=&size=&token=：path 是 MediaStore 图片 id。 */
    private fun handleThumbnail(s: IHTTPSession): Response {
        val token = tokenWithFallback(s)
            ?: return jsonError(Response.Status.UNAUTHORIZED, "Missing authorization")
        val auth = deps.validateToken(token)
            ?: return jsonError(Response.Status.UNAUTHORIZED, "Invalid or expired token")
        deps.touchDevice(auth.deviceId)
        val id = (s.parms["path"] ?: "").toLongOrNull()
            ?: return jsonError(Response.Status.BAD_REQUEST, "Invalid image id")
        // size 缺省 256（Rust default_thumbnail_size）；clamp 在 LanMediaSource 内做
        val size = s.parms["size"]?.toIntOrNull() ?: 256
        val bytes = LanMediaSource.thumbnailBytes(appContext, id, size)
            ?: return jsonError(Response.Status.NOT_FOUND, "Thumbnail not available")
        return NanoHTTPD.newFixedLengthResponse(
            Response.Status.OK, "image/jpeg", ByteArrayInputStream(bytes), bytes.size.toLong(),
        ).also { it.addHeader("Cache-Control", "private, max-age=600") }
    }

    /** GET /api/image?path=&token=：path 是 MediaStore 图片 id；mime 由数据面按行值/扩展名决定。 */
    private fun handleImage(s: IHTTPSession): Response {
        val token = tokenWithFallback(s)
            ?: return jsonError(Response.Status.UNAUTHORIZED, "Missing authorization")
        val auth = deps.validateToken(token)
            ?: return jsonError(Response.Status.UNAUTHORIZED, "Invalid or expired token")
        deps.touchDevice(auth.deviceId)
        val id = (s.parms["path"] ?: "").toLongOrNull()
            ?: return jsonError(Response.Status.BAD_REQUEST, "Invalid image id")
        val (bytes, mime) = LanMediaSource.imageBytes(appContext, id)
            ?: return jsonError(Response.Status.NOT_FOUND, "Image not found")
        Log.d(TAG, "[LanServer] 原图返回 - id: $id, 大小: ${bytes.size} bytes, 类型: $mime")
        return NanoHTTPD.newFixedLengthResponse(
            Response.Status.OK, mime, ByteArrayInputStream(bytes), bytes.size.toLong(),
        ).also { it.addHeader("Cache-Control", "private, max-age=300") }
    }

    // —— 设备 / 心跳 / 根 ——

    /** GET /api/devices：时间戳秒（Rust as_secs）；只含 last_active ≤15s 的在线设备；不 touch。 */
    private fun handleDevices(s: IHTTPSession): Response = withAuth(s) { _ ->
        val arr = JSONArray()
        deps.onlineDevices().forEach { d ->
            arr.put(
                JSONObject()
                    .put("id", d.id)
                    .put("name", d.name)
                    .put("ip", d.ip)
                    .put("connected_at", d.connectedAtSecs)
                    .put("last_active_at", d.lastActiveAtSecs)
                    .put("deviceType", d.deviceType),
            )
        }
        json(JSONObject().put("devices", arr))
    }

    /** GET /api/heartbeat：touch 设备活动时间后 success:true。 */
    private fun handleHeartbeat(s: IHTTPSession): Response = withAuth(s) { auth ->
        deps.touchDevice(auth.deviceId)
        json(JSONObject().put("success", true))
    }

    /** GET /：信息 JSON（照 handle_root 逐字对齐）。 */
    private fun rootInfo(): Response {
        val endpoints = JSONObject()
            .put("auth", "POST /api/auth/verify")
            .put("browse", "GET /api/browse")
            .put("all_image_folders", "GET /api/all_image_folders")
            .put("search", "GET /api/search")
            .put("thumbnail", "GET /api/thumbnail")
            .put("image", "GET /api/image")
            .put("devices", "GET /api/devices")
        return json(
            JSONObject()
                .put("name", "Aurora Gallery Android LAN Server")
                .put("version", "1.0")
                .put("endpoints", endpoints),
        )
    }

    // —— 鉴权与工具 ——

    /**
     * Bearer 鉴权包装（Rust extract_token + validate_token 合并）：缺 header / 非 Bearer /
     * token 无效三种失败统一 401（消息逐字对齐 handlers.rs）；成功把会话交给 [body]。
     */
    private fun withAuth(s: IHTTPSession, body: (LanServerSession) -> Response): Response {
        val header = s.headers["authorization"]
            ?: return jsonError(Response.Status.UNAUTHORIZED, "Missing authorization header")
        if (!header.startsWith("Bearer ")) {
            return jsonError(Response.Status.UNAUTHORIZED, "Invalid authorization format")
        }
        val session = deps.validateToken(header.substring(7))
            ?: return jsonError(Response.Status.UNAUTHORIZED, "Invalid or expired token")
        return body(session)
    }

    /**
     * 缩略图/大图的 token 双通道（对齐 extract_token_with_fallback）：Bearer 头优先，回退
     * `?token=`；两者皆无 → null（401 "Missing authorization"——与 Bearer 端点的
     * "Missing authorization header" 措辞不同，逐字对齐）。
     */
    private fun tokenWithFallback(s: IHTTPSession): String? {
        val header = s.headers["authorization"]
        if (header != null && header.startsWith("Bearer ")) return header.substring(7)
        val queryToken = s.parms["token"]
        if (!queryToken.isNullOrEmpty()) return queryToken
        return null
    }

    /** 客户端 IP：`getRemoteIpAddress()`（NanoHTTPD 2.3 起由 socket 解析；IHTTPSession 不暴露 socket）。 */
    private fun clientIp(s: IHTTPSession): String = try {
        s.remoteIpAddress ?: s.remoteHostName ?: ""
    } catch (e: Exception) {
        ""
    }

    /** 读 application/json 请求体（NanoHTTPD 落在 files["postData"]）。失败返回 null → 400。 */
    private fun readBody(s: IHTTPSession): String? = try {
        val files = HashMap<String, String>()
        s.parseBody(files)
        files["postData"]
    } catch (e: Exception) {
        Log.w(TAG, "[LanServer] 读取请求体失败: ${e.message}")
        null
    }

    /** 设备类型解析（逐行对齐 Rust parse_device_type：判定顺序与关键词表原样保留）。 */
    private fun parseDeviceType(userAgent: String): String {
        val ua = userAgent.lowercase()
        if (ua.contains("ipad")) return "tablet"
        if (ua.contains("iphone")) return "phone"
        if (ua.contains("android")) {
            for (keyword in TABLET_KEYWORDS) {
                if (ua.contains(keyword)) return "tablet"
            }
            if (ua.contains("mobile")) return "phone"
            return "tablet"
        }
        if (ua.contains("windows nt") || ua.contains("windows phone")) return "desktop"
        if (ua.contains("macintosh") || ua.contains("mac os x")) return "desktop"
        if (ua.contains("linux")) return "desktop"
        return "phone"
    }

    /** 每个响应（含错误与 OPTIONS）统一补 CORS 三头（桌面 webview 跨域 fetch 必需）。 */
    private fun withCors(resp: Response): Response {
        resp.addHeader("Access-Control-Allow-Origin", "*")
        resp.addHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        resp.addHeader("Access-Control-Allow-Headers", "Authorization, Content-Type")
        return resp
    }

    /** JSON 200 响应。 */
    private fun json(o: JSONObject): Response =
        NanoHTTPD.newFixedLengthResponse(Response.Status.OK, "application/json", o.toString())

    /** 错误响应统一 `{"error": "<msg>"}` + 对应状态码（对齐 Rust error_response）。 */
    private fun jsonError(status: Response.Status, message: String): Response =
        NanoHTTPD.newFixedLengthResponse(
            status, "application/json", JSONObject().put("error", message).toString(),
        )

    companion object {
        private const val TAG = "AuroraLanServer"

        /** Rust parse_device_type 的安卓平板关键词表（顺序保持）。 */
        private val TABLET_KEYWORDS = arrayOf("tablet", "sm-", "sc-", "nexus", "pixel", "kindle", "pad")
    }
}
