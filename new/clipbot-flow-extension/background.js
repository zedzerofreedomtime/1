const DEFAULT_API = 'http://127.0.0.1:8110';
const FLOW_VIDEO_TIMEOUT_MS = 15 * 60 * 1000;
// ช่วงพักมีสองแบบ (เจ้าของกำหนด 27 ก.ค. 2026):
//
//   ระหว่างคลิปในงานเดียวกัน (รูป→คลิป, คลิป→คลิป)  = 1-3 นาที
//   ข้ามไปงานใหม่ (งานจบ, หรือข้ามงานที่ fidelity ตก) = 3-5 นาที  ยาวขึ้น
//
// เหตุผล: การเริ่ม "งานใหม่" คือจุดที่สร้างโปรเจกต์ใหม่ + อัปโหลดชุดใหม่ = รอยเท้าหนักสุด
// ตัวคูณหลัง error ยังเป็น 2 เท่าเหมือนเดิม → 2-6 นาที และ 6-10 นาทีตามลำดับ
const NORMAL_COOLDOWN_MIN_MS = 1 * 60 * 1000;
const NORMAL_COOLDOWN_MAX_MS = 3 * 60 * 1000;
const NEXT_JOB_COOLDOWN_MIN_MS = 3 * 60 * 1000;
const NEXT_JOB_COOLDOWN_MAX_MS = 5 * 60 * 1000;
const ERROR_RETRY_LIMIT = 3;
// job #99 (27 ก.ค. 2026): Flow เจนคลิปไม่สำเร็จ → บอทกด "ลองอีกครั้ง" เวลา 11:34:41
// → 9 วินาทีต่อมา Flow ขึ้นการ์ด "กิจกรรมผิดปกติ" ทันที การยิงคำสั่งซ้ำทันทีหลังถูก
// ปฏิเสธคือจังหวะที่เสี่ยงที่สุด และไม่ได้ช่วยอะไร เพราะรอบก่อนหน้าก็ล้มซ้ำอยู่ดี
// ปิดไว้ = ล้มแล้วปล่อยให้เข้ากลไกพัก 20 นาทีเดิม แล้วค่อยเริ่มงานเดิมใหม่ทีหลัง
const FAILED_CARD_RETRY_ENABLED = false;
// fidelity บล็อกติดกันเกินนี้ = ปัญหาเชิงระบบ → หยุดกันเผาเครดิต (รีเซ็ตเมื่อมีงานสำเร็จ)
const FIDELITY_FAIL_STREAK_LIMIT = 3;
const MEDIA_LIBRARY_RETRY_LIMIT = 3;
const ERROR_RECOVERY_PAUSE_MS = 20 * 60 * 1000;
const NEXT_DAY_RECOVERY_PAUSE_MS = 24 * 60 * 60 * 1000;
// ─── จังหวะพิมพ์แบบมนุษย์ ───
// เดิมใช้ค่าคงที่ 70ms/ตัว — ตรวจจับง่ายเพราะสม่ำเสมอเกินไป
// เปลี่ยนเป็น: variable delay + typo + word pause + burst + thinking pause
const TYPING_DELAY_BASE_MIN_MS = 50;
const TYPING_DELAY_BASE_MAX_MS = 100;
const TYPING_TYPO_CHANCE = 0.02;
const TYPING_WORD_PAUSE_MIN_MS = 150;
const TYPING_WORD_PAUSE_MAX_MS = 400;
const TYPING_THINK_CHANCE = 0.03;
const TYPING_THINK_MIN_MS = 500;
const TYPING_THINK_MAX_MS = 1500;
const TYPING_BURST_MIN_MS = 30;
const TYPING_BURST_MAX_MS = 60;
const TYPING_BURST_MAX_LEN = 5;
const TYPO_NEIGHBORS = {
  a: 'sq', b: 'vn', c: 'xv', d: 'sf', e: 'rw', f: 'dg', g: 'fh',
  h: 'gj', i: 'uo', j: 'hk', k: 'jl', l: 'k;', m: 'n,', n: 'bm',
  o: 'ip', p: 'o[', q: 'wa', r: 'et', s: 'ad', t: 'ry', u: 'yi',
  v: 'cb', w: 'qe', x: 'zc', y: 'tu', z: 'xa',
};
/** สุ่ม delay ด้วย Gaussian-like distribution (Box-Muller) — ค่ากระจุกตรงกลาง ไม่สม่ำเสมอ */
function gaussianDelay(min, max) {
  const u1 = Math.random() || 0.0001;
  const u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  const mean = (min + max) / 2;
  const stddev = (max - min) / 6;
  return Math.max(min, Math.min(max, Math.round(mean + z * stddev)));
}
/** สุ่มตัว typo ใกล้เคียงบน keyboard */
function getTypoChar(original) {
  const lower = original.toLowerCase();
  const neighbors = TYPO_NEIGHBORS[lower];
  if (!neighbors) return lower === original ? 'x' : 'X';
  const pick = neighbors[Math.floor(Math.random() * neighbors.length)];
  return lower === original ? pick : pick.toUpperCase();
}
// ค่าเฉลี่ยสำหรับประมาณเวลาที่เหลือ (popup display)
const PROMPT_KEY_DELAY_MS = Math.round((TYPING_DELAY_BASE_MIN_MS + TYPING_DELAY_BASE_MAX_MS) / 2);
const randomPauseMs = (minMs, maxMs, multiplier = 1) => {
  const safeMultiplier = Number(multiplier) >= 2 ? 2 : 1;
  const min = minMs * safeMultiplier;
  const max = maxMs * safeMultiplier;
  return min + Math.floor(Math.random() * (max - min + 1));
};
/** พักระหว่างคลิปในงานเดียวกัน — 1-3 นาที */
const randomCooldownMs = (multiplier = 1) =>
  randomPauseMs(NORMAL_COOLDOWN_MIN_MS, NORMAL_COOLDOWN_MAX_MS, multiplier);
/** พักก่อนเริ่มงานใหม่ — 3-5 นาที (รอยเท้าหนักกว่า: สร้างโปรเจกต์ใหม่ + อัปโหลดชุดใหม่) */
const randomNextJobCooldownMs = (multiplier = 1) =>
  randomPauseMs(NEXT_JOB_COOLDOWN_MIN_MS, NEXT_JOB_COOLDOWN_MAX_MS, multiplier);
// Before FLOW_ARM_WATCH no paid click has happened yet. If the content script
// disappears during upload, safely re-dispatch after this silence window.
// Enhanced typing with variable delays takes longer than fixed 70ms — increase headroom.
const PRE_SUBMIT_STALL_TIMEOUT_MS = 8 * 60 * 1000;
let loopBusy = false;
let lastLoggedStatusKey = '';
const activeWatches = new Set();
const activePromptTyping = new Map();

function cancelActivePromptTyping(reason = 'cancelled') {
  for (const token of activePromptTyping.values()) {
    token.cancelled = true;
    token.reason = reason;
  }
}

async function emitLog(level, stage, message, details = {}) {
  try {
    const { backendUrl, currentJob } = await state();
    await fetch(`${backendUrl}/api/extension/logs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        level,
        source: 'extension',
        stage,
        message: String(message || ''),
        jobId: details.jobId ?? currentJob?.jobId ?? null,
        clipIndex: details.clipIndex ?? currentJob?.clipIndex ?? null,
        durationMs: details.durationMs,
        error: details.error ? {
          name: details.error.name || 'Error',
          message: details.error.message || String(details.error),
          stack: String(details.error.stack || '').split('\n').slice(0, 10).join('\n'),
        } : undefined,
        meta: details.meta,
      }),
    });
  } catch (_) {
    console[level === 'error' ? 'error' : 'log'](`[ClipBot:${stage}] ${message}`);
  }
}

async function state() {
  const value = await chrome.storage.local.get([
    'backendUrl', 'running', 'creditLocked', 'lastStatus', 'currentJob',
    'nextJobCooldownUntil', 'durationSeconds', 'cooldownMultiplier',
  ]);
  const storedBackend = String(value.backendUrl || '').replace(/\/$/, '');
  const backendUrl = !storedBackend || storedBackend === 'http://127.0.0.1:8100'
    ? DEFAULT_API
    : storedBackend;
  return {
    backendUrl,
    running: Boolean(value.running),
    creditLocked: value.creditLocked !== false,
    lastStatus: value.lastStatus || 'บอทหยุดอยู่',
    currentJob: value.currentJob || null,
    nextJobCooldownUntil: Number(value.nextJobCooldownUntil || 0),
    durationSeconds: Number(value.durationSeconds) === 16 ? 16 : 24,
    cooldownMultiplier: Number(value.cooldownMultiplier) >= 2 ? 2 : 1,
  };
}

async function api(path, options = {}) {
  const { backendUrl } = await state();
  const started = Date.now();
  try {
    const headers = {
      ...(options.headers || {}),
      'X-ClipForge-Version': chrome.runtime.getManifest().version,
    };
    const response = await fetch(`${backendUrl}${path}`, { ...options, headers });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Web App ตอบกลับ ${response.status}`);
    return data;
  } catch (error) {
    emitLog('error', 'api.request', `${options.method || 'GET'} ${path} ล้มเหลว`, {
      durationMs: Date.now() - started,
      error,
    });
    throw error;
  }
}

async function ensureQueuedJob(itemId, durationSeconds = 24) {
  return api('/api/extension/jobs/auto', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      itemId: Number(itemId) > 0 ? Number(itemId) : null,
      durationSeconds: Number(durationSeconds) === 16 ? 16 : 24,
    }),
  });
}

function debuggerCall(method, ...args) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      settled = true;
      reject(new Error(`Chrome debugger ${method} timed out`));
    }, 10000);
    chrome.debugger[method](...args, (result) => {
      const error = chrome.runtime.lastError;
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(new Error(error.message));
      else resolve(result);
    });
  });
}

/**
 * พิมพ์ prompt ทีละตัวอักษรด้วยจังหวะเลียนแบบมนุษย์
 *
 * ปรับปรุงจากเวอร์ชันเดิม (fixed 70ms/ตัว) เพื่อหลบ pattern detection:
 *   • Variable delay — Gaussian distribution ระหว่าง 50–100ms
 *   • Word-boundary pauses — เว้นวรรค/ขึ้นบรรทัดใหม่ หน่วง 150–400ms
 *   • Typo simulation — ~2% โอกาสพิมพ์ผิด → รอ → Backspace → พิมพ์ถูก
 *   • Burst typing — ตัวอักษรต่อเนื่องในคำสั้น พิมพ์เร็วขึ้น (30–60ms)
 *   • Thinking pauses — ทุก 30–80 ตัว มีโอกาส 3% หยุด 500–1500ms
 */
