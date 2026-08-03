import { logger } from '../utils/logger.js';

// barrel: ผู้เรียกเดิม import จากไฟล์นี้ได้เหมือนเดิมแม้ตารางย้ายไปแล้ว
export { CAR_CARE_PATTERN, demoActionFor, wearActionFor } from './shot-categories.js';
export type { DemoAction, WearAction } from './shot-categories.js';


// ⚠️ ตัวกรองนี้เคยกว้างเกินไป: มันบล็อกคำว่า open/peel/pour/apply/dispense/scoop ด้วย
// ซึ่งคือ "ท่าใช้งานสินค้า" ทั้งหมด → ทุก motion prompt ที่ Gemini วางไว้ตาม shotPlans
// ถูกเปลี่ยนเป็นท่าโยกสำรองหมด คลิปเลยนิ่งเหมือนกันทุกงาน
//
// เหลือไว้เฉพาะคำที่ทำให้โมเดล "ต้องวาดด้านที่ไม่เคยเห็น" หรือเอาของใหม่เข้าเฟรม
// (rotate/turn/orbit/spin/flip/side/back/unbox) กับคำที่พาวัตถุอื่นเข้ามา (place/add/next to)
const PRODUCT_DRIFT_RISK = /\b(?:rotate|rotates|rotating|turn|turns|turning|orbit|orbits|orbiting|side|back|spin|spins|spinning|flip|flips|flipping|unbox|unboxing|place|places|placing|set|sets|setting|add|adds|adding|introduce|introduces|introducing)\b|\bnext to\b/i;
const SAFE_FIXED_PRODUCT_MOTIONS = [
  'The product moves slowly closer to camera, supported by one female hand with a fixed grip, then settles front-facing in a clear hero view.',
  // ช็อตกลางคือช็อตที่ต้อง "ขาย" — ให้เห็นสินค้าถูกใช้งานจริงหนึ่งจังหวะ ไม่ใช่โยกเฉยๆ
  // ใช้คำว่า "in-use action" ซึ่งแชร์ตัวตรวจเดียวกับ narration validator จึงไม่ต้องฝืนโยก 8°
  // พร้อมทำท่าใช้งาน เพราะการสั่งสองการเคลื่อนไหวพร้อมกันทำให้มือและสินค้าดูไม่เป็นธรรมชาติ
  'Continue the exact frame. The product completes one slow, natural in-use action while the same female hand keeps an unchanged grip. Keep every visible detail readable.',
  'Continue the exact frame. The product remains supported by the same fixed-grip female hand while the camera gently pulls back into a clean hero frame.',
];

const EXTRA_HAND_PATTERN = /\b(?:pair of (?:natural )?(?:female |male )?hands|two hands|both hands|second hand|other hand|another hand)\b/i;

