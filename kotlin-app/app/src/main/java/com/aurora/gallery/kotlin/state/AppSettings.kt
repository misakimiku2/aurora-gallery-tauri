package com.aurora.gallery.kotlin.state

import android.content.Context
import com.aurora.gallery.kotlin.ui.components.LayoutMode

/**
 * 应用设置（M4b 2.1，D15 拍板：落 SharedPreferences，不导出 blob——设置项低频写、
 * 启动读、量级 KB，别为「将来三端一致」提前建抽象）。
 *
 * 项目范围按 D19 圈定：语言（标签 collation）/默认布局/默认排序；主题暗色、自启动、
 * 退出行为、folderIconStyle 不做（Kotlin 恒浅色 M1 拍板、桌面专属），animateOnSelect
 * 无对应效果随实现登记不做。专题排序（M4a 3.3 的 `aurora_topics` 散装偏好）并入本入口。
 */
data class AppSettings(
    /** 标签分组/组内排序的 locale（"zh" | "en"，M4a 顺延项 1 的语言开关）。 */
    val language: String = "zh",
    val defaultLayout: LayoutMode = LayoutMode.GRID,
    val defaultSortBy: SortOption = SortOption.DATE,
    val defaultSortDirection: SortDirection = SortDirection.DESC,
) {
    companion object {
        val LANGUAGE_ZH = "zh"
        val LANGUAGE_EN = "en"
    }
}

/**
 * 设置的唯一读写口（SharedPreferences `aurora_settings`）。专题排序也走这里：旧键
 * （`aurora_topics` 文件）在首次读取时迁移，行为不变（2.1 验收）。
 */
class SettingsStore(context: Context) {
    private val prefs = context.getSharedPreferences("aurora_settings", Context.MODE_PRIVATE)
    private val legacyTopicPrefs = context.getSharedPreferences("aurora_topics", Context.MODE_PRIVATE)

    fun load(): AppSettings = AppSettings(
        language = prefs.getString(KEY_LANGUAGE, AppSettings.LANGUAGE_ZH) ?: AppSettings.LANGUAGE_ZH,
        defaultLayout = prefs.getString(KEY_LAYOUT, null)?.let { layoutFromName(it) } ?: LayoutMode.GRID,
        defaultSortBy = prefs.getString(KEY_SORT_BY, null)?.let { sortFromName(it) } ?: SortOption.DATE,
        defaultSortDirection = if (prefs.getBoolean(KEY_SORT_ASC, false)) SortDirection.ASC else SortDirection.DESC,
    )

    fun save(settings: AppSettings) {
        prefs.edit()
            .putString(KEY_LANGUAGE, settings.language)
            .putString(KEY_LAYOUT, settings.defaultLayout.name)
            .putString(KEY_SORT_BY, settings.defaultSortBy.name)
            .putBoolean(KEY_SORT_ASC, settings.defaultSortDirection == SortDirection.ASC)
            .apply()
    }

    /** 专题排序（M4a 3.3 并入）：优先新文件，旧 `aurora_topics` 只读迁移。 */
    fun loadTopicSortByName(): Boolean =
        if (prefs.contains(KEY_TOPIC_SORT_BY_NAME)) prefs.getBoolean(KEY_TOPIC_SORT_BY_NAME, false)
        else legacyTopicPrefs.getBoolean("sortByName", false)

    fun loadTopicSortAscending(): Boolean =
        if (prefs.contains(KEY_TOPIC_SORT_ASC)) prefs.getBoolean(KEY_TOPIC_SORT_ASC, false)
        else legacyTopicPrefs.getBoolean("sortAscending", false)

    fun saveTopicSort(sortByName: Boolean, ascending: Boolean) {
        prefs.edit()
            .putBoolean(KEY_TOPIC_SORT_BY_NAME, sortByName)
            .putBoolean(KEY_TOPIC_SORT_ASC, ascending)
            .apply()
    }

    private fun layoutFromName(name: String): LayoutMode =
        LayoutMode.entries.firstOrNull { it.name == name } ?: LayoutMode.GRID

    private fun sortFromName(name: String): SortOption =
        SortOption.entries.firstOrNull { it.name == name } ?: SortOption.DATE

    private companion object {
        const val KEY_LANGUAGE = "language"
        const val KEY_LAYOUT = "defaultLayout"
        const val KEY_SORT_BY = "defaultSortBy"
        const val KEY_SORT_ASC = "defaultSortAscending"
        const val KEY_TOPIC_SORT_BY_NAME = "topicSortByName"
        const val KEY_TOPIC_SORT_ASC = "topicSortAscending"
    }
}
