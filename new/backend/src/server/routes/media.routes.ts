import fs from 'fs';
import path from 'path';
import { outputRoot } from '../paths.js';
import { CORS_HEADERS, sendJson, streamFile, type RouteHandler } from '../http.js';

const MEDIA_MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

/**
 * เสิร์ฟไฟล์สื่อที่ระบบสร้างไว้ (รูปตั้งต้น/คลิป) ให้ทั้งหน้าเว็บและ content.js
 *
 * ⚠️ ต้องมี CORS — content.js บน labs.google เป็นคนมาโหลดรูปนี้ไปอัปเข้า Flow
 * และต้องกันอ่านไฟล์นอก outputRoot เด็ดขาด (path traversal)
 */
export const mediaRoutes: RouteHandler = async ({ req, res, url }) => {
  if (url.pathname !== '/api/media' || req.method !== 'GET') return false;

  const requested = path.resolve(String(url.searchParams.get('path') || ''));
  if (!requested.startsWith(`${outputRoot}${path.sep}`) || !fs.existsSync(requested)) {
    sendJson(res, 404, { error: 'ไม่พบไฟล์' });
    return true;
  }

  // fallback เป็น image/jpeg ตามพฤติกรรมเดิม — รูปที่ระบบสร้างส่วนใหญ่เป็น jpeg
  streamFile(res, requested, MEDIA_MIME, {
    ...CORS_HEADERS,
    'Cache-Control': 'no-cache',
  }, 'image/jpeg');
  return true;
};
