package com.aurora.gallery.kotlin.canvas

import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * 画布纯逻辑（M5 1.1）：React `comparer/layout.ts`（84 行）、`viewport.ts`（56 行）、
 * `geometry.ts`（54 行）的逐字转译 + `ImageComparer.tsx:1667-1756` handleReorder 的
 * 纯函数化。本文件**不依赖任何 Android/Compose 类型**，配 `CanvasLogicTest` 与
 * React 同输入对拍（夹具由 node 跑 React 原算法生成，见测试文件头注）。
 *
 * 世界坐标系：React 把图片自然尺寸（px）当世界尺寸，transform 为 (x, y, scale) 的
 * 二维仿射（无旋转分量，旋转挂在 item 上）——照搬。
 */

/** 装箱输入：fileId + 自然宽高（无尺寸兜底由调用方按 React 语义给 1000×750）；
 * contentUri 不参与装箱，由 [CanvasStore][com.aurora.gallery.kotlin.canvas.CanvasStore]
 * 留作取图解析（画布解码要用，纯逻辑函数不碰）。 */
data class CanvasPackSource(
    val id: String,
    val width: Float,
    val height: Float,
    val contentUri: String = "",
)

/** 装箱输出：世界坐标矩形（首张以原点为中心，对齐 layout.ts 的 (-w/2, -h/2)）。 */
data class CanvasPackedRect(val id: String, val x: Float, val y: Float, val width: Float, val height: Float)

/** 轴对齐包围盒（geometry.ts AABB）。 */
data class CanvasAABB(val minX: Float, val minY: Float, val maxX: Float, val maxY: Float)

/**
 * 矩形装箱（layout.ts:7-84 逐字转译）：按面积降序，首张以原点为中心；其余围绕已放置
 * 项生成 8 向候选位（含 layout.ts 原样的第 4/8 项重复——转译保真，重复候选是无害的
 * no-op），取「离原点最近且不与现有项重叠（含 spacing 边距）」者。
 */
fun packImages(files: List<CanvasPackSource>, spacing: Float = 40f): List<CanvasPackedRect> {
    if (files.isEmpty()) return emptyList()

    // JS sort 是稳定排序（ES2019），Kotlin sortedWith(compareBy…) 同样稳定；比较键一致
    val packOrder = files.sortedWith(
        compareByDescending<CanvasPackSource> { it.width * it.height },
    )

    fun checkOverlap(x: Float, y: Float, w: Float, h: Float, existing: List<CanvasPackedRect>): Boolean {
        for (item in existing) {
            if (x < item.x + item.width + spacing - 1 &&
                x + w + spacing - 1 > item.x &&
                y < item.y + item.height + spacing - 1 &&
                y + h + spacing - 1 > item.y
            ) {
                return true
            }
        }
        return false
    }

    val first = packOrder[0]
    val items = mutableListOf(
        CanvasPackedRect(first.id, -first.width / 2f, -first.height / 2f, first.width, first.height),
    )

    for (i in 1 until packOrder.size) {
        val file = packOrder[i]
        val w = file.width
        val h = file.height

        var bestX = 0f
        var bestY = 0f
        var minDistance = Float.MAX_VALUE
        val candidates = ArrayList<Pair<Float, Float>>()

        for (item in items) {
            candidates.add(item.x + item.width + spacing to item.y)
            candidates.add(item.x - w - spacing to item.y)
            candidates.add(item.x to item.y + item.height + spacing)
            candidates.add(item.x to item.y - h - spacing)
            candidates.add(item.x + item.width + spacing to item.y + item.height - h)
            candidates.add(item.x - w - spacing to item.y + item.height - h)
            candidates.add(item.x + item.width - w to item.y + item.height + spacing)
            candidates.add(item.x to item.y - h - spacing)
        }

        for ((cx, cy) in candidates) {
            if (!checkOverlap(cx, cy, w, h, items)) {
                val dist = sqrt((cx + w / 2f) * (cx + w / 2f) + (cy + h / 2f) * (cy + h / 2f))
                if (dist < minDistance) {
                    minDistance = dist
                    bestX = cx
                    bestY = cy
                }
            }
        }

        items.add(CanvasPackedRect(file.id, bestX, bestY, w, h))
    }

    return items
}

/**
 * 增量装箱（React 无对应函数，语义从 ImageComparer 的添加流反推）：已有项保持现位
 * （React 的 manualLayouts 持久化），新项围绕已有项与已放置新项生成同款 8 向候选位。
 * 画布为空时退化为 [packImages] 的首张语义（以原点为中心）。
 */
