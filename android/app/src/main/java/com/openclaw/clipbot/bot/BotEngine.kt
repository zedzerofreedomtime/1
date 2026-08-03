package com.openclaw.clipbot.bot

import android.content.Context
import android.os.Handler
import android.os.Looper
import com.openclaw.clipbot.ai.Captioners
import com.openclaw.clipbot.auto.AccessibilityPoster
import com.openclaw.clipbot.core.BotListener
import com.openclaw.clipbot.core.BotState
import com.openclaw.clipbot.core.Captioner
import com.openclaw.clipbot.core.LogLevel
import com.openclaw.clipbot.core.NoopPoster
import com.openclaw.clipbot.core.Poster
import com.openclaw.clipbot.model.CaptionResult
import com.openclaw.clipbot.model.JobConfig
import com.openclaw.clipbot.model.Product
import com.openclaw.clipbot.video.Media3VideoComposer
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * The heart of Phase 1: turns one product's media into N finished clips.
 *
 * Singleton so the UI, the foreground service and the notification all observe the
 * same run. Collaborators (composer / captioner / poster) are constructed lazily
 * inside [start] so this object stays context-free until a run actually begins.
 *
 * Threading: work runs on an internal [Dispatchers.Default] scope; every
 * [BotListener] callback is marshalled back onto the main thread.
 */
object BotEngine {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val main = Handler(Looper.getMainLooper())

    // ---- Observable run state (read by UI + notification) ----

    @Volatile
    var state: BotState = BotState.IDLE
        private set

    @Volatile
    var produced: Int = 0
        private set

    @Volatile
    var target: Int = 0
        private set

    @Volatile
    var stage: String = ""
        private set

    /**
     * UI + service each subscribe INDEPENDENTLY. Multi-listener (not a single slot) so
     * backgrounding the UI never steals the service's callbacks: the service stays
     * subscribed for its whole lifetime and therefore always learns when the run
     * finishes (so it can tear down the foreground notification). Callbacks always
     * run on the MAIN thread.
     */
    private val listeners = java.util.concurrent.CopyOnWriteArraySet<BotListener>()

    fun addListener(l: BotListener) {
        // No immediate snapshot emit on purpose: the service's listener treats IDLE as
        // "run finished" and would tear itself down the instant it subscribed. Subscribers
        // that need the current state (the UI) read BotEngine.state directly on attach.
        listeners.add(l)
    }

    fun removeListener(l: BotListener) {
        listeners.remove(l)
    }

    // ---- Internal control flags ----

    @Volatile
    private var paused: Boolean = false

    @Volatile
    private var stopRequested: Boolean = false

    @Volatile
    private var product: Product? = null

    @Volatile
    private var config: JobConfig? = null

    @Volatile
    private var runJob: Job? = null

    fun isBusy(): Boolean = state == BotState.RUNNING || state == BotState.PAUSED

    /** Set up the next run. UI calls this before starting the service. */
    fun prepare(product: Product, config: JobConfig) {
        if (isBusy()) return
        this.product = product
        this.config = config
        produced = 0
        target = config.clipCount
        stage = ""
        paused = false
        stopRequested = false
        setState(BotState.IDLE)
    }

    /** Launch the run on the internal scope. No-op if busy or nothing prepared. */
    fun start(appContext: Context) {
        if (isBusy()) return
        val product = this.product ?: return
        val config = this.config ?: return

        paused = false
        stopRequested = false
        produced = 0
        target = config.clipCount
        setState(BotState.RUNNING)

        val ctx = appContext.applicationContext
        runJob = scope.launch { runLoop(ctx, product, config) }
    }

