/**
 * ตัวคุม Local Service ที่รีสตาร์ตให้เอง "เฉพาะตอนบอทว่าง"
 *
 * ปัญหาที่แก้ (เจอซ้ำหลายรอบวันที่ 30 ก.ค. 2026):
 * แก้โค้ด backend แล้วลืมรีสตาร์ต service → บอทวิ่งด้วยโค้ดเก่าทั้งงาน กว่าจะรู้ก็เสีย
 * เครดิตไปแล้วหลายใบ (job #122 ล้มซ้ำจุดเดิม, #125/#126 วิ่งด้วยของเก่าทั้งงาน)
 *
 * ทำไมไม่ใช้ `tsx watch` ตรงๆ:
 * มันฆ่าโปรเซสทันทีที่ไฟล์เปลี่ยน ถ้าบังเอิญตรงกับจังหวะที่ Extension กำลัง POST คลิป
 * ที่เพิ่งจ่ายเครดิต งานจะพังและคลิปนั้นหายไปเลย ตัวนี้จึง "รอให้ว่างก่อน" เสมอ
 *
 * นิยามของว่าง = ไม่มี currentJobId ใน data/extension-state.json
 * (ไฟล์เดียวกับที่ service เขียนจาก heartbeat ของ Extension ทุก 15 วินาที)
 *
 * ใช้: npm run control:auto
 */
import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const watchDir = path.join(root, 'backend', 'src');
const statePath = path.join(root, 'data', 'extension-state.json');

/**
 * ⚠️ ห้ามใช้ fs.watch ที่นี่ — เวิร์กสเปซอยู่บนไดรฟ์เครือข่าย (X: ชี้ไป NAS)
 * fs.watch แบบ recursive จะโยน UNKNOWN (errno -4094) ทันทีที่เริ่มเฝ้า แล้วตัวคุมตายทั้งตัว
 * ใช้วิธีไล่ดู mtime แทน ช้ากว่านิดหน่อยแต่ทำงานได้จริงบนไดรฟ์แบบนี้
 */
const SCAN_MS = 3_000;
/** ถี่ที่ใช้ถามว่า "ว่างหรือยัง" */
const IDLE_POLL_MS = 5_000;

let child: ChildProcess | null = null;
let restartPending = false;
let stopping = false;

function log(message: string): void {
  const now = new Date().toISOString().slice(11, 19);
  console.log(`[serve-auto ${now}] ${message}`);
}

/**
 * ต้องมี supervisor ได้ตัวเดียวเท่านั้น
 *
 * 🐛 31 ก.ค. 2026: เจอ `EADDRINUSE 127.0.0.1:8110` ตอน 10:23 เพราะมีคนสตาร์ต
 * `npm run control:auto` ซ้ำโดยไม่รู้ว่ามีตัวเดิมรันอยู่ สอง supervisor ต่างก็เฝ้าไฟล์
 * และต่างก็สั่ง spawn service ของตัวเอง → ชิงพอร์ตกัน ตัวหนึ่งตาย
 *
 * ตอนนั้นไม่เสียหายเพราะบอทว่าง แต่ถ้าชนตอนบอทกำลังส่งคลิปที่จ่ายเครดิตแล้วกลับมา
 * คลิปนั้นหายได้ ตัวกันนี้จึงคุ้มกว่าปล่อยให้พึ่งความจำของคน
 *
 * ใช้ไฟล์ล็อกที่เก็บ PID: ถ้าล็อกมีอยู่แล้วและเจ้าของยังมีชีวิต → ตัวใหม่ถอยออกทันที
 * ถ้าเจ้าของตายไปแล้ว (ไฟฟ้าดับ/kill -9) ถือว่าเป็นล็อกค้าง ให้ยึดมาใช้ต่อได้
 */
const lockPath = path.join(root, 'data', 'serve-auto.lock');

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    // EPERM = มีโปรเซสอยู่จริงแต่คนละสิทธิ์ ถือว่ายังมีชีวิต
    return error?.code === 'EPERM';
  }
}

function claimSingletonLock(): boolean {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = fs.openSync(lockPath, 'wx');
      fs.writeFileSync(handle, String(process.pid));
      fs.closeSync(handle);
      return true;
    } catch (error: any) {
      if (error?.code !== 'EEXIST') throw error;
      const owner = Number(fs.readFileSync(lockPath, 'utf8').trim());
      if (Number.isFinite(owner) && owner !== process.pid && processAlive(owner)) {
        log(`มี supervisor ตัวอื่นทำงานอยู่แล้ว (PID ${owner}) — ตัวนี้ขอถอยออก ไม่งั้นจะชิงพอร์ต 8110 กัน`);
        return false;
      }
      log(`เจอไฟล์ล็อกค้างของ PID ${owner} ที่ไม่มีชีวิตแล้ว — ยึดมาใช้ต่อ`);
      fs.rmSync(lockPath, { force: true });
    }
  }
  return false;
}

