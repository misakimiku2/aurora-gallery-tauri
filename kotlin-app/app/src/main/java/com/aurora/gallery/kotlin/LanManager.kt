package com.aurora.gallery.kotlin

import android.content.Context
import android.util.Log
import android.widget.Toast
import com.aurora.gallery.kotlin.state.LanConnectionRecord
import com.aurora.gallery.kotlin.state.SettingsStore
import kotlinx.coroutines.CancellationException
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
import java.io.IOException

/**
 * M6a 阶段 3：LAN 连接状态机（disconnected/connecting/connected/reconnecting）。
 *
 * 时序逐条对齐任务清单 §0.2 的 React 基准（验收对照表，常量见 [LanTiming]，别散魔法数）：
 *  - 请求 15s 超时（OkHttpClient 级，见 [client]）；
 *  - 心跳 5s，连续 [LanTiming.HEARTBEAT_FAIL_LIMIT] 次失败或任一次 401 → 清理链路
 *    （logout 调用 + 清 token + 状态回 disconnected + Toast）；
 *  - 未连接（连接意向仍在）每 [LanTiming.RETRY_INTERVAL_SECS] 周期重试；重试动作为
 *    「有 token 静默验证，无 token 用访问码重新认证」——401 清理后与死地址场景同循环；
 *  - 401 立即清 token 回 disconnected（区别于心跳的连续失败计数）；
 *  - SESSION 3600s 是服务端语义，客户端不倒计时，只处理 401。
 *
 * 手动连接访问码被拒（success=false / 401）是终态：清连接意向、不进重试循环，
 * 错误回表单（对齐 React「重连失败回退手动填写」）。
 *
 * 重启恢复：连接成功后持久化 lanHost/lanPort/token/serverName；[start] 读持久化 →
 * 有 token 静默验证一次（allImageFolders）→ 直接进 connected（token 未过期场景）。
 *
 * 状态经 [snapshot] StateFlow 暴露（设置 LAN 面板与侧栏网络 Section 消费，不轮询）。
 * 日志纪律：状态迁移全打 Log.d(tag=AuroraLan)，token 只打尾 4 位，**绝不整 token 入日志**。
 */
class LanManager(context: Context, private val store: SettingsStore) {

    private val appContext = context.applicationContext

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    /** 全部请求 15s 超时（§0.2：FETCH_TIMEOUT_SECS；okhttp 级配置即全局口径）。 */
    private val client = LanClient(
        okhttp3.OkHttpClient.Builder()
            .connectTimeout(LanTiming.FETCH_TIMEOUT_SECS, java.util.concurrent.TimeUnit.SECONDS)
            .readTimeout(LanTiming.FETCH_TIMEOUT_SECS, java.util.concurrent.TimeUnit.SECONDS)
            .writeTimeout(LanTiming.FETCH_TIMEOUT_SECS, java.util.concurrent.TimeUnit.SECONDS)
            .build(),
    )

    private val _snapshot = MutableStateFlow(LanSnapshot())
    val snapshot: StateFlow<LanSnapshot> = _snapshot.asStateFlow()

    /** 连接意向（host/port/访问码）。非 null 且未连接 → 重试循环按 15s 周期推进。 */
    private var intent: LanIntent? = null

    /** 当前会话 token（内存态；持久化副本在 SettingsStore，401 时两处同清）。 */
    private var token: String? = null

    private var heartbeatJob: Job? = null
    private var retryJob: Job? = null
    private var attemptJob: Job? = null
    private var heartbeatFailures = 0

    // —— 生命周期 ——

