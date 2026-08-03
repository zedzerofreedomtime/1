import { logger } from '../utils/logger.js';
import { cameraTimeline } from './camera-timeline.js';
import type { DemoAction, WearAction } from './shot-categories.js';
import {
  ALREADY_WEARING,
  ensureLaterShotDemonstrates,
  limitPromptWords,
  sanitizeProductMotionPrompt,
} from './motion-prompts.js';

/**
 * ความปลอดภัยของ motion prompt ที่ส่งให้ Flow
 *
 * ท่ากล้อง/ท่ามือบางแบบทำให้ Veo เปลี่ยนรูปทรงสินค้าไปเลย (หมุนไปด้านหลัง เปิดฝา
 * วางของใหม่เข้าเฟรม) ไฟล์นี้กันไม่ให้ prompt แบบนั้นหลุดไปถึงขั้นจ่ายเครดิต
 */
// Flow responds more reliably to one compact, repeated continuity rule than to a
// long list of prohibitions pasted into every 8-second request.
// รีวิว job_96 (27 ก.ค. 2026): ฉลากเปลี่ยนคำ/ตัวอักษรมั่ว กราฟิกย้ายที่ ฝาและคอขวดเปลี่ยนรูป
// ของเหลวในขวดหายไปแล้วกลับมา ระดับน้ำไม่อยู่แนวราบตอนเอียง นิ้วไม่ขยับตามตอนขวดหมุน
//
// รากปัญหาเดียวกันทั้งหมด: ยิ่งหมุนมาก โมเดลยิ่งต้อง "วาดด้านที่ไม่เคยเห็น" ขึ้นมาเอง
// ลด 20° → 8° (พอให้เห็นว่าเคลื่อนไหวจริง แต่ฉลากยังเป็นระนาบเดิมตลอด)
// แล้วล็อกสามอย่างที่โมเดลชอบปล่อยหลุดเพิ่ม: ตัวอักษรบนฉลาก / ระดับของเหลว / จุดที่นิ้วจับ
// เจ้าของรีวิว job_123/job_124 (30 ก.ค. 2026): "คลิปยังไม่ค่อยเข้ากับเสียงพากย์
// แล้วก็ยังไม่ดูเป็นการขายที่น่าดึงดูด" — เพราะทุกคลิปทำได้แค่โยก 8 องศาเหมือนกันหมด
// บทพากย์เลยไม่มีอะไรให้เกาะ และคนดูไม่เห็นสินค้า "ทำงาน" สักครั้ง
//
// ตอนนี้มีด่านตรวจเฟรมแรกของคลิป (clip-fidelity.ts) คอยจับสินค้าเพี้ยนแล้ว จึงเปิดให้
// ทำท่าใช้งานจริงได้หนึ่งท่าต่อคลิป โดยยังล็อกสิ่งที่ทำให้ "ดูเป็นสินค้าคนละตัว" ไว้ครบ:
// ฉลาก / สี / รูปทรง / ทิศทาง / ด้านที่ยังไม่เคยเห็น / ของใหม่โผล่เข้าเฟรม
// 🐛 job_148 (แพมเพิส Penbose) — Codex อ่านคลิปแล้วชี้ว่าจุดที่แปลกที่สุดคือ:
// เฟรมตั้งต้นที่ผ่านด่านคือ "มือถือแพ็ค" แต่พอขึ้นคลิปกลายเป็น "มือถือผ้าอ้อมชิ้นเดียว"
// โดยไม่มีจังหวะแกะซองเลย + ซองที่วางอยู่ฉากหลังถูกออกแบบใหม่ (ของจริงลายยีราฟ
// แต่ในคลิปมีรูปถ่ายหน้าเด็กกับเลข 35) + ฉลากบนผ้าอ้อมเป็นคำมั่ว
// สรุปของ Codex: "ดูเหมือน AI เปลี่ยนสินค้ากลางทาง แล้วพิมพ์ฉลากปลอม" = อ่านว่าของปลอมทันที
//
// ล็อกเดิมพูดถึง "สินค้า" ในฐานะแนวคิด แต่ไม่เคยพูดว่า "วัตถุชิ้นที่อยู่ในมือ" ต้องเป็นชิ้นเดิม
// และไม่เคยพูดถึงสินค้าตัวเดียวกันที่วางอยู่ในฉากเลย ทั้งสองช่องโหว่ถูกใช้ในคลิปเดียวกัน
const PRODUCT_IDENTITY_LOCK = 'Continuity lock: exact same product, silhouette, geometry, materials, colors, logo, printed details and visible hardware. The hand keeps holding the exact same object it holds in the first frame — never swap it for a different item, never exchange a pack for its contents, and never open, unwrap or empty it. Any other unit of this product resting in the scene keeps its packaging artwork exactly as it appears in the first frame; never redesign, re-illustrate or re-label it. Keep the front face toward camera; never show an unseen side, never invent unseen parts. Every letter, number, line and small print on the label stays identical and in the same place in every frame — never re-letter, re-spell, re-position or tidy up label artwork. Thai text on the label stays Thai script; never redraw it as Chinese, Japanese or Latin lookalike characters. Liquid or contents keep the same color, opacity and fill level, and the liquid surface stays horizontal when the product tilts. Exactly one natural adult female hand is visible for the whole clip. It only supports the product: the product is the moving subject while all five fingers keep the same grip points, shape and spacing in every frame. No second hand, other hand, pair of hands or new fingers may enter. The product keeps the exact same way up for the whole clip; never flip or re-orient it. No duplicates and no new objects entering frame. Camera holds steady, pushes in, pulls back or tilts a few degrees; the entire product, including its cap or pump, stays fully inside frame while the camera is wide, and the front label is readable in the opening seconds; never orbit around it or circle to another side. Silent footage: no dialogue, music or sound effects.';

