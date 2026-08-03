// Service worker: the queue driver. Polls YOUR backend (no token) for the next
// Shopee product to harvest, navigates the active tab to its review page, tells
// content.js to harvest, uploads each batch to /api/scrape/ingest, then next.

const DEFAULT_BACKEND = "http://127.0.0.1:8110"; // Clip Bot WEB APP (serves /api/scrape/*)

async function cfg() {
  const r = await chrome.storage.local.get(
    ["backendUrl", "maxPages", "running", "intervalMin", "scrapeToken"]);
  return {
    backendUrl: (r.backendUrl || DEFAULT_BACKEND).replace(/\/$/, ""),
    maxPages: r.maxPages || 10,
    running: !!r.running,
    intervalMin: Math.max(0, parseInt(r.intervalMin || 0)),  // 0 = ต่อเนื่อง, >0 = เว้นช่วง
    scrapeToken: r.scrapeToken || "",                        // required by a deployed server
  };
}

async function api(path, body) {
  // Never throws: a down/unreachable backend returns null so callers degrade
  // gracefully instead of surfacing an "Uncaught (in promise) Failed to fetch"
  // error on the extension card.
  try {
    const { backendUrl, scrapeToken } = await cfg();
    const headers = { "Content-Type": "application/json" };
    if (scrapeToken) headers["X-Clipbot-Token"] = scrapeToken;   // deployed server auth
    const r = await fetch(backendUrl + path, {
      method: "POST", headers, body: JSON.stringify(body || {}),
    });
    return await r.json().catch(() => null);
  } catch (_) {
    return null;
  }
}

// Ingest one harvested batch with retry + backoff. On persistent failure the
// batch is parked in chrome.storage.local so it survives a service-worker
// suspend and is retried on the next alarm — captured reviews are never dropped
// just because the backend blipped.
async function ingestBatch(payload) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const j = await api("/api/scrape/ingest", payload);
      if (j && j.ok) {
        chrome.action.setBadgeText({ text: j.media_total ? String(j.media_total) : "" });
        chrome.action.setBadgeBackgroundColor({ color: "#ff6a00" });
        return true;
      }
    } catch (_) { /* network error → retry */ }
    await new Promise((r) => setTimeout(r, 500 * Math.pow(2, attempt)));
  }
  const { pendingIngest = [] } = await chrome.storage.local.get("pendingIngest");
  pendingIngest.push(payload);
  await chrome.storage.local.set({ pendingIngest });
  return false;
}

async function flushPending() {
  const { pendingIngest = [] } = await chrome.storage.local.get("pendingIngest");
  if (!pendingIngest.length) return;
  const remaining = [];
  for (const p of pendingIngest) {
    let ok = false;
    try { const j = await api("/api/scrape/ingest", p); ok = !!(j && j.ok); } catch (_) {}
    if (!ok) remaining.push(p);
  }
  await chrome.storage.local.set({ pendingIngest: remaining });
}

async function setStatus(text) {
  await chrome.storage.local.set({ lastStatus: { text, at: Date.now() } });
  reportStatus(text); // mirror to backend so the dashboard shows live status
}

async function reportStatus(message) {
  try {
    const { running, jobs = {} } = await chrome.storage.local.get(["running", "jobs"]);
    const job = Object.values(jobs)[0];
    await api("/api/scrape/status", {
      running: !!running,
      message: message || "",
      current_job_id: job && job.id,
      current_itemid: job && job.itemid,
    });
  } catch (_) {}
}

async function activeTab() {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tabs && tabs[0];
}

function ratingUrl(job) {
  if (job.shopid && job.itemid) {
    return `https://shopee.co.th/shop/${job.shopid}/item/${job.itemid}/rating?filter=${job.filter || 0}`;
  }
  return job.product_url;
}

// ---- queue driving ----
async function pollNext() {
  const { running } = await cfg();
  if (!running) return;
  const { jobs = {} } = await chrome.storage.local.get("jobs");
  if (Object.keys(jobs).length) return; // one product at a time

  // interval gate: after each product, wait `intervalMin` before the next one
  const { cooldownUntil = 0 } = await chrome.storage.local.get("cooldownUntil");
  if (Date.now() < cooldownUntil) {
    await setStatus(`⏳ พักก่อนเก็บสินค้าถัดไป (อีก ${Math.ceil((cooldownUntil - Date.now()) / 60000)} นาที)`);
    return;
  }

  const res = await api("/api/scrape/next", {});
  const job = res && res.job;
  if (!job) { await setStatus("คิวว่าง — รองาน"); return; }

  const tab = await activeTab();
  if (!tab) { await setStatus("ไม่พบแท็บที่ใช้งานอยู่"); return; }

  jobs[tab.id] = { ...job, startedAt: Date.now() };
  await chrome.storage.local.set({ jobs });
  await setStatus(`เปิดหน้ารีวิวสินค้า #${job.itemid || "?"}`);
  try { await chrome.tabs.update(tab.id, { url: ratingUrl(job) }); } catch (_) {}
}

async function finishJob(tabId, job, status, extra) {
  if (job && job.id) {
    const result = await api(`/api/scrape/${job.id}/${status}`, { message: extra || "" });
    if (!result || !result.ok) {
      await setStatus(`รอยืนยันสถานะสินค้า #${job.itemid || "?"} กับ backend`);
      return false;
    }
  }
  const { jobs = {} } = await chrome.storage.local.get("jobs");
  delete jobs[tabId];
  await chrome.storage.local.set({ jobs });
  // start the interval cooldown so the next product waits `intervalMin`
  const { intervalMin } = await cfg();
  if (intervalMin > 0) {
    await chrome.storage.local.set({ cooldownUntil: Date.now() + intervalMin * 60000 });
  }
  await setStatus(status === "done" ? `เสร็จสินค้า #${job && job.itemid}` : `สินค้า #${job && job.itemid}: ${extra}`);
  pollNext().catch(() => {});
  return true;
}

