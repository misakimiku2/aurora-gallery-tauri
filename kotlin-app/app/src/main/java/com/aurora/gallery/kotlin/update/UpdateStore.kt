package com.aurora.gallery.kotlin.update

import android.content.Context

/**
 * 更新相关的持久化（独立 preferences 文件 `aurora_update`，与 `SettingsStore` 的
 * `aurora_settings` 分开，避免互相污染迁移逻辑）。
 *
 * 只存三件事：忽略的版本、上次检查时间、最后一次成功的源（展示用）。
 */
class UpdateStore(context: Context) {

    private val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /** 用户点了「忽略此版本」的版本号；为空表示没有忽略。 */
    var ignoredVersion: String
        get() = prefs.getString(KEY_IGNORED, "").orEmpty()
        set(value) = prefs.edit().putString(KEY_IGNORED, value).apply()

    var lastCheckTime: Long
        get() = prefs.getLong(KEY_LAST_CHECK, 0L)
        set(value) = prefs.edit().putLong(KEY_LAST_CHECK, value).apply()

    /** 上次成功取到清单的源 id（github/gitee），仅用于在关于页显示来源。 */
    var lastSource: String
        get() = prefs.getString(KEY_SOURCE, "").orEmpty()
        set(value) = prefs.edit().putString(KEY_SOURCE, value).apply()

    /** 距上次检查是否已超过 [intervalMs]（默认 24 小时），控制启动自动检查的节流。 */
    fun isCheckDue(intervalMs: Long = AUTO_CHECK_INTERVAL): Boolean {
        val last = lastCheckTime
        return last <= 0L || System.currentTimeMillis() - last >= intervalMs
    }

    private companion object {
        const val PREFS = "aurora_update"
        const val KEY_IGNORED = "ignoredVersion"
        const val KEY_LAST_CHECK = "lastCheckTime"
        const val KEY_SOURCE = "source"
        const val AUTO_CHECK_INTERVAL = 24 * 60 * 60 * 1000L
    }
}
