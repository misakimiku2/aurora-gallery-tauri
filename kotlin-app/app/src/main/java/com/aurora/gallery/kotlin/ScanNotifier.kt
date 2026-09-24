package com.aurora.gallery.kotlin

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat

/**
 * 扫描任务通知（M4b 阶段 5，D17 拍板的基础版）：自建 Channel + 进度/完成通知，
 * 只服务 MediaStore 扫描+对账这一条长任务。M4a §8 预警过 `android_*_task_notification`
 * 是 JNI→Tauri 桥、独立应用拿不到，必须自建。无按钮回传（扫描没有暂停语义），
 * 按钮回传 + 主色调/AI 任务的完整版随 M6b（M6b 只需在同一个 Channel 上加 action）。
 *
 * 仅初始扫描与手动下拉刷新会上通知（[GalleryViewModel.scanAndReconcile] 的 notify
 * 参数门控）；热刷新的防抖重扫频繁且通常很快，发通知是骚扰。
 */
class ScanNotifier(private val context: Context) {

    private val nm = context.getSystemService(NotificationManager::class.java)

    fun ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            "媒体库扫描",
            NotificationManager.IMPORTANCE_LOW,
        ).apply { description = "扫描与对账本地媒体库的进度通知" }
        nm.createNotificationChannel(channel)
    }

    /** 扫描进行中（不确定进度，ongoing：下拉清除不掉，扫描结束由 [done]/[clear] 收走）。 */
    fun progress() {
        notify(ID_PROGRESS) { builder ->
            builder
                .setSmallIcon(android.R.drawable.stat_notify_sync)
                .setContentTitle("正在扫描媒体库…")
                .setOngoing(true)
                .setProgress(0, 0, true)
        }
    }

    /** 终态通知（自动消失于点击），并收走进度条。 */
    fun done(folders: Int, images: Int) {
        nm.cancel(ID_PROGRESS)
        notify(ID_DONE) { builder ->
            builder
                .setSmallIcon(android.R.drawable.stat_notify_sync_noanim)
                .setContentTitle("媒体库扫描完成")
                .setContentText("$folders 个相册 · $images 张图片")
                .setAutoCancel(true)
        }
    }

    fun clear() {
        nm.cancel(ID_PROGRESS)
    }

    private fun notify(id: Int, configure: (NotificationCompat.Builder) -> NotificationCompat.Builder) {
        ensureChannel()
        val pending = PendingIntent.getActivity(
            context,
            0,
            Intent(context, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val builder = NotificationCompat.Builder(context, CHANNEL_ID)
            .setContentIntent(pending)
        nm.notify(id, configure(builder).build())
    }

    companion object {
        private const val CHANNEL_ID = "aurora_scan"
        private const val ID_PROGRESS = 1001
        private const val ID_DONE = 1002
    }
}
