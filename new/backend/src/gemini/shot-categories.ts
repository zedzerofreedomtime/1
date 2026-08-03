/**
 * "สินค้าแบบนี้ ถ่ายที่ไหน ทำท่าอะไร" — ตารางเดียวที่ตัดสินหน้าตาของคลิปทั้งใบ
 *
 * แยกออกจาก motion-prompts.ts เมื่อ 1 ส.ค. 2026 ไฟล์นั้นถือสามเรื่องปนกัน:
 * ตารางหมวดสินค้า (ไฟล์นี้) · ข้อความล็อกที่ส่งให้ Flow · ตัวตรวจ/ซ่อมพรอมต์ที่ Gemini เขียนมา
 * ทั้งสามแก้คนละเหตุผลเสมอ — ตารางแก้ตอนเจอสินค้าหมวดใหม่ ล็อกแก้ตอนภาพเพี้ยน
 * ตัวตรวจแก้ตอนพรอมต์หลุดด่าน
 */

/**
 * สินค้าที่ "ท่าใช้งานจริง" คือการสวมใส่ ไม่ใช่การถือโชว์
 *
 * 🐛 job_143 (รองเท้าแตะ MARCO): บทพากย์พูดว่า "ใส่เดินเล่นชิลๆ" แต่ภาพเป็นมือถือรองเท้า
 * ไว้เหนือโต๊ะทั้ง 16 วินาที — เสียงกับภาพขัดกันเอง และคนดูไม่เคยเห็นว่าใส่แล้วเป็นยังไง
 * เจ้าของสั่งเมื่อ 31 ก.ค. ให้เพิ่มช็อตสวมใส่จริงสำหรับหมวดที่ทำได้
 *
 * ⚠️ เฉพาะหมวดที่ "อวัยวะที่ต้องวาดเพิ่มไม่มีใบหน้า" เท่านั้น — เท้า ข้อมือ ไหล่ วาดพลาดยังพอทน
 * แต่ใบหน้าพลาดคือคลิปใช้ไม่ได้เลย จึงไม่รวมแว่นตา หมวก ต่างหู เครื่องสำอางบนหน้า
 */
export type WearAction = { bodyPart: string; digits: string; action: string };

const WEARABLE_CATEGORIES: Array<{ match: RegExp; wear: WearAction }> = [
  {
    match: /รองเท้า|แตะ|ผ้าใบ|ส้นสูง|สลิปเปอร์|\bsandal|\bshoe|sneaker|\bslide\b/iu,
    wear: {
      bodyPart: 'bare foot',
      digits: 'five toes',
      action: 'A bare foot steps into the sandal and settles in, showing how it looks worn.',
    },
  },
  {
    match: /ถุงเท้า|\bsocks?\b/iu,
    wear: {
      bodyPart: 'bare foot',
      digits: 'five toes',
      action: 'A foot slides into the sock and it is pulled snug over the ankle.',
    },
  },
  {
    match: /กระเป๋า|เป้|สะพาย|\bbag\b|backpack|tote/iu,
    wear: {
      bodyPart: 'shoulder',
      digits: 'natural proportions',
      action: 'The bag is lifted by its strap and settled onto one shoulder.',
    },
  },
  {
    match: /นาฬิกา|กำไล|สร้อยข้อมือ|\bwatch\b|bracelet|wristband/iu,
    wear: {
      bodyPart: 'wrist',
      digits: 'five fingers',
      action: 'The strap is fastened around the wrist and the wrist turns slightly to show it worn.',
    },
  },
];

/** คืนท่าสวมใส่ของสินค้านั้น ถ้าเป็นหมวดที่สวมใส่ได้ (ไม่ใช่ก็คืน null) */
export function wearActionFor(productTitle = ''): WearAction | null {
  return WEARABLE_CATEGORIES.find((entry) => entry.match.test(productTitle))?.wear || null;
}

/**
 * ช็อต "มือใช้งานจริงในที่ใช้จริง" — แนวที่ลูกค้าขอมา 31 ก.ค. 2026
 *
 * เจ้าของส่งคลิปอ้างอิงของ Krumaew Ai Studio (แปรงขัดพื้น/น้ำยาห้องน้ำ) มาแล้วบอกว่า
 * "ดูเนียนมาก อยากให้คลิปเราเป็นแบบนี้ โดยที่เห็นแค่มือ" คลิปนั้นไม่ได้โชว์สินค้าเลย
 * มันโชว์งานที่สินค้าทำ: ห้องน้ำสกปรก → ฉีด → ขัด → ฟอง → สะอาด
 *
 * ผลพลอยได้ที่สำคัญ: กล้องไปอยู่ที่การกระทำ ไม่ได้จ้องฉลาก อาการ "ตัวหนังสือเล็กเพี้ยน"
 * (Clandestine → Cleaniine ใน job_146) จึงกระทบน้อยลงมาก เพราะไม่มีใครอ่านฉลากในช็อตนั้น
 *
 * ⚠️ เจ้าของเลือก "เฉพาะหมวดที่มีท่าใช้ชัด" — หมวดที่นึกท่าไม่ออก (หมอน ขนม อะไหล่)
 *    ต้องคงช็อต hero เดิมไว้ ไม่ใช่ให้ Gemini เดาท่าขึ้นมาเอง
 * ⚠️ ห้ามมีใบหน้า/ลำตัว/คนทั้งตัวเด็ดขาด — คลิปอ้างอิงมีช็อตเห็นคนทั้งตัว แต่ของเราห้าม
 *    (เหตุผลเดียวกับ WEARABLE_CATEGORIES: อวัยวะที่ไม่มีหน้าวาดพลาดยังพอทน หน้าพลาดคือจบ)
 * ⚠️ สกินแคร์ต้องทาลงแขน/มือ ไม่ใช่ลงหน้า ด้วยเหตุผลเดียวกัน
 * ⚠️ มือเดียวเท่านั้น — สองมือคือต้นตออาการนิ้วเพี้ยนที่เจ้าของทักมาตลอด ท่าทุกตัวข้างล่าง
 *    จึงถูกออกแบบให้ทำด้วยมือเดียวได้จริง
 */
/**
 * ⚠️ `scene` ต้องถูกใช้ตั้งแต่ "รูปตั้งต้น" ไม่ใช่เพิ่งมาโผล่ตอนคลิป 2
 *
 * คลิป 2 ของเราต่อจากเฟรมสุดท้ายของคลิป 1 (โหมดเฟรม) จะสั่งให้ย้ายจากโต๊ะเครื่องแป้ง
 * ไปพื้นห้องน้ำกลางคลิปไม่ได้ — โมเดลจะไม่ทำตาม หรือทำแล้วภาพละลาย
 * ฉากจึงต้องเป็น "ที่ใช้งานจริง" ตั้งแต่เฟรมแรก แล้วคลิป 1 เป็น hero ในที่นั้น
 * คลิป 2 ค่อยลงมือทำในที่เดียวกัน ต่อเนื่องกันได้จริงและด่านเฟรมแรกยังเข้มเท่าเดิม
 */
