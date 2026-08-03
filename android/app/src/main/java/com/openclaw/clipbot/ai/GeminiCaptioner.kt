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
 * Generates a caption via the Google Gemini generateContent API.
 *
 * @param apiKey         the user's Gemini API key
 * @param promptTemplate the base prompt (BotConfig.captionPrompt)
 */
class GeminiCaptioner(
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
            // Gemini has no separate system role in this simple call; combine both.
            val fullPrompt = buildString {
                append(promptTemplate)
                append("\n\n")
                append(CaptionSupport.buildUserMessage(product, config))
            }

            val parts = JSONArray().put(JSONObject().put("text", fullPrompt))
            val contents = JSONArray().put(JSONObject().put("parts", parts))
            val body = JSONObject()
                .put("contents", contents)
                .toString()
                .toRequestBody(JSON_MEDIA_TYPE)

            val request = Request.Builder()
                .url("$ENDPOINT?key=$apiKey")
                .addHeader("Content-Type", "application/json")
                .post(body)
                .build()

            client.newCall(request).execute().use { response ->
                val raw = response.body?.string().orEmpty()
                if (!response.isSuccessful) {
                    throw IOException(
                        "Gemini HTTP ${response.code}: ${raw.take(500)}",
                    )
                }
                val text = JSONObject(raw)
                    .getJSONArray("candidates")
                    .getJSONObject(0)
                    .getJSONObject("content")
                    .getJSONArray("parts")
                    .getJSONObject(0)
                    .getString("text")
                CaptionSupport.parse(text, config)
            }
        }

    private companion object {
        const val ENDPOINT =
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent"
        val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()
    }
}
