// ISOLATED world. Idle until the background sends START_HARVEST (so normal
// Shopee browsing is untouched). Then it scrolls through the review pages,
// parses each captured get_ratings batch, and streams reviews to the background.
const IMG_CDN = "https://down-th.img.susercontent.com/file/";
const REVIEW_START_EPOCH_SECONDS = Date.UTC(2025, 7, 1) / 1000;

function reviewTimestampSeconds(review) {
  const raw = Number(review && (review.ctime || review.create_time || review.created_at));
  if (!Number.isFinite(raw) || raw <= 0) return null;
  return raw > 1e12 ? raw / 1000 : raw;
}

let harvesting = false;
let job = null;
let maxPages = 10;
let seen = new Set();
let pages = new Set();
let lastNewAt = 0;
let captureBuffer = [];
let pendingIngests = new Set();
let ingestFailures = 0;
let textReviewsCaptured = 0;
let mediaCaptured = 0;
let diagnosticSent = false;
let captureQueue = Promise.resolve();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function toImg(img) {
  if (!img) return null;
  if (typeof img === "string") return img.startsWith("http") ? img : IMG_CDN + img;
  const raw = img.url || img.image_url || img.imageUrl || img.image_id || img.imageId || img.id;
  if (raw) return String(raw).startsWith("http") ? String(raw) : IMG_CDN + raw;
  return null;
}
function toVid(v) {
  if (!v) return null;
  if (typeof v === "string") return v;
  return v.url || v.video_url || v.videoUrl || v.play_url ||
    (v.default_format && (v.default_format.url || v.default_format.video_url)) ||
    (v.formats && v.formats[0] && (v.formats[0].url || v.formats[0].video_url)) || null;
}

function captureMatchesJob(d, activeJob) {
  const capturedItem = String(d && d.meta && d.meta.itemid || "");
  const activeItem = String(activeJob && activeJob.itemid || "");
  return !capturedItem || !activeItem || capturedItem === activeItem;
}

function queueCapture(d) {
  const task = captureQueue.then(() => onCapture(d)).catch(() => { ingestFailures++; });
  captureQueue = task;
  pendingIngests.add(task);
  task.finally(() => pendingIngests.delete(task));
}

// inject.js (MAIN world) forwards raw captures here.
window.addEventListener("message", (e) => {
  if (e.source !== window) return;
  const d = e.data;
  if (!d || d.source !== "clipbot") return;
  if (d.type === "RATINGS_ERROR") {
    if (harvesting) { harvesting = false; chrome.runtime.sendMessage({ type: "HARVEST_CAPTCHA", job }); }
  } else if (d.type === "RATINGS_CAPTURE") {
    captureBuffer.push({ at: Date.now(), data: d });
    captureBuffer = captureBuffer.filter((entry) => Date.now() - entry.at <= 60000).slice(-20);
    if (harvesting && captureMatchesJob(d, job)) queueCapture(d);
  }
});

// Best-effort product title/price from the ratings page (empty when not found —
// the backend keeps whatever it already had, so a miss never overwrites data).
function pageTitle() {
  const t = (document.title || "").split("|")[0].trim();
  return t && !/shopee/i.test(t) ? t : "";
}
function pagePrice() {
  const meta = document.querySelector('meta[property="product:price:amount"]');
  return (meta && meta.content) ? String(meta.content).trim() : "";
}

// สเปก + รูปทางการหลายมุม จาก Shopee PDP API เดียว — ป้อน Gemini เป็น VERIFIED FACTS (พากย์)
// และเป็นรูปอ้างอิงหลายมุมให้เจน start/end frame (Veo interpolate เนียนขึ้น)
// endpoint + โครงสร้างยืนยันจากหน้า Shopee จริง 23 ก.ค. 2026:
//   GET /api/v4/pdp/get_pc?shop_id=..&item_id=..
//     → data.product_attributes.attrs[{name,value}] + data.item.description (สเปก/รายละเอียด)
//     → data.product_images.images[hash] (รูปทางการ; URL = CDN + hash)
// ดึงครั้งเดียวต่อสินค้า (cache) เพราะไม่เปลี่ยนข้ามหน้ารีวิว
// ⚠️ ห้ามยิง get_pc จากตรงนี้ (isolated world) — Shopee คืนค่าว่างเสมอ
// ต้องให้ inject.js ที่รันใน MAIN world ยิงแทน แล้วส่งผลกลับผ่าน postMessage
let productInfoFetched = false;
let productInfoCache = { detail: "", images: [] };
// prefetch อาจยิงก่อนหน้าเว็บพร้อม → ต้องลองใหม่ได้ แต่มีเพดานกันยิงรัวทุก batch
let productInfoInFlight = false;
let productInfoAttempts = 0;
let productInfoBatchesSent = 0;
const PRODUCT_INFO_MAX_ATTEMPTS = 3;
const PRODUCT_INFO_TIMEOUT_MS = 8000;
let _productInfoRequestCounter = 0;

