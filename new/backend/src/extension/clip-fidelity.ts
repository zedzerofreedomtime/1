import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

import { config } from '../config.js';
import { compareGeneratedProductFidelity } from '../gemini/fidelity-check.js';
import { isDemoShotPrompt } from '../gemini/identity-lock.js';
import { logger, logEvent } from '../utils/logger.js';
import { extractFirstFrame } from '../utils/media.js';
import type { GeminiVisionResult, ProductImageFidelityResult } from '../types.js';

/**
 * ด่านตรวจคลิป: เฟรมแรกของคลิปต้องเป็นสินค้าตัวเดียวกับรูปที่ป้อนเข้า Flow
 *
 * job #124 พิสูจน์ว่าโหมดส่วนผสม "วาดสินค้าขึ้นใหม่" ไม่ได้ขยับพิกเซลของรูปตั้งต้น
 * เฟรมที่ 0 ของคลิปจึงเพี้ยนได้ทันที ทั้งที่รูปตั้งต้นผ่าน fidelity gate มาแล้ว
 * (ฉลาก "บ้านไผ่ รู้ใจคนรักความสะอาด" → "Brapt Cemual", "L 420" → "L x2G")
 * ไม่มี prompt ไหนกันได้ เพราะโมเดลไม่เคยเห็นพิกเซลจริงตั้งแต่ต้น — ต้องตรวจผลลัพธ์เอา
 *
 * รูปอ้างอิงคือ "รูปที่เพิ่งป้อนเข้าไปจริงๆ" ของคลิปนั้น: คลิปแรกใช้รูปตั้งต้นที่ Flow เจน
 * คลิปถัดไปใช้ continuity_N.jpg ที่ถูกอัปเป็น Start frame
 *
 * ⚠️ ถ้าตรวจไม่ได้ (Gemini ล่ม/เน็ตหลุด) ต้องปล่อยผ่าน ไม่ใช่บล็อก — คลิปนี้จ่ายเครดิตไปแล้ว
 * การทิ้งของที่จ่ายแล้วเพราะ API สะดุดคือเสียเปล่าโดยไม่มีหลักฐานว่าคลิปเสียจริง
 */
export async function assertClipMatchesItsSourceFrame(
  jobId: number,
  clipIndex: number,
  incomingClipPath: string,
  jobDir: string,
  vision: GeminiVisionResult | null
): Promise<void> {
  if (!config.clipFidelityCheckEnabled) return;

  const referencePath = clipIndex === 0
    ? vision?.generatedImagePath
    : path.join(jobDir, `continuity_${clipIndex}.jpg`);
  if (!referencePath || !fs.existsSync(referencePath)) return;
  // คลิปแรกถูกสร้างด้วยโหมดส่วนผสม: เฟรมตั้งต้น + รูปทางการที่ยืนยันแล้ว
  // ผู้ตรวจต้องเห็นหลักฐานชุดเดียวกับ Flow ไม่งั้นรายละเอียดจริงที่มือบังในเฟรมต้น
  // จะถูกตีความผิดว่าเป็นของที่โมเดลแต่งเพิ่ม (job #145)
  const approvedReferencePaths = clipIndex === 0 && Array.isArray(vision?.referenceImagePaths)
    ? vision.referenceImagePaths
    : [];

  // ช็อตที่มือกำลังใช้สินค้าจริง สินค้าจะโดนฟอง/ผ้า/มือบังและเอียงตามการกระทำ
  // ถ้าใช้เกณฑ์ 'clip' ปกติ ผู้ตรวจจะอ่านว่าเป็นสินค้าคนละตัวแล้วตีตกคลิปที่จ่ายเครดิตไปแล้ว
  // อ่านจากพรอมต์จริงที่ส่งเข้า Flow ไม่ใช่ flag แยก — flag หลุดจากพรอมต์ได้ พรอมต์หลุดจากตัวเองไม่ได้
  const inUseShot = isDemoShotPrompt(vision?.motionPrompts?.[clipIndex] || '');
  if (inUseShot) {
    logger.info(`🧽 คลิป ${clipIndex + 1} งาน #${jobId} เป็นช็อตใช้งานจริง — ใช้เกณฑ์เทียบสินค้าฉบับผ่อน`);
  }

  const framePath = path.join(jobDir, `clip_${clipIndex + 1}_frame0.${randomUUID()}.jpg`);
  let fidelity: ProductImageFidelityResult;
  try {
    await extractFirstFrame(incomingClipPath, framePath);
    fidelity = await compareGeneratedProductFidelity(
      referencePath,
      framePath,
      inUseShot ? 'clip_in_use' : 'clip',
      approvedReferencePaths
    );
  } catch (error: any) {
    logger.warn(
      `⚠️ ตรวจเฟรมแรกของคลิป ${clipIndex + 1} งาน #${jobId} ไม่ได้ — ปล่อยผ่านเพื่อไม่ทิ้งคลิปที่จ่ายแล้ว: ${String(error?.message || error)}`
    );
    return;
  } finally {
    if (fs.existsSync(framePath)) fs.rmSync(framePath, { force: true });
  }

  if (fidelity.pass) return;

  // เก็บคลิปที่ถูกปฏิเสธไว้ตรวจสาเหตุ — อย่าลบของที่จ่ายเครดิตไปแล้วทิ้งเฉยๆ
  const rejectedPath = path.join(jobDir, `job_${jobId}_video_${clipIndex + 1}_rejected.mp4`);
  if (fs.existsSync(rejectedPath)) fs.rmSync(rejectedPath, { force: true });
  fs.copyFileSync(incomingClipPath, rejectedPath);
  const reason = fidelity.differences.join('; ') || 'สินค้าในคลิปไม่ตรงรูปที่ป้อนเข้าไป';
  const message =
    `PRODUCT_FIDELITY_BLOCK: คลิป ${clipIndex + 1} วาดสินค้าใหม่ไม่ตรงรูปที่ป้อนเข้า Flow `
    + `(score ${fidelity.score}/100) — ${reason}`;
  logger.warn(`🛑 งาน #${jobId} ปฏิเสธคลิป ${clipIndex + 1}: ${message}`);
  logEvent({
    source: 'gemini',
    stage: 'clip.fidelity',
    message,
    level: 'warn',
    jobId,
    clipIndex,
    meta: {
      score: fidelity.score,
      referencePath,
      approvedReferencePaths,
      rejectedPath,
    },
  });
  throw new Error(message);
}
