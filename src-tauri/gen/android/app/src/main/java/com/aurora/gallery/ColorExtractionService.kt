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
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.util.Log
import androidx.core.app.NotificationCompat

class ColorExtractionService : Service() {

    companion object {
        private const val TAG = "ColorExtraction"
        const val CHANNEL_ID = "color_extraction"
        const val NOTIFICATION_ID = 1001
        const val ACTION_START = "com.aurora.gallery.START_EXTRACTION"
        const val ACTION_PAUSE = "com.aurora.gallery.PAUSE_EXTRACTION"
        const val ACTION_RESUME = "com.aurora.gallery.RESUME_EXTRACTION"
        const val ACTION_STOP = "com.aurora.gallery.STOP_EXTRACTION"
        const val EXTRA_TITLE = "title"
        const val EXTRA_CURRENT = "current"
        const val EXTRA_TOTAL = "total"
        const val EXTRA_IS_PAUSED = "is_paused"

        private val COLOR_RUNNING = Color.parseColor("#3B82F6")
        private val COLOR_PAUSED = Color.parseColor("#EAB308")
        private val mainHandler = Handler(Looper.getMainLooper())

        var isPaused = false
            private set
        var currentTitle = ""
            private set
        var currentProgress = 0
            private set
        var currentTotal = 0
            private set
        private var pendingNotifyRunnable: Runnable? = null
        private var wakeLock: PowerManager.WakeLock? = null

        fun createChannel(context: Context) {
            val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            if (manager.getNotificationChannel(CHANNEL_ID) == null) {
                val channel = NotificationChannel(
                    CHANNEL_ID,
                    "主色调提取",
                    NotificationManager.IMPORTANCE_LOW
                ).apply {
                    description = "主色调提取进度"
                    setShowBadge(false)
                }
                manager.createNotificationChannel(channel)
                Log.d(TAG, "Notification channel created")
            }
        }

        fun updateProgress(current: Int, total: Int, paused: Boolean) {
            Log.d(TAG, "updateProgress: current=$current total=$total paused=$paused")
            currentProgress = current
            currentTotal = total
            isPaused = paused
        }

        fun buildNotification(context: Context): Notification {
            Log.d(TAG, "buildNotification: isPaused=$isPaused title=$currentTitle progress=$currentProgress/$currentTotal")

            val contentIntent = context.packageManager.getLaunchIntentForPackage(context.packageName)?.let {
                PendingIntent.getActivity(context, 0, it, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
            }

            val pauseResumeIntent = Intent(context, ColorExtractionService::class.java).apply {
                action = if (isPaused) ACTION_RESUME else ACTION_PAUSE
            }
            val pauseResumePending = PendingIntent.getService(
                context,
                if (isPaused) 3 else 1,
                pauseResumeIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )

            val stopIntent = Intent(context, ColorExtractionService::class.java).apply {
                action = ACTION_STOP
            }
            val stopPending = PendingIntent.getService(
                context, 2, stopIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )

            val percent = if (currentTotal > 0) (currentProgress * 100 / currentTotal) else 0
            val statusText = if (isPaused) "已暂停" else "$percent%"
            val accentColor = if (isPaused) COLOR_PAUSED else COLOR_RUNNING

            val builder = NotificationCompat.Builder(context, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_color_palette)
                .setColor(accentColor)
                .setContentTitle(currentTitle)
                .setContentText(statusText)
                .setProgress(currentTotal, currentProgress, false)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setContentIntent(contentIntent)

            if (isPaused) {
                builder.addAction(
                    android.R.drawable.ic_media_play,
                    "恢复",
                    pauseResumePending
                )
            } else {
                builder.addAction(
                    android.R.drawable.ic_media_pause,
                    "暂停",
                    pauseResumePending
                )
            }

            builder.addAction(
                android.R.drawable.ic_menu_close_clear_cancel,
                "停止",
                stopPending
            )

            return builder.build()
        }

        fun acquireWakeLock(context: Context) {
            if (wakeLock == null) {
                val powerManager = context.getSystemService(Context.POWER_SERVICE) as PowerManager
                wakeLock = powerManager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "$TAG:WakeLock")
                wakeLock?.acquire()
                Log.d(TAG, "WakeLock acquired")
            }
        }

        fun releaseWakeLock() {
            wakeLock?.let {
                if (it.isHeld) {
                    it.release()
                    Log.d(TAG, "WakeLock released")
                }
                wakeLock = null
            }
        }

        fun notifyUpdate(context: Context) {
            val threadName = Thread.currentThread().name
            val isMainThread = Looper.myLooper() == Looper.getMainLooper()
            Log.d(TAG, "notifyUpdate called: thread=$threadName isMain=$isMainThread isPaused=$isPaused")

            if (isMainThread) {
                pendingNotifyRunnable?.let { mainHandler.removeCallbacks(it) }
                Log.d(TAG, "notifyUpdate: cancelled pending runnable")

                val runnable = Runnable {
                    pendingNotifyRunnable = null
                    try {
                        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
                        val notification = buildNotification(context)
                        manager.cancel(NOTIFICATION_ID)
                        manager.notify(NOTIFICATION_ID, notification)
                        Log.d(TAG, "notifyUpdate done: isPaused=$isPaused")
                    } catch (e: Exception) {
                        Log.e(TAG, "notifyUpdate failed: ${e.message}", e)
                    }
                }
                pendingNotifyRunnable = runnable
                mainHandler.postDelayed(runnable, 150)
            } else {
                mainHandler.post {
                    notifyUpdate(context)
                }
            }
        }
    }

