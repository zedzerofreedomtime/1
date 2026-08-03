package com.openclaw.clipbot.net

import android.content.Context
import android.content.SharedPreferences
import android.os.Build
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/**
 * Fleet session for the device: backend URL + device token + device id.
 *
 * Stored in EncryptedSharedPreferences (Android Keystore) — the original app
 * kept token/server_url/AI-keys in PLAINTEXT prefs, which was one of its worst
 * findings. We never store an AI key on the device at all (server-side proxy).
 */
class Session(context: Context) {

    private val app = context.applicationContext
    private val sp: SharedPreferences = try {
        val key = MasterKey.Builder(app).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build()
        EncryptedSharedPreferences.create(
            app,
            "clipbot_session",
            key,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    } catch (t: Throwable) {
        // Fallback so the app still runs if the Keystore is unavailable (rare).
        app.getSharedPreferences("clipbot_session", Context.MODE_PRIVATE)
    }

    var token: String?
        get() = sp.getString("token", null)
        set(v) { sp.edit().putString("token", v).apply() }

    var serverUrl: String?
        get() = sp.getString("server_url", null)
        set(v) { sp.edit().putString("server_url", v).apply() }

    var deviceId: Int
        get() = sp.getInt("device_id", 0)
        set(v) { sp.edit().putInt("device_id", v).apply() }

    var deviceLabel: String
        get() = sp.getString("device_label", null) ?: Build.MODEL
        set(v) { sp.edit().putString("device_label", v).apply() }

    fun isLoggedIn(): Boolean = token != null && serverUrl != null

    fun logout() {
        sp.edit().remove("token").remove("server_url").remove("device_id").apply()
    }
}
