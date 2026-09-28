package com.aurora.gallery.kotlin.update

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import androidx.core.content.FileProvider
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.isActive
import kotlinx.coroutines.withContext
import okhttp3.Request
import java.io.File
import java.io.FileOutputStream
import kotlin.coroutines.coroutineContext

/**
 * APK 下载与安装（D50：应用内下载 + 唤起系统安装界面）。
 *
 * 存储位置选内部 `filesDir/updates/`：① 不需要任何存储权限（Android 10+ 分区存储下
 * 公共 Download 目录需要 SAF 或权限）；② 卸载即清理；③ 配合 FileProvider 授权给
 * 安装器读取（Android 7+ 禁止 file:// 跨包传递，必须走 content://）。
 *
 * 安装权限：Android 8+ 需在 Manifest 声明 `REQUEST_INSTALL_PACKAGES`，且用户要在
 * 系统「允许来自此来源的应用」里打开开关——这是**无法用运行时弹窗直接申请**的特殊
 * 权限，只能把用户送到设置页（[unknownSourcesIntent]）。
 */
class ApkDownloader(private val context: Context) {

    /** 下载目录（每次新下载前清空，只保留最新一个 APK）。 */
    private val dir: File get() = File(context.filesDir, "updates").apply { mkdirs() }

    /** Android 8+ 是否已有「安装未知应用」授权。 */
    fun canInstallPackages(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return true
        return context.packageManager.canRequestPackageInstalls()
    }

    /** 跳系统「允许来自此来源的应用」开关页的意图（已授权时返回 null）。 */
    fun unknownSourcesIntent(): Intent? {
        if (canInstallPackages()) return null
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return null
        return Intent(
            android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
            Uri.parse("package:${context.packageName}"),
        ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }

    /**
     * 下载 [asset]：主 URL 失败自动换 `fallback_url`（Gitee 附件 → GitHub 附件）。
     * [onProgress] 传已下载/总字节（总大小未知时为 -1）。
     */
    @Throws(Exception::class)
    suspend fun download(asset: UpdateAsset, onProgress: (Long, Long) -> Unit): File =
        withContext(Dispatchers.IO) {
            dir.listFiles()?.forEach { it.delete() }
            var lastError: Exception? = null
            val candidates = listOf(asset.url, asset.fallbackUrl).filter { it.isNotBlank() }
            for (url in candidates) {
                try {
                    return@withContext downloadFrom(url, asset.name, onProgress)
                } catch (e: Exception) {
                    lastError = e
                    if (!coroutineContext.isActive) throw e
                }
            }
            throw lastError ?: IllegalStateException("清单里没有可用的下载地址")
        }

    private fun downloadFrom(url: String, rawName: String, onProgress: (Long, Long) -> Unit): File {
        val name = rawName.takeIf { it.endsWith(".apk", ignoreCase = true) }
            ?: "aurora-update-${System.currentTimeMillis()}.apk"
        val part = File(dir, "$name.part")
        if (part.exists()) part.delete()
        val request = Request.Builder().url(url).header("User-Agent", "AuroraGallery-Updater/1.0").build()
        UpdateClient.downloadClient.newCall(request).execute().use { response ->
            if (!response.isSuccessful) throw IllegalStateException("下载失败：HTTP ${response.code}")
            val body = response.body ?: throw IllegalStateException("下载失败：空响应体")
            val total = body.contentLength()
            var downloaded = 0L
            var lastReport = 0L
            body.byteStream().use { input ->
                FileOutputStream(part).use { out ->
                    val buf = ByteArray(64 * 1024)
                    while (true) {
                        val read = input.read(buf)
                        if (read <= 0) break
                        out.write(buf, 0, read)
                        downloaded += read
                        // 节流回传：200ms 一次足够刷 UI，别每行 chunk 都触发重组
                        val now = System.currentTimeMillis()
                        if (now - lastReport > 200) {
                            lastReport = now
                            onProgress(downloaded, total)
                        }
                    }
                }
            }
            onProgress(downloaded, total)
            val target = File(dir, name)
            if (target.exists()) target.delete()
            if (!part.renameTo(target)) throw IllegalStateException("无法写入安装包：$target")
            return target
        }
    }

    /** 唤起系统安装界面。返回 false 表示缺「安装未知应用」授权（需先跳设置页）。 */
    fun install(file: File): Boolean {
        if (!canInstallPackages()) return false
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file)
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, "application/vnd.android.package-archive")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        context.startActivity(intent)
        return true
    }
}
