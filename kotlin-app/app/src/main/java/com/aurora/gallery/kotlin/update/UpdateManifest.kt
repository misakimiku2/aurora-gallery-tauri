package com.aurora.gallery.kotlin.update

import org.json.JSONObject

/**
 * 更新清单（`update/android.json` / `update/desktop.json`）的数据模型与解析。
 *
 * 清单是「双源同格式」的核心：GitHub 与 Gitee 各托管一份同样 schema 的 JSON，
 * 客户端谁先取到用谁（GitHub 优先 + 短超时，失败降级 Gitee），因此 APK 的下载地址
 * 必须在清单内写死（Gitee 附件优先、GitHub 附件作 fallback_url）。
 *
 * 解析走 `org.json`（安卓内置，不引第三方 JSON 库）；字段一律容错为可空，
 * 缺字段降级为空串/0，不允许因为一个可选字段缺失就让整次检查失败。
 */

data class UpdateAsset(
    val kind: String,
    val name: String,
    val url: String,
    val fallbackUrl: String,
    val size: Long,
    val sizeText: String,
    val sha256: String,
)

data class UpdateManifest(
    val schema: Int,
    val platform: String,
    val version: String,
    val versionCode: Long,
    val releaseName: String,
    val releaseNotes: String,
    val publishedAt: String,
    val minVersionCode: Long,
    val homepage: String,
    val assets: List<UpdateAsset>,
) {
    /** 首选安装包（apk / installer），没有则回退第一个附件。 */
    val primaryAsset: UpdateAsset?
        get() = assets.firstOrNull { it.kind == "apk" || it.kind == "installer" } ?: assets.firstOrNull()

    /** 清单版本号是否已超过 [currentVersion]（严格 SemVer 比较，容忍 `v` 前缀）。 */
    fun isNewerThan(currentVersion: String, currentCode: Long): Boolean {
        if (versionCode > 0 && currentCode > 0) return versionCode > currentCode
        val latest = SemVer.parse(version) ?: return false
        val current = SemVer.parse(currentVersion) ?: return false
        return latest > current
    }
}

/** 极简语义化版本（只比 major/minor/patch 三段，预发布按字符串兜底，够更新判断用）。 */
data class SemVer(
    val major: Int,
    val minor: Int,
    val patch: Int,
    val prerelease: String = "",
) : Comparable<SemVer> {
    companion object {
        fun parse(raw: String): SemVer? {
            val v = raw.trim().trimStart('v', 'V')
            if (v.isEmpty()) return null
            val dash = v.indexOf('-')
            val core = if (dash >= 0) v.substring(0, dash) else v
            val pre = if (dash >= 0) v.substring(dash + 1) else ""
            val parts = core.split('.')
            if (parts.size !in 2..3) return null
            val nums = IntArray(3)
            for (i in parts.indices) {
                val n = parts[i].toIntOrNull() ?: return null
                nums[i] = n
            }
            return SemVer(nums[0], nums[1], nums[2], pre)
        }
    }

    override fun compareTo(other: SemVer): Int {
        if (major != other.major) return major.compareTo(other.major)
        if (minor != other.minor) return minor.compareTo(other.minor)
        if (patch != other.patch) return patch.compareTo(other.patch)
        // 无预发布后缀 = 正式版 > 预发布版
        if (prerelease.isEmpty() != other.prerelease.isEmpty()) {
            return if (prerelease.isEmpty()) 1 else -1
        }
        return prerelease.compareTo(other.prerelease)
    }
}

@Volatile
private var cachedParser: Boolean = true

/** 解析清单文本；任何结构问题都抛 [IllegalArgumentException]，由调用方降级到下一源。 */
fun parseUpdateManifest(text: String): UpdateManifest {
    val root = org.json.JSONObject(text)
    val assets = mutableListOf<UpdateAsset>()
    val arr = root.optJSONArray("assets")
    if (arr != null) {
        for (i in 0 until arr.length()) {
            val o = arr.optJSONObject(i) ?: continue
            val url = o.optString("url", "")
            if (url.isBlank()) continue
            assets += UpdateAsset(
                kind = o.optString("kind", ""),
                name = o.optString("name", ""),
                url = url,
                fallbackUrl = o.optString("fallback_url", ""),
                size = o.optLong("size", 0L),
                sizeText = o.optString("size_text", ""),
                sha256 = o.optString("sha256", ""),
            )
        }
    }
    val version = root.optString("version", "")
    if (version.isBlank()) throw IllegalArgumentException("manifest missing 'version'")
    return UpdateManifest(
        schema = root.optInt("schema", 1),
        platform = root.optString("platform", ""),
        version = version,
        versionCode = root.optLong("version_code", 0L),
        releaseName = root.optString("release_name", ""),
        releaseNotes = root.optString("release_notes", ""),
        publishedAt = root.optString("published_at", ""),
        minVersionCode = root.optLong("min_version_code", 0L),
        homepage = root.optString("homepage", ""),
        assets = assets,
    )
}