export type DemoAction = {
  /** ที่ที่สินค้าถูกใช้จริง — ต้องใช้เป็น backgroundStyle ของรูปตั้งต้นด้วย */
  scene: string;
  /** ผลที่ต้องเห็นในเฟรม ไม่งั้นช็อตนี้ก็แค่ "ขยับ" เฉยๆ ไม่ได้พิสูจน์อะไร */
  result: string;
  /** ประโยคท่าที่ส่งให้ Flow */
  action: string;
  /** ของที่ท่านี้ต้องใช้เพิ่มจากตัวสินค้า — ต้องผ่อนข้อ "no new objects" ให้ ไม่งั้นล็อกขัดกับท่าเอง */
  prop?: string;
  /**
   * สภาพที่สินค้า "ต้องอยู่แล้ว" ในเฟรมตั้งต้น ไม่งั้นท่าข้างบนทำไม่ได้จริง
   *
   * 🐛 job_160 (กระติก) กับ job_162 (โทนเนอร์ใต้วงแขน): บั๊กเดียวกันคนละสินค้า —
   * ท่าสั่งให้จ่ายของเหลวออกมา แต่เฟรมตั้งต้นฝายังปิด โมเดลเจอทางตันแล้วเลือกทางออกเอง
   * กระติกเลือก "ลบฝาทิ้งกลางคลิป" ส่วนโทนเนอร์เลือก "ทำท่ากดฝาปิดหลอกๆ 6 วินาทีแล้วข้าม"
   * เจ้าของทักเองว่า "มันเป็นแบบเปิดฝาแล้วบีบ ไม่ใช่กด"
   *
   * เปิดฝา+จ่าย+ใช้ = สามจังหวะใน 8 วินาที ซึ่ง job_147 พิสูจน์แล้วว่าไม่รอด
   * ทางที่เหลือคือ **ให้เฟรมตั้งต้นเปิดฝามาเลย** แล้วคลิปเหลือจังหวะเดียว
   *
   * ⚠️ ใส่เฉพาะหมวดที่ท่าต้องการสภาพนั้นจริงๆ — หมวดกระติกท่าคือ "เปิดฝา" จึงต้องปิดมาก่อน
   * ใส่มั่วจะกลายเป็นสั่งให้เฟรมตั้งต้นผิดสภาพแทน
   */
  startState?: string;
  /**
   * ⚠️ จำนวนมือที่ท่านี้ "ต้องใช้จริง" — ต้องซื่อสัตย์กับตัวเอง
   *
   * 🐛 job_147 (ทิชชู่ Botare): ผมเขียนล็อกว่า "No second hand ... may enter" แล้วเขียนท่า
   * บรรทัดถัดไปว่า "One sheet is drawn from the pack" ซึ่งคนจริงต้องใช้สองมือ
   * โมเดลเจอคำสั่งตีกันแล้วเลือกทำตามท่า → เสกมือเพิ่มจนได้สามมือกับกำไลหยกสองวง
   * เป็นบั๊กประเภทเดียวกับ "the hand sways the bottle" ที่เพิ่งแก้ไปวันก่อนหน้าเป๊ะ
   *
   * ห้ามใส่ 1 เพราะ "อยากให้เป็น 1" — ให้ดูว่าคนทำท่านี้จริงต้องใช้กี่มือ
   */
  hands: 1 | 2;
};

/**
 * ⚠️ ทุกท่าต้องเป็น "จังหวะเดียว" และขึ้นต้นด้วยสิ่งที่ "เปลี่ยน" ไม่ใช่สิ่งที่ "ทำ"
 *
 * 🐛 job_147: ท่าเดิมเขียนว่า "ดึงกระดาษออกมา + เช็ด + ทำให้แห้ง" = สามจังหวะใน 8 วินาที
 * โมเดลทำได้แค่จังหวะแรกครึ่งๆ แล้ววนกลับมาท่าเริ่มต้น น้ำที่หกยังอยู่ครบเท่าเดิมตอนจบ
 * คนดูจึงเห็น "มือขยับไปมา" ไม่ได้เห็น "สินค้าทำงาน" ซึ่งคือทั้งหมดของแนวที่เจ้าของขอ
 *
 * เขียนใหม่โดยเอา "ผลลัพธ์" ขึ้นต้นประโยค แล้วให้การกระทำเป็นส่วนขยาย
 * (เช่น "คราบหายไป ...ขณะที่แปรงขัด" แทน "แปรงขัด ...จนคราบหายไป")
 * เพราะสิ่งที่อยู่ต้นประโยคคือสิ่งที่โมเดลให้น้ำหนักมากที่สุด
 */
/**
 * หมวดคาร์แคร์ — export ไว้ให้ `reference-style.ts` ใช้ตัวเดียวกัน
 *
 * 🐛 job_149 (Cerax Wax เคลือบยางดำ ซิลิโคนออยล์): ถูกส่งไป "ขัดพื้นห้องน้ำ"
 * เพราะชื่อสินค้ามีคำว่า "น้ำยาขัดยางดำเงา" ซึ่งไปตรงกับ `น้ำยา(?:ขัด)` ของหมวดทำความสะอาด
 * ที่วางไว้บนสุด ส่วนหมวดคาร์แคร์เองไม่มีคำว่า ยางดำ / ทายาง / ซิลิโคนออยล์ เลยสักคำ
 *
 * ⚠️ นี่คือ job_132 ซ้ำรอย — สินค้า **ตัวเดียวกันนี้** เคยได้โต๊ะเครื่องแป้งมาแล้วครั้งหนึ่ง
 * (ดูคอมเมนต์ใน reference-style.ts) ตอนนั้นแก้ด้วยการเพิ่มหมวดยานยนต์ลงตารางฉากหลัง
 * แต่พอผมสร้างตารางหมวดใหม่ขึ้นมาอีกใบ ผมไม่ได้ยกคำเหล่านั้นมาด้วย บั๊กเดิมจึงกลับมา
 * ทั้งสองตารางต้องใช้ตัวจับตัวเดียวกันตั้งแต่นี้ไป ไม่งั้นมันจะเลื่อนออกจากกันอีก
 */