/**
 * ข้อความ "ล็อก" ที่ประกบหน้าทุก motion prompt ก่อนส่งเข้า Flow
 *
 * แยกออกจาก motion-prompts.ts เมื่อ 1 ส.ค. 2026 — ไฟล์นี้คือ "สิ่งที่เราสั่ง Flow"
 * ส่วน motion-prompts.ts คือ "การตรวจสิ่งที่ Gemini เขียนมา" คนละหน้าที่และแก้คนละเหตุผล
 *
 * ⚠️ ทุกประโยคในนี้มาจากคลิปที่เสียเครดิตไปแล้วจริงๆ ห้ามลบเพราะ "ดูซ้ำซ้อน"
 * เพิ่มความยาว 100 ตัวอักษร = บอทพิมพ์ช้าลง 10 วินาทีต่อคลิป (พิมพ์ทีละตัว)
 */

/**
 * ล็อกฉบับที่อนุญาตให้อวัยวะหนึ่งส่วนเข้าเฟรมเพื่อสวมใส่สินค้า
 *
 * ล็อกปกติเขียนว่า "no new objects entering frame" ซึ่งครอบเท้า/ข้อมือ/ไหล่ไปด้วย
 * ถ้าไม่ผ่อนตรงนี้ ช็อตสวมใส่จะขัดกับล็อกตัวเอง — แต่ผ่อนแบบเจาะจงเท่านั้น
 * ระบุอวัยวะที่อนุญาตชัดเจน พร้อมข้อบังคับเรื่องกายวิภาค และย้ำว่าสินค้าต้องไม่เปลี่ยนรูป
 */
/**
 * ล็อกฉบับ "ช็อตใช้งานจริง" — มือได้ทำงาน แต่ห้ามมีคนโผล่
 *
 * ล็อกปกติมีสามประโยคที่บังคับหน้าตาแบบ "ภาพแคตตาล็อก" ไว้ ซึ่งขัดกับแนวที่ลูกค้าขอตรงๆ:
 *   1. "the product is the moving subject while all five fingers keep the same grip points"
 *      → ห้ามมือทำงาน ทั้งที่ช็อตนี้ทั้งช็อตคือมือทำงาน
 *   2. "Keep the front face toward camera"
 *      → บังคับให้หันฉลากเข้ากล้องตลอด ขัดกับการขัด/เช็ด/ฉีดตามธรรมชาติ
 *   3. "the front label remains readable throughout"
 *      → ช็อตขัดพื้นที่ฉลากอ่านออกตลอดเวลาคือช็อตที่ไม่มีใครขัดพื้นจริง
 *
 * ผ่อนสามข้อนี้เฉพาะช็อตใช้งาน แล้ว "แลก" ด้วยข้อห้ามใหม่ที่เข้มกว่าเดิม:
 * ห้ามใบหน้า/ศีรษะ/ลำตัว/คนทั้งตัว ซึ่งล็อกเดิมไม่เคยมี — เจ้าของสั่งว่าเห็นได้แค่มือ
 *
 * ⚠️ สิ่งที่ยัง "ไม่" ผ่อนและห้ามผ่อนเด็ดขาด: สี รูปทรง วัสดุ การเขียนฉลากใหม่
 * ด้านที่ไม่เคยเห็น ของใหม่เข้าเฟรม และจำนวนมือ — ทั้งหมดยังล็อกเท่าเดิม
 */
