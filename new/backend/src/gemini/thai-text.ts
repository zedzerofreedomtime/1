/**
 * เครื่องมือจัดการ "ข้อความไทย" ที่ไม่ใช่กฎของบทพากย์
 *
 * แยกออกจาก narration-rules.ts เมื่อ 1 ส.ค. 2026 — ไฟล์นั้นเขียนไว้เองว่าตั้งใจรวม
 * "กฎของบท" ไว้ที่เดียวเพราะปรับโทนบททีต้องแก้หลายกฎพร้อมกัน เหตุผลนั้นยังถูกอยู่
 * จึงไม่แยกกฎออกจากกัน แต่ของในไฟล์นี้ไม่ใช่กฎ มันคือการนับและตัดตัวอักษรไทย
 * ซึ่งใช้ที่ไหนก็ได้และทดสอบแยกได้ ปนอยู่กับกฎแล้วทำให้ทั้งสองฝั่งอ่านยากขึ้นเปล่าๆ
 *
 * ⚠️ ภาษาไทยไม่เว้นวรรคระหว่างคำ การนับ "คำ" จึงใช้ไม่ได้ ต้องนับตัวอักษรที่ออกเสียง
 * (เคยทำให้บท 24 วินาทียาวจริง 34.6 วินาที ก่อนโดน FFmpeg ตัดกลางประโยค)
 */

export const THAI_DIGIT_WORDS: Record<string, number> = {
  ศูนย์: 0, หนึ่ง: 1, เอ็ด: 1, สอง: 2, ยี่: 2, สาม: 3, สี่: 4,
  ห้า: 5, หก: 6, เจ็ด: 7, แปด: 8, เก้า: 9,
};

export const THAI_SCALE_WORDS: Record<string, number> = {
  สิบ: 10, ร้อย: 100, พัน: 1000, หมื่น: 10_000, แสน: 100_000, ล้าน: 1_000_000,
};

/** "สองร้อยสิบสี่" → 214 · "หนึ่งหมื่นสองพัน" → 12000 (บทพากย์สะกดเลขเป็นคำเสมอเพื่อให้ TTS อ่านถูก) */
export function evaluateThaiNumberWords(words: string[]): number {
  let total = 0;
  let current = 0;
  for (const word of words) {
    const digit = THAI_DIGIT_WORDS[word];
    if (digit !== undefined) { current = digit; continue; }
    const scale = THAI_SCALE_WORDS[word];
    if (scale === undefined) continue;
    if (scale >= 1_000_000) {
      total = (total + (current || 1)) * scale;
    } else {
      total += (current || 1) * scale;
    }
    current = 0;
  }
  return total + current;
}

export function spokenLength(text: string): number {
  return [...text.replace(/\s+/g, '')].length;
}

export function limitThaiPhrase(text: string, maxChars: number): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (spokenLength(cleaned) <= maxChars) return cleaned;

  const units = (() => {
    try {
      return [...new Intl.Segmenter('th', { granularity: 'word' }).segment(cleaned)]
        .map((part) => part.segment);
    } catch {
      return [...cleaned];
    }
  })();
  let result = '';
  for (const unit of units) {
    const candidate = `${result}${unit}`.trim();
    if (spokenLength(candidate) > maxChars) break;
    result += unit;
  }
  return result.trim() || [...cleaned].slice(0, maxChars).join('').trim();
}

/**
 * ตัดกลับมาให้จบที่คำลงท้ายประโยคภาษาไทยที่สมบูรณ์
 *
 * job_102: บทถูกต่อประโยคสำรองแล้วตัดตามเพดาน 100 ตัว เหลือหางลอยว่า
 * "...ราคาไปมากเลยค่ะ ใช้" และ "...บอกเลยว่าคุ้มค่ามากกับราคา"
 * limitThaiPhrase ตัดตรงขอบ "คำ" ก็จริง แต่คำที่สมบูรณ์ไม่ได้แปลว่า "ประโยค" สมบูรณ์
 * ผู้ฟังจึงได้ยินเสียงหยุดกลางประโยค = อาการ "เสียงขัด"
 * INCOMPLETE_THAI_ENDING เป็นบัญชีดำคำเชื่อม ซึ่งไล่ตามคำอย่าง "ใช้" ไม่ทัน
 * จึงเปลี่ยนมาใช้วิธีบวก: ต้องจบที่คำลงท้าย/เครื่องหมายเท่านั้น
 */
export function trimToCompleteThaiEnding(text: string): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (!cleaned) return cleaned;
  if (/(?:ค่ะ|คะ|ครับ|จ้า|[.!?。！？])$/u.test(cleaned)) return cleaned;
  const endings = [...cleaned.matchAll(/(?:ค่ะ|คะ|ครับ|จ้า|[.!?。！？])/gu)];
  const last = endings.at(-1);
  if (!last || last.index === undefined) return cleaned;
  return cleaned.slice(0, last.index + last[0].length).trim();
}
