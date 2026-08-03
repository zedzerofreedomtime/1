import { config } from '../config.js';
import { logger, logEvent } from '../utils/logger.js';
import type { GeminiVisionResult, NarrationRepair, NarrationSnapshot, SubtitleSegment } from '../types.js';
import {
  evaluateThaiNumberWords,
  limitThaiPhrase,
  spokenLength,
  THAI_DIGIT_WORDS,
  THAI_SCALE_WORDS,
  trimToCompleteThaiEnding,
} from './thai-text.js';

// barrel: ผู้เรียกเดิม import ตัวช่วยข้อความไทยจากไฟล์นี้ได้เหมือนเดิม
export { limitThaiPhrase, spokenLength, trimToCompleteThaiEnding } from './thai-text.js';

/**
 * กฎของ "บทพากย์" ทั้งหมด — ความยาว เพศเสียง การจัดบทให้ตรงคลิป และด่านตรวจก่อนใช้จริง
 *
 * รวมไว้ที่เดียวเพราะเวลาปรับโทนบท มักต้องแก้หลายอย่างพร้อมกัน (ความยาว + คำต้องห้าม
 * + ประโยคสำรอง) ถ้ากระจายอยู่คนละไฟล์จะแก้ไม่ครบแล้วเกิดกฎขัดกันเอง
 */
/**
 * ความเร็วพูดของ edge-tts เสียงไทย (คำ/วินาที) — วัดจากของจริงที่ rate +0%
 * ใช้ประเมินว่าบทพากย์ควรยาวกี่คำถึงจะเต็มคลิปพอดี
 */
// Gemini TTS ภาษาไทยวัดจากงานจริงได้ราว 5.8 ตัวอักษรที่ออกเสียง/วินาที
// การนับ "คำ" ใช้กับภาษาไทยไม่ได้ เพราะภาษาไทยไม่เว้นวรรคทุกคำ และเคยทำให้
// บท 24 วินาทียาวจริง 34.6 วินาที ก่อนถูก FFmpeg ตัดกลางประโยค
// ยกความยาวบท: เดิม 44/52/64 ทำให้พูดจบ ~5.2s ในคลิป 8s → dead air ~2.2s ท้ายทุกคลิป
// (พบใน job_58 ช่วง 5-8s และ 13-16s) ที่ ~10 อักษรออกเสียง/วินาที บทควรยาว ~68 ตัว
// จึงพูดเต็ม ~6.8-7s แล้วเหลือหายใจแค่ ~0.6-1s
// ยกอีกรอบ (job_83): 66-78 ยังสั้นไป — วัดจริงได้ speech ~5.5s ในช่อง 8s → หางเงียบ 1.2s
// และ atempo ยืดต่อไม่ได้เพราะชนเพดาน 0.82 (ยืดกว่านี้เสียงยาน) ที่ ~11-12 อักษร/วินาที
// ต้องยาว ~86-100 ตัวถึงจะพูดเต็ม ~7-7.3s แล้วเหลือหายใจ 0.6-1s ตามเป้า
export const MIN_NARRATION_CHARS_PER_CLIP = 88;
// Video-understanding often answers more tersely than the upfront planner.
// Target a little more speech so measured TTS audio clears the 65% coverage gate.
// พบใน job_58 re-render: คลิป 2 ได้ 64 ตัว แต่ Gemini TTS พูดเร็ว (~11.4 ตัว/วิ)
// → speech แค่ 5.2s เหลือ dead air 2.2s. ยก floor เป็น 68 เพื่อบังคับประโยคยาวพอ
// (ถ้า Gemini ยังสั้นหลัง retry → ensureMinimumNarration เติมประโยคปลอดภัยให้ถึง 68)
// job_131: ยังเหลือเงียบ 0.48s คร่อมรอยต่อ เพราะเสียงพูดจริงจบที่ 7.56s แล้วยืดต่อไม่ได้
// (atempo ชนเพดานล่าง 0.82 — ยืดกว่านี้เสียงยาน) การลดหางเงียบในโค้ดจึงไม่ช่วยอะไรเลย
// ตัวคุมจริงคือ "ความยาวบท" ไม่ใช่ค่า padding → ยกพื้นบทขึ้นให้พูดเต็มช่องเองตั้งแต่แรก
export const MIN_VIDEO_NARRATION_CHARS_PER_CLIP = 90;
export const MAX_NARRATION_CHARS_PER_CLIP = 108;

/**
 * ความยาวสูงสุดของซับ 1 ช่วง = 2 บรรทัดเต็ม
 * เกินกว่านี้ตอนเบิร์นลงคลิปจะกลายเป็น 3-4 บรรทัดบังจอ
 */
// One subtitle segment is also the narration for one clip. Keep both length
// constraints identical; generateSRT() wraps the Thai text into display lines.
export const MAX_SUB_CHARS = MAX_NARRATION_CHARS_PER_CLIP;

// ประโยคสำรอง/ต่อเติม — ต้องยาว >= MIN_VIDEO_NARRATION_CHARS_PER_CLIP (88) และ <= MAX (100)
// จบประโยคสมบูรณ์ (ไม่ลงท้ายคำเชื่อม) เพื่อใช้เดี่ยวๆ ได้โดยไม่ต้อง pad ซ้ำจนตัดกลางวลี
//
// ⚠️ ชุดเดิมคือต้นตอบทที่เจ้าของไม่ชอบใน job_77 ("ลองดูรูปทรงและรายละเอียดของจริง",
// "จุดต่างๆ บนตัวสินค้า...ตรงกับแบบที่มองหา") — บทสั้นเมื่อไหร่ระบบจะเติมพวกนี้ให้
// ชุดใหม่ต้องเป็นโทนขายเชิงบวก + มีคำชวนปิดท้าย และห้ามชนกฎ DESCRIPTIVE_NARRATION
// ⚠️ ห้ามมีคำใน SOURCE_REQUIRED_CLAIMS อยู่ในประโยคสำรอง — ไม่งั้นตอนเอาไปซ่อมบท
// จะตกด่าน "อ้างเกินข้อมูล" ซ้ำอีก (เดิมประโยคนี้มีคำว่า "ทนทาน" ใช้ซ่อมไม่ได้เลย)
//
// ⚠️ และห้ามใช้ "ใช้ง่าย / ใช้ดี / ใช้งานได้จริง / ใช้สะดวก" ด้วย (30 ก.ค. 2026)
// ชุดเดิมมีคำพวกนี้ครบทั้งสามบรรทัด ซึ่งขัดกับกฎคำกริยาที่ระบบสั่ง Gemini ไว้เอง
// = ห้ามโมเดลพูด แต่พอบทสั้นเมื่อไหร่โค้ดก็เติมคำต้องห้ามให้ซะเอง
// เจ้าของจับได้จาก job #128: "ตัวนี้คุณภาพดีเกินราคา ใช้งานได้จริงในชีวิตประจำวัน"
// → ชุดใหม่ต้อง "ผ่านกฎของตัวเอง" ไม่ใช่แค่ยาวพอ (มี regression รันกฎจริงกับทุกบรรทัด)
export const SAFE_NARRATION_EXTENSIONS = [
  'ของถึงมือแล้วประทับใจกว่าที่คิดไว้เยอะเลยค่ะ งานเก็บรายละเอียดเรียบร้อยสวยงาม คุ้มกับราคาที่จ่ายไปจริงๆ นะคะ',
  'ราคาเท่านี้ถือว่าได้เกินคุ้มไปมากเลยค่ะ หยิบมาไว้ติดบ้านสักชิ้นก็ดี จะซื้อฝากคนที่บ้านก็ถูกใจแน่นอนนะคะ',
  'บอกเลยว่าคุ้มค่าเกินราคาไปมากจริงๆ ค่ะ ถูกใจตั้งแต่ครั้งแรกที่ได้ลอง สนใจกดเข้าไปสั่งซื้อกันได้เลยนะคะ',
];

