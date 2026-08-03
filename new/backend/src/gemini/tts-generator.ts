import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { randomInt } from '../utils/delay.js';
import { isTransientNetworkError, withRetry } from '../utils/retry.js';
import { generateGeminiTTS } from './gemini-tts.js';
import { getMediaDuration } from '../utils/media.js';
import type { SubtitleSegment } from '../types.js';

const execFileAsync = promisify(execFile);
const TTS_PROCESS_TIMEOUT_MS = 60_000;
const FFMPEG_MAX_BUFFER_BYTES = 10 * 1024 * 1024;
const MINIMUM_SPEECH_COVERAGE = 0.65;
// เป้าหมายช่วงเงียบท้ายคลิป: เดิม 1s ทำให้ dead air ยาว ~2s เมื่อบทสั้น
// ลดเหลือ 0.7s → preferred speech = secondsPerClip-0.7 ดันให้ atempo ยืดเสียงเติมช่องว่าง
//
// job_96 วัดจริง: เงียบคร่อมรอยต่อวินาทีที่ 8 ยาว 1.03s และเงียบท้ายคลิป 1.05s
// ช่วงเงียบท้ายของคลิปก่อนหน้าไปบวกกับช่วงเงียบนำของคลิปถัดไป → รอยต่อยิ่งโหว่
// ลดเหลือ 0.35s (ตามที่รีวิวขอ 0.2–0.4s) ทั้งรอยต่อกลางคลิปและหางท้ายเรื่องหดพร้อมกัน
const ENDING_PAUSE_SECONDS = 0.35;
const MINIMUM_ENDING_PAUSE_SECONDS = 0.25;
// job_129: หางเงียบ 0.35s ของคลิปกลางไปตกคร่อมรอยต่อพอดี วัดได้ 0.43s ที่วินาทีที่ 8
// เสียงหยุดตรงจังหวะที่ภาพเปลี่ยนพอดี = ฟังเหมือน "สะดุด" แม้ภาพจะต่อเนื่องดี
//
// หางท้ายเรื่องยังต้องมี 0.35s ไว้ให้จบสวย แต่รอยต่อ "กลางเรื่อง" ไม่ต้องการช่องหายใจ
// เพราะประโยคถัดไปมาต่อทันทีอยู่แล้ว → คลิปที่ไม่ใช่คลิปสุดท้ายใช้หางสั้นกว่า
//
// ⚠️ ห้ามไปบีบช่วงเงียบ "ระหว่างประโยค" เพิ่ม — job_96 พิสูจน์แล้วว่าบีบทุกช่วงเท่ากัน
// ทำให้จังหวะพูดแบนเหมือนหุ่นยนต์ ("รู้สึกแปลกๆ") แก้เฉพาะรอยต่อเท่านั้น
const SEAM_PAUSE_SECONDS = 0.15;
const MINIMUM_SEAM_PAUSE_SECONDS = 0.1;
const TEMPO_CHANGE_EPSILON = 0.01;
// ผ่อนเพดานล่าง tempo 0.9→0.82 (atempo คงระดับเสียง เปลี่ยนแค่จังหวะ)
// เพื่อยืดชิ้นเสียงที่สั้นให้เต็มคลิปได้มากขึ้นก่อนจะเหลือ dead air
const MINIMUM_NATURAL_TEMPO = 0.82;
const MAXIMUM_NATURAL_TEMPO = 1.1;
// ตัดชิ้นเสียงต่อคลิป: snap จุดตัดเข้าช่วงเงียบจริงได้ถ้าอยู่ในระยะนี้จากจุดตามสัดส่วน
const CLIP_SPLIT_SNAP_WINDOW_SECONDS = 1.2;

export interface TTSResult {
  audioPath: string;
  srtPath: string | null;
  voice: string;
}

/**
 * error ชั่วคราวที่ retry แล้วมีโอกาสผ่าน (เน็ตกระตุก/โดน rate limit/เซิร์ฟเวอร์ล่มชั่วครู่)
 *
 * job #69 พังทั้งงานเพราะเน็ตหลุดแค่แป๊บเดียว: Gemini TTS "fetch failed" แล้วถอยไป edge-tts
 * ซึ่ง ws_connect ไป Microsoft ก็ล้มพร้อมกัน → คลิปครบ 2 ตัวแล้วแต่จบงานไม่ได้ ต้องรอ 20 นาที
 * retry สั้นๆ ไม่กี่วินาทีช่วยให้รอดทันทีโดยไม่ต้องเสียรอบ
 */
