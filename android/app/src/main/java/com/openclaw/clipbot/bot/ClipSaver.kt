package com.openclaw.clipbot.bot

import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream

/**
 * Copies a finished clip into a place the user can find it.
 *
 * - API 29+: published to the public gallery via MediaStore under `Movies/ClipBot`.
 * - API 26–28: copied into app-scoped external files (`.../Movies/ClipBot`).
 *
 * All failures are non-fatal: a clip that composed fine should still count as produced
 * even if the copy step fails, so this only logs and returns null on error.
 */
object ClipSaver {

    private const val TAG = "ClipSaver"
    private const val ALBUM = "ClipBot"

    /** @return the destination [Uri] on success, or null if the copy failed. */
    suspend fun save(context: Context, source: Uri): Uri? = withContext(Dispatchers.IO) {
        val ctx = context.applicationContext
        val name = "clipbot_${System.currentTimeMillis()}.mp4"
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                saveViaMediaStore(ctx, source, name)
            } else {
                saveToAppStorage(ctx, source, name)
            }
        } catch (t: Throwable) {
            Log.w(TAG, "Failed to save clip $source", t)
            null
        }
    }

    private fun saveViaMediaStore(context: Context, source: Uri, name: String): Uri? {
        val resolver = context.contentResolver
        val values = ContentValues().apply {
            put(MediaStore.Video.Media.DISPLAY_NAME, name)
            put(MediaStore.Video.Media.MIME_TYPE, "video/mp4")
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                put(
                    MediaStore.Video.Media.RELATIVE_PATH,
                    Environment.DIRECTORY_MOVIES + File.separator + ALBUM,
                )
                put(MediaStore.Video.Media.IS_PENDING, 1)
            }
        }

        val collection = MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
        val dest = resolver.insert(collection, values) ?: return null

        try {
            resolver.openInputStream(source).use { input ->
                if (input == null) {
                    resolver.delete(dest, null, null)
                    return null
                }
                resolver.openOutputStream(dest).use { output ->
                    if (output == null) {
                        resolver.delete(dest, null, null)
                        return null
                    }
                    input.copyTo(output)
                }
            }
        } catch (t: Throwable) {
            runCatching { resolver.delete(dest, null, null) }
            throw t
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val done = ContentValues().apply { put(MediaStore.Video.Media.IS_PENDING, 0) }
            resolver.update(dest, done, null, null)
        }
        return dest
    }

    private fun saveToAppStorage(context: Context, source: Uri, name: String): Uri? {
        val baseDir = context.getExternalFilesDir(Environment.DIRECTORY_MOVIES)
            ?: context.filesDir
        val dir = File(baseDir, ALBUM).apply { if (!exists()) mkdirs() }
        val outFile = File(dir, name)

        val input: InputStream = context.contentResolver.openInputStream(source) ?: return null
        input.use { src ->
            FileOutputStream(outFile).use { out ->
                src.copyTo(out)
            }
        }
        return Uri.fromFile(outFile)
    }
}