/**
 * ประโยคชี้เฉพาะของล็อกฉบับผ่อน — ใช้เป็น "ลายเซ็น" ให้ด่านตรวจคลิปรู้ว่าช็อตนี้เป็นช็อตใช้งาน
 *
 * ใช้วิธีอ่านจากพรอมต์จริงแทนการเก็บ flag ใหม่ใน DB เพราะ flag กับพรอมต์หลุดจากกันได้
 * (แก้ตัวใดตัวหนึ่งแล้วลืมอีกตัว) ส่วนลายเซ็นนี้มาจากพรอมต์ที่ส่งเข้า Flow จริงเสมอ
 */
const DEMO_LOCK_SIGNATURE = 'It is actively using the product on ';

/** ช็อตนี้เป็นช็อตใช้งานจริงหรือไม่ — ด่านตรวจคลิปใช้ตัดสินว่าจะผ่อนเกณฑ์ให้ไหม */
export function isDemoShotPrompt(prompt = ''): boolean {
  return prompt.includes(DEMO_LOCK_SIGNATURE);
}

function demoIdentityLock(demo: DemoAction): string {
  // จำนวนมือต้องตรงกับที่ท่าต้องใช้จริง ไม่ใช่ตรงกับที่เราอยากให้เป็น (บทเรียนจาก job_147)
  const handClause = demo.hands === 2
    ? 'Exactly two natural adult female hands are visible for the whole clip and no more.'
    : 'Exactly one natural adult female hand is visible for the whole clip.';
  const extraLimbClause = demo.hands === 2
    ? 'No third hand, no extra arm and no new fingers may enter, and each wrist keeps exactly the jewellery it started with — never duplicate a bracelet or ring onto another wrist.'
    : 'No second hand, other hand, pair of hands or new fingers may enter.';

  return PRODUCT_IDENTITY_LOCK
    // ช็อตใช้งานบางท่า "ต้อง" เปลี่ยนของในมือจริงๆ (ดึงกระดาษออกจากซอง หยิบสำลี)
    // ถ้าไม่ผ่อนตรงนี้ ล็อกจะห้ามสิ่งที่ท่าในบรรทัดถัดไปสั่งให้ทำ = บั๊กแบบ job_147 อีกรอบ
    // แต่ยัง "ไม่" ผ่อนข้อซองในฉากหลัง เพราะไม่มีท่าไหนต้องออกแบบซองใหม่
    .replace(
      'The hand keeps holding the exact same object it holds in the first frame — never swap it for a different item, never exchange a pack for its contents, and never open, unwrap or empty it.',
      'What the hand holds may change only in the one way the action below describes, and only as a real continuous motion the viewer can follow; never cut to a different item.'
    )
    .replace(
      'Keep the front face toward camera; never show an unseen side, never invent unseen parts.',
      'The product may tilt and turn naturally with the action; never show an unseen side, never invent unseen parts.'
    )
    .replace(
      'Exactly one natural adult female hand is visible for the whole clip.',
      handClause
    )
    .replace(
      'It only supports the product: the product is the moving subject while all five fingers keep the same grip points, shape and spacing in every frame.',
      `${DEMO_LOCK_SIGNATURE}${demo.scene}. Every finger stays anatomically correct and the same throughout; the grip may move only as the action requires.`
    )
    .replace(
      'No second hand, other hand, pair of hands or new fingers may enter.',
      `${extraLimbClause} Never show a face, head, hair, torso, legs or any other part of a person — hands and forearms are the only body parts allowed in frame.`
    )
    .replace(
      'The product keeps the exact same way up for the whole clip; never flip or re-orient it.',
      'The product stays the same way up apart from the tilt the action needs; never flip it.'
    )
    // ⚠️ ล็อกทั้งก้อนสั่งว่า "คงทุกอย่างให้เหมือนเดิม" ซึ่งขัดกับหัวใจของช็อตนี้ตรงๆ
    // job_147: ท่าสั่งให้น้ำที่หกหายไป แต่ล็อกสั่งให้ฉากคงเดิม → น้ำไม่มีวันหาย
    // คนดูเลยเห็นแค่มือขยับไปมาบนเคาน์เตอร์ที่ยังเปียกเท่าเดิมตอนจบ
    // ต้องบอกให้ชัดว่า "สิ่งที่ท่าสั่งให้เปลี่ยน" คือข้อยกเว้นที่บังคับ ไม่ใช่ความผิดพลาด
    // ⚠️ ข้อความต้นทางต้องตรงกับ PRODUCT_IDENTITY_LOCK เป๊ะ ไม่งั้น .replace() เงียบไปเฉยๆ
    // แล้วช็อตใช้งานจะได้ล็อกฉบับเข้มมาแทนโดยไม่มีใครรู้ — แก้ประโยคกล้องต้องแก้คู่กันเสมอ
    .replace(
      'Camera holds steady, pushes in, pulls back or tilts a few degrees; the entire product, including its cap or pump, stays fully inside frame while the camera is wide, and the front label is readable in the opening seconds; never orbit around it or circle to another side.',
      'Camera holds steady, pushes in or follows the action closely, and may tilt a few degrees, but never orbits the product. The product stays fully inside frame. The label may fall out of focus or be partly hidden while the product works — that is expected — but never re-letter or redraw it. '
      + `By the last frame the scene MUST have visibly changed in exactly one way: ${demo.result}. That change is the point of the shot and is required — it is not a continuity error. Nothing else in the scene may change, and the clip must not return to how it began. `
      // 🐛 job_148: ซองสินค้าที่วางอยู่บนชั้นในฉากหลังถูกออกแบบใหม่กลางคลิป — ของจริงเป็น
      // ลายยีราฟการ์ตูน แต่ในคลิปกลายเป็นซองที่มีรูปถ่ายหน้าเด็กกับเลข 35 และไอคอนคนละชุด
      // (Codex ยืนยันจากรูปต้นฉบับแล้วว่าไม่มีใบไหนเป็นแบบนั้น) และมีขวดปั๊มสีเหลืองโผล่
      // กลางชั้นวางช่วงวินาทีที่ 9 ทั้งที่ช็อตแรกไม่มี
      // ล็อกเดิมพูดถึงแต่ "ตัวสินค้าที่ถืออยู่" ไม่เคยพูดถึงของที่อยู่ข้างหลังเลย
      + 'Every other copy of this product sitting in the background keeps the exact same packaging artwork, colours and text as in the first frame — never redesign, re-illustrate or re-letter them, and never swap a cartoon for a photo. Nothing new may appear anywhere in the scene, including on shelves behind the action.'
    )
    // ท่าที่ต้องใช้ของเพิ่ม (สำลี ผ้า) ชนกับ "no new objects entering frame" ในล็อกเอง
    // ถ้าไม่ผ่อนตรงนี้ พรอมต์จะสั่งขัดกันแบบเดียวกับบั๊กมือเป็นประธานใน job_146
    .replace(
      'No duplicates and no new objects entering frame.',
      // ประโยคเดิมลอกมาจากช็อตสวมใส่ซึ่งกรรมเป็นอวัยวะเสมอ พอ prop เป็นกระดาษหนึ่งแผ่น
      // มันเลยอ่านว่า "กระดาษที่มีกายวิภาคถูกต้องและไม่มีแขนขาเกิน" ซึ่งเป็นภาษาที่ไม่มีความหมาย
      // แยกเป็นสองประโยคแทน ให้ข้อกายวิภาคมีผลเฉพาะกับอวัยวะที่อยู่ในลิสต์จริงๆ
      demo.prop
        ? `No duplicates and no new objects entering frame except ${demo.prop}. Any body part among those stays anatomically correct with no extra limbs.`
        : 'No duplicates and no new objects entering frame.'
    );
}

