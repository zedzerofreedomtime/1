# โครงสร้างโค้ด ClipBot Flow

ปรับโครงเมื่อ 27 ก.ค. 2026 — เดิม backend กับ frontend ปนกันในราก และมีไฟล์
ระดับพันบรรทัดที่รวมหลายเรื่องไว้ด้วยกัน เอกสารนี้บอกว่า "จะแก้เรื่องนี้ ต้องไปไฟล์ไหน"

## ภาพรวม

```
backend/     Node + TypeScript — Local Service (พอร์ต 8110)
frontend/    React — หน้ามอนิเตอร์ (อ่านอย่างเดียว สั่งงานบอทไม่ได้)
extension/   Chrome Extension ตัวคุมบอท (ClipBot Flow)
clipbot-flow-extension/   สำเนาของ extension/ ที่ต้องตรงกันเป๊ะ
data/        ไฟล์สถานะ, product brief, ผลลัพธ์วิดีโอ
```

frontend คุยกับ backend ผ่าน HTTP `/api/*` เท่านั้น **ห้าม import ข้ามฝั่ง**
(regression มีเช็คข้อนี้ไว้ — ถ้า import ตรง โค้ด backend จะหลุดไปอยู่ใน bundle ของเบราว์เซอร์)

## backend/src/

| โฟลเดอร์ | หน้าที่ |
|---|---|
| `server/` | HTTP server และ routing |
| `gemini/` | เรียก Gemini: วางแผนช็อต, บทพากย์, ตรวจความตรงของสินค้า, TTS |
| `extension/` | วงจรชีวิตงานที่ ClipBot Flow extension ใช้ |
| `scrape/` | รับข้อมูลจาก Shopee Harvester extension |
| `ffmpeg/` | ประกอบวิดีโอสุดท้าย |
| `db/` | PostgreSQL (SQL ดิบ ไม่มี ORM) |
| `utils/` | log, retry, ตรวจไฟล์สื่อ |

### server/

`index.ts` เรียก route ทีละตัวตามลำดับ แต่ละตัวคืน `true` = จัดการแล้ว,
`false` = ส่งต่อตัวถัดไป **`static.routes.ts` ต้องอยู่ท้ายสุดเสมอ** เพราะจับทุก path ที่เหลือ

| ไฟล์ | ดูแล |
|---|---|
| `routes/dashboard.routes.ts` | `/api/dashboard`, `/api/gallery/delete` |
| `routes/scrape.routes.ts` | `/api/scrape/*` (Shopee Harvester) |
| `routes/extension-runtime.routes.ts` | heartbeat, คำสั่งรีโมต, log, diagnostic |
| `routes/extension-jobs.routes.ts` | สร้าง/จองงาน, เก็บรูปและคลิป, ปิดงาน |
| `routes/media.routes.ts` | `/api/media` เสิร์ฟรูป/คลิปที่ระบบสร้าง |
| `routes/automation.routes.ts` | `/api/mouse/path` (งานฝั่ง Antigravity) |
| `routes/static.routes.ts` | frontend ที่ build แล้ว + ไฟล์ extension |
| `http.ts` | CORS, sendJson, readJson, streamFile, ชนิด `RouteHandler` |
| `paths.ts` | path ที่ใช้ร่วมกัน + `ACTIVE_EXTENSION_VERSION` |

⚠️ ทุก response ต้องมี CORS — content.js รันบน `labs.google` เป็น cross-origin
ถ้าลืม เบราว์เซอร์บล็อกแล้ว extension จะเห็นแค่ `Failed to fetch` หาสาเหตุไม่เจอ

### gemini/

| ไฟล์ | ดูแล |
|---|---|
| `prompt-generator.ts` | วางแผนช็อต + บทพากย์ และเป็น **barrel** ที่ re-export โมดูลด้านล่าง |
| `narration-rules.ts` | กฎบทพากย์: ความยาว, ห้ามอ้างสรรพคุณ, เพศเสียงเดียว, บทสำรอง |
| `motion-prompts.ts` | กัน motion prompt ที่ทำให้สินค้าเพี้ยน (หมุนไปหลัง/เปิดฝา) |
| `fidelity-check.ts` | ด่านเทียบสินค้าก่อนจ่ายเครดิตวิดีโอ |
| `json-parser.ts` | แกะ JSON ที่โมเดลคืนมาผิดรูป (ขาด comma / มีข้อความเกิน) |
| `gemini-client.ts` | ตัวเชื่อม Gemini + แปลงรูปเป็น inline part |
| `tts-generator.ts` | เสียงพากย์ + จัดจังหวะให้ตรงคลิป |

