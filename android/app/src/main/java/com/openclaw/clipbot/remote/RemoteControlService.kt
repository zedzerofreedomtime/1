package com.openclaw.clipbot.remote

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.lifecycle.LifecycleService
import androidx.lifecycle.lifecycleScope
import com.openclaw.clipbot.R
import com.openclaw.clipbot.net.ApiClient
import com.openclaw.clipbot.net.Session
import com.openclaw.clipbot.ui.MainActivity
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import org.json.JSONObject

/**
 * Fleet mode: polls OUR backend for commands and reports status — the clean,
 * secure counterpart of the original's RemoteControlService (`r80`/`p80`).
 * Polls every 4s; heartbeats every 30s. All work runs on Dispatchers.IO.
 */
class RemoteControlService : LifecycleService() {

    private lateinit var session: Session
    private lateinit var api: ApiClient
    private var loop: Job? = null

    @Volatile
    private var runner: ServerJobRunner? = null

    override fun onCreate() {
        super.onCreate()
        session = Session(this)
        api = ApiClient(session)
        createChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        super.onStartCommand(intent, flags, startId)
        if (intent?.action == ACTION_STOP) {
            stopSelfClean()
            return START_NOT_STICKY
        }
        startPolling()
        return START_STICKY
    }

    private fun startPolling() {
        startForegroundCompat(buildNotification("พร้อมรับคำสั่งจากเซิร์ฟเวอร์"))
        if (loop?.isActive == true) return
        loop = lifecycleScope.launch(Dispatchers.IO) {
            var lastHeartbeat = 0L
            while (isActive) {
                try {
                    if (session.isLoggedIn()) {
                        val nowMs = System.currentTimeMillis()
                        if (nowMs - lastHeartbeat > 30_000) {
                            runCatching { api.heartbeat() }
                            lastHeartbeat = nowMs
                        }
                        pollOnce()
                    }
                } catch (t: Throwable) {
                    Log.w(TAG, "poll error: ${t.message}")
                }
                delay(4_000)
            }
        }
    }

    private suspend fun pollOnce() {
        val cmd = runCatching { api.getCommand() }.getOrNull() ?: return
        val id = cmd.optString("id")
        val action = cmd.optString("action")
        val params = cmd.optJSONObject("params") ?: JSONObject()
        Log.i(TAG, "command $id: $action")
        try {
            applyCommand(action, params)
            runCatching { api.ack(id, "applied", null) }
        } catch (t: Throwable) {
            runCatching { api.ack(id, "rejected", t.message) }
        }
    }

    private suspend fun applyCommand(action: String, params: JSONObject) {
        when (action) {
            "start" -> {
                if (runner != null) return // already running
                val r = ServerJobRunner(applicationContext, api)
                runner = r
                try {
                    r.run(params) { msg -> updateNotification(msg) }
                } finally {
                    runner = null
                    updateNotification("พร้อมรับคำสั่งจากเซิร์ฟเวอร์")
                }
            }
            "stop" -> runner?.stopped = true
            "pause" -> runner?.paused = true
            "resume" -> runner?.paused = false
            "set_config" -> { /* config is pulled fresh from /api/app/config at job start */ }
            else -> throw IllegalArgumentException("unknown action: $action")
        }
    }

    private fun stopSelfClean() {
        runner?.stopped = true
        loop?.cancel()
        stopForegroundCompat()
        stopSelf()
    }

    // ---- notification ----

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val mgr = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (mgr.getNotificationChannel(CHANNEL_ID) == null) {
            mgr.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, "เชื่อมต่อรีโมท", NotificationManager.IMPORTANCE_LOW)
            )
        }
    }

    private fun buildNotification(text: String): Notification {
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or
            (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) PendingIntent.FLAG_IMMUTABLE else 0)
        val pi = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), flags)
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_bot)
            .setContentTitle("Clip Bot — เชื่อมต่อรีโมท")
            .setContentText(text)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setContentIntent(pi)
            .build()
    }

    private fun updateNotification(text: String) {
        val mgr = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        runCatching { mgr.notify(NOTIF_ID, buildNotification(text)) }
    }

    private fun startForegroundCompat(n: Notification) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(NOTIF_ID, n)
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
        const val ACTION_START = "com.openclaw.clipbot.REMOTE_START"
        const val ACTION_STOP = "com.openclaw.clipbot.REMOTE_STOP"
        const val NOTIF_ID = 1002
        const val CHANNEL_ID = "remote_channel"
        private const val TAG = "RemoteControl"
    }
}
