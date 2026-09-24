package com.aurora.gallery.kotlin

import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.core.content.ContextCompat
import com.aurora.gallery.kotlin.state.SettingsStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.net.DatagramSocket
import java.net.Inet4Address
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/**
 * 已认证会话（对齐 `src-tauri/src/lan_share/types.rs` Session；时间用毫秒内部口径，
 * 在线/过期判定时换算——协议侧不序列化本类型）。
 */
data class LanServerSession(
    val token: String,
    val deviceId: String,
    val deviceName: String,
    val ip: String,
    val connectedAtMillis: Long,
    val lastActiveMillis: Long,
)

/**
 * 已连接设备（对齐 lan_share/types.rs ConnectedDevice）：connected_at/last_active_at
 * 为**秒**——`GET /api/devices` 的 JSON 字段直接用它（Rust as_secs 口径）。
 */
data class LanConnectedDevice(
    val id: String,
    val name: String,
    val ip: String,
    val connectedAtSecs: Long,
    val lastActiveAtSecs: Long,
    val deviceType: String,
)

/** 服务端快照（设置 LAN 面板消费；UI 只读这个结构，不碰 HTTP 层）。 */
data class LanServerSnapshot(
    /** 持久化开关意图（store.loadLanServerEnabled）。 */
    val enabled: Boolean = false,
    /** HTTP 服务端是否在运行（绑定成功即 true，与 enabled 独立）。 */
    val running: Boolean = false,
    /** 本机局域网 IP（未运行为 null；取不到时为 "127.0.0.1" 兜底值）。 */
    val ip: String? = null,
    /** 端口（本版固定 8080）。 */
    val port: Int = 8080,
    /** 4 位数字访问码（首次开启时生成并持久化；快照给面板展示/二维码用，绝不入日志）。 */
    val accessCode: String = "",
    /** 当前在线设备数（last_active ≤15s）。 */
    val deviceCount: Int = 0,
)

/**
 * M6a 阶段 7：对等服务端单例管理器——会话/设备表（lan_share/session.rs + device_manager.rs
 * 的 Kotlin 对应）+ HTTP 服务端与前台服务生命周期 + 面板快照。
 *
 * 语义对齐 `src-tauri/src/android/server/server.rs`：
 *  - 会话 3600s 过期（validate 时惰性删 + 清理循环兜底）；同 device_id 重连覆盖旧会话，
 *    旧 token 一并失效；
 *  - 设备「在线」判定 15s（= 心跳 5s × 3，ONLINE_TIMEOUT_SECS）；清理循环每 10s 跑一次
 *    （cleanup_handle 同款；设备不活跃清理同样按 SESSION 3600s 口径，对齐 server.rs）；
 *  - 每个鉴权成功的请求 touch 会话 + 设备（update_activity 同款）。
 *
 * 访问码：`store.loadLanAccessCode()` 为空时**首次生成** 4 位（1000-9999）并持久化——
 * 重启不变，桌面端保存的配对记录才不会失效。日志纪律：访问码绝不整串入日志，token 只打
 * 尾 4 位。tag = "AuroraLanServer"。
 */