/**
 * ตาข่ายจับ "บททั้งท่อนกลายเป็นประโยคสำรอง" โดยไม่มีใครรู้
 *
 * 🐛 job_146 (โทนเนอร์ Iblanc): บทวางล่วงหน้าทั้งสองท่อนเท่ากับ SAFE_NARRATION_EXTENSIONS[0]
 * และ [1] แบบตัวอักษรต่อตัวอักษร ทั้ง 16 วินาทีไม่มีคำว่าโทนเนอร์/รักแร้/200ml เลยสักคำ
 * ทั้งที่ review_text มีของให้ใช้ครบ — แต่ `narrationRepairs` เป็น [] จึงไม่มี log อะไรเตือน
 *
 * เพราะเส้นทาง "เติมบทให้ยาวพอ" (ensureMinimumNarration / fitCompleteNarration) หยิบ
 * ประโยคสำรองมาใช้โดยไม่นับเป็น repair — logNarrationRepairs() เลยไม่มีอะไรให้พิมพ์
 *
 * ⚠️ ตัวนี้ "รายงาน" อย่างเดียว ไม่แก้บท เพราะยังไม่รู้ว่าบทสั้นมาจากต้นทางหรือถูกด่านตัด
 * ต้องมีหลักฐานจาก log ก่อนถึงจะตัดสินใจว่าจะ retry Gemini หรือแก้ที่ตัวด่าน
 * (งาน #146 รอดเพราะเส้นทางดูวิดีโอเขียนบทใหม่ทับให้ แต่เส้นทางนั้น catch แล้วถอยกลับมา
 * ใช้บทวางล่วงหน้าได้ ถ้าถอยเมื่อไหร่ประโยคสำรองจะออกอากาศทันทีโดยไม่มีสัญญาณเตือน)
 */
export const SAFE_FILLER_ALERT_RATIO = 0.5;

export function safeFillerRatio(text: string): number {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  const total = spokenLength(cleaned);
  if (!total) return 0;
  const filler = SAFE_NARRATION_EXTENSIONS
    .filter((line) => cleaned.includes(line))
    .reduce((longest, line) => Math.max(longest, spokenLength(line)), 0);
  return Math.min(filler / total, 1);
}

export function auditSafeNarrationFallback(segments: SubtitleSegment[]): NarrationRepair[] {
  const repairs: NarrationRepair[] = [];
  segments.forEach((segment, clipIndex) => {
    const ratio = safeFillerRatio(segment.text);
    if (ratio < SAFE_FILLER_ALERT_RATIO) return;
    repairs.push({
      clipIndex,
      rule: 'filler_only_narration',
      strategy: 'safe_padding',
      // ต้นฉบับถูกทิ้งไปตั้งแต่ในตัวเติมแล้ว ตรงนี้จึงรู้แค่ผลลัพธ์ — ไม่เดาว่าเดิมเขียนว่าอะไร
      repairedFrom: '',
      replacement: segment.text,
      reasons: [`ประโยคสำรองกินพื้นที่บท ${Math.round(ratio * 100)}% ของคลิปนี้`],
    });
  });
  return repairs;
}

export function logNarrationRepairs(jobId: number, repairs: NarrationRepair[]): void {
  for (const repair of repairs) {
    const action = repair.strategy === 'gemini_rewrite'
      ? 'ถูก Gemini เขียนใหม่โดยตัดคำอ้างที่ไม่มีต้นทาง'
      : repair.strategy === 'safe_padding'
        ? 'เป็นประโยคสำรองแทบทั้งท่อน ไม่มีข้อมูลสินค้าเลย'
        : 'ถูกแทนด้วยประโยคสำรอง';
    logEvent({
      source: 'gemini',
      stage: 'narration.repair',
      level: 'warn',
      jobId,
      clipIndex: repair.clipIndex,
      message: `บทคลิป ${repair.clipIndex + 1} ${action} เพราะกฎ ${repair.rule}`,
      meta: {
        rule: repair.rule,
        strategy: repair.strategy,
        reasons: repair.reasons,
        repairedFrom: repair.repairedFrom,
        replacement: repair.replacement,
      },
    });
  }
}

// ⚠️ บัญชีดำนี้ไล่คำไม่ทันโดยธรรมชาติ — ใช้เป็น "ตัวช่วย" เท่านั้น ห้ามใช้เป็นตัวตัดสินหลัก
//
// 🐛 job_155: บทที่ออกอากาศจบด้วย "...ช่วยให้รีดผ้าได้ลื่นไหลไม่มี" ซึ่งค้างกลางวลีชัดเจน
// แต่คำว่า "ไม่มี" ไม่อยู่ในลิสต์ จึงผ่านไปได้ — เหมือน job_102 ที่คำว่า "ใช้" ก็ไม่อยู่ในลิสต์
// คอมเมนต์ของ job_102 สรุปไว้เองแล้วว่าต้องเปลี่ยนเป็น "วิธีบวก: ต้องจบที่คำลงท้าย/เครื่องหมาย"
// ซึ่งมีอยู่จริงใน endsWithCompleteThaiPhrase() ข้างล่าง แต่ตรงนี้ยังไม่เคยเรียกใช้
const INCOMPLETE_THAI_ENDING = /(?:จะได้|กำลัง|เพราะ|เพื่อ|ที่|ซึ่ง|และ|หรือ|แต่|กับ|ของ|ช่วย|ถ้า|เวลา|แบบ|เรื่อง|ตรง|ประมาณ)$/;

/**
 * "จบสมบูรณ์ไหม" แบบวิธีบวก — ต้องลงท้ายด้วยคำลงท้ายจริงหรือเครื่องหมายวรรคตอนเท่านั้น
 *
 * ตรงข้ามกับบัญชีดำ: บัญชีดำต้องรู้จักคำผิดทุกคำถึงจะจับได้ ส่วนวิธีนี้รู้แค่ "คำที่ถูก"
 * ซึ่งภาษาไทยมีไม่กี่คำและไม่เพิ่มขึ้นตามสินค้าใหม่ จึงไม่มีทางไล่ไม่ทัน
 */
