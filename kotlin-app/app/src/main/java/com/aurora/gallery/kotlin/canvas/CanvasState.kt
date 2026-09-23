package com.aurora.gallery.kotlin.canvas

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlin.math.max
import kotlin.math.min

/**
 * 画布单项（M5 1.1）。React 侧 = ComparisonItem + manualLayouts 的合并结果：
 * `x/y/width/height` 是**当前**世界矩形（初始 = 装箱位），`rotation` 编辑模式可改；
 * `homeX/homeY/homeWidth/homeHeight` 记装箱位，「重置变换」（React handleResetItem:1521
 * 删 manual 条目回到装箱位）回到这里。opacity 字段 React 有但触屏无编辑入口（D24），
 * 不建模。
 */
data class CanvasItem(
    val fileId: String,
    val x: Float,
    val y: Float,
    val width: Float,
    val height: Float,
    val rotation: Float = 0f,
    val homeX: Float,
    val homeY: Float,
    val homeWidth: Float,
    val homeHeight: Float,
) {
    val centerX: Float get() = x + width / 2f
    val centerY: Float get() = y + height / 2f

    fun aabb(): CanvasAABB = computeAABB(x, y, width, height, rotation)
}

/** 画布容纳上限（React AddImageModal 同值；矩阵表 1 画布行 N/24）。 */
const val CANVAS_CAPACITY = 24

/** 加图结果（入口 Toast 文案的数据来源）。 */
sealed class AddResult {
    /** 成功加入 [added] 张；[skipped] 为去重跳过数。 */
    data class Added(val added: Int, val skipped: Int) : AddResult()

    /** 画布已满（满员时一个都进不来）。 */
    object Full : AddResult()

    /** 入参全为重复项，一张都没加。 */
    object AllDuplicates : AddResult()
}

/**
 * 画布状态容器（M5 1.1）：items / 视口 / z 序 / 选中 / 编辑态 / 吸附开关的**唯一写者**。
 *
 * - **单实例**（D21）：无画布名、无会话列表；网格/查看器入口统一「加入唯一画布」。
 * - **进程内保活**：实例挂在 GalleryViewModel 上（对齐 topics 等现状的口子），退出画布
 *   视图数据不丢；App 被杀回空（React tab 内存态同语义，D22 顺带覆盖——无持久化）。
 * - 全部写入发生在主线程（Compose 回调），用 Compose state；UI 只消费这里算好的结构。
 */
class CanvasStore {

    /** 当前全部 item（列表序 = 插入序；绘制序由 [zOrderIds] 决定）。 */
    var items by mutableStateOf<List<CanvasItem>>(emptyList())
        private set

    /** z 序（数组尾 = 最上层；绘制与命中自尾向头）。 */
    var zOrderIds by mutableStateOf<List<String>>(emptyList())
        private set

    /** 选中集（触屏路径实际只有单选；保留列表以对齐 React 选中集菜单语义）。 */
    var selectedIds by mutableStateOf<List<String>>(emptyList())
        private set

    /** 编辑模式（长按已选图 500ms 进；双指落下/点空白/选中清空退出）。 */
    var isEditMode by mutableStateOf(false)
        private set

    /** 吸附开关（React isSnappingEnabled 默认开；「吸附功能: ON/OFF」菜单项消费）。 */
    var isSnappingEnabled by mutableStateOf(true)

    /**
     * 视口变换（世界→屏幕）。**刻意不是 Compose state**：它被 CanvasView 在布局/
     * 手势路径高频写入，而没有任何组合订阅者（绘制走 View.invalidate）——曾经是
     * mutableStateOf，在 onSizeChanged（布局 pass 中）写入时与本模拟器的合成管线
     * 冲突（chrome 整层停更），见清单 0.2/1.2 备注。
     */
    var viewport: CanvasViewport = CanvasViewport()
        private set

    /** 用户手动操作过视口（autoFit 语义与 React userInteractedRef 同位）。 */
    var userInteracted: Boolean = false
        private set

    /** 有图加载完成后该做一次 autoFit（React shouldAutoFitAfterLoadRef 同位）。 */
    var autoFitPending: Boolean = false
        private set