class LanServerManager private constructor(
    private val appContext: Context,
    private val store: SettingsStore,
) : LanServerHttp.Deps {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    private val _snapshot = MutableStateFlow(LanServerSnapshot())

    /** 面板快照（enabled/running/ip/port/accessCode/deviceCount）。 */
    val snapshot: StateFlow<LanServerSnapshot> = _snapshot.asStateFlow()

    /** HTTP 引擎（null = 未运行；setEnableOn 成功后才赋值）。 */
    private var http: LanServerHttp? = null

    /** 清理循环（运行期间每 10s 清过期会话与不活跃设备）。 */
    private var cleanupJob: Job? = null

    @Volatile
    private var runningIp: String? = null

    /** 会话表：device_id → session（token→device 映射分离，对齐 session.rs 双表结构）。 */
    private val sessions = ConcurrentHashMap<String, LanServerSession>()

    private val tokenToDevice = ConcurrentHashMap<String, String>()

    /** 设备表：device_id → device。 */
    private val devices = ConcurrentHashMap<String, LanConnectedDevice>()

    /** 配对回调（GalleryViewModel 接线）：桌面认证携带 peer_server 时触发（HTTP 线程回调）。 */
    @Volatile
    var onPeerPairing: ((host: String, port: Int, accessCode: String, deviceName: String) -> Unit)? =
        null

    /** LanManager 认证前上报桌面用的对端服务端信息（反向配对）。 */
    data class PeerInfo(val port: Int, val accessCode: String)

    // —— 生命周期（面板开关 / 连接融合 / 启动恢复共用） ——

    /**
     * 面板开关 ON / 连接融合：未运行则起 HTTP 服务端（绑定 0.0.0.0:[DEFAULT_PORT]）+
     * 前台服务；autoEnable=true 时持久化 enabled=true。已在运行直接返回 true。绑定失败
     * （端口占用等）回 false（打日志，不抛）。
     */
    suspend fun setEnabledOn(autoEnable: Boolean): Boolean = withContext(Dispatchers.Default) {
        if (autoEnable) store.saveLanServerEnabled(true)
        if (http != null) {
            refreshSnapshot()
            return@withContext true
        }
        // 访问码：首次生成并持久化（重启不变）
        val code = ensureAccessCode()
        val ip = localIp()
        val server = LanServerHttp(appContext, this@LanServerManager)
        try {
            server.startUp()
        } catch (e: Exception) {
            Log.w(TAG, "[LanServer] 启动失败（端口 $DEFAULT_PORT 绑定失败？）: ${e.message}")
            return@withContext false
        }
        http = server
        runningIp = ip
        cleanupJob?.cancel()
        cleanupJob = scope.launch { cleanupLoop() }
        _snapshot.update {
            it.copy(running = true, ip = ip, port = DEFAULT_PORT, accessCode = code, deviceCount = 0)
        }
        // 前台服务保活（尽力）：后台路径起 FGS 可能被系统拒绝，起不了不影响 HTTP 服务
        startForeground(ip)
        refreshSnapshot()
        Log.i(TAG, "[LanServer] 服务端已启动 http://$ip:$DEFAULT_PORT autoEnable=$autoEnable")
        true
    }

    /**
     * 停服务端 + 前台服务；persistOff=true 时持久化 enabled=false（手动断开/通知栏/面板关）。
     * 幂等：未运行调用无副作用（快照照常刷新）。
     */
    fun stop(persistOff: Boolean) {
        if (persistOff) store.saveLanServerEnabled(false)
        cleanupJob?.cancel()
        cleanupJob = null
        http?.shutDown()
        http = null
        runningIp = null
        // 会话/设备随服务端一起清（重启服务端 = 全新会话，对齐 Rust server 生命周期）
        sessions.clear()
        tokenToDevice.clear()
        devices.clear()
        runCatching { appContext.stopService(Intent(appContext, LanServerService::class.java)) }
        refreshSnapshot()
        Log.i(TAG, "[LanServer] 服务端已停止 persistOff=$persistOff")
    }

    /**
     * LanManager 认证前调：确保运行并返回上报桌面用的 PeerInfo；起不来返回 null
     * （照常连，只是不做反向配对）。
     */
    suspend fun peerServerForConnect(autoEnable: Boolean): PeerInfo? {
        if (!setEnabledOn(autoEnable)) return null
        val code = ensureAccessCode()
        if (code.isBlank()) return null
        return PeerInfo(port = DEFAULT_PORT, accessCode = code)
    }

    /** 重新生成 4 位访问码（1000-9999），持久化，运行中即时生效（HTTP 层每请求现读）；返回新码。 */
    fun regenerateAccessCode(): String {
        val code = randomAccessCode()
        store.saveLanAccessCode(code)
        refreshSnapshot()
        Log.i(TAG, "[LanServer] 访问码已重新生成（运行中即时生效）")
        return code
    }

    /** App 启动恢复：enabled=true 才自启（内部 scope.launch 异步，不阻塞主线程）。 */
    fun autoStartIfEnabled() {
        if (!store.loadLanServerEnabled()) {
            Log.d(TAG, "[LanServer] 启动恢复：开关未持久化，不自启")
            return
        }
        scope.launch {
            val ok = setEnabledOn(autoEnable = false)
            Log.i(TAG, "[LanServer] 启动恢复自启 ok=$ok ip=${_snapshot.value.ip}")
        }
    }

    // —— 清理循环（对齐 server.rs cleanup_handle） ——

    private suspend fun cleanupLoop() {
        while (scope.isActive) {
            delay(CLEANUP_INTERVAL_MILLIS)
            if (cleanupExpired()) refreshSnapshot()
        }
    }

    /**
     * 清过期会话（last_active > 3600s）与不活跃设备（对齐 server.rs 清理按 SESSION_TIMEOUT
     * 口径，非 15s 在线判定）。有清理动作返回 true（→ 刷新 deviceCount）。
     */
    private fun cleanupExpired(): Boolean {
        val nowMillis = System.currentTimeMillis()
        var changed = false
        for ((deviceId, s) in sessions) {
            if (nowMillis - s.lastActiveMillis > LanTiming.SESSION_SECS * 1000) {
                sessions.remove(deviceId)
                tokenToDevice.remove(s.token)
                changed = true
            }
        }
        val nowSecs = nowMillis / 1000
        for ((id, d) in devices) {
            if (nowSecs - d.lastActiveAtSecs > LanTiming.SESSION_SECS) {
                devices.remove(id)
                changed = true
            }
        }
        return changed
    }

    // —— 访问码 / IP / 前台服务 ——

    /** 读取持久化访问码，为空则首次生成 4 位并持久化（重启不变）。 */
    private fun ensureAccessCode(): String {
        store.loadLanAccessCode().takeIf { it.isNotBlank() }?.let { return it }
        val code = randomAccessCode()
        store.saveLanAccessCode(code)
        return code
    }

    private fun randomAccessCode(): String = (ACCESS_CODE_MIN..ACCESS_CODE_MAX).random().toString()

    /**
     * 本机局域网 IP：招一 NetworkInterface 枚举（site-local IPv4、非 loopback，优先 wlan0
     * 接口名），失败再试招二 DatagramSocket connect 8.8.8.8（不发包，内核按默认路由选出口
     * 网卡）——对齐 get_android_local_ip 的两段式意图；都取不到兜底 "127.0.0.1"。
     */
    private fun localIp(): String {
        runCatching {
            val candidates = mutableListOf<Pair<String, String>>()
            val interfaces = NetworkInterface.getNetworkInterfaces() ?: return@runCatching
            while (interfaces.hasMoreElements()) {
                val nif = interfaces.nextElement()
                val addresses = nif.inetAddresses ?: continue
                while (addresses.hasMoreElements()) {
                    val addr = addresses.nextElement()
                    if (addr is Inet4Address && !addr.isLoopbackAddress && addr.isSiteLocalAddress) {
                        addr.hostAddress?.let { candidates += nif.name to it }
                    }
                }
            }
            candidates.firstOrNull { it.first.startsWith("wlan") }?.let { return it.second }
            candidates.firstOrNull()?.let { return it.second }
        }
        runCatching {
            DatagramSocket().use { socket ->
                socket.connect(InetSocketAddress("8.8.8.8", 80))
                val addr = socket.localAddress
                if (addr is Inet4Address && !addr.isLoopbackAddress) {
                    addr.hostAddress?.takeIf { it.isNotEmpty() }?.let { return it }
                }
            }
        }
        Log.w(TAG, "[LanServer] 无法获取本机局域网 IP，兜底 127.0.0.1")
        return "127.0.0.1"
    }

    /**
     * 前台服务保活（尽力）：后台重连路径起 FGS 受限（ForegroundServiceStartNotAllowedException
     * 是 API 31+ 的 IllegalStateException 子类，统一按父类捕获不加 SDK 分支），起不了只打
     * 日志不影响 HTTP 服务。
     */
    private fun startForeground(ip: String) {
        try {
            val intent = Intent(appContext, LanServerService::class.java)
                .setAction(LanServerService.ACTION_START)
                .putExtra(LanServerService.EXTRA_PORT, DEFAULT_PORT)
                .putExtra(LanServerService.EXTRA_IP, ip)
            ContextCompat.startForegroundService(appContext, intent)
        } catch (e: IllegalStateException) {
            Log.w(TAG, "[LanServer] 前台服务启动受限（后台限制），HTTP 服务不受影响: ${e.message}")
        } catch (e: Exception) {
            Log.w(TAG, "[LanServer] 前台服务启动失败: ${e.message}")
        }
    }

    /** 快照唯一刷新口：enabled 读持久化、deviceCount 现算，其余取当前运行态。 */
    private fun refreshSnapshot() {
        _snapshot.update {
            it.copy(
                enabled = store.loadLanServerEnabled(),
                running = http != null,
                ip = if (http != null) runningIp else null,
                port = DEFAULT_PORT,
                accessCode = store.loadLanAccessCode(),
                deviceCount = onlineDevices().size,
            )
        }
    }

    // —— LanServerHttp.Deps（HTTP 线程并发调用；表全走 ConcurrentHashMap） ——

    override fun accessCode(): String = store.loadLanAccessCode()

    override fun serverName(): String = store.loadLanDeviceName()

    override fun createSession(deviceId: String, deviceName: String, ip: String): LanServerSession {
        val now = System.currentTimeMillis()
        val session = LanServerSession(
            token = UUID.randomUUID().toString(),
            deviceId = deviceId,
            deviceName = deviceName,
            ip = ip,
            connectedAtMillis = now,
            lastActiveMillis = now,
        )
        // 同 device_id 重连：旧会话连同旧 token 一并失效（对齐 session.rs create_session）
        val old = sessions.put(deviceId, session)
        if (old != null) tokenToDevice.remove(old.token)
        tokenToDevice[session.token] = deviceId
        return session
    }

    override fun registerDevice(session: LanServerSession, deviceType: String) {
        val nowSecs = System.currentTimeMillis() / 1000
        devices[session.deviceId] = LanConnectedDevice(
            id = session.deviceId,
            name = session.deviceName,
            ip = session.ip,
            connectedAtSecs = nowSecs,
            lastActiveAtSecs = nowSecs,
            deviceType = deviceType,
        )
    }

    override fun validateToken(token: String): LanServerSession? {
        val deviceId = tokenToDevice[token] ?: return null
        val session = sessions[deviceId] ?: return null
        val now = System.currentTimeMillis()
        if (now - session.lastActiveMillis > LanTiming.SESSION_SECS * 1000) {
            // 过期：删会话 + token 映射（对齐 session.rs validate_token 的惰性删除）
            sessions.remove(deviceId)
            tokenToDevice.remove(session.token)
            return null
        }
        // touch 会话（update_activity 的会话侧）
        val touched = session.copy(lastActiveMillis = now)
        sessions[deviceId] = touched
        return touched
    }

    override fun touchDevice(deviceId: String) {
        val nowSecs = System.currentTimeMillis() / 1000
        devices.computeIfPresent(deviceId) { _, d -> d.copy(lastActiveAtSecs = nowSecs) }
    }

    override fun removeSessionByToken(token: String): LanServerSession? {
        val deviceId = tokenToDevice.remove(token) ?: return null
        return sessions.remove(deviceId)
    }

    override fun removeDevice(deviceId: String) {
        devices.remove(deviceId)
    }

    override fun onlineDevices(): List<LanConnectedDevice> {
        val nowSecs = System.currentTimeMillis() / 1000
        return devices.values.filter { nowSecs - it.lastActiveAtSecs <= ONLINE_TIMEOUT_SECS }
    }

    override fun onDevicesChanged() {
        refreshSnapshot()
    }

    override fun notifyPeerPairing(host: String, port: Int, accessCode: String, deviceName: String) {
        // 访问码不入日志（打掩码也省了——有没有回调才是要点）
        Log.i(TAG, "[LanServer] 双向配对回调 - 对端 $host:$port 设备 $deviceName（访问码略）")
        onPeerPairing?.invoke(host, port, accessCode, deviceName)
    }

    companion object {
        private const val TAG = "AuroraLanServer"

        /** 服务端口（本版固定 8080 不开放改口——对齐 Rust 默认值，差异登记）。 */
        const val DEFAULT_PORT = 8080

        /** 设备在线判定（秒）：last_active 距今 ≤15s（= 心跳 5s × 3，lan_share ONLINE_TIMEOUT_SECS）。 */
        private const val ONLINE_TIMEOUT_SECS = 15L

        /** 清理循环周期（对齐 server.rs cleanup_handle 的 10s）。 */
        private const val CLEANUP_INTERVAL_MILLIS = 10_000L

        /** 访问码取值范围：4 位数字（1000-9999）。 */
        private const val ACCESS_CODE_MIN = 1000
        private const val ACCESS_CODE_MAX = 9999

        @Volatile
        private var instance: LanServerManager? = null

        /** 幂等：重复 init 返回既有实例。GalleryViewModel init 调。 */
        fun init(appContext: Context, store: SettingsStore): LanServerManager =
            instance ?: synchronized(this) {
                instance ?: LanServerManager(appContext.applicationContext, store).also { instance = it }
            }

        /** 未 init 时返回 null（调用方一律 ?. 安全调用）。 */
        fun get(): LanServerManager? = instance
    }
}
