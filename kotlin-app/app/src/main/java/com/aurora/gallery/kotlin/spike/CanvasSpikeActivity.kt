package com.aurora.gallery.kotlin.spike

import android.app.Activity
import android.content.ContentUris
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.drawable.BitmapDrawable
import android.net.Uri
import android.os.Bundle
import android.os.Debug
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import android.util.Log
import android.view.Gravity
import android.view.MotionEvent
import android.view.ScaleGestureDetector
import android.view.View
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import coil.ImageLoader
import coil.decode.GifDecoder
import coil.decode.ImageDecoderDecoder
import coil.disk.DiskCache
import coil.memory.MemoryCache
import coil.request.ImageRequest
import java.io.File
import java.util.concurrent.ConcurrentHashMap
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

/**
 * M5 阶段 0.2 渲染 spike（一次性调试代码，结论落清单后整体删除）。
 *
 * 验证两条：
 *  ① Coil 按档解码 + 单自定义 View 一帧画 24 张 Bitmap 的帧率与内存（bulk 取图）；
 *  ② 放大超过解码档位时的再解码策略（手势结束触发高档重解码）的视觉与卡顿表现。
 *
 * adb 驱动（真双指注不进，用按钮做确定性缩放）：
 * ```
 * adb shell am start -n com.aurora.gallery.kotlin/.spike.CanvasSpikeActivity
 * adb shell input tap <x y>  # 按钮行在顶部
 * adb shell dumpsys gfxinfo com.aurora.gallery.kotlin framestats
 * ```
 */
class CanvasSpikeActivity : Activity() {

    companion object {
        internal const val TAG = "CanvasSpike"
        private const val TARGET_COUNT = 24
        /** 解码档位系数（相对世界尺寸的倍率） */
        internal val TIERS = floatArrayOf(0.12f, 0.25f, 0.5f, 1f, 2f, 4f)
        internal const val MAX_DECODE_PX = 2048
        internal var SKIP_DOT_GRID = true
    }

    class Item(val uri: Uri, val w: Float, val h: Float)

    private lateinit var spikeView: SpikeCanvasView
    private lateinit var status: TextView
    private val mainHandler = Handler(Looper.getMainLooper())

    private val imageLoader: ImageLoader by lazy {
        ImageLoader.Builder(this)
            .memoryCache { MemoryCache.Builder(this).maxSizePercent(0.30).build() }
            .diskCache {
                DiskCache.Builder()
                    .directory(File(cacheDir, "coil_spike_cache"))
                    .maxSizeBytes(200L * 1024 * 1024)
                    .build()
            }
            .crossfade(false)
            .components {
                if (android.os.Build.VERSION.SDK_INT >= 28) add(ImageDecoderDecoder.Factory())
                else add(GifDecoder.Factory())
            }
            .build()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val root = FrameLayout(this)
        spikeView = SpikeCanvasView(this, imageLoader) { runOnUiThread { status.text = spikeView.statusText() } }
        root.addView(spikeView, FrameLayout.LayoutParams(-1, -1))

        val bar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(8, 8, 8, 8)
        }
        fun btn(label: String, onClick: (View) -> Unit) {
            bar.addView(Button(this).apply { setText(label); setOnClickListener(onClick) },
                LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        }
        btn("Refit") { spikeView.autoFit() }
        btn("Zoom+") { spikeView.zoomStep(1.5f) }
        btn("Zoom-") { spikeView.zoomStep(1f / 1.5f) }
        btn("Pan") { spikeView.nudgePan() }
        root.addView(bar, FrameLayout.LayoutParams(-1, LinearLayout.LayoutParams.WRAP_CONTENT, Gravity.TOP))
        status = TextView(this).apply { setTextColor(Color.BLACK); textSize = 12f }
        root.addView(status, FrameLayout.LayoutParams(-2, -2, Gravity.BOTTOM or Gravity.START))
        setContentView(root)

        loadImages()
    }

    override fun onDestroy() {
        super.onDestroy()
        mainHandler.removeCallbacksAndMessages(null)
        spikeView.shutdown()
        // spike 专属缓存目录，不影响应用本体
        File(cacheDir, "coil_spike_cache").deleteRecursively()
    }

