import fs from 'fs';
import path from 'path';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import type { GeminiVisionResult, NarrationSnapshot } from '../types.js';

type ProductBriefEntry = {
  match: string[];
  brief?: string;
  officialImages?: string[];
  spec?: Record<string, unknown>;
};

export type ProductAssets = {
  officialImages: string[];
  spec: Record<string, unknown>;
};

const genAI = new GoogleGenerativeAI(config.geminiApiKey);

// ── โมดูลที่แยกออกไปแล้ว ────────────────────────────────────────────────
// ไฟล์นี้ยังเป็นทางเข้าเดียว (barrel) ผู้เรียกเดิมจึงไม่ต้องแก้ import แม้โค้ดย้ายบ้านแล้ว
import {
  MAX_COMPLIANCE_RETRIES,
  MAX_NARRATION_CHARS_PER_CLIP,
  MIN_NARRATION_CHARS_PER_CLIP,
  MIN_VIDEO_NARRATION_CHARS_PER_CLIP,
  PromptComplianceError,
  auditSafeNarrationFallback,
  ensureMinimumNarration,
  fallbackRewrittenNarrationSegments,
  normalizeClipAlignedNarration,
  repairDescriptiveSegments,
  rewriteUnsupportedClaimSegments,
  spokenLength,
  validateGeminiSalesCompliance,
  autoGenerateSubtitles,
  type UnsupportedClaimRewriteRequest,
} from './narration-rules.js';
import { demoActionFor, wearActionFor } from './shot-categories.js';
import { applyProductIdentityLock, describeMotionAction } from './identity-lock.js';
import { buildNarrationRules, buildSystemPrompt } from './planner-prompt.js';
import { parseGeminiVisionJson } from './json-parser.js';
import { generateContentWithRetry, MAX_INLINE_VIDEO_BYTES } from './gemini-client.js';
export {
  PromptComplianceError,
  normalizeClipAlignedNarration,
  validateGeminiSalesCompliance,
} from './narration-rules.js';
export { limitPromptWords, sanitizeProductMotionPrompt } from './motion-prompts.js';
export { applyProductIdentityLock, buildFlowContinuationPrompt, describeMotionAction } from './identity-lock.js';
export { wearActionFor } from './shot-categories.js';
export { parseGeminiVisionJson } from './json-parser.js';
export { compareGeneratedProductFidelity } from './fidelity-check.js';

type UnsupportedClaimRewriteContext = {
  productTitle: string;
  supportedFacts: string;
  reviewText: string;
  sceneActions: string[];
};

/**
 * เขียนประโยคเดิมใหม่โดยตัดเฉพาะคำอ้างที่ไม่มีต้นทาง แทนการทิ้งบททั้งช็อต
 * ผู้เรียกยังตรวจคำอ้างและความยาวซ้ำด้วยโค้ดก่อนยอมรับผลลัพธ์
 */
async function rewriteUnsupportedClaimSentence(
  request: UnsupportedClaimRewriteRequest,
  context: UnsupportedClaimRewriteContext
): Promise<string> {
  const model = genAI.getGenerativeModel({
    model: config.geminiModel,
    generationConfig: {
      temperature: 0.25,
      topP: 0.85,
      maxOutputTokens: 1024,
      thinkingConfig: { thinkingBudget: Math.min(config.geminiThinkingBudget, 1024) },
      responseMimeType: 'application/json',
    } as any,
  });
  const sceneAction = context.sceneActions[request.clipIndex] || 'คงใจความและความสัมพันธ์กับภาพเดิม';
  const prompt = `เขียนบทพากย์ภาษาไทยหนึ่งประโยคนี้ใหม่ โดยรักษาใจความที่มีหลักฐานและให้ตรงกับภาพเดิม
สินค้า: ${context.productTitle}
สิ่งที่ช็อตนี้ตั้งใจให้เกิดขึ้น: ${sceneAction}
ข้อมูลที่ยืนยันแล้ว: ${context.supportedFacts || '(ไม่มีข้อมูลเพิ่มเติม)'}
รีวิวผู้ซื้อ: ${context.reviewText || '-'}
ประโยคเดิม: ${request.originalText}
คำอ้างที่ห้ามใช้เพราะไม่มีต้นทาง: ${request.unsupportedClaims.join(', ')}

กฎ:
- ห้ามใช้คำต้องห้ามหรือถ้อยคำที่อ้างความหมายเดียวกัน
- ห้ามแต่งตัวเลข วัสดุ คุณสมบัติ หรือประโยชน์ใหม่
- คงน้ำเสียง เพศผู้พูด และคำปิดท้ายของประโยคเดิม
- ต้องยาว ${MIN_VIDEO_NARRATION_CHARS_PER_CLIP}-${MAX_NARRATION_CHARS_PER_CLIP} ตัวอักษรที่ออกเสียง
- พูดถึงสินค้าหรือผลของการกระทำในช็อต ห้ามบรรยายมือ กล้อง เฟรม หรือการชี้

ตอบ JSON เท่านั้น: {"text":"ประโยคที่เขียนใหม่"}`;
  const result = await generateContentWithRetry(
    model,
    [{ text: prompt }],
    `rewrite unsupported claim คลิป ${request.clipIndex + 1}`
  );
  const parsed = parseGeminiVisionJson(result.response.text()) as { text?: unknown };
  if (typeof parsed.text !== 'string' || !parsed.text.trim()) {
    throw new Error('Gemini rewrite ไม่คืนข้อความ');
  }
  return parsed.text.trim();
}


