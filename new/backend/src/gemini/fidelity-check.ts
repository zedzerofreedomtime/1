import fs from 'fs';

import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import type { ProductImageFidelityResult } from '../types.js';
import { genAI, generateContentWithRetry, imageInlinePart } from './gemini-client.js';
import { parseGeminiVisionJson } from './json-parser.js';

/** ความเข้มของด่านตรวจ — เลือกตามว่ากำลังตรวจภาพแบบไหน (ดูคำอธิบายที่พารามิเตอร์ mode) */
// 'clip_in_use' = เฟรมแรกของช็อตที่มือกำลังใช้สินค้าจริง (ดู demoActionFor ใน motion-prompts.ts)
// สินค้าจะโดนฟอง/ผ้า/สำลี/มือบังบางส่วน และเอียงตามการกระทำ ซึ่งเกณฑ์ 'clip' ยังไม่ได้บอกผู้ตรวจ
// เจ้าของสั่ง 31 ก.ค. ว่าให้ "ผ่อนเฉพาะช็อตใช้งาน" — โหมดอื่นห้ามแตะ
export type FidelityMode = 'start' | 'rotated' | 'clip' | 'clip_in_use';

/**
 * ด่านสุดท้ายก่อนจ่ายเครดิตวิดีโอ — เทียบว่า "ภาพที่ Flow สร้าง" เป็นสินค้าตัวเดียวกับต้นฉบับไหม
 *
 * ปล่อยให้มือ พื้นหลัง องค์ประกอบภาพเปลี่ยนได้ แต่ตัวสินค้าห้ามเพี้ยน
 */
/**
 * Best-effort recovery when the fidelity JSON is malformed (usually an unescaped
 * quote/control char inside the freetext "differences"). Extracts ONLY the
 * decision-critical fields — the seven boolean checks and the numeric score —
 * which Gemini always emits as plain `"name": true/false` / `"score": N` tokens
 * that survive whatever broke the surrounding JSON. Returns null if not even the
 * checks can be recovered, so the caller still fails closed on true garbage.
 */
function extractFidelityFieldsLeniently(rawText: string): Record<string, any> | null {
  const checkNames = [
    'category', 'silhouette', 'openClosedState', 'colors',
    'componentCount', 'componentLayout', 'visibleText',
  ] as const;
  const checks: Record<string, boolean> = {};
  let recovered = 0;
  for (const name of checkNames) {
    const match = new RegExp(`"${name}"\\s*:\\s*(true|false)`, 'i').exec(rawText);
    if (match) {
      checks[name] = match[1].toLowerCase() === 'true';
      recovered += 1;
    } else {
      checks[name] = false;
    }
  }
  // If we could not read a single check, we have no basis to judge — fail closed.
  if (recovered === 0) return null;
  const scoreMatch = /"score"\s*:\s*(-?\d+(?:\.\d+)?)/.exec(rawText);
  const passMatch = /"pass"\s*:\s*(true|false)/i.exec(rawText);
  return {
    pass: passMatch ? passMatch[1].toLowerCase() === 'true' : undefined,
    score: scoreMatch ? Number(scoreMatch[1]) : 0,
    checks,
    differences: ['Gemini ส่ง JSON เพี้ยน — กู้เฉพาะผลตรวจหลัก (differences ไม่สมบูรณ์)'],
  };
}

/**
 * Final paid-credit gate: compare only the product identity between the source
 * and Flow output. A new hand/background/composition is allowed; invented or
 * changed product details are not.
 */