    private suspend fun runLoop(appContext: Context, product: Product, config: JobConfig) {
        val composer = Media3VideoComposer(appContext)

        val captioner: Captioner? = try {
            Captioners.create(appContext)
        } catch (t: Throwable) {
            emitLog(LogLevel.WARN, "AI caption disabled: ${t.message ?: t.javaClass.simpleName}")
            null
        }

        val poster: Poster =
            if (config.autoPost) AccessibilityPoster(appContext) else NoopPoster()

        try {
            for (i in 0 until target) {
                if (stopRequested) break

                // Honour pause without spinning the CPU.
                while (paused && !stopRequested) {
                    delay(200)
                }
                if (stopRequested) break

                try {
                    stage = "Compose"
                    emitProgress()
                    // Compose is the expensive step; if it fails the clip genuinely didn't happen.
                    val uri = composer.compose(product, config, i) { p ->
                        stage = "Compose ${(p.coerceIn(0f, 1f) * 100).toInt()}%"
                        emitProgress()
                    }

                    if (stopRequested) break

                    // Caption failure must NOT throw away an already-composed clip.
                    stage = "Caption"
                    emitProgress()
                    val caption = try {
                        captioner?.generate(product, config) ?: CaptionResult("")
                    } catch (c: kotlinx.coroutines.CancellationException) {
                        throw c
                    } catch (t: Throwable) {
                        emitLog(
                            LogLevel.WARN,
                            "Caption failed for clip ${i + 1}: ${t.message ?: t.javaClass.simpleName}",
                        )
                        CaptionResult("")
                    }

                    if (stopRequested) break

                    // Likewise a post failure (Phase 2) must not discard the clip.
                    stage = "Post"
                    emitProgress()
                    try {
                        poster.post(uri, caption, config)
                    } catch (c: kotlinx.coroutines.CancellationException) {
                        throw c
                    } catch (t: Throwable) {
                        emitLog(
                            LogLevel.WARN,
                            "Post failed for clip ${i + 1}: ${t.message ?: t.javaClass.simpleName}",
                        )
                    }

                    // Always persist the composed clip, then drop the temp copy to bound storage.
                    val saved = ClipSaver.save(appContext, uri)
                    if (saved != null) {
                        runCatching { uri.path?.let { java.io.File(it).delete() } }
                    }

                    produced++
                    stage = "Done"
                    emitProgress()
                } catch (c: kotlinx.coroutines.CancellationException) {
                    // Cancellation (stop) must propagate, not be treated as a clip error.
                    throw c
                } catch (t: Throwable) {
                    // Compose failed → this clip is lost; keep going with the next one.
                    emitLog(
                        LogLevel.ERROR,
                        "Clip ${i + 1} failed: ${t.message ?: t.javaClass.simpleName}",
                    )
                }
            }
        } finally {
            val finalState = if (stopRequested) BotState.FAILED else BotState.FINISHED
            setState(finalState)
            // Reset busy so a new run can be prepared.
            paused = false
            runJob = null
        }
    }

    fun pause() {
        if (state != BotState.RUNNING) return
        paused = true
        setState(BotState.PAUSED)
    }

    fun resume() {
        if (state != BotState.PAUSED) return
        paused = false
        setState(BotState.RUNNING)
    }

    /** Request a polite stop: unblock any pause, mark the run as failing, cancel work. */
    fun stop() {
        if (!isBusy()) {
            stopRequested = true
            setState(BotState.IDLE)
            return
        }
        stopRequested = true
        paused = false
        runJob?.cancel()
    }

    // ---- Listener marshalling (always on the main thread) ----

    private fun setState(newState: BotState) {
        state = newState
        if (listeners.isEmpty()) return
        main.post { listeners.forEach { it.onState(newState) } }
    }

    private fun emitProgress() {
        if (listeners.isEmpty()) return
        val p = produced
        val t = target
        val s = stage
        main.post { listeners.forEach { it.onProgress(p, t, s) } }
    }

    private fun emitLog(level: LogLevel, message: String) {
        if (listeners.isEmpty()) return
        main.post { listeners.forEach { it.onLog(level, message) } }
    }
}
