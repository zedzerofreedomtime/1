import { logger } from '../utils/logger.js';
import type { GeminiVisionResult } from '../types.js';

/**
 * ตัวแกะ JSON จาก Gemini ที่ทนความเพี้ยน
 *
 * โมเดลแบบ structured output ยังคืน JSON ที่ผิดรูปได้เป็นครั้งคราว (ขาด comma,
 * มีข้อความส่วนเกินต่อท้าย) ถ้าปล่อยให้ JSON.parse พังตรงๆ งานจะตายทั้งใบ
 * ทั้งที่เนื้อข้อมูลใช้ได้ ไฟล์นี้จึงซ่อมเฉพาะเคสที่ชัดเจน ไม่เดาค่าที่หายไป
 */
/**
 * Structured-output models can very rarely omit a comma between two properties.
 * Repair only that narrow, unambiguous case; never guess missing values or braces.
 */
export function parseGeminiVisionJson(json: string): GeminiVisionResult {
  const parseWithCommaRepair = (candidate: string): GeminiVisionResult => {
    try {
      return JSON.parse(candidate) as GeminiVisionResult;
    } catch (firstError) {
      const repaired = candidate.replace(
        /("(?:\\.|[^"\\])*"|true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|[\]}])(\s*\r?\n\s*)"([^"]+)"\s*:/g,
        '$1,$2"$3":'
      );
      if (repaired === candidate) throw firstError;
      logger.warn('⚠️ Gemini JSON ขาด comma ระหว่าง property — ซ่อมรูปแบบก่อนตรวจข้อมูล');
      return JSON.parse(repaired) as GeminiVisionResult;
    }
  };

  try {
    return parseWithCommaRepair(json);
  } catch (originalError) {
    // Gemini occasionally returns one valid JSON object followed by a second
    // fragment even with responseMimeType=application/json. Extract only the
    // first complete top-level object; the scanner respects quoted braces and
    // escapes, so it does not truncate prompt text.
    const start = json.indexOf('{');
    if (start < 0) throw originalError;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < json.length; index++) {
      const character = json[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') inString = true;
      else if (character === '{') depth += 1;
      else if (character === '}') {
        depth -= 1;
        if (depth === 0) {
          const candidate = json.slice(start, index + 1);
          if (!json.slice(index + 1).trim()) throw originalError;
          logger.warn('⚠️ Gemini ส่งข้อความส่วนเกินหลัง JSON — ใช้เฉพาะ object แรกที่สมบูรณ์');
          return parseWithCommaRepair(candidate);
        }
      }
    }
    throw originalError;
  }
}