function identityLockFor(wear: WearAction | null): string {
  if (!wear) return PRODUCT_IDENTITY_LOCK;
  return PRODUCT_IDENTITY_LOCK.replace(
    'No duplicates and no new objects entering frame.',
    `No duplicates and no new objects entering frame except one ${wear.bodyPart} wearing the product — `
    + `it stays anatomically correct with ${wear.digits}, natural skin, and no extra limbs. `
    + `The product keeps its exact shape, colors and printed details while worn, and stays fully visible.`
  );
}

/**
 * ⚠️ ฉลากต้องถูกล็อกในคลิปต่อเนื่องด้วย ห้ามตัดทิ้งพร้อม PRODUCT_IDENTITY_LOCK
 *
 * job #124 (ทิชชู่ BANPHAI): คลิปที่ออกมาเปลี่ยนฉลากเป็นคำมั่วทั้งใบ —
 * "บ้านไผ่ รู้ใจคนรักความสะอาด" กลายเป็น "Brapt Cemual" และ "L 420" กลายเป็น "L x2G"
 * ทั้งที่รูปตั้งต้นถูกต้อง
 *
 * สาเหตุ: buildFlowContinuationPrompt() ตัด PRODUCT_IDENTITY_LOCK ออกทั้งก้อนเพื่อย่อ
 * พรอมต์ ประโยค "never re-letter the label" จึงหายไปกับมันด้วย คลิปต่อเนื่องเลยไม่เคย
 * ได้รับคำสั่งห้ามเขียนฉลากใหม่เลยสักครั้ง เหลือแค่ "Same product" ซึ่งกว้างเกินจะกันได้
 *
 * ประโยคนี้สั้นพอจะไม่กินโควตาพรอมต์ แต่พูดสิ่งที่ต้องพูดครบ และย้ำว่า "ห้ามจัดให้อ่านง่ายขึ้น"
 * เพราะนั่นคือข้ออ้างที่โมเดลใช้เขียนฉลากใหม่ตอนตัวหนังสือในเฟรมเดิมดูเอียงหรืออ่านยาก
 */
