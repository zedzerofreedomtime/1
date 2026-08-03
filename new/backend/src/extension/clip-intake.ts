import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { createHash, randomUUID } from 'crypto';

import { config } from '../config.js';
import { getPool } from '../db/database.js';
import { updateJob } from '../db/job-repository.js';
import { buildFlowContinuationPrompt, compareGeneratedProductFidelity } from '../gemini/prompt-generator.js';
import { logger, traceStep } from '../utils/logger.js';
import { assertValidImage, assertValidVideo, extractLastFrame } from '../utils/media.js';
import { withRetry } from '../utils/retry.js';
import type { GeminiVisionResult } from '../types.js';
import { clipCountForDuration, normalizeTargetDuration } from './job-duration.js';
import { assertClipMatchesItsSourceFrame } from './clip-fidelity.js';
import { buildIngredientPaths, withIngredientGuidance } from './ingredient-plan.js';

const execFileAsync = promisify(execFile);

/**
 * ขาเข้าของ "ของที่ Flow ผลิตเสร็จ" — รูปตั้งต้นและคลิป
 *
 * แยกออกจาก extension-api.ts เมื่อ 1 ส.ค. 2026 ไฟล์นั้นถือทั้งขาออก (จ่ายงานให้บอท)
 * และขาเข้า (รับผลกลับ) ปนกัน ซึ่งเป็นคนละจังหวะของงานและแก้คนละเหตุผลเสมอ
 *
 * ⚠️ ทุกฟังก์ชันในนี้ทำงาน "หลังจ่ายเครดิตไปแล้ว" การโยน error ตรงนี้เท่ากับทิ้งของที่ซื้อมา
 * ให้ตรวจแล้วเก็บหลักฐานไว้เสมอ (ดู assertClipMatchesItsSourceFrame ที่เก็บไฟล์ _rejected)
 */

export async function storeExtensionClip(jobId: number, clipIndex: number, video: Buffer, sourceUrl: string) {
  const db = getPool();
  const result = await db.query('SELECT clip_paths, clip_urls, vision_result, target_duration_seconds FROM flow_job WHERE id = $1', [jobId]);
  if (!result.rows[0]) throw new Error('ไม่พบงาน');
  const jobDir = path.resolve(config.outputDir, `job_${jobId}`);
  fs.mkdirSync(jobDir, { recursive: true });
  const clipPath = path.join(jobDir, `job_${jobId}_video_${clipIndex + 1}.mp4`);

  const clipPaths: string[] = result.rows[0].clip_paths || [];
  const clipUrls: string[] = result.rows[0].clip_urls || [];
  const clipCount = clipCountForDuration(result.rows[0].target_duration_seconds);

  // A stored checkpoint is append-only. Reject both skipped indexes and an
  // attempt to overwrite a clip that is already safely recorded in the DB.
  if (clipIndex !== clipPaths.length) {
    throw new Error(
      `คลิปมาผิดลำดับ: ได้ index ${clipIndex} แต่ index ถัดไปต้องเป็น ${clipPaths.length}`
    );
  }

  if (clipUrls.includes(sourceUrl)) {
    throw new Error('Flow returned a video URL that is already saved for this job');
  }

  const incomingHash = createHash('sha256').update(video).digest('hex');
  for (const existingPath of clipPaths) {
    if (!existingPath || !fs.existsSync(existingPath)) continue;
    const existingHash = createHash('sha256').update(fs.readFileSync(existingPath)).digest('hex');
    if (existingHash === incomingHash) {
      throw new Error('Flow returned duplicate video content; the clip was not counted twice');
    }
  }

  // Validate a temporary file first. Writing directly to clipPath could replace
  // a good checkpoint with an HTML/image/error payload before ffprobe rejects it.
  const incomingPath = `${clipPath}.${randomUUID()}.incoming.mp4`;
  try {
    fs.writeFileSync(incomingPath, video);
    await assertValidVideo(incomingPath);
    await assertClipMatchesItsSourceFrame(jobId, clipIndex, incomingPath, jobDir, result.rows[0].vision_result);
    if (fs.existsSync(clipPath)) fs.rmSync(clipPath, { force: true });
    fs.renameSync(incomingPath, clipPath);
  } finally {
    if (fs.existsSync(incomingPath)) fs.rmSync(incomingPath, { force: true });
  }

  clipPaths[clipIndex] = clipPath;
  clipUrls[clipIndex] = sourceUrl;
  await updateJob(jobId, { clipPaths, clipUrls, status: 'generating_videos' });

  if (clipIndex + 1 >= clipCount) return { done: true, clipCount };
  const framePath = path.join(jobDir, `continuity_${clipIndex + 1}.jpg`);
  await extractLastFrame(clipPath, framePath);
  const vision = result.rows[0].vision_result as GeminiVisionResult;
  const basePrompt = vision.motionPrompts[clipIndex + 1] || vision.motionPrompts[0];
  return {
    done: false,
    imagePath: framePath,
    prompt: buildFlowContinuationPrompt(basePrompt),
    clipCount,
  };
}

