# ClipBot Flow — บอทกดเว็บ Google Flow อัตโนมัติ

## ติดตั้งแบบง่าย (Web App + Chrome Extension)

1. ดับเบิลคลิก `ติดตั้ง-ClipBot.bat`
2. ในหน้า `chrome://extensions/` เปิด **โหมดนักพัฒนาซอฟต์แวร์ (Developer mode)**
3. กด **โหลดส่วนขยายที่คลายการบีบอัดแล้ว (Load unpacked)** แล้วเลือกโฟลเดอร์ `extension`
4. ดับเบิลคลิก `เริ่ม-ClipBot.bat` เพื่อเปิดหน้า Web App ที่ `http://127.0.0.1:8110`
5. ปักหมุด ClipBot Flow จากเมนูส่วนขยายของ Chrome — การเพิ่มงาน เริ่ม หยุด และล็อกเครดิตอยู่ที่ Extension เท่านั้น

หลังอัปเดตไฟล์ Extension ให้เปิด `chrome://extensions/` แล้วกด **Reload** ที่ ClipBot Flow จากนั้นรีเฟรชแท็บ Google Flow หนึ่งครั้ง เวอร์ชัน 2.5.2 มีปุ่มควบคุมลอยมุมขวาล่าง ตรวจ Media ID จากการ์ดวิดีโอ และใช้ Chrome Downloads เก็บคลิปจาก Flow โดยไม่ติด CORS ก่อนส่งเข้า Local Service เพื่อเดิน checkpoint และตัดต่ออัตโนมัติ

ค่าเริ่มต้นคือ **ล็อกเครดิต** บอทใน Chrome Extension จะไม่ส่งงานสร้างวิดีโอจนกว่าผู้ใช้จะยืนยันปลดล็อกเอง ทุกงานใช้หลัก **1 รูป → 3 คลิปต่อเนื่อง** โดยนำเฟรมสุดท้ายของคลิปก่อนหน้าไปเป็นจุดเริ่มต้นคลิปถัดไป

## สถาปัตยกรรมปัจจุบัน

```
Chrome Extension (ตัวบอทและตัวควบคุม)
  ├─ เพิ่มงาน / เริ่ม / หยุด / ล็อกเครดิต
  ├─ เปิด Google Flow และกดสร้างวิดีโอ
  └─ ส่ง heartbeat + ผลลัพธ์ให้ Local Service

Local Service (งานสนับสนุน ไม่มีปุ่มควบคุมบนเว็บ)
  ├─ อ่านฐานข้อมูลและให้ Gemini เลือก 1 รูป
  ├─ เก็บคลิป / ดึงเฟรมสุดท้าย / ประกอบวิดีโอ
  └─ ให้ข้อมูลสถานะแบบ read-only

Web App Monitor
  └─ ดูสถานะ Extension, คิว, 3 คลิป และวิดีโอสุดท้ายเท่านั้น
```

Web App ไม่มี API สำหรับเริ่ม/หยุดบอท ปลดล็อกเครดิต เพิ่มงาน หรือลองงานซ้ำ การควบคุมทั้งหมดต้องมาจาก Extension

ไฟล์ `clipbot-flow-extension.zip` ใช้สำหรับเก็บหรือส่งต่อเท่านั้น Chrome ต้องแตก ZIP ก่อน แล้วติดตั้งด้วย Load unpacked

