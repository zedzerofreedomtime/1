# Frontend — Web Dashboard (Phase 2 · ยังไม่สร้าง)

หน้าเว็บสำหรับทีมคุมระบบทั้ง fleet — เรียก `backend/` ผ่าน `/api/admin/*`

## จะทำอะไร
- ล็อกอินแอดมิน (ADMIN_KEY / ภายหลังเป็น user login)
- **Devices** — สร้าง/เพิกถอน App Token, ดูสถานะ online, produced/target
- **Datasets** — ดูสินค้าที่ scrape มา, จำนวน media, สถานะ pending/posted/**verified/unverified**
- **Control** — สั่ง start/stop/pause/resume/set_config ต่อเครื่อง
- **Ext Tokens** — สร้าง token ให้ Chrome extension
- **Monitor** — สถานะเรียลไทม์ (poll หรือ WebSocket)

## เทคที่แนะนำ
Next.js (หรือ Vite + React) → เรียก backend REST. Endpoint ฝั่งแอดมินพร้อมแล้ว:
```
POST /api/admin/devices              สร้าง device + token
GET  /api/admin/devices              รายชื่อเครื่อง
POST /api/admin/devices/{id}/revoke  เพิกถอน
POST /api/admin/ext-tokens           สร้าง ext token
POST /api/admin/commands             สั่งงาน {device_id, action, params}
POST /api/admin/datasets             สร้าง dataset
GET  /api/admin/status?device_id=    สถานะล่าสุด
```
(auth: header `X-Admin-Key`)

## เริ่มยังไง
พร้อมลุยเมื่อพี่บอก — scaffold Next.js + หน้า Devices/Datasets/Control เชื่อม backend ที่มีอยู่
