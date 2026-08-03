// ===== ClipBot Flow v2 — Type Definitions =====

/** สถานะของ Flow Job */
export type JobStatus =
  | 'pending'
  | 'downloading_media'    // ดาวน์โหลดรูปรีวิวจริงจาก DB
  | 'generating_prompt'    // Gemini Vision วิเคราะห์รูป + เขียน motion prompt
  | 'generating_image'     // Flow: สร้างภาพมือจับสินค้า + ฉากหลังใหม่
  | 'generating_videos'    // Flow: image-to-video (2/3 คลิป × 8 วิ)
  | 'generating_tts'       // Gemini TTS: พากย์เสียง
  | 'assembling'           // FFmpeg: ต่อคลิป + ซับ + เพลง
  | 'completed'
  | 'failed';

/** ข้อมูลรีวิวจาก database (item table เดิม) */
export interface ReviewItem {
  id: number;
  datasetId: number;
  productId: number;
  title: string;
  price: string;
  productUrl: string;
  reviewSummary: string;
  mediaJson: string | ReviewMedia[]; // legacy VARCHAR หรือ canonical JSONB array
  status: string;
}

/** สื่อจาก media_json */
export interface ReviewMedia {
  url: string;
  type: 'image' | 'video';
}

/** ผลลัพธ์จาก Gemini Vision */
export interface GeminiVisionResult {
  /**
   * ลำดับรูปที่ Gemini คัดจาก imagePaths (zero-based)
   * ตำแหน่งต้องสอดคล้องกับ motionPrompts: selectedImageIndices[0] ใช้กับ prompt แรก
   */
  selectedImageIndices?: number[];
  /**
   * เหตุผลที่รูปต้นทางเหมาะจะเป็นเฟรมตั้งต้น ไม่ใช่แค่ "เหมือนสินค้า"
   * ต้องเห็นตัวตน/โครงสร้างหลักของสินค้าโดยไม่ถูกมือหรือวัตถุบังจนต้องเดา
   */
  sourceImageAssessment?: {
    productIdentityVisible: boolean;
    majorDetailsUnobscured: boolean;
    usefulVerticalComposition: boolean;
    /**
     * ต้องหมุนรูปตามเข็มกี่องศาให้ตัวหนังสือบนสินค้าตั้งตรง (0/90/180/270)
     * 🐛 job_155: รูปรีวิวถ่ายมากลับหัว ระบบทำตามทั้งเส้นทาง คลิปเลยกลับหัวทั้งเรื่อง
     */
    uprightRotationDegrees: number;
    reason: string;
  };
  /** prompt สำหรับสร้างภาพตั้งต้นใหม่จากรูปสินค้าจริงใน Flow */
  imagePrompt?: string;
  /** รูปแบบมือและฉากหลังที่สุ่มคงที่ต่อหนึ่งงาน */
  handGender?: 'male' | 'female';
  /** เฟรมตั้งต้นที่ระบบสร้างมีมือจับสินค้าหนึ่งข้างเสมอ ใช้ล็อก motion ไม่ให้เสกมือเพิ่ม */
  handCount?: 1;
  backgroundStyle?: string;
  /** แผนภาพและสารขายของแต่ละช็อต ซึ่ง Gemini ต้องวางก่อนเขียน prompt/บทพากย์ */
  shotPlans?: Array<{
    shot: number;
    visualAction: string;
    buyerMessage: string;
    narrationGoal: string;
  }>;
  /** checkpoint รูปก่อน/หลัง Flow สร้างภาพตั้งต้น */
  sourceImagePath?: string;
  /**
   * URL ต้นทางของรูปที่ถูกเลือก — ใช้กันไม่ให้งานถัดไปของสินค้าตัวเดิมหยิบรูปเดิมซ้ำ
   * 🐛 3 ส.ค. 2026: โลชั่น Oriental Princess ถูกทำ 5 งานแล้วได้รูปเดียวกันทั้งห้าครั้ง
   * เพราะเราหยิบรูปผู้สมัคร "8 ใบแรก" ชุดเดิมเสมอ ทั้งที่สินค้านั้นมีสื่อในฐาน 175 ชิ้น
   */
  sourceImageUrl?: string;
  /**
   * วิธี A: รูปสินค้าทางการ "มุมอื่น" ที่แนบเป็น reference เสริมตอนเจนเฟรมต้น
   * (ไม่รวมรูปหลักที่ Gemini เลือกไว้ใน sourceImagePath) เก็บใน checkpoint เพื่อให้
   * งานที่กลับมาทำต่อใช้ชุดเดิม ไม่ต้องคำนวณใหม่
   */
  referenceImagePaths?: string[];
  generatedImagePath?: string;
  generatedImageUrl?: string;
  /** prompt/checkpoint ภาพปลายสำหรับ Frames-to-Video; เจนครั้งเดียวก่อนคลิปแรก */
  endImagePrompt?: string;
  endImagePath?: string;
  endImageUrl?: string;
  rejectedEndImagePath?: string;
  endImageFidelity?: ProductImageFidelityResult;
  /** รูปที่ Flow สร้างแต่ถูก fidelity gate ปฏิเสธ เก็บไว้ตรวจสาเหตุเท่านั้น */
  rejectedGeneratedImagePath?: string;
  /** ผลเปรียบเทียบสินค้าต้นฉบับกับภาพที่ Flow สร้าง ก่อนอนุญาตให้ใช้เครดิตวิดีโอ */
  imageFidelity?: ProductImageFidelityResult;
  /** motion prompt สำหรับแต่ละรูป (ใช้กับ Flow image-to-video) */
  motionPrompts: string[];
  /** บทพากย์ภาษาไทย (เขียนจากรีวิวจริง ให้ดูเป็นคนพูดจริงๆ) */
  narrationScript: string;
  /** ซับไตเติ้ลแยกเป็นช่วง */
  subtitleSegments: SubtitleSegment[];
  /** แหล่งบทที่ใช้ประกอบงานจริง: บทวางล่วงหน้า หรือบทที่เขียนหลังดูคลิปจาก Flow */
  narrationSource?: 'upfront' | 'video';
  /** ร่องรอยทุกประโยคที่ถูกกฎแทนด้วยบทสำรอง เพื่อชันสูตรย้อนหลังได้ */
  narrationRepairs?: NarrationRepair[];
  /** เก็บบทก่อนสร้างคลิปไว้สำหรับ debug/fallback เมื่อใช้ video narration */
  upfrontNarration?: NarrationSnapshot;
  /** บทที่ Gemini เขียนหลังดูคลิปจริง */
  videoNarration?: NarrationSnapshot;
}

