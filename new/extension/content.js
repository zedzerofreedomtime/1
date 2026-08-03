(() => {
if (globalThis.__clipbotFlowContentInstalled) return;
globalThis.__clipbotFlowContentInstalled = true;

let working = false;
/**
 * ด่านกันจ่ายเครดิตซ้ำระดับ "หน้าเว็บ"
 *
 * job #111/#113: ตัวกัน submittedFor ฝั่ง background แพ้ race — พอกด Generate เสร็จ
 * generateImage คืนค่าทันที (working=false) แล้วมีข้อความสั่งงานเดิมเข้ามาอีกใน "วินาที
 * เดียวกัน" → อัปโหลดใหม่ + พิมพ์พรอมต์ทับของเดิม → ได้รูปซ้ำ 2 ใบ = เผาเครดิตฟรี
 *
 * Set นี้อยู่ในหน้าเว็บ ไม่ผ่าน storage จึงไม่มี race และจะถูกล้างเองเมื่อหน้าโหลดใหม่
 * (โหลดใหม่ = โปรเจกต์ใหม่จริงๆ ซึ่งควรทำซ้ำได้) ใช้คู่กับ submittedFor ไม่ใช่แทนที่
 */
const submittedInThisPage = new Set();
const paidStepKey = (job, stage) =>
  `${job.jobId}:${stage}:${job.imageRole === 'end' ? 'end' : 'start'}:${job.clipIndex ?? 0}`;
let cancelRequested = false;

async function generationIsAuthorized(job) {
  if (cancelRequested) return false;
  const bot = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
  return bot?.running === true
    && bot?.creditLocked === false
    && Number(bot?.currentJob?.jobId) === Number(job.jobId);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const visible = (element) => element && element.getClientRects().length > 0 && !element.disabled;

function all(selector) { return [...document.querySelectorAll(selector)].filter(visible); }
function byText(selector, pattern) {
  return all(selector).find((element) => pattern.test((element.textContent || '').trim()));
}
async function waitFor(find, timeout = 30000, label = 'องค์ประกอบที่ต้องใช้') {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = find();
    if (value) return value;
    await sleep(400);
  }
  throw new Error(`รอหน้าจอ Flow นานเกินกำหนด: ${label}`);
}
function notify(message) { return chrome.runtime.sendMessage({ type: 'FLOW_STATUS', message }); }

/**
 * กดปุ่มแบบ "เหมือนมนุษย์กดจริง" (DOM events เท่านั้น — ไม่ขยับเคอร์เซอร์จริง)
 *
 * ⚠️ ห้ามใช้ element.click() กับ UI ของ Flow เด็ดขาด
 * เพราะ .click() ยิงแค่ event 'click' ตัวเดียว แต่เมนูของ Flow เปิดด้วย 'pointerdown'
 * (ยืนยันจากของจริง: กดปุ่มโมเดลด้วย .click() แล้ว DOM ไม่เปลี่ยนเลยสักตัว เมนูไม่เปิด)
 *
 * ต้องยิงครบชุด pointerdown → mousedown → pointerup → mouseup → click
 * พร้อมพิกัดกลางปุ่ม เพราะบาง component เช็ค clientX/clientY ด้วย
 *
 * หมายเหตุ: ตอนนี้ใช้เป็น fallback เท่านั้น — ปกติใช้ humanClick() แทน
 */
function realClick(element) {
  const rect = element.getBoundingClientRect();
  const clientX = rect.left + rect.width / 2;
  const clientY = rect.top + rect.height / 2;
  const base = { bubbles: true, cancelable: true, composed: true, view: window, clientX, clientY, button: 0, buttons: 1 };
  const pointer = { ...base, pointerId: 1, pointerType: 'mouse', isPrimary: true };

  element.dispatchEvent(new PointerEvent('pointerover', pointer));
  element.dispatchEvent(new PointerEvent('pointerenter', pointer));
  element.dispatchEvent(new MouseEvent('mouseover', base));
  element.dispatchEvent(new PointerEvent('pointerdown', pointer));
  element.dispatchEvent(new MouseEvent('mousedown', base));
  element.dispatchEvent(new PointerEvent('pointerup', { ...pointer, buttons: 0 }));
  element.dispatchEvent(new MouseEvent('mouseup', { ...base, buttons: 0 }));
  element.dispatchEvent(new MouseEvent('click', { ...base, buttons: 0 }));
}

async function trustedClick(element, { windowsCursor = false } = {}) {
  // 🔬 ยืนยันจาก DOM จริง 27 ก.ค. 17:19 (ส่องด้วย Chrome ของเจ้าของ):
  //   ปุ่มส่งใช้ aria-disabled เป็นตัวบอกสถานะ ส่วน .disabled เป็น false เสมอ
  //   และ pointer-events:all ตลอด → คลิกลงไปได้เสมอ "แม้ตอนที่ Flow ยังไม่รับคำสั่ง"
  //
  // เจ้าของรายงาน: บางครั้งกดแล้วเหมือนไม่ได้กด (พรอมต์กับรูปยังค้าง) สาเหตุที่เป็นไปได้คือ
  // จุดกึ่งกลางปุ่มโดนอย่างอื่นบังอยู่ (คลังสื่อกำลังปิด/มีเลเยอร์ทับ) แล้วคลิกไปโดนตัวที่บังแทน
  // → ตรวจด้วย elementFromPoint ก่อนยิงคลิกเสมอ ถ้าโดนบังให้เลื่อนเข้าจอแล้ววัดใหม่
  const pointOnTarget = () => {
    const rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    return { x, y, hit, covered: !hit || !(hit === element || element.contains(hit) || hit.contains(element)) };
  };

  let point = pointOnTarget();
  if (!point) throw new Error('Generate button has no clickable area');
  if (point.covered) {
    element.scrollIntoView({ block: 'center' });
    await sleep(600);
    point = pointOnTarget();
    if (!point) throw new Error('Generate button has no clickable area');
  }
  if (point.covered) {
    const blocker = point.hit
      ? `${point.hit.tagName}${point.hit.className ? '.' + String(point.hit.className).split(' ')[0] : ''}`
      : 'ไม่ทราบ';
    throw new Error(`จุดกดปุ่มส่งถูก ${blocker} บังอยู่ — หยุดก่อน ไม่กดมั่วเพราะจะเสียเครดิตแบบไม่รู้ผล`);
  }

  if (windowsCursor) {
    await humanClick(element, { allowDomFallback: false });
    return;
  }

  const response = await chrome.runtime.sendMessage({
    type: 'TRUSTED_CLICK',
    x: point.x,
    y: point.y,
  });
  if (!response?.ok) throw new Error(response?.error || 'Native Generate click failed');
}

// ╔═══════════════════════════════════════════════════════════╗
// ║  Human-like Mouse Movement — เคลื่อนเคอร์เซอร์จริงบนหน้าจอ  ║
// ║  ผ่าน Windows API SetCursorPos (user32.dll)                ║
// ╚═══════════════════════════════════════════════════════════╝

/** ตำแหน่งเมาส์ล่าสุดใน viewport coordinates — ใช้ให้การเคลื่อนที่ต่อเนื่อง */
let lastMouseX = Math.round(window.innerWidth / 2);
let lastMouseY = Math.round(window.innerHeight / 3);

/**
 * แปลง viewport coordinates เป็น screen coordinates
 *
 * viewport (0,0) = มุมซ้ายบนของพื้นที่เนื้อหาเว็บ
 * screen (0,0)   = มุมซ้ายบนของหน้าจอ
 *
 * ต้องบวก:
 *   - window.screenX (ตำแหน่ง X ของหน้าต่าง Chrome บนหน้าจอ)
 *   - window.screenY (ตำแหน่ง Y ของหน้าต่าง Chrome บนหน้าจอ)
 *   - chrome offset (address bar, tab bar ที่อยู่เหนือ viewport)
 */
function toScreenCoords(viewportX, viewportY) {
  // Chrome window border — ด้านซ้ายมีขอบบาง
  const chromeLeftBorder = Math.round((window.outerWidth - window.innerWidth) / 2);
  // Chrome toolbar — tab bar + address bar อยู่ด้านบน
  const chromeTopBar = window.outerHeight - window.innerHeight - chromeLeftBorder;
  return {
    x: Math.round(window.screenX + chromeLeftBorder + viewportX),
    y: Math.round(window.screenY + chromeTopBar + viewportY),
  };
}

/**
 * ดึง URL ของ backend server จาก Extension storage
 */
async function getBackendUrl() {
  try {
    const stored = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
    const url = stored?.backendUrl || 'http://127.0.0.1:8110';
    return url.replace(/\/$/, '');
  } catch {
    return 'http://127.0.0.1:8110';
  }
}

/**
 * เคลื่อนเคอร์เซอร์จริงไปยัง element ตาม Bezier curve
 *
 * ใช้ Windows API SetCursorPos ผ่าน local server → เคอร์เซอร์เคลื่อนจริงบนหน้าจอ
 *
 * @param {Element} element - element เป้าหมาย
 * @returns {Promise<{x: number, y: number}>} - พิกัดปลายทาง (viewport)
 */
async function humanMoveTo(element) {
  const math = globalThis.__mouseMath;
  if (!math) throw new Error('mouse-math.js not loaded');

  const rect = element.getBoundingClientRect();
  if (!rect.width || !rect.height) throw new Error('Element has no visible area for mouse move');

  // สุ่มตำแหน่งคลิกภายใน element (ไม่ตรงกลางเป๊ะ)
  const target = math.randomClickTarget(rect, 0.12);

  // สร้าง Bezier path ใน viewport coordinates
  const viewportPath = math.generateBezierPath(lastMouseX, lastMouseY, target.x, target.y);

  // แปลงทุกจุดเป็น screen coordinates
  const screenPath = viewportPath.map((p) => {
    const s = toScreenCoords(p.x, p.y);
    return { x: s.x, y: s.y, delay: p.delay };
  });

  // ส่งไป local server เพื่อเคลื่อนเคอร์เซอร์จริง
  try {
    const backendUrl = await getBackendUrl();
    const response = await fetch(`${backendUrl}/api/mouse/path`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: screenPath, click: false }),
    });
    if (!response.ok) throw new Error(`Server returned ${response.status}`);
  } catch (err) {
    // ถ้า server ไม่ตอบ ก็ไม่ต้องหยุดทำงาน — แค่เคอร์เซอร์ไม่ขยับ
    console.warn('[ClipBot] Mouse move via server failed:', err?.message);
  }

  // อัปเดตตำแหน่งเมาส์ล่าสุด
  lastMouseX = target.x;
  lastMouseY = target.y;
  return target;
}

/**
 * เคลื่อนเคอร์เซอร์จริงไปยัง element แล้วคลิก — ทดแทน realClick()
 *
 * ลำดับ:
 *   1. สร้าง Bezier path จากตำแหน่งปัจจุบัน → เป้าหมาย
 *   2. แปลงเป็น screen coordinates
 *   3. ส่งไป local server → PowerShell SetCursorPos + mouse_event
 *   4. เคอร์เซอร์เคลื่อนจริง → Browser สร้าง native events เอง
 *
 * @param {Element} element - element ที่จะคลิก
 */
async function humanClick(element, { allowDomFallback = true } = {}) {
  const math = globalThis.__mouseMath;
  if (!math) {
    if (!allowDomFallback) throw new Error('ไม่พบ mouse-math.js — ยกเลิกการคลิกเมาส์ Windows');
    realClick(element);
    return;
  }

  const rect = element.getBoundingClientRect();
  if (!rect.width || !rect.height) {
    if (!allowDomFallback) throw new Error('ปุ่มไม่มีพื้นที่ให้เมาส์ Windows คลิก');
    realClick(element);
    return;
  }

  // สุ่มตำแหน่งคลิกภายใน element
  const target = math.randomClickTarget(rect, 0.12);

  // สร้าง Bezier path ใน viewport coordinates
  const viewportPath = math.generateBezierPath(lastMouseX, lastMouseY, target.x, target.y);

  // แปลงเป็น screen coordinates
  const screenPath = viewportPath.map((p) => {
    const s = toScreenCoords(p.x, p.y);
    return { x: s.x, y: s.y, delay: p.delay };
  });

  // อัปเดตตำแหน่งเมาส์ล่าสุด
  lastMouseX = target.x;
  lastMouseY = target.y;

  // ส่งไป server — เคลื่อน + คลิก
  try {
    const backendUrl = await getBackendUrl();
    const response = await fetch(`${backendUrl}/api/mouse/path`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: screenPath, click: true }),
    });
    if (!response.ok) throw new Error(`Server returned ${response.status}`);
    // คลิกสำเร็จผ่าน OS — ไม่ต้อง dispatch DOM events
    return;
  } catch (err) {
    console.warn('[ClipBot] Mouse click via server failed, falling back to DOM:', err?.message);
    if (!allowDomFallback) {
      throw new Error(`เมาส์ Windows คลิกไม่ได้ — ยกเลิกก่อนกด Generate: ${err?.message || 'Local Service ไม่ตอบ'}`);
    }
  }

  // Fallback: ถ้า server ไม่ตอบ → ใช้ DOM events เดิม
  realClick(element);
}

