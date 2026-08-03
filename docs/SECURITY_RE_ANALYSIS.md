# Samurai VDO Reviews 1.12 — Reverse-Engineering & Application-Security Analysis

**Package:** `com.app.samuraivdoreviews` · **versionName** 1.12 · **versionCode** 13
**SHA-256:** `a55f7db30700ca33e5eb91ff6e68ca98e02a078cb07cec5115b3f62453fd54ab`
**Evidence base:** JADX Java sources (`SamuraiVdoSp-1.12-release_decompiled/sources`), Dalvik `decompiled_full/dexdump.txt`, decoded `AndroidManifest.xml` + `res/xml/*`.
**R8 map id:** `96466044b6ecfe9a4a5d9052cc8dd6e921b3b0391eb1606ff9ceb0f3ac6e08ff`
**Tags:** `CONFIRMED` = seen in code/manifest · `INFERRED` = deduced from confirmed code · `UNKNOWN` = not determinable from static artifacts.

> ทุก finding ระดับ CONFIRMED มี Class / Method / path / snippet กำกับ ตามกติกาที่กำหนด. ชื่อ obfuscated (`ha`, `i4`, `r80`, `xq`…) เป็นชื่อจริงใน `defpackage/` ของ build นี้.

---

## 1. Executive Summary

Samurai VDO Reviews คือ **บอทสร้าง+โพสต์คลิปรีวิว Shopee อัตโนมัติ** สั่งงานจากเซิร์ฟเวอร์ผ่านการ poll คำสั่ง. สถาปัตยกรรมยืนยันแล้ว:

- **Auth = token → discover.** ผู้ใช้กรอก **app token** (ต้องขึ้นต้น `app_`) → POST ไป `{seed}/api/discover` → ได้ `server_url` + `member_id` → เก็บใน SharedPreferences `samurai_session`. Login สำเร็จเมื่อมี `token` + `server_url` (`a6.J()`).
- **Seed server ซ่อนแบบ XOR/Base64** ถอดด้วย SHA-256 ของใบเซ็นแอป (`a6.F()`), มี **anti-tamper** (`a6.I()`) ที่ทำให้ token กลายเป็นคำว่า `"tampered"` เมื่อ APK ถูกเซ็นใหม่.
- **Engine = `defpackage.ha`**, state enum = `defpackage.ga {IDLE, RUNNING, PAUSED, FINISHED, FAILED}`. Poll คำสั่งทุก 4 วิ (`p80`), heartbeat ทุก 30 วิ.
- **AI captioner** เลือก provider จาก **prefix ของ key** (`sk-or-`→OpenRouter, `sk-`→OpenAI, อื่น→Gemini); prompt บังคับตอบ JSON `{caption, hashtags, quote}`; AI ล้มทั้งหมด = **หยุดบอท** (ไม่มี caption สำรอง).
- **Render** ด้วย Media3 Transformer → 1080×1920 @30fps, 12 Mbps, effect แบบ seeded-random.
- **Shopee automation = state machine ฝัง hardcode ในแอป** (resource id + ข้อความไทยจริง) ผ่าน AccessibilityService; พิกัด gesture ถูก scale ตามขนาดจอ.

### ความเสี่ยงด้านความปลอดภัยที่ร้ายแรงที่สุด (Critical)
1. **TLS ถูกปิดทั้งหมด** — `X509TrustManager` (`h4`) ยอมรับทุก cert + `HostnameVerifier` (`g4`) คืน `true` → **MITM ได้ทั้งหมด** (token, server_url, AI keys, ไฟล์อัปเดต).
2. **Updater = supply-chain RCE** — โหลด APK ผ่าน HTTP/trust-all, **ไม่มี** checksum/signer/package validation ก่อนติดตั้ง, และ **บังคับอัปเดตได้** ผ่าน `force`/`min_code`.
3. **Cleartext HTTP** เปิดทั้งแอป + endpoint เวอร์ชันฝัง IP `http://103.114.203.222:7000`.

---

## 2. Component & Class Map

| Component | Class | Exported | บทบาท (CONFIRMED) |
|---|---|---|---|
| SplashActivity | `ui/SplashActivity` | ✅ (LAUNCHER) | หน่วง 2.2s แล้วเช็ก session inline → route |
| LoginActivity | `ui/LoginActivity` | ❌ | กรอก token → `/api/discover` → เก็บ token/server_url |
| MainActivity | `ui/MainActivity` | ❌ | เมนูหลัก; สตาร์ท RemoteControlService; เปิด Items/TestEdit |
| ItemsActivity | `ui/ItemsActivity` | ❌ | แสดง items ของ dataset (GET `/items`) |
| TestEditActivity | `ui/TestEditActivity` | ❌ | QA/preview render (ใช้ `hd` ตัวเดียวกับ engine) ไม่โพสต์ |
| BotForegroundService | `bot/BotForegroundService` | ❌ | FGS `specialUse|dataSync` (subtype `shopee_review_clip_automation`) — รัน engine thread `"bot-engine"` |
| RemoteControlService | `remote/RemoteControlService` | ❌ | FGS `remote_control_polling` — poll คำสั่ง (`r80`/`p80`) |
| ShopeeAutoService | `auto/ShopeeAutoService` | ❌ (BIND_ACCESSIBILITY_SERVICE) | AccessibilityService ขับ UI `com.shopee.th` |

**Helper/engine (defpackage):** `ha`=engine · `ga`=state enum · `r80`=remote poller/command dispatcher · `p80`=poll loop runnable · `i4`=API client · `a6`=session/seed/HTTP-media helper (multiplex) · `xq`=AI client · `hd`=video renderer · `dd`=fx flags · `hc0`=Shopee page-detector · `gc0`=Shopee screen enum · `sa0`/`ra0`=selector + fractional bounds · `l7`=signature fingerprint · `lb0`=settings (`samurai_settings`) · `ma`=progress (`samurai_progress`) · `h4`=trust-all TrustManager · `g4`=hostname verifier(true).

### Call graph (CONFIRMED call sites)
```
SplashActivity.onCreate --postDelayed(s2#23, 2200ms)--> s2.run()
  s2#23 --startActivity--> MainActivity        [token && server_url present]
  s2#23 --startActivity--> LoginActivity       [else]

LoginActivity.onCreate --a6(this,26)/i4(D)--> [if J()] MainActivity
  btnLogin.onClick(jg#2, token must start "app_") --lf0.a(mx#0,nx#0)--> POST {seed}/api/discover (i4.h)
  mx#0 --i4.l()--> POST /api/app/heartbeat ; nx#0.onSuccess --> MainActivity

MainActivity.onCreate --a6(this,26)--> [if !J()] LoginActivity
  --startForegroundService(REMOTE_START)--> RemoteControlService
  (mg/hg dataset row) --startActivity(bot_id,bot_name)--> ItemsActivity
  (gb0 settings) --startActivity--> TestEditActivity
  onResume --> ShopeeAutoService.showFloating()

RemoteControlService.onStartCommand --startForeground(1002)/ha.k.add(this)--> new Thread(p80(r80,0),"remote-control")
  RemoteControlService.d() [fa cb] --Thread(p80(r80,1))--> r80.l() POST /api/app/status

r80.a("start") --startForegroundService(START_BOT)--> BotForegroundService.onStartCommand
  onStartCommand(default) --new Thread(ca(ha,1),"bot-engine")--> ha.w()
r80.a("stop")  --startService(STOP_BOT)--> ha.o=true + a9.b.a=true + ShopeeAutoService.requestAbort() + thread.interrupt

User(Settings)-enable-a11y--> ShopeeAutoService.onServiceConnected (connected=true, instance=this)
  ha.v() --ShopeeAutoService.get()/tapSelector/typeIntoSelector/pasteIntoSelector--> drives com.shopee.th
```
Notes (CONFIRMED): FGS ids — engine **1001** (`bot_channel`), poller **1002** (`remote_channel`). `REMOTE_START` action เป็น cosmetic (onStartCommand จับเฉพาะ `REMOTE_STOP`, ที่เหลือ fall-through เริ่ม poll). RemoteControlService **ไม่ได้** รัน engine เอง — คำสั่ง `start` เด้งไป BotForegroundService.

