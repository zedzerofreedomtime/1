package com.openclaw.clipbot.core

import android.net.Uri
import com.openclaw.clipbot.model.CaptionResult
import com.openclaw.clipbot.model.JobConfig
import com.openclaw.clipbot.model.Product

/** High-level lifecycle state of the bot engine. Mirrors the original app's state machine. */
enum class BotState { IDLE, RUNNING, PAUSED, FINISHED, FAILED }

enum class LogLevel { INFO, WARN, ERROR }

/**
 * Composes raw product media into one finished vertical clip (mp4).
 * Implemented by the `video` module using Media3 Transformer.
 */
interface VideoComposer {
    /**
     * @param product  source material (images / videos)
     * @param config   run settings (length, music, overlay, fx, dryRun)
     * @param index    which clip in the run this is (0-based) — used to vary output
     * @param onProgress 0f..1f export progress; may be invoked off the main thread
     * @return content [Uri] of the exported mp4 (via FileProvider or app storage)
     * @throws Exception on unrecoverable failure
     */
    suspend fun compose(
        product: Product,
        config: JobConfig,
        index: Int,
        onProgress: (Float) -> Unit,
    ): Uri
}

/**
 * Generates a caption + hashtags for a product.
 * Implemented by the `ai` module (OpenAI / Gemini) using the key stored in BotConfig.
 */
interface Captioner {
    suspend fun generate(product: Product, config: JobConfig): CaptionResult
}

/**
 * Posts a finished clip to a target platform by driving its UI.
 * Implemented by the `auto` module (accessibility service) — arrives in Phase 2.
 * Phase 1 uses [NoopPoster] which just reports success without posting.
 */
interface Poster {
    /** @return true if the post flow completed (or was skipped for dryRun). */
    suspend fun post(clip: Uri, caption: CaptionResult, config: JobConfig): Boolean
}

/** Phase-1 stand-in: never actually posts. Lets the full pipeline run end-to-end. */
class NoopPoster : Poster {
    override suspend fun post(clip: Uri, caption: CaptionResult, config: JobConfig): Boolean = true
}

/**
 * Receives engine progress. UI, the notification, and (Phase 3) the server status
 * push all implement this so the engine stays decoupled from who is listening.
 */
interface BotListener {
    fun onState(state: BotState)
    fun onProgress(produced: Int, target: Int, stage: String)
    fun onLog(level: LogLevel, message: String)
}
