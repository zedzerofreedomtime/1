# ClipBot Flow — สำหรับ Claude

> ⚠️ **ส่วนกลางของไฟล์นี้ถูกคัดลอกมาจาก [`AGENTS.md`](./AGENTS.md) อัตโนมัติ**
> จะแก้เนื้อหาส่วนกลาง ให้แก้ที่ `AGENTS.md` แล้วรัน `npm run brief`
> แก้ตรงนี้จะถูกเขียนทับ และ regression จะ FAIL เพราะสองไฟล์ไม่ตรงกัน
>
> **สถานะสด (เวอร์ชัน, service, งานที่ค้าง) อยู่หัวไฟล์ `AGENTS.md`** — เปิดอ่านก่อนเริ่มงาน
> รายละเอียดรอบล่าสุดอยู่ท้าย [`AGENT-COORDINATION.md`](./AGENT-COORDINATION.md)

## เรื่องเฉพาะของ Claude

- เขตงาน: `extension/content.js`, `backend/src/gemini/**`, `backend/src/extension/**`, `backend/src/db/**`
- เจ้าของสั่งให้รายงานตรงไปตรงมา รวมถึงตอนที่ตัวเองทำพลาด — เคยฆ่า process ผิดตัวจน service
  ล้มกลางงาน #131 และเคยรายงานว่าโค้ดตายทั้งที่สคริปต์ใน `backend/scripts/` ยังเรียกอยู่
  (สแกนหาโค้ดตายต้องครอบ `backend/scripts/` ด้วยเสมอ)
- ก่อนบอกว่าเสร็จ: `npx tsc --noEmit` + `npm run test-regression` ต้องผ่านทั้งคู่

<!-- SHARED:START -->
## เป้าหมายของเจ้าของงาน

ทำ Chrome Extension ที่ขับ Google Flow ให้ผลิตคลิปรีวิวสินค้าภาษาไทยแนวตั้ง 16 วินาทีอัตโนมัติ
Web App เป็นหน้ามอนิเตอร์อย่างเดียว **ห้ามให้มันสั่งบอทได้**

รูปสินค้าที่เลือกไว้หนึ่งใบต้องถูกใช้สร้างคลิปที่ต่อเนื่องกัน Gemini เป็นคนเลือกรูปและวางแผนพรอมต์
**คลิปถัดไปต้องต่อจากคลิปก่อนหน้า ไม่ใช่หยิบรูปคนละใบมาเจนแยกกัน**

## กฎความปลอดภัย

- **การเจนที่เสียเครดิตได้รับอนุญาตแล้ว** เจ้าของยกเลิกกฎ "ห้ามเจนก่อนขออนุญาต" เมื่อ 17 ก.ค. 2026
  และให้สิทธิ์ยืนยาวสำหรับโปรเจกต์นี้ ไม่ต้องหยุดถามก่อนทุกคลิป
- ถึงอย่างนั้นเครดิตมีจำกัด ต้องใช้อย่างตั้งใจ:
  - รักษา checkpoint เดิมไว้ **ห้ามเจนคลิปที่อยู่ใน `clip_paths` แล้วซ้ำเด็ดขาด**
  - โค้ดที่เพิ่งแก้ ให้พิสูจน์ด้วยงานที่ถูกที่สุดก่อน แล้วค่อยปล่อยที่เหลือ
  - เรื่อง selector และสถานะ ให้ไล่แบบไม่จ่ายเครดิตถ้า dry run พิสูจน์ได้
- **เจ้าของเท่านั้นที่กด Start และปลดล็อกเครดิต** ตัวคุมอยู่ในป๊อปอัป Extension
  ระบบตั้งใจไม่มี endpoint สั่งเริ่ม เอเจนต์จึงสั่งรันเองไม่ได้
- Flow ขึ้น **"กิจกรรมผิดปกติ" → หยุดทันที ห้ามหาทางกดผ่าน**
- ห้ามเปิดเผยหรือพิมพ์ `.env`, `DATABASE_URL`, `GEMINI_API_KEY`
- คีย์ Gemini เคยถูกวางในแชท ยังต้องหมุนคีย์ใหม่

## เขตงาน — 3 เอเจนต์ทำงานพร้อมกัน

เจ้าของแบ่งบทบาทใหม่ 31 ก.ค. 2026 — แบ่งตาม **ชนิดของงาน** ไม่ใช่แค่ชื่อไฟล์