async function typePromptLikeKeyboard(tabId, prompt, jobId) {
  const target = { tabId };
  const previous = activePromptTyping.get(tabId);
  if (previous) {
    previous.cancelled = true;
    previous.reason = 'replaced by a newer typing request';
  }
  const token = { cancelled: false, reason: '', jobId: Number(jobId) };
  activePromptTyping.set(tabId, token);
  await debuggerCall('attach', target, '1.3');
  try {
    const key = (params) => debuggerCall('sendCommand', target, 'Input.dispatchKeyEvent', params);
    // ลบข้อความเดิม: Ctrl+A → Backspace
    await key({ type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
    await key({ type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
    await key({ type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
    await key({ type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });

    const chars = [...prompt];
    const total = chars.length;
    const estimatedSeconds = Math.round((total * PROMPT_KEY_DELAY_MS) / 1000);
    let typed = 0;
    let nextReport = 0;
    let burstRemaining = 0;
    let charsSinceThinkCheck = 0;
    const thinkCheckInterval = 30 + Math.floor(Math.random() * 50);

    for (let i = 0; i < total; i++) {
      if (token.cancelled) {
        throw new Error(`Prompt typing cancelled: ${token.reason || 'bot stopped'}`);
      }
      const character = chars[i];
      const prevChar = i > 0 ? chars[i - 1] : '';
      const isWordBoundary = /[\s\n\r,.;:!?()]/.test(character);
      const prevIsWordBoundary = /[\s\n\r,.;:!?()]/.test(prevChar);

      // ─── Typo Simulation ───
      if (burstRemaining <= 0
        && !isWordBoundary
        && /[a-zA-Z0-9]/.test(character)
        && Math.random() < TYPING_TYPO_CHANCE
      ) {
        const typo = getTypoChar(character);
        await debuggerCall('sendCommand', target, 'Input.insertText', { text: typo });
        await new Promise((resolve) => setTimeout(resolve, 200 + Math.floor(Math.random() * 300)));
        await key({ type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
        await key({ type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
        await new Promise((resolve) => setTimeout(resolve, 80 + Math.floor(Math.random() * 120)));
      }

      // ─── พิมพ์ตัวอักษรจริง ───
      await debuggerCall('sendCommand', target, 'Input.insertText', { text: character });
      typed++;

      // ─── รายงานความคืบหน้า ───
      const percent = Math.floor((typed / total) * 100);
      if (percent >= nextReport) {
        nextReport = percent + 10;
        const remaining = Math.max(0, Math.round(((total - typed) * PROMPT_KEY_DELAY_MS) / 1000));
        // ⚠️ ห้ามใช้ setStatus() ตรงนี้ — มันยิง API ไป backend แล้วประมวลผลคำสั่งรีโมตด้วย
        await chrome.storage.local.set({
          lastStatus: `กำลังพิมพ์ Prompt ${percent}% (${typed}/${total} ตัว) — เหลืออีกราว ${remaining} วินาที อย่าเพิ่งกดหยุด`,
        });
      }

      // ─── คำนวณ delay ───
      let delay;
      if (isWordBoundary && !prevIsWordBoundary) {
        delay = gaussianDelay(TYPING_WORD_PAUSE_MIN_MS, TYPING_WORD_PAUSE_MAX_MS);
        burstRemaining = 0;
      } else if (burstRemaining > 0) {
        delay = gaussianDelay(TYPING_BURST_MIN_MS, TYPING_BURST_MAX_MS);
        burstRemaining--;
      } else {
        delay = gaussianDelay(TYPING_DELAY_BASE_MIN_MS, TYPING_DELAY_BASE_MAX_MS);
        if (i + 1 < total && /[a-zA-Z0-9]/.test(chars[i + 1]) && Math.random() < 0.45) {
          burstRemaining = 1 + Math.floor(Math.random() * TYPING_BURST_MAX_LEN);
        }
      }

      // ─── Thinking Pause ───
      charsSinceThinkCheck++;
      if (charsSinceThinkCheck >= thinkCheckInterval) {
        charsSinceThinkCheck = 0;
        if (Math.random() < TYPING_THINK_CHANCE) {
          delay += gaussianDelay(TYPING_THINK_MIN_MS, TYPING_THINK_MAX_MS);
        }
      }

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    if (token.cancelled) {
      throw new Error(`Prompt typing cancelled: ${token.reason || 'bot stopped'}`);
    }
    return { ok: true, typed: total, estimatedSeconds };
  } finally {
    if (activePromptTyping.get(tabId) === token) activePromptTyping.delete(tabId);
    await debuggerCall('detach', target).catch(() => {});
  }
}

async function clickLikeMouse(tabId, x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > 10000 || y > 10000) {
    throw new Error('Invalid click coordinates');
  }
  const target = { tabId };
  await debuggerCall('attach', target, '1.3');
  try {
    await debuggerCall('sendCommand', target, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved', x, y,
    });
    await debuggerCall('sendCommand', target, 'Input.dispatchMouseEvent', {
      type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    await debuggerCall('sendCommand', target, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1,
    });
    return { ok: true };
  } finally {
    await debuggerCall('detach', target).catch(() => {});
  }
}

/**
 * เคลื่อนเมาส์ตาม Bezier path แล้วคลิกที่จุดสุดท้าย — ใช้ CDP ให้เคอร์เซอร์เคลื่อนจริง
 *
 * @param {number} tabId  - Tab ที่จะส่ง event ไป
 * @param {Array<{x: number, y: number, delay: number}>} path - จุดตามเส้นทาง Bezier
 * @param {boolean} click - true = คลิกที่จุดสุดท้าย, false = แค่เลื่อน
 */
async function moveLikeMouse(tabId, path, click) {
  if (!Array.isArray(path) || path.length === 0) throw new Error('Empty mouse path');
  const target = { tabId };
  await debuggerCall('attach', target, '1.3');
  try {
    // ── เคลื่อนเมาส์ตามแต่ละจุด ──
    for (const point of path) {
      const px = Math.round(Number(point.x));
      const py = Math.round(Number(point.y));
      if (!Number.isFinite(px) || !Number.isFinite(py)) continue;
      await debuggerCall('sendCommand', target, 'Input.dispatchMouseEvent', {
        type: 'mouseMoved', x: px, y: py,
      });
      if (point.delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, Math.round(point.delay)));
      }
    }

    // ── คลิกที่จุดสุดท้าย ──
    if (click) {
      const last = path[path.length - 1];
      const lx = Math.round(Number(last.x));
      const ly = Math.round(Number(last.y));
      // หน่วงเล็กน้อยก่อนกด (มนุษย์จะหยุดก่อนคลิก)
      await new Promise((resolve) => setTimeout(resolve, 30 + Math.floor(Math.random() * 50)));
      await debuggerCall('sendCommand', target, 'Input.dispatchMouseEvent', {
        type: 'mousePressed', x: lx, y: ly, button: 'left', buttons: 1, clickCount: 1,
      });
      await new Promise((resolve) => setTimeout(resolve, 40 + Math.floor(Math.random() * 40)));
      await debuggerCall('sendCommand', target, 'Input.dispatchMouseEvent', {
        type: 'mouseReleased', x: lx, y: ly, button: 'left', buttons: 0, clickCount: 1,
      });
    }
    return { ok: true };
  } finally {
    await debuggerCall('detach', target).catch(() => {});
  }
}

async function waitForChromeDownload(downloadId, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.downloads.onChanged.removeListener(onChanged);
      reject(new Error('Chrome ดาวน์โหลดคลิปไม่เสร็จภายใน 2 นาที'));
    }, timeoutMs);

    async function finish() {
      const [item] = await chrome.downloads.search({ id: downloadId });
      if (!item) throw new Error('ไม่พบรายการดาวน์โหลดของ Chrome');
      if (item.state === 'interrupted') throw new Error(`Chrome ดาวน์โหลดไม่สำเร็จ: ${item.error || 'interrupted'}`);
      if (item.state !== 'complete') return;
      clearTimeout(timeout);
      chrome.downloads.onChanged.removeListener(onChanged);
      resolve(item);
    }

    function onChanged(delta) {
      if (delta.id !== downloadId || (!delta.state && !delta.error)) return;
      finish().catch((error) => {
        clearTimeout(timeout);
        chrome.downloads.onChanged.removeListener(onChanged);
        reject(error);
      });
    }

    chrome.downloads.onChanged.addListener(onChanged);
    finish().catch((error) => {
      clearTimeout(timeout);
      chrome.downloads.onChanged.removeListener(onChanged);
      reject(error);
    });
  });
}

async function downloadAndImportClip(videoUrl, apiBase, jobId, clipIndex) {
  const started = Date.now();
  await emitLog('info', 'clip.download', 'เริ่มดาวน์โหลดคลิปจาก Flow', { jobId, clipIndex });
  const filename = `ClipBot/clipbot_job_${jobId}_clip_${clipIndex + 1}.mp4`;
  const downloadId = await chrome.downloads.download({
    url: videoUrl,
    filename,
    conflictAction: 'overwrite',
    saveAs: false,
  });
  try {
    const item = await waitForChromeDownload(downloadId);
    const bytes = Math.max(0, Number(item.fileSize || 0), Number(item.totalBytes || 0), Number(item.bytesReceived || 0));
    if (!item.filename || bytes < 1024) {
      throw new Error('Chrome ดาวน์โหลดคลิปได้ไฟล์ว่างหรือไม่พบ path');
    }
    if (/^image\//i.test(String(item.mime || ''))) {
      throw new Error(`Flow ส่ง thumbnail รูปภาพแทนวิดีโอ (${item.mime}) — ไม่บันทึกเป็นคลิป`);
    }

    const response = await fetch(`${apiBase}/api/extension/jobs/${jobId}/downloads/${clipIndex}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ downloadPath: item.filename, sourceUrl: videoUrl }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Local Service นำเข้าคลิปไม่สำเร็จ (${response.status})`);
    await emitLog('info', 'clip.download', 'ดาวน์โหลดและนำเข้าคลิปสำเร็จ', {
      jobId,
      clipIndex,
      durationMs: Date.now() - started,
      meta: { bytes },
    });
    return { data, size: bytes, downloadId };
  } finally {
    // Failed thumbnail/HTML downloads must not remain and collide with a later
    // retry under the same deterministic filename.
    await chrome.downloads.removeFile(downloadId).catch(() => {});
    await chrome.downloads.erase({ id: downloadId }).catch(() => {});
  }
}

async function downloadAndImportGeneratedImage(imageUrl, apiBase, jobId, imageRole = 'start') {
  const started = Date.now();
  await emitLog('info', 'image.download', 'Downloading generated product image from Flow', { jobId });
  const downloadId = await chrome.downloads.download({
    url: imageUrl,
    filename: `ClipBot/clipbot_job_${jobId}_generated_${imageRole === 'end' ? 'end' : 'start'}.png`,
    conflictAction: 'overwrite',
    saveAs: false,
  });
  try {
    const item = await waitForChromeDownload(downloadId);
    const bytes = Math.max(0, Number(item.fileSize || 0), Number(item.totalBytes || 0), Number(item.bytesReceived || 0));
    if (!item.filename || bytes < 2048) throw new Error('Flow returned an empty generated image');
    if (item.mime && !/^image\//i.test(String(item.mime))) {
      throw new Error(`Flow returned a non-image payload (${item.mime})`);
    }
    const response = await fetch(`${apiBase}/api/extension/jobs/${jobId}/generated-image`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ downloadPath: item.filename, sourceUrl: imageUrl, imageRole }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Local Service could not import the generated image (${response.status})`);
    await emitLog('info', 'image.download', 'Generated product image imported', {
      jobId,
      durationMs: Date.now() - started,
      meta: { bytes },
    });
    return { data, size: bytes, downloadId };
  } finally {
    await chrome.downloads.removeFile(downloadId).catch(() => {});
    await chrome.downloads.erase({ id: downloadId }).catch(() => {});
  }
}

async function setStatus(message, patch = {}) {
  await chrome.storage.local.set({ lastStatus: message, ...patch });
  const current = await state();
  const statusKey = `${message}|${current.currentJob?.jobId || ''}|${current.currentJob?.clipIndex ?? ''}|${current.running}`;
  if (statusKey !== lastLoggedStatusKey) {
    lastLoggedStatusKey = statusKey;
    emitLog('info', 'bot.status', message, {
      jobId: current.currentJob?.jobId,
      clipIndex: current.currentJob?.clipIndex,
      meta: { running: current.running, creditLocked: current.creditLocked },
    });
  }
  try {
    const reply = await api('/api/extension/status', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        running: current.running,
        creditLocked: current.creditLocked,
        status: message,
        currentJobId: current.currentJob?.jobId || null,
        // ส่งเวอร์ชันมาด้วย จะได้รู้แน่ๆ ว่า Chrome โหลดโค้ดตัวไหนอยู่
        // (เคยเสียเวลาไล่บั๊กที่แก้ไปแล้ว เพราะ reload ไม่ติดโดยไม่มีใครรู้)
        version: chrome.runtime.getManifest().version,
      }),
    });
    // service ส่งคำสั่งรีโมตกลับมาได้ (ใช้ตอน debug — ปกติคุมจากป๊อปอัป)
    // ใช้ commandPayload ก่อน (มีพารามิเตอร์) แล้วค่อย fallback เป็น command แบบ string
    if (reply?.commandPayload || reply?.command) {
      await handleRemoteCommand(reply.commandPayload || reply.command);
    }
  } catch (_) { /* heartbeat จะลองใหม่ */ }
}

/**
 * รับคำสั่งจาก Local Service (one-shot — service ลบคำสั่งทิ้งหลังส่งแล้ว)
 *
 * มีไว้เพื่อให้ไล่บั๊กได้โดยไม่ต้องให้คนกด Start ซ้ำเป็นสิบรอบ
 * ยังเคารพ credit lock อยู่ — ปลดล็อกเองไม่ได้ ต้องคนปลดเท่านั้น
 */
async function handleRemoteCommand(payload) {
  // รองรับทั้งแบบส่งชื่อคำสั่งเฉยๆ และแบบส่งทั้งก้อนพร้อมพารามิเตอร์
  const command = typeof payload === 'string' ? payload : payload?.command;
  const current = await state();

  // ── กู้คลิปที่ Veo เจนเสร็จแล้วแต่บอทเก็บไม่ทัน ──
  //
  // URL ของคลิปต้องใช้ cookie ของ labs.google ถึงจะโหลดได้
  // ฝั่ง Node โหลดเองไม่ได้ → ต้องให้ background ของ extension เป็นคนโหลด
  // (มี host_permissions + credentials:'include' อยู่แล้ว)
  // ใช้ตอนจ่าย credit ไปแล้วแต่คลิปหลุดมือ จะได้ไม่ต้องเจนซ้ำ
  if (command === 'salvage') {
    try {
      await chrome.storage.local.set({ lastStatus: 'กำลังกู้คลิปที่เจนไว้แล้ว...' });
      const outcome = await downloadAndImportClip(
        payload.url, current.backendUrl, payload.jobId, payload.clipIndex
      );
      await chrome.storage.local.set({
        lastStatus: `กู้คลิป ${payload.clipIndex + 1} สำเร็จ (${Math.round(outcome.size / 1024)} KB)`,
      });
    } catch (error) {
      await chrome.storage.local.set({ lastStatus: `กู้คลิปไม่สำเร็จ: ${error.message}` });
    }
    return;
  }

  // โหลดโค้ดใหม่จากดิสก์เอง — ทำให้ไม่ต้องให้คนไปกด Reload ที่ chrome://extensions อีก
  // (extension แบบ unpacked เรียก chrome.runtime.reload() แล้วอ่านไฟล์ใหม่ให้เลย)
  if (command === 'reload') {
    await chrome.storage.local.set({ lastStatus: 'รีโมตสั่งโหลดโค้ดใหม่...', running: false, currentJob: null, submittedFor: null });
    chrome.runtime.reload();
    return;
  }

  // ปลด/ล็อกเครดิตจากรีโมต — เจ้าของเครื่องอนุญาตให้สั่งได้เมื่อ 17 ก.ค. 2026
  // (จำเป็นด้วย เพราะทุกครั้งที่ reload ตัว onInstalled จะล็อกเครดิตกลับอัตโนมัติ)
  if (command === 'unlock' || command === 'lock') {
    const locked = command === 'lock';
    await chrome.storage.local.set({
      creditLocked: locked,
      lastStatus: locked ? 'รีโมตล็อกเครดิตแล้ว' : 'รีโมตปลดล็อกเครดิตแล้ว — พร้อมเริ่ม',
      running: locked ? false : current.running,
    });
    return;
  }

  // สั่งถ่าย DOM ของแท็บ Flow ตอนนี้เลย — ใช้ส่องตอนบอทค้างโดยไม่มี error
  // (ไม่แตะอะไรบนหน้า ไม่เสีย credit)
  if (command === 'snapshot') {
    try {
      const tab = await flowTab();
      await chrome.tabs.sendMessage(tab.id, { type: 'FLOW_SNAPSHOT' }).catch(async () => {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
        await chrome.tabs.sendMessage(tab.id, { type: 'FLOW_SNAPSHOT' });
      });
      await chrome.storage.local.set({ lastStatus: 'ถ่าย DOM ตามคำสั่งรีโมตแล้ว' });
    } catch (error) {
      await chrome.storage.local.set({ lastStatus: `ถ่าย DOM ไม่สำเร็จ: ${error.message}` });
    }
    return;
  }

  if (command === 'start') {
    if (current.creditLocked) {
      await chrome.storage.local.set({ lastStatus: 'รีโมตสั่ง Start แต่เครดิตล็อกอยู่ — ปลดล็อกก่อน' });
      return;
    }
    if (current.running) return;
    const queued = await ensureQueuedJob(null, current.durationSeconds);
    await chrome.storage.local.set({
      lastStatus: queued.random ? `สุ่มสินค้าอัตโนมัติแล้ว — งาน #${queued.id}` : `เริ่มงานที่รออยู่ #${queued.id}`,
      running: true,
      currentJob: null,
      submittedFor: null,
      cooldownMultiplier: 1,
    });
    runNext();
  } else if (command === 'stop') {
    cancelActivePromptTyping('user stopped the bot');
    const tabs = await chrome.tabs.query({ url: 'https://labs.google/*' });
    await Promise.allSettled(tabs.map((tab) => tab.id
      ? chrome.tabs.sendMessage(tab.id, { type: 'FLOW_CANCEL' })
      : Promise.resolve()));
    await chrome.storage.local.set({ lastStatus: 'รีโมตสั่งหยุดบอท', running: false, currentJob: null, submittedFor: null });
  }
}

async function flowTab() {
  const tabs = await chrome.tabs.query({ url: 'https://labs.google/*' });
  const flowTabs = tabs.filter((tab) => /\/tools\/flow|\/flow\/project/.test(tab.url || ''));
  const usable = flowTabs.find((tab) => tab.active)
    || flowTabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
  if (usable?.id) return usable;
  throw new Error('ไม่พบแท็บ Google Flow ที่ผู้ใช้เปิดไว้ — บอทจะไม่เปิด Chrome หรือแท็บใหม่เอง');
}

function imageUrl(apiBase, imagePath) {
  return `${apiBase}/api/media?path=${encodeURIComponent(imagePath)}`;
}

function jobDispatchKey(job) {
  if (!job || !['image', 'video'].includes(job.stage)) return null;
  const imageRole = job.stage === 'image' && job.imageRole === 'end' ? 'end' : 'start';
  return `${job.jobId}:${job.stage}:${imageRole}:${job.clipIndex}`;
}

async function sendCurrentJob(tabId) {
  const current = await state();
  if (!current.running || !current.currentJob) return;
  if (current.currentJob.phase === 'cooldown') {
    if (Number(current.currentJob.cooldownUntil || 0) > Date.now()) return;
    const resetRecovery = current.currentJob.resetRecoveryOnResume === true;
    await chrome.storage.local.set({
      currentJob: {
        ...current.currentJob,
        phase: 'preparing',
        cooldownUntil: null,
        cooldownReason: null,
        recoveryStage: resetRecovery ? 0 : Number(current.currentJob.recoveryStage || 0),
        resetRecoveryOnResume: false,
      },
      ...(resetRecovery ? { cooldownMultiplier: 1 } : {}),
    });
    await chrome.storage.local.remove('submittedFor');
  }

  // ── กันส่งงานซ้ำเด็ดขาด ──
  //
  // chrome.tabs.onUpdated ยิงทุกครั้งที่หน้าโหลดเสร็จ และ Flow เปลี่ยนหน้าเองหลังกด Generate
  // → content script ถูกฉีดใหม่ (working flag รีเซ็ต) → รันทับตัวที่กำลังรอวิดีโออยู่
  // → ตัวใหม่พังบนหน้าที่โหลดไม่เสร็จ → job โดนมาร์ค failed + currentJob ถูกล้าง
  // → พอตัวเดิมเจอวิดีโอ ส่งกลับมาก็ถูกปฏิเสธ = "จ่าย credit แล้วแต่คลิปหาย"
  //
  // เก็บใน storage ไม่ใช่ตัวแปร เพราะ service worker ของ MV3 ถูกฆ่าได้ตลอด
  // Fail closed when an old/stale Web App returns a job without the stage.
  // Defaulting an unknown stage to video skips the paid reference-image step
  // and can spend credits on the wrong workflow.
  if (!['image', 'video'].includes(current.currentJob.stage)) {
    throw new Error('Web App ส่งขั้นตอนงานไม่ครบ (ไม่มี image/video stage) — กรุณารีสตาร์ต Web App');
  }
  const stage = current.currentJob.stage;
  const imageRole = stage === 'image' && current.currentJob.imageRole === 'end' ? 'end' : 'start';
  const key = jobDispatchKey(current.currentJob);
  const saved = await chrome.storage.local.get('submittedFor');
  if (saved.submittedFor === key) {
    console.log('[ClipBot] ข้ามการส่งซ้ำสำหรับ', key);
    return;
  }
  await chrome.storage.local.set({ submittedFor: key });
  await chrome.storage.local.set({ jobDispatchAt: Date.now() });

  const endImagePath = typeof current.currentJob.endImagePath === 'string'
    ? current.currentJob.endImagePath.trim()
    : '';
  const message = {
    type: stage === 'image' ? 'FLOW_RUN_IMAGE' : 'FLOW_RUN_CLIP',
    stage,
    jobId: current.currentJob.jobId,
    clipIndex: current.currentJob.clipIndex,
    forceNewProject: current.currentJob.forceNewProject === true,
    projectReady: current.currentJob.projectReady === true,
    imageUrl: imageUrl(current.backendUrl, current.currentJob.imagePath),
    prompt: current.currentJob.prompt,
    ...(stage === 'image' ? { imageRole } : {}),
    // วิธี A: รูปสินค้าทางการมุมอื่น แนบเป็น reference เสริม (เฉพาะเฟรมต้น)
    // ไม่มี field นี้ = พฤติกรรมเดิมทุกประการ (content.js ข้ามขั้นนี้ไป)
    ...(stage === 'image' && imageRole === 'start'
      && Array.isArray(current.currentJob.referenceImagePaths)
      && current.currentJob.referenceImagePaths.length
      ? {
          referenceImageUrls: current.currentJob.referenceImagePaths
            .map((path) => imageUrl(current.backendUrl, path)),
        }
      : {}),
    clipCount: Number(current.currentJob.clipCount || 3),
    targetDurationSeconds: Number(current.currentJob.targetDurationSeconds || 24),
    // Frames-to-Video is opt-in. Keep this field absent for existing
    // start-only jobs so content.js follows the proven legacy path unchanged.
    ...(stage === 'video' && Number(current.currentJob.clipIndex) === 0 && endImagePath
      ? { endImageUrl: imageUrl(current.backendUrl, endImagePath) }
      : {}),
    // โหมดส่วนผสม: เฉพาะคลิปแรกเท่านั้น (คลิปถัดไปต้องต่อจากเฟรมสุดท้าย = โหมดเฟรม)
    // ไม่มี field นี้ = content.js เดินเส้นทางเดิมทุกประการ
    ...(stage === 'video' && Number(current.currentJob.clipIndex) === 0
      && Array.isArray(current.currentJob.ingredientImagePaths)
      && current.currentJob.ingredientImagePaths.length
      ? {
          ingredientUrls: current.currentJob.ingredientImagePaths
            .map((path) => imageUrl(current.backendUrl, path)),
        }
      : {}),
  };
  // job #98: หมายเลขแท็บที่จำไว้ตอนจบคลิป 1 ตายระหว่างพัก 3 นาที (ผู้ใช้ปิดแท็บ หรือ
  // Memory Saver เก็บแท็บแล้วคืนมาเป็น id ใหม่) → "No tab with id" ล้มงานทั้งใบ
  // ทั้งที่แท็บ Flow ยังเปิดอยู่จริง — ตรวจแท็บก่อนใช้ ถ้าตายให้ถอยไปหาแท็บ Flow
  // ที่เปิดอยู่ปัจจุบันแทน (flowTab ไม่เปิดแท็บใหม่เอง จึงไม่ผิดกติกาเดิม)
  let targetTabId = tabId;
  try {
    await chrome.tabs.get(targetTabId);
  } catch {
    await setStatus('แท็บ Flow เดิมหายไป — ใช้แท็บ Flow ที่เปิดอยู่ปัจจุบันแทน');
    targetTabId = (await flowTab()).id;
  }
  let delivery;
  try {
    delivery = await chrome.tabs.sendMessage(targetTabId, message);
  } catch (error) {
    const detail = String(error?.message || error);
    if (!/Receiving end does not exist|Could not establish connection/i.test(detail)) throw error;
    await setStatus('กำลังติดตั้งตัวบอทลงในแท็บ Flow ที่เปิดค้างอยู่');
    await chrome.scripting.executeScript({ target: { tabId: targetTabId }, files: ['content.js'] });
    delivery = await chrome.tabs.sendMessage(targetTabId, message);
  }
  // STOP can arrive while the content script is still unwinding an old task.
  // Retry this checkpoint only after the old task releases its working flag.
  if (delivery?.busy) {
    await chrome.storage.local.remove(['submittedFor', 'jobDispatchAt', 'jobProgressAt']);
    await setStatus(`รอคำสั่งงานเก่ายกเลิกก่อนเริ่มงาน #${message.jobId}`);
    setTimeout(() => {
      state().then((live) => {
        if (live.running && Number(live.currentJob?.jobId) === Number(message.jobId)) {
          return sendCurrentJob(targetTabId);
        }
      }).catch((error) => emitLog('error', 'dispatch.busy-retry', 'ส่งงานใหม่หลังยกเลิกงานเก่าไม่สำเร็จ', {
        jobId: message.jobId,
        clipIndex: message.clipIndex,
        error,
      }));
    }, 1000);
  }
}

/**
 * เดินงานถัดไปหลังพักครบ — ใช้ร่วมกันทุกจุดที่ตั้งเวลาไว้
 *
 * ⚠️ ต้องดัก error ให้หมดในนี้ ห้ามปล่อยให้ callback ของ setTimeout reject
 * MV3 service worker ไม่มีใครรับ unhandled rejection ต่อ → บอทหยุดเงียบสนิท
 * ไม่มีข้อความบนหน้าจอ ไล่หาสาเหตุแทบไม่ได้ (อาการ "กด Start แล้วนิ่ง")
 * heartbeat ทุก 15 วิยังกู้ให้ได้อยู่ แต่ต้องเห็นสาเหตุบนหน้าจอด้วย
 */
/**
 * Recover a backend reservation that has never been delivered to Flow.
 *
 * `currentJob` proves the reservation exists. A matching `submittedFor` proves
 * this exact stage was already handed to the content script, so it remains the
 * duplicate-credit guard and is never cleared here.
 */
async function resumeUndispatchedCurrentJob(current, reason) {
  if (!current.running || current.creditLocked || !current.currentJob) return false;
  if (['awaitingVideo', 'awaitingImage', 'cooldown'].includes(current.currentJob.phase)) return false;
  const expectedKey = jobDispatchKey(current.currentJob);
  if (!expectedKey) return false;
  const saved = await chrome.storage.local.get('submittedFor');
  if (saved.submittedFor === expectedKey) return false;
  const tab = await flowTab();
  if (!tab?.id) return false;
  await setStatus(`งาน #${current.currentJob.jobId}: จองงานไว้แล้วแต่ยังไม่เคยส่งเข้า Flow — กำลังทำต่ออัตโนมัติ`);
  await emitLog('warn', 'dispatch.reserved-job-resume', 'กู้การจองงานที่ยังไม่เคยส่งเข้าแท็บ Flow', {
    jobId: current.currentJob.jobId,
    clipIndex: current.currentJob.clipIndex,
    meta: {
      reason,
      expectedKey,
      submittedFor: saved.submittedFor || null,
    },
  });
  await sendCurrentJob(tab.id);
  return true;
}

async function resumeAfterCooldown(expectedCooldownUntil) {
  try {
    const live = await state();
    if (!live.running || live.creditLocked || live.currentJob) return;
    if (Number(live.nextJobCooldownUntil || 0) !== expectedCooldownUntil) return;
    await chrome.storage.local.remove('nextJobCooldownUntil');
    await runNext();
  } catch (error) {
    console.error('[ClipBot] resumeAfterCooldown failed', error);
    try {
      await setStatus(`เริ่มงานถัดไปไม่สำเร็จ: ${String(error?.message || error)} — heartbeat จะลองใหม่`);
    } catch (_) { /* ถ้า setStatus เองก็พัง ปล่อยให้ heartbeat จัดการ */ }
  }
}

async function runNext() {
  if (loopBusy) return;
  loopBusy = true;
  try {
    const current = await state();
    if (!current.running || current.creditLocked) return;

    // ห้าม return เงียบๆ ตรงนี้เด็ดขาด — ถ้ามีงานค้างต้องบอกให้เห็นบนหน้าจอ
    // ไม่งั้นอาการจะออกมาเป็น "กด Start แล้วบอทนิ่งสนิท ไม่มี error ไม่มีอะไรเลย"
    // ซึ่งหาสาเหตุแทบไม่ได้ถ้าไม่ไปไล่อ่าน chrome.storage
    if (current.currentJob) {
      if (await resumeUndispatchedCurrentJob(current, 'runNext')) return;
      await setStatus(
        `มีงาน #${current.currentJob.jobId} ค้างอยู่ — กดหยุด หรือ reload Extension เพื่อล้างก่อนเริ่มใหม่`
      );
      return;
    }

    await setStatus(`Gemini กำลังเลือกภาพและวางแผน ${current.durationSeconds === 16 ? 2 : 3} คลิป`);
    let result = await api('/api/extension/jobs/claim', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ creditUnlocked: true }),
    });
    if (!result.job) {
      // รัน 24 ชม.: คิวว่าง → สร้างงานใหม่อัตโนมัติจากสินค้าที่มี แล้ว claim ต่อทันที
      // (หมดคูลดาวรอบสุดท้ายแล้วไม่นิ่ง — สร้างคลิปใหม่ต่อเนื่อง จนกว่าจะกดหยุด/ล็อกเครดิต)
      await setStatus('คิวว่าง — สร้างงานใหม่อัตโนมัติ (โหมดรัน 24 ชม.)');
      try {
        await ensureQueuedJob(0, current.durationSeconds);
        result = await api('/api/extension/jobs/claim', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ creditUnlocked: true }),
        });
      } catch (autoError) {
        console.warn('[ClipBot] auto-create job (24h) failed', autoError);
      }
      if (!result.job) {
        await setStatus('ยังไม่มีสินค้าให้สร้างงานใหม่ — รอเก็บรีวิวเพิ่มก่อนจะรันต่อ');
        return;
      }
    }
    if (!['image', 'video'].includes(result.job.stage)) {
      throw new Error('Web App เวอร์ชันเก่าส่งงานโดยไม่มี stage — หยุดก่อนเพื่อไม่ให้ข้ามการสร้างรูป');
    }
    await setStatus(`กำลังเปิด Flow สำหรับงาน #${result.job.jobId}`, { currentJob: result.job });
    const tab = await flowTab();
    if (!tab.id) throw new Error('เปิดแท็บ Flow ไม่สำเร็จ');
    if (tab.status === 'complete') await sendCurrentJob(tab.id);
  } catch (error) {
    console.error('[ClipBot] runNext failed', error);
    // ถ้าจองงานไปแล้วค่อยพัง ต้องปล่อยงานคืนด้วย (failCurrent เคลียร์ currentJob ให้)
    //
    // ห้ามแค่ setStatus({running:false}) เฉยๆ เพราะ currentJob จะค้างใน storage
    // แล้วรอบหน้า runNext จะ return ทันทีที่บรรทัด `if (... || current.currentJob)`
    // → กด Start แล้ว "ไม่มีอะไรเกิดขึ้น" แบบหาสาเหตุไม่เจอ ต้องล้าง storage เองถึงหาย
    const stuck = await state();
    if (stuck.currentJob) {
      await failCurrent(error.message);
    } else {
      await setStatus(`หยุดเพื่อความปลอดภัย: ${error.message}`, { running: false });
    }
  } finally {
    loopBusy = false;
  }
}

