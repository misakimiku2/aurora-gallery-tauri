package com.aurora.gallery.kotlin

/**
 * 手机端**能播的视频容器**——单一真源（2026-10-22）。
 *
 * 为什么要一份共享表：这里同时决定三件事，三处判据必须逐字一致，否则会出现
 * 「列表里有、点开报不能播」或「能播却被藏起来」的自相矛盾——
 *  1. 扫描入库：不在表里的容器**根本不进列表**（指挥官要求 AVI/WMV 直接不显示）；
 *  2. LAN 浏览：服务端照样会下发 AVI/WMV 项，客户端在 [com.aurora.gallery.kotlin.LanClient]
 *     解析时按同一张表滤掉；
 *  3. 起播闸门：[com.aurora.gallery.kotlin.viewer.VideoLayerView.start] 再判一次（兜底，
 *     也覆盖 content:// 这种只能靠显示文件名判的本地项）。
 *
 * ⚠ 这张表是**容器**口径，不是编码口径。表内放行只代表 ExoPlayer 能解封装；里面装
 * VC-1 / MPEG-4 Part 2 这类手机没解码器的编码，照样会在播放时失败——编码能力按机型
 * 而变（MediaCodec），客户端判不了，只能让播放器自己撞。
 *
 * − AVI / WMV(ASF)：解封装器本身就没有，装什么都不行 → 不入表。
 * − FLV：media3 能解但容器无索引、**不能拖动**，属残缺体验 → 同样不入表（一律不显示）。
 */
internal object VideoContainers {

    /** 放行的容器扩展名（小写）。 */
    val PLAYABLE: Set<String> = setOf(
        "mp4", "m4v", "mov",
        "3gp", "3g2",
        "webm", "mkv",
        "ts", "m2ts",
        "mpg", "mpeg",
    )

    /**
     * 取扩展名（小写、只留字母数字）。入参可以是文件名、相对路径或带 query 的 URL：
     * LAN 项的扩展名常常藏在 `?path=xxx.avi` 里，所以先剥 query/fragment。
     * 没有扩展名返回空串。
     */
    fun extOf(nameOrPath: String): String {
        val clean = nameOrPath.substringBefore('?').substringBefore('#')
        val dot = clean.lastIndexOf('.')
        if (dot < 0 || dot == clean.length - 1) return ""
        return clean.substring(dot + 1).lowercase().filter { it.isLetterOrDigit() }
    }

    /**
     * 这份文件是否在放行表里。**取不到扩展名按「可播」处理**——判不了就不误伤
     * （本地 content:// 项没有文件名、畸形数据也常见）。
     */
    fun isPlayableName(nameOrPath: String): Boolean {
        val ext = extOf(nameOrPath)
        return ext.isEmpty() || ext in PLAYABLE
    }
}