/**
 * "มือเป็นประธานของท่า" — ต้องจับให้ได้ทุกคลิป ไม่ใช่แค่คลิปแรก
 *
 * 🐛 job_146 (โทนเนอร์ Iblanc): ท่าที่ส่งเข้า Flow จริงคือ
 *   คลิป 1 "The single female hand **brings** the pink iblanc bottle closer to the camera..."
 *   คลิป 2 "From the previous frame, the hand **sways** the bottle 8 degrees left and right..."
 * ทั้งคู่หลุดด่านโดยไม่มี WARN สักบรรทัด เพราะตัวเดิมเขียนไว้ว่า
 *   /^(?:...)?(?:(?:a|the|one|same|female|woman'?s)\s+){1,4}hand\s+(?:lifts?|raises?|brings?|moves?)\b/
 * แล้วเช็คเฉพาะ `clipIndex === 0` — พังสามชั้นพร้อมกัน:
 *   1. anchor `^` + เซ็ตคำนำหน้าปิด → คำว่า "single" ที่ไม่อยู่ในเซ็ตทำให้ทั้งประโยคไม่ match
 *   2. ล็อก clipIndex 0 → คลิป 2 เป็นต้นไปไม่เคยถูกตรวจเลย
 *   3. คำกริยาแค่ 4 ตัว → sway/rock/tilt/shake/press หลุดหมด
 *
 * ผลคือพรอมต์ก้อนเดียวสั่งขัดกันเอง: ล็อกบอก "the product is the moving subject while all five
 * fingers keep the same grip points" แต่ท้ายพรอมต์บอก "the hand sways the bottle 8 degrees"
 * โมเดลได้คำสั่งตีกัน = ต้นตออาการ "มือเพี้ยน" ที่เจ้าของทักมาตลอด
 *
 * ⚠️ ไม่ anchor `^` ได้เพราะ sanitizeProductMotionPrompt() ทำงานกับ "ประโยคท่า" ล้วนๆ
 * ก่อน applyProductIdentityLock() จะเอาล็อกมาประกบหน้า (ดู :201) จึงไม่ไปชนคำว่า
 * "one natural adult female hand is visible" ที่อยู่ในตัวล็อกเอง
 *
 * ⚠️⚠️ และต้องแยก "มือขนสินค้าทั้งชิ้น" ออกจาก "มือใช้งานสินค้า" ให้ขาด
 * ครั้งแรกที่ผมแก้ ใส่ pull/push/press/lift รวมไว้ในลิสต์เดียว → ท่า "the hand pulls one sheet
 * from the pack" ซึ่งเป็นช็อตขายที่ต้องเก็บไว้ ถูกเปลี่ยนเป็นท่าโยกสำรองทันที (regression จับได้)
 * นี่คือกับดักที่ CLAUDE.md เตือนไว้เป๊ะๆ ว่าห้ามคลาย/รัดด่าน motion ฝั่งเดียว
 *
 * ตัวแยกที่ใช้จริงคือ "กรรมของกริยา" ไม่ใช่ตัวกริยา:
 *   มือขนสินค้า  = กริยา + กรรมที่มี the/a/an/its/this/that + ตามด้วยทิศทาง (closer/toward/8 degrees)
 *   มือใช้งาน    = กรรมเป็นชิ้นส่วน/ของที่หยิบออกมา หรือตามด้วย from/onto/into (ไม่ใช่ทิศทางกล้อง)
 * จึงถือว่า "มือเป็นประธาน" เฉพาะตอนที่อ่านประโยคออกจนเขียนใหม่ได้เท่านั้น อ่านไม่ออกก็ปล่อยผ่าน
 * ยกเว้นกริยาขนของล้วนๆ ที่ไม่มีวันเป็นท่าใช้งาน (bring/carry/sway/rock/wave/swing/lower/angle)
 */
const HAND_MOTION_VERBS = 'lifts?|raises?|brings?|moves?|sways?|rocks?|tilts?|angles?|waves?|swings?|carries?|lowers?|pushes?|pulls?';
// กริยาที่ไม่มีทางเป็น "ท่าใช้งานสินค้า" ได้เลย — ตกด่านแม้เขียนใหม่ไม่ได้
// (จงใจไม่มี lift/pull/push/press/shake/slide เพราะทั้งหมดอยู่ใน IN_USE_ACTION_PATTERN)
const HAND_TRANSPORT_ONLY_PATTERN = /\bhands?\s+(?:\w+ly\s+)?(?:brings?|carries?|sways?|rocks?|waves?|swings?|lowers?|angles?)\b/i;


/** ท่าที่ถือว่า "สวมใส่แล้ว" — ใช้เช็คว่า Gemini วางช็อตสวมใส่มาเองหรือยัง */
export const ALREADY_WEARING = /\b(?:wear(?:s|ing)?|worn|steps? into|slides? into|fasten\w*|on the (?:foot|wrist|shoulder)|onto (?:one|the) (?:foot|wrist|shoulder))\b/i;

/**
 * ท่าที่นับว่า "ได้เห็นสินค้าทำงานจริง"
 *
 * ใช้ร่วมกันสองที่: บังคับให้ช็อตหลังเป็นช็อตใช้งาน และให้ด่านตรวจบทยอมรับท่าแบบนี้
 * โดยไม่ต้องมีตัวเลของศา (ประกาศที่เดียวเพื่อไม่ให้สองที่หลุดจากกันเหมือน job #128)
 */
export const IN_USE_ACTION_PATTERN = /\b(?:in-use action|point(?:s|ed|ing)?|press(?:es|ing)?|push(?:es|ing)?|squeez\w*|fluff\w*|smooth(?:s|es|ing)?|open(?:s|ing)?|clos(?:es|ing)|pull(?:s|ing)?|lift(?:s|ing)?|wipe\w*|pour\w*|appl(?:y|ies|ying)|dispens\w*|scoop\w*|spray\w*|slide\w*|fold(?:s|ing)?|pump(?:s|ing)?|shake(?:s|ing)?|swipe\w*)\b/i;

