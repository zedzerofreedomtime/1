import http from 'http';
import { config } from '../config.js';
import { connectDB, disconnectDB, initFlowTables } from '../db/database.js';
import { logEvent, logger } from '../utils/logger.js';
import { failOrphanedExtensionJobs, readExtensionRuntime } from '../extension/extension-api.js';
import { port } from './paths.js';
import { sendJson, type RouteContext, type RouteHandler } from './http.js';
import { dashboardRoutes } from './routes/dashboard.routes.js';
import { scrapeRoutes } from './routes/scrape.routes.js';
import { extensionRuntimeRoutes } from './routes/extension-runtime.routes.js';
import { extensionJobRoutes } from './routes/extension-jobs.routes.js';
import { mediaRoutes } from './routes/media.routes.js';
import { automationRoutes } from './routes/automation.routes.js';
import { staticRoutes } from './routes/static.routes.js';
import { proxyRoutes } from './routes/proxy.routes.js';
import { accountRoutes } from './routes/account.routes.js';
import { readFlowRuntimeFlags } from './runtime-flags.js';
import { loadProxies } from '../proxy/proxy-manager.js';
import { loadAccounts } from '../proxy/account-manager.js';

// ⚠️ ต้องอ่านจาก config ไม่ใช่ฝังเลขไว้ — เดิม STALE_JOB_MINUTES ใน .env ตั้งแล้วไม่มีผล
// เพราะที่นี่ hardcode 20 ไว้ กลายเป็น "ปุ่มหลอก" ที่ดูเหมือนปรับได้ (ตรวจพบ 30 ก.ค. 2026)
//
// ค่านี้ต้องสูงกว่าเวลาที่ Flow ใช้เจนจริง (สูงสุด 15 นาที) เสมอ ไม่งั้น watchdog จะฆ่างาน
// ที่กำลังรอผลอยู่แล้วเผาเครดิตทิ้ง — จึงบังคับพื้นล่างไว้ที่ 20 นาที
const ORPHAN_JOB_STALE_MINUTES = Math.max(20, config.staleJobMinutes);
const ORPHAN_WATCHDOG_INTERVAL_MS = 60_000;

/**
 * ลำดับสำคัญ — router ลองทีละตัวจนกว่าจะมีตัวรับงาน
 * staticRoutes ต้องอยู่ท้ายสุดเสมอ เพราะจับทุก path ที่เหลือ
 */
const routes: RouteHandler[] = [
  dashboardRoutes,
  scrapeRoutes,
  extensionRuntimeRoutes,
  extensionJobRoutes,
  mediaRoutes,
  proxyRoutes,
  accountRoutes,
  automationRoutes,
  staticRoutes,
];

await connectDB();
await initFlowTables();
loadProxies();
loadAccounts();

/**
 * งานที่ค้างเพราะ Extension หลุดกลางคัน ต้องถูกปล่อยคืน ไม่งั้นคิวตันถาวร
 * (ยกเว้นงานที่ Extension ที่เชื่อมต่ออยู่กำลังทำจริง)
 */
async function runOrphanJobWatchdog(): Promise<void> {
  const runtime = readExtensionRuntime();
  const activeJobId = runtime.connected && Number.isInteger(runtime.currentJobId)
    ? runtime.currentJobId
    : null;
  await failOrphanedExtensionJobs(activeJobId, ORPHAN_JOB_STALE_MINUTES);
}

await runOrphanJobWatchdog();
setInterval(() => {
  runOrphanJobWatchdog().catch((error) =>
    logger.error(`Orphan job watchdog ล้มเหลว: ${String(error?.message || error)}`));
}, ORPHAN_WATCHDOG_INTERVAL_MS).unref();

const server = http.createServer(async (req, res) => {
  const requestStarted = Date.now();
  const traceId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  let requestPath = req.url || '';
  try {
    if (!req.url) return sendJson(res, 400, { error: 'Missing URL' });
    if (req.method === 'OPTIONS') return sendJson(res, 204, {});

    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    requestPath = url.pathname;
    const context: RouteContext = { req, res, url, traceId };

    for (const route of routes) {
      if (await route(context)) return;
    }
    // staticRoutes รับทุกอย่างที่เหลืออยู่แล้ว — มาถึงตรงนี้ได้แปลว่าโค้ดผิด
    sendJson(res, 404, { error: 'Not found' });
  } catch (error: any) {
    logEvent({
      source: 'service',
      stage: 'http.error',
      message: `${req.method || 'UNKNOWN'} ${requestPath} ล้มเหลว`,
      level: 'error',
      traceId,
      durationMs: Date.now() - requestStarted,
      error,
    });
    sendJson(res, 500, { error: String(error?.message || error) });
  }
});

server.listen(port, '127.0.0.1', () => {
  const featureFlags = readFlowRuntimeFlags();
  logEvent({
    source: 'service',
    stage: 'startup',
    message: `ClipBot Flow พร้อมที่ http://127.0.0.1:${port}`,
    meta: {
      version: process.env.npm_package_version || 'unknown',
      featureFlags,
    },
  });
  logger.info(
    `Flow flags: ingredients=${featureFlags.ingredientsModeEnabled}, `
    + `endFrame=${featureFlags.endFrameEnabled}, `
    + `firstImage=${featureFlags.firstImageSource}, `
    + `references=${featureFlags.referenceImagesEnabled ? featureFlags.referenceImageCount : 0}, `
    + `clipFidelity=${featureFlags.clipFidelityCheckEnabled}`
  );
});

async function shutdown() {
  server.close();
  await disconnectDB();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