export const CAR_CARE_PATTERN =
  /ยางรถ|ยางล้อ|ยางดำ|ทายาง|เคลือบยาง|รถยนต์|มอเตอร์ไซค์|จักรยานยนต์|เคลือบเงา|แว็ก|\bwax\b|ล้างรถ|เบาะรถ|คาร์แคร์|น้ำมันเครื่อง|กันสนิม|ซิลิโคนออยล์/iu;

/**
 * ⚠️ **ลำดับในตารางนี้คือกฎ** — ตัวแรกที่ตรงชนะ จึงต้องเรียง "เจาะจง → กว้าง" เสมอ
 *
 * หมวดทำความสะอาดมีคำนำหน้ากว้างมาก (`น้ำยาล้าง` / `น้ำยาขัด`) ซึ่งกลืนได้ทั้ง
 * น้ำยาล้างจาน น้ำยาขัดรถ น้ำยาขัดรองเท้า จึงต้องอยู่ **ท้ายสุด** ไม่ใช่บนสุด
 * เช่นเดียวกับหมวดสกินแคร์ที่มีคำว่า `ออยล์` ซึ่งกลืน "ซิลิโคนออยล์" ของรถได้
 */
const DEMO_CATEGORIES: Array<{ match: RegExp; demo: DemoAction }> = [
  {
    match: CAR_CARE_PATTERN,
    demo: {
      scene: 'a car tyre and wheel arch in a home driveway, daylight',
      result: 'the treated section of rubber turns deep black and glossy next to the dull untreated part',
      action: 'The dull grey rubber turns deep black and glossy under the product as it is worked along one short stretch of the tyre wall.',
      hands: 1,
    },
  },
  {
    match: /น้ำยาล้างจาน|ล้างจาน|คราบมัน|จาระบี|เครื่องครัว|กระทะ|เตา/iu,
    demo: {
      scene: 'a kitchen sink with a greasy pan under running water',
      result: 'the grease breaks apart and rinses off, leaving bare clean metal',
      action: 'The greasy film breaks apart and slides off the pan as the product is squeezed over it, leaving bare clean metal behind.',
      hands: 1,
    },
  },
  {
    // 🐛 job_153 (สบู่ FayDa แพลงก์ตอน): คำว่า "สบู่" ไม่อยู่ในหมวดไหนเลยสักหมวด
    // → ตกไปได้ช็อต hero ทั้งสองคลิป และคลิป 2 กลายเป็น "กล่องโยก 8 องศา"
    // ซึ่งคือท่าที่เจ้าของบ่นไว้ตั้งแต่ job_123/124 ว่าน่าเบื่อ มันกลับมาเพราะสินค้าตกหมวด
    //
    // ที่เจ็บกว่านั้นคือบทพากย์เขียนว่า "เพียงถูสบู่จนเกิดฟองแล้วลูบไล้ทำความสะอาด"
    // = เสียงบรรยายท่าที่ภาพไม่เคยแสดงเลย ซ้ำรอย job_143 (รองเท้า) เป๊ะ
    //
    // ⚠️ สองมือ: มือหนึ่งถือสบู่ อีกมือถูให้เกิดฟอง — เป็นท่าที่ทำมือเดียวไม่ได้จริงๆ
    // ⚠️ ห้ามลงหน้าเด็ดขาด ให้เห็นแค่มือกับฟอง
    match: /สบู่|\bsoap\b|คลีนเซอร์|โฟมล้างหน้า|เจลล้างหน้า|แชมพู|ครีมอาบน้ำ/iu,
    demo: {
      scene: 'a clean bathroom sink counter with soft daylight',
      result: 'thick white lather builds up over the bar and the hands holding it',
      action: 'Thick white lather builds up over the bar as two wet hands rub it together, until the foam covers both the bar and the fingers.',
      prop: 'the white lather the product itself produces',
      hands: 2,
    },
  },
  {
    // ⚠️ ลงแขน/มือเท่านั้น ห้ามลงหน้า
    //
    // 🐛 job_156 (โลชั่น Oriental Princess Sakura): ท่าเดิมคือ "สำลีเช็ดท้องแขน" ซึ่งผมนับว่า
    // สองมือ — มือจับสำลี + แขนที่ถูกเช็ด — แล้ว **ลืมนับมือที่ถือสินค้าอยู่** ทั้งที่คลิป 2
    // ต่อจากเฟรมสุดท้ายของคลิป 1 ที่มือถือขวดค้างไว้เสมอ ของจริงจึงเป็นสามแขน
    // และคลิปที่ออกมาก็มีสามจริง: มือถือขวด · มือจับสำลี · แขนที่ถูกเช็ด (มีมือของตัวเองด้วย)
    // เป็นบั๊กเดียวกับ job_147 เป๊ะ ต่างกันแค่รอบนี้ผมนับพลาดเองแทนที่จะเขียนล็อกขัดกับท่า
    //
    // ท่าใหม่ผูกแขนที่ถูกเช็ดเข้ากับ "แขนข้างที่ถือสินค้า" โดยตรง → นับได้แน่นอนว่าสองแขน
    // ⚠️ ถ้าจะเพิ่มท่าที่ต้องจับของเพิ่ม ต้องปล่อยสินค้าลงก่อน ไม่งั้นเกินสองแขนทันที
    //
    // เจ้าของสั่งเพิ่มเมื่อ 1 ส.ค. หลังดู job_156: "ช็อตที่เอาไปเช็ดคือดีมากๆ แต่อยากให้มี
    // ช็อตที่บีบครีมลงผ้าแล้วค่อยเช็ด" — จังหวะบีบคือสิ่งที่ทำให้คนดูเชื่อว่าครีมบนแขน
    // มาจากขวดใบนี้จริง เหมือนจังหวะแกะซองของหมวดทิชชู่ (job_148) ที่ขาดแล้วอ่านเป็นคนละชิ้น
    match: /โทนเนอร์|เซรั่ม|ครีม|โลชั่น|เจล|ออยล์|บำรุงผิว|รักแร้|ข้อศอก|เช็ดคราบ|น้ำตบ/iu,
    demo: {
      scene: 'a bright bathroom counter beside a folded towel',
      result: 'a bead of the product sits on the pad and the wiped forearm is left visibly dewy',
      // ⚠️ ยาวกว่านี้ไม่ได้ — พรอมต์ถูกพิมพ์ทีละตัวอักษร ทุกคำที่เกินคือเวลารอจริงหน้าจอ
      // 🐛 job_162: เดิมเขียนว่า `as one press dispenses it` = กลไกของหัวปั๊ม
      // แต่สินค้าหมวดนี้ส่วนใหญ่เป็นขวดฝากระดก/หลอดบีบ ต้องเอียงแล้วบีบ ไม่ใช่กด
      // และเฟรมตั้งต้นฝาปิด โมเดลจึงทำท่ากดฝาที่เปิดไม่ได้อยู่ 6 วินาทีแล้วข้ามไปเช็ดเลย
      // → เปลี่ยนกลไกให้ตรงกับบรรจุภัณฑ์ + บังคับให้เฟรมตั้งต้นเปิดฝามาแล้ว (startState)
      action: 'A bead of the product lands on the cotton pad as the open bottle is tipped and squeezed once over it, until that pad wipes one slow pass along the inner forearm of the arm holding the product.',
      startState: 'with its cap or lid already open so the product can be poured or squeezed out straight away',
      prop: 'one plain white cotton pad in the free hand, plus the bare inner forearm of the same arm that holds the product',
      hands: 2,
    },
  },
  {
    // 🐛 job_147 → job_148: สองรอบที่ล้มเพราะเข้าใจโจทย์ผิด
    //
    // รอบแรกผมสั่ง "ดึงกระดาษออกจากซอง" ทั้งที่ล็อกห้ามมือที่สอง → เสกมือเพิ่มเป็นสามมือ
    // รอบสองผมเลยตัดจังหวะแกะออกให้เหลือ "แผ่นอยู่ในมือแล้ว" ซึ่งก็ผิดอีกทาง เพราะ job_148
    // แสดงให้เห็นว่าพอไม่มีจังหวะแกะ ของในมือจะ "เปลี่ยนชิ้นแบบเทเลพอร์ต" แล้วคนดูอ่านว่า
    // สินค้าคนละตัว (Codex สรุปว่า "โดยไม่มีจังหวะแกะหรือหยิบออกมาเลย" คือจุดที่สะดุดที่สุด)
    //
    // เจ้าของเคาะเมื่อ 1 ส.ค. ว่า **การแกะซองคือสิ่งที่ควรมี** เพราะมันคือภาพของการขายจริง
    // ทางที่ถูกจึงไม่ใช่ห้ามของในมือเปลี่ยน แต่คือ "บังคับให้เห็นจังหวะที่มันเปลี่ยน"
    // ⚠️ ฉากเดิมคือ "เคาน์เตอร์ที่มีน้ำหก" ซึ่งเข้าคู่กับท่าเช็ด พอท่าเปลี่ยนเป็นแกะซอง
    // น้ำที่หกก็กลายเป็นคำสัญญาที่ไม่มีวันถูกทำให้จบ = อาการเดียวกับที่เจ้าของบ่นใน job_147
    // ฉากต้องเข้าคู่กับท่าเสมอ แก้ท่าแล้วต้องกลับมาดูฉากด้วยทุกครั้ง
    match: /ทิชชู่|กระดาษเช็ด|แผ่นเช็ด|ผ้าเปียก|wet wipe|ผ้าเช็ด|ไมโครไฟเบอร์/iu,
    demo: {
      scene: 'a clean kitchen countertop in warm daylight',
      result: 'the pack is open and one clean sheet stands clear of it',
      action: 'One clean sheet rises out of the pack as two hands part the opening, until the sheet stands clear of the pack it came from.',
      prop: 'the single sheet drawn out of this same pack',
      hands: 2,
    },
  },
  {
    // สินค้าที่ขายเป็น "แพ็คของชิ้นเล็กเหมือนกันหลายชิ้น" — ท่าขายที่สมจริงที่สุดคือแกะให้ดู
    //
    // job_148 (แพมเพิส Penbose): เดิมผมกันหมวดนี้ออกเพราะคิดว่าท่าใช้งานผ้าอ้อมต้องมีตัวเด็ก
    // ซึ่งผิดกฎ "เห็นแค่มือ" — แต่ผมมองข้ามไปว่า **การแกะซองหยิบขึ้นมาดูก็เป็นท่าใช้งาน**
    // และเป็นท่าที่คนรีวิวจริงทำกันตลอด โมเดลเองก็พยายามทำอยู่แล้ว (มันหยิบผ้าอ้อมขึ้นมาเอง)
    // เราแค่ไม่เคยสั่ง มันเลยข้ามจังหวะแกะไปเลยจนดูเหมือนสลับสินค้า
    //
    // ⚠️ ไม่มีเด็ก ไม่มีการสวมใส่ — แค่แกะแล้วชูให้เห็นชิ้นจริง
    // ⚠️ จงใจไม่ใส่ `\d+\s*ชิ้น` หรือ `แพ็ค\s*\d` แม้จะเขียนง่ายกว่า — ชื่อสินค้าบน Shopee
    // ใส่จำนวนชิ้นกันแทบทุกตัว ตัวจับแบบนั้นจะกวาดสินค้าเกือบทั้งฐานเข้ามาเป็นช็อตแกะซอง
    // รวมถึงของที่ไม่ได้ขายเป็นแพ็ค (ชุดเครื่องมือ 12 ชิ้น ฯลฯ) ซึ่งท่าแกะจะดูไม่เข้าท่า
    // เจ้าของเคาะไว้ว่า "เฉพาะหมวดที่มีท่าใช้ชัด" จึงยอมพลาดบางตัวดีกว่ากวาดเกิน
    match: /แพมเพิส|ผ้าอ้อม|\bdiaper|มาส์ก|แผ่นมาส์ก|ผ้าอนามัย|สำลี|คอตตอนบัด/iu,
    demo: {
      scene: 'a tidy home shelf where this product is kept, warm daylight',
      // 🐛 job_164 (แพมเพิส Penbose): จังหวะแกะออกมาสวยครบ แต่พอถึงวินาทีที่ 3 ผ้าอ้อม
      // ที่กางอยู่ในมือ **ร่วงลงชั้นแล้วกลายเป็นก้อนพับเล็กๆ คนละทรง** และมือที่ถือมันหายไปเลย
      // เจ้าของดูออกทันที ("อยู่ดีดีผ้าอ้อมวาร์ปหายไป")
      //
      // ต้นเหตุคือคำว่า `both clearly in frame` = ขอแค่ "อยู่ในเฟรม" ซึ่งวางลงบนชั้นก็ยังอยู่
      // โมเดลเลยเลือกทางที่ถูกที่สุด แล้วพอเรนเดอร์ใหม่เป็นของที่วางอยู่ มันก็วาดทรงใหม่ไปด้วย
      //
      // หมวดทิชชู่ใช้คำว่า `stands clear of the pack` ซึ่งบังคับให้ยกค้าง และผ่านมาแล้วใน #157
      // ⚠️ ต้องบอกด้วยว่า "ยังอยู่ในมือเดิม ทรงเดิม" ไม่งั้นยกค้างแต่เปลี่ยนทรงก็ยังเกิดได้
      result: 'the pack is open and one single piece from inside is held clear of it, both visible together',
      action: 'One piece from inside rises out of the pack as two hands open it, until it stands clear of the pack still held in that same hand, keeping the exact shape it had on the way out.',
      prop: 'the single piece taken out of this same pack',
      hands: 2,
    },
  },
  {
    // ⚠️ ของกินต้องได้ฉากครัวแสงอุ่นเสมอ — ห้ามใช้ฉากกลางๆ
    // job_80 (พริกกากหมู) เคยตกไปได้ "minimal dark slate tabletop" แล้วภาพออกมาเหมือน
    // โฆษณาเหล้า ไม่น่ากิน (ดูคอมเมนต์ใน reference-style.ts) ตอนนี้ฉากของโหมดสาธิต
    // ทับฉากจาก BACKGROUND_FAMILIES จึงต้องแยกหมวดของกินออกมาตั้งฉากเอง ไม่งั้นเสียของเดิม
    match: /ขนม|ซองขนม|ขบเคี้ยว|อบกรอบ|คุกกี้|เยลลี่|ลูกอม|สาหร่าย|แคบหมู|กากหมู|ถั่วทอด|ข้าวเกรียบ/iu,
    demo: {
      scene: 'a modern home kitchen counter with gentle warm morning light',
      result: 'the bag is open and one piece is lifted clear of it, both the piece and the bag visible together',
      // ⚠️ เคยเขียนว่า `both clearly in frame` เหมือนหมวดแพมเพิส ซึ่ง job_164 พิสูจน์แล้วว่า
      // โมเดลจะวางของลงแล้วเอามือออก เพราะวางแล้วก็ยังอยู่ในเฟรมครบตามที่สั่ง — แก้พร้อมกัน
      action: 'One piece rises out of the bag as two hands part the opening, until it stands clear of the bag still held in that same hand, keeping the exact shape it had on the way out.',
      prop: 'the single piece taken out of this same bag',
      hands: 2,
    },
  },
  {
    // 🐛 job_154 (เครื่องปั่น Yotex): ตกทุกหมวด → คลิป 2 ได้ท่าสำรองกลางๆ
    // "completes one slow, natural in-use action" ซึ่งไม่ได้บอกว่าให้ทำอะไร
    // ทั้งที่เครื่องปั่นมีท่าที่ชัดที่สุดในบรรดาสินค้าทั้งหมด: กดปุ่ม → ของข้างในเปลี่ยนสภาพ
    //
    // ⚠️ มือเดียวจริง — ตัวเครื่องตั้งอยู่บนเคาน์เตอร์ มือแค่กดปุ่ม ไม่ต้องจับตัวเครื่อง
    //    (ชื่อสินค้าของ job_154 เขียนเองว่า "การทำงานด้วยปุ่มเดียว")
    // ⚠️ ของที่อยู่ข้างในนับเป็น "ของใหม่ในเฟรม" ตามล็อก จึงต้องประกาศเป็น prop
    // ⚠️ จงใจไม่ใส่ `หม้อ` เดี่ยวๆ — หม้อต้มธรรมดาไม่มีปุ่มและของข้างในไม่เปลี่ยนสภาพให้เห็น
    //    เอาเฉพาะที่ "กดแล้วเห็นผล" จริงๆ
    match: /เครื่องปั่น|โถปั่น|ปั่นอาหาร|เครื่องบด|เครื่องสับ|เครื่องคั้น|สกัดน้ำ|\bblender\b|เครื่องตีไข่|หม้อทอด|หม้อหุง|หม้อไฟฟ้า|หม้อนึ่ง/iu,
    demo: {
      scene: 'a bright home kitchen counter with the ingredients already inside the product',
      result: 'the food inside has visibly changed from raw and chunky to finished and even',
      action: 'The food inside turns from chunky and raw to smooth and even as one press sets the product running.',
      prop: 'the food already sitting inside the product',
      hands: 1,
    },
  },
  {
    // 📊 สแกนฐานข้อมูล 1 ส.ค. 2026: 50 รายการ ครอบคลุมแค่ 24%
    // ก้อนที่ใหญ่ที่สุดคืออาหารเสริมแบบเม็ดในกระปุก **20 รายการ = 40% ของทั้งฐาน**
    //
    // ⚠️ ชื่อสินค้ากลุ่มนี้เต็มไปด้วยคำเคลมโรค (ไทรอยด์ รูมาตอยด์ หอบหืด แพนิค ซิฟิลิส)
    // ท่าในนี้จึงต้องเป็นกลางล้วน — แค่เทเม็ดออกมาให้เห็นของจริง ห้ามสื่อถึงการรักษา
    // ส่วนคำเคลมในบทพากย์มี MEDICAL_CLAIM ใน narration-rules คุมอยู่แล้ว คนละด่านกัน
    match: /อาหารเสริม|ผลิตภัณฑ์เสริมอาหาร|สมุนไพร|วิตามิน|แคปซูล|\bBLB\s*U\b|บีแอลบี|บาลานซ์|\bBalance\s*U/iu,
    demo: {
      scene: 'a clean home table beside a glass of water, warm daylight',
      result: 'a few capsules now rest in the open palm beside the opened jar',
      action: 'A few capsules tip out into the open palm as the jar is tilted once, coming to rest beside the jar they came from.',
      prop: 'the capsules poured out of this same jar and the open palm holding them',
      hands: 2,
    },
  },
  {
    // เสื้อผ้า — เจ้าของเคยขอช็อตสวมใส่ไว้ 31 ก.ค. แต่การใส่เสื้อต้องวาดลำตัว
    // ซึ่งผิดกฎ "เห็นแค่มือ" จึงใช้ท่าที่พิสูจน์เนื้อผ้าได้โดยไม่ต้องมีคน:
    // ดึงผ้าออกแล้วปล่อย เห็นว่าคืนทรงไม่ย้วย
    // ⚠️ ไม้แขวนเสื้อมีคำว่า "เสื้อ" ด้วย แต่มีคำของตัวเองสองคำ ตัวนับคะแนนจึงแยกออกเอง
    match: /เสื้อยืด|เสื้อเชิ้ต|เสื้อผ้า|กางเกง|เดรส|กระโปรง|โอเวอร์ไซส์|\bt-?shirt\b/iu,
    demo: {
      scene: 'a tidy bedroom surface with soft daylight',
      result: 'the stretched fabric snaps back to its original shape with no sag left',
      action: 'The stretched fabric snaps back to its original shape as two hands release the pull, leaving no sag behind.',
      hands: 2,
    },
  },
  {
    // ⚠️ เดิมเขียนว่า "stays put on the shoulders" ซึ่งหมายถึงไหล่ของ **ไม้แขวน** ในหัวผม
    // ด่านนับแขนที่เพิ่งเพิ่ม (auditDemoLimbAccounting) จับคำนี้ได้ แล้วผมเกือบยกเว้นให้เพราะ
    // คิดว่ามันจับผิด — แต่โมเดลก็อ่านกำกวมได้เหมือนกัน และคลิปนี้ห้ามมีคนอยู่ในเฟรมเด็ดขาด
    // เลี่ยงคำที่เป็นอวัยวะไปเลยดีกว่าเขียนยกเว้น: ไม้แขวนมี "ปลายลาดสองข้าง" เรียกแบบนั้นได้
    match: /ไม้แขวน|ที่แขวนเสื้อ|ราวแขวน/iu,
    demo: {
      scene: 'an open wardrobe rail with soft daylight',
      result: 'the garment hangs settled on the hanger without sliding off its two sloped ends',
      action: 'The garment settles onto the hanger and stays put across its two sloped ends without sliding off as the hand lets go.',
      prop: 'one plain garment being hung on this same hanger',
      hands: 2,
    },
  },
  {
    // 🐛 job_158 (หูฟังบลูทูธ): ท่าเดิมสั่ง "เปิดฝาเผยให้เห็นหูฟัง **ทั้งสองข้าง**"
    // แต่เฟรมที่ผ่านด่านมีหูฟังข้างเดียว อีกช่องเป็นก้อนไฟเขียวเบลอๆ
    // **สั่งให้เผยของที่ไม่มีอยู่ในเฟรม = สั่งให้เสกขึ้นมา** แล้วมันก็เสกเป็น AirPods
    // ล็อกที่เขียนว่า never invent unseen parts แพ้ให้ท่าที่ขัดกับมันเอง = job_147 ซ้ำรอย
    //
    // ท่าใหม่หยิบของที่ **อยู่ในเฟรมอยู่แล้ว** ออกมา ไม่ต้องเผยอะไรที่ยังไม่เคยเห็น
    // (รูปทรงเดียวกับท่าดึงกระดาษออกจากซองของหมวดทิชชู่ ซึ่งผ่านมาแล้วใน job_157)
    // ⚠️ สองมือจริง: มือหนึ่งถือเคส อีกมือหยิบหูฟังออก — นับรวมมือที่ถือสินค้าแล้ว
    match: /หูฟัง|\bTWS\b|เอียร์บัด|earbud|headphone|\bหูฟังบลูทูธ\b/iu,
    demo: {
      scene: 'a clean desk with warm daylight from a side window',
      result: 'one earbud is out of the case and held clear of it, with its empty cradle visible',
      action: 'One earbud rises out of its cradle as two fingers lift it, until it stands clear of the case it came from.',
      prop: 'the earbud lifted out of this same case, and the empty cradle it leaves behind',
      hands: 2,
    },
  },
  {
    // 🐛 job_160 (กระติกสแตนเลส 316): ท่าเดิมคือ "เทน้ำใส่จนเต็ม ผิวนอกยังแห้ง"
    // เจ้าของดูแล้วบอกว่า "ยังไงมันก็ยังแปลกนะ" — ถูกต้อง ท่านั้นผิดพร้อมกันสามข้อ
    //
    //   1. ไม่เคยสั่งให้เปิดฝาก่อน ทั้งที่เฟรมตั้งต้นฝาปิดอยู่ → เทน้ำใส่ฝาปิดคือทางตัน
    //      โมเดลแก้ด้วยการ **ลบฝาทิ้งกลางคลิป** แล้วปากสแตนเลสก็โผล่มาเอง = เทเลพอร์ต
    //      แบบเดียวกับซองแพมเพิสใน job_148 ที่กลายเป็นผ้าอ้อมชิ้นเดียวโดยไม่มีจังหวะแกะ
    //   2. `until it is full` — กระติกสแตนเลสทึบ มองไม่เห็นระดับน้ำ ผลลัพธ์ที่มองไม่เห็น
    //      เท่ากับไม่มีผลลัพธ์ น้ำเลยไหลไปเรื่อยๆ ไม่มีจุดจบ และเหยือกก็อยู่นอกเฟรมทั้งคลิป
    //   3. `the outside stays completely dry` — สั่งให้ "ไม่มีอะไรเกิดขึ้น" เป็นผลลัพธ์
    //      ผิดกฎที่เขียนไว้เองหัวไฟล์นี้ว่าผลต้องเห็นในเฟรม ไม่งั้นช็อตนี้ก็แค่ขยับเฉยๆ
    //
    // ท่าใหม่: เปิดฝา ซึ่งเห็นชัด ทำได้ในจังหวะเดียว ไม่ต้องเสกของใหม่เข้าเฟรม
    // และปากสแตนเลสข้างในมีอยู่จริงในรูปทางการ ไม่ใช่ของที่ต้องเดา
    //
    // ⚠️ ถ้าจะเอาจังหวะเทน้ำกลับมา ต้องให้ **เฟรมตั้งต้นฝาเปิดอยู่แล้ว** ไม่ใช่หวังให้โมเดล
    // เปิดเองระหว่างทาง — สองจังหวะใน 8 วินาทีคือสิ่งที่ job_147 พิสูจน์แล้วว่าไม่รอด
    match: /กระบอกน้ำ|กระติก|ขวดน้ำ|แก้วน้ำ|เก็บความเย็น|เก็บความร้อน|ทัมเบลอร์|tumbler/iu,
    demo: {
      scene: 'a kitchen counter beside a jug of iced water',
      result: 'the lid stands open and the bare steel mouth of the bottle is visible',
      action: 'The lid swings open on its hinge to uncover the bare steel mouth of the bottle, staying attached to this same bottle the whole time.',
      hands: 1,
    },
  },
  {
    // 🐛 job_155: ผมเหมา `ผ้ารองรีด` เข้าหมวดนี้เพราะมันเป็นของนุ่มเหมือนกัน
    // ผลคือผ้ารองรีดไปวางอยู่ **บนเตียงนอน** แล้วถูกกดเหมือนหมอน ทั้งที่ชื่อสินค้า
    // เขียนไว้เองว่า "สำหรับโต๊ะรีดผ้า" — ผิดกฎที่ผมเพิ่งเขียนเองเมื่อเช้าว่า
    // "ฉากต้องเป็นที่ที่สินค้าถูกใช้จริง" ผ้ารองรีดมีที่ของมันคือโต๊ะรีดผ้า
    //
    // ⚠️ ความนุ่มเหมือนกันไม่ได้แปลว่าใช้ที่เดียวกัน — เกณฑ์คือ "ใช้ที่ไหน" ไม่ใช่ "ทำจากอะไร"
    match: /หมอน|ที่นอน|เบาะรองนั่ง|โฟมรองนอน|ผ้าห่ม|ผ้าปูที่นอน/iu,
    demo: {
      scene: 'a neatly made bed with soft morning light from a bedroom window',
      result: 'the pressed dent springs back until the surface looks untouched again',
      // ⚠️ สองมือจริง: มือหนึ่งประคองหมอนไว้ อีกมือคือฝ่ามือที่กดลงไป
      // 🐛 job_161: ประกาศไว้ 1 ล็อกจึงสั่ง "ห้ามมือที่สองเข้ามา" พร้อมกับท่าที่ต้องใช้สองมือ
      // โมเดลเลือกทำตามท่าและเสกมือที่สองขึ้นมา = job_147 ซ้ำรอยเป็นครั้งที่สาม
      action: 'The pressed dent springs back and the surface returns to full loft as the palm lifts away.',
      prop: 'the dent the palm leaves behind',
      hands: 2,
    },
  },
  {
    // ผ้ารองรีด/แผ่นรองรีด — ที่ของมันคือโต๊ะรีดผ้า และท่าขายคือรีดแล้วผ้าเรียบ
    // (แยกออกจากหมวดหมอนหลัง job_155 ที่มันไปโดนกดอยู่บนเตียง)
    // ⚠️ สองมือ: มือหนึ่งจับเตารีด อีกมือรั้งผ้า — เตารีดต้องประกาศเป็น prop
    match: /ผ้ารองรีด|แผ่นรองรีด|โต๊ะรีดผ้า|ที่รองรีด/iu,
    demo: {
      scene: 'an ironing board set up in a bright laundry corner',
      result: 'the creased shirt on the cover turns smooth and flat where the iron has passed',
      action: 'The creased fabric on the cover turns smooth and flat as the iron glides over it once.',
      prop: 'one household iron and the shirt being pressed on this cover',
      hands: 2,
    },
  },
  {
    // พัดลม/เครื่องใช้ไฟฟ้าที่มีใบพัด — กดแล้วใบพัดหมุน
    match: /พัดลม|\bfan\b|พัดลมพกพา|เครื่องเป่า|ไดร์เป่าผม/iu,
    demo: {
      scene: 'a tidy desk corner with warm daylight',
      result: 'the blades are spinning and the guard blurs with motion',
      action: 'The blades spin up into a blur behind the guard as the power button is pressed once.',
      hands: 1,
    },
  },
  {
    // น้ำยาซักผ้า — เทลงฝาตวง เห็นเนื้อน้ำยาและสี
    match: /ซักผ้า|น้ำยาซัก|ผงซักฟอก|ปรับผ้านุ่ม|\bdetergent\b/iu,
    demo: {
      scene: 'a laundry area beside a washing machine, daylight',
      result: 'the measuring cap is filled to the line with the coloured liquid',
      action: 'The coloured liquid fills the measuring cap up to its line as the bottle is tipped once.',
      prop: 'the measuring cap that comes with this same bottle',
      hands: 2,
    },
  },
  {
    match: /สเปรย์|ฉีดพ่น|ปรับอากาศ|ดับกลิ่น|กำจัด(?:ยุง|แมลง|มด)|ไล่ยุง/iu,
    demo: {
      scene: 'a corner of a real room where the product would be used',
      result: 'a fine mist leaves the nozzle and drifts across the frame',
      action: 'A fine visible mist bursts from the nozzle and drifts across the frame as the trigger is pressed once.',
      hands: 1,
    },
  },
  {
    // 🧹 หมวดเดียวกับคลิปอ้างอิงที่เจ้าของส่งมา (แปรงขัดพื้นห้องน้ำ Krumaew Ai Studio)
    //
    // ⚠️ **ต้องอยู่ท้ายสุดเสมอ** — `น้ำยาล้าง` / `น้ำยาขัด` กลืนสินค้าหมวดอื่นได้เยอะมาก
    // job_149 ตอนที่ entry นี้อยู่บนสุด: "น้ำยาขัดยางดำเงา" (เคลือบยางรถ) ถูกส่งไปขัดพื้น
    // ห้องน้ำ และ "น้ำยาล้างจาน" ก็จะโดนกลืนเหมือนกันทั้งที่มี entry ของตัวเองอยู่แล้ว
    // ย้ายมาท้ายสุดแล้วหมวดเจาะจงทุกตัวได้จับก่อน เหลือตัวนี้เป็นตาข่ายรับของที่ไม่เข้าใคร
    match: /น้ำยา(?:ล้าง|ขัด|ถู|ทำความสะอาด)|ห้องน้ำ|ขัดพื้น|ถูพื้น|ไม้ถู|ไม้ม็อบ|ไม้ม๊อบ|\bmop\b|แปรงขัด|ขจัดคราบ|คราบสกปรก|ตะไคร่|เชื้อรา/iu,
    demo: {
      scene: 'a real tiled bathroom floor with visible grime between the tiles',
      result: 'the scrubbed strip turns visibly cleaner than the untouched tile beside it',
      action: 'The grimy tile turns visibly clean under the product as it scrubs one short stretch, leaving a bright clean strip beside the still-dirty tile.',
      hands: 1,
    },
  },
];

