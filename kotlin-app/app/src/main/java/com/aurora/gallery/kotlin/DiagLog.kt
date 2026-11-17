package com.aurora.gallery.kotlin

import android.os.Build
import android.os.Environment
import java.io.File

/**
 * 诊断落盘的统一出口（2026-11-17「进文件夹缩略图要好几秒」排查引入）。
 *
 * 华为 EMUI 会间歇性吞第三方 App 的 logcat（AuroraKotlin tag 连实时流都没有），
 * 排时序问题只有落盘一条路。此前唯一写入口是 [GalleryViewModel.debugLog]（扩展函数
 * 簇都要经 VM），现在缩略图管线（ThumbnailLoader）与网格适配器（FileGridAdapter）也
 * 要落锚点——它们的持有链里没有 VM，硬把 lambda 穿三层构造只为写日志得不偿失，
 * 抽成进程级单例，任何层直接落。
 *
 * 目的地与 [GalleryViewModel.debugLog] 完全一致：
 *  - filesDir/debug_fileop.log（排查完用 run-as 读）
 *  - /sdcard/aurora_diag_debug.log 镜像（API 29 legacy 存储下 run-as 读不了非
 *    debuggable 包，外部这份是唯一可靠取证面；排查完删）
 */
object DiagLog {

    @Volatile
    private var filesDir: File? = null

    /** 应用启动时注入（GalleryViewModel.init 里调一次；未注入前静默丢弃）。 */
    fun init(dir: File) {
        filesDir = dir
    }

    fun log(msg: String) {
        val dir = filesDir ?: return
        try {
            File(dir, "debug_fileop.log").appendText("$msg\n")
        } catch (_: Exception) {
        }
        try {
            if (Build.VERSION.SDK_INT == 29 && Environment.isExternalStorageLegacy()) {
                File(
                    Environment.getExternalStorageDirectory(),
                    "aurora_diag_debug.log",
                ).appendText("${System.currentTimeMillis()} $msg\n")
            }
        } catch (_: Exception) {
        }
    }
}
