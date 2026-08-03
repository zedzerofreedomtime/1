package com.openclaw.clipbot.ui

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.widget.Toast
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.openclaw.clipbot.R
import com.openclaw.clipbot.auto.AutoController
import com.openclaw.clipbot.bot.BotEngine
import com.openclaw.clipbot.bot.BotForegroundService
import com.openclaw.clipbot.core.BotConfig
import com.openclaw.clipbot.core.BotListener
import com.openclaw.clipbot.core.BotState
import com.openclaw.clipbot.core.LogLevel
import com.openclaw.clipbot.databinding.ActivityMainBinding
import com.openclaw.clipbot.model.MediaSource
import com.openclaw.clipbot.model.MediaType
import com.openclaw.clipbot.model.Product

/**
 * Home screen. Collects a product + media, then hands a prepared job to the
 * foreground service. Subscribes to [BotEngine] while visible to reflect progress.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding

    /** Media the user has picked for this run. */
    private val pickedMedia = mutableListOf<Uri>()

    // ---- Activity result launchers ----

    private val pickMediaLauncher: ActivityResultLauncher<PickVisualMediaRequest> =
        registerForActivityResult(
            ActivityResultContracts.PickMultipleVisualMedia(MAX_MEDIA)
        ) { uris ->
            onMediaPicked(uris)
        }

    private val notifPermLauncher: ActivityResultLauncher<String> =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { /* ignore result */ }

    // ---- Engine listener (callbacks arrive on the main thread) ----

    private val botListener = object : BotListener {
        override fun onState(state: BotState) = renderState(state)

        override fun onProgress(produced: Int, target: Int, stage: String) {
            binding.textProgress.text = "$produced/$target · $stage"
        }

        override fun onLog(level: LogLevel, message: String) {
            if (level == LogLevel.ERROR) {
                Toast.makeText(this@MainActivity, message, Toast.LENGTH_SHORT).show()
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        binding.btnPickMedia.setOnClickListener {
            pickMediaLauncher.launch(
                PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageAndVideo)
            )
        }
        binding.btnSettings.setOnClickListener {
            startActivity(Intent(this, SettingsActivity::class.java))
        }
        // Long-press Settings to enrol this device into fleet mode (backend URL + token).
        binding.btnSettings.setOnLongClickListener {
            startActivity(Intent(this, ConnectActivity::class.java))
            true
        }
        binding.btnStartStop.setOnClickListener {
            if (BotEngine.isBusy()) stopBot() else startBot()
        }

        maybeRequestNotifPermission()
        maybeAskBatteryOptimization()
    }

    override fun onResume() {
        super.onResume()
        BotEngine.addListener(botListener)
        // Reflect whatever state the engine is already in.
        renderState(BotEngine.state)
        binding.textProgress.text =
            if (BotEngine.target > 0) "${BotEngine.produced}/${BotEngine.target} · ${BotEngine.stage}" else ""
        updateMediaCount()
    }

    override fun onPause() {
        super.onPause()
        BotEngine.removeListener(botListener)
    }

    // ---- Media ----

    private fun onMediaPicked(uris: List<Uri>) {
        if (uris.isEmpty()) return
        pickedMedia.clear()
        for (uri in uris) {
            // Best effort: keep read access across process death.
            try {
                contentResolver.takePersistableUriPermission(
                    uri, Intent.FLAG_GRANT_READ_URI_PERMISSION
                )
            } catch (_: SecurityException) {
                // Photo-picker uris are already readable for this session even without persist.
            }
            pickedMedia.add(uri)
        }
        updateMediaCount()
    }

    private fun updateMediaCount() {
        binding.textMediaCount.text =
            if (pickedMedia.isEmpty()) getString(R.string.media_none)
            else getString(R.string.media_count, pickedMedia.size)
    }

    // ---- Start / stop ----

    private fun startBot() {
        if (pickedMedia.isEmpty()) {
            Toast.makeText(this, R.string.need_media, Toast.LENGTH_SHORT).show()
            return
        }

        val config = BotConfig(this)
        if (!config.hasAiKey()) {
            // Allowed to run — caption will simply be skipped.
            Toast.makeText(this, R.string.need_ai_key, Toast.LENGTH_LONG).show()
        }

        val titleText = binding.inputTitle.text?.toString()?.trim().orEmpty()
        val linkText = binding.inputLink.text?.toString()?.trim().orEmpty()

        val media = pickedMedia.map { uri ->
            val mime = contentResolver.getType(uri).orEmpty()
            val type = if (mime.startsWith("video")) MediaType.VIDEO else MediaType.IMAGE
            MediaSource(uri = uri, type = type)
        }

        val product = Product(
            id = System.currentTimeMillis(),
            title = titleText,
            link = linkText.ifEmpty { null },
            media = media,
        )

        val snapshot = config.snapshot()

        // Guide the user to enable the accessibility service if auto-post is on but not connected.
        if (snapshot.autoPost && !AutoController.isConnected()) {
            promptEnableAccessibility()
        }

        BotEngine.prepare(product, snapshot)
        ContextCompat.startForegroundService(
            this,
            Intent(this, BotForegroundService::class.java)
                .setAction(BotForegroundService.ACTION_START)
        )
    }

    private fun stopBot() {
        startService(
            Intent(this, BotForegroundService::class.java)
                .setAction(BotForegroundService.ACTION_STOP)
        )
    }

    // ---- Rendering ----

    private fun renderState(state: BotState) {
        binding.textStatus.setText(
            when (state) {
                BotState.IDLE -> R.string.status_idle
                BotState.RUNNING -> R.string.status_running
                BotState.PAUSED -> R.string.status_paused
                BotState.FINISHED -> R.string.status_finished
                BotState.FAILED -> R.string.status_failed
            }
        )
        binding.btnStartStop.setText(
            if (BotEngine.isBusy()) R.string.btn_stop else R.string.btn_start
        )
    }

    // ---- Permissions / dialogs ----

    private fun maybeRequestNotifPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            val granted = ContextCompat.checkSelfPermission(
                this, Manifest.permission.POST_NOTIFICATIONS
            ) == PackageManager.PERMISSION_GRANTED
            if (!granted) {
                notifPermLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
            }
        }
    }

    private fun maybeAskBatteryOptimization() {
        val prefs = getSharedPreferences(UI_PREFS, Context.MODE_PRIVATE)
        if (prefs.getBoolean(PREF_ASKED_BATTERY, false)) return

        val pm = getSystemService(Context.POWER_SERVICE) as? PowerManager
        val ignoring = pm?.isIgnoringBatteryOptimizations(packageName) ?: true
        if (ignoring) {
            prefs.edit().putBoolean(PREF_ASKED_BATTERY, true).apply()
            return
        }

        AlertDialog.Builder(this)
            .setTitle(R.string.perm_battery_title)
            .setMessage(R.string.perm_battery_msg)
            .setPositiveButton(R.string.perm_allow) { _, _ ->
                try {
                    startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
                } catch (_: Exception) {
                    startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName")))
                }
            }
            .setNegativeButton(android.R.string.cancel, null)
            .setOnDismissListener {
                prefs.edit().putBoolean(PREF_ASKED_BATTERY, true).apply()
            }
            .show()
    }

    private fun promptEnableAccessibility() {
        AlertDialog.Builder(this)
            .setTitle(R.string.set_auto_post)
            .setMessage(R.string.accessibility_desc)
            .setPositiveButton(android.R.string.ok) { _, _ ->
                try {
                    startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
                } catch (_: Exception) {
                    // Some devices lack the direct screen — ignore.
                }
            }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    companion object {
        private const val MAX_MEDIA = 10
        private const val UI_PREFS = "clipbot_ui"
        private const val PREF_ASKED_BATTERY = "asked_battery"
    }
}