/**
 * นับว่าชื่อสินค้าตรงกับหมวดนี้ "กี่คำ" ไม่ใช่แค่ "ตรงหรือไม่ตรง"
 *
 * 🐛 ทำไมต้องนับ — การเรียงลำดับอย่างเดียวแก้ปัญหานี้ไม่ได้ พิสูจน์มาแล้วสองรอบในวันเดียว:
 *
 *   job_149 (เคลือบยางดำ ซิลิโคนออยล์): หมวดทำความสะอาดอยู่บนสุด คำว่า `น้ำยาขัด`
 *     ในชื่อ "น้ำยาขัดยางดำเงา" จับได้ก่อน → สินค้ารถไปขัดพื้นห้องน้ำ
 *     ผมแก้ด้วยการย้ายหมวดทำความสะอาดไปท้ายสุด แล้ว...
 *
 *   job_150 (ถังปั่นไม้ม๊อบถูพื้น): ชื่อมีคำว่า "ผ้าม๊อบไมโครไฟเบอร์" ซึ่ง `ไมโครไฟเบอร์`
 *     อยู่ในหมวดทิชชู่/ผ้าเช็ด ที่ตอนนี้อยู่ก่อนหมวดพื้น → ไม้ม็อบได้ท่า "ดึงกระดาษออกจากซอง"
 *     บนเคาน์เตอร์ครัว ทั้งที่ชื่อสินค้ามีคำบอกว่าเป็นของถูพื้นอยู่ตั้ง 4 คำ
 *
 * ย้ายลำดับทีก็เกิดบั๊กใหม่ทีหนึ่ง เพราะชุดคำของแต่ละหมวดซ้อนกันจริงๆ และคำอย่าง
 * `ไมโครไฟเบอร์` ก็กำกวมด้วยตัวมันเอง (เป็นได้ทั้งผ้าม็อบและผ้าเช็ดทำความสะอาด)
 *
 * การนับจำนวนคำที่ตรงแก้ได้ทั้งสองเคสโดยไม่ต้องพึ่งลำดับ:
 *   ยางดำ/ทายาง/เคลือบยาง/ซิลิโคนออยล์ = 4  ชนะ  น้ำยาขัด = 1
 *   ไม้ม๊อบ/ถูพื้น/ไม้ถู/mop = 4          ชนะ  ไมโครไฟเบอร์ = 1
 * ลำดับในตารางเหลือหน้าที่แค่ตัดสินตอนคะแนนเท่ากันเท่านั้น
 */
