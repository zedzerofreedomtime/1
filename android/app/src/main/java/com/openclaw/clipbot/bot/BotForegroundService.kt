package com.openclaw.clipbot.bot

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.lifecycle.LifecycleService
import com.openclaw.clipbot.R
import com.openclaw.clipbot.auto.AutoController
import com.openclaw.clipbot.core.BotListener
import com.openclaw.clipbot.core.BotState
import com.openclaw.clipbot.core.LogLevel
import com.openclaw.clipbot.ui.MainActivity

/**
 * Hosts a [BotEngine] run as an Android foreground service so the OS keeps the
 * process alive (and the notification visible) while clips are being produced.
 *
 * The UI talks to this service purely through the [ACTION_START] / [ACTION_STOP] /
 * [ACTION_PAUSE] / [ACTION_RESUME] / [ACTION_TOGGLE_FLOAT] intent actions.
 */
class BotForegroundService : LifecycleService() {

    /** Refreshes the notification as the engine progresses; tears down on terminal state. */
    private val engineListener = object : BotListener {
        override fun onState(state: BotState) {
            when (state) {
                BotState.RUNNING, BotState.PAUSED -> refreshNotification()
                BotState.FINISHED, BotState.FAILED, BotState.IDLE -> finishForeground()
            }
        }

        override fun onProgress(produced: Int, target: Int, stage: String) {
            refreshNotification()
        }

        override fun onLog(level: LogLevel, message: String) { /* no-op in notification */ }
    }

    override fun onCreate() {
        super.onCreate()
        createChannel()
    }

    override fun onDestroy() {
        // Safety net: never leave a dangling listener if the service dies unexpectedly.
        BotEngine.removeListener(engineListener)
        super.onDestroy()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        super.onStartCommand(intent, flags, startId)

        when (intent?.action) {
            ACTION_START -> handleStart()
            ACTION_STOP -> handleStop()
            ACTION_PAUSE -> {
                BotEngine.pause()
                refreshNotification()
            }
            ACTION_RESUME -> {
                BotEngine.resume()
                refreshNotification()
            }
            ACTION_TOGGLE_FLOAT -> {
                if (AutoController.isFloatingShown()) AutoController.hideFloating()
                else AutoController.showFloating()
            }
            else -> { /* ignore unknown actions */ }
        }
        return START_NOT_STICKY
    }

    private fun handleStart() {
        // Subscribe for the service's whole lifetime; the UI subscribes separately, so
        // backgrounding the app can never steal our completion callback.
        BotEngine.addListener(engineListener)
        startForegroundCompat(buildNotification())
        BotEngine.start(applicationContext)
    }

    private fun handleStop() {
        BotEngine.stop()
        finishForeground()
    }

    private fun finishForeground() {
        BotEngine.removeListener(engineListener)
        stopForegroundCompat()
        stopSelf()
    }

    // ---- Notification ----

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val mgr = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (mgr.getNotificationChannel(CHANNEL_ID) != null) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            getString(R.string.chan_bot_name),
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = getString(R.string.chan_bot_desc)
            setShowBadge(false)
        }
        mgr.createNotificationChannel(channel)
    }

    private fun buildNotification(): Notification {
        val contentText = "${BotEngine.produced}/${BotEngine.target} · ${BotEngine.stage.ifBlank { "…" }}"

        val openIntent = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP),
            pendingFlags(),
        )

        val builder = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_bot)
            .setContentTitle(getString(R.string.notif_bot_title))
            .setContentText(contentText)
            .setContentIntent(openIntent)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_PROGRESS)

        // Stop action.
        builder.addAction(
            R.drawable.ic_bot,
            getString(R.string.notif_action_stop),
            servicePendingIntent(ACTION_STOP, 1),
        )

        // Pause / Resume action, reflecting current state.
        if (BotEngine.state == BotState.PAUSED) {
            builder.addAction(
                R.drawable.ic_bot,
                "ทำต่อ",
                servicePendingIntent(ACTION_RESUME, 2),
            )
        } else {
            builder.addAction(
                R.drawable.ic_bot,
                "พัก",
                servicePendingIntent(ACTION_PAUSE, 3),
            )
        }

        return builder.build()
    }

    private fun refreshNotification() {
        val notif = buildNotification()
        runCatching {
            NotificationManagerCompat.from(this).notify(NOTIF_ID, notif)
        }
    }

    private fun servicePendingIntent(action: String, requestCode: Int): PendingIntent {
        val intent = Intent(this, BotForegroundService::class.java).setAction(action)
        return PendingIntent.getService(this, requestCode, intent, pendingFlags())
    }

    private fun pendingFlags(): Int {
        var flags = PendingIntent.FLAG_UPDATE_CURRENT
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags = flags or PendingIntent.FLAG_IMMUTABLE
        }
        return flags
    }

    // ---- Foreground start/stop with SDK-version branching ----

    private fun startForegroundCompat(notification: Notification) {
        when {
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE -> // API 34+
                startForeground(
                    NOTIF_ID,
                    notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE,
                )
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q -> // API 29+
                startForeground(
                    NOTIF_ID,
                    notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
                )
            else ->
                startForeground(NOTIF_ID, notification)
        }
    }

    @Suppress("DEPRECATION")
    private fun stopForegroundCompat() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(STOP_FOREGROUND_REMOVE)
        } else {
            stopForeground(true)
        }
    }

    companion object {
        const val ACTION_START = "com.openclaw.clipbot.START_BOT"
        const val ACTION_STOP = "com.openclaw.clipbot.STOP_BOT"
        const val ACTION_PAUSE = "com.openclaw.clipbot.PAUSE_BOT"
        const val ACTION_RESUME = "com.openclaw.clipbot.RESUME_BOT"
        const val ACTION_TOGGLE_FLOAT = "com.openclaw.clipbot.TOGGLE_FLOAT"

        const val NOTIF_ID = 1001
        const val CHANNEL_ID = "bot_channel"
    }
}