fun packNewItems(
    existingRects: List<CanvasPackedRect>,
    newItems: List<CanvasPackSource>,
    spacing: Float = 40f,
): List<CanvasPackedRect> {
    if (newItems.isEmpty()) return emptyList()
    val placed = existingRects.toMutableList()
    val out = mutableListOf<CanvasPackedRect>()
    for (file in newItems) {
        val w = file.width
        val h = file.height
        var bestX = -w / 2f
        var bestY = -h / 2f
        var minDistance = Float.MAX_VALUE
        val candidates = ArrayList<Pair<Float, Float>>()
        for (item in placed) {
            candidates.add(item.x + item.width + spacing to item.y)
            candidates.add(item.x - w - spacing to item.y)
            candidates.add(item.x to item.y + item.height + spacing)
            candidates.add(item.x to item.y - h - spacing)
            candidates.add(item.x + item.width + spacing to item.y + item.height - h)
            candidates.add(item.x - w - spacing to item.y + item.height - h)
            candidates.add(item.x + item.width - w to item.y + item.height + spacing)
            candidates.add(item.x to item.y - h - spacing)
        }
        for ((cx, cy) in candidates) {
            if (!checkOverlapRects(cx, cy, w, h, placed, spacing)) {
                val dist = sqrt((cx + w / 2f) * (cx + w / 2f) + (cy + h / 2f) * (cy + h / 2f))
                if (dist < minDistance) {
                    minDistance = dist
                    bestX = cx
                    bestY = cy
                }
            }
        }
        val rect = CanvasPackedRect(file.id, bestX, bestY, w, h)
        placed.add(rect)
        out.add(rect)
    }
    return out
}

private fun checkOverlapRects(
    x: Float,
    y: Float,
    w: Float,
    h: Float,
    existing: List<CanvasPackedRect>,
    spacing: Float,
): Boolean {
    for (item in existing) {
        if (x < item.x + item.width + spacing - 1 &&
            x + w + spacing - 1 > item.x &&
            y < item.y + item.height + spacing - 1 &&
            y + h + spacing - 1 > item.y
        ) {
            return true
        }
    }
    return false
}

/** 视口变换（viewport.ts Transform；scale ∈ [0.01, 20] 与 React 捏合限界一致）。 */
data class CanvasViewport(val x: Float = 0f, val y: Float = 0f, val scale: Float = 1f)

const val CANVAS_MIN_SCALE = 0.01f
const val CANVAS_MAX_SCALE = 20f

/** 以屏幕点 (px, py) 为中心缩放视口，保持该点下的内容不动（viewport.ts:17-29）。 */
fun zoomAtPoint(
    transform: CanvasViewport,
    pointX: Float,
    pointY: Float,
    factor: Float,
    minScale: Float = CANVAS_MIN_SCALE,
    maxScale: Float = CANVAS_MAX_SCALE,
): CanvasViewport {
    val newScale = (transform.scale * factor).coerceIn(minScale, maxScale)
    val ratio = newScale / transform.scale
    val newX = pointX - (pointX - transform.x) * ratio
    val newY = pointY - (pointY - transform.y) * ratio
    return CanvasViewport(newX, newY, newScale)
}

/**
 * 计算使内容边界适应容器并居中的视口变换（viewport.ts:33-56）；padding 60、
 * maxScale 1.2 为 React 同款默认。内容尺寸无效（<=0）返回 null。
 */
fun computeFitTransform(
    containerWidth: Float,
    containerHeight: Float,
    bounds: CanvasAABB,
    padding: Float = 60f,
    maxScale: Float = 1.2f,
): CanvasViewport? {
    val contentWidth = bounds.maxX - bounds.minX
    val contentHeight = bounds.maxY - bounds.minY
    if (contentWidth <= 0f || contentHeight <= 0f) return null
    val scaleX = (containerWidth - padding * 2f) / contentWidth
    val scaleY = (containerHeight - padding * 2f) / contentHeight
    val scale = min(scaleX, min(scaleY, maxScale))
    val centerX = bounds.minX + contentWidth / 2f
    val centerY = bounds.minY + contentHeight / 2f
    return CanvasViewport(
        containerWidth / 2f - centerX * scale,
        containerHeight / 2f - centerY * scale,
        scale,
    )
}

/** 绕中心 (cx, cy) 旋转一个点（geometry.ts:12-19），angleDeg 单位为度。 */
fun rotatePointAround(x: Float, y: Float, cx: Float, cy: Float, angleDeg: Float): Pair<Float, Float> {
    val rad = angleDeg * (Math.PI / 180.0)
    val dx = (x - cx).toDouble()
    val dy = (y - cy).toDouble()
    val rx = dx * kotlin.math.cos(rad) - dy * kotlin.math.sin(rad)
    val ry = dx * kotlin.math.sin(rad) + dy * kotlin.math.cos(rad)
    return (rx + cx).toFloat() to (ry + cy).toFloat()
}

/** 判断世界坐标点是否落在（已旋转的）item 内部（geometry.ts:22-27）。 */
fun pointInRotatedItem(worldX: Float, worldY: Float, x: Float, y: Float, width: Float, height: Float, rotation: Float): Boolean {
    val cx = x + width / 2f
    val cy = y + height / 2f
    val (lx, ly) = rotatePointAround(worldX, worldY, cx, cy, -rotation)
    return lx >= x && lx <= x + width && ly >= y && ly <= y + height
}

/** 世界坐标 -> item 局部坐标（消除旋转，geometry.ts:30-34）。 */
fun worldToLocalPoint(worldX: Float, worldY: Float, x: Float, y: Float, width: Float, height: Float, rotation: Float): Pair<Float, Float> {
    val cx = x + width / 2f
    val cy = y + height / 2f
    return rotatePointAround(worldX, worldY, cx, cy, -rotation)
}

