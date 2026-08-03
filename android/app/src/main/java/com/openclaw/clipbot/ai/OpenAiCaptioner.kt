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

/**
 * Generates a caption via the OpenAI Chat Completions API.
 *
 * @param apiKey         the user's OpenAI API key
 * @param promptTemplate the system prompt (BotConfig.captionPrompt)
 */
class OpenAiCaptioner(
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
            val userContent = CaptionSupport.buildUserMessage(product, config)

            val messages = JSONArray()
                .put(
                    JSONObject()
                        .put("role", "system")
                        .put("content", promptTemplate),
                )
                .put(
                    JSONObject()
                        .put("role", "user")
                        .put("content", userContent),
                )

            val body = JSONObject()
                .put("model", "gpt-4o-mini")
                .put("temperature", 0.8)
                .put("messages", messages)
                .toString()
                .toRequestBody(JSON_MEDIA_TYPE)

            val request = Request.Builder()
                .url(ENDPOINT)
                .addHeader("Authorization", "Bearer $apiKey")
                .addHeader("Content-Type", "application/json")
                .post(body)
                .build()

            client.newCall(request).execute().use { response ->
                val raw = response.body?.string().orEmpty()
                if (!response.isSuccessful) {
                    throw IOException(
                        "OpenAI HTTP ${response.code}: ${raw.take(500)}",
                    )
                }
                val content = JSONObject(raw)
                    .getJSONArray("choices")
                    .getJSONObject(0)
                    .getJSONObject("message")
                    .getString("content")
                CaptionSupport.parse(content, config)
            }
        }

    private companion object {
        const val ENDPOINT = "https://api.openai.com/v1/chat/completions"
        val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()
    }
}
