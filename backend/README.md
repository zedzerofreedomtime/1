# ClipBot Backend — Phase 0

Backend ของเราเอง (แทน "VPS A + VPS B" ของ Samurai) — FastAPI + SQLite.
คุม fleet: ออก token ต่อเครื่อง, คิวคำสั่ง, dataset + item lock, รับสถานะ, และ **AI proxy** (คีย์อยู่ที่เซิร์ฟเวอร์).

> **สถานะ:** Phase 0 — ลูปควบคุม 1 เครื่องทำงานครบ (verified). ยังไม่ต่อกับแอป Android จริง (ขั้นต่อไป).

## รัน
```bash
python -m venv .venv
.venv/Scripts/python -m pip install -r requirements.txt     # (mac/linux: .venv/bin/python)
.venv/Scripts/python seed.py                                # สร้าง device+dataset ทดสอบ → พิมพ์ DEVICE_TOKEN
.venv/Scripts/python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```
เปิด API docs อัตโนมัติ: http://127.0.0.1:8000/docs

## ตั้งค่า (`.env`, มี default หมด รันได้เลยไม่ต้องมีไฟล์)
- `ADMIN_KEY` — คีย์สำหรับ endpoint แอดมิน (เปลี่ยนก่อนใช้จริง)
- `AI_PROVIDER` = `stub` | `openai` | `gemini` — ใส่ `OPENAI_API_KEY`/`GEMINI_API_KEY` ที่ **เซิร์ฟเวอร์** (device ไม่เคยเห็นคีย์)
- `LOCK_TTL_SEC` — อายุ lock ของ item (แก้จุดที่ของเดิม lock ไม่มีวันหมดอายุ)

## Auth
- **Device:** `Authorization: Bearer <token>` (token ขึ้นต้น `app_`, ออกจาก `/api/admin/devices`, เพิกถอนได้)
- **Admin:** header `X-Admin-Key: <ADMIN_KEY>`
- token = `"tampered"` → 403 (รองรับ anti-tamper แบบเดียวกับแอป)

## Endpoint (verified)
**Device** (`/api/discover`, `/api/app/*`): `discover · version · heartbeat · status · commands (+ack) · datasets · auto-pick · datasets/{id}/opened|closed|items · items/{pid} · items/{pid}/start|done|release · ai/caption`
**Admin** (`/api/admin/*`): `devices (สร้าง/ดู) · devices/{id}/revoke · commands (สั่ง start/stop/pause/resume/set_config) · datasets (สร้าง+items) · status`

ตัวอย่างลูป:
```bash
# แอดมินสั่งงาน
curl -H "X-Admin-Key: $ADMIN" -H "Content-Type: application/json" \
  -X POST localhost:8000/api/admin/commands \
  -d '{"device_id":1,"action":"start","params":{"pick_mode":"auto","config":{"clip_count":3}}}'
# เครื่องดึงคำสั่ง
curl -H "Authorization: Bearer $TOKEN" "localhost:8000/api/app/commands?device_id=1"
```

## ต่างจากของเดิม (security-by-design)
- 🔑 **คีย์ AI อยู่ที่เซิร์ฟเวอร์** — device เรียก `/api/app/ai/caption` ส่งแค่ข้อมูลสินค้า ไม่เคยถือคีย์
- 🔒 **item lock มี TTL** + คืน 409 `already_posted` เมื่ออีกเครื่องถืออยู่
- ♻️ **token เพิกถอนได้** ต่อเครื่อง
- 🚫 ไม่มี endpoint อัปเดต APK เถื่อน (แจกแอปผ่านช่องทางที่ verify signature เอง)
- TLS/pinning จะบังคับตอน deploy จริง (ตอน dev รัน HTTP local)

## ขั้นต่อไป
1. **ต่อแอป Android (Clip Bot)** — เพิ่ม network client + RemoteControlService ให้ poll `/api/app/commands` และรายงาน `/api/app/status`
2. **Shopee scraper** → push เข้า `/api/admin/datasets` (หรือ ingest endpoint)
3. **Web dashboard** เรียก `/api/admin/*`

## โครงสร้าง
```
app/
  main.py            # FastAPI app + error handler (คืน {error,message})
  config.py db.py    # settings + SQLModel engine
  models.py          # Device, Dataset, Item, Command, StatusReport
  auth.py            # device Bearer + admin key
  routers/
    auth.py          # /api/discover
    app_api.py       # /api/app/*  (device)
    ai.py            # /api/app/ai/caption  (server-side AI proxy)
    admin.py         # /api/admin/*  (dashboard/ops)
seed.py              # demo device + dataset
```