function releaseSingletonLock(): void {
  try {
    if (!fs.existsSync(lockPath)) return;
    if (fs.readFileSync(lockPath, 'utf8').trim() !== String(process.pid)) return;
    fs.rmSync(lockPath, { force: true });
  } catch {
    // ปล่อยล็อกไม่สำเร็จไม่ควรทำให้ตอนปิดตัวพัง — ตัวถัดไปจะเห็นว่าเป็นล็อกค้างแล้วยึดเอง
  }
}

/**
 * ⚠️ ต้องมี service ลูกได้ "ตัวเดียว" เท่านั้นตลอดเวลา
 *
 * บั๊กจริง 30 ก.ค. 2026 15:01: การรีสตาร์ตจากไฟล์เปลี่ยน กับการปลุกกลับหลัง crash
 * ต่างคนต่างตั้ง setTimeout เรียก startService() → ได้ลูกสองตัว ตัวหนึ่งยึดพอร์ต 8110 ไว้
 * อีกตัวตาย EADDRINUSE แล้วตั้งเวลาปลุกใหม่ทุก 3 วินาทีไม่รู้จบ (วนสร้างโปรเซสทิ้งเรื่อยๆ)
 *
 * ตัวจับเวลาจึงต้องมีอันเดียวและต้องเช็คว่าไม่มีลูกอยู่ก่อนเสมอ
 */
let pendingSpawn: NodeJS.Timeout | null = null;
let quickDeaths = 0;

function scheduleSpawn(delayMs: number): void {
  if (pendingSpawn) clearTimeout(pendingSpawn);
  pendingSpawn = setTimeout(() => {
    pendingSpawn = null;
    if (stopping || child) return;
    startService();
  }, delayMs);
}

/**
 * อัปเดตบรีฟกลางหลัง service ขึ้น เพื่อให้เอเจนต์ตัวถัดไปที่เปิดโปรเจกต์เห็นสถานะจริง
 * โดยไม่ต้องรอใครมาบอก — รอ 8 วินาทีให้ service ตอบ /api/dashboard ได้ก่อน
 * ล้มก็ปล่อย ห้ามให้ supervisor ตายเพราะเรื่องเอกสาร
 */
function refreshBrief(): void {
  setTimeout(() => {
    if (stopping) return;
    const brief = spawn(
      process.execPath,
      ['--import', 'tsx', path.join('backend', 'scripts', 'agent-brief.ts')],
      { cwd: root, stdio: 'ignore' }
    );
    brief.on('error', (error) => log(`อัปเดตบรีฟไม่สำเร็จ: ${error.message}`));
  }, 8_000);
}

function startService(): void {
  const spawnedAt = Date.now();
  refreshBrief();
  child = spawn(
    process.execPath,
    ['--use-system-ca', '--import', 'tsx', path.join('backend', 'src', 'server', 'index.ts')],
    { cwd: root, stdio: 'inherit' }
  );
  const started = child;
  child.on('exit', (code, signal) => {
    if (stopping || started !== child) return;
    child = null;
    // ตายเร็วซ้ำๆ = ปัญหาที่รีสตาร์ตไม่ช่วย (พอร์ตถูกยึด / โค้ดพัง) ต้องถ่างจังหวะ
    // ไม่ใช่กระแทกซ้ำทุก 3 วินาที ไม่งั้นกลายเป็นวนสร้างโปรเซสทิ้งจนเครื่องอืด
    quickDeaths = Date.now() - spawnedAt < 10_000 ? quickDeaths + 1 : 0;
    const delay = quickDeaths >= 3 ? 60_000 : 3_000;
    log(
      `service ดับเอง (code=${code} signal=${signal}) — เปิดใหม่ใน ${delay / 1000} วินาที`
      + (quickDeaths >= 3 ? ' ⚠️ ตายเร็วติดกัน อาจมี service ตัวอื่นยึดพอร์ต 8110 อยู่' : '')
    );
    scheduleSpawn(delay);
  });
}

/**
 * เงียบเกินเท่านี้ทั้งที่ "มีงานค้าง" ถึงจะยอมถือว่างานนั้นถูกทิ้งแล้ว
 *
 * งานหนึ่งใบใช้เวลาราว 20 นาที ช่วงที่เงียบนานสุดคือตอนพิมพ์พรอมต์ทีละตัวอักษรกับตอนรอ Flow เจน
 * 15 นาทีจึงยาวพอที่จะไม่ตัดงานจริง แต่ไม่ยาวจนตัวคุมเป็นอัมพาตถ้าเบราว์เซอร์ถูกปิดกลางงาน
 */
const ABANDONED_MS = 15 * 60_000;

