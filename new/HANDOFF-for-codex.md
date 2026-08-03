# Handoff to Codex — ClipBot Flow (17 Jul 2026, ~17:25)

> ⛔ **เอกสารเก่า (17 ก.ค. 2026) — ไม่ใช่สถานะปัจจุบันแล้ว** เก็บไว้อ้างอิงประวัติเท่านั้น
> สถานะจริงอยู่ท้าย `AGENT-COORDINATION.md` และใน `CLAUDE.md`

> เขียนโดย Claude ส่งต่อให้ Codex. อ่านไฟล์นี้ + `CLAUDE.md` ก่อนเริ่ม.
> เราทำงานสลับกัน — ไฟล์นี้คือสถานะจริง ณ ตอนส่งมอบ.

## TL;DR สถานะปัจจุบัน

- **บอทกดเว็บ Flow ทำงานได้ครบทุกด่านแล้ว** (extension 2.3.2) — เข้า Editor → สลับโหมด Veo →
  อัปโหลดรูป → ใส่ prompt → กด Generate → Veo เจนคลิปออกมาจริง. พิสูจน์แล้ว เห็น `<video>` บนหน้า.
- **ค้างด่านเดียว:** ดาวน์โหลดคลิปที่ Veo เจนเสร็จ → `Failed to fetch` (รายละเอียดข้างล่าง).
- **ไปป์ไลน์ประกอบวิดีโอ (หลังได้ 3 คลิป) เสร็จสมบูรณ์และเทสต์ด้วยคลิป Veo จริงแล้ว** — Gemini กำกับตัดต่อ,
  เสียงพากย์ Gemini TTS, มิกซ์เสียงบรรยากาศ, -14 LUFS, ภาพตรงเสียง. ไม่ต้องแตะส่วนนี้.
- typecheck สะอาด (`npx tsc --noEmit` ผ่าน). extension 2 ชุด (`extension/`, `clipbot-flow-extension/`) sync กันแล้ว.
- **ไม่ใช่ git repo** — ไม่มี diff ให้ดู ต้องอ่านไฟล์ตรงๆ.

## 🔴 บั๊กเดียวที่ต้องแก้ต่อ: ดาวน์โหลดคลิป 3 → "Failed to fetch"

**อาการ:** บอทกด Generate สำเร็จ, Veo เจนคลิปเสร็จ (เห็น `<video src=".../getMediaUrlRedirect?name=...">`
บนหน้า), background poll เจอวิดีโอ แต่พอจะโหลด → `Failed to fetch`.

**สิ่งที่ Claude ลองแล้วยังไม่ผ่าน:**
1. โหลดจาก service worker ตรงๆ → fail (URL redirect ไปโดเมนนอก host_permissions)
2. โหลดผ่าน page context ด้วย `chrome.scripting.executeScript` + `fetch(url, {credentials:'include'})`
   → ยัง `Failed to fetch` (โค้ดนี้อยู่ใน `extension/background.js` → `acceptClip()` และ `salvage` command)

**เบาะแสสำคัญ (ยังไม่ได้ไล่):**
- คลิป 1-2 (ของ codex เดิม) ถูกโหลดสำเร็จด้วย URL รูปแบบเดียวกันเป๊ะ — ไฟล์อยู่ครบใน `data/output/job_2/`
  → **แปลว่ามันเคยทำได้** ต่างกันตรงไหน?
- สมมติฐานที่ Claude ยังพิสูจน์ไม่เสร็จ: คลิปที่พยายามโหลด**อยู่คนละโปรเจ็กต์กับแท็บที่เปิดอยู่**
  (บอทสร้าง `/project/<id>` ใหม่ทุกครั้ง) → page context ของแท็บปัจจุบัน fetch คลิปข้ามโปรเจ็กต์ไม่ได้
- ลองเช็ค: URL คลิปต้อง fetch จาก**แท็บที่อยู่ในโปรเจ็กต์เดียวกับคลิปนั้น** ไหม? หรือต้องแนบ header อื่น?

## เครื่องมือรีโมตที่ Claude สร้างไว้ (ใช้ไล่บั๊กโดยไม่ต้องให้ user กดเอง)

Extension poll `/api/extension/status` ทุก 15 วิ. เขียนไฟล์ `data/remote-command.json` แล้วรอ ~15 วิ:
```json
{"command":"reload"}      // สั่ง extension โหลดโค้ดใหม่จากดิสก์เอง (chrome.runtime.reload)
{"command":"unlock"}      // ปลด credit lock (onInstalled ล็อกกลับทุก reload)
{"command":"start"}       // สั่งบอทเริ่มทำงาน
{"command":"stop"}
{"command":"snapshot"}    // ถ่าย DOM หน้า Flow ตอนนี้ → data/flow-diagnostic.json (ไม่แตะอะไร ไม่เสีย credit)
{"command":"salvage","url":"<video-url>","jobId":2,"clipIndex":2}  // กู้คลิปที่เจนแล้ว
```
- เวอร์ชันที่ Chrome โหลดอยู่ดูได้จาก `data/extension-state.json` → field `version`.
  **ต้องเช็คทุกครั้งหลัง reload** ว่าตรงกับ manifest ไหม (เคยเสียเวลาเพราะ reload ไม่ติด).
