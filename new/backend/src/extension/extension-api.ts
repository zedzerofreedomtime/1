import fs from 'fs';
import path from 'path';
import { config } from '../config.js';
import { getPool } from '../db/database.js';
import { updateJob } from '../db/job-repository.js';
import {
  analyzeAndCreatePrompts,
  loadProductAssets,
  normalizeSelectedImageIndices,
} from '../gemini/prompt-generator.js';
import { logNarrationRepairs } from '../gemini/narration-rules.js';
import { downloadImages, prepareOfficialImages, usedSourceImageUrls } from './media-intake.js';
import { buildReferenceImagePlan } from './reference-image-plan.js';
import { buildIngredientPaths, withIngredientGuidance } from './ingredient-plan.js';
import { logger, logEvent, traceStep } from '../utils/logger.js';
import { isTransientNetworkError, withRetry } from '../utils/retry.js';
import { extractLastFrame, rotateImageUpright } from '../utils/media.js';
import { eligibleReviewMediaEntries, REVIEW_MEDIA_START_EPOCH_SECONDS } from '../utils/review-media.js';
import type { GeminiVisionResult } from '../types.js';

import { pickIngredientImages } from '../gemini/ingredient-images.js';
import { clipCountForDuration, normalizeTargetDuration } from './job-duration.js';
import { pickReferenceStyle } from './reference-style.js';
import { demoActionFor } from '../gemini/shot-categories.js';
import { finalizeExtensionJob } from './job-finalize.js';

// ── โมดูลที่แยกออกไปแล้ว ────────────────────────────────────────────────
// ไฟล์นี้ยังเป็นทางเข้าเดียว (barrel) ผู้เรียกเดิมจึงไม่ต้องแก้ import แม้โค้ดย้ายบ้านแล้ว
export type { ExtensionRuntime } from './runtime-state.js';
export { readExtensionRuntime, writeExtensionRuntime } from './runtime-state.js';
export { finalizeExtensionJob, failExtensionJob, pauseExtensionJob } from './job-finalize.js';
export { withIngredientGuidance } from './ingredient-plan.js';
export { buildReferenceImagePlan } from './reference-image-plan.js';
export {
  storeExtensionClip,
  importExtensionGeneratedImage,
  importExtensionDownload,
  validateExtensionDownload,
} from './clip-intake.js';


/**
 * Fail jobs that claim to be in progress but are no longer owned by the live
 * Extension. A paid generation may legitimately take up to 15 minutes, so the
 * stale threshold must stay above that provider timeout.
 */