    private fun loadImages() {
        // adb push 的文件不保证已被 MediaStore 索引：先主动扫描 spike 目录，稍候再查
        val dir = File(
            android.os.Environment.getExternalStoragePublicDirectory(android.os.Environment.DIRECTORY_PICTURES),
            "spike",
        )
        val paths = dir.listFiles()?.map { it.absolutePath }.orEmpty()
        if (paths.isNotEmpty()) {
            android.media.MediaScannerConnection.scanFile(this, paths.toTypedArray(), null, null)
        }
        mainHandler.postDelayed({ queryAndLoad() }, 3_000)
    }

    private fun queryAndLoad() {
        val uris = ArrayList<Uri>()
        val projection = arrayOf(
            MediaStore.Images.Media._ID,
            MediaStore.Images.Media.RELATIVE_PATH,
        )
        // 先 spike（压力集：20 张 1600×1200 + 8k + 高图 + 2 张 4000×3000），不够从全库补足
        contentResolver.query(
            MediaStore.Images.Media.EXTERNAL_CONTENT_URI, projection,
            "${MediaStore.Images.Media.RELATIVE_PATH} LIKE ?", arrayOf("Pictures/spike%"),
            null,
        )?.use { c ->
            val id = c.getColumnIndexOrThrow(MediaStore.Images.Media._ID)
            while (c.moveToNext() && uris.size < TARGET_COUNT) {
                uris.add(imageUri(c.getLong(id)))
            }
        }
        if (uris.size < TARGET_COUNT) {
            contentResolver.query(
                MediaStore.Images.Media.EXTERNAL_CONTENT_URI, projection, null, null, null,
            )?.use { c ->
                val id = c.getColumnIndexOrThrow(MediaStore.Images.Media._ID)
                val seen = uris.toHashSet()
                while (c.moveToNext() && uris.size < TARGET_COUNT) {
                    val u = imageUri(c.getLong(id))
                    if (u !in seen) uris.add(u)
                }
            }
        }
        val items = uris.map { uri ->
            var w = 1000f; var h = 750f
            contentResolver.query(uri, arrayOf(MediaStore.Images.Media.WIDTH, MediaStore.Images.Media.HEIGHT), null, null, null)?.use { c ->
                if (c.moveToFirst()) {
                    if (!c.isNull(0)) w = c.getInt(0).toFloat()
                    if (!c.isNull(1)) h = c.getInt(1).toFloat()
                }
            }
            // bulk 这批 MediaStore 行 WIDTH/HEIGHT=1×1（无意义）：读 Bitmap 头部边界兜底（只解码头，代价小）
            if (w < 8f || h < 8f) {
                runCatching {
                    contentResolver.openInputStream(uri)?.use { input ->
                        val opts = android.graphics.BitmapFactory.Options().apply { inJustDecodeBounds = true }
                        android.graphics.BitmapFactory.decodeStream(input, null, opts)
                        if (opts.outWidth > 0) w = opts.outWidth.toFloat()
                        if (opts.outHeight > 0) h = opts.outHeight.toFloat()
                    }
                }
            }
            if (w <= 0f) w = 1000f
            if (h <= 0f) h = 750f
            Item(uri, w, h)
        }
        Log.i(TAG, "loaded ${items.size} items: " + items.joinToString { "${it.w.toInt()}x${it.h.toInt()}" })
        spikeView.setItems(items)
    }

    private fun imageUri(id: Long): Uri =
        ContentUris.withAppendedId(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, id)
}

/**
 * spike 画布 View：世界变换 + 点阵背景 + 可见 item 的 drawBitmap。
 * 手势只实现捏合/单指平移（spike 够用），再解码在手势结束触发。
 */
