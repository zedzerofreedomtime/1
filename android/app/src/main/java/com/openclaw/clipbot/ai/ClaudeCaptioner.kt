package com.openclaw.clipbot.ai

import com.openclaw.clipbot.core.Captioner
import com.openclaw.clipbot.model.CaptionResult
import com.openclaw.clipbot.model.JobConfig
import com.openclaw.clipbot.model.Product
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit

/** Generates a caption through Anthropic's Claude Messages API. */
class ClaudeCaptioner(
    private val apiKey: String,
    private val promptTemplate: String,
) : Captioner {

    private val client: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .build()

    override suspend fun generate(product: Product, config: JobConfig): CaptionResult =
        withContext(Dispatchers.IO) {
            val messages = JSONArray().put(
                JSONObject()
                    .put("role", "user")
                    .put("content", CaptionSupport.buildUserMessage(product, config)),
            )
            val body = JSONObject()
                .put("model", MODEL)
                .put("max_tokens", MAX_TOKENS)
                .put("temperature", 0.8)
                .put("system", promptTemplate)
                .put("messages", messages)
                .toString()
                .toRequestBody(JSON_MEDIA_TYPE)

            val request = Request.Builder()
                .url(ENDPOINT)
                .addHeader("x-api-key", apiKey)
                .addHeader("anthropic-version", ANTHROPIC_VERSION)
                .addHeader("content-type", "application/json")
                .post(body)
                .build()

            client.newCall(request).execute().use { response ->
                val raw = response.body?.string().orEmpty()
                if (!response.isSuccessful) {
                    throw IOException("Claude HTTP ${response.code}: ${raw.take(500)}")
                }
                val content = JSONObject(raw)
                    .getJSONArray("content")
                    .getJSONObject(0)
                    .getString("text")
                CaptionSupport.parse(content, config)
            }
        }

    private companion object {
        const val ENDPOINT = "https://api.anthropic.com/v1/messages"
        const val ANTHROPIC_VERSION = "2023-06-01"
        const val MODEL = "claude-haiku-4-5-20251001"
        const val MAX_TOKENS = 512
        val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()
    }
}
