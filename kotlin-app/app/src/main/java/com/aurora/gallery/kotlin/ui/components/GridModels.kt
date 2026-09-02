package com.aurora.gallery.kotlin.ui.components

import uniffi.aurora_core.Image
import java.util.Calendar
import java.util.Locale
import kotlin.math.max

/**
 * 布局模式。
 *
 * **不含 list**——对齐 React 版安卓端：`src/components/TopBar.tsx` 的 `isAndroid` 分支
 * 只在 `['grid', 'adaptive', 'masonry']` 之间循环切换，list 只出现在桌面端的完整菜单里
 * （同文件 1368-1372 行）。因此 Kotlin 端不实现列表模式。
 *
 * 排布算法对齐 `src/workers/layout.worker.ts` 的 `viewMode === 'browser'` 分支
 *（GAP/PADDING 手机 10/8、平板 16/24；卡片文字区 40px）。
 */
enum class LayoutMode { GRID, ADAPTIVE, MASONRY }

/**
 * 分组方式。
 *
 * 对齐 React 版 `GroupByOption`：其类型定义为 `'none' | 'type' | 'date' | 'size'`，
 * 但 `src/hooks/useFileSearch.ts` 的 `groupedFiles` memo **只实现了 type 与 date 两个分支**
 *（`'size'` 会连同其它情况一起落到 `'Other'`）。Kotlin 端沿用同一行为，不实现按大小分组。
 */
enum class GroupBy { NONE, TYPE, DATE }

/** 宽高比（w/h），缺尺寸时按 1:1 处理（对齐 React 版 `aspectRatios[id] || 1`）。 */
internal fun aspectRatioOf(image: Image): Float {
    val w = image.width?.toFloat()
    val h = image.height?.toFloat()
    return if (w != null && h != null && h > 0f) w / h else 1f
}

/**
 * adaptive 模式的一行。
 *
 * 行内图片按原始宽高比排布、整行拉伸填满容器宽度，因此**行内等高、行间不等高**
 *（对齐 `layout.worker.ts` 的 adaptive 分支）。
 *
 * @param imageHeightDp 行内图片高度（不含文字区）
 * @param widthsDp 行内每张图片的宽度，与 [images] 一一对应
 */
data class AdaptiveRowLayout(
    val images: List<Image>,
    val imageHeightDp: Float,
    val widthsDp: List<Float>,
)

/** 网格项：分组标题 / 一张图片 / adaptive 的一行。 */
sealed interface GridItem {
    /** 分组标题行（占满整行）。 */
    data class Header(val id: String, val title: String, val count: Int) : GridItem

    /** 一张图片（grid / masonry 用）。 */
    data class Photo(val image: Image) : GridItem

    /** adaptive 的一行（行容器：RecyclerView 的一个 item 就是一行）。 */
    data class AdaptiveRow(val row: AdaptiveRowLayout) : GridItem
}

private const val UNKNOWN_GROUP = "Unknown"

/** type 分组 key：`format.toUpperCase()`（对齐 React 版）。 */
private fun typeKey(image: Image): String =
    image.format?.takeIf { it.isNotBlank() }?.uppercase(Locale.US) ?: UNKNOWN_GROUP

/** date 分组 key：`createdAt` 的 `YYYY-MM`（对齐 React 版 `createdAt.substring(0, 7)`）。 */
private fun dateKey(image: Image): String {
    if (image.createdAt <= 0L) return UNKNOWN_GROUP
    val cal = Calendar.getInstance().apply { timeInMillis = image.createdAt * 1000L }
    return String.format(Locale.US, "%04d-%02d", cal.get(Calendar.YEAR), cal.get(Calendar.MONTH) + 1)
}

/**
 * adaptive 行的目标图片高度（dp），即 React 版 adaptive 分支里的 `targetHeight = thumbnailSize`。
 *
 * 对齐 `src/utils/androidThumbnailSizes.ts` 的 `androidLevelToThumbnailSize`：
 * `(availableWidth + gap) / targetCols - gap`，clamp 到 [100, 480]。
 */
fun adaptiveTargetHeightDp(
    containerWidthDp: Int,
    cols: Int,
    gapDp: Int,
    paddingDp: Int,
): Float {
    val available = max(100, containerWidthDp - paddingDp * 2)
    val raw = (available + gapDp).toFloat() / max(1, cols) - gapDp
    return raw.coerceIn(100f, 480f)
}