function findProductBriefEntry(productTitle: string): ProductBriefEntry | undefined {
  if (!productTitle) return undefined;
  try {
    const file = path.join(process.cwd(), 'data', 'product-briefs.json');
    if (!fs.existsSync(file)) return undefined;
    const entries = JSON.parse(fs.readFileSync(file, 'utf8')) as ProductBriefEntry[];
    const title = productTitle.toLowerCase();
    return entries.find((entry) =>
      Array.isArray(entry.match) && entry.match.some((token) => title.includes(String(token).toLowerCase())));
  } catch (error) {
    logger.warn(`⚠️ อ่าน product-briefs.json ไม่ได้: ${(error as Error).message}`);
    return undefined;
  }
}

/** ข้อเท็จจริงที่ผ่านการตรวจแล้ว ใช้ทั้งตอนวางแผนและตอนเขียนบทจากวิดีโอจริง */
export function loadProductBrief(productTitle: string): string {
  const entry = findProductBriefEntry(productTitle);
  const brief = entry?.brief?.trim() || '';
  const spec = entry?.spec && typeof entry.spec === 'object'
    ? Object.entries(entry.spec)
      .filter(([, value]) => value !== undefined && value !== null && String(value).trim())
      .map(([key, value]) => `${key}: ${String(value).trim()}`)
      .join('; ')
    : '';
  return [brief, spec].filter(Boolean).join('\n');
}

/**
 * คืนรูปสินค้าทางการที่อยู่ภายใน workspace เท่านั้น พร้อมสเปกที่ยืนยันแล้ว
 * path ใน JSON อ้างจาก project root เช่น data/product-assets/sku/front.jpg
 */
export function loadProductAssets(productTitle: string): ProductAssets {
  const entry = findProductBriefEntry(productTitle);
  const projectRoot = path.resolve(process.cwd());
  const officialImages = (entry?.officialImages || [])
    .filter((image): image is string => typeof image === 'string' && image.trim().length > 0)
    .map((image) => path.resolve(projectRoot, image))
    .filter((image) => image.startsWith(`${projectRoot}${path.sep}`) && fs.existsSync(image) && fs.statSync(image).isFile());
  return {
    officialImages,
    spec: entry?.spec && typeof entry.spec === 'object' ? entry.spec : {},
  };
}

/**
 * ใช้ Gemini Vision วิเคราะห์รูปรีวิวจริง + เขียน prompt
 * @param reviewText ข้อความรีวิวจริง
 * @param imagePaths path ไฟล์รูปรีวิว (local)
 * @param productTitle ชื่อสินค้า
 */