function failedGenerationCardCount() {
  return all('[role="button"]').filter((element) => {
    const label = [element.textContent, element.getAttribute('aria-label'), element.getAttribute('title')]
      .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    return /(?:warning.*(?:ล้มเหลว|failed)|(?:ล้มเหลว|failed).*warning)/i.test(label)
      && label.length < 600;
  }).length;
}

/** ช่องพรอมต์ว่างจริงไหม — Flow ล้างช่องให้เองเมื่อ "รับคำสั่งสร้าง" สำเร็จ */
function promptBoxEmpty() {
  const box = all('textarea,[role="textbox"],[contenteditable="true"]')
    .find((element) => !element.closest('[aria-hidden="true"]'));
  if (!box) return true;
  return !((box.innerText || box.value || '').trim());
}

/**
 * ยืนยันว่า Flow "รับคำสั่งสร้าง" จริง ไม่ใช่แค่คลิกลงไปแล้วไม่มีอะไรเกิดขึ้น
 *
 * เจ้าของรายงาน: บางครั้งกดปุ่มเจนแล้วเหมือนไม่ได้กด — พรอมต์ยังอยู่ รูปยังคาอยู่ในช่อง
 * สัญญาณที่เชื่อถือได้ที่สุดคือ "ช่องพรอมต์ถูกล้าง" เพราะ Flow ล้างให้เองเมื่อส่งสำเร็จ
 * (เงื่อนไขเดิมใช้ปุ่ม disabled/หายจาก DOM ซึ่งเกิดตอน re-render ธรรมดาได้ด้วย เลยหลุด)
 *
 * ถ้ายืนยันไม่ได้ จะกดซ้ำได้แค่ครั้งเดียว และเฉพาะตอนที่ "ไม่มีอะไรกำลังเดินอยู่" เท่านั้น
 * (ช่องยังเต็ม + ไม่มี progressbar + ไม่มีการ์ดล้มเหลวใหม่) = มั่นใจว่าคลิกแรกไม่ติดจริง
 */
async function confirmGenerateAccepted(generate, retryClick = null) {
  const busy = () => all('[role="progressbar"],[aria-busy="true"]').length > 0;
  const accepted = () => promptBoxEmpty()
    || busy();

  try {
    await waitFor(accepted, 12000, 'Flow ล้างช่องพรอมต์หลังกด Generate');
    return;
  } catch (_) {
    if (!retryClick) {
      throw new Error('กด Generate แล้วช่องพรอมต์ยังไม่ถูกล้าง — Flow ไม่รับคำสั่ง หยุดก่อนเดาต่อ');
    }
  }

  await notify('กด Generate แล้ว Flow ยังไม่รับคำสั่ง (พรอมต์ยังค้าง) — กดซ้ำอีกครั้งเดียว');
  await retryClick();
  await waitFor(accepted, 15000, 'Flow ล้างช่องพรอมต์หลังกด Generate ครั้งที่ 2');
}

/**
 * ถ่ายภาพ DOM ตอนพัง เพื่อให้รู้ว่า Flow เรนเดอร์ปุ่มเป็นอะไรจริงๆ
 *
 * จำเป็นมาก เพราะ Flow UI เปลี่ยนบ่อยและเรนเดอร์ปุ่มด้วย tag แปลกๆ
 * (เคยเจอ <div type="button">เริ่ม</div> ซึ่ง selector เดิมหาไม่เจอ)
 * ถ้าไม่มีข้อมูลนี้ต้องนั่งเดา selector ทีละตัว
 */
function snapshotUi() {
  // ต้องมี role=menuitem/menuitemradio/li ด้วย ไม่งั้นเปิดเมนูแล้วก็ยังมองไม่เห็นรายการข้างใน
  // และต้องมี video/progressbar ด้วย ไม่งั้นตอนรอผลลัพธ์จะแยกไม่ออกว่า
  // "ยังเจนอยู่" หรือ "เจนเสร็จแล้วแต่บอทมองไม่เห็น"
  // ต้องเก็บ img/gridcell/listitem ด้วย ไม่งั้นมองไม่เห็น "thumbnail ในคลังสื่อ"
  // (Flow เลิกใช้ role=option กับคลังแล้วช่วง ~22 ก.ค. → ต้องเห็นว่าตอนนี้ใช้ tag อะไร)
  const nodes = [...document.querySelectorAll(
    'button,[role="button"],div[type="button"],[aria-haspopup],[role="tab"],[role="option"],' +
    '[role="menuitem"],[role="menuitemradio"],[role="menuitemcheckbox"],[role="menu"] li,[role="listbox"] *,' +
    '[role="gridcell"],[role="listitem"],img,' +
    'video,[role="progressbar"],[role="alert"],input,textarea,[contenteditable="true"]'
  )].filter((el) => {
    // ตัด icon เล็กๆ ออก เหลือเฉพาะ img ที่ใหญ่พอจะเป็น thumbnail จริง
    if (el.tagName !== 'IMG') return true;
    const r = el.getBoundingClientRect();
    return r.width >= 40 && r.height >= 40;
  });
  return nodes.slice(0, 160).map((el) => {
    const text = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 45);
    return {
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type') || undefined,
      role: el.getAttribute('role') || undefined,
      aria: (el.getAttribute('aria-label') || '').slice(0, 35) || undefined,
      alt: (el.getAttribute('alt') || '').slice(0, 35) || undefined,
      pop: el.getAttribute('aria-haspopup') || undefined,
      // ต้องรู้ว่าเมนูเปิดอยู่ไหม ไม่งั้นแยกไม่ออกว่า "กดไม่ติด" หรือ "กดติดแต่หาไม่เจอ"
      expanded: el.getAttribute('aria-expanded') || undefined,
      // สำหรับ <video>/<img> — เอาไว้ดูว่าเจน/อัปโหลดออกมาหรือยัง
      src: el.tagName === 'VIDEO' ? (el.currentSrc || el.src || '(ไม่มี src)')
        : el.tagName === 'IMG' ? (el.currentSrc || el.src || '').slice(0, 70) || undefined
        : undefined,
      text: text || undefined,
      shown: el.getClientRects().length > 0,
    };
  });
}

