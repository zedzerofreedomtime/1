import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AUTO_START,
  AUTO_END,
  SHARED_START,
  SHARED_END,
  sectionBetween,
} from './agent-brief.js';
import {
  applyProductIdentityLock,
  wearActionFor,
  analyzeClipsAndWriteNarration,
  buildFlowContinuationPrompt,
  describeMotionAction,
  limitPromptWords,
  loadProductAssets,
  loadProductBrief,
  normalizeClipAlignedNarration,
  normalizeSelectedImageIndices,
  parseGeminiVisionJson,
  PromptComplianceError,
  sanitizeProductMotionPrompt,
  validateGeminiSalesCompliance,
} from '../src/gemini/prompt-generator.js';
import {
  auditSafeNarrationFallback,
  ensureMinimumNarration,
  endsWithCompleteThaiPhrase,
  fitCompleteNarration,
  safeFillerRatio,
  SAFE_FILLER_ALERT_RATIO,
  MAX_NARRATION_CHARS_PER_CLIP,
  MIN_NARRATION_CHARS_PER_CLIP,
  MIN_VIDEO_NARRATION_CHARS_PER_CLIP,
  findUnsupportedClaims,
  findUnsupportedSpecNumbers,
  SAFE_NARRATION_EXTENSIONS,
  SOURCE_REQUIRED_CLAIMS,
  spokenLength,
  opensByNamingProduct,
  normalizeNarrationGender,
  repairDescriptiveSegments,
  repairUnsupportedClaims,
} from '../src/gemini/narration-rules.js';
import { auditDemoLimbAccounting, demoActionFor } from '../src/gemini/shot-categories.js';
import { isDemoShotPrompt } from '../src/gemini/identity-lock.js';
import { normalizeRole } from '../src/gemini/ingredient-images.js';
import { pickBackgroundStyle, pickReferenceStyle } from '../src/extension/reference-style.js';
 import { isTransientNetworkError } from '../src/utils/retry.js';
import { buildReferenceImagePlan, validateExtensionDownload, withIngredientGuidance } from '../src/extension/extension-api.js';
import { looksEncodingCorrupted, parseStoredMedia } from '../src/scrape/harvester-api.js';
import { isEligibleReviewMedia, REVIEW_MEDIA_START_EPOCH_SECONDS } from '../src/utils/review-media.js';
import { freshCandidateWindow } from '../src/extension/media-intake.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * อ่านซอร์สฝั่ง backend เป็นข้อความเดียว — รับได้ทั้ง "ไฟล์เดียว" และ "ทั้งโฟลเดอร์"
 *
 * เช็คส่วนใหญ่ในไฟล์นี้ยืนยันพฤติกรรมด้วยการ match ข้อความในซอร์ส ถ้าผูกกับ path
 * ไฟล์เดี่ยวไว้ตรงๆ พอแตกไฟล์ใหญ่เป็นโมดูลย่อยทีไร assertion จะพังยกแผงทั้งที่โค้ด
 * ยังทำงานเหมือนเดิม การอ่านทั้งโฟลเดอร์ (ไล่ลงโฟลเดอร์ย่อยด้วย) ทำให้ย้ายโค้ด
 * ข้ามไฟล์ได้อิสระ โดยยังกันพฤติกรรมถอยหลังไว้เหมือนเดิม
 */
/**
 * ชั้น "motion" ทั้งชั้นรวมกัน — ตารางหมวด + ข้อความล็อก + ตัวตรวจพรอมต์
 *
 * 1 ส.ค. 2026 แยก motion-prompts.ts ออกเป็นสามไฟล์ตามหน้าที่ ข้อความล็อกจึงย้ายบ้าน
 * assertion ที่ตรวจว่า "ประโยคนี้ต้องอยู่ในพรอมต์ที่ส่งเข้า Flow" ไม่ควรผูกกับชื่อไฟล์
 * แต่ก็ไม่ควรกวาดทั้งโฟลเดอร์ gemini เพราะจะไปเจอข้อความจากพรอมต์คนละชุด
 */
/**
 * ชั้น "คำสั่งที่ส่งให้ Gemini" ทั้งชั้น — โจทย์ที่ตั้ง + โค้ดที่เรียกและตรวจคำตอบ
 *
 * เหตุผลเดียวกับ readMotionLayer(): 1 ส.ค. 2026 แยกก้อนข้อความคำสั่งออกไป
 * planner-prompt.ts assertion ที่ตรวจ "ประโยคนี้ต้องอยู่ในคำสั่ง" จึงไม่ควรผูกชื่อไฟล์
 */
/**
 * ชั้น "กฎบทพากย์" ทั้งชั้น — กฎ + ตัวช่วยจัดการข้อความไทยที่กฎเรียกใช้
 *
 * 1 ส.ค. 2026 ดึงตัวนับ/ตัดตัวอักษรไทยออกไป thai-text.ts (ไม่ใช่กฎ ใช้ที่ไหนก็ได้)
 * แต่ assertion เรื่องกฎบทไม่ควรต้องรู้ว่าโค้ดถูกแบ่งบ้านยังไง
 */
function readNarrationLayer(): string {
  return ['thai-text.ts', 'narration-rules.ts']
    .map((file) => readBackendSource('gemini', file))
    .join('\n');
}

function readPromptLayer(): string {
  return ['planner-prompt.ts', 'prompt-generator.ts']
    .map((file) => readBackendSource('gemini', file))
    .join('\n');
}

function readMotionLayer(): string {
  return ['shot-categories.ts', 'identity-lock.ts', 'motion-prompts.ts', 'camera-timeline.ts']
    .map((file) => readBackendSource('gemini', file))
    .join('\n');
}

function readBackendSource(...segments: string[]): string {
  const target = path.join(root, 'backend', 'src', ...segments);
  if (!fs.existsSync(target)) {
    throw new Error(`ไม่พบซอร์สที่ต้องตรวจ: ${path.relative(root, target)}`);
  }
  if (!fs.statSync(target).isDirectory()) return fs.readFileSync(target, 'utf8');
  const collect = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))
      .flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return collect(full);
        return entry.name.endsWith('.ts') ? [fs.readFileSync(full, 'utf8')] : [];
      });
  return collect(target).join('\n');
}

const validResult = {
  selectedImageIndices: [0],
  motionPrompts: ['one', 'two', 'three'],
  narrationScript: 'ทดสอบ {วงเล็บ} ในข้อความ',
  subtitleSegments: [{ text: 'ทดสอบ', startSec: 0, endSec: 3 }],
};