function categoryScore(pattern: RegExp, productTitle: string): number {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const hits = productTitle.match(new RegExp(pattern.source, flags));
  if (!hits) return 0;
  // นับคำที่ "ต่างกันจริง" — ชื่อสินค้าไทยชอบพิมพ์คำเดิมซ้ำหลายรอบเพื่อ SEO
  // ("ไม้ถูพื้น ไม้ม๊อบ ถังปั่นไม้ม๊อบ") ถ้านับซ้ำด้วยคะแนนจะเฟ้อตามความยาวชื่อ ไม่ใช่ตามความตรง
  return new Set(hits.map((hit) => hit.toLowerCase())).size;
}

/**
 * ⚠️ ด่านนับแขน — สินค้า "ถูกถืออยู่เสมอ" หนึ่งมือ ตั้งแต่เฟรมแรกของคลิป 1
 *
 * 🐛 job_147 แล้ว job_156: บั๊กเดียวกันสองรอบ ทั้งสองรอบผมนับแขนในหัวแล้วลืมนับมือที่ถือสินค้า
 * รอบ 156 ผมถึงกับเขียนคอมเมนต์ไว้เองว่า "สองมือ: มือหนึ่งจับสำลี อีกแขนคือแขนที่ถูกเช็ด"
 * ซึ่งนับครบสองแล้วในความคิดผม แต่ในเฟรมจริงมีสาม เพราะขวดยังอยู่ในมืออีกข้างตลอดเวลา
 * เจ้าของดูออกทันที ("เหมือนมี 3 แขนเลย")
 *
 * กฎที่นับได้จริง: ท่าไหนพูดถึงอวัยวะที่ "ไม่ใช่มือ/นิ้ว" ต้องบอกด้วยว่าอวัยวะนั้นเป็นของใคร
 * — ของแขนข้างที่ถือสินค้า หรือของมือที่ว่างอยู่ ถ้าไม่บอก แปลว่ามีคนที่สามอยู่ในเฟรม
 *
 * ตั้งใจไม่ตรวจ `result` เพราะมันบอก "สิ่งที่เปลี่ยน" ไม่ได้เรียกอวัยวะเข้าฉาก
 */
