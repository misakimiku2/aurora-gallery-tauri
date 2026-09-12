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
 *（同文件 1368-1372 行）。因此 Kotlin 端不实现列表模式。
 *
 * 排布算法对齐 `src/workers/layout.worker.ts`：GRID/MASONRY 按列铺、ADAPTIVE 按行装箱
 *（行划分在 [AuroraAdaptiveLayoutManager] 内完成，item 与 GRID/MASONRY 同为一图一项）。
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

/** 网格项：分组标题 / 一张图片。三种布局模式的 item 粒度一致（一图一项）。 */
sealed interface GridItem {
    /** 分组标题行（占满整行）。 */
    data class Header(val id: String, val title: String, val count: Int) : GridItem

    /** 一张图片。 */
    data class Photo(val image: Image) : GridItem
}

private const val UNKNOWN_GROUP = "Unknown"

/** type 分组 key：`format.toUpperCase()`（对齐 React 版）。 */
private fun typeKey(image: Image): String =
    image.format?.takeIf { it.isNotBlank() }?.uppercase(Locale.US) ?: UNKNOWN_GROUP

/** date 分组 key：`createdAt` 的 `YYYY-MM`（对齐 React 版）。 */
private fun dateKey(image: Image): String {
    if (image.createdAt <= 0L) return UNKNOWN_GROUP
    val cal = Calendar.getInstance().apply { timeInMillis = image.createdAt * 1000L }
    return String.format(Locale.US, "%04d-%02d", cal.get(Calendar.YEAR), cal.get(Calendar.MONTH) + 1)
}

/**
 * adaptive 行的目标图片高度（dp），即 React 版 adaptive 分支里的 `targetHeight = thumbnailSize`。
 *
 * 对齐 `layout.worker.ts` / `androidThumbnailSizes.ts`：
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
 * 把图片序列（含分组标题）平铺成 RecyclerView 的 item 序列。
 *
 * 三种布局模式的 item 粒度一致（一图一项）：adaptive 的「行」不再是 item，行划分由
 * [AuroraAdaptiveLayoutManager] 在布局期完成——这样捏合换档时 position 与图的对应
 * 关系保持稳定，进度驱动的跟手预览才有「同一 item 旧位置 → 新位置」可插值。
 *
 * 分组规则逐条对齐 React 版 `useFileSearch.ts` 的 `groupedFiles` memo：
 *  - 组之间的顺序 = 各组**首个元素**在列表中的出现顺序（React 版依赖 `Object.entries`
 *    的插入顺序，即首次赋值的先后）；
 *  - 组内顺序 = 原列表顺序（列表已由 `list_images` 的 `ORDER BY modified_at DESC` 排好）。
 * 折叠时仍保留标题行本身，只是不输出该组的图片。
 */
fun buildGridItems(
    images: List<Image>,
    groupBy: GroupBy,
    collapsedIds: Set<String> = emptySet(),
): List<GridItem> {
    if (groupBy == GroupBy.NONE) return images.map { GridItem.Photo(it) }

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
        if (key !in collapsedIds) {
            out.addAll(list.map { GridItem.Photo(it) })
        }
    }
    return out
}
