# Clip Bot — Shopee Auto Harvester (Chrome Extension v0.2)

## v0.2.3 reliability fixes

- เก็บ response หน้าแรกไว้ชั่วคราว แม้ Shopee จะตอบก่อน background ส่งคำสั่งเริ่ม
- รอ backend ยืนยันว่า ingest สำเร็จก่อนประกาศว่างานเสร็จ
- รองรับชื่อ field รูป/วิดีโอของ Shopee หลายรูปแบบขึ้น
- บันทึกเฉพาะโครงสร้าง field และจำนวนข้อมูลลง diagnostic log เพื่อ debug โดยไม่เก็บเนื้อหารีวิวเพิ่ม

ตัวเก็บรีวิว Shopee **อัตโนมัติแบบ queue-driven** — ชี้มา backend ของคุณเอง **ไม่ต้องใส่ token**
(เวอร์ชันของเราเองแทน "Samurai Bot" ของคนขาย ที่ต้องผูก ext_ token + เซิร์ฟเวอร์คนขาย)

## ทำงานยังไง (เหมือนตัวคนขาย แต่ตัด token/เซิร์ฟเวอร์คนขายออก)
```
Dashboard (แท็บ Scrape) วางลิงก์สินค้า → เข้าคิว backend
        ↓  extension poll /api/scrape/next  (ไม่มี token)
background พาแท็บ foreground ไปหน้ารีวิว Shopee (/shop/SHOP/item/ITEM/rating)
        ↓  content.js เลื่อน/เก็บครบทุกหน้า (สูงสุด maxPages)
inject.js ดัก get_ratings → parse รีวิว+รูป+วิดีโอ
        ↓  background POST /api/scrape/ingest → Dataset item + media
เสร็จ → /api/scrape/{id}/done → งานถัดไป (ใช้แท็บเดิม)
```
- **ทีละสินค้า** ใช้แท็บที่เปิดอยู่ (ไม่เปิดแท็บซ่อน)
- เจอ **captcha / error 90309999** → หยุด รอผู้ใช้ยืนยันตัวตน แล้วกดเริ่มใหม่

## ติดตั้ง (dev)
1. Chrome → `chrome://extensions` → เปิด **Developer mode**
2. **Load unpacked** → เลือกโฟลเดอร์ `clipbot-extension`
3. กดไอคอน → ใส่ **Backend URL** (`http://127.0.0.1:8000`) + **maxPages** → บันทึก

> ไม่มีช่อง token — เลิกพึ่ง token/เซิร์ฟเวอร์คนขายแล้ว

## ใช้งาน
1. เปิด Dashboard → แท็บ **Scrape** → วางลิงก์สินค้า Shopee (บรรทัดละ 1) + ตั้งชื่อ dataset → **+ เข้าคิว**
2. กดไอคอน extension → **▶ เริ่ม**
3. ระบบพาแท็บไปหน้ารีวิวเอง เก็บครบแล้วไปสินค้าถัดไป — ดูผลใน Dashboard แท็บ **Datasets**

## ⚠ จุดที่ต้องเช็คกับ Shopee จริง
`content.js` แกะ get_ratings ตาม data model ที่ยืนยันจากแอปต้นฉบับ (image=hash→CDN, video=object→url)
**ถ้า media ว่าง** → เปิด DevTools (F12) → Console ดูบรรทัด `get_ratings` / `sample rating` แล้วปรับ
`toImg()`/`toVid()` ใน `content.js` ให้ตรง field จริง (contract → backend ทดสอบแล้วถูกต้อง)

## ไฟล์
- `manifest.json` — MV3, no token, permissions: storage/tabs/scripting/alarms
- `inject.js` — hook fetch/XHR จับ get_ratings (MAIN world) + ตรวจ anti-bot
- `content.js` — harvester: เลื่อน/pagination/parse รีวิว (ISOLATED world)
- `background.js` — queue driver: poll → navigate → ingest → next
- `popup.html` / `popup.js` — Backend URL + maxPages + Start/Stop + สถานะ

## Backend endpoints (ไม่มี auth — localhost self-hosted)
- `POST /api/scrape/next` → งานถัดไป
- `POST /api/scrape/ingest` → อัปโหลดรีวิว 1 หน้า
- `POST /api/scrape/{id}/done` · `/failed`
- จัดการคิว (ต้องใช้ admin key): `GET/POST /api/admin/scrape-jobs`, `DELETE /api/admin/scrape-jobs/{id}`