export async function compareGeneratedProductFidelity(
  sourceImagePath: string,
  generatedImagePath: string,
  // 'start'   = เฟรมตั้งต้น เข้มที่สุด เพราะยังไม่จ่ายเครดิตวิดีโอ เจนใหม่ถูกกว่าปล่อยผ่าน
  //
  // 'rotated' = end frame ถูกออกแบบให้ "หมุน ~35° ให้เห็นมุมต่าง" → silhouette/ชิ้นส่วนที่
  //   มองเห็น/ความอ่านออกของฉลาก "ต้องเปลี่ยน" ตามมุม ถ้าใช้เกณฑ์เข้มเท่า start frame จะบล็อก
  //   ทุกครั้ง (job #70) โหมดนี้เช็คแค่ "เป็นสินค้าเดียวกันไหม" (หมวด+สี)
  //
  // 'clip'    = เฟรมแรกของคลิปที่ Flow เรนเดอร์ใหม่ทั้งภาพ ท่ามือ/จุดจับ/มุมกล้อง/ทรงชั่วขณะ
  //   ต่างจากรูปที่ป้อนเข้าไปได้ตามธรรมชาติ ถ้าเอาเกณฑ์ 6 ข้อของ start frame มาใช้จะตีตกคลิป
  //   ที่จ่ายเครดิตไปแล้วเพราะเรื่องท่าทางล้วนๆ → เช็คเฉพาะสิ่งที่บอกว่า "สินค้าคนละตัว":
  //   หมวด + สี + ตัวตนของแบรนด์บนฉลาก
  //   (visibleText ไม่ได้อยู่ในเกณฑ์ตัดสินของ start frame แต่ต้องอยู่ในโหมดนี้ เพราะเคสที่
  //    ทำให้ต้องมีด่านนี้คือ job #124 ที่ฉลาก "บ้านไผ่..." ถูกเขียนใหม่เป็น "Brapt Cemual")
  mode: FidelityMode | boolean = 'start',
  approvedReferencePaths: string[] = []
): Promise<ProductImageFidelityResult> {
  // ผู้เรียกเดิมส่ง boolean expectRotated มา — รับต่อได้โดยไม่ต้องแก้
  const compareMode: FidelityMode = mode === true ? 'rotated' : mode === false ? 'start' : mode;
  const expectRotated = compareMode === 'rotated';
  const isClipFrame = compareMode === 'clip' || compareMode === 'clip_in_use';
  const model = genAI.getGenerativeModel({
    model: config.geminiModel,
    generationConfig: {
      temperature: 0,
      topP: 0.1,
      maxOutputTokens: 2048,
      thinkingConfig: { thinkingBudget: 0 },
      responseMimeType: 'application/json',
    } as any,
  });

  const approvedReferences = approvedReferencePaths
    .filter((imagePath, index, paths) =>
      imagePath
      && imagePath !== sourceImagePath
      && paths.indexOf(imagePath) === index
      && fs.existsSync(imagePath)
    )
    .slice(0, 3);

  const result = await generateContentWithRetry(model, [
    {
      text: `You are a strict ecommerce product identity inspector.
Compare SOURCE PRODUCT with GENERATED IMAGE. Ignore the new hand, background, lighting, crop, camera angle and global position.
Judge only whether the generated image preserves the exact same physical product identity and component relationships.
${isClipFrame ? `
IMPORTANT — the GENERATED IMAGE is the first frame of a video the model re-rendered from the source as a reference. Framing, camera angle, distance, lighting, surface, hand position and which parts are in shot WILL differ, and that is expected, NOT an identity change.
The clip may also have been generated with APPROVED PRODUCT REFERENCE images shown below. Those are verified views of the SAME physical product. A real logo, trim, seam, component or material visible in any approved reference is valid evidence of product identity, even when the primary source frame hid it behind a hand or crop. Do not mark such a verified detail as invented. Still fail branding, text, colors, geometry or parts that appear in NONE of the approved references.
Because of the new framing, label text is often smaller, angled away, cropped out or covered. Mark "visibleText" TRUE whenever the label is simply not readable, not visible or cut off — absence of readable text is NOT an identity change. Mark it FALSE only when readable branding is present AND it is clearly DIFFERENT branding: a different brand name, a different product name, or invented words replacing the source wording.
Judge "colors" on the product's own dominant and secondary colors, allowing for the new lighting and white balance; a warmer or cooler cast on the same materials is not a color change. A hardware finish that changed to a genuinely different metal or color IS a change.
` : ''}${compareMode === 'clip_in_use' ? `
IMPORTANT — this frame is taken mid-action: the product is being USED, not displayed. Foam, liquid, spray, a cloth, a cotton pad, a work surface or the hand itself may cover part of it, and it may be steeply tilted or only partly in shot. Judge identity from whatever part of the product IS visible. Partial occlusion, a working tilt, wet or foamy surfaces, and a cropped body are all expected here and are NOT identity changes.
The pack may also be OPEN here with one single unit from inside it taken out and held up — one tissue sheet, one diaper, one snack piece, one mask sheet. That unit is part of this same product, not a different product, so an opened pack and a loose unit beside it are both expected and correct. Judge it as the same product when the unit is a plausible content of that pack.
Fail only when a visible part proves it is a DIFFERENT product: a different category, different dominant colors, or different branding. Also fail when branding text on the pack or on the loose unit has been rewritten into words or letter shapes that appear nowhere in the source — invented wording is an identity change even when the colours and shape are right.
` : ''}${expectRotated ? `
IMPORTANT — the GENERATED IMAGE is the SAME product intentionally ROTATED about 35 degrees to show a different angle. So its silhouette outline, which components are visible, which side faces the camera, perspective, and label readability WILL naturally differ from the source — that is expected and correct, NOT an identity change. Judge ONLY whether it is the same product: same product category/type, same materials, same dominant and secondary colors, same brand/label artwork. Mark silhouette/openClosedState/componentCount/componentLayout TRUE as long as it is plausibly the same product seen from another angle. Fail only if it is clearly a DIFFERENT product (different category, different colors, or different branding).
` : ''}
SOFT / DEFORMABLE PRODUCTS — pillows, cushions, mattresses, quilts, towels, clothing, fabric bags, fitted covers stretched over a frame such as an ironing board cover or mattress protector, flexible-film packaging: their outline changes with how they are held, pressed, stacked or laid down, and the source photo and the generated photo were taken in different handling states.
The generated image was deliberately given a hand that the source does not have. Where that hand grips, lifts, pulls or pinches a soft product, the outline it changes at that spot is the DIRECT RESULT of an instruction we gave, not evidence of a different product — a fabric cover whose corner reads flat or squared because a hand is lifting it there is the same cover. Judge the outline away from the hand. Judge such a product's "silhouette" on its CONSTRUCTION — panel layout, trim/gusset bands, seam and piping placement, proportion of each colored section, label position — NOT on its momentary loft, sag, dip or compression. A pillow that looks flatter, plumper or without the source's pressed-in dip is the SAME product in a different handling state: mark silhouette TRUE. Mark it FALSE only when the construction itself differs, for example a trim band that moved, disappeared or changed width, a different number of panels, or genuinely different proportions.

Fail if any of these changed or were invented:
- product category or type
- silhouette, geometry, proportions, joints or visible hardware (for soft goods, see the rule above)
- open/closed/folded/assembled state
- dominant and secondary colors
- number of product components or accessories
- relative layout/relationship of components (for example parts inside vs outside a case)

For "visibleText": judge whether the SAME WORDS in the SAME SCRIPT are still on the label, not how crisply they rendered. Mark it TRUE when the wording is the same even though characters are soft, blurred, cut off or imperfectly formed — AI image generation cannot reproduce label text pixel-perfectly, and that alone is not an identity change. Mark it FALSE when the wording itself changed: a different brand or model name, invented words that appear nowhere in the source, text added where the source label is blank, or a line written in one script replaced by another script — Thai turning into Chinese, Japanese or Latin gibberish, or the reverse. A Thai-market product whose Thai line is no longer Thai has lost its label identity no matter how sharp the rendering.

Score on product IDENTITY (shape, state, colors, components) together with label wording. Soft or blurred rendering of the CORRECT words still scores high. Correct shape and colours with rewritten or re-scripted wording does not.

When a detail is hidden by the new hand, do not invent certainty. Mark the relevant check false if the remaining evidence cannot prove it matches.
"score" is 0-100 where 100 means the product identity is fully preserved and 0 means it is a completely different product. Do not copy the example number below.
Return JSON only:
{
  "pass": true,
  "score": 92,
  "checks": {
    "category": true,
    "silhouette": true,
    "openClosedState": true,
    "colors": true,
    "componentCount": true,
    "componentLayout": true,
    "visibleText": true
  },
  "differences": ["specific difference"]
}`,
    },
    { text: 'PRIMARY SOURCE PRODUCT — main continuity reference:' },
    imageInlinePart(sourceImagePath),
    ...approvedReferences.flatMap((imagePath, index) => [
      { text: `APPROVED PRODUCT REFERENCE ${index + 1} — verified view of the same product:` },
      imageInlinePart(imagePath),
    ]),
    { text: 'GENERATED IMAGE — candidate to approve or block:' },
    imageInlinePart(generatedImagePath),
  ], 'ตรวจความตรงของสินค้า');

  const rawText = result.response.text().trim();
  let parsed: Record<string, any>;
  try {
    parsed = parseGeminiVisionJson(rawText) as unknown as Record<string, any>;
  } catch (parseError) {
    // Gemini's freetext "differences" occasionally contains an unescaped quote or
    // control char that breaks strict JSON. The DECISION fields (checks booleans +
    // score) are machine-formatted and extract reliably by regex — so a broken
    // differences string must never masquerade as a product mismatch (score 0 block).
    const lenient = extractFidelityFieldsLeniently(rawText);
    if (!lenient) throw parseError;
    logger.warn('⚠️ Gemini fidelity JSON เพี้ยน — ดึงเฉพาะ checks/score ด้วยตัวสำรอง (differences อาจไม่ครบ)');
    parsed = lenient;
  }
  const rawChecks = parsed.checks && typeof parsed.checks === 'object' ? parsed.checks : {};
  const checks: ProductImageFidelityResult['checks'] = {
    category: rawChecks.category === true,
    silhouette: rawChecks.silhouette === true,
    openClosedState: rawChecks.openClosedState === true,
    colors: rawChecks.colors === true,
    componentCount: rawChecks.componentCount === true,
    componentLayout: rawChecks.componentLayout === true,
    visibleText: rawChecks.visibleText === true,
  };
  const score = Math.max(0, Math.min(100, Number(parsed.score) || 0));
  const differences = Array.isArray(parsed.differences)
    ? parsed.differences.map((value: unknown) => String(value).trim()).filter(Boolean).slice(0, 12)
    : ['Gemini ไม่ได้ระบุความแตกต่างอย่างเป็นโครงสร้าง'];
  // A real identity change blocks the paid video stage. Rendering artifacts
  // on the same label remain visible in diagnostics but do not false-block
  // nearly every text-bearing product.
  // end frame (rotated): เช็คแค่ "สินค้าเดียวกันไหม" = หมวด + สี (ไม่เปลี่ยนตามมุม)
  // silhouette/openClosedState/componentCount/componentLayout เปลี่ยนตามการหมุนโดยธรรมชาติ
  // จึงไม่เอามาเป็นตัวบล็อก ไม่งั้น end frame ที่หมุนถูกต้องจะโดนบล็อกทุกครั้ง
  //
  // clip: คลิปถูกเรนเดอร์ใหม่ทั้งภาพ ท่ามือ/จุดจับ/ทรงชั่วขณะจึงต่างได้ตามธรรมชาติ
  // เอาเฉพาะสิ่งที่แปลว่า "สินค้าคนละตัว" มาตัดสิน + ยอมปล่อยผ่านถ้าผู้ตรวจให้คะแนนสูงถึง
  // เกณฑ์ (CLIP_FIDELITY_MIN_SCORE) เพราะคลิปนี้จ่ายเครดิตไปแล้ว ตีตกเพราะเคสก้ำกึ่งไม่คุ้ม
  const identityPass = expectRotated
    ? checks.category && checks.colors
    : isClipFrame
      ? (checks.category && checks.colors && checks.visibleText)
        || score >= config.clipFidelityMinScore
      : checks.category && checks.silhouette && checks.openClosedState
        && checks.colors && checks.componentCount && checks.componentLayout;

  // 🐛 job_163 (ทิชชู่ BOTARE): รูปตั้งต้นออกมาโดยบรรทัดไทย `โบทาเร่ กระดาษเนื้อนุ่มหลายชั้น`
  // กลายเป็น `โบพาเว่ กระจานเพื่อชุ่นลลัดคุขั้บ` แล้วด่านนี้ตอบ pass=true score=85
  // visibleText=true differences=[] — คือด่านบอกว่าไม่มีอะไรผิดเลย
  //
  // สองชั้นซ้อนกัน: พรอมต์เดิมสั่งตรงๆ ว่า "imperfect Thai characters" ให้ตอบ TRUE
  // และโหมด start ก็ไม่ได้เอา visibleText มาร่วมตัดสินอยู่แล้ว
  //
  // ⚠️ **ยังไม่เอา visibleText มาบล็อกโหมด start** เพราะยังไม่รู้ว่าตัวเจนรูปทำไทยพังบ่อยแค่ไหน
  // ถ้าเปิดบล็อกทันทีแล้วมันพังทุกใบ ไปป์ไลน์จะหยุดทั้งระบบ — ต้องวัดก่อนแล้วค่อยตัดสิน
  // ตอนนี้ทำให้ "สัญญาณเป็นความจริง" ก่อน แล้วตะโกนออกมาให้เห็นทุกครั้ง
  if (!checks.visibleText) {
    logger.warn(
      `⚠️ ตัวหนังสือบนฉลากถูกเขียนใหม่ (โหมด ${compareMode}, score ${score})`
      + `${identityPass ? ' — ปล่อยผ่านเพราะโหมดนี้ยังไม่บล็อกด้วยข้อนี้' : ''}`
      + `${differences.length ? ` — ${differences.slice(0, 2).join('; ')}` : ''}`
    );
  }

  return {
    pass: identityPass,
    score,
    checks,
    differences,
  };
}