/**
 * รอวิดีโอใหม่จากฝั่ง background — ห้ามให้ content script เป็นคนรอ
 *
 * เหตุผล: Flow re-render หน้าตอนเจนเสร็จ → content script ถูกทำลาย → คลิปหาย
 * background poll ผ่าน chrome.scripting.executeScript แทน ซึ่งอยู่รอดข้ามการ re-render
 * (ถ้า service worker ถูกฆ่า heartbeat จะปลุกกลับมา แล้ว watchForClip ถูกเรียกใหม่จาก storage)
 */
function mediaKey(url) {
  try {
    const parsed = new URL(url);
    return parsed.searchParams.get('name') || parsed.href;
  } catch (_) {
    return String(url || '');
  }
}

function watchKey(jobId, clipIndex, mediaType = 'video') {
  return `${jobId}:${mediaType}:${clipIndex}`;
}

function startClipWatch(tabId, jobId, clipIndex, before, deadlineAt, mediaType = 'video') {
  const key = watchKey(jobId, clipIndex, mediaType);
  if (activeWatches.has(key)) return false;
  activeWatches.add(key);
  watchForClip(tabId, jobId, clipIndex, before, deadlineAt, mediaType)
    .catch(async (error) => {
      const live = await state();
      if (live.currentJob?.jobId === jobId && live.currentJob?.clipIndex === clipIndex) {
        await failCurrent(error.message);
      }
    })
    .catch((error) => console.error('[ClipBot] watch recovery failed', error))
    .finally(() => activeWatches.delete(key));
  return true;
}