// ใช้ตัวกลางใน utils/retry.ts — เดิมประกาศซ้ำที่นี่ที่เดียว ฝั่ง Gemini เลยไม่มี retry เลย
const isTransientTtsError = isTransientNetworkError;

function ensureOutputDirectory(outputPath: string): void {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
}

function removeFileIfPresent(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) fs.rmSync(filePath, { force: true });
  } catch {
    // Temporary-file cleanup must never hide the original result or error.
  }
}

/**
 * สร้างเสียงพากย์ภาษาไทยด้วย edge-tts (Microsoft Neural TTS)
 * ใช้ Python edge-tts package ผ่าน subprocess
 *
 * เสียงไทยที่รองรับ:
 * - th-TH-PremwadeeNeural (หญิง) — เสียงนุ่ม เป็นธรรมชาติ
 * - th-TH-NiwatNeural (ชาย) — เสียงทุ้ม ชัดเจน
 *
 * ติดตั้ง: pip install edge-tts
 */
async function generateTTS(
  text: string,
  outputPath: string,
  subtitlePath?: string,
  voice?: string,
  style?: string
): Promise<TTSResult> {
  // ── Gemini TTS เป็นค่าเริ่มต้น ──
  //
  // edge-tts พ่นข้อความรวดเดียวไม่มีจังหวะหยุด ฟังออกทันทีว่าเป็น AI
  // Gemini TTS สั่งอารมณ์ด้วยภาษาคนได้ (config.ttsStyle) เสียงเลยเป็นธรรมชาติกว่ามาก
  // ถ้า Gemini ล่ม/โควตาหมด → ถอยไป edge-tts อัตโนมัติ ดีกว่าปล่อยให้ job พังทั้งงาน
  if (config.ttsEngine === 'gemini') {
    try {
      const result = await withRetry(
        () => generateGeminiTTS(text, outputPath, voice, style),
        { maxRetries: 2, initialDelayMs: 2000, maxDelayMs: 8000, retryOn: isTransientTtsError }
      );
      return { audioPath: result.audioPath, srtPath: null, voice: result.voice };
    } catch (error: unknown) {
      logger.warn(
        `⚠️ Gemini TTS ล้มเหลว (${String(error instanceof Error ? error.message : error).slice(0, 90)}) — ถอยไปใช้ edge-tts`
      );
    }
  }

  // edge-tts ต่อ websocket ไป Microsoft — เน็ตกระตุกก็ล้มได้เหมือนกัน จึง retry ด้วย
  return withRetry(
    () => generateEdgeTTS(text, outputPath, subtitlePath, voice),
    { maxRetries: 2, initialDelayMs: 2000, maxDelayMs: 8000, retryOn: isTransientTtsError }
  );
}

/** อ่านช่วงเงียบจาก ffmpeg silencedetect → [{start,end}] วินาที */
async function detectSilences(audioPath: string): Promise<{ start: number; end: number }[]> {
  let stderr = '';
  try {
    const result = await execFileAsync(config.ffmpegPath, [
      '-hide_banner', '-nostats', '-i', audioPath,
      '-af', 'silencedetect=noise=-35dB:d=0.25', '-f', 'null', '-',
    ], { timeout: TTS_PROCESS_TIMEOUT_MS, maxBuffer: FFMPEG_MAX_BUFFER_BYTES });
    stderr = result.stderr || '';
  } catch (error: any) {
    stderr = String(error?.stderr || '');
  }
  const silences: { start: number; end: number }[] = [];
  let pendingStart: number | null = null;
  for (const line of stderr.split('\n')) {
    const startMatch = line.match(/silence_start:\s*(-?[\d.]+)/);
    const endMatch = line.match(/silence_end:\s*(-?[\d.]+)/);
    if (startMatch) pendingStart = parseFloat(startMatch[1]);
    else if (endMatch && pendingStart !== null) {
      silences.push({ start: pendingStart, end: parseFloat(endMatch[1]) });
      pendingStart = null;
    }
  }
  return silences;
}

