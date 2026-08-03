const API = 'http://127.0.0.1:8110';
const $ = (id) => document.getElementById(id);
const extensionRuntime = typeof chrome !== 'undefined' && Boolean(chrome.runtime?.sendMessage);
const previewCooldownSeconds = extensionRuntime ? 0 : Math.max(0, Number(new URLSearchParams(location.search).get('cooldown')) || 0);
const previewCooldownUntil = previewCooldownSeconds ? Date.now() + previewCooldownSeconds * 1000 : 0;
const send = (message) => extensionRuntime
  ? chrome.runtime.sendMessage(message)
  : Promise.resolve(message.type === 'GET_STATUS'
    ? {
      running: Boolean(previewCooldownUntil),
      creditLocked: !previewCooldownUntil,
      lastStatus: previewCooldownUntil ? 'กำลังพักเพื่อเว้นจังหวะการสร้างวิดีโอ' : 'โหมดตัวอย่าง Extension',
      currentJob: previewCooldownUntil ? { jobId: 15, clipIndex: 2, phase: 'cooldown', cooldownUntil: previewCooldownUntil } : null,
      nextJobCooldownUntil: 0,
    }
    : { ok: false, error: 'ติดตั้ง Extension เพื่อใช้คำสั่งนี้' });
let latestBotStatus = null;
let latestVisibleJobId = null;

function selectedDuration() {
  return Number(document.querySelector('input[name="duration"]:checked')?.value) === 16 ? 16 : 24;
}

function renderDuration(durationSeconds) {
  const duration = Number(durationSeconds) === 16 ? 16 : 24;
  const radio = document.querySelector(`input[name="duration"][value="${duration}"]`);
  if (radio) radio.checked = true;
  const clipCount = duration === 16 ? 2 : 3;
  const heading = document.querySelector('.continuity h2');
  if (heading) heading.textContent = `รูปสินค้า → รูปมือจับ → ${clipCount} คลิปต่อเนื่อง`;
  for (const node of document.querySelectorAll('[data-clip3]')) node.hidden = clipCount === 2;
}

function getCooldown(bot, now = Date.now()) {
  const clipUntil = Number(bot?.currentJob?.cooldownUntil || 0);
  const nextJobUntil = Number(bot?.nextJobCooldownUntil || 0);
  if (clipUntil > now) {
    const reason = bot.currentJob?.cooldownReason;
    if (reason === 'error-recovery') {
      return { until: clipUntil, target: 'พักหลัง error — จะลองใหม่อัตโนมัติ' };
    }
    if (reason === 'next-day-recovery') {
      return { until: clipUntil, target: 'พักระบบ 24 ชั่วโมง — จะเริ่มใหม่อัตโนมัติ' };
    }
    const clipCount = Number(bot.currentJob?.clipCount || 3);
    const nextClip = Math.min(clipCount, Number(bot.currentJob?.clipIndex || 0) + 1);
    return { until: clipUntil, target: `พักก่อนคลิป ${nextClip} จาก ${clipCount}` };
  }
  if (nextJobUntil > now) return { until: nextJobUntil, target: 'พักก่อนเริ่มงานถัดไป' };
  return null;
}