export function endsWithCompleteThaiPhrase(text: string): boolean {
  return /(?:ค่ะ|คะ|ครับ|จ้า|นะคะ|[.!?。！？])$/u.test(text.trim());
}
const CAMERA_NARRATION = /พลิก|หัน|ชี้|ขยับ|มุมกล้อง|เฟรม|ช็อต|กล้อง|ฉลาก.{0,8}(?:เห็น|ชัด)/u;
// บท "บอกลักษณะ/ให้ไปดูรูปทรง" แทนการรีวิวขาย (job_77: "ลองดูรูปทรงและรายละเอียดของจริง",
// "จุดต่างๆ บนตัวสินค้า ช่วยให้เช็กได้ว่าตรงกับแบบที่มองหา") — เกิดเมื่อ prompt สายดูวิดีโอ
// ดันให้บรรยายภาพแทนหยิบรีวิวมาขาย จับให้ตกด่านแล้ว retry ให้เขียนแบบคนใช้จริงแนะนำ
// จับ "ชวนไปดู/ตรวจลักษณะสินค้า" แบบเจาะจง — ไม่ชน CTA ปกติอย่าง "กดดูรายละเอียด(ที่ตะกร้า)"
const DESCRIPTIVE_NARRATION = /ดูรูปทรง|รูปทรงและรายละเอียด|รายละเอียดของจริง|ของจริงให้ครบ|จุดต่าง\s*ๆ\s*บน|ตรงกับแบบที่.{0,8}มองหา/u;
// เคลมทางยา/สรรพคุณที่ผิด พ.ร.บ.อาหาร + อย. สำหรับผลิตภัณฑ์เสริมอาหาร
// (ห้ามอ้างรักษาโรค บำรุงอวัยวะ ปรับระบบร่างกาย เสริมภูมิ ฮอร์โมน ฯลฯ)
// ขยายให้ครอบคำจากสเปกสินค้าจริงที่เจ้าของส่งมา 22 ก.ค. — กันหลุดลง Flow/TTS เด็ดขาด
// ⚠️ "รักษา" กับ "ความดัน" เดี่ยวๆ กว้างเกินไป — job_100 (น้ำยาเคลือบยางรถ) ตกด่านนี้
// เพราะข้อมูลสินค้าเขียนว่า "รักษายางรถยนต์" ซึ่งแปลว่าถนอม ไม่ใช่รักษาโรค
// ทำให้บททั้งใบถูกทิ้งแล้วตกไปใช้ประโยคสำรองกลางๆ ที่ไม่มีข้อมูลสินค้าเลย
// แก้เป็น: "รักษา" ต้องตามด้วยบริบทสุขภาพ / "ความดัน" ต้องไม่ใช่ความดันลม-น้ำ-อากาศ
// ชื่อโรคเดี่ยวๆ (โรค ภูมิแพ้ อักเสบ เบาหวาน ฯลฯ) ยังจับได้เหมือนเดิม จึงไม่ได้อ่อนลงจริง
const MEDICAL_CLAIM = /รักษา(?=.{0,8}(?:โรค|อาการ|ผู้ป่วย|แผล|สิว|ฝ้า|ผื่น|อักเสบ|ภูมิ))|หายขาด|บรรเทา|แก้.{0,4}(?:โรค|อาการ)|ภูมิแพ้|โรค|ป่วย|อักเสบ|ภูมิคุ้มกัน|ภูมิต้านทาน|เสริมภูมิ|ภูมิตก|ฮอร์โมน|ไทรอยด์|ต่อมไร้ท่อ|บำรุง(?:ปอด|หัวใจ|ตับ|ไต|สมอง|เลือด)|ปอด|ทางเดินหายใจ|หายใจโล่ง|เสมหะ|ไหลเวียน|เผาผลาญ|ชะลอ(?:ความเสื่อม|วัย|ความแก่)|อนุมูลอิสระ|รูมาตอยด์|เกาต์|เก๊าท์|ปวด(?:ข้อ|เข่า|หลัง|เมื่อย|กระดูก)|ข้อเสื่อม|เบาหวาน|ความดัน(?!ลม|น้ำ|อากาศ)|มะเร็ง|ริดสีดวง|ฝี|ไมเกรน|นอนไม่หลับ|ท้องผูก|กรดไหลย้อน/u;
// คำลงท้ายบอกเพศผู้พูด — ใช้ตรวจว่าเพศเสียงปนกันข้ามคลิปไหม (#45: คลิป1 "ครับ" คลิป2 "ค่ะ")
const MALE_PARTICLE = /ครับ/;
const FEMALE_PARTICLE = /ค่ะ|นะคะ|ค่า/;
// เสียง Gemini TTS ที่เป็นผู้หญิง — ใช้ตัดสินว่าคำลงท้ายบทต้องเป็น ค่ะ หรือ ครับ
// ให้ตรงกับเสียงที่พูดจริง (ค่าเริ่มต้นของงานนี้ pin ไว้ที่ Aoede = หญิง)
const FEMALE_TTS_VOICES = new Set(['aoede', 'kore', 'leda']);
// ต้องตรงกับองศาที่ prompt-generator/motion-prompts สั่งจริง ไม่งั้นบทตกด่านทุกใบ
// (27 ก.ค. 2026: ลดการหมุน 20° → 8° เพื่อกันฉลากเพี้ยน แต่ลืมแก้ตัวตรวจ ทำให้ job_99-101
//  ตกด่าน "ต้องระบุมุมพลิก 18-30°" ทุกงาน แล้วตกไปใช้บทสำรองกลางๆ ที่ไม่มีข้อมูลสินค้าเลย)
const REQUIRED_PIVOT_ANGLE = /\b(?:[5-9]|1[0-2])[\s-]*(?:degrees?|°)/i;
// ใช้ตัวเดียวกับที่ motion-prompts บังคับจริง — ประกาศแยกสองที่คือทางที่ job #128 พัง
// Claims that cannot be proven from appearance alone. This gate applies to
// every product category, not only supplements or eyewear. A claim is allowed
// only when the title, review or an approved product brief states it explicitly.
export const SOURCE_REQUIRED_CLAIMS = [
  'แข็งแรง', 'ทนทาน', 'น้ำหนักเบา', 'ใส่สบาย', 'ไม่กด', 'พกพาง่าย',
  'กันน้ำ', 'ป้องกันน้ำ', 'กันยูวี', 'ป้องกันยูวี', 'กรองแสง', 'ตัดแสง',
  'ปรับสายตา', 'ปลอดภัย', 'ไร้สาร', 'ออร์แกนิก', 'ธรรมชาติ', 'ฆ่าเชื้อ',
  'ต้านแบคทีเรีย', 'ประหยัดไฟ', 'ชาร์จเร็ว', 'ใช้งานได้นาน', 'แบตอึด',
  'รองรับ', 'เข้ากันได้', 'ของแท้', 'รับประกัน', 'ไม่ระคายเคือง',
  // วัสดุ — job_134 พูดว่า "พลาสติกพีพีคุณภาพดี" ทั้งที่ชื่อสินค้าและรีวิวไม่เคยบอกวัสดุเลย
  // มองจากคลิปก็แยกไม่ออกว่าเป็นพลาสติกชนิดไหน จึงเป็นคำอ้างที่ต้องมีต้นทางเสมอ
  'พลาสติก', 'พีพี', 'พีวีซี', 'เอบีเอส', 'อะคริลิก', 'สแตนเลส', 'สเตนเลส',
  'อะลูมิเนียม', 'อลูมิเนียม', 'ทองเหลือง', 'ซิลิโคน', 'ไนลอน', 'โพลีเอสเตอร์',
  'ผ้าฝ้าย', 'หนังแท้', 'ไม้สัก', 'ยางพารา', 'เซรามิก',
];

