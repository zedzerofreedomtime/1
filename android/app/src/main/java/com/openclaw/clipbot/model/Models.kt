package com.openclaw.clipbot.model

import android.net.Uri

/**
 * A product / subject to make a review clip about.
 * Phase 1: the user supplies these locally (pick media, optionally paste a link).
 * Phase 3: these will arrive from our own backend as "datasets".
 */
data class Product(
    val id: Long,
    val title: String,
    val price: String? = null,
    val link: String? = null,
    val media: List<MediaSource> = emptyList(),
)

/** One image or video used as raw material for a clip. */
data class MediaSource(
    val uri: Uri,
    val type: MediaType,
    val durationMs: Long = 0L,
)

enum class MediaType { IMAGE, VIDEO }

/**
 * Target platform for (eventual) auto-posting.
 * Phase 1 only tags the exported file; Phase 2 uses [pkg] to bring the app forward.
 */
enum class Platform(val label: String, val pkg: String?) {
    TIKTOK("TikTok", "com.zhiliaoapp.musically"),
    FACEBOOK("Facebook", "com.facebook.katana"),
    SHOPEE("Shopee Video", "com.shopee.th"),
    NONE("บันทึกไฟล์อย่างเดียว", null);

    companion object {
        fun fromKey(key: String?): Platform =
            entries.firstOrNull { it.name.equals(key, ignoreCase = true) } ?: TIKTOK
    }
}

/** Result of AI caption generation. */
data class CaptionResult(
    val caption: String,
    val hashtags: List<String> = emptyList(),
) {
    /** Caption text plus normalized hashtags, ready to paste into a post box. */
    fun full(): String =
        if (hashtags.isEmpty()) caption
        else caption + "\n\n" + hashtags.joinToString(" ") {
            if (it.startsWith("#")) it else "#$it"
        }
}

/**
 * Immutable snapshot of the settings for a single run,
 * copied from [com.openclaw.clipbot.core.BotConfig] the moment Start is pressed
 * so mid-run settings changes don't corrupt an in-flight job.
 */
data class JobConfig(
    val clipCount: Int,
    val clipLenSec: Int,
    val withMusic: Boolean,
    val aiTag: Boolean,
    val applyOverlay: Boolean,
    val fancyFx: Boolean,
    val autoPost: Boolean,
    val dryRun: Boolean,
    val platform: Platform,
)

/** A single unit of work: turn one product's media into one exported/posted clip. */
data class ClipJob(
    val product: Product,
    val config: JobConfig,
)