/**
 * fit เสียงพูดหนึ่งชิ้นให้อยู่ในช่อง secondsPerClip: atempo เบาๆ แล้ว pad หางเงียบ
 *
 * isLastClip = false → เป็นรอยต่อกลางเรื่อง ใช้หางสั้นเพื่อไม่ให้เสียงหยุดตรงจุดที่ภาพตัด
 */
/**
 * ชิ้นเสียงยาวเท่านี้ ใส่ในช่องคลิปได้โดยไม่ต้องฝืนความเร็วเกินช่วงธรรมชาติหรือไม่
 *
 * ใช้ตอนเลือกจุดตัดระหว่างคลิป — จุดตัดที่ทำให้ฝั่งใดฝั่งหนึ่งหลุดช่วงนี้
 * จะถูก clamp แล้วเสียงสองครึ่งเร็วไม่เท่ากันจนได้ยินชัดตรงรอยต่อ (job_154)
 */
function fitsNaturalTempo(
  chunkSpeechSeconds: number,
  secondsPerClip: number,
  isLastClip: boolean
): boolean {
  const preferred = secondsPerClip - (isLastClip ? ENDING_PAUSE_SECONDS : SEAM_PAUSE_SECONDS);
  const maxSpeech = secondsPerClip
    - (isLastClip ? MINIMUM_ENDING_PAUSE_SECONDS : MINIMUM_SEAM_PAUSE_SECONDS);
  if (chunkSpeechSeconds <= 0) return false;
  return chunkSpeechSeconds >= preferred * MINIMUM_NATURAL_TEMPO
    && chunkSpeechSeconds <= maxSpeech * MAXIMUM_NATURAL_TEMPO;
}

function clipTempoFilter(
  chunkSpeechSeconds: number,
  secondsPerClip: number,
  isLastClip = true
): string {
  const preferred = secondsPerClip - (isLastClip ? ENDING_PAUSE_SECONDS : SEAM_PAUSE_SECONDS);
  const maxSpeech = secondsPerClip
    - (isLastClip ? MINIMUM_ENDING_PAUSE_SECONDS : MINIMUM_SEAM_PAUSE_SECONDS);
  const requestedTempo = chunkSpeechSeconds > maxSpeech
    ? chunkSpeechSeconds / maxSpeech
    : chunkSpeechSeconds < preferred
      ? chunkSpeechSeconds / preferred
      : 1;
  const tempo = Math.min(MAXIMUM_NATURAL_TEMPO, Math.max(MINIMUM_NATURAL_TEMPO, requestedTempo));
  return Math.abs(tempo - 1) > TEMPO_CHANGE_EPSILON ? `atempo=${tempo.toFixed(5)},` : '';
}

/**
 * สร้างเสียงพากย์แล้ว "จัดวางตามคลิป" ให้เสียงของคลิป i เริ่มตรงเส้น i×secondsPerClip
 *
 * ทำไมสังเคราะห์ครั้งเดียวก่อนตัด: เรียก TTS ทีละประโยคทำให้ได้น้ำเสียง/บุคลิก
 * ไม่คงที่ (เหมือนคนละคน) การสังเคราะห์รวดเดียวจึงคุมเสียงให้เป็นคนเดียวกัน
 *
 * แล้วค่อยตัดเป็นชิ้นต่อคลิปตามสัดส่วนความยาวข้อความ + snap จุดตัดเข้าช่วงเงียบจริง
 * (กันตัดกลางคำ) จากนั้น pad แต่ละชิ้นให้ครบ secondsPerClip แล้วต่อกัน
 *
 * แก้บั๊กเดิม: โค้ดเก่า join บททั้งหมดเป็นเสียงต่อเนื่องแล้วเติมเงียบ "ท้ายก้อนเดียว"
 * → เสียงคลิป 2 มาก่อนภาพ + dead air ยาวช่วงท้าย (เสียงไม่ตรงภาพ)
 */