// ── ด่านตัวเลขสเปก ────────────────────────────────────────────────────────
// 🐛 job_134: บทพูดว่า "น้ำหนักเพียงสองร้อยสิบสี่กรัม" ทั้งที่ไม่มีเลข 214 อยู่ในชื่อสินค้า
// รีวิว หรือ brief เลยสักที่ พรอมต์สั่งห้ามไว้แล้ว (ห้ามเดาตัวเลข/หน่วย) แต่โมเดลก็ยังทำ
// → กฎที่ "ขอร้อง" อย่างเดียวเอาไม่อยู่ ต้องมีด่านตรวจของจริงมาบังคับ
//
// ตรวจเฉพาะตัวเลขที่ตามด้วยหน่วย เพราะนั่นคือ "การอ้างสเปก" ที่คนดูเอาไปเทียบกับของจริงได้
// เลขลอยๆ ในสำนวน (เช่น "ครั้งแรก") ไม่ใช่คำอ้าง จึงไม่ควรไปบล็อกให้บทเสียเปล่า
const SPEC_UNITS = [
  'มิลลิกรัม', 'กิโลกรัม', 'กรัม', 'กิโล', 'ขีด', 'ออนซ์', 'ปอนด์',
  'มิลลิเมตร', 'เซนติเมตร', 'เซ็นติเมตร', 'เมตร', 'นิ้ว', 'ฟุต',
  'มิลลิลิตร', 'ลิตร', 'ซีซี', 'วัตต์', 'โวลต์', 'มิลลิแอมป์', 'แอมป์',
  'องศา', 'ระดับ', 'สปีด', 'โหมด', 'เปอร์เซ็นต์',
  'ชั่วโมง', 'นาที', 'วินาที', 'วัน', 'เดือน', 'ปี',
  'ชิ้น', 'เม็ด', 'แคปซูล', 'ซอง', 'แผ่น', 'ห่อ', 'ขวด', 'กล่อง', 'ใบ', 'คู่', 'บาท',
];

const THAI_NUMBER_WORDS = [...Object.keys(THAI_DIGIT_WORDS), ...Object.keys(THAI_SCALE_WORDS)]
  .sort((a, b) => b.length - a.length);


/** เก็บ "ตัวเลข + หน่วย" ที่บทพูดออกมา ทั้งแบบสะกดเป็นคำไทยและแบบเลขอารบิก */
function collectSpecClaims(text: string): { value: number; unit: string }[] {
  const claims: { value: number; unit: string }[] = [];
  let index = 0;
  while (index < text.length) {
    const words: string[] = [];
    let value: number | null = null;
    let cursor = index;

    const digits = text.slice(cursor).match(/^[\d,]+(?:\.\d+)?/);
    if (digits) {
      value = Number(digits[0].replace(/,/g, ''));
      cursor += digits[0].length;
    } else {
      // ไล่คำเลขไทยที่ติดกันเป็นชุดเดียว เช่น "สองร้อยสิบสี่" ต้องอ่านรวมกัน ไม่ใช่ทีละคำ
      for (;;) {
        const word = THAI_NUMBER_WORDS.find((candidate) => text.startsWith(candidate, cursor));
        if (!word) break;
        words.push(word);
        cursor += word.length;
      }
      if (words.length) value = evaluateThaiNumberWords(words);
    }

    if (value === null || Number.isNaN(value)) { index += 1; continue; }

    const rest = text.slice(cursor).replace(/^[\s​]*/, '');
    const unit = SPEC_UNITS.find((candidate) => rest.startsWith(candidate));
    if (unit) claims.push({ value, unit });
    index = cursor;
  }
  return claims;
}

/** ตัวเลขทุกตัวที่ "มีต้นทางรองรับ" — ทั้งเลขอารบิกในชื่อ/รีวิว และเลขที่สะกดเป็นคำไทย */
function collectSupportedNumbers(source: string): Set<number> {
  const numbers = new Set<number>();
  for (const match of source.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    const value = Number(match[0].replace(/,/g, ''));
    if (!Number.isNaN(value)) numbers.add(value);
  }
  let index = 0;
  while (index < source.length) {
    const words: string[] = [];
    let cursor = index;
    for (;;) {
      const word = THAI_NUMBER_WORDS.find((candidate) => source.startsWith(candidate, cursor));
      if (!word) break;
      words.push(word);
      cursor += word.length;
    }
    if (words.length) {
      numbers.add(evaluateThaiNumberWords(words));
      index = cursor;
    } else {
      index += 1;
    }
  }
  return numbers;
}

/** คืนรายการสเปกที่บทอ้างแต่ไม่มีต้นทางรองรับ (ว่าง = ผ่าน) */
export function findUnsupportedSpecNumbers(text: string, supportedFacts: string): string[] {
  const supported = collectSupportedNumbers(supportedFacts);
  return collectSpecClaims(text)
    .filter((claim) => !supported.has(claim.value))
    .map((claim) => `${claim.value} ${claim.unit}`);
}
export const MAX_COMPLIANCE_RETRIES = 2;


export class PromptComplianceError extends Error {
  constructor(public readonly violations: string[]) {
    super(`ผลลัพธ์ไม่ผ่านกฎขายสินค้า: ${violations.join('; ')}`);
    this.name = 'PromptComplianceError';
  }
}

// ── โมดูลที่แยกออกไปแล้ว ────────────────────────────────────────────────
// ไฟล์นี้ทำหน้าที่เป็นทางเข้าเดียว (barrel) ต่อไปด้วย ผู้เรียกเดิมจึงไม่ต้องแก้ import
// แม้โค้ดจะย้ายบ้านไปแล้ว
import { describesProductInUse } from './motion-prompts.js';
export { sanitizeProductMotionPrompt } from './motion-prompts.js';
export { applyProductIdentityLock, buildFlowContinuationPrompt } from './identity-lock.js';
export { parseGeminiVisionJson } from './json-parser.js';
export { compareGeneratedProductFidelity } from './fidelity-check.js';




export function ensureMinimumNarration(
  text: string,
  clipIndex: number,
  minimumChars = MIN_NARRATION_CHARS_PER_CLIP
): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (spokenLength(cleaned) >= minimumChars) return cleaned;
  const extension = SAFE_NARRATION_EXTENSIONS[Math.min(clipIndex, SAFE_NARRATION_EXTENSIONS.length - 1)];
  // ต่อได้พอดีไม่เกินเพดาน → ใช้ทั้งประโยค ไม่ต้องตัดอะไรเลย
  const combined = `${cleaned} ${extension}`.trim();
  if (spokenLength(combined) <= MAX_NARRATION_CHARS_PER_CLIP) return combined;
  // ต่อแล้วเกิน → ตัดให้จบประโยคสมบูรณ์ ไม่ใช่ตัดตรงเพดานแล้วทิ้งหางลอย
  const limited = trimToCompleteThaiEnding(
    limitThaiPhrase(combined, MAX_NARRATION_CHARS_PER_CLIP)
  );
  if (spokenLength(limited) > spokenLength(cleaned) && !INCOMPLETE_THAI_ENDING.test(limited)) {
    return limited;
  }
  // ตัดแล้วไม่ได้ยาวขึ้นจริง → เก็บบทเดิมที่ "จบสมบูรณ์" ไว้ดีกว่า
  // บทสั้นกว่าเกณฑ์นิดหน่อยยังฟังรู้เรื่อง แต่หางลอยกลางประโยคฟังแล้วสะดุดทันที
  return cleaned;
}

