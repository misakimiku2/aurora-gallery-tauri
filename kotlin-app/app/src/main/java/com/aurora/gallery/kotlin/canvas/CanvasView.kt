package com.aurora.gallery.kotlin.canvas

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapShader
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Shader
import android.net.Uri
import android.util.Log
import android.view.View
import coil.request.ImageRequest
import coil.request.SuccessResult
import com.aurora.gallery.kotlin.ui.theme.AuroraPalette
import com.aurora.gallery.kotlin.ui.theme.AuroraPalettes
import com.aurora.gallery.kotlin.viewer.CoilSource
import com.aurora.gallery.kotlin.viewer.SharedCoil
import java.nio.ByteBuffer
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlin.math.max
import kotlin.math.min

/**
 * 画布视图本体（M5 1.2，D7 同款宿主形态：View 体系单自定义 View，外层 Compose
 * `AndroidView` 承载）。**不抄 React 的 canvas2D 绘制管线**（drawCanvas/mipmap/
 * requestAnimationFrame 是 Web 路径），对应物：
 *  - 世界变换：`Canvas` 的 translate/scale（对齐 React `ctx.setTransform`）；
 *  - 可见裁剪：自算视口 AABB + item 旋转 AABB 求交（React `getVisibleItems:541`）;
 *  - mipmap：D25 = Coil 按显示档位解码（[decodeTierFor]），内存缓存 key 带档位、
 *    磁盘 key 沿用查看器 `aurora-viewer:<fileId>`（同实例 ImageLoader，见 SharedCoil）；
 *  - 动画：[animateViewportTo]（Choreographer lerp，对齐 React startAnimation 的
 *    「约 40ms 时间缓动」）。
 *
 * 数据只读 [CanvasStore]（唯一写者纪律的例外：视口手势由本视图就地写 store 后自行
 * invalidate，不绕道重组）。宿主经 [sync] 推送结构性变化（items/选中/编辑态/主题）。
 */
