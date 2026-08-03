import { traceStep } from '../../utils/logger.js';
import {
  claimAndPrepareExtensionJob,
  createExtensionJob,
  ensureExtensionJob,
  failExtensionJob,
  finalizeExtensionJob,
  importExtensionDownload,
  importExtensionGeneratedImage,
  pauseExtensionJob,
  storeExtensionClip,
  validateExtensionDownload,
} from '../../extension/extension-api.js';
import { ACTIVE_EXTENSION_VERSION } from '../paths.js';
import { readBuffer, readJson, sendJson, type RouteHandler } from '../http.js';

/**
 * วงจรชีวิตงานของ ClipBot Flow extension:
 * สร้างงาน → จองงาน (claim) → เก็บรูป/คลิปที่ Flow สร้าง → ประกอบวิดีโอ → จบ/พัก/ล้มเหลว
 */
export const extensionJobRoutes: RouteHandler = async ({ req, res, url, traceId }) => {
  const method = req.method;

  if (url.pathname === '/api/extension/jobs' && method === 'POST') {
    const body = await readJson(req);
    const itemId = Number(body.itemId);
    const durationSeconds = Number(body.durationSeconds) === 24 ? 24 : 16;
    const id = await traceStep(
      { source: 'service', stage: 'job.create', message: `เพิ่มสินค้า #${itemId} เข้าคิว (${durationSeconds} วิ)`, traceId },
      () => createExtensionJob(itemId, durationSeconds)
    );
    sendJson(res, 201, { id });
    return true;
  }

  if (url.pathname === '/api/extension/jobs/auto' && method === 'POST') {
    const body = await readJson(req);
    const requestedItemId = Number(body.itemId);
    const durationSeconds = Number(body.durationSeconds) === 24 ? 24 : 16;
    const job = await traceStep(
      {
        source: 'service',
        stage: 'job.auto',
        message: requestedItemId > 0 ? `เตรียมสินค้า #${requestedItemId} อัตโนมัติ` : 'สุ่มสินค้าเข้าคิวอัตโนมัติ',
        traceId,
      },
      () => ensureExtensionJob(requestedItemId > 0 ? requestedItemId : undefined, durationSeconds)
    );
    sendJson(res, job.created ? 201 : 200, job);
    return true;
  }

  if (url.pathname === '/api/extension/jobs/claim' && method === 'POST') {
    const body = await readJson(req);
    // กันชุดเก่าแย่งงานที่จ่ายเครดิตจริง — ต้องตรงเวอร์ชันเท่านั้นถึงจองงานได้
    if (String(req.headers['x-clipforge-version'] || '') !== ACTIVE_EXTENSION_VERSION) {
      sendJson(res, 426, { error: `ClipForge เวอร์ชันเก่าถูกระงับ — ต้องใช้ ${ACTIVE_EXTENSION_VERSION}` });
      return true;
    }
    if (body.creditUnlocked !== true) {
      sendJson(res, 423, { error: 'Extension ยังล็อกเครดิตอยู่' });
      return true;
    }
    const job = await traceStep(
      { source: 'service', stage: 'job.prepare', message: 'จองงานและให้ Gemini เตรียมรูป/พรอมต์', traceId },
      claimAndPrepareExtensionJob
    );
    sendJson(res, 200, { job });
    return true;
  }

  const clipMatch = url.pathname.match(/^\/api\/extension\/jobs\/(\d+)\/clips\/(\d+)$/);
  if (clipMatch && method === 'POST') {
    const video = await readBuffer(req);
    if (!video.length) {
      sendJson(res, 400, { error: 'ไม่ได้รับข้อมูลวิดีโอ' });
      return true;
    }
    const jobId = Number(clipMatch[1]);
    const clipIndex = Number(clipMatch[2]);
    const result = await traceStep(
      { source: 'service', stage: 'clip.store', message: 'ตรวจและบันทึกคลิปจาก Flow', traceId, jobId, clipIndex, meta: { bytes: video.length } },
      () => storeExtensionClip(jobId, clipIndex, video, String(req.headers['x-source-url'] || ''))
    );
    sendJson(res, 200, result);
    return true;
  }

  const importMatch = url.pathname.match(/^\/api\/extension\/jobs\/(\d+)\/downloads\/(\d+)$/);
  if (importMatch && method === 'POST') {
    const body = await readJson(req);
    if (!body.downloadPath) {
      sendJson(res, 400, { error: 'ไม่ได้รับ path ของไฟล์ดาวน์โหลด' });
      return true;
    }
    const jobId = Number(importMatch[1]);
    const clipIndex = Number(importMatch[2]);
    // dryRun = ตรวจไฟล์อย่างเดียว ไม่แตะ checkpoint (ใช้ทดสอบโดยไม่เสี่ยงข้อมูลงานจริง)
    if (body.dryRun === true) {
      const checked = await validateExtensionDownload(jobId, clipIndex, String(body.downloadPath));
      sendJson(res, 200, { ok: true, dryRun: true, importedBytes: checked.size });
      return true;
    }
    const result = await traceStep(
      { source: 'service', stage: 'clip.import', message: 'นำเข้าไฟล์จาก Chrome Downloads', traceId, jobId, clipIndex },
      () => importExtensionDownload(jobId, clipIndex, String(body.downloadPath), String(body.sourceUrl || ''))
    );
    sendJson(res, 200, result);
    return true;
  }

  const imageImportMatch = url.pathname.match(/^\/api\/extension\/jobs\/(\d+)\/generated-image$/);
  if (imageImportMatch && method === 'POST') {
    const body = await readJson(req);
    if (!body.downloadPath) {
      sendJson(res, 400, { error: 'ไม่ได้รับ path ของรูปที่ดาวน์โหลด' });
      return true;
    }
    const jobId = Number(imageImportMatch[1]);
    const result = await traceStep(
      { source: 'service', stage: 'image.import', message: 'นำเข้ารูปมือจับสินค้าจาก Flow', traceId, jobId },
      () => importExtensionGeneratedImage(
        jobId,
        String(body.downloadPath),
        String(body.sourceUrl || ''),
        body.imageRole === 'end' ? 'end' : 'start'
      )
    );
    sendJson(res, 200, result);
    return true;
  }

  const finishMatch = url.pathname.match(/^\/api\/extension\/jobs\/(\d+)\/finish$/);
  if (finishMatch && method === 'POST') {
    const jobId = Number(finishMatch[1]);
    const finalVideoPath = await traceStep(
      { source: 'service', stage: 'job.finalize', message: 'พากย์เสียงและประกอบวิดีโอสุดท้าย', traceId, jobId },
      () => finalizeExtensionJob(jobId)
    );
    sendJson(res, 200, { finalVideoPath });
    return true;
  }

  const failMatch = url.pathname.match(/^\/api\/extension\/jobs\/(\d+)\/fail$/);
  if (failMatch && method === 'POST') {
    const body = await readJson(req);
    await failExtensionJob(Number(failMatch[1]), String(body.message || 'Extension หยุดงาน'));
    sendJson(res, 200, { ok: true });
    return true;
  }

  const pauseMatch = url.pathname.match(/^\/api\/extension\/jobs\/(\d+)\/pause$/);
  if (pauseMatch && method === 'POST') {
    const body = await readJson(req);
    await pauseExtensionJob(Number(pauseMatch[1]), String(body.message || 'Flow พักการสร้างชั่วคราว'));
    sendJson(res, 200, { ok: true, checkpointPreserved: true });
    return true;
  }

  return false;
};