export interface ProductImageFidelityResult {
  pass: boolean;
  score: number;
  checks: {
    category: boolean;
    silhouette: boolean;
    openClosedState: boolean;
    colors: boolean;
    componentCount: boolean;
    componentLayout: boolean;
    visibleText: boolean;
  };
  differences: string[];
}

export interface NarrationSnapshot {
  narrationScript: string;
  subtitleSegments: SubtitleSegment[];
  repairs?: NarrationRepair[];
}

export interface NarrationRepair {
  clipIndex: number;
  rule: 'descriptive_narration' | 'unsupported_claim' | 'filler_only_narration';
  strategy: 'gemini_rewrite' | 'safe_fallback' | 'safe_padding';
  repairedFrom: string;
  replacement: string;
  reasons: string[];
}

/** ช่วงซับไตเติ้ล */
export interface SubtitleSegment {
  text: string;
  startSec: number;
  endSec: number;
}

/** Flow Job — งานที่ต้องทำ */
export interface FlowJob {
  id: number;
  itemId: number;
  reviewText: string;
  // Gemini Vision
  visionResult: GeminiVisionResult | null;
  // ไฟล์ต้นฉบับ
  reviewImagePaths: string[];   // รูปรีวิวจริงที่ download มา
  // Flow output
  clipPaths: string[];          // 3 คลิปวิดีโอจาก Flow
  clipUrls: string[];
  // TTS output
  ttsAudioPath: string | null;  // ไฟล์เสียงพากย์
  ttsVoice: string | null;      // เสียงที่สุ่มได้ (ชาย/หญิง)
  // Subtitle
  subtitlePath: string | null;  // ไฟล์ .srt
  // FFmpeg output
  finalVideoPath: string | null; // วิดีโอพร้อมลง (ต่อ+ซับ+เสียง+เพลง)
  // Meta
  status: JobStatus;
  workerId: number | null;
  errorMessage: string | null;
  retryCount: number;
  targetDurationSeconds: 16 | 24;
  createdAt: Date;
  updatedAt: Date;
}