async function resumeCurrentWatch(current) {
  const job = current.currentJob;
  if (!current.running || !job || !['awaitingVideo', 'awaitingImage'].includes(job.phase)) return false;
  const tabs = await chrome.tabs.query({ url: 'https://labs.google/*' });
  const tab = tabs.find((candidate) => candidate.active && /\/tools\/flow|\/flow\/project/.test(candidate.url || ''))
    || tabs.find((candidate) => /\/tools\/flow|\/flow\/project/.test(candidate.url || ''));
  if (!tab?.id) {
    await failCurrent('แท็บ Google Flow ถูกปิดระหว่างรอผล — หยุดเพื่อไม่ให้สร้างซ้ำ');
    return false;
  }
  return startClipWatch(
    tab.id,
    job.jobId,
    job.clipIndex,
    Array.isArray(job.watchBefore) ? job.watchBefore : [],
    Number(job.watchDeadline || 0),
    job.phase === 'awaitingImage' ? 'image' : 'video'
  );
}

async function watchForClip(tabId, jobId, clipIndex, before, deadlineAt = 0, mediaType = 'video') {
  const current = await state();
  const known = new Set([
    ...(before || []),
    ...(current.currentJob?.clipUrls || []),
  ].map(mediaKey).filter(Boolean));
  // The deadline is persisted before Generate is clicked. Recreating an MV3
  // service worker must not silently grant another 15-minute wait window.
  const storedDeadline = Number(deadlineAt || current.currentJob?.watchDeadline || 0);
  const deadline = Number.isFinite(storedDeadline) && storedDeadline > 0
    ? storedDeadline
    : Date.now() + FLOW_VIDEO_TIMEOUT_MS;
  let crashReloads = 0;
  // Persist this on the job: Chrome may suspend/restart the MV3 service worker
  // while Flow is generating. A local-only counter would reset and could retry
  // indefinitely across worker restarts.
  let failedCardRetries = Number(current.currentJob?.failedCardRetries || 0);
  const watchStartedAt = Number(current.currentJob?.watchStartedAt || Date.now());
  const acceptMediaAfter = mediaType === 'image' ? watchStartedAt + 12000 : 0;
  // Flow can briefly render a failed placeholder while the image request is
  // still finishing on the server. Job #32 proved that a valid generated image
  // may appear after that placeholder. Give image generation time to settle;
  // fresh media always wins over the transient failure card.
  const failedCardGraceUntil = watchStartedAt + 120000;
  let transientFailureLogged = false;
  // Flow virtualizes project cards. An old failed card can therefore appear
  // as a "new" DOM node after Generate. Associate a failure with this request
  // only after its own queued/generating/processing state has been observed.
  let currentGenerationObserved = false;

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 4000));

    // ผู้ใช้อาจกดหยุด/ล็อกระหว่างรอ ต้องหยุดตัวเฝ้าทันที
    const live = await state();
    if (!live.running || live.currentJob?.jobId !== jobId) return;

    let found = null;
    try {
      const [result] = await chrome.scripting.executeScript({
        target: { tabId },
        func: (allowFailedCardRetry, knownKeys, failedBefore, expectedMediaType) => {
          const candidates = new Map();
          // Never accept IMG thumbnails as finished clips. Flow renders the
          // thumbnail before the video element; accepting it early previously
          // downloaded a .jpg under an .mp4 job and lost the paid result.
          const nodes = document.querySelectorAll(
            expectedMediaType === 'image' ? 'img[src*="getMediaUrlRedirect"]' : 'video,source'
          );
          for (const node of nodes) {
            const raw = node.currentSrc || node.getAttribute('src') || '';
            if (!raw) continue;
            let url;
            try { url = new URL(raw, location.href).href; } catch (_) { continue; }
            const card = node.closest('a,button,[role="button"]') || node.parentElement;
            const label = [
              card?.textContent,
              card?.getAttribute?.('aria-label'),
              node.getAttribute?.('aria-label'),
              node.getAttribute?.('alt'),
            ].filter(Boolean).join(' ');
            const isVideo = /^(VIDEO|SOURCE)$/.test(node.tagName)
              || Boolean(card?.querySelector?.('video,source'))
              || /play_circle|videocam|video|วิดีโอ/i.test(label);
            if (expectedMediaType === 'video' && !isVideo) continue;
            if (expectedMediaType === 'image') {
              if (node.tagName !== 'IMG') continue;
              if (node.naturalWidth && node.naturalWidth < 128) continue;
              if (node.naturalHeight && node.naturalHeight < 128) continue;
            }
            let key = url;
            try { key = new URL(url).searchParams.get('name') || url; } catch (_) {}
            const priority = /^(VIDEO|SOURCE)$/.test(node.tagName)
              ? 3
              : /mediaUrlType=MEDIA_URL_TYPE_THUMBNAIL/i.test(url)
                ? 1
                : 2;
            const previous = candidates.get(key);
            const generated = expectedMediaType === 'image'
              && /รูปภาพที่สร้างขึ้น|generated image|image generated/i.test(label);
            if (!previous || priority > previous.priority || generated) {
              candidates.set(key, { key, url, priority, generated });
            }
          }
          // Flow shows a failed-generation card with three actions:
          // refresh/try again, reuse prompt, delete. Only click the explicit
          // "try again" child button; never the enclosing card or other refresh controls.
          const knownMedia = new Set(knownKeys || []);
          const pendingGeneration = [...document.querySelectorAll('[role="button"]')]
            .filter((element) => element.getClientRects().length > 0)
            .some((element) => {
              const label = [element.textContent, element.getAttribute('aria-label'), element.getAttribute('title')]
                .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
              return /(?:อยู่ในคิว|queued|กำลังสร้าง|generating|processing)/i.test(label)
                && label.length < 1200;
            });
          const hasFreshExpectedMedia = [...candidates.values()].some((candidate) =>
            !knownMedia.has(candidate.key)
            && (expectedMediaType !== 'image' || candidate.generated)
          );
          const failedCards = [...document.querySelectorAll('[role="button"]')]
            .filter((element) => element.getClientRects().length > 0)
            .filter((element) => {
              const label = [element.textContent, element.getAttribute('aria-label'), element.getAttribute('title')]
                .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
              return /(?:warning.*(?:ล้มเหลว|failed)|(?:ล้มเหลว|failed).*warning)/i.test(label)
                && label.length < 600;
            });
          // Ignore failure cards that were already on the page before this
          // generation. Pick the newest card only, and never retry after a new
          // video is already available.
          const hasNewFailedCard = failedCards.length > Number(failedBefore || 0);
          const failedCard = hasNewFailedCard ? failedCards[failedCards.length - 1] : null;
          // Only a newly-created failed card may block the active request.
          // Old failure cards remain in Flow projects and must not poison a
          // later generation merely because their text is still on the page.
          const failedCardText = failedCard
            ? [failedCard.textContent, failedCard.getAttribute('aria-label'), failedCard.getAttribute('title')]
              .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()
            : '';
          const unusualActivity = Boolean(failedCard) &&
            /(?:กิจกรรมที่ผิดปกติ|กิจกรรมผิดปกติ|unusual activity|suspicious activity|abnormal activity)/i.test(failedCardText);
          let retryButton = null;
          if (failedCard && !hasFreshExpectedMedia) {
            const cardRect = failedCard.getBoundingClientRect();
            // Flow sometimes portals the three action controls outside the
            // failed-card DOM subtree. Use visual containment as well as DOM
            // containment so the icon-only refresh control is still found.
            const actions = [...document.querySelectorAll('button,[role="button"]')]
              .filter((element) => {
                if (element === failedCard || element.getClientRects().length === 0) return false;
                const rect = element.getBoundingClientRect();
                const centerX = rect.left + rect.width / 2;
                const centerY = rect.top + rect.height / 2;
                return failedCard.contains(element)
                  || (centerX >= cardRect.left && centerX <= cardRect.right
                    && centerY >= cardRect.top && centerY <= cardRect.bottom);
              })
              .map((element) => ({
                element,
                label: [element.textContent, element.getAttribute('aria-label'), element.getAttribute('title')]
                  .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim(),
              }));
            retryButton = actions.find(({ label }) =>
              /(?:refresh|restart_alt|ลองอีกครั้ง|ลองใหม่|Try again|Retry)/i.test(label)
            )?.element || null;
            if (!retryButton) {
              const unlabeled = actions.filter(({ label }) => !label);
              if (unlabeled.length === 1) retryButton = unlabeled[0].element;
            }
          }
          let retryPoint = null;
          if (retryButton && allowFailedCardRetry && !unusualActivity) {
            const rect = retryButton.getBoundingClientRect();
            retryPoint = {
              x: rect.left + rect.width / 2,
              y: rect.top + rect.height / 2,
            };
          }
          return {
            candidates: [...candidates.values()],
            failedCard: Boolean(failedCard),
            pendingGeneration,
            retryPoint,
            retriedFailedCard: false,
            unusualActivity,
            crashed: /Application error:\s*a client-side exception has occurred|client-side exception has occurred while loading labs\.google/i
              .test(document.body?.innerText || ''),
            alert: [...document.querySelectorAll('[role="alert"]')]
              .map((a) => (a.textContent || '').trim())
              // Flow always renders a hidden accessibility alert containing the page title.
              // It is not an error and must not abort a paid generation.
              .find((t) => t && !/^Google Flow\s*-/i.test(t)) || null,
          };
        },
        args: [
          true, // Retry only the explicit failed-card action; unusual activity is excluded above.
          [...known].slice(-500),
          Number(current.currentJob?.watchFailedBefore || 0),
          mediaType,
        ],
      });
      const data = result?.result;
      if (data?.pendingGeneration) currentGenerationObserved = true;
      const currentFailedCard = Boolean(currentGenerationObserved && data?.failedCard);
      if (data?.crashed) {
        if (crashReloads >= 2) {
          throw new Error('Flow crash ซ้ำหลังรีโหลดอัตโนมัติ 2 ครั้ง — หยุดเพื่อกันการทำงานผิดบัญชีหรือ session หมดอายุ');
        }
        crashReloads += 1;
        await setStatus(`Flow crash ระหว่างรอคลิป — รีโหลดอัตโนมัติครั้งที่ ${crashReloads} (ไม่กดสร้างซ้ำ)`);
        await emitLog('warn', 'flow.crash-recovery', 'พบหน้า Application error และรีโหลดโปรเจกต์เดิม', {
          jobId,
          clipIndex,
          meta: { attempt: crashReloads },
        });
        await chrome.tabs.reload(tabId);
        // submittedFor ยังอยู่ใน chrome.storage ดังนั้น onUpdated จะไม่ส่ง Generate ซ้ำ
        await new Promise((resolve) => setTimeout(resolve, 7000));
        continue;
      }
      if (currentGenerationObserved && data?.unusualActivity) {
        // ─── Recovery Pipeline: กิจกรรมผิดปกติ ───
        // แทนที่จะหยุดทันที ลองแจ้ง backend แล้วรอ cooldown ก่อน
        await emitLog('warn', 'flow.unusual-activity', 'Flow ตรวจพบกิจกรรมผิดปกติ — เริ่ม recovery pipeline', {
          jobId, clipIndex,
        });
        // ลอง dismiss: reload แท็บแล้วรอ cooldown
        try {
          // แจ้ง backend ว่า account นี้โดนแฟลก (ถ้า API พร้อม)
          await fetch(`${(await state()).backendUrl}/api/accounts/flag`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ port: 0, reason: 'unusual-activity-card' }),
          }).catch(() => {});
          // ถาม backend ว่ามี account อื่นว่างไหม
          const nextAccount = await fetch(`${(await state()).backendUrl}/api/accounts/next`)
            .then((r) => r.ok ? r.json() : null)
            .catch(() => null);
          if (nextAccount?.port && nextAccount.port !== 0) {
            // มี account อื่นว่าง → pause งาน + แจ้งให้ใช้ account อื่นแทน
            await setStatus(`กิจกรรมผิดปกติ — สลับไป account port ${nextAccount.port}`, {
              currentJob: { ...(await state()).currentJob, switchToPort: nextAccount.port },
            });
            await emitLog('info', 'flow.account-switch', `สลับจาก account ปัจจุบันไป port ${nextAccount.port}`, {
              jobId, clipIndex, meta: { nextPort: nextAccount.port },
            });
          }
        } catch (recoveryError) {
          await emitLog('warn', 'flow.recovery-failed', 'Recovery pipeline ล้มเหลว — fallback หยุดบอท', {
            jobId, clipIndex, error: recoveryError,
          });
        }
        // ไม่ว่า recovery สำเร็จหรือไม่ ก็ยังต้อง throw เพื่อให้ failCurrent จัดการต่อ
        // แต่ตอนนี้ backend มีข้อมูลแฟลกแล้ว → failCurrent จะลองหา account อื่นได้
        throw new Error('Flow ตรวจพบกิจกรรมผิดปกติ — recovery pipeline ทำงานแล้ว');
      }
      const freshCandidates = (data?.candidates || [])
        .filter((candidate) => !known.has(candidate.key));
      // An uploaded reference can carry the same generic generated-image alt
      // text as real output. Require both a fresh media id and Flow's generated
      // label, then wait briefly for redirect URLs to settle before download.
      found = Date.now() >= acceptMediaAfter
        ? freshCandidates.find((candidate) => mediaType !== 'image' || candidate.generated)?.url || null
        : null;

      // Never let a stale/transient failure card override media that already
      // appeared. Flow uses the same temporary placeholder before both image
      // and video cards settle into queued/processing state, so wait through it
      // before attempting Retry or declaring the job failed.
      if (!found && currentFailedCard && Date.now() < failedCardGraceUntil) {
        if (!transientFailureLogged) {
          transientFailureLogged = true;
          await setStatus(`งาน #${jobId}: Flow แสดงสถานะล้มเหลวชั่วคราว — รอ${mediaType === 'image' ? 'ภาพ' : 'คลิป'}ใหม่อีกไม่เกิน 2 นาที`);
          await emitLog('warn', 'flow.image-failure-grace', 'พบการ์ดล้มเหลวระหว่างที่ภาพใหม่อาจยังประมวลผลอยู่', {
            jobId,
            clipIndex,
            meta: { graceUntil: failedCardGraceUntil },
          });
        }
        continue;
      }
      if (!found && transientFailureLogged && Date.now() >= failedCardGraceUntil
        && !currentFailedCard && !data?.pendingGeneration) {
        throw new Error(`Flow นำการ์ด${mediaType === 'image' ? 'ภาพ' : 'คลิป'}ออกจากคิวโดยไม่มีไฟล์ผลลัพธ์ — หยุดเพื่อกันเครดิตซ้ำ`);
      }
      // A stale failed card can remain beside a newer generation card. As long
      // as Flow explicitly reports queued/generating/processing, keep watching
      // and never Retry or fail the active paid request.
      if (!found && data?.pendingGeneration) continue;
      if (found) {
        // Skip Retry/failure handling below. The generated media is the
        // authoritative outcome even if Flow left a failed placeholder behind.
      } else if (currentFailedCard && data?.retryPoint && FAILED_CARD_RETRY_ENABLED && failedCardRetries < ERROR_RETRY_LIMIT) {
        await clickLikeMouse(tabId, Number(data.retryPoint.x), Number(data.retryPoint.y));
        data.retriedFailedCard = true;
      }
      if (data?.retriedFailedCard) {
        failedCardRetries += 1;
        const latest = await state();
        await setStatus(`Flow สร้างสื่อไม่สำเร็จ — กด "ลองอีกครั้ง" อัตโนมัติ (${failedCardRetries}/${ERROR_RETRY_LIMIT})`, {
          currentJob: latest.currentJob?.jobId === jobId
            ? { ...latest.currentJob, failedCardRetries }
            : latest.currentJob,
        });
        await emitLog('warn', 'flow.generation-retry', 'กดปุ่มลองอีกครั้งบนการ์ดสร้างคลิปล้มเหลว', {
          jobId,
          clipIndex,
          meta: { attempt: failedCardRetries },
        });
        await new Promise((resolve) => setTimeout(resolve, 5000));
        continue;
      }
      if (!found && currentFailedCard) {
        if (!FAILED_CARD_RETRY_ENABLED) {
          throw new Error('Flow สร้างสื่อไม่สำเร็จ — พักตามรอบปกติแล้วค่อยเริ่มงานเดิมใหม่ (ไม่กดลองอีกครั้ง)');
        }
        throw new Error(failedCardRetries >= ERROR_RETRY_LIMIT
          ? `Flow สร้างสื่อล้มเหลวซ้ำหลังจากกด "ลองอีกครั้ง" ${ERROR_RETRY_LIMIT} ครั้ง`
          : 'Flow สร้างสื่อล้มเหลวและไม่พบปุ่มลองอีกครั้งที่กดได้ — หยุดเพื่อป้องกันการกดผิดปุ่ม');
      }
      if (!found && data?.alert) throw new Error(`Flow แจ้ง: ${data.alert}`);
    } catch (error) {
      // แท็บกำลังโหลด/นำทางอยู่ — ลองใหม่รอบหน้า
      if (/Cannot access|No tab|Frame|closed/i.test(String(error?.message))) continue;
      throw error;
    }

    if (found) {
      const elapsed = Math.round((FLOW_VIDEO_TIMEOUT_MS - (deadline - Date.now())) / 1000);
      await setStatus(mediaType === 'image'
        ? `เจอรูปภาพที่สร้างใหม่ใน ${elapsed}s — กำลังบันทึก`
        : `เจอวิดีโอใหม่ใน ${elapsed}s — กำลังบันทึก`);
      if (mediaType === 'image') {
        try {
          await acceptGeneratedImage({ jobId, imageUrl: found, tabId });
        } catch (error) {
          // Flow อาจเปลี่ยน redirect URL ของรูปที่อัปโหลดหลังเริ่ม Generate ทำให้ URL นั้น
          // ดูเหมือน media ใหม่ แม้ bytes ยังเป็นรูปอ้างอิงเดิม (#112) Backend ตรวจด้วย
          // PSNR ได้แม่นกว่า DOM: blacklist candidate นี้แล้วเฝ้าผลจาก Generate เดิมต่อ
          // ห้าม fail/re-dispatch เพราะจะเสี่ยงกด Generate ซ้ำและเสียเครดิตเพิ่ม
          if (isDuplicateReferenceImageError(error)) {
            const rejectedKey = mediaKey(found);
            if (rejectedKey) known.add(rejectedKey);
            await setStatus(`งาน #${jobId}: ข้ามรูปอ้างอิงที่ Flow เปลี่ยน URL — รอรูปที่สร้างจริงต่อ`);
            await emitLog('warn', 'flow.image-reference-skipped', 'Watcher หยิบรูปอ้างอิงที่เพิ่งเปลี่ยน URL — ข้ามแล้วเฝ้าผลเดิมต่อ', {
              jobId,
              clipIndex,
              error,
              meta: { rejectedKey },
            });
            continue;
          }
          throw error;
        }
      } else {
        await acceptClip({ jobId, clipIndex, videoUrl: found, tabId });
      }
      return;
    }
  }
  throw new Error(`ส่งสร้างแล้วแต่ไม่พบ${mediaType === 'image' ? 'รูปภาพ' : 'วิดีโอ'}ใหม่ภายใน 15 นาที — หยุดเพื่อกันเครดิตซ้ำ`);
}

