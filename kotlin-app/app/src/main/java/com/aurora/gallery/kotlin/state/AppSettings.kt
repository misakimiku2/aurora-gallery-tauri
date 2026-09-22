package com.aurora.gallery.kotlin.state

import android.content.Context
import com.aurora.gallery.kotlin.ui.components.GroupBy
import com.aurora.gallery.kotlin.ui.components.LayoutMode

/**
 * 应用设置（M4b 2.1，D15 拍板：落 SharedPreferences，不导出 blob——设置项低频写、
 * 启动读、量级 KB，别为「将来三端一致」提前建抽象）。
 *
 * 项目范围按 D19 圈定、M4c（D22）二次筛选：语言（标签 collation）/主题（light/dark/
 * system，M4c 起点亮暗色档，修订 D19 的「暗色不做」）/默认布局/默认排序/默认分组
 * （M4c 新增——GroupBy 网格能力 M1 已有，补持久化对齐桌面 defaultLayoutSettings.
 * groupBy）；自启动、退出行为、folderIconStyle 不做（桌面专属），animateOnSelect
 * 无对应效果随实现登记不做。专题排序（M4a 3.3 的 `aurora_topics` 散装偏好）并入本入口。
 */
data class AppSettings(
    /** 标签分组/组内排序的 locale（"zh" | "en"，M4a 顺延项 1 的语言开关）。 */
    val language: String = "zh",
    /** 主题档（M4c，对齐桌面 GeneralPanel 的 settings.theme："light" | "dark" | "system"）。 */
    val theme: String = THEME_SYSTEM,
    val defaultLayout: LayoutMode = LayoutMode.GRID,
    val defaultSortBy: SortOption = SortOption.DATE,
    val defaultSortDirection: SortDirection = SortDirection.DESC,
    /** 默认分组方式（M4c，对齐桌面 GeneralPanel 的 defaultLayoutSettings.groupBy；无 SIZE，见 GroupBy KDoc）。 */
    val defaultGroupBy: GroupBy = GroupBy.NONE,
) {
    companion object {
        val LANGUAGE_ZH = "zh"
        val LANGUAGE_EN = "en"
        val THEME_LIGHT = "light"
        val THEME_DARK = "dark"
        val THEME_SYSTEM = "system"
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
        theme = prefs.getString(KEY_THEME, null)?.takeIf { it in VALID_THEMES } ?: AppSettings.THEME_SYSTEM,
        defaultLayout = prefs.getString(KEY_LAYOUT, null)?.let { layoutFromName(it) } ?: LayoutMode.GRID,
        defaultSortBy = prefs.getString(KEY_SORT_BY, null)?.let { sortFromName(it) } ?: SortOption.DATE,
        defaultSortDirection = if (prefs.getBoolean(KEY_SORT_ASC, false)) SortDirection.ASC else SortDirection.DESC,
        defaultGroupBy = prefs.getString(KEY_GROUP_BY, null)?.let { groupFromName(it) } ?: GroupBy.NONE,
    )

    fun save(settings: AppSettings) {
        prefs.edit()
            .putString(KEY_LANGUAGE, settings.language)
            .putString(KEY_THEME, settings.theme)
            .putString(KEY_LAYOUT, settings.defaultLayout.name)
            .putString(KEY_SORT_BY, settings.defaultSortBy.name)
            .putBoolean(KEY_SORT_ASC, settings.defaultSortDirection == SortDirection.ASC)
            .putString(KEY_GROUP_BY, settings.defaultGroupBy.name)
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

    private fun groupFromName(name: String): GroupBy =
        GroupBy.entries.firstOrNull { it.name == name } ?: GroupBy.NONE

    private companion object {
        const val KEY_LANGUAGE = "language"
        const val KEY_THEME = "theme"
        const val KEY_LAYOUT = "defaultLayout"
        const val KEY_SORT_BY = "defaultSortBy"
        const val KEY_SORT_ASC = "defaultSortAscending"
        const val KEY_GROUP_BY = "defaultGroupBy"
        const val KEY_TOPIC_SORT_BY_NAME = "topicSortByName"
        const val KEY_TOPIC_SORT_ASC = "topicSortAscending"
        val VALID_THEMES = setOf(AppSettings.THEME_LIGHT, AppSettings.THEME_DARK, AppSettings.THEME_SYSTEM)
    }
}