async function enterEditor(job) {
  const inProject = /\/project\//.test(location.pathname);

  // Clip 1 may use both Start and End frames. Open a clean project before
  // clip 2 so stale filled frame slots cannot leak into the continuation.
  if (job.forceNewProject && inProject) {
    await notify('กำลังเปิดโปรเจกต์ใหม่สำหรับคลิปต่อเนื่องหลังใช้ End frame');
    await chrome.runtime.sendMessage({ type: 'FLOW_RESET_TO_PROJECTS', jobId: job.jobId });
    location.href = 'https://labs.google/fx/th/tools/flow';
    await sleep(30000);
    return;
  }

  // คลิปแรกของทุกงานต้องเริ่มในโปรเจกต์ใหม่เสมอ ป้องกัน state เสียจากงานก่อนหน้า
  // และป้องกัน media เก่าถูก watcher เข้าใจผิดว่าเป็นผลของงานใหม่
  if (job.clipIndex === 0 && !job.projectReady) {
    if (inProject) {
      await notify('กำลังกลับหน้ารวมโปรเจกต์เพื่อเริ่มงานใหม่');
      await chrome.runtime.sendMessage({ type: 'FLOW_RESET_TO_PROJECTS', jobId: job.jobId });
      location.href = 'https://labs.google/fx/th/tools/flow';
      await sleep(30000);
      return;
    }
    await notify('กำลังเปิดโปรเจกต์ใหม่ใน Flow');
    const button = await waitFor(() => byText('button,[role="button"]', /โปรเจ็กต์ใหม่|New project/i), 30000, 'ปุ่มโปรเจ็กต์ใหม่');
    await chrome.runtime.sendMessage({ type: 'FLOW_CREATING_PROJECT', jobId: job.jobId });
    await humanClick(button);
    await sleep(30000);
    return;
  }

  if (inProject) return;
  if (job.clipIndex > 0) {
    // A checkpoint can be resumed after the user switches Google accounts.
    // The old Flow project is unavailable, but continuity_N.jpg is the exact
    // last frame of the previous paid clip, so it is safe to start a new
    // project and continue from that frame without regenerating earlier clips.
    await notify(`กำลังกู้ checkpoint คลิป ${job.clipIndex + 1} ในโปรเจกต์ใหม่`);
    const resumeButton = await waitFor(
      () => byText('button,[role="button"]', /โปรเจ็กต์ใหม่|New project/i),
      30000,
      'ปุ่มโปรเจ็กต์ใหม่สำหรับกู้ checkpoint'
    );
    await chrome.runtime.sendMessage({ type: 'FLOW_CREATING_PROJECT', jobId: job.jobId });
    await humanClick(resumeButton);
    await sleep(30000);
    return;
  }
  await notify('กำลังเปิดโปรเจ็กต์ใหม่ใน Flow');
  const button = await waitFor(() => byText('button,[role="button"]', /โปรเจ็กต์ใหม่|New project/i), 30000, 'ปุ่มโปรเจ็กต์ใหม่');
  await humanClick(button);
  await waitFor(() => /\/project\//.test(location.pathname), 30000, 'หน้าโปรเจ็กต์ Flow');
  await sleep(1000);
}

/** tag ที่ Flow ใช้ทำปุ่ม — มันไม่ได้ใช้ <button> เสมอไป (เจอ <div type="button"> มาแล้ว) */
const CLICKABLE = 'button,[role="button"],div[type="button"],[aria-haspopup="dialog"],[aria-haspopup="menu"]';

/** ตัวเลือกในเมนู/ป๊อปอัปของ Flow (ยืนยันจาก DOM จริง: ปุ่มโมเดลเป็น aria-haspopup="menu") */
const MENU_ITEM = '[role="menuitem"],[role="menuitemradio"],[role="option"],[role="tab"],li,button,div[type="button"]';

/**
 * ป้าย "จำนวนผลลัพธ์ = 1"
 *
 * Flow เปลี่ยนป้ายจาก "1x" เป็น "x1" (ยืนยันบน DOM จริง 30 ก.ค. 11:01 — แท็บคือ
 * x1/x2/x3/x4) ตัวจับเดิม /^1x$/i จึงไม่มีวันตรง ทำให้ job #120 ล้มที่
 * "ไม่พบตัวเลือก 1x ในการตั้งค่าวิดีโอ" ทั้งที่ Flow เลือก x1 ไว้ให้อยู่แล้ว
 *
 * รับทั้งสองแบบและไม่ยึดหัวท้าย เพราะป้ายบนปุ่ม composer เอา ligature มาต่อกัน
 * เป็น "crop_9_16x1" — แต่ต้องกันไม่ให้ไปโดน x2/x3/x4 หรือ x10 ด้วย lookahead
 */
const ONE_OUTPUT_PATTERN = /x\s*1(?![0-9])|(?:^|\D)1\s*x(?![0-9])/i;

/**
 * โมเดลวิดีโอที่ต้องใช้ — เจ้าของสั่งเปลี่ยนจาก Omni Flash เมื่อ 3 ส.ค. 2026
 *
 * เมนูโมเดลจริงในเบราว์เซอร์วันนั้นมี 5 ตัว:
 *   Omni Flash · Veo 3.1 - Lite · Veo 3.1 - Fast · Veo 3.1 - Quality
 *   Veo 3.1 - Lite [Lower Priority]   ← ตัวที่ต้องใช้ และขึ้นว่า "จะใช้ 0 เครดิต"
 *
 * ⚠️ **ห้ามจับด้วย /Veo\s*3\.1\s*-\s*Lite/ เด็ดขาด** — มันจะไปโดน `Veo 3.1 - Lite`
 * ตัวธรรมดาที่อยู่เหนือกว่าในเมนู ซึ่งเป็นคนละโมเดลและกินเครดิต
 * เป็นกับดักตัวเดียวกับ `Nano Banana Pro` vs `Nano Banana 2 Lite` ที่ทำ #116 ล้มมาแล้ว
 * ตัวที่แยกสองอันนี้ออกจากกันได้จริงมีแค่คำว่า "Lower Priority"
 *
 * ⚠️ ห้ามยึดหัวท้ายด้วย ^...$ — Flow เอา ligature ไอคอนมาต่อกับข้อความเสมอ
 */
const VIDEO_MODEL_LABEL = 'Veo 3.1 - Lite [Lower Priority]';
const VIDEO_MODEL_PATTERN = /Veo[^]{0,20}Lite[^]{0,20}Lower\s*Priority/i;

/**
 * กดปุ่มที่มีป๊อปอัป "จนกว่าจะเปิดจริง" — ยืนยันด้วย aria-expanded
 *
 * ทำไมต้องวนกด: realClick ยิง pointerdown (เมนูเปิด) แล้วตามด้วย click
 * ซึ่งบาง component ตีความว่าเป็นการ toggle → ปิดกลับทันที
 * ผลคือบางรอบเปิด บางรอบปิด ทั้งที่โค้ดเดียวกัน (เจอจริงมาแล้ว)
 * เช็ค aria-expanded คือวิธีเดียวที่รู้แน่ว่าเปิดจริงหรือยัง
 */
async function openPanel(button, label, confirmOpen = null) {
  // ⚠️ ถ้าผู้เรียกบอกวิธียืนยันมา ให้เชื่อ "ของที่ต้องเห็น" เท่านั้น ห้ามลัดด้วย aria-expanded
  // เพราะปุ่มอาจถูกเปิดค้างไว้จากแผงชั้นนอก → isOpen() เป็นจริงทั้งที่เมนูที่ต้องการยังไม่เปิด
  // แล้ว openPanel คืน true ตั้งแต่รอบแรกโดยไม่กดอะไรเลย (job #116/#118/#119)
  const isOpen = () => (typeof confirmOpen === 'function'
    ? Boolean(confirmOpen())
    : button.getAttribute('aria-expanded') === 'true');
  for (let attempt = 1; attempt <= 4; attempt++) {
    if (isOpen()) return true;
    // Flow sometimes ignores synthetic pointer events after a generated card
    // re-renders the composer. Fall back to the debugger-backed native mouse
    // click used by Generate; this produces a trusted browser interaction.
    if (attempt === 1) await humanClick(button);
    else await trustedClick(button);
    await sleep(600);
    if (isOpen()) return true;
    await notify(`${label} ยังไม่เปิด — กดใหม่ (${attempt}/4)`);
  }
  throw new Error(`กดแล้ว ${label} ไม่เปิด — ไม่พบแผงหรือสถานะ expanded (ดู diagnostic)`);
}

async function configureImage() {
  await notify('Preparing Flow image mode (9:16, one image)');
  const modelButton = byText(CLICKABLE, /crop_(?:9_16|16_9)|Nano Banana|Imagen|Veo/i);
  if (!modelButton) throw new Error('Image model/settings button was not found');
  const currentLabel = (modelButton.textContent || '').trim();
  await openPanel(modelButton, 'image settings', () =>
    Boolean(byText('[role="tab"]', /Image|รูปภาพ/i) && byText('[role="tab"]', /Video|วิดีโอ/i))
  );

  if (/Veo|Video|วิดีโอ/i.test(currentLabel)) {
    const imageTab = byText('[role="tab"]', /Image|รูปภาพ/i);
    if (!imageTab) throw new Error('Image tab was not found in Flow settings');
    await humanClick(imageTab);
    await waitFor(() => Array.from(document.querySelectorAll('[role="tab"]'))
      .find((el) => el.getAttribute('aria-selected') === 'true' && /Image|รูปภาพ/i.test((el.textContent || '').trim())),
      5000, 'Flow image mode');
  }

  // Flow defaults to Nano Banana 2 Lite (0 credits). It is fast, but it
  // frequently rewrites labels and small product geometry. The fidelity gate
  // then rejects the image after we have already spent time generating it.
  // Product-reference jobs must explicitly use Pro; never silently fall back
  // to Lite because that would make the quality setting depend on stale UI.
  // ⚠️ หน้านี้มีปุ่ม aria-haspopup="menu" ที่ข้อความมีชื่อโมเดล "สองตัว"
  // (ยืนยันจาก data/flow-diagnostic.json 30 ก.ค. 10:39):
  //   1. ปุ่มตั้งค่า composer  "🍌 Nano Banana 2 Litecrop_16_9x2"    ← เปิดค้างอยู่แล้ว
  //   2. ปุ่มเลือกโมเดลในแผง   "🍌 Nano Banana 2 Litearrow_drop_down" ← ตัวที่ต้องกดจริง
  // เดิมใช้ .find() จึงคว้าตัวที่ 1 ซึ่ง aria-expanded="true" อยู่แล้ว → openPanel คืน true
  // ทันทีโดยไม่กดอะไร แล้วหา Pro ไม่เจอ งานล้มใน 1.7 วินาที ทั้งที่เมนูยังไม่เคยถูกเปิด
  // ตัวที่ใช่มี ligature "arrow_drop_down" เสมอ — configureVideo() ใช้หลักนี้อยู่แล้ว
  const pickModelDropdown = () => {
    const candidates = Array.from(document.querySelectorAll(
      '[role="menu"] button,[role="menu"] [role="button"],[role="menu"] div[type="button"],[aria-haspopup="menu"]'
    )).filter((el) => /arrow_drop_down/i.test(el.textContent || ''));
    return candidates.find((el) => /Nano Banana|Imagen/i.test(el.textContent || '')) || candidates[0] || null;
  };
  const imageModelButton = pickModelDropdown();
  if (!imageModelButton) throw new Error('Image model selector was not found');
  if (!/Nano Banana Pro/i.test((imageModelButton.textContent || '').trim())) {
    // ⚠️ ห้ามใช้ regex แบบ ^...$ กับข้อความใน Flow เด็ดขาด (กติกาที่ CLAUDE.md เตือนไว้)
    //
    // Flow เอา ligature ของไอคอนมาต่อกับข้อความในโหนดเดียวกัน เช่น "add_2สร้าง",
    // "crop_freeเฟรม", "🍌 Nano Banana 2 Litecrop_9_161x" → ตัวจับที่ยึดหัวท้ายจะพลาดทันที
    // ที่ Flow เติม badge/ราคาเครดิต/ไอคอนเพิ่ม (job #116: "Nano Banana Pro is unavailable"
    // ทั้งที่ตัวเลือกอยู่ในเมนูจริงๆ) → จับด้วย substring เท่านั้น
    //
    // ต้องกัน "Nano Banana Pro" ไปโดน "Nano Banana 2 Lite" ด้วย จึงเช็คคำว่า Pro ตรงๆ
    const findProModel = () => byText('[role="menuitem"],[role="menuitemradio"],[role="option"]', /Nano\s*Banana\s*Pro/i);
    await openPanel(imageModelButton, 'image model list', () => Boolean(findProModel()));
    const proModel = findProModel();
    if (!proModel) throw new Error('Nano Banana Pro is unavailable — stopped before Generate');
    await humanClick(proModel);
    await waitFor(() => Array.from(document.querySelectorAll('[aria-haspopup="menu"]'))
      .some((el) => /Nano Banana Pro/i.test((el.textContent || '').trim())),
      5000, 'Nano Banana Pro selection');
  }

  // Model selection may close the outer settings popover. Reopen it before
  // choosing aspect ratio and output count.
  let settingsButton = byText(CLICKABLE, /crop_(?:9_16|16_9)|Nano Banana|Imagen/i);
  // DOM จริงเรนเดอร์แท็บนี้เป็น "crop_9_169:16" (ไอคอน+ข้อความติดกัน) ตัวจับแบบ ^...$
  // จึงไม่มีวันตรงเลย ทำให้เปิดแผงซ้ำทุกครั้งโดยไม่จำเป็น — ใช้ substring เหมือนที่อื่น
  if (!byText('[role="tab"]', /crop_9_16|9:16/i)) {
    if (!settingsButton) throw new Error('Image settings button disappeared after model selection');
    await openPanel(settingsButton, 'image settings', () => Boolean(byText('[role="tab"]', /9:16/i)));
  }
  const portrait = byText(MENU_ITEM, /9:16/i);
  if (portrait) { await humanClick(portrait); await sleep(250); }
  // จำกัดที่ [role="tab"] เท่านั้น — MENU_ITEM กว้างถึง button ทั่วไป ซึ่งจะไปโดน
  // ปุ่ม composer "🍌 Nano Banana Procrop_9_16x1" แทนแท็บ x1 ที่ต้องการ
  const oneImage = byText('[role="tab"]', ONE_OUTPUT_PATTERN);
  if (oneImage) { await humanClick(oneImage); await sleep(250); }
  document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await sleep(400);

  const selectedImageTab = Array.from(document.querySelectorAll('[role="tab"]'))
    .find((el) => el.getAttribute('aria-selected') === 'true' && /Image|รูปภาพ/i.test((el.textContent || '').trim()));
  const finalLabel = (byText(CLICKABLE, /Nano Banana|Imagen|crop_9_16/i)?.textContent || '').trim();
  if (!/Nano Banana Pro/i.test(finalLabel)) {
    throw new Error(`Flow did not keep Nano Banana Pro selected (${finalLabel || 'unknown model'})`);
  }
  if ((!selectedImageTab && !/Nano Banana|Imagen/i.test(finalLabel)) || /Veo|Video|วิดีโอ/i.test(finalLabel)) {
    throw new Error(`Flow did not enter image mode (${finalLabel || 'unknown mode'})`);
  }
}

/**
 * สลับโปรเจ็กต์ให้เป็น "โหมดวิดีโอ" ก่อนทำอะไรต่อ
 *
 * สำคัญที่สุดในไฟล์นี้: โปรเจ็กต์ Flow เปิดมาเป็นโหมดสร้าง "รูป" (Nano Banana)
 * ซึ่ง "ไม่มีปุ่ม Start frame" เพราะ Start frame เป็นฟีเจอร์ของโหมดวิดีโอ
 * ถ้าสลับโหมดไม่สำเร็จแล้วปล่อยผ่าน บอทจะไปตายตอนหาปุ่ม Start frame
 * = ตายผิดที่ ไล่หาสาเหตุไม่เจอ (เสียเวลาไปหลายรอบมาแล้ว)
 *
 * ถ้าสลับไม่ได้ต้อง throw ทันทีตรงนี้ และ "ปล่อยเมนูเปิดค้างไว้"
 * เพราะ catch ข้างนอกจะถ่ายภาพ DOM ให้ → จะได้เห็นว่าในเมนูมีโมเดลอะไรให้เลือกบ้าง
 */
async function configureVideo(mode = 'frames') {
  async function selectRequiredTab(pattern, label) {
    const tab = byText('[role="tab"]', pattern);
    if (!tab) throw new Error(`ไม่พบตัวเลือก ${label} ในการตั้งค่าวิดีโอ`);
    if (tab.getAttribute('aria-selected') !== 'true') {
      await humanClick(tab);
      await waitFor(
        () => tab.isConnected && tab.getAttribute('aria-selected') === 'true',
        5000,
        `Flow เลือก ${label}`
      );
    }
    return tab;
  }

  // โหมด "ส่วนผสม" ยืนยันจาก DOM จริง 27 ก.ค.: เป็น [role="tab"] กลุ่มเดียวกับ "เฟรม"
  // ligature ไอคอนคือ chrome_extension (เฟรม ใช้ crop_free) และมี 9:16/1x/Omni Flash/8s ครบ
  const ingredientsMode = mode === 'ingredients';
  const modePattern = ingredientsMode
    ? /chrome_extension|ส่วนผสม|Ingredient/i
    : /crop_free|เฟรม|\bFrames?\b/i;
  const modeLabel = ingredientsMode ? 'ส่วนผสม' : 'เฟรม';
  await notify(`กำลังตั้งค่าวิดีโอ: ${modeLabel} · ${VIDEO_MODEL_LABEL} · 9:16 · 1x · 8s`);
  // Do not match the generic words "วิดีโอ/Video": once clip 1 exists, Flow
  // adds a sidebar "ดูวิดีโอ" button before the composer settings button.
  // The crop icon/model name is the stable signature of the real settings.
  const modelButton = byText(CLICKABLE, /crop_(?:9_16|16_9)|Nano Banana|Omni\s*Flash|Omni|Veo|Imagen/i);
  // ⚠️ ปุ่มหน้าตั้งค่ายังต้องจับคำว่า Omni ไว้ด้วย เพราะบัญชีที่ยังค้างโมเดลเดิมอยู่
  // ต้องหาปุ่มเจอก่อน ถึงจะเข้าไปเปลี่ยนเป็น Veo ได้ — ตัดออกเมื่อไรคือหาปุ่มไม่เจอทันที
  if (!modelButton) {
    throw new Error('หาปุ่มเลือกโมเดลไม่เจอ (ดู diagnostic ว่ามีปุ่มอะไรบ้าง)');
  }
  await openPanel(modelButton, 'แผงตั้งค่าโมเดล', () =>
    Boolean(byText('[role="tab"]', /Image|รูปภาพ/i) && byText('[role="tab"]', /Video|วิดีโอ/i))
  );

  await selectRequiredTab(/วิดีโอ|Video/i, 'โหมดวิดีโอ');
  await selectRequiredTab(modePattern, modeLabel);
  await selectRequiredTab(/crop_9_16|9:16/i, '9:16');
  await selectRequiredTab(ONE_OUTPUT_PATTERN, '1x');

  const modelSelector = '[role="menu"] button,[role="menu"] [role="button"],[role="menu"] div[type="button"]';
  let currentModel = byText(modelSelector, /arrow_drop_down/i);
  if (!currentModel) throw new Error('ไม่พบปุ่มเลือกโมเดลวิดีโอ');
  if (!VIDEO_MODEL_PATTERN.test((currentModel.textContent || '').trim())) {
    await openPanel(currentModel, 'รายชื่อโมเดลวิดีโอ', () =>
      Boolean(byText('[role="menuitem"],[role="menuitemradio"],[role="option"]', VIDEO_MODEL_PATTERN))
    );
    const wantedModel = await waitFor(
      () => byText('[role="menuitem"],[role="menuitemradio"],[role="option"]', VIDEO_MODEL_PATTERN),
      5000,
      `ตัวเลือก ${VIDEO_MODEL_LABEL}`
    );
    await humanClick(wantedModel);
    currentModel = await waitFor(
      () => byText(modelSelector, VIDEO_MODEL_PATTERN),
      5000,
      `Flow ยืนยันโมเดล ${VIDEO_MODEL_LABEL}`
    );
  }

  // ตัวเลือกความยาวขึ้นกับโมเดลที่เลือก จึงต้องเลือกโมเดลให้เสร็จก่อนเสมอ
  // ไม่งั้นแท็บ 8s ที่ยังไม่โผล่จะถูกอ่านว่า Flow เปลี่ยน UI
  // ยืนยันในเบราว์เซอร์จริง 3 ส.ค. 2026: Veo 3.1 - Lite [Lower Priority] มี 4s/6s/8s
  // (ไม่มี 10s แต่เราใช้ 8s) — คอมเมนต์เดิมที่ว่าโมเดลนี้ "ซ่อนตัวเลือกความยาว" ล้าสมัยแล้ว
  await selectRequiredTab(/^8s$/i, '8 วินาที');

  const selectedLabels = all('[role="tab"][aria-selected="true"]')
    .map((tab) => (tab.textContent || '').trim().replace(/\s+/g, ' '));
  const requiredSelections = [
    [/วิดีโอ|Video/i, 'วิดีโอ'],
    [modePattern, modeLabel],
    [/crop_9_16|9:16/i, '9:16'],
    [ONE_OUTPUT_PATTERN, '1x'],
    [/^8s$/i, '8s'],
  ];
  const missing = requiredSelections
    .filter(([pattern]) => !selectedLabels.some((label) => pattern.test(label)))
    .map(([, label]) => label);
  if (missing.length) throw new Error(`Flow ยังไม่ได้เลือก ${missing.join(', ')} — หยุดก่อนใช้เครดิต`);

  document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await sleep(400);
  const finalLabel = (modelButton.textContent || '').trim().replace(/\s+/g, ' ');
  if (!/วิดีโอ|Video/i.test(finalLabel) || !/8s/i.test(finalLabel)
      || !/crop_9_16|9:16/i.test(finalLabel) || !ONE_OUTPUT_PATTERN.test(finalLabel)) {
    throw new Error(`ค่าหน้าปุ่มวิดีโอไม่ตรงตามกำหนด: "${finalLabel}"`);
  }
  await notify(`ตั้งค่าวิดีโอสำเร็จ: ${modeLabel} · ${VIDEO_MODEL_LABEL} · 9:16 · 1x · 8s`);
}

async function uploadStartFrame(imageUrl, fileName) {
  // Flow has used both layouts:
  //   1) Frames mode exposes an explicit "เริ่ม / Start" slot.
  //   2) Older layouts expose only the generic "+" media picker.
  // Prefer the explicit slot. The generic picker can attach an image to the
  // prompt while leaving the real Start frame empty, which breaks continuity.
  await notify('เปิดคลังสื่อเพื่ออัปโหลดรูปที่ Gemini เลือก');
  const findStartFrameSlot = () => byText(CLICKABLE, /^(เริ่ม|Start)$/i);
  const findEndFrameSlot = () => byText(CLICKABLE, /^(สิ้นสุด|End)$/i);
  let startFrame = findStartFrameSlot();
  let usedExplicitStartSlot = false;

  if (!startFrame) {
    // A filled Start frame can replace its text slot with a thumbnail and
    // "cancel" icon. Scope the clear button to the Start/End frame controls so
    // we never remove an unrelated prompt attachment.
    const frameControls = findEndFrameSlot()?.parentElement || null;
    const clearStartFrame = frameControls
      ? [...frameControls.querySelectorAll('button')].find((button) =>
        /^cancel$/i.test((button.textContent || '').trim()))
      : null;
    if (clearStartFrame) {
      await notify('ล้าง Start frame เดิมก่อนใส่เฟรมต่อเนื่องของคลิปถัดไป');
      await humanClick(clearStartFrame);
      startFrame = await waitFor(findStartFrameSlot, 5000, 'ช่อง Start frame หลังล้างรูปเดิม');
    }
  }

  if (startFrame) {
    usedExplicitStartSlot = true;
    await humanClick(startFrame);
    await waitFor(
      () => all('[role="dialog"]').length || all('[role="option"]').length || document.querySelector('input[type="file"]'),
      10000,
      'คลังสื่อของ Start frame'
    );
  } else {
    const plusButton = byText(CLICKABLE, /add_2/i);
    if (!plusButton) throw new Error('อยู่โหมด Frames แต่ไม่พบช่อง Start frame หรือปุ่มเปิดคลังสื่อ');
    await openPanel(plusButton, 'คลังสื่อ (ปุ่ม +)');
  }
  const startFrameApplied = () => usedExplicitStartSlot && !findStartFrameSlot();

  // Uploading can re-render Flow and destroy the content-script execution
  // context. On watchdog recovery the same uniquely named asset is already in
  // the library, so reuse it instead of uploading a duplicate.
  const wanted = fileName.toLowerCase();
  const findUploadedOption = () =>
    all('[role="option"]').find((el) => {
      const hay = `${el.textContent || ''} ${el.getAttribute('alt') || ''} ${el.getAttribute('title') || ''}`.toLowerCase();
      return hay.includes(wanted);
    }) || null;

  // ── โหลดรูปจาก Local Service ──
  // จำ option ที่มีอยู่ "ก่อน" อัปโหลด ไว้ตรวจจับตัวใหม่ที่เพิ่งขึ้นคลัง
  // เผื่อ Flow ไม่ยัดชื่อไฟล์ลงใน role="option" (บั๊กที่ทำ #44 ค้าง 60 วิ)
  let priorOptions = new Set();
  if (!findUploadedOption()) {
  await notify('กำลังโหลดรูปที่ Gemini เลือก');
  // ให้ background โหลดแทน content script: Chrome บางรุ่นบล็อก/ค้าง private-network
  // fetch จาก https://labs.google ไป 127.0.0.1 แม้ CORS ถูกต้องแล้วก็ตาม
  // ใช้ callback wrapper ด้วย เพราะ Chrome บาง build คืน `undefined` จาก Promise API
  // ทั้งที่ background ส่ง response กลับมาแล้ว ทำให้บอทหยุดก่อนอัปโหลดโดยไม่มีสาเหตุจริง
  const loaded = await new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'FETCH_LOCAL_IMAGE', url: imageUrl }, (response) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) return resolve({ ok: false, error: runtimeError.message });
      resolve(response);
    });
  });
  if (!loaded?.ok || !loaded.base64) {
    throw new Error(loaded?.error || 'Extension background ไม่ส่งข้อมูลรูปกลับมา');
  }
  const binary = atob(loaded.base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const file = new File([bytes], fileName, { type: loaded.contentType || 'image/jpeg' });

  // ── ยัดไฟล์เข้า input[type=file] ──
  //
  // พอเปิดคลังสื่อแล้ว input[type=file] จะ shown=true (ก่อนหน้านั้น shown=false)
  // ยัดไฟล์ตรงๆ ไม่ต้องกดปุ่ม upload เพราะการกดจะเปิด dialog เลือกไฟล์ของ OS
  // ซึ่ง automate ไม่ได้
  const input = await waitFor(
    () => document.querySelector('input[type="file"]'),
    8000,
    'ช่องอัปโหลดไฟล์ในคลังสื่อ'
  );
  // snapshot ก่อนยัดไฟล์ — option ที่โผล่หลังจากนี้คือรูปที่เพิ่งอัป
  priorOptions = new Set(all('[role="option"]'));
  const transfer = new DataTransfer();
  transfer.items.add(file);
  input.files = transfer.files;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await notify(`อัปโหลด ${fileName} แล้ว — รอขึ้นคลัง`);
  } else {
    await notify(`พบ ${fileName} ในคลังแล้ว — ใช้ไฟล์เดิมเพื่อกู้งาน`);
  }

  // ── รอรูปขึ้นคลังแล้วเลือก ──
  //
  // 🔬 ยืนยันจาก DOM จริง (22 ก.ค. 13:xx, ส่องด้วย Chrome):
  //   role=option = <div role="option" aria-selected="true"> ข้อความเต็ม
  //   "clipbot_job_44_frame_1.jpgรูปภาพ" (ชื่อไฟล์ครบ .jpg — ที่เห็นตัด "...."
  //   เป็นแค่ CSS ellipsis) + ปุ่ม "เพิ่มไปยังพรอมต์" enabled อยู่แล้ว
  //
  // 🐛 เหตุที่ #44/#45 ค้าง "รอรูปใหม่ขึ้นคลัง": ตัวเลือก Start frame เป็น picker
  //   แบบ 2 แท็บ (รูปภาพ / การอัปโหลด) รูปที่อัปไปอยู่แท็บ "การอัปโหลด" แต่ picker
  //   ค้างที่แท็บ "รูปภาพ" → React unmount แท็บที่ไม่ active → role=option ของรูป
  //   ไม่อยู่ใน DOM เลย → querySelectorAll หาไม่เจอ วนจน timeout ทั้งที่ปุ่มเพิ่ม
  //   พร้อมแล้ว (Flow auto-select รูปที่เพิ่งอัปให้)
  //
  // แก้ 3 ชั้น: (1) คลิกแท็บ "การอัปโหลด" บังคับ option เรนเดอร์
  //           (2) รับสัญญาณ "เจอ option" หรือ "ปุ่มเพิ่มพร้อม" อย่างใดอย่างหนึ่ง
  //           (3) ไม่เจอ option แต่ปุ่มพร้อม = auto-select แล้ว → กดเพิ่มตรงๆ
  const findNewOption = () => {
    const fresh = all('[role="option"]').filter((el) => !priorOptions.has(el));
    return fresh[0] || null;
  };
  // 🌐 บัญชี Ultra / Flow ภาษาอังกฤษ: รูปในคลังเรนเดอร์เป็น <img alt="ชื่อไฟล์.jpg">
  //    ไม่ใช่ role="option" และ "ไม่ auto-select" → ปุ่ม "Add to Prompt" เลย disabled ค้าง
  //    (ยืนยันจาก diagnostic #49: tab "Uploads", img alt=clipbot_job_49_frame_1.jpg, ปุ่ม disabled)
  //    ต้องหา img ตามชื่อไฟล์ แล้วคลิก "ตัวที่คลิกได้" (img หรือ ancestor) เพื่อเลือกก่อน
  const findUploadedThumb = () => {
    const img = all('img').find((el) => (el.getAttribute('alt') || '').toLowerCase().includes(wanted));
    if (!img) return null;
    return img.closest('button,[role="button"],[role="option"],[role="gridcell"],[role="listitem"],div[type="button"],[tabindex]') || img;
  };
  const findSelectable = () => findUploadedOption() || findNewOption() || findUploadedThumb();
  // ปุ่มเพิ่ม (enabled เท่านั้น — all() กรอง disabled, บวกเช็ค aria/data-disabled) รองรับทั้งไทย/อังกฤษ
  const hasAddButton = () =>
    all('button,[role="button"],div[type="button"]').find((el) =>
      /เพิ่มไปยังพรอมต์|Add to prompt/i.test((el.textContent || '').trim())
      && el.getAttribute('aria-disabled') !== 'true'
      && el.getAttribute('data-disabled') !== 'true'
      && !el.hasAttribute('disabled')) || null;
  // แท็บ "การอัปโหลด/Uploads" — จำกัด role=tab เท่านั้น กันไปโดนปุ่ม "อัปโหลดสื่อ"
  // (ที่กดแล้วจะเปิด dialog เลือกไฟล์ของ OS ซึ่ง automate ไม่ได้)
  const uploadsTab = () =>
    all('[role="tab"]').find((el) => /การอัปโหลด|Uploads?/i.test((el.textContent || '').trim())) || null;

  // (1) เปิดแท็บ "การอัปโหลด/Uploads" ให้รูปที่เพิ่งอัปเรนเดอร์
  const tab = uploadsTab();
  if (tab && tab.getAttribute('aria-selected') !== 'true') {
    await humanClick(tab);
    await sleep(800);
  }

  // (2) รอ "อย่างใดอย่างหนึ่ง": เจอ option/thumbnail, ปุ่มเพิ่มพร้อม หรือ
  // Flow ใส่ Start frame แล้วปิด picker อัตโนมัติ (พบใน Ultra/English)
  let selectable = null;
  await waitFor(() => {
    selectable = findSelectable();
    return startFrameApplied() || selectable || hasAddButton();
  }, 60000, 'รูปขึ้นคลังสื่อ (Start frame, option/thumbnail หรือปุ่มเพิ่มไปยังพรอมต์)');

  // (3) เจอ option/thumbnail → คลิกเลือกถ้ายังไม่ถูกเลือก; ไม่เจอแต่ปุ่มพร้อม = auto-select แล้ว
  if (selectable) {
    const selected = selectable.getAttribute('aria-selected') === 'true'
      || selectable.getAttribute('data-state') === 'checked';
    if (!selected) {
      await humanClick(selectable);
      await sleep(500);
    }
  } else {
    await notify('รูป auto-select แล้ว — เพิ่มเข้าพรอมต์โดยตรง');
  }

  // Flow อาจใช้เวลาประมวลผลเฟรมเกิน 30 วินาทีก่อนเปิดปุ่มเพิ่ม
  // ส่งสถานะเป็นระยะเพื่อไม่ให้ watchdog เข้าใจว่า content script หายไป
  let addToPrompt = null;
  const addStartedAt = Date.now();
  while (!addToPrompt && !startFrameApplied() && Date.now() - addStartedAt < 180000) {
    addToPrompt = hasAddButton();
    if (addToPrompt) break;
    const elapsedSeconds = Math.round((Date.now() - addStartedAt) / 1000);
    await notify(`Flow กำลังประมวลผลเฟรมต้น (${elapsedSeconds}s) — รอปุ่มเพิ่มไปยังพรอมต์`);
    await sleep(15000);
  }
  if (startFrameApplied()) {
    await notify('Flow ใส่รูปเป็น Start frame และปิดคลังให้อัตโนมัติ');
    await sleep(700);
    return;
  }
  if (!addToPrompt) {
    throw new Error('รอหน้าจอ Flow นานเกินกำหนด: ปุ่มเพิ่มไปยังพรอมต์หลังประมวลผลเฟรม 180s');
  }
  await humanClick(addToPrompt);

  // ยืนยันคลังปิดด้วย "ปุ่มเพิ่มไปยังพรอมต์หายไป" แทนการเช็ค !all('[role="dialog"]')
  // — เพราะคลังอาจไม่ใช่ dialog เลย (เงื่อนไข !dialog อาจจริงตั้งแต่แรกแล้วข้ามเร็วเกิน)
  await waitFor(() => !hasAddButton(), 15000, 'คลังสื่อปิดหลังเพิ่มรูป').catch(() => null);
  if (usedExplicitStartSlot) {
    await waitFor(startFrameApplied, 15000, 'รูปปรากฏในช่อง Start frame');
  }
  await sleep(700);
  await notify('เลือกรูปเป็น Start frame แล้ว');
}

