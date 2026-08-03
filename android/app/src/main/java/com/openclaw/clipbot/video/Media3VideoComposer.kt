package com.openclaw.clipbot.video

import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.text.SpannableString
import android.text.Spanned
import android.text.style.AbsoluteSizeSpan
import android.text.style.ForegroundColorSpan
import android.text.style.StyleSpan
import androidx.annotation.OptIn
import androidx.media3.common.Effect
import androidx.media3.common.MediaItem
import androidx.media3.common.util.UnstableApi
import androidx.media3.effect.OverlayEffect
import androidx.media3.effect.Presentation
import androidx.media3.effect.OverlaySettings
import androidx.media3.effect.TextOverlay
import androidx.media3.transformer.Composition
import androidx.media3.transformer.EditedMediaItem
import androidx.media3.transformer.EditedMediaItemSequence
import androidx.media3.transformer.Effects
import androidx.media3.transformer.ExportException
import androidx.media3.transformer.ExportResult
import androidx.media3.transformer.ProgressHolder
import androidx.media3.transformer.Transformer
import com.openclaw.clipbot.core.VideoComposer
import com.openclaw.clipbot.model.JobConfig
import com.openclaw.clipbot.model.MediaSource
import com.openclaw.clipbot.model.MediaType
import com.openclaw.clipbot.model.Product
import kotlinx.coroutines.suspendCancellableCoroutine
import java.io.File
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * Composes a product's raw media (images + videos) into a single vertical
 * 1080x1920 H.264 mp4 using Media3 Transformer 1.5.1.
 *
 * The whole export runs off the caller's thread via [suspendCancellableCoroutine];
 * the Transformer itself must be built and driven on a thread with a Looper, so
 * all Transformer interaction is marshalled onto the main thread via [mainHandler].
 */
@OptIn(UnstableApi::class)
class Media3VideoComposer(private val context: Context) : VideoComposer {

    private val appContext: Context = context.applicationContext
    private val mainHandler = Handler(Looper.getMainLooper())

    override suspend fun compose(
        product: Product,
        config: JobConfig,
        index: Int,
        onProgress: (Float) -> Unit,
    ): Uri {
        val media = product.media
        require(media.isNotEmpty()) { "Product has no media to compose" }

        // Output location: <externalFilesDir>/clips/clip_<ts>_<index>.mp4
        // Fall back to internal storage when external is unmounted (getExternalFilesDir can return null).
        val base = appContext.getExternalFilesDir(null) ?: appContext.filesDir
        val clipsDir = File(base, "clips").apply { mkdirs() }
        val outputFile = File(clipsDir, "clip_${System.currentTimeMillis()}_$index.mp4")

        // Split the requested clip length evenly across the source items.
        val totalUs = config.clipLenSec.coerceAtLeast(1) * 1_000_000L
        val perItemUs = totalUs / media.size.coerceAtLeast(1)

        val editedItems = media.map { source -> buildEditedItem(source, perItemUs) }
        val sequence = EditedMediaItemSequence(editedItems)

        val videoEffects = buildVideoEffects(product, config)
        val effects = Effects(/* audioProcessors = */ emptyList(), videoEffects)

        val composition = Composition.Builder(sequence)
            .setEffects(effects)
            .build()

        return runTransformer(composition, outputFile, onProgress)
    }

    /** Wraps a single source into an [EditedMediaItem] with the correct duration. */
    @OptIn(UnstableApi::class)
    private fun buildEditedItem(source: MediaSource, perItemUs: Long): EditedMediaItem {
        return when (source.type) {
            MediaType.IMAGE -> {
                EditedMediaItem.Builder(MediaItem.fromUri(source.uri))
                    .setDurationUs(perItemUs)
                    .setFrameRate(30)
                    .build()
            }

            MediaType.VIDEO -> {
                val clipped = MediaItem.Builder()
                    .setUri(source.uri)
                    .setClippingConfiguration(
                        MediaItem.ClippingConfiguration.Builder()
                            .setStartPositionMs(0L)
                            .setEndPositionMs(perItemUs / 1_000L)
                            .build()
                    )
                    .build()
                EditedMediaItem.Builder(clipped).build()
            }
        }
    }