/** นำรูปที่ Flow สร้างผ่าน Chrome Downloads มาเก็บเป็น checkpoint ก่อนเริ่มวิดีโอ */
export async function importExtensionGeneratedImage(
  jobId: number,
  downloadPath: string,
  sourceUrl: string,
  imageRole: 'start' | 'end' = 'start'
) {
  const db = getPool();
  const row = (await db.query(
    'SELECT vision_result, target_duration_seconds FROM flow_job WHERE id = $1',
    [jobId]
  )).rows[0];
  if (!row) throw new Error('ไม่พบงานสำหรับบันทึกรูปที่สร้าง');
  const vision = row.vision_result as GeminiVisionResult;
  const isEndImage = imageRole === 'end';

  const resolved = path.resolve(downloadPath);
  const actualName = path.basename(resolved);
  const expectedStem = `clipbot_job_${jobId}_generated_${isEndImage ? 'end' : 'start'}`
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const expectedCompatible = new RegExp(`^${expectedStem}(?: \\(\\d+\\))?\\.(?:png|jpe?g|webp)$`, 'i').test(actualName);
  let sourceCompatible = false;
  try {
    const source = new URL(sourceUrl);
    const mediaId = source.searchParams.get('name') || '';
    sourceCompatible = source.origin === 'https://labs.google'
      && source.pathname.includes('media.getMediaUrlRedirect')
      && /^[a-z0-9-]{16,}$/i.test(mediaId)
      && new RegExp(`^${mediaId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.(?:png|jpe?g|webp)$`, 'i').test(actualName);
  } catch { /* source URL is checked only when Chrome chose its own filename */ }
  if (!expectedCompatible && !sourceCompatible) {
    throw new Error(`ชื่อไฟล์รูปไม่ตรงกับงาน: ${actualName}`);
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw new Error('ไม่พบไฟล์รูปที่ Chrome ดาวน์โหลด');
  }
  if (fs.statSync(resolved).size > 50 * 1024 * 1024) throw new Error('ไฟล์รูปใหญ่เกิน 50 MB');
  await assertValidImage(resolved);

  const jobDir = path.resolve(config.outputDir, `job_${jobId}`);
  fs.mkdirSync(jobDir, { recursive: true });
  const outputPath = path.join(jobDir, `job_${jobId}_generated_${isEndImage ? 'end' : 'start'}.jpg`);
  const incomingPath = `${outputPath}.${randomUUID()}.incoming.jpg`;
  try {
    await execFileAsync(config.ffmpegPath, [
      '-y', '-i', resolved, '-frames:v', '1', '-q:v', '2', incomingPath,
    ], { timeout: 30_000 });
    await assertValidImage(incomingPath);
    const duplicateReferencePath = isEndImage
      ? vision.generatedImagePath
      : vision.sourceImagePath;
    if (duplicateReferencePath && fs.existsSync(duplicateReferencePath)) {
      const { stderr } = await execFileAsync(config.ffmpegPath, [
        '-i', incomingPath,
        '-i', duplicateReferencePath,
        '-lavfi', '[0:v]scale=256:256:flags=bicubic[a];[1:v]scale=256:256:flags=bicubic[b];[a][b]psnr',
        '-f', 'null', '-',
      ], { timeout: 30_000 });
      const match = String(stderr).match(/average:([0-9.]+|inf)/i);
      const psnr = match?.[1]?.toLowerCase() === 'inf' ? Infinity : Number(match?.[1]);
      if (Number.isFinite(psnr) ? psnr >= 40 : psnr === Infinity) {
        throw new Error(
          isEndImage
            ? 'Flow returned the unchanged start frame instead of a new end frame'
            : 'Flow returned the uploaded reference image instead of a newly generated image'
        );
      }

      let fidelity;
      try {
        fidelity = await traceStep(
          {
            source: 'gemini',
            stage: isEndImage ? 'image.end-fidelity' : 'image.fidelity',
            message: isEndImage
              ? 'เปรียบเทียบสินค้าต้นฉบับกับภาพปลายที่ Flow สร้าง'
              : 'เปรียบเทียบสินค้าต้นฉบับกับภาพที่ Flow สร้าง',
            jobId,
          },
          () => withRetry(
            () => compareGeneratedProductFidelity(vision.sourceImagePath!, incomingPath, isEndImage),
            { maxRetries: 1, initialDelayMs: 2_000 }
          )
        );
      } catch (error: any) {
        fidelity = {
          pass: false,
          score: 0,
          checks: {
            category: false,
            silhouette: false,
            openClosedState: false,
            colors: false,
            componentCount: false,
            componentLayout: false,
            visibleText: false,
          },
          differences: [`ตรวจความตรงของสินค้าไม่ได้: ${String(error?.message || error)}`],
        };
      }

      if (!fidelity.pass) {
        const rejectedPath = path.join(
          jobDir,
          `job_${jobId}_generated_${isEndImage ? 'end_' : ''}rejected.jpg`
        );
        if (fs.existsSync(rejectedPath)) fs.rmSync(rejectedPath, { force: true });
        fs.renameSync(incomingPath, rejectedPath);
        const reason = fidelity.differences.join('; ') || 'รายละเอียดสินค้าไม่ตรงภาพต้นฉบับ';
        const errorMessage = `PRODUCT_FIDELITY_BLOCK: ภาพที่สร้างไม่ตรงสินค้าต้นฉบับ (score ${fidelity.score}/100) — ${reason}`;
        await updateJob(jobId, {
          status: 'failed',
          workerId: null,
          errorMessage,
          visionResult: {
            ...vision,
            ...(isEndImage
              ? {
                  endImageFidelity: fidelity,
                  rejectedEndImagePath: rejectedPath,
                }
              : {
                  imageFidelity: fidelity,
                  rejectedGeneratedImagePath: rejectedPath,
                }),
          },
        });
        logger.warn(`🛑 งาน #${jobId} หยุดก่อนเจนวิดีโอ: ${errorMessage}`);
        throw new Error(errorMessage);
      }

      if (isEndImage) vision.endImageFidelity = fidelity;
      else vision.imageFidelity = fidelity;
    }
    if (fs.existsSync(outputPath)) fs.rmSync(outputPath, { force: true });
    fs.renameSync(incomingPath, outputPath);
  } finally {
    if (fs.existsSync(incomingPath)) fs.rmSync(incomingPath, { force: true });
  }

  const clipCount = clipCountForDuration(row.target_duration_seconds);
  const targetDurationSeconds = normalizeTargetDuration(row.target_duration_seconds);

  if (!isEndImage) {
    const updatedVision = {
      ...vision,
      generatedImagePath: outputPath,
      generatedImageUrl: sourceUrl,
    };
    // kill-switch เดียวกับตอน claim (END_FRAME_ENABLED) ต้องมีที่นี่ด้วย ไม่งั้นเส้นทาง
    // "เพิ่งเซฟเฟรมต้นเสร็จ" จะสั่งเจน End frame ต่อโดยไม่สนใจ flag
    if (!config.endFrameEnabled) {
      await updateJob(jobId, { visionResult: updatedVision, status: 'generating_videos' });
      logger.info(
        `🖼️ บันทึกรูปตั้งต้นจาก Flow สำหรับงาน #${jobId}: ${outputPath} — ข้าม End frame (ปิดไว้) ไปเจนคลิปเลย`
      );
      // เส้นทางนี้ส่งงานคลิปแรกตรงๆ ไม่ผ่าน claim จึงต้องแนบส่วนผสมเองด้วย
      // และต้องใส่คำอธิบายรูปเสริมเองด้วยเช่นกัน — ลืมจุดนี้ = ช่องโหว่ job_152 กลับมา
      const firstClipIngredients = config.ingredientsModeEnabled
        ? buildIngredientPaths(outputPath, updatedVision)
        : [];
      return {
        stage: 'video' as const,
        jobId,
        clipIndex: 0,
        imagePath: outputPath,
        prompt: withIngredientGuidance(updatedVision.motionPrompts[0], firstClipIngredients.length),
        clipPaths: [],
        clipUrls: [],
        clipCount,
        targetDurationSeconds,
        ...(firstClipIngredients.length ? { ingredientImagePaths: firstClipIngredients } : {}),
      };
    }
    await updateJob(jobId, { visionResult: updatedVision, status: 'generating_image' });
    logger.info(`🖼️ บันทึกรูปตั้งต้นจาก Flow สำหรับงาน #${jobId}: ${outputPath}`);
    return {
      stage: 'image' as const,
      imageRole: 'end' as const,
      jobId,
      clipIndex: 0,
      imagePath: outputPath,
      prompt: updatedVision.endImagePrompt!,
      clipPaths: [],
      clipUrls: [],
      clipCount,
      targetDurationSeconds,
    };
  }

  const updatedVision = {
    ...vision,
    endImagePath: outputPath,
    endImageUrl: sourceUrl,
  };
  await updateJob(jobId, { visionResult: updatedVision, status: 'generating_videos' });
  logger.info(`🖼️ บันทึก End frame จาก Flow สำหรับงาน #${jobId}: ${outputPath}`);
  // 🐛 เคยส่ง outputPath (= รูป "ปลาย") เป็น imagePath ด้วย → Flow ได้รูปเดียวกันทั้งช่อง
  // Start และ End → Veo interpolate จากภาพเดิมไปภาพเดิม = คลิปนิ่ง/เฟรมซ้ำ (อาการ "เจนหน้าเดิม 2 รอบ")
  // เฟรมแรกต้องเป็นรูปตั้งต้นที่ผ่าน fidelity แล้ว ส่วน outputPath เป็นเฟรมปลายเท่านั้น
  const startFramePath = updatedVision.generatedImagePath;
  if (!startFramePath || !fs.existsSync(startFramePath)) {
    throw new Error('ไม่พบรูปตั้งต้นที่ผ่าน fidelity สำหรับใช้เป็น Start frame ของคลิป 1');
  }
  return {
    stage: 'video' as const,
    jobId,
    clipIndex: 0,
    imagePath: startFramePath,
    prompt: updatedVision.motionPrompts[0],
    clipPaths: [],
    clipUrls: [],
    clipCount,
    targetDurationSeconds,
    endImagePath: outputPath,
  };
}

