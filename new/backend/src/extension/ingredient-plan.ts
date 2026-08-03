import fs from 'fs';

import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import type { GeminiVisionResult } from '../types.js';

/**
 * ส่วนผสมของคลิปแรก: เลือกรูปไหนไปให้ Flow และบอกมันว่ารูปไหนคือสินค้าตัวจริง
 *
 * แยกออกมาจาก extension-api.ts เมื่อ 1 ส.ค. 2026 ตอนที่ไฟล์นั้นทะลุเพดาน 1000 บรรทัด
 * สองฟังก์ชันนี้ต้องอยู่คู่กันเสมอ เพราะจำนวนรูปที่แนบเป็นตัวกำหนดว่าพรอมต์ต้องพูดอะไร
 */

/**
 * รายการ "ส่วนผสม" ของคลิปแรก: รูปหลักที่ผ่าน fidelity แล้ว ตามด้วยรูปทางการมุมอื่น
 *
 * รูปหลักต้องมาก่อนเสมอ เพราะเป็นภาพที่ตรวจแล้วว่าตรงสินค้าจริง ส่วนที่เหลือเป็นข้อมูล
 * เสริมเรื่องรูปทรง/วัสดุ กรองไฟล์ที่หายจากดิสก์ทิ้ง ไม่งั้น content script จะค้างรอรูป
 * ที่โหลดไม่ได้ หลังจากเปิดคลังสื่อไปแล้ว
 */
export function buildIngredientPaths(mainImagePath: string, vision: GeminiVisionResult): string[] {
  const all = Array.isArray(vision.referenceImagePaths) ? vision.referenceImagePaths : [];
  // 🐛 job_158: รูปส่วนผสมใบหนึ่งของหูฟังเป็นรูปสต็อก AirPods ของแท้ ซึ่งเราแนบเข้าไปเอง
  // แล้วบอกว่า "สินค้าตัวเดียวกัน ใช้ดูรูปทรงได้" → คลิปเปลี่ยนสินค้าเป็น AirPods ตามที่สั่ง
  // ตั้ง INGREDIENT_REFERENCE_COUNT=0 เพื่อใช้รูปที่ผ่านด่านเทียบสินค้าแล้วใบเดียว
  const extras = all.slice(0, Math.max(0, config.ingredientReferenceCount));
  if (all.length > extras.length) {
    logger.info(`🧪 ส่วนผสม: ใช้รูปทางการ ${extras.length} จาก ${all.length} รูป (INGREDIENT_REFERENCE_COUNT)`);
  }
  return [mainImagePath, ...extras]
    .filter((imagePath, index, list) => imagePath && list.indexOf(imagePath) === index)
    .filter((imagePath) => fs.existsSync(imagePath));
}

/**
 * บอก Flow ว่าในรูปที่แนบไปหลายใบ ใบไหนคือ "สินค้าตัวจริง" และใบที่เหลือมีไว้ทำอะไร
 *
 * 🐛 job_152 (พริกกากหมู PIGGY BITES): ซองถูกวาดใหม่จนกลายเป็นสินค้าคนละตัว —
 * `PIGGY BITES` ซ้ำสองบรรทัด, ตัวหนังสือไทยหายหมด, มาสคอตหมูหาย, ช่องเลือกรสหาย,
 * ชิ้นกากหมูกลายเป็นขนมกรอบเป็นวงๆ และมีตารางโภชนาการภาษาอังกฤษกับ "NET WT 1 OZ"
 * โผล่มาเอง ทั้งที่ไม่มีอยู่ทั้งในรูปต้นฉบับและรูปทางการ (ด่านจับได้ที่ 45/100)
 *
 * ต้นเหตุไม่ใช่ "โมเดลห่วย" แต่เป็นช่องโหว่ในโค้ดของเรา:
 * ขั้นเจนรูปมีประโยคอธิบายรูปเสริมอยู่แล้ว ("The extra photos are the SAME product
 * from other angles — use them only for its true shape and materials") แต่ขั้นเจน
 * **คลิป** ซึ่งแนบรูปเข้าไปถึง 4 ใบ กลับส่งไปแค่ motion prompt เปล่าๆ
 * ไม่เคยบอกเลยว่าใบไหนคือของจริง Flow จึงเกลี่ยน้ำหนักทั้ง 4 ใบเท่าๆ กัน
 *
 * ที่ทำให้พังหนักคือรูปส่วนผสมใบหนึ่งของ job_152 เป็น "กากหมูกองบนจาน ไม่มีซองเลย"
 * (ตัวกรองจัดเป็น clean_product ซึ่งถูกตามนิยาม) โมเดลจึงเอาเนื้อสินค้าที่กองอยู่
 * ไปผสมกับซอง กลายเป็นซองที่มีขนมรูปทรงอื่นพิมพ์อยู่
 *
 * ⚠️ ความยาวพรอมต์ = เวลาพิมพ์โดยตรง (ทีละตัวอักษร) ประโยคนี้จึงต้องสั้นที่สุด
 * เท่าที่ยังสั่งครบ — ยาวขึ้น 100 ตัว = บอทช้าลงราว 10 วินาทีต่อคลิป
 * ฉบับแรกที่ผมเขียนยาว 596 ตัว = +60 วินาทีต่อคลิป ซึ่งเสี่ยงซ้ำรอย job #89 ที่พรอมต์ยาว
 * จนเจ้าของนึกว่าบอทค้างแล้วกดหยุดกลางคัน จึงตัดส่วนที่ PRODUCT_IDENTITY_LOCK
 * พูดไว้แล้ว ("never re-letter... label artwork") ออก เหลือเฉพาะสิ่งที่ยังไม่มีใครบอก:
 * รูปไหนคือของจริง และเนื้อสินค้าที่กองอยู่นอกซองห้ามไปโผล่บนซอง
 */
export function withIngredientGuidance(prompt: string, ingredientCount: number): string {
  if (ingredientCount < 2) return prompt;
  return `${prompt} `
    + 'Image 1 is the approved product and scene, and the sole authority on its packaging. '
    + 'Other images are the same product elsewhere — shape and colour only. '
    + 'Never redesign the pack, add text it lacks, or print loose contents onto it.';
}