async function acceptGeneratedImage(message) {
  const current = await state();
  if (!current.currentJob || current.currentJob.jobId !== message.jobId) return;
  const imageRole = current.currentJob.imageRole === 'end' ? 'end' : 'start';
  await setStatus(imageRole === 'end'
    ? `Job #${message.jobId}: saving generated end frame`
    : `Job #${message.jobId}: saving generated hand-held product image`);
  const outcome = await downloadAndImportGeneratedImage(
    message.imageUrl, current.backendUrl, message.jobId, imageRole
  );
  await chrome.storage.local.remove('submittedFor');
  const pauseMs = randomCooldownMs(current.cooldownMultiplier);
  // job #104: วิธี A แนบรูปมุมเสริมเข้าช่องพรอมต์ตอนเจนรูป และรูปพวกนั้น "ค้างอยู่ในโปรเจกต์"
  // พอสลับเป็นโหมดวิดีโอในโปรเจกต์เดิม ช่อง Start frame หาไม่เจอ → ล้มทั้งงานทั้งที่เพิ่งจ่าย
  // เครดิตรูปไป → ขึ้นโปรเจกต์ใหม่ให้สะอาดก่อนเจนคลิป
  // ต้องพกธงต่อ เพราะถ้าเปิด End frame จะมีขั้น image→image คั่น แล้ว job ขั้นนั้นไม่มี
  // referenceImagePaths ติดมา ทำให้เช็คตรงๆ ไม่เจอ ทั้งที่รูปยังค้างในโปรเจกต์เดิม
  const usedExtraReferences = current.currentJob.usedExtraReferences === true
    || (Array.isArray(current.currentJob.referenceImagePaths)
      && current.currentJob.referenceImagePaths.length > 0);
  const nextJob = {
    ...outcome.data,
    usedExtraReferences,
    projectReady: !(usedExtraReferences && outcome.data.stage === 'video'),
    recoveryStage: Number(current.currentJob.recoveryStage || 0),
    failedCardRetries: 0,
    mediaLibraryRetries: 0,
    phase: 'cooldown',
    cooldownUntil: Date.now() + pauseMs,
    cooldownReason: 'normal',
    watchBefore: null,
    watchStartedAt: null,
    watchDeadline: null,
    watchFailedBefore: null,
  };
  const nextTarget = outcome.data.stage === 'image'
    ? 'end frame'
    : `clip 1/${nextJob.clipCount}`;
  await setStatus(
    `Generated ${imageRole} image saved (${Math.round(outcome.size / 1024)} KB) — cooldown before ${nextTarget}`,
    { currentJob: nextJob }
  );
  if (message.tabId) {
    setTimeout(() => sendCurrentJob(message.tabId).catch((error) => failCurrent(error.message)), pauseMs + 50);
  }
}