function check(name: string, run: () => void): void {
  try {
    run();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

check('Gemini JSON ปกติ', () => {
  assert.deepEqual(parseGeminiVisionJson(JSON.stringify(validResult)), validResult);
});

check('product brief รองรับ spec และ official assets แบบ optional', () => {
  const brief = loadProductBrief('บีแอลบียู BLB U');
  assert.match(brief, /ซอฟต์เจล 30 เม็ด/);
  const assets = loadProductAssets('บีแอลบียู BLB U');
  assert.deepEqual(assets.officialImages, []);
  assert.equal(assets.spec.name, 'BLB U');
});

check('มีขั้น Gemini ดูคลิปจริงและ fallback ไปบท upfront', () => {
  assert.equal(typeof analyzeClipsAndWriteNarration, 'function');
  const apiSource = readBackendSource('extension');
  assert.match(apiSource, /stage: 'video\.narration'/);
  assert.match(apiSource, /narrationSource = 'video'/);
  assert.match(apiSource, /ใช้บทวางล่วงหน้าแทนโดยไม่ทำให้งานล้ม/);
  assert.match(apiSource, /upfrontNarration/);
  const promptSource = readBackendSource('gemini');
  assert.match(promptSource, /MIN_VIDEO_NARRATION_CHARS_PER_CLIP = 90/);
  assert.match(promptSource, /บทจากวิดีโอคลิป \$\{shortNarration \+ 1\} สั้นเกินไป/);
  assert.match(promptSource, /เติมประโยคขายแบบปลอดภัยก่อนเข้า TTS/);
  assert.match(apiSource, /stage: 'tts\.fallback'/);
  assert.match(apiSource, /เสียงจากบทที่ดูวิดีโอสั้นไม่ผ่านเกณฑ์จริง/);
});

// งาน #94: หมอน KOTORI ที่ Flow เจนถูกต้องทุกอย่างโดนบล็อกเพราะ silhouette ตกข้อเดียว
// เหตุผลของ Gemini คือ "ไม่มีร่องตรงกลางเหมือนต้นฉบับ" — แต่หมอนถูกกดอยู่ในรูปต้นฉบับ
// ของนุ่มเปลี่ยนทรงตามการจับวางเป็นธรรมดา ต้องตัดสินที่โครงสร้าง ไม่ใช่ทรงชั่วขณะ
check('ของนุ่มเปลี่ยนทรงได้ ห้ามบล็อกเพราะทรงชั่วขณะ (job #94 หมอนโดนตี 4/100)', () => {
  const geminiSource = readBackendSource('gemini');
  assert.match(geminiSource, /SOFT \/ DEFORMABLE PRODUCTS/);
  assert.match(geminiSource, /momentary loft, sag, dip or compression/);
  assert.match(geminiSource, /the SAME product in a different handling state: mark silhouette TRUE/);
  // ยังต้องบล็อกเมื่อ "โครงสร้าง" ต่างจริง เช่น แถบขอบหาย/สัดส่วนเปลี่ยน
  assert.match(geminiSource, /trim band that moved, disappeared or changed width/);
  // ตัวอย่างใน template เคยเป็น score 0 คู่กับ pass true โมเดลเลยลอกเลข 0 มาให้ตลอด
  assert.match(geminiSource, /Do not copy the example number below/);
  assert.doesNotMatch(geminiSource, /"pass": true,\n  "score": 0,/);
});

// job #98: แท็บ Flow เดิมหาย (ปิด/Memory Saver คืน id ใหม่) ระหว่างพักก่อนคลิป 2
// → "No tab with id" ล้มงานทั้งใบทั้งที่แท็บ Flow เปิดอยู่จริงและคลิป 1 จ่ายเงินแล้ว
check('แท็บ Flow เปลี่ยน id ระหว่างพัก ต้องหาแท็บที่เปิดอยู่แทนการล้มงาน (job #98)', () => {
  const backgroundSource = fs.readFileSync(path.join(root, 'extension', 'background.js'), 'utf8');
  assert.match(backgroundSource, /let targetTabId = tabId;/);
  assert.match(backgroundSource, /chrome\.tabs\.get\(targetTabId\)/);
  assert.match(backgroundSource, /targetTabId = \(await flowTab\(\)\)\.id;/);
  // ทุกจุดส่ง message/inject ต้องใช้แท็บที่ตรวจแล้ว ไม่ใช่ id ดิบที่อาจตายไปแล้ว
  assert.doesNotMatch(backgroundSource, /chrome\.tabs\.sendMessage\(tabId, message\)/);
});

// 27 ก.ค. 2026: กดเจน 14 ครั้งได้วิดีโอจบ 1 ชิ้น + โดนธง anti-bot 2 รอบ
// ทางแก้ที่ไม่ใช่การหลบตรวจจับ = ลดจำนวนครั้งที่แตะ Flow ต่อวิดีโอ 1 ชิ้น
check('ลดรอยเท้าใน Flow: ปิด End frame ได้จริงทุกเส้นทาง + ไม่กด "ลองอีกครั้ง" ซ้ำ (job #99)', () => {
  const apiSource = readBackendSource('extension');
  // เส้นทาง claim มี kill-switch อยู่แล้ว เส้นทาง "เพิ่งเซฟเฟรมต้น" ต้องมีด้วย
  // ไม่งั้นปิด flag แล้วยังเจน End frame ต่อ = จ่ายเครดิตเกินฟรี
  assert.match(apiSource, /if \(!config\.endFrameEnabled\) \{/);
  assert.match(apiSource, /ข้าม End frame \(ปิดไว้\) ไปเจนคลิปเลย/);

  const backgroundSource = fs.readFileSync(path.join(root, 'extension', 'background.js'), 'utf8');
  // #99: กด "ลองอีกครั้ง" 11:34:41 → 9 วิต่อมาโดนการ์ด "กิจกรรมผิดปกติ"
  assert.match(backgroundSource, /const FAILED_CARD_RETRY_ENABLED = false;/);
  assert.match(backgroundSource, /data\?\.retryPoint && FAILED_CARD_RETRY_ENABLED &&/);
  // ล้มแล้วต้องตกไปกลไกพัก 20 นาทีเดิม (เก็บ checkpoint ที่จ่ายเงินแล้วไว้)
  assert.match(backgroundSource, /พักตามรอบปกติแล้วค่อยเริ่มงานเดิมใหม่ \(ไม่กดลองอีกครั้ง\)/);
  // ข้อความสถานะต้องไม่โกหกว่า retry ไปแล้ว 3 รอบ ทั้งที่ไม่ได้กดเลย
  assert.doesNotMatch(backgroundSource, /error หลัง retry \$\{ERROR_RETRY_LIMIT\} รอบ/);
});

// รีวิว job_96 (27 ก.ค. 2026): ฉลากเปลี่ยนคำระหว่างหมุน ของเหลวหาย/ระดับไม่ราบ
// นิ้วไม่ขยับตามขวด เงียบคร่อมรอยต่อวินาทีที่ 8 นาน 1.03s และเงียบท้ายคลิป 1.05s
check('ลดสินค้าเพี้ยนระหว่างคลิป + ปิดช่องเงียบรอยต่อ (รีวิว job_96)', () => {
  const motionSource = readMotionLayer();
  assert.doesNotMatch(motionSource, /20-degree/);
  // สามอย่างที่โมเดลชอบปล่อยหลุดและรีวิวจับได้ — ต้องล็อกไว้เสมอ ไม่ว่าท่าจะเป็นแบบไหน
  assert.match(motionSource, /never re-letter, re-spell, re-position or tidy up label artwork/);
  assert.match(motionSource, /liquid surface stays horizontal when the product tilts/);
  assert.match(motionSource, /all five fingers keep the same grip points, shape and spacing in every frame/);

  // เจ้าของสั่ง 30 ก.ค. 2026: คลิปต้อง "ขายได้" ไม่ใช่โยก 8 องศาเหมือนกันทุกงาน
  // จึงเปิดให้ทำท่าใช้งานจริงได้หนึ่งท่าต่อคลิป — แต่การผ่อนนี้ "ต้องมาคู่กับด่านตรวจคลิป"
  // เท่านั้น ถ้าใครปิด CLIP_FIDELITY_CHECK เป็น default แล้วยังปล่อยท่าอิสระ = ไม่มีอะไรจับ
  // สินค้าเพี้ยนอีกเลย ทั้งฝั่งรูปและฝั่งคลิป
  assert.match(motionSource, /the product is the moving subject/);
  // job_129 (โทนเนอร์ iblanc): ทั้งสองคลิปเป็นภาพ "มือถือขวด" เหมือนกัน ต่างแค่มุมนิดเดียว
  // ทั้งที่ขวดมีฝาปั๊ม — คนดูไม่เคยเห็นสินค้าทำงานเลย ปล่อยให้ Gemini เลือกเองมันเลือกท่านิ่ง
  // → บังคับให้ช็อตที่ 2 เป็นต้นไปต้องมีท่าใช้งานเสมอ
  assert.match(motionSource, /function ensureLaterShotDemonstrates/);
  const locked2 = applyProductIdentityLock([
    'A hand holds the bottle toward camera.',
    'A hand holds the bottle toward camera.',
  ]);
  assert.match(locked2[1], /one slow, natural in-use action/, 'ช็อต 2 ที่ถือเฉยๆ ต้องถูกเปลี่ยนเป็นช็อตสาธิต');
  // เดิมยึด `$` ว่าพรอมต์ต้องจบด้วยประโยคท่า — ตั้งแต่ 1 ส.ค. มีไทม์ไลน์กล้องต่อท้าย
  // เจตนาของด่านคือ "ท่าที่มือไม่ได้เป็นประธานต้องรอด ไม่ถูกเขียนใหม่" ซึ่งยังตรวจได้เหมือนเดิม
  assert.match(locked2[0], /A hand holds the bottle toward camera\. Camera timeline/, 'ช็อตแรกที่มือไม่ได้เป็นตัวขยับยังคงได้');
  // เดิม assert ว่าท่าที่มือเป็นประธานต้องกลายเป็นประโยคสำรอง "เป๊ะตัวอักษร"
  // job_146 พิสูจน์ว่าการโยนทั้งประโยคทิ้งทำให้ท่าจืดเหมือนกันทุกงาน แล้วบทพากย์ที่เกาะ
  // describeMotionAction() ก็จืดตาม (CLAUDE.md เตือนไว้ว่า motion กับ narration ต้องขยับคู่กัน)
  // ตอนนี้สลับประธานให้สินค้าแทนโดยคงรายละเอียดท่าไว้ จึงตรวจ "เจตนาของด่าน" แทน:
  // ห้ามมีมือเป็นประธานของกริยาเคลื่อนไหวหลงเหลือในท่าที่ส่งเข้า Flow — ข้อนี้เข้มกว่าเดิม
  // เพราะเดิมตรวจแค่ประโยคเดียวที่รู้คำตอบล่วงหน้า
  // ⚠️ ห้ามใส่ pull/push/press/lift/shake/slide ในตัวนี้ — ทั้งหมดอยู่ใน IN_USE_ACTION_PATTERN
  // ด้วย ("the hand pulls one sheet from the pack" คือช็อตขายที่ต้องเก็บไว้ ดู assertion ข้างล่าง)
  const HAND_LED_RESIDUE = /\bhands?\s+(?:\w+ly\s+)?(?:brings?|carries?|sways?|rocks?|waves?|swings?|lowers?|angles?)\b/i;
  const productLedHook = applyProductIdentityLock(['A female hand lifts the bottle toward camera.']);
  assert.doesNotMatch(productLedHook[0], /A female hand lifts/);
  assert.doesNotMatch(productLedHook[0], HAND_LED_RESIDUE, 'ท่าที่ส่งเข้า Flow ห้ามให้มือเป็นประธาน');
  assert.match(productLedHook[0], /The bottle rises toward camera/, 'สลับประธานแล้วต้องคงรายละเอียดท่าเดิมไว้');

  // 🐛 ข้อความจริงสองบรรทัดที่หลุดด่านใน job_146 (31 ก.ค. 2026) — ตัวเดิมพังสามชั้นพร้อมกัน:
  // คำว่า "single" ไม่อยู่ในเซ็ตคำนำหน้า / ตรวจเฉพาะ clipIndex 0 / คำกริยามีแค่ 4 ตัว
  // ทั้งคู่ถูกส่งเข้า Flow โดยไม่มี WARN เลย แล้วไปขัดกับล็อกในพรอมต์ก้อนเดียวกัน
  // ⚠️ ตรวจตัวสลับประธานที่ sanitizeProductMotionPrompt() โดยตรง ไม่ใช่ผ่าน
  // applyProductIdentityLock() — ตัวหลังมี ensureLaterShotDemonstrates ต่อท้ายอีกด่านหนึ่ง
  // ซึ่งมีหน้าที่คนละอย่าง (บังคับให้ช็อต 2 เป็นช็อตใช้งาน) ถ้าตรวจผ่านตัวนอก
  // เราจะแยกไม่ออกว่าใครทำอะไร แล้วจะอ่านผลผิดเหมือนตอนแก้ camera-clause (1 ส.ค. 2026)
  const job146Clip1 = sanitizeProductMotionPrompt(
    "The single female hand brings the pink iblanc bottle closer to the camera, settling in a clear hero view showing the front label text 'Underarm Toning'.",
    0
  );
  const job146Clip2 = sanitizeProductMotionPrompt(
    "From the previous frame, the hand sways the bottle 8 degrees left and right while the camera pushes in slightly to focus on the '200 g' text.",
    1
  );
  assert.doesNotMatch(job146Clip1, HAND_LED_RESIDUE, 'job_146 คลิป 1: "the single female hand brings" ต้องไม่หลุด');
  assert.doesNotMatch(job146Clip2, HAND_LED_RESIDUE, 'job_146 คลิป 2: ต้องถูกตรวจด้วย ไม่ใช่แค่คลิปแรก');
  assert.match(job146Clip2, /8 degrees left and right/, 'รายละเอียดที่บทพากย์ต้องใช้ต้องไม่หายไปกับการแก้ประธาน');
  assert.match(job146Clip2, /200 g/, 'ตัวเลขบนฉลากที่ช็อตนี้โฟกัสต้องยังอยู่');
  const keptAction = applyProductIdentityLock([
    'A hand lifts the bottle.',
    'The same hand pumps toner onto a cotton pad and wipes.',
  ]);
  assert.match(keptAction[1], /pumps toner onto a cotton pad/, 'ท่าใช้งานที่ Gemini เขียนเองต้องไม่ถูกทับ');
  assert.match(
    readBackendSource('config.ts'),
    /clipFidelityCheckEnabled: optionalBool\('CLIP_FIDELITY_CHECK_ENABLED', true\)/,
    'ผ่อนท่าทางได้เฉพาะตอนด่านตรวจคลิปเปิดเป็นค่าเริ่มต้น'
  );
  // ผ่อนได้เฉพาะ "ท่าใช้งาน" เท่านั้น ห้ามผ่อนจนโมเดลต้องวาดด้านที่ไม่เคยเห็น/เอาของใหม่เข้าเฟรม
  assert.match(motionSource, /never show an unseen side, never invent unseen parts/);
  assert.match(motionSource, /No duplicates and no new objects entering frame/);
  for (const blocked of ['rotate', 'turning', 'spin', 'flip', 'unbox', 'placing', 'next to']) {
    assert.ok(
      sanitizeProductMotionPrompt(`The hand ${blocked} the product`, 1) !== `The hand ${blocked} the product`,
      `motion prompt ที่มีคำว่า "${blocked}" ต้องถูกเปลี่ยนเป็นท่าปลอดภัย`
    );
  }
  // ...แต่ท่าใช้งานจริงต้องผ่านได้ ไม่งั้นกลับไปนิ่งเหมือนเดิม (job_123/job_124)
  for (const allowed of ['opens the lid of', 'pulls one sheet from', 'pours a little from']) {
    const prompt = `The same hand ${allowed} the product`;
    assert.equal(
      sanitizeProductMotionPrompt(prompt, 1),
      prompt,
      `ท่าใช้งาน "${allowed}" ต้องไม่ถูกเปลี่ยนเป็นท่าโยกสำรอง`
    );
  }
  const pointing = 'A finger points beside the visible label.';
  assert.equal(
    sanitizeProductMotionPrompt(pointing, 1),
    pointing,
    'point/points/pointing ต้องไม่ถูกตัวกรอง drift แทนทิ้ง'
  );
  assert.match(
    applyProductIdentityLock(['A hand lifts the product.', pointing])[1],
    /points beside the visible label/,
    'ท่าชี้ในคลิปหลังต้องนับเป็นท่าสาธิตและไม่ถูก fallback ทับ'
  );

  const ttsSource = readBackendSource('gemini', 'tts-generator.ts');
  // หางเงียบของคลิปก่อนไปบวกกับเงียบนำของคลิปถัดไป → รอยต่อโหว่ ต้องหดทั้งคู่
  assert.match(ttsSource, /const ENDING_PAUSE_SECONDS = 0\.35/);
  assert.match(ttsSource, /const MINIMUM_ENDING_PAUSE_SECONDS = 0\.25/);
  // job_129: หางเงียบ 0.35s ของคลิปกลางไปตกคร่อมรอยต่อพอดี (วัดได้ 0.43s ที่วินาทีที่ 8)
  // เสียงหยุดตรงจังหวะที่ภาพเปลี่ยน = ฟังเหมือนสะดุด → คลิปกลางต้องใช้หางสั้นกว่าคลิปท้าย
  assert.match(ttsSource, /const SEAM_PAUSE_SECONDS = 0\.15/);
  assert.match(ttsSource, /isLastClip \? ENDING_PAUSE_SECONDS : SEAM_PAUSE_SECONDS/);
  assert.match(ttsSource, /clipTempoFilter\(\s*Math\.max\(0\.1, tightSpeech\),\s*secondsPerClip,\s*index === clipCount - 1,?\s*\)/);
  // ⚠️ ห้ามไปบีบช่วงเงียบ "ระหว่างประโยค" เพิ่ม — job_96 พิสูจน์ว่าจังหวะพูดจะแบนเหมือนหุ่นยนต์
  assert.match(ttsSource, /stop_duration=0\.45:stop_silence=0\.35/);
});

// job_129: บทพูด "สองร้อยมิลลิลิตร" ทั้งที่ขวดในภาพเขียน "200 g." — ผิดแบบที่คนดูเห็นเอง
check('ตัวเลขและหน่วยต้องอ่านจากฉลาก ห้ามเดาหรือแปลงหน่วยเอง (job_129)', () => {
  const promptSource = readPromptLayer();
  assert.match(promptSource, /ตัวเลขและหน่วยต้องอ่านจากฉลากบนสินค้าในภาพ ห้ามเดาหน่วยเอง/);
  assert.match(promptSource, /ห้ามแปลงหน่วยเอง \(กรัม↔มิลลิลิตร↔ชิ้น\)/);
  // ไม่มีข้อมูลยืนยัน = ตัดทิ้ง ไม่ใช่เดาให้ฟังดูดี
  assert.match(promptSource, /ห้ามพูดตัวเลขนั้นเลย\*\* — ตัดทิ้งดีกว่าพูดผิด/);
});

check('upscale 1080p ต้องเป็นของแถมที่ล้มแล้วไม่ทำให้งานพัง', () => {
  const ffmpegSource = readBackendSource('ffmpeg');
  assert.match(ffmpegSource, /config\.outputUpscale && !config\.outputSmooth/);
  // ห้ามซ้อนกับ minterpolate (มันทำ upscale ให้อยู่แล้ว) และต้อง fallback ไฟล์เดิมเมื่อพัง
  assert.match(ffmpegSource, /Upscale ล้มเหลว — ใช้ไฟล์/);
  assert.match(ffmpegSource, /await assertValidVideo\(upscaleTemp\)/);
});

// deep debug 27 ก.ค. 2026 — บั๊กจริง 2 ตัวที่เจอหลังปิด End frame
check('kill-switch End frame ต้องกันทั้ง "เจนใหม่" และ "ใช้ของเก่าที่ค้างบนดิสก์"', () => {
  const apiSource = readBackendSource('extension');
  // #98 ถูกสร้างตอน flag ยังเปิด → มี endImagePath ค้างอยู่ ถ้าไม่กรองตรงจุด resume
  // พอกลับมาทำต่อจะยังอัปโหลด End frame เข้า Flow ทั้งที่สั่งปิดไปแล้ว
  assert.match(apiSource, /config\.endFrameEnabled && vision\.endImagePath && fs\.existsSync\(vision\.endImagePath\)/);
});

check('callback ที่ตั้งเวลาไว้ต้องไม่ปล่อย unhandled rejection (บอทหยุดเงียบ)', () => {
  const backgroundSource = fs.readFileSync(path.join(root, 'extension', 'background.js'), 'utf8');
  assert.match(backgroundSource, /async function resumeAfterCooldown\(expectedCooldownUntil\)/);
  assert.match(backgroundSource, /console\.error\('\[ClipBot\] resumeAfterCooldown failed'/);
  // ทุกจุดที่พักแล้วเดินงานถัดไปด้วย nextJobCooldownUntil ต้องผ่าน resumeAfterCooldown
  // (งานจบ → งานใหม่ / ข้ามงานที่ fidelity ตก) — สองจุดนี้เป็นเส้นทางปกติของบอท
  const resumeCalls = backgroundSource.match(/setTimeout\(\(\) => \{ resumeAfterCooldown\(nextJobCooldownUntil\); \}/g) || [];
  assert.equal(resumeCalls.length, 2, 'จุดพักก่อนงานใหม่ต้องเรียก resumeAfterCooldown ทั้ง 2 จุด');
  // heartbeat ต้องใช้ทางเดียวกัน จะได้ดัก error เหมือนกัน
  assert.match(backgroundSource, /await resumeAfterCooldown\(cooldownUntil\);/);
});

// job_99: ตั้ง fps ปลายทาง 30 ทั้งที่ต้นทาง 24 → ffmpeg ก็อปเฟรมทุก 4 เฟรม
// (384 → 480 เฟรม) ได้ภาพกระตุกเป็นจังหวะ เจ้าของบอกว่าแย่กว่า job_96 ที่ 720p/24fps
check('ห้ามเปลี่ยนเฟรมเรตแบบหารไม่ลงตัวจนภาพกระตุก (job_99)', () => {
  const configSource = readBackendSource('config.ts');
  assert.match(configSource, /outputUpscaleFps: optionalInt\('OUTPUT_UPSCALE_FPS', 0\)/);
  const ffmpegSource = readBackendSource('ffmpeg');
  // 0 หรือเท่ากับต้นทาง = ไม่ใส่ filter fps เลย
  assert.match(ffmpegSource, /config\.outputUpscaleFps > 0 && config\.outputUpscaleFps !== config\.videoFps/);
  // ถ้าใครตั้งค่าหารไม่ลงตัวอีก ต้องเตือนให้เห็นใน log
  assert.match(ffmpegSource, /หารกับต้นทาง \$\{config\.videoFps\}fps ไม่ลงตัว/);
});

// เจ้าของแยกนโยบายพัก 27 ก.ค. 2026: ระหว่างคลิปในงานเดิม 1-3 นาที (เบา อยู่โปรเจกต์เดิม)
// แต่ข้ามไปงานใหม่ 3-5 นาที (หนัก ต้องสร้างโปรเจกต์ใหม่ + อัปโหลดชุดใหม่)
check('พักระหว่างคลิป 1-3 นาที แต่ข้ามไปงานใหม่ 3-5 นาที', () => {
  const backgroundSource = fs.readFileSync(path.join(root, 'extension', 'background.js'), 'utf8');
  assert.match(backgroundSource, /const NORMAL_COOLDOWN_MIN_MS = 1 \* 60 \* 1000;/);
  assert.match(backgroundSource, /const NORMAL_COOLDOWN_MAX_MS = 3 \* 60 \* 1000;/);
  assert.match(backgroundSource, /const NEXT_JOB_COOLDOWN_MIN_MS = 3 \* 60 \* 1000;/);
  assert.match(backgroundSource, /const NEXT_JOB_COOLDOWN_MAX_MS = 5 \* 60 \* 1000;/);
  // จุดที่ "จบงาน" และ "ข้ามงานที่ fidelity ตก" ต้องใช้ตัวยาว ไม่ใช่ตัวระหว่างคลิป
  const nextJobUses = backgroundSource.match(/randomNextJobCooldownMs\(current\.cooldownMultiplier\)/g) || [];
  assert.equal(nextJobUses.length, 2, 'ต้องมีจุดพักแบบงานใหม่ 2 จุด (งานจบ + ข้ามงาน fidelity)');
  // จุดระหว่างคลิป (รูป→คลิป, คลิป→คลิป) ต้องยังใช้ตัวสั้น
  const clipUses = backgroundSource.match(/= randomCooldownMs\(current\.cooldownMultiplier\)/g) || [];
  assert.equal(clipUses.length, 2, 'ต้องมีจุดพักระหว่างคลิป 2 จุด (หลังรูป + หลังคลิป)');
  // ข้อความบนหน้าจอต้องคำนวณจากค่าคงที่ ไม่ใช่เลขที่พิมพ์ตายไว้จนเพี้ยนตอนแก้ค่า
  assert.doesNotMatch(backgroundSource, /คูลดาวถัดไป 2[–-]6 นาที/);
});

// #99 กับ #101 ได้สินค้าตัวเดียวกัน (item 1601) และ item 69 ถูกใช้ไป 19 งาน
// เพราะ WHERE กันแค่ "สินค้าที่มีงานค้าง" พองานจบ/ล้ม มันกลับมาถูกสุ่มได้ทันที
check('สุ่มสินค้าต้องไล่ให้ครบคลังก่อนวนซ้ำ (#99 กับ #101 ได้ตัวเดียวกัน)', () => {
  const apiSource = readBackendSource('extension');
  // ยังต้องเลือกสินค้าที่ข้อมูลพร้อมก่อนเสมอ (กฎเดิม ห้ามหาย)
  assert.match(apiSource, /jsonb_array_length\(COALESCE\(i\.official_images, '\[\]'::jsonb\)\) > 0\s*\n?\s*\) DESC,/);
  // แล้วค่อยเรียง "ยังไม่เคยใช้ก่อน → ตัวที่ใช้นานสุด" ก่อนถึงจะ random
  assert.match(apiSource, /\(SELECT MAX\(j\.created_at\) FROM flow_job j WHERE j\.item_id = i\.id\) ASC NULLS FIRST/);
});

// job_100: บทพากย์ออกมาเป็นประโยคกลางๆ ไม่มีข้อมูลสินค้าเลย ทั้งที่ scrape มา 886 ตัวอักษร
// เพราะด่าน compliance ตกสองข้อ → ทิ้งบทที่ Gemini เขียนจากคลิปจริง แล้วถอยไปใช้บทสำรอง
check('ด่านตรวจบทต้องไม่ตกเพราะกฎที่ล้าสมัย (job_100 ได้บทกลางๆ ทั้งที่มีสเปก)', () => {
  const rulesSource = readNarrationLayer();
  const promptSource = readPromptLayer();
  const motionSource = readMotionLayer();

  // 1) องศาที่ "สั่ง" กับที่ "ตรวจ" ต้องตรงกัน — ลดเป็น 8° แล้วลืมแก้ตัวตรวจ = ตกทุกงาน
  assert.match(rulesSource, /REQUIRED_PIVOT_ANGLE = \/\\b\(\?:\[5-9\]\|1\[0-2\]\)\[\\s-\]\*/);
  assert.match(rulesSource, /มุมพลิก 5–12°/);
  // job #128: เปิดให้คลิปทำท่าใช้งานจริงแล้ว แต่ลืมบอกตัวตรวจ → ท่า "มือกดหมอนโชว์ความนุ่ม"
  // ที่ถูกต้องและขายได้ตกด่านเพราะไม่มีเลของศา บททั้งใบร่วงไปใช้บทสำรอง
  // เจตนาของด่านคือ "ต้องมีการเคลื่อนไหวที่ระบุชัด" ไม่ใช่ "ต้องมีเลข"
  assert.match(rulesSource, /!REQUIRED_PIVOT_ANGLE\.test\(clip2Motion\)\s*&&\s*!describesProductInUse\(clip2Motion\)/);
  // ⚠️ ตัวจับต้องประกาศที่เดียวแล้วแชร์กัน — แยกประกาศสองที่คือทางที่ job #128 พัง
  // (motion-prompts อนุญาตท่าใช้งาน แต่ตัวตรวจไม่รู้ บททั้งใบเลยตกไปใช้บทสำรอง)
  // 1 ส.ค. 2026: เปลี่ยนจากใช้ IN_USE_ACTION_PATTERN ตรงๆ มาเป็น describesProductInUse()
  // ซึ่งตัดวลีที่กล้องเป็นประธานออกก่อนตรวจ — ด่านบทกับด่าน motion ยังใช้ตัวเดียวกันเหมือนเดิม
  // (เจตนาเดิมคือ "ห้ามสองด่านหลุดจากกัน" ไม่ใช่ "ต้องชื่อ REQUIRED_IN_USE_ACTION")
  // เจตนา: ตัวตัดสิน "นี่คือท่าใช้งานไหม" ต้องถูกยืมมาจากที่ประกาศจริง ห้ามประกาศซ้ำที่นี่
  assert.match(rulesSource, /import \{[^}]*\bdescribesProductInUse\b[^}]*\} from '\.\/motion-prompts\.js';/);
  assert.doesNotMatch(rulesSource, /^const IN_USE_ACTION_PATTERN =/m, 'ห้ามประกาศตัวจับซ้ำในไฟล์นี้');
  assert.doesNotMatch(rulesSource, /^function describesProductInUse/m, 'ห้ามเขียนตัวตัดสินซ้ำในไฟล์นี้');
  assert.doesNotMatch(rulesSource, /^const IN_USE_ACTION_PATTERN =/m, 'ห้ามประกาศตัวจับซ้ำในไฟล์นี้');
  const inUse = /export const IN_USE_ACTION_PATTERN = (\/.+\/i);/.exec(motionSource);
  assert.ok(inUse, 'ต้องประกาศ IN_USE_ACTION_PATTERN ใน motion-prompts');
  // eslint-disable-next-line no-eval
  const actionPattern: RegExp = eval(inUse![1]);
  for (const motion of [
    'The same hand presses the pillow to show how soft it is',
    'The hand pulls one sheet from the pack',
    'The hand opens the lid and pours a little out',
  ]) {
    assert.ok(actionPattern.test(motion), `ท่าใช้งาน "${motion}" ต้องผ่านด่านได้`);
  }
  // ...แต่ท่าที่ไม่บอกอะไรเลยต้องยังตกเหมือนเดิม ไม่งั้นคลิปนิ่งก็ผ่าน
  for (const vague of ['The product stays in frame', 'A calm hero shot of the item']) {
    assert.ok(!actionPattern.test(vague), `ท่าที่ไม่ระบุการเคลื่อนไหว "${vague}" ต้องไม่ผ่าน`);
  }
  assert.doesNotMatch(promptSource, /about 20 degrees/);
  assert.doesNotMatch(motionSource, /about 20 degrees/);
  // ท่าสำรองของคลิป 2 ต้องใช้คำที่ตัวตรวจร่วมรู้จัก ไม่งั้นซ่อมแล้วยังตกอยู่ดี
  assert.match(motionSource, /one slow, natural in-use action/);

  // 2) "รักษา" เดี่ยวๆ กว้างเกิน — สินค้าเคลือบยางเขียนว่า "รักษายางรถยนต์" = ถนอม ไม่ใช่รักษาโรค
  assert.match(rulesSource, /รักษา\(\?=\.\{0,8\}\(\?:โรค\|อาการ/);
  // "ความดัน" ต้องไม่จับความดันลม/น้ำ/อากาศ
  assert.match(rulesSource, /ความดัน\(\?!ลม\|น้ำ\|อากาศ\)/);
  // แต่ชื่อโรคเดี่ยวๆ ต้องยังบล็อกได้เหมือนเดิม
  assert.match(rulesSource, /ภูมิแพ้\|โรค\|ป่วย\|อักเสบ/);
});

// job_102: บทถูกต่อประโยคสำรองแล้วตัดตามเพดาน เหลือหางลอย "...เลยค่ะ ใช้" กับ
// "...คุ้มค่ามากกับราคา" → เสียงหยุดกลางประโยค เจ้าของได้ยินเป็น "เสียงขัด"
check('บทพากย์ต้องจบประโยคสมบูรณ์เสมอ ห้ามเหลือหางลอย (job_102)', () => {
  const rulesSource = readNarrationLayer();
  assert.match(rulesSource, /export function trimToCompleteThaiEnding/);
  // ต่อได้พอดีก็ต้องไม่ตัดเลย
  assert.match(rulesSource, /if \(spokenLength\(combined\) <= MAX_NARRATION_CHARS_PER_CLIP\) return combined;/);
  // ตัดแล้วไม่ดีขึ้น ต้องคืนบทเดิมที่จบสมบูรณ์ ไม่ใช่ทิ้งไปใช้ประโยคสำรองล้วน
  assert.match(rulesSource, /บทสั้นกว่าเกณฑ์นิดหน่อยยังฟังรู้เรื่อง/);

  const twoClips = [
    ensureMinimumNarration('ร้อนๆ แบบนี้พกพัดลมหนีบขนาดแปดนิ้วรุ่นนี้ไว้ อุ่นใจขึ้นเยอะเลยค่ะ', 0),
    ensureMinimumNarration('ด้วยแบตเตอรี่ในตัวขนาดใหญ่ ชาร์จง่ายใช้งานได้ยาวนาน สนใจสั่งซื้อได้เลยนะคะ', 1),
  ];
  twoClips.forEach((line, index) => {
    assert.match(line, /(?:ค่ะ|คะ|ครับ|จ้า|[.!?])$/u, `บทคลิป ${index + 1} เหลือหางลอย: "${line}"`);
  });
  // เนื้อสเปกจริงต้องไม่ถูกตัดทิ้งเพราะการซ่อม
  assert.match(twoClips[0], /พัดลมหนีบขนาดแปดนิ้ว/);
  assert.match(twoClips[1], /แบตเตอรี่ในตัวขนาดใหญ่/);
});

// job_102: เฟรมตั้งต้นจับที่ตัวหนีบแล้วปล่อยหัวพัดลมห้อย = สินค้าคว่ำ พอคลิป 2
// Veo แก้ให้ตั้งตรง ผู้ชมเห็นสินค้า "พลิกเอง" กลางวิดีโอ
check('สินค้าต้องอยู่ในทิศตั้งตรงตามการใช้งานจริง และห้ามพลิกกลางคลิป (job_102)', () => {
  const apiSource = readBackendSource('extension');
  // job #122: รูปรีวิวถ่ายกลับหัวมาเอง แล้ว prompt ดันสั่งให้ "หันเหมือนต้นฉบับ"
  // → Flow คว่ำตาม และ fidelity ผ่านเพราะตรงต้นฉบับจริง ห้ามผูกทิศกับรูปต้นฉบับอีก
  assert.doesNotMatch(apiSource, /same way up as the source/);
  // job #124: แต่ "stand it upright" ก็แก้เกิน — ห่อทิชชู่ทรงนอนถูกหมุนตั้ง ตัวหนังสือ
  // ตะแคง 90° แล้ว Veo เขียนฉลากใหม่มั่วทั้งใบในคลิปถัดมา เกณฑ์ต้องเป็น "อ่านแนวนอนได้"
  // ไม่ใช่ "ตั้งตรง" และต้องคงทรงเดิมของสินค้าไว้
  assert.doesNotMatch(apiSource, /Stand it upright/);
  assert.match(apiSource, /Keep the product's own natural pose/);
  assert.match(apiSource, /never stand a wide pack on end or lay a tall bottle down/);
  assert.match(apiSource, /front label reads horizontally, right way up/);
  assert.match(apiSource, /never sideways or inverted/);
  assert.match(apiSource, /without changing the product or its orientation/);
  const motionSource = readMotionLayer();
  // ตัดคำว่า "rotate it upright" ออกตั้งแต่ 30 ก.ค. 2026 เพราะขัดกับเกณฑ์ใหม่ที่ยึด
  // "คงทรงเดิมของสินค้า" (ห่อนอนต้องนอน) — แต่ข้อห้ามพลิกกลางคลิปยังต้องอยู่ครบ
  assert.match(motionSource, /keeps the exact same way up for the whole clip; never flip or re-orient it/);
});

// job #104: เปิดวิธี A แล้วรูปมุมเสริมค้างอยู่ในช่องพรอมต์ของโปรเจกต์เดิม พอสลับเป็นโหมด
// วิดีโอ บอทหาช่อง Start frame ไม่เจอ → ล้มทั้งงานทั้งที่เพิ่งจ่ายเครดิตรูปไปแล้ว
check('วิธี A ต้องขึ้นโปรเจกต์ใหม่ก่อนเจนคลิป (job #104 หาช่อง Start frame ไม่เจอ)', () => {
  const backgroundSource = fs.readFileSync(path.join(root, 'extension', 'background.js'), 'utf8');
  assert.match(backgroundSource, /const usedExtraReferences = current\.currentJob\.usedExtraReferences === true/);
  assert.match(backgroundSource, /projectReady: !\(usedExtraReferences && outcome\.data\.stage === 'video'\)/);
  // ต้องพกธงต่อ ไม่งั้นขั้น End frame ที่คั่นกลางจะทำให้เช็คไม่เจอ
  // ไฟล์ extension เป็น CRLF — ต้องรับทั้ง \r\n และ \n ไม่งั้นจับไม่เจอทั้งที่โค้ดถูก
  assert.match(backgroundSource, /usedExtraReferences,\r?\n/);
  // content.js ต้องยังมีเส้นทาง "ขึ้นโปรเจกต์ใหม่เมื่อ projectReady=false"
  const contentSource = fs.readFileSync(path.join(root, 'extension', 'content.js'), 'utf8');
  assert.match(contentSource, /if \(job\.clipIndex === 0 && !job\.projectReady\)/);
});

// เจ้าของสั่ง 27 ก.ค. 2026: เฟรมตั้งต้นใช้รูปถ่ายจริงจากรีวิว ส่วนรูปทางการ (ซึ่งเป็น
// แบนเนอร์โฆษณามีตัวหนังสือ/นางแบบ/คอลลาจ) ให้ไปเป็น "ส่วนผสม" 3 รูปตอนเจนคลิปแทน
check('เฟรมตั้งต้นใช้รูปรีวิว ส่วนรูปทางการเป็นส่วนผสม 3 รูป', () => {
  const apiSource = readBackendSource('extension');
  assert.match(apiSource, /const preferReview = config\.firstImageSource === 'review';/);
  assert.match(apiSource, /candidates = preferReview && reviewPaths\.length \? reviewPaths/);
  // ส่วนผสมต้องมาจาก officialPaths เสมอ ห้ามหยิบจาก candidates ที่ตอนนี้อาจเป็นรูปรีวิว
  // รายการรูปทางการต้องถูกเก็บเสมอ (ใช้เป็นส่วนผสมตอนเจนคลิป) ส่วนการ "แนบตอนเจนรูป"
  // ถูกคุมแยกด้วย attachAtImageStage — ปิดวิธี A แล้วส่วนผสมต้องไม่หายไปด้วย
  // 31 ก.ค.: เปลี่ยนจาก "หยิบ 3 ใบแรก" เป็น "ให้ Gemini คัดก่อน" (ตัดโปสเตอร์/ภาพผ่าซีกทิ้ง)
  // กฎเดิมไม่เปลี่ยน — ต้นทางยังต้องเป็น officialPaths และต้องไม่เอารูปที่เลือกไปทำเฟรมตั้งต้นซ้ำ
  assert.match(apiSource, /const \{ picked: referenceImagePaths \} = await pickIngredientImages\(/);
  assert.match(apiSource, /officialPaths\.filter\(\(imagePath\) => imagePath !== selectedPaths\[0\]\)/);
  const configSource = readBackendSource('config.ts');
  assert.match(configSource, /referenceImageCount: optionalInt\('REFERENCE_IMAGE_COUNT', 3\)/);
  assert.match(configSource, /optional\('FIRST_IMAGE_SOURCE', 'review'\)/);
});

// เจ้าของออกแบบ 27 ก.ค. 2026: คลิป 1 ใช้โหมดส่วนผสม (รูปที่เจน + รูปทางการ 3 รูป)
// คลิป 2 ใช้โหมดเฟรมต่อจากเฟรมสุดท้าย — โหมดส่วนผสมไม่มีช่อง Start frame จึงต่อคลิปไม่ได้
// selector ทั้งหมดยืนยันจาก DOM จริง ดู data/flow-diagnostic-ingredients.json
check('คลิป 1 ใช้โหมดส่วนผสม คลิปถัดไปใช้โหมดเฟรม', () => {
  const contentSource = fs.readFileSync(path.join(root, 'extension', 'content.js'), 'utf8');
  // แท็บส่วนผสมใช้ ligature chrome_extension (เฟรมใช้ crop_free)
  assert.match(contentSource, /chrome_extension\|ส่วนผสม\|Ingredient/);
  assert.match(contentSource, /async function configureVideo\(mode = 'frames'\)/);
  // ต้องเลือกโหมดตามพารามิเตอร์ ห้าม hardcode แท็บเฟรมกลับมา
  assert.match(contentSource, /await selectRequiredTab\(modePattern, modeLabel\);/);
  assert.doesNotMatch(contentSource, /selectRequiredTab\(\/crop_free\|เฟรม/);
  // โหมดส่วนผสมไม่มีช่อง Start/End frame — ต้องไม่เรียกสองตัวนั้น
  assert.match(contentSource, /if \(useIngredients\) \{\s*\n\s*await uploadIngredients\(job\.ingredientUrls, job\.jobId\);/);
  // แนบทีละรูปผ่านเส้นทางอัปรูปเดี่ยวที่พิสูจน์แล้ว (รายละเอียดอยู่ในเช็ค "แนบส่วนผสมทีละรูป")
  assert.match(contentSource, /await uploadStartFrame\(imageUrls\[index\]/);
  // หาปุ่มไม่เจอต้องหยุดก่อนกด Generate เสมอ ห้ามเดาต่อ
  assert.match(contentSource, /หยุดก่อนใช้เครดิต/);

  const backgroundSource = fs.readFileSync(path.join(root, 'extension', 'background.js'), 'utf8');
  // ส่งส่วนผสมเฉพาะคลิปแรก
  assert.match(backgroundSource, /stage === 'video' && Number\(current\.currentJob\.clipIndex\) === 0\s*\n?\s*&& Array\.isArray\(current\.currentJob\.ingredientImagePaths\)/);

  const apiSource = readBackendSource('extension');
  // ทั้งเส้นทาง claim และเส้นทางส่งงานตรงหลังเซฟรูป ต้องแนบส่วนผสมทั้งคู่
  //
  // ⚠️ เดิมนับรูปแบบ `ingredientImagePaths: buildIngredientPaths(` แบบ inline
  // 1 ส.ค. 2026 ย้ายไปคำนวณใส่ตัวแปรก่อน เพราะพรอมต์ต้องรู้จำนวนรูปที่แนบด้วย
  // (ดูเช็ค "โหมดส่วนผสมต้องบอก Flow ว่ารูปไหนคือสินค้าตัวจริง") เจตนาเดิมยังอยู่ครบ
  // จึงตรวจว่าทั้งสองเส้นทาง "คำนวณ" และ "แนบ" ครบคู่แทนการยึดรูปแบบ inline
  const builds = apiSource.match(/= config\.ingredientsModeEnabled[\s\S]{0,80}?buildIngredientPaths\(/g) || [];
  assert.equal(builds.length, 2, 'ต้องคำนวณส่วนผสมทั้งเส้นทาง claim และเส้นทางส่งตรง');
  const attaches = apiSource.match(/ingredientImagePaths: (?:ingredientPaths|firstClipIngredients)\b/g) || [];
  assert.equal(attaches.length, 2, 'ต้องแนบส่วนผสมทั้งเส้นทาง claim และเส้นทางส่งตรง');
  assert.match(apiSource, /config\.ingredientsModeEnabled && !clipPaths\.length/);
  // รูปหลักที่ผ่าน fidelity ต้องมาก่อน และไฟล์ที่หายต้องถูกกรองทิ้ง
  assert.match(apiSource, /\[mainImagePath, \.\.\.extras\]/);
  assert.match(apiSource, /\.filter\(\(imagePath\) => fs\.existsSync\(imagePath\)\)/);
});

// job #107: โหมดส่วนผสมทำงานได้ แต่ช่องพรอมต์ยังมีพรอมต์ตอนเจนรูปค้างอยู่
// Ctrl+A + Backspace ล้างไม่โดนเพราะโฟกัสค้างที่ปุ่ม "เพิ่มไปยังพรอมต์"
// ผลคือพรอมต์รูปกับพรอมต์คลิปต่อกันเป็นก้อนเดียว (เห็นชัดในภาพ: "no watermarkContinuity lock:")
check('ช่องพรอมต์ต้องสะอาดก่อนพิมพ์ และตรวจซ้ำก่อนจ่ายเครดิต (job #107)', () => {
  const contentSource = fs.readFileSync(path.join(root, 'extension', 'content.js'), 'utf8');
  // ต้องคลิกเข้าไปในช่องด้วยเมาส์จริง element.focus() อย่างเดียวไม่พอกับ Lexical
  assert.match(contentSource, /await trustedClick\(editor\)\.catch\(/);
  // ตรวจซ้ำหลังพิมพ์: ยาวเกินคาด = มีของเก่าค้าง ต้องหยุดก่อนกด Generate
  assert.match(contentSource, /boxText\.length > expected \* 1\.3 \+ 40/);
  assert.match(contentSource, /ช่องพรอมต์มีข้อความค้างจากขั้นก่อน/);
});

// job #109: อัป extension แล้ว background เป็นโค้ดใหม่ แต่แท็บ Flow ยังรัน content.js ตัวเก่า
// ซึ่งส่ง TYPE_PROMPT มาโดยไม่มี jobId → ตัวกันงานข้ามตีเป็น "งาน #? ไม่ใช่งานปัจจุบัน" แล้วฆ่างาน
check('content script รุ่นเก่าค้างในแท็บต้องรีโหลดแล้วทำต่อ ไม่ใช่ฆ่างาน (job #109)', () => {
  const backgroundSource = fs.readFileSync(path.join(root, 'extension', 'background.js'), 'utf8');
  // แยกเคส "ไม่มี jobId เลย" (สคริปต์เก่า) ออกจาก "jobId ไม่ตรง" (งานเปลี่ยนจริง)
  assert.match(backgroundSource, /if \(!Number\.isInteger\(jobId\)\) \{/);
  assert.match(backgroundSource, /flow\.stale-content/);
  assert.match(backgroundSource, /content script รุ่นเก่าค้างในแท็บ/);
  // ต้องอยู่กลุ่ม "แก้เองได้ ลองใหม่เร็ว" ไม่ใช่โดนพัก 20 นาที เพราะยังไม่ได้กด Generate
  assert.match(backgroundSource, /คลังสื่อปิดหลังเพิ่ม\|รูปปรากฏในช่อง \(\?:Start\|End\) frame\|content script รุ่นเก่าค้างในแท็บ/);
  // กันไว้ตั้งแต่ต้นทาง: อัป extension แล้วรีโหลดแท็บ Flow ให้เลย
  assert.match(backgroundSource, /chrome\.tabs\.reload\(tab\.id\)/);
  // ⛔ job #111: รีโหลดทั้งที่มีงานค้าง → onUpdated ยิงงานซ้ำ → เจนรูปเดิม 2 รอบ เสียเครดิตฟรี
  assert.match(backgroundSource, /if \(!current\.currentJob\) \{\s*\n\s*try \{\s*\n\s*const flowTabs/);
  // ⛔ และห้ามล้าง submittedFor ในเส้นทางกู้ content script เก่า — มันคือด่านกันส่งซ้ำ
  assert.match(backgroundSource, /ห้ามล้าง submittedFor ตรงนี้เด็ดขาด/);
  assert.doesNotMatch(
    backgroundSource,
    /flow\.stale-content[\s\S]{0,400}?storage\.local\.remove\('submittedFor'\)/
  );
  // ข้อความเดิมที่ไม่มีเลขงานต้องไม่กลับมา
  assert.doesNotMatch(backgroundSource, /งาน #\$\{jobId \|\| '\?'\}/);
});

// job #111/#113: กด Generate เสร็จ generateImage คืนค่าทันที (working=false) แล้วมีข้อความ
// สั่งงานเดิมเข้ามาอีกในวินาทีเดียวกัน → อัปโหลด+พิมพ์พรอมต์ทับ → รูปซ้ำ 2 ใบ เผาเครดิตฟรี
// submittedFor ฝั่ง background ผ่าน storage จึงแพ้ race — ต้องมีด่านในหน้าเว็บที่ข้ามไม่ได้
check('กดจ่ายเครดิตแล้วห้ามทำขั้นเดิมซ้ำในหน้าเดียวกัน (job #111/#113)', () => {
  const contentSource = fs.readFileSync(path.join(root, 'extension', 'content.js'), 'utf8');
  assert.match(contentSource, /const submittedInThisPage = new Set\(\);/);
  // ต้องคุมทั้งขั้นเจนรูปและขั้นเจนคลิป และต้องเช็ค "ก่อน" ตั้ง working เพื่อไม่ให้ finally ล้างทิ้ง
  const guards = contentSource.match(/if \(submittedInThisPage\.has\(paidKey\)\) \{/g) || [];
  assert.equal(guards.length, 2, 'ต้องมีด่านกันซ้ำทั้งขั้นเจนรูปและขั้นเจนคลิป');
  const marks = contentSource.match(/submittedInThisPage\.add\(paidKey\);/g) || [];
  assert.equal(marks.length, 2, 'ต้องปักธงหลังกด Generate ทั้งสองขั้น');
  // ปักธงต้องอยู่หลังคลิกจริงเท่านั้น ไม่ใช่ตอนเริ่มขั้น — ตรวจว่าบรรทัดถัดไปคือข้อความ
  // "ส่งไปแล้ว" ของแต่ละขั้น (ถ้าย้ายไปปักตอนเริ่ม งานที่ล้มก่อนกดจะกลับมาทำต่อไม่ได้)
  const lines = contentSource.split(/\r?\n/);
  const markedAt = lines
    .map((line, index) => (line.includes('submittedInThisPage.add(paidKey);') ? index : -1))
    .filter((index) => index >= 0);
  assert.equal(markedAt.length, 2);
  markedAt.forEach((index) => {
    assert.match(lines[index + 1], /generation submitted|ส่งสร้างคลิป/, `ปักธงผิดที่บรรทัด ${index + 1}`);
  });
});

// เจ้าของสั่ง 27 ก.ค. 2026 หลังเห็นอาการจริง 2 อย่าง:
//   1) แนบส่วนผสมต้องอัป "ทีละรูป" — ยัดทีเดียวหลายไฟล์แล้ว Flow เพี้ยน
//   2) กด Generate แล้วเหมือนไม่ได้กด (พรอมต์กับรูปยังค้าง)
// ส่องปุ่มจริงแล้วพบว่า Flow ใช้ aria-disabled ส่วน .disabled เป็น false เสมอ และ
// pointer-events:all ตลอด → คลิกลงไปได้แม้ตอนที่ยังไม่พร้อม ต้องเช็คว่าจุดกดโดนบังไหม
check('แนบส่วนผสมทีละรูป + ตรวจจุดกดปุ่มส่งก่อนคลิกจริง', () => {
  const contentSource = fs.readFileSync(path.join(root, 'extension', 'content.js'), 'utf8');
  // ต้องวนเรียกเส้นทางอัปรูปเดี่ยวที่พิสูจน์แล้ว ห้ามยัด DataTransfer หลายไฟล์ทีเดียว
  assert.match(contentSource, /for \(let index = 0; index < imageUrls\.length; index\+\+\) \{\s*\n\s*await uploadStartFrame\(imageUrls\[index\]/);
  assert.doesNotMatch(contentSource, /files\.forEach\(\(file\) => transfer\.items\.add\(file\)\);/);
  // ก่อนยิงคลิกต้องยืนยันว่าจุดกึ่งกลางปุ่มไม่โดนอะไรบัง
  assert.match(contentSource, /document\.elementFromPoint\(x, y\)/);
  assert.match(contentSource, /covered: !hit \|\| !\(hit === element \|\| element\.contains\(hit\)/);
  assert.match(contentSource, /ไม่กดมั่วเพราะจะเสียเครดิตแบบไม่รู้ผล/);
  // โดนบังต้องลองเลื่อนเข้าจอก่อน แล้วค่อยยอมแพ้
  assert.match(contentSource, /element\.scrollIntoView\(\{ block: 'center' \}\)/);
});

// job #116: "Nano Banana Pro is unavailable" ทั้งที่ตัวเลือกอยู่ในเมนูจริง เพราะใช้ regex
// แบบ ^...$ กับข้อความที่ Flow เอา ligature ไอคอนมาต่อกัน (กติกาที่ CLAUDE.md เตือนไว้แล้ว)
check('ห้ามจับข้อความ Flow ด้วย regex ยึดหัวท้ายในจุดที่ไอคอนต่อกับคำ (job #116)', () => {
  const contentSource = fs.readFileSync(path.join(root, 'extension', 'content.js'), 'utf8');
  // เมนูเลือกโมเดลรูปต้องจับแบบ substring
  assert.match(contentSource, /\/Nano\\s\*Banana\\s\*Pro\/i/);
  assert.doesNotMatch(contentSource, /\^🍌\?\\s\*Nano Banana Pro\$/);
  // แท็บ 9:16 ก็เรนเดอร์เป็น "crop_9_169:16" — ห้ามยึดหัวท้ายเช่นกัน
  assert.doesNotMatch(contentSource, /\^\(\?:9:16\|crop_9_16\)\$/);
  // แต่ยังต้องกันไปโดน Nano Banana 2 Lite — ต้องมีคำว่า Pro อยู่ในตัวจับ
  assert.match(contentSource, /const findProModel = \(\) => byText\(/);
});

// job #118/#119: ล้มด้วยข้อความเดียวกันภายใน 1.7 วินาที ทั้งที่ไม่เคยกดเปิดเมนูโมเดลเลย
// เพราะคว้าปุ่มตั้งค่า composer (aria-expanded="true" ค้างอยู่) แทนปุ่มเลือกโมเดลในแผง
check('ต้องกดปุ่มเลือกโมเดลตัวจริง ไม่ใช่ปุ่มตั้งค่าที่เปิดค้างอยู่ (job #118/#119)', () => {
  const contentSource = fs.readFileSync(path.join(root, 'extension', 'content.js'), 'utf8');
  // ปุ่มเลือกโมเดลมี ligature "arrow_drop_down" เสมอ — ใช้แยกจากปุ่มตั้งค่าชั้นนอก
  assert.match(contentSource, /const pickModelDropdown = \(\) => \{/);
  assert.match(contentSource, /\.filter\(\(el\) => \/arrow_drop_down\/i\.test\(el\.textContent \|\| ''\)\)/);
  assert.doesNotMatch(
    contentSource,
    /querySelectorAll\('\[aria-haspopup="menu"\]'\)\)\s*\.find\(\(el\) => \/Nano Banana\|Imagen\/i/
  );
  // openPanel ห้ามลัดด้วย aria-expanded เมื่อผู้เรียกบอกวิธียืนยันมาแล้ว
  // ไม่งั้นแผงชั้นนอกที่เปิดค้างจะทำให้ "เปิดสำเร็จ" ทั้งที่ไม่เคยกด
  assert.match(
    contentSource,
    /const isOpen = \(\) => \(typeof confirmOpen === 'function'\s*\?\s*Boolean\(confirmOpen\(\)\)\s*:\s*button\.getAttribute\('aria-expanded'\) === 'true'\)/
  );
});

// job #120: Flow เปลี่ยนป้ายจำนวนผลลัพธ์จาก "1x" เป็น "x1" ตัวจับ /^1x$/i เลยไม่มีวันตรง
// ทั้งที่ Flow เลือก x1 ไว้ให้อยู่แล้ว — ล้มหลังจ่ายเครดิตรูปตั้งต้นไปแล้ว
check('ป้ายจำนวนผลลัพธ์ต้องรับทั้ง "x1" และ "1x" และห้ามไปโดน x2/x10 (job #120)', () => {
  const contentSource = fs.readFileSync(path.join(root, 'extension', 'content.js'), 'utf8');
  const declared = /const ONE_OUTPUT_PATTERN = (\/.+\/i);/.exec(contentSource);
  assert.ok(declared, 'ต้องประกาศ ONE_OUTPUT_PATTERN ไว้ที่เดียว ห้ามเขียน regex ซ้ำหลายจุด');
  // eslint-disable-next-line no-eval
  const pattern: RegExp = eval(declared![1]);
  for (const good of ['x1', '1x', 'crop_9_16x1', 'วิดีโอ · 8scrop_9_16x1']) {
    assert.ok(pattern.test(good), `ONE_OUTPUT_PATTERN ต้องจับ "${good}" ได้`);
  }
  for (const bad of ['x2', 'x3', 'x4', 'x10', '16:9', 'crop_16_916:9']) {
    assert.ok(!pattern.test(bad), `ONE_OUTPUT_PATTERN ต้องไม่ไปโดน "${bad}"`);
  }
  // ห้ามเหลือ regex ยึดหัวท้ายแบบเดิมค้างอยู่จุดไหน
  assert.doesNotMatch(contentSource, /\/\^\(\?:1x\|1\)\$\/i/);
  assert.doesNotMatch(contentSource, /\/\^1x\$\/i(?!\s*จึง)/);
  // แท็บจำนวนผลลัพธ์ต้องค้นใน [role="tab"] เท่านั้น ไม่งั้นไปโดนปุ่ม composer ที่ลงท้าย x1
  assert.match(contentSource, /const oneImage = byText\('\[role="tab"\]', ONE_OUTPUT_PATTERN\)/);
});

// job #124: โหมดส่วนผสมวาดสินค้าขึ้นใหม่ ไม่ได้ขยับพิกเซลของรูปตั้งต้น เฟรมที่ 0 ของคลิป
// จึงเพี้ยนได้ทันที ("บ้านไผ่ รู้ใจคนรักความสะอาด" → "Brapt Cemual", "L 420" → "L x2G")
// ทั้งที่รูปตั้งต้นผ่าน fidelity gate มาแล้ว — prompt กันไม่ได้ ต้องตรวจผลลัพธ์
check('เฟรมแรกของคลิปต้องตรงกับรูปที่ป้อนเข้า Flow (job #124)', () => {
  const mediaSource = readBackendSource('utils', 'media.ts');
  const apiSource = readBackendSource('extension');
  const configSource = readBackendSource('config.ts');
  assert.match(mediaSource, /export async function extractFirstFrame/);
  assert.match(configSource, /clipFidelityCheckEnabled: optionalBool\('CLIP_FIDELITY_CHECK_ENABLED', true\)/);
  // ⚠️ ด่านนี้ต้องอ่อนกว่าด่านรูปตั้งต้น เพราะคลิปจ่ายเครดิตไปแล้ว: ตรวจเฉพาะสิ่งที่แปลว่า
  // "สินค้าคนละตัว" (หมวด/สี/แบรนด์บนฉลาก) ไม่เอาท่ามือหรือทรงชั่วขณะมาตัดสิน
  // ตั้งแต่ 1 ส.ค. 2026 โหมดถูกเลือกตามว่าช็อตนั้นเป็นช็อตใช้งานจริงหรือไม่ (ดู demoActionFor)
  // แต่ต้องเป็นโหมดตระกูล clip เสมอ และต้องส่งรูปอ้างอิงที่อนุมัติแล้วไปด้วยเสมอ
  assert.match(
    apiSource,
    /compareGeneratedProductFidelity\(\s*referencePath,\s*framePath,\s*inUseShot \? 'clip_in_use' : 'clip',\s*approvedReferencePaths\s*\)/
  );
  const fidelitySource = readBackendSource('gemini', 'fidelity-check.ts');
  assert.match(
    fidelitySource,
    /isClipFrame\s*\?\s*\(checks\.category && checks\.colors && checks\.visibleText\)\s*\|\|\s*score >= config\.clipFidelityMinScore/
  );
  // เกณฑ์ตระกูล clip ต้องครอบทั้งสองโหมด ห้ามมีโหมดไหนหลุดไปใช้เกณฑ์เข้มของรูปตั้งต้น
  assert.match(fidelitySource, /const isClipFrame = compareMode === 'clip' \|\| compareMode === 'clip_in_use'/);
  // silhouette / componentLayout / openClosedState ต้องไม่อยู่ในเกณฑ์ของโหมด clip
  // ไม่งั้นคลิปที่ถูกต้องจะโดนตีตกเพราะมือจับคนละจุดกับรูปที่ป้อนเข้าไป
  assert.match(configSource, /clipFidelityMinScore: optionalInt\('CLIP_FIDELITY_MIN_SCORE', 70\)/);
  // job #126 (รองเท้า Marco): เฟรมแรกของคลิปเปลี่ยนมุม/ระยะ จนคำว่า "Marco" หลุดออกนอกภาพ
  // ถ้าปล่อยให้ "อ่านฉลากไม่ได้" = ตก visibleText คลิปที่ถูกต้องจะโดนตีตกแทบทุกใบ
  // ต้องตกเฉพาะตอน "มีตัวหนังสืออ่านได้ และเป็นแบรนด์อื่น" (เคส Brapt Cemual ของ #124)
  assert.match(
    fidelitySource,
    /Mark "visibleText" TRUE whenever the label is simply not readable, not visible or cut off/
  );
  assert.match(fidelitySource, /FALSE only when readable branding is present AND it is clearly DIFFERENT branding/);
  // แสงและไวต์บาลานซ์ที่เปลี่ยนตามฉากใหม่ต้องไม่นับเป็นสีเพี้ยน
  assert.match(fidelitySource, /a warmer or cooler cast on the same materials is not a color change/);
  // ต้องตรวจ "ก่อน" ย้ายไฟล์ไปเป็น checkpoint ไม่งั้นคลิปเสียถูกนับเป็นคลิปที่สำเร็จไปแล้ว
  const gateAt = apiSource.indexOf('await assertClipMatchesItsSourceFrame(');
  const commitAt = apiSource.indexOf('fs.renameSync(incomingPath, clipPath)');
  assert.ok(gateAt > 0 && commitAt > gateAt, 'ต้องตรวจเฟรมแรกก่อน rename เป็น clipPath');
  // รูปอ้างอิงต้องเป็นรูปที่ป้อนเข้าไปจริงของคลิปนั้น ไม่ใช่รูปตั้งต้นเสมอ
  assert.match(apiSource, /clipIndex === 0\s*\?\s*vision\?\.generatedImagePath\s*:\s*path\.join\(jobDir, `continuity_\$\{clipIndex\}\.jpg`\)/);
  // ใช้ marker เดิมเพื่อให้กลไกกันวนเผาเครดิต (fidelityFailStreak) ทำงานต่อได้
  assert.match(apiSource, /PRODUCT_FIDELITY_BLOCK: คลิป \$\{clipIndex \+ 1\}/);
  // คลิปที่จ่ายเครดิตแล้วต้องเก็บไว้ตรวจสาเหตุ ห้ามลบทิ้งเฉยๆ
  assert.match(apiSource, /_rejected\.mp4/);
  // ⚠️ Gemini ล่ม/เน็ตหลุด = ไม่มีหลักฐานว่าคลิปเสีย ต้องปล่อยผ่าน ไม่ใช่ทิ้งของที่จ่ายแล้ว
  const gateBody = apiSource.slice(
    apiSource.indexOf('async function assertClipMatchesItsSourceFrame'),
    apiSource.indexOf('export async function storeExtensionClip')
  );
  const catchBlock = gateBody.slice(gateBody.indexOf('} catch'), gateBody.indexOf('} finally'));
  assert.doesNotMatch(catchBlock, /throw/, 'ตรวจไม่ได้ต้องปล่อยผ่าน ห้าม throw ทิ้งคลิปที่จ่ายแล้ว');
  assert.match(catchBlock, /return;/);
});

// 30 ก.ค. 2026: แก้ backend แล้วลืมรีสตาร์ต service ทำให้บอทวิ่งด้วยโค้ดเก่าทั้งงานหลายรอบ
// (#122 ล้มซ้ำจุดเดิม, #125/#126 ไม่ได้ fix เลย) ตัวคุมนี้รีสตาร์ตให้เอง "เฉพาะตอนว่าง"
check('ตัวคุม service ต้องรีสตาร์ตเองได้ แต่ห้ามตัดกลางงานที่จ่ายเครดิตแล้ว', () => {
  const source = fs.readFileSync(path.join(root, 'backend', 'scripts', 'serve-auto.ts'), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['control:auto'], 'tsx backend/scripts/serve-auto.ts');
  // ⚠️ หัวใจของตัวนี้: ต้องเช็คว่าว่างก่อนเสมอ ห้ามฆ่า service ทันทีที่ไฟล์เปลี่ยน
  // (นี่คือเหตุผลที่ไม่ใช้ tsx watch ตรงๆ — มันตัดกลางตอน POST คลิปที่จ่ายแล้วได้)
  const tickBody = source.slice(source.indexOf('if (!restartPending) return;'));
  assert.match(tickBody, /if \(!isIdle\(\)\)/);
  const idleAt = tickBody.indexOf('isIdle()');
  const restartAt = tickBody.indexOf('restartNow()');
  assert.ok(idleAt > 0 && restartAt > idleAt, 'ต้องเช็ค isIdle() ก่อนเรียก restartNow()');
  assert.match(source, /if \(state\.currentJobId === null \|\| state\.currentJobId === undefined\) return true;/);
  // service ตายเองต้องปลุกกลับ ไม่งั้นบอทหยุดเงียบทั้งระบบ
  assert.match(source, /service ดับเอง/);
  // ⚠️ ต้องมีลูกได้ตัวเดียว: 30 ก.ค. 15:01 การรีสตาร์ตจากไฟล์เปลี่ยนกับการปลุกหลัง crash
  // ต่างคนต่างตั้ง setTimeout → ได้ลูกสองตัว ตัวหนึ่งยึดพอร์ต อีกตัววนตาย EADDRINUSE ไม่จบ
  assert.match(source, /let pendingSpawn: NodeJS\.Timeout \| null = null;/);
  assert.match(source, /if \(pendingSpawn\) clearTimeout\(pendingSpawn\);/);
  assert.match(source, /if \(stopping \|\| child\) return;\s*\n\s*startService\(\);/);
  // ตายเร็วซ้ำๆ ต้องถ่างจังหวะ ไม่ใช่กระแทกทุก 3 วินาทีจนวนสร้างโปรเซสทิ้ง
  assert.match(source, /quickDeaths >= 3 \? 60_000 : 3_000/);
  // 🐛 งาน #158 (3 ส.ค. 2026 10:04): ตัวคุมพิมพ์ "มีงานเดินอยู่ — เลื่อนการรีสตาร์ต" แล้ว
  // **5 วินาทีถัดมา** พิมพ์ "บอทว่างแล้ว" และรีสตาร์ตจริง ทั้งที่บอทกำลังอัปรูปส่วนผสมอยู่
  //
  // ⚠️ ด่านนี้เคย assert ว่า `> 60_000) return true;` — คือล็อกพฤติกรรมที่เป็นบั๊กไว้เอง
  // พร้อมคอมเมนต์ว่า "เงียบนาน = ต้องถือว่าว่าง" ซึ่งกลับหัวจากความจริง
  // Extension ยิงสถานะไม่ผ่านตอน 10:04:31 ค่าจึงค้าง พอครบ 60 วิ ตัวคุมก็เด้งเป็นว่างทันที
  //
  // "บอทบอกว่าจบแล้ว" กับ "บอทเงียบไป" เป็นคนละเรื่องกัน และอย่างหลังคือช่วงที่อันตรายที่สุด
  // ที่จะไปตัด ไม่ใช่ปลอดภัยที่สุด — รอบนั้นรอดเพราะยังไม่ทันจ่ายเครดิตวิดีโอ
  //
  // ข้อกังวลเดิมยังถูกและยังต้องมีทางออก: ถ้าเบราว์เซอร์ถูกปิดกลางงานจริง ตัวคุมต้องไม่เป็น
  // อัมพาตตลอดกาล จึงยอมรีสตาร์ตได้หลังเงียบนานพอที่จะมั่นใจว่างานถูกทิ้งแล้ว
  assert.doesNotMatch(source, /> 60_000\) return true;/, 'ห้ามกลับไปอ่าน "เงียบ" ว่า "ว่าง"');
  assert.match(source, /const ABANDONED_MS = 15 \* 60_000;/);
  assert.match(source, /if \(silentMs > ABANDONED_MS\)/, 'มีงานค้างแล้วเงียบ ต้องรอจนแน่ใจว่าถูกทิ้ง');
  const idleBody = source.slice(source.indexOf('function isIdle()'), source.indexOf('function restartNow()'));
  assert.ok(
    idleBody.lastIndexOf('return false;') > idleBody.indexOf('silentMs'),
    'มีงานค้างและยังเงียบไม่นานพอ ต้องตอบว่าไม่ว่าง'
  );
});

// job_126: รองเท้าแตะแต่บทพูดว่า "ใช้ง่ายไม่ยุ่งยาก" — คำกริยาไม่ตรงหมวดสินค้า ฟังแล้วแปลก
check('คำกริยาในบทต้องตรงวิธีใช้จริงของสินค้าหมวดนั้น (job_126 รองเท้าต้อง "ใส่")', () => {
  const promptSource = readPromptLayer();
  assert.match(promptSource, /คำกริยาต้องตรงกับวิธีใช้จริงของสินค้าหมวดนั้น/);
  assert.match(promptSource, /ห้ามใช้คำกลางๆ อย่าง "ใช้ง่าย\/ใช้ดี"/);
  // ต้องมีตัวอย่างคำกริยาให้ยึด ไม่ใช่บอกลอยๆ ว่า "ให้ตรงหมวด"
  assert.match(promptSource, /รองเท้า\/เสื้อผ้า\/กระเป๋า → \*\*ใส่ \/ สวม \/ สะพาย\*\*/);
  assert.match(promptSource, /ครีม\/โลชั่น\/เซรั่ม → \*\*ทา \/ บำรุง\*\*/);
});

// job_132: น้ำยาเคลือบยางรถถูกวางบนโต๊ะเครื่องแป้ง มีขวดเครื่องสำอางเบลออยู่ข้างหลัง
// เพราะลิสต์ฉากหลังเดิมเป็นบ้าน/ครัว/โต๊ะแต่งหน้าล้วน ไม่มีฉากยานยนต์เลย
check('ฉากหลังต้องตรงหมวดสินค้า ไม่ใช่สุ่มจากลิสต์กลางๆ (job_132)', () => {
  const source = readBackendSource('extension', 'reference-style.ts');
  assert.match(source, /const BACKGROUND_FAMILIES/);
  assert.match(source, /export function pickBackgroundStyle\(productTitle: string\)/);
  // ⚠️ เดิมข้อนี้ดึง regex ออกมาจากซอร์สด้วย /match: \/([^/]+)\/iu,\s*\n\s*scenes:/
  //    ซึ่งผูกกับ "หน้าตาของโค้ด" ไม่ใช่พฤติกรรม พอ 1 ส.ค. ย้ายคำหมวดยานยนต์ไปเป็น
  //    ค่าคงที่ร่วม (CAR_CARE_PATTERN) เพื่อไม่ให้สองตารางเลื่อนออกจากกัน ข้อนี้ก็ FAIL ทันที
  //    ทั้งที่พฤติกรรมถูกต้องขึ้น จึงเปลี่ยนมาตรวจ "ฉากที่ได้จริง" ผ่าน pickBackgroundStyle()
  //    ซึ่งเข้มกว่าเดิมด้วย เพราะครอบทั้งตารางฉากหลังและตารางหมวดสาธิตที่มาทับทีหลัง
  const AUTOMOTIVE_SCENE = /garage|driveway|tyre|wheel|car\b/i;
  const WRONG_FOR_AUTOMOTIVE = /vanity|bedroom|nursery|kitchen counter|dining table/i;
  for (const title of ['ซิลิโคนออยล์ ทายาง กันน้ำ Cerax Wax', 'น้ำยาล้างรถ', 'สเปรย์เคลือบเงายางรถ']) {
    const scene = pickBackgroundStyle(title);
    assert.match(scene, AUTOMOTIVE_SCENE, `"${title}" ต้องได้ฉากยานยนต์ — ได้ "${scene}"`);
    assert.doesNotMatch(scene, WRONG_FOR_AUTOMOTIVE, `"${title}" ห้ามได้ฉากในบ้าน — ได้ "${scene}"`);
  }
  // ...แต่ต้องไม่ลากสินค้าคนละหมวดเข้ามา
  for (const title of ['โลชั่นบำรุงผิว', 'หมอนหนุน TOTORI']) {
    assert.doesNotMatch(pickBackgroundStyle(title), AUTOMOTIVE_SCENE, `"${title}" ต้องไม่ได้ฉากยานยนต์`);
  }
  // job_133: ชุดถังปั่นไม้ม็อบถูพื้นไปตกบนเคาน์เตอร์ครัวหินอ่อน เพราะไม่เข้าหมวดไหนเลย
  assert.match(
    pickBackgroundStyle('ถังปั่นไม้ม๊อบ ถังปั่นไม้ถูพื้น Spin Mop'),
    /floor/i,
    'ของถูพื้นต้องอยู่บนพื้น ไม่ใช่บนโต๊ะ'
  );
  assert.doesNotMatch(pickBackgroundStyle('โลชั่นบำรุงผิว'), /floor/i, 'โลชั่นต้องไม่ตกไปอยู่บนพื้น');
  // ชื่อที่ไม่เข้าหมวดไหนเลยต้องยังได้ฉากกลางๆ ไม่ใช่พัง
  assert.match(source, /const scenes = family\?\.scenes \|\| BACKGROUND_STYLES;/);
  assert.match(
    readBackendSource('extension', 'extension-api.ts'),
    /pickReferenceStyle\(productTitle\)/,
    'ต้องส่งชื่อสินค้าเข้าไปเลือกฉาก ไม่งั้นตกกลับไปสุ่มมั่วเหมือนเดิม'
  );
});

// job_134: คลิปโชว์ "มือเปิดตัวหนีบพัดลม" แต่บทพูดเรื่องปรับแรงลม 3 ระดับ + หมุน 360°
// เพราะคนเขียนบทเห็นแต่วิดีโอ ไม่เคยรู้ว่าช็อตนั้นถูกสั่งให้ทำท่าอะไร
// (ctx.motionPrompts ถูกส่งเข้ามาตั้งนานแล้ว แต่ไม่มีโค้ดไหนหยิบไปใช้เลยสักบรรทัด)
check('คนเขียนบทต้องรู้ว่าช็อตนั้นตั้งใจให้ทำท่าอะไร (job_134)', () => {
  const promptSource = readPromptLayer();
  const motionSource = readMotionLayer();
  assert.match(motionSource, /export function describeMotionAction/);
  assert.match(promptSource, /const action = describeMotionAction\(ctx\.motionPrompts\[index\] \|\| ''\)/);
  assert.match(promptSource, /สิ่งที่ช็อตนี้ตั้งใจให้เกิดขึ้น/);
  assert.match(promptSource, /ประโยคต้องเริ่มจาก "สิ่งที่กำลังเกิดขึ้นในช็อตนั้น" ก่อนเสมอ/);

  // ต้องตัดล็อกความเหมือนทิ้งจริง ไม่งั้นคนเขียนบทได้แต่คำสั่งเทคนิคยาวเหยียดแทนท่าที่ทำ
  const stripped = describeMotionAction(applyProductIdentityLock([
    'The same hand opens the clip base of the fan.',
  ])[0]);
  assert.equal(stripped, 'The same hand opens the clip base of the fan.');
  assert.doesNotMatch(stripped, /Continuity lock/);
  // พรอมต์ของคลิปต่อเนื่องก็ต้องถูกตัดหัวออกเหมือนกัน
  assert.doesNotMatch(
    describeMotionAction(buildFlowContinuationPrompt(
      'Continuity lock: exact same product. Silent footage: no dialogue, music or sound effects. A hand pulls one sheet.'
    )),
    /Continue from the previous final frame/
  );
});

check('service watchdog หยุดงาน in-progress ที่ไม่มี Extension ดูแล', () => {
  const apiSource = readBackendSource('extension');
  const serverSource = readBackendSource('server');
  assert.match(apiSource, /export async function failOrphanedExtensionJobs/);
  assert.match(apiSource, /'generating_image'/);
  assert.match(apiSource, /AND \(\$2::integer IS NULL OR id <> \$2::integer\)/);
  // ⚠️ ต้องอ่านจาก config ไม่ใช่ฝังเลข — STALE_JOB_MINUTES ใน .env เคยเป็นปุ่มหลอกที่
  // ตั้งแล้วไม่มีผล เพราะที่นี่ hardcode 20 ไว้ (30 ก.ค. 2026)
  assert.match(serverSource, /ORPHAN_JOB_STALE_MINUTES = Math\.max\(20, config\.staleJobMinutes\)/);
  // ...แต่พื้นล่าง 20 นาทีต้องอยู่ ไม่งั้นตั้งต่ำๆ แล้ว watchdog ฆ่างานที่ Flow ยังเจนอยู่
  // (Flow ใช้เวลาได้ถึง 15 นาที) = เผาเครดิตที่จ่ายไปแล้วทิ้ง
  assert.match(serverSource, /Math\.max\(20,/);
  assert.match(serverSource, /ORPHAN_WATCHDOG_INTERVAL_MS = 60_000/);
  assert.match(serverSource, /await runOrphanJobWatchdog\(\)/);
});

check('Gemini JSON ขาด comma ระหว่าง property', () => {
  const malformed = JSON.stringify(validResult, null, 2)
    .replace(/("narrationScript"[^\n]+),\n/, '$1\n');
  assert.equal(parseGeminiVisionJson(malformed).narrationScript, validResult.narrationScript);
});

check('Gemini ส่ง object ส่วนเกินต่อท้าย', () => {
  const scalarMalformed = `{
    "pass": true
    "score": 88
    "checks": {
      "category": true,
      "colors": true
    },
    "differences": []
  }`;
  const scalarParsed = parseGeminiVisionJson(scalarMalformed) as unknown as Record<string, unknown>;
  assert.equal(scalarParsed.pass, true);
  assert.equal(scalarParsed.score, 88);

  const doubled = `${JSON.stringify(validResult)}\n{"ignored":true}`;
  assert.deepEqual(parseGeminiVisionJson(doubled), validResult);
});

check('วงเล็บปีกกาใน string ไม่ทำให้ตัวสแกนตัด JSON ผิดจุด', () => {
  const withTrailingText = `${JSON.stringify(validResult)} trailing`;
  assert.equal(parseGeminiVisionJson(withTrailingText).narrationScript, validResult.narrationScript);
});

check('JSON ที่ไม่มี object สมบูรณ์ต้องถูกปฏิเสธ', () => {
  assert.throws(() => parseGeminiVisionJson('{"motionPrompts": ['));
});

check('เลือกภาพเหลือหนึ่งภาพและตัด index ผิดช่วง', () => {
  assert.deepEqual(normalizeSelectedImageIndices([9, -1, 1, 1], 3, 1), [1]);
});

check('review media ไม่จำกัดวันที่แล้ว — ใช้รูปทั้งหมดที่มี url (เจ้าของสั่ง 2026-07-23)', () => {
  const nowMs = Date.parse('2026-07-21T00:00:00.000Z');
  // ทุกรูปที่มี url ใช้ได้ ไม่สนวันที่ (เดิม old/future/no-timestamp เป็น false)
  assert.equal(isEligibleReviewMedia({ url: 'new.jpg', type: 'image', reviewTimestamp: REVIEW_MEDIA_START_EPOCH_SECONDS }, nowMs), true);
  assert.equal(isEligibleReviewMedia({ url: 'old.jpg', type: 'image', reviewTimestamp: REVIEW_MEDIA_START_EPOCH_SECONDS - 1 }, nowMs), true);
  assert.equal(isEligibleReviewMedia({ url: 'no-timestamp.jpg', type: 'image' }, nowMs), true);
  assert.equal(isEligibleReviewMedia({ url: '', type: 'image' }, nowMs), false);
  // SQL ไม่ filter reviewTimestamp แล้ว (เหลือแค่ type='image')
  const apiSource = readBackendSource('extension');
  assert.doesNotMatch(apiSource, /reviewTimestamp'\)::double precision >=/);
});

check('content script ติดอาวุธ watcher ก่อนคลิก Generate', () => {
  const content = fs.readFileSync(path.join(root, 'extension', 'content.js'), 'utf8');
  const arm = content.indexOf("type: 'FLOW_ARM_WATCH'");
  const click = content.indexOf('await trustedClick(generate, { windowsCursor: true })', arm);
  // รับได้ทั้งแบบมีและไม่มี argument กดซ้ำ (codex เพิ่ม retryClick เข้ามาภายหลัง)
  const confirmation = content.indexOf('await confirmGenerateAccepted(generate,', click);
  assert.ok(arm >= 0 && click > arm, 'FLOW_ARM_WATCH must appear before the Windows-cursor Generate click');
  assert.ok(confirmation > click, 'Generate submission must be confirmed after the trusted click');
  assert.match(content, /humanClick\(element, \{ allowDomFallback: false \}\)/,
    'Generate must use the Windows cursor and fail closed instead of falling back to DOM click');
});

check('Generate acceptance is separate from stale failed cards (jobs #136/#138)', () => {
  const content = fs.readFileSync(path.join(root, 'extension', 'content.js'), 'utf8');
  const background = fs.readFileSync(path.join(root, 'extension', 'background.js'), 'utf8');
  const start = content.indexOf('async function confirmGenerateAccepted');
  const end = content.indexOf('/**', start + 10);
  const confirmation = content.slice(start, end);
  assert.doesNotMatch(
    confirmation,
    /failedGenerationCardCount/,
    'an old failed card must never prove that the current Generate click was accepted'
  );
  assert.match(background, /let currentGenerationObserved = false;/);
  assert.match(background, /if \(data\?\.pendingGeneration\) currentGenerationObserved = true;/);
  assert.match(background, /const currentFailedCard = Boolean\(currentGenerationObserved && data\?\.failedCard\);/);
  assert.match(background, /if \(!found && currentFailedCard && Date\.now\(\) < failedCardGraceUntil\)/);
});

check('dashboard and startup expose effective Flow flags (stale .env guard)', () => {
  const dashboard = fs.readFileSync(
    path.join(root, 'backend/src/server/routes/dashboard.routes.ts'),
    'utf8'
  );
  const server = fs.readFileSync(path.join(root, 'backend/src/server/index.ts'), 'utf8');
  const flags = fs.readFileSync(path.join(root, 'backend/src/server/runtime-flags.ts'), 'utf8');
  assert.match(dashboard, /featureFlags:\s*readFlowRuntimeFlags\(\)/);
  assert.match(server, /featureFlags = readFlowRuntimeFlags\(\)/);
  for (const key of [
    'ingredientsModeEnabled',
    'endFrameEnabled',
    'firstImageSource',
    'referenceImagesEnabled',
    'referenceImageCount',
    'clipFidelityCheckEnabled',
  ]) {
    assert.match(flags, new RegExp(`${key}: config\\.${key}`), `missing effective flag: ${key}`);
  }
});

check('image watcher cannot accept an old reference solely from its label', () => {
  const background = fs.readFileSync(path.join(root, 'extension', 'background.js'), 'utf8');
  assert.match(background, /filter\(\(candidate\) => !known\.has\(candidate\.key\)\)/);
  assert.doesNotMatch(
    background,
    /\(mediaType === 'image' && candidate\.generated\) \|\| !known\.has\(candidate\.key\)/
  );
  assert.match(background, /mediaType !== 'image' \|\| candidate\.generated/);
});

check('image watcher skips a late-resolved uploaded reference and keeps watching the paid request (#112)', () => {
  const background = fs.readFileSync(path.join(root, 'extension', 'background.js'), 'utf8');
  assert.match(background, /function isDuplicateReferenceImageError\(error\)/);
  assert.match(background, /if \(isDuplicateReferenceImageError\(error\)\) \{/);
  assert.match(background, /if \(rejectedKey\) known\.add\(rejectedKey\);/);
  assert.match(background, /flow\.image-reference-skipped/);
  // Candidate ที่ตรวจแล้วว่าเป็นรูปอ้างอิงต้องกลับไปเฝ้า Generate เดิม ห้ามตกไป
  // failCurrent ซึ่งจะเริ่ม recovery และเสี่ยงส่ง Generate ซ้ำ
  assert.match(background, /flow\.image-reference-skipped[\s\S]*continue;/);
});

check('content script resumes a saved checkpoint in a new Flow project', () => {
  const content = fs.readFileSync(path.join(root, 'extension', 'content.js'), 'utf8');
  assert.match(content, /กำลังกู้ checkpoint คลิป/);
  assert.match(content, /continuity_N\.jpg/);
  assert.match(content, /FLOW_CREATING_PROJECT/);
});

check('pre-submit upload recovery reuses the existing asset and heartbeat redispatches safely', () => {
  const content = fs.readFileSync(path.join(root, 'extension', 'content.js'), 'utf8');
  const background = fs.readFileSync(path.join(root, 'extension', 'background.js'), 'utf8');
  assert.match(content, /พบ \$\{fileName\} ในคลังแล้ว — ใช้ไฟล์เดิมเพื่อกู้งาน/);
  // media-library fix 3 ชั้น (Flow React unmount แท็บที่ไม่ active → role=option หลุด DOM):
  // (1) คลิกแท็บ "การอัปโหลด" (2) รับสัญญาณ option หรือ ปุ่มเพิ่ม (3) auto-select กดเพิ่มตรง
  assert.match(content, /const uploadsTab = \(\)/);
  assert.match(content, /return startFrameApplied\(\) \|\| selectable \|\| hasAddButton\(\)/);
  // รองรับบัญชี Ultra / Flow ภาษาอังกฤษ: รูปในคลังเป็น <img alt> ไม่ใช่ role=option → หา+คลิกเอง
  assert.match(content, /const findUploadedThumb = \(\)/);
  assert.match(content, /el\.getAttribute\('alt'\) \|\| ''\)\.toLowerCase\(\)\.includes\(wanted\)/);
  assert.match(content, /รูป auto-select แล้ว/);
  assert.match(content, /Date\.now\(\) - addStartedAt < 180000/);
  assert.match(content, /!el\.hasAttribute\('disabled'\)/);
  assert.match(content, /await sleep\(15000\)/);
  // Flow รุ่นปัจจุบันมีช่อง Start frame จริง ต้องใช้ช่องนี้ก่อนปุ่ม + เพื่อไม่ให้
  // continuity image ถูกแนบเป็น prompt media แต่ช่องเฟรมต้นยังว่าง
  assert.match(content, /const findStartFrameSlot = \(\)/);
  assert.match(content, /if \(startFrame\) \{[\s\S]*usedExplicitStartSlot = true/);
  assert.ok(
    content.indexOf('if (startFrame) {') < content.indexOf("const plusButton = byText(CLICKABLE, /add_2/i)"),
    'explicit Start frame must be preferred over the generic media picker'
  );
  assert.match(content, /while \(!addToPrompt && !startFrameApplied\(\)/);
  assert.match(content, /Flow ใส่รูปเป็น Start frame และปิดคลังให้อัตโนมัติ/);
  // ค่าถูกขยาย 6 → 8 นาทีเมื่อ 30 ก.ค. เพราะจังหวะพิมพ์แบบใหม่ใช้เวลานานกว่า 70ms คงที่
  // ตรวจแค่ว่ายัง "มีเพดาน" และไม่สั้นจนตัดงานที่ยังพิมพ์อยู่
  assert.match(background, /PRE_SUBMIT_STALL_TIMEOUT_MS = ([6-9]|1[0-5]) \* 60 \* 1000/);
  assert.match(background, /pre-submit\.watchdog/);
  assert.match(background, /jobProgressAt: Date\.now\(\)/);
  assert.match(background, /await chrome\.storage\.local\.remove\('submittedFor'\);[\s\S]*await sendCurrentJob\(tab\.id\)/);
});

check('media-library timeout retries the same unpaid checkpoint and ignores stale job errors', () => {
  const content = fs.readFileSync(path.join(root, 'extension', 'content.js'), 'utf8');
  const background = fs.readFileSync(path.join(root, 'extension', 'background.js'), 'utf8');
  assert.match(background, /MEDIA_LIBRARY_RETRY_LIMIT = 3/);
  assert.match(background, /async function recoverMediaLibraryTimeout/);
  assert.match(background, /\['awaitingImage', 'awaitingVideo'\]\.includes\(job\.phase\)/);
  assert.match(background, /forceNewProject: true/);
  assert.match(background, /chrome\.tabs\.reload\(tab\.id\)/);
  assert.match(background, /current\.currentJob\?\.jobId !== Number\(message\.jobId\)/);
  assert.match(background, /const recovered = await recoverMediaLibraryTimeout/);
  assert.match(background, /forceNewProject: current\.currentJob\.forceNewProject === true/);
  assert.match(content, /type: 'FLOW_ERROR',\s+jobId: job\.jobId/s);
});

check('video generation strictly requires Frames, Omni Flash, 9:16, 1x and 8s', () => {
  const content = fs.readFileSync(path.join(root, 'extension', 'content.js'), 'utf8');
  // โหมดถูกเลือกผ่าน modePattern แล้ว (เฟรม/ส่วนผสม) — ตรวจว่า pattern ของเฟรมยังอยู่ครบ
  assert.match(content, /crop_free\|เฟรม\|\\bFrames\?\\b/);
  assert.match(content, /await selectRequiredTab\(modePattern, modeLabel\);/);
  assert.match(content, /selectRequiredTab\(\/crop_9_16\|9:16/);
  // ยังต้องบังคับ "1 ผลลัพธ์" เหมือนเดิม แต่ Flow เปลี่ยนป้ายเป็น "x1" แล้ว (job #120)
  // ตัวจับย้ายไปอยู่ที่ ONE_OUTPUT_PATTERN ซึ่งมีเช็คของตัวเองอีกชุด
  assert.match(content, /selectRequiredTab\(ONE_OUTPUT_PATTERN, '1x'\)/);
  assert.match(content, /selectRequiredTab\(\/\^8s\$\/i/);
  assert.match(content, /Flow ยังไม่ได้เลือก/);
  assert.match(content, /Omni\\s\*Flash/);
  assert.match(content, /else await trustedClick\(button\)/);
  assert.match(content, /typeof confirmOpen === 'function'/);
  assert.match(content, /adds a sidebar "ดูวิดีโอ" button/);
  assert.doesNotMatch(content, /Omni\|Veo\|Imagen\|วิดีโอ\|Video/);
  assert.match(content, /const clearStartFrame = frameControls/);
  assert.match(content, /frameControls\.querySelectorAll\('button'\)/);
  assert.match(content, /ช่อง Start frame หลังล้างรูปเดิม/);
});

check('video model is selected before its duration option', () => {
  const content = fs.readFileSync(path.join(root, 'extension', 'content.js'), 'utf8');
  const configureStart = content.indexOf("async function configureVideo(mode = 'frames')");
  const configureEnd = content.indexOf('async function uploadStartFrame', configureStart);
  const configure = content.slice(configureStart, configureEnd);
  const modelConfirmed = configure.indexOf('`Flow ยืนยันโมเดล ${VIDEO_MODEL_LABEL}`');
  const durationSelected = configure.indexOf("selectRequiredTab(/^8s$/i, '8 วินาที')");
  assert.ok(modelConfirmed >= 0 && durationSelected > modelConfirmed);

  // เจ้าของสั่งเปลี่ยนโมเดลวิดีโอเมื่อ 3 ส.ค. 2026 — Veo 3.1 Lite [Lower Priority] ใช้ 0 เครดิต
  assert.equal(
    /const VIDEO_MODEL_LABEL = '(.+)';/.exec(content)?.[1],
    'Veo 3.1 - Lite [Lower Priority]'
  );

  // ⚠️ กับดักที่ต้องกันไว้ตลอด: เมนูมี `Veo 3.1 - Lite` อยู่เหนือ
  // `Veo 3.1 - Lite [Lower Priority]` และเป็นคนละโมเดลที่กินเครดิต
  // ตัวจับที่ไม่ระบุ Lower Priority จะไปโดนตัวบนเสมอ — กับดักเดียวกับ #116
  // (Nano Banana Pro ไปโดน Nano Banana 2 Lite) ซึ่งล้มไปแล้วสามงาน
  const pattern = /const VIDEO_MODEL_PATTERN = (\/.+\/i);/.exec(content)?.[1];
  assert.ok(pattern, 'ต้องมี VIDEO_MODEL_PATTERN');
  const modelPattern = new RegExp(pattern!.slice(1, -2), 'i');
  assert.ok(modelPattern.test('Veo 3.1 - Lite [Lower Priority]'), 'ต้องจับตัวที่ต้องการได้');
  assert.ok(!modelPattern.test('Veo 3.1 - Lite'), 'ห้ามไปโดน Veo 3.1 - Lite ตัวธรรมดา');
  assert.ok(!modelPattern.test('Veo 3.1 - Fast'), 'ห้ามไปโดน Fast');
  assert.ok(!modelPattern.test('Omni Flash'), 'ห้ามไปโดนโมเดลเดิม');
  // Flow เอา ligature ไอคอนมาต่อกับข้อความเสมอ ตัวจับจึงห้ามยึดหัวท้าย
  assert.ok(modelPattern.test('Veo 3.1 - Lite [Lower Priority]arrow_drop_down'), 'ต้องทนต่อ ligature');
});

check('a deleted source item can resume from a complete checkpoint', () => {
  const apiSource = readBackendSource('extension');
  assert.match(apiSource, /j\.vision_result IS NOT NULL/);
  assert.match(apiSource, /jsonb_array_length\(j\.clip_paths\) > 0/);
  assert.match(apiSource, /สินค้าต้นทางถูกลบและ checkpoint ไม่สมบูรณ์/);
  assert.match(apiSource, /FOR UPDATE OF j SKIP LOCKED/);
});

check('Node owns legacy dataset/item schema and supplies every blocking default', () => {
  const database = readBackendSource('db', 'database.ts');
  assert.match(database, /CREATE TABLE IF NOT EXISTS dataset/);
  assert.match(database, /CREATE TABLE IF NOT EXISTS item/);
  assert.match(database, /clipforge_schema_migration/);
  assert.match(database, /ALTER COLUMN status SET DEFAULT 'pending'/);
  assert.match(database, /ALTER COLUMN post_state SET DEFAULT ''/);
  assert.match(database, /ALTER COLUMN posted_verified SET DEFAULT FALSE/);
  assert.match(database, /ALTER COLUMN post_message SET DEFAULT ''/);
  assert.match(database, /ALTER COLUMN post_ref SET DEFAULT ''/);
  assert.match(database, /ALTER COLUMN media_json TYPE JSONB/);
});

check('scrape ingest accepts legacy text JSON and canonical JSONB media arrays', () => {
  const media = [{ url: 'https://example.test/a.jpg', type: 'image' }];
  assert.deepEqual(parseStoredMedia(media), media);
  assert.deepEqual(parseStoredMedia(JSON.stringify(media)), media);
  assert.deepEqual(parseStoredMedia('not-json'), []);
  assert.deepEqual(parseStoredMedia('{"url":"not-an-array"}'), []);
});

check('scrape ingest is idempotent and rejects corrupted legacy text', () => {
  assert.equal(looksEncodingCorrupted('ชื่อสินค้าและรีวิวภาษาไทยปกติ'), false);
  assert.equal(looksEncodingCorrupted('ดีไหม?'), false);
  assert.equal(looksEncodingCorrupted('??????????'), true);
  assert.equal(looksEncodingCorrupted('ข้อความเสีย \uFFFD'), true);

  const database = readBackendSource('db', 'database.ts');
  const ingest = readBackendSource('scrape', 'harvester-api.ts');
  // Shopee Harvester อยู่นอกโปรเจกต์และเปลี่ยนเลขเวอร์ชันบ่อย (0.2.1 → 0.2.7)
  // เดิม hardcode ไว้ที่ 0.2.2 พอโฟลเดอร์นั้นถูกลบ เช็คทั้งชุดก็พังทันที
  // → เลือกเวอร์ชันล่าสุดที่มีอยู่จริง และข้ามไปถ้าไม่มีเลย (คนละ repo กัน)
  const parentDir = path.resolve(root, '..');
  const harvesterDir = fs.existsSync(parentDir)
    ? fs.readdirSync(parentDir)
      .filter((name) => /^Shopee-Harvester-[\d.]+$/.test(name)
        && fs.existsSync(path.join(parentDir, name, 'content.js')))
      .sort()
      .pop()
    : undefined;
  if (!harvesterDir) {
    console.log('SKIP ตรวจ Shopee Harvester — ไม่พบโฟลเดอร์ (อยู่นอกโปรเจกต์นี้)');
    return;
  }
  const extensionRoot = path.join(parentDir, harvesterDir);
  const content = fs.readFileSync(path.join(extensionRoot, 'content.js'), 'utf8');
  const background = fs.readFileSync(path.join(extensionRoot, 'background.js'), 'utf8');

  assert.match(database, /CREATE TABLE IF NOT EXISTS scrape_ingest_batch/);
  assert.match(database, /VALUES \(2, 'Make scraper ingest batches idempotent'\)/);
  assert.match(ingest, /ON CONFLICT \(job_id, batch_id\) DO NOTHING/);
  assert.match(ingest, /FOR UPDATE/);
  assert.match(ingest, /รีวิวจริงจากผู้ซื้อ:/);
  assert.match(content, /captureBuffer/);
  assert.match(content, /batch_id/);
  assert.match(content, /HARVEST_DIAGNOSTIC/);
  assert.match(background, /msg\.type === ["']HARVEST_BATCH["']/);
  assert.match(background, /await finishJob/);
});

check('Gemini plans shot-led hands-on ecommerce reviews before image and narration', () => {
  const promptSource = readBackendSource('gemini');
  assert.match(promptSource, /E-COMMERCE HANDS-ON REVIEW STORY \(REQUIRED\)/);
  assert.match(promptSource, /วาง shotPlans ก่อน/);
  assert.match(promptSource, /Clip 1 \(HOOK\)/);
  assert.match(promptSource, /Clip 2 \(PROOF\)/);
  assert.match(promptSource, /Clip 3 when requested \(DECISION\)/);
  assert.match(promptSource, /เขียน imagePrompt ให้เป็นเฟรมตั้งต้น/);
  assert.match(promptSource, /ห้ามนำข้อความรีวิวมาเรียงต่อเป็นบทโดยตรง/);
  assert.match(promptSource, /controlled 8-degree left-right sway/);
  assert.match(promptSource, /ห้ามพูดบรรยายการพลิกสินค้า/);
  assert.match(promptSource, /ห้ามกล่าวอ้างรักษาโรค/);
  assert.match(promptSource, /exactly ONE natural adult female hand/);
  assert.match(promptSource, /five anatomically correct fingers/);
  assert.match(promptSource, /No floating graphics, sparkle\/star icons/);
  assert.match(promptSource, /PRODUCT FIDELITY OVERRIDES MOTION AND CONTINUITY/);
  assert.match(promptSource, /Match a close-up hands-on review/);
  assert.match(promptSource, /Conversion coverage is mandatory/);
  // บทต้อง "เล่ารายละเอียดสินค้าจริง" ตรงกับภาพ ไม่ใช่บอกลักษณะลอยๆ/ชวนดูเอง (เจ้าของ feedback job_77:
  // "ไม่ใช่รีวิว ต้องเป็นส่วนของรายละเอียดสินค้า แล้วให้เข้ากับคลิปวิดีโอ")
  assert.match(promptSource, /เล่าคุณสมบัติ\/จุดเด่นของสินค้า/);
  assert.match(promptSource, /ยึด "รายละเอียดสินค้า\/สเปกที่ให้มา \(VERIFIED FACTS\)/);
  assert.match(promptSource, /ห้ามพูดลอยๆ แบบชวนไปดูเอง/);
  assert.match(promptSource, /ข้อกำหนดจากคลิปตัวอย่างของลูกค้า/);
  assert.match(promptSource, /ผลรอบก่อนถูก validator ปฏิเสธ/);
});

check('validator blocks medical/camera narration, truncated brands and weak pivot angles', () => {
  const safe = {
    motionPrompts: [
      'The hand lifts the exact product.',
      // นโยบายใหม่ 27 ก.ค.: 8° (เดิม 20° ทำให้ฉลากเพี้ยน) — fixture ต้องตามนโยบายจริง
      'The hand sways the exact product 8 degrees left and right, keeping the readable front label to camera.',
    ],
    subtitleSegments: [
      { text: 'ตัวนี้เป็นแบบซอฟต์เจลขนาดเล็ก ลองดูรายละเอียดที่ระบุบนกล่องก่อนนะคะ', startSec: 0, endSec: 8 },
      { text: 'หน้ากล่องระบุสามสิบเม็ด ถ้าตรงกับที่หาเช็กข้อมูลที่ตะกร้าได้เลย', startSec: 8, endSec: 16 },
    ],
  };
  assert.doesNotThrow(() => validateGeminiSalesCompliance(safe, 'บีแอลบียู BLB U ซอฟต์เจล 30 เม็ด', 2));

  const unsafe = {
    motionPrompts: [safe.motionPrompts[0], 'The hand makes a wide 20 degree pivot to the back.'],
    subtitleSegments: [
      { text: 'ช่วงนี้ภูมิแพ้กำเริบ เลยต้องหาตัวช่วยอย่าง บี', startSec: 0, endSec: 8 },
      { text: 'ลองพลิกซ้ายขวา แล้วฉลากยังเห็นชัดค่ะ', startSec: 8, endSec: 16 },
    ],
  };
  assert.throws(
    () => validateGeminiSalesCompliance(unsafe, 'บีแอลบียู BLB U', 2),
    (error: unknown) => error instanceof PromptComplianceError
      && error.violations.some((message) => message.includes('กล่าวอ้างโรค'))
      && error.violations.some((message) => message.includes('ตัดชื่อสินค้า'))
      && error.violations.some((message) => message.includes('บรรยายกล้อง'))
      && error.violations.some((message) => message.includes('5–12°'))
  );
});

check('บทพากย์ต้องเล่ารายละเอียดสินค้าตรงภาพ ไม่ใช่บอกลักษณะลอยๆ/ชวนดูเอง (job_77)', () => {
  // job_77: บทที่ออกมาเป็น "ลองดูรูปทรงและรายละเอียดของจริง" + "จุดต่างๆ บนตัวสินค้า
  // ช่วยให้เช็กได้ว่าตรงกับแบบที่มองหา" = พูดลอยๆ ให้ไปดูเอง ไม่มีเนื้อรายละเอียดจริง
  // เจ้าของสั่ง: บทต้อง "เป็นส่วนของรายละเอียดสินค้า" และ "เข้ากับคลิปวิดีโอ"
  const descriptive = {
    motionPrompts: [
      'The hand lifts the exact product.',
      'The hand pivots the exact product 20 degrees left and right, then restores the readable front label.',
    ],
    subtitleSegments: [
      { text: 'ใครกำลังมองหาของแบบนี้อยู่ ลองดูรูปทรงและรายละเอียดของจริงให้ครบก่อนนะคะ', startSec: 0, endSec: 8 },
      { text: 'จุดต่างๆ บนตัวสินค้า ช่วยให้เช็กได้ว่าตรงกับแบบที่กำลังมองหาอยู่ไหมนะคะ', startSec: 8, endSec: 16 },
    ],
  };
  assert.throws(
    () => validateGeminiSalesCompliance(descriptive, 'ผ้ารองรีด', 2),
    (error: unknown) => error instanceof PromptComplianceError
      && error.violations.some((message) => message.includes('บอกลักษณะ'))
  );
  // prompt สายดูวิดีโอต้องยก "รายละเอียดสินค้า" เป็นแหล่งเนื้อหาหลัก + เลือกให้เข้ากับภาพแต่ละ Scene
  const promptSource = readBackendSource('gemini');
  assert.match(promptSource, /รายละเอียดสินค้า \(VERIFIED PRODUCT FACTS\) — นี่คือ "แหล่งเนื้อหาหลัก"/);
  assert.match(promptSource, /เลือกรายละเอียดสินค้าที่เข้ากับสิ่งที่เห็นใน Scene/);
  assert.match(promptSource, /ต้องบอก "เนื้อรายละเอียด" ออกมาตรงๆ/);
});

check('all product categories reject unsupported performance claims', () => {
  const eyewear = {
    motionPrompts: [
      'The hand lifts the exact glasses.',
      'The hand pivots the exact glasses 20 degrees left and right, then restores the recognizable front view.',
    ],
    subtitleSegments: [
      { text: 'แว่นทรงเหลี่ยมสีดำตัวนี้ดูเรียบและเห็นทรงกรอบชัดค่ะ', startSec: 0, endSec: 8 },
      { text: 'ขาแว่นแข็งแรงทนทานมาก สนใจกดดูรายละเอียดได้เลยค่ะ', startSec: 8, endSec: 16 },
    ],
  };
  assert.throws(
    () => validateGeminiSalesCompliance(eyewear, 'แว่นตากรอบเหลี่ยมสีดำ', 2, 'กรอบสีดำ ขาแว่นมีรายละเอียดโลหะ'),
    (error: unknown) => error instanceof PromptComplianceError
      && error.violations.some((message) => message.includes('ข้อมูลต้นทางไม่ได้ยืนยัน'))
  );

  const electronics = {
    motionPrompts: [
      'The hand lifts the exact power bank.',
      'The hand pivots the exact power bank 20 degrees left and right, then restores its recognizable view.',
    ],
    subtitleSegments: [
      { text: 'พาวเวอร์แบงก์สีดำตัวนี้มีพอร์ตสองช่องตามภาพ ลองดูรายละเอียดกันค่ะ', startSec: 0, endSec: 8 },
      { text: 'รุ่นนี้ชาร์จเร็วและแบตอึด ใครกำลังหาอยู่กดดูรายละเอียดได้เลยค่ะ', startSec: 8, endSec: 16 },
    ],
  };
  assert.throws(
    () => validateGeminiSalesCompliance(electronics, 'พาวเวอร์แบงก์สีดำสองพอร์ต', 2, 'ตัวเครื่องสีดำ มีพอร์ตสองช่อง'),
    (error: unknown) => error instanceof PromptComplianceError
      && error.violations.some((message) => message.includes('ชาร์จเร็ว'))
      && error.violations.some((message) => message.includes('แบตอึด'))
  );
});

check('เสียงรีวิวกำหนดจังหวะหายใจและน้ำเสียงแบบคน ไม่ใช่สปอตโฆษณา', () => {
  const configSource = readBackendSource('config.ts');
  assert.match(configSource, /หยุดหายใจสั้นเฉพาะจุดจบประโยค/);
  assert.match(configSource, /ไม่เว้นช่วงเงียบระหว่างช็อต/);
  assert.match(configSource, /ไม่เติมคำติดปากทุกประโยค/);
});

check('every generated motion prompt receives a hard product identity lock', () => {
  const locked = applyProductIdentityLock(['A hand gently holds the package.']);
  assert.equal(locked.length, 1);
  assert.match(locked[0], /^Continuity lock:/);
  assert.match(locked[0], /exact same product/);
  // องศาย้ายไปอยู่ในท่าของแต่ละช็อตแล้ว ไม่ได้อยู่ในล็อกกลาง เพราะช็อตที่ต้อง "ขาย"
  // ต้องทำท่าใช้งานได้ ไม่ใช่โยกอย่างเดียวทุกช็อต (30 ก.ค. 2026)
  // job_145: เฟรมตั้งต้นมีมือเดียว แต่ prompt บางรอบสั่งสองมือขึ้นมากลางคลิป
  // มือที่เสกใหม่ทำให้นิ้ว/จุดจับเปลี่ยน จึงล็อกเป็นมือหญิงหนึ่งข้างตลอดคลิป
  assert.match(locked[0], /Exactly one natural adult female hand is visible for the whole clip/);
  assert.match(locked[0], /No second hand, other hand, pair of hands or new fingers may enter/);
  // 31 ก.ค.: "Camera holds steady" เฉยๆ ทำให้คลิปนิ่งสนิทจนดูเป็นภาพนิ่ง (เทียบ job_80 ที่
  // มือยกเข้าหากล้องแล้วดูมีชีวิตกว่ามาก) — กล้องเข้าใกล้ไม่ทำให้เห็นด้านที่ไม่เคยเห็น
  // สิ่งที่ต้องห้ามจริงคือกล้อง "วนรอบ" สินค้า ซึ่งบังคับให้โมเดลวาดด้านที่ไม่มีข้อมูล
  // 1 ส.ค.: เจ้าของขอไทม์ไลน์กล้อง 4 จังหวะแบบสตอรี่บอร์ด — กล้องจึงต้อง "ดันเข้า/ถอย/เอียง"
  // ได้จริง ประโยคเดิมที่บอกว่าขยับได้ "only slightly" ขัดกับไทม์ไลน์ที่ต่อท้ายอยู่
  // สิ่งที่ยังห้ามเท่าเดิมคือกล้อง "วนรอบ" ซึ่งบังคับให้โมเดลวาดด้านที่ไม่มีข้อมูล
  assert.match(locked[0], /Camera holds steady, pushes in, pulls back or tilts a few degrees/);
  assert.match(locked[0], /entire product, including its cap or pump, stays fully inside frame/);
  assert.match(locked[0], /never orbit around it or circle to another side/);
  // ผ่อนจาก "อ่านออกตลอดคลิป" เป็น "อ่านออกช่วงต้น" เพราะวินาทีที่ 4-6 กล้องเข้ามาโครที่ผิว
  // สินค้าตามไทม์ไลน์ — ด่านเทียบเฟรมแรกดูแค่เฟรมแรกซึ่งอยู่ในช่วงต้น จึงยังเข้มเท่าเดิม
  // ⚠️ ห้ามลบทิ้งเฉยๆ ฉลากอ่านออกช่วงต้นคือสิ่งเดียวที่ทำให้คนดูรู้ว่าขายอะไรอยู่
  assert.match(locked[0], /front label is readable in the opening seconds/);
  assert.match(locked[0], /silhouette, geometry, materials/);
  assert.match(locked[0], /printed details and visible hardware/);
  // ท่าต้องอยู่ครบ แล้วไทม์ไลน์ต่อท้าย — ถ้าไทม์ไลน์ไปแทรกกลางจะไปคั่นท่ากับล็อก
  assert.match(locked[0], /A hand gently holds the package\. Camera timeline across the 8 seconds/);
  assert.match(locked[0], /0-2s hold exactly on the opening frame/, 'จังหวะแรกต้องตรงกับเฟรมตั้งต้น');
  assert.match(locked[0], /one continuous take with no cuts/, 'ห้ามสั่งตัดต่อ Flow เจนเทคเดียว');
  assert.doesNotMatch(locked[0], /cut to/i, 'สั่งตัดภาพแล้วคลิปจะละลายกลางทาง');
  // 🐛 job_157 ซองทิชชู่หมุน 90° ตอนกล้องดันเข้า ผมจึงตัดมาโครทิ้ง แต่ job_158 (หูฟัง)
  // ที่ไม่มีมาโครแล้ว เจ้าของยังบอกว่าสู้ 157 ไม่ได้ และคลิป 2 ของมันเปลี่ยนหูฟังจีนเป็น
  // AirPods ทั้งที่ไทม์ไลน์ demo ไม่เคยถูกแตะ = ตัวแปรจริงคือ "สินค้าคนละตัว" ไม่ใช่มาโคร
  //
  // มาโครจึงกลับมา พร้อมประโยคที่รอบก่อนเพิ่งเพิ่ม เพื่อ **แยกตัวแปรให้ได้เป็นครั้งแรก**
  // ว่าซองที่หมุนเกิดจากมาโคร หรือเกิดจากตอนนั้นไม่มีใครบอกว่าสินค้าห้ามหมุน
  assert.match(
    locked[0],
    /the camera alone pushes in slowly/,
    'ต้องบอกว่ากล้องเป็นฝ่ายขยับ ไม่ใช่ให้สินค้าขยับเข้ามา'
  );
  assert.match(locked[0], /4-6s hold at the closest point/, 'เจ้าของสั่งให้เอามาโครแบบ 157 กลับมา');
  assert.match(
    locked[0],
    /never turns, tilts or changes which face points at the camera/,
    'ล็อกเดิมห้ามแค่พลิกคว่ำ ไม่ครอบการหมุนรอบแกนตั้งแบบ job_157'
  );
});

check('product fidelity rules support every category instead of assuming a container', () => {
  const promptSource = readBackendSource('gemini');
  const apiSource = readBackendSource('extension');
  assert.match(promptSource, /lens, hinge, fastener/);
  assert.match(promptSource, /Any changed shape, material, frame, hinge/);
  assert.match(promptSource, /For every product category, never infer performance from appearance/);
  assert.match(promptSource, /Never merge separate parts into one continuous band/);
  assert.match(promptSource, /ห้ามสมมติว่าสินค้าเป็นอาหารเสริม/);
  // ตัวอย่างบทต้องสอน "เล่าเนื้อรายละเอียด" ไม่ใช่ meta-บอกว่าเขียนไว้ตรงไหน (เจ้าของ feedback job_77)
  assert.match(promptSource, /บอกว่าเขียนไว้ตรงไหน ไม่ใช่บอกเนื้อรายละเอียด/);
  // ถ้อยคำถูกย่อลงเพื่อลดเวลาพิมพ์ (job #89) แต่ข้อบังคับต้องอยู่ครบเหมือนเดิม
  assert.match(apiSource, /uploaded image is the sole visual source of truth/);
  assert.match(apiSource, /ignoring its title or filename/);
  assert.match(apiSource, /every visible part; never merge or duplicate parts/);
  assert.doesNotMatch(promptSource, /exact same product, label, logo, colors, shape and cap/);
});

check('ท่าที่หมุนไปด้านข้างหรือพาของใหม่เข้าเฟรมถูกแทนด้วยท่าคงฉลากด้านหน้า', () => {
  // หมายเหตุ: "เปิดสินค้า" ไม่ถูกแทนแล้วตั้งแต่ 30 ก.ค. 2026 — เจ้าของสั่งให้คลิปขายได้
  // จึงเปิดให้ทำท่าใช้งานจริง โดยมีด่านตรวจเฟรมแรกของคลิปเป็นตัวจับสินค้าเพี้ยนแทน
  // ที่ยังต้องแทนคือท่าที่บังคับให้โมเดลวาดด้านที่ไม่เคยเห็น หรือเอาวัตถุใหม่เข้าเฟรม
  const risky = sanitizeProductMotionPrompt(
    'From the previous frame, the hand rotates the box slightly to the side.',
    1
  );
  assert.doesNotMatch(risky, /rotates the box slightly to the side/i);
  assert.match(risky, /one slow, natural in-use action/);
  assert.match(risky, /same female hand keeps an unchanged grip/);
  assert.match(risky, /every visible detail readable\.$/);
  assert.doesNotMatch(risky, /\band$/, 'fallback ห้ามถูกตัดจบกลางประโยค');

  const safe = 'A hand points beside the visible front label while the product remains stationary.';
  assert.equal(sanitizeProductMotionPrompt(safe, 1), safe);

  const inventedCompanion = sanitizeProductMotionPrompt(
    'The hand sets the box down next to a newly appearing supplement bottle.',
    2
  );
  assert.doesNotMatch(inventedCompanion, /newly appearing supplement bottle/i);
  assert.match(inventedCompanion, /clean hero frame/);
});

check('บทพากย์ถูกจัดเป็น 3 ช่วงตรงคลิปและไม่ยาวเกินเพดาน', () => {
  const narration = normalizeClipAlignedNarration(
    'บทเดิมยาวมาก',
    [
      { text: 'ได้รับของแล้วค่ะ ร้านนี้จัดส่งไวมาก แพ็คมาดีกล่องไม่เสียหาย', startSec: 0, endSec: 8.64 },
      { text: 'กระปุกนี้ดูดีและฉลากด้านหน้ายังชัดเหมือนเดิม', startSec: 8.64, endSec: 16 },
      { text: 'ลองใช้งานจริงแล้วจับถนัดมือ ใครสนใจลองดูได้ค่ะ', startSec: 16, endSec: 34.56 },
    ]
  );
  assert.equal(narration.subtitleSegments.length, 3);
  assert.deepEqual(
    narration.subtitleSegments.map(({ startSec, endSec }) => [startSec, endSec]),
    [[0, 8], [8, 16], [16, 24]]
  );
  for (const segment of narration.subtitleSegments) {
    const spokenChars = [...segment.text.replace(/\s+/g, '')].length;
    // ⚠️ เพดานบนต้องอ้างค่าคงที่จริง ไม่ใช่ตัวเลขตายตัว — เลข 100 ที่ hardcode ไว้เดิม
    // ทำให้ตอนยกเพดานเป็น 108 (30 ก.ค.) ด่านนี้ตกทั้งที่บทถูกต้องตามกฎใหม่แล้ว
    assert.ok(
      spokenChars >= 44 && spokenChars <= MAX_NARRATION_CHARS_PER_CLIP,
      `ช่วงซับยาว ${spokenChars} ตัว ต้องอยู่ใน 44-${MAX_NARRATION_CHARS_PER_CLIP}`
    );
  }
  assert.equal(
    narration.narrationScript,
    narration.subtitleSegments.map((segment) => segment.text).join(' ')
  );
});

check('บทพากย์ยาวไม่ถูกตัดทิ้งไว้กลางคำเชื่อม', () => {
  const narration = normalizeClipAlignedNarration(
    '',
    [
      { text: 'ใครที่กำลังมองหาสินค้าแบบนี้อยู่ ลองถือให้ดูใกล้ ๆ ก่อนนะ จะได้เห็นรายละเอียดทั้งหมดชัดขึ้นมากกว่าเดิม', startSec: 0, endSec: 8 },
      { text: 'ลองพลิกซ้ายขวาเบา ๆ แล้วดูรายละเอียดบนฉลากตรงนี้ก่อนนะ จะได้รู้ว่าตรงกับสิ่งที่กำลังหาอยู่หรือเปล่า', startSec: 8, endSec: 16 },
      { text: 'ถ้ารายละเอียดตรงกับปัญหาที่กำลังเจออยู่ตอนนี้ ลองกดดูข้อมูลเพิ่มเติมที่ตะกร้าก่อนสั่งซื้อได้เลยนะคะ', startSec: 16, endSec: 24 },
    ],
    3,
    8
  );
  for (const segment of narration.subtitleSegments) {
    assert.doesNotMatch(segment.text, /(?:จะได้|กำลัง|เพราะ|เพื่อ|และ|หรือ|แต่|กับ|ของ|ช่วย|ถ้า)$/);
    assert.ok([...segment.text.replace(/\s+/g, '')].length <= 100);
  }
});

check('ตัวรวมวิดีโอไม่อนุญาตให้ตัดเสียงยาวกลางประโยค', () => {
  const assembler = readBackendSource('ffmpeg', 'video-assembler.ts');
  assert.match(assembler, /audioDuration > videoDuration \+ 0\.35/);
  assert.match(assembler, /ปฏิเสธการตัดเสียงกลางประโยค/);
  assert.match(assembler, /apad=whole_dur=/);
});

check('TTS งานเดียวใช้การสังเคราะห์ครั้งเดียวและวางประโยคตามคลิป', () => {
  const tts = readBackendSource('gemini', 'tts-generator.ts');
  assert.match(tts, /export async function generateContinuousNarrationTTS/);
  assert.match(tts, /join\(' '\)/); // สังเคราะห์รวดเดียว → เสียงคนเดียวกัน
  // แล้วตัดเป็นชิ้นต่อคลิป snap เข้าช่วงเงียบจริง วางเสียงคลิป i ตรงเส้น i×secondsPerClip
  assert.match(tts, /async function detectSilences/);
  assert.match(tts, /CLIP_SPLIT_SNAP_WINDOW_SECONDS/);
  assert.match(tts, /concat=n=\$\{clipCount\}/);
  const configSource = readBackendSource('config.ts');
  assert.match(configSource, /ไม่ทำเสียงผู้ประกาศ/);
  const apiSource = readBackendSource('extension');
  assert.match(apiSource, /generateContinuousNarrationTTS\(alignedNarration\.subtitleSegments, ttsPath\)/);
  assert.match(apiSource, /generateSRT\(alignedNarration\.subtitleSegments, subtitlePath\)/);
});

check('Flow continuation prompt is concise and retains the last frame context', () => {
  const prompt = buildFlowContinuationPrompt('Continuity lock: exact same product, label, logo, colors, shape and cap. Keep the front label visible; only a shallow left-right pivot, never unseen sides. No opening, duplicates or new objects. Silent footage: no dialogue, music or sound effects. A hand points beside the label.');
  assert.match(prompt, /^Continue from the previous final frame\./);
  assert.match(prompt, /A hand points beside the label\./);
  // job #124: การย่อพรอมต์ตัด PRODUCT_IDENTITY_LOCK ออกทั้งก้อน คำสั่งห้ามเขียนฉลากใหม่
  // เลยหายไปด้วย คลิปที่ได้จึงเปลี่ยน "บ้านไผ่..." เป็น "Brapt Cemual" และ "L 420" เป็น "L x2G"
  // ทั้งที่รูปตั้งต้นถูกต้อง — คลิปต่อเนื่องต้องพกล็อกฉลากติดไปเสมอ
  assert.match(prompt, /never re-letter, re-spell, re-position, straighten or tidy up label artwork/);
  // ต้องห้าม "จัดให้อ่านง่ายขึ้น" ด้วย เพราะเป็นข้ออ้างที่โมเดลใช้เขียนฉลากใหม่
  assert.match(prompt, /even if it looks rotated, blurred or hard to read/);
  assert.match(prompt, /keeps the same shape and the same way up/);
  // ยังต้องสั้นพอที่ Flow จะรับไหว — ล็อกฉลากกินโควตาไปแล้วส่วนหนึ่ง
  assert.ok(prompt.split(/\s+/).length <= 110, `continuation prompt ยาวเกินไป (${prompt.split(/\s+/).length} คำ)`);
});

check('TICKET-12 motion prompt ตัดเฉพาะที่จบประโยคและไม่คาคำเชื่อม', () => {
  const twoSentences = [
    'The hand lifts the bottle and points to the front label.',
    'The camera moves closer while the other hand enters and keeps moving with the product.',
  ].join(' ');
  const limited = limitPromptWords(twoSentences, 12);
  assert.equal(limited, 'The hand lifts the bottle and points to the front label.');
  assert.doesNotMatch(
    limited,
    /\b(?:and|or|but|with|to|from|for|of|by|at|in|on|into|while|then)$/i
  );

  const longSingleSentence = 'The hand slowly lifts the bottle toward the camera while keeping the entire pump and front label visible and readable throughout the natural movement without changing grip or introducing another object.';
  const intact = limitPromptWords(longSingleSentence, 12);
  assert.equal(intact, longSingleSentence, 'ประโยคเดี่ยวยาวต้องอยู่ครบ แทนการตัดกลางท่า');

  const trivialLeadIn = 'Continue the exact frame. The holding hand slowly raises the bottle toward the camera while keeping the entire front label and pump visible throughout the movement.';
  const meaningful = limitPromptWords(trivialLeadIn, 8);
  assert.equal(
    meaningful,
    trivialLeadIn,
    'ห้ามเหลือแค่ Continue the exact frame แล้วตัดท่าจริงทิ้ง'
  );

  const source = readMotionLayer();
  assert.match(source, /Motion prompt ยาว .*ตัดที่จบประโยค/);
  assert.match(source, /ไม่มีขอบเขตประโยคที่ปลอดภัย — ไม่ตัด/);
});

check('background เก็บ deadline และปลุก watcher จาก heartbeat', () => {
  const background = fs.readFileSync(path.join(root, 'extension', 'background.js'), 'utf8');
  assert.match(background, /watchDeadline/);
  assert.match(background, /resumeCurrentWatch\(live\)/);
  assert.match(background, /const live = await state\(\);/);
});

check('provider block locks credits while recoverable errors keep the checkpoint', () => {
  const background = fs.readFileSync(path.join(root, 'extension', 'background.js'), 'utf8');
  const failStart = background.indexOf('async function failCurrent(message)');
  const failEnd = background.indexOf('chrome.runtime.onInstalled', failStart);
  const failBlock = background.slice(failStart, failEnd);
  assert.match(failBlock, /creditLocked:\s*true/);
  assert.match(failBlock, /ERROR_RECOVERY_PAUSE_MS/);
  assert.match(failBlock, /NEXT_DAY_RECOVERY_PAUSE_MS/);
  assert.match(failBlock, /creditLocked:\s*false/);
  assert.match(failBlock, /currentJob:\s*recoveryJob/);
});

check('unusual activity never retries a failed card', () => {
  const background = fs.readFileSync(path.join(root, 'extension', 'background.js'), 'utf8');
  const apiSource = readBackendSource('extension');
  assert.match(background, /unusualActivity/);
  assert.match(background, /const unusualActivity = Boolean\(failedCard\)/);
  assert.doesNotMatch(background, /test\(pageText\)/);
  assert.match(background, /allowFailedCardRetry && !unusualActivity/);
  assert.match(background, /true, \/\/ Retry only the explicit failed-card action/);
  assert.match(background, /failedCardRetries < ERROR_RETRY_LIMIT/);
  assert.match(background, /ERROR_RETRY_LIMIT = 3/);
  assert.match(background, /Flow ตรวจพบกิจกรรมผิดปกติ/);
  assert.match(background, /if \(providerBlocked && current\.currentJob\?\.jobId\)/);
  assert.match(background, /jobs\/\$\{current\.currentJob\.jobId\}\/pause/);
  assert.match(apiSource, /export async function pauseExtensionJob/);
  assert.match(apiSource, /generatedImagePath/);
});

check('Stop cancels in-flight content work before every paid Generate click', () => {
  const background = fs.readFileSync(path.join(root, 'extension', 'background.js'), 'utf8');
  const content = fs.readFileSync(path.join(root, 'extension', 'content.js'), 'utf8');
  assert.match(background, /type: 'FLOW_CANCEL'/);
  assert.match(background, /const activePromptTyping = new Map\(\)/);
  assert.match(background, /cancelActivePromptTyping\('user stopped the bot'\)/);
  assert.match(background, /delivery\?\.busy/);
  assert.match(background, /รอคำสั่งงานเก่ายกเลิกก่อนเริ่มงาน/);
  assert.match(content, /async function generationIsAuthorized/);
  assert.match(content, /stopped before the paid image Generate click/);
  assert.match(content, /stopped before the paid video Generate click/);
  assert.match(content, /message\.type === 'FLOW_CANCEL'/);
  assert.match(content, /if \(working\) \{\s*reply\(\{ ok: false, busy: true \}\)/);
  assert.match(content, /type: 'TYPE_PROMPT', prompt, jobId/);
});

check('Motion Prompt ต้องพิมพ์ทีละตัวและหน่วงจริงทุกตัว ห้ามวางทั้งก้อน', () => {
  const background = fs.readFileSync(path.join(root, 'extension', 'background.js'), 'utf8');
  // เดิม pin ไว้ที่ PROMPT_KEY_DELAY_MS = 100 ตายตัว ตอนนี้ delay เป็นช่วงสุ่ม (งานของ
  // Antigravity) ค่าคงที่เหลือไว้แค่ประมาณเวลาให้ popup — จึงตรวจ "พฤติกรรม" แทนตัวเลข:
  // ต้องแตกเป็นตัวอักษร, ยิง insertText ทีละตัว, และ await หน่วงจริงทุกตัว
  assert.match(background, /const chars = \[\.\.\.prompt\]/);
  assert.match(background, /'Input\.insertText', \{ text: character \}/);
  assert.match(background, /await new Promise\(\(resolve\) => setTimeout\(resolve, delay\)\)/);
  // พื้นล่างของ delay ห้ามเป็น 0 ไม่งั้นกลายเป็นวางทั้งก้อนแล้ว Flow กินพรอมต์ไม่ครบ (job #107)
  const baseMin = Number(/TYPING_DELAY_BASE_MIN_MS = (\d+)/.exec(background)?.[1]);
  assert.ok(baseMin >= 50, `TYPING_DELAY_BASE_MIN_MS ต้องไม่ต่ำกว่า 50ms (ได้ ${baseMin})`);
  assert.match(background, /TYPING_DELAY_BASE_MIN_MS = 50/);
  assert.match(background, /TYPING_DELAY_BASE_MAX_MS = 100/);
  assert.match(background, /TYPING_BURST_MIN_MS = 30/);
  assert.match(background, /TYPING_BURST_MAX_MS = 60/);
  assert.match(background, /TYPING_WORD_PAUSE_MIN_MS = 150/);
  assert.match(background, /TYPING_WORD_PAUSE_MAX_MS = 400/);
  assert.match(background, /TYPING_THINK_MIN_MS = 500/);
  assert.match(background, /TYPING_THINK_MAX_MS = 1500/);
  assert.match(background, /TYPING_TYPO_CHANCE = 0\.02/);
  assert.match(background, /PROMPT_KEY_DELAY_MS = Math\.round\(\(TYPING_DELAY_BASE_MIN_MS \+ TYPING_DELAY_BASE_MAX_MS\) \/ 2\)/);
});

check('stale duplicate extensions cannot consume commands or claim paid work', () => {
  const serverSource = readBackendSource('server');
  const backgroundSource = fs.readFileSync(path.join(root, 'extension', 'background.js'), 'utf8');
  // ต้องตรงกับเวอร์ชันจริงใน manifest เสมอ — เดิม pin เลขตายตัวทำให้ลืมอัปเดตคู่กันได้
  const manifestVersion = JSON.parse(
    fs.readFileSync(path.join(root, 'extension', 'manifest.json'), 'utf8')
  ).version;
  assert.match(serverSource, new RegExp(`ACTIVE_EXTENSION_VERSION = '${manifestVersion.replace(/\./g, '\\.')}'`));
  assert.match(serverSource, /clientVersion !== ACTIVE_EXTENSION_VERSION/);
  assert.match(serverSource, /req\.headers\['x-clipforge-version'\]/);
  // ตรวจ "พฤติกรรม" (ตอบ 426 ให้เวอร์ชันเก่า) ไม่ผูกกับรูปประโยค เพราะ route ถูกแยกไฟล์แล้ว
  assert.match(serverSource, /sendJson\(res, 426/);
  assert.match(serverSource, /candidate\?\.command !== 'reload'/);
  assert.match(serverSource, /upgradeCommand\?\.command/);
  assert.match(backgroundSource, /'X-ClipForge-Version': chrome\.runtime\.getManifest\(\)\.version/);
});

check('Frames-to-Video payload is optional and media supports job end-frame images', () => {
  const serverSource = readBackendSource('server');
  const backgroundSource = fs.readFileSync(path.join(root, 'extension', 'background.js'), 'utf8');
  assert.match(backgroundSource, /typeof current\.currentJob\.endImagePath === 'string'/);
  assert.match(backgroundSource, /stage === 'video' && Number\(current\.currentJob\.clipIndex\) === 0 && endImagePath/);
  assert.match(backgroundSource, /\{ endImageUrl: imageUrl\(current\.backendUrl, endImagePath\) \}/);
  assert.doesNotMatch(backgroundSource, /endImageUrl:\s*(?:null|undefined)/);
  assert.match(serverSource, /url\.pathname !== '\/api\/media'/);
  assert.match(serverSource, /requested\.startsWith\(`\$\{outputRoot\}\$\{path\.sep\}`\)/);
  assert.match(serverSource, /\.\.\.CORS_HEADERS/);
});

check('product image generation explicitly requires Nano Banana Pro', () => {
  const contentSource = fs.readFileSync(path.join(root, 'extension', 'content.js'), 'utf8');
  assert.match(contentSource, /Nano Banana Pro is unavailable — stopped before Generate/);
  assert.match(contentSource, /Flow did not keep Nano Banana Pro selected/);
  // เดิม pin regex ยึดหัวท้าย (^🍌?\s*Nano Banana Pro$) ซึ่งพังกับข้อความที่ไอคอนต่อกับคำ
  // ตอนนี้ต้องเป็น substring — รายละเอียดอยู่ในเช็ค "ห้ามจับข้อความ Flow ด้วย regex ยึดหัวท้าย"
  assert.match(contentSource, /\[role="menuitem"\],\[role="menuitemradio"\],\[role="option"\]', \/Nano\\s\*Banana\\s\*Pro\/i\)/);
});

check('end frame is generated once, fidelity-checked and checkpointed before clip 1', () => {
  const apiSource = readBackendSource('extension');
  const backgroundSource = fs.readFileSync(path.join(root, 'extension', 'background.js'), 'utf8');
  const contentSource = fs.readFileSync(path.join(root, 'extension', 'content.js'), 'utf8');
  assert.match(apiSource, /endImagePrompt/);
  assert.match(apiSource, /!vision\.endImagePath \|\| !fs\.existsSync\(vision\.endImagePath\)/);
  assert.match(apiSource, /imageRole: 'end' as const/);
  assert.match(apiSource, /endImageFidelity/);
  assert.match(apiSource, /rejectedEndImagePath/);
  assert.match(apiSource, /endImagePath: outputPath/);
  assert.match(backgroundSource, /generated_\$\{imageRole === 'end' \? 'end' : 'start'\}/);
  assert.match(backgroundSource, /imageRole === 'end' \? 'end' : 'start'/);
  assert.match(backgroundSource, /forceNewProject: message\.clipIndex === 0/);
  assert.match(contentSource, /preparing the matching end frame/);
  assert.match(contentSource, /job\.forceNewProject && inProject/);
});

check('generated product image must pass a source-grounded fidelity gate before video credits', () => {
  const promptSource = readBackendSource('gemini');
  const apiSource = readBackendSource('extension');
  const backgroundSource = fs.readFileSync(path.join(root, 'extension', 'background.js'), 'utf8');
  assert.match(promptSource, /PRIMARY SOURCE PRODUCT — main continuity reference/);
  assert.match(promptSource, /openClosedState/);
  assert.match(promptSource, /componentCount/);
  assert.match(promptSource, /componentLayout/);
  assert.match(promptSource, /visibleText/);
  assert.match(apiSource, /compareGeneratedProductFidelity/);
  // job #75: Gemini ส่ง JSON fidelity เพี้ยน (double-quote ไม่ escape ใน differences)
  // → parse ล้ม → เดิมถูกตีเป็น block score 0 ทั้งที่ checks (ตัวตัดสินจริง) อาจผ่านหมด → ข้ามงานทิ้งเครดิต
  // ต้องกู้เฉพาะ checks/score ด้วย regex ก่อน ไม่ใช่ fail closed ทันทีเพราะ freetext พัง
  assert.match(promptSource, /function extractFidelityFieldsLeniently/);
  assert.match(promptSource, /if \(recovered === 0\) return null/);
  assert.match(promptSource, /parsed = extractFidelityFieldsLeniently|parsed = lenient/);
  assert.match(apiSource, /status: 'failed'/);
  assert.match(apiSource, /rejectedGeneratedImagePath/);
  assert.match(apiSource, /PRODUCT_FIDELITY_BLOCK/);
  assert.match(backgroundSource, /const fidelityBlocked = \/PRODUCT_FIDELITY_BLOCK/);
  // fidelity block = ปัญหาคุณภาพการเจน ไม่ใช่คำสั่งห้ามจากแพลตฟอร์ม
  // ต้อง "ข้ามไปงานถัดไป" ไม่ใช่ล็อกเครดิตหยุดบอท (ไม่งั้นรัน 24 ชม. ไม่ได้ ต้องมีคนมาปลดล็อก)
  // แต่ยังต้องกันเครดิตวิดีโอ คือไม่เจนคลิปต่อจากภาพที่เพี้ยน
  assert.match(backgroundSource, /ข้ามงานนี้/);
  assert.match(backgroundSource, /running: true, creditLocked: false, currentJob: null, nextJobCooldownUntil/);
  // แต่ถ้า fidelity บล็อกติดกันเกินเพดาน ต้องหยุด+ล็อก กันวนเผาเครดิต (รีเซ็ตเมื่องานสำเร็จ)
  assert.match(backgroundSource, /if \(streak >= FIDELITY_FAIL_STREAK_LIMIT\)/);
  assert.match(backgroundSource, /หยุดเพื่อกันเผาเครดิต/);
  assert.match(backgroundSource, /running: false, creditLocked: true, currentJob: null \}/);
  assert.match(backgroundSource, /fidelityFailStreak: 0 \}\); \/\/ งานสำเร็จ/);
  // provider block (กิจกรรมผิดปกติ) ต้องยังล็อกเครดิตอยู่ — แพลตฟอร์มสั่งหยุด
  assert.match(backgroundSource, /Flow ตรวจพบกิจกรรมผิดปกติ[\s\S]{0,200}creditLocked: true/);
});

check('prompt ต้องไม่ยาวจนดูเหมือนบอทค้าง + ต้องรายงานความคืบหน้าตอนพิมพ์ (job #89)', () => {
  const apiSource = readBackendSource('extension');
  const backgroundSource = fs.readFileSync(path.join(root, 'extension', 'background.js'), 'utf8');
  // พิมพ์ทีละตัว 100ms → ความยาว prompt = เวลารอโดยตรง
  // job #89: 1,949 ตัว = 136 วินาที เงียบสนิท เจ้าของนึกว่าค้างเลยกดหยุดกลางคัน
  assert.match(backgroundSource, /กำลังพิมพ์ Prompt \$\{percent\}%/);
  assert.match(backgroundSource, /อย่าเพิ่งกดหยุด/);
  assert.match(backgroundSource, /const estimatedSeconds = Math\.round/);
  // ห้ามใช้ setStatus() ระหว่างพิมพ์ — มันยิง API แล้วประมวลผลคำสั่งรีโมตด้วย
  // ถ้ามีคำสั่ง reload ค้างอยู่จะรีโหลด extension กลางคันพิมพ์ prompt
  assert.match(backgroundSource, /ห้ามใช้ setStatus\(\) ตรงนี้/);
  // prompt ที่ย่อแล้วต้องยังคงข้อบังคับสำคัญครบ
  assert.match(apiSource, /sole visual source of truth/);
  assert.match(apiSource, /Never invent a nutrition table/);
  assert.match(apiSource, /keep the front label artwork exactly as uploaded/);
  assert.match(apiSource, /never re-letter the label/);
  assert.match(apiSource, /never swing around to the rear panel/);
  // ย่อแล้วต้องสั้นจริง — กันโดนเขียนยาวกลับมาอีก (job #89: 1,949 ตัว = รอ 136 วินาที)
  //
  // 31 ก.ค.: เดิมวัดจาก "ข้อความในซอร์ส" ซึ่งนับคอมเมนต์ภาษาไทยเข้าไปด้วย ทั้งที่คอมเมนต์
  // ไม่เคยถูกพิมพ์เข้า Flow เลยสักตัว → เขียนคำอธิบายเพิ่มแล้วด่านแดงทั้งที่เวลาพิมพ์เท่าเดิม
  // เปลี่ยนมาวัด prompt จริงที่ถูกสร้างออกมา ตรงกับสิ่งที่ด่านนี้ตั้งใจคุมจริงๆ (เพดานเท่าเดิม)
  const builtPrompt = buildReferenceImagePlan({
    handGender: 'female',
    backgroundStyle: 'a tidy vanity table with neutral daylight and shallow depth of field',
  }).imagePrompt || '';
  assert.ok(builtPrompt.length < 1400, `imagePrompt ยาวเกินไป (${builtPrompt.length} ตัวอักษร = พิมพ์ ${Math.round(builtPrompt.length / 10)} วินาที)`);
});

check('งานที่จบแล้วต้องปล่อย worker_id คืนเสมอ (deep debug พบค้าง 73 งาน)', () => {
  const repoSource = readBackendSource('db', 'job-repository.ts');
  // เดิมแต่ละ call site ต้องจำใส่ workerId:null เอง → ลืมบ่อย (failed 52 + completed 21)
  // บังคับที่ updateJob จุดเดียว ครอบทุกเส้นทางอัตโนมัติ
  assert.match(repoSource, /updates\.status === 'completed' \|\| updates\.status === 'failed'/);
  assert.match(repoSource, /sets\.push\('worker_id = NULL'\)/);
  // ต้องไม่ทับค่าที่ call site ตั้งใจส่งมาเอง
  assert.match(repoSource, /updates\.workerId === undefined/);
});

check('สร้างงานอัตโนมัติต้องเลือกสินค้าที่ข้อมูลพร้อมก่อน (ไม่สุ่มมั่วจนได้บทอ่อน)', () => {
  const apiSource = readBackendSource('extension');
  // deep debug: มีสินค้าที่มีสเปก+รูปทางการแค่ 16/50 — ORDER BY random() ล้วนทำให้ ~68%
  // ของงานไปโดนสินค้าไม่มีข้อมูล = บทพากย์อ่อน + ใช้ reference หลายมุมไม่ได้ ทั้งที่จ่ายเครดิตเท่ากัน
  assert.match(apiSource, /COALESCE\(LENGTH\(i\.product_detail\), 0\) > 0/);
  // ลำดับ "ข้อมูลพร้อมก่อน" ต้องเป็นคีย์แรกเสมอ ส่วนคีย์ถัดไป (กันซ้ำ) ตรวจในเช็คของมันเอง
  assert.match(apiSource, /jsonb_array_length\(COALESCE\(i\.official_images, '\[\]'::jsonb\)\) > 0\s*\n\s*\) DESC,/);
});

check('product_detail ต้องถึง Gemini ตอนวาง shotPlans ไม่ใช่เฉพาะตอนพากย์วิดีโอ (TICKET-08)', () => {
  const apiSource = readBackendSource('extension', 'extension-api.ts');
  const promptSource = readPromptLayer();
  assert.match(apiSource, /SELECT media_json, title, official_images, product_detail FROM item/);
  assert.match(
    apiSource,
    /String\(item\.rows\[0\]\?\.product_detail \|\| ''\)\.trim\(\)\.slice\(0, 1800\)/
  );
  assert.match(promptSource, /productDetail\.trim\(\)\.slice\(0, 1800\)/);
  assert.match(promptSource, /สเปก\/จุดขายจริงของสินค้า/);
  assert.match(promptSource, /const supportedFacts = `\$\{productTitle\} \$\{reviewText\} \$\{productBrief\}`/);
  assert.match(promptSource, /rewriteUnsupportedClaimSegments\(\s*parsed\.subtitleSegments,\s*supportedFacts/);
});

check('การแทนบทต้องเก็บข้อความเดิม ชื่อกฎ และเหตุผลไว้ชันสูตร (TICKET-09)', () => {
  const descriptive = [{
    text: 'ลองดูรูปทรงและรายละเอียดของจริงให้ครบก่อนตัดสินใจนะคะ',
    startSec: 0,
    endSec: 8,
  }];
  const descriptiveRepairs = repairDescriptiveSegments(descriptive);
  assert.equal(descriptiveRepairs.length, 1);
  assert.equal(descriptiveRepairs[0].rule, 'descriptive_narration');
  assert.equal(descriptiveRepairs[0].strategy, 'safe_fallback');
  assert.match(descriptiveRepairs[0].repairedFrom, /รายละเอียดของจริง/);
  assert.equal(descriptive[0].text, descriptiveRepairs[0].replacement);

  const unsupported = [{
    text: 'ชิ้นนี้แข็งแรงทนทานมาก เหมาะกับการหยิบมาใช้ทุกวันเลยค่ะ',
    startSec: 0,
    endSec: 8,
  }];
  const claimRepairs = repairUnsupportedClaims(unsupported, 'ข้อมูลยืนยันมีเพียงสีและขนาด');
  assert.equal(claimRepairs.length, 1);
  assert.equal(claimRepairs[0].rule, 'unsupported_claim');
  assert.equal(claimRepairs[0].strategy, 'safe_fallback');
  assert.deepEqual(claimRepairs[0].reasons, ['แข็งแรง', 'ทนทาน']);

  const apiSource = readBackendSource('extension', 'extension-api.ts');
  const finalizeSource = readBackendSource('extension', 'job-finalize.ts');
  const rulesSource = readNarrationLayer();
  const dashboardSource = readBackendSource('server', 'routes/dashboard.routes.ts');
  assert.match(apiSource, /logNarrationRepairs\(row\.id, vision\.narrationRepairs \|\| \[\]\)/);
  assert.match(finalizeSource, /logNarrationRepairs\(jobId, alignedNarration\.repairs \|\| \[\]\)/);
  assert.match(rulesSource, /stage: 'narration\.repair'/);
  assert.match(rulesSource, /repairedFrom: repair\.repairedFrom/);
  assert.match(rulesSource, /replacement: repair\.replacement/);
  assert.match(dashboardSource, /narrationRepairs:/);
});

check('TICKET-11 คำอ้างเกินข้อมูลต้อง rewrite เฉพาะประโยคก่อนใช้ fallback', () => {
  assert.deepEqual(
    findUnsupportedClaims(
      'นิ้วชี้ฉลากให้เห็นจุดเด่นชัด ตัวนี้พกพาง่ายและน่าใช้มากค่ะ',
      'กระติก VACUUM CUP สีฟ้า'
    ),
    ['พกพาง่าย']
  );
  assert.deepEqual(
    findUnsupportedClaims(
      'นิ้วชี้ฉลาก VACUUM CUP ให้เห็นชัด ตัวทรงกะทัดรัดหยิบใช้ได้ทุกวันค่ะ',
      'กระติก VACUUM CUP สีฟ้า'
    ),
    []
  );

  const source = readBackendSource('gemini');
  assert.match(source, /async function rewriteUnsupportedClaimSentence/);
  assert.match(source, /rewriteUnsupportedClaimSegments/);
  assert.match(source, /คำอ้างที่ห้ามใช้เพราะไม่มีต้นทาง/);
  assert.match(source, /maxAttempts = 2/);
  assert.match(source, /'gemini_rewrite'\s*:\s*'safe_fallback'/);
  assert.match(source, /ใช้ประโยคสำรองเป็นทางสุดท้าย/);
  assert.match(source, /findUnsupportedClaims\(candidate, supportedFacts\)\.length === 0/);
  assert.match(source, /fallbackRewrittenNarrationSegments/);
  assert.match(source, /ยังตก compliance gate/);
});

check('ปัญหาเชิงสไตล์ต้องซ่อม ไม่ใช่ทิ้งงาน (job #84-87 ตาย 4 ใบเพราะกฎ "บอกลักษณะ")', () => {
  const promptSource = readBackendSource('gemini');
  // กฎ DESCRIPTIVE_NARRATION เป็นเรื่อง "สไตล์การเขียน" ไม่ใช่ความเสี่ยงกฎหมาย/ข้อมูลเท็จ
  // → retry ขอบทใหม่ได้ แต่หมดรอบแล้วต้องซ่อมแล้วไปต่อ ห้ามทิ้งงานทั้งใบ
  assert.match(promptSource, /function repairDescriptiveSegments/);
  assert.match(promptSource, /if \(complianceAttempt >= MAX_COMPLIANCE_RETRIES\)/);
  assert.match(promptSource, /repairDescriptiveSegments\(parsed\.subtitleSegments\)/);
  assert.match(promptSource, /repairDescriptiveSegments\(aligned\.subtitleSegments\)/);
  // แต่เคลมยา/อ้างเกินข้อมูล ต้องยังตายเหมือนเดิม (ห้ามซ่อมแล้วปล่อยผ่าน)
  assert.match(promptSource, /if \(violations\.length\) throw new PromptComplianceError/);
});

check('เสียงต้องไม่มีหางเงียบยาว/เว้นวรรคแปลก (job_83: เงียบ 1.2s + หยุดกลางประโยค 0.46s)', () => {
  const ttsSource = readBackendSource('gemini', 'tts-generator.ts');
  const promptSource = readBackendSource('gemini');
  // ต้องบีบช่วงเงียบก่อน "วัดความยาวเสียงพูด" ไม่งั้น tempo คิดว่าพูดยาวพอแล้วเลยไม่ยืด
  assert.match(ttsSource, /silenceremove=start_periods=1/);
  assert.match(ttsSource, /stop_periods=-1/);
  // job_96: บีบทุกช่วงเงียบเหลือ 0.16s เท่ากันหมดทำให้จังหวะพูดแบนเหมือนหุ่นยนต์
  // ต้องตัดเฉพาะเงียบยาวผิดธรรมชาติ (≥0.45s → เหลือ 0.35s) และ -40dB กันกินหางเสียง
  assert.match(ttsSource, /stop_duration=0\.45:stop_silence=0\.35/);
  assert.match(ttsSource, /stop_threshold=-40dB/);
  assert.match(ttsSource, /let tightSpeech = await getMediaDuration\(clipPath\)/);
  // กันตัดเงียบแรงเกินจนเหลือคลิปเงียบ — ต้องกลับไปใช้ชิ้นดิบ (พร้อม atrim ช่วงเดิม)
  assert.match(ttsSource, /const tooAggressive = tightSpeech < rawChunk \* 0\.5/);
  assert.match(ttsSource, /tooAggressive\s*\n?\s*\? \[source\.audioPath, `atrim=/);
  // บทต้องยาวพอจะพูดเต็มช่อง 8s เอง (ยืด tempo อย่างเดียวไม่พอ เพราะชนเพดาน 0.82)
  assert.match(promptSource, /MIN_NARRATION_CHARS_PER_CLIP = 88/);
  assert.match(promptSource, /MAX_NARRATION_CHARS_PER_CLIP = 108/);
  // ประโยคสำรองชุดเดิมคือต้นตอบท "บอกรูปทรง" ของ job_77 (บทสั้น → ระบบเติมประโยคพวกนี้ให้)
  // ชุดใหม่ต้องเป็นโทนขาย + มีคำชวนปิดท้าย และยาวพอตามเพดานใหม่
  assert.match(promptSource, /สนใจกดเข้าไปสั่งซื้อกันได้เลยนะคะ/);
  // ⚠️ ประโยคสำรองต้อง "ผ่านกฎของตัวเอง" ไม่ใช่แค่ยาวพอ — job #128: ชุดเดิมมีคำว่า
  // "ใช้งานได้จริง / ใช้ง่าย / ใช้สะดวก" ครบทั้งสามบรรทัด ซึ่งเป็นคำที่ระบบสั่งห้าม
  // Gemini ใช้ แต่พอบทสั้นโค้ดก็เติมคำต้องห้ามให้เอง เจ้าของจับได้จากวิดีโอจริง
  // ตรวจด้วยกฎจริงทุกบรรทัด ไม่ใช่จับข้อความตายตัว
  const bannedGenericVerb = /ใช้ง่าย|ใช้ดี|ใช้งานได้จริง|ใช้สะดวก|ไม่ยุ่งยาก/u;
  for (const [index, line] of SAFE_NARRATION_EXTENSIONS.entries()) {
    const length = spokenLength(line);
    assert.ok(
      length >= MIN_VIDEO_NARRATION_CHARS_PER_CLIP && length <= MAX_NARRATION_CHARS_PER_CLIP,
      `ประโยคสำรอง ${index + 1} ยาว ${length} ตัว ต้องอยู่ใน ${MIN_VIDEO_NARRATION_CHARS_PER_CLIP}-${MAX_NARRATION_CHARS_PER_CLIP}`
    );
    assert.ok(!bannedGenericVerb.test(line), `ประโยคสำรอง ${index + 1} มีคำกริยากลางๆ ที่ระบบสั่งห้ามเอง`);
    const claims = SOURCE_REQUIRED_CLAIMS.filter((claim) => line.includes(claim));
    assert.equal(claims.length, 0, `ประโยคสำรอง ${index + 1} มีคำอ้างที่ต้องมีหลักฐาน: ${claims.join(', ')}`);
    assert.ok(/(?:ค่ะ|นะคะ)$/u.test(line.trim()), `ประโยคสำรอง ${index + 1} ต้องลงท้ายเสียงผู้หญิง`);
  }
});

check('ห้าม AI แต่งข้อมูลหลังซอง + Hook/CTA/เลี่ยงคำเชิงลบ (codex review job_80)', () => {
  const apiSource = readBackendSource('extension');
  const promptSource = readBackendSource('gemini');
  // ⚠️ ความเสี่ยงจริง: job_80 มี Nutrition Facts ที่ AI สร้างเอง = ข้อมูลสินค้าเท็จ
  assert.match(apiSource, /Never invent a nutrition table, ingredient list, barcode/);
  assert.match(apiSource, /Never add, remove or redraw any brand, logo, label or printed text/);
  // เฟรมปลายหมุนได้แค่เห็นด้านข้าง ห้ามหมุนไปด้านหลังแล้ววาดตารางขึ้นมา
  assert.match(apiSource, /never swing around to the rear panel/);
  // บทพากย์: Hook แรง + ปิดการขาย + ห้ามอธิบายข้อดีด้วยคำเชิงลบ
  assert.match(promptSource, /\*\*ประโยคแรก = Hook\*\*/);
  assert.match(promptSource, /\*\*ประโยคสุดท้าย = ปิดการขาย\*\*/);
  assert.match(promptSource, /ห้ามใช้คำเชิงลบมาอธิบายข้อดี/);
  assert.match(promptSource, /ไม่เหม็นหืน/);
});

check('คลิป 1 ต้องได้ Start = รูปตั้งต้น, End = รูปปลาย (ห้ามเป็นไฟล์เดียวกัน)', () => {
  const apiSource = readBackendSource('extension');
  // 🐛 job #80 (เจ้าของจับได้จากหน้า Flow): หลังบันทึก End frame เคยคืน
  // `imagePath: outputPath` + `endImagePath: outputPath` = ไฟล์เดียวกันทั้งสองช่อง
  // → Veo interpolate ภาพเดิม→ภาพเดิม = คลิปนิ่ง/เฟรมซ้ำ ("เจนหน้าเดิม 2 รอบ")
  assert.match(apiSource, /const startFramePath = updatedVision\.generatedImagePath/);
  assert.match(apiSource, /imagePath: startFramePath/);
  assert.match(apiSource, /ไม่พบรูปตั้งต้นที่ผ่าน fidelity สำหรับใช้เป็น Start frame/);
  // ต้องไม่มีบรรทัดที่ตั้ง imagePath เป็น outputPath คู่กับ endImagePath: outputPath อีก
  assert.doesNotMatch(apiSource, /imagePath: outputPath,\n    prompt: updatedVision\.motionPrompts\[0\]/);
});

check('วิธี A: แนบรูปทางการมุมอื่นเป็น reference เสริมตอนเจนเฟรมต้น (ปิดได้ด้วย flag)', () => {
  const apiSource = readBackendSource('extension');
  const backgroundSource = fs.readFileSync(path.join(root, 'extension', 'background.js'), 'utf8');
  const contentSource = fs.readFileSync(path.join(root, 'extension', 'content.js'), 'utf8');
  const configSource = readBackendSource('config.ts');
  // เจ้าของขอ "วิธี A เสริมวิธี B" และขอให้ถอดออกง่ายถ้าผลไม่ดี → ต้องมี kill-switch
  assert.match(configSource, /referenceImagesEnabled: optionalBool\('REFERENCE_IMAGES_ENABLED'/);
  assert.match(configSource, /referenceImageCount: optionalInt\('REFERENCE_IMAGE_COUNT'/);
  // วิธี A คุมแค่ "แนบตอนเจนรูป" — ตัวรายการรูปทางการต้องถูกเก็บไว้เสมอ เพราะโหมดส่วนผสม
  // ตอนเจนคลิปใช้รายการเดียวกัน ถ้าผูกทั้งก้อนกับ flag เดียว ปิดวิธี A แล้วส่วนผสมจะหายด้วย
  assert.match(apiSource, /const attachAtImageStage = config\.referenceImagesEnabled && referenceImagePaths\.length > 0;/);
  assert.match(apiSource, /imagePrompt: attachAtImageStage/);
  // ห้ามแนบซ้ำรูปหลักที่ Gemini เลือก
  assert.match(apiSource, /\.filter\(\(imagePath\) => imagePath !== selectedPaths\[0\]\)/);
  // ต้องบอกโมเดลว่าเป็นสินค้าตัวเดียวกันมุมอื่น ไม่งั้นเจนเป็นหลายชิ้น/collage
  assert.match(apiSource, /SAME product from other angles/);
  assert.match(apiSource, /Render exactly ONE product, never a collage/);
  // แนบเฉพาะเฟรมต้น — เฟรมปลายต้องไม่ถูกกวนการหมุน 35° ของวิธี B
  assert.match(backgroundSource, /stage === 'image' && imageRole === 'start'/);
  assert.match(backgroundSource, /referenceImageUrls: current\.currentJob\.referenceImagePaths/);
  // แนบไม่สำเร็จต้องไม่ทำให้งานพัง — เดินต่อด้วยรูปหลัก (พฤติกรรมเดิม)
  assert.match(contentSource, /job\.referenceImageUrls/);
  assert.match(contentSource, /แนบรูปมุมเสริมไม่สำเร็จ/);
  // job #79: รูปทางการจาก Shopee เป็น URL แต่ prepareOfficialImages ทำ copyFileSync
  // → ENOENT 'X:\...\new\https://down-th.img...' → งานตายก่อนเริ่ม ต้องรองรับทั้ง URL และไฟล์ในเครื่อง
  assert.match(apiSource, /const isRemote = \/\^https\?:\\\/\\\/\/i\.test\(raw\)/);
  assert.match(apiSource, /ข้ามรูปทางการรูปที่/);
});

check('คลิปครบแล้วต้องไปประกอบวิดีโอ ห้ามเจนคลิปเกิน (กันเผาเครดิต)', () => {
  const apiSource = readBackendSource('extension');
  // job #69: คลิปครบ 2 แล้ว แต่ finalize ล้ม (เน็ตหลุดตอน TTS) → งานกลับ pending → ถูก claim ใหม่
  // → เดิมไม่เช็คจำนวน เลยสั่งเจนคลิปที่ 3 = เสียเครดิตฟรี แล้ว finalize ปฏิเสธถาวร (3 ≠ 2)
  assert.match(apiSource, /if \(clipPaths\.length >= clipCount\)/);
  assert.match(apiSource, /ประกอบวิดีโอโดยไม่เจนคลิปเพิ่ม/);
  // และถ้าเผลอมีคลิปเกินอยู่แล้ว ต้องกู้ได้ด้วยการใช้ N ตัวแรก ไม่ใช่ค้างถาวร
  assert.match(apiSource, /storedClips\.filter\(Boolean\)\.slice\(0, clipCount\)/);
});

check('bot uses only an existing user-opened Flow tab', () => {
  const backgroundSource = fs.readFileSync(path.join(root, 'extension', 'background.js'), 'utf8');
  assert.match(backgroundSource, /ไม่พบแท็บ Google Flow ที่ผู้ใช้เปิดไว้/);
  assert.doesNotMatch(backgroundSource, /chrome\.tabs\.create\(\{ url: 'https:\/\/labs\.google\/fx\/th\/tools\/flow'/);
  assert.match(backgroundSource, /flowTabs\.find\(\(tab\) => tab\.active\)/);
});

check('clip and job cooldowns use a persisted rate-limit pause', () => {
  const background = fs.readFileSync(path.join(root, 'extension', 'background.js'), 'utf8');
  // ค่าตัวเลขจริงถูกยืนยันในเช็ค "พักระหว่างคลิป 1-3 นาที แต่ข้ามไปงานใหม่ 3-5 นาที"
  // ตรงนี้ดูแค่ว่ากลไก multiplier ที่จำค่าไว้ข้ามการรีสตาร์ตยังอยู่ครบ
  assert.match(background, /const randomCooldownMs = \(multiplier = 1\) =>/);
  assert.match(background, /const randomNextJobCooldownMs = \(multiplier = 1\) =>/);
  assert.match(background, /const safeMultiplier = Number\(multiplier\) >= 2 \? 2 : 1/);
  assert.match(background, /setStatus\(queuedStatus, \{ running: true, cooldownMultiplier: 1 \}\)/);
  assert.match(background, /const pauseMs = randomCooldownMs\(current\.cooldownMultiplier\)/);
  assert.match(background, /phase: 'cooldown'/);
  assert.match(background, /nextJobCooldownUntil/);
  assert.match(background, /nextJobCooldownUntil: Number\(value\.nextJobCooldownUntil \|\| 0\)/);
});

check('recoverable Flow errors retry three times then back off 20 minutes and one day', () => {
  const background = fs.readFileSync(path.join(root, 'extension', 'background.js'), 'utf8');
  assert.match(background, /ERROR_RETRY_LIMIT = 3/);
  assert.match(background, /ERROR_RECOVERY_PAUSE_MS = 20 \* 60 \* 1000/);
  assert.match(background, /NEXT_DAY_RECOVERY_PAUSE_MS = 24 \* 60 \* 60 \* 1000/);
  assert.match(background, /cooldownReason: nextDay \? 'next-day-recovery' : 'error-recovery'/);
  assert.match(background, /resetRecoveryOnResume: nextDay/);
  assert.match(background, /cooldownMultiplier: 2/);
});

check('โหมดรัน 24 ชม.: คิวว่างแล้วสร้างงานใหม่อัตโนมัติแทนการนิ่ง', () => {
  const background = fs.readFileSync(path.join(root, 'extension', 'background.js'), 'utf8');
  assert.match(background, /โหมดรัน 24 ชม/);
  assert.match(background, /ensureQueuedJob\(0, current\.durationSeconds\)/);
  // ต้อง claim ซ้ำหลังสร้างงานใหม่ ไม่ใช่แค่สร้างทิ้งไว้
  assert.match(background, /ยังไม่มีสินค้าให้สร้างงานใหม่/);
});

check('extension reload and Chrome startup preserve an active paid checkpoint', () => {
  const background = fs.readFileSync(path.join(root, 'extension', 'background.js'), 'utf8');
  const installedStart = background.indexOf('chrome.runtime.onInstalled.addListener');
  const startupStart = background.indexOf('chrome.runtime.onStartup.addListener');
  const alarmStart = background.indexOf('chrome.alarms.onAlarm.addListener');
  const installedBlock = background.slice(installedStart, startupStart);
  const startupBlock = background.slice(startupStart, alarmStart);
  assert.match(installedBlock, /if \(!current\.running \|\| !current\.currentJob\)/);
  assert.match(startupBlock, /if \(current\.running && current\.currentJob\)/);
  assert.match(startupBlock, /setStatus\(current\.lastStatus\)/);
  assert.doesNotMatch(installedBlock, /running: false,[\s\S]*currentJob: null,[\s\S]*submittedFor: null[\s\S]*chrome\.alarms\.create/);
});

check('reserved job that was never dispatched resumes after Start (ticket #07)', () => {
  const background = fs.readFileSync(path.join(root, 'extension', 'background.js'), 'utf8');
  const helperStart = background.indexOf('async function resumeUndispatchedCurrentJob');
  const helperEnd = background.indexOf('async function resumeAfterCooldown', helperStart);
  const helper = background.slice(helperStart, helperEnd);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, 'missing reserved-job recovery helper');
  assert.match(helper, /const expectedKey = jobDispatchKey\(current\.currentJob\)/);
  assert.match(helper, /if \(saved\.submittedFor === expectedKey\) return false;/);
  assert.doesNotMatch(helper, /remove\([^)]*submittedFor/, 'recovery must not clear the paid duplicate guard');
  assert.doesNotMatch(helper, /currentJob:\s*null/, 'recovery must preserve the backend reservation');
  assert.match(background, /resumeUndispatchedCurrentJob\(current, 'runNext'\)/);
  assert.match(background, /resumeUndispatchedCurrentJob\(live, 'heartbeat'\)/);
  const startHandler = background.slice(
    background.indexOf("if (message.type === 'START')"),
    background.indexOf("if (message.type === 'STOP')")
  );
  assert.match(startHandler, /const queued = current\.currentJob[\s\S]*: await ensureQueuedJob/);
  assert.match(startHandler, /resumed: true/);
});

check('Popup can safely clear a stuck job without deleting paid files', () => {
  const background = fs.readFileSync(path.join(root, 'extension', 'background.js'), 'utf8');
  const popup = fs.readFileSync(path.join(root, 'extension', 'popup.js'), 'utf8');
  const popupHtml = fs.readFileSync(path.join(root, 'extension', 'popup.html'), 'utf8');
  const clearStart = background.indexOf("message.type === 'CLEAR_STUCK_JOB'");
  const clearEnd = background.indexOf("message.type === 'ADD_JOB'", clearStart);
  const clearBlock = background.slice(clearStart, clearEnd);
  assert.ok(clearStart >= 0);
  assert.match(clearBlock, /ผู้ใช้เคลียร์งานค้างจาก Extension/);
  assert.doesNotMatch(clearBlock, /Remove-Item|unlinkSync/);
  assert.match(popup, /type: 'CLEAR_STUCK_JOB'/);
  assert.match(popupHtml, /id="clearStuck"/);
});

check('Popup and floating control show a live persisted cooldown countdown', () => {
  const popup = fs.readFileSync(path.join(root, 'extension', 'popup.js'), 'utf8');
  const popupHtml = fs.readFileSync(path.join(root, 'extension', 'popup.html'), 'utf8');
  const content = fs.readFileSync(path.join(root, 'extension', 'content.js'), 'utf8');
  assert.match(popup, /currentJob\?\.cooldownUntil/);
  assert.match(popup, /nextJobCooldownUntil/);
  assert.match(popup, /setInterval\(renderCooldown, 250\)/);
  assert.match(popupHtml, /id="cooldownTime"/);
  assert.match(content, /id="cooldown-time"/);
  assert.match(content, /setInterval\(renderFloatingCooldown, 250\)/);
  assert.match(content, /พักก่อนเริ่มงานถัดไป/);
  assert.match(content, /function revealNewCooldown\(\)/);
  assert.match(content, /panel\.hidden = false/);
  assert.match(content, /announcedCooldownUntil/);
});

check('Start creates one automatic random job without a separate queue click', () => {
  const background = fs.readFileSync(path.join(root, 'extension', 'background.js'), 'utf8');
  const popup = fs.readFileSync(path.join(root, 'extension', 'popup.js'), 'utf8');
  const popupHtml = fs.readFileSync(path.join(root, 'extension', 'popup.html'), 'utf8');
  assert.match(background, /ensureQueuedJob\(message\.itemId, durationSeconds\)/);
  assert.match(background, /\/api\/extension\/jobs\/auto/);
  assert.match(popup, /type: 'START', itemId, durationSeconds: selectedDuration\(\)/);
  assert.doesNotMatch(popup, /getElementById\(['"]addJob/);
  assert.doesNotMatch(popupHtml, /id="addJob"/);
  assert.match(popupHtml, /สุ่มอัตโนมัติเมื่อเริ่มบอท/);
});

check('Image generation is checkpointed before the video chain starts', () => {
  const background = fs.readFileSync(path.join(root, 'extension', 'background.js'), 'utf8');
  const content = fs.readFileSync(path.join(root, 'extension', 'content.js'), 'utf8');
  const apiSource = readBackendSource('extension');
  assert.match(content, /async function generateImage\(job\)/);
  assert.match(content, /mediaType: 'image'/);
  assert.match(content, /FLOW_RUN_IMAGE/);
  assert.match(background, /downloadAndImportGeneratedImage/);
  assert.match(background, /awaitingImage/);
  assert.match(apiSource, /importExtensionGeneratedImage/);
  assert.match(apiSource, /generatedImagePath/);
  assert.match(background, /\['image', 'video'\]\.includes\(result\.job\.stage\)/);
  assert.match(background, /ไม่มี stage — หยุดก่อนเพื่อไม่ให้ข้ามการสร้างรูป/);
});

check('16 and 24 second choices drive a dynamic two or three clip workflow', () => {
  const popup = fs.readFileSync(path.join(root, 'extension', 'popup.js'), 'utf8');
  const popupHtml = fs.readFileSync(path.join(root, 'extension', 'popup.html'), 'utf8');
  const apiSource = readBackendSource('extension');
  assert.match(popupHtml, /name="duration" value="16"/);
  assert.match(popupHtml, /name="duration" value="24"/);
  assert.match(popup, /selectedDuration\(\)/);
  assert.match(apiSource, /clipCountForDuration/);
  assert.match(apiSource, /targetDurationSeconds/);
});

check('ClipForge branding and Chrome icons are complete', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'extension', 'manifest.json'), 'utf8'));
  const popupHtml = fs.readFileSync(path.join(root, 'extension', 'popup.html'), 'utf8');
  const content = fs.readFileSync(path.join(root, 'extension', 'content.js'), 'utf8');
  assert.equal(manifest.name, 'ClipForge — Auto Video Bot');
  assert.equal(manifest.action.default_title, 'ClipForge');
  for (const size of [16, 32, 48, 128]) {
    const iconPath = path.join(root, 'extension', 'icons', `icon${size}.png`);
    assert.ok(fs.statSync(iconPath).size > 100, `missing icon${size}.png`);
    assert.equal(manifest.icons[String(size)], `icons/icon${size}.png`);
    assert.equal(manifest.action.default_icon[String(size)], `icons/icon${size}.png`);
  }
  assert.match(popupHtml, /<strong>ClipForge<\/strong>/);
  assert.match(popupHtml, /icons\/icon32\.png/);
  assert.match(content, /chrome\.runtime\.getURL\('icons\/icon32\.png'\)/);
});

check('โฟลเดอร์ Extension สองชุดตรงกัน', () => {
  for (const file of ['background.js', 'content.js', 'popup.js', 'popup.html', 'popup.css', 'manifest.json']) {
    const source = fs.readFileSync(path.join(root, 'extension', file));
    const installCopy = fs.readFileSync(path.join(root, 'clipbot-flow-extension', file));
    assert.deepEqual(installCopy, source, `${file} differs between extension folders`);
  }
  for (const size of [16, 32, 48, 128]) {
    const file = path.join('icons', `icon${size}.png`);
    assert.deepEqual(
      fs.readFileSync(path.join(root, 'clipbot-flow-extension', file)),
      fs.readFileSync(path.join(root, 'extension', file)),
      `${file} differs between extension folders`
    );
  }
});

async function checkExistingVideoValidation(): Promise<void> {
  const source = path.join(root, 'data', 'output', 'job_11', 'job_11_video_1.mp4');
  if (!fs.existsSync(source)) {
    console.log('SKIP ตรวจ ffprobe ไฟล์ดาวน์โหลด — ไม่มีคลิปตัวอย่าง job #11');
    return;
  }
  const temporary = path.join(root, 'data', 'test', 'clipbot_job_11_clip_1.mp4');
  fs.mkdirSync(path.dirname(temporary), { recursive: true });
  try {
    fs.copyFileSync(source, temporary);
    const result = await validateExtensionDownload(11, 0, temporary);
    assert.ok(result.size > 1024);
    console.log('PASS ตรวจชื่อ ขนาด และ video stream ของไฟล์ดาวน์โหลด');
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

check('คำอ้างที่ไม่มีหลักฐานต้องถูกตัดออก ไม่ใช่ทิ้งงาน (job #92)', () => {
  const source = readBackendSource('gemini');
  // job #92: Gemini เขียน "ทนทาน" ทั้งที่ไม่มีข้อมูลรองรับ → ตกด่านหลัง retry ครบ
  // → งานตาย + บอทหยุดทั้งระบบ ซึ่งรัน 24 ชม. ไม่ได้
  assert.match(source, /function repairUnsupportedClaims/);
  assert.match(source, /rewriteUnsupportedClaimSegments\(\s*parsed\.subtitleSegments/);
  assert.match(source, /rewriteUnsupportedClaimSegments\(\s*aligned\.subtitleSegments/);
  // เคลมยา/เพศเสียงปน ต้องยังตกด่านเหมือนเดิม ห้ามซ่อมแล้วปล่อยผ่าน
  assert.match(source, /if \(violations\.length\) throw new PromptComplianceError/);

  // ประโยคสำรองห้ามมีคำใน SOURCE_REQUIRED_CLAIMS อยู่ในตัวเอง
  // (เดิมมีคำว่า "ทนทาน" อยู่ → เอาไปซ่อมบทแล้วตกด่านเดิมซ้ำ ซ่อมไม่ได้เลย)
  const listOf = (name: string) => {
    const start = source.indexOf(`export const ${name} = [`);
    return source.slice(start, source.indexOf('];', start)).match(/'([^']+)'/g)!.map((s) => s.slice(1, -1));
  };
  const claims = listOf('SOURCE_REQUIRED_CLAIMS');
  for (const [index, extension] of listOf('SAFE_NARRATION_EXTENSIONS').entries()) {
    const conflict = claims.filter((claim) => extension.includes(claim));
    assert.deepEqual(conflict, [], `ประโยคสำรอง ${index + 1} มีคำที่ต้องมีหลักฐาน: ${conflict.join(', ')}`);
  }
});

check('ตัวเลขสเปกที่แต่งขึ้นเองต้องไม่หลุดเข้าบทพากย์ (job_134)', () => {
  // job_134 พูดว่า "น้ำหนักเพียงสองร้อยสิบสี่กรัม" ทั้งที่เลข 214 ไม่มีอยู่ในชื่อสินค้า
  // รีวิว หรือ brief เลย พรอมต์สั่งห้ามเดาตัวเลขไว้ตั้งแต่ job_129 แล้วแต่โมเดลก็ยังทำ
  // ด่านนี้จึงต้องเป็นโค้ดจริง ไม่ใช่คำสั่งในพรอมต์
  const title = '8นิ้ว พัดลมไร้สาย 12000mAh มีแบตในตัว ชาร์จ USB ปรับได้ 360° ตั้ง & หนีบ';
  const review = 'ปรับได้ 3 ระดับสามารถชาร์จแบตได้ วัสดุแข็งแรงพอสมควรมีความทนทาน';
  const facts = `${title} ${review}`;

  assert.deepEqual(
    findUnsupportedSpecNumbers('มีน้ำหนักเพียงสองร้อยสิบสี่กรัมค่ะ', facts),
    ['214 กรัม'],
    'ตัวเลขที่ไม่มีต้นทางต้องถูกจับ (บทสะกดเลขเป็นคำไทยเสมอเพื่อให้ TTS อ่านถูก)'
  );

  // ของที่มีต้นทางจริงต้องผ่านหมด ไม่งั้นด่านจะไปบีบให้บทพูดสเปกจริงไม่ได้เลย
  for (const line of [
    'พัดลมตั้งโต๊ะขนาดแปดนิ้วเครื่องนี้',            // 8 อยู่ในชื่อสินค้า
    'ปรับแรงลมได้ถึงสามระดับ',                      // 3 อยู่ในรีวิว
    'หมุนปรับทิศทางได้ถึงสามร้อยหกสิบองศา',          // 360 อยู่ในชื่อสินค้า
    'แบตในตัวหนึ่งหมื่นสองพันมิลลิแอมป์',            // 12000 อยู่ในชื่อสินค้า
    'ซื้อมาใช้ครั้งแรกก็ถูกใจเลยค่ะ',                // เลขลอยๆ ไม่ใช่การอ้างสเปก
  ]) {
    assert.deepEqual(findUnsupportedSpecNumbers(line, facts), [], `บล็อกผิดตัว: ${line}`);
  }

  // ประโยคสำรองต้องผ่านด่านนี้ด้วย ไม่งั้นตอนเอาไปซ่อมบทจะตกด่านซ้ำแบบ job #92
  for (const extension of SAFE_NARRATION_EXTENSIONS) {
    assert.deepEqual(findUnsupportedSpecNumbers(extension, ''), [], `ประโยคสำรองอ้างสเปก: ${extension}`);
  }

  // ชื่อวัสดุก็ต้องมีต้นทาง — job_134 พูดว่า "ทำจากพลาสติกพีพี" ทั้งที่ไม่มีใครบอกวัสดุไว้
  assert.ok(SOURCE_REQUIRED_CLAIMS.includes('พลาสติก'), 'วัสดุต้องอยู่ในรายการคำอ้างที่ต้องมีหลักฐาน');
});

check('ของกินต้องได้ฉากสว่างอุ่นเสมอ และภาพต้องไม่ทึบ (เทียบ job_80)', () => {
  // เจ้าของเทียบ job_80 (24 ก.ค.) กับคลิป 31 ก.ค. ของสินค้าตัวเดียวกัน แล้วบอกว่าของเก่าดูดีกว่า
  // ทั้งที่จูนมาเยอะ — ต้นเหตุคือของที่เราเพิ่มเข้าไปเอง ไม่ใช่ Flow แย่ลง
  for (const title of ['พริกกากหมู เคี้ยวเพลินๆ(รสต้มยำ)', 'แคบหมูไร้มัน', 'สาหร่ายทอดกรอบ', 'ขนมปังกรอบ']) {
    const scene = pickBackgroundStyle(title);
    assert.doesNotMatch(scene, /dark slate/, `ของกินต้องไม่ได้ฉากหินดำ: ${title} → ${scene}`);
    assert.match(scene, /kitchen|dining/, `ของกินต้องได้ฉากครัว/โต๊ะอาหาร: ${title} → ${scene}`);
  }

  // ตรวจ prompt จริงที่สร้างออกมา ไม่ใช่ข้อความในซอร์ส — ไม่งั้นคอมเมนต์ที่อ้างถึงคำเก่า
  // จะไปทำให้ด่านของตัวเองแดง ทั้งที่ prompt จริงไม่มีคำนั้นแล้ว
  const prompt = buildReferenceImagePlan({
    handGender: 'female',
    backgroundStyle: 'a modern home kitchen counter with gentle morning light',
  }).imagePrompt || '';
  // ล็อกสีเดิมเขียนว่า "never brighten" ซึ่งห้ามแสงในฉากไปด้วย จนภาพทึบทั้งใบ
  assert.doesNotMatch(prompt, /never brighten/, 'ห้ามกลับไปห้ามภาพสว่างอีก');
  assert.match(prompt, /never recolour or tint it/, 'แต่ยังต้องล็อกสีของตัวสินค้าไว้');
  assert.match(prompt, /Light the scene bright and warm/);
  // job_80 ถือเอียงและสินค้ากินพื้นที่เกือบเต็มเฟรม — ของใหม่ตั้งตรงกลางเฟรมเหลือที่ว่างมืดๆ
  assert.match(prompt, /Tilt it slightly toward the camera/);
  assert.match(prompt, /fills most of the frame height/);
});

check('เน็ตกระตุกต้องไม่ทำให้บอทหยุดทั้งระบบ', () => {
  // เจ้าของแจ้ง: Gemini ตอบ "fetch failed" ครั้งเดียวแล้วบอทดับทั้งตัว ทั้งที่ยังไม่ได้
  // จ่ายเครดิต Flow เลย ต้นเหตุมี 2 ชั้น — ไม่มี retry ตอนเรียก Gemini และตอนเตรียมงานพัง
  // Extension ยังไม่มี currentJob จึงเข้าเส้นทาง "หยุดเพื่อความปลอดภัย"
  assert.ok(isTransientNetworkError(new Error('fetch failed')), 'ต้องรู้จัก fetch failed');
  assert.ok(isTransientNetworkError(new Error('503 Service Unavailable')), 'ต้องรู้จัก 5xx');
  assert.ok(isTransientNetworkError(new Error('model is overloaded')), 'ต้องรู้จักปลายทางล้น');
  assert.ok(!isTransientNetworkError(new Error('บทพากย์คลิป 1 สั้นเกินไป')), 'error เนื้อหาต้องไม่ถูก retry');

  // ทุกจุดที่คุยกับ Gemini ต้องผ่านตัวที่มี retry — เรียก generateContent ตรงๆ ได้ที่เดียว
  // คือข้างในตัว wrapper เอง ไฟล์อื่นเรียกตรงเมื่อไหร่ = จุดนั้นไม่มี retry อีกแล้ว
  const geminiDir = path.join(root, 'backend', 'src', 'gemini');
  const direct = fs.readdirSync(geminiDir)
    .filter((file) => file.endsWith('.ts') && file !== 'gemini-client.ts')
    .filter((file) => /model\.generateContent\(/.test(fs.readFileSync(path.join(geminiDir, file), 'utf8')));
  assert.deepEqual(direct, [], `ไฟล์นี้เรียก Gemini โดยไม่มี retry: ${direct.join(', ')}`);
  assert.match(readBackendSource('gemini'), /export async function generateContentWithRetry/);

  // เตรียมงานล้มเพราะเน็ต = คืนงานกลับคิว ไม่ mark failed และไม่โยน error ออกไป
  const api = fs.readFileSync(path.join(root, 'backend/src/extension/extension-api.ts'), 'utf8');
  assert.match(api, /if \(isTransientNetworkError\(error\)\)[\s\S]{0,400}status: 'pending'[\s\S]{0,300}return null;/);
});

check('รูปส่วนผสมต้องไม่ใช่โปสเตอร์หรือภาพผ่าซีก (job_134)', () => {
  // รูป "ทางการ" ของ Shopee ส่วนใหญ่เป็นโปสเตอร์ที่มีตัวหนังสือเต็มภาพ และบางใบเป็นภาพ
  // X-ray โชว์วงจรข้างใน โหมดส่วนผสมวาดสินค้าใหม่จากรูปพวกนี้ = สอนให้วาดตัวหนังสือมั่ว
  const source = readBackendSource('gemini');
  assert.match(source, /export async function pickIngredientImages/);
  assert.match(source, /text_poster/);
  assert.match(source, /diagram/);

  // โมเดลเคยคืน role ว่า "product_in_use" แทน "in_use" แล้วตัวเทียบแบบตรงตัวตีตกทั้ง 9 ใบ
  assert.equal(normalizeRole('product_in_use'), 'in_use');
  assert.equal(normalizeRole('clean_product'), 'clean_product');
  assert.equal(normalizeRole('text_poster'), 'text_poster');
  assert.equal(normalizeRole('marketing_banner'), 'text_poster');
  assert.equal(normalizeRole('cutaway_diagram'), 'diagram');
  // "โปสเตอร์" ต้องชนะ "product" เสมอ ไม่งั้นโปสเตอร์จะถูกนับเป็นรูปสินค้าสะอาด
  assert.equal(normalizeRole('product_poster'), 'text_poster');

  // ต้องต่อสายเข้ากับตัวเลือกรูปส่วนผสมจริง ไม่ใช่มีฟังก์ชันลอยไว้เฉยๆ
  const api = fs.readFileSync(path.join(root, 'backend/src/extension/extension-api.ts'), 'utf8');
  assert.match(api, /pickIngredientImages\(/);
  assert.doesNotMatch(api, /officialPaths[\s\S]{0,120}\.slice\(0, config\.referenceImageCount\)/);
});

check('ประโยคแรกต้องไม่เปิดด้วยการเรียกชื่อสินค้า (job_134 hook อ่อน)', () => {
  const title = '8นิ้ว พัดลมไร้สาย 12000mAh มีแบตในตัว ชาร์จ USB ปรับได้ 360° ตั้ง & หนีบ';
  assert.ok(
    opensByNamingProduct('พัดลมตั้งโต๊ะขนาดแปดนิ้วที่ทำจากพลาสติกคุณภาพดีค่ะ', title),
    'บทจริงของ job_134 ต้องถูกตีกลับ'
  );
  for (const good of [
    'ห้องร้อนจนนอนไม่หลับ แต่ไม่มีที่วางพัดลมเลยใช่ไหมคะ',
    'ใครทำงานโต๊ะแคบๆ แล้วหาที่วางพัดลมไม่ได้ ต้องดูตัวนี้เลยค่ะ',
    ...SAFE_NARRATION_EXTENSIONS,
  ]) {
    assert.ok(!opensByNamingProduct(good, title), `hook ที่ดีต้องไม่ถูกตีกลับ: ${good.slice(0, 30)}`);
  }

  // รอบสุดท้ายต้องปล่อยผ่าน — hook อ่อนไม่ใช่ข้อมูลเท็จ ไม่คุ้มจะทิ้งงานที่จ่ายเครดิตแล้ว
  const weakHook = {
    motionPrompts: ['The hand lifts the exact product.', 'A hand opens the clamp and hooks it onto the desk edge.'],
    subtitleSegments: [
      { text: 'พัดลมตัวนี้เป็นแบบไร้สาย มีแบตในตัวพร้อมใช้ได้เลยค่ะ', startSec: 0, endSec: 8 },
      { text: 'ตัวหนีบเปิดกว้าง หนีบขอบโต๊ะหรือหัวเตียงได้เลยนะคะ', startSec: 8, endSec: 16 },
    ],
  };
  assert.throws(() => validateGeminiSalesCompliance(weakHook, title, 2, ''), PromptComplianceError);
  assert.doesNotThrow(
    () => validateGeminiSalesCompliance(weakHook, title, 2, '', { enforceHook: false }),
    'รอบสุดท้ายต้องไม่ตายเพราะ hook'
  );
});


check('สินค้าหมวดสวมใส่ต้องมีช็อตสวมใส่จริง (job_143)', () => {
  // job_143 (รองเท้าแตะ MARCO): บทพากย์พูดว่า "ใส่เดินเล่นชิลๆ" แต่ภาพเป็นมือถือรองเท้า
  // ไว้เหนือโต๊ะทั้ง 16 วินาที — เสียงกับภาพขัดกันเอง เจ้าของสั่งให้เพิ่มช็อตสวมใส่ 31 ก.ค.
  assert.equal(wearActionFor('รองเท้าแตะ แบรนด์ MARCO รุ่น G1005')?.bodyPart, 'bare foot');
  assert.equal(wearActionFor('กระเป๋าสะพายข้าง ผ้าแคนวาส')?.bodyPart, 'shoulder');
  assert.equal(wearActionFor('นาฬิกาข้อมือ สายหนัง')?.bodyPart, 'wrist');
  // หมวดที่สวมใส่ไม่ได้ต้องไม่ถูกแตะเลย
  assert.equal(wearActionFor('Oriental Princess ครีมทาผิว Body Lotion'), null);
  assert.equal(wearActionFor('พริกกากหมู เคี้ยวเพลินๆ'), null);
  // ⚠️ ห้ามรวมหมวดที่ต้องวาดใบหน้า (แว่น/หมวก/ต่างหู) — วาดหน้าพลาดคือคลิปใช้ไม่ได้เลย
  assert.equal(wearActionFor('แว่นกันแดด UV400'), null);
  assert.equal(wearActionFor('หมวกบักเก็ต'), null);

  const shots = ['A hand lifts the sandal toward the camera.', 'Continue the exact frame. A finger points to the buckle.'];
  const worn = applyProductIdentityLock(shots, wearActionFor('รองเท้าแตะ MARCO'));
  // ช็อตแรกยังเป็น hero ถือโชว์ และยังห้ามของใหม่เข้าเฟรมตามเดิม
  assert.match(worn[0], /No duplicates and no new objects entering frame./);
  assert.doesNotMatch(worn[0], /bare foot/);
  // ช็อตที่ 2 ต้องเป็นการสวมใส่ พร้อมข้อบังคับกายวิภาค
  assert.match(worn[1], /A bare foot steps into the sandal/);
  assert.match(worn[1], /except one bare foot wearing the product/);
  assert.match(worn[1], /anatomically correct with five toes/);
  assert.match(worn[1], /keeps its exact shape, colors and printed details while worn/);

  // สินค้าที่ไม่ใช่หมวดสวมใส่ต้องได้ผลเหมือนเดิมทุกตัวอักษร (ไม่ regress ของเดิม)
  assert.equal(applyProductIdentityLock(shots, null)[1], applyProductIdentityLock(shots)[1]);
});

check('TICKET-13–17 รูปต้นทาง ส่วนผสม มือ และเสียงใช้ contract เดียวกัน', () => {
  const promptSource = readPromptLayer();
  const motionSource = readMotionLayer();
  const fidelitySource = readBackendSource('gemini', 'fidelity-check.ts');
  const clipFidelitySource = readBackendSource('extension', 'clip-fidelity.ts');
  const configSource = readBackendSource('config.ts');

  // TICKET-14: ห้ามปล่อยรูปที่มือบังตัวตนสินค้าไปจ่ายเครดิต Flow
  assert.match(promptSource, /sourceImageAssessment/);
  assert.match(promptSource, /productIdentityVisible/);
  assert.match(promptSource, /majorDetailsUnobscured/);
  assert.match(promptSource, /usefulVerticalComposition/);
  assert.match(promptSource, /รูปต้นทางใช้ขายไม่ได้/);

  // TICKET-15: คลิป 1 ถูกเจนจากหลาย reference ด่านตรวจจึงต้องเห็นหลักฐานชุดเดียวกัน
  assert.match(clipFidelitySource, /approvedReferencePaths/);
  assert.match(
    clipFidelitySource,
    /compareGeneratedProductFidelity\([\s\S]*?'clip',[\s\S]*?approvedReferencePaths/
  );
  assert.match(fidelitySource, /APPROVED PRODUCT REFERENCE/);
  assert.match(fidelitySource, /appear in NONE of the approved references/);

  // TICKET-13/17: hook ต้องให้สินค้าเป็นตัวเคลื่อนไหว และคำสั่งสองมือต้องถูกตัดทิ้ง
  const hook = sanitizeProductMotionPrompt('A woman\'s hand slowly lifts the product toward camera.', 0);
  // เดิมบังคับว่าต้องได้ประโยคสำรองเป๊ะตัวอักษร — เปลี่ยนมาตรวจเจตนาแทนหลัง job_146
  // (โยนทั้งประโยคทิ้งทำให้ท่าเหมือนกันทุกงาน แล้วบทพากย์ที่เกาะท่าก็จืดตาม)
  assert.match(hook, /^The product rises toward camera/, 'สินค้าต้องเป็นประธาน และทิศทางเดิมต้องอยู่ครบ');
  assert.doesNotMatch(hook, /hand .*lifts/i);
  const oneHand = sanitizeProductMotionPrompt(
    'A pair of natural female hands lifts the product and changes grip.',
    0
  );
  assert.match(oneHand, /one female hand with a fixed grip/);
  assert.match(motionSource, /the product is the moving subject/);

  // TICKET-16: ทั้งภาพ, Gemini TTS, Edge fallback และคำลงท้ายต้องเป็นผู้หญิง
  for (let index = 0; index < 20; index += 1) {
    const style = pickReferenceStyle('สินค้าทดสอบ');
    assert.equal(style.handGender, 'female');
    assert.equal(style.handCount, 1);
  }
  assert.doesNotMatch(configSource, /th-TH-PremwadeeNeural,th-TH-NiwatNeural/);
  assert.match(configSource, /\.filter\(\(voice\) => \/\^Aoede\$\/i\.test\(voice\)\)/);
  assert.match(configSource, /\.filter\(\(voice\) => \/Premwadee\/i\.test\(voice\)\)/);
  const normalizedVoice = normalizeNarrationGender([
    { text: 'ลองดูรายละเอียดตัวนี้นะครับ', startSec: 0, endSec: 8 },
  ]);
  assert.equal(normalizedVoice[0].text, 'ลองดูรายละเอียดตัวนี้นะคะ');
});

check('โครงสร้าง frontend/backend ต้องไม่ปนกันอีก', () => {
  // แยกโครงเมื่อ 27 ก.ค. 2026 เพราะ src/ (backend) กับ web/ (frontend) ปนกันในราก
  // จนหาของยาก เช็คนี้กันไม่ให้ค่อยๆ ไหลกลับไปปนกันอีก
  assert.ok(fs.existsSync(path.join(root, 'backend', 'src')), 'ต้องมี backend/src');
  assert.ok(fs.existsSync(path.join(root, 'frontend', 'src')), 'ต้องมี frontend/src');
  assert.ok(!fs.existsSync(path.join(root, 'src')), 'ห้ามมี src/ ที่รากอีก');
  assert.ok(!fs.existsSync(path.join(root, 'web')), 'ห้ามมี web/ ที่รากอีก');

  // frontend ต้องคุยกับ backend ผ่าน HTTP เท่านั้น ห้าม import ข้ามฝั่ง
  // (ถ้า import ตรงๆ ได้ โค้ด backend จะหลุดไปอยู่ใน bundle ที่ส่งให้เบราว์เซอร์)
  const frontendDir = path.join(root, 'frontend', 'src');
  const frontendSources = fs.readdirSync(frontendDir)
    .filter((file) => file.endsWith('.tsx') || file.endsWith('.ts'))
    .map((file) => fs.readFileSync(path.join(frontendDir, file), 'utf8'))
    .join('\n');
  assert.doesNotMatch(frontendSources, /from '[^']*\.\.\/\.\.\/backend/, 'frontend ห้าม import จาก backend');

  // package.json ต้องชี้ตำแหน่งใหม่ทั้งหมด
  const packageJson = fs.readFileSync(path.join(root, 'package.json'), 'utf8');
  assert.match(packageJson, /backend\/src\/server\/index\.ts/);
  assert.doesNotMatch(packageJson, /"tsx src\/|node[^"]*src\/server\.ts/, 'ห้ามเหลือ path เก่าใน scripts');
});

check('ไฟล์เดียวต้องไม่บวมกลับไปเป็นพันบรรทัดอีก', () => {
  // เหตุผลที่ตั้งเพดาน: ก่อน refactor มี server.ts 528, prompt-generator 1223,
  // extension-api 1062 บรรทัด ซึ่งแก้ทีต้องเลื่อนอ่านผ่านเรื่องอื่นเต็มไปหมด
  // เพดานนี้ไม่ได้ห้ามไฟล์ยาว แต่บังคับให้ "ตั้งใจ" ก่อนจะปล่อยให้ยาวเกินนี้
  const LIMIT = 1000;
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.ts')) continue;
      const lines = fs.readFileSync(full, 'utf8').split('\n').length;
      if (lines > LIMIT) offenders.push(`${path.relative(root, full)} (${lines})`);
    }
  };
  walk(path.join(root, 'backend', 'src'));
  assert.deepEqual(offenders, [], `ไฟล์เกิน ${LIMIT} บรรทัด — ควรแตกเป็นโมดูล: ${offenders.join(', ')}`);
});

check('บรีฟของเอเจนต์ทุกตัวต้องเป็นข้อมูลชุดเดียวกัน', () => {
  // Codex กับ Antigravity อ่าน AGENTS.md เอง ส่วน Claude อ่าน CLAUDE.md เอง
  // ถ้าปล่อยให้แยกกันเขียน เอเจนต์คนละตัวจะทำงานบนข้อมูลคนละชุดโดยไม่มีใครรู้ตัว
  // ซึ่งเป็นเหตุผลที่เจ้าของต้องคอยเอาข้อมูลไปบอกเองทุกรอบ
  const agents = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
  const claude = fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8');

  const sharedInAgents = sectionBetween(agents, SHARED_START, SHARED_END);
  const sharedInClaude = sectionBetween(claude, SHARED_START, SHARED_END);
  assert.ok(sharedInAgents, 'AGENTS.md ต้องมีบล็อก SHARED');
  assert.ok(sharedInClaude, 'CLAUDE.md ต้องมีบล็อก SHARED');
  assert.equal(sharedInClaude, sharedInAgents, 'AGENTS.md กับ CLAUDE.md ไม่ตรงกัน — รัน `npm run brief`');

  // ถ้าบรีฟยังโฆษณาเวอร์ชันเก่า เอเจนต์ที่มาอ่านจะเข้าใจผิดทันที
  const active = fs.readFileSync(path.join(root, 'backend/src/server/paths.ts'), 'utf8')
    .match(/ACTIVE_EXTENSION_VERSION\s*=\s*'([^']+)'/)?.[1];
  const stated = sectionBetween(agents, AUTO_START, AUTO_END);
  assert.ok(stated, 'AGENTS.md ต้องมีบล็อกสถานะสด');
  assert.ok(
    active && stated.includes(active),
    `บรีฟยังไม่ได้อัปเดตเวอร์ชันเป็น ${active} — รัน \`npm run brief\``
  );
});

await checkExistingVideoValidation();
console.log('Regression checks passed');

check('ช็อตใช้งานจริงแบบ "เห็นแค่มือ" — เฉพาะหมวดที่มีท่าชัด และผ่อนด่านเฉพาะช็อตนั้น', () => {
  // เจ้าของส่งคลิปอ้างอิงของ Krumaew Ai Studio (แปรงขัดพื้น/น้ำยาห้องน้ำ) มา 31 ก.ค. 2026
  // แล้วสั่งว่า "อยากให้คลิปเราเป็นแบบนี้ โดยที่เห็นแค่มือ" — คลิปนั้นโชว์งานที่สินค้าทำ
  // ไม่ได้โชว์ตัวสินค้า และขอบเขตที่เจ้าของเคาะคือ "เฉพาะหมวดที่มีท่าใช้ชัด"
  const cleaner = 'แปรงขัดพื้นห้องน้ำ 4in1 ด้ามยาว น้ำยาขจัดคราบ';
  // ⚠️ ตัวอย่างเดิมใช้ "หมอนยางพารา" ซึ่ง 1 ส.ค. 2026 ได้ท่ากดแล้วคืนตัวไปแล้ว
  // (ท่าที่เจ้าของเคยชมเองใน job_145) จึงย้ายมาใช้ของที่ "จงใจไม่เอา" จริงๆ:
  // หมวก/แว่นตา ท่าใช้งานคือสวมบนหัว ต้องวาดใบหน้า = ผิดกฎเห็นแค่มือ
  const noShot = 'George Russell Mercedes F1 - Team Cap 63';
  const demo = demoActionFor(cleaner);
  assert.ok(demo, 'หมวดทำความสะอาดต้องมีท่าใช้งาน');
  assert.equal(demoActionFor(noShot), null, 'หมวดที่ท่าใช้งานต้องมีใบหน้า ต้องคงช็อต hero เดิม');

  // ฉากต้องเป็น "ที่ใช้งานจริง" ตั้งแต่เฟรมแรก ไม่งั้นคลิป 2 ที่ต่อจากเฟรมสุดท้ายของคลิป 1
  // จะย้ายจากโต๊ะจัดสวยไปพื้นห้องน้ำกลางคลิปไม่ได้
  assert.equal(pickBackgroundStyle(cleaner), demo!.scene, 'ฉากรูปตั้งต้นต้องเป็นฉากเดียวกับที่ท่าอ้างถึง');

  const locked = applyProductIdentityLock(
    ['A hand holds the product toward camera.', 'A hand holds the product toward camera.'],
    wearActionFor(cleaner),
    demo
  );
  // ช็อตแรกยังเป็น hero ล็อกเต็ม — ด่านเทียบเฟรมแรกยืนบนสมมติฐานว่าฉลากอ่านออก
  // ถ้าเปลี่ยนช็อตแรกเป็นช็อตใช้งานด้วย ด่านจะตีตกคลิปที่ถูกต้องแล้วเราจ่ายเครดิตทิ้ง
  assert.equal(isDemoShotPrompt(locked[0]), false, 'ช็อตแรกต้องเป็น hero เสมอ');
  assert.match(locked[0], /the product is the moving subject/, 'ช็อตแรกต้องใช้ล็อกเต็ม');
  assert.equal(isDemoShotPrompt(locked[1]), true, 'ช็อต 2 ของหมวดนี้ต้องเป็นช็อตใช้งานจริง');

  // สิ่งที่ผ่อนได้ในช็อตใช้งาน
  assert.doesNotMatch(locked[1], /all five fingers keep the same grip points/, 'มือต้องได้ทำงาน');
  assert.doesNotMatch(locked[1], /front label is readable in the opening seconds/, 'ฉลากไม่ต้องอ่านออกตอนกำลังใช้งาน');
  // ช็อตใช้งานต้องได้ไทม์ไลน์คนละตัวกับ hero — กล้องตามมือ ไม่ใช่พาเข้าไปดูผิวสินค้า
  assert.match(locked[1], /4-6s stay macro on the exact spot that changes/, 'ช็อตใช้งานต้องใช้ไทม์ไลน์ของมันเอง');
  assert.doesNotMatch(locked[1], /the camera alone pushes in slowly/, 'ห้ามได้ไทม์ไลน์ hero');
  // ⚠️ สิ่งที่ห้ามผ่อนเด็ดขาด แม้ในช็อตใช้งาน
  assert.match(locked[1], /never re-letter/, 'ห้ามเขียนฉลากใหม่ ผ่อนไม่ได้ทุกโหมด');
  assert.match(locked[1], /never show an unseen side, never invent unseen parts/, 'ห้ามวาดด้านที่ไม่เคยเห็น');
  assert.match(locked[1], /No second hand, other hand, pair of hands or new fingers may enter/, 'ยังมือเดียวเหมือนเดิม');
  // ข้อห้ามใหม่ที่ล็อกเดิมไม่เคยมี — เจ้าของสั่งว่าเห็นได้แค่มือ
  assert.match(
    locked[1],
    /Never show a face, head, hair, torso, legs or any other part of a person/,
    'ห้ามมีใบหน้า/ลำตัว — คลิปอ้างอิงมีคนทั้งตัว แต่ของเราห้าม'
  );

  // 🐛 job_147: ล็อกห้ามมือที่สอง แต่ท่าสั่ง "ดึงกระดาษออกจากซอง" ซึ่งคนจริงต้องใช้สองมือ
  // โมเดลเลือกทำตามท่า แล้วเสกมือเพิ่มจนได้สามมือกับกำไลหยกสองวง
  // ทุกท่าจึงต้องประกาศจำนวนมือที่ใช้จริง และล็อกต้องพูดตรงกับตัวเลขนั้นเสมอ
  for (const title of ['แปรงขัดพื้นห้องน้ำ น้ำยาขจัดคราบ', 'ทิชชู่ Botare 4 ชั้น', 'โทนเนอร์เช็ดรักแร้']) {
    const d = demoActionFor(title)!;
    assert.ok(d.hands === 1 || d.hands === 2, `${title}: ต้องประกาศจำนวนมือ`);
    const shot = applyProductIdentityLock(['A hand holds it.', 'A hand holds it.'], null, d)[1];
    if (d.hands === 2) {
      assert.match(shot, /Exactly two natural adult female hands are visible/, `${title}: ล็อกต้องบอกสองมือ`);
      assert.doesNotMatch(shot, /No second hand, other hand, pair of hands/, `${title}: ห้ามยังห้ามมือที่สองอยู่`);
      assert.match(shot, /No third hand, no extra arm/, `${title}: ต้องกันมือที่สามแทน`);
      assert.match(shot, /never duplicate a bracelet or ring onto another wrist/, `${title}: กำไลห้ามงอก`);
    } else {
      assert.match(shot, /Exactly one natural adult female hand is visible/, `${title}: ล็อกต้องบอกมือเดียว`);
      assert.match(shot, /No second hand, other hand, pair of hands/, `${title}: มือเดียวต้องห้ามมือที่สอง`);
    }
    // ผลลัพธ์ต้องถูกสั่งให้เกิดจริง ไม่งั้นได้แค่ "มือขยับ" บนฉากที่ไม่เปลี่ยนอะไรเลย
    assert.match(shot, new RegExp(`MUST have visibly changed in exactly one way: ${escapeForRegExp(d.result)}`), `${title}: ต้องสั่งให้ผลลัพธ์เกิด`);
    assert.match(shot, /must not return to how it began/, `${title}: ห้ามวนกลับมาท่าเริ่มต้น`);
    // ท่าต้องเป็นจังหวะเดียว — เอาผลลัพธ์ขึ้นต้น ไม่ใช่ไล่ทำสามอย่างใน 8 วินาที
    assert.ok(d.action.split('.').filter((s) => s.trim()).length === 1, `${title}: ท่าต้องเป็นประโยคเดียว`);
  }

  // ท่าที่ต้องใช้ของเพิ่ม (สำลี) ต้องถูกผ่อนข้อ "no new objects" ให้ ไม่งั้นพรอมต์สั่งขัดกันเอง
  // แบบเดียวกับบั๊กมือเป็นประธานใน job_146
  const toner = applyProductIdentityLock(
    ['A hand holds the product toward camera.', 'A hand holds the product toward camera.'],
    wearActionFor('โทนเนอร์เช็ดรักแร้ Iblanc'),
    demoActionFor('โทนเนอร์เช็ดรักแร้ Iblanc')
  );
  assert.match(toner[1], /cotton pad/, 'ท่านี้ใช้สำลี');
  assert.match(toner[1], /no new objects entering frame except .*cotton pad/, 'ต้องผ่อนข้อของใหม่ให้สำลีที่ท่าเรียกใช้');
  // สกินแคร์ห้ามลงหน้าเด็ดขาด — วาดหน้าพลาดคือคลิปใช้ไม่ได้เลย
  assert.match(toner[1], /inner forearm/, 'สกินแคร์ต้องทาลงแขน ไม่ใช่ลงหน้า');

  // 🐛 job_156: แขนที่ถูกเช็ดไม่ได้ผูกกับมือไหนเลย → ในเฟรมมีสามแขน (ถือขวด/จับสำลี/แขนที่ถูกเช็ด)
  // เจ้าของทักเองว่า "เหมือนมี 3 แขนเลย" — ซ้ำรอย job_147 โดยผมนับพลาดเองรอบนี้
  // สินค้าถูกถืออยู่หนึ่งมือเสมอ อวัยวะที่ไม่ใช่มือจึงต้องบอกทุกครั้งว่าเป็นของแขนไหน
  assert.deepEqual(auditDemoLimbAccounting(), [], 'ทุกท่าต้องบอกว่าอวัยวะที่เรียกเข้าฉากเป็นของแขนไหน');
  assert.match(
    toner[1],
    /inner forearm of the arm holding the product/,
    'แขนที่ถูกเช็ดต้องเป็นแขนข้างที่ถือสินค้า ไม่งั้นได้แขนที่สาม'
  );
  // เจ้าของขอจังหวะบีบลงผ้าก่อนเช็ด — ขาดจังหวะนี้คนดูไม่เชื่อว่าครีมบนแขนมาจากขวดใบนี้
  // 🐛 job_162: เดิม assert คำว่า `one press dispenses it` ซึ่งเป็นกลไกของหัวปั๊ม
  // สินค้าหมวดนี้ส่วนใหญ่เป็นขวดฝากระดก/หลอดบีบ โมเดลจึงทำท่ากดฝาที่ปิดอยู่ 6 วินาทีแล้วข้าม
  assert.match(toner[1], /the open bottle is tipped and squeezed once over it/, 'ต้องเห็นจังหวะบีบลงสำลี');
  // ⚠️ ท่าจ่ายของเหลวทำไม่ได้ถ้าเฟรมตั้งต้นฝาปิด — เฟรมตั้งต้นต้องเปิดฝามาแล้ว
  const tonerDemo = demoActionFor('โทนเนอร์เช็ดรักแร้ Iblanc')!;
  assert.match(tonerDemo.startState || '', /cap or lid already open/, 'หมวดนี้ต้องสั่งให้เฟรมตั้งต้นเปิดฝา');
  assert.match(
    buildReferenceImagePlan({ handGender: 'female', handCount: 1, backgroundStyle: 'a bright counter' }, undefined, tonerDemo.startState).imagePrompt || '',
    /Show the product with its cap or lid already open/,
    'พรอมต์เจนรูปต้องได้รับคำสั่งสภาพเริ่มต้นไปด้วย'
  );
  // หมวดที่ท่าคือ "เปิดฝา" ต้องไม่ถูกสั่งให้เปิดมาก่อน ไม่งั้นไม่เหลืออะไรให้เปิด
  assert.equal(demoActionFor('กระติกน้ำสแตนเลส เก็บความเย็น')!.startState, undefined, 'กระติกต้องฝาปิดมาก่อน');

  // ด่านเทียบสินค้าต้องมีโหมดผ่อนสำหรับช็อตนี้ และต้องอ่านจากพรอมต์จริง ไม่ใช่ flag แยก
  const fidelitySource = readBackendSource('gemini', 'fidelity-check.ts');
  const clipFidelitySource = readBackendSource('extension', 'clip-fidelity.ts');
  assert.match(fidelitySource, /'clip_in_use'/);
  assert.match(fidelitySource, /the product is being USED, not displayed/);
  assert.match(clipFidelitySource, /isDemoShotPrompt\(vision\?\.motionPrompts\?\.\[clipIndex\]/);
  assert.match(clipFidelitySource, /inUseShot \? 'clip_in_use' : 'clip'/);
});

function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

check('บทจากคลิปจริงที่กลวงกว่าบทวางล่วงหน้า ต้องถูกถอยกลับ ไม่ใช่ปล่อยออกอากาศ', () => {
  // 🐛 job_147: บทวางล่วงหน้าเปิดด้วย "ทำน้ำหกเลอะเทอะบนโต๊ะบ่อยๆ..." ซึ่งตรงกับภาพเป๊ะ
  // แต่บทที่ Gemini เขียนใหม่หลังดูคลิปจริงสั้นเกินเกณฑ์ ตัวเติมเลยแทนด้วยประโยคสำรองทั้งท่อน
  // 8 วินาทีแรกของวิดีโอที่ส่งมอบจึงไม่มีคำว่ากระดาษ ทิชชู่ หรือ 4 ชั้น เลยสักคำ
  const finalizeSource = readBackendSource('extension', 'job-finalize.ts');
  assert.match(finalizeSource, /const videoFiller = auditSafeNarrationFallback\(alignedNarration\.subtitleSegments\)/);
  assert.match(finalizeSource, /if \(upfrontFiller\.length < videoFiller\.length\)/);
  assert.match(finalizeSource, /alignedNarration = upfrontNarration;\s+narrationSource = 'upfront';/);

  // ตัวนับต้องรู้จักประโยคสำรองจริงทุกบรรทัด ไม่งั้นเทียบสองบทแล้วได้ 0 เท่ากันเสมอ
  const [first] = SAFE_NARRATION_EXTENSIONS;
  assert.equal(safeFillerRatio(first), 1, 'บทที่เป็นประโยคสำรองล้วนต้องได้อัตราส่วน 100%');
  assert.ok(safeFillerRatio('ทิชชู่หนา 4 ชั้นซับน้ำได้ดีมากค่ะ ลองใช้ดูนะคะ') < SAFE_FILLER_ALERT_RATIO, 'บทจริงต้องไม่ถูกนับว่ากลวง');
  assert.equal(
    auditSafeNarrationFallback([{ text: first, startSec: 0, endSec: 8 }]).length,
    1,
    'ท่อนที่กลวงต้องถูกนับได้'
  );
});

check('ช็อตแกะซอง — ของในมือเปลี่ยนได้ แต่ต้องเห็นจังหวะที่มันเปลี่ยน', () => {
  // 🐛 job_148 (แพมเพิส Penbose): รูปตั้งต้นถือ "แพ็ค" พอเข้าคลิปกลายเป็น "ผ้าอ้อมชิ้นเดียว"
  // ทันทีโดยไม่มีจังหวะแกะ Codex อ่านคลิปแล้วสรุปว่านี่คือจุดที่สะดุดที่สุด และทำให้คนดู
  // อ่านว่า "AI เปลี่ยนสินค้ากลางทาง" = ดูเหมือนของเลียนแบบ
  //
  // เจ้าของเคาะ 1 ส.ค. ว่า **การแกะซองคือสิ่งที่ควรมี** เพราะคือภาพของการขายจริง
  // ทางแก้จึงไม่ใช่ห้ามของในมือเปลี่ยน แต่บังคับให้เห็นจังหวะที่มันเปลี่ยน
  for (const title of ['แพมเพิส Penbose 50ชิ้น ผ้าอ้อมเด็ก', 'Botare กระดาษเช็ดหน้า 4 ชั้น', 'พริกกากหมู ขนมขบเคี้ยว']) {
    const d = demoActionFor(title);
    assert.ok(d, `${title}: สินค้าขายเป็นแพ็คต้องได้ช็อตแกะซอง`);
    assert.equal(d!.hands, 2, `${title}: แกะซองต้องใช้สองมือ ห้ามประกาศ 1 แล้วสั่งให้แกะ`);
    // ท่าต้องพูดถึงทั้ง "ชิ้นที่หยิบออกมา" และ "ซองที่มันออกมาจาก" อยู่ในเฟรมเดียวกัน
    // ไม่งั้นก็กลับไปเป็นการสลับชิ้นแบบเทเลพอร์ตเหมือนเดิม
    assert.match(d!.action, /out of the (?:pack|bag)/i, `${title}: ท่าต้องแสดงว่าชิ้นนั้นออกมาจากซอง`);
    assert.match(d!.result, /pack is open|bag is open/i, `${title}: ผลลัพธ์ต้องคือซองถูกเปิดแล้ว`);
  }

  // ⚠️ ตัวจับต้องไม่กวาดสินค้าที่ไม่ได้ขายเป็นแพ็คของกินของใช้ — ชื่อสินค้าบน Shopee
  // ใส่จำนวนชิ้นกันแทบทุกตัว ถ้าจับด้วย `\d+ ชิ้น` จะกวาดเกือบทั้งฐานเข้ามา
  for (const title of ['ชุดเครื่องมือช่าง 12 ชิ้น กล่องเหล็ก', 'เคสมือถือ แพ็ค 3 ชิ้น']) {
    assert.equal(demoActionFor(title), null, `${title}: ไม่ควรถูกจับเป็นช็อตแกะซอง`);
  }
  // หมอนมีท่าของตัวเอง (กดแล้วคืนตัว) ต้องไม่ถูกหมวดแกะซองลากไป
  assert.match(demoActionFor('หมอนยางพารา เพื่อสุขภาพ')!.result, /springs back/i);
  // ตารางหมวดย้ายไป shot-categories.ts เมื่อ 1 ส.ค. 2026 (motion-prompts.ts ถือสามเรื่องปนกัน)
  const categorySource = readBackendSource('gemini', 'shot-categories.ts');
  assert.doesNotMatch(categorySource, /\d\+\s\*ชิ้น/, 'ห้ามกลับไปใช้ตัวจับ "N ชิ้น" ที่กวาดเกิน');

  // ของกินต้องได้ฉากครัวแสงอุ่นเสมอ — ฉากของโหมดสาธิตทับฉากจาก BACKGROUND_FAMILIES
  // ถ้าไม่แยกหมวดของกินออกมา job_80 (พริกกากหมูถ่ายบนหินดำแสงมืด) จะกลับมา
  const snack = demoActionFor('พริกกากหมู ขนมขบเคี้ยว')!;
  assert.match(snack.scene, /kitchen/i, 'ของกินต้องอยู่ในครัว');
  assert.match(snack.scene, /warm/i, 'ของกินต้องได้แสงอุ่น');

  // ฉากต้องเข้าคู่กับท่า — ทิชชู่เคยตั้งฉาก "เคาน์เตอร์มีน้ำหก" ไว้คู่กับท่าเช็ด
  // พอเปลี่ยนท่าเป็นแกะซองแล้วไม่แก้ฉาก น้ำที่หกจะกลายเป็นคำสัญญาที่ไม่มีวันจบ (อาการ job_147)
  const tissue = demoActionFor('Botare กระดาษเช็ดหน้า')!;
  assert.doesNotMatch(tissue.scene, /spill/i, 'ฉากห้ามสัญญาสิ่งที่ท่าไม่ได้ทำ');

  // 🐛 job_148: ซองบนชั้นในฉากหลังถูกออกแบบใหม่กลางคลิป (ยีราฟการ์ตูน → รูปถ่ายหน้าเด็ก)
  // และมีขวดปั๊มสีเหลืองโผล่มาวินาทีที่ 9 — ล็อกเดิมพูดถึงแต่สินค้าที่ถืออยู่เท่านั้น
  const shot = applyProductIdentityLock(['A hand holds it.', 'A hand holds it.'], null, tissue)[1];
  assert.match(shot, /Every other copy of this product sitting in the background keeps the exact same packaging artwork/);
  assert.match(shot, /never swap a cartoon for a photo/);
  assert.match(shot, /Nothing new may appear anywhere in the scene, including on shelves behind the action/);

  // ด่านต้องรู้จักช็อตแกะซอง ไม่งั้นมันจะตีตกช็อตที่เราตั้งใจสร้างเองว่า "สินค้าคนละตัว"
  const fidelitySource = readBackendSource('gemini', 'fidelity-check.ts');
  assert.match(fidelitySource, /The pack may also be OPEN here with one single unit from inside it taken out/);
  assert.match(fidelitySource, /invented wording is an identity change/);
});

check('หมวดช็อตสาธิตต้องเรียงเจาะจงก่อนกว้าง — สินค้าต้องไปอยู่ในที่ที่มันถูกใช้จริง', () => {
  // 🐛 job_149 (Cerax Wax เคลือบยางดำ ซิลิโคนออยล์): ถูกส่งไป "ขัดพื้นห้องน้ำ"
  // ชื่อสินค้ามีคำว่า "น้ำยาขัดยางดำเงา" ซึ่งตรงกับ `น้ำยา(?:ขัด)` ของหมวดทำความสะอาด
  // ที่ตอนนั้นวางไว้บนสุด ส่วนหมวดคาร์แคร์ไม่มีคำว่า ยางดำ/ทายาง/ซิลิโคนออยล์ เลย
  //
  // ⚠️ สินค้า **ตัวเดียวกันนี้** เคยพังมาแล้วใน job_132 (ได้โต๊ะเครื่องแป้ง) และแก้ไปแล้ว
  // ในตารางฉากหลัง — บั๊กกลับมาเพราะผมสร้างตารางหมวดใบใหม่โดยไม่ยกคำเดิมมาด้วย
  const routes: Array<[string, RegExp]> = [
    ['เคลือบยางดำ [ฟรีฟองน้ำ] ทายางดำ ซิลิโคนออยล์ แท้ กันUV น้ำยาขัดยางดำเงา', /car tyre/i],
    ['Cerax Wax น้ำยาเคลือบเงา ยางรถยนต์', /car tyre/i],
    ['น้ำยาล้างจาน สูตรมะนาว ขจัดคราบมัน', /kitchen sink/i],
    ['แปรงขัดพื้นห้องน้ำ 4in1 น้ำยาขจัดคราบ', /tiled bathroom floor/i],
    ['น้ำยาถูพื้น กลิ่นลาเวนเดอร์', /tiled bathroom floor/i],
    ['เซรั่มบำรุงผิว อาร์แกนออยล์', /bathroom counter/i],
  ];
  for (const [title, expected] of routes) {
    const d = demoActionFor(title);
    assert.ok(d, `${title}: ควรเข้าหมวดสาธิต`);
    assert.match(d!.scene, expected, `${title}: ไปอยู่ผิดที่ — ได้ "${d!.scene}"`);
  }

  // ตารางฉากหลังกับตารางหมวดสาธิตต้องใช้ตัวจับคาร์แคร์ตัวเดียวกัน ห้ามเขียนคำซ้ำสองที่
  // ไม่งั้นสองตารางจะเลื่อนออกจากกันแล้วบั๊กเดิมกลับมาอีกรอบเหมือนที่เพิ่งเกิด
  const styleSource = readBackendSource('extension', 'reference-style.ts');
  assert.match(styleSource, /import \{ CAR_CARE_PATTERN, demoActionFor \}/);
  assert.match(styleSource, /match: CAR_CARE_PATTERN,/);
  assert.doesNotMatch(styleSource, /match: \/ยางรถ\|ยางล้อ\|รถยนต์/, 'ห้ามกลับไปเขียนคำคาร์แคร์ซ้ำในตารางฉากหลัง');

  // ตัวกว้างต้องอยู่ท้ายสุดของตาราง ไม่งั้นมันจะกลืนหมวดเจาะจงที่อยู่ข้างล่างทั้งหมด
  const tableSource = readBackendSource('gemini', 'shot-categories.ts');
  const cleanerAt = tableSource.indexOf('น้ำยา(?:ล้าง|ขัด|ถู|ทำความสะอาด)');
  const tableEnd = tableSource.indexOf('export function demoActionFor');
  const others = ['match: CAR_CARE_PATTERN', 'น้ำยาล้างจาน|ล้างจาน', 'ทิชชู่|กระดาษเช็ด', 'สเปรย์|ฉีดพ่น'];
  assert.ok(cleanerAt > 0 && cleanerAt < tableEnd, 'หา entry ทำความสะอาดในตารางไม่เจอ');
  for (const other of others) {
    const at = tableSource.indexOf(other);
    assert.ok(at > 0 && at < cleanerAt, `entry "${other}" ต้องอยู่ก่อนตัวกว้าง ไม่งั้นถูกกลืน`);
  }
});

check('เลือกหมวดด้วยการนับคำที่ตรง ไม่ใช่ลำดับ — ชื่อสินค้าไทยมีคำซ้อนหมวดเสมอ', () => {
  // การเรียงลำดับอย่างเดียวแก้ไม่ได้ พิสูจน์แล้วสองรอบในวันเดียว (1 ส.ค. 2026):
  //
  //   job_149 "เคลือบยางดำ ... น้ำยาขัดยางดำเงา" — หมวดทำความสะอาดอยู่บนสุด `น้ำยาขัด`
  //     จับก่อน → น้ำยาเคลือบยางรถถูกส่งไปขัดพื้นห้องน้ำ
  //     แก้ด้วยการย้ายหมวดทำความสะอาดไปท้ายสุด แล้วเกิด...
  //
  //   job_150 "ถังปั่นไม้ม๊อบ ... ผ้าม๊อบไมโครไฟเบอร์" — `ไมโครไฟเบอร์` อยู่ในหมวดทิชชู่
  //     ซึ่งตอนนี้อยู่ก่อนหมวดพื้น → ไม้ม็อบได้ท่า "ดึงกระดาษออกจากซอง" บนเคาน์เตอร์ครัว
  //
  // ทั้งสองชื่อเป็นชื่อจริงจากฐานข้อมูล ต้องเข้าหมวดถูกโดยไม่ต้องพึ่งลำดับ
  const realTitles: Array<[string, RegExp]> = [
    ['ถังปั่นไม้ม๊อบ ถังปั่นไม้ถูพื้น Spin Mop ชุดถังปั่นพลาสติก ชุดทำความสะอาดพื้น ไม้ถูพื้น ไม้ม๊อบ ผ้าม๊อบไมโครไฟเบอร์.', /tiled bathroom floor/i],
    ['เคลือบยางดำ [ฟรีฟองน้ำ] ทายางดำ ซิลิโคนออยล์ แท้ ยางดำกันน้ำ กันUV น้ำยาขัดยางดำเงา', /car tyre/i],
  ];
  for (const [title, expected] of realTitles) {
    const d = demoActionFor(title);
    assert.ok(d, `${title.slice(0, 30)}: ควรเข้าหมวดสาธิต`);
    assert.match(d!.scene, expected, `${title.slice(0, 30)}: ไปผิดที่ — ได้ "${d!.scene}"`);
  }

  // คำกำกวมที่อยู่หมวดเดียวโดดๆ ต้องยังทำงานปกติ — "ไมโครไฟเบอร์" เป็นผ้าเช็ดจริงเมื่อ
  // ไม่มีคำของหมวดพื้นมาแข่ง ตัวนับต้องไม่ทำให้หมวดทิชชู่ใช้ไม่ได้ไปเลย
  assert.match(
    demoActionFor('ผ้าไมโครไฟเบอร์ เช็ดทำความสะอาด อเนกประสงค์')!.scene,
    /kitchen countertop/i,
    'ผ้าไมโครไฟเบอร์เดี่ยวๆ ยังต้องเป็นหมวดผ้าเช็ด'
  );

  // ต้องเป็นการนับจริง ไม่ใช่ .find() ตัวแรกที่ตรงเหมือนเดิม
  const scoreSource = readBackendSource('gemini', 'shot-categories.ts');
  assert.match(scoreSource, /function categoryScore\(pattern: RegExp, productTitle: string\): number/);
  assert.doesNotMatch(
    scoreSource,
    /DEMO_CATEGORIES\.find\(\(entry\) => entry\.match\.test\(productTitle\)\)/,
    'ห้ามกลับไปใช้ "ตัวแรกที่ตรงชนะ"'
  );
  // นับคำที่ต่างกันจริง ไม่ใช่นับจำนวนครั้ง — ชื่อไทยชอบพิมพ์คำเดิมซ้ำเพื่อ SEO
  // ถ้านับซ้ำ คะแนนจะเฟ้อตามความยาวชื่อแทนที่จะสะท้อนความตรงของหมวด
  assert.match(scoreSource, /new Set\(hits\.map\(\(hit\) => hit\.toLowerCase\(\)\)\)\.size/);
});

check('โหมดส่วนผสมต้องบอก Flow ว่ารูปไหนคือสินค้าตัวจริง (job_152)', () => {
  // 🐛 job_152 (พริกกากหมู PIGGY BITES): ซองถูกวาดใหม่จนเป็นสินค้าคนละตัว —
  // `PIGGY BITES` ซ้ำสองบรรทัด ตัวหนังสือไทยหายหมด มาสคอตหมูหาย ช่องเลือกรสหาย
  // ชิ้นกากหมูกลายเป็นขนมกรอบเป็นวง และมีตารางโภชนาการอังกฤษ + "NET WT 1 OZ" โผล่มาเอง
  // ทั้งที่ไม่มีอยู่ทั้งในรูปต้นฉบับและรูปทางการ (ด่านจับได้ที่ 45/100 — ทำงานถูก)
  //
  // ต้นเหตุอยู่ในโค้ดเรา ไม่ใช่ที่โมเดล: ขั้นเจน "รูป" มีประโยคอธิบายรูปเสริมอยู่แล้ว
  // แต่ขั้นเจน "คลิป" ซึ่งแนบรูปเข้า Flow ถึง 4 ใบ ส่งไปแค่ motion prompt เปล่าๆ
  // ไม่เคยบอกว่าใบไหนคือของจริง Flow จึงเกลี่ยน้ำหนักทุกใบเท่ากัน แล้วเอารูป
  // "กากหมูกองบนจาน ไม่มีซอง" ไปผสมกับซองจนได้ซองที่พิมพ์ขนมคนละชนิด
  const motion = 'Continuity lock: same product. The bag moves closer to camera.';
  assert.equal(withIngredientGuidance(motion, 1), motion, 'รูปใบเดียว = ไม่ใช่โหมดส่วนผสม ห้ามเติมอะไร');
  assert.equal(withIngredientGuidance(motion, 0), motion, 'ไม่มีรูป = ห้ามเติมอะไร');

  const guided = withIngredientGuidance(motion, 4);
  assert.notEqual(guided, motion, 'แนบหลายใบต้องมีคำอธิบายเสมอ');
  assert.match(guided, /Image 1 is the approved product and scene/, 'ต้องระบุว่าใบแรกคือของจริง');
  assert.match(guided, /sole authority on its packaging/, 'ต้องบอกว่าใบแรกคุมเรื่องซอง');
  assert.match(guided, /shape and colour only/, 'ใบอื่นใช้ได้แค่รูปทรงกับสี');
  // ข้อที่ทำให้ job_152 พังโดยตรง — กากหมูที่กองอยู่บนจานถูกพิมพ์ลงบนซอง
  assert.match(guided, /never .*print loose contents onto it|print loose contents onto it/, 'ห้ามเอาเนื้อสินค้าไปพิมพ์บนซอง');

  // ⚠️ ความยาว = เวลาพิมพ์ทีละตัวอักษร job #89 เคยยาวจนเจ้าของนึกว่าบอทค้างแล้วกดหยุด
  // ฉบับแรกที่เขียนยาว 596 ตัว (+60 วินาทีต่อคลิป) ต้องไม่ปล่อยให้เฟ้อกลับไปแบบนั้น
  const added = guided.length - motion.length;
  assert.ok(added <= 320, `คำอธิบายรูปเสริมยาว ${added} ตัว — เกิน 320 จะถ่วงเวลาพิมพ์เกินไป`);

  // ทั้งสองเส้นทางที่ส่งงานคลิปแรกต้องใช้ตัวนี้ ลืมเส้นทางใดเส้นทางหนึ่ง = บั๊กกลับมาครึ่งหนึ่ง
  // อ่านทั้งโฟลเดอร์ ไม่ยึดไฟล์ — สองเส้นทางนี้อยู่คนละไฟล์แล้วตั้งแต่แยกโมดูล 1 ส.ค. 2026
  // (เส้นทาง claim อยู่ extension-api.ts / เส้นทางส่งตรงหลังเซฟรูปอยู่ clip-intake.ts)
  // สิ่งที่ต้องกันคือ "มีเส้นทางไหนลืมใส่คำอธิบายรูปเสริม" ไม่ใช่ "โค้ดอยู่ไฟล์ไหน"
  const apiSource = readBackendSource('extension');
  // นับเฉพาะ "จุดที่ห่อพรอมต์จริง" — ถ้านับ withIngredientGuidance( ลอยๆ จะไปโดนตัวประกาศ
  // ฟังก์ชันใน ingredient-plan.ts กับบรรทัด re-export ด้วย แล้วตัวเลขจะไม่ได้แปลว่าอะไรเลย
  const uses = apiSource.match(/prompt: withIngredientGuidance\(/g) || [];
  assert.equal(uses.length, 2, `ต้องห่อพรอมต์ทั้งสองเส้นทางที่แนบส่วนผสม (เจอ ${uses.length} ครั้ง)`);
  // ตัวฟังก์ชันอยู่คนละไฟล์ตั้งแต่ 1 ส.ค. 2026 (extension-api.ts ทะลุเพดาน 1000 บรรทัด)
  // ต้องอยู่คู่กับ buildIngredientPaths เสมอ เพราะจำนวนรูปที่แนบคือตัวกำหนดว่าพรอมต์ต้องพูดอะไร
  const planSource = readBackendSource('extension', 'ingredient-plan.ts');
  assert.match(planSource, /export function withIngredientGuidance/);
  assert.match(planSource, /export function buildIngredientPaths/);
  assert.match(apiSource, /prompt: withIngredientGuidance\(\s*vision\.motionPrompts\[clipPaths\.length\]/);
  assert.match(apiSource, /prompt: withIngredientGuidance\(updatedVision\.motionPrompts\[0\], firstClipIngredients\.length\)/);
  // จำนวนที่ส่งให้พรอมต์ต้องเป็นจำนวนรูปที่แนบจริง ไม่ใช่ค่าคงที่หรือค่าเดา
  assert.match(apiSource, /\.\.\.\(ingredientPaths\.length \? \{ ingredientImagePaths: ingredientPaths \} : \{\}\)/);
});

check('เครื่องใช้ไฟฟ้าในครัว — กดปุ่มแล้วของข้างในต้องเปลี่ยนสภาพให้เห็น (job_154)', () => {
  // 🐛 job_154 (เครื่องปั่น Yotex): ตกทุกหมวด → คลิป 2 ได้ท่าสำรองกลางๆ ที่ไม่บอกว่าให้ทำอะไร
  // ทั้งที่เครื่องปั่นมีท่าชัดที่สุด: กดปุ่ม → ของข้างในเปลี่ยนสภาพ
  // (ชื่อสินค้าเขียนเองว่า "การทำงานด้วยปุ่มเดียว" — มือเดียวจริง ตัวเครื่องตั้งบนเคาน์เตอร์)
  const blender = demoActionFor('Yotex เครื่องปั่นอาหารเด็ก เครื่องปั่นกระเทียม การทำงานด้วยปุ่มเดียว 1000ML ทำความสะอาดง่าย');
  assert.ok(blender, 'เครื่องปั่นต้องเข้าหมวดสาธิต');
  assert.equal(blender!.hands, 1, 'กดปุ่มใช้มือเดียว ห้ามประกาศเกินจริง');
  assert.match(blender!.scene, /kitchen counter/i);
  assert.match(blender!.action, /^The food inside turns/, 'ต้องขึ้นต้นด้วยผลลัพธ์ ไม่ใช่การกระทำ');
  assert.ok(blender!.prop, 'ของที่อยู่ข้างในนับเป็นของใหม่ในเฟรม ต้องประกาศเป็น prop ไม่งั้นล็อกขัดกับท่า');
  assert.equal(blender!.action.split('.').filter((s) => s.trim()).length, 1, 'ท่าต้องเป็นจังหวะเดียว');

  for (const title of ['หม้อทอดไร้น้ำมัน 5.5 ลิตร', 'เครื่องบดกาแฟ ไฟฟ้า']) {
    assert.ok(demoActionFor(title), `${title}: ควรเข้าหมวดเดียวกัน`);
  }
  // ⚠️ ห้ามกวาด "หม้อ" เดี่ยวๆ เข้ามา — หม้อต้มไม่มีปุ่มและของข้างในไม่เปลี่ยนสภาพให้เห็น
  // เอาเฉพาะที่ "กดแล้วเห็นผล" จริงๆ ไม่งั้นจะได้ท่าที่ภาพทำตามไม่ได้
  assert.equal(demoActionFor('หม้อต้มสแตนเลส 24 ซม.'), null, 'หม้อต้มธรรมดาต้องคงช็อต hero');

  // คำว่า "ทำความสะอาดง่าย" ในชื่อเครื่องปั่นต้องไม่ลากไปหมวดน้ำยาทำความสะอาด
  // และน้ำยาล้างจานที่มีคำว่า "กระทะ" ต้องยังอยู่หมวดตัวเอง — ตัวนับคะแนนต้องแยกออก
  assert.match(demoActionFor('น้ำยาล้างจาน ขจัดคราบมัน กระทะ')!.scene, /kitchen sink/i);
});

check('สบู่และของทำฟองต้องได้ช็อตถูฟอง ไม่ใช่ถือกล่องโยก (job_153)', () => {
  // 🐛 job_153: คำว่า "สบู่" ไม่อยู่ในหมวดไหนเลย → hero ทั้งสองคลิป และคลิป 2 กลายเป็น
  // "กล่องโยก 8 องศา" ซึ่งคือท่าที่เจ้าของบ่นตั้งแต่ job_123/124
  // ที่เจ็บกว่าคือบทพากย์เขียนว่า "เพียงถูสบู่จนเกิดฟองแล้วลูบไล้" = เสียงบรรยายท่าที่ภาพไม่มี
  for (const title of ['สบู่เฟย์ด้า FayDa planktonsoap สบู่รักษาสิว 50 กรัม', 'โฟมล้างหน้า สูตรอ่อนโยน', 'แชมพูสมุนไพร']) {
    const d = demoActionFor(title);
    assert.ok(d, `${title}: ต้องเข้าหมวดทำฟอง`);
    assert.match(d!.result, /lather/i, `${title}: ผลลัพธ์ต้องคือฟอง`);
    assert.equal(d!.hands, 2, 'ถูสบู่ให้เกิดฟองใช้สองมือจริง ห้ามประกาศ 1 เพราะอยากให้เป็น 1');
  }
  // ครีม/โทนเนอร์ยังต้องอยู่หมวดเดิม (ทาลงแขน) ไม่ถูกหมวดสบู่กลืน
  assert.match(demoActionFor('โทนเนอร์เช็ดรักแร้ Iblanc')!.action, /inner forearm/i);
});

check('จุดตัดเสียงต้องไม่ทำให้สองครึ่งเร็วไม่เท่ากัน (job_154 "เสียงแปลกๆ")', () => {
  // 🐛 job_154: เสียงพูดรวม 14.2s จุดตามสัดส่วนอยู่ที่ 7.14s แต่มีช่วงเงียบจริงที่ 6.2s
  // อยู่ในระยะ snap 1.2s ตัวเลือกเดิมดูแค่ "ใกล้ที่สุด" เลยเลือก 6.2
  // → คลิป 1 เหลือเสียง 6.2s ต้องยืดเป็น 8s = tempo 0.79 ต่ำกว่าเพดานล่าง 0.82 จึงถูก clamp
  //   เสียงครึ่งแรกช้าลง 18% ส่วนคลิป 2 ถูกเร่ง 3% → ต่างกัน 21% คร่อมรอยต่อวินาทีที่ 8
  const ttsSource = readBackendSource('gemini', 'tts-generator.ts');
  assert.match(ttsSource, /function fitsNaturalTempo\(/);
  // ต้องเช็ค "ทั้งสองฝั่ง" ของจุดตัด ไม่ใช่ฝั่งเดียว
  assert.match(ttsSource, /if \(!fitsNaturalTempo\(mid - previousBound, secondsPerClip, false\)\) continue;/);
  assert.match(
    ttsSource,
    /if \(!fitsNaturalTempo\(speechDuration - mid, secondsPerClip, index === clipCount - 2\)\) continue;/
  );
  // ⚠️ เพดานความเร็วต้องเป็นตัวเดียวกับที่ clipTempoFilter ใช้จริง แยกค่าคือเช็คแล้วไม่ตรงกับผล
  assert.match(ttsSource, /chunkSpeechSeconds >= preferred \* MINIMUM_NATURAL_TEMPO/);
  assert.match(ttsSource, /chunkSpeechSeconds <= maxSpeech \* MAXIMUM_NATURAL_TEMPO/);
  // snap ยังต้องทำงานอยู่ ไม่ใช่ปิดทิ้งไปเลย — มันมีไว้กันตัดกลางคำ (เหตุผลเดิมยังถูก)
  assert.match(ttsSource, /CLIP_SPLIT_SNAP_WINDOW_SECONDS/);
  assert.match(ttsSource, /let chosen = proportional;/, 'ตกลงกันไม่ได้ต้องถอยไปใช้จุดตามสัดส่วน');
});

check('หมวดต้องครอบสินค้าจริงในฐานข้อมูล ไม่ใช่เฉพาะที่บังเอิญเจอ', () => {
  // 📊 สแกนฐาน 1 ส.ค. 2026: 50 รายการ ครอบคลุมแค่ 24% — สินค้าตกหมวดแล้วได้ท่ากลางๆ
  // ที่ภาพทำตามไม่ได้ (job_153 สบู่ / job_154 เครื่องปั่น) จึงไล่เพิ่มจากของจริงในฐาน
  // ก้อนใหญ่สุดคืออาหารเสริมแบบเม็ด 20 รายการ = 40% ของทั้งฐาน
  const shouldHaveShot: Array<[string, RegExp]> = [
    ['บีแอลบียู BLB U สูตรใหม่ อาหารเสริมสมุนไพร 13 ชนิด 1 กระปุกมี 30 เม็ด', /table beside a glass of water/i],
    ['ฝีคัณฑสูตร ฝีอักเสบ ดูแลด้วย Balance UCore', /table beside a glass of water/i],
    ['หูฟังบลูทูธไร้สาย TWS Pro5 กันน้ำ IPX5', /desk/i],
    ['กระติกน้ำสแตนเลสเกรด316 ขวดน้ำ 1.3L เก็บความเย็น', /jug of iced water/i],
    ['TOTORI หมอน รุ่น คลาวด์ หมอนหนุน', /bed/i],
    ['8นิ้ว พัดลมไร้สาย 12000mAh ตั้ง & หนีบ', /desk corner/i],
    ['ไฟน์ไลน์ซักผ้า กลิ่นซันนี่โกลด์ 1250 มล.', /washing machine/i],
    ['เสื้อยืดโอเวอร์ไซส์สีขาว', /bedroom surface/i],
    ['ไม้แขวนเสื้อ ไม้แขวนสแตนเลส เคลือบซีลีโคนกันลื่น', /wardrobe rail/i],
  ];
  for (const [title, scene] of shouldHaveShot) {
    const d = demoActionFor(title);
    assert.ok(d, `${title.slice(0, 34)}: ต้องมีท่าใช้งาน ไม่ใช่ปล่อยตกหมวด`);
    assert.match(d!.scene, scene, `${title.slice(0, 34)}: ฉากผิด — ได้ "${d!.scene}"`);
    assert.equal(d!.action.split('.').filter((s) => s.trim()).length, 1, `${title.slice(0, 34)}: ท่าต้องจังหวะเดียว`);
    assert.ok(d!.hands === 1 || d!.hands === 2, `${title.slice(0, 34)}: ต้องประกาศจำนวนมือ`);
  }

  // ⚠️ หมวก/แว่นตา จงใจไม่เอาเข้า — ท่าใช้งานคือสวมบนหัว ซึ่งต้องวาดใบหน้า
  // ผิดกฎ "เห็นแค่มือ" ที่เจ้าของสั่งไว้ หน้าวาดพลาด = คลิปใช้ไม่ได้เลย
  for (const title of ['George Russell Mercedes F1 - Team Cap 63', 'แว่นตากรอบเหลี่ยมสีดำ ขาแว่นผสมโลหะ']) {
    assert.equal(demoActionFor(title), null, `${title.slice(0, 30)}: ต้องคงช็อต hero เพราะท่าใช้งานต้องมีใบหน้า`);
  }

  // เคสเฉียงที่ตัวนับคะแนนต้องแยกออก — ทั้งคู่มีคำว่า "เสื้อ" หรือ "ผ้า" ปนกัน
  assert.match(demoActionFor('ไม้แขวนเสื้อ ไม้แขวนสแตนเลส')!.scene, /wardrobe rail/i, 'ไม้แขวนต้องไม่กลายเป็นเสื้อผ้า');
  // ผ้ารองรีดย้ายออกจากหมวดของนุ่มไปโต๊ะรีดผ้าแล้ว (job_155) — ที่ต้องกันคือไม่ให้ไปเป็นเสื้อผ้า
  assert.match(demoActionFor('ผ้ารองรีด เสริมฟองน้ำ')!.scene, /ironing board/i, 'ผ้ารองรีดต้องอยู่บนโต๊ะรีดผ้า');
  assert.match(demoActionFor('แพมเพิส Penbose ผ้าอ้อมเด็ก')!.scene, /home shelf/i, 'ผ้าอ้อมต้องยังเป็นหมวดแกะซอง');
});

check('ห้ามเติมประโยคสำรองตั้งแต่รอบแรก — ต้องให้ Gemini เขียนใหม่ก่อน', () => {
  // 🐛 ต้นตอของบทกลวงที่ไล่มาทั้งวัน (job_146 / job_154 ได้ประโยคสำรอง 100%)
  // ตัวเติมเคยทำงานตั้งแต่รอบแรกเสมอ → บทจริงที่ดีแต่สั้นไปนิด (เช่น 61 ตัว) ถูกบวก
  // ประโยคสำรอง 44 ตัวจนครบ 105 แล้วผ่านด่านทันที = Gemini ไม่เคยถูกขอให้เขียนใหม่เลย
  // ทั้งที่ retry มีอยู่แล้วและได้บทจริงทุกครั้งที่ได้ทำงาน
  // (42% ของบทเป็นคำกลวง ต่ำกว่าเกณฑ์เตือน 50% พอดี จึงไม่มีสัญญาณอะไรเลย)
  const real = 'ทิชชู่สี่ชั้นซับน้ำได้ดีเยี่ยม เหนียวนุ่มไม่ขาดง่าย ราคาคุ้มมาก';
  const segments = [
    { text: real, startSec: 0, endSec: 8 },
    { text: real, startSec: 8, endSec: 16 },
  ];
  const padded = normalizeClipAlignedNarration(real + ' ' + real, segments, 2, 8, true);
  const unpadded = normalizeClipAlignedNarration(real + ' ' + real, segments, 2, 8, false);

  assert.ok(
    spokenLength(unpadded.subtitleSegments[0].text) < MIN_NARRATION_CHARS_PER_CLIP,
    'รอบที่ยังลองใหม่ได้ ต้องปล่อยให้บทสั้นแล้วตกด่าน ไม่ใช่เติมให้ผ่าน'
  );
  assert.equal(unpadded.subtitleSegments[0].text, real, 'ห้ามแตะบทจริงเลยเมื่อยังไม่ถึงรอบสุดท้าย');
  assert.ok(
    spokenLength(padded.subtitleSegments[0].text) >= MIN_NARRATION_CHARS_PER_CLIP,
    'รอบสุดท้ายยังต้องเติมให้ผ่าน ไม่งั้นงานตายทั้งใบ'
  );
  assert.notEqual(padded.subtitleSegments[0].text, unpadded.subtitleSegments[0].text);

  // ⚠️ ค่าเริ่มต้นต้องเป็น "เติม" เพราะผู้เรียกนอกลูป retry (job-finalize) ไม่มีรอบให้ลองใหม่
  const byDefault = normalizeClipAlignedNarration(real + ' ' + real, segments, 2, 8);
  assert.equal(byDefault.subtitleSegments[0].text, padded.subtitleSegments[0].text);

  // ทั้งสองเส้นทางใน prompt-generator ต้องส่งรอบปัจจุบันเข้าไป ลืมเส้นใดเส้นหนึ่ง = บั๊กกลับมาครึ่งหนึ่ง
  const promptSource = readPromptLayer();
  const wired = promptSource.match(/complianceAttempt >= MAX_COMPLIANCE_RETRIES\s*\n\s*\);/g) || [];
  assert.equal(wired.length, 2, `ต้องส่งรอบปัจจุบันเข้า normalizeClipAlignedNarration ทั้งสองเส้นทาง (เจอ ${wired.length})`);
});

check('บทจริงต้องถูกซ่อม ไม่ใช่ทิ้งทั้งประโยคแล้วใช้คำกลวงแทน (job_155)', () => {
  // 🐛 job_155 (ผ้ารองรีด) และหลายงานก่อนหน้า: บทจริง 91 ตัวที่พูดถึงสินค้าครบถ้วน
  // ถูกทิ้งทั้งประโยคแล้วแทนด้วยประโยคสำรอง เพียงเพราะลงท้ายด้วยคำเชื่อม "ที่"
  // ทั้งสามเส้นทางของ fitCompleteNarration เคยคืนประโยคสำรองแบบเหมารวมโดยไม่ซ่อมก่อน
  // ทั้งที่มี trimToCompleteThaiEnding() ตัดกลับไปหาคำลงท้ายจริงอยู่แล้ว แต่ไม่เคยถูกเรียก
  const real = 'ผ้ารองรีดเคลือบสารสะท้อนความร้อน เสริมฟองน้ำหนานุ่ม ช่วยให้รีดผ้าเรียบไวขึ้นมากค่ะ';
  const cases = [
    `${real} เป็นรุ่นที่`,          // ลงท้ายคำเชื่อม
    `${real} และ`,                   // ลงท้ายคำเชื่ออีกแบบ
    `${real} ${real} ${real}`,       // ยาวเกินเพดาน
  ];
  for (const text of cases) {
    const out = fitCompleteNarration(text, 0);
    assert.ok(
      safeFillerRatio(out) < SAFE_FILLER_ALERT_RATIO,
      `บทจริงถูกทิ้งทั้งประโยค: "${text.slice(0, 30)}" → "${out.slice(0, 40)}"`
    );
    assert.doesNotMatch(out, /(?:จะได้|กำลัง|เพราะ|และ|ที่)$/, 'ซ่อมแล้วต้องไม่เหลือหางลอย');
  }

  // ⚠️ เกณฑ์ความยาวที่ยอมเก็บของจริงต้อง "ต่ำกว่า" เกณฑ์บทขั้นต่ำ
  // ครั้งแรกที่แก้ผมใส่ >= 88 ตามเกณฑ์บท ผลคือบทจริงที่ตัดแล้วเหลือ 80 ตัวถูกปฏิเสธ
  // แล้วไปใช้คำกลวง 105 ตัวแทน = ยังกลวง 100% เหมือนเดิม
  const rulesSource = readNarrationLayer();
  assert.match(rulesSource, /const MINIMUM_SALVAGEABLE_CHARS = (\d+)/);
  const floor = Number(/const MINIMUM_SALVAGEABLE_CHARS = (\d+)/.exec(rulesSource)![1]);
  assert.ok(floor < MIN_NARRATION_CHARS_PER_CLIP, `เกณฑ์ซ่อม ${floor} ต้องต่ำกว่าเกณฑ์บท ${MIN_NARRATION_CHARS_PER_CLIP}`);
  assert.match(rulesSource, /function salvageOrFallback/);

  // ของที่สั้นจนไม่เหลืออะไรใช้ได้ ยังต้องยอมใช้ประโยคสำรอง ไม่ใช่ปล่อยเศษบทออกไป
  assert.ok(safeFillerRatio(fitCompleteNarration('ดีมาก แต่', 0)) > 0.9, 'เศษบทสั้นมากต้องใช้ประโยคสำรอง');
});

check('รูปต้นทางกลับหัวต้องถูกหมุนก่อนใช้ ไม่ใช่ปล่อยให้คลิปกลับหัวทั้งเรื่อง (job_155)', () => {
  // 🐛 job_155 (ผ้ารองรีด Yanuo Xuan): รูปรีวิวถ่ายมากลับหัว ทุกขั้นทำตามอย่างซื่อสัตย์
  // "IRONING BOARD COVER" กลับหัวตลอด 16 วินาที = คลิปใช้ขายไม่ได้เลย
  // ไม่มีด่านไหนจับได้ เพราะทุกด่านถามว่า "ตรงรูปต้นฉบับไหม" ซึ่งตรงเป๊ะ
  // job #122 เคยเจอแล้วครั้งหนึ่ง แก้ด้วยการเติมคำสั่งในพรอมต์ ซึ่งพิสูจน์แล้วว่าไม่พอ
  const mediaSource = readBackendSource('utils', 'media.ts');
  assert.match(mediaSource, /export async function rotateImageUpright/);
  // ต้องหมุนพิกเซลจริง ไม่ใช่แค่ขอให้โมเดลช่วยหมุน
  assert.match(mediaSource, /transpose=1,transpose=1/, '180° ต้องหมุนด้วย ffmpeg จริง');
  assert.match(mediaSource, /fs\.renameSync\(rotated, filePath\)/, 'ต้องเขียนทับไฟล์เดิม');

  // Gemini ต้องถูกถามว่าต้องหมุนกี่องศา และค่าต้องถูกเก็บไว้ ไม่ถูกทับทิ้ง
  const promptSource = readPromptLayer();
  assert.match(promptSource, /uprightRotationDegrees/);
  assert.match(promptSource, /\[0, 90, 180, 270\]\.includes\(rotation\) \? rotation : 0/, 'ค่ามั่วต้องกลายเป็น 0');

  // ต้องหมุน "ก่อน" ทุกอย่างที่ตามมา ไม่งั้นส่วนผสมกับด่านเทียบจะเห็นรูปคนละทิศกับเฟรมตั้งต้น
  const apiSource = readBackendSource('extension');
  assert.match(apiSource, /await rotateImageUpright\(selectedPaths\[0\], uprightRotation\)/);
});

check('ตัวจับบทจบห้วนต้องใช้วิธีบวก ไม่ใช่บัญชีดำคำ (job_155)', () => {
  // 🐛 job_155: บทที่ออกอากาศจบด้วย "...ช่วยให้รีดผ้าได้ลื่นไหลไม่มี" ค้างกลางวลีชัดเจน
  // แต่ "ไม่มี" ไม่อยู่ในบัญชีดำจึงผ่านไปได้ — เหมือน job_102 ที่ "ใช้" ก็ไม่อยู่ในลิสต์
  // บัญชีดำต้องรู้จักคำผิดทุกคำถึงจะจับได้ ส่วนวิธีบวกรู้แค่คำที่ถูก ซึ่งมีไม่กี่คำและคงที่
  assert.equal(endsWithCompleteThaiPhrase('ช่วยให้รีดผ้าได้ลื่นไหลไม่มี'), false, 'job_155: ต้องจับได้');
  assert.equal(endsWithCompleteThaiPhrase('ตัวนี้ดีมากเลยค่ะ'), true);
  assert.equal(endsWithCompleteThaiPhrase('ราคาคุ้มมากนะคะ'), true);
  assert.equal(endsWithCompleteThaiPhrase('เหมาะกับคนที่'), false);

  const bad = 'ตัวผ้าทำจากคอตตอนแท้ร้อยเปอร์เซ็นต์ ด้านในเสริมฟองน้ำหนานุ่ม กดแล้วคืนตัวได้ดีค่ะ ช่วยให้รีดผ้าได้ลื่นไหลไม่มี';
  const fixed = fitCompleteNarration(bad, 1);
  assert.doesNotMatch(fixed, /ไม่มี$/, 'หางลอยต้องถูกตัดทิ้ง');
  assert.ok(endsWithCompleteThaiPhrase(fixed), 'ผลลัพธ์ต้องจบสมบูรณ์');
  assert.ok(safeFillerRatio(fixed) < SAFE_FILLER_ALERT_RATIO, 'ต้องเก็บบทจริงไว้ ไม่ใช่แทนด้วยคำกลวง');

  // ⚠️ คำสั่งอนุญาตให้บทไม่มีคำลงท้ายก็ได้ — ห้ามเหมาว่า "ไม่มี ค่ะ = ใช้ไม่ได้"
  // ไม่งั้นบทจริงที่ถูกต้องจะโดนทิ้งเป็นคำกลวง ซึ่งคือความผิดพลาดเดิมแค่กลับด้าน
  const noParticle = 'ผ้ารองรีดเคลือบสารสะท้อนความร้อน เสริมฟองน้ำหนานุ่ม รีดผ้าได้ลื่นไหลมาก';
  assert.equal(fitCompleteNarration(noParticle, 0), noParticle, 'บทไม่มีคำลงท้ายต้องไม่ถูกทิ้ง');
});

check('ผ้ารองรีดต้องอยู่บนโต๊ะรีดผ้า ไม่ใช่บนเตียง (job_155)', () => {
  // 🐛 job_155: ผมเหมา `ผ้ารองรีด` เข้าหมวดหมอนเพราะเป็นของนุ่มเหมือนกัน
  // ผลคือมันไปวางบนเตียงแล้วถูกกดเหมือนหมอน ทั้งที่ชื่อสินค้าเขียนว่า "สำหรับโต๊ะรีดผ้า"
  // เกณฑ์คือ "ใช้ที่ไหน" ไม่ใช่ "ทำจากอะไร"
  const cover = demoActionFor('จัดส่งฟรี ผ้ารองรีด แบบเคลือบสารสะท้อนความร้อน เสริมฟองน้ำ สำหรับโต๊ะรีดผ้า')!;
  assert.match(cover.scene, /ironing board/i, 'ผ้ารองรีดต้องอยู่บนโต๊ะรีดผ้า');
  assert.match(cover.action, /iron glides/i, 'ท่าต้องคือรีดแล้วผ้าเรียบ');
  assert.ok(cover.prop, 'เตารีดกับเสื้อเป็นของใหม่ในเฟรม ต้องประกาศเป็น prop');
  // หมอนกับผ้าห่มยังต้องอยู่บนเตียงเหมือนเดิม
  assert.match(demoActionFor('TOTORI หมอน รุ่น คลาวด์')!.scene, /bed/i);
  assert.match(demoActionFor('ผ้าห่มนวมขนแกะ')!.scene, /bed/i);
});

check('รูปตั้งต้นต้องไม่ซ้ำรูปเดิมทุกงานของสินค้าตัวเดียวกัน (3 ส.ค. 2026)', () => {
  // 🐛 เจ้าของทักว่า "รูปที่สุ่มออกมามีแต่รูปเดิมๆ ตลอดเลย" — ตรวจประวัติแล้วจริงตามนั้น
  // โลชั่น Oriental Princess ถูกทำ 5 งาน (72/107/123/140/156) ได้ review_candidate_6 ทั้งห้าครั้ง
  //
  // ต้นเหตุไม่ได้อยู่ที่ "Gemini เลือกซ้ำ" แต่อยู่ที่เราหยิบผู้สมัคร "8 ใบแรก" ชุดเดิมเสมอ
  // สินค้าที่มีสื่อ 175 ชิ้นจึงถูกมองแค่ 8 ชิ้นตลอดชีวิต คำถามเดิม+ข้อมูลเดิม = คำตอบเดิม
  const media = Array.from({ length: 20 }, (_, index) => ({ url: `https://img/${index}.jpg` }));

  const first = freshCandidateWindow(media, new Set());
  assert.equal(first.length, 8, 'งานแรกเสนอ 8 ใบแรกตามเดิม');
  assert.equal(first[0].url, 'https://img/0.jpg');

  // งานถัดไปต้องไม่เห็นรูปที่เคยใช้ไปแล้วเลย
  const used = new Set(['https://img/0.jpg', 'https://img/3.jpg', 'https://img/5.jpg']);
  const second = freshCandidateWindow(media, used);
  assert.equal(second.length, 8, 'ยังต้องได้ผู้สมัครครบ 8 ใบ');
  assert.ok(second.every((image) => !used.has(image.url)), 'ห้ามเสนอรูปที่เคยใช้ไปแล้ว');

  // ⚠️ ห้ามให้ "ความหลากหลาย" ทำให้ได้รูปน้อยจนเลือกไม่ได้ หรือได้รูปแย่กว่าเดิม
  // รูปที่ดีที่สุดมันดีด้วยเหตุผลของมัน ถ้ารูปใหม่เหลือน้อยเกินไปให้ถอยไปใช้ทั้งกอง
  const almostAllUsed = new Set(media.slice(0, 18).map((image) => image.url));
  const fallback = freshCandidateWindow(media, almostAllUsed);
  assert.equal(fallback.length, 8, 'เหลือรูปใหม่ไม่พอ ต้องถอยไปใช้ทั้งกอง ไม่ใช่คืนแค่ 2 ใบ');
  assert.equal(fallback[0].url, 'https://img/0.jpg', 'ถอยแล้วต้องกลับไปเป็นชุดเดิม');
});

check('ท่าสาธิตต้องเป็นไปได้จริงจากเฟรมที่มีอยู่ (job_158/job_160)', () => {
  // 🐛 สองงานล้มด้วยเหตุผลเดียวกัน: ท่าสั่งสิ่งที่ทำไม่ได้จากเฟรมตั้งต้น โมเดลจึงแก้ทางตัน
  // ด้วยการเสกหรือลบของกลางคลิป ซึ่งคนดูอ่านว่า "สินค้าคนละตัว"
  //
  //   job_158 หูฟัง: สั่ง "เผยหูฟังทั้งสองข้าง" ทั้งที่เฟรมมีข้างเดียว → เสกเป็น AirPods
  //   job_160 กระติก: สั่ง "เทน้ำใส่จนเต็ม" ทั้งที่ฝายังปิด → ลบฝาทิ้งกลางคลิป
  const bottle = demoActionFor('กระติกน้ำสแตนเลสเกรด316 ขวดน้ำ 1.3L เก็บความเย็น')!;
  const earbud = demoActionFor('หูฟังบลูทูธไร้สาย หูฟังไร้สายพร้อมไมโครโฟน')!;

  // ⚠️ ห้ามสั่งเทของเหลวใส่ภาชนะที่ยังไม่ได้เปิด — ฝาจะหายเองแบบเทเลพอร์ต
  assert.doesNotMatch(bottle.action, /pours? into|fill/i, 'ห้ามเทน้ำใส่ก่อนที่ฝาจะเปิด');
  // ⚠️ กระติกสแตนเลสทึบ ผลลัพธ์ที่มองไม่เห็นเท่ากับไม่มีผลลัพธ์
  assert.doesNotMatch(bottle.result, /until it is full|stays completely dry/i, 'ผลต้องมองเห็นได้');
  assert.match(bottle.result, /visible|open/i, 'ผลของกระติกต้องเป็นสิ่งที่เห็นได้จริง');

  // ⚠️ ห้ามสั่ง "เผย" ของที่เฟรมตั้งต้นไม่เคยมี — เฟรมที่ผ่านด่านมีหูฟังข้างเดียว
  assert.doesNotMatch(earbud.action, /both earbuds/i, 'ห้ามสั่งเผยหูฟังข้างที่ไม่มีในเฟรม');
  assert.match(earbud.action, /rises out of its cradle/i, 'ต้องหยิบของที่มีอยู่แล้วออกมาแทน');
  assert.equal(earbud.hands, 2, 'ถือเคส 1 มือ หยิบหูฟัง 1 มือ = สองมือจริง');

  // ทุกท่ายังต้องเป็นจังหวะเดียวเหมือนเดิม — ห้ามแก้บั๊กนี้ด้วยการยัดสองจังหวะเข้าไป
  for (const demo of [bottle, earbud]) {
    assert.equal(demo.action.split('.').filter((part) => part.trim()).length, 1, 'ท่าต้องเป็นประโยคเดียว');
  }
});

check('ฉลากภาษาไทยต้องยังเป็นภาษาไทย (job_163)', () => {
  // 🐛 job_163 (ทิชชู่ BOTARE): บรรทัด `โบทาเร่ กระดาษเนื้อนุ่มหลายชั้น` กลายเป็น
  // `โบพาเว่ กระจานเพื่อชุ่นลลัดคุขั้บ` ตั้งแต่ขั้นเจนรูป แล้ว Veo ลากต่อจนเป็น
  // `美享會全國導·八章·詩0年紀氣中泣` = ตัวจีนล้วน
  //
  // ไม่มีพรอมต์ไหนในระบบเคยบอกเลยว่าตัวหนังสือบนฉลากเป็นภาษาอะไร ทั้งที่สินค้าทุกตัว
  // ขายตลาดไทย — ฉลากที่อ่านเป็นภาษาอื่นคือคลิปที่ใช้ขายไม่ได้ ไม่ว่าจะเรนเดอร์คมแค่ไหน
  const imagePlan = readBackendSource('extension', 'reference-image-plan.ts');
  assert.match(imagePlan, /Thai text on the label stays Thai script/,
    'ขั้นเจนรูปต้องบอกว่าฉลากเป็นภาษาไทย');

  const locked = applyProductIdentityLock(['A hand holds the pack.', 'A hand holds the pack.']);
  assert.match(locked[0], /Thai text on the label stays Thai script/,
    'ล็อกวิดีโอต้องกันการเปลี่ยนภาษาด้วย');
  assert.match(buildFlowContinuationPrompt(locked[0]), /Thai text stays Thai script/,
    'คลิปต่อเนื่องก็ต้องกัน — job_124 เคยพังเพราะล็อกฉลากหายไปกับพรอมต์ที่ถูกย่อ');

  // ⚠️ ด่านเทียบสินค้าเคยถูกสั่งเองว่า "imperfect Thai characters" ให้ตอบผ่าน
  // ซึ่งทำให้ job_163 ได้ pass=true score=85 differences=[] ทั้งที่ฉลากผิดทั้งบรรทัด
  const fidelity = readBackendSource('gemini', 'fidelity-check.ts');
  assert.doesNotMatch(fidelity, /has imperfect Thai characters/,
    'ห้ามกลับไปสั่งผู้ตรวจให้ยกโทษให้ตัวอักษรไทยที่ผิด');
  assert.match(fidelity, /replaced by another script/,
    'ผู้ตรวจต้องแยก "เรนเดอร์เบลอ" ออกจาก "เปลี่ยนภาษา"');
  // สัญญาณต้องดังออกมาทุกครั้ง แม้โหมดนั้นจะยังไม่บล็อก — จะได้วัดได้ว่าเกิดบ่อยแค่ไหน
  assert.match(fidelity, /ตัวหนังสือบนฉลากถูกเขียนใหม่/, 'ต้อง log เตือนเสมอเมื่อ visibleText ตก');
});

check('ของที่หยิบออกมาต้องถูกถือค้างไว้ ไม่ใช่แค่อยู่ในเฟรม (job_164)', () => {
  // 🐛 job_164 (แพมเพิส Penbose): จังหวะแกะซองออกมาครบสวย แต่วินาทีที่ 3 ผ้าอ้อมที่กางอยู่
  // ในมือร่วงลงชั้น กลายเป็นก้อนพับคนละทรง และมือที่ถือมันหายไปจากเฟรม
  // เจ้าของทักว่า "อยู่ดีดีผ้าอ้อมวาร์ปหายไป"
  //
  // คำว่า `both clearly in frame` ขอแค่ให้อยู่ในเฟรม ซึ่ง "วางลงบนชั้น" ก็ยังอยู่ครบ
  // โมเดลเลือกทางที่ถูกที่สุดเสมอ แล้วพอเรนเดอร์ของที่วางอยู่ใหม่ ทรงก็เปลี่ยนตาม
  //
  // หมวดทิชชู่ใช้ `stands clear of the pack` มาตั้งแต่ต้นและผ่านใน #157 — ความต่างอยู่ตรงนี้
  const pulled = ['แพมเพิส Penbose 50ชิ้น ผ้าอ้อมเด็ก', 'ขนมแคบหมู อบกรอบ ซองใหญ่', 'ทิชชู่ Botare 4 ชั้น'];
  for (const title of pulled) {
    const demo = demoActionFor(title)!;
    assert.ok(demo, `${title}: ต้องมีท่าใช้งาน`);
    assert.doesNotMatch(
      demo.action,
      /both clearly in frame/,
      `${title}: "อยู่ในเฟรม" อ่อนเกินไป โมเดลจะวางของลงแล้วเอามือออก`
    );
    assert.match(demo.action, /stands clear of/, `${title}: ต้องบังคับให้ยกค้างพ้นซอง`);
  }

  // ⚠️ สองหมวดที่แก้เพราะ job_164 ต้องบอกด้วยว่ายังอยู่ในมือเดิมและทรงเดิม
  // ยกค้างแต่เปลี่ยนทรงก็ยังเป็นอาการ "วาร์ป" อยู่ดี
  for (const title of ['แพมเพิส Penbose 50ชิ้น ผ้าอ้อมเด็ก', 'ขนมแคบหมู อบกรอบ ซองใหญ่']) {
    const demo = demoActionFor(title)!;
    assert.match(demo.action, /still held in that same hand/, `${title}: ต้องยังอยู่ในมือเดิม`);
    assert.match(demo.action, /keeping the exact shape/, `${title}: ทรงต้องไม่เปลี่ยนตอนยกค้าง`);
  }
});

check('พรอมต์ต้องบอกความยาวบทเข้มเท่ากันทั้งสองด้าน (job_166/job_167)', () => {
  // 🐛 3 ส.ค. 2026: ตกขอบล่าง 17 ครั้งจาก 9 งาน แล้ว #166 กับ #167 ล้มทั้งงาน
  // เพราะลองใหม่ครบรอบแล้วบทยังสั้นอยู่
  //
  // ต้นเหตุคือความไม่สมมาตร: ขอบบนเขียนว่า "ห้ามเกินเด็ดขาด" ส่วนขอบล่างใช้คำว่า "ประมาณ"
  // และอยู่คนละบรรทัดกัน โมเดลจึงเขียนเผื่อสั้นไว้ก่อนเพื่อไม่ให้ผิดข้อที่เข้มกว่า
  // ช่องที่ยอมรับได้กว้างแค่ 20 ตัวอักษร (88-108) การเอนไปทางสั้นจึงตกทันที
  const prompt = readBackendSource('gemini', 'planner-prompt.ts');
  assert.doesNotMatch(
    prompt,
    /ออกเสียงประมาณ \$\{MIN_NARRATION_CHARS_PER_CLIP\}/,
    'ห้ามกลับไปบอกขอบล่างว่า "ประมาณ" ขณะที่ขอบบนห้ามเด็ดขาด'
  );
  assert.match(prompt, /ไม่ต่ำกว่า \$\{MIN_NARRATION_CHARS_PER_CLIP\} ตัว/, 'ขอบล่างต้องเป็นคำสั่งเข้ม');
  assert.match(prompt, /ให้เล็งไว้ที่ราว/, 'ต้องให้เป้าหมายตรงกลาง ไม่ใช่แค่ช่วง');
  // กฎซับไตเติ้ลก็ต้องมีขอบล่าง ไม่ใช่บอกแต่เพดาน
  assert.match(
    prompt,
    /แต่ละช่วงยาว \$\{MIN_NARRATION_CHARS_PER_CLIP\}-\$\{MAX_SUB_CHARS\} ตัวอักษร/,
    'กฎซับไตเติ้ลต้องบอกทั้งขอบล่างและขอบบน'
  );
  // ⚠️ เคยเขียน assert.doesNotMatch(/ห้ามเกินเด็ดขาด/) ไว้ตรงนี้ แล้วมันไปสะดุดคอมเมนต์
  // ที่อ้างถ้อยคำเก่ามาอธิบายบั๊ก — ตัวจับที่กวาดทั้งไฟล์แยกคำสั่งจริงกับคำที่ยกมาเล่าไม่ออก
  // สี่ข้อบนครอบเจตนาครบแล้ว: ขอบล่างต้องเข้ม มีเป้าหมายตรงกลาง และซับไตเติ้ลมีสองขอบ
});

check('ทรงที่เปลี่ยนเพราะมือที่เราสั่งให้เติม ต้องไม่ถูกนับเป็นสินค้าคนละตัว (job_171)', () => {
  // 🐛 job_171 (ผ้ารองรีด Yanuo Xuan): ด่านตีตกที่ 65/100 ด้วยเหตุผลว่า
  // "ปลายโต๊ะเปลี่ยนจากโค้งมนเป็นเหลี่ยมตัดตรง" — แต่ที่จริงคือ **มือกำลังดึงผ้าขึ้นตรงนั้น**
  // โต๊ะ ผ้า เตารีด พื้น เหมือนกันทุกอย่าง เจ้าของดูแล้วถามว่า "มันไม่เหมือนยังไง"
  //
  // ช่องโหว่แคบกว่าที่เห็น: พรอมต์สั่ง `Ignore the new hand` ซึ่งบอกให้มองข้าม
  // "การมีมือ" แต่ไม่ได้บอกให้มองข้าม "สิ่งที่มือทำกับผ้า" — และมือนั้นเราสั่งให้เติมเอง
  // ผลคือด่านลงโทษภาพเพราะทำตามคำสั่งของเราเอง
  const fidelity = readBackendSource('gemini', 'fidelity-check.ts');
  assert.match(
    fidelity,
    /Where that hand grips, lifts, pulls or pinches a soft product/,
    'ต้องบอกด่านว่าทรงที่เปลี่ยนตรงจุดที่มือจับ เกิดจากคำสั่งของเราเอง'
  );
  assert.match(fidelity, /Judge the outline away from the hand/, 'ให้ตัดสินทรงจากส่วนที่มือไม่ได้แตะ');
  // ⚠️ ผ้าคลุมที่ขึงบนโครงไม่เคยอยู่ในลิสต์ของนุ่ม ทั้งที่นุ่มเต็มตัว
  assert.match(fidelity, /fitted covers stretched over a frame/, 'ผ้าคลุมขึงโครงต้องนับเป็นของนุ่ม');
  // ⚠️ ไม่ได้ลดเกณฑ์ — สิ่งที่แปลว่า "สินค้าคนละตัว" ยังต้องตกเหมือนเดิม
  assert.match(fidelity, /Fail if any of these changed or were invented/, 'เกณฑ์หลักต้องอยู่ครบ');
  assert.match(fidelity, /product category or type/, 'หมวดสินค้ายังเป็นตัวตัดสิน');
});

check('กล้องเข้าใกล้ต้องทำให้ทั้งฉากโตพร้อมกัน ไม่ใช่สินค้าพองเดี่ยว (job_172)', () => {
  // 🐛 job_172: เทียบเฟรม 0 วิ กับ 7 วิ — ขวดโตขึ้นเกือบเท่าตัว แต่ก๊อกน้ำ ผ้าเช็ดตัว
  // และขอบเคาน์เตอร์ขนาดเท่าเดิม มือดูเล็กลงเมื่อเทียบกับขวด = ขวดพองขึ้นเอง
  // เจ้าของดูแล้วบอกว่า "ยังมีความแปลกอยู่นิดหน่อย" ซึ่งคือตัวนี้
  //
  // คำว่า `the product itself stays completely still` ที่กันสินค้าหมุน (job_157)
  // ถูกอ่านว่า "ฉากนิ่ง แล้วขยายสินค้าแทน" — ไม่เคยมีใครบอกว่าทั้งเฟรมต้องโตพร้อมกัน
  const locked = applyProductIdentityLock(['A hand holds the bottle.', 'A hand holds the bottle.']);
  assert.match(
    locked[0],
    /The whole scene scales together as the camera nears/,
    'ต้องบอกว่าเข้าใกล้แล้วทั้งฉากโตพร้อมกัน'
  );
  assert.match(locked[0], /never swells while the room stays the same size/, 'ห้ามสินค้าพองเดี่ยว');
  // ⚠️ ห้ามแก้อาการนี้ด้วยการถอนประโยคห้ามหมุน — มันคือตัวที่ทำให้ #160/#161/#164 ไม่เพี้ยน
  assert.match(
    locked[0],
    /never turns, tilts or changes which face points at the camera/,
    'ประโยคห้ามหมุนต้องยังอยู่ครบ'
  );
});