function fetchProductInfo(shopid, itemid) {
  if (!shopid || !itemid) return Promise.resolve({ detail: "", images: [] });
  return new Promise((resolve) => {
    const requestId = "pi_" + Date.now() + "_" + (++_productInfoRequestCounter);
    const timer = setTimeout(() => {
      window.removeEventListener("message", handler);
      resolve({ detail: "", images: [] });
    }, PRODUCT_INFO_TIMEOUT_MS);

    function handler(e) {
      if (e.source !== window) return;
      const d = e.data;
      if (!d || d.source !== "clipbot" || d.type !== "CLIPBOT_PRODUCT_INFO_RESULT") return;
      if (d.requestId !== requestId) return;
      clearTimeout(timer);
      window.removeEventListener("message", handler);
      resolve({
        detail: typeof d.detail === "string" ? d.detail : "",
        images: Array.isArray(d.images) ? d.images : [],
      });
    }

    window.addEventListener("message", handler);
    window.postMessage({
      source: "clipbot",
      type: "CLIPBOT_FETCH_PRODUCT_INFO",
      requestId,
      shopid: String(shopid),
      itemid: String(itemid),
    }, "*");
  });
}

// เริ่มดึงสเปกแบบ "ไม่บล็อก" — เรียกได้หลายครั้ง ทำงานจริงครั้งเดียวต่อสินค้า
//
// ⚠️ ห้าม await ตัวนี้ในเส้นทางส่ง batch เด็ดขาด ถ้า inject.js ตอบช้า/ไม่ตอบ
// harvester จะเด้งไปงานถัดไป/ปิดแท็บก่อน แล้ว batch (รวมรีวิว) หายทั้งก้อน
function ensureProductInfo(shopid, itemid) {
  if (productInfoFetched || productInfoInFlight || !shopid || !itemid) return;
  if (productInfoAttempts >= PRODUCT_INFO_MAX_ATTEMPTS) return;
  productInfoAttempts++;
  productInfoInFlight = true;
  fetchProductInfo(shopid, itemid).then((info) => {
    productInfoInFlight = false;
    if (!info.detail && !info.images.length) {
      // ❗อย่าปักธง fetched — prefetch ยิงตั้งแต่ START_HARVEST ซึ่งหน้าอาจยังโหลดไม่เสร็จ
      // ปล่อยให้ onCapture รอบถัดไป (ตอนหน้าพร้อมแล้ว) ลองใหม่ได้ ภายในเพดานที่กำหนด
      console.warn(
        `[clipbot] product info ว่าง (ครั้งที่ ${productInfoAttempts}/${PRODUCT_INFO_MAX_ATTEMPTS})`
      );
      return;
    }
    productInfoFetched = true;
    productInfoCache = info;
    // ถ้าเพิ่งได้มาหลังส่ง batch ไปแล้ว ให้ตามส่งสเปกเพิ่มอีกก้อน
    // (ingest ฝั่ง server คงค่ารีวิว/มีเดียเดิมไว้เมื่อรอบนี้ไม่ได้ส่งมา)
    if (productInfoBatchesSent > 0) sendProductInfoOnlyBatch();
  });
}