- DOM จริงของ Flow ทุกด่านเก็บไว้ที่ `data/flow-diagnostic-*.json` (imagemode, videomode, medialib ฯลฯ) —
  **อ่านพวกนี้ก่อนแก้ selector** อย่าเดา.

## สิ่งที่เปลี่ยนในเซสชันนี้ (codex ยังไม่เคยเห็น)

### ไฟล์ใหม่
- `src/gemini/edit-director.ts` — Gemini เป็นผู้กำกับตัดต่อ: ดูเฟรมจริงทุกคลิป + ไทม์ไลน์เสียงพากย์
  → คืน `EditPlan` (เลือกช่วง/เรียงลำดับให้ภาพตรงเสียง). `video-assembler` ตัดตาม `-ss/-to`.
- `src/gemini/gemini-tts.ts` — เสียงพากย์ด้วย Gemini TTS (`gemini-3.1-flash-tts-preview`).
  สั่งอารมณ์ด้วย `config.ttsStyle`. คืน PCM → แปลง mp3. edge-tts เป็น fallback.
- `src/scripts/retry-failed.ts` — `npm run retry-failed` กู้ job ที่ retry เต็ม (คลิปเดิมไม่ถูกลบ).

### config ใหม่ (ทั้งหมดมี default ใน `.env` แล้ว)
- `GEMINI_MODEL=gemini-3.5-flash` (เปลี่ยนจาก 2.x ทั้งหมด — user สั่งให้เหลือรุ่นเดียว)
- `GEMINI_THINKING_BUDGET=2048` (ล็อก thinking — 3.5-flash ใช้ 0 แต่กันไว้เผื่อสลับรุ่น)
- `TTS_ENGINE=gemini` (edge = fallback), `GEMINI_TTS_MODEL`, `GEMINI_TTS_VOICES=Kore,Aoede,Leda`, `TTS_STYLE`
- `SUBTITLE_BURN_IN=false` (user ไม่ต้องการซับบนจอ — บทใช้เป็นเสียงพากย์อย่างเดียว. .srt ยังถูกสร้างเก็บไว้)
- `AMBIENCE_VOLUME=0.28` (ผสมเสียง foley ของ Veo กลับเข้าไป — เดิม `-an` ทิ้งหมดทำให้ฟังปลอม)
- `TARGET_LUFS=-14` (มาตรฐาน TikTok — เดิม -18.5 เบาไป)
- `VIDEO_FPS=24` (ตรงกับ native ของ Veo — วัดจากคลิปจริง)
- `STALE_JOB_MINUTES=30`, `FLOW_GENERATION_ENABLED` (credit lock)

### จุดที่ควรระวัง
- **`gemini-3.5-flash` ไม่มีรุ่น TTS** — ต้องใช้ `gemini-3.1-flash-tts` แยก (ถูกต้องแล้ว อย่าเผลอเปลี่ยน).
- `video-assembler.ts` เก็บเสียงคลิปไว้แล้ว (เลิกใช้ `-an`) + normalize=0 ใน amix + loudnorm ท้าย.
  ถ้าคลิปไหนไม่มี audio stream มันยัด `anullsrc` ให้ (กัน concat พัง).
- `planEdit` รับ `narrationTimeline` (จาก `rescaleSegments`) — **ตัวนี้แหละที่ทำให้ภาพตรงเสียง** ห้ามถอด.

## Database ตอนนี้
- job #2: `failed`, clips=2 (ไฟล์ครบ `job_2_video_1/2.mp4`), error `Failed to fetch`.
  → ถ้าจะเทสต์ด่านโหลดคลิป ให้ set `pending` แล้ว unlock+start. เหลือแค่ 1 credit (คลิป 3).
- job #1: `failed`, clips=0. ทิ้งไว้ (จะกิน 3 credit + claim ก่อน #2 เพราะ ORDER BY id).
- job #3: `failed`, clips=0, item ซ้ำกับ #2. ทิ้งไว้.

## Env ที่รันอยู่
- Postgres ใน Docker container `clipbot-pg` (start ด้วย `docker start clipbot-pg` ถ้าดับ).
- Local service `npm run control` port 8100 (Claude restart หลายรอบ — ถ้าแก้ server.ts ต้อง restart).
- Chrome debug port 9222 profile `C:\clipbot-chrome\profile-9222` — login Google แล้ว.
- ffmpeg/ffprobe: `winget` Gyan.FFmpeg (อยู่ใน PATH ของ user, ไม่อยู่ใน PATH ของ bash tool — ต้อง prepend).

## คลิปตัวอย่างที่ทำไว้ให้ user ดู (Downloads/)
`clipbot_v4_ภาพตรงเสียง.mp4` = ตัวล่าสุด (3.5-flash + Gemini TTS + ภาพตรงเสียง).