export async function generateContinuousNarrationTTS(
  segments: SubtitleSegment[],
  outputPath: string,
  secondsPerClip: number = config.videoDurationSeconds
): Promise<TTSResult & { srtPath: null }> {
  if (!segments.length) throw new Error('ไม่มีช่วงบทพากย์สำหรับสร้างเสียง');
  ensureOutputDirectory(outputPath);
  const stem = outputPath.replace(/\.\w+$/, '');
  const rawPath = `${stem}_continuous_raw.mp3`;
  const clipCount = segments.length;
  const targetDuration = clipCount * secondsPerClip;
  const clipAudioPaths: string[] = [];

  try {
    const texts = segments.map((segment) => segment.text.replace(/\s+/g, ' ').trim());
    // สังเคราะห์รวดเดียว → คุมให้เป็นเสียงคนเดียวกันตลอดเรื่อง
    const source = await generateTTS(texts.join(' '), rawPath);
    const speechDuration = await getMediaDuration(source.audioPath);
    if (speechDuration < targetDuration * MINIMUM_SPEECH_COVERAGE) {
      throw new Error(
        `บทพากย์สั้นเกินไป (${speechDuration.toFixed(1)}s) สำหรับวิดีโอ ${targetDuration}s — ต้องสร้างบทให้ยาวขึ้นก่อนประกอบ`
      );
    }

    // จุดตัดระหว่างคลิป = ตำแหน่งตามสัดส่วนความยาวข้อความ snap เข้าช่วงเงียบจริงที่ใกล้สุด
    const silences = await detectSilences(source.audioPath);
    const totalChars = texts.reduce((sum, text) => sum + [...text].length, 0) || 1;
    let cumulativeChars = 0;
    const splitTimes: number[] = [];
    for (let index = 0; index < clipCount - 1; index++) {
      cumulativeChars += [...texts[index]].length;
      const proportional = speechDuration * (cumulativeChars / totalChars);
      let chosen = proportional;
      let bestDistance = Infinity;
      const previousBound = splitTimes[index - 1] ?? 0;
      for (const silence of silences) {
        const mid = (silence.start + silence.end) / 2;
        if (mid <= 0.3 || mid >= speechDuration - 0.3) continue; // ข้ามเงียบต้น/ท้าย
        const distance = Math.abs(mid - proportional);
        if (distance >= bestDistance || distance > CLIP_SPLIT_SNAP_WINDOW_SECONDS) continue;
        // 🐛 job_154: จุดตามสัดส่วนอยู่ที่ 7.14s แต่มีช่วงเงียบที่ 6.2s อยู่ในระยะ snap
        // ตัวเลือกเดิมดูแค่ "ใกล้ที่สุด" เลยเลือก 6.2 → คลิป 1 เหลือเสียงพูด 6.2s ต้องยืดเป็น 8s
        // = tempo 0.79 ซึ่งต่ำกว่าเพดานล่าง 0.82 จึงถูก clamp แล้วเสียงครึ่งแรกช้าลง 18%
        // ส่วนคลิป 2 ได้ 8.0s ถูกเร่งขึ้น 3% → ต่างกัน 21% คร่อมรอยต่อวินาทีที่ 8
        // เจ้าของฟังแล้วบอกว่า "เสียงแปลกๆ" — ครึ่งแรกอืด แล้วจู่ๆ เร็วขึ้น
        //
        // snap ได้ต่อเมื่อ "ทั้งสองฝั่ง" ยังปรับความเร็วได้ในช่วงธรรมชาติ ไม่ใช่แค่ใกล้
        if (!fitsNaturalTempo(mid - previousBound, secondsPerClip, false)) continue;
        if (!fitsNaturalTempo(speechDuration - mid, secondsPerClip, index === clipCount - 2)) continue;
        bestDistance = distance;
        chosen = mid;
      }
      splitTimes.push(chosen);
    }
    // ตัดเงียบนำหน้าออก: ถ้า Gemini TTS ใส่ช่วงเงียบเริ่มที่ ~0 เสียงเปิดเรื่องจะหน่วง
    // → เริ่มคลิปแรกที่จุดพูดจริง (เว้น lead-in สั้นๆ 0.1s กันเปิดห้วนเกิน)
    const leadingSilence = silences.find((silence) => silence.start <= 0.05);
    const speechStart = leadingSilence ? Math.max(0, leadingSilence.end - 0.1) : 0;
    const bounds = [speechStart, ...splitTimes, speechDuration];

    // ตัดชิ้นเสียงต่อคลิป → fit tempo → pad ให้ครบ secondsPerClip ต่อชิ้น
    for (let index = 0; index < clipCount; index++) {
      const from = bounds[index];
      const to = bounds[index + 1];
      const clipPath = `${stem}_clip${index}.mp3`;
      const tightPath = `${stem}_tight${index}.mp3`;
      clipAudioPaths.push(tightPath);

      // ── รอบ 1: ตัดชิ้น แล้วตัดเฉพาะ "ช่วงเงียบผิดปกติ" ทิ้ง ──
      // job_83: TTS แถมเงียบเองท้ายประโยค 1.2s และหยุดกลางประโยค 0.46s ("เว้นวรรคแปลก")
      // ความยาวชิ้น (to-from) จึงรวมเงียบพวกนี้ไปด้วย → clipTempoFilter คิดว่าพูดยาวพอแล้ว
      // เลยไม่ยืดเสียง สุดท้ายเหลือหางเงียบยาวเหมือนเดิม ต้องตัดเงียบทิ้งก่อนวัด
      // job_96: เวอร์ชันแรกบีบ "ทุก" ช่วงเงียบ ≥0.22s เหลือ 0.16s เท่ากันหมด → จังหวะพูด
      // แบนราบเหมือนหุ่นยนต์รีบพูด ("รู้สึกแปลกๆ") เพราะคนจริงเว้นสั้นยาวไม่เท่ากัน
      // แก้: แตะเฉพาะช่วงเงียบยาวผิดธรรมชาติ (≥0.45s) แล้วเหลือไว้ 0.35s ให้ยังหายใจเป็นคน
      // ส่วนช่วงเว้นสั้นตามจังหวะพูดจริง ปล่อยผ่านทั้งหมด และผ่อน threshold เป็น -40dB
      // กัน silenceremove กินหางเสียงลมท้ายคำ (ค่ะ/ครับ) จนคำฟังขาดห้วน
      await execFileAsync(config.ffmpegPath, [
        '-i', source.audioPath,
        '-af', `atrim=${from.toFixed(3)}:${to.toFixed(3)},asetpts=PTS-STARTPTS,`
          + 'silenceremove=start_periods=1:start_threshold=-40dB:start_silence=0.04'
          + ':stop_periods=-1:stop_threshold=-40dB:stop_duration=0.45:stop_silence=0.35',
        '-ar', '44100', '-ac', '2', '-c:a', 'libmp3lame', '-q:a', '2', '-y', clipPath,
      ], { timeout: TTS_PROCESS_TIMEOUT_MS, maxBuffer: FFMPEG_MAX_BUFFER_BYTES });

      // ── รอบ 2: วัดความยาว "เสียงพูดจริง" แล้วค่อยยืด/บีบให้เต็มช่อง + เติมหางเงียบคงที่ ──
      const rawChunk = Math.max(0.1, to - from);
      let tightSpeech = await getMediaDuration(clipPath);
      // กันเคสเสียงเบาผิดปกติจน silenceremove กินเนื้อเสียงไปด้วย (วัดจริง job_83 เหลือ 88% = ปกติ)
      // ถ้าหดเกินครึ่ง แปลว่า threshold ไม่เหมาะกับเสียงนี้ → กลับไปใช้ชิ้นดิบ ดีกว่าได้คลิปเงียบ
      const tooAggressive = tightSpeech < rawChunk * 0.5;
      if (tooAggressive) {
        logger.warn(
          `⚠️ ตัดเงียบคลิป ${index + 1} หดผิดปกติ (${tightSpeech.toFixed(1)}s จาก ${rawChunk.toFixed(1)}s) — ใช้เสียงดิบแทน`
        );
        tightSpeech = rawChunk;
      }
      const tempoFilter = clipTempoFilter(
        Math.max(0.1, tightSpeech),
        secondsPerClip,
        index === clipCount - 1
      );
      // fallback ต้องตัดช่วงเดิมจากไฟล์ต้นทางด้วย ไม่งั้นจะได้เสียงทั้งก้อนมาทับคลิปนี้
      const [tightInput, tightPrefix] = tooAggressive
        ? [source.audioPath, `atrim=${from.toFixed(3)}:${to.toFixed(3)},asetpts=PTS-STARTPTS,`]
        : [clipPath, ''];
      await execFileAsync(config.ffmpegPath, [
        '-i', tightInput,
        '-af', `${tightPrefix}${tempoFilter}apad=whole_dur=${secondsPerClip},atrim=0:${secondsPerClip}`,
        '-ar', '44100', '-ac', '2', '-c:a', 'libmp3lame', '-q:a', '2', '-y', tightPath,
      ], { timeout: TTS_PROCESS_TIMEOUT_MS, maxBuffer: FFMPEG_MAX_BUFFER_BYTES });
      removeFileIfPresent(clipPath);
    }

    // ต่อชิ้นต่อคลิป → เสียงคลิป i เริ่มตรงเส้น i×secondsPerClip พอดี
    const concatFilter = clipAudioPaths.map((_, index) => `[${index}:a]`).join('')
      + `concat=n=${clipCount}:v=0:a=1[a]`;
    await execFileAsync(config.ffmpegPath, [
      ...clipAudioPaths.flatMap((clipPath) => ['-i', clipPath]),
      '-filter_complex', concatFilter, '-map', '[a]',
      '-ar', '44100', '-ac', '2', '-c:a', 'libmp3lame', '-q:a', '2', '-y', outputPath,
    ], { timeout: TTS_PROCESS_TIMEOUT_MS, maxBuffer: FFMPEG_MAX_BUFFER_BYTES });

    logger.info(
      `✅ เสียงพากย์จัดตามคลิป ${clipCount}×${secondsPerClip}s (พูด ${speechDuration.toFixed(1)}s, ตัดที่ ${splitTimes.map((t) => t.toFixed(1)).join(', ') || '-'})`
    );
    return { audioPath: outputPath, srtPath: null, voice: source.voice };
  } finally {
    removeFileIfPresent(rawPath);
    clipAudioPaths.forEach(removeFileIfPresent);
  }
}