// ส่ง batch ที่มีเฉพาะ product_detail/official_images (ไม่มีรีวิว/มีเดีย)
function sendProductInfoOnlyBatch() {
  const itemid = (job && job.itemid) || 0;
  chrome.runtime.sendMessage({
    type: "HARVEST_BATCH",
    job,
    batch_id: `${(job && job.id) || 0}:${itemid}:productinfo`,
    product_id: Number(itemid) || 0,
    product_url: location.href,
    title: pageTitle(),
    price: pagePrice(),
    review_texts: [],
    media: [],
    product_detail: productInfoCache.detail,
    official_images: productInfoCache.images,
  }).catch(() => {});
}

async function onCapture(d) {
  const ratings = (d.data && d.data.data && d.data.data.ratings) || [];
  const meta = d.meta || {};
  if (meta.page != null) pages.add(meta.page);
  if (!diagnosticSent) {
    diagnosticSent = true;
    const sample = ratings[0] || {};
    chrome.runtime.sendMessage({
      type: "HARVEST_DIAGNOSTIC",
      meta: {
        jobId: job && job.id,
        itemid: meta.itemid || (job && job.itemid),
        page: meta.page,
        ratings: ratings.length,
        ratingKeys: Object.keys(sample).filter((key) => /image|video|media|ctime|create/i.test(key)).slice(0, 30),
        imageValueType: Array.isArray(sample.images) ? "array" : typeof sample.images,
        videoValueType: Array.isArray(sample.videos) ? "array" : typeof sample.videos,
      },
    }).catch(() => {});
  }
  const texts = [], media = [];
  let fresh = 0;
  for (const r of ratings) {
    const reviewTimestamp = reviewTimestampSeconds(r);
    const nowSeconds = Date.now() / 1000;
    if (reviewTimestamp == null || reviewTimestamp < REVIEW_START_EPOCH_SECONDS || reviewTimestamp > nowSeconds) continue;
    const rid = r.cmtid || r.orderid || `${r.itemid}_${r.userid}_${r.ctime || ""}`;
    if (seen.has(rid)) continue;
    seen.add(rid); fresh++;
    if (r.comment && String(r.comment).trim()) texts.push(String(r.comment).trim());
    const reviewDate = new Date(reviewTimestamp * 1000).toISOString();
    for (const img of r.images || []) { const u = toImg(img); if (u) media.push({ url: u, type: "image", reviewTimestamp, reviewDate }); }
    for (const v of r.videos || []) { const u = toVid(v); if (u) media.push({ url: u, type: "video", reviewTimestamp, reviewDate }); }
  }
  if (fresh > 0) {
    lastNewAt = Date.now();
    textReviewsCaptured += texts.length;
    mediaCaptured += media.length;
    if (!texts.length && !media.length) return;
    // ดึงสเปก + รูปทางการครั้งเดียวต่อสินค้า — "ไม่ await" เพื่อไม่ให้บล็อกการส่ง batch
    // (ถ้ายังไม่เสร็จ batch นี้จะส่งไปโดยยังไม่มีสเปก แล้วตามส่งให้ทีหลังอัตโนมัติ)
    ensureProductInfo(
      meta.shopid || (job && job.shopid),
      meta.itemid || (job && job.itemid)
    );
    productInfoBatchesSent++;
    const result = await chrome.runtime.sendMessage({
      type: "HARVEST_BATCH",
      job,
      batch_id: `${job && job.id || 0}:${meta.itemid || job && job.itemid || 0}:${meta.offset != null ? meta.offset : meta.page || 0}`,
      product_id: Number(meta.itemid) || (job && job.itemid) || 0,
      product_url: location.href,
      title: pageTitle(),
      price: pagePrice(),
      review_texts: texts,
      media,
      product_detail: productInfoCache.detail,
      official_images: productInfoCache.images,
    });
    if (!result || !result.ok) ingestFailures++;
  }
}

function closeModals() {
  // Shopee "open in app" / cookie modals can block scrolling.
  const sels = ['.shopee-popup__close-btn', '[class*="close"]', 'button[aria-label="Close"]'];
  for (const s of sels) {
    document.querySelectorAll(s).forEach((el) => { try { el.click(); } catch (_) {} });
  }
}

