import { CAR_CARE_PATTERN, demoActionFor } from '../gemini/motion-prompts.js';
import type { GeminiVisionResult } from '../types.js';

/**
 * มือและฉากหลังของงานหนึ่งใบ — สุ่มครั้งเดียวแล้วใช้ตลอดงานเพื่อให้ทุกช็อตเป็นชุดเดียวกัน
 */
export const BACKGROUND_STYLES = [
  'a warm wooden review table beside a softly lit window',
  'a clean cream studio tabletop with soft natural shadows',
  'a modern home kitchen counter with gentle morning light',
  'a minimal dark slate tabletop with a warm practical lamp',
  'a tidy vanity table with neutral daylight and shallow depth of field',
];

/**
 * ฉากหลังต้องเป็น "ที่ที่คนใช้สินค้านั้นจริงๆ"
 *
 * job_132 (ซิลิโคนออยล์เคลือบยางรถ Cerax Wax): สุ่มได้โต๊ะเครื่องแป้ง มีขวดเครื่องสำอาง
 * เบลอเป็นฉากหลัง — น้ำยาเคลือบยางรถวางอยู่บนโต๊ะแต่งหน้า ดูไม่เข้ากันเลย
 *
 * เดิมสุ่มจากลิสต์กลางๆ ที่เป็นบ้าน/ครัว/โต๊ะแต่งหน้าล้วน ไม่มีฉากยานยนต์เลยสักอัน
 * แยกตามหมวดจากชื่อสินค้าแทน แล้วค่อยสุ่มภายในหมวด (ยังได้ความหลากหลายเหมือนเดิม)
 */
const BACKGROUND_FAMILIES: Array<{ match: RegExp; scenes: string[] }> = [
  {
    // ⚠️ ใช้ตัวจับตัวเดียวกับ DEMO_CATEGORIES — ห้ามเขียนคำซ้ำไว้สองที่
    // job_149: ตอนที่สองตารางมีคำคนละชุด "เคลือบยางดำ ซิลิโคนออยล์" ไม่ตรงทั้งคู่
    // ทั้งที่เป็นสินค้าตัวเดียวกับ job_132 ที่เคยแก้ไปแล้วรอบหนึ่ง
    match: CAR_CARE_PATTERN,
    scenes: [
      'a clean garage floor beside a parked car wheel, soft daylight from the open door',
      'a driveway next to a car tyre in bright overcast daylight',
      'a tidy car-care workbench with microfibre cloths and a car blurred behind',
    ],
  },
  {
    // job_133: ชุดถังปั่นไม้ม็อบถูพื้นไปตกบนเคาน์เตอร์ครัวหินอ่อน เพราะไม่เข้าหมวดไหนเลย
    // ของทำความสะอาดพื้นต้องอยู่ "บนพื้น" ไม่ใช่บนโต๊ะ
    match: /ไม้ถู|ไม้ม็อบ|ไม้ม๊อบ|\bmop\b|ถูพื้น|ถังปั่น|ไม้กวาด|ที่ปัดฝุ่น|ขัดพื้น|ทำความสะอาดพื้น/iu,
    scenes: [
      'a clean tiled living-room floor with soft daylight from a nearby window',
      'a bright home hallway floor with skirting board and gentle natural light',
    ],
  },
  {
    // 🐛 job_80 (24 ก.ค.) ได้ "modern home kitchen counter with gentle morning light" แล้วภาพน่ากิน
    // แต่รอบ 31 ก.ค. สินค้าตัวเดียวกัน ("พริกกากหมู") ไม่ match หมวดไหนเลย เพราะลิสต์มีแค่
    // "น้ำพริก" ไม่มี "พริก" เดี่ยวๆ และไม่มีคำของกินเล่นสักคำ → ตกไปลิสต์กลางแล้วสุ่มได้
    // "minimal dark slate tabletop" = ถ่ายของกินบนหินสีดำแสงมืด ดูเหมือนโฆษณาเหล้า ไม่น่ากิน
    // ของกินต้องได้แสงอุ่นและสว่างเสมอ ห้ามหลุดไปลิสต์กลางอีก
    match: /ครัว|กระทะ|หม้อ|จาน|ช้อน|มีด|อาหาร|ขนม|เครื่องปรุง|พริก|กากหมู|แคบหมู|ขบเคี้ยว|เคี้ยว|ทอด|อบกรอบ|กรอบ|สาหร่าย|ถั่ว|คุกกี้|เยลลี่|ลูกอม|ซอส|น้ำจิ้ม|เครื่องดื่ม|กาแฟ|ชา\b|นม\b|รส[ต้มยำบาร์บีคิวหวานเผ็ดเค็ม]/iu,
    scenes: [
      'a modern home kitchen counter with gentle morning light',
      'a warm wooden dining table with soft window light',
      'a bright kitchen counter beside a sunlit window with warm highlights',
    ],
  },
  {
    match: /ครีม|เซรั่ม|โลชั่น|โทนเนอร์|สบู่|บำรุงผิว|แป้ง|ลิป|กันแดด|เครื่องสำอาง|แชมพู|ผิวหน้า/iu,
    scenes: [
      'a tidy vanity table with neutral daylight and shallow depth of field',
      'a clean bathroom counter with soft diffused daylight',
    ],
  },
  {
    match: /ผ้าอ้อม|เด็ก|ทารก|ขวดนม|ของเล่น|จุกนม/iu,
    scenes: [
      'a bright nursery changing table with soft pastel surroundings',
      'a clean home shelf beside folded baby clothes in warm daylight',
    ],
  },
  {
    match: /หมอน|ที่นอน|ผ้าปู|ผ้าห่ม|มุ้ง|ผ้าคลุมเตียง/iu,
    scenes: [
      'a neatly made bed with soft morning light from a bedroom window',
      'a calm bedroom side table with warm lamp light',
    ],
  },
];

