package com.openclaw.clipbot.remote

import android.content.Context
import android.net.Uri
import android.util.Log
import com.openclaw.clipbot.bot.ClipSaver
import com.openclaw.clipbot.model.JobConfig
import com.openclaw.clipbot.model.MediaSource
import com.openclaw.clipbot.model.MediaType
import com.openclaw.clipbot.model.Platform
import com.openclaw.clipbot.model.Product
import com.openclaw.clipbot.net.ApiClient
import com.openclaw.clipbot.video.Media3VideoComposer
import kotlinx.coroutines.delay
import org.json.JSONObject
import java.io.File

/**
 * Runs one server-driven "start" job — the fleet counterpart of the local
 * [com.openclaw.clipbot.bot.BotEngine]. Mirrors device_sim.py exactly:
 * config → auto-pick → items → per item: lock → detail → AI caption (server
 * proxy) → compose → export → done. Reports honest status to the backend at
 * every stage.
 */
class ServerJobRunner(
    private val appContext: Context,
    private val api: ApiClient,
) {
    @Volatile var paused = false
    @Volatile var stopped = false

    private val composer by lazy { Media3VideoComposer(appContext) }

    suspend fun run(params: JSONObject, onProgress: (String) -> Unit) {
        val cfg = mergeConfig(params)
        val target = cfg.optInt("clip_count", 1)
        var produced = 0
        report("running", "PICK_DATASET", produced, target)

        val pick = api.autoPick(cfg.optBoolean("reuse_touched", false))
        if (!pick.optBoolean("ok", false)) {
            report("failed", "-", produced, target, message = "no dataset")
            return
        }
        val dsId = pick.getJSONObject("dataset").getInt("id")
        api.opened(dsId)
        onProgress("dataset=$dsId · target=$target")

        report("running", "LOAD_ITEMS", produced, target, datasetId = dsId)
        val items = api.items(dsId)

        for (i in 0 until items.length()) {
            if (stopped) break
            while (paused && !stopped) delay(200)
            if (stopped) break

            val it = items.getJSONObject(i)
            if (it.optString("status") != "pending") continue
            if (produced >= target) break
            val pid = it.optLong("product_id")

            report("running", "LOCK", produced, target, dsId, pid)
            if (!api.startItem(dsId, pid, force = false)) {
                onProgress("#$pid locked by another device → skip")
                continue
            }
            try {
                val detail = api.itemDetail(dsId, pid)

                report("running", "CAPTION", produced, target, dsId, pid)
                val cap = api.aiCaption(detail.optString("summary"), null)
                onProgress("#$pid ${cap.optString("caption").take(38)}")

                report("running", "COMPOSE", produced, target, dsId, pid)
                val product = buildProduct(pid, detail)
                if (product.media.isNotEmpty()) {
                    val uri = composer.compose(product, toJobConfig(cfg), i) { /* progress */ }
                    report("running", "EXPORT", produced, target, dsId, pid)
                    ClipSaver.save(appContext, uri)
                    runCatching { uri.path?.let { File(it).delete() } }
                } else {
                    // Phase-0: items have no media yet (that's the scraper, Phase 1).
                    // The control loop is still fully exercised end-to-end.
                    onProgress("#$pid no media yet (awaiting scraper) — skip compose")
                }

                // Phase-0 has no auto-post → verified=false (rendered only).
                // Phase-3 will set verified from a REAL Shopee upload-complete check.
                api.doneItem(dsId, pid, verified = false,
                    message = "rendered (phase-0, no auto-post)", postRef = null)
                produced++
                report("running", "DONE", produced, target, dsId, pid)
            } catch (t: Throwable) {
                Log.w(TAG, "item $pid failed: ${t.message}")
                runCatching { api.releaseItem(dsId, pid) }
            }
        }

        api.closed(dsId, produced)
        report(
            if (stopped) "idle" else "finished", "-", produced, target,
            message = "$produced/$target rendered",
        )
    }

    /** Server defaults (/api/app/config) overlaid with this command's config. */
    private fun mergeConfig(params: JSONObject): JSONObject {
        val server = runCatching { api.config() }.getOrDefault(JSONObject())
        val override = params.optJSONObject("config") ?: JSONObject()
        val out = JSONObject()
        for (k in server.keys()) out.put(k, server.get(k))
        for (k in override.keys()) out.put(k, override.get(k))
        return out
    }

    private fun buildProduct(pid: Long, detail: JSONObject): Product {
        val prod = detail.optJSONObject("product") ?: JSONObject()
        val media = mutableListOf<MediaSource>()
        detail.optJSONArray("media")?.let { arr ->
            for (i in 0 until arr.length()) {
                val m = arr.getJSONObject(i)
                val url = m.optString("url")
                if (url.isEmpty()) continue
                val type = if (m.optString("type").startsWith("video")) MediaType.VIDEO else MediaType.IMAGE
                val ext = if (type == MediaType.VIDEO) ".mp4" else ".jpg"
                val f = File(appContext.cacheDir, "media_pool/${pid}_$i$ext").apply { parentFile?.mkdirs() }
                runCatching { if (!f.exists() || f.length() == 0L) api.download(url, f) }
                if (f.exists() && f.length() > 0) media.add(MediaSource(Uri.fromFile(f), type))
            }
        }
        return Product(
            id = pid,
            title = prod.optString("name"),
            price = prod.optString("price"),
            link = detail.optString("product_url").ifEmpty { null },
            media = media,
        )
    }

    private fun toJobConfig(cfg: JSONObject) = JobConfig(
        clipCount = cfg.optInt("clip_count", 1),
        clipLenSec = cfg.optInt("clip_len_sec", 16),
        withMusic = cfg.optBoolean("with_music", true),
        aiTag = cfg.optBoolean("ai_tag", true),
        applyOverlay = cfg.optBoolean("apply_overlay", true),
        fancyFx = cfg.optBoolean("fancy_fx", true),
        autoPost = cfg.optBoolean("auto_post", false),
        dryRun = cfg.optBoolean("post_dry_run", false),
        platform = Platform.fromKey(cfg.optString("platform", "shopee")),
    )

    private fun report(
        state: String,
        stage: String,
        produced: Int,
        target: Int,
        datasetId: Int = 0,
        productId: Long = 0,
        message: String = "",
    ) {
        runCatching {
            api.postStatus(
                JSONObject()
                    .put("run_state", state)
                    .put("stage", stage)
                    .put("produced", produced)
                    .put("target", target)
                    .put("dataset_id", datasetId)
                    .put("product_id", productId)
                    .put("last_message", message),
            )
        }
    }

    companion object {
        private const val TAG = "ServerJob"
    }
}