/**
 * นำคลิปที่ Chrome Downloads โหลดเสร็จแล้วเข้า checkpoint ของงาน
 *
 * ใช้แทน fetch() จาก content script เพราะ URL ของ Flow redirect ข้าม origin
 * และถูก CORS บล็อก แม้แท็ก <video> จะเล่นคลิปนั้นได้ตามปกติ
 */
export async function importExtensionDownload(
  jobId: number,
  clipIndex: number,
  downloadPath: string,
  sourceUrl: string
) {
  const { resolved, size } = await validateExtensionDownload(jobId, clipIndex, downloadPath, sourceUrl);
  const result = await storeExtensionClip(jobId, clipIndex, fs.readFileSync(resolved), sourceUrl);
  logger.info(`📥 นำคลิปจาก Chrome Downloads เข้า job #${jobId} clip ${clipIndex + 1} แล้ว (${Math.round(size / 1024)} KB)`);
  return { ...result, importedBytes: size };
}

/** ตรวจไฟล์จาก Chrome Downloads โดยไม่แก้ฐานข้อมูล ใช้กับ health check/dry run */
export async function validateExtensionDownload(
  jobId: number,
  clipIndex: number,
  downloadPath: string,
  sourceUrl = ''
) {
  const resolved = path.resolve(downloadPath);
  const expectedName = `clipbot_job_${jobId}_clip_${clipIndex + 1}.mp4`;
  const actualName = path.basename(resolved);
  const expectedStem = path.basename(expectedName, '.mp4').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Chrome อาจเติม " (1)" แม้กำหนด conflictAction=overwrite หากไฟล์เดิมยังถูกจับใช้งาน
  const expectedCompatible = new RegExp(`^${expectedStem}(?: \\(\\d+\\))?\\.mp4$`, 'i').test(actualName);
  let sourceCompatible = false;
  try {
    const source = new URL(sourceUrl);
    const mediaId = source.searchParams.get('name') || '';
    sourceCompatible = source.origin === 'https://labs.google'
      && source.pathname.includes('media.getMediaUrlRedirect')
      && /^[a-z0-9-]{16,}$/i.test(mediaId)
      && actualName.toLowerCase() === `${mediaId}.mp4`.toLowerCase();
  } catch { /* source URL is optional for dry-run checks */ }
  const compatibleName = expectedCompatible || sourceCompatible;
  if (!compatibleName) {
    throw new Error(`ชื่อไฟล์ดาวน์โหลดไม่ตรงกับงาน: ได้ "${actualName}" แต่ต้องเป็น ${expectedName}`);
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw new Error('ไม่พบไฟล์ที่ Chrome ดาวน์โหลด');
  }
  const size = fs.statSync(resolved).size;
  if (size < 1024) throw new Error(`ไฟล์ดาวน์โหลดเล็กผิดปกติ (${size} ไบต์)`);
  if (size > 500 * 1024 * 1024) throw new Error('ไฟล์ดาวน์โหลดใหญ่เกิน 500 MB');
  await assertValidVideo(resolved);
  return { resolved, size };
}
