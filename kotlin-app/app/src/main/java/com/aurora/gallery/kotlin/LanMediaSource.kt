package com.aurora.gallery.kotlin

import android.content.ContentUris
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import android.util.Log
import android.util.Size
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream

/**
 * M6a 阶段 7：服务端 MediaStore 数据面（对齐 `src-tauri/src/android/server/media_store.rs`，
 * Kotlin 原生直接走 ContentResolver，无需 JNI/裸路径读取）。
 *
 * 职责：文件夹分组（BUCKET_ID）、相册浏览、文件名搜索、缩略图与原图字节。所有 BrowseItem
 * 都是逐字段对齐 Rust `BrowseItem` serde 形状的 JSONObject——**null/None 一律省略字段**，
 * palette 恒省略（安卓端无调色板数据，与 handlers.rs 同一现状）。查询排序与 selection 均
 * 对齐 Rust 版：全量/浏览/搜索统一 `date_modified DESC`，selection_args 以字符串传
 * （SQLite 亲和性，Rust 同款做法）。日志 tag = "AuroraLanServer"。
 */
object LanMediaSource {

    private const val TAG = "AuroraLanServer"

    /** 一行 MediaStore 图片（对齐 Rust AndroidImageInfo 的实际使用面）。 */
    data class LanMediaImage(
        val id: Long,
        /** `_data` 裸路径（只用于根级散图判定，不用于读文件——读走 content uri）。 */
        val pathData: String,
        val name: String,
        val size: Long,
        val width: Int?,
        val height: Int?,
        val dateModified: Long,
        val mimeType: String,
        val bucketId: String,
        /** `BUCKET_DISPLAY_NAME` 原始值（存储根散图为 null/blank，归组时不看它，看路径）。 */
        val bucketName: String?,
    )

    /**
     * 全量扫描：`(folders, rootImages)`。
     *
     * 分组铁律（对齐 Rust is_root_level_image + scan_device_all 的分组口径）：`_data` 父目录
     * == 存储根（/storage/emulated/0 或 /sdcard）→ 根级散图；否则按 BUCKET_ID 归相册
     * （bucket_display_name 为 blank 但父目录非根的罕见行也归相册，名字兜底 bucketId）。
     * 查询已按 date_modified DESC → 每个 bucket 首个出现的行就是最新一张（封面元数据 +
     * preview_images 前 3 个 id）。两类列表均按 name lowercase 升序（Rust 同款稳定排序）。
     */
    fun scanAll(context: Context): Pair<List<JSONObject>, List<JSONObject>> {
        val rows = queryImages(context, null, emptyList())
        val folderRows = LinkedHashMap<String, MutableList<LanMediaImage>>()
        val rootRows = mutableListOf<LanMediaImage>()
        for (row in rows) {
            if (isRootLevelImage(row.pathData)) {
                rootRows += row
            } else {
                folderRows.getOrPut(row.bucketId) { mutableListOf() }.add(row)
            }
        }
        val folders = folderRows.map { (bucketId, imgs) ->
            val newest = imgs.first()
            folderBrowseItem(
                name = newest.bucketName?.takeIf { it.isNotBlank() } ?: bucketId,
                path = bucketId,
                count = imgs.size.toLong(),
                previews = imgs.take(3).map { it.id.toString() },
                cover = newest,
            )
        }.sortedBy { it.optString("name").lowercase() }
        val rootImages = rootRows.map { imageBrowseItem(it) }
            .sortedBy { it.optString("name").lowercase() }
        Log.i(TAG, "[LanServer] scanAll: ${folders.size} 个文件夹, ${rootImages.size} 张根目录图片")
        return folders to rootImages
    }

    /** 浏览指定 BUCKET_ID 相册（query 已按 date_modified DESC；Rust 的二次排序是稳定排序、同序）。 */
    fun browseBucket(context: Context, bucketId: String): List<JSONObject> =
        queryImages(context, "bucket_id = ?", listOf(bucketId)).map { imageBrowseItem(it) }

    /** 按文件名 LIKE 搜索（空/全空白 query 直接空列表，对齐 Rust search_images）。 */
    fun searchImages(context: Context, query: String): List<JSONObject> {
        val term = query.trim()
        if (term.isEmpty()) return emptyList()
        return queryImages(context, "_display_name LIKE ?", listOf("%$term%")).map { imageBrowseItem(it) }
    }