const LIMB_BEYOND_HANDS = /\b(?:fore)?arms?\b|\bwrists?\b|\belbows?\b|\bshoulders?\b|\bfoot\b|\bfeet\b|\blegs?\b|\bknees?\b/i;
const LIMB_OWNERSHIP = /\b(?:that|which)\s+holds?\s+the\s+product\b|\bholding\s+the\s+product\b|\bthe\s+free\s+hand\b/i;

/**
 * ⚠️ ชิ้นส่วนของมือที่ "ลงมือทำ" — ฝ่ามือ นิ้ว นิ้วโป้ง
 *
 * 🐛 job_161 (หมอน TOTORI): ท่าเขียนว่า "as the palm lifts away" แต่ประกาศ hands: 1
 * ล็อกจึงสั่ง "ห้ามมือที่สองเข้ามา" พร้อมกับท่าที่ต้องมีมือที่สอง โมเดลทำตามท่า
 * และเสกมือขึ้นมาจริงในคลิป — job_147 ซ้ำรอยเป็นครั้งที่สาม
 *
 * ด่าน LIMB_BEYOND_HANDS จับไม่ได้เพราะมันไล่หา "อวัยวะที่ไม่ใช่มือ" ส่วนฝ่ามือก็คือมือ
 * แต่ประเด็นคือ **สินค้าถูกถืออยู่หนึ่งมือเสมอ** ฝ่ามือที่ลงมือทำจึงเป็นมือที่สองโดยอัตโนมัติ
 */