/**
 * ⚠️ กล้องขยับ ≠ สินค้าทำงาน
 *
 * 🐛 job_153 (สบู่ FayDa): คลิป 2 คือ "the box exactly sways 8 degrees left and right,
 * as the camera pulls focus onto the printed usage instructions" — ไม่มีอะไรเกิดขึ้นเลย
 * นอกจากกล่องโยกกับกล้องเปลี่ยนโฟกัส แต่ ensureLaterShotDemonstrates ปล่อยผ่าน
 * เพราะคำว่า **"pulls"** ใน "camera pulls focus" ไปตรงกับ `pull(?:s|ing)?` ในลิสต์ข้างบน
 *
 * แปลว่าด่านที่ตั้งไว้ตั้งแต่ job_129 เพื่อบังคับว่า "คลิป 2 ต้องเห็นสินค้าทำงาน"
 * ถูกปิดปากได้ด้วยคำบรรยายกล้องธรรมดา — และพรอมต์แทบทุกอันมีคำว่า camera pushes in/pulls back
 * ด่านนี้จึงแทบไม่เคยทำงานจริงเลยตั้งแต่วันที่สร้าง นี่คือเหตุผลที่คลิปยังนิ่งอยู่
 * ทั้งที่เรามีด่านบังคับอยู่แล้ว
 *
 * ตัดวลีที่ "กล้อง" เป็นประธานออกก่อนตรวจเสมอ — เหลือเฉพาะสิ่งที่สินค้าหรือมือทำจริง
 */
const CAMERA_CLAUSE = /\b(?:the\s+)?camera\b[^,.;]*/gi;

export function describesProductInUse(prompt: string): boolean {
  return IN_USE_ACTION_PATTERN.test(prompt.replace(CAMERA_CLAUSE, ' '));
}

/**
 * ย่อเฉพาะที่จบประโยค ห้ามตัดคาคำเชื่อมหรือกลางท่า
 *
 * ถ้าประโยคแรกยาวเกินเพดาน ให้คงประโยคนั้นครบแทนการตัดจน Flow ไม่รู้ว่าต้องทำอะไร
 * (job #143 นิ่งสนิทเมื่อพรอมต์จบคา "...footbed and").
 */