async function acceptClip(message) {
  const current = await state();
  if (!current.currentJob || current.currentJob.jobId !== message.jobId) return;
  const clipCount = Number(current.currentJob.clipCount || 3);
  await setStatus(`กำลังบันทึกคลิป ${message.clipIndex + 1} จาก ${clipCount}`);

  // ใช้ Chrome Downloads แทน fetch(): ตัวจัดการดาวน์โหลดของ Chrome ตาม redirect
  // และใช้ session cookie ได้โดยไม่ติด CORS แบบ JavaScript fetch
  const outcome = await downloadAndImportClip(
    message.videoUrl, current.backendUrl, message.jobId, message.clipIndex
  );
  await setStatus(`บันทึกคลิป ${message.clipIndex + 1} แล้ว (${Math.round(outcome.size / 1024)} KB)`);
  const result = outcome.data;

  if (result.done) {
    await setStatus(`กำลังประกอบวิดีโองาน #${message.jobId}`);
    await api(`/api/extension/jobs/${message.jobId}/finish`, { method: 'POST' });
    await chrome.storage.local.remove('submittedFor');
    await chrome.storage.local.set({ fidelityFailStreak: 0 }); // งานสำเร็จ → รีเซ็ตตัวนับ fidelity
    const pauseMs = randomNextJobCooldownMs(current.cooldownMultiplier); // ข้ามไปงานใหม่ = พักยาว
    const nextJobCooldownUntil = Date.now() + pauseMs;
    await setStatus(`งาน #${message.jobId} เสร็จแล้ว — พักสุ่ม ${Math.round(pauseMs / 60000)} นาที ก่อนงานถัดไป`, {
      currentJob: null,
      nextJobCooldownUntil,
    });
    setTimeout(() => { resumeAfterCooldown(nextJobCooldownUntil); }, pauseMs + 50);
    return;
  }

  const pauseMs = randomCooldownMs(current.cooldownMultiplier);
  const nextJob = {
    ...current.currentJob,
    stage: 'video',
    clipIndex: message.clipIndex + 1,
    forceNewProject: message.clipIndex === 0 && Boolean(current.currentJob.endImagePath),
    imagePath: result.imagePath,
    prompt: result.prompt,
    failedCardRetries: 0,
    mediaLibraryRetries: 0,
    phase: 'cooldown',
    cooldownUntil: Date.now() + pauseMs,
    cooldownReason: 'normal',
    watchBefore: null,
    watchStartedAt: null,
    watchDeadline: null,
    watchFailedBefore: null,
  };
  await setStatus(`คลิป ${message.clipIndex + 1} เสร็จ — พักสุ่ม ${Math.round(pauseMs / 60000)} นาที ก่อนเตรียมคลิป ${nextJob.clipIndex + 1} จาก ${clipCount}`, { currentJob: nextJob });
  if (message.tabId) setTimeout(() => sendCurrentJob(message.tabId).catch((error) => failCurrent(error.message)), pauseMs + 50);
}

/**
 * Backend ปฏิเสธเพราะรูปที่ watcher หยิบมาคือ "รูปอ้างอิงที่เราอัปเอง" ไม่ใช่ผลจาก Generate
 *
 * ตรวจด้วย PSNR ฝั่ง backend (>= 40 = แทบเหมือนกันทุกพิกเซล) แม่นกว่าดูจาก DOM
 * เจอเมื่อ Flow เปลี่ยน redirect URL ของรูปที่อัปโหลดหลังกด Generate (job #112)
 */
function isDuplicateReferenceImageError(error) {
  const message = String(error?.message || error || '');
  return /returned the uploaded reference image|returned the unchanged start frame/i.test(message);
}

function isMediaLibraryTimeout(message) {
  // "content script รุ่นเก่า" ก็อยู่กลุ่มเดียวกัน: เกิดก่อนกด Generate ทั้งคู่ จึงยังไม่มี
  // เครดิตค้าง และแก้ได้ด้วยการรีโหลดแท็บแล้วสั่งงานเดิมซ้ำจาก checkpoint เดิม
  // ไม่ควรโดนลงโทษพัก 20 นาทีเหมือน error ที่แก้เองไม่ได้ (job #109)
  return /รูปขึ้นคลังสื่อ|ปุ่มเพิ่มไปยังพรอมต์.*(?:เฟรม|frame)|คลังสื่อปิดหลังเพิ่ม|รูปปรากฏในช่อง (?:Start|End) frame|content script รุ่นเก่าค้างในแท็บ/i
    .test(String(message || ''));
}

/**
 * Retry a flaky Flow media picker only before a paid Generate click.
 * Reloading kills the stale content task; tabs.onUpdated then dispatches the
 * same persisted job and local checkpoint instead of generating a duplicate.
 */
async function recoverMediaLibraryTimeout(message) {
  if (!isMediaLibraryTimeout(message)) return false;
  const current = await state();
  const job = current.currentJob;
  if (!current.running || !job || ['awaitingImage', 'awaitingVideo'].includes(job.phase)) {
    return false;
  }
  const retries = Number(job.mediaLibraryRetries || 0);
  if (retries >= MEDIA_LIBRARY_RETRY_LIMIT) return false;

  let tab;
  try {
    tab = await flowTab();
  } catch (_) {
    return false;
  }

  const nextAttempt = retries + 1;
  const recoveryJob = {
    ...job,
    phase: 'preparing',
    forceNewProject: true,
    mediaLibraryRetries: nextAttempt,
    watchBefore: null,
    watchStartedAt: null,
    watchDeadline: null,
    watchFailedBefore: null,
  };
  await chrome.storage.local.remove(['submittedFor', 'jobDispatchAt', 'jobProgressAt']);
  await setStatus(
    `คลังสื่อ Flow timeout — กู้จากไฟล์เดิม (${nextAttempt}/${MEDIA_LIBRARY_RETRY_LIMIT}) โดยยังไม่กด Generate`,
    { currentJob: recoveryJob }
  );
  await emitLog('warn', 'media-library.recovery', 'โหลดคลังสื่อใหม่และใช้ไฟล์ checkpoint เดิม', {
    jobId: job.jobId,
    clipIndex: job.clipIndex,
    meta: { attempt: nextAttempt, limit: MEDIA_LIBRARY_RETRY_LIMIT, message: String(message || '') },
  });
  await chrome.tabs.sendMessage(tab.id, { type: 'FLOW_CANCEL' }).catch(() => {});
  await chrome.tabs.reload(tab.id);
  return true;
}

async function failCurrent(message) {
  const providerBlocked = /กิจกรรมผิดปกติ|unusual activity/i.test(String(message || ''));
  const fidelityBlocked = /PRODUCT_FIDELITY_BLOCK/i.test(String(message || ''));
  console.error(providerBlocked
    ? '[ClipBot] job paused by provider'
    : fidelityBlocked
      ? '[ClipBot] product fidelity gate blocked video generation'
      : '[ClipBot] job failed', message);
  const current = await state();
  await emitLog(providerBlocked ? 'warn' : 'error', providerBlocked ? 'job.paused' : 'job.failed', message, {
    jobId: current.currentJob?.jobId,
    clipIndex: current.currentJob?.clipIndex,
  });
  if (providerBlocked && current.currentJob?.jobId) {
    try {
      await api(`/api/extension/jobs/${current.currentJob.jobId}/pause`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
      });
    } catch (_) {}
  }
  await chrome.storage.local.remove('submittedFor');
  if (fidelityBlocked) {
    // ภาพที่ Flow เจนไม่ตรงสินค้า = ปัญหา "คุณภาพการเจน" ไม่ใช่คำสั่งห้ามจากแพลตฟอร์ม
    // เดิมล็อกเครดิต + หยุดบอท → ต้องมีคนมาปลดล็อกทุกครั้ง ทำให้รัน 24 ชม. ไม่ได้จริง
    // เปลี่ยนเป็น: ทิ้งงานนี้แล้วไปงานถัดไปอัตโนมัติ
    // — ยังกันเครดิตวิดีโอเหมือนเดิม เพราะไม่เจนคลิปต่อจากภาพที่เพี้ยน
    // — provider block (กิจกรรมผิดปกติ) ยังล็อกเหมือนเดิม เพราะนั่นคือแพลตฟอร์มสั่งหยุด
    if (current.currentJob?.jobId) {
      try {
        await api(`/api/extension/jobs/${current.currentJob.jobId}/fail`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message }),
        });
      } catch (_) {}
    }
    // Safety กันวนเผาเครดิต: ถ้า fidelity บล็อกติดกันหลายงาน = มีปัญหาเชิงระบบ
    // (prompt/รูปอ้างอิง/Flow เพี้ยน) การข้ามไปเรื่อยๆ = เจนภาพทิ้งไปเรื่อยๆ เสียเครดิต
    // → เกินเพดานให้หยุด+ล็อก เรียกคนมาดู แทนที่จะวนไม่รู้จบ
    const { fidelityFailStreak = 0 } = await chrome.storage.local.get('fidelityFailStreak');
    const streak = Number(fidelityFailStreak) + 1;
    await chrome.storage.local.set({ fidelityFailStreak: streak });
    if (streak >= FIDELITY_FAIL_STREAK_LIMIT) {
      await chrome.storage.local.set({ fidelityFailStreak: 0 });
      await setStatus(
        `ภาพไม่ตรงสินค้าติดกัน ${streak} งาน — หยุดเพื่อกันเผาเครดิต (ตรวจ prompt/รูปอ้างอิง/Flow)`,
        { running: false, creditLocked: true, currentJob: null }
      );
      return;
    }
    const pauseMs = randomNextJobCooldownMs(current.cooldownMultiplier); // ข้ามไปงานใหม่ = พักยาว
    const nextJobCooldownUntil = Date.now() + pauseMs;
    await setStatus(
      `ภาพที่สร้างไม่ตรงสินค้าต้นฉบับ — ข้ามงานนี้ (${streak}/${FIDELITY_FAIL_STREAK_LIMIT}) ไปงานถัดไปใน ${Math.round(pauseMs / 60000)} นาที`,
      { running: true, creditLocked: false, currentJob: null, nextJobCooldownUntil }
    );
    setTimeout(() => { resumeAfterCooldown(nextJobCooldownUntil); }, pauseMs + 50);
    return;
  }
  if (providerBlocked) {
    // ─── Recovery: ลองหา account อื่นก่อนหยุดบอท ───
    let recovered = false;
    try {
      const nextAccount = await fetch(`${current.backendUrl}/api/accounts/next`)
        .then((r) => r.ok ? r.json() : null)
        .catch(() => null);
      if (nextAccount?.port) {
        // มี account ว่าง → พัก 5-15 นาทีแล้วลองด้วย account ใหม่
        const recoveryPauseMs = 5 * 60 * 1000 + Math.floor(Math.random() * 10 * 60 * 1000);
        const cooldownUntil = Date.now() + recoveryPauseMs;
        await emitLog('info', 'job.provider-recovery', `กิจกรรมผิดปกติ — พัก ${Math.round(recoveryPauseMs / 60000)} นาทีแล้วลองด้วย account port ${nextAccount.port}`, {
          jobId: current.currentJob?.jobId,
          meta: { nextPort: nextAccount.port, cooldownUntil },
        });
        await setStatus(`กิจกรรมผิดปกติ — พัก ${Math.round(recoveryPauseMs / 60000)} นาทีแล้วลอง account อื่น`, {
          running: true,
          creditLocked: false,
          currentJob: null,
          nextJobCooldownUntil: cooldownUntil,
          cooldownMultiplier: 2,
        });
        setTimeout(async () => {
          const live = await state();
          if (live.running && !live.creditLocked && !live.currentJob
            && Number(live.nextJobCooldownUntil || 0) === cooldownUntil) {
            await chrome.storage.local.remove('nextJobCooldownUntil');
            await runNext();
          }
        }, recoveryPauseMs + 50);
        recovered = true;
      }
    } catch (recoveryError) {
      await emitLog('warn', 'job.provider-recovery-failed', 'ลอง recovery จากกิจกรรมผิดปกติไม่สำเร็จ', {
        jobId: current.currentJob?.jobId,
        error: recoveryError,
      });
    }
    if (!recovered) {
      // ไม่มี account อื่น หรือ recovery ล้มเหลว → หยุดเหมือนเดิม (safe fallback)
      await setStatus(`Flow ตรวจพบกิจกรรมผิดปกติ — หยุดทันทีและเก็บงานเดิมไว้: ${message}`, {
        running: false,
        creditLocked: true,
        currentJob: null,
      });
    }
    return;
  }

  if (!current.currentJob?.jobId) {
    await setStatus(`หยุดเพื่อความปลอดภัย: ${message}`, {
      running: false,
      creditLocked: true,
      currentJob: null,
    });
    return;
  }

  // Do not mark a recoverable job failed: keep its paid image/clip checkpoints,
  // pause it in the API, and let the persisted heartbeat resume it later.
  try {
    await api(`/api/extension/jobs/${current.currentJob.jobId}/pause`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    });
  } catch (_) {}

  const previousStage = Number(current.currentJob.recoveryStage || 0);
  const nextDay = previousStage >= 1;
  const pauseMs = nextDay ? NEXT_DAY_RECOVERY_PAUSE_MS : ERROR_RECOVERY_PAUSE_MS;
  const cooldownUntil = Date.now() + pauseMs;
  const recoveryJob = {
    ...current.currentJob,
    phase: 'cooldown',
    cooldownUntil,
    cooldownReason: nextDay ? 'next-day-recovery' : 'error-recovery',
    recoveryStage: nextDay ? 2 : 1,
    resetRecoveryOnResume: nextDay,
    failedCardRetries: 0,
    watchBefore: null,
    watchStartedAt: null,
    watchDeadline: null,
    watchFailedBefore: null,
    lastRecoveryError: String(message || ''),
  };
  await setStatus(
    nextDay
      ? `งาน #${current.currentJob.jobId} ยัง error หลังพัก 20 นาที — พักระบบ 24 ชั่วโมงแล้วเริ่มใหม่อัตโนมัติ`
      : `งาน #${current.currentJob.jobId} error — พัก 20 นาทีแล้วเริ่มใหม่อัตโนมัติ (คูลดาวถัดไป ${NORMAL_COOLDOWN_MIN_MS / 30000}–${NORMAL_COOLDOWN_MAX_MS / 30000} นาที)`,
    {
      running: true,
      creditLocked: false,
      cooldownMultiplier: 2,
      currentJob: recoveryJob,
    }
  );
  await emitLog('warn', nextDay ? 'job.recovery-next-day' : 'job.recovery-20m', 'ตั้งเวลารันงานเดิมอัตโนมัติหลัง error', {
    jobId: current.currentJob.jobId,
    clipIndex: current.currentJob.clipIndex,
    meta: { cooldownUntil, pauseMs, recoveryStage: recoveryJob.recoveryStage },
  });
}

