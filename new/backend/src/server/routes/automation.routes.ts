import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { logger } from '../../utils/logger.js';
import { root } from '../paths.js';
import { readJson, sendJson, type RouteHandler } from '../http.js';

/** move-cursor.exe คอมไพล์จาก MoveCursor.cs ที่อยู่ข้างกัน (ดู README ของ scripts) */
const cursorExecutable = path.join(root, 'backend', 'scripts', 'move-cursor.exe');

/**
 * เคลื่อนเคอร์เซอร์จริงบนหน้าจอตามเส้นทางที่ส่งมา
 *
 * เพิ่มโดย Antigravity สำหรับงานฝั่ง OS-level automation
 */
export const automationRoutes: RouteHandler = async ({ req, res, url }) => {
  if (url.pathname !== '/api/mouse/path' || req.method !== 'POST') return false;

  const body = await readJson(req);
  const movePath = body.path;
  if (!Array.isArray(movePath) || movePath.length === 0) {
    sendJson(res, 400, { error: 'path must be a non-empty array' });
    return true;
  }
  if (!fs.existsSync(cursorExecutable)) {
    sendJson(res, 500, {
      error: 'move-cursor.exe not found — run: csc /out:backend/scripts/move-cursor.exe backend/scripts/MoveCursor.cs',
    });
    return true;
  }

  // เขียน JSON ลงไฟล์ temp แล้วส่ง path ผ่าน argument (เลี่ยงข้อจำกัดความยาว argument)
  const tmpFile = path.join(root, `.mouse-path-${Date.now()}.json`);
  fs.writeFileSync(tmpFile, JSON.stringify({ path: movePath, click: body.click === true }));

  await new Promise<void>((resolve) => {
    const child = spawn(cursorExecutable, [tmpFile], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('close', (code) => {
      try { fs.unlinkSync(tmpFile); } catch { /* ลบไม่ได้ก็ปล่อย — เป็นไฟล์ temp */ }
      if (code !== 0) {
        logger.warn(`Mouse path error (exit ${code}): ${stderr}`);
        sendJson(res, 500, { error: stderr || `exit code ${code}` });
      } else {
        sendJson(res, 200, { ok: true });
      }
      resolve();
    });
    child.on('error', (error) => {
      try { fs.unlinkSync(tmpFile); } catch { /* ลบไม่ได้ก็ปล่อย */ }
      logger.warn(`Mouse path spawn error: ${String(error.message)}`);
      sendJson(res, 500, { error: String(error.message) });
      resolve();
    });
  });
  return true;
};