export function limitPromptWords(prompt: string, maxWords = 30): string {
  const words = prompt.trim().split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return words.join(' ');

  const sentenceBoundaries = words
    .map((word, index) => /[.!?。！？]["')\]]*$/.test(word) ? index : -1)
    .filter((index) => index >= 7);
  const boundaryAtOrBeforeLimit = sentenceBoundaries
    .filter((index) => index < maxWords)
    .pop();

  if (boundaryAtOrBeforeLimit !== undefined) {
    const limited = words.slice(0, boundaryAtOrBeforeLimit + 1).join(' ');
    logger.warn(`⚠️ Motion prompt ยาว ${words.length} คำ — ตัดที่จบประโยคเหลือ ${boundaryAtOrBeforeLimit + 1} คำ`);
    return limited;
  }

  const firstBoundary = sentenceBoundaries[0];
  if (firstBoundary !== undefined) {
    const limited = words.slice(0, firstBoundary + 1).join(' ');
    logger.warn(
      `⚠️ Motion prompt ประโยคแรกยาวเกินเพดาน ${maxWords} คำ — คงประโยคครบ ${firstBoundary + 1} คำแทนการตัดกลางท่า`
    );
    return limited;
  }

  logger.warn(
    `⚠️ Motion prompt ยาว ${words.length} คำแต่ไม่มีขอบเขตประโยคที่ปลอดภัย — ไม่ตัดเพื่อกันท่าขาดกลาง`
  );
  return words.join(' ');
}

/**
 * เปลี่ยน "มือทำอะไรกับสินค้า" เป็น "สินค้าทำอะไร" โดยเก็บรายละเอียดของท่าไว้ครบ
 *
 * ทำไมต้องเขียนใหม่แทนที่จะโยนทิ้งไปใช้ประโยคสำรอง:
 * CLAUDE.md เตือนไว้ว่าด่าน motion กับ validator บทพากย์ต้องขยับคู่กัน — ถ้าตัวจับเข้มขึ้น
 * แล้วท่าทุกคลิปตกไปใช้ SAFE_FIXED_PRODUCT_MOTIONS หมด ท่าจะเหมือนกันทุกงาน แล้วบทพากย์
 * ที่เกาะ describeMotionAction() ก็จะจืดตามไปด้วย (#128 ซ้ำรอย #100)
 *
 * "the hand sways the bottle 8 degrees left and right while the camera pushes in"
 *   → "the bottle sways 8 degrees left and right while the camera pushes in, supported by ..."
 * รายละเอียดที่บทพากย์ต้องใช้ ("8 องศา", "โฟกัสที่ตัวเลข 200 g") อยู่ครบ เปลี่ยนแค่ประธาน
 *
 * ⚠️ กริยาที่ย้ายประธานแล้วภาษาเพี้ยน (press/hold up) กับกริยาที่เสี่ยงทำสินค้าเพี้ยนอยู่แล้ว
 * (turn/rotate/flip/twist) จงใจไม่ใส่ในตาราง → ตกไปใช้ประโยคสำรองเหมือนเดิม ปลอดภัยกว่าเดา
 */
const HAND_VERB_AS_PRODUCT_VERB = new Map<string, string>([
  ['lift', 'rises'], ['lifts', 'rises'],
  ['raise', 'rises'], ['raises', 'rises'],
  ['bring', 'moves'], ['brings', 'moves'],
  ['move', 'moves'], ['moves', 'moves'],
  ['sway', 'sways'], ['sways', 'sways'],
  ['rock', 'rocks'], ['rocks', 'rocks'],
  ['tilt', 'tilts'], ['tilts', 'tilts'],
  ['angle', 'tilts'], ['angles', 'tilts'],
  ['shake', 'shakes'], ['shakes', 'shakes'],
  ['wave', 'sways'], ['waves', 'sways'],
  ['swing', 'swings'], ['swings', 'swings'],
  ['carry', 'moves'], ['carries', 'moves'],
  ['lower', 'settles'], ['lowers', 'settles'],
  ['push', 'moves'], ['pushes', 'moves'],
  ['pull', 'moves'], ['pulls', 'moves'],
]);

// ตัวบอกว่า "กรรม" จบตรงไหน — ต้องมีตัวใดตัวหนึ่งตามหลัง ไม่งั้นถือว่าอ่านประโยคไม่ออก
// แล้วยอมตกไปใช้ประโยคสำรอง ดีกว่าเดาขอบเขตผิดแล้วได้ประโยคพัง
const OBJECT_BOUNDARY = 'closer|nearer|up|down|upward|downward|toward|towards|into|out|outward|forward|backward|back|slightly|gently|slowly|smoothly|steadily|left|right|while|as|so|until|then|in|to|at|over|near|past|across|around|and|\\d';
const HAND_LED_REWRITE_PATTERN = new RegExp(
  String.raw`(?:\b(?:a|an|the|one|its|his|her|their|same|single|natural|adult|female|male|woman'?s|model'?s|gloved)\s+)*\bhands?\s+(?:\w+ly\s+)?(${HAND_MOTION_VERBS})\s+((?:the|a|an|its|this|that)\s+(?:[\w'’\-]+\s+){0,4}?[\w'’\-]+)(?=\s+(?:${OBJECT_BOUNDARY})\b|\s*[,.]|\s*$)`,
  'i'
);
const FIXED_GRIP_TAIL = ', supported by the same fixed-grip female hand.';

function rewriteHandLedAction(prompt: string): string | null {
  // ⚠️ ห้ามเขียนใหม่เมื่อพรอมต์สั่ง "สองมือ" — ตัวเขียนใหม่ตัดคำว่า hands ออกแล้วเอากรรมมาเป็น
  // ประธาน ทำให้ "A pair of natural female hands lifts the product" กลายเป็น "A pair of the
  // product rises" ซึ่งพังทั้งไวยากรณ์และยังเหลือคำว่าสองมืออยู่ ต้องปล่อยให้ EXTRA_HAND_PATTERN
  // จัดการเป็นท่ามือเดียวแทน
  if (EXTRA_HAND_PATTERN.test(prompt)) return null;
  const match = HAND_LED_REWRITE_PATTERN.exec(prompt);
  if (!match) return null;
  const productVerb = HAND_VERB_AS_PRODUCT_VERB.get(match[1].toLowerCase());
  if (!productVerb) return null;
  const rewritten = `${prompt.slice(0, match.index)}${match[2]} ${productVerb}${prompt.slice(match.index + match[0].length)}`
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.])/g, '$1')
    .trim();
  // ประธานใหม่ต้องไม่พาให้มือกลับมาเป็นประธานอีก ไม่งั้นเท่ากับไม่ได้แก้อะไร
  if (HAND_TRANSPORT_ONLY_PATTERN.test(rewritten)) return null;
  const body = rewritten.replace(/[.\s]+$/u, '');
  if (!body) return null;
  return `${body.charAt(0).toUpperCase()}${body.slice(1)}${FIXED_GRIP_TAIL}`;
}

