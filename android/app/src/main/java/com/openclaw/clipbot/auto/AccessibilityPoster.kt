package com.openclaw.clipbot.auto

import android.content.Context
import android.net.Uri
import android.util.Log
import com.openclaw.clipbot.core.Poster
import com.openclaw.clipbot.model.CaptionResult
import com.openclaw.clipbot.model.JobConfig

/**
 * Phase-2 STUB implementation of [Poster].
 *
 * It does NOT post anything. It logs a clear message and returns true so the end-to-end
 * pipeline (compose -> caption -> "post") still completes cleanly during Phase 1 while
 * auto-post = true is selected. Real posting arrives in Phase 2.
 *
 * ---------------------------------------------------------------------------
 * TODO(Phase 2) — real accessibility-driven posting plan:
 *
 *   1. Ensure [PostAutoService.isConnected]; if not, return false and surface a WARN so
 *      the UI can prompt the user to enable the accessibility service.
 *   2. Bring the target app to the front using config.platform.pkg:
 *          val launch = context.packageManager.getLaunchIntentForPackage(pkg)
 *          launch?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK); context.startActivity(launch)
 *      (handle pkg == null -> "save only", nothing to post).
 *   3. Wait for the app window, then walk the AccessibilityNodeInfo tree (from
 *      PostAutoService.get()?.rootInActiveWindow) to find the "create / upload" entry
 *      point and perform ACTION_CLICK.
 *   4. Attach the clip: hand the exported [clip] Uri to the platform's picker (via its
 *      gallery/upload node, or an ACTION_SEND share intent as a fallback).
 *   5. Paste the caption: put caption.full() on the ClipboardManager, focus the compose
 *      EditText node, and perform ACTION_PASTE (more reliable than ACTION_SET_TEXT across
 *      IME-heavy apps).
 *   6. Locate and ACTION_CLICK the final "Post / Publish" button; verify success by
 *      watching for the confirmation window/toast in onAccessibilityEvent.
 *   7. Respect config.dryRun: run every step EXCEPT the final publish tap.
 *
 * This mirrors a standard accessibility automation approach. Until it is built, we never
 * actually attempt posting.
 * ---------------------------------------------------------------------------
 */
class AccessibilityPoster(context: Context) : Poster {

    private val appContext: Context = context.applicationContext

    override suspend fun post(clip: Uri, caption: CaptionResult, config: JobConfig): Boolean {
        Log.i(
            TAG,
            "โพสต์อัตโนมัติยังไม่เปิดใช้งาน (Phase 2) — ข้ามการโพสต์ไปก่อน " +
                "แพลตฟอร์ม=${config.platform.label} ไฟล์=$clip",
        )
        // Return true so the pipeline treats this as a successful (skipped) post.
        return true
    }

    companion object {
        private const val TAG = "AccessibilityPoster"
    }
}