/** เสียงพากย์ด้วย edge-tts (ของเดิม — ฟรีแต่ฟังเป็นหุ่นยนต์กว่า) */
async function generateEdgeTTS(
  text: string,
  outputPath: string,
  subtitlePath?: string,
  voice?: string
): Promise<TTSResult> {
  // สุ่มเสียงชาย/หญิง ถ้าไม่ได้ระบุ
  const selectedVoice =
    voice || config.ttsVoices[randomInt(0, config.ttsVoices.length - 1)];

  const voiceLabel = selectedVoice.includes('Premwadee') ? '👩 หญิง' : '👨 ชาย';
  logger.info(`🗣️ TTS: ${voiceLabel} (${selectedVoice})`);

  // สร้างโฟลเดอร์ output
  ensureOutputDirectory(outputPath);

  // สร้าง subtitle path ถ้าไม่ได้ระบุ
  const srtPath =
    subtitlePath || outputPath.replace(/\.\w+$/, '.srt');

  try {
    // เรียก edge-tts ผ่าน Python
    const args = [
      '-m', 'edge_tts',
      '--voice', selectedVoice,
      '--rate', config.ttsRate,
      '--text', text,
      '--write-media', outputPath,
      '--write-subtitles', srtPath,
    ];

    await execFileAsync('python', args, {
      timeout: TTS_PROCESS_TIMEOUT_MS,
    });

    // ตรวจสอบว่าไฟล์สร้างเสร็จ
    if (!fs.existsSync(outputPath)) {
      throw new Error(`ไฟล์เสียงไม่ถูกสร้าง: ${outputPath}`);
    }

    const fileSize = fs.statSync(outputPath).size;
    logger.info(`✅ TTS สำเร็จ: ${outputPath} (${(fileSize / 1024).toFixed(1)} KB)`);

    return {
      audioPath: outputPath,
      srtPath: fs.existsSync(srtPath) ? srtPath : null,
      voice: selectedVoice,
    };
  } catch (error: any) {
    // ถ้า edge-tts ไม่ได้ติดตั้ง — แนะนำติดตั้ง
    if (
      error?.message?.includes('ENOENT') ||
      error?.message?.includes('not found') ||
      error?.message?.includes('No module named')
    ) {
      logger.error('❌ ไม่พบ edge-tts — ต้องติดตั้งก่อน:');
      logger.error('   pip install edge-tts');
      logger.error('   หรือ: python -m pip install edge-tts');
    }
    throw error;
  }
}