export async function analyzeAndCreatePrompts(
  reviewText: string,
  imagePaths: string[],
  productTitle: string = '',
  clipCount: number = config.clipsPerJob,
  creativeBrief?: Pick<GeminiVisionResult, 'handGender' | 'handCount' | 'backgroundStyle'>,
  productDetail: string = '',
  complianceAttempt: number = 0,
  complianceFeedback: string = ''
): Promise<GeminiVisionResult> {
  const model = genAI.getGenerativeModel({
    model: config.geminiModel,
    // thinkingConfig ยังไม่มีใน type ของ SDK เวอร์ชันนี้ แต่ส่งผ่านไปถึง API จริง
    // (ยืนยันแล้ว: สั่ง thinkingBudget=0 → thoughtsTokenCount=0 จริง)
    generationConfig: {
      // Keep enough variation for motion ideas while making structured JSON
      // materially less likely to drift or append a second response.
      temperature: 0.6,
      topP: 0.95,
      // โมเดล Gemini รุ่นใหม่บางตัวเป็น thinking model — thinking กินโควตารวมกับ maxOutputTokens
      // การเพิ่ม maxOutputTokens เฉยๆ ไม่พอ เพราะ thinking แกว่งได้ถึง 15k+
      // ต้องล็อกเพดาน thinking ด้วย ถึงจะเหลือที่ให้คำตอบแน่นอนทุกครั้ง
      maxOutputTokens: 16384,
      thinkingConfig: { thinkingBudget: config.geminiThinkingBudget },
      // บังคับให้ตอบเป็น JSON ที่ valid เสมอ (ไม่มี markdown fence)
      responseMimeType: 'application/json',
    } as any,
  });

  logger.info(`🤖 Gemini Vision กำลังวิเคราะห์ ${imagePaths.length} รูป...`);

  // เตรียม parts: system prompt + รูปทั้งหมด + ข้อความรีวิว
  const parts: any[] = [{ text: buildSystemPrompt(clipCount) }];

  // เพิ่มรูปรีวิวจริง (ส่งให้ Gemini ดู)
  for (let imageIndex = 0; imageIndex < imagePaths.length; imageIndex++) {
    const imgPath = imagePaths[imageIndex];
    try {
      const imageData = fs.readFileSync(imgPath);
      const ext = path.extname(imgPath).toLowerCase();
      const mimeType =
        ext === '.png'
          ? 'image/png'
          : ext === '.webp'
            ? 'image/webp'
            : 'image/jpeg';

      parts.push({ text: `IMAGE CANDIDATE ${imageIndex} (zero-based index ${imageIndex})` });
      parts.push({
        inlineData: {
          mimeType,
          data: imageData.toString('base64'),
        },
      });
    } catch (error) {
      logger.warn(`⚠️ อ่านรูปไม่ได้: ${imgPath}`);
    }
  }

  // Optional verified product facts. Entries may describe any category: specs,
  // materials, dimensions, ingredients or approved selling points.
  const staticProductBrief = loadProductBrief(productTitle);
  const productBrief = [productDetail.trim().slice(0, 1800), staticProductBrief]
    .filter(Boolean)
    .join('\n');
  if (productDetail.trim()) logger.info('📋 ใช้ product_detail ที่ scrape มาเป็น verified facts สำหรับวางแผนช็อต');
  if (staticProductBrief) logger.info('📋 ใช้ product brief ที่ยืนยันแล้วจาก data/product-briefs.json');

  // เพิ่มข้อความรีวิว + สินค้า
  parts.push({
    text: `สินค้า: ${productTitle}
จำนวนรูป: ${imagePaths.length}
จำนวนคลิปที่ต้องการสำหรับงานนี้: ${clipCount}
ความยาวต่อคลิป: ${config.videoDurationSeconds} วินาที
CREATIVE BRIEF: ใช้มือผู้หญิงธรรมชาติ exactly ${creativeBrief?.handCount || 1} ข้าง จุดจับเดิมตลอดทุกเฟรม ห้ามมีมือที่สอง และฉากหลัง "${creativeBrief?.backgroundStyle || 'โต๊ะรีวิวแสงธรรมชาติ'}" ให้เหมือนเดิมตลอดงาน${productBrief ? `
สเปก/จุดขายจริงของสินค้า (พูดได้ตามข้อความนี้เท่านั้น ห้ามขยายเป็นผลลัพธ์ที่ไม่ได้ระบุ):
${productBrief}` : ''}

รีวิวจากลูกค้าจริง:
${reviewText}

ข้อห้ามด้านรูปลักษณ์: ชื่อสินค้าและรีวิวใช้วางสารขายเท่านั้น ห้ามใช้เดาแบรนด์ รุ่น โลโก้ ตัวหนังสือ สถานะเปิด/ปิด จำนวนชิ้น หรือรูปทรงใน imagePrompt; รูปลักษณ์ทั้งหมดต้องยึด IMAGE CANDIDATE ที่เลือกเท่านั้น

เลือกภาพต้นทางที่ดีที่สุดเพียง 1 รูปเท่านั้น และคืน selectedImageIndices เพียง 1 ตำแหน่ง
รูปที่เลือกต้องเห็นตัวตนและโครงสร้างหลักของสินค้าชัด ไม่ถูกมือ/แขน/วัตถุบังจนต้องเดารายละเอียด
คืน sourceImageAssessment ตามภาพจริง โดย productIdentityVisible, majorDetailsUnobscured และ
usefulVerticalComposition ต้องผ่านทั้งหมดก่อนระบบยอมใช้รูปนั้นเป็นเฟรมตั้งต้น
และคืน uprightRotationDegrees = จำนวนองศาที่ต้องหมุนรูป "ตามเข็มนาฬิกา" เพื่อให้ตัวหนังสือบนสินค้าตั้งตรงอ่านได้ (0, 90, 180 หรือ 270 เท่านั้น)
ดูจากตัวอักษร/โลโก้บนตัวสินค้าเป็นหลัก ไม่ใช่จากพื้นหลัง ถ้าตั้งตรงอยู่แล้วให้ตอบ 0
วาง shotPlans ${clipCount} ช็อตก่อน แล้วสร้าง imagePrompt จากช็อตแรก จากนั้นสร้าง ${clipCount} motion prompts เป็นช็อตต่อเนื่อง โดยคลิปถัดไปเริ่มจากเฟรมสุดท้ายของคลิปก่อนหน้า ห้ามเปลี่ยนสินค้า ฉลาก ฉาก แสง หรือทิศทางกล้อง

ข้อกำหนดจากคลิปตัวอย่างของลูกค้า: ต้องทำให้คนหยุดดูตั้งแต่วินาทีแรกด้วยปัญหาหรือเหตุผลเลือกสินค้า, ให้เห็นการยกและพลิกซ้าย-ขวาแบบสั้น ๆ พร้อม close-up รายละเอียด, บอกคุณสมบัติที่อ่านหรือเห็นได้จริง, เชื่อมคุณสมบัติกับปัญหาหรือความยุ่งยากที่ช่วยตอบโจทย์, และปิดด้วย CTA ตรวจรายละเอียด/สั่งซื้อที่เป็นธรรมชาติในช็อตสุดท้ายเท่านั้น

กฎของงานนี้อยู่ท้ายสุดและสำคัญกว่าแม่แบบด้านบน: คืน selectedImageIndices 1 ตำแหน่ง, motionPrompts และ subtitleSegments อย่างละ ${clipCount} รายการเท่านั้น ความยาวรวม ${clipCount * config.videoDurationSeconds} วินาที
บทพากย์ต้องมี ${clipCount} ประโยคและพูดเต็มเกือบตลอดคลิป ให้พูดจบภายในประมาณ ${clipCount === 2 ? '13.5-15' : '20.5-23'} วินาที เหลือช่วงหายใจสั้นๆ ท้ายคลิปเท่านั้น (ห้ามพูดจบเร็วจนเงียบยาว) ห้ามสร้างเนื้อหาสำหรับคลิปที่ ${clipCount + 1}`,
  });

  if (complianceFeedback) {
    parts.push({
      text: `ผลรอบก่อนถูก validator ปฏิเสธ: ${complianceFeedback}\nแก้เฉพาะจุดที่ผิดและคืน JSON ชุดใหม่ทั้งหมด ห้ามโต้แย้ง validator`,
    });
  }

  try {
    const result = await generateContentWithRetry(model, parts, 'วางแผนช็อตและบทพากย์');

    // ถ้าคำตอบถูกตัดกลางคัน JSON จะพังแน่นอน — บอกสาเหตุจริงไปเลย
    // ดีกว่าปล่อยให้ไปตายที่ JSON.parse ด้วย error ที่อ่านไม่รู้เรื่อง
    const finishReason = result.response.candidates?.[0]?.finishReason;
    if (finishReason === 'MAX_TOKENS') {
      // thoughtsTokenCount มีจริงตอน runtime แต่ยังไม่มีใน type ของ SDK เวอร์ชันนี้
      const thoughts =
        (result.response.usageMetadata as any)?.thoughtsTokenCount ?? 0;
      throw new Error(
        `Gemini ตอบไม่จบ (finishReason=MAX_TOKENS, thinking ใช้ไป ${thoughts} tokens) — เพิ่ม maxOutputTokens`
      );
    }

    const responseText = result.response.text().trim();

    // Parse JSON — responseMimeType=application/json ตัด markdown fence ให้แล้ว
    // แต่เผื่อไว้ให้ยังรองรับกรณีมี fence ติดมา
    const jsonStr = responseText
      .replace(/```json\n?/g, '')
      .replace(/```\n?/g, '')
      .trim();

    const parsed = parseGeminiVisionJson(jsonStr);

    // Validate
    if (!Array.isArray(parsed.motionPrompts)) {
      throw new Error('motionPrompts missing');
    }
    if (!Array.isArray(parsed.shotPlans) || parsed.shotPlans.length !== clipCount) {
      throw new Error(`shotPlans missing — Gemini ต้องวางแผน ${clipCount} ช็อตก่อนสร้างภาพและบท`);
    }
    const sourceAssessment = parsed.sourceImageAssessment;
    if (
      !sourceAssessment
      || sourceAssessment.productIdentityVisible !== true
      || sourceAssessment.majorDetailsUnobscured !== true
      || sourceAssessment.usefulVerticalComposition !== true
    ) {
      const reason = String(
        sourceAssessment?.reason || 'รูปที่เลือกไม่ยืนยันว่ามองเห็นตัวตนสินค้าได้ครบ'
      ).trim();
      throw new PromptComplianceError([
        `รูปต้นทางใช้ขายไม่ได้: ${reason}. เลือก IMAGE CANDIDATE อื่นที่เห็นโครงสร้างและรายละเอียดหลักโดยไม่ถูกมือหรือวัตถุบัง`,
      ]);
    }
    // ปัดเข้ามุมฉากที่ ffmpeg หมุนได้จริง ค่าที่ Gemini ตอบมั่วจะกลายเป็น 0 (ไม่หมุน) เอง
    const rotation = Number(sourceAssessment.uprightRotationDegrees) || 0;
    parsed.sourceImageAssessment = {
      productIdentityVisible: true,
      majorDetailsUnobscured: true,
      usefulVerticalComposition: true,
      uprightRotationDegrees: [0, 90, 180, 270].includes(rotation) ? rotation : 0,
      reason: String(sourceAssessment.reason || '').trim(),
    };
    parsed.shotPlans = parsed.shotPlans.map((plan, index) => ({
      shot: index + 1,
      visualAction: String(plan?.visualAction || '').trim(),
      buyerMessage: String(plan?.buyerMessage || '').trim(),
      narrationGoal: String(plan?.narrationGoal || '').trim(),
    }));
    if (parsed.shotPlans.some((plan) => !plan.visualAction || !plan.buyerMessage || !plan.narrationGoal)) {
      throw new Error('shotPlans incomplete — ทุกช็อตต้องมีภาพ สารขาย และเป้าหมายบทพากย์');
    }
    if (typeof parsed.imagePrompt !== 'string' || !parsed.imagePrompt.trim()) {
      throw new Error('imagePrompt missing — ต้องสร้างเฟรมตั้งต้นจาก shotPlans[0]');
    }
    parsed.imagePrompt = parsed.imagePrompt.trim();
    parsed.motionPrompts = parsed.motionPrompts
      .filter((prompt): prompt is string => typeof prompt === 'string')
      .map((prompt) => prompt.trim())
      .filter(Boolean);
    if (typeof parsed.narrationScript !== 'string' || !parsed.narrationScript.trim()) {
      throw new Error('narrationScript missing');
    }
    parsed.narrationScript = parsed.narrationScript.trim();
    if (!Array.isArray(parsed.subtitleSegments)) parsed.subtitleSegments = [];
    parsed.subtitleSegments = parsed.subtitleSegments.filter((segment) =>
      segment
      && typeof segment.text === 'string'
      && segment.text.trim().length > 0
      && Number.isFinite(Number(segment.startSec))
      && Number.isFinite(Number(segment.endSec))
      && Number(segment.endSec) > Number(segment.startSec)
    ).map((segment) => ({
      text: segment.text.trim(),
      startSec: Number(segment.startSec),
      endSec: Number(segment.endSec),
    }));
    if (!parsed.subtitleSegments.length) {
      // ถ้าไม่มี subtitle — สร้างจาก narration อัตโนมัติ
      parsed.subtitleSegments = autoGenerateSubtitles(
        parsed.narrationScript,
        clipCount * config.videoDurationSeconds
      );
    }
    parsed.subtitleSegments = parsed.subtitleSegments
      .filter((segment) => segment.startSec < clipCount * config.videoDurationSeconds)
      .slice(0, clipCount);
    // เติมประโยคสำรองเฉพาะรอบสุดท้ายเท่านั้น — รอบก่อนหน้าปล่อยให้ตกด่านแล้วให้ Gemini
    // เขียนใหม่ ซึ่งได้บทจริงเสมอ (ดูคอมเมนต์ allowPadding ใน normalizeClipAlignedNarration)
    const alignedNarration = normalizeClipAlignedNarration(
      parsed.narrationScript,
      parsed.subtitleSegments,
      clipCount,
      config.videoDurationSeconds,
      complianceAttempt >= MAX_COMPLIANCE_RETRIES
    );
    parsed.narrationScript = alignedNarration.narrationScript;
    parsed.subtitleSegments = alignedNarration.subtitleSegments;
    // 🐛 3 ส.ค. 2026: ตกด่านนี้ 25 ครั้งจาก 10 งาน แล้ว #166/#167 ล้มทั้งงาน
    //
    // ต้นเหตุไม่ใช่ถ้อยคำในพรอมต์ (แก้ไปแล้วไม่ช่วย) แต่เป็น **ชนิดของ error**
    // เดิมโยน `Error` ธรรมดา ซึ่งตัวจับ retry ด้านล่างรับเฉพาะ PromptComplianceError
    //   → ไม่เข้าลูปนับรอบ → หลุดขึ้นไปถึง withRetry ข้างนอก
    //   → withRetry เรียกฟังก์ชันใหม่ทั้งก้อนโดย complianceAttempt กลับเป็น 0
    //   → `allowPadding` ที่เปิดตอนรอบสุดท้าย (บรรทัด ~373) จึงไม่มีวันเปิด
    //   → ลองใหม่ 3 ครั้งด้วยเงื่อนไขเดิมเป๊ะ ได้ผลเดิม แล้วล้มทั้งงาน
    //
    // เส้นทางบทจากวิดีโอเขียนถูกมาตั้งแต่ต้น (ดู MIN_VIDEO_NARRATION_CHARS_PER_CLIP)
    // — เช็ครอบก่อน แล้วรอบสุดท้ายค่อยเติมประโยคให้ยาวพอแทนการทิ้งงาน ตรงนี้ทำตามนั้น
    const shortNarration = parsed.subtitleSegments.findIndex(
      (segment) => spokenLength(segment.text) < MIN_NARRATION_CHARS_PER_CLIP
    );
    if (shortNarration >= 0 && complianceAttempt < MAX_COMPLIANCE_RETRIES) {
      throw new PromptComplianceError([
        `บทพากย์คลิป ${shortNarration + 1} สั้นเกินไป — ต้องมีอย่างน้อย ${MIN_NARRATION_CHARS_PER_CLIP} ตัวอักษรที่ออกเสียง`,
      ]);
    }
    // รอบสุดท้ายแล้ว: normalizeClipAlignedNarration ข้างบนเปิด allowPadding ให้แล้ว
    // ถ้ายังสั้นอยู่แปลว่าเติมแล้วก็ยังไม่ถึงเกณฑ์ — ปล่อยผ่านพร้อม log ดีกว่าทิ้งทั้งงาน
    // (บทที่สั้นไปหน่อยยังขายได้ งานที่ล้มทั้งใบขายไม่ได้เลย — บทเรียนเดียวกับ job #92)
    if (shortNarration >= 0) {
      logger.warn(
        `⚠️ บทคลิป ${shortNarration + 1} ยังสั้นกว่า ${MIN_NARRATION_CHARS_PER_CLIP} ตัวหลังเติมประโยคแล้ว`
        + ' — ปล่อยผ่านเพื่อไม่ให้ทิ้งทั้งงาน'
      );
    }

    // ตัดให้เหลือตามจำนวนคลิป
    parsed.motionPrompts = parsed.motionPrompts.slice(0, clipCount);
    if (parsed.motionPrompts.length !== clipCount) {
      throw new Error(
        `Gemini ต้องคืน motion prompts ${clipCount} ชุด แต่ได้ ${parsed.motionPrompts.length}`
      );
    }
    // รอบสุดท้ายแล้ว: ซ่อมก่อนตรวจ จะได้ไม่ตายทั้งงานเพราะประโยคเดียว
    // (เคลมยา/เพศเสียงปน/มุมพลิก ยังตกด่านตามเดิม — ซ่อมเฉพาะที่ซ่อมแล้วยังปลอดภัย)
    if (complianceAttempt >= MAX_COMPLIANCE_RETRIES) {
      const supportedFacts = `${productTitle} ${reviewText} ${productBrief}`;
      const unsupportedRepairs = await rewriteUnsupportedClaimSegments(
        parsed.subtitleSegments,
        supportedFacts,
        (request) => rewriteUnsupportedClaimSentence(request, {
          productTitle,
          supportedFacts,
          reviewText,
          sceneActions: parsed.motionPrompts.map(describeMotionAction),
        })
      );
      parsed.narrationRepairs = [
        ...repairDescriptiveSegments(parsed.subtitleSegments),
        ...unsupportedRepairs,
      ];
      parsed.narrationScript = parsed.subtitleSegments.map((segment) => segment.text).join(' ');
    }
    try {
      validateGeminiSalesCompliance(
        parsed,
        productTitle,
        clipCount,
        `${reviewText} ${productBrief}`,
        { enforceHook: complianceAttempt < MAX_COMPLIANCE_RETRIES }
      );
    } catch (error) {
      const repairs = parsed.narrationRepairs || [];
      if (
        !(error instanceof PromptComplianceError)
        || !fallbackRewrittenNarrationSegments(parsed.subtitleSegments, repairs)
      ) {
        throw error;
      }
      parsed.narrationScript = parsed.subtitleSegments.map((segment) => segment.text).join(' ');
      validateGeminiSalesCompliance(
        parsed,
        productTitle,
        clipCount,
        `${reviewText} ${productBrief}`,
        { enforceHook: false }
      );
    }
    // บทผ่านด่านแล้วก็จริง แต่ "ผ่าน" ไม่ได้แปลว่ามีข้อมูลสินค้าอยู่ในนั้น — ประโยคสำรอง
    // ออกแบบมาให้ผ่านทุกกฎอยู่แล้ว (ดู :44) จึงต้องนับแยกไว้ ไม่งั้นบทกลวงจะเงียบสนิท (job_146)
    parsed.narrationRepairs = [
      ...(parsed.narrationRepairs || []),
      ...auditSafeNarrationFallback(parsed.subtitleSegments),
    ];
    parsed.motionPrompts = applyProductIdentityLock(
      parsed.motionPrompts,
      wearActionFor(productTitle),
      demoActionFor(productTitle)
    );
    parsed.selectedImageIndices = normalizeSelectedImageIndices(
      Array.isArray(parsed.selectedImageIndices) ? parsed.selectedImageIndices : undefined,
      imagePaths.length,
      1
    );

    logger.info(
      `✅ Gemini Vision สร้างสำเร็จ: เลือกรูป [${parsed.selectedImageIndices.join(', ')}], ${parsed.motionPrompts.length} motion prompts, ${parsed.subtitleSegments.length} subtitle segments`
    );

    return parsed;
  } catch (error) {
    if (error instanceof PromptComplianceError && complianceAttempt < MAX_COMPLIANCE_RETRIES) {
      logger.warn(
        `⚠️ Gemini ไม่ผ่าน validator รอบ ${complianceAttempt + 1}/${MAX_COMPLIANCE_RETRIES + 1} — ให้แก้ใหม่: ${error.violations.join('; ')}`
      );
      return analyzeAndCreatePrompts(
        reviewText,
        imagePaths,
        productTitle,
        clipCount,
        creativeBrief,
        productDetail,
        complianceAttempt + 1,
        error.violations.join('; ')
      );
    }
    logger.error('❌ Gemini Vision ล้มเหลว:', error);
    throw error;
  }
}