export function sanitizeProductMotionPrompt(prompt: string, clipIndex: number): string {
  const cleaned = prompt.trim();
  // ตรวจทุกคลิป ไม่ใช่แค่คลิปแรก — job_146 คลิป 2 หลุดเพราะเดิมล็อกไว้ที่ clipIndex === 0
  const rewritten = rewriteHandLedAction(cleaned);
  if (rewritten) {
    logger.warn(
      `⚠️ Motion prompt คลิป ${clipIndex + 1} ให้มือเป็นประธาน — สลับให้สินค้าเป็นประธานโดยคงรายละเอียดท่าไว้`
    );
    return rewritten;
  }
  // เขียนใหม่ไม่ได้ + เป็นกริยาขนของล้วนๆ → ยอมเสียรายละเอียดดีกว่าปล่อยให้ขัดกับล็อกในพรอมต์เดียวกัน
  if (HAND_TRANSPORT_ONLY_PATTERN.test(cleaned)) {
    logger.warn(
      `⚠️ Motion prompt คลิป ${clipIndex + 1} ให้มือขนสินค้าและเขียนใหม่ไม่ได้ — เปลี่ยนเป็นท่าสินค้าเป็นประธาน`
    );
    return SAFE_FIXED_PRODUCT_MOTIONS[Math.min(clipIndex, SAFE_FIXED_PRODUCT_MOTIONS.length - 1)];
  }
  if (EXTRA_HAND_PATTERN.test(cleaned)) {
    const fallback = SAFE_FIXED_PRODUCT_MOTIONS[Math.min(clipIndex, SAFE_FIXED_PRODUCT_MOTIONS.length - 1)];
    logger.warn(`⚠️ Motion prompt คลิป ${clipIndex + 1} สั่งมือเกินจากเฟรมตั้งต้น — เปลี่ยนเป็นท่ามือเดียว`);
    return fallback;
  }
  if (!PRODUCT_DRIFT_RISK.test(cleaned)) return cleaned;
  const fallback = SAFE_FIXED_PRODUCT_MOTIONS[Math.min(clipIndex, SAFE_FIXED_PRODUCT_MOTIONS.length - 1)];
  logger.warn(`⚠️ Motion prompt คลิป ${clipIndex + 1} เสี่ยงทำสินค้าเพี้ยน — เปลี่ยนเป็นท่าคงสินค้าอัตโนมัติ`);
  return fallback;
}

/**
 * ช็อตที่ 2 เป็นต้นไปต้องมีการใช้งานสินค้าให้เห็น ไม่ใช่ถือเฉยๆ ซ้ำช็อตแรก
 *
 * job_129 (โทนเนอร์ iblanc): ทั้งสองคลิปเป็นภาพ "มือถือขวดหน้าหน้าต่าง" เหมือนกันเป๊ะ
 * ต่างแค่มุมนิดเดียว ทั้งที่ขวดมีฝาปั๊มอยู่ตรงนั้น — คนดูไม่เคยเห็นสินค้าทำงานเลยสักครั้ง
 * บทพากย์จึงไม่มีอะไรให้เกาะ และคลิปไม่มีจังหวะที่ "ขาย" ได้จริง
 *
 * ปล่อยให้ Gemini เลือกเองแล้วมันเลือกท่านิ่งเป็นส่วนใหญ่ จึงบังคับตรงนี้แทน
 */
export function ensureLaterShotDemonstrates(prompt: string, index: number): string {
  if (index === 0 || describesProductInUse(prompt)) return prompt;
  logger.warn(`⚠️ Motion prompt คลิป ${index + 1} ไม่มีท่าใช้งานสินค้า — เปลี่ยนเป็นช็อตสาธิต`);
  return SAFE_FIXED_PRODUCT_MOTIONS[Math.min(index, SAFE_FIXED_PRODUCT_MOTIONS.length - 1)];
}