/**
 * แนบ "ส่วนผสม" ทีละรูป — โหมด Ingredients-to-Video
 *
 * 🔬 ยืนยันจาก DOM จริง 27 ก.ค. 15:58 (ส่องด้วย Chrome ของเจ้าของ ไม่ได้กด Generate):
 *   - โหมดนี้ "ไม่มี" ช่อง เริ่ม/สิ้นสุด เหมือนโหมดเฟรม มีแต่ปุ่ม add_2 เปิดคลังสื่อ
 *   - input[type=file] มี multiple=true ก็จริง แต่ของจริงยัดทีเดียวหลายไฟล์แล้วเพี้ยน
 *     (เจ้าของยืนยันจากหน้างาน) จึงต้องอัปทีละรูปเท่านั้น
 *   ดูรายละเอียดเต็มที่ data/flow-diagnostic-ingredients.json
 */
async function uploadIngredients(imageUrls, jobId) {
  // ⚠️ ต้องแนบ "ทีละรูป" เท่านั้น (เจ้าของสั่ง 27 ก.ค. 2026)
  //
  // เวอร์ชันแรกผมยัดทั้ง 4 ไฟล์เข้า input[type=file] ทีเดียวเพราะเห็นว่า multiple=true
  // แต่ของจริง Flow ประมวลผลไม่ทัน/เลือกให้ไม่ครบ แล้วสถานะคลังสื่อเพี้ยน
  // uploadStartFrame คือเส้นทางเดิมที่พิสูจน์แล้วว่านิ่ง: เปิดคลัง → อัป 1 ไฟล์ → รอขึ้นคลัง
  // → เลือก → กด "เพิ่มไปยังพรอมต์" ในโหมดส่วนผสมไม่มีช่อง Start frame มันจึงตกไปใช้
  // ปุ่ม add_2 เองอัตโนมัติ = ตรงกับที่ต้องการพอดี
  await notify(`เตรียมแนบส่วนผสม ${imageUrls.length} รูป (ทีละรูป)`);
  for (let index = 0; index < imageUrls.length; index++) {
    await uploadStartFrame(imageUrls[index], `clipbot_job_${jobId}_ingredient_${index + 1}.jpg`);
    await notify(`แนบส่วนผสม ${index + 1}/${imageUrls.length} แล้ว`);
    await sleep(1200);
  }
  await notify(`แนบส่วนผสมครบ ${imageUrls.length} รูปแล้ว`);
}

