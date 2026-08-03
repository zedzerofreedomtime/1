import fs from 'fs';
import path from 'path';
import { logEvent, logger } from '../../utils/logger.js';
import { readExtensionRuntime, writeExtensionRuntime } from '../../extension/extension-api.js';
import { ACTIVE_EXTENSION_VERSION, remoteCommandFile, root } from '../paths.js';
import { readJson, sendJson, type RouteHandler } from '../http.js';

/**
 * อ่านคำสั่งรีโมตแล้วลบไฟล์ทิ้งทันที (one-shot)
 *
 * ต้องลบทุกครั้งที่หยิบไป ไม่งั้นบอทจะวนทำคำสั่งเดิมไม่รู้จบ
 * @param onlyReload รับเฉพาะคำสั่ง reload (ใช้กับ client เวอร์ชันเก่า)
 */
function takeRemoteCommand(onlyReload = false): any {
  if (!fs.existsSync(remoteCommandFile)) return null;
  try {
    const candidate = JSON.parse(fs.readFileSync(remoteCommandFile, 'utf8'));
    if (onlyReload && candidate?.command !== 'reload') return null;
    fs.unlinkSync(remoteCommandFile);
    return candidate;
  } catch {
    // ไฟล์เสีย — ข้ามไป ไม่ต้องทำให้ heartbeat พัง
    return null;
  }
}

/**
 * Heartbeat ของ Extension — และเป็นช่องส่ง "คำสั่งรีโมต" กลับไปด้วย
 *
 * ปกติการควบคุมบอทอยู่ที่ป๊อปอัป Extension เท่านั้น (ตามที่ออกแบบไว้)
 * แต่ตอน debug ต้องกด Start ซ้ำหลายสิบรอบ ถ้าต้องให้คนกดเองทุกครั้ง
 * จะไล่บั๊กไม่ทัน → เปิดช่องให้สั่งจากเครื่องได้ผ่าน data/remote-command.json
 */
export const extensionRuntimeRoutes: RouteHandler = async ({ req, res, url, traceId }) => {
  if (url.pathname === '/api/extension/status' && req.method === 'POST') {
    const body = await readJson(req);
    const clientVersion = String(body.version || '?');

    // Chrome เปิด unpacked หลายชุดพร้อมกันได้ — ชุดเก่าต้องไม่แย่งงานและไม่แย่ง
    // คำสั่งรีโมตไปจากชุดที่ใช้จริง ยกเว้น `reload` อย่างเดียวที่ยอมให้ผ่าน
    // ไม่งั้นชุดเก่าจะติดกับดัก: อัปเกรดไม่ได้เพราะ server ปฏิเสธ และไม่มีทางรู้ว่าต้องรีโหลด
    if (clientVersion !== ACTIVE_EXTENSION_VERSION) {
      const upgradeCommand = takeRemoteCommand(true);
      sendJson(res, 200, {
        ...readExtensionRuntime(),
        command: upgradeCommand?.command ?? null,
        commandPayload: upgradeCommand,
        requiredVersion: ACTIVE_EXTENSION_VERSION,
      });
      return true;
    }

    const runtime = writeExtensionRuntime(body);
    const command = takeRemoteCommand();
    if (command) logger.info(`📡 ส่งคำสั่งรีโมตให้ Extension: ${command?.command}`);

    // ส่ง 2 รูปแบบเพื่อความเข้ากันได้:
    //   command        = string  (เวอร์ชันเก่าอ่านตัวนี้ — สำคัญมาก ไม่งั้นสั่ง reload ไม่ได้
    //                             แล้วจะติดกับดักอัปเกรดไม่ได้ตลอดกาล)
    //   commandPayload = object  (เวอร์ชันใหม่ที่ต้องใช้พารามิเตอร์ เช่น salvage)
    sendJson(res, 200, {
      ...runtime,
      command: command?.command ?? null,
      commandPayload: command ?? null,
    });
    return true;
  }

  if (url.pathname === '/api/extension/logs' && req.method === 'POST') {
    const body = await readJson(req);
    logEvent({
      source: String(body.source || 'extension'),
      stage: String(body.stage || 'runtime'),
      message: String(body.message || 'Extension event'),
      level: ['debug', 'info', 'warn', 'error'].includes(body.level) ? body.level : 'info',
      jobId: body.jobId == null ? null : (Number.isFinite(Number(body.jobId)) ? Number(body.jobId) : null),
      clipIndex: body.clipIndex == null ? null : (Number.isFinite(Number(body.clipIndex)) ? Number(body.clipIndex) : null),
      traceId: String(body.traceId || traceId),
      durationMs: Number.isFinite(Number(body.durationMs)) ? Number(body.durationMs) : undefined,
      error: body.error,
      meta: body.meta && typeof body.meta === 'object' ? body.meta : undefined,
    });
    sendJson(res, 200, { ok: true });
    return true;
  }

  // เก็บภาพ DOM ตอนบอทพัง — ใช้ไล่ selector เวลา Flow เปลี่ยน UI
  if (url.pathname === '/api/extension/diagnostic' && req.method === 'POST') {
    const body = await readJson(req);
    const file = path.join(root, 'data', 'flow-diagnostic.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...body }, null, 2), 'utf8');
    logger.warn(`🔎 เก็บภาพ DOM ตอนพังไว้แล้ว: ${file}`);
    logger.warn(`   สาเหตุ: ${body.message}`);
    sendJson(res, 200, { ok: true });
    return true;
  }

  return false;
};
