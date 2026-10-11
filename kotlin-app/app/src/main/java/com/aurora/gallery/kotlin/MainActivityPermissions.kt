package com.aurora.gallery.kotlin

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import android.widget.Toast

// 权限/欢迎向导助手簇（拆分清单第 29 刀，⑥ 第 4 刀）：媒体读权限口径（mediaPermission，
// 与 GalleryViewModel.hasMediaPermission 同式）+ 通知权限补请求 + requestMediaPermissionIfNeeded
// 授权链（READ → WRITE 补请求 → 通知）+ 欢迎向导「去系统设置」兜底，5 个扩展函数落地
// （§5.1 手法，接收者 MainActivity，全 internal——setContent 欢迎流程与 requestPermission
// 回调等留守区消费）。
// requestPermission / notificationPermission 两个 registerForActivityResult 字段留原类，
// 随本刀降 internal。

internal fun MainActivity.requestNotificationPermissionIfNeeded() {
    if (Build.VERSION.SDK_INT >= 33 &&
        checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
    ) {
        notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
    }
}

/** 媒体库读权限字符串：设备 API 33+ **且** targetSdk ≥ 33 才用 READ_MEDIA_IMAGES
 *  （该权限只对 targetSdk ≥ 33 的应用生效；targetSdk < 33 时走 READ_EXTERNAL_STORAGE
 *  的媒体映射，声明掐了会拿残缺索引）。须与 GalleryViewModel.hasMediaPermission 一致。 */
internal fun MainActivity.mediaPermission(): String =
    if (Build.VERSION.SDK_INT >= 33 &&
        applicationInfo.targetSdkVersion >= 33
    ) {
        Manifest.permission.READ_MEDIA_IMAGES
    } else {
        Manifest.permission.READ_EXTERNAL_STORAGE
    }

internal fun MainActivity.hasMediaPermission(): Boolean =
    checkSelfPermission(mediaPermission()) == PackageManager.PERMISSION_GRANTED

internal fun MainActivity.requestMediaPermissionIfNeeded() {
    if (hasMediaPermission()) {
        viewModel.startScanIfNeeded()
        requestWritePermissionIfNeeded()
        requestNotificationPermissionIfNeeded()
    } else {
        // READ 授权回调里会再进 WRITE 补请求，见 requestPermission 的 granted 分支
        requestPermission.launch(mediaPermission())
    }
}

/** 欢迎向导权限拒绝兜底：跳系统应用详情页；授权后 onResume 推进（launcher 不回调）。 */
internal fun MainActivity.openAppDetailsSettings() {
    try {
        startActivity(
            android.content.Intent(
                android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                android.net.Uri.fromParts("package", packageName, null),
            ),
        )
    } catch (e: Exception) {
        Log.w("AuroraKotlin", "[Welcome] open app settings failed", e)
        Toast.makeText(this, "无法打开系统设置", Toast.LENGTH_SHORT).show()
    }
}