/** 计算（已旋转的）item 的轴对齐包围盒（geometry.ts:37-49）。 */
fun computeAABB(x: Float, y: Float, width: Float, height: Float, rotation: Float): CanvasAABB {
    val cx = x + width / 2f
    val cy = y + height / 2f
    val corners = listOf(
        rotatePointAround(x, y, cx, cy, rotation),
        rotatePointAround(x + width, y, cx, cy, rotation),
        rotatePointAround(x + width, y + height, cx, cy, rotation),
        rotatePointAround(x, y + height, cx, cy, rotation),
    )
    val xs = corners.map { it.first }
    val ys = corners.map { it.second }
    return CanvasAABB(xs.min(), ys.min(), xs.max(), ys.max())
}

/** 判断两个 AABB 是否重叠（geometry.ts:52-54）。 */
fun aabbOverlap(a: CanvasAABB, b: CanvasAABB): Boolean =
    !(a.maxX < b.minX || a.minX > b.maxX || a.maxY < b.minY || a.minY > b.maxY)

/** z 序操作类型（React handleReorder 的 'top' | 'bottom' | 'up' | 'down'）。 */
enum class ZOrderOp { TOP, BOTTOM, UP, DOWN }

/**
 * z 序重排（ImageComparer.tsx:1667-1756 逐字转译；数组尾 = 最上层）。
 *
 * 语义要点（照抄别简化）：top/bottom **不是端点移动**——top 是越过「z 序中与自己
 * 重叠的最高项」（放到它上面一格），无重叠才移到端点；up/down 沿 z 序找相邻重叠项
 * 跳到它旁边，无重叠才与相邻位交换。[existingIds] 模拟 layoutItemMap 过滤
 * （z 序里可能残留已删除的 id）。
 */
fun reorderZOrder(
    zOrderIds: List<String>,
    targetId: String,
    op: ZOrderOp,
    existingIds: Set<String>,
    isOverlap: (String, String) -> Boolean,
): List<String> {
    val next = zOrderIds.toMutableList()
    val visible = next.filter { it in existingIds }
    if (targetId !in visible) return next

    fun moveToPos(pos: Int) {
        val curIdx = next.indexOf(targetId)
        if (curIdx == -1) return
        next.removeAt(curIdx)
        next.add(pos.coerceIn(0, next.size), targetId)
    }

    when (op) {
        ZOrderOp.TOP -> {
            var highestOverlapIdx = -1
            for (i in visible.indices.reversed()) {
                val otherId = visible[i]
                if (otherId == targetId) continue
                if (isOverlap(targetId, otherId)) {
                    highestOverlapIdx = i
                    break
                }
            }
            if (highestOverlapIdx == -1) {
                moveToPos(next.size)
            } else {
                moveToPos(next.indexOf(visible[highestOverlapIdx]) + 1)
            }
        }
        ZOrderOp.BOTTOM -> {
            var lowestOverlapIdx = -1
            for (i in visible.indices) {
                val otherId = visible[i]
                if (otherId == targetId) continue
                if (isOverlap(targetId, otherId)) {
                    lowestOverlapIdx = i
                    break
                }
            }
            if (lowestOverlapIdx == -1) {
                moveToPos(0)
            } else {
                moveToPos(next.indexOf(visible[lowestOverlapIdx]))
            }
        }
        ZOrderOp.UP -> {
            var found = false
            for (i in visible.indexOf(targetId) + 1 until visible.size) {
                val otherId = visible[i]
                if (isOverlap(targetId, otherId)) {
                    moveToPos(next.indexOf(otherId) + 1)
                    found = true
                    break
                }
            }
            if (!found) {
                val curPos = next.indexOf(targetId)
                if (curPos < next.size - 1) {
                    val tmp = next[curPos]
                    next[curPos] = next[curPos + 1]
                    next[curPos + 1] = tmp
                }
            }
        }
        ZOrderOp.DOWN -> {
            var found = false
            for (i in visible.indexOf(targetId) - 1 downTo 0) {
                val otherId = visible[i]
                if (isOverlap(targetId, otherId)) {
                    moveToPos(next.indexOf(otherId))
                    found = true
                    break
                }
            }
            if (!found) {
                val curPos = next.indexOf(targetId)
                if (curPos > 0) {
                    val tmp = next[curPos]
                    next[curPos] = next[curPos - 1]
                    next[curPos - 1] = tmp
                }
            }
        }
    }
    return next
}

/** 旋转项的命中检测（画布点按选中用；自 z 序顶到底逐个测试由调用方循环）。 */
fun hitTestItem(worldX: Float, worldY: Float, item: CanvasItem): Boolean =
    pointInRotatedItem(worldX, worldY, item.x, item.y, item.width, item.height, item.rotation)

/** 浮点近似相等（单测对拍容差）。 */
fun Float.approx(other: Float, eps: Float = 0.01f): Boolean = abs(this - other) <= eps