/**
 * อัปโหลดรูปเข้า "ช่อง End frame" (สิ้นสุด) ของ Flow — โหมด Frames-to-Video
 *
 * ⚠️ OPT-IN + DORMANT: เรียกเฉพาะเมื่อ background ส่ง job.endImageUrl มาเท่านั้น
 * (generateClip เช็ค `if (job.endImageUrl)`) ถ้าไม่มี = ทำงานเหมือนเดิมทุกอย่าง
 * ยังไม่ผ่านการทดสอบกับ Flow จริง — ต้อง dry-run กับรูปจริงก่อนเปิดใช้งานจริง
 *
 * ทำไมต้องมี: ตอนนี้ Veo ได้แค่ Start frame รูปเดียว พอสินค้าพลิกมันต้อง "เดา"
 * ด้านที่มองไม่เห็น → warp/แปลกๆ. ใส่ End frame (มุมที่อยากเผย) ให้ Veo
 * interpolate ระหว่าง 2 เฟรมจริง = ลื่นและตรงสินค้าจริง
 *
 * โครงสร้าง mirror uploadStartFrame แต่ target ช่อง End และไม่แตะ Start frame
 */
async function uploadEndFrame(imageUrl, fileName) {
  await notify('เปิดคลังสื่อเพื่อใส่ End frame (มุมที่อยากเผย)');
  const findEndSlot = () => byText(CLICKABLE, /^(สิ้นสุด|End)$/i);
  let endSlot = findEndSlot();
  if (!endSlot) {
    // ช่อง End ที่ถูกเติมแล้วจะกลายเป็น thumbnail + ปุ่ม cancel — ล้างเฉพาะของช่อง End
    // (scope ที่ parent ของช่อง End เอง กัน cancel ของ Start frame โดยไม่ตั้งใจ)
    // TODO(live): ยืนยันโครง DOM ปุ่ม cancel ของช่อง End ตอน dry-run กับ Flow จริง
    const startSlot = byText(CLICKABLE, /^(เริ่ม|Start)$/i);
    const frameControls = (findEndSlot() || startSlot)?.parentElement || null;
    const clearEndFrame = frameControls
      ? [...frameControls.querySelectorAll('button')].filter((button) =>
        /^cancel$/i.test((button.textContent || '').trim())).pop() || null
      : null;
    if (clearEndFrame) {
      await notify('ล้าง End frame เดิมก่อนใส่เฟรมใหม่');
      await humanClick(clearEndFrame);
      endSlot = await waitFor(findEndSlot, 5000, 'ช่อง End frame หลังล้างรูปเดิม');
    }
  }
  if (!endSlot) {
    // ไม่มีช่อง End (โหมดไม่รองรับ / layout ต่าง) → ข้ามไปโดยไม่ทำให้งานล้ม
    await notify('ไม่พบช่อง End frame — ข้าม (ใช้ Start frame อย่างเดียวเหมือนเดิม)');
    return;
  }

  await humanClick(endSlot);
  await waitFor(
    () => all('[role="dialog"]').length || all('[role="option"]').length || document.querySelector('input[type="file"]'),
    10000,
    'คลังสื่อของ End frame'
  );
  const endFrameApplied = () => !findEndSlot();

  const wanted = fileName.toLowerCase();
  const findUploadedOption = () =>
    all('[role="option"]').find((el) => {
      const hay = `${el.textContent || ''} ${el.getAttribute('alt') || ''} ${el.getAttribute('title') || ''}`.toLowerCase();
      return hay.includes(wanted);
    }) || null;

  let priorOptions = new Set();
  if (!findUploadedOption()) {
    await notify('กำลังโหลดรูป End frame');
    const loaded = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'FETCH_LOCAL_IMAGE', url: imageUrl }, (response) => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) return resolve({ ok: false, error: runtimeError.message });
        resolve(response);
      });
    });
    if (!loaded?.ok || !loaded.base64) {
      throw new Error(loaded?.error || 'Extension background ไม่ส่งข้อมูลรูป End frame กลับมา');
    }
    const binary = atob(loaded.base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const file = new File([bytes], fileName, { type: loaded.contentType || 'image/jpeg' });
    const input = await waitFor(
      () => document.querySelector('input[type="file"]'),
      8000,
      'ช่องอัปโหลดไฟล์ในคลังสื่อ (End frame)'
    );
    priorOptions = new Set(all('[role="option"]'));
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await notify(`อัปโหลด ${fileName} (End frame) แล้ว — รอขึ้นคลัง`);
  } else {
    await notify(`พบ ${fileName} ในคลังแล้ว — ใช้ไฟล์เดิมเป็น End frame`);
  }

  const findNewOption = () => {
    const fresh = all('[role="option"]').filter((el) => !priorOptions.has(el));
    return fresh[0] || null;
  };
  const findUploadedThumb = () => {
    const img = all('img').find((el) => (el.getAttribute('alt') || '').toLowerCase().includes(wanted));
    if (!img) return null;
    return img.closest('button,[role="button"],[role="option"],[role="gridcell"],[role="listitem"],div[type="button"],[tabindex]') || img;
  };
  const findSelectable = () => findUploadedOption() || findNewOption() || findUploadedThumb();
  const hasAddButton = () =>
    all('button,[role="button"],div[type="button"]').find((el) =>
      /เพิ่มไปยังพรอมต์|Add to prompt/i.test((el.textContent || '').trim())
      && el.getAttribute('aria-disabled') !== 'true'
      && el.getAttribute('data-disabled') !== 'true'
      && !el.hasAttribute('disabled')) || null;
  const uploadsTab = () =>
    all('[role="tab"]').find((el) => /การอัปโหลด|Uploads?/i.test((el.textContent || '').trim())) || null;

  const tab = uploadsTab();
  if (tab && tab.getAttribute('aria-selected') !== 'true') {
    await humanClick(tab);
    await sleep(800);
  }

  let selectable = null;
  await waitFor(() => {
    selectable = findSelectable();
    return endFrameApplied() || selectable || hasAddButton();
  }, 60000, 'รูปขึ้นคลังสื่อ (End frame, option/thumbnail หรือปุ่มเพิ่มไปยังพรอมต์)');

  if (selectable) {
    const selected = selectable.getAttribute('aria-selected') === 'true'
      || selectable.getAttribute('data-state') === 'checked';
    if (!selected) {
      await humanClick(selectable);
      await sleep(500);
    }
  } else {
    await notify('รูป End frame auto-select แล้ว — เพิ่มเข้าพรอมต์โดยตรง');
  }

  let addToPrompt = null;
  const addStartedAt = Date.now();
  while (!addToPrompt && !endFrameApplied() && Date.now() - addStartedAt < 180000) {
    addToPrompt = hasAddButton();
    if (addToPrompt) break;
    const elapsedSeconds = Math.round((Date.now() - addStartedAt) / 1000);
    await notify(`Flow กำลังประมวลผล End frame (${elapsedSeconds}s) — รอปุ่มเพิ่มไปยังพรอมต์`);
    await sleep(15000);
  }
  if (endFrameApplied()) {
    await notify('Flow ใส่รูปเป็น End frame และปิดคลังให้อัตโนมัติ');
    await sleep(700);
    return;
  }
  if (!addToPrompt) {
    throw new Error('รอหน้าจอ Flow นานเกินกำหนด: ปุ่มเพิ่มไปยังพรอมต์ (End frame) หลังประมวลผล 180s');
  }
  await humanClick(addToPrompt);
  await waitFor(() => !hasAddButton(), 15000, 'คลังสื่อปิดหลังเพิ่ม End frame').catch(() => null);
  await waitFor(endFrameApplied, 15000, 'รูปปรากฏในช่อง End frame').catch(() => null);
  await sleep(700);
  await notify('เลือกรูปเป็น End frame แล้ว');
}