class CanvasView @JvmOverloads constructor(
    context: Context,
    attrs: android.util.AttributeSet? = null,
) : View(context, attrs) {

    companion object {
        internal const val TAG = "AuroraCanvas"

        /** React 捏合限界 0.01–20（viewport.ts 同款默认，zoomAtPoint 内亦钳制）。 */
        private const val DOT_SPACING_WORLD = 40f

        /** 解码档位系数（相对 item 世界尺寸的倍数）。 */
        private val TIERS = floatArrayOf(0.25f, 0.5f, 1f, 2f, 4f)

        /** 单张解码上限（px）；超出的放大幅度靠 GPU 双线性放大（React mipmap 同思路）。 */
        private const val MAX_DECODE_PX = 2048
        private const val MIN_DECODE_PX = 64
    }

    private val imageLoader by lazy { SharedCoil.get(context) }

    /** 解码协程域（取流/解码不占主线程；detach 时整体取消）。 */
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    fun attachStore(store: CanvasStore) {
        this.store = store
    }

    private var store: CanvasStore? = null

    private var dark = false
    private var palette: AuroraPalette = AuroraPalettes.of(false)

    // —— 绘制资源（惰性建，onDraw 内零分配目标）——
    private val bgPaint = Paint()
    private val placeholderPaint = Paint()
    private val selectedStroke = Paint().apply { style = Paint.Style.STROKE }
    private val plainStroke = Paint().apply { style = Paint.Style.STROKE }
    private val bitmapPaint = Paint().apply { isFilterBitmap = true }
    private val dotPaint = Paint().apply { style = Paint.Style.FILL }
    private val dstRect = RectF()

    /** 点阵背景平铺（BitmapShader 一次 drawRect；React 逐点 arc 在 CPU 光栅化下太贵）。 */
    private var dotShader: BitmapShader? = null
    private var dotShaderSize = 0f

    // —— 解码状态 ——
    private class Entry(val bitmap: Bitmap, val tier: Float)

    private val bitmaps = HashMap<String, Entry>()
    private val inflight = HashSet<Pair<String, Int>>()

    /** 当前解码档位索引（视口变化时重算；手势/缩放结束后对可见项重解码）。 */
    private var tierIndex = 0

    // —— 视口动画（React startAnimation 同款：单循环 lerp，约 40ms 时间缓动）——
    private var animTarget: CanvasViewport? = null
    private var animLastFrameNs = 0L

    private val density = resources.displayMetrics.density

    // ------------------------------------------------------------ 生命周期

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        // 容器就绪后消费 autoFit pending（1.4）。post 出布局 pass：autoFit 会写
        // store 状态，别在布局过程中做
        if (w > 0 && h > 0) post { autoFitIfPending() }
    }

    override fun onDetachedFromWindow() {
        animTarget = null
        removeCallbacks(animStep)
        scope.cancel()
        super.onDetachedFromWindow()
    }

    /** 主题档变化（宿主 M4c 主题链调用；未变化时 no-op，避免点阵无谓重建）。 */
    fun applyTheme(dark: Boolean) {
        this.dark = dark
        palette = AuroraPalettes.of(dark)
        bgPaint.color = palette.content
        placeholderPaint.color = palette.placeholderBg
        selectedStroke.color = palette.primary
        plainStroke.color = palette.hairline
        dotPaint.color = palette.textSecondary
        dotPaint.alpha = if (dark) 64 else 51 // React: 0.25 深 / 0.2 浅
        dotShader = null // 换档重建点阵
        invalidate()
    }

    /**
     * 宿主在结构性变化（items/选中/编辑态/换图）后调用：保证可见项的解码在飞、
     * 重绘。视口变化不经过这里（手势路径自己保证）。
     */
    fun sync() {
        val s = store ?: return
        if (!tmpCleaned) {
            // 进画布会话的头部清一次上一会话的大图临时文件残留（此时本会话解码未起）
            tmpCleaned = true
            tmpDirFor().deleteRecursively()
            tmpDirFor()
        }
        // 画布为空时清掉旧位图引用（移除图后的内存回收；内存缓存由 Coil LRU 管理）
        bitmaps.keys.retainAll { id -> s.itemById.containsKey(id) }
        updateTierForScale()
        ensureVisibleDecodes()
        autoFitIfPending()
        invalidate()
    }

    private var tmpCleaned = false

    // ------------------------------------------------------------ 档位与解码

    private fun updateTierForScale() {
        val s = store ?: return
        val need = s.viewport.scale * density
        var best = 0
        for (i in TIERS.indices) {
            if (TIERS[i] <= need * 1.25f) best = i
        }
        tierIndex = best
    }

    /** 视口变化后调用：保证可见项都有当前档位位图（缺则发起解码，去重在飞请求）。 */
    private fun ensureVisibleDecodes() {
        val s = store ?: return
        val viewportAABB = visibleWorldAABB(s) ?: return
        val order = drawOrder(s)
        for (id in order) {
            val item = s.itemById[id] ?: continue
            val aabb = item.aabb()
            if (!aabbOverlap(aabb, viewportAABB)) continue
            val entry = bitmaps[id]
            if (entry != null && entry.tier == TIERS[tierIndex]) continue
            requestDecode(item, tierIndex)
        }
    }

    private fun requestDecode(item: CanvasItem, tierIdx: Int) {
        val s = store ?: return
        if (!inflight.add(item.fileId to tierIdx)) return
        val tier = TIERS[tierIdx]
        val tw = (item.width * tier).toInt().coerceIn(MIN_DECODE_PX, MAX_DECODE_PX)
        val th = (item.height * tier).toInt().coerceIn(MIN_DECODE_PX, MAX_DECODE_PX)
        val fileId = item.fileId
        val uri = s.contentUriOf(fileId).orEmpty()
        val t0 = android.os.SystemClock.uptimeMillis()
        scope.launch {
            // 并发闸（3）：24 张首屏同启的话，瞬时 byte[] + 解码位图会顶穿 192MB 堆
            //（spike/实测：20 张 5.5MB 并发读 = 110MB 瞬时 → OOM 崩进程）
            decodeGate.withPermit {
                try {
                    // 取流在 IO 线程（小文件读 bytes、大文件拷临时文件，见 canvasSourceFor）
                    val src = withContext(Dispatchers.IO) {
                        canvasSourceFor(fileId, uri, context.contentResolver, tierIdx, tmpDirFor())
                    }
                    val request = ImageRequest.Builder(context)
                        .apply {
                            data(src.data)
                            src.diskKey?.let { diskCacheKey(it) }
                            src.memoryKey?.let { memoryCacheKey(it) }
                        }
                        .size(tw, th)
                        .build()
                    val result = imageLoader.execute(request)
                    val bmp = (result.drawable as? android.graphics.drawable.BitmapDrawable)?.bitmap
                    if (result is SuccessResult && bmp != null) {
                        Log.i(TAG, "decoded $fileId tier=$tierIdx ${bmp.width}x${bmp.height} in ${android.os.SystemClock.uptimeMillis() - t0}ms")
                        bitmaps[fileId] = Entry(bmp, tier)
                    } else {
                        Log.w(TAG, "decode failed $fileId tier=$tierIdx", (result as? coil.request.ErrorResult)?.throwable)
                    }
                } catch (e: Exception) {
                    Log.w(TAG, "decode error $fileId tier=$tierIdx", e)
                } finally {
                    inflight.remove(fileId to tierIdx)
                    invalidate()
                }
            }
        }
    }

    private val decodeGate = kotlinx.coroutines.sync.Semaphore(3)

    /** 画布大图临时目录（cacheDir 下，「清除缓存」自动覆盖；进画布时清一次残留）。 */
    private fun tmpDirFor(): java.io.File =
        java.io.File(context.cacheDir, "canvas_tmp").apply { mkdirs() }

    // ------------------------------------------------------------ 视口操作

    /**
     * 视口动画到 [target]（React startAnimation:682-727 的时间缓动 lerp；ease ≈
     * min(1, dt×0.025)，即约 40ms 走完 90%）。新手势/新动画会取消前一个。
     */
    fun animateViewportTo(target: CanvasViewport) {
        animTarget = target
        animLastFrameNs = 0L
        postOnAnimation(animStep)
    }

    private val animStep = object : Runnable {
        override fun run() {
            val s = store ?: return
            val target = animTarget ?: return
            val nowNs = android.os.SystemClock.uptimeMillis() * 1_000_000L
            val dtMs = if (animLastFrameNs == 0L) 16L else (nowNs - animLastFrameNs) / 1_000_000L
            animLastFrameNs = nowNs
            val ease = min(1f, dtMs * 0.025f)
            val cur = s.viewport
            val nx = cur.x + (target.x - cur.x) * ease
            val ny = cur.y + (target.y - cur.y) * ease
            val ns = cur.scale + (target.scale - cur.scale) * ease
            val close = kotlin.math.abs(nx - target.x) < 0.5f &&
                kotlin.math.abs(ny - target.y) < 0.5f &&
                kotlin.math.abs(ns - target.scale) < 0.005f
            if (close) {
                s.applyViewport(target)
                animTarget = null
            } else {
                s.applyViewport(CanvasViewport(nx, ny, ns))
                postOnAnimation(this)
            }
            updateTierForScale()
            ensureVisibleDecodes()
            invalidate()
        }
    }

    /** 取消进行中的视口动画（新手势落下时）。 */
    fun cancelViewportAnimation() {
        animTarget = null
        removeCallbacks(animStep)
    }

    /** autoFit pending 消费（1.4：首批加载完成 / 加图后的 fit；React shouldAutoFitAfterLoadRef）。 */
    private fun autoFitIfPending() {
        val s = store ?: return
        if (width == 0 || height == 0) return
        if (s.applyAutoFitIfPending(width.toFloat(), height.toFloat())) {
            updateTierForScale()
            ensureVisibleDecodes()
            invalidate()
        }
    }

    /** 「查看全部」/「重置画布」后的主动 fit（动画到位）。 */
    fun fitToContent() {
        val s = store ?: return
        val bounds = s.contentBounds() ?: return
        val fit = computeFitTransform(width.toFloat(), height.toFloat(), bounds) ?: return
        s.markInteracted()
        animateViewportTo(fit)
    }

    // ------------------------------------------------------------ 绘制

    private fun visibleWorldAABB(s: CanvasStore): CanvasAABB? {
        val t = s.viewport
        if (t.scale <= 0f) return null
        val buffer = min(100f / t.scale, 5000f) // React :550 同款缓冲，防边缘闪烁
        val minX = -t.x / t.scale - buffer
        val minY = -t.y / t.scale - buffer
        val maxX = (width - t.x) / t.scale + buffer
        val maxY = (height - t.y) / t.scale + buffer
        return CanvasAABB(minX, minY, maxX, maxY)
    }

    /** 绘制序：z 序过滤掉已删除项（React drawOrder :556 同款）。 */
    private fun drawOrder(s: CanvasStore): List<String> =
        s.zOrderIds.filter { s.itemById.containsKey(it) }

    @SuppressLint("DrawAllocation")
    override fun onDraw(canvas: Canvas) {
        val s = store ?: return
        val t0 = if (Log.isLoggable(TAG, Log.DEBUG)) android.os.SystemClock.uptimeMillis() else 0L

        canvas.drawColor(palette.content)
        drawDotGrid(canvas, s)

        val save = canvas.save()
        canvas.translate(s.viewport.x, s.viewport.y)
        canvas.scale(s.viewport.scale, s.viewport.scale)

        val viewportAABB = visibleWorldAABB(s)
        var drawn = 0
        if (viewportAABB != null) {
            for (id in drawOrder(s)) {
                val item = s.itemById[id] ?: continue
                if (!aabbOverlap(item.aabb(), viewportAABB)) continue
                drawn++
                drawItem(canvas, s, item)
            }
        }
        canvas.restoreToCount(save)

        if (t0 > 0L) {
            val cost = android.os.SystemClock.uptimeMillis() - t0
            if (cost > 16) Log.d(TAG, "draw ${cost}ms scale=${s.viewport.scale} drawn=$drawn")
        }
    }

    private fun drawItem(canvas: Canvas, s: CanvasStore, item: CanvasItem) {
        canvas.save()
        canvas.translate(item.centerX, item.centerY)
        if (item.rotation != 0f) canvas.rotate(item.rotation)
        val hw = item.width / 2f
        val hh = item.height / 2f
        dstRect.set(-hw, -hh, hw, hh)
        canvas.drawRect(dstRect, placeholderPaint)
        bitmaps[item.fileId]?.let { entry ->
            canvas.drawBitmap(entry.bitmap, null, dstRect, bitmapPaint)
        }
        // 选中描边 4/scale（React :646-658）；未选项细描边（hairline）
        if (item.fileId in s.selectedIds) {
            selectedStroke.strokeWidth = 4f / s.viewport.scale
            canvas.drawRect(dstRect, selectedStroke)
        } else {
            plainStroke.strokeWidth = 1f / s.viewport.scale
            canvas.drawRect(dstRect, plainStroke)
        }
        canvas.restore()
    }

    /** 点阵背景（React :594-617 的 spacing/step 语义；实现为 BitmapShader 平铺）。 */
    private fun drawDotGrid(canvas: Canvas, s: CanvasStore) {

        var gridSize = DOT_SPACING_WORLD * s.viewport.scale
        if (gridSize < 15f) {
            gridSize *= max(1f, kotlin.math.floor(30f / gridSize))
        }
        if (gridSize < 8f) return
        if (dotShader == null || kotlin.math.abs(dotShaderSize - gridSize) > 0.5f) {
            dotShader = buildDotShader(gridSize)
            dotShaderSize = gridSize
        }
        val shader = dotShader ?: return
        val m = Matrix()
        val ox = s.viewport.x % gridSize
        val oy = s.viewport.y % gridSize
        m.setTranslate(ox, oy)
        shader.setLocalMatrix(m)
        dotPaint.shader = shader
        canvas.drawRect(0f, 0f, width.toFloat(), height.toFloat(), dotPaint)
        dotPaint.shader = null
    }

    private fun buildDotShader(gridSize: Float): BitmapShader {
        val sizePx = gridSize.toInt().coerceIn(8, 256)
        val bmp = Bitmap.createBitmap(sizePx, sizePx, Bitmap.Config.ARGB_8888)
        val c = Canvas(bmp)
        val radius = if (dotShaderSize < 8f) 1.5f else 1.2f
        c.drawCircle(sizePx / 2f, sizePx / 2f, radius, dotPaint)
        return BitmapShader(bmp, Shader.TileMode.REPEAT, Shader.TileMode.REPEAT)
    }
}

