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
})();
