package com.aurora.gallery.kotlin.ui.components

import com.aurora.gallery.kotlin.state.DateFilter
import com.aurora.gallery.kotlin.state.DateFilterMode
import com.aurora.gallery.kotlin.state.SortDirection
import com.aurora.gallery.kotlin.state.SortOption
import uniffi.aurora_core.Folder
import uniffi.aurora_core.Image
import java.util.Calendar
import java.util.Locale
import kotlin.math.max

/**
 * 根目录散落文件的虚拟文件夹名（MediaStore 的 bucket_display_name 为 NULL 时的兜底名，
 * 对齐 React 版 `__android_root_images__` 的「根目录图片」）。总览排序与 ViewModel 的
 * 扫描管道共用同一常量，避免两处字面量漂移。
 */
internal const val ROOT_FOLDER_DISPLAY_NAME = "根目录图片"

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

/**
 * 按搜索词与日期筛选图片（3.2 TopBar 的数据管道第一步）。
 *
 * 语义对齐 React `useFileSearch.ts`：
 *  - 搜索：文件名 contains、大小写不敏感（该文件 129-135 行的 `file` scope 分支）；
 *  - 日期：**start 与 end 同时存在才生效**（该文件 152 行的条件），[DateFilter.mode]
 *    决定比较 createdAt 还是 modifiedAt（epoch 秒，含端点）。
 *
 * **标签筛选不在这里**，别照着 React 的 `scope === 'tag'` 分支往这儿补：M4a 4.1 定的做法是
 * 把标签当成**序列源**而不是谓词——`GalleryViewModel.reloadImages` 在 activeTags 非空时
 * 直接调 `list_images_by_tags` 取全库命中的图。理由：侧栏标签上的计数是全库口径，
 * 若只把当前文件夹的序列过滤一遍，同一屏上会出现「徽标 5、点开 2 张」的自相矛盾。
 * 补在这里等于两套标签筛选，且第二套是错的。
 */
fun filterImages(images: List<Image>, query: String, dateFilter: DateFilter): List<Image> {
    val q = query.trim().lowercase(Locale.US)
    val dateActive = dateFilter.start != null && dateFilter.end != null
    if (q.isEmpty() && !dateActive) return images
    return images.filter { img ->
        (q.isEmpty() || img.name.lowercase(Locale.US).contains(q)) &&
            (!dateActive || run {
                val d = if (dateFilter.mode == DateFilterMode.CREATED) img.createdAt else img.modifiedAt
                d >= dateFilter.start!! && d <= dateFilter.end!!
            })
    }
}

/**
 * 排序（3.2 TopBar 的数据管道第二步）。
 *
 * 对齐 React `useFileSearch.ts` 169-172 行：name = 文件名小写比较、date = createdAt、
 * size = 字节数；asc/desc 翻转。React 用 `localeCompare`（locale 感知），Kotlin 用
 * 码位比较——对 ASCII 与中文文件名的差异可忽略，避免 Collator 在 1~2 万条上的开销。
 * 排序稳定，同键保持 `list_images` 的 modified DESC 原序。
 */
fun sortImages(images: List<Image>, sortBy: SortOption, direction: SortDirection): List<Image> {
    if (images.size < 2) return images
    val comparator = when (sortBy) {
        SortOption.NAME -> compareBy<Image> { it.name.lowercase(Locale.US) }
        SortOption.DATE -> compareBy { it.createdAt }
        SortOption.SIZE -> compareBy { it.size }
    }
    return if (direction == SortDirection.ASC) {
        images.sortedWith(comparator)
    } else {
        images.sortedWith(comparator.reversed())
    }
}

/**
 * 总览文件夹排序（2026-09-17 总览 TopBar 接入排序菜单）。
 *
 * 语义对齐 React `FoldersOverview.tsx` 的 `sortedFolderIds` memo：name = 名称小写比较、
 * size = 图片数（React 用 `imageCount ?? size`）、date = 文件夹创建时间（2026-09-17 起
 * `Folder.createdAt` = 最早子图创建时间，Rust `list_folders` 提供）。无日期（无图，
 * createdAt=0）的文件夹**恒排最后**，不随方向翻转。排序稳定，同键保持 `list_folders`
 * 的原序；「根目录图片」在排序结果之上**恒置顶**（对齐 React 把 `__lan_root_images__`
 * unshift 到顶部；与 GalleryViewModel.orderFoldersForOverview 同一条规则，双保险）。
 */
fun sortFolders(folders: List<Folder>, sortBy: SortOption, direction: SortDirection): List<Folder> {
    if (folders.size < 2) return folders
    val sorted = when (sortBy) {
        SortOption.SIZE -> {
            val comparator = compareBy<Folder> { it.imageCount }
            if (direction == SortDirection.ASC) folders.sortedWith(comparator)
            else folders.sortedWith(comparator.reversed())
        }
        SortOption.DATE -> {
            val comparator = compareBy<Folder> { it.createdAt }
            val dated = folders.filter { it.createdAt > 0 }
            val undated = folders.filterNot { it.createdAt > 0 }
            if (direction == SortDirection.ASC) dated.sortedWith(comparator) + undated
            else dated.sortedWith(comparator.reversed()) + undated
        }
        else -> {
            val comparator = compareBy<Folder> { it.name.lowercase(Locale.US) }
            if (direction == SortDirection.ASC) folders.sortedWith(comparator)
            else folders.sortedWith(comparator.reversed())
        }
    }
    return sorted.sortedBy { it.name != ROOT_FOLDER_DISPLAY_NAME }
}

/**
 * 总览文件夹过滤（2026-09-17 总览 TopBar 接入搜索/日期筛选）。
 *
 * 搜索：文件夹名 contains、大小写不敏感（同 [filterImages] 的文件名分支）。
 * 日期：**start 与 end 同时存在才生效**（对齐 `useFileSearch:152`）。语义用文件夹的
 * 代表日期做区间命中——CREATED 用 [Folder.createdAt]（最早子图，「这段时间创建的
 * 相册」）、UPDATED 用 [Folder.modifiedAt]（最新子图修改，「这段时间有更新的相册」）。
 * React 是「任一子图命中」（逐子图检查），代表日期是它的近似：CREATED 等价（最早命中
 * ⟺ 有命中），UPDATED 在「区间后还有更新」的文件夹上会漏选——按「最近更新过」的筛选
 * 直觉这反而是想要的行为，差异已注明。
 */
fun filterFolders(folders: List<Folder>, query: String, dateFilter: DateFilter): List<Folder> {
    val q = query.trim().lowercase(Locale.US)
    val dateActive = dateFilter.start != null && dateFilter.end != null
    if (q.isEmpty() && !dateActive) return folders
    return folders.filter { f ->
        (q.isEmpty() || f.name.lowercase(Locale.US).contains(q)) &&
            (!dateActive || run {
                val d = if (dateFilter.mode == DateFilterMode.CREATED) f.createdAt else f.modifiedAt
                d >= dateFilter.start!! && d <= dateFilter.end!!
            })
    }
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
