import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import type { AppConfig } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`❌ Missing required env variable: ${name}`);
  }
  return value;
}

function optional(name: string, defaultValue: string): string {
  return process.env[name] || defaultValue;
}

function optionalInt(name: string, defaultValue: number): number {
  const val = process.env[name];
  return val ? parseInt(val, 10) : defaultValue;
}

function optionalFloat(name: string, defaultValue: number): number {
  const val = process.env[name];
  return val ? parseFloat(val) : defaultValue;
}

function optionalBool(name: string, defaultValue: boolean): boolean {
  const value = process.env[name];
  if (value === undefined) return defaultValue;
  return /^(?:1|true|yes|on)$/i.test(value.trim());
}

/**
 * ตัวสร้างเสียงพากย์: 'gemini' (ธรรมชาติกว่ามาก) หรือ 'edge' (ของเดิม ฟรี)
 *
 * edge-tts พ่นข้อความรวดเดียวไม่มีจังหวะหยุด → ฟังออกว่าเป็น AI ทันที
 * (วัดจริง: ประโยคเดียวกัน edge 8 วิ / Gemini 12-14 วิ = Gemini เว้นวรรคแบบคนพูด)
 */
const ttsEngine = optional('TTS_ENGINE', 'gemini') as 'gemini' | 'edge';

/**
 * โมเดล TTS ของ Gemini
 * ⚠️ ไม่มีตระกูล 3.5 สำหรับ TTS — ต้องใช้โมเดล TTS แยก ตัวใหม่สุดคือ 3.1-flash-tts
 */
const geminiTtsModel = optional('GEMINI_TTS_MODEL', 'gemini-3.1-flash-tts-preview');

/**
 * เสียงของ Gemini TTS — default เป็น Aoede เสียงเดียว (ลูกค้าอนุมัติเสียงนี้)
 * ตั้งได้หลายเสียงคั่น comma ผ่าน env GEMINI_TTS_VOICES แล้วระบบจะสุ่มเลือก
 * แต่ default ตั้งใจให้ pin ตัวเดียว เพื่อให้ทุกงานได้เสียงมาตรฐานที่ลูกค้าชอบ ไม่ใช่สุ่มเสี่ยง
 */
const geminiTtsVoices = optional('GEMINI_TTS_VOICES', 'Aoede')
  .split(',')
  .map((v) => v.trim())
  .filter((voice) => /^Aoede$/i.test(voice))
  .concat(['Aoede'])
  .filter((voice, index, voices) => voices.indexOf(voice) === index);

/**
 * คำสั่งอารมณ์ที่ส่งนำหน้าบทพากย์ — จุดชี้ขาดว่าเสียงจะเหมือนคนหรือเหมือนอ่านข่าว
 * edge-tts ทำแบบนี้ไม่ได้ ปรับได้แค่ความเร็ว/ระดับเสียง
 */
const ttsStyle = optional(
  'TTS_STYLE',
  'พูดเหมือนคนไทยกำลังถือสินค้ารีวิวให้เพื่อนดูแบบถ่ายมือถือ น้ำเสียงจริงใจ เป็นกันเอง และไม่ปรุงแต่งเกินจริง ' +
    'อย่าอ่านเป็นจังหวะสม่ำเสมอแบบ AI ให้มีน้ำหนักคำและความเร็วเปลี่ยนเล็กน้อยตามความหมาย ' +
    'พูดต่อเนื่องเหมือนประโยคเดียวกัน หยุดหายใจสั้นเฉพาะจุดจบประโยค ไม่เว้นช่วงเงียบระหว่างช็อต ' +
    'ไม่พูดรวบ ไม่ลากเสียง ไม่เติมคำติดปากทุกประโยค ไม่ทำเสียงผู้ประกาศ และไม่ใช้น้ำเสียงโฆษณา:'
);

const subtitleFontsize = optionalInt('SUBTITLE_FONTSIZE', 24);

/**
 * ความดังของ "เสียงบรรยากาศที่ Veo แถมมาในคลิป" ที่จะผสมใต้เสียงพากย์
 *
 * Veo ใส่เสียง foley มาให้จริง (เสียงช้อน เสียงหยิบของ เสียงห้อง) — วัดได้ ~-24.7 dB
 * เดิมโค้ดตัดทิ้งหมดด้วย -an เหลือแต่ TTS ลอยบนความเงียบสนิท → ฟังปลอมทันที
 * ผสมกลับเข้าไปเบาๆ ช่วยให้คลิปฟังเหมือนถ่ายจริง
 */
const ambienceVolume = optionalFloat('AMBIENCE_VOLUME', 0.28);