const CONTINUATION_LABEL_LOCK = 'Every letter, number, line and small print on the label stays exactly as it is in that frame — never re-letter, re-spell, re-position, straighten or tidy up label artwork, even if it looks rotated, blurred or hard to read. Thai text stays Thai script; never redraw it as Chinese, Japanese or Latin lookalike characters. The product keeps the same shape and the same way up.';

/**
 * ดึงเฉพาะ "ท่าที่สั่งให้ทำ" ออกจาก motion prompt โดยตัดล็อกความเหมือนทิ้ง
 *
 * ใช้บอกคนเขียนบทว่าช็อตนั้นตั้งใจให้เกิดอะไรขึ้น — job_134: คลิปโชว์การเปิดตัวหนีบ
 * แต่บทพูดเรื่องปรับแรงลม 3 ระดับกับหมุน 360° เพราะคนเขียนบทเห็นแต่วิดีโอ
 * ไม่เคยรู้ว่าช็อตนี้ถูกสั่งให้ทำท่าอะไร เลยหยิบสเปกที่ขายดีที่สุดมาพูดแทน
 */
export function describeMotionAction(prompt: string): string {
  return prompt
    .replace(/^Continuity lock:[\s\S]*?sound effects\.\s*/i, '')
    .replace(/^Continue from the previous final frame\.[\s\S]*?no dialogue or music\.\s*/i, '')
    .replace(/^Continue the exact frame\.\s*/i, '')
    // ไทม์ไลน์กล้องต้องไม่ไปถึงคนเขียนบท — บทที่บรรยายกล้องตกด่าน CAMERA_NARRATION ทุกครั้ง
    // (job_129 เคยได้บท "กล้องค่อยๆ เลื่อนเข้าไปใกล้" มาแล้ว) คนเขียนบทต้องรู้แค่ว่า
    // "ในช็อตนี้สินค้าทำอะไร" ไม่ใช่ "กล้องอยู่ตรงไหนวินาทีไหน"
    .replace(/\s*Camera timeline across the 8 seconds[\s\S]*$/i, '')
    .trim();
}

