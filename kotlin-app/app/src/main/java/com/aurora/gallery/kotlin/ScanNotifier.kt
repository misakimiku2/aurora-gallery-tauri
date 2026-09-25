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

    // —— M6b 阶段 2（D17 尾款）：AI 任务通知，同一 Channel 加取消 action（:15 注释的
    //    扩展位）。取消回传走广播 [ACTION_AI_CANCEL]（MainActivity 常驻注册，转发
    //    GalleryViewModel.cancelAiTask → core 取消注册表，下一张迭代首查生效）。

    /** AI 批量任务进行中（确定进度 + 取消按钮；kind 显示名如「AI 分析」）。 */
    fun aiProgress(kind: String, current: Int, total: Int) {
        notify(ID_AI_PROGRESS) { builder ->
            val cancel = PendingIntent.getBroadcast(
                context,
                1,
                Intent(ACTION_AI_CANCEL).setPackage(context.packageName),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
            builder
                .setSmallIcon(android.R.drawable.stat_notify_sync)
                .setContentTitle("${kind}中… $current/$total")
                .setOngoing(true)
                .setProgress(total, current, false)
                .addAction(0, "取消", cancel)
        }
    }

    /** AI 任务终态（完成/取消/失败各态文案由调用方给）；收走进度通知。 */
    fun aiDone(message: String) {
        nm.cancel(ID_AI_PROGRESS)
        notify(ID_AI_DONE) { builder ->
            builder
                .setSmallIcon(android.R.drawable.stat_notify_sync_noanim)
                .setContentTitle("AI 任务")
                .setContentText(message)
                .setAutoCancel(true)
        }
    }

    fun aiClear() {
        nm.cancel(ID_AI_PROGRESS)
    }

    // —— M6b 阶段 3：主色调批量提取任务通知（D17 尾款「主色调任务按钮回传」的兑现）。
    //    回传走同一广播机制：[ACTION_COLOR_TASK] + cmd extra（pause|resume|stop），
    //    MainActivity 常驻注册后转发 GalleryViewModel（core 取消/暂停注册表，迭代边界生效）。
    //    进行中按 paused 态给不同按钮组（运行=暂停+停止，暂停=恢复+停止）。

    /** 主色调批量提取进行中（确定进度 + 暂停|恢复/停止按钮）。 */
    fun colorProgress(current: Int, total: Int, paused: Boolean) {
        notify(ID_COLOR_PROGRESS) { builder ->
            builder
                .setSmallIcon(android.R.drawable.stat_notify_sync)
                .setContentTitle("提取主色调中… $current/$total")
                .setOngoing(true)
                .setProgress(total, current, false)
                .addAction(0, if (paused) "恢复" else "暂停", taskAction(if (paused) "resume" else "pause", 2))
                .addAction(0, "停止", taskAction("stop", 3))
        }
    }

    /** 主色调任务终态（完成/取消/失败文案由调用方给）；收走进度通知。 */
    fun colorDone(message: String) {
        nm.cancel(ID_COLOR_PROGRESS)
        notify(ID_COLOR_DONE) { builder ->
            builder
                .setSmallIcon(android.R.drawable.stat_notify_sync_noanim)
                .setContentTitle("主色调提取")
                .setContentText(message)
                .setAutoCancel(true)
        }
    }

    fun colorClear() {
        nm.cancel(ID_COLOR_PROGRESS)
    }

    /** 任务控制按钮的广播 PendingIntent（cmd ∈ pause|resume|stop，requestCode 区分实例）。 */
    private fun taskAction(cmd: String, requestCode: Int): PendingIntent =
        PendingIntent.getBroadcast(
            context,
            requestCode,
            Intent(ACTION_COLOR_TASK).setPackage(context.packageName).putExtra(EXTRA_CMD, cmd),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )

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
        private const val ID_AI_PROGRESS = 1003
        private const val ID_AI_DONE = 1004
        private const val ID_COLOR_PROGRESS = 1005
        private const val ID_COLOR_DONE = 1006

        /** 通知「取消」action 的广播 action（常驻 receiver 注册，见 MainActivity）。 */
        const val ACTION_AI_CANCEL = "com.aurora.gallery.kotlin.ACTION_AI_CANCEL"

        /** 主色调任务控制按钮的广播 action 与 cmd extra（常驻 receiver 注册，见 MainActivity）。 */
        const val ACTION_COLOR_TASK = "com.aurora.gallery.kotlin.ACTION_COLOR_TASK"
        const val EXTRA_CMD = "cmd"
    }
}