/**
 * ตัดบทเฉพาะตรงจบวลีที่สมบูรณ์ หากโมเดลเขียนยาวและจุดตัดลงท้ายด้วยคำเชื่อม
 * ให้ใช้ประโยคสำรองที่จบครบแทน ป้องกันเสียงแบบ "จะได้..." / "กำลัง..." ค้างกลางคลิป
 */
/**
 * ตัดบทให้จบสวยโดย "เก็บของจริงไว้ให้มากที่สุด" ก่อนจะยอมใช้ประโยคสำรอง
 *
 * 🐛 job_155 (ผ้ารองรีด) และอีกหลายงานก่อนหน้า: บทจริง 91 ตัวที่พูดถึงสินค้าครบถ้วน
 * ถูก **ทิ้งทั้งประโยค** แล้วแทนด้วยประโยคสำรอง เพียงเพราะลงท้ายด้วยคำเชื่อมอย่าง "ที่"
 * ทั้งสามเส้นทางของฟังก์ชันนี้เคยคืนประโยคสำรองแบบเหมารวมโดยไม่พยายามซ่อมก่อนเลย
 *
 * นี่คือต้นตอจริงของ "บทกลวง 100%" ที่ไล่มาทั้งวัน — ไม่ใช่ตัวเติมความยาว
 * (ผมเคยเดาผิดว่าเป็น ensureMinimumNarration แล้วแก้ผิดจุดไปหนึ่งรอบ)
 *
 * เรามี trimToCompleteThaiEnding() ที่ตัดกลับไปหาคำลงท้ายจริงอยู่แล้ว แต่ไม่เคยถูกเรียก
 * ตรงนี้เลย ใช้มันก่อนเสมอ แล้วยอมใช้ประโยคสำรองเฉพาะตอนที่ไม่เหลืออะไรใช้ได้จริงๆ
 */
// ⚠️ เกณฑ์ตรงนี้ต้อง "ต่ำ" ไม่ใช่เท่ากับ MIN_NARRATION_CHARS_PER_CLIP
//
// ครั้งแรกที่แก้ ผมใส่ >= 88 ตามเกณฑ์ความยาว ผลคือบทจริงที่ตัดแล้วเหลือ 80 ตัว
// ถูกปฏิเสธแล้วไปใช้ประโยคสำรอง 105 ตัวแทน = ยังกลวง 100% เหมือนเดิม
//
// บทจริง 80 ตัวดีกว่าคำกลวง 105 ตัวเสมอ และปลายทางมีทางออกที่ดีกว่ารออยู่แล้ว:
// ถ้ายังไม่หมดรอบ ด่านความยาวจะส่งกลับให้ Gemini เขียนใหม่ / ถ้าหมดรอบแล้ว
// ตัวเติมจะต่อท้ายให้ครบ ซึ่งได้ "ของจริง + คำเติม" ไม่ใช่ "คำเติมล้วน"
const MINIMUM_SALVAGEABLE_CHARS = 20;

function salvageOrFallback(text: string, clipIndex: number): string {
  const trimmed = trimToCompleteThaiEnding(text);
  // ใช้วิธีบวก (ต้องจบด้วยคำลงท้ายจริง) ไม่ใช่บัญชีดำ — job_155 จบด้วย "ไม่มี"
  // ซึ่งบัญชีดำไม่รู้จัก แล้วหลุดออกอากาศไปทั้งที่ค้างกลางวลีชัดเจน
  if (spokenLength(trimmed) >= MINIMUM_SALVAGEABLE_CHARS
    && endsWithCompleteThaiPhrase(trimmed)) {
    return trimmed;
  }
  return SAFE_NARRATION_EXTENSIONS[Math.min(clipIndex, SAFE_NARRATION_EXTENSIONS.length - 1)];
}

export function fitCompleteNarration(text: string, clipIndex: number): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (spokenLength(cleaned) <= MAX_NARRATION_CHARS_PER_CLIP) {
    if (endsWithCompleteThaiPhrase(cleaned)) return cleaned;
    // จบไม่สมบูรณ์ → ตัดกลับไปหาคำลงท้ายจริงก่อน
    const trimmed = trimToCompleteThaiEnding(cleaned);
    if (spokenLength(trimmed) >= MINIMUM_SALVAGEABLE_CHARS && endsWithCompleteThaiPhrase(trimmed)) {
      return trimmed;
    }
    // ⚠️ ตัดไม่ได้ก็ "คืนของเดิม" ไม่ใช่แทนด้วยประโยคสำรอง
    // เพราะคำสั่งอนุญาตให้บทไม่มีคำลงท้ายก็ได้ ("หรือจะไม่ใส่คำลงท้ายเลยก็ได้")
    // ถ้าเหมาว่าไม่มีคำลงท้าย = ใช้ไม่ได้ บทจริงที่ถูกต้องจะโดนทิ้งเป็นคำกลวงทันที
    // ซึ่งคือความผิดพลาดแบบเดียวกับที่เพิ่งแก้ไปใน job_155 แค่กลับด้าน
    return INCOMPLETE_THAI_ENDING.test(cleaned)
      ? salvageOrFallback(cleaned, clipIndex)
      : cleaned;
  }

  // Prefer an explicitly completed sentence. Never publish an arbitrary slice:
  // Thai brand names are not always segmented reliably, so a character/word
  // limit can produce endings such as a product name cut after its first syllable.
  const completeSentence = cleaned
    .split(/(?<=[.!?。！？])\s*/u)
    .map((part) => part.trim())
    .filter(Boolean)
    .find((part) => spokenLength(part) >= MIN_NARRATION_CHARS_PER_CLIP
      && spokenLength(part) <= MAX_NARRATION_CHARS_PER_CLIP);
  if (completeSentence) return completeSentence;

  const limited = limitThaiPhrase(cleaned, MAX_NARRATION_CHARS_PER_CLIP);
  const boundary = Math.max(
    limited.lastIndexOf(','),
    limited.lastIndexOf('，'),
    limited.lastIndexOf('.'),
    limited.lastIndexOf('。'),
    limited.lastIndexOf('!'),
    limited.lastIndexOf('?')
  );
  if (boundary >= 0) {
    const completeClause = limited.slice(0, boundary + 1).trim();
    if (spokenLength(completeClause) >= MIN_NARRATION_CHARS_PER_CLIP) return completeClause;
  }
  // ไม่มีเครื่องหมายวรรคตอนให้ยึด — แต่ภาษาไทยมีคำลงท้าย (ค่ะ/คะ/นะคะ) เป็นขอบเขตที่
  // เชื่อถือได้พอๆ กัน ลองตัดตรงนั้นก่อนเสมอ ยอมใช้ประโยคสำรองเฉพาะตอนไม่เหลืออะไรจริงๆ
  return salvageOrFallback(limited, clipIndex);
}

/**
 * บังคับบททั้งวิดีโอให้ใช้เพศเสียงเดียว โดย "ซ่อม" ไม่ใช่ "ทิ้งงาน"
 *
 * เดิม: Gemini ปน ครับ/ค่ะ ข้ามคลิป → compliance ปฏิเสธ → ทั้ง job ตาย
 * (job #64 ตายทั้งงานเพราะคำลงท้ายอย่างเดียว ทั้งที่เนื้อหาถูกหมด)
 * ใหม่: แปลงเป็นเพศที่ใช้มากกว่า (เสมอกัน → หญิง ซึ่งเป็นค่าเริ่มต้นของงานนี้)
 * แล้ว gate เดิมกลายเป็น safety net ที่ไม่มีวันยิง
 */
