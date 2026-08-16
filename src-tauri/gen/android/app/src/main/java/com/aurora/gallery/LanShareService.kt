package com.aurora.gallery

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Color
import android.net.wifi.WifiManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import androidx.core.app.NotificationCompat

/**
 * 局域网共享前台服务：为 Rust 侧 HTTP 服务端提供进程保活。
 *
 * - startForeground 持久通知，避免息屏后进程被系统回收
 * - PARTIAL_WAKE_LOCK 保持 CPU 运行
 * - WifiLock 防止息屏后 Wi-Fi 进入低功耗模式
 * - START_STICKY：被系统杀死后自动重建
 * - 通知提供"停止共享"快捷操作（回调 Rust nativeStopLanShare 停止服务端）
 */
class LanShareService : Service() {

    companion object {
        private const val TAG = "LanShareService"
        const val CHANNEL_ID = "lan_share"
        const val NOTIFICATION_ID = 2001
        const val ACTION_START = "com.aurora.gallery.START_LAN_SHARE"
        const val ACTION_STOP = "com.aurora.gallery.STOP_LAN_SHARE"
        const val EXTRA_PORT = "port"
        const val EXTRA_IP = "ip"

        private var wakeLock: PowerManager.WakeLock? = null
        private var wifiLock: WifiManager.WifiLock? = null

        fun createChannel(context: Context) {
            val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            if (manager.getNotificationChannel(CHANNEL_ID) == null) {
                val channel = NotificationChannel(
                    CHANNEL_ID,
                    "局域网共享",
                    NotificationManager.IMPORTANCE_LOW
                ).apply {
                    description = "局域网共享服务运行状态"
                    setShowBadge(false)
                }
                manager.createNotificationChannel(channel)
                Log.d(TAG, "Notification channel created")
            }
        }

        private fun buildNotification(context: Context, ip: String, port: Int): Notification {
            val contentIntent = context.packageManager.getLaunchIntentForPackage(context.packageName)?.let {
                PendingIntent.getActivity(context, 0, it, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
            }

            val stopIntent = Intent(context, LanShareService::class.java).apply {
                action = ACTION_STOP
            }
            val stopPending = PendingIntent.getService(
                context, 1, stopIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )

            val address = if (ip.isNotEmpty()) "http://$ip:$port" else "端口 $port"

            val builder = NotificationCompat.Builder(context, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_color_palette)
                .setColor(Color.parseColor("#3B82F6"))
                .setContentTitle("局域网共享中")
                .setContentText("桌面端可访问：$address")
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setContentIntent(contentIntent)
                .addAction(
                    android.R.drawable.ic_menu_close_clear_cancel,
                    "停止共享",
                    stopPending
                )

            return builder.build()
        }

        private fun acquireWakeLock(context: Context) {
            if (wakeLock == null) {
                val powerManager = context.getSystemService(Context.POWER_SERVICE) as PowerManager
                wakeLock = powerManager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "$TAG:WakeLock")
                wakeLock?.acquire()
                Log.d(TAG, "WakeLock acquired")
            }
        }

        private fun releaseWakeLock() {
            wakeLock?.let {
                if (it.isHeld) {
                    it.release()
                    Log.d(TAG, "WakeLock released")
                }
                wakeLock = null
            }
        }

        @Suppress("DEPRECATION")
        private fun acquireWifiLock(context: Context) {
            if (wifiLock == null) {
                try {
                    val wifiManager = context.applicationContext
                        .getSystemService(Context.WIFI_SERVICE) as WifiManager
                    wifiLock = wifiManager.createWifiLock(
                        WifiManager.WIFI_MODE_FULL_HIGH_PERF, "$TAG:WifiLock"
                    )
                    wifiLock?.acquire()
                    Log.d(TAG, "WifiLock acquired")
                } catch (e: Exception) {
                    Log.w(TAG, "Failed to acquire WifiLock: ${e.message}")
                }
            }
        }

        private fun releaseWifiLock() {
            wifiLock?.let {
                if (it.isHeld) {
                    it.release()
                    Log.d(TAG, "WifiLock released")
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
        Log.d(TAG, "onStartCommand: action=$action flags=$flags startId=$startId")

        when (action) {
            ACTION_STOP -> {
                Log.d(TAG, "ACTION_STOP from notification")
                releaseWakeLock()
                releaseWifiLock()
                nativeStopLanShare()
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
                val port = intent?.getIntExtra(EXTRA_PORT, 8080) ?: 8080
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
        Log.d(TAG, "Service onDestroy")
    }

    private external fun nativeStopLanShare()
}