// ⛔ ไม่มี WorkerConfig / WorkerStatus แล้ว — เหลือจากยุค Puppeteer หลาย worker
// ตอนนี้ Extension เป็นตัวคุมคิวและมีบอทตัวเดียว สถานะจริงอยู่ใน ExtensionRuntime
// (ลบ 30 ก.ค. 2026 เพราะทำให้คนอ่านโค้ดเข้าใจผิดว่ายังมีระบบ worker อยู่)

/** Config หลักของระบบ */
export interface AppConfig {
  // Database
  databaseUrl: string;

  // Gemini
  geminiApiKey: string;
  geminiModel: string;
  geminiThinkingBudget: number;

  // Chrome
  chromeDebugPorts: number[];
  chromeExecutable: string;

  // ⛔ ไม่มีค่าหน่วงเวลาของ worker แล้ว (delayBetweenJobs / delayBetweenActions / typingDelay)
  // ยุค Puppeteer หน่วงเวลาอยู่ฝั่ง Node ตอนนี้ Extension เป็นคนคุมจังหวะเองทั้งหมด
  // จังหวะจริงอยู่ใน `extension/background.js` (ลบ 1 ส.ค. 2026)

  // Flow
  flowUrl: string;
  flowGenerationEnabled: boolean;
  endFrameEnabled: boolean;
  referenceImagesEnabled: boolean;
  referenceImageCount: number;
  /** รูปทางการที่แนบเป็นส่วนผสมตอนเจนคลิป 1 — 0 = ใช้รูปที่ผ่านด่านแล้วใบเดียว */
  ingredientReferenceCount: number;
  firstImageSource: 'review' | 'official';
  ingredientsModeEnabled: boolean;
  clipFidelityCheckEnabled: boolean;
  clipFidelityMinScore: number;
  videoDurationSeconds: number;
  clipsPerJob: number;
  maxRetries: number;
  videoWidth: number;
  videoHeight: number;
  videoFps: number;
  outputSmooth: boolean;
  outputFps: number;
  outputWidth: number;
  outputHeight: number;
  outputSmoothPreset: string;
  outputSmoothTimeoutMs: number;
  outputUpscale: boolean;
  outputUpscaleFps: number;
  outputUpscaleMaxrate: string;
  outputUpscaleCrf: number;
  staleJobMinutes: number;

  // TTS
  ttsVoices: string[];
  ttsRate: string;
  /** ตัวสร้างเสียง: gemini (ธรรมชาติกว่า) หรือ edge (ของเดิม) */
  ttsEngine: "gemini" | "edge";
  geminiTtsModel: string;
  geminiTtsVoices: string[];
  /** คำสั่งอารมณ์ที่ส่งนำหน้าบท — ทำให้เสียงไม่เหมือนอ่านข่าว */
  ttsStyle: string;

  // FFmpeg
  ffmpegPath: string;
  bgmDir: string;
  bgmVolume: number;
  /** ความดังเสียงบรรยากาศจากคลิป Veo ที่ผสมใต้เสียงพากย์ (0 = ปิด) */
  ambienceVolume: number;
  /** ความดังเป้าหมายของคลิปสุดท้าย (LUFS) — TikTok ใช้ราว -14 */
  targetLufs: number;
  subtitleFontsize: number;
  /** เบิร์นซับลงคลิปไหม — ค่าเริ่มต้นคือไม่ (บทของ Gemini ใช้เป็นเสียงพากย์อย่างเดียว) */
  subtitleBurnIn: boolean;
  subtitleMaxCharsPerLine: number;
  subtitleFont: string;

  // Output
  outputDir: string;

  // Logging
  logDir: string;

  // Proxy & Anti-Detection
  proxyList: string[];
  proxyHealthCheckIntervalMs: number;
  proxyMaxFailCount: number;
  accountCooldownBaseMs: number;
}

/** สถิติรวม */
export interface BotStats {
  totalJobs: number;
  completedJobs: number;
  failedJobs: number;
  pendingJobs: number;
  inProgressJobs: number;
  totalClips: number;
  totalFinalVideos: number;
  startTime: Date;
  activeWorkers: number;
}
