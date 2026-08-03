# HANDOFF — Clip Bot (Android) Phase 1

โน้ตส่งต่อสำหรับ Codex / นักพัฒนาที่มารับงานต่อ อ่านไฟล์นี้ + `README.md` ก่อนเริ่ม

## นี่คืออะไร
แอป Android (Kotlin) สร้างคลิปรีวิวสินค้า + แคปชั่น AI แบบ **standalone** — ไม่มี login ไม่มีเซิร์ฟเวอร์ คุมบนมือถือเครื่องเดียว
สร้างใหม่ทั้งหมด ใช้แอปเดิม (SamuraiVdo 1.12) เป็นแค่พิมพ์เขียวอ้างอิงเรื่องฟีเจอร์ ไม่ได้ก๊อปโค้ด

## สถานะปัจจุบัน
- **Phase 1 เขียนครบและผ่านรีวิวว่า BUILD-READY** (โค้ด Kotlin 15 ไฟล์ + layout + resources ครบ)
- ยังไม่เคยถูก compile บนเครื่องจริง (เครื่องที่สร้างไม่มี Android SDK) — **งานแรกของคุณคือ build ให้ผ่านแล้วออก APK**

## Stack
Kotlin 2.0 · AGP 8.7 · Gradle 8.11.1 · minSdk 26 / target 35 · Media3 1.5.1 (Transformer) · OkHttp · Coroutines · viewBinding
Dependency ทั้งหมดอยู่ใน `gradle/libs.versions.toml`

## วิธี build
```bash
# ต้องมี JDK 17 + Android SDK (platform-35, build-tools;35, platform-tools)
# 1) ชี้ SDK: สร้าง local.properties เอง
echo "sdk.dir=/path/to/android-sdk" > local.properties
# 2) โปรเจกต์นี้ยังไม่มี gradle-wrapper.jar (ไฟล์ binary) — สร้างก่อน
gradle wrapper --gradle-version 8.11.1
# 3) build
./gradlew assembleDebug
# ผลลัพธ์: app/build/outputs/apk/debug/app-debug.apk
```
หรือเปิดใน Android Studio แล้วกด Run/Build APK (จัดการ wrapper + SDK ให้เอง)

## จุดที่ต้องระวังตอน build ครั้งแรก (ตรวจแล้วน่าจะผ่าน แต่ถ้าเจอ ให้แก้ตรงนี้)
1. **`local.properties` ถูกตัดออกจากแพ็กเกจ** (มันชี้ SDK ของเครื่องเดิม) — สร้างใหม่ให้ตรงเครื่องคุณ
2. **`gradle-wrapper.jar` ไม่ได้แนบมา** (binary) — รัน `gradle wrapper` หรือให้ Android Studio สร้าง
3. **Media3 1.5.1 — 2 จุดที่อาจต้องยืนยัน API** ใน `video/Media3VideoComposer.kt`:
   - `EditedMediaItemSequence(list)` — ถ้า 1.5.1 ลบ constructor แบบ List ให้เปลี่ยนไปใช้ `EditedMediaItemSequence.Builder(...)`
   - `StaticOverlaySettings.Builder()` + `OverlayEffect(ImmutableList.of(overlay))` — ถ้า API เพี้ยน ปรับตาม media3 เวอร์ชันที่ resolve จริง

## สถาปัตยกรรม (ดู README.md ประกอบ)
```
ui/MainActivity ─prepare(product,config)→ bot/BotEngine ─start→ bot/BotForegroundService
                                              ├─ video/Media3VideoComposer.compose() → .mp4
                                              ├─ ai/Captioners.create().generate()    → caption+tags
                                              └─ core/Poster (Phase1 = NoopPoster)
core/Contracts.kt = interface กลาง · core/BotConfig.kt = settings เก็บใน SharedPreferences (มี AI key)
```

## สิ่งที่ทำแล้ว vs ยังไม่ทำ
| | สถานะ |
|---|---|
| เลือกสื่อ → ตัดต่อคลิป 1080×1920 → แคปชั่น AI → เซฟลง gallery | ✅ Phase 1 |
| ใส่ OpenAI/Gemini key ในหน้า Settings | ✅ |
| Auto-post ผ่าน Accessibility (Shopee/TikTok/FB) | 🔷 **โครงเปล่า** — `auto/AccessibilityPoster.kt` เป็น stub (log + return true) มี TODO อธิบายแผน Phase 2 |
| Backend + คิวคำสั่ง + สถานะ (คุมหลายเครื่อง) | ⬜ Phase 3 |
| เว็บแดชบอร์ด | ⬜ Phase 4 |

## งานถัดไปที่แนะนำ
1. Build ให้ผ่าน → ทดสอบบนมือถือจริง (เลือกรูป 2-3 รูป, ใส่ AI key, กด Start, ดูว่าได้ .mp4 + แคปชั่น)
2. เริ่ม Phase 2: เติมของจริงใน `auto/PostAutoService` + `auto/AccessibilityPoster` — ไล่ส่อง UI ของ Shopee ทีละปุ่ม (bring-to-front → เลือกไฟล์ → วางแคปชั่น → กดโพสต์)

## หมายเหตุตามจริง
Auto-post ด้วย accessibility ผิด ToS ของ Shopee/TikTok (เสี่ยงบัญชีถูกแบน, Play Store มักไม่อนุมัติ → แจก APK เอง) ส่วนตัดต่อ + AI ไม่มีปัญหา