    /** 进程启动恢复（GalleryViewModel init 调）：有持久化连接就静默验证一次。 */
    fun start() {
        val saved: LanConnectionRecord = store.loadLanConnection() ?: run {
            Log.d(TAG, "[Lan] start: 无持久化连接，保持 disconnected")
            return
        }
        val code = store.loadSavedServers()
            .firstOrNull { it.host == saved.host && it.port == saved.port }?.accessCode
        intent = LanIntent(saved.host, saved.port, code)
        _snapshot.update { it.copy(host = saved.host, port = saved.port) }
        if (saved.token != null) {
            token = saved.token
            Log.d(
                TAG,
                "[Lan] restore host=${saved.host}:${saved.port} token=…${saved.token.takeLast(4)}" +
                    "（静默带 token 验证一次）",
            )
            transition(LanState.CONNECTING, "启动恢复：验证持久化 token")
            attemptConnect()
        } else if (code != null) {
            Log.d(TAG, "[Lan] restore host=${saved.host}:${saved.port} token 无、有访问码，走重连")
            transition(LanState.CONNECTING, "启动恢复：访问码重连")
            attemptConnect()
        } else {
            // token 与访问码都没有：没有可恢复的凭据，清掉意向（不空转重试）
            intent = null
            Log.d(TAG, "[Lan] restore host=${saved.host}:${saved.port} 无凭据，保持 disconnected")
        }
    }

    // —— 对 UI 的操作 ——

    /**
     * 手动连接。[addressInput] 接受 `ip` / `ip:port` / `http://ip:port`（复用二维码
     * 解析器，默认端口 8080）；[accessCode] 必填。错误直接回表单（snapshot.error）。
     */
    fun connect(addressInput: String, accessCode: String) {
        val parsed = LanQr.parse(addressInput)
        if (parsed == null) {
            _snapshot.update { it.copy(error = "地址格式无法识别（示例：192.168.31.87:8080）") }
            return
        }
        if (accessCode.isBlank()) {
            _snapshot.update { it.copy(error = "请输入访问码") }
            return
        }
        cancelLoops()
        token = null
        heartbeatFailures = 0
        intent = LanIntent(parsed.host, parsed.port, accessCode.trim())
        _snapshot.update {
            it.copy(host = parsed.host, port = parsed.port, error = null, folders = emptyList())
        }
        Log.d(TAG, "[Lan] connect 手动 host=${parsed.host}:${parsed.port}")
        transition(LanState.CONNECTING, "手动连接")
        attemptConnect()
    }

    /** 手动断开：清连接意向（不再周期重试）+ 清理链路。 */
    fun disconnect() {
        val i = intent
        intent = null
        cancelLoops()
        val t = token
        token = null
        heartbeatFailures = 0
        store.clearLanToken()
        transition(LanState.DISCONNECTED, "手动断开", clearFolders = true)
        // 尽力通知服务端销毁会话（失败忽略——本地已清，网络错误无意义）
        if (i != null && t != null) {
            scope.launch { runCatching { client.logout(baseOf(i), t) } }
        }
        toast("已断开与桌面端的连接")
    }

    /** 侧栏展开后远端目录为空时的补拉（连接成功时已拉过，这里是手动兜底）。 */
    fun refreshFolders() {
        val i = intent ?: return
        val t = token ?: return
        if (_snapshot.value.state != LanState.CONNECTED) return
        scope.launch {
            runCatching { client.allImageFolders(baseOf(i), t) }
                .onSuccess { _snapshot.update { s -> s.copy(folders = it.folders) } }
                .onFailure { Log.w(TAG, "[Lan] refreshFolders failed: ${it.message}") }
        }
    }

    // —— 设备名（认证时上报；默认系统型号，设置面板可改） ——

    fun deviceName(): String = store.loadLanDeviceName()

    fun setDeviceName(name: String) = store.saveLanDeviceName(name)

    /** 最近服务器列表（面板「一键重连」数据源；连接成功后由 store 记录）。 */
    fun savedServers(): List<com.aurora.gallery.kotlin.state.LanSavedServer> = store.loadSavedServers()

    // —— 连接尝试（手动连接 / 周期重试共用一条路径；同一时刻至多一次在途） ——