export async function failOrphanedExtensionJobs(
  activeJobId: number | null,
  staleMinutes = 20
): Promise<number[]> {
  const db = getPool();
  const result = await db.query(`
    UPDATE flow_job
    SET status = 'failed',
        error_message = 'งานผีค้าง ' || status || ' เกิน ${staleMinutes} นาทีโดยไม่มี Extension ดูแล — watchdog หยุดอัตโนมัติ',
        worker_id = NULL,
        updated_at = NOW()
    WHERE status IN (
      'downloading_media',
      'generating_prompt',
      'generating_image',
      'generating_videos',
      'generating_tts',
      'assembling'
    )
      AND updated_at < NOW() - ($1 || ' minutes')::interval
      AND ($2::integer IS NULL OR id <> $2::integer)
    RETURNING id
  `, [String(staleMinutes), activeJobId]);
  const ids = result.rows.map((row) => Number(row.id));
  if (ids.length) {
    logger.warn(`🧹 Orphan watchdog หยุดงานผี ${ids.map((id) => `#${id}`).join(', ')}`);
  }
  return ids;
}

export async function createExtensionJob(itemId: number, targetDurationSeconds: 16 | 24 = 16): Promise<number> {
  const db = getPool();
  const item = await db.query('SELECT id, review_summary, media_json FROM item WHERE id = $1', [itemId]);
  if (!item.rows[0]) throw new Error('ไม่พบรีวิวที่เลือก');
  if (!eligibleReviewMediaEntries(item.rows[0].media_json).some((entry) => entry.type === 'image')) {
    throw new Error('สินค้านี้ไม่มีรูปรีวิวที่มีวันที่ตั้งแต่ 1 ส.ค. 2025 ถึงปัจจุบัน กรุณาเก็บรีวิวใหม่');
  }
  const existing = await db.query(
    `SELECT id FROM flow_job WHERE item_id = $1 AND status NOT IN ('completed', 'failed') ORDER BY id DESC LIMIT 1`,
    [itemId]
  );
  if (existing.rows[0]) throw new Error(`รีวิวนี้อยู่ในคิวแล้ว (งาน #${existing.rows[0].id})`);
  const created = await db.query(
    `INSERT INTO flow_job (item_id, review_text, status, target_duration_seconds) VALUES ($1, $2, 'pending', $3) RETURNING id`,
    [itemId, item.rows[0].review_summary, normalizeTargetDuration(targetDurationSeconds)]
  );
  return created.rows[0].id;
}

export async function ensureExtensionJob(itemId?: number, durationSeconds: number = 16): Promise<{
  id: number;
  itemId: number;
  created: boolean;
  random: boolean;
  targetDurationSeconds: 16 | 24;
}> {
  const db = getPool();
  const targetDurationSeconds = normalizeTargetDuration(durationSeconds);

  // Never add a second paid job when one is already waiting. Start should be
  // idempotent even if the popup is clicked twice or the MV3 worker wakes up
  // while the first request is still visible to the user.
  const queued = await db.query(`
    SELECT j.id, j.item_id, j.target_duration_seconds
    FROM flow_job j
    LEFT JOIN item i ON i.id = j.item_id
    WHERE j.status = 'pending'
      AND (
        (
          j.vision_result IS NOT NULL
          AND (
            jsonb_array_length(j.clip_paths) > 0
            OR COALESCE(j.vision_result->>'generatedImagePath', '') <> ''
          )
        )
        OR (
          i.id IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM jsonb_array_elements(i.media_json::jsonb) AS media
            WHERE media->>'type' = 'image'
              AND $1::double precision IS NOT NULL /* date filter removed — ใช้รูปทั้งหมด */
          )
        )
      )
    ORDER BY j.id ASC
    LIMIT 1
  `, [REVIEW_MEDIA_START_EPOCH_SECONDS]);
  if (queued.rows[0]) {
    return {
      id: Number(queued.rows[0].id),
      itemId: Number(queued.rows[0].item_id),
      created: false,
      random: false,
      targetDurationSeconds: normalizeTargetDuration(queued.rows[0].target_duration_seconds),
    };
  }

  if (Number.isInteger(itemId) && Number(itemId) > 0) {
    const id = await createExtensionJob(Number(itemId), targetDurationSeconds);
    return { id, itemId: Number(itemId), created: true, random: false, targetDurationSeconds };
  }

  // The user chose automatic mode. Pick exactly one usable product from the
  // same dataset/query used by the Web App and popup. This happens on Start,
  // so there is no separate "random" or "add to queue" click.
  const created = await db.query(`
    INSERT INTO flow_job (item_id, review_text, status, target_duration_seconds)
    SELECT i.id, i.review_summary, 'pending', $1
    FROM item i
    INNER JOIN dataset d ON d.id = i.dataset_id
    WHERE d.name = 'Shopee Scrape'
      AND i.review_summary <> ''
      AND i.media_json IS NOT NULL
      AND i.media_json <> '[]'
      AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(i.media_json::jsonb) AS media
        WHERE media->>'type' = 'image'
          AND $2::double precision IS NOT NULL /* date filter removed — ใช้รูปทั้งหมด */
      )
      AND NOT EXISTS (
        SELECT 1 FROM flow_job j
        WHERE j.item_id = i.id
          AND j.status NOT IN ('completed', 'failed')
      )
    -- เลือก "สินค้าที่ข้อมูลพร้อม" ก่อนเสมอ แล้วค่อยหมุนเวียนภายในกลุ่มนั้น
    -- (เดิม ORDER BY random() ล้วน — ตอนนี้มีสเปกแค่ 16/50 จึงสุ่มไปโดนของไม่มีข้อมูล ~68%
    --  ได้บทพากย์อ่อน + ใช้ reference หลายมุมไม่ได้ ทั้งที่จ่ายเครดิตเท่ากัน)
    --
    -- ⚠️ WHERE ข้างบนกันแค่สินค้าที่ "มีงานค้างอยู่" เท่านั้น พองานจบ/ล้ม สินค้านั้นกลับมา
    -- ถูกสุ่มได้ทันที รวมกับกลุ่มข้อมูลพร้อมที่มีแค่ ~15 ตัว → ซ้ำกันรัวๆ
    -- (#99 กับ #101 ได้ item 1601 เหมือนกัน, item 69 ถูกใช้ไป 19 งาน)
    -- เพิ่มลำดับ "ยังไม่เคยใช้ก่อน แล้วค่อยตัวที่ใช้นานสุด" เพื่อไล่ให้ครบคลังก่อนวนซ้ำ
    ORDER BY (
      COALESCE(LENGTH(i.product_detail), 0) > 0
      AND jsonb_array_length(COALESCE(i.official_images, '[]'::jsonb)) > 0
    ) DESC,
    (SELECT MAX(j.created_at) FROM flow_job j WHERE j.item_id = i.id) ASC NULLS FIRST,
    random()
    LIMIT 1
    RETURNING id, item_id, target_duration_seconds
  `, [targetDurationSeconds, REVIEW_MEDIA_START_EPOCH_SECONDS]);
  if (!created.rows[0]) {
    throw new Error('ไม่มีสินค้าที่พร้อมให้สุ่มอัตโนมัติ');
  }
  return {
    id: Number(created.rows[0].id),
    itemId: Number(created.rows[0].item_id),
    created: true,
    random: true,
    targetDurationSeconds,
  };
}

export async function claimAndPrepareExtensionJob() {
  const db = getPool();

  // สินค้าใน Web App และคิวของ Extension ใช้ฐานข้อมูลเดียวกัน แต่ flow_job
  // ตั้งใจไม่ผูก foreign key เพื่อเก็บประวัติงาน/ไฟล์ที่สร้างไปแล้วไว้ได้
  // ดังนั้นเมื่อลบสินค้า ต้องปิดเฉพาะงานที่ "ยังรอ" ไม่เช่นนั้นบอทจะ claim
  // งานกำพร้าแล้วล้มตอนพยายามอ่าน media_json ของ item ที่ไม่มีอยู่แล้ว
  const orphaned = await db.query(`
    UPDATE flow_job j
    SET status = 'failed',
        error_message = 'สินค้าต้นทางถูกลบจาก Web App แล้ว — ข้ามงานนี้อัตโนมัติ',
        worker_id = NULL,
        updated_at = NOW()
    WHERE j.status = 'pending'
      AND NOT EXISTS (SELECT 1 FROM item i WHERE i.id = j.item_id)
      AND (
        j.vision_result IS NULL
        OR (
          jsonb_array_length(j.clip_paths) = 0
          AND COALESCE(j.vision_result->>'generatedImagePath', '') = ''
        )
      )
    RETURNING j.id
  `);
  if (orphaned.rowCount) {
    logger.warn(
      `⚠️ ข้ามงานที่สินค้าต้นทางถูกลบ ${orphaned.rowCount} งาน: ${orphaned.rows.map((row) => `#${row.id}`).join(', ')}`
    );
  }

  const claimed = await db.query(`
    UPDATE flow_job SET status = 'downloading_media', worker_id = 9001, error_message = NULL, updated_at = NOW()
    WHERE id = (
      SELECT j.id FROM flow_job j
      LEFT JOIN item i ON i.id = j.item_id
      WHERE j.status = 'pending'
        AND (
          (
            j.vision_result IS NOT NULL
            AND (
              jsonb_array_length(j.clip_paths) > 0
              OR COALESCE(j.vision_result->>'generatedImagePath', '') <> ''
            )
          )
          OR (
            i.id IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM jsonb_array_elements(i.media_json::jsonb) AS media
              WHERE media->>'type' = 'image'
                AND $1::double precision IS NOT NULL /* date filter removed — ใช้รูปทั้งหมด */
            )
          )
        )
      ORDER BY j.id ASC
      FOR UPDATE OF j SKIP LOCKED LIMIT 1
    ) RETURNING *
  `, [REVIEW_MEDIA_START_EPOCH_SECONDS]);
  if (!claimed.rows[0]) return null;

  const row = claimed.rows[0];
  try {
    const item = await db.query(
      'SELECT media_json, title, official_images, product_detail FROM item WHERE id = $1',
      [row.item_id]
    );
    let vision: GeminiVisionResult | null = row.vision_result || null;
    let selectedPaths: string[] = row.review_image_paths || [];
    const clipPaths: string[] = row.clip_paths || [];
    const targetDurationSeconds = normalizeTargetDuration(row.target_duration_seconds);
    const clipCount = clipCountForDuration(targetDurationSeconds);

    if (!vision || selectedPaths.length !== 1 || !fs.existsSync(selectedPaths[0])) {
      if (!item.rows[0]) {
        await updateJob(row.id, {
          status: 'failed',
          workerId: null,
          errorMessage: 'สินค้าต้นทางถูกลบและ checkpoint ไม่สมบูรณ์ — ยกเลิกโดยไม่ใช้เครดิต',
        });
        logger.warn(`⚠️ ยกเลิกงาน #${row.id}: สินค้า #${row.item_id} ถูกลบและข้อมูล checkpoint ไม่ครบ`);
        return claimAndPrepareExtensionJob();
      }
      await updateJob(row.id, { status: 'generating_prompt' });
      const productTitle = item.rows[0]?.title || '';
      const productAssets = loadProductAssets(productTitle);
      // รูปทางการที่ scrape จาก Shopee (item.official_images) มีสิทธิ์ก่อน — สดและตรงสินค้าจริง
      // แล้วค่อย fallback เป็น brief static (product-briefs.json) → สุดท้ายเป็นรูปรีวิว
      const scrapedOfficial: string[] = Array.isArray(item.rows[0]?.official_images)
        ? item.rows[0].official_images.filter((url: unknown): url is string => typeof url === 'string')
        : [];
      const officialImages = scrapedOfficial.length ? scrapedOfficial : productAssets.officialImages;
      // เจ้าของสั่ง 27 ก.ค. 2026: เฟรมตั้งต้นให้ใช้ "รูปจากรีวิว" เป็นหลัก
      // รูปทางการของ Shopee ส่วนใหญ่เป็นแบนเนอร์โฆษณา (นางแบบ ตัวหนังสือไทย ป้ายราคา คอลลาจ)
      // ซึ่งเสี่ยงให้โมเดลลอกตัวหนังสือ/สไตล์แบนเนอร์มาใส่ ส่วนรูปรีวิวเป็นภาพถ่ายของจริง
      // รูปทางการยังถูกใช้ต่อในฐานะ "ส่วนผสม/reference" ตอนเจนคลิป
      const preferReview = config.firstImageSource === 'review';
      const officialPaths = officialImages.length
        ? await traceStep(
          { source: 'service', stage: 'media.official', message: `เตรียมรูปสินค้าทางการ ${officialImages.length} รูป`, jobId: row.id },
          () => prepareOfficialImages(row.id, officialImages)
        )
        : [];
      // 🐛 3 ส.ค. 2026 เจ้าของทักว่า "รูปที่สุ่มออกมามีแต่รูปเดิมๆ ตลอดเลย" — ตรวจแล้วจริง
      // โลชั่น Oriental Princess ถูกทำ 5 งานแล้วเลือก review_candidate_6 ทั้งห้าครั้ง
      // ต้นเหตุคือ downloadImages หยิบ "8 ใบแรก" ชุดเดิมเสมอ ทั้งที่สินค้านั้นมีสื่อ 175 ชิ้น
      const usedImageUrls = await usedSourceImageUrls(row.item_id, row.id, item.rows[0]?.media_json);
      const reviewCandidates = preferReview || !officialPaths.length
        ? await traceStep(
          { source: 'service', stage: 'media.download', message: 'ดาวน์โหลดรูปผู้สมัครจากรีวิว', jobId: row.id },
          () => downloadImages(row.id, item.rows[0]?.media_json, usedImageUrls)
        )
        : [];
      const reviewPaths = reviewCandidates.map((candidate) => candidate.path);
      const candidates = preferReview && reviewPaths.length ? reviewPaths : (officialPaths.length ? officialPaths : reviewPaths);
      if (!candidates.length) throw new Error('ไม่มีรูปสินค้าทางการหรือรูปรีวิวให้ Gemini เลือก');
      const candidateSource = candidates === reviewPaths ? 'รูปรีวิว' : 'รูปสินค้าทางการ';
      logger.info(`🖼️ งาน #${row.id} เฟรมตั้งต้นใช้${candidateSource} ${candidates.length} รูป (official สำรองไว้ ${officialPaths.length} รูป)`);
      const referenceStyle = pickReferenceStyle(productTitle);
      vision = await traceStep(
        { source: 'gemini', stage: 'vision.plan', message: `วิเคราะห์และเลือกรูปจาก ${candidates.length} รูป`, jobId: row.id },
        () => withRetry(
          () => analyzeAndCreatePrompts(
            row.review_text,
            candidates,
            productTitle,
            clipCount,
            referenceStyle,
            String(item.rows[0]?.product_detail || '').trim().slice(0, 1800)
          ),
          {
            maxRetries: 2,
            initialDelayMs: 2_000,
            retryOn: (error) => {
              const message = String(error?.message || error);
              return (message.includes('บทพากย์คลิป') && message.includes('สั้นเกินไป'))
                || message.includes('shotPlans')
                || message.includes('imagePrompt');
            },
          }
        )
      );
      const selectedIndex = normalizeSelectedImageIndices(vision.selectedImageIndices, candidates.length, 1)[0];
      selectedPaths = [candidates[selectedIndex]];
      // เก็บ URL ต้นทางของรูปที่เลือกไว้ ให้งานถัดไปของสินค้าตัวนี้กันซ้ำได้ตรงๆ
      // (งานเก่าไม่มีค่านี้ ต้องถอดจากเลขผู้สมัครในชื่อไฟล์แทน — ดู usedSourceImageUrls)
      // เลือกจากรูปทางการเมื่อไร ไม่มี URL รีวิวให้บันทึก ปล่อยว่างไว้ตามจริง
      vision.sourceImageUrl = candidates === reviewPaths
        ? reviewCandidates[selectedIndex]?.url
        : undefined;

      // 🐛 job_155 (ผ้ารองรีด Yanuo Xuan): รูปรีวิวถ่ายมากลับหัว ทั้งเส้นทางจึงกลับหัวตาม
      // ตัวหนังสือ "IRONING BOARD COVER" กลับหัวตลอด 16 วินาที = คลิปใช้ขายไม่ได้เลย
      //
      // ⚠️ ไม่มีด่านไหนจับได้เลย เพราะทุกด่านถามว่า "ตรงกับรูปต้นฉบับไหม" ซึ่งตรงเป๊ะ
      // และคำสั่งในพรอมต์ ("rotate so the front label reads right way up") ก็เอาไม่อยู่
      // เพราะรูปที่อัปเข้าไปคือความจริงที่โมเดลยึดแน่นกว่าคำสั่งที่เป็นตัวหนังสือ
      // (job #122 เคยเจอเรื่องนี้แล้วครั้งหนึ่ง แก้ด้วยการเติมคำสั่ง ซึ่งไม่พอ)
      //
      // แก้ที่พิกเซลก่อนอัปจึงเป็นทางเดียวที่ได้ผลแน่นอน — ทำก่อนทุกอย่างที่ตามมา
      // ทั้งเฟรมตั้งต้น ส่วนผสม และด่านเทียบสินค้า จะได้เห็นรูปที่ตั้งตรงเหมือนกันหมด
      const uprightRotation = Number(vision.sourceImageAssessment?.uprightRotationDegrees) || 0;
      if (uprightRotation) {
        const rotated = await rotateImageUpright(selectedPaths[0], uprightRotation);
        if (rotated) {
          logger.info(
            `🔄 งาน #${row.id}: รูปต้นทางถ่ายมาเอียง/กลับหัว — หมุน ${uprightRotation}° ให้ตัวหนังสือตั้งตรงก่อนใช้`
          );
        }
      }
      // รูป "ส่วนผสม" ต้องมาจากรูปทางการเสมอ (มุมสินค้าหลายด้านของชิ้นจริง)
      // ไม่ใช่จาก candidates เพราะตอนนี้ candidates อาจเป็นรูปรีวิวซึ่งเป็นคนละมุมกล้อง/คนละชิ้น
      //
      // ⚠️ เก็บไว้เสมอโดยไม่ผูกกับ referenceImagesEnabled เพราะรายการนี้ถูกใช้ 2 ที่:
      //   1) แนบเป็น reference ตอนเจนรูป (วิธี A) — ควบคุมด้วย referenceImagesEnabled
      //   2) เป็น "ส่วนผสม" ตอนเจนคลิป 1 — ต้องมีเสมอถ้าเปิดโหมดส่วนผสม
      // ถ้าผูกทั้งก้อนกับ flag เดียว พอปิดวิธี A ส่วนผสมจะหายไปด้วยทั้งที่ยังต้องใช้
      // คัดด้วยตาของ Gemini ไม่ใช่หยิบ 3 ใบแรก — รูปทางการของ Shopee ส่วนใหญ่เป็นโปสเตอร์
      // ที่มีตัวหนังสือเต็มภาพ ซึ่งพอเอาไปเป็นส่วนผสมแล้วโมเดลจะวาดตัวหนังสือมั่วลงบนสินค้า
      const { picked: referenceImagePaths } = await pickIngredientImages(
        officialPaths.filter((imagePath) => imagePath !== selectedPaths[0]),
        String(item.rows[0]?.title || ''),
        config.referenceImageCount
      );
      // แนบตอน "เจนรูป" เฉพาะเมื่อเปิดวิธี A เท่านั้น — ค่าเริ่มต้นคือไม่แนบ เพราะเจ้าของ
      // ออกแบบให้เฟรมตั้งต้นใช้รูปเดียว แล้วค่อยเอารูปทางการไปเป็นส่วนผสมตอนเจนคลิป
      const attachAtImageStage = config.referenceImagesEnabled && referenceImagePaths.length > 0;
      if (attachAtImageStage) {
        logger.info(`🖼️ งาน #${row.id} แนบรูปมุมเสริม ${referenceImagePaths.length} รูปเป็น reference (วิธี A)`);
      } else if (referenceImagePaths.length) {
        logger.info(`🧪 งาน #${row.id} เก็บรูปทางการ ${referenceImagePaths.length} รูปไว้เป็นส่วนผสมตอนเจนคลิป (เจนรูปใช้รูปเดียว)`);
      }
      // ท่าของคลิป 2 บางหมวดต้องการให้สินค้าเปิดฝามาแล้วตั้งแต่เฟรมตั้งต้น (job_160/job_162)
      const demoStartState = demoActionFor(productTitle)?.startState;
      const plan = buildReferenceImagePlan(referenceStyle, vision.imagePrompt, demoStartState);
      vision = {
        ...vision,
        ...plan,
        // ต้องบอกให้ชัดว่ารูปที่แนบเพิ่มคือ "สินค้าตัวเดียวกันมุมอื่น" ไม่ใช่สินค้าคนละชิ้น
        // ไม่งั้นโมเดลอาจประกอบเป็นหลายชิ้น/ผสมร่างแทนที่จะใช้เป็นข้อมูลอ้างอิงรูปทรง
        // ประโยคอธิบาย "รูปเสริม" ต้องมีเฉพาะตอนที่แนบรูปเสริมจริงๆ ไม่งั้นพรอมต์จะพูดถึง
        // รูปที่ไม่มีอยู่ ทำให้โมเดลสับสนและพรอมต์ยาวเกินจำเป็น
        imagePrompt: attachAtImageStage
          ? `${plan.imagePrompt} The extra photos are the SAME product from other angles — use them only for its true shape and materials. Render exactly ONE product, never a collage.`
          : plan.imagePrompt,
        sourceImagePath: selectedPaths[0],
        referenceImagePaths,
      };
      logNarrationRepairs(row.id, vision.narrationRepairs || []);
      await updateJob(row.id, { visionResult: vision, reviewImagePaths: selectedPaths });
    }

    if (!vision.imagePrompt || !vision.endImagePrompt) {
      const referenceStyle = {
        handGender: vision.handGender,
        handCount: 1 as const,
        backgroundStyle: vision.backgroundStyle,
      };
      vision = {
        ...vision,
        // บล็อกนี้อยู่นอกขอบเขตของ productTitle ข้างบน — อ่านชื่อจากแถว item ตรงนี้เอง
        ...buildReferenceImagePlan(
          referenceStyle,
          vision.imagePrompt,
          demoActionFor(String(item.rows[0]?.title || ''))?.startState
        ),
        sourceImagePath: selectedPaths[0],
      };
      await updateJob(row.id, { visionResult: vision });
    }

    if (!clipPaths.length && (!vision.generatedImagePath || !fs.existsSync(vision.generatedImagePath))) {
      await updateJob(row.id, { status: 'generating_image' });
      return {
        stage: 'image' as const,
        jobId: row.id,
        itemId: row.item_id,
        clipIndex: 0,
        imagePath: selectedPaths[0],
        prompt: vision.imagePrompt,
        clipPaths,
        clipUrls: row.clip_urls || [],
        clipCount,
        targetDurationSeconds,
        imageRole: 'start' as const,
        // วิธี A: มุมเสริม แนบเฉพาะเฟรมต้นเท่านั้น (เฟรมปลายอ้างอิงเฟรมต้นที่ผ่าน fidelity แล้ว
        // การยัด reference เพิ่มตอนนั้นจะไปกวนการหมุน 35° ของวิธี B)
        referenceImagePaths: (config.referenceImagesEnabled && Array.isArray(vision.referenceImagePaths)
          ? vision.referenceImagePaths.filter((p) => p && fs.existsSync(p))
          : []),
      };
    }

    // End-frame is a separate paid image checkpoint. Generate it exactly once
    // after the accepted start frame and before the first paid video request.
    // kill-switch: ปิดด้วย config.endFrameEnabled=false → ข้ามขั้นนี้ทั้งหมด
    // (endImagePath ไม่ถูกตั้ง → background ไม่ส่ง endImageUrl → uploadEndFrame ไม่ทำงาน
    //  → clips ใช้ start frame อย่างเดียว = พฤติกรรมก่อนมี End-frame)
    if (config.endFrameEnabled && !clipPaths.length && (!vision.endImagePath || !fs.existsSync(vision.endImagePath))) {
      await updateJob(row.id, { status: 'generating_image' });
      return {
        stage: 'image' as const,
        imageRole: 'end' as const,
        jobId: row.id,
        itemId: row.item_id,
        clipIndex: 0,
        imagePath: vision.generatedImagePath!,
        prompt: vision.endImagePrompt!,
        clipPaths,
        clipUrls: row.clip_urls || [],
        clipCount,
        targetDurationSeconds,
      };
    }

    const clipUrls: string[] = row.clip_urls || [];

    // ── ด่านกันเจนคลิปเกิน (สำคัญมาก: กันเผาเครดิต) ──
    // ถ้าคลิปครบแล้ว ต้องไป "ประกอบวิดีโอ" ห้ามคืน stage 'video' เด็ดขาด
    // บั๊กจริง job #69: คลิปครบ 2 แล้ว แต่ finalize ล้มเพราะเน็ตหลุดตอน TTS → งานกลับเป็น pending
    // → ถูก claim ใหม่ → โค้ดเดิมไม่เช็คจำนวน เลยสั่งเจน clipIndex 2 (คลิปที่ 3) = เสียเครดิตฟรี
    // → แล้ว finalize ปฏิเสธถาวรเพราะ 3 ≠ 2 ("คลิปยังไม่ครบ 2 (มี 3)") งานค้างตลอดกาล
    if (clipPaths.length >= clipCount) {
      await traceStep(
        { source: 'service', stage: 'job.finalize', message: 'คลิปครบแล้ว — ประกอบวิดีโอโดยไม่เจนคลิปเพิ่ม', jobId: row.id },
        () => finalizeExtensionJob(row.id)
      );
      return claimAndPrepareExtensionJob();
    }

    const imagePath = clipPaths.length
      ? path.resolve(config.outputDir, `job_${row.id}`, `continuity_${clipPaths.length}.jpg`)
      : (vision.generatedImagePath || selectedPaths[0]);

    if (clipPaths.length && !fs.existsSync(imagePath)) {
      await traceStep(
        { source: 'ffmpeg', stage: 'continuity.frame', message: 'ดึงเฟรมสุดท้ายสำหรับคลิปถัดไป', jobId: row.id, clipIndex: clipPaths.length - 1 },
        () => extractLastFrame(clipPaths[clipPaths.length - 1], imagePath)
      );
    }

    await updateJob(row.id, { status: 'generating_videos' });
    // ⚠️ ต้องคำนวณก่อน return เพราะพรอมต์ต้องรู้ว่าแนบรูปไปกี่ใบ ไม่งั้นจะเกิดช่องโหว่
    // เดิมที่แนบรูป 4 ใบแล้วไม่บอกโมเดลว่าใบไหนคือของจริง (ดู withIngredientGuidance)
    const ingredientPaths = config.ingredientsModeEnabled && !clipPaths.length
      ? buildIngredientPaths(imagePath, vision)
      : [];
    return {
      jobId: row.id,
      stage: 'video' as const,
      itemId: row.item_id,
      clipIndex: clipPaths.length,
      imagePath,
      prompt: withIngredientGuidance(
        vision.motionPrompts[clipPaths.length] || vision.motionPrompts[0],
        ingredientPaths.length
      ),
      clipPaths,
      clipUrls,
      clipCount,
      targetDurationSeconds,
      // ต้องเช็ค endFrameEnabled ตรงนี้ด้วย ไม่ใช่แค่ตอนตัดสินใจ "เจน End frame ใหม่"
      // งานที่ถูกสร้างตอน flag ยังเปิด (เช่น #98) มี endImagePath ค้างบนดิสก์อยู่แล้ว
      // ถ้าไม่กรอง พอ resume จะยังอัปโหลด End frame เข้า Flow = ทำในสิ่งที่เพิ่งสั่งปิดไป
      ...(config.endFrameEnabled && vision.endImagePath && fs.existsSync(vision.endImagePath)
        ? { endImagePath: vision.endImagePath }
        : {}),
      // ส่วนผสมของคลิปแรก = รูปที่ Flow เจนไว้ (ผ่าน fidelity แล้ว) + รูปทางการอีก 3 รูป
      // คลิปถัดไปไม่ส่ง เพราะต้องต่อจากเฟรมสุดท้ายด้วยโหมดเฟรม
      ...(ingredientPaths.length ? { ingredientImagePaths: ingredientPaths } : {}),
    };
  } catch (error: any) {
    logEvent({ source: 'service', stage: 'job.prepare', message: 'เตรียมงานไม่สำเร็จ', level: 'error', jobId: row.id, error });
    // เน็ตกระตุกตอนเตรียมงาน ≠ งานเสีย — ยังไม่ได้จ่ายเครดิต Flow แม้แต่บาทเดียว
    //
    // 🐛 ถ้าโยน error ออกไปตอนนี้ Extension จะยังไม่มี currentJob → เข้าเส้นทาง
    // "หยุดเพื่อความปลอดภัย" แล้วบอทดับทั้งตัว รอเจ้าของมากดเริ่มใหม่ ทั้งที่ Gemini
    // แค่ตอบไม่ได้ไปสิบวินาที (retry ในตัวเรียก Gemini หมดแล้วถึงจะมาถึงตรงนี้)
    // → คืนงานกลับคิวแล้วบอกว่า "ยังไม่มีงาน" แทน บอทจะรอรอบหน้าเองโดยไม่หยุด
    if (isTransientNetworkError(error)) {
      await updateJob(row.id, {
        status: 'pending',
        workerId: null,
        errorMessage: `เตรียมงานไม่สำเร็จชั่วคราว (${String(error?.message || error).slice(0, 120)}) — คืนงานกลับคิวแล้ว`,
      });
      logger.warn(`⚠️ งาน #${row.id} เตรียมไม่สำเร็จเพราะเครือข่าย — คืนกลับคิว บอทจะลองใหม่รอบถัดไป (ไม่หยุดระบบ)`);
      return null;
    }
    await updateJob(row.id, { status: 'failed', errorMessage: String(error?.message || error) });
    throw error;
  }
}
