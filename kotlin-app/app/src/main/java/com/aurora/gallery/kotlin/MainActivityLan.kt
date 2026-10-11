package com.aurora.gallery.kotlin

import android.net.Uri
import android.util.Log
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts

// LAN 上传簇（拆分清单第 30 刀，⑥ 第 5 刀）：M6a 阶段 4 平板 → 桌面方向的写路径——
// 上传入口门禁（allow_upload=false 友好拦截）+ 系统照片选择器多选后逐个 multipart
// （进度/完成 Toast，完成后 VM 刷新当前目录），2 个扩展函数落地（§5.1 手法，
// 接收者 MainActivity，全 internal）。
// uploadLauncher（PickMultipleVisualMedia 字段）与 pendingUploadTargetDir 留原类，
// 随本刀降 internal；LAN_UPLOAD_MAX_ITEMS 是文件尾部 top-level const，不动。

/**
 * 上传入口（LAN 目录网格 TopBar）。allow_upload=false（门禁位来自 browse/
 * all_image_folders 尾部，D32 拍板后默认 true——置灰态=桌面端手动收紧的真实状态）：
 * 入口已置灰，点击再提示需桌面端开启。
 */
internal fun MainActivity.launchLanUpload(targetDir: String) {
    if (!viewModel.lanAllowUpload.value) {
        Toast.makeText(
            this,
            "桌面端未开启「允许上传」，请先在桌面端共享设置中开启",
            Toast.LENGTH_LONG,
        ).show()
        return
    }
    pendingUploadTargetDir = targetDir
    uploadLauncher.launch(
        androidx.activity.result.PickVisualMediaRequest(
            ActivityResultContracts.PickVisualMedia.ImageOnly,
        ),
    )
}

/** 逐个上传：进度与完成都是 Toast（清单阶段 4 口径），完成后 VM 刷新当前目录列表。 */
internal fun MainActivity.startLanUpload(uris: List<Uri>, targetDir: String) {
    Toast.makeText(this, "开始上传 ${uris.size} 张…", Toast.LENGTH_SHORT).show()
    viewModel.uploadUrisToLan(
        uris,
        targetDir,
        onProgress = { idx, total, name, ok, err ->
            val msg = if (ok) "上传成功（$idx/$total）$name"
            else "上传失败（$idx/$total）$name${err?.let { "：$it" } ?: ""}"
            Log.i("AuroraKotlin", "[Lan] $msg")
            Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()
        },
        onDone = { ok, fail ->
            val msg = if (fail == 0) "上传完成（$ok 张）" else "上传完成：成功 $ok 张，失败 $fail 张"
            Toast.makeText(this, msg, Toast.LENGTH_LONG).show()
        },
    )
}