// Shopee identity-verification / "Verify to Continue" wall (not the API error,
// the full-page interstitial). Pause so the user can clear it manually.
function isVerifyPage() {
  const t = (document.body.innerText || "").toLowerCase();
  if (/verify to continue|identity verification|ยืนยันตัวตน|กรุณายืนยัน|please verify/.test(t)) return true;
  if (/\/verify\b|captcha/i.test(location.href)) return true;
  return false;
}

// Click the ratings pagination "next" arrow if present (Shopee paginates
// reviews). Returns true if it advanced a page.
function clickNextPage() {
  const btn = document.querySelector(
    '.product-ratings__page-controller .shopee-icon-button--right, ' +
    '.shopee-page-controller .shopee-icon-button--right, ' +
    'button.shopee-icon-button--right'
  );
  if (btn && !btn.disabled && btn.getAttribute("aria-disabled") !== "true") {
    try { btn.click(); return true; } catch (_) {}
  }
  return false;
}

// A visible "no more reviews / ยังไม่มีความคิดเห็น" empty state.
function noMoreReviews() {
  const t = (document.body.innerText || "");
  return /ยังไม่มีความคิดเห็น|ไม่มีรีวิว|No Reviews Yet|no ratings yet/i.test(t);
}

async function startHarvest(j, mp) {
  if (harvesting) return;
  harvesting = true; job = j; maxPages = mp || 10;
  seen = new Set(); pages = new Set(); lastNewAt = Date.now();
  pendingIngests = new Set(); ingestFailures = 0;
  captureQueue = Promise.resolve();
  textReviewsCaptured = 0; mediaCaptured = 0; diagnosticSent = false;
  // reset ต่อสินค้า — ไม่งั้นสเปก/รูปของสินค้าก่อนหน้าจะติดไปกับสินค้าถัดไป
  productInfoFetched = false;
  productInfoCache = { detail: "", images: [] };
  productInfoInFlight = false;
  productInfoAttempts = 0;
  productInfoBatchesSent = 0;
  // เริ่มดึงสเปกล่วงหน้าตั้งแต่รับงาน (ไม่บล็อก) ให้ทันก่อน batch แรกจะมาถึง
  ensureProductInfo(j && j.shopid, j && j.itemid);
  const startAt = Date.now();
  let idleScrolls = 0;
  const buffered = captureBuffer
    .filter((entry) => Date.now() - entry.at <= 60000 && captureMatchesJob(entry.data, job));
  for (const entry of buffered) queueCapture(entry.data);
  if (pendingIngests.size) await Promise.allSettled([...pendingIngests]);
  await sleep(600);
  while (harvesting) {
    if (isVerifyPage()) {
      harvesting = false;
      chrome.runtime.sendMessage({ type: "HARVEST_CAPTCHA", job });
      return;
    }
    if (pages.size >= maxPages) break;
    if (Date.now() - startAt > 150000) break;                    // hard cap 150s
    if (noMoreReviews() && pages.size === 0) break;              // product has no reviews
    if (Date.now() - lastNewAt > 12000 && pages.size > 0) break; // no new data 12s
    if (idleScrolls >= 4 && pages.size > 0) break;               // stopped advancing

    closeModals();
    const before = seen.size;
    // Prefer real pagination; fall back to infinite-scroll.
    if (!clickNextPage()) window.scrollTo(0, document.body.scrollHeight);
    await sleep(1900);
    idleScrolls = seen.size > before ? 0 : idleScrolls + 1;
  }
  if (harvesting) {
    harvesting = false;
    if (pendingIngests.size) await Promise.allSettled([...pendingIngests]);
    if (ingestFailures > 0) {
      await chrome.runtime.sendMessage({
        type: "HARVEST_FAILED",
        job,
        message: `ingest failed ${ingestFailures} batch(es); captured data parked for retry`,
      });
      return;
    }
    await chrome.runtime.sendMessage({
      type: "HARVEST_DONE",
      job,
      pages: pages.size,
      reviews: seen.size,
      textReviews: textReviewsCaptured,
      media: mediaCaptured,
    });
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.type === "START_HARVEST") { startHarvest(msg.job, msg.maxPages); reply({ ok: true }); }
  else if (msg.type === "STOP_HARVEST") { harvesting = false; reply({ ok: true }); }
  return true;
});