chrome.runtime.onInstalled.addListener(() => {
  void (async () => {
    const current = await state();
    // MV3 can reload the service worker while a persisted cooldown is active.
    // Keep the paid checkpoint/currentJob so the heartbeat can resume it instead
    // of orphaning the DB row in generating_videos.
    await chrome.storage.local.set({ backendUrl: DEFAULT_API });
    chrome.alarms.create('clipbot-heartbeat', { periodInMinutes: 0.25 });
    // อัป extension แล้ว background เป็นโค้ดใหม่ แต่แท็บ Flow ที่เปิดค้างยังรัน content.js
    // ตัวเก่าจนกว่าหน้าจะถูกโหลดใหม่ → คนละสัญญากัน (job #109 ตายเพราะเรื่องนี้)
    //
    // ⚠️ รีโหลดได้เฉพาะตอน "ไม่มีงานค้าง" เท่านั้น — job #111: รีโหลดทั้งที่มีงานอยู่
    // ทำให้ onUpdated ยิง sendCurrentJob ซ้ำ แล้วเจนรูปเดิมอีกรอบ = เผาเครดิตฟรี
    if (!current.currentJob) {
      try {
        const flowTabs = await chrome.tabs.query({ url: 'https://labs.google/*' });
        await Promise.allSettled(flowTabs
          .filter((tab) => tab.id && /\/tools\/flow|\/flow\/project/.test(tab.url || ''))
          .map((tab) => chrome.tabs.reload(tab.id)));
      } catch (_) { /* ไม่มีสิทธิ์/ไม่มีแท็บ ก็ปล่อยให้ตัวดักตอน TYPE_PROMPT จัดการแทน */ }
    }
    if (!current.running || !current.currentJob) {
      await chrome.storage.local.set({
        running: false,
        creditLocked: true,
        currentJob: null,
        submittedFor: null,
      });
    }

    // ⛔ ห้ามใส่ลูปรีโหลดแท็บ Flow เพิ่มตรงนี้อีก
    //
    // เคยมีบล็อก `for (const tab of tabs) chrome.tabs.reload(...)` ซ้ำอยู่ตรงนี้แบบ
    // "ไม่มีเงื่อนไข" ซึ่งลบล้างตัวกัน `if (!current.currentJob)` ด้านบนทั้งดุ้น
    // job #122: ผู้ใช้ reload extension ตอนงานกำลังเดิน → บล็อกนี้รีโหลดแท็บทับ
    // ระหว่างที่ content script รอหน้าโปรเจกต์ใหม่ → "รอหน้าจอ Flow นานเกินกำหนด"
    // และเป็นทางเดียวกับที่ job #111 เคยเจนรูปซ้ำจนเสียเครดิตฟรี
    //
    // การรีโหลดแท็บทำไปแล้วด้านบน (เฉพาะตอนไม่มีงานค้าง) ซึ่งถูกต้องแล้ว
  })().catch((error) => emitLog('error', 'runtime.install', 'Extension initialization failed', { error }));
});