export type ReferenceStyle = Pick<GeminiVisionResult, 'handGender' | 'handCount' | 'backgroundStyle'>;

export function pickBackgroundStyle(productTitle: string): string {
  // สินค้าที่มีท่าใช้งานชัด ต้องยืนอยู่ใน "ที่ที่มันถูกใช้" ตั้งแต่เฟรมแรก ไม่ใช่บนโต๊ะจัดสวย
  // เพราะคลิป 2 ต่อจากเฟรมสุดท้ายของคลิป 1 ถ้าฉากคนละที่กัน มันจะย้ายฉากกลางคลิปไม่ได้
  // (แนวที่เจ้าของขอมา 31 ก.ค. จากคลิปอ้างอิงแปรงขัดพื้น — ดู demoActionFor)
  // จงใจไม่สุ่ม: ฉากต้องเป็นตัวเดียวกับที่ท่าในคลิป 2 อ้างถึง ไม่งั้นพรอมต์สองก้อนพูดคนละที่
  const demo = demoActionFor(productTitle);
  if (demo) return demo.scene;
  const family = BACKGROUND_FAMILIES.find((entry) => entry.match.test(productTitle));
  const scenes = family?.scenes || BACKGROUND_STYLES;
  return scenes[Math.floor(Math.random() * scenes.length)];
}

export function pickReferenceStyle(productTitle = ''): ReferenceStyle {
  // เสียงพากย์และคำลงท้ายของระบบเป็นผู้หญิงเสมอ ภาพจึงต้องใช้มือผู้หญิงด้วย
  // ไม่งั้นคลิปเดียวกันจะเห็นมือผู้ชายแต่ได้ยินเสียงผู้หญิงเหมือน job #145
  const handGender: 'female' = 'female';
  const handCount: 1 = 1;
  const backgroundStyle = pickBackgroundStyle(productTitle);
  return { handGender, handCount, backgroundStyle };
}