/** A short continuation instruction for Flow clips 2 and 3. */
export function buildFlowContinuationPrompt(basePrompt: string): string {
  const action = basePrompt.replace(
    /^Continuity lock:[\s\S]*?Silent footage:[\s\S]*?sound effects\.\s*/i,
    ''
  );
  return `Continue from the previous final frame. Same product, hand, framing, light and background. ${CONTINUATION_LABEL_LOCK} No reset or new objects. Silent footage; no dialogue or music. ${limitPromptWords(action)}`;
}

/**
 * @param wear ถ้าสินค้าเป็นหมวดที่สวมใส่ได้ ช็อตที่ 2 เป็นต้นไปจะถูกบังคับให้เห็นการสวมใส่จริง
 *   (ช็อตแรกยังเป็นช็อต hero ถือโชว์เหมือนเดิม เพราะต้องให้คนดูเห็นตัวสินค้าเต็มๆ ก่อน)
 * @param demo ถ้าสินค้าเป็นหมวดที่มีท่าใช้งานชัด ช็อตที่ 2 เป็นต้นไปจะกลายเป็นช็อตใช้งานจริง
 *   ในที่ที่สินค้าถูกใช้ พร้อมล็อกฉบับผ่อน (ดู demoIdentityLock)
 *
 * ⚠️ ช็อตแรกยังเป็น hero เสมอทั้งสองโหมด และยังใช้ล็อกเต็มเหมือนเดิม — ตั้งใจไว้แบบนี้
 * เพราะด่านเทียบเฟรมแรกกับรูปอ้างอิงยืนอยู่บนสมมติฐานว่าฉลากอ่านออก ถ้าเปลี่ยนช็อตแรก
 * เป็นช็อตใช้งานด้วย ด่านจะตีตกคลิปที่ถูกต้องแล้วเราจ่ายเครดิตทิ้ง (เจ้าของเลือก
 * "ผ่อนเฉพาะช็อตใช้งาน" ไว้เมื่อ 31 ก.ค.)
 */
export function applyProductIdentityLock(
  prompts: string[],
  wear: WearAction | null = null,
  demo: DemoAction | null = null
): string[] {
  return prompts.map((prompt, index) => {
    const safe = sanitizeProductMotionPrompt(prompt, index);
    const demonstrated = ensureLaterShotDemonstrates(safe, index);
    // ปล่อยให้ Gemini วางช็อตสวมใส่มาเองก่อน — บังคับเฉพาะตอนที่มันไม่ได้วางมา
    const needsWearShot = Boolean(wear) && index > 0 && !ALREADY_WEARING.test(demonstrated);
    if (needsWearShot) {
      logger.info(`👟 ช็อต ${index + 1} เปลี่ยนเป็นช็อตสวมใส่จริง (${wear!.bodyPart})`);
    }
    // ช็อตสวมใส่มาก่อน เพราะสำหรับรองเท้า/ถุงเท้า "การสวม" คือท่าใช้งานที่ตรงกว่า
    const needsDemoShot = !needsWearShot && Boolean(demo) && index > 0;
    if (needsDemoShot) {
      logger.info(`🧽 ช็อต ${index + 1} เปลี่ยนเป็นช็อตใช้งานจริง — ${demo!.result}`);
    }
    // ไทม์ไลน์กล้องต่อท้ายเสมอ — อ้างถึงท่าที่เพิ่งสั่งไป และต้องไม่โดน limitPromptWords ตัด
    if (needsDemoShot) {
      return `${demoIdentityLock(demo!)} ${limitPromptWords(`Continue the exact frame. ${demo!.action}`)} ${cameraTimeline('demo')}`;
    }
    const action = needsWearShot ? `Continue the exact frame. ${wear!.action}` : demonstrated;
    // ช็อตสวมใส่มีการกระทำเกิดขึ้นจริงเหมือนช็อตใช้งาน จึงใช้ไทม์ไลน์เดียวกัน
    // ส่วนช็อต hero (ถือโชว์) ใช้ไทม์ไลน์ที่กล้องเป็นคนเล่าเรื่องแทน
    const timeline = cameraTimeline(needsWearShot ? 'demo' : 'hero');
    return `${identityLockFor(index > 0 ? wear : null)} ${limitPromptWords(action)} ${timeline}`;
  });
}