| เอเจนต์ | บทบาท | ทำอะไร |
|---|---|---|
| **Claude** | Architect / Investigator | วิเคราะห์ทั้งระบบ · ออกแบบโครงสร้าง · หา root cause · refactor งานซับซ้อน |
| **Codex** | Implementer / QA Engineer | เขียนฟีเจอร์ · แก้ ticket · เพิ่มเทสต์ · รัน build/lint · ตรวจ diff และ PR |
| **Antigravity** | Anti-detection | งานหลบการตรวจจับ · typing pattern · mouse path |

ไฟล์ที่แต่ละคนถือ (ยังใช้เหมือนเดิม เป็นตัวกันชนกันตอนแก้พร้อมกัน):

| เอเจนต์ | ถือไฟล์ |
|---|---|
| **Claude** | `extension/content.js`, `backend/src/gemini/**`, `backend/src/extension/**`, `backend/src/db/**` |
| **Codex** | `extension/background.js`, `backend/src/server/**`, manifest + ตัวแพ็ก, `backend/scripts/regression-check.ts` |

**วิธีส่งงานกัน:** Claude วินิจฉัยแล้วเขียน **ticket** ไว้ท้าย [`AGENT-COORDINATION.md`](./AGENT-COORDINATION.md)
พร้อมหลักฐาน (งานเลขอะไร ไฟล์ไหน บรรทัดไหน เห็นอะไร) แล้ว Codex ลงมือแก้ + เขียนเทสต์ + ตรวจ diff

Codex อ่านได้ทุกไฟล์รวมถึงเขตของ Claude และ **ตรวจงานของ Claude เป็นหน้าที่**
ถ้าเห็นว่า Claude คลายด่านไหนแล้วเสี่ยง ให้ทักได้เลย — เจ้าของตั้งใจให้มีคนตรวจอีกชั้น
ส่วนจะ **แก้** ไฟล์นอกเขตตัวเอง ให้เขียนบอกในกระดานก่อน

⚠️ `extension/background.js` ใช้ร่วมกัน 3 คน **ห้ามเขียนทับทั้งไฟล์** (เคยทำให้ตัวกันเครดิตหาย 9 ตัว)

## สถาปัตยกรรม

- **Chrome Extension** ถือ Start/Stop, ล็อกเครดิต, คุมแท็บ Flow, ฉีด content script,
  ดาวน์โหลดคลิป และเดิน checkpoint
- **Local Node service** เตรียมงานด้วย Gemini, เสิร์ฟไฟล์สื่อ, เก็บคลิป, ทำ TTS/ซับ/FFmpeg
  และป้อนข้อมูลให้หน้ามอนิเตอร์
- **Web App** อ่าน `/api/dashboard` อย่างเดียว endpoint สั่งบอทแบบเก่าตั้งใจไม่ให้มี
- โครงไฟล์อยู่ใน [`STRUCTURE.md`](./STRUCTURE.md) — `src/` กับ `web/` ที่รากไม่มีแล้ว
  ย้ายลง `backend/` กับ `frontend/` ตั้งแต่ 27 ก.ค.

## ไปป์ไลน์ปัจจุบัน (3 จุด)

1. เจนรูปตั้งต้นจาก **รูปรีวิวจริง** (`firstImageSource=review`)
2. รูปนั้น + **รูปทางการ 3 ใบ** เข้าโหมด **ส่วนผสม** → คลิป 1
3. คลิป 2 ต่อจาก **เฟรมสุดท้ายของคลิป 1** (โหมดเฟรม)

งาน 16 วิ = 2 คลิป (`backend/src/extension/job-duration.ts`)

⚠️ **โหมดส่วนผสมวาดสินค้าใหม่จากรูปอ้างอิง ไม่ได้ขยับพิกเซลของเฟรมตั้งต้น** — ถ้าสินค้าเพี้ยน
ในคลิปทั้งที่รูปตั้งต้นตรง ต้นเหตุอยู่ตรงนี้ ไม่ใช่ขั้นเจนรูป

### ด่านคุณภาพ — อย่าลบ อย่าคลายทีละตัว

| ด่าน | ไฟล์ |
|---|---|
| เทียบสินค้าก่อนจ่ายเครดิตวิดีโอ | `backend/src/gemini/fidelity-check.ts` |
| เทียบเฟรมแรกของคลิปกับรูปอ้างอิง | `backend/src/extension/clip-fidelity.ts` |
| กฎบทพากย์ (ความยาว/สรรพคุณ/เพศเสียง) | `backend/src/gemini/narration-rules.ts` |
| กัน motion ที่ทำให้สินค้าเพี้ยน | `backend/src/gemini/motion-prompts.ts` |

