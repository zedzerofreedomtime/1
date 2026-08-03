import fs from 'fs';
import path from 'path';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { isTransientNetworkError, withRetry } from '../utils/retry.js';

/** ตัวเชื่อม Gemini ตัวเดียวที่ทุกโมดูลใช้ร่วมกัน */
export const genAI = new GoogleGenerativeAI(config.geminiApiKey);

/** เพดานขนาดวิดีโอที่ส่งแนบไปกับ prompt ได้โดยตรง (inline data) */
export const MAX_INLINE_VIDEO_BYTES = 20 * 1024 * 1024;

/**
 * เรียก Gemini โดยทนเน็ตกระตุก — ทุกจุดที่คุยกับ Gemini ต้องผ่านตัวนี้
 *
 * 🐛 เดิมเรียก model.generateContent() ตรงๆ ทุกที่ พอเน็ตสะดุดครั้งเดียวจะได้ "fetch failed"
 * แล้วงานตายทั้งใบ + บอทหยุดทั้งระบบ ทั้งที่ยังไม่ได้จ่ายเครดิต Flow สักบาท และรอ 3 วินาที
 * ลองใหม่ก็ผ่านแล้ว การหยุดทั้งระบบเพราะ blip เดียวทำให้รันยาวข้ามคืนไม่ได้เลย
 *
 * ไม่ retry error ที่เกิดจากเนื้อหา (JSON เพี้ยน / ตกด่าน) เพราะลองใหม่ก็ได้ผลเดิม
 * — พวกนั้นมีวงจร retry ของตัวเองที่แก้ prompt ก่อนยิงใหม่อยู่แล้ว
 */
export async function generateContentWithRetry(
  model: { generateContent: (parts: any) => Promise<any> },
  parts: any,
  label: string
): Promise<any> {
  return withRetry(() => model.generateContent(parts), {
    maxRetries: 3,
    initialDelayMs: 2000,
    maxDelayMs: 20_000,
    retryOn: (error) => {
      const transient = isTransientNetworkError(error);
      if (transient) {
        logger.warn(`⚠️ ${label}: Gemini ตอบไม่ได้ชั่วคราว (${String(error?.message || error).slice(0, 80)}) — ลองใหม่`);
      }
      return transient;
    },
  });
}

/** อ่านไฟล์รูปเป็น inline part สำหรับส่งให้ Gemini Vision */
export function imageInlinePart(filePath: string): { inlineData: { mimeType: string; data: string } } {
  const ext = path.extname(filePath).toLowerCase();
  const mimeType = ext === '.png'
    ? 'image/png'
    : ext === '.webp'
      ? 'image/webp'
      : 'image/jpeg';
  return {
    inlineData: {
      mimeType,
      data: fs.readFileSync(filePath).toString('base64'),
    },
  };
}