    val count: Int get() = items.size
    val isFull: Boolean get() = items.size >= CANVAS_CAPACITY
    val itemById: Map<String, CanvasItem> get() = items.associateBy { it.fileId }

    /** fileId → content uri（加图时登记，CanvasView 解码取流用；非 Compose 状态）。 */
    private val contentUris = HashMap<String, String>()

    fun contentUriOf(fileId: String): String? = contentUris[fileId]

    /** 最后选中的项（React activeImageIds 末项 = 菜单/编辑框的 activeItem）。 */
    val activeItemId: String? get() = selectedIds.lastOrNull()

    // —— 加图（3.1 网格 / 3.2 查看器 / 3.3 添加弹窗三个入口的公共落点）——

    /**
     * 加入一批图：按 fileId 去重（React handleAddImages:1896-1905）、24 上限内收多少算
     * 多少、装箱位（[packNewItems]，围绕现有项）、追加 z 序尾、autoFit 待首批加载完成
     * 后触发。加入后与 React 一致地复位 userInteracted（autoFit 重新接管视口）。
     */
    fun addImages(sources: List<CanvasPackSource>): AddResult {
        if (sources.isEmpty()) return AddResult.Added(0, 0)
        val existing = itemById
        val unique = sources.filter { it.id !in existing }.distinctBy { it.id }
        if (unique.isEmpty()) return AddResult.AllDuplicates
        if (isFull) return AddResult.Full

        val room = CANVAS_CAPACITY - items.size
        val accepted = unique.take(room)
        val skipped = unique.size - accepted.size

        val packed = packNewItems(
            existingRects = items.map { CanvasPackedRect(it.fileId, it.x, it.y, it.width, it.height) },
            newItems = accepted,
        )
        items = items + packed.map { r ->
            CanvasItem(
                fileId = r.id,
                x = r.x, y = r.y, width = r.width, height = r.height,
                rotation = 0f,
                homeX = r.x, homeY = r.y, homeWidth = r.width, homeHeight = r.height,
            )
        }
        zOrderIds = zOrderIds + packed.map { it.id }
        for (src in accepted) contentUris[src.id] = src.contentUri
        autoFitPending = true
        userInteracted = false
        return if (skipped > 0) AddResult.Added(accepted.size, skipped) else AddResult.Added(accepted.size, 0)
    }

    /** 从画布移除（选中集菜单「从对比中移除」；items/z 序/选中一并清）。 */
    fun removeImages(ids: Collection<String>) {
        if (ids.isEmpty()) return
        items = items.filter { it.fileId !in ids }
        zOrderIds = zOrderIds.filter { it !in ids }
        selectedIds = selectedIds.filter { it !in ids }
        ids.forEach { contentUris.remove(it) }
        if (activeItemId == null) isEditMode = false
    }

    /** 重置变换（React handleResetItem：选中项回装箱位、转角归 0）。 */
    fun resetItemTransforms(ids: Collection<String>) {
        if (ids.isEmpty()) return
        items = items.map {
            if (it.fileId in ids && (it.x != it.homeX || it.y != it.homeY || it.rotation != 0f ||
                        it.width != it.homeWidth || it.height != it.homeHeight)
            ) {
                it.copy(x = it.homeX, y = it.homeY, width = it.homeWidth, height = it.homeHeight, rotation = 0f)
            } else {
                it
            }
        }
    }

    /**
     * 重置画布（React handleReset：manualLayouts 清空 = 全部回**重新装箱**的位并
     * autoFit）。全量重排（面积降序），新装箱位成为新的 home。
     */
    fun resetAll() {
        if (items.isEmpty()) return
        val packed = packImages(items.map { CanvasPackSource(it.fileId, it.width, it.height) })
        items = packed.map { r ->
            CanvasItem(
                fileId = r.id,
                x = r.x, y = r.y, width = r.width, height = r.height,
                rotation = 0f,
                homeX = r.x, homeY = r.y, homeWidth = r.width, homeHeight = r.height,
            )
        }
        // z 序按新 items 的存在性过滤保序（React 重置不动 z 序）
        val alive = itemById.keys
        zOrderIds = zOrderIds.filter { it in alive }
        autoFitPending = true
    }