- `clip-fidelity.ts` **ห้าม `throw`** — คลิปที่จ่ายเครดิตแล้วต้องไม่ถูกทิ้งเพราะด่านล้ม
- ด่าน motion กับ validator บทพากย์ **ต้องแก้คู่กัน** เคยคลายฝั่งเดียวแล้วบททั้งชุดตกไปใช้
  fallback (#128 ซ้ำรอย #100)
- บทพากย์ต้องเล่าสิ่งที่เห็นในช็อตก่อน แล้วค่อยโยงเข้าสเปก — ท่าที่สั่งไว้ถูกส่งเข้าไปให้คนเขียนบท
  ผ่าน `describeMotionAction()` แล้ว (job_134 เคยพูดสเปกลอยๆ ไม่เกี่ยวกับภาพเพราะยังไม่มีตัวนี้)

## DOM จริงของ Flow editor — เชื่อตารางนี้ก่อนเดา

ทุกครั้งที่ content script ล้ม ระบบจะ POST snapshot ไป `/api/extension/diagnostic`
→ `data/flow-diagnostic.json` **อ่านไฟล์นั้นก่อนแตะ selector ใดๆ**

| element | ข้อความ |
|---|---|
| `button[aria-haspopup="menu"]` | ชื่อโมเดล — **มีสองตัว** ดูหัวข้อถัดไป |
| `button[aria-haspopup="dialog"]` | `add_2สร้าง` — ปุ่ม "+" |
| `div[role="textbox"]` | `คุณต้องการสร้างอะไร` — ช่องพรอมต์ |
| `button` | `arrow_forwardสร้าง` — ปุ่มส่ง |

สองข้อที่ล้มทฤษฎีเก่า:

1. **ไม่มีปุ่ม `เริ่ม` / Start-frame ใน DOM เลย** ตัวที่เห็นบนจอเป็นข้อความบน canvas
2. โปรเจกต์ใหม่เปิดมาใน **โหมดรูป (Nano Banana)** ไม่ใช่โหมดวิดีโอ ปุ่มเฉพาะวิดีโอจึงยังไม่โผล่

ข้อความของ Flow เอา ligature ไอคอนต่อกับข้อความเสมอ (`add_2สร้าง`, `arrow_forwardสร้าง`)
→ **regex ที่ยึด `^...$` พังทุกตัว ให้จับ substring**

### ⚠️ ปุ่มชื่อโมเดลมีสองตัว — อย่าคว้าตัวแรก (ยืนยันในเบราว์เซอร์จริง 30 ก.ค. 10:48)

| # | ข้อความจริง | `aria-expanded` | คืออะไร |
|---|---|---|---|
| ① | `🍌 Nano Banana 2 Lite`**`crop_9_16x1`** | `true` ตอนแผงเปิด | ปุ่มตั้งค่า composer (ชั้นนอก) |
| ② | `🍌 Nano Banana 2 Lite`**`arrow_drop_down`** | `false` | ปุ่มเลือกโมเดล (ตัวที่ต้องกด) |

`querySelectorAll('[aria-haspopup="menu"]').find(มีคำว่า Nano Banana)` จะได้ ① เสมอ ซึ่ง
`aria-expanded="true"` ค้างอยู่แล้ว → `openPanel()` คืน true ทันทีโดยไม่กดอะไร → หาเมนูโมเดลไม่เจอ
แล้วโยน "Nano Banana Pro is unavailable" ทั้งที่ยังไม่เคยเปิดเมนู (#116/#118/#119 ล้มใน 1.7 วินาที)
**ตัวที่ใช่มี ligature `arrow_drop_down` เสมอ**

ผลพลอยได้: `openPanel()` **ห้ามลัดด้วย `aria-expanded`** เมื่อผู้เรียกส่ง `confirmOpen` มาแล้ว

### ⚠️ ป้ายจำนวนผลลัพธ์คือ `x1` ไม่ใช่ `1x` (Flow เปลี่ยน — ยืนยัน 30 ก.ค. 11:01)

แท็บในแผงตั้งค่าวิดีโอตามลำดับจริง:

```
imageรูปภาพ · videocamวิดีโอ · crop_freeเฟรม · chrome_extensionส่วนผสม
crop_9_169:16 · crop_16_916:9 · 4s · 6s · 8s · 10s · x1 · x2 · x3 · x4
```

`/^1x$/i` จึงไม่มีวันตรง → #120 ล้มที่ "ไม่พบตัวเลือก 1x" ทั้งที่ Flow เลือก x1 ไว้ให้แล้ว
ใช้ `ONE_OUTPUT_PATTERN` ใน `content.js` จุดเดียว และค้นเฉพาะใน `[role="tab"]`
(`MENU_ITEM` กว้างถึง `button` ทั่วไป จะไปโดนปุ่ม composer ที่ลงท้าย `...crop_9_16x1`)

**บัญชีนี้มี Nano Banana Pro จริง** — เมนูมี `🍌 Nano Banana Pro`, `🍌 Nano Banana 2`,
`🍌 Nano Banana 2 Lite`

## กติกาเวลาแก้ extension

1. ขยับเวอร์ชัน **ครบ 3 จุด**: `extension/manifest.json`,
   `clipbot-flow-extension/manifest.json`, `backend/src/server/paths.ts`
   (`ACTIVE_EXTENSION_VERSION`) ไม่งั้น service ตอบ 426 ปฏิเสธ extension
2. **รีสตาร์ต Local Service** ทุกครั้งหลังแก้ฝั่ง backend — service ไม่ได้รันแบบ watch
3. `npm run test-regression` ก่อนถือว่าเสร็จเสมอ — FAIL ที่ไม่เกี่ยวกับงานตัวเอง =
   เพิ่งลบตัวกันของคนอื่น **ห้ามแก้ assertion ให้ผ่าน**
4. sync `extension/` ↔ `clipbot-flow-extension/` **หลัง** regression ผ่านแล้วเท่านั้น
5. งานเป็นชิ้นแล้ว **commit ลง git** ไม่งั้นถูกเขียนทับแล้วกู้ไม่ได้

## เริ่มระบบหลังรีสตาร์ตเครื่อง

PostgreSQL ของโปรเจกต์นี้เป็น **Docker container** ไม่ใช่โปรแกรมติดตั้งปกติ ถ้า Local Service
ขึ้น `ECONNREFUSED 127.0.0.1:5432` แปลว่า Docker Desktop ยังไม่ได้เปิด

⚠️ Docker Desktop ติดตั้งที่ `AppData\Local\Programs` **ไม่ใช่** `Program Files` และไม่มี
Windows Service ชื่อ postgres ให้หา — อย่าเสียเวลาไล่หา `pg_ctl.exe`

```bash
"C:\Users\edit01\AppData\Local\Programs\DockerDesktop\Docker Desktop.exe"
```

เปิดแล้ว engine ขึ้นภายในไม่กี่วินาที และ `clipbot-pg` (postgres:16) กับ `clipbot-pgadmin`
จะสตาร์ตเองอัตโนมัติ จากนั้นค่อยสตาร์ต Local Service **แบบ detached** (ห้ามผูกกับ session
ของเอเจนต์ ไม่งั้นเซสชันจบแล้ว service ตายตาม พาบอทล้มกลางงาน)

> พอร์ต 8110 ไม่ใช่ 8100 เพราะมีแอป Python/Uvicorn ที่ไม่เกี่ยวกันถือ 8100 อยู่ **ห้ามไปหยุดมัน**

```bash
npm run control:auto
```

`control:auto` คือ supervisor ที่รีสตาร์ต service ให้เอง **เฉพาะตอนไม่มีงานเดินอยู่**
(`npm run control` คือรัน service ตรงๆ ไม่มีตัวกู้)

## คำสั่งที่ใช้บ่อย

```bash
npm run brief            # อัปเดตสถานะสดในบรีฟนี้ + ซิงก์เข้า CLAUDE.md
npm run test-regression  # ต้องผ่านก่อนถือว่าเสร็จเสมอ
npm run status           # สถิติงานใน DB
npm run logs             # log ล่าสุด
```

## ไฟล์ที่ควรรู้จัก

- [`AGENT-COORDINATION.md`](./AGENT-COORDINATION.md) — กระดานงานกลาง **สรุปสถานะล่าสุดอยู่ท้ายไฟล์**
- [`STRUCTURE.md`](./STRUCTURE.md) — จะแก้เรื่องไหนต้องไปไฟล์ไหน
- [`BRIEF-for-video-reviewer.md`](./BRIEF-for-video-reviewer.md) — ส่งให้คนนอกที่รีวิว `job_XX_final.mp4` โดยไม่เห็นโค้ด
- `extension/content.js` — คุย DOM ของ Flow และตรวจจับการเจน
- `extension/background.js` — วนคิวงาน, ฉีดสคริปต์, เดิน checkpoint (**ไฟล์ใช้ร่วม**)
- `backend/src/extension/extension-api.ts` — เตรียม/เก็บ/ปิดงานของ Extension
- `backend/src/server/index.ts` — routing ของมอนิเตอร์และ Extension API
- `backend/src/db/job-repository.ts` — เก็บงานแบบรู้จัก checkpoint
<!-- SHARED:END -->
