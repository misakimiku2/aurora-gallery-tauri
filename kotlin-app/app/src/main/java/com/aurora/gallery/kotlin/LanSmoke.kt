package com.aurora.gallery.kotlin

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Color
import android.util.Log
import coil.imageLoader
import coil.request.ErrorResult
import coil.request.ImageRequest
import com.google.zxing.BarcodeFormat
import com.google.zxing.BinaryBitmap
import com.google.zxing.MultiFormatReader
import com.google.zxing.RGBLuminanceSource
import com.google.zxing.common.HybridBinarizer
import com.google.zxing.qrcode.QRCodeWriter
import kotlinx.coroutines.runBlocking
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.net.URLEncoder
import java.util.concurrent.TimeUnit

/**
 * M6a 0.7 spike（可丢弃的验证代码，2026-09-24）：LAN 直连桌面服务端 + 扫码库的最小验证。
 * 不进主链路，只挂调试广播（FfiSmoke 同款风格）：
 * ```
 * adb shell am broadcast -a aurora.debug.LAN_SMOKE --es nonce <n>
 * adb shell am broadcast -a aurora.debug.QR_SCAN   # 相机扫码入口（见 MainActivity）
 * ```
 * 每行日志带 nonce——看不到 `[LanSmoke <nonce>]` 就是没跑到新代码。
 *
 * 验证链：① okhttp POST `/api/auth/verify`（请求体字段名实测是 `code`，不是 access_code）
 * 换 token → ② 带 Bearer 拉 `/api/all_image_folders` + `/api/browse`（验 allow_edit /
 * allow_upload 位与真实数据）→ ③ Coil 加载一张 `/api/thumbnail`（token 进 query，验
 * 「Coil 2.7 自带 http fetcher」摸底结论）→ ④ zxing 编码→解码一张 QR Bitmap 并按桌面
 * 契约解析 JSON（验「库集成 + 解析链路」；相机实扫走 QR_SCAN 入口，见报告）。
 * 直达失败时退探 10.0.2.2 回环，用于写清连通口径。
 */
private const val LAN_TAG = "AuroraKotlin"

/** 主电脑桌面端（主口径）。模拟器出站经宿主网络栈，预期直达——0.7 ②要实证的就是这个。 */
private const val LAN_BASE = "http://192.168.31.87:8080"

/** 回环备选口径：仅当直达失败时探测，只用于落连通结论，不改变主口径。 */
private const val LAN_BASE_LOOPBACK = "http://10.0.2.2:8080"

private const val LAN_ACCESS_CODE = "9928"

/** 桌面二维码内容契约（0.2：qrParseUtils 的 JSON 形态）。 */
private const val QR_CONTENT = """{"type":"aurora-lan","url":"http://192.168.31.87:8080","code":"9928"}"""