    private fun attemptConnect() {
        attemptJob?.cancel()
        attemptJob = scope.launch {
            val i = intent ?: return@launch
            if (_snapshot.value.state == LanState.CONNECTED) return@launch
            val base = baseOf(i)
            try {
                var t = token
                if (t == null) {
                    val code = i.accessCode
                    if (code.isNullOrEmpty()) {
                        // 没有可用的凭据（token 已失效又无访问码）：终态，不重试
                        intent = null
                        Log.w(TAG, "[Lan] 无凭据可重连（token 失效且无访问码）host=${i.host}:${i.port}")
                        transition(
                            LanState.DISCONNECTED,
                            "无凭据",
                            error = "连接已失效，请重新输入访问码",
                            clearFolders = true,
                        )
                        return@launch
                    }
                    // 无 token（首次连接/401 清理后）：访问码换 token
                    val auth = client.verify(base, code, deviceName(), deviceId())
                    if (!auth.success || auth.token == null) {
                        // 访问码被拒 = 终态：清意向不重试，错误回表单（不进 15s 循环）
                        token = null
                        store.clearLanToken()
                        intent = null
                        Log.w(
                            TAG,
                            "[Lan] auth rejected（${auth.error ?: "success=false"}），" +
                                "清意向不再重试 host=${i.host}:${i.port}",
                        )
                        transition(
                            LanState.DISCONNECTED,
                            "访问码被拒",
                            error = auth.error ?: "访问码不正确",
                            clearFolders = true,
                        )
                        return@launch
                    }
                    t = auth.token
                    token = t
                    Log.d(TAG, "[Lan] auth OK expires_in=${auth.expiresIn} token=…${t.takeLast(4)}")
                    _snapshot.update { it.copy(serverName = auth.serverName) }
                }
                // 连接成功的判据 = 能拉到远端目录（restore 场景即「静默带 token 验证一次」；
                // 401 在这里被抛出，与手动连接同一条 401 处理）
                val folders = client.allImageFolders(base, t).folders
                // 尝试在途期间用户可能已断开/换目标（okhttp 阻塞调用不响应协程取消，
                // 残响应会晚到）——意向已变的丢弃，不许覆盖断开后的 disconnected 态
                if (intent !== i) {
                    Log.d(TAG, "[Lan] 残响应丢弃（意向已变）host=${i.host}:${i.port}")
                    return@launch
                }
                store.saveLanConnection(i.host, i.port, t, _snapshot.value.serverName)
                store.recordSavedServer(i.host, i.port, _snapshot.value.serverName, i.accessCode)
                _snapshot.update { it.copy(error = null, folders = folders) }
                transition(LanState.CONNECTED, "目录就绪（${folders.size} 个）")
                startHeartbeat()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                // 同上：阻塞调用自然超时后残响应晚到（尤其手动断开时在途的那次尝试），
                // 意向已变就静默丢弃——不迁移状态、不排重试
                if (intent !== i) {
                    Log.d(TAG, "[Lan] 残响应丢弃（${e.javaClass.simpleName}，意向已变）")
                    return@launch
                }
                if (e is LanHttpException) {
                    if (e.code == 401) {
                        // 401：立即清 token 回 disconnected（区别于心跳连续失败计数）。
                        // 恢复场景的 token 过期不打扰用户（无 Toast）；重试循环会用
                        // 访问码重新认证（访问码也被桌面端重生成时下一轮终态处理）。
                        token = null
                        store.clearLanToken()
                        Log.w(TAG, "[Lan] 401 in connect（token 失效），清 token host=${i.host}:${i.port}")
                        transition(LanState.DISCONNECTED, "401 token 失效", clearFolders = true)
                    } else {
                        transition(
                            LanState.RECONNECTING,
                            "HTTP ${e.code}",
                            error = "无法连接 ${i.host}:${i.port}（HTTP ${e.code}）",
                        )
                    }
                } else {
                    transition(
                        LanState.RECONNECTING,
                        if (e is IOException) "网络错误 ${e.javaClass.simpleName}" else "异常 ${e.javaClass.simpleName}",
                        error = "无法连接 ${i.host}:${i.port}",
                    )
                }
                scheduleRetry()
            }
        }
    }

