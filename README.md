# Clip Bot — ระบบสร้าง+โพสต์คลิปรีวิวอัตโนมัติ (ของเราเอง)

Monorepo แทนชุด Samurai ทั้งหมด — เป็นเจ้าของเอง, คุม fleet ได้, และปลอดภัยกว่าเดิม
(สร้างจากพิมพ์เขียว RE ของ SamuraiVdoSp 1.12 แต่ไม่ได้ลอกโค้ด และแก้จุดพังด้านความปลอดภัยทั้งหมด)

## โครงสร้าง (แยกส่วนเพื่อจัดการง่าย)

```
clipbot/
├── backend/     FastAPI — สมองส่วนกลาง (auth, dataset, command queue, status, AI proxy, ingest)
├── frontend/    Web Dashboard — คุม fleet + ดูสถานะ  [Phase 2 · ยังไม่สร้าง]
├── android/     แอปมือถือ (Kotlin) — เจนคลิป + AI caption + auto-post + remote client
├── extension/   Chrome Extension — ดึงรีวิว Shopee เข้าเป็น Dataset
└── docs/        RE analysis + blueprint (พิมพ์เขียว/สเปค)
```

## สถานะแต่ละส่วน
| ส่วน | สถานะ | หมายเหตุ |
|---|---|---|
| backend | ✅ Phase 0–1 (รัน+ทดสอบผ่าน) | control loop + ingest + media |
| extension | ✅ source ครบ | ดักจับ `get_ratings` — เหลือ verify กับ Shopee สด |
| android | 🟡 source ครบ (ยัง build ไม่ได้ที่นี่) | ต้อง Android SDK |
| frontend | ⬜ Phase 2 | ดู `frontend/README.md` |

## รันแต่ละส่วน

### backend
```bash
cd backend
python -m venv .venv
.venv/Scripts/python -m pip install -r requirements.txt
.venv/Scripts/python seed.py            # ได้ DEVICE_TOKEN
.venv/Scripts/python -m uvicorn app.main:app --host 0.0.0.0 --port 8000
# docs อัตโนมัติ: http://<ip>:8000/docs · จำลอง device: python device_sim.py
```

### android
> ⚠️ **สำคัญ:** path นี้มีอักษรไทย+เว้นวรรค → **Gradle build ไม่ผ่าน**
> ให้ build จาก path แบบ ASCII (เช่น `C:\dev\clipbot-android`) หรือใช้ **GitHub Actions**
> (มี `.github/workflows/android-build.yml` ในโฟลเดอร์ android) build บนคลาวด์แทน
เปิด `android/` ใน Android Studio → ตั้งค่า `local.properties` (sdk.dir) → Run/Build APK

### extension
Chrome → `chrome://extensions` → Developer mode → **Load unpacked** → เลือกโฟลเดอร์ `extension/`
กรอก Backend URL + Extension Token (`ext_…` ออกจาก `/api/admin/ext-tokens`)

## หลักการ "ทำให้ดีกว่าเดิม" (แก้จากผล RE)
- 🔑 คีย์ AI อยู่ที่ **เซิร์ฟเวอร์** (device ไม่เคยถือคีย์) — เดิมยัดลงเครื่อง
- 🔒 secret ในแอปเก็บใน **Keystore (เข้ารหัส)** — เดิม plaintext
- 🌐 TLS จริง + cert pinning (ตอน deploy) — เดิม TrustManager ยอมทุก cert
- 🚫 ไม่มี auto-update เถื่อน — เดิมยัด APK อะไรก็ได้ (RCE)
- ⏱ item lock มี **TTL** + สถานะ **posted/verified** ซื่อสัตย์ — เดิมเดาว่าสำเร็จเมื่อปุ่มหาย

## เอกสาร (docs/)
- `SECURITY_RE_ANALYSIS.md` — RE + security ฉบับเต็มของ SamuraiVdoSp 1.12
- `owned-system-blueprint.html` — สถาปัตยกรรม+roadmap ระบบของเรา
- `rebuild-blueprint.html` — feasibility เริ่มต้น