function renderCooldown() {
  const cooldown = getCooldown(latestBotStatus);
  $('cooldownPanel').hidden = !cooldown;
  if (!cooldown) return;
  const totalSeconds = Math.max(0, Math.ceil((cooldown.until - Date.now()) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  $('cooldownTarget').textContent = cooldown.target;
  $('cooldownTime').textContent = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  $('cooldownTime').dateTime = `PT${totalSeconds}S`;
}

function showNotice(message) {
  $('notice').hidden = !message;
  $('notice').textContent = message || '';
}

async function dashboard() {
  const response = await fetch(`${API}/api/dashboard`);
  if (!response.ok) throw new Error('ยังไม่ได้เปิด Web App service');
  return response.json();
}

async function refresh() {
  try {
    const [data, bot] = await Promise.all([dashboard(), send({ type: 'GET_STATUS' })]);
    latestBotStatus = bot;
    renderDuration(bot.currentJob?.targetDurationSeconds || bot.durationSeconds || 24);
    renderCooldown();
    $('connection').className = 'connected';
    $('connection').innerHTML = '<i></i> เชื่อมต่อแล้ว';
    $('statusText').textContent = bot.lastStatus || 'บอทหยุดอยู่';
    $('runLamp').className = bot.running ? 'lamp on' : 'lamp';
    $('lockToggle').className = bot.creditLocked ? 'switch active' : 'switch';
    $('lockToggle').setAttribute('aria-checked', String(bot.creditLocked));
    $('lockText').textContent = bot.creditLocked ? 'เปิดอยู่' : 'ปิดอยู่';
    $('start').disabled = bot.creditLocked || bot.running;
    $('stop').disabled = !bot.running;
    $('lockHint').hidden = !bot.creditLocked;

    const currentValue = $('reviewSelect').value;
    $('reviewSelect').replaceChildren();
    const reviews = data.reviews || [];
    if (reviews.length) {
      const randomOption = document.createElement('option');
      randomOption.value = 'random';
      randomOption.textContent = '🎲 สุ่มอัตโนมัติเมื่อเริ่มบอท';
      $('reviewSelect').append(randomOption);
    }
    for (const item of reviews) {
      const option = document.createElement('option');
      option.value = String(item.id);
      option.textContent = item.title;
      $('reviewSelect').append(option);
    }
    if (!reviews.length) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = 'ไม่มีรูปรีวิวตั้งแต่ ส.ค. 2025 — กรุณาเก็บรีวิวใหม่';
      $('reviewSelect').append(option);
    }
    if (currentValue && [...$('reviewSelect').options].some((option) => option.value === currentValue)) {
      $('reviewSelect').value = currentValue;
    }

    const job = bot.currentJob ? data.jobs.find((item) => item.id === bot.currentJob.jobId) : data.jobs.find((item) => !['completed', 'failed'].includes(item.status));
    latestVisibleJobId = Number(job?.id || bot.currentJob?.jobId || 0) || null;
    $('clearStuck').disabled = !latestVisibleJobId;
    if (job) {
      const clips = job.clipPaths?.length || 0;
      const clipCount = Number(job.clipCount || 3);
      $('jobTitle').textContent = job.title;
      $('jobProgress').textContent = `${job.status === 'generating_image' ? 'กำลังสร้างรูปมือจับ · ' : ''}คลิป ${clips} จาก ${clipCount}`;
      $('progressBar').style.width = `${Math.min(100, clips / clipCount * 100)}%`;
      const image = job.selectedImagePath ? `${API}/api/media?path=${encodeURIComponent(job.selectedImagePath)}` : job.sourceImageUrl;
      if (image) {
        const thumbnail = document.createElement('img');
        thumbnail.src = image;
        thumbnail.alt = '';
        $('jobThumb').replaceChildren(thumbnail);
      }
    } else {
      $('jobTitle').textContent = 'ยังไม่มีงานกำลังทำ';
      $('jobProgress').textContent = `คลิป 0 จาก ${selectedDuration() === 16 ? 2 : 3}`;
      $('progressBar').style.width = '0%';
      $('jobThumb').textContent = '▧';
    }
  } catch (error) {
    latestBotStatus = null;
    latestVisibleJobId = null;
    $('clearStuck').disabled = true;
    renderCooldown();
    $('connection').className = 'connected offline';
    $('connection').innerHTML = '<i></i> Web App ปิดอยู่';
    showNotice(error.message);
  }
}

$('lockToggle').addEventListener('click', async () => {
  const locked = $('lockToggle').getAttribute('aria-checked') === 'true';
  if (locked && !confirm('ปลดล็อกเครดิตและอนุญาตให้ Extension กดสร้างวิดีโอจริงหรือไม่?')) return;
  const result = await send({ type: 'SET_LOCK', locked: !locked });
  showNotice(result?.ok ? (locked ? 'ปลดล็อกแล้ว กด “เริ่มบอท” ได้' : 'ล็อกเครดิตและหยุดบอทแล้ว') : (result?.error || 'เปลี่ยนล็อกไม่สำเร็จ'));
  await refresh();
});

$('start').addEventListener('click', async () => {
  const selectedValue = $('reviewSelect').value;
  const itemId = /^\d+$/.test(selectedValue) ? Number(selectedValue) : null;
  const result = await send({ type: 'START', itemId, durationSeconds: selectedDuration() });
  const startedMessage = result?.random
    ? `สุ่มสินค้าอัตโนมัติแล้ว → เริ่มงาน #${result.id}`
    : (result?.created ? `เลือกสินค้าแล้ว → เริ่มงาน #${result.id}` : `เริ่มงานที่อยู่ในคิว #${result?.id}`);
  showNotice(result?.ok ? startedMessage : (result?.error || 'เริ่มบอทไม่สำเร็จ'));
  await refresh();
});
$('stop').addEventListener('click', async () => { await send({ type: 'STOP' }); await refresh(); });
$('resetCooldown').addEventListener('click', async () => {
  const result = await send({ type: 'RESET_COOLDOWN' });
  showNotice(result?.ok
    ? 'รีเซ็ตเวลาพักแล้ว — พร้อมเริ่มใหม่'
    : (result?.error || 'รีเซ็ตเวลาพักไม่สำเร็จ'));
  await refresh();
});
$('clearStuck').addEventListener('click', async () => {
  if (!latestVisibleJobId) return;
  if (!confirm(`เคลียร์งาน #${latestVisibleJobId} ออกจากคิวหรือไม่?\n\nไฟล์รูปและคลิปที่สร้างไว้จะไม่ถูกลบ`)) return;
  const result = await send({ type: 'CLEAR_STUCK_JOB', jobId: latestVisibleJobId });
  showNotice(result?.ok
    ? `เคลียร์งาน #${result.jobId || latestVisibleJobId} แล้ว และล็อกเครดิตกลับอัตโนมัติ`
    : (result?.error || 'เคลียร์งานค้างไม่สำเร็จ'));
  await refresh();
});
$('openDashboard').addEventListener('click', () => extensionRuntime ? chrome.tabs.create({ url: API }) : window.open(API, '_blank'));

for (const radio of document.querySelectorAll('input[name="duration"]')) {
  radio.addEventListener('change', async () => {
    renderDuration(selectedDuration());
    if (extensionRuntime) await chrome.storage.local.set({ durationSeconds: selectedDuration() });
  });
}

refresh();
setInterval(refresh, 2500);
setInterval(renderCooldown, 250);
