package com.aurora.gallery.kotlin.ui.components

import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import com.aurora.gallery.kotlin.state.SortDirection
import com.aurora.gallery.kotlin.state.SortOption
import com.aurora.gallery.kotlin.state.TabState
import uniffi.aurora_core.Image

/**
 * 网格的展示序列（搜索/日期过滤 → 排序），M1 3.2 数据管道的组合点。
 *
 * 单列成函数是因为有两个消费者必须拿到**同一个**序列：网格本身，和 M3 查看器的进入序列
 * （2.2 的硬要求——`startIndex` 必须落在这条过滤后的序列上，否则筛选态下翻页会翻到
 * 被过滤掉的图）。
 */
@Composable
fun rememberDisplayImages(
    images: List<Image>,
    tab: TabState,
    sortBy: SortOption,
    sortDirection: SortDirection,
): List<Image> = remember(images, tab.searchQuery, tab.dateFilter, sortBy, sortDirection) {
    sortImages(filterImages(images, tab.searchQuery, tab.dateFilter), sortBy, sortDirection)
}