/**
 * สร้างไฟล์ SRT (SubRip Subtitle) จาก subtitle segments ของ Gemini
 *
 * ทำไมไม่ใช้ .srt ที่ edge-tts สร้างให้?
 * — edge-tts แบ่งซับด้วย word boundary ซึ่ง "ใช้กับภาษาไทยไม่ได้"
 *   (ไทยไม่เว้นวรรคระหว่างคำ) ผลคือได้ซับก้อนเดียวยาวคลุมทั้งคลิป อ่านไม่ไหว
 * — Gemini แบ่งข้อความเป็นช่วงสั้นๆ อ่านง่ายกว่ามาก
 *
 * แต่ไทม์ของ Gemini เป็นการ "เดา" (มันไม่รู้ว่า TTS จะพูดจบตอนไหน)
 * เลยต้องยืด/หดไทม์ให้ตรงกับความยาวเสียงจริง ผ่าน actualDurationSec
 *
 * @param actualDurationSec ความยาวจริงของไฟล์เสียง TTS — ถ้าใส่มาจะ rescale ไทม์ให้ตรงเสียง
 */
export function generateSRT(
  segments: { text: string; startSec: number; endSec: number }[],
  outputPath: string,
  actualDurationSec?: number
): string {
  ensureOutputDirectory(outputPath);

  const scaled = rescaleSegments(segments, actualDurationSec);

  const srtContent = scaled
    .map((seg, i) => {
      const start = formatSRTTime(seg.startSec);
      const end = formatSRTTime(seg.endSec);
      const text = wrapSubtitleText(seg.text, config.subtitleMaxCharsPerLine);
      return `${i + 1}\n${start} --> ${end}\n${text}\n`;
    })
    .join('\n');

  fs.writeFileSync(outputPath, srtContent, 'utf-8');
  logger.info(`📝 SRT สร้างเสร็จ: ${outputPath} (${scaled.length} segments)`);
  return outputPath;
}