/** ปุ่มส่ง (arrow_forward) — ถ้ามันยัง disabled แปลว่า Flow ยังไม่รับ prompt */
function submitButton() {
  return all('button,[role="button"]').find((b) => {
    if (b.getAttribute('aria-haspopup')) return false;
    const text = `${b.textContent || ''} ${b.getAttribute('aria-label') || ''}`;
    return /arrow_forward/i.test(text);
  }) || null;
}

/** Flow รับ prompt แล้วจริงไหม — ดูจากปุ่มส่งว่าเลิก disabled หรือยัง */
function promptAccepted() {
  const button = submitButton();
  if (!button) return false;
  return button.getAttribute('aria-disabled') !== 'true' && !button.disabled;
}

/** เลือกข้อความในช่องทั้งหมดแล้วลบ */
function clearEditor(editor) {
  editor.focus();
  const range = document.createRange();
  range.selectNodeContents(editor);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  document.execCommand('delete', false);
}

/**
 * ใส่ Motion Prompt ลงช่องของ Flow
 *
 * ⚠️ ห้ามยัดข้อความเข้า DOM ตรงๆ (editor.value = x หรือ textContent = x)
 *
 * ช่อง prompt ของ Flow เป็น contenteditable ที่เก็บ state ไว้ข้างในตัวเอง (Lexical)
 * การยัด DOM ตรงๆ ทำให้ "ตาเห็นข้อความ แต่ editor ไม่รู้จัก" ผลคือ:
 *   - กด Generate แล้ว Flow ฟ้อง "ต้องระบุพรอมต์"
 *   - ปุ่มส่งยัง disabled (สีดำ)
 *   - ลบข้อความนั้นด้วยมือไม่ได้ เพราะ editor ไม่รู้ว่ามีอยู่
 * (ยืนยันจากผู้ใช้ทดสอบด้วยมือเอง — วางเองแล้วใช้ได้ แต่ของบอทใช้ไม่ได้)
 *
 * ต้องจำลอง "การวาง" ให้ editor ประมวลผลเอง แล้วยืนยันด้วยปุ่มส่งว่าติดจริง
 */
