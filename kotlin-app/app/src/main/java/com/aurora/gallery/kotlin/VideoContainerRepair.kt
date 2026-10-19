package com.aurora.gallery.kotlin

import android.media.MediaScannerConnection
import android.provider.MediaStore
import android.util.Log
import uniffi.aurora_core.MediaImage
import uniffi.aurora_core.repairVideoContainers
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * MP4 容器原位修复的安卓侧接入（2026-10-19，两种形态共用一次调用）。
 *
 * **一：撒谎 edit list。** 成因与桌面完全同源：插件从 X.com 下载的 mp4，
 * `elst.segment_duration` 是 **u32**，长片全片时长折算后溢出，播放器只认全片的一小段
 * （实测 69:34 的片子只肯放 9:52）。安卓走 MediaExtractor/ExoPlayer，**听** edit list，
 * 于是进度条拖过那个点就定格在一帧上。
 *
 * **二：碎片化的 `mdat` 链。** 同一批文件把媒体数据切成几千个顶层 `mdat`（实测 2783 个），
 * 沿着顶层 box 链走的解析器等于要把整只文件读一遍才肯起播。桌面台架实测
 * 5406 ms → 154 ms；**安卓侧的收益还没量过**，这里跟着一起修只是因为两端共用同一份
 * 判定与同一本台账，且改动同样是不搬数据、可按台账逐字节还原的 4 个字节。
 *
 * 判定与写入全在 `aurora_core`（`mp4_editlist` + `mp4_mdat` + `container_repair`），
 * 桌面和安卓共用同一份实现 —— 安卓没有 ffmpeg，绝不允许在这里再写一套解析或去调 ffmpeg。
 *
 * 三步，缺一不可：
 * 1. 原位改 4 字节（体积不变、画面数据不动、台账可还原）；
 * 2. **让 MediaStore 重扫**这些文件 —— 不重扫的话 `DURATION` 列仍是旧的 9:52，
 *    文件虽然能放到 69:34，进度条却只让你拖到 9:52，症状看着像没修好；
 * 3. 修不动的（没直写权限 / 只读 / 被占用）只报日志，**时长一律不动**（下面有解释）。
 */