---

## 3. End-to-End Sequence

| # | Step | Real code (CONFIRMED) |
|---|------|-----------|
| 1 | App launch | `SplashActivity.onCreate` → `s2.run()` case 23 (`s2.java:476`) |
| 2 | Session check | `a6.J()` (`a6.java:249`): token+server_url ใน `samurai_session` |
| 3 | Route | token → MainActivity ; else LoginActivity |
| 4 | Seed discovery | `a6.F()` (`a6.java:212`): `seed_url` pref, else XOR-decode Base64 `"Mo9gi4QYuXdKIttp0NrilDgRra6yvnU96lV/"` ⊕ `SHA256(signingCert)` |
| 5 | Login POST | `jg#2`(`jg.java:35`, token ต้องขึ้นต้น `app_`) → `mx#0`(`mx.java:53`): `POST {seed}/api/discover {"token":…}` → `DiscoverResponse` → save token/server_url/member_id → `i4.l()` heartbeat |
| 6 | Enter Main | `nx#0.onSuccess`(`nx.java:52`) |
| 7 | Start poller | `MainActivity.java:71` `startForegroundService(REMOTE_START)` → `Thread(p80(r80,0))` |
| 8 | Poll loop | `p80.run()` case 0 (`p80.java:47`): ทุก 4000ms ถ้า `a6.J() && a6.I()` → `r80.h()` publishSettings, `r80.k()` getCommands, `r80.l()` postStatus; heartbeat ทุก 30000ms |
| 9 | Receive command | `r80.k()`(`r80.java:298`): `GET /api/app/commands?device_id=…` → `r80.a(params,action)` |
| 10 | "start" | `r80.a()` case 4 (`r80.java:150`): set pick_mode/dataset/config → `startForegroundService(BotForegroundService, START_BOT)` |
| 11 | Engine launch | `BotForegroundService.onStartCommand` default → `ga.RUNNING` + `Thread(ca(ha,1),"bot-engine")` → `ha.w()` |
| 12 | Dataset pick — `"PickDataset"` | `ha.o()`(`ha.java:271,280`): `GET /api/app/datasets`; pick first `my_posted<product_count` else auto-pick (`i4.c`); `i4.e(id)`=`/opened` |
| 13 | Load items — `"LoadItems"` | `ha.java:1114`: `i4.k(id)`=`GET /items`; `ha.f()` filter `pending`+`video_review_count>0`+not-locally-done |
| 14 | Lock — `"Lock"` | `ha.java:1145`: `i4.q()`=`POST /items/{pid}/start {force:false,device_id}` (409/`already_posted`→skip) |
| 15 | **Caption — `"Caption"` (มาก่อน download/render!)** | `ha.java:1161`: `i4.j()`=`GET /items/{pid}` → `p1.C()` extract → `xq.d(key,model,system,prompt)`; fallback `ha.z()` gemini→openrouter→openai |
| 16 | Video pool — `"PoolReady"` | `ha.java:1196`: `p1.F(datasetId,productId)` → list `MediaSource` |
| 17 | Download — `"Downloading n/m"` | `ha.java:1208-1230`: `a6.y(MediaSource)` (mode 23) MD5-cache ใน `cacheDir/media_pool` |
| 18 | Render — `"Compose"` | `ha.java:1245`: `hd.b(...)` → mp4 |
| 19 | Export — `"Export"` (progress 100) | `ha.java:1248`: `cz.a(ctx,file,"samurai_{pid}.mp4")` → gallery |
| 20 | Post — `"Post"` | `ha.java:1260`: `ha.v(item,caption)` — `ShopeeAutoService.ensureForeground/launchPackage("com.shopee.th")` → `hc0` เดิน `gc0` states |
| 21 | Report done → next | `ha.java:1285-1324`: SUCCESS → `ma.b()` local-done, `i4.p()` `/release`, `i4.f()` `/done`; `u++`; `ma.c(u)`; `ha.q()` random delay; `ShopeeAutoService.killApp("com.shopee.th")` refresh gallery |
| 22 | Finish | `ha.java:1389`: `n = o ? IDLE : FINISHED`; clear `run_produced` |

**Status สองช่องทาง:** Pull = `p80`→`r80.l()`→`POST /api/app/status`; Push = engine `ha.m()`→`fa.d()`→`RemoteControlService.d()` throttled (>1500ms).

---

## 4. Bot State Machine

### 4a. Lifecycle enum `ga` (CONFIRMED — `defpackage/ga.java`)
```java
public enum ga { IDLE, RUNNING, PAUSED, FINISHED, FAILED }
```
Engine field map (`ha.java:53-66`): `n`=state · `o`=stopRequested · `p`=pauseRequested · `r`=stage string · `s`=stage progress · `t`=target · `u`=produced · `w`=skipped · `x`=consecutive post failures · `z`=datasetId · `A`=datasetName · `B`=productId.

| Current State | Trigger | Next State | Side Effect | Error State | Cite |
|---|---|---|---|---|---|
| IDLE | START_BOT + `!ha.j()` | RUNNING | reset counters, restore `run_produced`, start `bot-engine` | — | `BotForegroundService.java:147-159` |
| RUNNING | `ha.n()` (pause) | PAUSED | `p=true`, log "พักงาน (จะหยุดหลังคลิปปัจจุบัน)" | — | `ha.java:256-269` |
| PAUSED | `ha.u()` (resume) | RUNNING | `p=false`, `m.notifyAll()` | — | `ha.java:514-523` |
| RUNNING/PAUSED | `u>=t` หรือ dataset ว่าง, `!o` | FINISHED | report closed, clear `run_produced` | — | `ha.java:1389-1392` |
| RUNNING/PAUSED | STOP_BOT (`o=true`+interrupt) | IDLE | `ShopeeAutoService.requestAbort()`, `i4.d()` closed | — | `ha.java:1389`; `BotForegroundService.java:91-115` |
| RUNNING | uncaught `Exception`/`j4` และ `!o` | FAILED | `h(exc)` log "บอทล้มเหลว", report | FAILED | `ha.java:216-231,1081-1086` |
| RUNNING | `o||interrupted` ใน `h(exc)` | IDLE | log "หยุดบอทแล้ว" (stop ชนะ fail) | — | `ha.java:217-221` |
| RUNNING | 3 โพสต์ล้มเหลวติดกัน `x>=3` | FINISHED | break loop → `n=o?IDLE:FINISHED` | — | `ha.java:1299-1301,1389` |
| any | `d()` เห็น IDLE/FINISHED/FAILED | (service dies) | `stopForeground`+`stopSelf` | — | `BotForegroundService.java:51-62` |

`ga` ordinal→string map: `q80.a` → `running/paused/finished/failed/idle` (ใช้ใน `r80.m()`).

