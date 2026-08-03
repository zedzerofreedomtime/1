const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);

async function refresh() {
  const s = await send({ type: "GET_STATUS" });
  if (!s) return;
  if (!$("url").value) $("url").value = s.backendUrl || "http://127.0.0.1:8110";
  if (!$("token").dataset.touched) $("token").value = s.scrapeToken || "";
  if (!$("pages").dataset.touched) $("pages").value = s.maxPages || 10;
  if (!$("interval").dataset.touched) {
    const m = s.intervalMin || 0;
    if (m && m % 60 === 0) { $("interval").value = m / 60; $("unit").value = "hr"; }
    else { $("interval").value = m; $("unit").value = "min"; }
  }
  $("dot").className = "dot" + (s.running ? " on" : "");
  const txt = s.lastStatus ? s.lastStatus.text : (s.running ? "กำลังทำงาน" : "หยุดอยู่");
  $("statusText").textContent = txt + (s.activeJobs ? `  ·  กำลังเก็บ ${s.activeJobs} งาน` : "");
}

$("pages").addEventListener("input", () => { $("pages").dataset.touched = "1"; });
$("interval").addEventListener("input", () => { $("interval").dataset.touched = "1"; });
$("token").addEventListener("input", () => { $("token").dataset.touched = "1"; });

function saveCfg() {
  const n = Math.max(0, parseInt($("interval").value, 10) || 0);
  const intervalMin = $("unit").value === "hr" ? n * 60 : n;
  return send({
    type: "SET_CONFIG",
    backendUrl: $("url").value.trim() || "http://127.0.0.1:8110",
    scrapeToken: $("token").value.trim(),
    maxPages: Math.max(1, Math.min(100, parseInt($("pages").value, 10) || 10)),
    intervalMin,
  });
}

$("save").addEventListener("click", async () => { await saveCfg(); $("statusText").textContent = "บันทึกแล้ว"; });
$("start").addEventListener("click", async () => { await saveCfg(); await send({ type: "START" }); refresh(); });
$("stop").addEventListener("click", async () => { await send({ type: "STOP" }); refresh(); });

refresh();
setInterval(refresh, 3000);
