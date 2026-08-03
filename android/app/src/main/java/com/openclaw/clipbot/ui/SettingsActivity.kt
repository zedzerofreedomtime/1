package com.openclaw.clipbot.ui

import android.os.Bundle
import android.widget.ArrayAdapter
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import com.openclaw.clipbot.R
import com.openclaw.clipbot.core.BotConfig
import com.openclaw.clipbot.databinding.ActivitySettingsBinding
import com.openclaw.clipbot.model.Platform

/**
 * Edits the persistent [BotConfig]. Loads current values on entry and writes them
 * back to SharedPreferences only when Save is tapped.
 */
class SettingsActivity : AppCompatActivity() {

    private lateinit var binding: ActivitySettingsBinding
    private lateinit var config: BotConfig

    /** Provider keys, aligned with the labels shown in the dropdown. */
    private val providerKeys = listOf(
        BotConfig.PROVIDER_OPENAI,
        BotConfig.PROVIDER_GEMINI,
        BotConfig.PROVIDER_CLAUDE,
    )
    private val providerLabels = listOf("OpenAI", "Gemini", "Claude")

    /** Target platforms, aligned with their user-facing labels. */
    private val platforms = Platform.entries.toList()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivitySettingsBinding.inflate(layoutInflater)
        setContentView(binding.root)

        supportActionBar?.setDisplayHomeAsUpEnabled(true)
        title = getString(R.string.settings_title)

        config = BotConfig(this)

        setupDropdowns()
        loadValues()

        binding.btnSave.setOnClickListener { save() }
    }

    override fun onSupportNavigateUp(): Boolean {
        finish()
        return true
    }

    private fun setupDropdowns() {
        binding.dropdownProvider.setAdapter(
            ArrayAdapter(this, android.R.layout.simple_list_item_1, providerLabels)
        )
        binding.dropdownPlatform.setAdapter(
            ArrayAdapter(this, android.R.layout.simple_list_item_1, platforms.map { it.label })
        )
    }

    private fun loadValues() {
        binding.inputClipCount.setText(config.clipCount.toString())
        binding.inputClipLen.setText(config.clipLenSec.toString())

        binding.switchMusic.isChecked = config.withMusic
        binding.switchAiTag.isChecked = config.aiTag
        binding.switchOverlay.isChecked = config.applyOverlay
        binding.switchFancyFx.isChecked = config.fancyFx
        binding.switchAutoPost.isChecked = config.autoPost
        binding.switchDryRun.isChecked = config.dryRun
        binding.switchFloating.isChecked = config.floatingButton

        val providerIndex = providerKeys.indexOf(config.aiProvider).coerceAtLeast(0)
        binding.dropdownProvider.setText(providerLabels[providerIndex], false)

        binding.inputOpenAiKey.setText(config.openAiKey.orEmpty())
        binding.inputGeminiKey.setText(config.geminiKey.orEmpty())
        binding.inputClaudeKey.setText(config.claudeKey.orEmpty())
        binding.inputCaptionPrompt.setText(config.captionPrompt)

        val platformIndex = platforms.indexOf(config.platform).coerceAtLeast(0)
        binding.dropdownPlatform.setText(platforms[platformIndex].label, false)
    }

    private fun save() {
        config.clipCount = binding.inputClipCount.text?.toString()?.trim()?.toIntOrNull() ?: config.clipCount
        config.clipLenSec = binding.inputClipLen.text?.toString()?.trim()?.toIntOrNull() ?: config.clipLenSec

        config.withMusic = binding.switchMusic.isChecked
        config.aiTag = binding.switchAiTag.isChecked
        config.applyOverlay = binding.switchOverlay.isChecked
        config.fancyFx = binding.switchFancyFx.isChecked
        config.autoPost = binding.switchAutoPost.isChecked
        config.dryRun = binding.switchDryRun.isChecked
        config.floatingButton = binding.switchFloating.isChecked

        config.aiProvider = resolveProvider()
        config.openAiKey = binding.inputOpenAiKey.text?.toString()
        config.geminiKey = binding.inputGeminiKey.text?.toString()
        config.claudeKey = binding.inputClaudeKey.text?.toString()
        config.captionPrompt = binding.inputCaptionPrompt.text?.toString().orEmpty()

        config.platform = resolvePlatform()

        Toast.makeText(this, R.string.saved, Toast.LENGTH_SHORT).show()
        finish()
    }

    private fun resolveProvider(): String {
        val label = binding.dropdownProvider.text?.toString().orEmpty()
        val index = providerLabels.indexOf(label)
        return if (index >= 0) providerKeys[index] else config.aiProvider
    }

    private fun resolvePlatform(): Platform {
        val label = binding.dropdownPlatform.text?.toString().orEmpty()
        return platforms.firstOrNull { it.label == label } ?: config.platform
    }
}