ระบบ **สร้างวิดีโออัตโนมัติ** บนเว็บ [Google Flow](https://labs.google/fx/tools/flow) โดย Content Script ของ Chrome Extension เป็นผู้ควบคุมหน้า Flow โดยตรง ส่วนโค้ด Playwright เดิมยังเก็บไว้เป็นเครื่องมือทดสอบ/สำรอง แต่ไม่ถูกเรียกจาก Web App

## สิ่งที่บอททำ

```
รูปรีวิวจริง (DB) → Gemini Vision (motion prompt + บทพากย์)
  → Flow image-to-video (3 คลิป × 8 วิ) → edge-tts พากย์ไทย
  → FFmpeg (ต่อคลิป + ซับ + เพลง) → วิดีโอพร้อมลง
```

> **ความยาวคลิปสุดท้ายยึดตามเสียงพากย์** (เสียง + 0.5 วิ) — เสียงสั้นกว่าวิดีโอจะตัดวิดีโอส่วนเกินทิ้ง
> เสียงยาวกว่าจะวนวิดีโอซ้ำให้คลุม เพื่อไม่ให้บทพากย์โดนตัดกลางประโยค

## โครงสร้าง

```
new/
├── src/
│   ├── index.ts                 # 🎯 Orchestrator หลัก
│   ├── config.ts                # ⚙️ Config จาก .env
│   ├── types.ts                 # 📐 TypeScript types
│   ├── db/
│   │   ├── database.ts          # 🗄️ PostgreSQL connection
│   │   └── job-repository.ts    # 📋 CRUD flow_job
│   ├── gemini/
│   │   ├── prompt-generator.ts  # 🤖 Gemini Vision → motion prompt + บทพากย์
│   │   └── tts-generator.ts     # 🗣️ edge-tts พากย์ไทย + สร้าง SRT
│   ├── ffmpeg/
│   │   └── video-assembler.ts   # 🎞️ ต่อคลิป + ซับ + เพลง → วิดีโอพร้อมลง
│   ├── flow/
│   │   ├── browser-manager.ts   # 🖥️ จัดการ Chrome CDP
│   │   ├── flow-worker.ts       # 👷 Worker หลัก
│   │   ├── video-generator.ts   # 🎬 สร้างวิดีโอบน Flow
│   │   ├── downloader.ts        # 💾 Download ผลลัพธ์
│   │   └── selectors.ts         # 🎯 CSS selectors (แก้ที่นี่เมื่อ UI เปลี่ยน)
│   ├── utils/
│   │   ├── delay.ts             # ⏱️ Random delay
│   │   ├── human-typing.ts      # ⌨️ พิมพ์เหมือนคน
│   │   ├── logger.ts            # 📝 Logging
│   │   ├── media.ts             # 📏 อ่านความยาวไฟล์ (ffprobe)
│   │   └── retry.ts             # 🔄 Retry logic
│   └── scripts/
│       ├── launch-chrome.ts     # 🖥️ เปิด Chrome
│       ├── test-connection.ts   # 🔍 ทดสอบเชื่อมต่อ
│       └── status.ts            # 📊 ดูสถานะ queue
├── package.json
├── tsconfig.json
├── .env.example
└── .gitignore
```

## วิธีใช้งาน

### 0. ติดตั้งโปรแกรมที่ต้องมีก่อน (จำเป็น!)

บอทเรียก 2 โปรแกรมนี้ผ่าน subprocess — **ถ้าไม่มี Phase 4 (TTS) กับ Phase 5 (FFmpeg) จะพังทันที**

```bash
# FFmpeg — ต่อคลิป + ฝังซับ + มิกซ์เสียง (ต้องมี ffprobe ที่ติดมาด้วย)
winget install Gyan.FFmpeg     # หรือโหลดจาก https://ffmpeg.org/download.html
# ปิด/เปิด terminal ใหม่ แล้วเช็ค:
ffmpeg -version

# edge-tts — เสียงพากย์ไทย (Microsoft Neural TTS)
pip install edge-tts
python -m edge_tts --list-voices | grep th-TH
```

> ถ้าไม่อยากติดตั้ง FFmpeg ลงเครื่อง โหลดแบบ portable แล้วชี้ `FFMPEG_PATH` ใน `.env` ไปที่ `ffmpeg.exe` ได้ (ระบบจะหา `ffprobe.exe` ในโฟลเดอร์เดียวกันเอง)

### 1. ติดตั้ง

```bash
cd new
npm install
cp .env.example .env
# แก้ไข .env — ใส่ DATABASE_URL, GEMINI_API_KEY
```

### 2. เปิด Chrome (ครั้งแรก)

```bash
npm run chrome
```

ทำสิ่งนี้ในแต่ละ Chrome window:
1. **Login Google Account**
2. ไปที่ Google Flow
3. ยอมรับ Terms (ถ้ามี)
4. ลองสร้างรูป/วิดีโอด้วยมือ 1 ครั้ง

### 3. ทดสอบการเชื่อมต่อ

```bash
npm run test-connection
```

### 4. รันบอท

```bash
npm run start
```

### 5. ดูสถานะ

```bash
npm run status
```

### 6. หาอาการพังจาก Log

ระบบเก็บ log อ่านง่ายไว้ที่ `logs/clipbot.log`, error ล้วนที่ `logs/error.log` และเหตุการณ์แบบค้นได้ที่ `logs/events-YYYY-MM-DD.jsonl` โดยไม่บันทึก API key, token, cookie หรือรหัสผ่าน

```bash
# 80 เหตุการณ์ล่าสุด
npm run logs

# ดูเฉพาะงาน #5
npm run logs -- --job 5

# ดูเฉพาะ error หรือเหตุการณ์จาก Extension
npm run logs -- --level error
npm run logs -- --source extension --limit 150
```

แต่ละเหตุการณ์ระบุแหล่งที่มา (`extension`, `service`, `gemini`, `ffmpeg`), ขั้นตอน, หมายเลขงาน, หมายเลขคลิป, ระยะเวลาทำงาน และ error stack เพื่อชี้ว่าพังตรงส่วนใด

## Environment Variables

| ตัวแปร | คำอธิบาย | ค่าเริ่มต้น |
|--------|---------|-----------|
| `DATABASE_URL` | PostgreSQL connection string | **(จำเป็น)** |
| `GEMINI_API_KEY` | Gemini API Key | **(จำเป็น)** |
| `GEMINI_MODEL` | โมเดล Gemini (ต้องรองรับ vision) | `gemini-3.5-flash` |
| `CHROME_DEBUG_PORTS` | Ports ของ Chrome (comma-separated) | `9222,9223,9224,9225,9226` |
| `MAX_CONCURRENT_WORKERS` | จำนวน worker สูงสุด | `5` |
| `DELAY_BETWEEN_JOBS_MIN` | หน่วงเวลาต่ำสุดระหว่าง job (ms) | `30000` |
| `DELAY_BETWEEN_JOBS_MAX` | หน่วงเวลาสูงสุดระหว่าง job (ms) | `120000` |
| `CLIPS_PER_JOB` | จำนวนคลิปต่อ job | `3` |
| `VIDEO_DURATION_SECONDS` | ความยาวคลิป (วินาที) | `8` |
| `TTS_VOICES` | เสียงพากย์ (สุ่มเลือก) | `th-TH-PremwadeeNeural,th-TH-NiwatNeural` |
| `FFMPEG_PATH` | path ของ ffmpeg | `ffmpeg` |
| `BGM_DIR` | โฟลเดอร์เพลง background | `./data/bgm` |
| `OUTPUT_DIR` | โฟลเดอร์ผลลัพธ์ | `./data/output` |

## ⚠️ ข้อควรระวัง

1. **Selectors อาจเปลี่ยน** — เมื่อ Google อัพเดท Flow UI ต้องแก้ไขไฟล์ `src/flow/selectors.ts`
2. **Session หมดอายุ** — ต้อง login ใหม่ใน Chrome เป็นระยะ
3. **Rate Limit** — ไม่ควรรันเร็วเกินไป ใช้ delay ตามที่ตั้งไว้
4. **ห้ามปิด Chrome** — Chrome ต้องเปิดค้างไว้ตลอดที่บอททำงาน
