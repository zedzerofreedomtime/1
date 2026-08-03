import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { genAI, generateContentWithRetry, imageInlinePart } from './gemini-client.js';
import { parseGeminiVisionJson } from './json-parser.js';

/**
 * คัดรูปทางการที่จะเอาไปเป็น "ส่วนผสม" ตอนเจนคลิป
 *
 * 🐛 เดิมหยิบรูปทางการ 3 ใบแรกมาดื้อๆ ซึ่งอันตรายกว่าที่คิด เพราะรูปทางการของ Shopee
 * ส่วนใหญ่ไม่ใช่รูปสินค้า แต่เป็น **โปสเตอร์โฆษณาที่มีตัวหนังสือเต็มภาพ** และบางใบเป็น
 * **ภาพผ่าซีกโชว์วงจรข้างใน** (ตรวจจากรูปจริงของ job_134: ใบที่ 1 มีคำว่า "เป่าได้ 64 ชม
 * 12000mAh 8นิ้ว" ทับอยู่ ใบที่ 4 เป็นภาพ X-ray แบตเตอรี่พร้อมข้อความพาดหัว)
 *
 * โหมดส่วนผสมวาดสินค้าใหม่จากรูปอ้างอิง การป้อนโปสเตอร์เข้าไปจึงเท่ากับสอนให้โมเดล
 * วาดตัวหนังสือมั่วลงบนตัวสินค้า และสอนรูปทรงที่ไม่ใช่ของจริง
 *
 * ลำดับที่ต้องการ: รูปสินค้าสะอาด → รูปใช้งานจริง → (ตัดโปสเตอร์/ภาพผ่าซีกทิ้ง)
 * รูปใช้งานจริงมีค่าเพราะเจ้าของสั่งไว้ตั้งแต่รอบ job_132 ว่าคลิปต้องสาธิตการใช้งานจริง
 */
export type IngredientRole = 'clean_product' | 'in_use' | 'text_poster' | 'diagram' | 'other';

export interface IngredientImageVerdict {
  path: string;
  role: IngredientRole;
  /** สัดส่วนพื้นที่ที่เป็นตัวหนังสือ/กราฟิกโฆษณา (0-100) */
  textCoverage: number;
  usable: boolean;
  reason: string;
}

const USABLE_ROLES: IngredientRole[] = ['clean_product', 'in_use'];
/** เกินนี้ถือว่าโปสเตอร์ครองภาพ ตัวสินค้าเหลือน้อยเกินกว่าจะใช้อ้างอิงรูปทรงได้ */
const MAX_TEXT_COVERAGE = 35;

function fallbackOrder(paths: string[], count: number): string[] {
  return paths.slice(0, count);
}

/**
 * โมเดลไม่ได้คืนชื่อ role ตรงตามที่สั่งเสมอ — เคยคืน "product_in_use" แทน "in_use"
 * แล้วตัวเทียบแบบตรงตัวตีตกทั้ง 9 ใบ ทั้งที่ตัวมันวิเคราะห์ถูกหมด จึงต้องเทียบแบบยืดหยุ่น
 * เรียงลำดับการตรวจสำคัญ: โปสเตอร์/ภาพผ่าซีกต้องถูกคัดออกก่อนที่จะไปเจอคำว่า "product"
 */
export function normalizeRole(value: unknown): IngredientRole {
  const role = String(value || '').toLowerCase();
  if (/poster|banner|marketing|text|collage|infographic/.test(role)) return 'text_poster';
  if (/diagram|cutaway|cut_away|exploded|x-?ray|schematic|internal/.test(role)) return 'diagram';
  if (/use|usage|scene|lifestyle|install|worn|mounted/.test(role)) return 'in_use';
  if (/clean|product|packshot|studio/.test(role)) return 'clean_product';
  return 'other';
}

/**
 * เรียง + คัดรูปส่วนผสม ถ้า Gemini ล้มหรือคืนค่าเพี้ยน จะถอยไปใช้ลำดับเดิม (3 ใบแรก)
 * เพราะการเตรียมงานต้องไม่พังเพราะขั้นตอนที่เป็นแค่ "การจัดลำดับให้ดีขึ้น"
 */