### 4b. Stage strings (`ha.r`, ตั้งโดย `ha.y(int,String)` — CONFIRMED)
`"PickDataset"`(preparing) → `"LoadItems"`(preparing) → `"Lock"`(preparing) → `"Caption"`(caption) → `"PoolReady"` → `"Downloading n/m"`(compose) → `"Compose"`(compose) → `"Export"`(export) → `"Post"`(posting) → `"รอ N วิ"`(delay) → `"-"`(idle).
`run_state`→category mapping ใน `r80.d()` (`r80.java:238`). **`"Render"` เป็น stage ตายแล้ว** (มีใน mapping แต่ไม่มี `y(...,"Render")` เรียกจริง — INFERRED).

### 4c. Shopee posting sub-FSM `gc0` (CONFIRMED — `ha.v`, ดู §11)
`DISCARD_DIALOG · LINK_ENTRY · PRODUCT_SELECT · PUBLISH · AFFILIATE · GALLERY · CAMERA · VIDEO_EDIT · HOME · UNKNOWN`. ผลลัพธ์ห่อด้วย enum `n50 {SUCCESS, FAILED, SKIPPED, STOPPED}`.

---

## 5. Remote Command Schema

**Envelope (server→app):** `{"command":{"id":<String>,"action":<String>,"params":<JsonObject>}}` (parse `r80.k()` `r80.java:298-330`).
**ACK (app→server):** `POST /api/app/commands/ack {"command_id":<id>,"device_id":<uuid>,"result":"applied"|"rejected","message":<err, only if rejected>}` (`i4.a()` `i4.java:88-99`). `applied` เมื่อ `r80.a()` ไม่ throw; `rejected`+message เมื่อ throw.
**Duplicate protection:** ❌ **ไม่มีฝั่ง client** — ไม่มี seen-set/dedupe ของ command id. Idempotency เป็นหน้าที่ server (ต้องหยุดส่ง command ที่ ack แล้ว). UNKNOWN/absent client-side.

| action | ตัวอย่าง | params (type, req/opt, default, validation) | Side effect |
|---|---|---|---|
| `set_config` (case 0) | `{"action":"set_config","params":{"config":{"clip_count":10,"platform":"tiktok"}}}` | unwrap `params.config` ถ้าเป็น object → `r80.b(cfg)`; ทุก field optional | เขียน prefs; แล้ว `Thread(p80(this,2))` → re-publish `/api/app/settings` |
| `resume` (case 1) | `{"action":"resume"}` | — | `ha.u()` (PAUSED→RUNNING) |
| `stop` (case 2) | `{"action":"stop"}` | — | `startService(BotForegroundService, STOP_BOT)` |
| `pause` (case 3) | `{"action":"pause"}` | — | `ha.n()` (RUNNING→PAUSED) |
| `start` (case 4) | `{"action":"start","params":{"pick_mode":"manual","dataset_id":42,"dataset_name":"X","config":{…}}}` | `pick_mode`(String,opt,def `auto`); `dataset_id`(int,opt, อ่านเมื่อ manual); `dataset_name`(String,opt,def `"Bot "+id`); `config`(obj,opt) | manual→`lb0.o(MANUAL)`+persist `manual_dataset_id(_name)`; apply config; `startForegroundService(START_BOT)` |
| default | — | — | `e4.f("unknown action: …")` → throw → ack `rejected` |

**`config`/`set_config` body (`r80.b()` `r80.java:174-227`)** — apply เฉพาะ field ที่มี & non-null:

| field | type | default | validation | pref |
|---|---|---|---|---|
| `clip_count` | int | 5 | clamp 1–1000 (`lb0.a`) | `clip_count` |
| `clip_len_sec` | int | (`lb0.h`) | clamp 3–60 | `clip_len_sec` |
| `auto_post` | bool | true | — | `auto_post` |
| `with_music` | bool | (`lb0.m`) | — | `with_music` |
| `ai_tag` | bool | false | — | `ai_tag` |
| `apply_overlay` | bool | true | — | `apply_overlay` |
| `fancy_fx` | bool | derived | — | fan-out → `fx_intro/outro/flash/watermark/frame/progress/textfade/rhythm` |
| `post_dry_run` | bool | false | — | `post_dry_run` |
| `reuse_touched` | bool | false | — | `reuse_touched` |
| `platform` | enum `tiktok/facebook/shopee` | `tiktok` | non-empty | `platform` |
| `pick_mode` | enum `auto/manual` | `auto` | case-insensitive | `lb0.o()` |

Published `settings_schema` มาจาก `r80.c()` (`r80.java:37-61`).

---

## 6. API Contract Table

**Transport (CONFIRMED `i4.b()` `i4.java:101`):** base = `server_url` (prefs `samurai_session`); header `Authorization: Bearer <token|"tampered">` + `Content-Type: application/json` ทุก call. `.b()`=GET, `.d("POST",body)`=POST (ไม่มี PUT/PATCH/DELETE). **Timeout** connect 20s / read 30s / write 30s (`i4.java:52-55`); media-download client read 60s. **Retry: ไม่มีชั้น HTTP.** Error: `i4.h()` (`i4.java:221`) parse `error`+`message`, throw `j4(error,message,httpCode)`; 403 หรือ `token_bound_to_other_device` = bound-token error. `device_id` = `a6.C()` (UUID, prefs).

