package com.openclaw.clipbot.net

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.util.concurrent.TimeUnit

/** Raised on non-2xx; carries the backend's {error,message} contract. */
class ApiException(val code: Int, val error: String, override val message: String) : IOException(message)

/**
 * Talks to OUR backend (matches the contract proven by device_sim.py).
 * Every device call sends `Authorization: Bearer <token>`. TLS pinning is added
 * at deploy time (the original shipped an all-trusting TrustManager — we do NOT).
 */
class ApiClient(private val session: Session) {

    private val http = OkHttpClient.Builder()
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .build()

    private val jsonType = "application/json; charset=utf-8".toMediaType()

    // ---- login ----

    /** POST {baseUrl}/api/discover {token} → stores token + server_url + device_id. */
    fun discover(baseUrl: String, token: String): JSONObject {
        val body = JSONObject().put("token", token)
        val req = Request.Builder()
            .url(trim(baseUrl) + "/api/discover")
            .post(body.toString().toRequestBody(jsonType))
            .build()
        val json = exec(req)
        session.token = token
        session.serverUrl = json.getString("server_url")
        session.deviceId = json.optInt("device_id", 0)
        return json
    }

    // ---- device endpoints ----

    fun config(): JSONObject = exec(get("/api/app/config")).getJSONObject("config")

    fun heartbeat() {
        exec(post("/api/app/heartbeat", JSONObject()
            .put("device_label", session.deviceLabel)
            .put("device_id", session.deviceId.toString())))
    }

    fun postStatus(status: JSONObject) {
        exec(post("/api/app/status", status))
    }

    fun getCommand(): JSONObject? {
        val j = exec(get("/api/app/commands?device_id=" + session.deviceId))
        return if (j.isNull("command")) null else j.getJSONObject("command")
    }

    fun ack(commandId: String, result: String, message: String?) {
        val body = JSONObject()
            .put("command_id", commandId)
            .put("device_id", session.deviceId.toString())
            .put("result", result)
        if (message != null) body.put("message", message)
        exec(post("/api/app/commands/ack", body))
    }

    fun autoPick(reuseTouched: Boolean): JSONObject =
        exec(post("/api/app/datasets/auto-pick", JSONObject().put("reuse_touched", reuseTouched)))

    fun opened(datasetId: Int) =
        exec(post("/api/app/datasets/$datasetId/opened", JSONObject().put("context", "bot")))

    fun closed(datasetId: Int, postedInSession: Int) =
        exec(post("/api/app/datasets/$datasetId/closed",
            JSONObject().put("reason", "bot-stop").put("posted_in_session", postedInSession)))

    fun items(datasetId: Int): JSONArray =
        exec(get("/api/app/datasets/$datasetId/items")).getJSONArray("items")

    fun itemDetail(datasetId: Int, productId: Long): JSONObject =
        exec(get("/api/app/datasets/$datasetId/items/$productId"))

    /** @return true if locked to us; false if 409/already_posted (caller skips). */
    fun startItem(datasetId: Int, productId: Long, force: Boolean): Boolean {
        return try {
            exec(post("/api/app/datasets/$datasetId/items/$productId/start",
                JSONObject().put("force", force).put("device_id", session.deviceId.toString())))
            true
        } catch (e: ApiException) {
            if (e.code == 409 || e.error == "already_posted") false else throw e
        }
    }

    fun doneItem(datasetId: Int, productId: Long, verified: Boolean, message: String?, postRef: String?) {
        val body = JSONObject().put("verified", verified)
        if (message != null) body.put("post_message", message)
        if (postRef != null) body.put("post_ref", postRef)
        exec(post("/api/app/datasets/$datasetId/items/$productId/done", body))
    }

    fun releaseItem(datasetId: Int, productId: Long) =
        exec(post("/api/app/datasets/$datasetId/items/$productId/release",
            JSONObject().put("device_id", session.deviceId.toString())))

    /** Server-side AI proxy — the device sends only the product summary, never an API key. */
    fun aiCaption(productSummary: String, captionIdea: String?): JSONObject {
        val body = JSONObject().put("product_summary", productSummary)
        if (captionIdea != null) body.put("caption_idea", captionIdea)
        return exec(post("/api/app/ai/caption", body))
    }

    /** Download a media URL to [dest]. Used by the job runner for review media. */
    fun download(url: String, dest: File) {
        val req = Request.Builder().url(url).get().build()
        http.newCall(req).execute().use { resp ->
            if (!resp.isSuccessful) throw ApiException(resp.code, "download_failed", "HTTP ${resp.code}")
            dest.outputStream().use { out -> resp.body?.byteStream()?.copyTo(out) }
        }
    }

    // ---- plumbing ----

    private fun base(): String =
        session.serverUrl ?: throw ApiException(0, "no_server", "not logged in")

    private fun get(path: String): Request =
        Request.Builder().url(trim(base()) + path).headers().get().build()

    private fun post(path: String, body: JSONObject): Request =
        Request.Builder().url(trim(base()) + path).headers()
            .post(body.toString().toRequestBody(jsonType)).build()

    private fun Request.Builder.headers(): Request.Builder = this
        .header("Authorization", "Bearer " + (session.token ?: "tampered"))
        .header("Content-Type", "application/json")

    private fun exec(req: Request): JSONObject {
        http.newCall(req).execute().use { resp ->
            val text = resp.body?.string().orEmpty()
            val json = if (text.isNotEmpty()) JSONObject(text) else JSONObject()
            if (!resp.isSuccessful) {
                throw ApiException(
                    resp.code,
                    json.optString("error", "http_error"),
                    json.optString("message", "HTTP ${resp.code}"),
                )
            }
            return json
        }
    }

    private fun trim(u: String): String = u.trimEnd('/')
}
