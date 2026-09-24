package com.aurora.gallery.kotlin.state

import android.content.Context
import com.aurora.gallery.kotlin.ui.components.GroupBy
import com.aurora.gallery.kotlin.ui.components.LayoutMode
import java.util.UUID

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

    // —— M6a 阶段 3：LAN 连接持久化（lanHost/lanPort/lanToken/savedServers/
    //    lanServerEnabled（阶段 7 用，先落键）/ 设备名 / device_id）——
    // 不并入 [AppSettings]：token/最近服务器是连接态而非用户偏好，读写走专用入口，
    // 由 LanManager 独占调用，避免混进设置面板的整行 save。

    /**
     * 本机设备标识（对齐 React `lanClientApi.getDeviceId` 的语义）：首次生成 UUID 持久化，
     * 之后复用——服务端按 device_id 覆盖旧会话；双模拟器并发时各设备必须唯一（会互踢）。
     */
    fun loadLanDeviceId(): String {
        prefs.getString(KEY_LAN_DEVICE_ID, null)?.let { return it }
        val id = UUID.randomUUID().toString()
        prefs.edit().putString(KEY_LAN_DEVICE_ID, id).apply()
        return id
    }

    /** 设备名（认证时上报桌面端显示）。默认取系统型号（React 从 UA 解析的同语义）。 */
    fun loadLanDeviceName(): String =
        prefs.getString(KEY_LAN_DEVICE_NAME, null)?.takeIf { it.isNotBlank() }
            ?: android.os.Build.MODEL.ifBlank { "Android 设备" }

    fun saveLanDeviceName(name: String) {
        prefs.edit().putString(KEY_LAN_DEVICE_NAME, name.trim()).apply()
    }

    /** 最近一次成功连接的三元组（杀进程重启自动恢复用）。 */
    fun loadLanConnection(): LanConnectionRecord? {
        val host = prefs.getString(KEY_LAN_HOST, null) ?: return null
        if (host.isEmpty()) return null
        return LanConnectionRecord(
            host = host,
            port = prefs.getInt(KEY_LAN_PORT, 0).takeIf { it > 0 } ?: return null,
            token = prefs.getString(KEY_LAN_TOKEN, null)?.takeIf { it.isNotEmpty() },
            serverName = prefs.getString(KEY_LAN_SERVER_NAME, null)?.takeIf { it.isNotEmpty() },
        )
    }

    /** 连接成功后保存 lanHost/lanPort/token（serverName 一并留作状态行展示）。 */
    fun saveLanConnection(host: String, port: Int, token: String, serverName: String?) {
        prefs.edit()
            .putString(KEY_LAN_HOST, host)
            .putInt(KEY_LAN_PORT, port)
            .putString(KEY_LAN_TOKEN, token)
            .putString(KEY_LAN_SERVER_NAME, serverName)
            .apply()
    }

    /** 只清 token（host/port/serverName 保留：401 清理后重试循环还要按 host/port 重连）。 */
    fun clearLanToken() {
        prefs.edit().putString(KEY_LAN_TOKEN, null).apply()
    }

    /** 最近服务器列表（上限 [SAVED_SERVERS_LIMIT] 条，含访问码供一键重连；新者在前）。 */
    fun loadSavedServers(): List<LanSavedServer> = runCatching {
        val raw = prefs.getString(KEY_LAN_SAVED_SERVERS, null) ?: return emptyList()
        val arr = org.json.JSONArray(raw)
        (0 until arr.length()).mapNotNull { i ->
            val o = arr.optJSONObject(i) ?: return@mapNotNull null
            val host = o.optString("host")
            val port = o.optInt("port")
            if (host.isEmpty() || port <= 0) return@mapNotNull null
            LanSavedServer(
                host = host,
                port = port,
                // org.json 的 optString 对 JSON null 返回字面量 "null"——必须先 isNull 判空
                name = o.optString("name").takeIf { !o.isNull("name") && it.isNotEmpty() },
                accessCode = o.optString("accessCode").takeIf { !o.isNull("accessCode") && it.isNotEmpty() },
                lastConnected = o.optLong("lastConnected", 0L),
            )
        }
    }.getOrDefault(emptyList())

    /**
     * 连接成功就记录：同 host:port 去重置顶（刷新访问码/时间），超上限丢最旧
     * （对齐 React `saveRecentServer` 的 cap-10 语义）。
     */
    fun recordSavedServer(host: String, port: Int, name: String?, accessCode: String?) {
        val existing = loadSavedServers().toMutableList()
        existing.removeAll { it.host == host && it.port == port }
        existing.add(
            0,
            LanSavedServer(
                host = host,
                port = port,
                name = name?.takeIf { it.isNotBlank() },
                accessCode = accessCode?.takeIf { it.isNotBlank() },
                lastConnected = System.currentTimeMillis(),
            ),
        )
        val capped = existing.take(SAVED_SERVERS_LIMIT)
        val arr = org.json.JSONArray()
        capped.forEach { s ->
            arr.put(
                org.json.JSONObject()
                    .put("host", s.host)
                    .put("port", s.port)
                    .put("name", s.name ?: org.json.JSONObject.NULL)
                    .put("accessCode", s.accessCode ?: org.json.JSONObject.NULL)
                    .put("lastConnected", s.lastConnected),
            )
        }
        prefs.edit().putString(KEY_LAN_SAVED_SERVERS, arr.toString()).apply()
    }

    /** 对等服务端开关（阶段 7 落地，先落键记忆）。 */
    fun loadLanServerEnabled(): Boolean = prefs.getBoolean(KEY_LAN_SERVER_ENABLED, false)

    fun saveLanServerEnabled(enabled: Boolean) {
        prefs.edit().putBoolean(KEY_LAN_SERVER_ENABLED, enabled).apply()
    }

    private companion object {
        const val KEY_LANGUAGE = "language"
        const val KEY_THEME = "theme"
        const val KEY_LAYOUT = "defaultLayout"
        const val KEY_SORT_BY = "defaultSortBy"
        const val KEY_SORT_ASC = "defaultSortAscending"
        const val KEY_GROUP_BY = "defaultGroupBy"
        const val KEY_TOPIC_SORT_BY_NAME = "topicSortByName"
        const val KEY_TOPIC_SORT_ASC = "topicSortAscending"
        const val KEY_LAN_DEVICE_ID = "lanDeviceId"
        const val KEY_LAN_DEVICE_NAME = "lanDeviceName"
        const val KEY_LAN_HOST = "lanHost"
        const val KEY_LAN_PORT = "lanPort"
        const val KEY_LAN_TOKEN = "lanToken"
        const val KEY_LAN_SERVER_NAME = "lanServerName"
        const val KEY_LAN_SAVED_SERVERS = "lanSavedServers"
        const val KEY_LAN_SERVER_ENABLED = "lanServerEnabled"
        /** 最近服务器上限（React savedServers 同值）。 */
        const val SAVED_SERVERS_LIMIT = 10
        val VALID_THEMES = setOf(AppSettings.THEME_LIGHT, AppSettings.THEME_DARK, AppSettings.THEME_SYSTEM)
    }
}

/** 最近一次成功连接的持久化快照（[SettingsStore.loadLanConnection]）。 */
data class LanConnectionRecord(
    val host: String,
    val port: Int,
    /** 持久化 token；被清理（401/心跳断链）后为 null。 */
    val token: String?,
    val serverName: String?,
)

/** 「最近服务器」一条（React `SavedServer` 同构：host/port/name/accessCode/lastConnected）。 */
data class LanSavedServer(
    val host: String,
    val port: Int,
    val name: String?,
    /** 上次成功连接使用的访问码（一键重连用；桌面端重新生成后重连失败回退手输）。 */
    val accessCode: String?,
    val lastConnected: Long,
)