private class SpikeCanvasView(
    context: android.content.Context,
    val loader: ImageLoader,
    val onChange: () -> Unit,
) : View(context) {

    class Loaded(val bitmap: Bitmap, val tier: Float)

    val items = ArrayList<CanvasSpikeActivity.Item>()
    val rects = ArrayList<FloatArray>() // x,y,w,h
    val bitmaps = ConcurrentHashMap<Int, Loaded>()
    val pending = ConcurrentHashMap<Pair<Int, Int>, Boolean>()
    private val mainHandler = Handler(Looper.getMainLooper())

    // 世界变换
    var tx = 0f; var ty = 0f; var scale = 1f
    var fitDone = false

    // 当前解码档位索引
    var tierIndex = 2 // 0.5×
    var lastRedecodeMs = 0L
    var fps = 0

    private val bgPaint = Paint().apply { color = 0xFF111827.toInt() }
    private val dotPaint = Paint().apply { color = Color.argb(51, 107, 114, 128) }
    private val strokePlain = Paint().apply {
        style = Paint.Style.STROKE; color = 0x14000000; strokeWidth = 1f
    }

    fun shutdown() {
        mainHandler.removeCallbacksAndMessages(null)
        bitmaps.clear()
    }

    fun setItems(list: List<CanvasSpikeActivity.Item>) {
        items.clear()
        items.addAll(list)
        // 简单行包装箱（spike 只关心渲染规模，正式装箱在 M5-1.4 转译 layout.ts）
        rects.clear()
        var px = 0f; var py = 0f; var rh = 0f
        for (it in items) {
            if (px > 0 && px + it.w > 4000f) { px = 0f; py += rh + 40f; rh = 0f }
            rects.add(floatArrayOf(px, py, it.w, it.h))
            px += it.w + 40f
            rh = max(rh, it.h)
        }
        post { autoFit() }
        // 初始解码由 autoFit 定档后经 refitDecode 触发，避免先按错档解码一遍
    }

    fun statusText(): String =
        "scale=%.2f tier=%.2f decoded=%d/%d pend=%d redecode=%dms heap=%dMB fps=%d".format(
            scale, Tiers[tierIndex], bitmaps.size, items.size, pending.size, lastRedecodeMs,
            (Runtime.getRuntime().totalMemory() - Runtime.getRuntime().freeMemory()) / (1024 * 1024),
            fps,
        )

    private val Tiers get() = CanvasSpikeActivity.TIERS

    /** 请求某 item 按指定档位解码（Coil size + 显式缓存键） */
    private fun requestDecode(index: Int, tierIdx: Int) {
        if (index >= items.size) return
        if (pending.putIfAbsent(index to tierIdx, true) != null) return
        val item = items[index]
        val tier = Tiers[tierIdx]
        val tw = (item.w * tier).toInt().coerceIn(32, CanvasSpikeActivity.MAX_DECODE_PX)
        val th = (item.h * tier).toInt().coerceIn(32, CanvasSpikeActivity.MAX_DECODE_PX)
        val t0 = now()
        val req = ImageRequest.Builder(context)
            .data(item.uri)
            .size(tw, th)
            .memoryCacheKey("spike:${index}:$tierIdx")
            .diskCacheKey("spike:$index")
            .target(
                onSuccess = { drawable ->
                    val bmp = (drawable as? BitmapDrawable)?.bitmap
                    if (bmp != null) {
                        Log.i(CanvasSpikeActivity.TAG, "decoded #$index tier=$tierIdx ${bmp.width}x${bmp.height} in ${now() - t0}ms")
                        bitmaps[index] = Loaded(bmp, tier)
                        post { invalidate(); onChange() }
                    }
                    pending.remove(index to tierIdx)
                },
                onError = { pending.remove(index to tierIdx) },
            )
            .build()
        loader.enqueue(req)
    }

    private fun now(): Long = android.os.SystemClock.uptimeMillis()

    fun autoFit() {
        if (items.isEmpty() || width == 0 || height == 0) return
        var minX = Float.MAX_VALUE; var minY = Float.MAX_VALUE
        var maxX = -Float.MAX_VALUE; var maxY = -Float.MAX_VALUE
        for (r in rects) {
            minX = min(minX, r[0]); minY = min(minY, r[1])
            maxX = max(maxX, r[0] + r[2]); maxY = max(maxY, r[1] + r[3])
        }
        val cw = maxX - minX; val chh = maxY - minY
        if (cw <= 0 || chh <= 0) return
        val padding = 60f
        val s = min(min((width - padding * 2) / cw, (height - padding * 2) / chh), 1.2f)
        scale = s
        tx = width / 2f - (minX + cw / 2f) * s
        ty = height / 2f - (minY + chh / 2f) * s
        tierIndex = tierForScale(s)
        refitDecode()
        invalidate(); onChange()
    }

    private fun tierForScale(s: Float): Int {
        val need = s * resources.displayMetrics.density
        var best = 0
        for (i in Tiers.indices) if (Tiers[i] <= need * 1.25f) best = i
        return best
    }

    /** 全量对齐到当前档位（跳过已在档的） */
    private fun refitDecode() {
        for (i in items.indices) {
            val cur = bitmaps[i]
            if (cur == null || abs(cur.tier - Tiers[tierIndex]) > 0.001f) requestDecode(i, tierIndex)
        }
    }

    fun zoomStep(factor: Float) {
        applyZoom(factor, width / 2f, height / 2f)
        onGestureEnd()
    }

    fun nudgePan() {
        tx += 80f; ty += 40f
        invalidate(); onChange()
    }

    private fun applyZoom(factor: Float, fx: Float, fy: Float) {
        val newScale = (scale * factor).coerceIn(0.01f, 20f)
        val ratio = newScale / scale
        tx = fx - (fx - tx) * ratio
        ty = fy - (fy - ty) * ratio
        scale = newScale
        invalidate(); onChange()
    }

    /** 手势结束：按需重解码高档 */
    fun onGestureEnd() {
        val want = tierForScale(scale)
        if (want != tierIndex) {
            tierIndex = want
            refitDecode()
            Log.i(CanvasSpikeActivity.TAG, "redecode tier=$want")
            onChange()
        }
    }

    private val scaleDetector = ScaleGestureDetector(context, object : ScaleGestureDetector.SimpleOnScaleGestureListener() {
        override fun onScale(detector: ScaleGestureDetector): Boolean {
            applyZoom(detector.scaleFactor, detector.focusX, detector.focusY)
            return true
        }
    })

    private var lastX = 0f; private var lastY = 0f

    override fun onTouchEvent(event: MotionEvent): Boolean {
        scaleDetector.onTouchEvent(event)
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> { lastX = event.x; lastY = event.y }
            MotionEvent.ACTION_MOVE -> if (!scaleDetector.isInProgress) {
                tx += event.x - lastX; ty += event.y - lastY
                lastX = event.x; lastY = event.y
                invalidate(); onChange()
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> onGestureEnd()
        }
        return true
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        if (!fitDone && w > 0) { fitDone = true; autoFit() }
    }

    private var frameCount = 0
    private var lastFrameLog = 0L
    private var checkedHw = false

    override fun onDraw(canvas: Canvas) {
        val t0 = now()
        if (!checkedHw) {
            checkedHw = true
            Log.i(
                CanvasSpikeActivity.TAG,
                "canvasHW=" + canvas.isHardwareAccelerated +
                    " viewHW=" + isHardwareAccelerated +
                    " bmpCfg=" + (bitmaps[0]?.bitmap?.config?.name ?: "none"),
            )
        }
        canvas.drawColor(Color.WHITE)
        // A/B spike：点阵背景性能嫌疑最大，此开关用于 attribut（结论落清单后删）
        if (!CanvasSpikeActivity.SKIP_DOT_GRID) {
        var g = 40f * scale
        if (g < 15f) { g *= max(1, (30f / g).toInt()) }
        if (g >= 8f) {
            val radius = if (scale < 0.2f) 1.5f else 1.2f
            var ox = tx % g; if (ox < 0) ox += g
            var oy = ty % g; if (oy < 0) oy += g
            var xx = ox
            while (xx < width) {
                var yy = oy
                while (yy < height) {
                    canvas.drawCircle(xx, yy, radius, dotPaint)
                    yy += g
                }
                xx += g
            }
        }
        }
        val save = canvas.save()
        canvas.translate(tx, ty)
        canvas.scale(scale, scale)
        val dst = android.graphics.RectF()
        for (i in rects.indices) {
            val r = rects[i]
            // 可见裁剪（AABB）
            if (r[0] + r[2] < -tx / scale || r[0] > (width - tx) / scale ||
                r[1] + r[3] < -ty / scale || r[1] > (height - ty) / scale
            ) continue
            val cx = r[0] + r[2] / 2f; val cy = r[1] + r[3] / 2f
            canvas.save()
            canvas.translate(cx, cy)
            canvas.drawRect(-r[2] / 2f, -r[3] / 2f, r[2] / 2f, r[3] / 2f, bgPaint)
            bitmaps[i]?.let { ld ->
                dst.set(-r[2] / 2f, -r[3] / 2f, r[2] / 2f, r[3] / 2f)
                canvas.drawBitmap(ld.bitmap, null, dst, null)
            }
            canvas.drawRect(-r[2] / 2f, -r[3] / 2f, r[2] / 2f, r[3] / 2f, strokePlain)
            canvas.restore()
        }
        canvas.restoreToCount(save)
        val cost = now() - t0
        frameCount++
        val n = now()
        if (n - lastFrameLog > 1000) {
            fps = frameCount
            frameCount = 0
            lastFrameLog = n
            if (cost > 16) Log.i(CanvasSpikeActivity.TAG, "draw ${cost}ms scale=$scale")
            onChange()
        }
    }
}
