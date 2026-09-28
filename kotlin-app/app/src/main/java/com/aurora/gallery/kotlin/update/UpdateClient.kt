package com.aurora.gallery.kotlin.update

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.Call
import okhttp3.OkHttpClient
import okhttp3.Request
import java.util.concurrent.TimeUnit

/**
 * 清单数据源：GitHub 优先，短超时失败后降级 Gitee（D50）。
 *
 * 为什么清单 URL 走 raw 而不是 releases API：
 *  - GitHub `raw.githubusercontent.com` 与 Gitee `raw` 都是**免鉴权**的静态直链（Gitee 的
 *    OpenAPI `/releases/latest` 要么需 access_token、要么在无 Release 时返回 404）；
 *  - 清单里写明 APK 下载地址与版本号，服务端无需再解析 API 响应，两端（安卓/桌面）共用
 *    同一份 schema。
 *
 * ⚠️ 分支名：GitHub 默认分支 `main`，Gitee 新建仓库默认 `master`。若你的仓库默认分支
 * 不同，改下面两个常量的分支段即可（URL 其余部分不要动）。
 */
data class UpdateSource(
    val id: String,
    val label: String,
    val url: String,
    /** 整次请求上限（含连接+读体），用于「连不上快点换下一源」。 */
    val timeoutMs: Long,
)

/** 更新检查的网络层：负责取清单；下载 APK 走 [ApkDownloader]（共用 client 配置）。 */
object UpdateClient {

    private const val GITHUB_MANIFEST =
        "https://raw.githubusercontent.com/misakimiku2/aurora-gallery-tauri/main/update/android.json"
    private const val GITEE_MANIFEST =
        "https://gitee.com/misakimiku2/aurora_gallery/raw/master/update/android.json"

    /** GitHub 走短超时（3s）——国内网络常常连不通，卡太久不如早点降级到 Gitee。 */
    private const val GITHUB_TIMEOUT_MS = 3_000L
    private const val GITEE_TIMEOUT_MS = 10_000L

    val sources: List<UpdateSource> = listOf(
        UpdateSource("github", "GitHub", GITHUB_MANIFEST, GITHUB_TIMEOUT_MS),
        UpdateSource("gitee", "Gitee", GITEE_MANIFEST, GITEE_TIMEOUT_MS),
    )

    /** 清单请求专用 client（短超时、不复用连接池结果）。 */
    private val probeClients = sources.associate { source ->
        source.id to OkHttpClient.Builder()
            .callTimeout(source.timeoutMs, TimeUnit.MILLISECONDS)
            .connectTimeout(minOf(source.timeoutMs, 3_000L), TimeUnit.MILLISECONDS)
            .readTimeout(source.timeoutMs, TimeUnit.MILLISECONDS)
            .followRedirects(true)
            .retryOnConnectionFailure(false)
            .build()
    }

    /** 下载用的长连接 client（清单那种 3s 超时显然不能拿来下 APK）。 */
    val downloadClient: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .followRedirects(true)
            .build()
    }

    /** 按 [sources] 顺序取第一个成功的清单，返回「清单 + 命中源」。 */
    suspend fun fetchLatest(): Pair<UpdateManifest, UpdateSource> = withContext(Dispatchers.IO) {
        var lastError: Throwable? = null
        for (source in sources) {
            val result = runCatching { fetchFrom(source) }
            val manifest = result.getOrNull()
            if (manifest != null) return@withContext manifest to source
            lastError = result.exceptionOrNull() ?: lastError
        }
        throw IllegalStateException(
            "所有更新源均不可用：${lastError?.message ?: "未知错误"}",
            lastError,
        )
    }

    private fun fetchFrom(source: UpdateSource): UpdateManifest {
        val client = probeClients[source.id] ?: error("未配置的更新源：${source.id}")
        // no-cache + 时间戳：绕开 CDN/代理对 raw 文件的缓存（清单更新后要立刻生效）
        val url = source.url + (if (source.url.contains('?')) "&" else "?") + "t=" + System.currentTimeMillis()
        val request = Request.Builder()
            .url(url)
            .header("User-Agent", "AuroraGallery-Updater/1.0")
            .header("Cache-Control", "no-cache")
            .header("Accept", "application/json")
            .build()
        val call: Call = client.newCall(request)
        val body = call.execute().use { response ->
            if (!response.isSuccessful) {
                throw IllegalStateException("${source.label} HTTP ${response.code}")
            }
            response.body?.string()?.takeIf { it.isNotBlank() }
                ?: throw IllegalStateException("${source.label} 返回空内容")
        }
        return parseUpdateManifest(body)
    }
}