/**
 * 行化：把图片序列切成 adaptive 的行，逐条对齐 `layout.worker.ts` 的 adaptive 分支。
 *
 *  - 累积 `w = targetHeight * ratio`，达到容器宽度（含 gap）或到最后一张时成行；
 *  - 整行按 `scale = (availableWidth - gaps) / currentWidth` 拉伸填满；
 *  - **最后一行若不足容器一半宽则不拉伸**（React 版的 `scale = 1` 特例）。
 */
private fun buildAdaptiveRows(
    images: List<Image>,
    containerWidthDp: Int,
    targetHeightDp: Float,
    gapDp: Int,
): List<AdaptiveRowLayout> {
    if (images.isEmpty() || containerWidthDp <= 0 || targetHeightDp <= 0f) return emptyList()

    val rows = ArrayList<AdaptiveRowLayout>()
    var current = ArrayList<Image>()
    var currentWidth = 0f

    images.forEachIndexed { index, image ->
        current.add(image)
        currentWidth += targetHeightDp * aspectRatioOf(image)

        val gaps = max(0, current.size - 1) * gapDp
        val isLast = index == images.size - 1
        if (currentWidth + gaps >= containerWidthDp || isLast) {
            var scale = (containerWidthDp - gaps) / currentWidth
            if (isLast && currentWidth + gaps < containerWidthDp / 2f) scale = 1f
            val height = targetHeightDp * scale
            val widths = current.map { targetHeightDp * aspectRatioOf(it) * scale }
            rows.add(AdaptiveRowLayout(current.toList(), height, widths))
            current = ArrayList()
            currentWidth = 0f
        }
    }
    return rows
}

/**
 * 按 [groupBy] 把图片列表拍平成 RecyclerView 的 item 序列。
 *
 * 分组规则逐条对齐 React 版 `useFileSearch.ts` 的 `groupedFiles` memo：
 *  - 分组之间的顺序 = 各组**首个元素**在列表中的出现顺序（React 版依赖 `Object.entries`
 *    的插入顺序，即首次赋值的先后）；
 *  - 组内顺序 = 原列表顺序（列表已由 `list_images` 的 `ORDER BY modified_at DESC` 排好，
 *    React 版同理是先排序再分组）。
 *
 * adaptive 模式下每个 item 是一行而非一张图；[containerWidthDp] / [targetHeightDp] / [gapDp]
 * 参与行化计算，传 0 时退化为按图片展开（宽度尚未量出时的首帧）。
 * **分组时组内独立行化**——对齐 React 版 `GroupContent` 对每个 group 单独跑 `useLayout`。
 */
fun buildGridItems(
    images: List<Image>,
    groupBy: GroupBy,
    collapsedIds: Set<String> = emptySet(),
    layoutMode: LayoutMode = LayoutMode.GRID,
    containerWidthDp: Int = 0,
    targetHeightDp: Float = 0f,
    gapDp: Int = 0,
): List<GridItem> {
    val adaptive = layoutMode == LayoutMode.ADAPTIVE && containerWidthDp > 0 && targetHeightDp > 0f

    fun expand(list: List<Image>): List<GridItem> = if (adaptive) {
        buildAdaptiveRows(list, containerWidthDp, targetHeightDp, gapDp).map { GridItem.AdaptiveRow(it) }
    } else {
        list.map { GridItem.Photo(it) }
    }

    if (groupBy == GroupBy.NONE) return expand(images)

    val order = ArrayList<String>()
    val buckets = HashMap<String, MutableList<Image>>()
    for (img in images) {
        val key = when (groupBy) {
            GroupBy.TYPE -> typeKey(img)
            GroupBy.DATE -> dateKey(img)
            else -> UNKNOWN_GROUP
        }
        val bucket = buckets[key]
        if (bucket == null) {
            buckets[key] = mutableListOf(img)
            order.add(key)
        } else {
            bucket.add(img)
        }
    }

    val out = ArrayList<GridItem>(images.size + order.size)
    for (key in order) {
        val list = buckets[key] ?: continue
        out.add(GridItem.Header(id = key, title = key, count = list.size))
        // 折叠时仍保留标题行本身，只是不输出该组的图片
        if (key !in collapsedIds) {
            out.addAll(expand(list))
        }
    }
    return out
}