    override fun onCreate() {
        super.onCreate()
        Log.d(TAG, "Service onCreate")
        createChannel(this)
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val action = intent?.action ?: "(null)"
        Log.d(TAG, "onStartCommand: action=$action flags=$flags startId=$startId")

        when (action) {
            ACTION_START -> {
                currentTitle = intent?.getStringExtra(EXTRA_TITLE) ?: "主色调提取"
                currentProgress = intent?.getIntExtra(EXTRA_CURRENT, 0) ?: 0
                currentTotal = intent?.getIntExtra(EXTRA_TOTAL, 0) ?: 0
                isPaused = false
                Log.d(TAG, "ACTION_START: title=$currentTitle total=$currentTotal")
                acquireWakeLock(applicationContext)
                startForegroundNotification()
            }
            ACTION_PAUSE -> {
                Log.d(TAG, "ACTION_PAUSE: setting isPaused=true")
                isPaused = true
                releaseWakeLock()
                nativePauseColorExtraction()
                notifyUpdate(this)
            }
            ACTION_RESUME -> {
                Log.d(TAG, "ACTION_RESUME: setting isPaused=false")
                isPaused = false
                acquireWakeLock(applicationContext)
                nativeResumeColorExtraction()
                notifyUpdate(this)
            }
            ACTION_STOP -> {
                Log.d(TAG, "ACTION_STOP")
                releaseWakeLock()
                nativeCancelColorExtraction()
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    stopForeground(STOP_FOREGROUND_REMOVE)
                } else {
                    @Suppress("DEPRECATION")
                    stopForeground(true)
                }
                stopSelf()
            }
            else -> {
                Log.d(TAG, "Unknown action, starting foreground with current state")
                startForegroundNotification()
            }
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        releaseWakeLock()
        super.onDestroy()
        Log.d(TAG, "Service onDestroy")
    }

    private fun startForegroundNotification() {
        Log.d(TAG, "startForegroundNotification: isPaused=$isPaused title=$currentTitle")
        val notification = buildNotification(this)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private external fun nativePauseColorExtraction()
    private external fun nativeResumeColorExtraction()
    private external fun nativeCancelColorExtraction()
}
