package com.aurora.gallery.kotlin.update

import android.content.Context
import android.content.Intent
import androidx.compose.runtime.mutableStateOf
import androidx.core.content.pm.PackageInfoCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import java.io.File

/**
 * 更新检查的状态机与 UI 唯一读写口（对标桌面 `useUpdateCheck.ts`）。
 *
 * 放在 ViewModel 作用域而不是 Activity：下载是长任务，旋屏/重建不能把它掐断。
 * UI 只读 state + 调函数，不持有任何下载句柄。
 */
class UpdateController(
    private val context: Context,
    private val scope: CoroutineScope,
) {
    private val store = UpdateStore(context)
    private val downloader = ApkDownloader(context)
    private var downloadJob: Job? = null

    /** 当前 APK 版本（versionName / versionCode 都要：清单优先比 versionCode）。 */
    val currentVersion: String
    val currentVersionCode: Long

    init {
        val info = runCatching {
            context.packageManager.getPackageInfo(context.packageName, 0)
        }.getOrNull()
        currentVersion = info?.versionName.orEmpty()
        currentVersionCode = info?.let { PackageInfoCompat.getLongVersionCode(it) } ?: 0L
    }

    /** 正在检查。 */
    val checking = mutableStateOf(false)
    /** 可用的新版本清单（已被判定为比当前新且未被忽略），没有则 null。 */
    val release = mutableStateOf<UpdateManifest?>(null)

    /**
     * 用户点过「稍后提醒」：只收起顶部弹窗，[release] 保持置位——这样关于页仍显示
     * 「发现新版本 vX」与下载入口，语义是「有更新，弹窗先不烦你」，而不是「已是最新」。
     */
    private val bannerDismissed = mutableStateOf(false)

    /** 更新弹窗是否该显示（[release] 有值且未被「稍后提醒」收起）。 */
    val showBanner: Boolean
        get() = release.value != null && !bannerDismissed.value
    /** 本次检查命中的源标签（GitHub/Gitee），关于页显示用。 */
    val sourceLabel = mutableStateOf("")
    /** 检查失败原因（网络不通/清单格式错误），null 表示无错误。 */
    val checkError = mutableStateOf<String?>(null)
    /** 至少检查过一次（用于区分「从未检查」和「已是最新」）。 */
    val checkedOnce = mutableStateOf(false)

    enum class Phase { IDLE, DOWNLOADING, READY, INSTALLING, FAILED }

    val phase = mutableStateOf(Phase.IDLE)
    val downloadedBytes = mutableStateOf(0L)
    val totalBytes = mutableStateOf(0L)
    val downloadError = mutableStateOf<String?>(null)
    val apkFile = mutableStateOf<File?>(null)

    val progress: Float
        get() {
            val total = totalBytes.value
            if (total > 0) return (downloadedBytes.value.toFloat() / total.toFloat()).coerceIn(0f, 1f)
            return 0f
        }

    /**
     * 检查更新。[force] = 用户手动点按钮（忽略 24h 节流）；否则仅在到点时查。
     * silent 场景（启动自动）不覆盖已有错误文案，避免一开屏就红字。
     */
    fun check(force: Boolean = false) {
        if (checking.value) return
        if (!force && store.isCheckDue().not()) return
        if (!force && release.value != null) return
        checking.value = true
        checkError.value = null
        scope.launch {
            val (manifest, source) = runCatching { UpdateClient.fetchLatest() }
                .getOrElse { e ->
                    checking.value = false
                    checkedOnce.value = true
                    checkError.value = e.message ?: "检查更新失败"
                    return@launch
                }
            store.lastCheckTime = System.currentTimeMillis()
            store.lastSource = source.id
            sourceLabel.value = source.label
            checking.value = false
            checkedOnce.value = true
            val newer = manifest.isNewerThan(currentVersion, currentVersionCode)
            val ignored = store.ignoredVersion == manifest.version
            release.value = if (newer && !ignored) manifest else null
            bannerDismissed.value = false
        }
    }

    /** 忽略当前提示的版本，本版本不再打扰。 */
    fun ignoreCurrentVersion() {
        val v = release.value?.version ?: return
        store.ignoredVersion = v
        release.value = null
    }

    /** 关掉弹窗但不写忽略、不清 [release]（下次检查还会提醒；关于页入口仍在）。 */
    fun dismiss() {
        bannerDismissed.value = true
    }

    fun startDownload() {
        val manifest = release.value ?: return
        val asset = manifest.primaryAsset
        if (asset == null) {
            downloadError.value = "清单里没有 APK 下载地址"
            phase.value = Phase.FAILED
            return
        }
        if (phase.value == Phase.DOWNLOADING) return
        downloadJob?.cancel()
        phase.value = Phase.DOWNLOADING
        downloadError.value = null
        downloadedBytes.value = 0L
        totalBytes.value = asset.size
        downloadJob = scope.launch {
            val file = runCatching {
                downloader.download(asset) { done, total ->
                    downloadedBytes.value = done
                    if (total > 0) totalBytes.value = total
                }
            }.getOrElse { e ->
                phase.value = Phase.FAILED
                downloadError.value = e.message ?: "下载失败"
                return@launch
            }
            apkFile.value = file
            phase.value = Phase.READY
            // 已授权就直接唤起安装器（用户体验：下载完自动弹出安装）
            if (downloader.canInstallPackages()) {
                phase.value = Phase.INSTALLING
                downloader.install(file)
            }
        }
    }

    fun cancelDownload() {
        downloadJob?.cancel()
        downloadJob = null
        phase.value = Phase.IDLE
        downloadedBytes.value = 0L
    }

    /**
     * 安装已下载的 APK；缺「安装未知应用」授权时返回引导页 intent（UI 负责 startActivity）。
     */
    fun installOrAsk(): Intent? {
        val file = apkFile.value ?: return null
        return if (downloader.install(file)) null else downloader.unknownSourcesIntent()
    }

    fun openReleaseHomepage(): Intent? {
        val url = release.value?.homepage?.takeIf { it.isNotBlank() } ?: return null
        return Intent(Intent.ACTION_VIEW, android.net.Uri.parse(url))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }

    /** 已经下载好的 APK（同一版本重复进入设置页时不必重下）。 */
    fun downloadExists(): Boolean = apkFile.value?.exists() == true
}