/**
 * บอทว่างไหม — ว่าง = ไม่มีงานที่จ่ายเครดิตค้างอยู่กลางคัน
 *
 * 🐛 3 ส.ค. 2026 10:04 (งาน #158): ตัวคุมพิมพ์ "มีงานเดินอยู่ — เลื่อนการรีสตาร์ต" แล้ว
 * **5 วินาทีถัดมา** พิมพ์ "บอทว่างแล้ว" และรีสตาร์ตจริง ทั้งที่บอทกำลังอัปรูปส่วนผสมอยู่
 *
 * เพราะบรรทัดเดิมเขียนว่า heartbeat เงียบเกิน 60 วิ = ว่าง โดยไม่ดูเลยว่าตอนที่ยังพูดอยู่
 * มันบอกว่ามีงานหรือเปล่า Extension ยิง POST /api/extension/status ไม่ผ่านตอน 10:04:31
 * (`Failed to fetch`) สถานะจึงค้าง พอเงียบครบ 60 วิ ตัวคุมก็เด้งเป็น "ว่าง" ทันที
 *
 * **สถานะที่ค้างถูกอ่านว่าว่าง** ซึ่งกลับหัวจากความจริง — "บอทบอกว่าจบแล้ว" กับ "บอทเงียบไป"
 * เป็นคนละเรื่องกันสิ้นเชิง และอย่างหลังคือช่วงที่อันตรายที่สุดที่จะไปตัด ไม่ใช่ปลอดภัยที่สุด
 * รอบนั้นรอดเพราะยังไม่ทันจ่ายเครดิตวิดีโอ ถ้าช้าไปอีกนาทีเดียวคือคลิปหาย
 *
 * เงียบตอนไม่มีงานค้าง = ปิดเบราว์เซอร์ไปเฉยๆ รีสตาร์ตได้ (ข้อกังวลเดิมยังถูก)
 * เงียบตอนมีงานค้าง = ขาดการติดต่อกลางงาน ต้องรอจนมั่นใจว่างานถูกทิ้งจริง
 */
function isIdle(): boolean {
  try {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8')) as {
      currentJobId: number | null;
      updatedAt: string;
    };
    // ไม่มีงานค้าง = ไม่มีอะไรให้ตัดกลาง รีสตาร์ตได้เลยไม่ว่า heartbeat จะสดหรือค้าง
    if (state.currentJobId === null || state.currentJobId === undefined) return true;
    const silentMs = Date.now() - new Date(state.updatedAt).getTime();
    if (silentMs > ABANDONED_MS) {
      log(
        `⚠️ งาน #${state.currentJobId} เงียบมา ${Math.round(silentMs / 60_000)} นาที `
        + '— ถือว่าถูกทิ้งแล้วและยอมรีสตาร์ต'
      );
      return true;
    }
    return false;
  } catch {
    // อ่านไฟล์ไม่ได้ = ยังไม่เคยมี Extension ต่อเข้ามา ถือว่าว่าง
    return true;
  }
}

function restartNow(): void {
  restartPending = false;
  log('บอทว่างแล้ว — รีสตาร์ต service ด้วยโค้ดใหม่');
  const dying = child;
  child = null;
  if (dying) dying.kill();
  setTimeout(() => { if (!stopping) startService(); }, 500);
}

/** ไล่ดูไฟล์ซอร์สทั้งหมด คืนไฟล์ที่ถูกแก้ล่าสุดพร้อมเวลา */
function scanSources(dir: string): { newest: number; file: string } {
  let newest = 0;
  let file = '';
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const deeper = scanSources(full);
      if (deeper.newest > newest) ({ newest, file } = deeper);
      continue;
    }
    if (!/\.(?:ts|json)$/i.test(entry.name)) continue;
    const mtime = fs.statSync(full).mtimeMs;
    if (mtime > newest) { newest = mtime; file = path.relative(root, full); }
  }
  return { newest, file };
}

// ต้องเช็คก่อน spawn อะไรทั้งสิ้น — ถ้ามีตัวอื่นอยู่แล้ว การ spawn service จะไปชนพอร์ตทันที
if (!claimSingletonLock()) process.exit(0);
process.on('exit', releaseSingletonLock);

let lastSeen = scanSources(watchDir).newest;

log(`เฝ้า ${path.relative(root, watchDir)} และรีสตาร์ตให้เองเมื่อบอทว่าง`);
startService();

setInterval(() => {
  let snapshot: { newest: number; file: string };
  try {
    snapshot = scanSources(watchDir);
  } catch (error: any) {
    // ไดรฟ์เครือข่ายหลุดชั่วคราว — ข้ามรอบนี้ ห้ามทำให้ตัวคุมตาย
    log(`อ่านไฟล์ซอร์สไม่ได้รอบนี้ (${String(error?.message || error).slice(0, 80)})`);
    return;
  }
  if (snapshot.newest <= lastSeen) return;
  lastSeen = snapshot.newest;
  if (restartPending) return;
  restartPending = true;
  log(`พบการแก้ไข ${snapshot.file} — จะรีสตาร์ตเมื่อบอทว่าง`);
}, SCAN_MS);

setInterval(() => {
  if (!restartPending) return;
  if (!isIdle()) {
    log('มีงานเดินอยู่ — เลื่อนการรีสตาร์ตออกไปก่อน (จะไม่ตัดกลางงานที่จ่ายเครดิตแล้ว)');
    return;
  }
  restartNow();
}, IDLE_POLL_MS);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    stopping = true;
    log('ปิดตัวคุมและ service');
    child?.kill();
    process.exit(0);
  });
}