    /**
     * 缩略图字节（JPEG 85）：API 29+ 走 `loadThumbnail`（边长 clamp 到 32..512），更低版本
     * 回退两次 `openInputStream` + inSampleSize 解码（目标 ~256px）。任何异常返回 null
     * （handler 映射 404 "Thumbnail not available"）。
     */
    fun thumbnailBytes(context: Context, id: Long, size: Int): ByteArray? = try {
        val uri = contentUri(id)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val side = minOf(size, THUMBNAIL_MAX_SIDE).coerceAtLeast(THUMBNAIL_MIN_SIDE)
            compressJpeg(context.contentResolver.loadThumbnail(uri, Size(side, side), null))
        } else {
            legacyThumbnail(context, uri)
        }
    } catch (e: Exception) {
        Log.w(TAG, "[LanServer] 缩略图生成失败 id=$id: ${e.message}")
        null
    }

    /**
     * 原图字节 + MIME：先按 id 查行（mime_type）；mime 以 "image/" 开头才采用，缺失按扩展名
     * 兜底（.png/.gif/.webp/.bmp，否则 image/jpeg——对齐 Rust mime_type_of）。读字节走
     * content uri 的 `openInputStream`（作用域存储安全，app 有 READ_MEDIA_IMAGES）。
     * 查无此 id / 读失败返回 null（handler 映射 404 "Image not found"）。
     */
    fun imageBytes(context: Context, id: Long): Pair<ByteArray, String>? {
        val info = queryImages(context, "_id = ?", listOf(id.toString())).firstOrNull() ?: return null
        val bytes = try {
            context.contentResolver.openInputStream(contentUri(id))?.use { it.readBytes() }
        } catch (e: Exception) {
            Log.w(TAG, "[LanServer] 原图读取失败 id=$id: ${e.message}")
            null
        }
        if (bytes == null || bytes.isEmpty()) return null
        return bytes to mimeOf(info)
    }

    // —— 内部：查询 ——

    /** projection/sort 对齐 GalleryViewModel.scanMediaStore（比 Rust JNI 版少个 date_added，阶段 7 任务明令）。 */
    private val PROJECTION = arrayOf(
        MediaStore.Images.Media._ID,
        MediaStore.Images.Media.DISPLAY_NAME,
        MediaStore.Images.Media.DATA,
        MediaStore.Images.Media.SIZE,
        MediaStore.Images.Media.DATE_MODIFIED,
        MediaStore.Images.Media.WIDTH,
        MediaStore.Images.Media.HEIGHT,
        MediaStore.Images.Media.MIME_TYPE,
        MediaStore.Images.Media.BUCKET_ID,
        MediaStore.Images.Media.BUCKET_DISPLAY_NAME,
    )

    private val SORT_ORDER = "${MediaStore.Images.Media.DATE_MODIFIED} DESC"

    /** 存储根目录（对齐 Rust is_root_level_image 的两个判定值）。 */
    private val ROOT_DIRS = setOf("/storage/emulated/0", "/sdcard")

    /** MediaStore.Images 全量/条件查询；空游标关闭返回空列表（异常由 handler 捕获映射 500）。 */
    private fun queryImages(
        context: Context,
        selection: String?,
        selectionArgs: List<String>,
    ): List<LanMediaImage> {
        val out = mutableListOf<LanMediaImage>()
        context.contentResolver.query(
            MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
            PROJECTION,
            selection,
            selectionArgs.toTypedArray(),
            SORT_ORDER,
        )?.use { c ->
            val idCol = c.getColumnIndexOrThrow(MediaStore.Images.Media._ID)
            val nameCol = c.getColumnIndexOrThrow(MediaStore.Images.Media.DISPLAY_NAME)
            val dataCol = c.getColumnIndexOrThrow(MediaStore.Images.Media.DATA)
            val sizeCol = c.getColumnIndexOrThrow(MediaStore.Images.Media.SIZE)
            val widthCol = c.getColumnIndexOrThrow(MediaStore.Images.Media.WIDTH)
            val heightCol = c.getColumnIndexOrThrow(MediaStore.Images.Media.HEIGHT)
            val modifiedCol = c.getColumnIndexOrThrow(MediaStore.Images.Media.DATE_MODIFIED)
            val mimeCol = c.getColumnIndexOrThrow(MediaStore.Images.Media.MIME_TYPE)
            val bucketIdCol = c.getColumnIndexOrThrow(MediaStore.Images.Media.BUCKET_ID)
            val bucketNameCol = c.getColumnIndexOrThrow(MediaStore.Images.Media.BUCKET_DISPLAY_NAME)
            while (c.moveToNext()) {
                out += LanMediaImage(
                    id = c.getLong(idCol),
                    pathData = c.getString(dataCol) ?: "",
                    name = c.getString(nameCol) ?: "",
                    size = c.getLong(sizeCol),
                    width = if (c.isNull(widthCol)) null else c.getInt(widthCol),
                    height = if (c.isNull(heightCol)) null else c.getInt(heightCol),
                    dateModified = c.getLong(modifiedCol),
                    mimeType = c.getString(mimeCol) ?: "",
                    bucketId = c.getString(bucketIdCol) ?: "",
                    bucketName = c.getString(bucketNameCol),
                )
            }
        }
        return out
    }

    // —— 内部：BrowseItem 形状（逐字段对齐 Rust serde：null 一律省略） ——

    /** 文件夹 BrowseItem：size=图片数，preview_images=最新 ≤3 张的 id 字符串，封面取最新一张。 */
    private fun folderBrowseItem(
        name: String,
        path: String,
        count: Long,
        previews: List<String>,
        cover: LanMediaImage,
    ): JSONObject {
        val o = JSONObject()
            .put("name", name)
            .put("path", path)
            .put("type", "folder")
            .put("size", count)
            .put("preview_images", JSONArray(previews))
        // width/height/modified_at 取该夹最新一张（<=0 / null 则整个字段省略，Rust 同款）
        cover.width?.takeIf { it > 0 }?.let { o.put("width", it) }
        cover.height?.takeIf { it > 0 }?.let { o.put("height", it) }
        if (cover.dateModified > 0) o.put("modified_at", cover.dateModified)
        return o
    }

    /** 图片 BrowseItem：path=MediaStore id 字符串，thumbnail 指向本服务端缩略图端点。 */
    private fun imageBrowseItem(info: LanMediaImage): JSONObject {
        val o = JSONObject()
            .put("name", info.name)
            .put("path", info.id.toString())
            .put("type", "image")
        if (info.size > 0) o.put("size", info.size)
        o.put("thumbnail", "/api/thumbnail?path=${info.id}&size=256")
        info.width?.takeIf { it > 0 }?.let { o.put("width", it) }
        info.height?.takeIf { it > 0 }?.let { o.put("height", it) }
        if (info.dateModified > 0) o.put("modified_at", info.dateModified)
        return o
    }

    // —— 内部：字节面 ——

    /** API < 29 的缩略图回退：两次 openInputStream（先 bounds 后实解），inSampleSize 逼近 256px。 */
    private fun legacyThumbnail(context: Context, uri: Uri): ByteArray? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        context.contentResolver.openInputStream(uri)?.use {
            BitmapFactory.decodeStream(it, null, bounds)
        }
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
        var sample = 1
        while (bounds.outWidth / (sample * 2) >= THUMBNAIL_TARGET_SIDE &&
            bounds.outHeight / (sample * 2) >= THUMBNAIL_TARGET_SIDE
        ) {
            sample *= 2
        }
        val opts = BitmapFactory.Options().apply { inSampleSize = sample }
        val bmp = context.contentResolver.openInputStream(uri)?.use {
            BitmapFactory.decodeStream(it, null, opts)
        } ?: return null
        return compressJpeg(bmp)
    }

    /** 压 JPEG（质量 85）并回收位图；压缩失败返回 null。 */
    private fun compressJpeg(bmp: Bitmap): ByteArray? {
        if (bmp.isRecycled) return null
        val out = ByteArrayOutputStream()
        val ok = bmp.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, out)
        bmp.recycle()
        return if (ok) out.toByteArray() else null
    }

    /** mime 优先采用 MediaStore 行值（须以 image/ 开头），缺失按扩展名兜底（对齐 Rust mime_type_of）。 */
    private fun mimeOf(info: LanMediaImage): String {
        if (info.mimeType.isNotEmpty() && info.mimeType.startsWith("image/")) return info.mimeType
        val nameLower = info.name.lowercase()
        return when {
            nameLower.endsWith(".png") -> "image/png"
            nameLower.endsWith(".gif") -> "image/gif"
            nameLower.endsWith(".webp") -> "image/webp"
            nameLower.endsWith(".bmp") -> "image/bmp"
            else -> "image/jpeg"
        }
    }

    /** 父目录 == 存储根 → 不属于任何相册（对齐 Rust is_root_level_image：无 '/' 或路径为空都是 false）。 */
    private fun isRootLevelImage(pathData: String): Boolean {
        if (pathData.isEmpty()) return false
        val idx = pathData.lastIndexOf('/')
        if (idx < 0) return false
        return pathData.substring(0, idx) in ROOT_DIRS
    }

    private fun contentUri(id: Long): Uri =
        ContentUris.withAppendedId(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, id)

    private const val JPEG_QUALITY = 85

    /** 旧版本解码的目标边长（inSampleSize 估算基准，Rust generate_thumbnail 同量级）。 */
    private const val THUMBNAIL_TARGET_SIDE = 256

    /** loadThumbnail 请求边长的 clamp 下限（过小无意义）与上限（系统实现内部也在 512 封顶）。 */
    private const val THUMBNAIL_MIN_SIDE = 32
    private const val THUMBNAIL_MAX_SIDE = 512
}