// ---- messages from content.js ----
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const tabId = sender && sender.tab && sender.tab.id;
  if (msg.type === "HARVEST_BATCH") {
    ingestBatch({
      job_id: msg.job && msg.job.id,
      batch_id: msg.batch_id,
      product_id: msg.product_id,
      product_url: msg.product_url,
      title: msg.title,
      price: msg.price,
      review_texts: msg.review_texts,
      media: msg.media,
      product_detail: msg.product_detail,
      official_images: msg.official_images,
    }).then((ok) => reply({ ok })).catch(() => reply({ ok: false }));
    return true;
  }
  if (msg.type === "HARVEST_DONE") {
    finishJob(
      tabId,
      msg.job,
      "done",
      `${msg.reviews} reviews (${msg.textReviews || 0} text, ${msg.media || 0} media) / ${msg.pages} pages`
    ).then((ok) => reply({ ok })).catch(() => reply({ ok: false }));
    return true;
  }
  if (msg.type === "HARVEST_FAILED") {
    finishJob(tabId, msg.job, "failed", msg.message || "ingest failed")
      .then((ok) => reply({ ok }))
      .catch(() => reply({ ok: false }));
    return true;
  }
  if (msg.type === "HARVEST_DIAGNOSTIC") {
    api("/api/extension/logs", {
      source: "scraper",
      stage: "ratings.shape",
      message: "Shopee ratings payload shape",
      level: "info",
      meta: msg.meta || {},
    }).then(() => reply({ ok: true })).catch(() => reply({ ok: false }));
    return true;
  }
  if (msg.type === "HARVEST_CAPTCHA") {
    (async () => {
      await chrome.storage.local.set({ running: false });
      await finishJob(tabId, msg.job, "failed", "captcha — ยืนยันตัวตนแล้วกดเริ่มใหม่");
      await setStatus("⚠ เจอ captcha — ยืนยันตัวตนในแท็บ แล้วกดเริ่มใหม่");
    })();
    return;
  }
  // ---- popup control ----
  if (msg.type === "SET_CONFIG") {
    chrome.storage.local.set({
      backendUrl: msg.backendUrl, maxPages: msg.maxPages, intervalMin: msg.intervalMin || 0,
      scrapeToken: msg.scrapeToken || "",
    }).then(() => reply({ ok: true }));
    return true;
  }
  if (msg.type === "START") {
    // clear any leftover cooldown so pressing Start harvests immediately
    chrome.storage.local.set({ running: true, cooldownUntil: 0 }).then(async () => {
      await setStatus("เริ่มทำงาน…");
      pollNext().catch(() => {});
      reply({ ok: true });
    });
    return true;
  }
  if (msg.type === "STOP") {
    (async () => {
      await chrome.storage.local.set({ running: false });
      const { jobs = {} } = await chrome.storage.local.get("jobs");
      for (const tid of Object.keys(jobs)) {
        try { chrome.tabs.sendMessage(Number(tid), { type: "STOP_HARVEST" }); } catch (_) {}
      }
      await chrome.storage.local.set({ jobs: {} });
      await setStatus("หยุดแล้ว");
      reply({ ok: true });
    })();
    return true;
  }
  if (msg.type === "GET_STATUS") {
    chrome.storage.local.get(["lastStatus", "running", "backendUrl", "maxPages", "jobs", "intervalMin", "scrapeToken"]).then((r) =>
      reply({
        lastStatus: r.lastStatus || null,
        running: !!r.running,
        backendUrl: r.backendUrl || DEFAULT_BACKEND,
        maxPages: r.maxPages || 10,
        intervalMin: parseInt(r.intervalMin || 0),
        scrapeToken: r.scrapeToken || "",
        activeJobs: Object.keys(r.jobs || {}).length,
      })
    );
    return true;
  }
});

// When a job tab finishes loading the review page, start harvesting.
chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (info.status !== "complete") return;
  const { jobs = {}, running, maxPages } = await chrome.storage.local.get(["jobs", "running", "maxPages"]);
  const job = jobs[tabId];
  if (!job || !running) return;
  try { chrome.tabs.sendMessage(tabId, { type: "START_HARVEST", job, maxPages: maxPages || 10 }); } catch (_) {}
});

// User closed a harvesting tab → mark failed and move on.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { jobs = {} } = await chrome.storage.local.get("jobs");
  if (jobs[tabId]) finishJob(tabId, jobs[tabId], "failed", "tab closed");
});

// Poll the queue periodically + watchdog for stuck jobs (service worker may sleep).
chrome.alarms.create("poll", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name !== "poll") return;
  const { jobs = {}, running } = await chrome.storage.local.get(["jobs", "running"]);
  const t = Date.now();
  for (const [tid, j] of Object.entries(jobs)) {
    if (j.startedAt && t - j.startedAt > 240000) {   // stuck > 4 min → fail + move on
      finishJob(Number(tid), j, "failed", "timeout > 4 min");
    }
  }
  await flushPending();          // retry any batches parked by a backend blip
  if (running) reportStatus();  // keep the dashboard status fresh
  pollNext().catch(() => {});
});
