# Clip Bot (Android) — Phase 1

แอปสร้างคลิปรีวิวสินค้า + แคปชั่น AI แบบ **standalone** — ไม่มีหน้า login ไม่มีเซิร์ฟเวอร์
คุมทุกอย่างบนมือถือเครื่องเดียว สร้างใหม่ทั้งหมด (ใช้ SamuraiVdo 1.12 เป็นแค่พิมพ์เขียว ไม่ได้ก๊อปโค้ด)

> **สถานะ:** Phase 1 = เลือกสื่อ → ตัดต่อวิดีโอ (Media3) → เขียนแคปชั่น (OpenAI/Gemini) → บันทึกลงเครื่อง
> Auto-post ผ่าน Accessibility เป็น **โครง Phase 2** (ยังไม่กดโพสต์จริง)

---

## ต้องมีอะไรก่อน build

เครื่องนี้ยังไม่มี Android SDK/Studio — ติดตั้งก่อน:

1. **Android Studio** (เวอร์ชัน Ladybug / 2024.2 ขึ้นไป) — มาพร้อม JDK 17 + Android SDK
2. เปิดโปรเจกต์: `File > Open` แล้วเลือกโฟลเดอร์ `clipbot-android`
3. Android Studio จะ:
   - สร้าง `local.properties` (ชี้ไปที่ Android SDK) ให้อัตโนมัติ
   - ดาวน์โหลด Gradle wrapper + dependency ให้เอง
4. กด **Run ▶** ลงมือถือ (เปิด USB debugging) หรือ **Build > Build APK**

> โปรเจกต์วางไว้ที่ path แบบ ASCII ไม่มีเว้นวรรค/อักษรไทย โดยตั้งใจ — Gradle จะ build ไม่ผ่านถ้า path มีอักขระพวกนั้น

### ถ้าใช้ command line (มี Gradle ติดตั้งแล้ว)
```bash
cd clipbot-android
gradle wrapper          # สร้าง gradlew ครั้งแรก (ถ้ายังไม่มี)
./gradlew assembleDebug # ได้ไฟล์ app/build/outputs/apk/debug/app-debug.apk
```

---

## โครงสร้างโปรเจกต์

```
clipbot-android/
├─ app/src/main/
│  ├─ AndroidManifest.xml         # permissions + services (ไม่มี login/remote)
│  ├─ java/com/openclaw/clipbot/
│  │  ├─ model/Models.kt          # Product, MediaSource, CaptionResult, JobConfig …
│  │  ├─ core/
│  │  │  ├─ Contracts.kt          # VideoComposer, Captioner, Poster, BotListener, BotState
│  │  │  └─ BotConfig.kt          # ตั้งค่าทั้งหมดเก็บใน SharedPreferences
│  │  ├─ video/  Media3VideoComposer.kt   # ตัดต่อคลิปด้วย Media3 Transformer
│  │  ├─ ai/     OpenAiCaptioner / GeminiCaptioner / Captioners
│  │  ├─ bot/    BotEngine + BotForegroundService   # เครื่องยนต์ + service เบื้องหลัง
│  │  ├─ auto/   PostAutoService / AutoController / AccessibilityPoster  # โครง Phase 2
│  │  └─ ui/     MainActivity + SettingsActivity
│  └─ res/                        # strings (ไทย), theme (crimson), ไอคอน, xml config
├─ gradle/libs.versions.toml      # version catalog (dependency ทั้งหมด)
└─ build.gradle.kts / settings.gradle.kts
```

## สถาปัตยกรรมย่อ

```
MainActivity ──prepare(product, config)──▶ BotEngine ──start──▶ BotForegroundService (foreground)
     │                                        │
     │                                        ├─ Media3VideoComposer.compose()  → ไฟล์ .mp4
     │                                        ├─ Captioners.create().generate()  → แคปชั่น + #แท็ก
     │                                        └─ Poster.post()   (Phase 1 = NoopPoster / Phase 2 = Accessibility)
     ▼
  BotListener ◀── onState / onProgress / onLog  (อัปเดต UI + notification)
```

- **ไม่มี login/token** — ค่าและคีย์ AI เก็บในเครื่อง (`BotConfig`)
- ใส่ **API key ของ OpenAI หรือ Gemini** ในหน้า Settings ก่อนใช้แคปชั่น AI

---

## Roadmap

| Phase | ได้อะไร | สถานะ |
|------|---------|-------|
| **1** | เลือกสื่อ → ตัดต่อ → แคปชั่น AI → บันทึกไฟล์ | ✅ โปรเจกต์นี้ |
| 2 | Auto-post ผ่าน Accessibility (Shopee/TikTok/FB) + ปุ่มลอย | 🔷 มีโครงไว้แล้ว |
| 3 | Backend + คิวคำสั่ง + สถานะ (คุมหลายเครื่อง) | ⬜ |
| 4 | เว็บแดชบอร์ดคุมบอท | ⬜ |

## หมายเหตุตามจริง
การ auto-post ด้วย accessibility service (Phase 2) ผิด ToS ของ Shopee/TikTok — เสี่ยงบัญชีถูกแบน และ Google Play มักไม่อนุมัติ (แจก APK เอง) ส่วนการตัดต่อ + AI แคปชั่นไม่มีปัญหา

## เปลี่ยนชื่อ/แบรนด์
ชื่อแพ็กเกจ `com.openclaw.clipbot` และชื่อแอป "Clip Bot" เป็น placeholder — เปลี่ยนได้ที่
`app/build.gradle.kts` (applicationId/namespace) และ `res/values/strings.xml` (app_name)