export function normalizeNarrationGender(segments: SubtitleSegment[]): SubtitleSegment[] {
  // ต้องยึด "เพศของเสียงที่พูดจริง" ไม่ใช่เพศข้างมากในบท
  // (job_68: เสียง Aoede = หญิง แต่บทลงท้าย "ครับ" ทุกประโยค → ฟังแล้วขัดทันที)
  const voice = (config.geminiTtsVoices[0] || '').trim().toLowerCase();
  const useFemale = !voice || FEMALE_TTS_VOICES.has(voice);
  return segments.map((segment) => ({
    ...segment,
    text: useFemale
      ? segment.text.replace(/นะครับ/g, 'นะคะ').replace(/ครับ/g, 'ค่ะ')
      : segment.text.replace(/นะคะ/g, 'นะครับ').replace(/ค่ะ|ค่า/g, 'ครับ'),
  }));
}

/**
 * บังคับบทพากย์ให้มีหนึ่งช่วงต่อหนึ่งคลิป และให้แต่ละช่วงสั้นพอสำหรับ TTS จริง
 * ใช้ซ้ำตอน finalize ด้วย จึงซ่อม checkpoint เก่าที่ Gemini เคยเขียนบทยาวเกินได้
 */
/**
 * @param allowPadding เติมประโยคสำรองให้บทที่สั้นกว่าเกณฑ์หรือไม่
 *
 * 🐛 ต้นตอของ "บทกลวง" ที่ไล่มาทั้งวัน (job_146 / job_154 ได้ประโยคสำรอง 100%)
 * ตัวเติมเคยทำงาน **ตั้งแต่รอบแรก** เสมอ ผลคือบทจริงที่ดีอยู่แล้วแต่สั้นไปนิด
 * เช่น 61 ตัว ถูกบวกประโยคสำรอง 44 ตัวจนครบ 105 แล้ว **ผ่านด่านทันที**
 * → Gemini ไม่เคยถูกขอให้เขียนใหม่เลย ทั้งที่ retry มีอยู่แล้วและได้ผลดีทุกครั้งที่ได้ทำงาน
 * (42% ของบทเป็นคำกลวง ซึ่งต่ำกว่าเกณฑ์เตือน 50% พอดี จึงไม่มีใครรู้ด้วยซ้ำ)
 *
 * ตอนนี้รอบแรกๆ ไม่เติม ปล่อยให้ตกด่านแล้วให้ Gemini เขียนใหม่ — ซึ่งคือสิ่งที่ควรเกิด
 * เก็บการเติมไว้เป็นทางออกสุดท้ายของรอบสุดท้ายเท่านั้น เพื่อไม่ให้งานตายทั้งใบ
 *
 * ⚠️ ค่าเริ่มต้นเป็น true เพราะผู้เรียกนอกลูป retry (job-finalize) ไม่มีรอบให้ลองใหม่
 * ถ้าไม่เติมให้ที่นั่น บทจะสั้นแล้วเสียงพากย์จะไม่เต็มคลิป
 */
export function normalizeClipAlignedNarration(
  narrationScript: string,
  segments: SubtitleSegment[],
  clipCount: number = config.clipsPerJob,
  secondsPerClip: number = config.videoDurationSeconds,
  allowPadding = true
): NarrationSnapshot {
  const totalSeconds = clipCount * secondsPerClip;
  const valid = segments.filter((segment) =>
    segment
    && typeof segment.text === 'string'
    && segment.text.trim()
    && Number.isFinite(segment.startSec)
    && Number.isFinite(segment.endSec)
    && segment.endSec > segment.startSec
  );
  const source = valid.length
    ? valid
    : autoGenerateSubtitles(narrationScript, totalSeconds);

  const buckets = Array.from({ length: clipCount }, () => [] as string[]);
  for (const segment of source) {
    const midpoint = (segment.startSec + segment.endSec) / 2;
    const index = Math.min(clipCount - 1, Math.max(0, Math.floor(midpoint / secondsPerClip)));
    buckets[index].push(segment.text.trim());
  }

  // หาก timestamp จากโมเดลผิดจนบางคลิปว่าง ให้แบ่งข้อความตามลำดับแทน
  const fallback = source.map((segment) => segment.text.trim()).filter(Boolean);
  const aligned = buckets.map((texts, index) => {
    const fallbackText = fallback[Math.min(index, fallback.length - 1)] || narrationScript;
    const fitted = fitCompleteNarration(texts.join(' ') || fallbackText, index);
    const text = allowPadding ? ensureMinimumNarration(fitted, index) : fitted;
    return {
      text,
      startSec: index * secondsPerClip,
      endSec: (index + 1) * secondsPerClip,
    };
  });

  // ซ่อมเพศเสียงให้เป็นเพศเดียวก่อนส่งออก — ทั้งสายวางแผนและสายดูวิดีโอเรียกฟังก์ชันนี้
  // ก่อน validateGeminiSalesCompliance จึงไม่มีทางตกด่านเพศปนกันอีก
  const genderAligned = normalizeNarrationGender(aligned);
  return {
    narrationScript: genderAligned.map((segment) => segment.text).join(' ').trim(),
    subtitleSegments: genderAligned,
  };
}

/**
 * ซ่อมประโยคที่ "บอกลักษณะ/ชวนดูรูปทรง" แทนที่จะปล่อยให้ validator ฆ่างานทั้งใบ
 *
 * 🐛 job #84-87: หลังเพิ่มกฎ DESCRIPTIVE_NARRATION งาน 4 ใบติดตาย ("ผลลัพธ์ไม่ผ่านกฎขายสินค้า")
 * ทั้งที่เป็นแค่ปัญหา "สไตล์การเขียน" ไม่ใช่ความเสี่ยงด้านกฎหมาย/ข้อมูลเท็จ
 * → ให้ retry ขอบทใหม่ก่อน (โมเดลมักแก้ได้) แต่พอหมดรอบต้องซ่อมแล้วไปต่อ ห้ามทิ้งงาน
 * (ต่างจากกฎเคลมยา/อ้างเกินข้อมูล ซึ่งยังต้องตายเหมือนเดิม)
 */
export function repairDescriptiveSegments(segments: SubtitleSegment[]): NarrationRepair[] {
  const repairs: NarrationRepair[] = [];
  segments.forEach((segment, index) => {
    if (!DESCRIPTIVE_NARRATION.test(segment.text.replace(/\s+/g, ' ').trim())) return;
    const repairedFrom = segment.text;
    const replacement = SAFE_NARRATION_EXTENSIONS[index % SAFE_NARRATION_EXTENSIONS.length];
    segment.text = replacement;
    repairs.push({
      clipIndex: index,
      rule: 'descriptive_narration',
      strategy: 'safe_fallback',
      repairedFrom,
      replacement,
      reasons: ['บอกลักษณะ/ชวนดูรูปทรงแทนการรีวิวขายจากประสบการณ์จริง'],
    });
  });
  if (repairs.length) {
    logger.warn(`⚠️ ซ่อมบท ${repairs.length} ประโยคที่ "บอกลักษณะ" ด้วยประโยคขายสำรอง (หมดรอบ retry แล้ว)`);
  }
  return repairs;
}