internal fun GalleryViewModel.repairMp4Containers(imgs: List<MediaImage>): List<MediaImage> {
    // 只碰 MP4 族容器；其余交给既有转封装路径，不做字节级改写。
    // ⚠️ 必须「是视频 MIME」且「扩展名属于 MP4 族」两个条件同时成立——上一版这里写成
    // `mime && endsWith(mp4) || endsWith(m4v) || endsWith(mov)`，`&&` 优先级高于 `||`，
    // 等于让任何 .mov/.m4v 结尾的文件（包括图片）都漏进来被当视频修。
    val mp4Family = listOf(".mp4", ".m4v", ".mov")
    val videos = imgs.filter {
        it.mimeType.startsWith("video/") && mp4Family.any { ext -> it.path.endsWith(ext, true) }
    }
    if (videos.isEmpty()) return imgs

    val results = runCatching {
        repairVideoContainers(videos.map { it.path }, "android")
    }.getOrElse {
        // FFI 抛回来也不能打断扫描（本函数在 scanAndReconcile 的主路径上）
        Log.w(GalleryViewModel.TAG, "[ContainerRepair] FFI 调用失败，跳过本轮: ${it.message}")
        return imgs
    }

    val byPath = results.associateBy { it.path }
    val repaired = results.filter { it.status == "repaired" }
    val notFixed = results.filter {
        it.status == "failed" || it.status == "maskedNoLedger"
    }
    if (repaired.isNotEmpty() || notFixed.isNotEmpty()) {
        Log.i(
            GalleryViewModel.TAG,
            "[ContainerRepair] 扫描到待修容器（edit list / mdat 链）：修复 ${repaired.size}，未修成 ${notFixed.size}" +
                notFixed.firstOrNull()?.let { "（例：status=${it.status} err=${it.error}）" } ?: ""
        )
        debugLog("[ContainerRepair] repaired=${repaired.size} notFixed=${notFixed.size}")
    }

    // 已修好的文件（本轮修的 + 以前修过的）：容器里的采样表时长 == 播放器能给出的时长，
    // 一律以它为准。
    //
    // ⚠️ 曾经只处理 `repaired`，漏了 `alreadyRepaired`，真机上表现为：第一轮刷新修好了、
    // 时长对；之后每轮扫描 `scanMediaStore()` 又把 MediaStore 里**旧的截断值**（9:51）灌回来，
    // 而 alreadyRepaired 分支什么都不做 → 列表永久停在 9:51，点进去播放器却给 1:09:34。
    // 修好的事实不能只靠一次写入维持，必须每轮都用容器口径覆盖 MediaStore 的缓存值。
    val storeDuration = videos.associate { it.path to (it.durationMs ?: -1L) }
    val fixed = results.filter {
        (it.status == "repaired" || it.status == "alreadyRepaired") && it.tableMs > 0
    }
    fixed.forEach { r ->
        Log.i(
            GalleryViewModel.TAG,
            "[ContainerRepair] ${r.path.substringAfterLast('/')} status=${r.status} " +
                "容器=${r.tableMs}ms elst=${r.elstMs}ms MediaStore现值=${storeDuration[r.path]}ms " +
                "遮蔽处=${r.offsets}"
        )
    }
    // 只对「文件已修好、但 MediaStore 还报着旧值」的触发重扫；已经对上号的不重复扫，
    // 免得每次刷新都把媒体扫描器叫一遍。
    val stale = fixed.filter { (storeDuration[it.path] ?: -1L) != it.tableMs }
    val freshDuration: Map<String, Long> =
        if (stale.isEmpty()) emptyMap() else rescanAndReadDurations(stale.map { it.path })

    return imgs.map { img ->
        val r = byPath[img.path] ?: return@map img
        when {
            // 已修好：优先用重扫回来的新值，拿不到就用容器采样表口径。
            r.status == "repaired" || r.status == "alreadyRepaired" -> {
                val want = freshDuration[img.path] ?: r.tableMs.takeIf { t -> t > 0 }
                if (want != null && want != img.durationMs) img.copy(durationMs = want) else img
            }
            // 修不动（没权限/只读/被占用）：**不动时长**。
            // ⚠️ 这里原先写的是「夹到 elst 口径」，是错的：真机实测 MediaStore 本来报的
            // 就是全片时长（4174578ms），夹小反而把唯一正确的值覆盖成 9:51，
            // 表现成「文件明明能放 69 分钟，列表却写 9:51」。
            // 安卓的时长与可访问范围是两回事（MediaExtractor 取帧受 edit list 限制、
            // 时长却按 mdhd 报全片），所以时长没有"改小才对"这回事。
            // 失败只需要报出来 —— 授权引导由调用方在扫描结束后统一处理。
            else -> img
        }
    }
}

/**
 * 触发 MediaStore 重扫并读回新的 `DURATION`。
 *
 * 有界等待：EMUI 的 `MediaScannerConnection` 回调可能迟到甚至丢失（见
 * `scanFileSync` 里同样的教训），所以 8 秒拿不到就返回空表，由调用方退到
 * 采样表口径 —— 不能因为扫描器不回话就把整轮 `scanAndReconcile` 卡住。
 */
private fun GalleryViewModel.rescanAndReadDurations(paths: List<String>): Map<String, Long> {
    val latch = CountDownLatch(paths.size)
    runCatching {
        MediaScannerConnection.scanFile(appContext, paths.toTypedArray(), null) { _, _ ->
            latch.countDown()
        }
    }
    runCatching { latch.await(8, TimeUnit.SECONDS) }
    return paths.mapNotNull { p -> queryVideoDurationByPath(p)?.let { p to it } }.toMap()
}

private fun GalleryViewModel.queryVideoDurationByPath(path: String): Long? =
    runCatching {
        appContext.contentResolver.query(
            MediaStore.Video.Media.EXTERNAL_CONTENT_URI,
            arrayOf(MediaStore.Video.Media.DURATION),
            "${MediaStore.Video.Media.DATA}=?",
            arrayOf(path),
            null,
        )?.use { c -> if (c.moveToFirst() && !c.isNull(0)) c.getLong(0) else null }
    }.getOrNull()