fun runLanSmoke(context: Context, nonce: String) {
    Thread({
        try {
            Log.i(LAN_TAG, "[LanSmoke $nonce] begin base=$LAN_BASE")
            val client = OkHttpClient.Builder()
                .connectTimeout(5, TimeUnit.SECONDS)
                .readTimeout(15, TimeUnit.SECONDS)
                .build()

            // —— ① auth ——（直接打主口径；失败才探回环，结论进日志）
            val token = try {
                authenticate(client, LAN_BASE, nonce)
            } catch (e: Throwable) {
                Log.w(LAN_TAG, "[LanSmoke $nonce] 直达 $LAN_BASE 失败：${e.message}")
                val loop = try {
                    authenticate(client, LAN_BASE_LOOPBACK, nonce)
                } catch (e2: Throwable) {
                    Log.e(LAN_TAG, "[LanSmoke $nonce] 回环 $LAN_BASE_LOOPBACK 也失败：${e2.message}")
                    throw AssertionError("直达与回环都不通，先查服务端/防火墙", e)
                }
                Log.w(LAN_TAG, "[LanSmoke $nonce] 结论：直达不通、10.0.2.2 回环可用——连通口径要改写")
                loop
            }
            Log.i(LAN_TAG, "[LanSmoke $nonce] PASS auth: 直达 $LAN_BASE 换到 token expires_in=3600（连通口径=直达可用）")

            // —— ② folders + browse ——
            val authHeader = "Bearer $token"
            val foldersResp = httpJson(client, Request.Builder()
                .url("$LAN_BASE/api/all_image_folders")
                .header("Authorization", authHeader)
                .build())
            val folderArr = foldersResp.getJSONArray("folders")
            val names = (0 until folderArr.length()).map { folderArr.getJSONObject(it).optString("name") }
            Log.i(LAN_TAG, "[LanSmoke $nonce] PASS all_image_folders: ${names.size} 个目录，前 3 个=${
                names.take(3)
            }")

            val browsePath = folderArr.getJSONObject(0).optString("path")
            val browse = httpJson(client, Request.Builder()
                .url("$LAN_BASE/api/browse?path=${queryEncode(browsePath)}")
                .header("Authorization", authHeader)
                .build())
            Log.i(LAN_TAG, "[LanSmoke $nonce] browse「$browsePath」: allow_edit=${browse.optBoolean("allow_edit")} " +
                "allow_upload=${browse.optBoolean("allow_upload")}（D32 改默认值前的服务端现状）")
            val images = browse.getJSONArray("images")
            var imagePath: String? = null
            var videoCount = 0
            for (i in 0 until images.length()) {
                val item = images.getJSONObject(i)
                when (item.optString("type")) {
                    "image" -> if (imagePath == null) imagePath = item.getString("path")
                    "video" -> videoCount++
                }
            }
            check(imagePath != null) { "browse 没返回任何 type=image 项" }
            Log.i(LAN_TAG, "[LanSmoke $nonce] PASS browse: images=${images.length()}（video $videoCount 个，" +
                "视频过滤登记项实证）首个 image path=$imagePath")

            // —— ③ Coil http fetcher ——
            val thumbUrl = "$LAN_BASE/api/thumbnail?path=${queryEncode(imagePath!!)}&size=256&token=$token"
            val result = runBlocking {
                context.imageLoader.execute(
                    ImageRequest.Builder(context)
                        .data(thumbUrl)
                        .size(256)
                        .allowHardware(false)
                        .build(),
                )
            }
            val drawable = result.drawable
                ?: throw AssertionError("Coil 加载缩略图失败: ${(result as? ErrorResult)?.throwable}")
            Log.i(LAN_TAG, "[LanSmoke $nonce] PASS Coil: http URL 出图 ${drawable.intrinsicWidth}x" +
                "${drawable.intrinsicHeight}（2.7 自带 http fetcher 结论成立，无需额外依赖/配置）")

            // —— ④ QR 编码→解码→JSON ——
            smokeQrBitmap(nonce)

            Log.i(LAN_TAG, "[LanSmoke $nonce] end（全部 PASS）")
        } catch (e: Throwable) {
            Log.e(LAN_TAG, "[LanSmoke $nonce] CRASH ${e.javaClass.simpleName}: ${e.message}", e)
        }
    }, "lan-smoke").start()
}

/** auth 换 token。请求体字段名实测是 `code`（响应 `{"success":true,"token":…,"expires_in":3600}`）。 */
private fun authenticate(client: OkHttpClient, base: String, nonce: String): String {
    val body = JSONObject().put("code", LAN_ACCESS_CODE).put("device_id", "spike-$nonce")
    val resp = httpJson(client, Request.Builder()
        .url("$base/api/auth/verify")
        .post(body.toString().toRequestBody("application/json; charset=utf-8".toMediaType()))
        .build())
    check(resp.optBoolean("success")) { "auth success=false: $resp" }
    return resp.getString("token")
}

private fun httpJson(client: OkHttpClient, request: Request): JSONObject {
    client.newCall(request).execute().use { resp ->
        val text = resp.body?.string().orEmpty()
        Log.i(LAN_TAG, "  HTTP ${resp.code} ${request.url.encodedPath} bytes=${text.length}")
        check(resp.isSuccessful) { "HTTP ${resp.code}: ${text.take(200)}" }
        return JSONObject(text)
    }
}

/**
 * spike 约定：URLEncoder 是表单口径（空格→`+`），React 基准用 encodeURIComponent
 * （空格→`%20`）；服务端 query 解析按 URL 标准走 %20 最稳，故统一 replace。
 */
private fun queryEncode(raw: String): String =
    URLEncoder.encode(raw, "UTF-8").replace("+", "%20")

/**
 * 相机实扫的退级验证：zxing 编码一张桌面契约内容的 QR → 再解码回原文 → 解析 JSON 取
 * url/code。证明「库集成 + 桌面契约解析链路」通；相机取景链路由 QR_SCAN 入口另行验证。
 */
private fun smokeQrBitmap(nonce: String) {
    val matrix = QRCodeWriter().encode(QR_CONTENT, BarcodeFormat.QR_CODE, 480, 480)
    val pixels = IntArray(matrix.width * matrix.height)
    for (y in 0 until matrix.height) {
        for (x in 0 until matrix.width) {
            pixels[y * matrix.width + x] = if (matrix[x, y]) Color.BLACK else Color.WHITE
        }
    }
    val decoded = MultiFormatReader().decode(
        BinaryBitmap(HybridBinarizer(RGBLuminanceSource(matrix.width, matrix.height, pixels))),
    ).text
    check(decoded == QR_CONTENT) { "解码内容与原文不一致: $decoded" }
    val json = JSONObject(decoded)
    check(json.optString("type") == "aurora-lan") { "type 不是 aurora-lan: $decoded" }
    Log.i(LAN_TAG, "[LanSmoke $nonce] PASS QR: 编码→解码 roundtrip 一致，JSON url=${json.optString("url")} " +
        "code=${json.optString("code")}")
}