/**
 * 画布取图（D8 结论的画布版，M5 0.2 spike 后补大文件分支）：
 *  - `content://` 一律不进解码器（三星 MediaProvider 恢复库雷）——**取流先行**；
 *  - ≤[BIG_FILE_THRESHOLD]（照片级，绝大多数）：读入 `ByteBuffer`（查看器 viewer 路径
 *    同款，Coil ImageDecoder 需要可寻址源）；
 *  - 更大的（扫描件级 BMP/PNG，压力集与极端个例）：流式拷到 `cacheDir/canvas_tmp/<id>`
 *    再以 File 交给 Coil——**整文件 byte[] 会 OOM**（spike 实测 103MB tall.bmp 炸堆）；
 *    临时文件跨档位复用（换档重解码不再拷），「清除缓存」覆盖残留；
 *  - 磁盘 key 沿用查看器 `aurora-viewer:<fileId>`（原始字节与尺寸无关，两视图共用）；
 *    内存 key 带 `canvas` variant 与档位（同图多档共存）；
 *  - GIF 动画例外不复制——画布与 React canvas2d 一样只画静态首帧，统一走流；
 *  - 读不到字节退回 URI（viewer 同款兜底，失败原因留在日志）。
 *
 * **必须在 IO 线程调用**（requestDecode 已用 withContext(Dispatchers.IO) 包住）。
 */
