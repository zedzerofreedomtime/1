import fs from 'fs';
import path from 'path';
import { config } from '../config.js';
import { logger, traceStep } from '../utils/logger.js';
import { getPool } from '../db/database.js';
import { updateJob } from '../db/job-repository.js';
import {
  analyzeClipsAndWriteNarration,
  loadProductBrief,
  normalizeClipAlignedNarration,
} from '../gemini/prompt-generator.js';
import { generateContinuousNarrationTTS, generateSRT } from '../gemini/tts-generator.js';
import { auditSafeNarrationFallback, logNarrationRepairs } from '../gemini/narration-rules.js';
import { assembleVideo } from '../ffmpeg/video-assembler.js';
import { clipCountForDuration } from './job-duration.js';
import type { GeminiVisionResult } from '../types.js';

/**
 * ปลายทางของงาน: ประกอบวิดีโอสุดท้าย และการปิดงานแบบล้มเหลว/พักไว้
 *
 * แยกออกมาเพราะเป็นคนละช่วงชีวิตกับการ "จองงาน/เก็บสื่อ" — เวลาแก้เรื่อง
 * เสียงพากย์หรือการต่อคลิป จะได้ไม่ต้องเลื่อนผ่านโค้ดจองงานทั้งหมด
 */
export async function finalizeExtensionJob(jobId: number): Promise<string> {
  const db = getPool();
  const result = await db.query(`
    SELECT j.*, i.title AS product_title, i.product_detail AS product_detail
    FROM flow_job j
    LEFT JOIN item i ON i.id = j.item_id
    WHERE j.id = $1
  `, [jobId]);
  const row = result.rows[0];
  if (!row) throw new Error('ไม่พบงาน');
  const storedClips: string[] = row.clip_paths || [];
  const clipCount = clipCountForDuration(row.target_duration_seconds);
  // เช็คว่าไม่มีรู/ไฟล์หาย — length เฉยๆ ไม่พอ เพราะ [null,null,path] ก็ได้ length=3
  // เหมือนกัน แล้วจะไปพังที่ FFmpeg แทนที่จะบอกสาเหตุตรงนี้
  //
  // "เกิน" ต้องกู้ได้ ไม่ใช่ตายถาวร: job #69 เคยมี 3 คลิปทั้งที่ต้องการ 2 (บั๊กเจนเกิน)
  // แล้วเงื่อนไข !== ทำให้ประกอบไม่ได้ตลอดกาล ทั้งที่คลิปที่จ่ายเงินไปใช้ได้จริง
  // → ใช้ N ตัวแรกตามจำนวนที่ต้องการ ส่วนเกินเก็บไว้เฉยๆ ไม่ทิ้ง
  const clips = storedClips.filter(Boolean).slice(0, clipCount);
  if (clips.length !== clipCount) {
    throw new Error(`คลิปยังไม่ครบ ${clipCount} (มี ${storedClips.filter(Boolean).length})`);
  }
  if (storedClips.filter(Boolean).length > clipCount) {
    logger.warn(`⚠️ งาน #${jobId} มีคลิป ${storedClips.filter(Boolean).length} ตัวเกินที่ต้องการ ${clipCount} — ใช้ ${clipCount} ตัวแรกประกอบวิดีโอ`);
  }
  const missing = clips.filter((clip) => !fs.existsSync(clip));
  if (missing.length) {
    throw new Error(`ไฟล์คลิปหาย ${missing.length} ตัว: ${missing.join(', ')}`);
  }
  const vision = row.vision_result as GeminiVisionResult;
  const upfrontNarration = vision.upfrontNarration || normalizeClipAlignedNarration(
    vision.narrationScript,
    vision.subtitleSegments,
    clipCount
  );
  if (!upfrontNarration.repairs?.length && vision.narrationRepairs?.length) {
    upfrontNarration.repairs = vision.narrationRepairs;
  }
  let alignedNarration = upfrontNarration;
  let narrationSource: 'upfront' | 'video' = 'upfront';

  try {
    alignedNarration = await traceStep(
      { source: 'gemini', stage: 'video.narration', message: 'ดูคลิปจริงแล้วเขียนบทพากย์ตามภาพ', jobId },
      () => analyzeClipsAndWriteNarration(clips, {
        productTitle: String(row.product_title || ''),
        // รวม brief ที่คัดเอง (product-briefs.json) + สเปกที่ scrape จาก Shopee → VERIFIED FACTS
        // ให้ Gemini พากย์อิงสเปกจริง (แบต/จอ/วัสดุ ฯลฯ) ไม่ใช่เดาจากหน้าตา
        productBrief: [
          loadProductBrief(String(row.product_title || '')),
          String(row.product_detail || '').trim().slice(0, 1800), // cap กัน prompt บวม (สเปกบางตัวยาวมาก)
        ].filter(Boolean).join('\n\n'),
        reviewText: String(row.review_text || ''),
        clipCount,
        secondsPerClip: config.videoDurationSeconds,
        motionPrompts: vision.motionPrompts,
      })
    );
    narrationSource = 'video';
    logNarrationRepairs(jobId, alignedNarration.repairs || []);
  } catch (error: any) {
    logger.warn(`⚠️ Gemini ดูคลิปจริงไม่สำเร็จ — ใช้บทวางล่วงหน้าแทนโดยไม่ทำให้งานล้ม: ${String(error?.message || error)}`);
  }

  // ⚠️ "เขียนใหม่จากคลิปจริงแล้วผ่าน compliance" ไม่ได้แปลว่าบทดีกว่าของเดิม
  //
  // 🐛 job_147 (ทิชชู่ Botare): บทวางล่วงหน้าเปิดด้วย "ทำน้ำหกเลอะเทอะบนโต๊ะบ่อยๆ แต่ไม่อยาก
  // ใช้กระดาษม้วนใหญ่เกะกะใช่ไหมคะ" ซึ่งตรงกับภาพเป๊ะ แต่พอ Gemini ดูคลิปแล้วเขียนใหม่
  // มันเขียนคลิป 1 สั้นเกินเกณฑ์ ตัวเติมจึงแทนด้วยประโยคสำรองทั้งท่อน แล้วบทที่ดีถูกทิ้ง
  // 8 วินาทีแรกของวิดีโอที่ส่งมอบจริงจึงเป็น "ของถึงมือแล้วประทับใจกว่าที่คิดไว้เยอะเลยค่ะ"
  // ซึ่งไม่มีคำว่ากระดาษ ทิชชู่ หรือ 4 ชั้น เลยสักคำ
  //
  // เทียบจำนวนท่อนที่กลวงของทั้งสองบท แล้วเลือกอันที่กลวงน้อยกว่า
  // เสมอกันให้ใช้บทจากวิดีโอตามเดิม เพราะมันเห็นภาพจริงจึงตรงกับสิ่งที่คนดูเห็นมากกว่า
  const videoFiller = auditSafeNarrationFallback(alignedNarration.subtitleSegments);
  if (narrationSource === 'video' && videoFiller.length) {
    const upfrontFiller = auditSafeNarrationFallback(upfrontNarration.subtitleSegments);
    if (upfrontFiller.length < videoFiller.length) {
      logger.warn(
        `⚠️ บทจากคลิปจริงกลวง ${videoFiller.length} ท่อน มากกว่าบทวางล่วงหน้าที่กลวง ${upfrontFiller.length} ท่อน `
        + '— ถอยไปใช้บทวางล่วงหน้าแทน'
      );
      alignedNarration = upfrontNarration;
      narrationSource = 'upfront';
    }
  }

  // ตรวจ "บทที่จะออกอากาศจริง" ไม่ใช่บทวางล่วงหน้า — ถ้าเส้นทางดูวิดีโอด้านบนล้มแล้วถอย
  // กลับมาใช้บทวางล่วงหน้า ประโยคสำรองจะลงคลิปทันทีโดยไม่มีสัญญาณเตือน (ดู job_146)
  const fillerRepairs = auditSafeNarrationFallback(alignedNarration.subtitleSegments);
  if (fillerRepairs.length) {
    logNarrationRepairs(jobId, fillerRepairs);
    alignedNarration.repairs = [...(alignedNarration.repairs || []), ...fillerRepairs];
  }

  const videoNarration = narrationSource === 'video' ? alignedNarration : undefined;
  let updatedVision: GeminiVisionResult = {
    ...vision,
    narrationScript: alignedNarration.narrationScript,
    subtitleSegments: alignedNarration.subtitleSegments,
    narrationSource,
    upfrontNarration,
    ...(videoNarration ? { videoNarration } : {}),
  };
  const jobDir = path.resolve(config.outputDir, `job_${jobId}`);

  await updateJob(jobId, { visionResult: updatedVision, status: 'generating_tts' });
  const ttsPath = path.join(jobDir, `job_${jobId}_tts.mp3`);
  let tts: Awaited<ReturnType<typeof generateContinuousNarrationTTS>>;
  try {
    tts = await traceStep(
      { source: 'service', stage: 'tts.generate', message: 'สร้างเสียงพากย์', jobId },
      () => generateContinuousNarrationTTS(alignedNarration.subtitleSegments, ttsPath)
    );
  } catch (error: any) {
    if (narrationSource !== 'video' || !/บทพากย์สั้นเกินไป/.test(String(error?.message || error))) {
      throw error;
    }
    logger.warn('⚠️ เสียงจากบทที่ดูวิดีโอสั้นไม่ผ่านเกณฑ์จริง — fallback บท upfront และสร้าง TTS ใหม่');
    alignedNarration = upfrontNarration;
    narrationSource = 'upfront';
    updatedVision = {
      ...updatedVision,
      narrationScript: upfrontNarration.narrationScript,
      subtitleSegments: upfrontNarration.subtitleSegments,
      narrationSource,
    };
    await updateJob(jobId, { visionResult: updatedVision, status: 'generating_tts' });
    tts = await traceStep(
      { source: 'service', stage: 'tts.fallback', message: 'สร้างเสียงจากบทวางล่วงหน้าแทนบทวิดีโอที่สั้น', jobId },
      () => generateContinuousNarrationTTS(upfrontNarration.subtitleSegments, ttsPath)
    );
  }
  const subtitlePath = path.join(jobDir, `job_${jobId}_sub.srt`);
  generateSRT(alignedNarration.subtitleSegments, subtitlePath);
  await updateJob(jobId, { ttsAudioPath: tts.audioPath, ttsVoice: tts.voice, subtitlePath, status: 'assembling' });

  const output = path.join(jobDir, `job_${jobId}_final.mp4`);
  await traceStep(
    { source: 'ffmpeg', stage: 'video.assemble', message: 'รวมคลิป เสียง และซับไตเติล', jobId },
    () => assembleVideo({
      clipPaths: clips,
      ttsAudioPath: tts.audioPath,
      subtitlePath,
      outputPath: output,
      workerId: 9001,
    })
  );
  await updateJob(jobId, { status: 'completed', finalVideoPath: output });
  return output;
}

export async function failExtensionJob(jobId: number, message: string): Promise<void> {
  await updateJob(jobId, { status: 'failed', errorMessage: message });
}

/**
 * Keep paid checkpoints when Flow temporarily blocks generation.
 * A later manual Start can resume from generatedImagePath/clipPaths instead of
 * creating a new product job and paying for the reference image again.
 */
export async function pauseExtensionJob(jobId: number, message: string): Promise<void> {
  await updateJob(jobId, {
    status: 'pending',
    workerId: null,
    errorMessage: message,
  });
}