chrome.runtime.onStartup.addListener(() => {
  void (async () => {
    chrome.alarms.create('clipbot-heartbeat', { periodInMinutes: 0.25 });
    const current = await state();
    if (current.running && current.currentJob) {
      await setStatus(current.lastStatus);
      return;
    }
    await chrome.storage.local.set({ running: false, currentJob: null, submittedFor: null });
    await setStatus('บอทพร้อมใช้งาน — เปิด Extension เพื่อเริ่ม');
  })().catch((error) => emitLog('error', 'runtime.startup', 'Extension startup recovery failed', { error }));
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'clipbot-heartbeat') return;
  const current = await state();
  await setStatus(current.lastStatus);
  // setStatus can consume a remote lock/stop/reload command. Re-read storage;
  // using the stale pre-command state could restart work after it was stopped.
  const live = await state();
  if (live.running && live.currentJob?.phase === 'cooldown') {
    if (Number(live.currentJob.cooldownUntil || 0) <= Date.now()) {
      const tabs = await chrome.tabs.query({ url: 'https://labs.google/*' });
      const tab = tabs.find((candidate) => /\/tools\/flow|\/flow\/project/.test(candidate.url || ''));
      if (tab?.id) {
        const resetRecovery = live.currentJob.resetRecoveryOnResume === true;
        await chrome.storage.local.set({
          currentJob: {
            ...live.currentJob,
            phase: 'preparing',
            cooldownUntil: null,
            cooldownReason: null,
            recoveryStage: resetRecovery ? 0 : Number(live.currentJob.recoveryStage || 0),
            resetRecoveryOnResume: false,
          },
          ...(resetRecovery ? { cooldownMultiplier: 1 } : {}),
        });
        await chrome.storage.local.remove('submittedFor');
        await sendCurrentJob(tab.id);
      }
    }
  } else if (live.running && ['awaitingVideo', 'awaitingImage'].includes(live.currentJob?.phase)) {
    await resumeCurrentWatch(live);
  } else if (live.running && live.currentJob) {
    if (await resumeUndispatchedCurrentJob(live, 'heartbeat')) return;
    const recovery = await chrome.storage.local.get(['submittedFor', 'jobDispatchAt', 'jobProgressAt']);
    const lastActivity = Math.max(
      Number(recovery.jobDispatchAt || 0),
      Number(recovery.jobProgressAt || 0)
    );
    if (recovery.submittedFor && lastActivity > 0
      && Date.now() - lastActivity >= PRE_SUBMIT_STALL_TIMEOUT_MS) {
      const tabs = await chrome.tabs.query({ url: 'https://labs.google/*' });
      const tab = tabs.find((candidate) => /\/tools\/flow|\/flow\/project/.test(candidate.url || ''));
      if (tab?.id) {
        await emitLog('warn', 'pre-submit.watchdog', 'content script เงียบก่อนกด Generate — ส่งงานเดิมเพื่อกู้จากไฟล์ในคลัง', {
          jobId: live.currentJob.jobId,
          clipIndex: live.currentJob.clipIndex,
          meta: { silentMs: Date.now() - lastActivity },
        });
        await chrome.storage.local.remove('submittedFor');
        await setStatus(`งาน #${live.currentJob.jobId}: กู้ขั้นตอนก่อนกด Generate อัตโนมัติ`);
        await sendCurrentJob(tab.id);
      }
    }
  } else if (live.running && !live.currentJob) {
    const cooldownUntil = Number(live.nextJobCooldownUntil || 0);
    if (cooldownUntil > Date.now()) return;
    // ใช้ตัวเดียวกับ setTimeout เพื่อให้ error ถูกดักเหมือนกัน (heartbeat เป็น async listener)
    await resumeAfterCooldown(cooldownUntil);
  }
});

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === 'complete' && /labs\.google\/.*(?:tools\/flow|flow\/project)/.test(tab.url || '')) {
    sendCurrentJob(tabId).catch((error) => failCurrent(error.message));
  }
});

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  (async () => {
    if (message.type === 'GET_STATUS') return { ...(await state()) };
    if (message.type === 'RESET_COOLDOWN') {
      const current = await state();
      await chrome.storage.local.remove(['nextJobCooldownUntil']);
      await setStatus('รีเซ็ตเวลาพักแล้ว — พร้อมเริ่มใหม่', {
        running: false,
        cooldownMultiplier: 1,
        currentJob: current.currentJob?.phase === 'cooldown'
          ? {
              ...current.currentJob,
              cooldownUntil: null,
              cooldownReason: null,
              recoveryStage: 0,
              resetRecoveryOnResume: false,
            }
          : current.currentJob,
      });
      await emitLog('info', 'cooldown.manual-reset', 'ผู้ใช้รีเซ็ตเวลาพักของบอท');
      return { ok: true };
    }
    if (message.type === 'FLOW_RESET_TO_PROJECTS') {
      const current = await state();
      if (current.currentJob?.jobId !== Number(message.jobId)) throw new Error('งานเปลี่ยนระหว่างเตรียมโปรเจกต์');
      await chrome.storage.local.remove('submittedFor');
      await setStatus('กำลังกลับหน้ารวมโปรเจกต์เพื่อสร้างโปรเจกต์ใหม่');
      return { ok: true };
    }
    if (message.type === 'FLOW_CREATING_PROJECT') {
      const current = await state();
      if (current.currentJob?.jobId !== Number(message.jobId)) throw new Error('งานเปลี่ยนระหว่างสร้างโปรเจกต์');
      await chrome.storage.local.remove('submittedFor');
      await setStatus('กดสร้างโปรเจกต์ใหม่แล้ว — รอหน้า editor', {
        currentJob: { ...current.currentJob, projectReady: true, forceNewProject: false },
      });
      return { ok: true };
    }
    if (message.type === 'TYPE_PROMPT') {
      const tabId = sender.tab?.id;
      const tabUrl = String(sender.tab?.url || '');
      const prompt = String(message.prompt || '');
      if (!tabId || !/labs\.google\/.*(?:tools\/flow|flow\/project)/.test(tabUrl)) {
        throw new Error('Typing prompt is allowed only in Google Flow tabs');
      }
      if (!prompt || prompt.length > 4000) throw new Error('Motion Prompt is empty or too long');
      // กันพิมพ์พรอมต์ให้ "งานที่ไม่ใช่งานปัจจุบัน" — ถ้าปล่อยผ่าน สคริปต์เก่าจะพิมพ์ทับ
      // แล้วเดินไปกด Generate ต่อ = จ่ายเครดิตให้งานที่ยกเลิกไปแล้ว
      const jobId = Number(message.jobId);
      const current = await state();
      // ไม่มี jobId ติดมาเลย = content script ที่ฝังอยู่ในแท็บเป็นโค้ดรุ่นก่อนหน้า
      // (อัป extension แล้วแต่แท็บ Flow ที่เปิดค้างยังรันสคริปต์เก่าจนกว่าจะรีโหลดหน้า)
      // job #109: อาการคือ "งาน #? ไม่ใช่งานปัจจุบัน" แล้วงานตาย ทั้งที่ยังไม่ได้กด Generate
      // ⛔ ห้ามล้าง submittedFor ตรงนี้เด็ดขาด (job #111: เคยล้างแล้วเจนรูปซ้ำ 2 รอบ
      // = จ่ายเครดิตฟรีไปหนึ่งใบ) มันคือด่านเดียวที่กันการส่งงานซ้ำหลังแท็บรีโหลด
      if (!Number.isInteger(jobId)) {
        await emitLog('warn', 'flow.stale-content', 'พบ content script รุ่นเก่าค้างในแท็บ — รีโหลดแท็บให้ใช้โค้ดใหม่', {
          jobId: current.currentJob?.jobId,
          meta: { version: chrome.runtime.getManifest().version },
        });
        chrome.tabs.reload(tabId).catch(() => null);
        return { ok: false, cancelled: true, error: 'content script รุ่นเก่าค้างในแท็บ — รีโหลดแท็บแล้ว จะทำงานเดิมต่อเอง' };
      }
      if (!current.running || Number(current.currentJob?.jobId) !== jobId) {
        return { ok: false, cancelled: true, error: `งาน #${jobId} ไม่ใช่งานปัจจุบัน` };
      }
      return typePromptLikeKeyboard(tabId, prompt, jobId);
    }
    if (message.type === 'TRUSTED_CLICK') {
      const tabId = sender.tab?.id;
      const tabUrl = String(sender.tab?.url || '');
      if (!tabId || !/labs\.google\/.*(?:tools\/flow|flow\/project)/.test(tabUrl)) {
        throw new Error('Native click is allowed only in Google Flow tabs');
      }
      return clickLikeMouse(tabId, Number(message.x), Number(message.y));
    }
    if (message.type === 'TRUSTED_MOVE') {
      const tabId = sender.tab?.id;
      const tabUrl = String(sender.tab?.url || '');
      if (!tabId || !/labs\.google\/.*(?:tools\/flow|flow\/project)/.test(tabUrl)) {
        throw new Error('Native mouse move is allowed only in Google Flow tabs');
      }
      return moveLikeMouse(tabId, message.path, message.click !== false);
    }
    if (message.type === 'FETCH_LOCAL_IMAGE') {
      const current = await state();
      const url = new URL(String(message.url || ''));
      if (url.origin !== new URL(current.backendUrl).origin || url.pathname !== '/api/media') {
        throw new Error('ปฏิเสธ URL รูปที่ไม่ได้มาจาก Local Service');
      }
      const response = await fetch(url.href, { signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new Error(`Local Service ส่งรูปไม่สำเร็จ (${response.status})`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      let binary = '';
      const chunkSize = 0x8000;
      for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
      }
      await emitLog('info', 'media.fetch', 'โหลดรูปผ่าน Extension background สำเร็จ', {
        jobId: current.currentJob?.jobId,
        clipIndex: current.currentJob?.clipIndex,
        meta: { bytes: bytes.length },
      });
      return { ok: true, base64: btoa(binary), contentType: response.headers.get('content-type') || 'image/jpeg' };
    }
    if (message.type === 'SET_LOCK') {
      const locked = message.locked !== false;
      if (locked) cancelActivePromptTyping('credits locked');
      await setStatus(locked ? 'ล็อกเครดิตแล้ว' : 'ปลดล็อกเครดิตแล้ว — พร้อมเริ่ม', {
        creditLocked: locked, running: locked ? false : (await state()).running,
      });
      return { ok: true };
    }
    if (message.type === 'START') {
      const current = await state();
      if (current.creditLocked) throw new Error('ปลดล็อกเครดิตใน Extension ก่อน');
      const durationSeconds = Number(message.durationSeconds) === 16 ? 16 : 24;
      await chrome.storage.local.set({ durationSeconds });
      // A reservation can finish after STOP wins a race with Gemini/job claim.
      // Resume it first; creating another row here produced #140 while #139
      // was already reserved and waiting in chrome.storage.
      const queued = current.currentJob
        ? { id: current.currentJob.jobId, created: false, resumed: true }
        : await ensureQueuedJob(message.itemId, durationSeconds);
      const queuedStatus = queued.created
        ? (queued.random ? `สุ่มสินค้าอัตโนมัติแล้ว — งาน #${queued.id}` : `เลือกสินค้าแล้ว — งาน #${queued.id}`)
        : `ใช้งานคิวเดิม — งาน #${queued.id}`;
      // A deliberate new Start begins a fresh normal-rate session. Do not
      // inherit the 2x multiplier left by an older recovered/finished job.
      await setStatus(queuedStatus, { running: true, cooldownMultiplier: 1 });
      runNext();
      return { ok: true, ...queued };
    }
    if (message.type === 'STOP') {
      cancelActivePromptTyping('user stopped the bot');
      // ต้องปล่อยงานที่จองไว้ด้วย ไม่ใช่แค่เซ็ต running=false
      //
      // ถ้าปล่อย currentJob ค้างไว้ จะติดกับดัก: กด Start ใหม่ runNext() จะ return
      // ทันทีที่ `if (... || current.currentJob)` แบบเงียบสนิท (บอทนิ่งไม่ทำอะไรเลย)
      // และ reload extension ก็ไม่ช่วย เพราะ chrome.storage ไม่ถูกล้าง
      //
      // ฝั่ง DB มาร์คเป็น failed ไว้ก่อน (ไม่ใช่ pending) เพราะถ้าหยุดตอนกำลังเจนค้าง
      // การเอากลับเข้าคิวอัตโนมัติจะทำให้เจนซ้ำ = เสีย credit ฟรี
      // → คลิปที่เจนเสร็จแล้วยังอยู่ใน clip_paths ครบ กู้ต่อได้ด้วย npm run retry-failed
      const current = await state();
      if (current.currentJob?.jobId) {
        try {
          await api(`/api/extension/jobs/${current.currentJob.jobId}/fail`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: 'ผู้ใช้กดหยุดบอท' }),
          });
        } catch (_) { /* ปล่อยงานฝั่ง DB ไม่ได้ก็ต้องล้าง currentJob อยู่ดี */ }
      }
      await chrome.storage.local.remove('submittedFor');
      await setStatus('หยุดบอทแล้ว', { running: false, currentJob: null });
      return { ok: true };
    }
    if (message.type === 'CLEAR_STUCK_JOB') {
      const current = await state();
      const requestedJobId = Number(message.jobId);
      const jobId = Number.isInteger(requestedJobId) && requestedJobId > 0
        ? requestedJobId
        : Number(current.currentJob?.jobId || 0);

      // Clear only the queue/runtime state. Paid image/video checkpoints remain
      // on disk so this recovery action cannot destroy generated media.
      if (jobId > 0) {
        await api(`/api/extension/jobs/${jobId}/fail`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: 'ผู้ใช้เคลียร์งานค้างจาก Extension' }),
        });
      }
      await chrome.storage.local.remove(['submittedFor', 'nextJobCooldownUntil']);
      await setStatus(jobId > 0 ? `เคลียร์งานค้าง #${jobId} แล้ว` : 'เคลียร์สถานะบอทแล้ว — ไม่พบงานค้าง', {
        running: false,
        creditLocked: true,
        currentJob: null,
      });
      return { ok: true, jobId: jobId || null };
    }
    if (message.type === 'ADD_JOB') {
      return api('/api/extension/jobs', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          itemId: Number(message.itemId),
          durationSeconds: Number(message.durationSeconds) === 16 ? 16 : 24,
        }),
      });
    }
    if (message.type === 'FLOW_STATUS') {
      await chrome.storage.local.set({ jobProgressAt: Date.now() });
      await setStatus(message.message);
      return { ok: true };
    }
    // Arm and persist the watcher BEFORE the paid Generate click. If Flow
    // re-renders the content script immediately after clicking, the background
    // still has everything required to resume after an MV3 worker restart.
    if (message.type === 'FLOW_ARM_WATCH') {
      const tabId = sender.tab?.id;
      const current = await state();
      const mediaType = message.mediaType === 'image' ? 'image' : 'video';
      if (!tabId || !current.running
        || current.currentJob?.jobId !== Number(message.jobId)
        || current.currentJob?.clipIndex !== Number(message.clipIndex)) {
        throw new Error('ไม่สามารถเริ่มตัวเฝ้าคลิปได้ เพราะงานหรือแท็บ Flow เปลี่ยนไป');
      }
      const before = Array.isArray(message.before)
        ? message.before.filter((url) => typeof url === 'string').slice(0, 200)
        : [];
      const failedBefore = Math.max(0, Number(message.failedBefore || 0));
      const existingDeadline = Number(current.currentJob.watchDeadline || 0);
      const expectedPhase = mediaType === 'image' ? 'awaitingImage' : 'awaitingVideo';
      const sameWatch = current.currentJob.phase === expectedPhase && existingDeadline > Date.now();
      const watchDeadline = sameWatch ? existingDeadline : Date.now() + FLOW_VIDEO_TIMEOUT_MS;
      const watchStartedAt = sameWatch
        ? Number(current.currentJob.watchStartedAt || Date.now())
        : Date.now();
      const armedJob = {
        ...current.currentJob,
        phase: expectedPhase,
        watchBefore: before,
        watchStartedAt,
        watchDeadline,
        watchFailedBefore: failedBefore,
      };
      await setStatus(mediaType === 'image'
        ? `งาน #${message.jobId}: เปิดตัวเฝ้าผลรูปมือจับแล้ว`
        : `งาน #${message.jobId}: เปิดตัวเฝ้าผลคลิป ${Number(message.clipIndex) + 1} แล้ว`, {
        currentJob: armedJob,
      });
      startClipWatch(tabId, Number(message.jobId), Number(message.clipIndex), before, watchDeadline, mediaType);
      return { ok: true, watchDeadline };
    }
    // Compatibility/ack after content script has clicked Generate.
    if (message.type === 'FLOW_SUBMITTED') {
      const tabId = sender.tab?.id;
      if (!tabId) return { ok: false };
      const current = await state();
      if (current.currentJob?.jobId !== Number(message.jobId)
        || current.currentJob?.clipIndex !== Number(message.clipIndex)) {
        return { ok: false, error: 'งานเปลี่ยนก่อนยืนยันการส่ง Generate' };
      }
      if (current.currentJob.phase !== 'awaitingVideo') {
        const before = Array.isArray(message.before) ? message.before : [];
        const watchDeadline = Date.now() + FLOW_VIDEO_TIMEOUT_MS;
        await setStatus(`งาน #${message.jobId}: ยืนยันการส่งสร้างคลิป ${Number(message.clipIndex) + 1}`, {
          currentJob: {
            ...current.currentJob,
            phase: 'awaitingVideo',
            watchBefore: before,
            watchStartedAt: Date.now(),
            watchDeadline,
            watchFailedBefore: Math.max(0, Number(message.failedBefore || 0)),
          },
        });
      }
      const live = await state();
      startClipWatch(
        tabId,
        Number(message.jobId),
        Number(message.clipIndex),
        Array.isArray(live.currentJob?.watchBefore) ? live.currentJob.watchBefore : [],
        Number(live.currentJob?.watchDeadline || 0)
      );
      return { ok: true };
    }
    if (message.type === 'FLOW_CLIP_READY') {
      // ต้อง catch เอง! ถ้าปล่อยให้ throw ขึ้นไป listener จะแค่ reply error กลับ
      // แล้วไม่มีใครเคลียร์ currentJob → heartbeat จะไม่เรียก runNext อีกเลย
      // (เงื่อนไขคือ running && !currentJob) = บอทค้างเงียบทั้งที่จ่าย credit ไปแล้ว
      try {
        await acceptClip({ ...message, tabId: sender.tab?.id });
      } catch (error) {
        await failCurrent(`บันทึกคลิปไม่สำเร็จ (เครดิตถูกใช้ไปแล้ว): ${error.message}`);
      }
      return { ok: true };
    }
    // ส่องเฉยๆ — เก็บ diagnostic อย่างเดียว ไม่แตะสถานะงาน
    if (message.type === 'FLOW_DIAG') {
      try {
        await api('/api/extension/diagnostic', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: message.message, url: message.url, ui: message.ui }),
        });
      } catch (_) {}
      return { ok: true };
    }
    if (message.type === 'FLOW_ERROR') {
      const current = await state();
      // A cancelled or reloaded content task may finish late. It must never
      // fail/pause whichever job is current now.
      if (Number.isInteger(Number(message.jobId))
        && current.currentJob?.jobId !== Number(message.jobId)) {
        await emitLog('warn', 'flow.error.stale', 'ข้าม error จาก content task เก่าที่ไม่ใช่งานปัจจุบัน', {
          jobId: Number(message.jobId),
          clipIndex: Number(message.clipIndex || 0),
          meta: { currentJobId: current.currentJob?.jobId ?? null, message: String(message.message || '') },
        });
        return { ok: true, ignored: true };
      }
      // ส่งภาพ DOM ตอนพังไปเก็บที่ service ก่อน — เอาไว้ไล่ selector ทีหลัง
      if (message.ui) {
        try {
          await api('/api/extension/diagnostic', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: message.message, url: message.url, ui: message.ui }),
          });
        } catch (_) { /* เก็บ diagnostic ไม่ได้ก็ต้อง fail งานต่อไปอยู่ดี */ }
      }
      const recovered = await recoverMediaLibraryTimeout(message.message || '');
      if (!recovered) await failCurrent(message.message || 'Flow ทำงานไม่สำเร็จ');
      return { ok: true };
    }
    return { ok: false };
  })().then(reply).catch((error) => {
    emitLog('error', 'message.handler', `จัดการคำสั่ง ${message?.type || 'UNKNOWN'} ไม่สำเร็จ`, { error });
    reply({ ok: false, error: error.message });
  });
  return true;
});