internal fun canvasSourceFor(
    fileId: String,
    contentUri: String,
    resolver: android.content.ContentResolver,
    tierIdx: Int,
    tmpDir: java.io.File,
): CoilSource {
    val uri = Uri.parse(contentUri)
    val bytes: ByteArray? = try {
        resolver.openAssetFileDescriptor(uri, "r")?.use { afd ->
            val length = afd.length
            if (length in 1..BIG_FILE_THRESHOLD) {
                afd.createInputStream()?.use { it.readBytes() }
            } else null
        }
    } catch (e: Exception) {
        Log.w(CanvasView.TAG, "size probe failed: $fileId", e)
        null
    }
    if (bytes != null) {
        return CoilSource(
            ByteBuffer.wrap(bytes),
            "aurora-viewer:$fileId",
            "aurora-canvas:$fileId:$tierIdx",
        )
    }
    // 大文件：流式拷临时文件（已存在则复用），File 对 ImageDecoder 天然可寻址。
    // 先写 .part 再改名：拷贝中途进程死亡不会留下半截文件被后续复用
    return try {
        val tmp = java.io.File(tmpDir, fileId)
        if (!tmp.exists() || tmp.length() == 0L) {
            val part = java.io.File(tmpDir, "$fileId.part")
            resolver.openInputStream(uri)?.use { input ->
                part.outputStream().use { output -> input.copyTo(output) }
            } ?: return CoilSource(uri, null, null)
            if (!part.renameTo(tmp)) {
                part.delete()
                return CoilSource(uri, null, null)
            }
        }
        CoilSource(tmp, "aurora-viewer:$fileId", "aurora-canvas:$fileId:$tierIdx")
    } catch (e: Exception) {
        Log.w(CanvasView.TAG, "tmp copy failed: $fileId", e)
        CoilSource(uri, null, null)
    }
}

/** 小/大文件分界（20MB）：照片级走内存 ByteBuffer，扫描件级走临时文件。 */
private const val BIG_FILE_THRESHOLD = 8L * 1024 * 1024