/**
 * สระ/วรรณยุกต์ไทย — พวกนี้ "กว้าง 0" เพราะซ้อนอยู่บน/ล่างพยัญชนะ ไม่กินที่แนวนอน
 * (วัดจากของจริง: "ใครทีอยากได้ชาไทย" นับได้ 17 ตัว แต่กินที่จริงแค่ 15)
 */
const THAI_COMBINING = /[ัิ-ฺ็-๎]/;

/**
 * แตกข้อความเป็น cluster — พยัญชนะ 1 ตัว + สระ/วรรณยุกต์ที่เกาะอยู่ = 1 cluster
 *
 * 1 cluster = 1 ช่องความกว้าง ทำให้นับความกว้างบรรทัดได้ตรงกว่านับตัวอักษรดิบ
 * และได้ผลพลอยได้คือตัดบรรทัดตรงไหนก็ไม่มีทางทำสระหลุดจากพยัญชนะ
 */
function toClusters(text: string): string[] {
  const clusters: string[] = [];

  for (const ch of text) {
    if (clusters.length > 0 && THAI_COMBINING.test(ch)) {
      clusters[clusters.length - 1] += ch;
    } else {
      clusters.push(ch);
    }
  }

  return clusters;
}

/**
 * ตัดข้อความไทยเป็น "คำ" ด้วยพจนานุกรมไทยของ ICU ที่ติดมากับ Node
 *
 * ภาษาไทยไม่เว้นวรรคระหว่างคำ การ split(/\s+/) เลยได้ก้อนยาวก้อนเดียว
 * ถ้าหั่นก้อนนั้นตามจำนวนตัวอักษรดื้อๆ จะตัดกลางคำ ("ส่ง" → "ส" + "ง")
 * Intl.Segmenter รู้ขอบคำไทยจริง เลยตัดได้ตรงรอยต่อคำ โดยไม่ต้องลง lib เพิ่ม
 */
