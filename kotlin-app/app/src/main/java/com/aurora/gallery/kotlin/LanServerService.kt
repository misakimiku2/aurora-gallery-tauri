package com.aurora.gallery.kotlin

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import androidx.core.app.NotificationCompat

/**
 * M6a 阶段 7：对等服务端前台服务（参考 src-tauri/gen/android 的 LanShareService.kt，
 * 逐块对齐但**去 JNI**——「停止共享」直接调 [LanServerManager.stop]，不走 native 回调）。
 *
 * - startForeground 持久通知（API 34+ 带 FOREGROUND_SERVICE_TYPE_DATA_SYNC），避免息屏后进程被回收
 * - PARTIAL_WAKE_LOCK 保持 CPU 运行；WifiLock（WIFI_MODE_FULL_HIGH_PERF）防息屏后 Wi-Fi 进低功耗
 * - START_STICKY：被系统杀死后自动重建
 * - 通知提供「停止共享」快捷操作（ACTION_STOP 自 Intent → manager.stop(persistOff = true)）
 *
 * 通知 Channel 自建 `aurora_lan`（不复用 ScanNotifier 的 aurora_scan——清单明令），通知 id 2101。
 * tag = "AuroraLanServer"。
 */
class LanServerService : Service() {

    companion object {
        private const val TAG = "AuroraLanServer"

        const val CHANNEL_ID = "aurora_lan"
        const val NOTIFICATION_ID = 2101
        const val ACTION_START = "com.aurora.gallery.kotlin.START_LAN_SERVER"
        const val ACTION_STOP = "com.aurora.gallery.kotlin.STOP_LAN_SERVER"
        const val EXTRA_PORT = "port"
        const val EXTRA_IP = "ip"

        private var wakeLock: PowerManager.WakeLock? = null
        private var wifiLock: WifiManager.WifiLock? = null

        /** 建 Channel（IMPORTANCE_LOW：常驻通知不响不弹）。onCreate 与调用方双保险。 */
        fun createChannel(context: Context) {
            val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            if (manager.getNotificationChannel(CHANNEL_ID) == null) {
                val channel = NotificationChannel(
                    CHANNEL_ID,
                    "局域网共享",
                    NotificationManager.IMPORTANCE_LOW,
                ).apply {
                    description = "对等服务端运行状态（桌面端可反向浏览本机媒体库）"
                    setShowBadge(false)
                }
                manager.createNotificationChannel(channel)
                Log.d(TAG, "[LanServer] 通知 Channel 已创建")
            }
        }

        private fun buildNotification(context: Context, ip: String, port: Int): Notification {
            // 点击通知进主 Activity
            val contentIntent = context.packageManager.getLaunchIntentForPackage(context.packageName)?.let {
                PendingIntent.getActivity(
                    context, 0, it,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
                )
            }
            // 「停止共享」自 Intent 回传（getService；FLAG_IMMUTABLE 为 API 31+ 强制）
            val stopIntent = Intent(context, LanServerService::class.java).apply {
                action = ACTION_STOP
            }
            val stopPending = PendingIntent.getService(
                context, 1, stopIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )

            val address = if (ip.isNotEmpty()) "http://$ip:$port" else "端口 $port"

            return NotificationCompat.Builder(context, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.ic_menu_share)
                .setContentTitle("局域网共享中")
                .setContentText("桌面端可访问：$address")
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setContentIntent(contentIntent)
                .addAction(android.R.drawable.ic_menu_close_clear_cancel, "停止共享", stopPending)
                .build()
        }

        private fun acquireWakeLock(context: Context) {
            if (wakeLock == null) {
                val powerManager = context.getSystemService(Context.POWER_SERVICE) as PowerManager
                wakeLock = powerManager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "$TAG:WakeLock")
                wakeLock?.acquire()
                Log.d(TAG, "[LanServer] WakeLock acquired")
            }
        }

        private fun releaseWakeLock() {
            wakeLock?.let {
                if (it.isHeld) {
                    it.release()
                    Log.d(TAG, "[LanServer] WakeLock released")
                }
                wakeLock = null
            }
        }

        @Suppress("DEPRECATION")
        private fun acquireWifiLock(context: Context) {
            if (wifiLock == null) {
                try {
                    val wifiManager =
                        context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
                    wifiLock = wifiManager.createWifiLock(
                        WifiManager.WIFI_MODE_FULL_HIGH_PERF, "$TAG:WifiLock",
                    )
                    wifiLock?.acquire()
                    Log.d(TAG, "[LanServer] WifiLock acquired")
                } catch (e: Exception) {
                    Log.w(TAG, "[LanServer] WifiLock 获取失败: ${e.message}")
                }
            }
        }

        private fun releaseWifiLock() {
            wifiLock?.let {
                if (it.isHeld) {
                    it.release()
                    Log.d(TAG, "[LanServer] WifiLock released")
                }
                wifiLock = null
            }
        }
    }

    override fun onCreate() {
        super.onCreate()
        createChannel(this)
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val action = intent?.action ?: ACTION_START
        Log.d(TAG, "[LanServer] onStartCommand action=$action flags=$flags startId=$startId")

        when (action) {
            ACTION_STOP -> {
                Log.i(TAG, "[LanServer] 通知栏「停止共享」→ 停服务端（持久化关）")
                LanServerManager.get()?.stop(persistOff = true)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    stopForeground(STOP_FOREGROUND_REMOVE)
                } else {
                    @Suppress("DEPRECATION")
                    stopForeground(true)
                }
                stopSelf()
                return START_NOT_STICKY
            }
            else -> {
                val port = intent?.getIntExtra(EXTRA_PORT, LanServerManager.DEFAULT_PORT)
                    ?: LanServerManager.DEFAULT_PORT
                val ip = intent?.getStringExtra(EXTRA_IP) ?: ""
                acquireWakeLock(applicationContext)
                acquireWifiLock(applicationContext)
                val notification = buildNotification(this, ip, port)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                    startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
                } else {
                    startForeground(NOTIFICATION_ID, notification)
                }
            }
        }
        // START_STICKY：进程被系统杀死后自动重建服务
        return START_STICKY
    }

    override fun onDestroy() {
        releaseWakeLock()
        releaseWifiLock()
        super.onDestroy()
        Log.d(TAG, "[LanServer] 前台服务 onDestroy")
    }
}
