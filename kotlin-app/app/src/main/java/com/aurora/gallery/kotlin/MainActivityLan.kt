package com.aurora.gallery.kotlin

import android.net.Uri
import android.util.Log
import android.widget.Toast

// 跨域复制/移动执行簇（2026-10-11，取代原 LAN 上传簇——顶栏上传按钮随统一复制/移动
// 弹窗 CopyMovePickerDialog 移除，upload 端点转作「本地 → 网络」的传输原语）。
// 执行链矩阵（统一弹窗按源/目标域分派）：
//   本地→本地 MainActivityFileOps.performCopyMove*；LAN→LAN App 的 onCopyMoveLanFiles；
//   本地→LAN performLocalToLan（本文件，multipart 上传 + move 时删本机源）；
//   LAN→本地 performLanToLocal / performLanToLocalNewAlbum（本文件，下载落盘 +
//   move 时删远端源）。

/**
 * 本地 → 网络（统一弹窗选了网络目标）：fileIds 解析成本机 uri 后逐个 multipart 上传
 * （GalleryViewModel.uploadUrisToLan → POST /api/upload，目标 = 远端目录 opaque path，
 * 共享根 = ""）。type=move 时上传成功的原件走 requestDelete（系统删除链，含
 * createDeleteRequest 兜底）——「先传后删」窗口内删除失败只丢移动语义不丢数据，
 * 副本已安全落桌面端。门禁：allow_upload=false 友好拦截（原上传按钮同款文案）。
 *
 * 标签/描述等元数据不跨域迁移（本地 MediaStore 行与远端元数据是两套存储，与
 * 「保存到设备」同口径，登记差异）。
 */
internal fun MainActivity.performLocalToLan(fileIds: List<String>, targetDir: String, type: String) {
    if (!viewModel.lanAllowUpload.value) {
        Toast.makeText(this, "桌面端未开启「允许上传」，无法传输到网络目录", Toast.LENGTH_LONG).show()
        return
    }
    viewModel.resolveFileUris(fileIds) { uris ->
        if (uris.isEmpty()) {
            Toast.makeText(this, "没有可操作的文件", Toast.LENGTH_SHORT).show()
            return@resolveFileUris
        }
        Toast.makeText(this, "开始传输 ${uris.size} 张…", Toast.LENGTH_SHORT).show()
        viewModel.uploadUrisToLan(
            uris,
            targetDir,
            onProgress = { idx, total, name, ok, err ->
                val msg = if (ok) "传输成功（$idx/$total）$name"
                else "传输失败（$idx/$total）$name${err?.let { "：$it" } ?: ""}"
                Log.i("AuroraKotlin", "[Lan] $msg")
                Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()
            },
            onDone = { ok, fail, okUris ->
                val verb = if (type == "copy") "复制" else "移动"
                val msg = when {
                    fail == 0 -> "已$verb $ok 张"
                    ok == 0 -> "${verb}失败"
                    else -> "已$verb $ok 张，失败 $fail 张"
                }
                Toast.makeText(this, msg, if (ok == 0) Toast.LENGTH_LONG else Toast.LENGTH_SHORT).show()
                if (ok == 0) return@uploadUrisToLan
                if (type == "move" && okUris.isNotEmpty()) {
                    // move：上传成功的原件删除（系统删除链；传输失败项留在本机）。
                    // 删除完成回调自带 exitSelectionMode，这里不重复退
                    requestDelete(okUris)
                } else {
                    // copy 的副本不影响原选中集，对齐本地 performCopyMove 的完成口径
                    viewModel.appState.exitSelectionMode()
                }
            },
        )
    }
}

/**
 * 网络 → 本地（统一弹窗选了本机相册目标）：[folderId] 现场解析 RELATIVE_PATH 后逐个
 * 下载落盘（GalleryViewModel.saveLanImagesToFolder；imageUrl 全图字节 → MediaStore
 * Images insert，重名 MediaProvider 自动序号）。type=move 时落盘成功的远端源在 VM 内
 * 走 deleteLanFiles（先落后删，失败项留在远端可重试）。
 */
internal fun MainActivity.performLanToLocal(paths: List<String>, folderId: String, type: String) {
    viewModel.resolveFolderRelPath(folderId) { relPath ->
        if (relPath == null) {
            Toast.makeText(this, "无法解析目标相册路径", Toast.LENGTH_SHORT).show()
            return@resolveFolderRelPath
        }
        performLanToRelPath(paths, relPath, type)
    }
}

/** 网络 → 新建本机相册（1.3 懒创建：目标 = `Pictures/<名字>`，校验同本地新相册）。 */
internal fun MainActivity.performLanToLocalNewAlbum(paths: List<String>, albumName: String, type: String) {
    if (albumName.isEmpty() || albumName == "." || albumName == ".." ||
        albumName.contains('/') || albumName.contains('\\')
    ) {
        Toast.makeText(this, "相册名不能包含 / \\ 等路径字符", Toast.LENGTH_SHORT).show()
        return
    }
    performLanToRelPath(paths, "Pictures/$albumName", type)
}

/** 网络 → 本地的公共体：逐个下载落盘 + Toast 进度/汇总；有成功即退选择（先例口径）。 */
private fun MainActivity.performLanToRelPath(paths: List<String>, relPath: String, type: String) {
    if (android.os.Build.VERSION.SDK_INT < 29) {
        Toast.makeText(this, "此系统版本不支持按文件夹落盘，请用查看器「保存到设备」", Toast.LENGTH_LONG).show()
        return
    }
    Toast.makeText(this, "开始传输 ${paths.size} 张…", Toast.LENGTH_SHORT).show()
    viewModel.saveLanImagesToFolder(
        paths,
        relPath,
        type,
        onProgress = { idx, total, name, ok, err ->
            val msg = if (ok) "传输成功（$idx/$total）$name"
            else "传输失败（$idx/$total）$name${err?.let { "：$it" } ?: ""}"
            Log.i("AuroraKotlin", "[Lan] $msg")
            Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()
        },
        onDone = { ok, fail ->
            val verb = if (type == "copy") "复制" else "移动"
            val msg = when {
                fail == 0 -> "已$verb $ok 张"
                ok == 0 -> "${verb}失败"
                else -> "已$verb $ok 张，失败 $fail 张"
            }
            Toast.makeText(this, msg, if (ok == 0) Toast.LENGTH_LONG else Toast.LENGTH_SHORT).show()
            if (ok > 0) viewModel.appState.exitSelectionMode()
        },
    )
}
