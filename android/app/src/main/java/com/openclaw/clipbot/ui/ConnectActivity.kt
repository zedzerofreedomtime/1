package com.openclaw.clipbot.ui

import android.content.Intent
import android.os.Bundle
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import com.openclaw.clipbot.net.ApiClient
import com.openclaw.clipbot.net.Session
import com.openclaw.clipbot.remote.RemoteControlService
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Fleet enrolment: enter the backend URL + app token → discover → start the
 * RemoteControlService. UI is built in code to stay self-contained.
 * Opened via long-press on the Settings button (see MainActivity).
 */
class ConnectActivity : AppCompatActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val session = Session(this)
        val pad = (resources.displayMetrics.density * 20).toInt()

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad, pad, pad)
        }
        val title = TextView(this).apply {
            text = "เชื่อมต่อเซิร์ฟเวอร์ (Fleet)"
            textSize = 20f
        }
        val urlField = EditText(this).apply {
            hint = "Backend URL เช่น http://192.168.1.10:8000"
            setText(session.serverUrl ?: "")
        }
        val tokenField = EditText(this).apply { hint = "App Token (app_…)" }
        val btn = Button(this).apply { text = "เชื่อมต่อ" }
        val status = TextView(this)

        listOf(title, urlField, tokenField, btn, status).forEach {
            root.addView(
                it,
                LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                ),
            )
        }
        setContentView(root)

        if (session.isLoggedIn()) {
            status.text = "เชื่อมต่อแล้ว: ${session.serverUrl} (device_id=${session.deviceId})"
        }

        btn.setOnClickListener {
            val url = urlField.text.toString().trim()
            val token = tokenField.text.toString().trim()
            if (url.isEmpty() || token.isEmpty()) {
                Toast.makeText(this, "กรอก URL และ token ให้ครบ", Toast.LENGTH_SHORT).show()
                return@setOnClickListener
            }
            btn.isEnabled = false
            status.text = "กำลังเชื่อมต่อ…"
            lifecycleScope.launch {
                val result = withContext(Dispatchers.IO) {
                    runCatching { ApiClient(session).discover(url, token) }
                }
                btn.isEnabled = true
                result.onSuccess {
                    status.text = "สำเร็จ! device_id=${session.deviceId} — เริ่มรับคำสั่งจากเซิร์ฟเวอร์"
                    ContextCompat.startForegroundService(
                        this@ConnectActivity,
                        Intent(this@ConnectActivity, RemoteControlService::class.java)
                            .setAction(RemoteControlService.ACTION_START),
                    )
                }.onFailure { e ->
                    status.text = "ล้มเหลว: ${e.message}"
                }
            }
        }
    }
}