    // —— 心跳（仅 CONNECTED；5s 周期） ——

    private fun startHeartbeat() {
        heartbeatJob?.cancel()
        heartbeatFailures = 0
        heartbeatJob = scope.launch {
            while (isActive) {
                delay(LanTiming.HEARTBEAT_INTERVAL_SECS * 1000)
                val i = intent ?: break
                val t = token ?: break
                if (_snapshot.value.state != LanState.CONNECTED) break
                try {
                    client.heartbeat(baseOf(i), t)
                    if (heartbeatFailures != 0) {
                        Log.d(TAG, "[Lan] heartbeat recovered（此前失败 $heartbeatFailures 次）")
                    }
                    heartbeatFailures = 0
                } catch (e: LanHttpException) {
                    if (e.code == 401) {
                        Log.w(
                            TAG,
                            "[Lan] heartbeat 401（会话已被服务端清除）token=…${t.takeLast(4)} → 清理链路",
                        )
                        cleanupChain("心跳 401（会话失效）")
                        return@launch
                    }
                    heartbeatFailures++
                    Log.w(TAG, "[Lan] heartbeat HTTP ${e.code}（$heartbeatFailures/${LanTiming.HEARTBEAT_FAIL_LIMIT}）")
                    if (heartbeatFailures >= LanTiming.HEARTBEAT_FAIL_LIMIT) {
                        cleanupChain("心跳连续 ${LanTiming.HEARTBEAT_FAIL_LIMIT} 次失败")
                        return@launch
                    }
                } catch (e: IOException) {
                    heartbeatFailures++
                    Log.w(
                        TAG,
                        "[Lan] heartbeat 网络失败（$heartbeatFailures/${LanTiming.HEARTBEAT_FAIL_LIMIT}）：${e.message}",
                    )
                    if (heartbeatFailures >= LanTiming.HEARTBEAT_FAIL_LIMIT) {
                        cleanupChain("心跳连续 ${LanTiming.HEARTBEAT_FAIL_LIMIT} 次失败")
                        return@launch
                    }
                }
            }
        }
    }

    /**
     * 清理链路（§0.2 clearConnection 的 Kotlin 对应，去掉阶段 7 才有的「停本机服务端」）：
     * logout 调用（尽力）+ 清 token + 状态回 disconnected + Toast；连接意向保留 →
     * 重试循环继续 15s 周期推进（验收口径：断链后进入周期重试）。
     */
    private fun cleanupChain(reason: String) {
        val i = intent
        val t = token
        Log.w(TAG, "[Lan] cleanup: $reason token=${t?.let { "…${it.takeLast(4)}" } ?: "null"} host=${i?.host}:${i?.port}")
        heartbeatJob?.cancel()
        heartbeatFailures = 0
        token = null
        store.clearLanToken()
        transition(LanState.DISCONNECTED, reason, clearFolders = true)
        if (i != null && t != null) {
            scope.launch { runCatching { client.logout(baseOf(i), t) } }
        }
        toast("与桌面端的连接已断开")
        scheduleRetry()
    }

    // —— 周期重试（intent 存在且未连接时，每 RETRY_INTERVAL_SECS 推进一步） ——

    private fun scheduleRetry() {
        if (retryJob?.isActive == true) return
        if (intent == null) return
        retryJob = scope.launch {
            var tick = 0
            while (isActive) {
                val i = intent ?: break
                if (_snapshot.value.state == LanState.CONNECTED) break
                delay(LanTiming.RETRY_INTERVAL_SECS * 1000)
                val i2 = intent ?: break
                if (_snapshot.value.state == LanState.CONNECTED) break
                tick++
                Log.d(
                    TAG,
                    "[Lan] retry tick #$tick（${LanTiming.RETRY_INTERVAL_SECS}s 周期）" +
                        "state=${_snapshot.value.state} host=${i2.host}:${i2.port}",
                )
                attemptConnect()
            }
        }
    }

