import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { randomInt } from '../utils/delay.js';

const execFileAsync = promisify(execFile);

/**
 * สร้างเสียงพากย์ด้วย Gemini TTS
 *
 * ทำไมถึงเลิกใช้ edge-tts เป็นค่าเริ่มต้น:
 * - edge-tts พ่นข้อความรวดเดียวจบ ไม่มีจังหวะหยุดหายใจ → ฟังออกทันทีว่าเป็น AI
 *   (วัดจริง: ประโยคเดียวกัน edge-tts 8 วิ / Gemini 12-14 วิ = Gemini เว้นจังหวะแบบคนพูด)
 * - Gemini TTS "สั่งอารมณ์ด้วยภาษาคนได้" เช่น "พูดแบบตื่นเต้น เหมือนเล่าให้เพื่อนฟัง"
 *   ซึ่ง edge-tts ทำไม่ได้เลย ปรับได้แค่ rate/pitch ซึ่งไม่ช่วยเรื่องความเป็นธรรมชาติ
 *
 * ⚠️ Gemini TTS ไม่มีโมเดลตระกูล 3.5 — ต้องใช้โมเดล TTS แยกต่างหาก
 *    ตัวใหม่สุดที่ใช้ได้คือ gemini-3.1-flash-tts-preview
 */
export async function generateGeminiTTS(
  text: string,
  outputPath: string,
  voice?: string,
  style: string = config.ttsStyle
): Promise<{ audioPath: string; voice: string }> {
  const selectedVoice =
    voice || config.geminiTtsVoices[randomInt(0, config.geminiTtsVoices.length - 1)];

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  logger.info(`🗣️ Gemini TTS: ${selectedVoice} (${config.geminiTtsModel})`);

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${config.geminiTtsModel}:generateContent?key=${config.geminiApiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        // คำสั่งอารมณ์ต้องนำหน้าบท — นี่คือหัวใจที่ทำให้เสียงไม่เหมือนอ่านข่าว
        contents: [{ parts: [{ text: `${style}\n\n${text}` }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: selectedVoice } },
          },
        },
      }),
      signal: AbortSignal.timeout(120_000),
    }
  );

  const data: any = await response.json();
  if (!response.ok) {
    throw new Error(
      `Gemini TTS ตอบ ${response.status}: ${JSON.stringify(data).slice(0, 200)}`
    );
  }

  const inline = data?.candidates?.[0]?.content?.parts?.[0]?.inlineData;
  if (!inline?.data) {
    throw new Error(`Gemini TTS ไม่ส่งเสียงกลับมา: ${JSON.stringify(data).slice(0, 200)}`);
  }

  // Gemini คืน PCM ดิบ (audio/l16) ต้องแปลงเป็น mp3 เอง
  // sample rate อ่านจาก mimeType เช่น "audio/l16; rate=24000; channels=1"
  const rate = /rate=(\d+)/.exec(inline.mimeType || '')?.[1] || '24000';
  const channels = /channels=(\d+)/.exec(inline.mimeType || '')?.[1] || '1';
  const pcmPath = outputPath.replace(/\.\w+$/, '.pcm');
  fs.writeFileSync(pcmPath, Buffer.from(inline.data, 'base64'));

  try {
    await execFileAsync(
      config.ffmpegPath,
      ['-f', 's16le', '-ar', rate, '-ac', channels, '-i', pcmPath, '-b:a', '192k', '-y', outputPath],
      { timeout: 60000 }
    );
  } finally {
    try { fs.unlinkSync(pcmPath); } catch { /* ไม่เป็นไร */ }
  }

  if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size < 1024) {
    throw new Error(`แปลงเสียง Gemini TTS เป็น mp3 ไม่สำเร็จ: ${outputPath}`);
  }

  const sizeKb = (fs.statSync(outputPath).size / 1024).toFixed(1);
  logger.info(`✅ Gemini TTS สำเร็จ: ${outputPath} (${sizeKb} KB)`);
  return { audioPath: outputPath, voice: selectedVoice };
}
