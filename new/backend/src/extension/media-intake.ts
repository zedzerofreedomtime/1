import fs from 'fs';
import path from 'path';

import { config } from '../config.js';
import { usedSourceImagesForItem } from '../db/job-repository.js';
import { logger } from '../utils/logger.js';
import { assertValidImage } from '../utils/media.js';
import { eligibleReviewMediaEntries } from '../utils/review-media.js';
import { withRetry } from '../utils/retry.js';

/**
 * ดึงรูปจากภายนอกเข้ามาไว้ในโฟลเดอร์ของงาน ก่อนส่งต่อให้ Gemini และ Flow
 *
 * แยกออกจาก extension-api.ts เมื่อ 1 ส.ค. 2026 — ไฟล์นั้นทำหน้าที่ปนกันหลายอย่าง
 * (รับงาน · เตรียมรูป · เตรียมพรอมต์ · รับคลิปกลับ) จนอ่านทีต้องเลื่อนผ่านเรื่องอื่นตลอด
 * ตรงนี้คือ "ขาเข้าของรูป" อย่างเดียว: โหลดมา ตรวจว่าเป็นรูปจริง แล้วเก็บลงดิสก์
 */

/** จำนวนรูปผู้สมัครที่ส่งให้ Gemini เลือกต่อหนึ่งงาน */
const CANDIDATE_COUNT = 8;
/** เหลือรูปที่ยังไม่เคยใช้น้อยกว่านี้ ให้เลิกกรองแล้วใช้ทั้งกองแทน */
const MIN_FRESH_CANDIDATES = 3;

/**
 * รูปที่งานก่อนหน้าของสินค้าตัวนี้ใช้ไปแล้ว ต้องไม่ถูกเสนอซ้ำ
 *
 * 🐛 3 ส.ค. 2026 เจ้าของทักว่า "รูปที่สุ่มออกมามีแต่รูปเดิมๆ ตลอดเลย"
 * ต้นเหตุอยู่ที่ `.slice(0, 8)` บรรทัดเดียว — เราหยิบ **8 ใบแรกชุดเดิมทุกครั้ง**
 * สินค้าที่มีสื่อ 175 ชิ้นจึงถูกมองแค่ 8 ชิ้นตลอดชีวิต แล้ว Gemini ที่ได้คำถามเดิม
 * กับข้อมูลเดิมก็ตอบเดิม → เฟรมตั้งต้นเดิม → คลิปหน้าตาเดิมทั้งใบ
 *
 * ปัญหาไม่ได้อยู่ที่ "Gemini เลือกซ้ำ" แต่อยู่ที่เราไม่เคยให้มันเห็นรูปที่เหลือเลย
 *
 * ⚠️ ถ้ากรองแล้วเหลือน้อยกว่า MIN_FRESH_CANDIDATES ให้ใช้ทั้งกองตามเดิม —
 * ห้ามให้งานล้มหรือได้รูปแย่ๆ เพราะเหตุผลเรื่องความหลากหลาย รูปที่ดีที่สุดมันดีด้วยเหตุผลของมัน
 */
export function freshCandidateWindow<T extends { url: string }>(images: T[], usedUrls: Set<string>): T[] {
  if (!usedUrls.size) return images.slice(0, CANDIDATE_COUNT);
  const fresh = images.filter((image) => !usedUrls.has(image.url));
  if (fresh.length < MIN_FRESH_CANDIDATES) {
    logger.warn(
      `⚠️ สินค้านี้เหลือรูปที่ยังไม่เคยใช้ ${fresh.length} รูป — ใช้ทั้งกองตามเดิมเพื่อไม่ให้ได้รูปแย่กว่าเดิม`
    );
    return images.slice(0, CANDIDATE_COUNT);
  }
  logger.info(`🔀 ข้ามรูปที่เคยใช้ไปแล้ว ${images.length - fresh.length} รูป — เสนอรูปใหม่ให้ Gemini เลือก`);
  return fresh.slice(0, CANDIDATE_COUNT);
}

/**
 * รูปผู้สมัครหนึ่งใบ — ต้องพก URL ต้นทางมาด้วย ไม่ใช่แค่ path ในเครื่อง
 *
 * ชื่อไฟล์ `review_candidate_N.jpg` เคยใช้แทนตัวรูปได้ตอนที่เราหยิบ 8 ใบแรกเสมอ เพราะ N
 * ตรงกับลำดับในสื่อทั้งกองพอดี พอเริ่มเลื่อนหน้าต่างเพื่อเลี่ยงรูปซ้ำ ความตรงนั้นก็หายไป
 * — ต้องพก URL จริงมาด้วยตั้งแต่ต้นทาง ไม่งั้นกันซ้ำรอบถัดไปไม่ได้
 */
export type ReviewCandidate = { path: string; url: string };