**อยากแก้บทพากย์** → `narration-rules.ts` (กฎ) คู่กับ `prompt-generator.ts` (สิ่งที่ส่งให้ Gemini เห็น)
**อยากแก้ prompt ที่ส่งให้ Flow ตอนเจนรูป** → `extension/extension-api.ts` (`buildReferenceImagePlan`)

⚠️ กฎ motion กับ validator บทพากย์ **ต้องแก้คู่กัน** — เคยคลายฝั่ง motion อย่างเดียวแล้ว
validator ยังบังคับของเดิมอยู่ บททั้งชุดเลยตกไปใช้บทสำรอง (job #128 ซ้ำรอย #100)

### extension/

| ไฟล์ | ดูแล |
|---|---|
| `extension-api.ts` | จองงาน, เตรียมรูป/พรอมต์, เก็บคลิป และเป็น **barrel** |
| `job-finalize.ts` | ประกอบวิดีโอสุดท้าย, ปิดงานแบบล้มเหลว/พักไว้ |
| `clip-fidelity.ts` | เทียบเฟรมแรกของคลิปกับรูปอ้างอิง — **ห้าม `throw`** คลิปที่จ่ายแล้วต้องไม่ถูกทิ้ง |
| `reference-style.ts` | เลือกฉากหลังให้เข้ากับหมวดสินค้า |
| `runtime-state.ts` | สถานะ/heartbeat ของ Extension |
| `job-duration.ts` | แปลง 16/24 วิ เป็นจำนวนคลิป |

## ส่งงานให้คนนอกรีวิว

`BRIEF-for-video-reviewer.md` คือไฟล์ที่ต้องแนบไปด้วยทุกครั้งที่ให้ ChatGPT หรือคนอื่น
รีวิวไฟล์ `job_XX_final.mp4` เพราะเขาเห็นแค่วิดีโอ ไม่เห็นโค้ด จึงมักเสนอสิ่งที่ระบบทำอยู่แล้ว
(เช่น "ใช้เฟรมสุดท้ายเป็น reference") หรือสิ่งที่ทำไม่ได้เพราะเราคุยกับ Flow ผ่านหน้าเว็บเท่านั้น

**เวลาเปลี่ยนค่าสำคัญ (ความละเอียด, องศาการหมุน, flag เปิด/ปิด) ต้องอัปเดตตารางในไฟล์นั้นด้วย**
ไม่งั้นรอบรีวิวถัดไปจะได้คำแนะนำจากข้อมูลเก่า

## คำสั่งที่ใช้บ่อย

```bash
npm run control          # เปิด Local Service
npm run web:build        # build frontend
npm run test-regression  # ตรวจว่าพฤติกรรมไม่ถอยหลัง
npm run status           # ดูสถิติงานใน DB
```

## กติกาที่ regression บังคับไว้

1. `src/` และ `web/` ที่รากต้องไม่กลับมาอีก
2. frontend ห้าม import จาก backend
3. ไฟล์ใน `backend/src/` ต้องไม่เกิน 1000 บรรทัด — เกินเมื่อไหร่ให้แตกเป็นโมดูล
4. `extension/` กับ `clipbot-flow-extension/` ต้องตรงกันเป๊ะ

## หมายเหตุเรื่อง barrel

`prompt-generator.ts` และ `extension-api.ts` ยัง re-export ของที่ย้ายออกไปแล้ว
ผู้เรียกเดิมจึงไม่ต้องแก้ import **เวลาเขียนโค้ดใหม่ควร import จากโมดูลจริงโดยตรง**
จะได้เห็นชัดว่าพึ่งพาอะไรอยู่