/**
 * ความดังเป้าหมายของคลิปสุดท้าย (LUFS)
 *
 * TikTok/IG/YouTube normalize ที่ประมาณ -14 LUFS
 * ถ้าส่งไปเบากว่านี้ คลิปเราจะเสียงเบากว่าคนอื่นเห็นๆ (วัดของเดิมได้ -18.5 LUFS)
 */
const targetLufs = optionalFloat('TARGET_LUFS', -14);

/**
 * เบิร์นซับลงคลิปไหม (ค่าเริ่มต้น: ไม่)
 *
 * บทที่ Gemini เขียนถูกใช้เป็น "เสียงพากย์" เป็นหลัก
 * การเบิร์นซับทับไปด้วยจะบังสินค้าและดูรก — เปิดเมื่อต้องการเท่านั้น
 */
const subtitleBurnIn = optionalBool('SUBTITLE_BURN_IN', false);

/**
 * จำนวน cluster สูงสุดต่อบรรทัดซับ (1 cluster = พยัญชนะ + สระที่เกาะ = 1 ช่อง)
 *
 * ต้องตัดบรรทัดเอง เพราะภาษาไทยไม่เว้นวรรคระหว่างคำ libass เลยหาจุดตัดไม่ได้
 * → บรรทัดยาวทะลุออกนอกเฟรม ตัวหนังสือหายทั้งซ้ายขวา
 *
 * ค่าที่ใช้วัดจากการ render จริงบนคลิป 9:16 กว้าง 720:
 *   - FontSize 24 → ตัวกว้างสุด (ญ ฒ ณ) 13 ตัวก็ล้นแล้ว → ~2.2 × FontSize ต่อ cluster
 *   - หักอีก 8% กันขอบ เพราะความกว้างแต่ละตัวไม่เท่ากัน
 */
const CLIP_WIDTH_PX = 720;
const THAI_CLUSTER_WIDTH_RATIO = 2.2;
const autoMaxChars = Math.max(
  8,
  Math.floor(
    (CLIP_WIDTH_PX / (subtitleFontsize * THAI_CLUSTER_WIDTH_RATIO)) * 0.92
  )
);

