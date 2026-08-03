import type { GeminiVisionResult } from '../types.js';
import { BACKGROUND_STYLES, type ReferenceStyle } from './reference-style.js';

/**
 * พรอมต์สำหรับ "เฟรมตั้งต้น" — รูปเดียวที่ทั้งงานยึดเป็นความจริง
 *
 * แยกออกจาก extension-api.ts เมื่อ 1 ส.ค. 2026 ไฟล์นี้เป็นก้อนข้อความล้วนๆ ที่สะสม
 * บทเรียนจากงานจริงมาหลายสิบรอบ อยู่ปนกับโค้ดรับส่งงานแล้วอ่านยากทั้งสองฝั่ง
 */

/**
 * @param startState สภาพที่สินค้าต้องอยู่แล้วในเฟรมตั้งต้น เพื่อให้ท่าของคลิป 2 ทำได้จริง
 *
 * 🐛 job_160 / job_162: ท่าสั่งจ่ายของเหลวออกจากภาชนะที่ฝายังปิด โมเดลเจอทางตัน
 * แล้วเลือกทางออกเอง — กระติกลบฝาทิ้งกลางคลิป โทนเนอร์ทำท่ากดฝาปิดหลอกๆ แล้วข้าม
 * เฟรมตั้งต้นคือที่เดียวที่แก้ได้ เพราะเปิดฝา+จ่าย+ใช้ = สามจังหวะ ซึ่งไม่รอดใน 8 วินาที
 */
