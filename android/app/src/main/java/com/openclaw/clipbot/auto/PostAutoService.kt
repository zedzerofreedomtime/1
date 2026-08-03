package com.openclaw.clipbot.auto

import android.accessibilityservice.AccessibilityService
import android.util.Log
import android.view.accessibility.AccessibilityEvent
import com.openclaw.clipbot.core.BotConfig

/**
 * Phase-2 groundwork accessibility service.
 *
 * Right now it does almost nothing on purpose: it just tracks whether the service is
 * connected and, when the user has the floating button enabled, shows a small draggable
 * overlay control (see [AutoController]). The real UI-driving automation (bringing the
 * target app forward, filling the compose box, tapping "post") lands in Phase 2 and will
 * live here in [onAccessibilityEvent] plus helper methods.
 *
 * Everything is null-safe: the rest of the app must never assume the service is running.
 */
class PostAutoService : AccessibilityService() {

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
        connected = true
        Log.i(TAG, "Accessibility service connected")
        try {
            // Show the floating control only if the user opted in.
            if (BotConfig(this).floatingButton) {
                AutoController.showFloating()
            }
        } catch (t: Throwable) {
            // Never let overlay setup crash the service.
            Log.w(TAG, "showFloating on connect failed: ${t.message}")
        }
    }

    /** Phase-2: inspect window/content events to locate compose & upload nodes. */
    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        // Intentionally empty in Phase 1.
    }

    override fun onInterrupt() {
        // Intentionally empty in Phase 1.
    }

    override fun onUnbind(intent: android.content.Intent?): Boolean {
        try {
            AutoController.hideFloating()
        } catch (t: Throwable) {
            Log.w(TAG, "hideFloating on unbind failed: ${t.message}")
        }
        connected = false
        if (instance === this) instance = null
        Log.i(TAG, "Accessibility service unbound")
        return super.onUnbind(intent)
    }

    override fun onDestroy() {
        connected = false
        if (instance === this) instance = null
        super.onDestroy()
    }

    companion object {
        private const val TAG = "PostAutoService"

        /** Live service instance, or null when the a11y service is off. */
        @Volatile
        private var instance: PostAutoService? = null

        @Volatile
        private var connected: Boolean = false

        /** @return the running service, or null when disconnected. Always null-check the result. */
        fun get(): PostAutoService? = instance

        /** @return true only while the accessibility service is bound and connected. */
        fun isConnected(): Boolean = connected && instance != null
    }
}
