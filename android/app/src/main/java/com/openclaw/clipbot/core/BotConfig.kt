package com.openclaw.clipbot.core

import android.content.Context
import com.openclaw.clipbot.model.JobConfig
import com.openclaw.clipbot.model.Platform

/**
 * Local settings store — the whole app config lives on-device in SharedPreferences.
 *
 * There is deliberately NO login and NO server here: this is the "standalone" design.
 * When Phase 3 adds a backend, a separate sync layer will read/write these same keys,
 * so nothing downstream needs to change.
 */
class BotConfig(context: Context) {

    private val sp = context.applicationContext
        .getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    // ---- Run settings (mirror the original app's remote-config keys) ----

    var clipCount: Int
        get() = sp.getInt(K_CLIP_COUNT, 3).coerceIn(1, 1000)
        set(v) = sp.edit().putInt(K_CLIP_COUNT, v.coerceIn(1, 1000)).apply()

    var clipLenSec: Int
        get() = sp.getInt(K_CLIP_LEN, 15).coerceIn(3, 60)
        set(v) = sp.edit().putInt(K_CLIP_LEN, v.coerceIn(3, 60)).apply()

    var withMusic: Boolean
        get() = sp.getBoolean(K_MUSIC, true)
        set(v) = sp.edit().putBoolean(K_MUSIC, v).apply()

    var aiTag: Boolean
        get() = sp.getBoolean(K_AI_TAG, true)
        set(v) = sp.edit().putBoolean(K_AI_TAG, v).apply()

    var applyOverlay: Boolean
        get() = sp.getBoolean(K_OVERLAY, true)
        set(v) = sp.edit().putBoolean(K_OVERLAY, v).apply()

    var fancyFx: Boolean
        get() = sp.getBoolean(K_FANCY_FX, true)
        set(v) = sp.edit().putBoolean(K_FANCY_FX, v).apply()

    /** Phase 1 default OFF — auto-post needs the Phase 2 accessibility service. */
    var autoPost: Boolean
        get() = sp.getBoolean(K_AUTO_POST, false)
        set(v) = sp.edit().putBoolean(K_AUTO_POST, v).apply()

    var dryRun: Boolean
        get() = sp.getBoolean(K_DRY_RUN, false)
        set(v) = sp.edit().putBoolean(K_DRY_RUN, v).apply()

    var platform: Platform
        get() = Platform.fromKey(sp.getString(K_PLATFORM, Platform.TIKTOK.name))
        set(v) = sp.edit().putString(K_PLATFORM, v.name).apply()

    // ---- AI provider settings (kept locally instead of fetched from server) ----

    /** "openai", "gemini", or "claude". */
    var aiProvider: String
        get() = sp.getString(K_AI_PROVIDER, PROVIDER_OPENAI) ?: PROVIDER_OPENAI
        set(v) = sp.edit().putString(K_AI_PROVIDER, v).apply()

    var openAiKey: String?
        get() = sp.getString(K_OPENAI_KEY, null)?.trim()?.ifEmpty { null }
        set(v) = sp.edit().putString(K_OPENAI_KEY, v?.trim()).apply()

    var geminiKey: String?
        get() = sp.getString(K_GEMINI_KEY, null)?.trim()?.ifEmpty { null }
        set(v) = sp.edit().putString(K_GEMINI_KEY, v?.trim()).apply()

    var claudeKey: String?
        get() = sp.getString(K_CLAUDE_KEY, null)?.trim()?.ifEmpty { null }
        set(v) = sp.edit().putString(K_CLAUDE_KEY, v?.trim()).apply()

    /** Optional custom caption prompt; falls back to [DEFAULT_CAPTION_PROMPT] when blank. */
    var captionPrompt: String
        get() = sp.getString(K_CAPTION_PROMPT, DEFAULT_CAPTION_PROMPT)
            ?.ifBlank { DEFAULT_CAPTION_PROMPT } ?: DEFAULT_CAPTION_PROMPT
        set(v) = sp.edit().putString(K_CAPTION_PROMPT, v).apply()

    var floatingButton: Boolean
        get() = sp.getBoolean(K_FLOATING, true)
        set(v) = sp.edit().putBoolean(K_FLOATING, v).apply()

    /** True when the user has entered a key for the currently selected provider. */
    fun hasAiKey(): Boolean = when (aiProvider) {
        PROVIDER_GEMINI -> geminiKey != null
        PROVIDER_CLAUDE -> claudeKey != null
        else -> openAiKey != null
    }

    /** Freeze the current settings into an immutable snapshot for one run. */
    fun snapshot(): JobConfig = JobConfig(
        clipCount = clipCount,
        clipLenSec = clipLenSec,
        withMusic = withMusic,
        aiTag = aiTag,
        applyOverlay = applyOverlay,
        fancyFx = fancyFx,
        autoPost = autoPost,
        dryRun = dryRun,
        platform = platform,
    )

    companion object {
        const val PREFS = "clipbot_settings"

        const val PROVIDER_OPENAI = "openai"
        const val PROVIDER_GEMINI = "gemini"
        const val PROVIDER_CLAUDE = "claude"

        const val DEFAULT_CAPTION_PROMPT =
            "เขียนแคปชั่นรีวิวสินค้าสั้น ๆ กระชับ น่าซื้อ เป็นภาษาไทย " +
                "โทนเป็นกันเองแบบครีเอเตอร์ ความยาวไม่เกิน 2 บรรทัด " +
                "ห้ามใส่ราคาเกินจริง แล้วต่อด้วยแฮชแท็กที่เกี่ยวข้อง 3-5 อัน"

        private const val K_CLIP_COUNT = "clip_count"
        private const val K_CLIP_LEN = "clip_len_sec"
        private const val K_MUSIC = "with_music"
        private const val K_AI_TAG = "ai_tag"
        private const val K_OVERLAY = "apply_overlay"
        private const val K_FANCY_FX = "fancy_fx"
        private const val K_AUTO_POST = "auto_post"
        private const val K_DRY_RUN = "post_dry_run"
        private const val K_PLATFORM = "platform"
        private const val K_AI_PROVIDER = "ai_provider"
        private const val K_OPENAI_KEY = "openai_key"
        private const val K_GEMINI_KEY = "gemini_key"
        private const val K_CLAUDE_KEY = "claude_key"
        private const val K_CAPTION_PROMPT = "caption_prompt"
        private const val K_FLOATING = "floating_button"
    }
}