export function buildReferenceImagePlan(
  style: ReferenceStyle,
  _plannedImagePrompt?: string,
  startState?: string
): Pick<GeminiVisionResult, 'imagePrompt' | 'endImagePrompt' | 'handGender' | 'handCount' | 'backgroundStyle'> {
  const handGender = style.handGender || 'female';
  const handCount: 1 = 1;
  const backgroundStyle = style.backgroundStyle || BACKGROUND_STYLES[0];
  const handDescription = handGender === 'male' ? 'one natural adult male hand' : 'one natural adult female hand';
  return {
    handGender,
    handCount,
    backgroundStyle,
    // Never send Gemini's product-title-influenced visual description to Flow.
    // The uploaded image is the sole visual source of truth; the prompt below
    // changes only hand/background while keeping every product state invariant.
    // ⚠️ ความยาว prompt = เวลาพิมพ์โดยตรง (พิมพ์ทีละตัว 100ms)
    // job #89: 1,949 ตัว = พิมพ์ 136 วินาที + อัปรูป 3 รอบ ≈ 3.5 นาทีกว่าจะกด Generate
    // → เจ้าของนึกว่าบอทค้าง เลยกดหยุดกลางคัน prompt ค้างครึ่งๆ
    // เขียนใหม่ให้กระชับโดยคงข้อบังคับครบทุกข้อ (~1,050 ตัว = ประหยัดไปราว 1 นาที)
    //
    // job_102: พัดลมหนีบถูกจับที่ตัวหนีบแล้วปล่อยหัวพัดลมห้อยลง = สินค้าคว่ำตั้งแต่เฟรมแรก
    // พอถึงคลิป 2 Veo แก้ให้ตั้งตรงตามธรรมชาติ ผู้ชมจึงเห็นสินค้า "พลิกเอง" กลางวิดีโอ
    // → ประโยคล็อกท่าทาง/ทิศฉลากด้านล่างคุมไว้ตั้งแต่เฟรมตั้งต้น
    //
    // job #122: รูปรีวิวถูกถ่ายกลับหัวมาเอง Flow จึงทำตาม และ fidelity gate ก็ผ่าน
    // เพราะมัน "ตรงต้นฉบับ" จริงๆ — คำเดิมที่สั่งให้หันเหมือนรูปต้นฉบับเลยกลายเป็น
    // ตัวสั่งให้คว่ำตาม ต้องยึด "ทิศที่อ่านฉลากออก" แทน ไม่ใช่ยึดทิศของรูปต้นฉบับ
    //
    // job #124: แต่คำว่า "stand it upright" ก็แก้เกิน — ห่อทิชชู่เป็นทรงนอน พอสั่งให้
    // ตั้งขึ้น Flow หมุนห่อเป็นแนวตั้ง ตัวหนังสือบนฉลากเลยตะแคง 90° แล้วคลิป 2 ที่ Veo
    // ต่อจากเฟรมนั้นก็ "แก้ให้" ด้วยการเขียนฉลากใหม่ทั้งใบเป็นคำมั่ว (Brapt Cemual / L x2G)
    // → เกณฑ์ที่ถูกคือ "ตัวหนังสืออ่านตามแนวนอนได้" ไม่ใช่ "สินค้าตั้งตรง"
    //   ทรงของสินค้าเป็นยังไงต้องคงไว้อย่างนั้น ห่อนอนก็ต้องนอน ขวดตั้งก็ต้องตั้ง
    //
    // codex review job_80: AI แต่ง "Nutrition Facts" ด้านหลังซองเอง = ให้ข้อมูลสินค้าเท็จ
    //
    // job_133: ถังปั่นสีเขียวอมฟ้า (teal) ถูกเจนออกมาเป็นฟ้าสดกว่าเดิม และตะแกรงปั่นข้างใน
    // จากสีเดียวกับถังกลายเป็นสีขาว — ด่าน fidelity ผ่านเพราะยังเป็น "โทนฟ้า" เหมือนกัน
    // คำว่า "colors" ที่ปนอยู่ในลิสต์รวมๆ อ่อนเกินไป ต้องแยกเป็นประโยคสั่งตรงๆ
    // ว่าห้ามขยับเฉดหรือเร่งสี ทีละชิ้นส่วนด้วย ไม่ใช่ดูรวมทั้งภาพ
    //
    // 31 ก.ค. — เจ้าของเทียบ job_80 กับคลิปใหม่ของสินค้าตัวเดียวกันแล้วบอกว่าของเก่าดูดีกว่า
    // ต้นเหตุคือคำสั่งที่เราเพิ่มเข้ามาเองสองอัน ไม่ใช่ Flow แย่ลง:
    //   1) "never brighten or shift it" — ตั้งใจกันสีสินค้าเพี้ยน แต่ไปห้ามแสงในฉากด้วย ภาพเลยทึบ
    //   2) ล็อกท่าวาง + front face ทำให้สินค้าตั้งตรงกลางเฟรมแบบภาพแคตตาล็อก
    // job_80 ถือเอียงเข้าหากล้องและกินพื้นที่เกือบเต็มเฟรม ซึ่งคือหน้าตาของคลิปรีวิวจริง
    // → แยก "สีของตัวสินค้า" (ล็อกแน่น) ออกจาก "แสงและการจัดเฟรม" (ต้องสวยและอบอุ่น)
    imagePrompt:
      `Photorealistic vertical 9:16 ecommerce photo. The uploaded image is the sole visual source of truth — reproduce that exact product, ignoring its title or filename. ` +
      `Keep its state, silhouette, proportions, materials and every visible part; never merge or duplicate parts. ` +
      `Keep the product's own colours exactly as uploaded — same hue, saturation and depth on every part; never recolour or tint it. ` +
      `Light the scene bright and warm. ` +
      `Never add, remove or redraw any brand, logo, label or printed text — keep the front label artwork exactly as uploaded. ` +
      // 🐛 job_163 (ทิชชู่ BOTARE): บรรทัดไทยบนฉลากถูกวาดใหม่เป็นคำมั่ว แล้วพอเข้าขั้นวิดีโอ
      // Veo ก็ลากต่อจนกลายเป็นตัวจีน — ตัวเจนรูปไม่เคยถูกบอกเลยว่าตัวหนังสือนั้นเป็นภาษาอะไร
      // สินค้าทุกตัวในระบบขายตลาดไทย ฉลากที่อ่านเป็นภาษาอื่นคือคลิปที่ใช้ขายไม่ได้
      `Any Thai text on the label stays Thai script, character for character — never redraw it as Chinese, Japanese or Latin lookalike shapes. ` +
      `Front face to camera. Never invent a nutrition table, ingredient list, barcode or small print that is not legible in the source. ` +
      `Keep the product's own natural pose — never stand a wide pack on end or lay a tall bottle down. Rotate only so the front label reads horizontally, right way up; never sideways or inverted. ` +
      `Tilt it slightly toward the camera for depth, and frame it close so it fills most of the frame height. ` +
      `Place ${handDescription} at a safe grip without changing the product or its orientation. Fingers anatomically correct. ` +
      `${backgroundStyle}, natural shadows, shallow depth of field. No extra objects, no graphics, no watermark.` +
      // วางไว้ท้ายสุดเพราะเป็นข้อยกเว้นของ "Keep its state ... exactly as uploaded" ข้างบน
      // ต้องอ่านทีหลังถึงจะชนะประโยคนั้นได้ และมีเฉพาะหมวดที่ท่าต้องการจริงๆ
      (startState ? ` Show the product ${startState}, even if the uploaded photo shows it closed.` : ''),
    // ⚠️ คำสั่งหลักต้องเป็น "หมุนให้เห็นชัด" ไม่ใช่ "รักษาให้เหมือนเดิม"
    // ของเดิมอัดคำสั่ง preserve ท่วมท้น + ขอหมุนแค่ 20° → Flow คืนรูปแทบเหมือน start frame
    // → 2 เฟรมซ้ำ → Veo ไม่มีอะไร interpolate → คลิปนิ่ง เห็นหน้าเดิมซ้ำ (job_68)
    endImagePrompt:
      `END frame of the same 9:16 shot, using the uploaded start frame as reference. ` +
      `MUST look clearly different: the hand turns the product about 35 degrees right so another side faces the camera. Never return a copy. ` +
      `Same hand, background, lighting and framing so both read as one shot. Same product, colors, label and state — only the angle changes. ` +
      // หมุน 35° ได้ แต่ห้ามหมุนจนเห็นด้านหลังแล้ว AI วาดตารางโภชนาการ/ส่วนผสมขึ้นมาเอง
      `Rotate just enough to show the adjacent side; never swing around to the rear panel, never invent a nutrition table or small print, never re-letter the label. ` +
      `No new objects, no duplicates, no watermark.`
  };
}