| # | Method | Path | Request JSON | Response model | Call site |
|---|---|---|---|---|---|
| 1 | GET | `http://103.114.203.222:7000/api/app/version` (hardcoded, ไม่ set Content-Type) | — | `AppVersionResponse{apk_url(±download_url/url),latest_code(±…),latest_name,min_code,force(±mandatory/forced),changelog,ok,error,message}` | `i4.i()` `i4.java:274-282` |
| 2 | POST | `{seed}/api/discover` (ไม่ผ่าน `b()`, ไม่มี Bearer) | `{"token":<String>}` | `DiscoverResponse{ok,server_url,host,port,scheme,kind,member_id,error,message}` | `mx#0` `mx.java:58-73` |
| 3 | POST | `/api/app/heartbeat` | `{"device_label":<opt>,"device_id":<String>}` | (ignored) | `i4.l()` `i4.java:296` |
| 4 | POST | `/api/app/status` | status(§ `r80.d()`) + `device_id`+`device_label` | (ignored) | `i4.n()` `i4.java:333` |
| 5 | POST | `/api/app/settings` | `{"device_id","app_version":"1.12","settings_schema":<arr>,"settings_values":<obj>}` | (ignored) | `i4.o()` `i4.java:342` |
| 6 | GET | `/api/app/commands?device_id=<id>` | — | `{command:{id,action,params}}` | `r80.k()` `r80.java:302` |
| 7 | POST | `/api/app/commands/ack` | `{"command_id","device_id","result","message":<opt>}` | (ignored) | `i4.a()` `i4.java:88` |
| 8 | GET | `/api/app/datasets` | — | `DatasetsResponse{ok,datasets[Dataset],error,message}` | `ha.o()` / `kg#0` |
| 9 | POST | `/api/app/datasets/auto-pick` | `{"reuse_touched":<bool>}` | `AutoPickResponse{ok,dataset,error,message}` | `i4.c()` `i4.java:116` |
| 10 | — | `/api/app/datasets/{id}` (bare GET) | — | — | **ไม่ถูกเรียกใน build นี้ (UNKNOWN/absent)** |
| 11 | POST | `/api/app/datasets/{id}/opened` | `{"context":"bot"}` | (ignored) | `i4.e()` `i4.java:133` |
| 12 | POST | `/api/app/datasets/{id}/closed` | `{"reason":"bot-stop","posted_in_session":<int>}` | (ignored) | `i4.d()` `i4.java:124` |
| 13 | POST | `/api/app/datasets/{id}/reset` | `{"device_id"}` | (ignored) | `eg#2` `eg.java:38` |
| 14 | POST | `/api/app/datasets/{id}/progress` | `{"product_ids":<arr<long>>,"device_id"}` | **response ทิ้ง (ไม่ read)** | `i4.m()` `i4.java:317` |
| 15 | GET | `/api/app/datasets/{id}/items` | — | `ItemsResponse{ok,items[ProductItem],error,message}` | `i4.k()` `i4.java:290` |
| 16 | GET | `/api/app/datasets/{id}/items/{itemId}` | — | `ItemDetailResponse{ok,product,reviews[Review],video_reviews[Review],review_count,video_review_count,post_status,summary,…}` | `i4.j()` `i4.java:284` |
| 17 | POST | `/api/app/datasets/{id}/items/{itemId}/start` | `{"force":false,"device_id"}` | (ignored; 409/`already_posted` พิเศษ) | `i4.q()` `i4.java:361` |
| 18 | POST | `/api/app/datasets/{id}/items/{itemId}/done` | `{"platform":"manual","device_id"}` | (ignored) | `i4.f()` `i4.java:141` |
| 19 | POST | `/api/app/datasets/{id}/items/{itemId}/release` | `{"device_id"}` | (ignored) | `i4.p()` `i4.java:353` |
| 20 | GET | `/api/app/ai-config` (404→#21) | — | `AiConfigResponse{ok,provider,model,api_key,has_api_key,system_instruction,prompt,device_label,providers{gemini/openai/openrouter:{api_key,has_api_key,model}}}` | `ha.e()` `ha.java:169` |
| 21 | GET | `/api/app/gemini-config` | — | `GeminiConfigResponse{ok,api_key,has_api_key,model,system_instruction,prompt,device_label}` | `ha.e()` fallback `ha.java:176` |

---

## 7. SharedPreferences & Data Model

| Prefs file | Key | ค่า/ชนิด | เขียนที่ | หมายเหตุ |
|---|---|---|---|---|
| `samurai_session` | `token` | String (ขึ้นต้น `app_`) | `mx.java:69` | **plaintext**; ส่ง `"tampered"` ถ้า `!I()` |
| | `server_url` | String | `mx.java` | base ของ `/api/app/*` |
| | `seed_url` | String | `a6.F` cache | ถอด XOR แล้ว cache |
| | `member_id` | int | `mx.java` | |
| | `device_id` | String(UUID) | `a6.C` `a6.java:187` | ตัวระบุเครื่อง/ownership |
| | `device_label` | String | login | |
| `samurai_settings` (`lb0`) | run cfg | `clip_count,clip_len_sec,with_music,ai_tag,apply_overlay,fx_*,post_dry_run,reuse_touched,platform,pick_mode,manual_dataset_id(_name)` | `r80.b` | ค่าบอท |
| | `ai_key_<PROVIDER>` | String | local | **plaintext AI key** |
| | `ai_model` | String def `gemini-2.5-flash` | | |
| | `srv_ai_key/model/system/prompt` | String | `lb0.p` | cache จาก server |
| | `srv_ai_fetched_at` | long | | เขียนอย่างเดียว, **ไม่มี TTL check** |
| | `srv_pk_<p>`/`srv_pm_<p>` | String | | per-provider key/model |
| | `caption_idea` | String | | prompt seed |
| `samurai_progress` (`ma`) | `run_produced` | int | `ma.c` | กู้ตอน start; ลบเมื่อ FINISH |
| | `done_<id>` | JSON HashSet<Long> | `ma.b` | กัน pick ซ้ำ |
| `update_prefs` | `skip_version_code`,`skip_until_ts` | | `fi0` | snooze 12 ชม. |

**Models (real names, `com/app/samuraivdoreviews/model/`):** `Dataset, DatasetsResponse, DatasetProgressResponse, AutoPickResponse, ProductItem, ItemsResponse, ItemDetailResponse, Review, MediaSource, CaptionResult{caption,hashtags,quote}, AiConfigResponse, GeminiConfigResponse, AppVersionResponse, DiscoverResponse`.
**IPC payload `m50`** (engine→a11y, `ha.java:578-596`): `a=caption, b=hashtags, c=productUrl, d=addMusic`.

---

## 8. Dataset / Item Lifecycle

ลำดับ (CONFIRMED `ha`): pick (`GET /datasets` → เลือก `my_posted<product_count` else `auto-pick`) → `opened{context:bot}` → `GET /items` → filter `ha.f()` (`pending`+`video_review_count>0`+ไม่อยู่ local done-set) → **lock** `POST /items/{pid}/start{force:false,device_id}` → detail → caption → download → render → export → post → บนสำเร็จ: local-done + `release` + `done{platform:"manual"}` → close `closed{reason:"bot-stop",posted_in_session}`.

- **Lock = `/start` + `device_id`.** กันสองเครื่องด้วย **server-side**: อีกเครื่องถือ item → **HTTP 409** หรือ `error=="already_posted"` → caller `catch` แล้ว **skip + mark local-done** (`ha.java:1148-1155`).
- **Lock TTL/expiration:** **UNKNOWN (client)** — ไม่มี lease timer/refresh ในโค้ด.
- **Release บน stop/error:** ✅ `ha.x(long)`=`POST /items/{pid}/release` เรียกทุก checkpoint stop, post failure, และหลัง success/skip (`ha.java:1157,1204,1231,1256,1263,1288,1295,1325`).
- **Retry ต่อ item:** ไม่มี per-item retry; ล้มแล้ว release + ไป item ถัดไป. มี **consecutive-failure counter `ha.x`** cap **3** → หยุด run. Download best-effort ≤ `max(6, clip_len/2)` ไฟล์.
- **Idempotency key:** ❌ **ไม่มี** ทุก request. correlation id เดียวคือ `command_id` (สำหรับ remote command เท่านั้น). กันซ้ำฝั่ง item = local done-set `done_<id>` เท่านั้น.

---

## 9. AI Prompt & Data Flow

**Client `xq` (OkHttp), provider จาก prefix key (`xq.f`):** `sk-or-`→OpenRouter, `sk-`→OpenAI, else→Gemini.
- Gemini: `https://generativelanguage.googleapis.com/v1beta/models/<model>:generateContent?key=<KEY>` (**key ใน URL**), default `gemini-2.5-flash`; body มีแค่ `system_instruction.parts[].text` + `contents[].parts[].text` — **ไม่มี generationConfig/temperature**.
- OpenAI: `https://api.openai.com/v1/chat/completions`, `Authorization: Bearer`, default `gpt-4o-mini`.
- OpenRouter: `https://openrouter.ai/api/v1/chat/completions` + `HTTP-Referer: https://samurai.vdo`, `X-Title: Samurai VDO`, default `openai/gpt-4o-mini`.
- **Params (OpenAI/OpenRouter):** `temperature=0.4`; **ไม่มี** `max_tokens`/`response_format`/`top_p`. timeout connect 20s/read 40s.
- **Rate-limit/auth (`xq.g`):** 429→`yq("rate-limit")`; 401/403→`yq("key ถูกปฏิเสธ")`. **ไม่มี retry ใน `xq`** — retry = provider fallback ชั้น engine.

**Prompt (verbatim, builder `ub.a`)** — user prompt = server template (`{product_summary}` placeholder) หรือ fallback `caption_idea` + product summary, ต่อท้ายด้วยคำสั่งบังคับ:
```
สำคัญ: ต้องคิด "quote" (คำคม/วลีเด็ด) สำหรับแปะบนวิดีโอเสมอ — ห้ามเว้นว่าง
- quote ต้องสั้น ไม่เกิน 12 คำ ภาษาไทย จับใจ สะดุดตา
- quote ต้องเกี่ยวกับ "สินค้านี้โดยตรง" …
ตอบกลับเป็น JSON ล้วน ๆ เท่านั้น … {"caption":"...","hashtags":"#a #b #c","quote":"…ไม่เกิน 12 คำ"}
```
default `caption_idea` = `"เขียนแคปชั่นขายของสั้น กระชับ ดึงดูด พร้อมแฮชแท็ก"`. `system_instruction` มาจาก server (`srv_ai_system`), ไม่มี default hardcode.

**Product fields ที่ส่ง AI (`p1.C(ItemDetailResponse)`):** ชื่อสินค้า, ราคา, ยอดขาย, **รีวิวผู้ซื้อ ≤6 รายการ** (≤160 ตัวอักษร/รายการ). ถ้าไม่มีข้อมูล → `"สินค้ารีวิวจาก Shopee"` (นี่คือ fallback **product-summary** ไม่ใช่ caption). **ไม่มีข้อมูลบัญชี/ส่วนตัว (token/member_id/email) ส่งไป AI** — token แนบเฉพาะ `i4` (เซิร์ฟเวอร์แอปเอง).

**Parse (`xq.d`):** ตัด `{…}` ก้อนแรก → Gson → `CaptionResult{caption,hashtags(array→join space | raw),quote}`; parse ไม่ได้ → ใช้ raw ทั้งก้อนเป็น caption.
**Fallback order:** gemini→openrouter→openai (`ha.z`, ใช้ `srv_pk_<p>`/`srv_pm_<p>`). **AI ล้มทั้งหมด → hard-stop:** `throw IllegalStateException("AI คิดแคปชั่นไม่ได้ … — หยุดบอท")`. (ข้อความตัวอย่างใน `hd.c` เป็น preview-only).
**Key source/storage:** local `ai_key_<p>` ก่อน, ไม่มีก็ `GET /api/app/ai-config` (404→`/api/app/gemini-config`); เก็บ **plaintext** ใน `samurai_settings`; **ไม่มี expiry** (refresh-on-run, INFERRED).

---

## 10. Video Render Pipeline (`defpackage/hd.java`, Media3 Transformer)

- **Setup:** `Transformer.Builder(ctx).setEncoderFactory(DefaultEncoderFactory.Builder(ctx).setRequestedVideoEncoderSettings(VideoEncoderSettings.Builder().setBitrate(12000000).build())).addListener(bd).build(); transformer.start(composition, out.mp4)`.
- **Output:** container **.mp4**, **12 Mbps** (CONFIRMED); codec **H.264/AVC + AAC** (INFERRED, ไม่ set MIME → DefaultEncoderFactory default); **1080×1920** (`Presentation.createForWidthAndHeight(1080,1920,1)`); **30fps** (`setFrameRate(30)` บน image + non-clipped video); HW-encoder preferred, SW fallback (INFERRED).
- **Audio:** ต่อคลิป `setRemoveAudio(true)`; composition `experimentalSetForceAudioTrack(true)` (silent track).
- **Files:** overlay png `cacheDir/fx/card_<nanoTime>.png`; output `cacheDir/out/clip_<ms>.mp4` → export `samurai_<pid>.mp4` (MediaStore). **Cleanup: ไม่มีการลบ temp** (INFERRED — พึ่ง OS cache eviction).
- **Timeout** `await(8, MINUTES)` → null + log. **Cancel** `edVar.isCancelled()`=`ha.o`; poller `ac` (250ms) → `transformer.cancel()`; หลัง await `throw new cd()`. **Progress** `getProgress==2` → `ha.y(p,"Render")`. **Error** `bd.onError` เก็บ `ExportException` → rethrow.

**FX flags (`dd.a`, `samurai_settings`, default true):** `fx_intro/outro/flash/watermark/frame/progress/textfade/rhythm/motions/templates`, `apply_overlay`, `varied_style`.
**Effect ORDER (CONFIRMED `hd.c`/`hd.a`):**
- Sequence: **intro card** (fx_intro) → **main clips** (shuffle pool) → **outro CTA** (fx_outro).
- ต่อคลิป (add-order): **motion `n00`** (Ken-Burns) → **Presentation 1080×1920** → **color-grade** (RgbAdjustment/Contrast | HslAdjustment | grayscale) → **OverlayEffect** (frame→watermark `"⚔ ซามูไร"`→progress bar→caption/quote card `bitmap3` (+textfade บนคลิป 0)→white flash บนคลิปหลังตัวแรก).
- **Randomization: seeded** `Random(serial)` (serial = FNV-hash device+counter → reproducible). สุ่ม: pool order, template `tb.a`, hue, motion, rhythm durations, clip in-point, intro/outro slogan. Anti-repeat: `recent_style_sigs` เก็บ 16 signature ล่าสุด, ลองได้ 20 ครั้ง.
- Motions `o00.a`: `ZOOM_IN/OUT, PAN_LEFT/RIGHT/UP/DOWN, DIAGONAL, PUNCH, DRIFT`. Templates `tb.a`: `TOP_GRADIENT, BOTTOM_BAR, CENTER_QUOTE, CARD, PILL_TAGS, MINIMAL`.

---

## 11. Shopee Automation Step Table

**สถาปัตยกรรม (CONFIRMED):** **hardcode ในแอป** — `ha.v(ProductItem,CaptionResult)` วน page-detector (`hc0`) จำแนกจอเป็น `gc0` แล้ว `switch` ทำ action; selector = `sa0` สร้าง inline ด้วย literal `com.shopee.th:id/…` + ข้อความไทย. **เซิร์ฟเวอร์ไม่ส่ง step/selector** — ส่งแค่ verb + AI/config. Loop รวม **300,000ms**; stuck 6 รอบ → `pressBack`.

**พิกัด gesture scale ตามจอ (CONFIRMED):** `measureScreen()` → `screenW/screenH`; `ra0.a(int i)=round(((a+c)/2)*i)`; `tapAt(x,y)` = `dispatchGesture` stroke 2px/150ms รอ `CountDownLatch` ≤1500ms.

| # | State (`gc0`) | Selector | ResID/Text | Action | Timeout | Fallback | Success | Error |
|---|---|---|---|---|---|---|---|---|
| 0 | DISCARD_DIALOG | id | `.../buttonDefaultNegative` | tap | 8000 | — | dialog ปิด | — |
| 1a | LINK_ENTRY | cls | `android.widget.EditText` | clipboard **paste** product URL | 6000 | — | field focus | paste false |
| 1b | LINK_ENTRY | — | — | pressBack (ซ่อน keyboard) | — | — | — | — |
| 1c | LINK_ENTRY | text⊃ | `นำเข้า` | tap | 5000 | `วางลิงก์` 4000 | — | — |
| 1d | LINK_ENTRY | poll≤14000 | error 10 คำ (`ลิงก์ไม่ถูกต้อง/หมดอายุ/ไม่พบสินค้า…`) | detect | 14000 | retry ≤2× (`hc0.g`) | `฿` ปรากฏ | error → **skip item** |
| 1e | LINK_ENTRY | text⊃ | `เลือกทั้งหมด` | tap | 5000 | — | — | — |
| 1f | LINK_ENTRY | text⊃+region `ra0(0.3,0.8,1,0.99)` | `เพิ่ม` | tap | 6000 | — | รอ `เพิ่มแคปชั่น` 9000 | — |
| 2 | PRODUCT_SELECT | text⊃ | `เลือกทั้งหมด`→`เพิ่ม`+region | tap×2 | 6000/8000 | — | รอ `เพิ่มแคปชั่น` | — |
| 3a | PUBLISH (caption) | id | `.../et_caption` | tap → **typeInto** `caption\nhashtags` | 8000 | clipboard paste | `verifyTyped` | — |
| 3b | PUBLISH | — | — | pressBack; `hc0.c=true` | — | — | — | — |
| 3c | PUBLISH (add product) | id/text | `.../ll_add_product_symbol` else `เพิ่มสินค้า` | tap ×≤4 | 2500/2000 | — | `เพิ่มแคปชั่น` หาย | — |
| 3d | PUBLISH (**post**, ไม่ dry-run) | text⊃+bounds `e(0.08,0.9,0.99,0.99)` | `โพสต์` | tap | 8000 | id `.../btn_post`; bounds `e(0.45,..)`; `ตกลง` | `waitSelectorGone(โพสต์,20000)` → `hc0.d=true` | ปุ่มค้าง |
| 4 | AFFILIATE | cls+region+bounds | `ImageView` region `ra0(0.78,0.04,1,0.12)` | tap create มุมขวาบน | 6000 | bounds tap | — | — |
| 5a | VIDEO_EDIT (music, ถ้า `m50.d`) | id | `.../ll_music` | tap | 4000 | text `เพิ่มเพลง` 8000 | search เปิด | — |
| 5b | VIDEO_EDIT (search) | id | `.../et_music_search_text`→`et_music_search` | tap, พิมพ์ **สุ่ม a-z** | 8000/4000 | — | รอ `.../tv_use` | ไม่เจอ→`iv_cover` ตัวแรก |
| 5c | VIDEO_EDIT (use) | id | `.../tv_use` | tap | 4000 | `btn_search_panel_back`/back | — | — |
| 5d | VIDEO_EDIT (next) | id/text⊃ | `.../tv_compress`/`ถัดไป` | tap | 4000 | `ถัดไป`+bounds | — | — |
| 6 | GALLERY | text⊃ | `วิดีโอ`→`.../ll_check`→`.../tv_pick_top_next` | tap | 8000/6000 | `ถัดไป` | — | — |
| 7 | CAMERA | id | `.../ll_gallery_entrance` | tap | 6000 | text `คลังภาพ` | — | — |
| 8 | HOME | text+bounds | `Live & Video` `e(0.33,0.94,0.58,0.99)`; desc `click top right create icon` | tap | 4000/8000 | — | — | — |

**IPC engine↔a11y (CONFIRMED):** **static singleton** `ShopeeAutoService.get()/instance` + **method arguments** (`m50` + `CaptionResult`) — **ไม่มี** Intent/broadcast/prefs สำหรับ payload. video path **ไม่ส่ง** (เซฟ gallery ไว้ก่อน Shopee หยิบเอง); product URL วาง clipboard (`newPlainText("product",url)`). abort = static flags `ShopeeAutoService.aborted` + `a9.b.a`.

---

## 12. Pause / Resume / Stop / Recovery

- **Pause = cooperative, มีผลหลังจบคลิปปัจจุบัน.** `ha.n()` set `p=true`; gate `ha.A()` (`this.m.wait()`) เช็ก **เฉพาะต้น loop ต่อ item** (`ha.java:1107`). **ระหว่าง render/gesture ไม่ interrupt** — คลิปปัจจุบันทำจนจบก่อน. Pause ล้วนจอด thread ใน `wait()` ไม่ release item.
- **Resume = ทำ item ถัดไป** (`ha.u()` → `notifyAll`), ไม่ทำ item เดิมซ้ำ.
- **Stop = ทันที, หลายชั้น** (`BotForegroundService.onStartCommand` STOP_BOT): `ha.o=true` + `a9.b.a=true` + `ShopeeAutoService.requestAbort()` + cancel OkHttp dispatcher (`((d40)a6.g).f.c()`, INFERRED cast) + `thread.interrupt()` + `ha.u()`. **Transformer cancel ทางอ้อม** (`isCancelled()→ha.o` → `ac`→`transformer.cancel()` → `throw cd`).
- **Release บน stop/error:** ✅ ทุก stop-checkpoint + render-cancel เรียก `x(pid)` = `/release`.
- **Temp files: ไม่ลบ** (fx png, out mp4, downloaded media) — CONFIRMED by absence.
- **Kill/restart recovery:** `run_produced` + `done_<id>` persist ใน `samurai_progress` → count & completed-set รอด, แต่ **ไม่มี resume คลิปที่ทำค้าง** (item ครึ่งทางถูกหยิบใหม่). **device restart ไม่ auto-resume** — ต้อง start ใหม่ (UI/remote), แล้ว continue จาก `run_produced`.
- **Shopee crash/foreground:** `ensureForeground("com.shopee.th",…)` → banner "↩️ ดึง Shopee กลับ / อย่ากดหน้าจอ" + `bringToFront` (retry >1200ms ≤8s); เริ่มโพสต์ `launchPackage(…,20000)` (HOME→kill→relaunch); หลังสำเร็จ `killApp("com.shopee.th")` refresh gallery.
- **Network retry (จำกัด):** link import ≤2 ครั้ง; โพสต์ล้ม 3 ติด → หยุด; download ล้ม → swallow ต่อ source, ทั้ง pool ล้ม → skip item. **ไม่มี backoff/wait-for-network loop.**

---

## 13. Update Flow (⚠ supply-chain)

`AppVersionResponse{latest_code,latest_name,min_code,force(±mandatory/forced),apk_url(±download_url/url),changelog,ok}`.
1. **Fetch (HTTP):** `i4.i()` → `GET http://103.114.203.222:7000/api/app/version` (cleartext, trust-all, Bearer/"tampered").
2. **Compare (`fi0.java:36-53`):** `z3` (มี update) = `latest_code>13 && apk_url non-empty`; `z2` (บังคับ) = `force || min_code>13`. snooze 12 ชม. (`skip_version_code/skip_until_ts`) เฉพาะ non-forced.
3. **Prompt/perm (`m8` case 6):** ถ้า `!canRequestPackageInstalls()` → ขอ "install unknown apps"; แล้ว `Thread(ph,"update-download")`.
4. **Download (`ph.java:45-59`):** `File(getExternalFilesDir(null),"samurai-update.apk")`; ลบไฟล์เก่า; `new i4(a6).g(apk_url,file,…)` (trust-all). `i4.g()` เช็กแค่ HTTP 2xx + body ไม่ว่าง.
5. **Install (`m8` case 5):** `FileProvider.d(...,".fileprovider",file)` → `ACTION_VIEW` MIME `application/vnd.android.package-archive` + flags `268435457` (`NEW_TASK|GRANT_READ`).

**Absent checks (แต่ละอันเป็น finding):** ❌ SHA-256/checksum · ❌ APK signer/package-name validation · ❌ TLS integrity (trust-all + HTTP metadata) · ❌ redirect allowlist (ตาม default, ยอม HTTPS→HTTP) · ❌ Content-Type/Length · ❌ downgrade protection (ไม่เช็ก versionCode ของ APK ที่โหลด) · ⚠ temp APK ค้างหลังติดตั้ง. **force/min_code → dialog ยกเลิกไม่ได้** → บังคับติดตั้ง apk_url ที่เซิร์ฟเวอร์/attacker ชี้.
**สรุป:** **Critical supply-chain RCE.**

---

## 14. Security Findings (Critical → Informational)

| # | Finding | Severity | Evidence |
|---|---|---|---|
| 1 | X509TrustManager ยอมรับทุก cert | **Critical** | `h4.java:8-20` (empty check, `getAcceptedIssuers=[]`); wired `i4.java:46-64` |
| 2 | HostnameVerifier คืน `true` | **Critical** | `g4.java:10-13`; wired `i4.java:64` |
| 3 | Update APK ผ่าน HTTP + ไม่มี integrity | **Critical** | §13; `i4.i():278`, `ph.java`, `m8` |
| 4 | Cleartext HTTP ทั้งแอป | **High** | manifest `usesCleartextTraffic=true`; `network_security_config.xml`; `i4.java:278` |
| 5 | User-CA trust เปิด | **High** | `network_security_config.xml` `<certificates src="user"/>` |
| 6 | Bearer token plaintext (prefs + wire) | **High** | `mx.java:69`, `i4.java:108,111` |
| 7 | AI keys plaintext + Gemini key ใน URL | **High** | `lb0.java:65,118-150`; `xq.java:136` |
| 8 | ทุก secret ใน SharedPreferences ไม่เข้ารหัส | **High** | `a6.java:1155`; `lb0` MODE_PRIVATE (ไม่มี EncryptedSharedPreferences/Keystore) |
| 9 | `allowBackup=true` + cloud-backup ไม่ exclude | **Medium** | manifest:37; `data_extraction_rules.xml`; `backup_rules.xml` ว่าง |
| 10 | Accessibility: อ่านทุกจอ + gesture | **High** | manifest:100-110; `accessibility_service_config.xml` (`canRetrieveWindowContent`,`canPerformGestures`,`flagRetrieveInteractiveWindows`) |
| 11 | Clipboard write (paste injection) | **Medium** | `ShopeeAutoService.java:326-330,784-788` |
| 12 | Remote-control polling รับคำสั่ง backend | **Medium** | manifest:83-90; `i4.a()`; `RemoteControlService.java` |
| 13 | Hard-coded C2/update IP (cleartext) | **Medium** | `i4.java:278` |
| 14 | ไม่มี cert pinning | **Medium** | ไม่พบ `CertificatePinner` |
| 15 | ไม่มี root/emulator/anti-debug/anti-hook | **Low** | grep = 0 (มีแค่ soft signature check) |
| 16 | `SYSTEM_ALERT_WINDOW` + `REQUEST_INSTALL_PACKAGES` | **Medium** | manifest:20,24 (รวม a11y = tap-jacking potential) |
| 17 | FileProvider expose external-files root | **Low** | `file_paths.xml` `<external-files-path path="."/>` (exported=false, filename คงที่) |
| 18 | Logcat leakage (UI state) | **Low** | `ShopeeAutoService` `Log.w` (ไม่มี token/key) |
| 19 | PendingIntent = IMMUTABLE (**pass**) | Info | `201326592` = UPDATE_CURRENT\|IMMUTABLE |
| 20 | Install Intent flags (**pass**) | Info | `m8.java:98-101` scoped grant |
| 21 | ไม่มี unsafe deserialization (Gson only) | Info | — |
| 22 | ไม่มี WebView/JS bridge | Info | — |
| 23 | ProfileInstallReceiver exported แต่ DUMP-guarded | Info | manifest:125-143 |

**Exported sweep:** เฉพาะ SplashActivity (LAUNCHER) + ProfileInstallReceiver (DUMP-guarded) ที่ exported; ที่เหลือ `exported=false`. **ไม่มี attack surface ที่แอปอื่นเรียกได้.**

**Anti-tamper (CONFIRMED):** `l7.a` = baked SHA-256 ของใบเซ็น (`l7.java:14`); `a6.I()` เทียบ runtime sig; ถ้าไม่ตรง → token = `"tampered"` (`i4.java:108,163,276`); poll loop เรียกเมื่อ `I()` จริงเท่านั้น (`p80.java:53`); loop ปฏิเสธรันถ้า `!I()` (`ha.java:1087`). Seed URL = `Base64Decode("Mo9gi4QYuXdKIttp0NrilDgRra6yvnU96lV/") ⊕ repeat(SHA256(cert))` → cache `seed_url` (plaintext จริง UNKNOWN ถ้าไม่มี cert จริง; ถอดได้ 27 ไบต์).

---

## 15. Negative Findings (searched — NOT FOUND unless noted)

`Runtime.exec` ✘ · `ProcessBuilder` ✘ · `DexClassLoader`/`PathClassLoader`/dynamic DEX ✘ · `System.loadLibrary` (app) ✘ (มีแค่ media3; `extractNativeLibs=false`) · SMS ✘ · Contacts ✘ · CallLog ✘ · Camera ✘ · Microphone ✘ · Location ✘ · MediaProjection/screen-capture ✘ · **Keylogging** ✘ (a11y อ่าน `getText()` เพื่อ match แต่ไม่ log/exfil keystroke) · WebSocket ✘ · MQTT ✘ · Firebase/Crashlytics ✘ · Ad SDK ✘ · Analytics SDK ✘ · Cert pinning ✘ · Root/emulator/anti-debug ✘.
**PRESENT (benign):** Reflection `Class.forName("android.text.DynamicLayout$ChangeWatcher")` (`a6.java:1198`, AndroidX emoji internal).

---

## 16. Confirmed / Inferred / Unknown

**CONFIRMED (หลักฐานตรง):** call graph 8 คอมโพเนนต์ · workflow เต็ม · `ga` state + stage strings · remote command schema + ACK · API 21 endpoint + method/JSON/timeout/no-retry · lock ผ่าน `/start`+409 · release ทุก path · no idempotency · AI providers+endpoints+prefix routing+temp 0.4+prompt verbatim+fallback order+hard-stop · product fields ส่ง AI (ไม่มี PII) · Media3 1080×1920/30fps/12Mbps/force-audio · effect order + seeded random · Shopee step table (hardcoded) + coord scaling · static-singleton IPC · pause-after-clip / multi-stage stop / no temp cleanup · anti-tamper `"tampered"` · seed XOR derivation · **TLS trust-all (#1/#2)** · update flow + missing integrity checks · exported sweep · negatives.

**INFERRED:** H.264/AAC codec (Media3 default) · HW-encoder preferred · ไม่มี AI config TTL · ไม่มี temp cleanup · `"Render"` stage dead · `a6.g→d40` cast (STOP path).

**UNKNOWN (ต้อง runtime/artifact เพิ่ม):** seed URL plaintext จริง (ต้องมีใบเซ็นจริง) · server-side lock TTL + command dedupe (ไม่มีหลักฐาน client) · server-delivered `system_instruction`/`prompt` values · GL math ใน `n00`/`uq` · `/api/app/datasets/{id}` bare-GET (ไม่ถูกเรียก).

---

## 17. จุดที่ Handoff (PROGRAM_FLOW.md) เดิมคลาดเคลื่อน

| # | ข้อมูลเดิม | ที่ถูกต้อง | หลักฐาน | สาเหตุ |
|---|---|---|---|---|
| 1 | "endpoint ยืนยันได้คือ `/api/app/datasets/{id}/reset`" (แค่ตัวเดียว) | มี **21 endpoint** ยืนยันได้ครบ (§6) | `i4.java`, `r80.java` | Handoff อ่านจาก dexdump บางส่วน; JADX source เผยครบ |
| 2 | ลำดับ "ดาวน์โหลด → caption → ตัดต่อ" | จริงคือ **Caption ก่อน** แล้วค่อย download/render | `ha.w` stage `"Caption"`(1161) < `"Downloading"`(1208) | ผังเดา sequence จากชื่อ ไม่ได้อ่าน `ha.w` |
| 3 | ไม่ระบุ | **TLS ถูกปิดทั้งหมด** (trust-all) | `h4.java`, `g4.java`, `i4.java:46-64` | Handoff เป็น flow ไม่ใช่ security audit |
| 4 | ไม่ระบุ | **Updater = supply-chain RCE** | §13 | เหมือนกัน |
| 5 | "RemoteControlService → เริ่ม/หยุดงานหรือบอท" (ชวนเข้าใจว่ารัน engine) | poller poll คำสั่งเท่านั้น; `start` เด้งไป **BotForegroundService** | `RemoteControlService.java:76`, `r80.java:166` | สรุปจากชื่อ service |
| 6 | ไม่ระบุ | AI ล้มทั้งหมด = **หยุดบอท** (ไม่มี caption สำรอง); "สินค้ารีวิวจาก Shopee" เป็น product-summary fallback ไม่ใช่ caption | `ha.w` throw; `p1.C` | Handoff เดาว่าเป็น caption ตั้งต้น |
| 7 | ไม่ระบุ | Shopee steps **hardcode** (resource id จริง) ไม่ได้ดึงจากเซิร์ฟเวอร์ | `ha.v` `gc0` switch | — |

---

## 18. Class/Method/Snippet ที่ควรส่งตรวจรอบสอง (ChatGPT)

1. `defpackage/xq.java` — `f()` (prefix routing), `c()`/`e()` (endpoint/body), `d()` (JSON parse) — ยืนยัน body ทุก provider + การ handle `quote`.
2. `defpackage/hd.java` — `c()` (Transformer setup, clip loop), `a()` (intro/outro), `e()` (card png) — ยืนยัน codec/effect GL (`n00`,`uq`).
3. `defpackage/ha.java` — `w()` (run loop), `v()` (Shopee FSM), `z()` (AI fallback), `A()/n()/u()` (pause), `x()` (release) — ยืนยัน state/stage/lock ทั้งหมด.
4. `defpackage/i4.java` — `b()`,`g()`,`h()`,`i()`,`q()` + `h4.java`/`g4.java` — ยืนยัน TLS trust-all + endpoint.
5. `defpackage/a6.java` — `F()`(seed XOR), `I()`(tamper), `C()/J()/M()` + `l7.java` — ยืนยัน discovery/anti-tamper.
6. `defpackage/r80.java` — `a()`(dispatch), `b()`(config), `d()`(status), `k()`(commands) + `p80.java` — ยืนยัน command schema + poll.
7. `defpackage/fi0.java`,`ph.java`,`m8.java` — ยืนยัน update compare/download/install (missing checks).
8. `com/app/samuraivdoreviews/auto/ShopeeAutoService.java` — `tapSelector/typeIntoSelector/pasteIntoSelector/ensureForeground/measureScreen` — ยืนยัน selector engine + coord scaling.
9. `resources/res/xml/network_security_config.xml`, `accessibility_service_config.xml`, `file_paths.xml`, `AndroidManifest.xml` — ยืนยัน cleartext/user-CA/a11y scope/FileProvider.

---

## 19. Dynamic Analysis Plan (ปลอดภัย)

> ⛔ **ห้าม:** ทดสอบกับ **บัญชี Shopee หลัก**, **โทรศัพท์หลัก**, หรือเครื่องที่มี **แอปธนาคาร/กระเป๋าเงิน**. ใช้ **emulator หรือเครื่องทดสอบแยกเท่านั้น**, บัญชี Shopee ทิ้งได้, ตั้ง `post_dry_run=true` เพื่อไม่โพสต์จริง.

**สภาพแวดล้อม:** Android Emulator (rooted, x86_64) หรือเครื่องทดสอบ rooted แยก; SIM/บัญชีแยก; snapshot ก่อนติดตั้งเพื่อ rollback.

| เป้า (อ้าง finding) | เครื่องมือ | ขั้นตอน | สิ่งที่คาดว่าจะเห็น |
|---|---|---|---|
| ยืนยัน TLS trust-all (#1/#2) | **mitmproxy / Burp** (ไม่ต้องลง CA เพราะแอป trust-all) | ตั้ง proxy → เปิดแอป → ดู traffic | อ่าน `/api/discover`, `/api/app/*`, AI calls, token/keys เป็น plaintext |
| Map API + token flow (§6) | mitmproxy + `logcat` | login ด้วย token ทดสอบ → จับ request/response | ยืนยัน `Authorization: Bearer`, discover→server_url, command poll |
| Remote command (§5) | **mock backend** (Flask/FastAPI ปลอม) ชี้ผ่าน hosts/proxy | ตอบ `/api/app/commands` ด้วย `start/pause/resume/stop/set_config` | สังเกต state machine (`ga`) + ACK |
| Dump secrets at rest (#6-#8) | **adb** + `run-as`/root | `cat /data/data/com.app.samuraivdoreviews/shared_prefs/samurai_session.xml` และ `samurai_settings.xml` | token/server_url/AI keys plaintext |
| ยืนยัน anti-tamper (§14) | **Frida / Objection** | hook `a6.I()` ให้คืน true บน build ที่ resign; หรือดู `Bearer tampered` ใน proxy | เข้าใจ soft-enforcement |
| Update supply-chain (§13) | mock backend + mitmproxy | ตอบ `/api/app/version` ด้วย `apk_url` ชี้ APK ทดสอบ (เซ็นต่าง, package ต่าง) | ยืนยันว่า **ติดตั้งได้โดยไม่เช็ก signer/hash** → Critical |
| Shopee automation (§11) | **Accessibility screen recording** + `uiautomatorviewer` | เปิด a11y + dry-run → อัดหน้าจอ | ยืนยัน selector/step + coord scaling |
| Static re-scan | **JADX, apktool, MobSF, Drozer** | MobSF สแกนอัตโนมัติ; Drozer เช็ก exported/IPC | cross-check §14 (exported=false, ไม่มี surface) |
| Filesystem diff | snapshot ก่อน/หลัง 1 run | เทียบ `cacheDir/fx`, `cacheDir/out`, `media_pool` | ยืนยัน temp ไม่ถูกลบ (#temp cleanup) |

**ลำดับแนะนำ:** (1) snapshot → (2) proxy+logcat baseline → (3) login + map API → (4) mock backend ขับ command → (5) dry-run 1 clip + a11y record → (6) prefs dump → (7) update-flow test ด้วย APK ทดสอบ → (8) MobSF/Drozer sweep → (9) rollback snapshot.

---

*จัดทำจาก static analysis (JADX + dexdump + manifest) 5 สายขนาน — ทุก CONFIRMED มี evidence กำกับ. ส่วนที่ต้องยืนยันเพิ่มด้วย runtime อยู่ใน §16 (UNKNOWN) และ §19.*