async function fillPrompt(prompt, jobId) {
  await notify('กำลังใส่ Motion Prompt ใน Flow');
  const editor = await waitFor(() =>
    all('textarea,[role="textbox"],[contenteditable="true"]').find((element) =>
      !element.closest('[aria-hidden="true"]')
    ), 15000, 'ช่อง Motion Prompt');

  // ช่องแบบ <textarea>/<input> จริงๆ — ต้องยิงผ่าน native setter ให้ React เห็น
  // Flow's Lexical editor accepts real keyboard input, not synthetic paste/DOM injection.
  //
  // ⚠️ typePromptLikeKeyboard มี Ctrl+A + Backspace ล้างช่องให้อยู่แล้ว แต่จะได้ผลก็ต่อเมื่อ
  // "เคอร์เซอร์อยู่ในช่องจริง" — job #107: หลังกด "เพิ่มไปยังพรอมต์" โฟกัสยังค้างที่ปุ่ม
  // element.focus() บน Lexical ไม่พอที่จะวางเคอร์เซอร์ → Ctrl+A ไปเลือกอย่างอื่น Backspace
  // ไม่ลบอะไร แล้ว insertText ไปต่อท้ายพรอมต์เดิม กลายเป็น "พรอมต์รูป + พรอมต์คลิป" ติดกัน
  // แก้: คลิกเข้าไปในช่องด้วยเมาส์จริงก่อน แล้วค่อยพิมพ์
  editor.focus();
  await trustedClick(editor).catch(() => { editor.focus(); });
  await sleep(300);
  const typed = await chrome.runtime.sendMessage({ type: 'TYPE_PROMPT', prompt, jobId });
  if (!typed?.ok) throw new Error(typed?.error || 'Keyboard typing failed');
  await waitFor(promptAccepted, 10000, 'Generate button after keyboard typing');

  // ด่านสุดท้ายก่อนจ่ายเครดิต: ช่องต้องมีแค่พรอมต์ที่เราเพิ่งพิมพ์เท่านั้น
  // ถ้ายาวเกินมากแปลว่าล้างไม่สำเร็จและมีพรอมต์เก่าค้างอยู่ — หยุดดีกว่าเจนด้วยพรอมต์มั่ว
  const boxText = (editor.innerText || editor.value || '').replace(/\s+/g, ' ').trim();
  const expected = [...prompt.replace(/\s+/g, ' ').trim()].length;
  if (boxText.length > expected * 1.3 + 40) {
    throw new Error(
      `ช่องพรอมต์มีข้อความค้างจากขั้นก่อน (${boxText.length} ตัว แต่ควรราว ${expected}) — หยุดก่อนใช้เครดิต`
    );
  }
  await notify('Motion Prompt typed character-by-character; Generate is enabled');
  return;

  const nativeInput = (element, value) => {
    const proto = element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    setter ? setter.call(element, value) : (element.value = value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  };

  const strategies = [
    // 1) จำลองการวาง (paste) — ผู้ใช้ยืนยันว่าวางเองแล้ว Flow รับ
    {
      name: 'paste',
      run: () => {
        clearEditor(editor);
        const data = new DataTransfer();
        data.setData('text/plain', prompt);
        editor.dispatchEvent(new ClipboardEvent('paste', {
          bubbles: true, cancelable: true, clipboardData: data,
        }));
      },
    },
    // 2) beforeinput แบบ insertFromPaste — Lexical/ProseMirror ฟัง event นี้โดยตรง
    {
      name: 'beforeinput',
      run: () => {
        clearEditor(editor);
        const data = new DataTransfer();
        data.setData('text/plain', prompt);
        editor.dispatchEvent(new InputEvent('beforeinput', {
          bubbles: true, cancelable: true, inputType: 'insertFromPaste', dataTransfer: data,
        }));
      },
    },
    // 3) execCommand — ให้เบราว์เซอร์เป็นคนแทรกเอง (จะยิง beforeinput/input ให้ครบ)
    {
      name: 'execCommand',
      run: () => {
        clearEditor(editor);
        document.execCommand('insertText', false, prompt);
      },
    },
    // 4) native setter — สำหรับกรณีที่เป็น textarea/input จริง
    {
      name: 'nativeSetter',
      run: () => { if ('value' in editor) nativeInput(editor, prompt); },
    },
  ];

  for (const strategy of strategies) {
    strategy.run();
    await sleep(700);
    if (promptAccepted()) {
      await notify(`ใส่ prompt สำเร็จ (วิธี: ${strategy.name})`);
      return;
    }
    await notify(`วิธี "${strategy.name}" ไม่ติด — ลองวิธีถัดไป`);
  }

  throw new Error(
    'ใส่ prompt แล้วปุ่มส่งยัง disabled — Flow ไม่รับ prompt (ลองครบทุกวิธีแล้ว) — ดู diagnostic'
  );
}

function videoUrls() {
  const found = new Map();
  const nodes = document.querySelectorAll(
    'video,source,img[src*="getMediaUrlRedirect"]'
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
    if (!isVideo) continue;
    let key = url;
    try { key = new URL(url).searchParams.get('name') || url; } catch (_) {}
    const priority = /^(VIDEO|SOURCE)$/.test(node.tagName)
      ? 3
      : /mediaUrlType=MEDIA_URL_TYPE_THUMBNAIL/i.test(url)
        ? 1
        : 2;
    const previous = found.get(key);
    if (!previous || priority > previous.priority) {
      found.set(key, { url, priority });
    }
  }
  return [...found.values()].map((item) => item.url);
}

function imageUrls() {
  const found = new Map();
  for (const node of document.querySelectorAll('img[src*="getMediaUrlRedirect"]')) {
    const raw = node.currentSrc || node.getAttribute('src') || '';
    if (!raw) continue;
    if (node.naturalWidth && node.naturalWidth < 128) continue;
    if (node.naturalHeight && node.naturalHeight < 128) continue;
    let url;
    try { url = new URL(raw, location.href).href; } catch (_) { continue; }
    let key = url;
    try { key = new URL(url).searchParams.get('name') || url; } catch (_) {}
    const priority = /mediaUrlType=MEDIA_URL_TYPE_THUMBNAIL/i.test(url) ? 1 : 2;
    const previous = found.get(key);
    if (!previous || priority > previous.priority) found.set(key, { url, priority });
  }
  return [...found.values()].map((item) => item.url);
}

/**
 * ตรวจว่าหน้า Flow crash หรือยัง (React error boundary ของ Next.js)
 *
 * labs.google เป็น Labs beta พังเองบ่อย โดยเฉพาะตอนโหลดหนักๆ หรือ session ใกล้หมด
 * ขึ้นข้อความ "Application error: a client-side exception has occurred"
 * ถ้าไม่กันไว้ บอทจะไปหาปุ่มบนหน้าที่พังแล้ว timeout ตายทั้งที่แค่ refresh ก็หาย
 */
function isFlowCrashed() {
  const text = document.body?.innerText || '';
  return /client-side exception has occurred|Application error:/i.test(text);
}

/**
 * กู้หน้าที่ crash ด้วยการ reload — แต่กัน reload วนไม่รู้จบ
 *
 * reload แล้ว content script ตาย → background (chrome.tabs.onUpdated) จะ re-inject
 * แล้วส่งงานเดิมกลับมาให้ทำต่อเอง ถ้า reload แล้วยัง crash อีก = ปัญหาจริง (session หมด?)
 * ต้องหยุดแล้วบอกคน ไม่ใช่ reload ไปเรื่อยๆ
 */
async function recoverIfCrashed() {
  const KEY = 'clipbotReloadCount';
  if (!isFlowCrashed()) {
    // หน้าปกติ = คืน budget reload ให้เต็ม เผื่อ crash รอบหน้า
    sessionStorage.removeItem(KEY);
    return false;
  }

  const count = Number(sessionStorage.getItem(KEY) || '0');
  if (count >= 2) {
    // reload 2 ครั้งแล้วยัง crash — session น่าจะหมด ต้อง login ใหม่
    throw new Error('หน้า Flow crash ซ้ำหลัง reload 2 ครั้ง — น่าจะ session หมดอายุ ต้อง login Google ใหม่');
  }
  sessionStorage.setItem(KEY, String(count + 1));
  await notify(`หน้า Flow crash — กำลัง refresh กู้อัตโนมัติ (ครั้งที่ ${count + 1})`);
  await sleep(500);
  location.reload();
  await sleep(10000); // รอ reload — content script จะตายระหว่างนี้
  return true;
}

async function generateImage(job) {
  if (working) return;
  const paidKey = paidStepKey(job, 'image');
  if (submittedInThisPage.has(paidKey)) {
    await notify(`งาน #${job.jobId}: ขั้นเจนรูปนี้กด Generate ไปแล้วในหน้านี้ — ไม่ทำซ้ำ`);
    return;
  }
  working = true;
  try {
    if (await recoverIfCrashed()) return;
    const imageRole = job.imageRole === 'end' ? 'end' : 'start';
    await notify(imageRole === 'end'
      ? `Job #${job.jobId}: preparing the matching end frame`
      : `Job #${job.jobId}: preparing the hand-held product image`);
    await enterEditor(job);
    await configureImage();
    await uploadStartFrame(
      job.imageUrl,
      `clipbot_job_${job.jobId}_${imageRole === 'end' ? 'generated_start_reference' : 'product_reference'}.jpg`
    );
    // วิธี A: แนบรูปสินค้าทางการ "มุมอื่น" เพิ่มเป็น reference ให้โมเดลเห็นทรงจริงหลายด้าน
    // → ลดอาการสินค้าเพี้ยน/วาร์ปตอนเจนคลิป (ทำงานร่วมกับ End-frame วิธี B)
    // ⚠️ ห้ามทำให้งานพัง: แนบไม่สำเร็จให้เดินต่อด้วยรูปหลักรูปเดียว = พฤติกรรมเดิม
    const extraRefs = Array.isArray(job.referenceImageUrls) ? job.referenceImageUrls : [];
    for (let index = 0; index < extraRefs.length; index++) {
      try {
        await uploadStartFrame(extraRefs[index], `clipbot_job_${job.jobId}_ref_${index + 1}.jpg`);
        await notify(`Job #${job.jobId}: แนบรูปมุมเสริม ${index + 1}/${extraRefs.length} แล้ว`);
      } catch (error) {
        await notify(`แนบรูปมุมเสริมไม่สำเร็จ (${index + 1}/${extraRefs.length}) — ใช้รูปหลักต่อ`);
        break;
      }
    }
    await fillPrompt(job.prompt, job.jobId);
    const before = new Set(imageUrls());
    // Flow resolves an uploaded asset through several redirect URLs. Merge a
    // second snapshot so a late-settling reference URL cannot look like output.
    await sleep(1200);
    for (const url of imageUrls()) before.add(url);
    const failedBefore = failedGenerationCardCount();
    const generate = await waitFor(() =>
      all('button,[role="button"]').find((button) => {
        if (button.getAttribute('aria-haspopup')) return false;
        if (button.getAttribute('aria-disabled') === 'true' || button.disabled) return false;
        const text = `${button.textContent || ''} ${button.getAttribute('aria-label') || ''}`;
        return /arrow_forward|^\s*Generate\b/i.test(text);
      }), 15000, 'image Generate button');
    if (!await generationIsAuthorized(job)) {
      await notify(`Job #${job.jobId}: stopped before the paid image Generate click`);
      return;
    }
    const armed = await chrome.runtime.sendMessage({
      type: 'FLOW_ARM_WATCH',
      mediaType: 'image',
      jobId: job.jobId,
      clipIndex: 0,
      imageRole,
      before: [...before],
      failedBefore,
    });
    if (!armed?.ok) throw new Error(armed?.error || 'Could not arm the generated-image watcher');
    await trustedClick(generate, { windowsCursor: true });
    await confirmGenerateAccepted(generate, () => trustedClick(generate, { windowsCursor: true }));
    submittedInThisPage.add(paidKey);
    await notify(`Job #${job.jobId}: ${imageRole} image generation submitted — duplicate clicks are blocked`);
  } catch (error) {
    await chrome.runtime.sendMessage({
      type: 'FLOW_ERROR',
      jobId: job.jobId,
      clipIndex: 0,
      stage: 'image',
      imageRole: job.imageRole === 'end' ? 'end' : 'start',
      message: error.message,
      url: location.href,
      ui: snapshotUi(),
    });
  } finally {
    working = false;
  }
}

async function generateClip(job) {
  if (working) return;
  const paidKey = paidStepKey(job, 'video');
  if (submittedInThisPage.has(paidKey)) {
    await notify(`งาน #${job.jobId}: คลิป ${job.clipIndex + 1} กด Generate ไปแล้วในหน้านี้ — ไม่ทำซ้ำ`);
    return;
  }
  working = true;
  try {
    // กู้ก่อนถ้าหน้า crash — ถ้า reload มันจะ return แล้ว background ส่งงานกลับมาใหม่หลังโหลดเสร็จ
    if (await recoverIfCrashed()) return;

    await notify(`งาน #${job.jobId}: เตรียมคลิป ${job.clipIndex + 1} จาก ${job.clipCount || 3}`);
    await enterEditor(job);
    // คลิป 1 = โหมดส่วนผสม (รูปที่เจน + รูปทางการหลายมุม) / คลิปถัดไป = โหมดเฟรม
    // เพราะคลิปถัดไปต้องต่อจาก "เฟรมสุดท้ายของคลิปก่อนหน้า" ซึ่งมีแต่โหมดเฟรมที่ทำได้
    // ไม่มี ingredientUrls = ทำงานแบบเดิมทุกประการ (backward-compatible)
    const useIngredients = Array.isArray(job.ingredientUrls) && job.ingredientUrls.length > 0;
    await configureVideo(useIngredients ? 'ingredients' : 'frames');
    if (useIngredients) {
      await uploadIngredients(job.ingredientUrls, job.jobId);
    } else {
      await uploadStartFrame(job.imageUrl, `clipbot_job_${job.jobId}_frame_${job.clipIndex + 1}.jpg`);
      // OPT-IN: ใส่ End frame เฉพาะเมื่อ background ส่ง endImageUrl (โหมด Frames-to-Video)
      // ไม่มี = ทำงานเหมือนเดิม (Start frame อย่างเดียว) — backward-compatible 100%
      if (job.endImageUrl) {
        await uploadEndFrame(job.endImageUrl, `clipbot_job_${job.jobId}_end_${job.clipIndex + 1}.jpg`);
      }
    }
    await fillPrompt(job.prompt, job.jobId);
    const before = new Set(videoUrls());
    const failedBefore = failedGenerationCardCount();
    await notify(`งาน #${job.jobId}: พร้อมกดสร้างคลิป ${job.clipIndex + 1}`);
    // ⚠️ ห้ามจับด้วยคำว่า "สร้าง" เฉยๆ เด็ดขาด!
    //
    // DOM จริงมีปุ่มที่ข้อความลงท้ายด้วย "สร้าง" อยู่ 2 ตัว และตัวที่มาก่อนคือปุ่มผิด:
    //   1. "add_2สร้าง"          (aria-haspopup="dialog") = ปุ่ม + เปิดคลังสื่อ  ← .find() คว้าตัวนี้
    //   2. "arrow_forwardสร้าง"  (ไม่มี haspopup)          = ปุ่มส่งตัวจริง
    // ผลคือบอทกดปุ่ม + แล้วรอวิดีโอ 6 นาทีเก้อ ทั้งที่ไม่เคยส่งอะไรเลย
    //
    // "arrow_forward" คือไอคอนของปุ่มส่งโดยเฉพาะ ใช้เป็นตัวจับได้แม่นกว่า
    // และตัดปุ่มที่เปิดป๊อปอัปทิ้งไปเลย เพราะปุ่มส่งไม่มีทางเปิดป๊อปอัป
    const generate = await waitFor(() =>
      all('button,[role="button"]').find((button) => {
        if (button.getAttribute('aria-haspopup')) return false;
        if (button.getAttribute('aria-disabled') === 'true' || button.disabled) return false;
        const text = `${button.textContent || ''} ${button.getAttribute('aria-label') || ''}`;
        return /arrow_forward|^\s*Generate\b|^\s*สร้างวิดีโอ/i.test(text);
      }), 15000, 'ปุ่มส่ง (arrow_forward)');
    // Persist the watcher checkpoint before the paid click. Flow can re-render
    // this page immediately after Generate; arming afterwards creates a race
    // where the click succeeds but nobody ever observes the resulting video.
    if (!await generationIsAuthorized(job)) {
      await notify(`Job #${job.jobId}: stopped before the paid video Generate click`);
      return;
    }
    const armed = await chrome.runtime.sendMessage({
      type: 'FLOW_ARM_WATCH',
      mediaType: 'video',
      jobId: job.jobId,
      clipIndex: job.clipIndex,
      before: [...before],
      failedBefore,
    });
    if (!armed?.ok) throw new Error(armed?.error || 'เปิดตัวเฝ้าผลวิดีโอไม่สำเร็จ — ยังไม่ได้กด Generate');

    await trustedClick(generate, { windowsCursor: true });
    await confirmGenerateAccepted(generate, () => trustedClick(generate, { windowsCursor: true }));
    submittedInThisPage.add(paidKey);
    await notify(`งาน #${job.jobId}: ส่งสร้างคลิป ${job.clipIndex + 1} แล้ว — จะไม่กดซ้ำ`);

    // background already owns the durable watcher; content script can now be
    // destroyed/re-rendered without losing the paid result.
  } catch (error) {
    // แนบภาพ DOM ไปด้วยเสมอ — เวลาพังจะได้รู้ทันทีว่า Flow เรนเดอร์อะไรอยู่
    // ไม่ต้องให้คนไปเปิด DevTools ไล่ดูเอง
    await chrome.runtime.sendMessage({
      type: 'FLOW_ERROR',
      jobId: job.jobId,
      clipIndex: job.clipIndex,
      stage: 'video',
      message: error.message,
      url: location.href,
      ui: snapshotUi(),
    });
  } finally {
    working = false;
  }
}

function mountFloatingControl() {
  if (document.getElementById('clipbot-floating-control')) return;

  const host = document.createElement('div');
  host.id = 'clipbot-floating-control';
  host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483600;';
  const shadow = host.attachShadow({ mode: 'open' });
  const iconUrl = chrome.runtime.getURL('icons/icon32.png');
  shadow.innerHTML = `
    <style>
      :host {
        --cb-bg: hsl(214 46% 9%);
        --cb-panel: hsl(213 42% 12%);
        --cb-soft: hsl(212 31% 17%);
        --cb-line: hsl(210 27% 28%);
        --cb-text: hsl(210 40% 97%);
        --cb-muted: hsl(211 18% 67%);
        --cb-red: hsl(1 93% 65%);
        --cb-green: hsl(151 70% 56%);
        --cb-amber: hsl(39 92% 62%);
        font-family: "Noto Sans Thai", "Leelawadee UI", "Segoe UI", sans-serif;
        color: var(--cb-text);
        -webkit-font-smoothing: antialiased;
        text-rendering: optimizeLegibility;
      }
      * { box-sizing: border-box; }
      button { font: inherit; }
      button:focus-visible {
        outline: 3px solid hsl(196 90% 60% / .9);
        outline-offset: 2px;
      }
      .fab {
        min-width: 56px;
        height: 56px;
        padding: 0 16px;
        border: 1px solid hsl(1 93% 68% / .65);
        border-radius: 18px;
        color: white;
        background: hsl(214 46% 9% / .96);
        box-shadow: 0 2px 5px hsl(220 50% 2% / .34), 0 12px 32px hsl(220 50% 2% / .5);
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 9px;
        cursor: pointer;
        transition: transform 120ms cubic-bezier(.23,1,.32,1), border-color 120ms, background-color 120ms;
      }
      .fab:active, .action:active, .icon-button:active { transform: scale(.97); }
      .fab-mark {
        width: 28px;
        height: 28px;
        border-radius: 9px;
        display: grid;
        place-items: center;
        overflow: hidden;
        background: hsl(214 46% 9%);
      }
      .fab-mark img { width: 100%; height: 100%; display: block; object-fit: cover; }
      .fab-label { font-size: 14px; font-weight: 750; letter-spacing: -.01em; }
      .panel {
        position: absolute;
        right: 0;
        bottom: 68px;
        width: min(328px, calc(100vw - 24px));
        padding: 8px;
        border: 1px solid hsl(210 27% 30% / .82);
        border-radius: 22px;
        background: hsl(214 46% 8% / .97);
        box-shadow: 0 4px 12px hsl(220 50% 2% / .32), 0 24px 64px hsl(220 50% 2% / .62);
        transform-origin: right bottom;
        transition: opacity 180ms cubic-bezier(.23,1,.32,1), transform 180ms cubic-bezier(.23,1,.32,1);
        backdrop-filter: blur(18px);
      }
      .panel[hidden] { display: block; opacity: 0; transform: translateY(8px) scale(.96); pointer-events: none; }
      .panel-card { border-radius: 14px; background: var(--cb-panel); overflow: hidden; }
      .header {
        min-height: 64px;
        padding: 12px 12px 12px 14px;
        display: flex;
        align-items: center;
        gap: 11px;
        border-bottom: 1px solid var(--cb-line);
      }
      .brand { flex: 1; min-width: 0; }
      .title { font-size: 16px; line-height: 1.2; font-weight: 780; letter-spacing: -.02em; }
      .eyebrow { margin-top: 3px; color: var(--cb-muted); font-size: 11px; font-weight: 650; letter-spacing: .08em; text-transform: uppercase; }
      .icon-button {
        width: 44px;
        height: 44px;
        border: 0;
        border-radius: 12px;
        color: var(--cb-muted);
        background: transparent;
        cursor: pointer;
      }
      .status-wrap { padding: 14px; }
      .state-row { display: flex; align-items: center; gap: 8px; margin-bottom: 9px; }
      .dot { width: 9px; height: 9px; border-radius: 999px; background: var(--cb-muted); box-shadow: 0 0 0 4px hsl(211 18% 67% / .1); }
      .dot.running { background: var(--cb-green); box-shadow: 0 0 0 4px hsl(151 70% 56% / .12); }
      .dot.locked { background: var(--cb-amber); box-shadow: 0 0 0 4px hsl(39 92% 62% / .12); }
      .state-label { font-size: 13px; font-weight: 720; }
      .job { margin-left: auto; color: var(--cb-muted); font-size: 12px; font-variant-numeric: tabular-nums; }
      .message { min-height: 42px; color: hsl(210 28% 88%); font-size: 13px; line-height: 1.55; text-wrap: pretty; }
      .cooldown {
        margin-top: 11px;
        padding: 10px 11px;
        display: grid;
        grid-template-columns: 1fr auto;
        align-items: center;
        gap: 3px 12px;
        border: 1px solid hsl(39 58% 37% / .72);
        border-radius: 12px;
        background: linear-gradient(135deg, hsl(39 64% 18% / .68), hsl(213 42% 14%));
      }
      .cooldown[hidden] { display: none; }
      .cooldown-label { color: hsl(40 60% 78%); font-size: 11px; font-weight: 650; }
      .cooldown-target { color: hsl(210 35% 94%); font-size: 12px; font-weight: 720; }
      .cooldown-time { grid-row: 1 / 3; grid-column: 2; color: hsl(40 95% 72%); font-size: 25px; line-height: 1; font-weight: 820; letter-spacing: .04em; font-variant-numeric: tabular-nums; }
      .safety {
        margin-top: 11px;
        padding: 9px 10px;
        border-radius: 10px;
        color: hsl(40 95% 82%);
        background: hsl(39 64% 18% / .62);
        font-size: 12px;
        line-height: 1.45;
      }
      .safety[hidden] { display: none; }
      .actions { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; padding: 0 14px 14px; }
      .action {
        min-height: 44px;
        border: 1px solid var(--cb-line);
        border-radius: 12px;
        color: var(--cb-text);
        background: var(--cb-soft);
        font-size: 13px;
        font-weight: 720;
        cursor: pointer;
        transition: transform 120ms cubic-bezier(.23,1,.32,1), background-color 120ms, opacity 120ms;
      }
      .action.primary { border-color: hsl(1 93% 68% / .7); background: var(--cb-red); color: hsl(214 46% 8%); }
      .action.wide { grid-column: 1 / -1; }
      .action:disabled { opacity: .42; cursor: not-allowed; }
      .notice { padding: 0 14px 13px; color: hsl(1 92% 80%); font-size: 12px; line-height: 1.45; }
      .notice:empty { display: none; }
      @media (hover:hover) and (pointer:fine) {
        .fab:hover { background: hsl(213 42% 13% / .98); border-color: var(--cb-red); }
        .action:not(:disabled):hover { background: hsl(211 30% 22%); }
        .action.primary:not(:disabled):hover { background: hsl(1 93% 70%); }
        .icon-button:hover { color: var(--cb-text); background: var(--cb-soft); }
      }
      @media (prefers-reduced-motion: reduce) {
        .fab, .panel, .action, .icon-button { transition-duration: .01ms !important; }
      }
    </style>
    <section class="panel" id="panel" role="dialog" aria-labelledby="clipbot-float-title">
      <div class="panel-card">
        <header class="header">
          <span class="fab-mark" aria-hidden="true"><img src="${iconUrl}" alt=""></span>
          <div class="brand">
            <div class="title" id="clipbot-float-title">ClipForge</div>
            <div class="eyebrow">Chrome bot control</div>
          </div>
          <button class="icon-button" id="close" type="button" aria-label="ย่อแผง ClipForge">✕</button>
        </header>
        <div class="status-wrap">
          <div class="state-row">
            <span class="dot" id="dot" aria-hidden="true"></span>
            <span class="state-label" id="state">กำลังเชื่อมต่อ…</span>
            <span class="job" id="job"></span>
          </div>
          <div class="message" id="message" aria-live="polite">กำลังอ่านสถานะบอท</div>
          <div class="cooldown" id="cooldown" hidden aria-live="polite">
            <span class="cooldown-label">⏱ คูลดาวน์</span>
            <span class="cooldown-target" id="cooldown-target">พักก่อนคลิปถัดไป</span>
            <time class="cooldown-time" id="cooldown-time" datetime="PT0S">00:00</time>
          </div>
          <div class="safety" id="safety" hidden>🔒 เครดิตถูกล็อก บอทจะไม่กด Generate</div>
        </div>
        <div class="actions">
          <button class="action primary" id="start" type="button">▶ เริ่มบอท</button>
          <button class="action" id="stop" type="button">■ หยุด</button>
          <button class="action wide" id="reset-cooldown" type="button">⏱ รีเซ็ตเวลาพัก</button>
          <button class="action wide" id="lock" type="button">ปลดล็อกเครดิต</button>
        </div>
        <div class="notice" id="notice" aria-live="polite"></div>
      </div>
    </section>
    <button class="fab" id="fab" type="button" aria-expanded="true" aria-controls="panel">
      <span class="fab-mark" aria-hidden="true"><img src="${iconUrl}" alt=""></span>
      <span class="fab-label">ClipForge</span>
    </button>`;

  const panel = shadow.getElementById('panel');
  const fab = shadow.getElementById('fab');
  const close = shadow.getElementById('close');
  const dot = shadow.getElementById('dot');
  const stateLabel = shadow.getElementById('state');
  const jobLabel = shadow.getElementById('job');
  const message = shadow.getElementById('message');
  const cooldownPanel = shadow.getElementById('cooldown');
  const cooldownTarget = shadow.getElementById('cooldown-target');
  const cooldownTime = shadow.getElementById('cooldown-time');
  const safety = shadow.getElementById('safety');
  const start = shadow.getElementById('start');
  const stop = shadow.getElementById('stop');
  const resetCooldown = shadow.getElementById('reset-cooldown');
  const lock = shadow.getElementById('lock');
  const notice = shadow.getElementById('notice');
  let latest = null;
  let busy = false;
  let announcedCooldownUntil = 0;

  function setOpen(open) {
    panel.hidden = !open;
    fab.setAttribute('aria-expanded', String(open));
    if (open) close.focus({ preventScroll: true });
    else fab.focus({ preventScroll: true });
  }

  function showNotice(text) { notice.textContent = text || ''; }

  function renderFloatingCooldown() {
    const now = Date.now();
    const clipUntil = Number(latest?.currentJob?.cooldownUntil || 0);
    const nextJobUntil = Number(latest?.nextJobCooldownUntil || 0);
    let until = 0;
    let target = '';
    if (clipUntil > now) {
      until = clipUntil;
      const reason = latest.currentJob?.cooldownReason;
      if (reason === 'error-recovery') {
        target = 'พักหลัง error — จะลองใหม่อัตโนมัติ';
      } else if (reason === 'next-day-recovery') {
        target = 'พักระบบ 24 ชั่วโมง — จะเริ่มใหม่อัตโนมัติ';
      } else {
        const clipCount = Number(latest.currentJob?.clipCount || 3);
        const nextClip = Math.min(clipCount, Number(latest.currentJob?.clipIndex || 0) + 1);
        target = `พักก่อนคลิป ${nextClip} จาก ${clipCount}`;
      }
    } else if (nextJobUntil > now) {
      until = nextJobUntil;
      target = 'พักก่อนเริ่มงานถัดไป';
    }
    cooldownPanel.hidden = !until;
    if (!until) return;
    const totalSeconds = Math.max(0, Math.ceil((until - now) / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    cooldownTarget.textContent = target;
    cooldownTime.textContent = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    cooldownTime.dateTime = `PT${totalSeconds}S`;
  }

  function revealNewCooldown() {
    const now = Date.now();
    const clipUntil = Number(latest?.currentJob?.cooldownUntil || 0);
    const nextJobUntil = Number(latest?.nextJobCooldownUntil || 0);
    const activeUntil = clipUntil > now ? clipUntil : (nextJobUntil > now ? nextJobUntil : 0);
    if (!activeUntil) {
      announcedCooldownUntil = 0;
      return;
    }
    if (activeUntil === announcedCooldownUntil) return;
    announcedCooldownUntil = activeUntil;
    panel.hidden = false;
    fab.setAttribute('aria-expanded', 'true');
  }

  async function refreshFloatingStatus() {
    try {
      const bot = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
      latest = bot;
      renderFloatingCooldown();
      revealNewCooldown();
      dot.className = `dot ${bot.running ? 'running' : (bot.creditLocked ? 'locked' : '')}`;
      stateLabel.textContent = bot.running ? 'บอทกำลังทำงาน' : (bot.creditLocked ? 'ล็อกเครดิตอยู่' : 'พร้อมเริ่ม');
      jobLabel.textContent = bot.currentJob?.jobId
        ? (bot.currentJob.stage === 'image'
          ? `งาน #${bot.currentJob.jobId} · กำลังสร้างรูปมือจับ`
          : `งาน #${bot.currentJob.jobId} · คลิป ${(bot.currentJob.clipIndex || 0) + 1}/${bot.currentJob.clipCount || 3}`)
        : '';
      message.textContent = bot.lastStatus || 'บอทหยุดอยู่';
      safety.hidden = !bot.creditLocked;
      start.disabled = busy || bot.creditLocked || bot.running;
      stop.disabled = busy || !bot.running;
      resetCooldown.disabled = busy;
      resetCooldown.hidden = !(
        Number(bot.currentJob?.cooldownUntil || 0) > Date.now()
        || Number(bot.nextJobCooldownUntil || 0) > Date.now()
      );
      lock.disabled = busy;
      lock.textContent = bot.creditLocked ? 'ปลดล็อกเครดิต' : '🔒 ล็อกเครดิตและหยุด';
      fab.title = stateLabel.textContent;
    } catch (_) {
      latest = null;
      renderFloatingCooldown();
      dot.className = 'dot';
      stateLabel.textContent = 'Extension ไม่ตอบสนอง';
      message.textContent = 'รีเฟรชหน้า Flow หลังโหลด Extension เวอร์ชันใหม่';
      start.disabled = true;
      stop.disabled = true;
      resetCooldown.disabled = true;
      lock.disabled = true;
    }
  }

  async function runAction(action) {
    if (busy) return;
    busy = true;
    showNotice('');
    await refreshFloatingStatus();
    try {
      const result = await action();
      if (result?.ok === false) throw new Error(result.error || 'คำสั่งไม่สำเร็จ');
    } catch (error) {
      showNotice(error?.message || String(error));
    } finally {
      busy = false;
      await refreshFloatingStatus();
    }
  }

  fab.addEventListener('click', () => setOpen(panel.hidden));
  close.addEventListener('click', () => setOpen(false));
  start.addEventListener('click', () => runAction(() => chrome.runtime.sendMessage({
    type: 'START',
    durationSeconds: latest?.durationSeconds || 24,
  })));
  stop.addEventListener('click', () => runAction(() => chrome.runtime.sendMessage({ type: 'STOP' })));
  resetCooldown.addEventListener('click', () => runAction(
    () => chrome.runtime.sendMessage({ type: 'RESET_COOLDOWN' })
  ));
  lock.addEventListener('click', () => runAction(async () => {
    const unlocking = latest?.creditLocked !== false;
    if (unlocking && !window.confirm('ปลดล็อกเครดิตและอนุญาตให้ ClipForge กดสร้างวิดีโอจริงหรือไม่?')) {
      return { ok: true };
    }
    return chrome.runtime.sendMessage({ type: 'SET_LOCK', locked: !unlocking });
  }));
  shadow.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !panel.hidden) setOpen(false);
  });

  const firstOpen = sessionStorage.getItem('clipbotFloatingSeen') !== '1';
  sessionStorage.setItem('clipbotFloatingSeen', '1');
  panel.hidden = !firstOpen;
  fab.setAttribute('aria-expanded', String(firstOpen));
  document.documentElement.appendChild(host);
  refreshFloatingStatus();
  setInterval(refreshFloatingStatus, 2500);
  setInterval(renderFloatingCooldown, 250);
}

chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  // ถ่าย DOM ตามคำสั่ง — ไม่แตะอะไรบนหน้า ใช้ส่องตอนบอทค้าง
  if (message.type === 'FLOW_SNAPSHOT') {
    // ใช้ FLOW_DIAG ไม่ใช่ FLOW_ERROR — ไม่งั้นจะไปสั่ง failCurrent ทำ job พังทั้งที่แค่ส่อง
    chrome.runtime.sendMessage({
      type: 'FLOW_DIAG',
      message: `[SNAPSHOT ตามคำสั่ง] content script ยังทำงานอยู่ไหม: working=${working}`,
      url: location.href,
      ui: snapshotUi(),
    });
    reply({ ok: true });
    return;
  }
  if (message.type === 'FLOW_CANCEL') {
    cancelRequested = true;
    reply({ ok: true });
    return;
  }
  if (!['FLOW_RUN_IMAGE', 'FLOW_RUN_CLIP'].includes(message.type)) return;
  if (working) {
    reply({ ok: false, busy: true });
    return;
  }
  cancelRequested = false;
  if (message.type === 'FLOW_RUN_IMAGE') generateImage(message);
  else generateClip(message);
  reply({ ok: true });
});
mountFloatingControl();
})();
