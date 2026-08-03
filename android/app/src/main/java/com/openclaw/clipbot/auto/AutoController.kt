package com.openclaw.clipbot.auto

import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.PixelFormat
import android.os.Build
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.widget.TextView
import com.openclaw.clipbot.bot.BotEngine
import com.openclaw.clipbot.bot.BotForegroundService
import kotlin.math.abs

/**
 * Owns the small draggable floating control shown while the accessibility service is on.
 *
 * The overlay uses [WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY], which an
 * accessibility service can draw WITHOUT the SYSTEM_ALERT_WINDOW ("draw over other apps")
 * permission — so as long as [PostAutoService] is connected we can put a button on screen.
 *
 * All WindowManager calls are wrapped in try/catch and guarded by a live service check so
 * nothing here can crash when the service is off.
 */
object AutoController {

    private const val TAG = "AutoController"

    private var floatingView: View? = null

    /** True while the floating control is currently attached to the window manager. */
    fun isFloatingShown(): Boolean = floatingView != null

    /** Convenience passthrough so UI can ask the controller directly. */
    fun isConnected(): Boolean = PostAutoService.isConnected()

    /** Attach the draggable floating button. No-op if already shown or the service is off. */
    fun showFloating() {
        if (floatingView != null) return
        val service = PostAutoService.get() ?: run {
            Log.w(TAG, "showFloating skipped: accessibility service not connected")
            return
        }
        try {
            val wm = service.getSystemService(Context.WINDOW_SERVICE) as? WindowManager ?: return
            val button = buildButton(service)
            val params = buildLayoutParams()
            attachDragHandler(button, wm, params)
            wm.addView(button, params)
            floatingView = button
            Log.i(TAG, "Floating control shown")
        } catch (t: Throwable) {
            Log.w(TAG, "showFloating failed: ${t.message}")
            floatingView = null
        }
    }

    /** Detach the floating button. Safe to call when nothing is shown. */
    fun hideFloating() {
        val view = floatingView ?: return
        floatingView = null
        try {
            val service = PostAutoService.get()
            val wm = service?.getSystemService(Context.WINDOW_SERVICE) as? WindowManager
            wm?.removeView(view)
            Log.i(TAG, "Floating control hidden")
        } catch (t: Throwable) {
            Log.w(TAG, "hideFloating failed: ${t.message}")
        }
    }

    // ---- internals ----

    private fun buildButton(context: Context): TextView {
        val dp = context.resources.displayMetrics.density
        return TextView(context).apply {
            text = "●"                       // simple dot glyph; no res dependency
            setTextColor(Color.WHITE)
            textSize = 18f
            gravity = Gravity.CENTER
            val pad = (10 * dp).toInt()
            setPadding(pad, pad, pad, pad)
            setBackgroundColor(Color.argb(200, 0, 0, 0))
        }
    }

    private fun buildLayoutParams(): WindowManager.LayoutParams {
        @Suppress("DEPRECATION")
        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY
        } else {
            // minSdk is 26 (O) so this branch is effectively unused, but keep it safe.
            WindowManager.LayoutParams.TYPE_SYSTEM_OVERLAY
        }
        return WindowManager.LayoutParams(
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            type,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
            PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            x = 24
            y = 240
        }
    }

    private fun attachDragHandler(
        view: View,
        wm: WindowManager,
        params: WindowManager.LayoutParams,
    ) {
        var downX = 0f
        var downY = 0f
        var startX = 0
        var startY = 0
        var dragged = false
        val touchSlop = TypedValue.applyDimension(
            TypedValue.COMPLEX_UNIT_DIP, 6f, view.resources.displayMetrics,
        )

        view.setOnTouchListener { v, event ->
            when (event.action) {
                MotionEvent.ACTION_DOWN -> {
                    downX = event.rawX
                    downY = event.rawY
                    startX = params.x
                    startY = params.y
                    dragged = false
                    true
                }
                MotionEvent.ACTION_MOVE -> {
                    val dx = event.rawX - downX
                    val dy = event.rawY - downY
                    if (abs(dx) > touchSlop || abs(dy) > touchSlop) dragged = true
                    params.x = startX + dx.toInt()
                    params.y = startY + dy.toInt()
                    try {
                        wm.updateViewLayout(v, params)
                    } catch (t: Throwable) {
                        Log.w(TAG, "updateViewLayout failed: ${t.message}")
                    }
                    true
                }
                MotionEvent.ACTION_UP -> {
                    if (!dragged) onTap(v.context)
                    true
                }
                else -> false
            }
        }
    }

    /**
     * Tap behaviour — intentionally minimal for Phase 1.
     *
     * If the bot is busy we send an ACTION_STOP to the foreground service (a quick "panic
     * stop" from anywhere on screen). Otherwise we do nothing.
     *
     * TODO(Phase 2): replace with a richer control surface — pause/resume, quick stats,
     * and a shortcut to trigger the auto-post flow once accessibility posting is real.
     */
    private fun onTap(context: Context) {
        try {
            if (BotEngine.isBusy()) {
                val intent = Intent(context, BotForegroundService::class.java).apply {
                    action = BotForegroundService.ACTION_STOP
                }
                context.startService(intent)
                Log.i(TAG, "Floating tap -> STOP_BOT")
            } else {
                Log.i(TAG, "Floating tap ignored (bot not busy)")
            }
        } catch (t: Throwable) {
            Log.w(TAG, "onTap failed: ${t.message}")
        }
    }
}
