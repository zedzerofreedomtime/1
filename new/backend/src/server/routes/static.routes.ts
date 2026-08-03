import fs from 'fs';
import path from 'path';
import { extensionRoot, webDist } from '../paths.js';
import { sendJson, streamFile, type RouteHandler } from '../http.js';

const WEB_MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

const EXTENSION_MIME: Record<string, string> = {
  ...WEB_MIME,
  '.json': 'application/json; charset=utf-8',
};

/**
 * ไฟล์ static ทั้งหมด — ต้องเป็น route สุดท้ายเสมอ เพราะจับทุก path ที่เหลือ
 *
 * 1. /extension/*  → ไฟล์ของ Chrome Extension (เปิดดูตอน debug)
 * 2. ที่เหลือ      → frontend ที่ build แล้ว (SPA: path ที่ไม่มีไฟล์จริงตกไป index.html)
 */
export const staticRoutes: RouteHandler = async ({ req, res, url }) => {
  if (req.method !== 'GET') {
    sendJson(res, 404, { error: 'Not found' });
    return true;
  }

  if (url.pathname.startsWith('/extension/')) {
    const relative = url.pathname.slice('/extension/'.length) || 'popup.html';
    const file = path.resolve(extensionRoot, relative);
    // กันอ่านไฟล์นอกโฟลเดอร์ extension (path traversal)
    if (!file.startsWith(`${extensionRoot}${path.sep}`) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      sendJson(res, 404, { error: 'Extension file not found' });
      return true;
    }
    streamFile(res, file, EXTENSION_MIME);
    return true;
  }

  const relative = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  let filePath = path.resolve(webDist, relative);
  if (!filePath.startsWith(webDist) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(webDist, 'index.html');
  }
  if (!fs.existsSync(filePath)) {
    sendJson(res, 503, { error: 'Web app not built. Run npm run web:build' });
    return true;
  }
  streamFile(res, filePath, WEB_MIME);
  return true;
};