    /**
     * Vertical crop presentation, plus an optional bottom title overlay.
     * fancyFx is intentionally minimal and must never break the export.
     */
    @OptIn(UnstableApi::class)
    private fun buildVideoEffects(product: Product, config: JobConfig): List<Effect> {
        val effects = mutableListOf<Effect>()

        // Always: fit the source into a 1080x1920 portrait frame, cropping overflow.
        effects.add(
            Presentation.createForWidthAndHeight(
                1080,
                1920,
                Presentation.LAYOUT_SCALE_TO_FIT_WITH_CROP,
            )
        )

        if (config.applyOverlay && product.title.isNotBlank()) {
            runCatching { effects.add(buildTitleOverlay(product.title)) }
        }

        return effects
    }

    /** A [TextOverlay] pinned near the bottom of the frame showing the product title. */
    @OptIn(UnstableApi::class)
    private fun buildTitleOverlay(title: String): OverlayEffect {
        val text = SpannableString(title).apply {
            setSpan(ForegroundColorSpan(Color.WHITE), 0, length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            setSpan(AbsoluteSizeSpan(64), 0, length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            setSpan(StyleSpan(Typeface.BOLD), 0, length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        }

        // anchor/background at the bottom-center of the frame.
        val settings = OverlaySettings.Builder()
            // overlay space is [-1,1]; y = -0.7 places it toward the bottom.
            .setBackgroundFrameAnchor(0f, -0.7f)
            .build()

        val overlay = TextOverlay.createStaticTextOverlay(text, settings)
        return OverlayEffect(listOf(overlay))
    }

    /**
     * Bridges the callback-based [Transformer] to a suspend function.
     * Everything touching the Transformer runs on the main thread's Looper.
     */
    @OptIn(UnstableApi::class)
    private suspend fun runTransformer(
        composition: Composition,
        outputFile: File,
        onProgress: (Float) -> Unit,
    ): Uri = suspendCancellableCoroutine { cont ->
        // Per-invocation token so concurrent composes never cancel each other's poll loop.
        val progressToken = Any()
        // Build + start on the main thread (Transformer requires a Looper thread).
        val startRunnable = Runnable {
            val transformer = Transformer.Builder(appContext)
                .setVideoMimeType(androidx.media3.common.MimeTypes.VIDEO_H264)
                .addListener(object : Transformer.Listener {
                    override fun onCompleted(composition: Composition, exportResult: ExportResult) {
                        mainHandler.removeCallbacksAndMessages(progressToken)
                        if (cont.isActive) {
                            runCatching { onProgress(1f) }
                            cont.resume(Uri.fromFile(outputFile))
                        }
                    }

                    override fun onError(
                        composition: Composition,
                        exportResult: ExportResult,
                        exportException: ExportException,
                    ) {
                        mainHandler.removeCallbacksAndMessages(progressToken)
                        if (cont.isActive) cont.resumeWithException(exportException)
                    }
                })
                .build()

            try {
                transformer.start(composition, outputFile.absolutePath)
            } catch (t: Throwable) {
                if (cont.isActive) cont.resumeWithException(t)
                return@Runnable
            }

            // Progress polling loop (also on the main thread).
            val holder = ProgressHolder()
            val pollRunnable = object : Runnable {
                override fun run() {
                    if (!cont.isActive) return
                    val state = try {
                        transformer.getProgress(holder)
                    } catch (t: Throwable) {
                        Transformer.PROGRESS_STATE_NOT_STARTED
                    }
                    if (state == Transformer.PROGRESS_STATE_AVAILABLE) {
                        runCatching { onProgress((holder.progress / 100f).coerceIn(0f, 1f)) }
                    }
                    mainHandler.postAtTime(this, progressToken, android.os.SystemClock.uptimeMillis() + PROGRESS_INTERVAL_MS)
                }
            }
            mainHandler.postAtTime(pollRunnable, progressToken, android.os.SystemClock.uptimeMillis() + PROGRESS_INTERVAL_MS)

            // Cancel the export if the coroutine is cancelled.
            cont.invokeOnCancellation {
                mainHandler.post {
                    mainHandler.removeCallbacksAndMessages(progressToken)
                    runCatching { transformer.cancel() }
                }
            }
        }

        if (Looper.myLooper() == Looper.getMainLooper()) {
            startRunnable.run()
        } else {
            mainHandler.post(startRunnable)
        }
    }

    private companion object {
        const val PROGRESS_INTERVAL_MS = 250L
    }
}