    // —— 内部工具 ——

    private fun baseOf(i: LanIntent): String = "http://${i.host}:${i.port}"

    private fun deviceId(): String = store.loadLanDeviceId()

    /**
     * 状态迁移唯一入口（迁移即打点：logcat 状态迁移是阶段 3 验收证据）。
     * [error] 只写入不覆盖为 null——重连失败链条里保留最后一条给表单展示，成功时显式清。
     */
    private fun transition(
        to: LanState,
        reason: String,
        error: String? = null,
        clearFolders: Boolean = false,
    ) {
        val old = _snapshot.value.state
        _snapshot.update {
            it.copy(
                state = to,
                error = error ?: it.error.takeIf { prev -> to != LanState.CONNECTED },
                folders = if (clearFolders) emptyList() else it.folders,
            )
        }
        Log.d(
            TAG,
            "[Lan] state $old -> $to（$reason）token=${token?.let { t -> "…${t.takeLast(4)}" } ?: "null"}",
        )
        if (to == LanState.CONNECTED) {
            val s = _snapshot.value
            Log.d(
                TAG,
                "[Lan] connected server=${s.serverName ?: s.host} folders=${s.folders.size}",
            )
        }
    }

    private fun cancelLoops() {
        heartbeatJob?.cancel()
        heartbeatJob = null
        retryJob?.cancel()
        retryJob = null
        attemptJob?.cancel()
        attemptJob = null
    }

    private fun toast(msg: String) {
        Toast.makeText(appContext, msg, Toast.LENGTH_SHORT).show()
    }

    /** 连接意向（发起方视角的地址 + 访问码；恢复场景可能只有 token 无码 → null）。 */
    private data class LanIntent(val host: String, val port: Int, val accessCode: String?)

    companion object {
        private const val TAG = "AuroraLan"
    }
}

/**
 * 连接状态。
 * disconnected = 无连接（可能仍带意向，等周期重试）；connecting = 尝试中；
 * connected = 会话有效；reconnecting = 上一次尝试失败、等下一轮周期。
 */
enum class LanState { DISCONNECTED, CONNECTING, CONNECTED, RECONNECTING }

/** 侧栏/设置面板消费的连接快照（UI 只读这个结构，不碰 LanClient）。 */
data class LanSnapshot(
    val state: LanState = LanState.DISCONNECTED,
    /** 服务端上报名（auth.server_name）；恢复场景取持久化值。 */
    val serverName: String? = null,
    val host: String? = null,
    val port: Int? = null,
    /** 远端含图目录（侧栏网络 Section 展开列表；断链清空）。 */
    val folders: List<LanRemoteFolder> = emptyList(),
    /** 面板表单错误行（访问码被拒/地址不识别/网络不可达的最近一条）。 */
    val error: String? = null,
)

/**
 * 时序常量表（§0.2 React 基准 → Kotlin 唯一来源；改时序只改这里，别散魔法数）。
 */
object LanTiming {
    /** 单请求超时（OkHttpClient connect/read/write 三处同值）。 */
    const val FETCH_TIMEOUT_SECS = 15L

    /** 心跳周期（React setInterval 5000）。 */
    const val HEARTBEAT_INTERVAL_SECS = 5L

    /** 连续心跳失败上限（第 3 次失败触发清理链路；任一次 401 立即清理）。 */
    const val HEARTBEAT_FAIL_LIMIT = 3

    /** 未连接周期重试间隔（React setInterval 15000）。 */
    const val RETRY_INTERVAL_SECS = 15L

    /**
     * 服务端会话时长（SESSION 3600s，types.rs 语义）。客户端**不倒计时**——
     * 过期表现为请求吃 401，统一走 401 即清；列在这里只为时序表完整可对照。
     */
    const val SESSION_SECS = 3600L
}