const ACTING_HAND_PART = /\bpalms?\b|\bfingers?\b|\bthumbs?\b/i;

/** คืนรายการหมวดที่เรียกอวัยวะเข้าฉากโดยไม่บอกว่าเป็นของแขนไหน (ว่าง = ผ่าน) */
export function auditDemoLimbAccounting(): string[] {
  const problems: string[] = [];
  for (const entry of DEMO_CATEGORIES) {
    const demanded = `${entry.demo.action} ${entry.demo.prop || ''}`;
    if (entry.demo.hands === 1 && ACTING_HAND_PART.test(demanded)) {
      problems.push(
        `${entry.match.source}: ท่าใช้ฝ่ามือ/นิ้วลงมือทำ แต่ประกาศไว้มือเดียว `
        + '— สินค้าถูกถืออยู่หนึ่งมือเสมอ ชิ้นส่วนที่ลงมือทำจึงเป็นมือที่สอง'
      );
    }
    if (!LIMB_BEYOND_HANDS.test(demanded)) continue;
    if (LIMB_OWNERSHIP.test(demanded)) continue;
    problems.push(
      `${entry.match.source}: ท่าเรียกอวัยวะที่ไม่ใช่มือเข้าฉากโดยไม่บอกว่าเป็นของแขนไหน `
      + '— สินค้าถูกถืออยู่หนึ่งมือเสมอ อวัยวะที่ลอยมาเองคือแขนที่สาม'
    );
  }
  return problems;
}

/**
 * คืนช็อตใช้งานจริงของสินค้านั้น ถ้าเป็นหมวดที่มีท่าชัด (ไม่ใช่ก็คืน null → คงช็อต hero เดิม)
 */
export function demoActionFor(productTitle = ''): DemoAction | null {
  let best: { demo: DemoAction; score: number } | null = null;
  for (const entry of DEMO_CATEGORIES) {
    const score = categoryScore(entry.match, productTitle);
    // `>` ไม่ใช่ `>=` — คะแนนเท่ากันให้ตัวที่อยู่ก่อนในตารางชนะ
    if (score > 0 && (!best || score > best.score)) best = { demo: entry.demo, score };
  }
  return best?.demo || null;
}