export async function pickIngredientImages(
  paths: string[],
  productTitle: string,
  count: number
): Promise<{ picked: string[]; verdicts: IngredientImageVerdict[] }> {
  if (paths.length <= 1 || count <= 0) {
    return { picked: fallbackOrder(paths, count), verdicts: [] };
  }

  const candidates = paths.slice(0, 9);
  const model = genAI.getGenerativeModel({
    model: config.geminiModel,
    generationConfig: {
      temperature: 0,
      topP: 0.1,
      // 9 รูป × คำอธิบายต่อใบ — 2048 เคยไม่พอแล้วคำตอบขาดกลางจน JSON พัง
      maxOutputTokens: 4096,
      thinkingConfig: { thinkingBudget: 0 },
      responseMimeType: 'application/json',
    } as any,
  });

  const parts: any[] = [
    {
      text: `You are picking reference photos of "${productTitle}" that will be fed into an
image-to-video model as visual references for the SAME product.

Classify EVERY image with one role:
- "clean_product": the physical product itself is the subject, clearly visible, little or no overlaid marketing text.
- "in_use": the real product shown installed, held, clipped, worn or being used in a real scene. Valuable — but only if the product itself is still clearly visible.
- "text_poster": a marketing banner where large overlaid text, price tags, badges or collage panels dominate the image.
- "diagram": cutaway, exploded, X-ray or schematic view showing internals that are not visible on the real product.
- "other": anything else (accessories only, packaging only, unrelated scene).

Also give "textCoverage" 0-100 = percentage of the image area covered by overlaid text and marketing graphics.

Return ONLY JSON:
{"images":[{"index":0,"role":"clean_product","textCoverage":5,"reason":"max 10 words"}]}
"index" is the zero-based position in the order the images are given. Use exactly the role words listed above.
Include every image exactly once and keep each "reason" under 10 words.`,
    },
  ];
  candidates.forEach((imagePath, index) => {
    parts.push({ text: `Image ${index}:` });
    parts.push(imageInlinePart(imagePath));
  });

  let verdicts: IngredientImageVerdict[];
  try {
    const result = await generateContentWithRetry(model, parts, 'คัดรูปส่วนผสม');
    // parseGeminiVisionJson พิมพ์ผลเป็น GeminiVisionResult เพราะถูกเขียนมาเพื่อสายวางแผนช็อต
    // ตัวคัดรูปใช้ schema คนละชุด จึงอ่านผ่าน any — ตัวแกะ JSON ที่ทนคำตอบเพี้ยนใช้ร่วมกันได้
    const parsed = parseGeminiVisionJson(result.response.text().trim()) as any;
    // โมเดลสลับไปมาระหว่างคืน {images:[...]} กับคืน array เปล่าๆ — รับทั้งสองแบบ
    const rows: any[] = Array.isArray(parsed) ? parsed
      : Array.isArray(parsed?.images) ? parsed.images
        : [];
    verdicts = candidates.map((imagePath, index) => {
      const row = rows.find((entry) => Number(entry?.index) === index) ?? rows[index];
      const role = normalizeRole(row?.role);
      const textCoverage = Math.max(0, Math.min(100, Number(row?.textCoverage) || 0));
      return {
        path: imagePath,
        role,
        textCoverage,
        usable: USABLE_ROLES.includes(role) && textCoverage <= MAX_TEXT_COVERAGE,
        reason: String(row?.reason || '').slice(0, 120),
      };
    });
  } catch (error: any) {
    logger.warn(`⚠️ คัดรูปส่วนผสมด้วย Gemini ไม่สำเร็จ (${String(error?.message || error).slice(0, 80)}) — ใช้ลำดับเดิม`);
    return { picked: fallbackOrder(paths, count), verdicts: [] };
  }

  // รูปสินค้าสะอาดมาก่อนเพื่อล็อกรูปทรง/ฉลากให้ถูก แล้วค่อยตามด้วยรูปใช้งานจริง
  // ภายในกลุ่มเดียวกัน ตัวหนังสือน้อยกว่าอยู่ก่อน
  const usable = verdicts
    .filter((verdict) => verdict.usable)
    .sort((a, b) => {
      if (a.role !== b.role) return a.role === 'clean_product' ? -1 : 1;
      return a.textCoverage - b.textCoverage;
    });

  const rejected = verdicts.filter((verdict) => !verdict.usable);
  if (rejected.length) {
    logger.info(
      `🧹 ตัดรูปส่วนผสมที่ใช้ไม่ได้ ${rejected.length} ใบ: `
      + rejected.map((verdict) => `${verdict.path.split(/[\\/]/).pop()} (${verdict.role}, ตัวหนังสือ ${verdict.textCoverage}%)`).join(', ')
    );
  }

  if (!usable.length) {
    // ทุกใบเป็นโปสเตอร์ = ไม่มีรูปอ้างอิงที่ดีจริง ยอมใช้แค่เฟรมตั้งต้นดีกว่าป้อนโปสเตอร์เข้าไป
    logger.warn('⚠️ ไม่มีรูปทางการใบไหนใช้เป็นส่วนผสมได้เลย (โปสเตอร์/ภาพผ่าซีกล้วน) — คลิปแรกจะใช้เฟรมตั้งต้นอย่างเดียว');
    return { picked: [], verdicts };
  }

  const picked = usable.slice(0, count);
  logger.info(
    `🧪 เลือกรูปส่วนผสม ${picked.length} ใบ: `
    + picked.map((verdict) => `${verdict.path.split(/[\\/]/).pop()} (${verdict.role})`).join(', ')
  );
  return { picked: picked.map((verdict) => verdict.path), verdicts };
}