/** คืนคำอ้างทั้งหมดที่บทพูด แต่ไม่มีอยู่ในข้อมูลต้นทางที่ยืนยันแล้ว */
export function findUnsupportedClaims(text: string, supportedFacts: string): string[] {
  return [
    ...SOURCE_REQUIRED_CLAIMS.filter(
      (claim) => text.includes(claim) && !supportedFacts.includes(claim)
    ),
    ...findUnsupportedSpecNumbers(text, supportedFacts),
  ];
}

/**
 * ตัดคำอ้างที่ข้อมูลต้นทางไม่ยืนยันออกจากบท แทนการทิ้งงานทั้งใบ
 *
 * 🐛 job #92: Gemini เขียน "ทนทาน" ทั้งที่รีวิว/สเปกไม่ได้พูดถึง → ตกด่านหลัง retry ครบ
 * → งานตาย + บอทหยุดทั้งระบบ ("หยุดเพื่อความปลอดภัย") ซึ่งรัน 24 ชม. ไม่ได้
 *
 * คำอ้างพวกนี้ปล่อยผ่านไม่ได้จริง (เสี่ยงให้ข้อมูลสินค้าเท็จ) แต่ทางออกที่ถูก
 * คือ "เอาคำอ้างออก" ไม่ใช่ "ทิ้งงาน" — ผลลัพธ์ยังปลอดภัยเท่าเดิมแต่งานเดินต่อได้
 */
export function repairUnsupportedClaims(
  segments: SubtitleSegment[],
  supportedFacts: string
): NarrationRepair[] {
  const repairs: NarrationRepair[] = [];
  segments.forEach((segment, index) => {
    const unsupported = findUnsupportedClaims(segment.text, supportedFacts);
    if (!unsupported.length) return;
    // แทนทั้งประโยค ไม่ใช่ลบเฉพาะคำ — ลบคำเดี่ยวๆ ทำให้ประโยคขาดใจความ
    // (ประโยคสำรองถูกตรวจแล้วว่าไม่มีคำในรายการนี้อยู่ในตัวเอง)
    const repairedFrom = segment.text;
    const replacement = SAFE_NARRATION_EXTENSIONS[index % SAFE_NARRATION_EXTENSIONS.length];
    segment.text = replacement;
    repairs.push({
      clipIndex: index,
      rule: 'unsupported_claim',
      strategy: 'safe_fallback',
      repairedFrom,
      replacement,
      reasons: unsupported,
    });
    logger.warn(`⚠️ บทคลิป ${index + 1} อ้าง "${unsupported.join(', ')}" โดยไม่มีข้อมูลรองรับ — แทนด้วยประโยคขายที่ปลอดภัย`);
  });
  return repairs;
}

export type UnsupportedClaimRewriteRequest = {
  clipIndex: number;
  originalText: string;
  unsupportedClaims: string[];
};

/**
 * ขอให้ Gemini เขียนเฉพาะประโยคที่มีคำอ้างเกินข้อมูลใหม่ก่อนใช้ข้อความสำรอง
 *
 * TICKET-11 / job #144: คำว่า "พกพาง่าย" คำเดียวทำให้บททั้งช็อตที่ตรงภาพที่สุด
 * ถูกทิ้งแล้วแทนด้วยข้อความสำเร็จรูปเรื่องราคา การ rewrite แบบเจาะประโยครักษาเนื้อหา
 * และความสัมพันธ์กับภาพไว้ ขณะที่ด่านเดิมยังตรวจคำอ้างซ้ำก่อนยอมรับทุกครั้ง
 */
export async function rewriteUnsupportedClaimSegments(
  segments: SubtitleSegment[],
  supportedFacts: string,
  rewrite: (request: UnsupportedClaimRewriteRequest) => Promise<string>,
  maxAttempts = 2
): Promise<NarrationRepair[]> {
  const repairs: NarrationRepair[] = [];

  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index];
    const repairedFrom = segment.text;
    const unsupported = findUnsupportedClaims(repairedFrom, supportedFacts);
    if (!unsupported.length) continue;

    let replacement = '';
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const candidate = (await rewrite({
          clipIndex: index,
          originalText: repairedFrom,
          unsupportedClaims: unsupported,
        })).replace(/\s+/g, ' ').trim();
        const length = spokenLength(candidate);
        if (
          candidate
          && length >= MIN_VIDEO_NARRATION_CHARS_PER_CLIP
          && length <= MAX_NARRATION_CHARS_PER_CLIP
          && findUnsupportedClaims(candidate, supportedFacts).length === 0
        ) {
          replacement = candidate;
          break;
        }
        logger.warn(
          `⚠️ Gemini rewrite บทคลิป ${index + 1} รอบ ${attempt + 1} ยังไม่ปลอดภัย/ความยาวไม่ผ่าน`
        );
      } catch (error: any) {
        logger.warn(
          `⚠️ Gemini rewrite บทคลิป ${index + 1} รอบ ${attempt + 1} ล้มเหลว: ${String(error?.message || error).slice(0, 120)}`
        );
      }
    }

    const strategy: NarrationRepair['strategy'] = replacement ? 'gemini_rewrite' : 'safe_fallback';
    if (!replacement) {
      replacement = SAFE_NARRATION_EXTENSIONS[index % SAFE_NARRATION_EXTENSIONS.length];
      logger.warn(
        `⚠️ บทคลิป ${index + 1} rewrite ไม่ผ่าน ${maxAttempts} รอบ — ใช้ประโยคสำรองเป็นทางสุดท้าย`
      );
    }
    segment.text = replacement;
    repairs.push({
      clipIndex: index,
      rule: 'unsupported_claim',
      strategy,
      repairedFrom,
      replacement,
      reasons: unsupported,
    });
  }

  return repairs;
}

/**
 * หากประโยคที่ Gemini rewrite ยังตกด่าน compliance อื่น ให้ถอยกลับเป็นข้อความสำรอง
 * โดยคงหลักฐาน original/reasons ไว้ใน repair เดิมเพื่อชันสูตรย้อนหลังได้
 */
export function fallbackRewrittenNarrationSegments(
  segments: SubtitleSegment[],
  repairs: NarrationRepair[]
): boolean {
  let changed = false;
  for (const repair of repairs) {
    if (repair.strategy !== 'gemini_rewrite') continue;
    const replacement = SAFE_NARRATION_EXTENSIONS[
      repair.clipIndex % SAFE_NARRATION_EXTENSIONS.length
    ];
    segments[repair.clipIndex].text = replacement;
    repair.strategy = 'safe_fallback';
    repair.replacement = replacement;
    changed = true;
    logger.warn(
      `⚠️ Gemini rewrite บทคลิป ${repair.clipIndex + 1} ยังตก compliance gate — ใช้ประโยคสำรองเป็นทางสุดท้าย`
    );
  }
  return changed;
}