export const config: AppConfig = {
  // Database
  databaseUrl: required('DATABASE_URL'),

  // Gemini
  geminiApiKey: required('GEMINI_API_KEY'),
  geminiModel: optional('GEMINI_MODEL', 'gemini-3.5-flash'),

  /**
   * เพดาน thinking token (0 = ปิด thinking)
   *
   * ต้องล็อกไว้! เพราะ thinking กินโควตารวมกับ maxOutputTokens และแกว่งมาก
   * (วัดจริง: 1,753 → 15,725 tokens กับ prompt เดียวกัน) ถ้าไม่ล็อก
   * บาง job thinking จะกินหมดจนคำตอบถูกตัดกลาง แล้ว JSON.parse พัง
   */
  geminiThinkingBudget: optionalInt('GEMINI_THINKING_BUDGET', 2048),

  // Chrome
  chromeDebugPorts: optional('CHROME_DEBUG_PORTS', '9222,9223,9224,9225,9226')
    .split(',')
    .map((p) => parseInt(p.trim(), 10)),
  chromeExecutable: optional(
    'CHROME_EXECUTABLE',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  ),

  // ⛔ ไม่มี maxConcurrentWorkers / delayBetweenJobs / delayBetweenActions / typingDelay แล้ว
  // ทั้งหมดเหลือจากยุค Puppeteer หลาย worker — Extension เป็นตัวคุมคิวและมีบอทตัวเดียวเสมอ
  // maxConcurrentWorkers ลบไปแล้ว 30 ก.ค. 2026 พร้อมคอมเมนต์ว่า "ตั้งใน .env แล้วไม่มีผลอะไรเลย"
  // แต่อีกสามตัวถูกลืมไว้ ทั้งที่เป็นอาการเดียวกันเป๊ะ (ลบ 1 ส.ค. 2026)
  //
  // ⚠️ จังหวะพักจริงอยู่ใน `extension/background.js` ไม่ได้อยู่ที่นี่ — ถ้าจะปรับเวลาพัก
  // ระหว่างงานหรือความเร็วพิมพ์ ต้องไปแก้ตรงนั้น ตั้ง DELAY_BETWEEN_JOBS_MIN / TYPING_DELAY_MIN
  // ใน .env ไม่มีผลใดๆ ทั้งสิ้น

  // Flow
  flowUrl: optional('FLOW_URL', 'https://labs.google/fx/tools/flow'),
  // Credit safety lock: generation must be deliberately enabled.
  flowGenerationEnabled: optionalBool('FLOW_GENERATION_ENABLED', false),
  // kill-switch ฟีเจอร์ End-frame (Frames Start+End) — DEFAULT ON (เจ้าของยังอยากให้เทสต์จริง)
  // ถ้าอยากปิดชั่วคราวเพื่อกลับพฤติกรรมก่อน End-frame: END_FRAME_ENABLED=false
  endFrameEnabled: optionalBool('END_FRAME_ENABLED', true),
  // วิธี A: แนบรูปสินค้าทางการ "หลายมุม" เป็น reference เพิ่มตอนเจนเฟรมต้น
  // (เสริมวิธี B/End-frame) ให้โมเดลเห็นสินค้าหลายด้าน → รูปแม่นขึ้น → คลิปวาร์ปน้อยลง
  // ปิดได้ทันทีถ้าผลไม่ดี: REFERENCE_IMAGES_ENABLED=false
  referenceImagesEnabled: optionalBool('REFERENCE_IMAGES_ENABLED', true),
  // จำนวนรูปมุมเสริม/ส่วนผสม (ไม่นับรูปหลักที่ Gemini เลือก) — เจ้าของขอ 3 รูป (27 ก.ค. 2026)
  referenceImageCount: optionalInt('REFERENCE_IMAGE_COUNT', 3),
  /**
   * จำนวนรูปทางการที่แนบเป็น "ส่วนผสม" ตอนเจนคลิป 1 — ตั้ง 0 เพื่อใช้รูปเดียว
   *
   * 🐛 job_158 (หูฟังบลูทูธ): คลิป 2 เปลี่ยนหูฟังจีนมีไฟ RGB หนึ่งข้าง เป็น AirPods สองข้าง
   * ตอนแรกผมสรุปว่าโมเดลมีอคติไปทาง AirPods — ผิด เจ้าของถามว่าเคยลองใช้รูปเดียวไหม
   * ผมเลยไปเปิดดูรูปส่วนผสมที่เราส่งเข้าไปเอง `official_candidate_2.jpg` **คือรูปสต็อก
   * AirPods ของแท้** มีก้าน มีตัวอักษร R ครบ เราหยิบมาแนบเองแล้วบอกว่า "สินค้าตัวเดียวกัน"
   *
   * ⚠️ ประโยคกำกับที่มีอยู่กันไม่ได้ เพราะมันเขียนว่า "ใบอื่นเอาไว้ดู **รูปทรงกับสี**"
   * ซึ่งสำหรับเคสนี้รูปทรงคือสิ่งที่ผิดพอดี — ประโยคนั้นเขียนตอน job_152 เพื่อกันเรื่องฉลาก
   *
   * ⚠️ ห้ามตั้งเป็น 0 ถาวรโดยไม่เทียบก่อน — รูปทางการเคยช่วยจริงใน job_156 (รูปรีวิวมีนิ้ว
   * บังคำว่า SAKURA MUSE ครึ่งคำ รูปทางการเข้าไปเติมให้จนฉลากออกมาครบ)
   * ปัญหาอยู่ที่ "รูปทางการบางตัวเป็นของยี่ห้ออื่น" ไม่ใช่ที่ตัวความคิดเรื่องส่วนผสม
   */
  ingredientReferenceCount: optionalInt('INGREDIENT_REFERENCE_COUNT', 3),
  // แหล่งรูปของ "เฟรมตั้งต้น": review = รูปถ่ายจริงจากรีวิว (ค่าเริ่มต้นตามที่เจ้าของสั่ง),
  // official = รูปทางการจาก Shopee ซึ่งมักเป็นแบนเนอร์โฆษณามีตัวหนังสือ/นางแบบ/คอลลาจ
  // ไม่ว่าเลือกแบบไหน รูปทางการยังถูกใช้เป็นส่วนผสม/reference ตอนเจนคลิปเสมอ
  firstImageSource: optional('FIRST_IMAGE_SOURCE', 'review') === 'official' ? 'official' as const : 'review' as const,
  // เจ้าของออกแบบ 27 ก.ค. 2026: คลิป 1 ใช้โหมด "ส่วนผสม" ของ Flow โดยเอารูปที่เจนไว้
  // มารวมกับรูปทางการอีก 3 รูป ส่วนคลิป 2 ยังใช้โหมดเฟรมต่อจากเฟรมสุดท้ายเหมือนเดิม
  // (โหมดส่วนผสมไม่มีช่อง Start frame จึงต่อคลิปไม่ได้ — ยืนยันจาก DOM จริง)
  ingredientsModeEnabled: optionalBool('INGREDIENTS_MODE_ENABLED', true),
  // job #124: โหมดส่วนผสม "วาดสินค้าขึ้นใหม่" ไม่ได้ขยับพิกเซลของรูปตั้งต้น เฟรมที่ 0 ของ
  // คลิปจึงผิดได้ทันที (ฉลากถูกเขียนใหม่เป็นคำมั่ว) ทั้งที่รูปตั้งต้นผ่าน fidelity มาแล้ว
  // → ตรวจเฟรมแรกของทุกคลิปเทียบกับรูปที่ป้อนเข้าไป ปิดได้ถ้าอยากประหยัดโควตา Gemini
  clipFidelityCheckEnabled: optionalBool('CLIP_FIDELITY_CHECK_ENABLED', true),
  // คลิปจ่ายเครดิตไปแล้ว การตีตกเพราะเคสก้ำกึ่งจึงแพงกว่าปล่อยผ่าน — ถ้าผู้ตรวจให้คะแนน
  // ตัวตนสินค้าถึงเกณฑ์นี้ ให้ผ่านแม้เช็คย่อยจะไม่ครบ ลดเลขลง = เข้มขึ้น, 101 = ปิดวาล์วนี้
  clipFidelityMinScore: optionalInt('CLIP_FIDELITY_MIN_SCORE', 70),
  videoDurationSeconds: optionalInt('VIDEO_DURATION_SECONDS', 8),
  clipsPerJob: optionalInt('CLIPS_PER_JOB', 3),
  maxRetries: optionalInt('MAX_RETRIES', 3),

  // สเปควิดีโอปลายทาง — ใช้ normalize คลิปทุกตัวให้ตรงกันก่อน concat
  // (คลิปจาก Flow อาจมี resolution/fps/codec ต่างกัน ถ้าไม่ปรับให้ตรง concat จะได้ภาพเพี้ยน)
  // ค่าเริ่มต้นตั้งให้ตรงกับที่ Google Flow (Veo) คืนมาจริง — วัดจากคลิปจริง 17 ก.ค. 2026:
  // 720x1280 / h264 High / yuv420p / 24fps / 8.000s พอดี
  // ตั้ง fps ให้ตรง native ไว้ normalize จะได้ไม่ต้องก็อปเฟรม (ภาพกระตุก + เสียคุณภาพฟรี)
  videoWidth: optionalInt('VIDEO_WIDTH', 720),
  videoHeight: optionalInt('VIDEO_HEIGHT', 1280),
  videoFps: optionalInt('VIDEO_FPS', 24),

  // Post-process ขั้นสุดท้าย: interpolate เฟรม (24→60fps แบบ motion-compensated) +
  // upscale เป็น 1080p ให้ลื่น/คมขึ้น
  // แก้อาการ "กระตุก" ได้ ไม่แก้ "แปลก" (Veo warp ต้นทาง → ใช้ End-frame แทน)
  // ⚠️ DEFAULT OFF: minterpolate ช้ามาก (~5-6 นาที/คลิป 1080p) หนักเกินไปสำหรับโหมด 24 ชม.
  // (เจ้าของสั่ง 23 ก.ค. 2026: "ถ้ามันนานไปก็ไม่ต้องทำ") — เปิดเฉพาะตอนต้องการด้วย OUTPUT_SMOOTH=true
  outputSmooth: optionalBool('OUTPUT_SMOOTH', false),
  // ทางสายกลางระหว่าง "ปล่อย 720p" กับ "minterpolate 5-6 นาที": upscale เป็น 1080x1920
  // + ตั้ง bitrate ให้ตรงสเปกอัปโหลด โดยไม่สร้างเฟรมกลาง → ใช้เวลาแค่ราว 10-20 วินาที
  // ⚠️ ไม่ได้เพิ่มรายละเอียดจริงในภาพ แค่ทำให้ตรงสเปกที่แพลตฟอร์มชอบ (รีวิว job_96 ข้อ 11)
  // ถ้าเปิด OUTPUT_SMOOTH=true ไว้แล้ว ตัวนั้นทำ upscale ให้อยู่แล้ว ขั้นนี้จะถูกข้าม
  outputUpscale: optionalBool('OUTPUT_UPSCALE', true),
  // ⚠️ 0 = คงเฟรมเรตเดิม และต้องเป็น 0 เป็นค่าเริ่มต้นเสมอ
  //
  // job_99: ตั้งไว้ 30 แล้วภาพกระตุกจนเจ้าของบอกว่า "แปลกเกินไป" — ต้นทาง Veo คือ 24fps
  // 24→30 หารไม่ลงตัว ffmpeg จึงก็อปเฟรมทุก 4 เฟรม (384 → 480 เฟรม = ซ้ำ 96 เฟรม)
  // ได้จังหวะกระตุกสม่ำเสมอ เห็นชัดมากกับมือที่ขยับช้าๆ
  // ถ้าอยากได้ 30/60fps จริงต้อง interpolate สร้างเฟรมกลาง = OUTPUT_SMOOTH=true (ช้า 5-6 นาที)
  outputUpscaleFps: optionalInt('OUTPUT_UPSCALE_FPS', 0),
  outputUpscaleMaxrate: optional('OUTPUT_UPSCALE_MAXRATE', '10M'),
  // crf 20 กับต้นทาง 720p ที่ upscale แล้ว ได้ราว 3.5-4 Mbps ซึ่งเพียงพอทางสายตา
  // ถ้าอยากดัน bitrate ให้ถึง 6-10 Mbps ตามสเปกอัปโหลด ให้ลดเลขนี้ (เช่น 16)
  // แต่ไฟล์จะใหญ่ขึ้นโดยไม่ได้รายละเอียดเพิ่ม เพราะต้นทางคือ 720p
  outputUpscaleCrf: optionalInt('OUTPUT_UPSCALE_CRF', 20),
  outputFps: optionalInt('OUTPUT_FPS', 60),
  outputWidth: optionalInt('OUTPUT_WIDTH', 1080),
  outputHeight: optionalInt('OUTPUT_HEIGHT', 1920),
  outputSmoothPreset: optional('OUTPUT_SMOOTH_PRESET', 'medium'),
  // minterpolate 1080p ใช้เวลา >5 นาที → timeout ต้องยาวกว่า runFFmpeg ปกติ (default 15 นาที)
  outputSmoothTimeoutMs: optionalInt('OUTPUT_SMOOTH_TIMEOUT_MS', 900000),

  /** job ที่ค้างสถานะ in-progress นานเกินนี้ (นาที) ถือว่า worker ตาย → เอากลับเข้าคิว */
  staleJobMinutes: optionalInt('STALE_JOB_MINUTES', 30),

  // TTS
  ttsVoices: optional('TTS_VOICES', 'th-TH-PremwadeeNeural')
    .split(',')
    .map((v) => v.trim())
    // ตอนนี้ Edge Thai ที่อนุมัติเป็นเสียงหญิงมี Premwadee เท่านั้น
    // ใช้ allow-list เพื่อไม่ให้ env เก่าที่มี Niwat หรือเสียงชายอื่นหลุดกลับมา
    .filter((voice) => /Premwadee/i.test(voice))
    .concat(['th-TH-PremwadeeNeural'])
    .filter((voice, index, voices) => voices.indexOf(voice) === index),
  ttsRate: optional('TTS_RATE', '+0%'),
  ttsEngine,
  geminiTtsModel,
  geminiTtsVoices,
  ttsStyle,

  // FFmpeg
  ffmpegPath: optional('FFMPEG_PATH', 'ffmpeg'),
  bgmDir: optional('BGM_DIR', './data/bgm'),
  bgmVolume: optionalFloat('BGM_VOLUME', 0.08),
  ambienceVolume,
  targetLufs,
  subtitleFontsize,
  subtitleBurnIn,
  subtitleMaxCharsPerLine: optionalInt(
    'SUBTITLE_MAX_CHARS_PER_LINE',
    autoMaxChars
  ),
  subtitleFont: optional('SUBTITLE_FONT', 'Tahoma'),

  // Output
  outputDir: optional('OUTPUT_DIR', './data/output'),

  // Logging
  // ⛔ ไม่มี logLevel ที่นี่แล้ว — logger.ts อ่าน process.env.LOG_LEVEL เองอยู่แล้ว
  // มีสองที่ทำให้เข้าใจผิดว่าต้องตั้งผ่าน config (LOG_LEVEL ใน .env ยังใช้ได้เหมือนเดิม)
  logDir: optional('LOG_DIR', './logs'),

  // Proxy & Anti-Detection
  proxyList: optional('PROXY_LIST', '').split(',').map(p => p.trim()).filter(Boolean),
  proxyHealthCheckIntervalMs: optionalInt('PROXY_HEALTH_CHECK_INTERVAL_MS', 300000),
  proxyMaxFailCount: optionalInt('PROXY_MAX_FAIL_COUNT', 3),
  accountCooldownBaseMs: optionalInt('ACCOUNT_COOLDOWN_BASE_MS', 7200000),  // 2 hours
};