export async function downloadImages(
  jobId: number,
  mediaJson: unknown,
  usedUrls: Set<string> = new Set()
): Promise<ReviewCandidate[]> {
  const jobDir = path.resolve(config.outputDir, `job_${jobId}`);
  fs.mkdirSync(jobDir, { recursive: true });
  const eligible = eligibleReviewMediaEntries(mediaJson).filter((item) => item.type === 'image');
  const images = freshCandidateWindow(eligible, usedUrls);
  const files: ReviewCandidate[] = [];
  for (let index = 0; index < images.length; index++) {
    const output = path.join(jobDir, `review_candidate_${index + 1}.jpg`);
    if (!fs.existsSync(output)) {
      // เน็ตกระตุกทำให้ fetch failed เป็นพักๆ (job #73/#74 พังทั้งงานเพราะ blip เดียว)
      // → retry ต่อรูป และถ้ารูปนี้ล้มจริง ให้ข้ามรูปนั้น ไม่ throw ทำให้ทั้ง job ตาย
      try {
        const buffer = await withRetry(
          async () => {
            const response = await fetch(images[index].url, { signal: AbortSignal.timeout(30_000) });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return Buffer.from(await response.arrayBuffer());
          },
          { maxRetries: 2, initialDelayMs: 1500, maxDelayMs: 6000 }
        );
        fs.writeFileSync(output, buffer);
      } catch (error: unknown) {
        logger.warn(`⚠️ ดาวน์โหลดรูปรีวิว ${index + 1} ล้มเหลว (${String(error instanceof Error ? error.message : error).slice(0, 60)}) — ข้ามรูปนี้`);
        continue;
      }
    }
    files.push({ path: output, url: images[index].url });
  }
  return files;
}

/**
 * URL ของรูปตั้งต้นที่งานก่อนหน้าของสินค้าตัวนี้ใช้ไปแล้ว
 *
 * งานใหม่บันทึก `sourceImageUrl` ไว้ตรงๆ ส่วนงานเก่ามีแต่ path — ตอนนั้นทุกงานหยิบ 8 ใบแรก
 * เสมอ เลขผู้สมัครในชื่อไฟล์จึงตรงกับลำดับในสื่อทั้งกองพอดี ถอดกลับเป็น URL ได้
 * (ถ้า media_json ถูกเก็บใหม่จนลำดับเลื่อน การถอดจะเพี้ยน — ยอมได้ เพราะนี่คือ
 * "พยายามไม่ให้ซ้ำ" ไม่ใช่ด่านความถูกต้อง อย่างมากก็เสนอรูปที่เคยใช้มาอีกใบเดียว)
 */
export async function usedSourceImageUrls(
  itemId: number,
  exceptJobId: number,
  mediaJson: unknown
): Promise<Set<string>> {
  const eligible = eligibleReviewMediaEntries(mediaJson).filter((item) => item.type === 'image');
  const used = new Set<string>();
  for (const row of await usedSourceImagesForItem(itemId, exceptJobId)) {
    if (row.url) { used.add(row.url); continue; }
    const legacy = /review_candidate_(\d+)\./i.exec(String(row.path || ''));
    if (!legacy) continue;
    const entry = eligible[Number(legacy[1]) - 1];
    if (entry) used.add(entry.url);
  }
  return used;
}

/** Copy trusted product assets into the job directory so /api/media can serve them safely. */
export async function prepareOfficialImages(jobId: number, sourcePaths: string[]): Promise<string[]> {
  const jobDir = path.resolve(config.outputDir, `job_${jobId}`);
  fs.mkdirSync(jobDir, { recursive: true });
  const files: string[] = [];
  for (let index = 0; index < sourcePaths.length; index++) {
    const raw = String(sourcePaths[index] || '').trim();
    if (!raw) continue;
    // รูปทางการมาได้ 2 ทาง: URL จาก Shopee (harvester 0.2.7) หรือไฟล์ในเครื่อง (product-briefs)
    // เดิมรองรับแต่ไฟล์ในเครื่อง พอ Shopee ส่ง URL มาเลย copyFileSync พังด้วย ENOENT
    // (job #79: copyfile 'X:\...\new\https://down-th.img.susercontent.com/...')
    const isRemote = /^https?:\/\//i.test(raw);
    const extname = isRemote
      ? path.extname(new URL(raw).pathname).toLowerCase()
      : path.extname(raw).toLowerCase();
    const ext = ['.jpg', '.jpeg', '.png', '.webp'].includes(extname) ? extname : '.jpg';
    const output = path.join(jobDir, `official_candidate_${index + 1}${ext}`);
    try {
      if (isRemote) {
        if (!fs.existsSync(output) || fs.statSync(output).size < 1024) {
          const buffer = await withRetry(async () => {
            const response = await fetch(raw, { signal: AbortSignal.timeout(30_000) });
            if (!response.ok) throw new Error(`โหลดรูปทางการไม่สำเร็จ (${response.status})`);
            return Buffer.from(await response.arrayBuffer());
          }, { maxRetries: 2, initialDelayMs: 1_500, maxDelayMs: 6_000 });
          fs.writeFileSync(output, buffer);
        }
      } else {
        const source = path.resolve(raw);
        if (!fs.existsSync(output) || fs.statSync(output).size !== fs.statSync(source).size) {
          fs.copyFileSync(source, output);
        }
      }
      await assertValidImage(output);
      files.push(output);
    } catch (error: any) {
      // รูปเดียวพังต้องไม่ล้มทั้งงาน — ข้ามรูปนั้นแล้วใช้รูปที่เหลือต่อ
      logger.warn(`⚠️ ข้ามรูปทางการรูปที่ ${index + 1} ของงาน #${jobId}: ${String(error?.message || error)}`);
      if (fs.existsSync(output)) fs.rmSync(output, { force: true });
    }
  }
  return files;
}
