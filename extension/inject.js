// MAIN world: hook fetch + XHR, capture Shopee's /api/v2/item/get_ratings
// responses, and forward the RAW data (+ meta) to content.js via postMessage.
// Parsing happens in content.js. Anti-bot errors (e.g. 90309999) are flagged
// so the harvester can pause instead of looping.
(function () {
  if (window.__clipbotHookInstalled) return;
  window.__clipbotHookInstalled = true;

  const API = "/api/v2/item/get_ratings";

  function parseUrl(url) {
    try {
      const u = new URL(url, location.origin);
      const p = u.searchParams;
      const offset = parseInt(p.get("offset") || "0", 10);
      const limit = parseInt(p.get("limit") || "6", 10);
      return {
        shopid: p.get("shopid"),
        itemid: p.get("itemid"),
        type: parseInt(p.get("type") || "0", 10),
        filter: parseInt(p.get("filter") || "0", 10),
        offset,
        limit,
        page: limit > 0 ? Math.floor(offset / limit) + 1 : 1,
      };
    } catch (_) {
      return null;
    }
  }

  function isAntiBot(data) {
    if (!data || typeof data !== "object") return false;
    if (data.error === 90309999) return true;
    if (data.error && data.error !== 0 && !data.data) return true;
    return false;
  }

  function forward(url, data) {
    try {
      if (isAntiBot(data)) {
        window.postMessage({ source: "clipbot", type: "RATINGS_ERROR", error: data.error, pageUrl: location.href }, "*");
        return;
      }
      window.postMessage(
        { source: "clipbot", type: "RATINGS_CAPTURE", url, data, meta: parseUrl(url), pageUrl: location.href },
        "*"
      );
    } catch (_) {}
  }

  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const res = await origFetch.apply(this, args);
    try {
      const url = typeof args[0] === "string" ? args[0] : (args[0] && args[0].url) || "";
      if (url && url.indexOf(API) !== -1) {
        res.clone().json().then((d) => forward(url, d)).catch(() => {});
      }
    } catch (_) {}
    return res;
  };

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, url) {
    this.__cb_url = url;
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    const url = this.__cb_url || "";
    if (url && url.indexOf(API) !== -1) {
      this.addEventListener("load", function () {
        try {
          if (this.responseText) forward(url, JSON.parse(this.responseText));
        } catch (_) {}
      });
    }
    return origSend.apply(this, arguments);
  };

  // ---- Product info (get_pc) — ดึงใน MAIN world ให้ content.js ----
  //
  // Shopee บล็อก get_pc ที่เรียกจาก isolated world ของ extension แต่ยอมให้เรียก
  // จากหน้าเว็บ (main world) — ยืนยันด้วยการทดสอบสด: เรียกจากหน้าได้ description
  // 1,406 ตัวอักษร + 5 รูปทางการ ส่วนจาก isolated world ได้ค่าว่างทุกครั้ง
  const SHOPEE_IMG_CDN = "https://down-th.img.susercontent.com/file/";
  const productInfoCache = {}; // key = "shopid:itemid"

  async function fetchProductInfoOnce(shopid, itemid) {
    const cacheKey = shopid + ":" + itemid;
    if (productInfoCache[cacheKey]) return productInfoCache[cacheKey];
    try {
      // ⚠️ ต้องใช้ window.fetch (ตัวที่หน้าเว็บใช้อยู่ ณ ตอนเรียก) ไม่ใช่ origFetch —
      // origFetch คือ native fetch ที่ดักไว้ตั้งแต่ document_start ก่อนสคริปต์ Shopee โหลด
      // จึงข้ามชั้นห่อของ Shopee ที่เติม header ให้เอง
      const r = await window.fetch(
        "/api/v4/pdp/get_pc?shop_id=" + shopid + "&item_id=" + itemid, {
          credentials: "include",
          headers: { "x-api-source": "pc", "x-shopee-language": "th" },
        });
      if (!r.ok) console.warn("[clipbot] get_pc HTTP", r.status);
      const j = await r.json();
      if (j && j.error) console.warn("[clipbot] get_pc api error", j.error);
      const data = (j && j.data) || {};
      const attrs = (data.product_attributes && data.product_attributes.attrs) || [];
      const specLines = attrs
        .filter(function (a) { return a && a.name && a.value; })
        .map(function (a) { return "- " + a.name + ": " + a.value; });
      const desc = data.item && typeof data.item.description === "string"
        ? data.item.description.trim() : "";
      const detail = [
        specLines.length ? "สเปกสินค้า:\n" + specLines.join("\n") : "",
        desc ? "รายละเอียด:\n" + desc : "",
      ].filter(Boolean).join("\n\n").slice(0, 4000);
      const imgHashes = (data.product_images && data.product_images.images) || [];
      const images = imgHashes
        .filter(function (h) { return typeof h === "string" && h; })
        .slice(0, 9)
        .map(function (h) { return h.indexOf("http") === 0 ? h : SHOPEE_IMG_CDN + h; });
      const result = { detail: detail, images: images };
      // cache เฉพาะผลที่มีข้อมูลจริง — ถ้าว่างต้องปล่อยให้ลองใหม่ได้ ไม่งั้นค่าว่างค้างถาวร
      if (detail || images.length) productInfoCache[cacheKey] = result;
      return result;
    } catch (_) {
      return { detail: "", images: [] };
    }
  }

  // ลองใหม่ได้ เพราะ prefetch อาจยิงก่อนสคริปต์ Shopee ห่อ fetch เสร็จ
  // รวมเวลาไม่เกิน ~4.5 วิ ให้อยู่ในกรอบ timeout 8 วิของ content.js
  async function fetchProductInfoMain(shopid, itemid) {
    const delays = [0, 1500, 3000];
    for (let i = 0; i < delays.length; i++) {
      if (delays[i]) await new Promise(function (r) { setTimeout(r, delays[i]); });
      const got = await fetchProductInfoOnce(shopid, itemid);
      if (got.detail || got.images.length) return got;
    }
    console.warn("[clipbot] get_pc ว่างหลังลองใหม่ 3 ครั้ง", shopid, itemid);
    return { detail: "", images: [] };
  }

  window.addEventListener("message", function (e) {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.source !== "clipbot" || d.type !== "CLIPBOT_FETCH_PRODUCT_INFO") return;
    const requestId = d.requestId;
    fetchProductInfoMain(d.shopid, d.itemid).then(function (result) {
      window.postMessage({
        source: "clipbot",
        type: "CLIPBOT_PRODUCT_INFO_RESULT",
        requestId: requestId,
        detail: result.detail,
        images: result.images,
      }, "*");
    });
  });
})();