    /** 清空画布（「重置画布」在 React 是 handleReset 重排；此处另备真清空给空态测试用）。 */
    fun clear() {
        items = emptyList()
        zOrderIds = emptyList()
        selectedIds = emptyList()
        contentUris.clear()
        isEditMode = false
        viewport = CanvasViewport()
        autoFitPending = false
        userInteracted = false
    }

    // —— 变换编辑（2.1 编辑手势写这里；「动画查看此图」的双击也用 setViewport）——

    /** 编辑手势更新单项矩形/转角（EditOverlay onUpdateItem 的落点）。 */
    fun updateItemTransform(fileId: String, x: Float? = null, y: Float? = null, width: Float? = null, height: Float? = null, rotation: Float? = null) {
        items = items.map {
            if (it.fileId == fileId) {
                it.copy(
                    x = x ?: it.x,
                    y = y ?: it.y,
                    width = width ?: it.width,
                    height = height ?: it.height,
                    rotation = rotation ?: it.rotation,
                )
            } else {
                it
            }
        }
    }

    /** 视口整体替换（视口手势/zoom 动画的落点；名字避开属性 setter 的 JVM 签名）。 */
    fun applyViewport(v: CanvasViewport) {
        viewport = v
    }

    fun markInteracted() {
        userInteracted = true
    }

    // —— 选中与编辑态（1.3 视口手势驱动）——

    /** 点按选中（触屏=单选替换；React 触屏分支 :1150-1162 同款）。 */
    fun selectSingle(id: String) {
        selectedIds = listOf(id)
        isEditMode = false
    }

    fun clearSelection() {
        selectedIds = emptyList()
        isEditMode = false
    }

    fun enterEditMode() {
        if (selectedIds.isNotEmpty()) isEditMode = true
    }

    fun exitEditMode() {
        isEditMode = false
    }

    // —— z 序（2.2 选中集菜单四项；React handleReorder 语义）——

    fun reorderActive(op: ZOrderOp) {
        val target = activeItemId ?: return
        zOrderIds = reorderZOrder(
            zOrderIds = zOrderIds,
            targetId = target,
            op = op,
            existingIds = itemById.keys,
            isOverlap = { a, b ->
                val ia = itemById[a]
                val ib = itemById[b]
                ia != null && ib != null && aabbOverlap(ia.aabb(), ib.aabb())
            },
        )
    }

    /**
     * 「查看全部」的内容边界（React handleViewAll:1844-1873：全部 item **旋转后**角点
     * 的联合 AABB）。items 为空返回 null。
     */
    fun contentBounds(): CanvasAABB? {
        if (items.isEmpty()) return null
        var minX = Float.MAX_VALUE
        var minY = Float.MAX_VALUE
        var maxX = -Float.MAX_VALUE
        var maxY = -Float.MAX_VALUE
        for (it in items) {
            val a = it.aabb()
            minX = min(minX, a.minX)
            minY = min(minY, a.minY)
            maxX = max(maxX, a.maxX)
            maxY = max(maxY, a.maxY)
        }
        return CanvasAABB(minX, minY, maxX, maxY)
    }

    /**
     * autoFit（1.4）：[autoFitPending] 且有内容且容器有效时，算 fit 变换写入视口并消费
     * pending。返回是否真的执行（调用方可借此触发动画）。
     */
    fun applyAutoFitIfPending(containerWidth: Float, containerHeight: Float): Boolean {
        if (!autoFitPending) return false
        val bounds = contentBounds() ?: return false
        val fit = computeFitTransform(containerWidth, containerHeight, bounds) ?: return false
        autoFitPending = false
        viewport = fit
        return true
    }

    /** 「查看全部」/「重置画布」的主动 fit（不经 pending，直接动画到位）。 */
    fun fitToContent(containerWidth: Float, containerHeight: Float): Boolean {
        val bounds = contentBounds() ?: return false
        val fit = computeFitTransform(containerWidth, containerHeight, bounds) ?: return false
        viewport = fit
        userInteracted = true
        return true
    }
}
