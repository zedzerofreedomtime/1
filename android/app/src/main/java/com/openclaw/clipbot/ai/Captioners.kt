package com.openclaw.clipbot.ai

import android.content.Context
import com.openclaw.clipbot.core.BotConfig
import com.openclaw.clipbot.core.Captioner
import com.openclaw.clipbot.model.CaptionResult
import com.openclaw.clipbot.model.JobConfig
import com.openclaw.clipbot.model.Product
import org.json.JSONException
import org.json.JSONObject

/**
 * Factory + shared parsing helpers for the AI caption module.
 *
 * [create] picks a provider from [BotConfig]; the concrete captioners
 * ([OpenAiCaptioner], [GeminiCaptioner], [ClaudeCaptioner]) delegate request-body building and
 * response parsing to [CaptionSupport] so both stay consistent.
 */
object Captioners {

    /**
     * Build a [Captioner] from the on-device settings.
     *
     * - selected provider + key present -> its captioner
     * - otherwise, if an OpenAI key is present -> [OpenAiCaptioner]
     * - otherwise -> throw [IllegalStateException] (Thai message asking for a key)
     */
    fun create(context: Context): Captioner {
        val config = BotConfig(context)
        val prompt = config.captionPrompt

        if (config.aiProvider == BotConfig.PROVIDER_GEMINI) {
            val key = config.geminiKey
            if (key != null) return GeminiCaptioner(key, prompt)
        }

        if (config.aiProvider == BotConfig.PROVIDER_CLAUDE) {
            val key = config.claudeKey
            if (key != null) return ClaudeCaptioner(key, prompt)
        }

        val openAiKey = config.openAiKey
        if (openAiKey != null) return OpenAiCaptioner(openAiKey, prompt)

        // Fall back: if Gemini is selected but empty, still surface the key error.
        throw IllegalStateException(
            "ยังไม่ได้ใส่ API Key สำหรับสร้างแคปชั่น กรุณาไปที่หน้าตั้งค่าเพื่อเพิ่ม API Key ก่อนใช้งาน",
        )
    }
}

/** Request-message building and lenient response parsing shared by the captioners. */
internal object CaptionSupport {

    private val HASHTAG_REGEX = Regex("#[\\p{L}\\p{N}_]+")

    /**
     * The user-facing instruction: product line + strict-JSON contract.
     * Uses org.json to escape the product title/link safely.
     */
    fun buildUserMessage(product: Product, config: JobConfig): String {
        val sb = StringBuilder()
        sb.append("สินค้า: ").append(product.title)
        product.price?.takeIf { it.isNotBlank() }?.let {
            sb.append("\nราคา: ").append(it)
        }
        product.link?.takeIf { it.isNotBlank() }?.let {
            sb.append("\nลิงก์: ").append(it)
        }
        sb.append("\n\n")

        if (config.aiTag) {
            sb.append(
                "ตอบกลับเป็น JSON ที่ถูกต้องเท่านั้น ในรูปแบบ " +
                    "{\"caption\": \"...\", \"hashtags\": [\"...\", \"...\"]} " +
                    "โดย caption คือแคปชั่นรีวิว และ hashtags คือรายการแฮชแท็ก 3-5 อัน (ไม่ต้องมีเครื่องหมาย # ก็ได้). " +
                    "ห้ามมีข้อความอื่นนอกเหนือจาก JSON",
            )
        } else {
            sb.append(
                "ตอบกลับเป็น JSON ที่ถูกต้องเท่านั้น ในรูปแบบ " +
                    "{\"caption\": \"...\", \"hashtags\": []} " +
                    "โดย caption คือแคปชั่นรีวิว ห้ามใส่แฮชแท็กใด ๆ และให้ hashtags เป็นลิสต์ว่าง. " +
                    "ห้ามมีข้อความอื่นนอกเหนือจาก JSON",
            )
        }
        return sb.toString()
    }

    /**
     * Parse the model reply leniently.
     * First try to locate a JSON object and read `caption`/`hashtags`.
     * If that fails, treat the whole text as the caption and pull #hashtags out of it.
     * When [JobConfig.aiTag] is false, hashtags are always empty.
     */
    fun parse(rawText: String, config: JobConfig): CaptionResult {
        val text = rawText.trim()

        val json = extractJsonObject(text)
        if (json != null) {
            val caption = json.optString("caption").trim().ifEmpty {
                // Fallback if the model put text but no caption field.
                stripHashtags(text)
            }
            val tags = if (config.aiTag) {
                normalizeHashtags(readHashtagArray(json))
            } else {
                emptyList()
            }
            return CaptionResult(caption, tags)
        }

        // No JSON object at all: whole text is the caption.
        val caption = if (config.aiTag) stripHashtags(text) else stripHashtags(text)
        val tags = if (config.aiTag) {
            normalizeHashtags(HASHTAG_REGEX.findAll(text).map { it.value }.toList())
        } else {
            emptyList()
        }
        return CaptionResult(caption.ifEmpty { text }, tags)
    }

    /** Find the first balanced-ish JSON object in [text] and parse it, or null. */
    private fun extractJsonObject(text: String): JSONObject? {
        val start = text.indexOf('{')
        val end = text.lastIndexOf('}')
        if (start < 0 || end <= start) return null
        val candidate = text.substring(start, end + 1)
        return try {
            JSONObject(candidate)
        } catch (_: JSONException) {
            null
        }
    }

    /** Read `hashtags` whether it's a JSON array or a single/space-separated string. */
    private fun readHashtagArray(json: JSONObject): List<String> {
        val arr = json.optJSONArray("hashtags")
        if (arr != null) {
            val out = ArrayList<String>(arr.length())
            for (i in 0 until arr.length()) {
                val v = arr.optString(i).trim()
                if (v.isNotEmpty()) out.add(v)
            }
            return out
        }
        val asString = json.optString("hashtags").trim()
        if (asString.isEmpty()) return emptyList()
        return asString.split(Regex("\\s+")).filter { it.isNotBlank() }
    }

    /** Strip leading '#', trim, drop blanks, de-duplicate while preserving order. */
    private fun normalizeHashtags(raw: List<String>): List<String> {
        val seen = LinkedHashSet<String>()
        for (item in raw) {
            val cleaned = item.trim().removePrefix("#").trim()
            if (cleaned.isNotEmpty()) seen.add(cleaned)
        }
        return seen.toList()
    }

    /** Remove hashtag tokens from a caption body so tags don't duplicate in the text. */
    private fun stripHashtags(text: String): String =
        HASHTAG_REGEX.replace(text, "").replace(Regex("[ \\t]{2,}"), " ").trim()
}