/**
 * ประโยคแรกเปิดด้วยการเรียกชื่อสินค้าไหม
 *
 * เจ้าของสั่งหลังดู job_134: "hook อ่อน" — คลิปเปิดด้วย "พัดลมตั้งโต๊ะขนาดแปดนิ้ว..."
 * ซึ่งเป็นการอ่านสเปกใส่หน้าคนดูตั้งแต่วินาทีแรก คนเลื่อนผ่านทันทีเพราะยังไม่มีเหตุผลให้หยุดดู
 * สองวินาทีแรกต้องเป็น "เรื่องของคนดู" (ปัญหา/สถานการณ์/สิ่งที่จะได้) ก่อนจะพูดถึงตัวสินค้า
 *
 * เทียบด้วยคำขึ้นต้น 4-8 ตัวอักษรว่าไปตรงกับข้อความในชื่อสินค้าไหม ใช้ได้กับภาษาไทย
 * ที่ไม่เว้นวรรค ซึ่งการตัดคำแบบปกติใช้ไม่ได้
 */
export function opensByNamingProduct(text: string, productTitle: string): boolean {
  const opening = text.replace(/^[\s"'“”‘’]+/, '');
  const title = productTitle.replace(/\s+/g, '');
  if (!opening || !title) return false;
  for (let length = 4; length <= 8; length++) {
    const prefix = [...opening].slice(0, length).join('');
    if ([...prefix].length < length) break;
    if (title.includes(prefix)) return true;
  }
  return false;
}

/** Hard gate after model output; invalid narration must never reach Flow/TTS. */
export function validateGeminiSalesCompliance(
  result: Pick<GeminiVisionResult, 'motionPrompts' | 'subtitleSegments'>,
  productTitle: string,
  clipCount: number,
  sourceText = '',
  options: { enforceHook?: boolean } = {}
): void {
  const violations: string[] = [];
  result.subtitleSegments.forEach((segment, index) => {
    const text = segment.text.replace(/\s+/g, ' ').trim();
    if (CAMERA_NARRATION.test(text)) {
      violations.push(`บทคลิป ${index + 1} บรรยายกล้อง/มือแทนการขายสินค้า`);
    }
    if (DESCRIPTIVE_NARRATION.test(text)) {
      violations.push(`บทคลิป ${index + 1} บอกลักษณะ/ชวนดูรูปทรงแทนการรีวิวขายจากประสบการณ์จริง`);
    }
    if (MEDICAL_CLAIM.test(text)) {
      violations.push(`บทคลิป ${index + 1} มีคำกล่าวอ้างโรคหรือการรักษา`);
    }
    if (INCOMPLETE_THAI_ENDING.test(text)) {
      violations.push(`บทคลิป ${index + 1} ลงท้ายด้วยคำเชื่อมที่ไม่สมบูรณ์`);
    }
    // hook: บังคับเฉพาะตอนที่ยังเหลือรอบให้เขียนใหม่ — รอบสุดท้ายปล่อยผ่านพร้อม log
    // เพราะ "เปิดเรื่องไม่เก๋" ไม่ใช่ข้อมูลเท็จ ไม่คุ้มที่จะทิ้งงานที่จ่ายเครดิตไปแล้ว (บทเรียน job #92)
    if (index === 0 && options.enforceHook !== false && opensByNamingProduct(text, productTitle)) {
      violations.push(
        'ประโยคแรกเปิดด้วยการเรียกชื่อ/ประเภทสินค้า — สองวินาทีแรกต้องเป็นปัญหาหรือสถานการณ์ของคนดูก่อน'
      );
    }
    // ตัวเลขสเปกที่แต่งขึ้นเองเป็นข้อมูลสินค้าเท็จ คนดูเอาไปเทียบของจริงได้ทันที
    const inventedSpecs = findUnsupportedSpecNumbers(text, `${productTitle} ${sourceText}`);
    if (inventedSpecs.length) {
      violations.push(
        `บทคลิป ${index + 1} อ้างสเปก “${inventedSpecs.join('”, “')}” ที่ไม่มีในชื่อสินค้า รีวิว หรือสเปกที่ให้มา`
      );
    }

    // Detect a partial product token such as “บี” when the title contains
    // “บีแอลบียู”, without banning all legitimate short Thai endings.
    const lastToken = text.split(/\s+/).at(-1)?.replace(/[.!?。！？,，]/g, '') || '';
    const titleTokens = productTitle.split(/[\s()[\]{}\-–—/|,，.!?]+/u).filter(Boolean);
    if ([...lastToken].length > 0 && [...lastToken].length <= 3
      && titleTokens.some((token) => token !== lastToken && token.startsWith(lastToken))) {
      violations.push(`บทคลิป ${index + 1} ตัดชื่อสินค้ากลางคำที่ “${lastToken}”`);
    }
  });

  // เจตนาของด่านนี้คือ "คลิป 2 ต้องมีการเคลื่อนไหวที่ระบุชัด" ไม่ใช่ "ต้องมีเลของศา"
  // จึงผ่านได้ทั้งแบบบอกองศา และแบบบอกท่าใช้งานสินค้าจริง (ซึ่งขายได้ดีกว่าด้วยซ้ำ)
  const clip2Motion = result.motionPrompts[1] || '';
  if (clipCount >= 2
    && !REQUIRED_PIVOT_ANGLE.test(clip2Motion)
    && !describesProductInUse(clip2Motion)) {
    violations.push('motion คลิป 2 ต้องระบุการเคลื่อนไหวชัดเจน: มุมพลิก 5–12° หรือท่าใช้งานสินค้าจริง');
  }

  // เพศเสียงต้องเป็นเพศเดียวทั้งวิดีโอ — ห้ามสลับ ครับ↔ค่ะ ระหว่างคลิป
  // (ตรวจทั้งบทรวม ถ้าเจอทั้งคำผู้ชายและผู้หญิง = ปนกัน) แบบไม่ใส่คำลงท้ายเพศเลยก็ผ่าน
  const joinedNarration = result.subtitleSegments.map((segment) => segment.text).join(' ');
  const supportedFacts = `${productTitle} ${sourceText}`;
  for (const claim of SOURCE_REQUIRED_CLAIMS) {
    if (joinedNarration.includes(claim) && !supportedFacts.includes(claim)) {
      violations.push(`บทพากย์อ้างว่า “${claim}” แต่ข้อมูลต้นทางไม่ได้ยืนยัน`);
    }
  }
  if (MALE_PARTICLE.test(joinedNarration) && FEMALE_PARTICLE.test(joinedNarration)) {
    violations.push('บทพากย์ใช้เพศเสียงปนกัน (ครับ กับ ค่ะ) — ต้องเลือกเพศเดียวทั้งวิดีโอ');
  }

  if (violations.length) throw new PromptComplianceError(violations);
}


/**
 * สร้าง subtitle อัตโนมัติจากบทพากย์ (fallback)
 */
export function autoGenerateSubtitles(
  script: string,
  totalSeconds: number
): SubtitleSegment[] {
  const sentences = script
    .split(/[.!?。\n]+/)
    .filter((s) => s.trim().length > 0);
  const segments: SubtitleSegment[] = [];
  const secPerSentence = totalSeconds / sentences.length;

  let currentTime = 0;
  for (const sentence of sentences) {
    const duration = Math.min(secPerSentence, 4); // max 4 วินาทีต่อซับ
    segments.push({
      text: sentence.trim(),
      startSec: Math.round(currentTime * 100) / 100,
      endSec: Math.round((currentTime + duration) * 100) / 100,
    });
    currentTime += duration;
  }

  return segments;
}