// ⛔ ไม่มี imageInlinePart แล้ว — ตัวช่วยแปลงไฟล์รูปเป็น inlineData ที่ไม่มีใครเรียก
// จุดที่ป้อนรูปเข้า Gemini จริงอ่านไฟล์เองในที่ (ดู analyzeAndCreatePrompts) (ลบ 1 ส.ค. 2026)


export type VideoNarrationContext = {
  productTitle: string;
  productBrief?: string;
  reviewText?: string;
  clipCount: number;
  secondsPerClip: number;
  motionPrompts: string[];
};

/**
 * ดูคลิปที่ Flow สร้างจริงตามลำดับ แล้วเขียนบทใหม่ให้ตรงกับภาพจริง
 * ผู้เรียกต้องมี fallback เพราะ video understanding เป็นขั้นเสริมและห้ามทำให้งานเสีย
 */
export async function analyzeClipsAndWriteNarration(
  clipPaths: string[],
  ctx: VideoNarrationContext,
  complianceAttempt = 0,
  complianceFeedback = ''
): Promise<NarrationSnapshot> {
  if (clipPaths.length !== ctx.clipCount) {
    throw new Error(`จำนวนคลิปสำหรับวิเคราะห์ไม่ครบ: ต้องมี ${ctx.clipCount} แต่ได้ ${clipPaths.length}`);
  }

  const clips = clipPaths.map((clipPath) => {
    const resolved = path.resolve(clipPath);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      throw new Error(`ไม่พบคลิปสำหรับ Gemini วิเคราะห์: ${resolved}`);
    }
    return { path: resolved, data: fs.readFileSync(resolved) };
  });
  const totalBytes = clips.reduce((sum, clip) => sum + clip.data.length, 0);
  if (totalBytes > MAX_INLINE_VIDEO_BYTES) {
    throw new Error(`คลิปรวมใหญ่เกินขีดจำกัด inline video (${Math.ceil(totalBytes / 1024 / 1024)} MB)`);
  }

  const verifiedFacts = ctx.productBrief?.trim() || loadProductBrief(ctx.productTitle);
  const model = genAI.getGenerativeModel({
    model: config.geminiModel,
    generationConfig: {
      temperature: 0.45,
      topP: 0.9,
      maxOutputTokens: 8192,
      thinkingConfig: { thinkingBudget: config.geminiThinkingBudget },
      responseMimeType: 'application/json',
    } as any,
  });
  const parts: any[] = [{
    text: `คุณเป็นผู้เขียนบทพากย์สินค้าแนวตั้ง หน้าที่คือ "เล่ารายละเอียดสินค้าจริง" ให้ตรงกับภาพในแต่ละ Scene
สินค้า: ${ctx.productTitle}

รายละเอียดสินค้า (VERIFIED PRODUCT FACTS) — นี่คือ "แหล่งเนื้อหาหลัก" ที่ต้องนำมาพูด (วัสดุ คุณสมบัติ หน้าที่ จุดเด่น):
${verifiedFacts || '(ไม่มีสเปกแยกมา — ให้ดึงรายละเอียดจาก "ชื่อสินค้า" ด้านบน เช่น วัสดุ/ประเภท/คุณสมบัติที่ระบุในชื่อ แล้วอธิบายว่าจุดนั้นช่วยอะไร ห้ามแต่งสเปกที่ไม่มี)'}

ข้อมูลรีวิวผู้ซื้อ (ใช้ "สนับสนุน" รายละเอียดได้ เช่น ยืนยันว่าใช้ดีจริง — ไม่ใช่เนื้อหาหลัก และห้ามอ้างเกินรายละเอียด/ภาพ):
${ctx.reviewText?.trim() || '-'}

วิธีใช้วิดีโอ Scene 1-${ctx.clipCount} ที่แนบมา: อ่านภาพแต่ละ Scene แล้ว "เลือกรายละเอียดสินค้าที่เข้ากับสิ่งที่เห็นใน Scene นั้น" มาพูด — บทของแต่ละประโยคต้องล้อกับภาพช็อตนั้นจริง
⚠️ ห้ามพูดถึงรายละเอียด/การกระทำที่ไม่ปรากฏใน Scene นั้น และห้ามแต่งสเปกเกินข้อมูลที่ให้
⚠️ ห้ามพูดลอยๆ ให้ไปดูเอง เช่น "ลองดูรูปทรง/ดูรายละเอียดของจริง/จุดต่างๆ บนตัวสินค้า/เช็คว่าตรงกับแบบที่มองหา" — ต้องบอก "เนื้อรายละเอียด" ออกมาตรงๆ

${buildNarrationRules(ctx.clipCount, ctx.secondsPerClip)}

ตอบ JSON เท่านั้น:
{"narrationScript":"บททั้งหมด","subtitleSegments":[{"text":"หนึ่งประโยคของ Scene 1","startSec":0,"endSec":${ctx.secondsPerClip}}]}`,
  }];
  clips.forEach((clip, index) => {
    // job_134: เดิมส่งแต่คลิปเปล่าๆ คนเขียนบทเลยไม่รู้ว่าช็อตนั้นตั้งใจให้ทำท่าอะไร
    // คลิปโชว์ "เปิดตัวหนีบพัดลม" แต่บทพูดเรื่องปรับแรงลม 3 ระดับ + หมุน 360° คนละเรื่อง
    // (ctx.motionPrompts ถูกส่งเข้ามาตั้งนานแล้วแต่ไม่เคยถูกใช้เลยสักครั้ง)
    const action = describeMotionAction(ctx.motionPrompts[index] || '');
    parts.push({
      text: `Scene ${index + 1} — เวลา ${index * ctx.secondsPerClip}-${(index + 1) * ctx.secondsPerClip} วินาที`
        + (action ? `\nสิ่งที่ช็อตนี้ตั้งใจให้เกิดขึ้น: ${action}` : ''),
    });
    parts.push({ inlineData: { mimeType: 'video/mp4', data: clip.data.toString('base64') } });
  });
  if (complianceFeedback) {
    parts.push({
      text: `รอบก่อน validator ปฏิเสธ: ${complianceFeedback}\nแก้เฉพาะจุดผิด แล้วตรวจอีกครั้งว่าทุกคำตรงกับ Scene ของตนก่อนคืน JSON ใหม่ทั้งหมด`,
    });
  }

  try {
    logger.info(`🎬 Gemini กำลังดูคลิปจริง ${ctx.clipCount} คลิปเพื่อเขียนบทพากย์...`);
    const result = await generateContentWithRetry(model, parts, 'เขียนบทจากคลิปจริง');
    if (result.response.candidates?.[0]?.finishReason === 'MAX_TOKENS') {
      throw new Error('Gemini video narration ตอบไม่จบ (MAX_TOKENS)');
    }
    const responseText = result.response.text()
      .replace(/```json\n?/g, '')
      .replace(/```\n?/g, '')
      .trim();
    // ใช้ parser เดียวกับ vision (ทน JSON เพี้ยน/มี fragment ต่อท้าย/ขาด comma)
    // เดิมใช้ raw JSON.parse → พังเมื่อ Gemini คืน object ที่มีข้อความต่อท้าย
    // (job_59: "Unexpected non-whitespace after JSON") แล้ว fallback ทิ้งบทที่ดูวิดีโอจริง
    const parsed = parseGeminiVisionJson(responseText) as unknown as Partial<NarrationSnapshot>;
    if (typeof parsed.narrationScript !== 'string' || !parsed.narrationScript.trim()) {
      throw new Error('Gemini video narration ไม่มี narrationScript');
    }
    if (!Array.isArray(parsed.subtitleSegments) || parsed.subtitleSegments.length !== ctx.clipCount) {
      throw new Error(`Gemini video narration ต้องคืน subtitleSegments ${ctx.clipCount} ช่วง`);
    }
    const segments = parsed.subtitleSegments.map((segment) => ({
      text: String(segment?.text || '').trim(),
      startSec: Number(segment?.startSec),
      endSec: Number(segment?.endSec),
    }));
    if (segments.some((segment) => !segment.text || !Number.isFinite(segment.startSec) || !Number.isFinite(segment.endSec))) {
      throw new Error('Gemini video narration คืน subtitleSegments ไม่สมบูรณ์');
    }
    // เหตุผลเดียวกับสายวางแผน: ยังมีรอบให้ลองใหม่อยู่ก็อย่าเพิ่งเติมคำกลวงให้ผ่าน
    let aligned = normalizeClipAlignedNarration(
      parsed.narrationScript,
      segments,
      ctx.clipCount,
      ctx.secondsPerClip,
      complianceAttempt >= MAX_COMPLIANCE_RETRIES
    );
    const shortNarration = aligned.subtitleSegments.findIndex(
      (segment) => spokenLength(segment.text) < MIN_VIDEO_NARRATION_CHARS_PER_CLIP
    );
    if (shortNarration >= 0 && complianceAttempt < MAX_COMPLIANCE_RETRIES) {
      throw new PromptComplianceError([
        `บทจากวิดีโอคลิป ${shortNarration + 1} สั้นเกินไป — ต้องมีอย่างน้อย ${MIN_VIDEO_NARRATION_CHARS_PER_CLIP} ตัวอักษรที่ออกเสียง`,
      ]);
    }
    if (shortNarration >= 0) {
      const paddedSegments = aligned.subtitleSegments.map((segment, index) => ({
        ...segment,
        text: ensureMinimumNarration(segment.text, index, MIN_VIDEO_NARRATION_CHARS_PER_CLIP),
      }));
      aligned = {
        narrationScript: paddedSegments.map((segment) => segment.text).join(' '),
        subtitleSegments: paddedSegments,
      };
      logger.warn('⚠️ บทจากวิดีโอยังสั้นหลัง retry — เติมประโยคขายแบบปลอดภัยก่อนเข้า TTS');
    }
    // เช่นเดียวกับสายวางแผน: หมดรอบ retry แล้วให้ซ่อมสไตล์ ไม่ใช่ทิ้งงาน
    // (สายนี้มี fallback เป็นบท upfront อยู่แล้ว แต่ซ่อมก่อนดีกว่า จะได้ใช้บทที่ตรงภาพจริง)
    if (complianceAttempt >= MAX_COMPLIANCE_RETRIES) {
      const supportedFactsForRepair = `${ctx.productTitle} ${ctx.reviewText || ''} ${verifiedFacts}`;
      const unsupportedRepairs = await rewriteUnsupportedClaimSegments(
        aligned.subtitleSegments,
        supportedFactsForRepair,
        (request) => rewriteUnsupportedClaimSentence(request, {
          productTitle: ctx.productTitle,
          supportedFacts: supportedFactsForRepair,
          reviewText: ctx.reviewText || '',
          sceneActions: ctx.motionPrompts.map(describeMotionAction),
        })
      );
      aligned.repairs = [
        ...repairDescriptiveSegments(aligned.subtitleSegments),
        ...unsupportedRepairs,
      ];
      aligned.narrationScript = aligned.subtitleSegments.map((segment) => segment.text).join(' ');
    }
    try {
      validateGeminiSalesCompliance(
        { motionPrompts: ctx.motionPrompts, subtitleSegments: aligned.subtitleSegments },
        ctx.productTitle,
        ctx.clipCount,
        `${ctx.reviewText || ''} ${verifiedFacts}`,
        { enforceHook: complianceAttempt < MAX_COMPLIANCE_RETRIES }
      );
    } catch (error) {
      const repairs = aligned.repairs || [];
      if (
        !(error instanceof PromptComplianceError)
        || !fallbackRewrittenNarrationSegments(aligned.subtitleSegments, repairs)
      ) {
        throw error;
      }
      aligned.narrationScript = aligned.subtitleSegments.map((segment) => segment.text).join(' ');
      validateGeminiSalesCompliance(
        { motionPrompts: ctx.motionPrompts, subtitleSegments: aligned.subtitleSegments },
        ctx.productTitle,
        ctx.clipCount,
        `${ctx.reviewText || ''} ${verifiedFacts}`,
        { enforceHook: false }
      );
    }
    logger.info('✅ Gemini เขียนบทใหม่จากคลิปจริงและผ่าน compliance gate');
    return aligned;
  } catch (error) {
    if (error instanceof PromptComplianceError && complianceAttempt < MAX_COMPLIANCE_RETRIES) {
      logger.warn(`⚠️ บทจากวิดีโอไม่ผ่าน validator รอบ ${complianceAttempt + 1}: ${error.violations.join('; ')}`);
      return analyzeClipsAndWriteNarration(
        clipPaths,
        ctx,
        complianceAttempt + 1,
        error.violations.join('; ')
      );
    }
    throw error;
  }
}

/**
 * ทำให้ผลเลือกรูปจาก Gemini ปลอดภัยต่อการใช้จริง:
 * ตัด index ผิดช่วง/ซ้ำ แล้วเติมรูปที่ยังไม่ถูกเลือก หากรูปมีน้อยกว่าคลิปจึงค่อยวนซ้ำ
 */
export function normalizeSelectedImageIndices(
  selectedIndices: number[] | undefined,
  imageCount: number,
  targetCount: number
): number[] {
  if (imageCount <= 0 || targetCount <= 0) return [];

  const selected: number[] = [];
  for (const index of selectedIndices || []) {
    if (
      Number.isInteger(index) &&
      index >= 0 &&
      index < imageCount &&
      !selected.includes(index)
    ) {
      selected.push(index);
    }
    if (selected.length >= targetCount) return selected;
  }

  for (let index = 0; index < imageCount && selected.length < targetCount; index++) {
    if (!selected.includes(index)) selected.push(index);
  }

  for (let index = 0; selected.length < targetCount; index++) {
    selected.push(index % imageCount);
  }

  return selected;
}