function segmentWords(text: string): string[] {
  try {
    const segmenter = new Intl.Segmenter('th', { granularity: 'word' });
    return [...segmenter.segment(text)].map((s) => s.segment);
  } catch {
    // ถ้า runtime ไม่มี ICU ไทย — ถอยไปใช้เว้นวรรคธรรมดา
    return text.split(/(\s+)/).filter(Boolean);
  }
}

/**
 * ตัดบรรทัดซับเอง — libass ตัดบรรทัดภาษาไทยไม่ได้ (ไทยไม่เว้นวรรคระหว่างคำ)
 * ถ้าปล่อยไว้ ซับจะทะลุออกนอกเฟรม ตัวหนังสือหายทั้งซ้ายและขวา
 *
 * @param maxChars จำนวน cluster สูงสุดต่อบรรทัด
 */
function wrapSubtitleText(text: string, maxChars: number): string {
  const units = segmentWords(text.trim());
  const lines: string[] = [];
  let current = '';
  let currentLen = 0;

  const flush = () => {
    const trimmed = current.trim();
    if (trimmed) lines.push(trimmed);
    current = '';
    currentLen = 0;
  };

  for (const unit of units) {
    const unitLen = toClusters(unit).length;

    // คำเดียวยาวเกินบรรทัด (คำประสมยาวมาก) — จำเป็นต้องตัดกลางคำ
    // หั่นให้ทุกบรรทัดยาวใกล้เคียงกัน แทนการอัดเต็มบรรทัดแรกแล้วปล่อยเศษ
    // ไม่งั้นจะได้ตัวอักษรห้อยเดี่ยวบรรทัดล่าง (13 ตัว เพดาน 12 → 12+1)
    if (unitLen > maxChars) {
      flush();
      const clusters = toClusters(unit);
      const lineCount = Math.ceil(clusters.length / maxChars);
      const perLine = Math.ceil(clusters.length / lineCount);
      for (let i = 0; i < clusters.length; i += perLine) {
        lines.push(clusters.slice(i, i + perLine).join(''));
      }
      continue;
    }

    if (currentLen + unitLen > maxChars) {
      flush();
      // อย่าขึ้นบรรทัดใหม่ด้วยช่องว่าง
      if (/^\s+$/.test(unit)) continue;
    }

    current += unit;
    currentLen += unitLen;
  }

  flush();
  return lines.join('\n');
}

/**
 * ยืด/หดไทม์ซับให้พอดีกับความยาวเสียงจริง (คงสัดส่วนเดิมของแต่ละช่วง)
 */
function rescaleSegments(
  segments: { text: string; startSec: number; endSec: number }[],
  actualDurationSec?: number
): { text: string; startSec: number; endSec: number }[] {
  if (!actualDurationSec || segments.length === 0) return segments;

  const guessedEnd = Math.max(...segments.map((s) => s.endSec));
  if (!Number.isFinite(guessedEnd) || guessedEnd <= 0) return segments;

  const scale = actualDurationSec / guessedEnd;
  logger.info(
    `⏱️ ปรับไทม์ซับ: Gemini เดา ${guessedEnd.toFixed(1)}s → เสียงจริง ${actualDurationSec.toFixed(1)}s (×${scale.toFixed(2)})`
  );

  return segments.map((s) => ({
    text: s.text,
    startSec: Math.round(s.startSec * scale * 1000) / 1000,
    endSec: Math.round(s.endSec * scale * 1000) / 1000,
  }));
}

/** Format วินาที → SRT timestamp (HH:MM:SS,mmm) */
function formatSRTTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.round((seconds % 1) * 1000);
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad3(ms)}`;
}

function pad(n: number): string {
  return n.toString().padStart(2, '0');
}

function pad3(n: number): string {
  return n.toString().padStart(3, '0');
}
