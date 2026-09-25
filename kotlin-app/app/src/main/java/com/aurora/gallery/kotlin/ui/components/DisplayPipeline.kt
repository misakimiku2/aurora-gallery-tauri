package com.aurora.gallery.kotlin.ui.components

import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import com.aurora.gallery.kotlin.state.SearchScope
import com.aurora.gallery.kotlin.state.SortDirection
import com.aurora.gallery.kotlin.state.SortOption
import com.aurora.gallery.kotlin.state.TabState
import uniffi.aurora_core.FfiFileMetadata
import uniffi.aurora_core.Image

/**
 * 网格的展示序列（搜索/日期过滤 → 排序），M1 3.2 数据管道的组合点。
 *
 * 单列成函数是因为有两个消费者必须拿到**同一个**序列：网格本身，和 M3 查看器的进入序列
 * （2.2 的硬要求——`startIndex` 必须落在这条过滤后的序列上，否则筛选态下翻页会翻到
 * 被过滤掉的图）。
 *
 * M4b 阶段 3 起 scope 下拉进管道：scope 快照（[SearchScope]）与标签/元数据快照由组合根
 * 喂入，作为 remember 的 key——切 scope、打标签、改描述都会让序列重算，无需额外失效时机。
 */
@Composable
fun rememberDisplayImages(
    images: List<Image>,
    tab: TabState,
    sortBy: SortOption,
    sortDirection: SortDirection,
    /** file_id → 标签（VM 快照；scope=TAG/ALL 的文本搜索用）。 */
    tagsByFile: Map<String, List<String>> = emptyMap(),
    /** file_id → 元数据（VM 快照；scope=ALL 搜描述用）。 */
    metadataById: Map<String, FfiFileMetadata> = emptyMap(),
    /** 当前视图所属文件夹名（scope=FOLDER 的序列级判定用）。 */
    viewFolderName: String = "",
    /**
     * M6b 阶段 2：AI 搜索命中集（null=普通管道）。非 null 时 images 应传**全库命中序列**
     * （VM 的 aiSearchResultImages）——AI 是全库语义；文本/日期/scope 过滤整体跳过
     * （原查询是自然语言，做 name 子串匹配只会把命中集错杀），仅排序保留。
     */
    aiFilterIds: Set<String>? = null,
): List<Image> = remember(
    images, tab.searchQuery, tab.dateFilter, tab.searchScope,
    sortBy, sortDirection, tagsByFile, metadataById, viewFolderName, aiFilterIds,
) {
    if (aiFilterIds != null) {
        sortImages(images.filter { it.id in aiFilterIds }, sortBy, sortDirection)
    } else {
        sortImages(
            filterImages(
                images, tab.searchQuery, tab.dateFilter, tab.searchScope,
                tagsByFile, metadataById, viewFolderName,
            ),
            sortBy, sortDirection,
        )
    }
}
