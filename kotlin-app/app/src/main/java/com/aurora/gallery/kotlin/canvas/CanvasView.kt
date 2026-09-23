package com.aurora.gallery.kotlin.canvas

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapShader
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.DashPathEffect
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Shader
import android.net.Uri
import android.util.Log
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
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

        /**
         * 点阵世界间距 = React drawCanvas `baseSpacing = 40`（ImageComparer.tsx :595，
         * world 单位；屏上格距 = 40×scale，CSS-px 阈值换算见 [drawDotGrid]）。
         * 2026-09-24 与桌面逐参数对齐时核对原值未变（旧 KDoc 误写成捏合限界）。
         */
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
    // 初始即给浅色点色兜底（宿主 applyTheme 前若先绘制不至于全透明），正式换档在
    // applyTheme。0x33 = 51 = 0.2×255（React :585 浅色 α）
    private val dotPaint = Paint().apply {
        style = Paint.Style.FILL
        color = 0x336B7280.toInt()
    }
    // 平铺 shader 的绘制笔必须**不透明**：tile 位图里的点已自带 0.2/0.25 点色 alpha，
    // 若复用带 alpha 的 dotPaint 挂 shader，两层 alpha 相乘（0.25×0.25≈0.06），点阵
    // 淡到不可见——2026-09-24 模拟器实测点亮度增量仅 8 灰阶（桌面 31）的根因
    private val dotShaderDrawPaint = Paint()
    private val density = resources.displayMetrics.density
    // 编辑框（2.1）：React 边框 #3b82f6 = palette.primary；柄白底蓝边。
    // 线宽按 React 的 CSS px（≈dp）乘 density：编辑框 1px、柄圆环 1.5px（EditOverlay :602/:628）
    private val editBorderPaint = Paint().apply {
        style = Paint.Style.STROKE
        strokeWidth = 1f * density
        color = 0xFF3B82F6.toInt()
    }
    private val handleFillPaint = Paint().apply {
        style = Paint.Style.FILL
        color = Color.WHITE
    }
    private val handleStrokePaint = Paint().apply {
        style = Paint.Style.STROKE
        strokeWidth = 1.5f * density
        color = 0xFF3B82F6.toInt()
    }
    private val handleGlyphPaint = Paint().apply {
        style = Paint.Style.STROKE
        // React strokeWidth=2（24 视口）落在柄径一半的图标盒上：2×15/24 = 1.25dp
        strokeWidth = 1.25f * density
        strokeCap = android.graphics.Paint.Cap.ROUND
        color = 0xFF3B82F6.toInt()
    }
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
        // 占位块固定深色 #111827（React drawCanvas :637 明暗两档同值）：浅色画布上
        // 未解码项若用 palette.placeholderBg（近白）会隐形——2026-09-23 黑盒验收问题 1/7 根因
        placeholderPaint.color = 0xFF111827.toInt()
        selectedStroke.color = palette.primary
        plainStroke.color = palette.hairline
        // 点阵点色 = React drawCanvas :585 原值逐字对齐（2026-09-24）：浅色
        // rgba(107,114,128,0.2) = gray-500 #6B7280 @ α0.2（0x33=51）、深色
        // rgba(156,163,175,0.25) = gray-400 #9CA3AF @ α0.25（0x40=64）。此前取
        // palette.textSecondary（#737373/#A3A3A3，neutral 系）——色相不符且观感更淡，
        // 是「点阵比桌面单调」的根因之一；textSecondary 是全局文本角色，不能为点阵改值
        dotPaint.color = if (dark) 0x409CA3AF.toInt() else 0x336B7280.toInt()
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
        val fit = s.pendingAutoFit(width.toFloat(), height.toFloat()) ?: return
        s.clearAutoFitPending()
        animateViewportTo(fit)
        updateTierForScale()
        ensureVisibleDecodes()
        invalidate()
    }

    /** 「查看全部」/「重置画布」后的主动 fit（动画到位）。 */
    fun fitToContent() {
        val s = store ?: return
        val bounds = s.contentBounds() ?: return
        val fit = computeFitTransform(width.toFloat(), height.toFloat(), bounds) ?: return
        s.markInteracted()
        animateViewportTo(fit)
    }

    /**
     * 「查看此图」/双击图：动画到以 [item] 居中、padding 60、scale 上限 1.2（硬顶 5.0）
     * 的视口（React handleViewImageForId:1634-1665 同款）；缩放跨度 >10×/<0.1× 时先走
     * 几何平均的中间步骤防卡死。
     */
    fun zoomToItem(item: CanvasItem) {
        val s = store ?: return
        val padding = 60f
        val sx = (width - padding * 2f) / item.width
        val sy = (height - padding * 2f) / item.height
        val targetScale = min(min(sx, sy), min(1.2f, 5f))
        val targetX = width / 2f - item.centerX * targetScale
        val targetY = height / 2f - item.centerY * targetScale
        val ratio = targetScale / s.viewport.scale
        s.markInteracted()
        if (ratio > 10f || ratio < 0.1f) {
            val midScale = kotlin.math.sqrt(s.viewport.scale * targetScale)
            animateViewportTo(
                CanvasViewport(width / 2f - item.centerX * midScale, height / 2f - item.centerY * midScale, midScale),
            )
            postDelayed({
                animateViewportTo(CanvasViewport(targetX, targetY, targetScale))
            }, 50L)
        } else {
            animateViewportTo(CanvasViewport(targetX, targetY, targetScale))
        }
    }

    // ------------------------------------------------------------ 手势（1.3，对齐 React :956-1187 的触屏语义）

    private class DragState {
        var active = false
        var startX = 0f
        var startY = 0f
        var initialTransform = CanvasViewport()
    }

    private class PinchState {
        var active = false
        var initialDistance = 0f
        var initialMidX = 0f
        var initialMidY = 0f
        var initialTransform = CanvasViewport()
    }

    private val drag = DragState()
    private val pinch = PinchState()

    /** 点按起点（React touchStartPosRef：x/y 是 window 坐标，这里用 view 坐标）。 */
    private var touchStartX = 0f
    private var touchStartY = 0f
    private var touchStartAt = 0L

    /** 上一次点按（双击判定：400ms / 30px 窗口，React lastTapRef 同款）。 */
    private var lastTapX = 0f
    private var lastTapY = 0f
    private var lastTapAt = 0L
    private var lastTapTargetId: String? = null

    private val longPressRunnable = Runnable {
        // 长按**已选中**图 500ms 进编辑模式（React :1021-1031；只在非编辑态挂此计时器）
        store?.enterEditMode()
        drag.active = false
        performHapticFeedback(android.view.HapticFeedbackConstants.LONG_PRESS)
        invalidate()
    }

    private val touchSlopPx = ViewConfiguration.get(context).scaledTouchSlop

    private fun cancelLongPressTimer() {
        removeCallbacks(longPressRunnable)
    }

    /** 屏幕（view）坐标 → 世界坐标。 */
    private fun toWorld(x: Float, y: Float, s: CanvasStore): Pair<Float, Float> =
        (x - s.viewport.x) / s.viewport.scale to (y - s.viewport.y) / s.viewport.scale

    /** 命中检测：自 z 序顶到底（React :998-1008 同序）。 */
    private fun hitTest(x: Float, y: Float, s: CanvasStore): String? {
        val (wx, wy) = toWorld(x, y, s)
        for (id in s.zOrderIds.asReversed()) {
            val item = s.itemById[id] ?: continue
            if (hitTestItem(wx, wy, item)) return id
        }
        return null
    }

    @SuppressLint("ClickableViewAccessibility")
    override fun onTouchEvent(event: MotionEvent): Boolean {
        val s = store ?: return false
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                cancelViewportAnimation()
                touchStartX = event.x
                touchStartY = event.y
                touchStartAt = android.os.SystemClock.uptimeMillis()
                val touchedId = hitTest(event.x, event.y, s)
                // 编辑模式：手柄/框内优先成为编辑拖动（2.1）
                if (s.isEditMode && beginEditDrag(event.x, event.y, s)) {
                    drag.active = false
                    return true
                }
                // 编辑模式且按在已选图上：不启动画布拖动（React :1010-1019 的语义）
                drag.active = !(s.isEditMode && touchedId != null && touchedId in s.selectedIds)
                drag.startX = event.x
                drag.startY = event.y
                drag.initialTransform = s.viewport
                if (!s.isEditMode && touchedId != null && touchedId in s.selectedIds) {
                    cancelLongPressTimer()
                    postDelayed(longPressRunnable, 500L)
                }
            }

            MotionEvent.ACTION_POINTER_DOWN -> {
                if (event.pointerCount >= 2) {
                    // 双指落下：取消长按、退出编辑（React :962-964）
                    cancelLongPressTimer()
                    s.exitEditMode()
                    editDragType = null
                    snapGuides = emptyList()
                    drag.active = false
                    pinch.active = true
                    val dx = event.getX(0) - event.getX(1)
                    val dy = event.getY(0) - event.getY(1)
                    pinch.initialDistance = kotlin.math.sqrt(dx * dx + dy * dy).coerceAtLeast(1f)
                    pinch.initialMidX = (event.getX(0) + event.getX(1)) / 2f
                    pinch.initialMidY = (event.getY(0) + event.getY(1)) / 2f
                    pinch.initialTransform = s.viewport
                }
            }

            MotionEvent.ACTION_MOVE -> {
                if (editDragType != null) {
                    processEditDrag(event.x, event.y, s)
                } else if (pinch.active && event.pointerCount >= 2) {
                    val dx = event.getX(0) - event.getX(1)
                    val dy = event.getY(0) - event.getY(1)
                    val dist = kotlin.math.sqrt(dx * dx + dy * dy).coerceAtLeast(1f)
                    val midX = (event.getX(0) + event.getX(1)) / 2f
                    val midY = (event.getY(0) + event.getY(1)) / 2f
                    // 捏合 = 围绕初始中点缩放 + 中点平移复合（React :1050-1061 公式照搬）
                    val init = pinch.initialTransform
                    val newScale = (init.scale * dist / pinch.initialDistance)
                        .coerceIn(CANVAS_MIN_SCALE, CANVAS_MAX_SCALE)
                    val scaleChange = newScale / init.scale
                    val nx = midX - (pinch.initialMidX - init.x) * scaleChange + (midX - pinch.initialMidX)
                    val ny = midY - (pinch.initialMidY - init.y) * scaleChange + (midY - pinch.initialMidY)
                    s.applyViewport(CanvasViewport(nx, ny, newScale))
                    s.markInteracted()
                    invalidate()
                } else if (drag.active && event.pointerCount == 1) {
                    val dx = event.x - drag.startX
                    val dy = event.y - drag.startY
                    // >5px 生效并取消长按计时（React :1071）
                    if (kotlin.math.sqrt(dx * dx + dy * dy) > 5f) {
                        cancelLongPressTimer()
                        val init = drag.initialTransform
                        s.applyViewport(CanvasViewport(init.x + dx, init.y + dy, init.scale))
                        s.markInteracted()
                        invalidate()
                    }
                } else if (event.pointerCount == 1) {
                    // 未激活拖动（编辑模式按住已选图）：移动超 slop 取消长按
                    val dx = event.x - touchStartX
                    val dy = event.y - touchStartY
                    if (kotlin.math.sqrt(dx * dx + dy * dy) > touchSlopPx) cancelLongPressTimer()
                }
            }

            MotionEvent.ACTION_UP -> {
                cancelLongPressTimer()
                val wasEditDrag = editDragType != null
                editDragType = null
                snapGuides = emptyList()
                val wasPinch = pinch.active
                pinch.active = false
                val wasDrag = drag.active
                drag.active = false
                // 手势结束：按需重解码高档
                updateTierForScale()
                ensureVisibleDecodes()
                if (wasEditDrag) {
                    invalidate()
                    return true
                }

                val dx = event.x - touchStartX
                val dy = event.y - touchStartY
                val dist = kotlin.math.sqrt(dx * dx + dy * dy)
                val elapsed = android.os.SystemClock.uptimeMillis() - touchStartAt
                if (!wasPinch && dist < 10f && elapsed < 300L) {
                    handleTap(event.x, event.y, s)
                } else if (wasDrag || wasPinch) {
                    onChangeGestureSettled()
                }
            }

            MotionEvent.ACTION_CANCEL -> {
                cancelLongPressTimer()
                pinch.active = false
                drag.active = false
                editDragType = null
                snapGuides = emptyList()
            }
        }
        return true
    }

    /** 点按（React 触屏分支 :1132-1163）：双击判定 → 选中/取消。 */
    private fun handleTap(x: Float, y: Float, s: CanvasStore) {
        val clickedId = hitTest(x, y, s)
        val now = android.os.SystemClock.uptimeMillis()
        val isDoubleTap = kotlin.math.abs(x - lastTapX) < 30f &&
            kotlin.math.abs(y - lastTapY) < 30f &&
            (now - lastTapAt) < 400L
        if (isDoubleTap) {
            if (clickedId != null && lastTapTargetId == clickedId) {
                // 双击同一图 = zoom 动画查看此图
                s.itemById[clickedId]?.let(::zoomToItem)
            } else {
                // 双击空白 / 不同目标 = 查看全部
                fitToContent()
            }
            lastTapTargetId = null
            lastTapAt = 0L
        } else {
            lastTapX = x
            lastTapY = y
            lastTapAt = now
            lastTapTargetId = clickedId
            when {
                clickedId != null && s.selectedIds.singleOrNull() == clickedId -> {
                    // 已单选的项再点 = 无操作（React :1151-1153；保持编辑态不被打断）
                }
                clickedId != null -> s.selectSingle(clickedId)
                else -> s.clearSelection()
            }
            invalidate()
        }
    }

    /** 捏合/拖动结束后的档位对齐（重解码高档）。 */
    private fun onChangeGestureSettled() {
        updateTierForScale()
        ensureVisibleDecodes()
        invalidate()
    }

    // ------------------------------------------------------------ 编辑模式（2.1，按阶段 0.1 手势清单实现）

    /** 编辑框手柄的屏幕尺寸（dp）。React 安卓分支 30px 手柄 + 旋转柄外偏 -40px。 */
    private val handleRadiusPx = 15f * density
    private val rotateOffsetPx = 25f * density
    /** 手柄命中半径：视觉 15dp，命中扩到 24dp（触控目标 ≥48dp）。 */
    private val handleHitRadiusPx = 24f * density

    /** 编辑拖动类型："move" / 八向缩放 "tl","tc","tr","ml","mr","bl","bc","br" / "rotate"。 */
    private var editDragType: String? = null
    private var editRotateHandleCorner = 't'

    /** 编辑拖动起点状态（EditOverlay startState:103-110 的对应物）。 */
    private class EditStartState {
        var pivotX = 0f; var pivotY = 0f
        var itemR = 0f
        var aspect = 1f
        var centerX = 0f; var centerY = 0f
        var startAngle = 0f
        var itemX = 0f; var itemY = 0f
        var startWorldX = 0f; var startWorldY = 0f
        var clickOffsetX = 0f; var clickOffsetY = 0f
    }

    private val editStart = EditStartState()
    /** 吸附参考线（world 坐标；move 时更新，松手清除）。 */
    private var snapGuides: List<SnapGuide> = emptyList()

    private class SnapGuide(val isX: Boolean, val pos: Float, val start: Float, val end: Float)

    private val snapGuidePaint = Paint().apply {
        style = Paint.Style.STROKE
        strokeWidth = 1.5f
        color = 0xFF34D399.toInt() // React 吸附线 emerald-400 #34d399（TreeSidebar SECTION_EMERALD 同族语义色）
        pathEffect = DashPathEffect(floatArrayOf(8f, 6f), 0f)
    }

    private fun beginEditDrag(x: Float, y: Float, s: CanvasStore): Boolean {
        val item = s.activeItemId?.let { s.itemById[it] } ?: return false
        val scale = s.viewport.scale
        val scx = item.centerX * scale + s.viewport.x
        val scy = item.centerY * scale + s.viewport.y
        val sw = item.width * scale
        val sh = item.height * scale
        // 触点转到 item 本地（屏）坐标
        val rad = Math.toRadians(item.rotation.toDouble())
        val cos = kotlin.math.cos(rad).toFloat()
        val sin = kotlin.math.sin(rad).toFloat()
        fun toLocal(px: Float, py: Float): Pair<Float, Float> {
            val dx = px - scx; val dy = py - scy
            return (dx * cos + dy * sin) to (-dx * sin + dy * cos)
        }
        val (lx, ly) = toLocal(x, y)

        // 1) 旋转柄（四角外 offset -40px，中心 ≈ 角外 25dp）
        val rotateCorners = listOf(
            't' to (-sw / 2f - rotateOffsetPx to -sh / 2f - rotateOffsetPx),
            'r' to (sw / 2f + rotateOffsetPx to -sh / 2f - rotateOffsetPx),
            'l' to (-sw / 2f - rotateOffsetPx to sh / 2f + rotateOffsetPx),
            'b' to (sw / 2f + rotateOffsetPx to sh / 2f + rotateOffsetPx),
        )
        for ((corner, pos) in rotateCorners) {
            if (kotlin.math.abs(lx - pos.first) <= handleHitRadiusPx &&
                kotlin.math.abs(ly - pos.second) <= handleHitRadiusPx
            ) {
                editRotateHandleCorner = corner
                startEdit(item, x, y, s, "rotate")
                return true
            }
        }
        // 2) 缩放柄（8 枚）
        val scaleHandles = mapOf(
            "tl" to (-sw / 2f to -sh / 2f), "tc" to (0f to -sh / 2f), "tr" to (sw / 2f to -sh / 2f),
            "ml" to (-sw / 2f to 0f), "mr" to (sw / 2f to 0f),
            "bl" to (-sw / 2f to sh / 2f), "bc" to (0f to sh / 2f), "br" to (sw / 2f to sh / 2f),
        )
        for ((type, pos) in scaleHandles) {
            if (kotlin.math.abs(lx - pos.first) <= handleHitRadiusPx &&
                kotlin.math.abs(ly - pos.second) <= handleHitRadiusPx
            ) {
                startEdit(item, x, y, s, type)
                return true
            }
        }
        // 3) 框内 = move（命中检测已确认点在 item 内——ACTION_DOWN 的 touchedId 判定）
        if (kotlin.math.abs(lx) <= sw / 2f && kotlin.math.abs(ly) <= sh / 2f) {
            startEdit(item, x, y, s, "move")
            return true
        }
        return false
    }

    private fun startEdit(item: CanvasItem, x: Float, y: Float, s: CanvasStore, type: String) {
        val typeWithRotate = if (type == "rotate") type + editRotateHandleCorner else type
        val scale = s.viewport.scale
        val (wx, wy) = toWorld(x, y, s)
        val cx = item.centerX
        val cy = item.centerY
        val rad = Math.toRadians(item.rotation.toDouble())
        val cos = kotlin.math.cos(rad).toFloat()
        val sin = kotlin.math.sin(rad).toFloat()

        // 对侧锚点（React startInteraction :302-319；'l'→px=+1 = 锚在右缘）
        var px = 0f; var py = 0f
        if ('l' in typeWithRotate) px = 1f else if ('r' in typeWithRotate) px = -1f
        if ('t' in typeWithRotate) py = 1f else if ('b' in typeWithRotate) py = -1f
        val lpx = px * item.width / 2f
        val lpy = py * item.height / 2f
        editStart.pivotX = cx + (lpx * cos - lpy * sin)
        editStart.pivotY = cy + (lpx * sin + lpy * cos)

        // 抓取偏移（拖柄不跳变；React clickOffset :328-337）
        var hx = 0f; var hy = 0f
        if ('l' in typeWithRotate) hx = -item.width / 2f else if ('r' in typeWithRotate) hx = item.width / 2f
        if ('t' in typeWithRotate) hy = -item.height / 2f else if ('b' in typeWithRotate) hy = item.height / 2f
        val vx = wx - editStart.pivotX
        val vy = wy - editStart.pivotY
        val rCos = kotlin.math.cos(-rad).toFloat()
        val rSin = kotlin.math.sin(-rad).toFloat()
        val localMouseX = vx * rCos - vy * rSin
        val localMouseY = vx * rSin + vy * rCos
        editStart.clickOffsetX = (hx - px * item.width / 2f) - localMouseX
        editStart.clickOffsetY = (hy - py * item.height / 2f) - localMouseY

        editStart.itemR = item.rotation
        editStart.aspect = item.width / kotlin.math.max(1f, item.height)
        editStart.centerX = cx; editStart.centerY = cy
        editStart.startAngle = (Math.atan2(
            (wy - cy).toDouble(),
            (wx - cx).toDouble(),
        )).toFloat()
        editStart.itemX = item.x; editStart.itemY = item.y
        editStart.startWorldX = wx; editStart.startWorldY = wy
        editDragType = type
    }

    /** 编辑拖动进行中（EditOverlay processDrag:126-290 逐字转译 + 吸附）。 */
    private fun processEditDrag(x: Float, y: Float, s: CanvasStore) {
        val item = s.activeItemId?.let { s.itemById[it] } ?: return
        val (wx, wy) = toWorld(x, y, s)
        when (editDragType) {
            "move" -> {
                var newX = editStart.itemX + (wx - editStart.startWorldX)
                var newY = editStart.itemY + (wy - editStart.startWorldY)
                val pair = applySnap(item, newX, newY, s)
                newX = pair.first; newY = pair.second
                s.updateItemTransform(item.fileId, x = newX, y = newY)
            }
            "rotate" -> {
                val angleNow = Math.atan2(
                    (wy - editStart.centerY).toDouble(),
                    (wx - editStart.centerX).toDouble(),
                ).toFloat()
                var deg = (angleNow - editStart.startAngle) * 180f / Math.PI.toFloat() + editStart.itemR
                // 归一到 (-180, 180]，避免累计浮点漂移
                deg = ((deg % 360f) + 540f) % 360f - 180f
                s.updateItemTransform(item.fileId, rotation = deg)
            }
            else -> {
                // 八向等比缩放（锚点=对侧，EditOverlay :232-289）
                val type = editDragType ?: return
                val rad = Math.toRadians(editStart.itemR.toDouble())
                val cos = kotlin.math.cos(-rad).toFloat()
                val sin = kotlin.math.sin(-rad).toFloat()
                val vx = wx - editStart.pivotX
                val vy = wy - editStart.pivotY
                val localMouseX = vx * cos - vy * sin
                val localMouseY = vx * sin + vy * cos
                val pcx = localMouseX + editStart.clickOffsetX
                val pcy = localMouseY + editStart.clickOffsetY
                var w = kotlin.math.abs(pcx)
                var h = kotlin.math.abs(pcy)
                when {
                    type == "ml" || type == "mr" -> h = w / editStart.aspect
                    type == "tc" || type == "bc" -> w = h * editStart.aspect
                    else -> if (w / editStart.aspect > h) h = w / editStart.aspect else w = h * editStart.aspect
                }
                w = kotlin.math.max(50f, w)
                h = kotlin.math.max(50f, h)
                var kx = 0f; var ky = 0f
                if ('l' in type) kx = 1f else if ('r' in type) kx = -1f
                if ('t' in type) ky = 1f else if ('b' in type) ky = -1f
                val offX = -kx * w / 2f
                val offY = -ky * h / 2f
                val cosR = kotlin.math.cos(rad).toFloat()
                val sinR = kotlin.math.sin(rad).toFloat()
                val newCx = editStart.pivotX + (offX * cosR - offY * sinR)
                val newCy = editStart.pivotY + (offX * sinR + offY * cosR)
                s.updateItemTransform(
                    item.fileId,
                    x = newCx - w / 2f,
                    y = newCy - h / 2f,
                    width = w,
                    height = h,
                )
            }
        }
        invalidate()
    }

    /**
     * 移动吸附（EditOverlay :126-219）：对其他未选中项的旋转 AABB 做边缘/中线吸附——
     * 每轴独立取最近候选（我的左缘/右缘/中线 ↔ 对方的左缘/右缘/中线），触发阈值
     * 15 屏幕像素，近邻窗口 200 屏幕像素。
     */
    private fun applySnap(active: CanvasItem, newX: Float, newY: Float, s: CanvasStore): Pair<Float, Float> {
        if (!s.isSnappingEnabled) {
            snapGuides = emptyList()
            return newX to newY
        }
        val scale = s.viewport.scale
        val threshold = 15f / scale
        val proximity = 200f / scale
        val selectedSet = s.selectedIds.toSet()
        var bestX = newX; var bestY = newY
        var minDx = threshold; var minDy = threshold
        var guideX: SnapGuide? = null
        var guideY: SnapGuide? = null
        val m = active.copy(x = newX, y = newY).aabb()
        val mCx = (m.minX + m.maxX) / 2f
        val mCy = (m.minY + m.maxY) / 2f
        for (other in s.items) {
            if (other.fileId == active.fileId || other.fileId in selectedSet) continue
            val o = other.aabb()
            val oCx = (o.minX + o.maxX) / 2f
            val oCy = (o.minY + o.maxY) / 2f
            val nearY = (m.minY < o.maxY + proximity) && (m.maxY > o.minY - proximity)
            val nearX = (m.minX < o.maxX + proximity) && (m.maxX > o.minX - proximity)
            if (nearY) {
                // X 向候选：(对方值, 我方参照缘, 距离)
                val candidates = listOf(
                    Triple(o.minX, m.minX, kotlin.math.abs(m.minX - o.minX)),
                    Triple(o.maxX, m.minX, kotlin.math.abs(m.minX - o.maxX)),
                    Triple(o.minX, m.maxX, kotlin.math.abs(m.maxX - o.minX)),
                    Triple(o.maxX, m.maxX, kotlin.math.abs(m.maxX - o.maxX)),
                    Triple(oCx, mCx, kotlin.math.abs(mCx - oCx)),
                )
                for ((target, ref, dist) in candidates) {
                    if (dist < minDx) {
                        minDx = dist
                        bestX = newX + (target - ref)
                        guideX = SnapGuide(true, target, kotlin.math.min(m.minY, o.minY), kotlin.math.max(m.maxY, o.maxY))
                    }
                }
            }
            if (nearX) {
                val candidates = listOf(
                    Triple(o.minY, m.minY, kotlin.math.abs(m.minY - o.minY)),
                    Triple(o.maxY, m.minY, kotlin.math.abs(m.minY - o.maxY)),
                    Triple(o.minY, m.maxY, kotlin.math.abs(m.maxY - o.minY)),
                    Triple(o.maxY, m.maxY, kotlin.math.abs(m.maxY - o.maxY)),
                    Triple(oCy, mCy, kotlin.math.abs(mCy - oCy)),
                )
                for ((target, ref, dist) in candidates) {
                    if (dist < minDy) {
                        minDy = dist
                        bestY = newY + (target - ref)
                        guideY = SnapGuide(false, target, kotlin.math.min(m.minX, o.minX), kotlin.math.max(m.maxX, o.maxX))
                    }
                }
            }
        }
        snapGuides = listOfNotNull(guideX, guideY)
        return bestX to bestY
    }

    /** 编辑框 + 手柄 + 吸附线（屏幕空间，手柄恒定尺寸；React EditOverlay 渲染同位）。 */
    private fun drawEditOverlay(canvas: Canvas, s: CanvasStore) {
        val item = s.activeItemId?.let { s.itemById[it] } ?: return
        val scale = s.viewport.scale
        val scx = item.centerX * scale + s.viewport.x
        val scy = item.centerY * scale + s.viewport.y
        val sw = item.width * scale
        val sh = item.height * scale

        // 吸附参考线（世界→屏幕）
        for (g in snapGuides) {
            if (g.isX) {
                val sx = g.pos * scale + s.viewport.x
                val sy0 = g.start * scale + s.viewport.y
                val sy1 = g.end * scale + s.viewport.y
                canvas.drawLine(sx, sy0, sx, sy1, snapGuidePaint)
            } else {
                val sy = g.pos * scale + s.viewport.y
                val sx0 = g.start * scale + s.viewport.x
                val sx1 = g.end * scale + s.viewport.x
                canvas.drawLine(sx0, sy, sx1, sy, snapGuidePaint)
            }
        }

        canvas.save()
        canvas.translate(scx, scy)
        canvas.rotate(item.rotation)
        canvas.drawRect(-sw / 2f, -sh / 2f, sw / 2f, sh / 2f, editBorderPaint)

        // 8 枚缩放柄（白底蓝边圆 + lucide scaling 图标，对齐 React ScaleIcon）
        val handles = listOf(
            -sw / 2f to -sh / 2f, 0f to -sh / 2f, sw / 2f to -sh / 2f,
            -sw / 2f to 0f, sw / 2f to 0f,
            -sw / 2f to sh / 2f, 0f to sh / 2f, sw / 2f to sh / 2f,
        )
        for ((hx, hy) in handles) {
            canvas.drawCircle(hx, hy, handleRadiusPx, handleFillPaint)
            canvas.drawCircle(hx, hy, handleRadiusPx, handleStrokePaint)
            drawScaleGlyph(canvas, hx, hy)
        }
        // 4 枚旋转柄（四角外，圆 + lucide 旋转箭头图标，对齐 React RotateIcon）
        val ro = rotateOffsetPx
        val rotateCorners = listOf(
            -sw / 2f - ro to -sh / 2f - ro,
            sw / 2f + ro to -sh / 2f - ro,
            -sw / 2f - ro to sh / 2f + ro,
            sw / 2f + ro to sh / 2f + ro,
        )
        for ((hx, hy) in rotateCorners) {
            canvas.drawCircle(hx, hy, handleRadiusPx, handleFillPaint)
            canvas.drawCircle(hx, hy, handleRadiusPx, handleStrokePaint)
            drawRotateGlyph(canvas, hx, hy)
        }
        canvas.restore()
    }

    /**
     * 缩放柄图标：React `ScaleIcon`（lucide scaling，24 视口）逐线转译——
     * `M15 3H21V9`（右上角折线）/ `M9 21H3V15`（左下角折线）/ `M21 3L14 10` / `M3 21L10 14`。
     * React 图标盒 = 柄径一半（`size={s * 0.5}`，EditOverlay :655）：24 视口 → k = 柄半径/24。
     */
    private fun drawScaleGlyph(canvas: Canvas, cx: Float, cy: Float) {
        val k = handleRadiusPx / 24f
        fun px(x: Float) = cx + (x - 12f) * k
        fun py(y: Float) = cy + (y - 12f) * k
        canvas.drawLine(px(15f), py(3f), px(21f), py(3f), handleGlyphPaint)
        canvas.drawLine(px(21f), py(3f), px(21f), py(9f), handleGlyphPaint)
        canvas.drawLine(px(9f), py(21f), px(3f), py(21f), handleGlyphPaint)
        canvas.drawLine(px(3f), py(21f), px(3f), py(15f), handleGlyphPaint)
        canvas.drawLine(px(21f), py(3f), px(14f), py(10f), handleGlyphPaint)
        canvas.drawLine(px(3f), py(21f), px(10f), py(14f), handleGlyphPaint)
    }

    /**
     * 旋转柄图标：React `RotateIcon`（24 视口）——右上角折线 `M21.5 2V8H15.5` +
     * 大圆弧 `M21.34 15.57A10 10 0 1 1-.57-8.38`（起点 (21.34,15.57)、终点 (20.77,7.19)；
     * 弦心距解出圆心恰为视口中心 (12,12)、r=10：起点角 20.94°、顺时针扫 310.3°，
     * 缺口正对右上角折线）。图标盒同缩放柄 = 柄径一半。
     */
    private fun drawRotateGlyph(canvas: Canvas, cx: Float, cy: Float) {
        val k = handleRadiusPx / 24f
        fun px(x: Float) = cx + (x - 12f) * k
        fun py(y: Float) = cy + (y - 12f) * k
        canvas.drawLine(px(21.5f), py(2f), px(21.5f), py(8f), handleGlyphPaint)
        canvas.drawLine(px(21.5f), py(8f), px(15.5f), py(8f), handleGlyphPaint)
        val arcR = 10f * k
        canvas.drawArc(
            cx - arcR, cy - arcR, cx + arcR, cy + arcR,
            20.94f, 310.3f, false, handleGlyphPaint,
        )
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

        // 编辑框/手柄/吸附线在屏幕空间绘制（手柄恒定尺寸，不随世界缩放）
        if (s.isEditMode) drawEditOverlay(canvas, s)

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

    /**
     * 点阵背景（React ImageComparer drawCanvas :594-617 逐参数对齐，2026-09-24；
     * 实现仍为 BitmapShader 一次 drawRect 平铺——React 逐点 arc 在 CPU 光栅化下太贵）。
     *
     * 桌面原值（CSS px 语义）：
     *  - 间距：`gridSize = 40 × scale`；< 15 时 `step = max(1, floor(30/gridSize))`
     *    倍乘；< 8 不画（:595-604）；
     *  - 半径：`scale < 0.2 ? 1.5 : 1.2` CSS px（:608）；
     *  - 相位：`offset = transform.x/y % gridSize`（:606-607）。
     *
     * 单位换算（2026-09-24 二次校准，用户实测定标）：网格以 **CSS px 语义**直接套桌面
     * 公式——屏上间距 = 40 CSS px × scale，与桌面同名缩放下观感一致；density 只用于
     * 把 CSS 网格折成 view px 光栅化（×density），不参与缩放语义。此前 ×density 得
     * 80 CSS px（太疏）、÷density 得 20 CSS px（太密，用户实测「最多 20px 左右」）。
     */
    private fun drawDotGrid(canvas: Canvas, s: CanvasStore) {
        val cssScale = s.viewport.scale
        var gridSizeCss = DOT_SPACING_WORLD * cssScale
        if (gridSizeCss < 15f) {
            gridSizeCss *= max(1f, kotlin.math.floor(30f / gridSizeCss))
        }
        if (gridSizeCss < 8f) return
        val gridSizePx = gridSizeCss * density
        if (dotShader == null || kotlin.math.abs(dotShaderSize - gridSizePx) > 0.5f) {
            dotShader = buildDotShader(gridSizePx, cssScale < 0.2f)
            dotShaderSize = gridSizePx
        }
        val shader = dotShader ?: return
        val m = Matrix()
        val ox = s.viewport.x % gridSizePx
        val oy = s.viewport.y % gridSizePx
        m.setTranslate(ox, oy)
        shader.setLocalMatrix(m)
        // 不透明笔铺 tile（点色 alpha 已在 tile 位图里，勿再用 dotPaint 二次折损）
        dotShaderDrawPaint.shader = shader
        canvas.drawRect(0f, 0f, width.toFloat(), height.toFloat(), dotShaderDrawPaint)
        dotShaderDrawPaint.shader = null
    }

    /**
     * 平铺位图：单点居中（半径 < 半格，不跨 tile 边裁切，REPEAT 无缝）。半径 = React
     * :608 原值——`zoomedOut` 即桌面 `scale < 0.2` 时 1.5，否则 1.2，单位 CSS px 乘
     * density 转 view px。此前条件写成 `dotShaderSize < 8f`：gridSize < 8 在
     * [drawDotGrid] 已 early-return，条件恒假 → 1.5 档是死分支，缩小视图时点不增粗。
     */
    private fun buildDotShader(gridSizePx: Float, zoomedOut: Boolean): BitmapShader {
        val sizePx = gridSizePx.toInt().coerceIn(8, 256)
        val bmp = Bitmap.createBitmap(sizePx, sizePx, Bitmap.Config.ARGB_8888)
        val c = Canvas(bmp)
        val radius = (if (zoomedOut) 1.5f else 1.2f) * density
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
