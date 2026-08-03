import { getPool } from '../db/database.js';
import { logger } from '../utils/logger.js';

export type ScrapeJob = {
  id: number;
  datasetName: string;
  productUrl: string;
  shopid: string;
  itemid: string;
  filter: number;
  status: string;
  message: string;
  title: string;
  price: string;
  reviewsCount: number;
  mediaCount: number;
  createdAt: string;
  updatedAt: string;
};

function rowToJob(row: any): ScrapeJob {
  return {
    id: Number(row.id),
    datasetName: row.dataset_name,
    productUrl: row.product_url,
    shopid: row.shopid,
    itemid: row.itemid,
    filter: Number(row.filter || 0),
    status: row.status,
    message: row.message || '',
    title: row.title || '',
    price: row.price || '',
    reviewsCount: Number(row.reviews_count || 0),
    mediaCount: Number(row.media_count || 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** รองรับทั้ง JSONB ของ schema ใหม่และข้อความ JSON จากฐาน Python เดิม */
export function parseStoredMedia(value: unknown): any[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseShopeeUrl(input: string): { shopid: string; itemid: string } {
  const text = input.trim();
  const patterns = [
    /\/product\/(\d+)\/(\d+)/i,
    /\/shop\/(\d+)\/item\/(\d+)/i,
    /[?&]shopid=(\d+).*?[?&]itemid=(\d+)/i,
    /i\.(\d+)\.(\d+)/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return { shopid: match[1], itemid: match[2] };
  }
  throw new Error('Shopee URL must include shop id and item id');
}

async function ensureDataset(name: string, db: any = getPool()): Promise<number> {
  const row = await db.query(`
    INSERT INTO dataset (name)
    VALUES ($1)
    ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
    RETURNING id
  `, [name]);
  return Number(row.rows[0].id);
}

/** ป้องกัน payload เก่าที่แปลงอักษรไทยเป็นเครื่องหมายคำถามมาเขียนทับข้อมูลดี */
export function looksEncodingCorrupted(value: unknown): boolean {
  const text = String(value || '').trim();
  if (!text) return false;
  if (text.includes('\uFFFD')) return true;
  const questionMarks = (text.match(/\?/g) || []).length;
  return questionMarks >= 3 && questionMarks / text.length >= 0.1;
}

function preferValidText(incoming: unknown, existing: unknown = ''): string {
  const next = String(incoming || '').trim();
  if (!next || looksEncodingCorrupted(next)) return String(existing || '');
  return next;
}

export async function listScrapeJobs(): Promise<ScrapeJob[]> {
  const rows = await getPool().query(`
    SELECT * FROM scrape_job
    ORDER BY updated_at DESC, id DESC
    LIMIT 200
  `);
  return rows.rows.map(rowToJob);
}

export async function createScrapeJobs(input: { datasetName?: string; dataset_name?: string; urls?: string[] | string }) {
  const db = getPool();
  const datasetName = String(input.datasetName || input.dataset_name || 'Shopee Scrape').trim() || 'Shopee Scrape';
  const urls = Array.isArray(input.urls)
    ? input.urls
    : String(input.urls || '').split(/\r?\n/);
  const created: ScrapeJob[] = [];
  for (const rawUrl of urls) {
    const productUrl = String(rawUrl || '').trim();
    if (!productUrl) continue;
    const { shopid, itemid } = parseShopeeUrl(productUrl);
    const row = await db.query(`
      INSERT INTO scrape_job (dataset_name, product_url, shopid, itemid)
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `, [datasetName, productUrl, shopid, itemid]);
    created.push(rowToJob(row.rows[0]));
  }
  return created;
}

export async function claimNextScrapeJob() {
  const db = getPool();
  const claimed = await db.query(`
    UPDATE scrape_job
    SET status = 'running', message = 'sent to extension', updated_at = NOW()
    WHERE id = (
      SELECT id FROM scrape_job
      WHERE status = 'pending'
      ORDER BY id ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING *
  `);
  const row = claimed.rows[0];
  if (!row) return null;
  return {
    id: Number(row.id),
    product_url: row.product_url,
    shopid: row.shopid,
    itemid: row.itemid,
    filter: Number(row.filter || 0),
  };
}

export async function ingestScrapeBatch(payload: any) {
  const pool = getPool();
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const jobId = Number(payload.job_id || 0);
    const batchId = String(payload.batch_id || '').trim().slice(0, 240);
    const job = jobId ? (await db.query('SELECT * FROM scrape_job WHERE id = $1', [jobId])).rows[0] : null;
    const datasetName = job?.dataset_name || preferValidText(payload.dataset_name, 'Shopee Scrape');
    const datasetId = await ensureDataset(datasetName || 'Shopee Scrape', db);
    const productId = Number(payload.product_id || job?.itemid || 0);
    if (!productId) throw new Error('missing product id');
    // วินิจฉัย: harvester ส่ง product_detail/official_images มาจริงไหมต่อ batch (0.2.4 spec pipeline)
    logger.info(`[harvest.ingest] job=${jobId} item=${productId} product_detail=${String(payload.product_detail || '').length}ตัวอักษร official_images=${Array.isArray(payload.official_images) ? payload.official_images.length : 0}รูป reviews=${Array.isArray(payload.review_texts) ? payload.review_texts.length : 0}`);

    if (jobId && batchId) {
      const marker = await db.query(`
        INSERT INTO scrape_ingest_batch (job_id, batch_id)
        VALUES ($1, $2)
        ON CONFLICT (job_id, batch_id) DO NOTHING
        RETURNING batch_id
      `, [jobId, batchId]);
      if (!marker.rows.length) {
        const current = await db.query(`
          SELECT CASE WHEN jsonb_typeof(media_json) = 'array' THEN jsonb_array_length(media_json) ELSE 0 END AS media_total
          FROM item WHERE dataset_id = $1 AND product_id = $2
        `, [datasetId, productId]);
        await db.query('COMMIT');
        return { mediaTotal: Number(current.rows[0]?.media_total || 0), mediaAdded: 0 };
      }
    }

    const existing = await db.query(
      'SELECT * FROM item WHERE dataset_id = $1 AND product_id = $2 LIMIT 1 FOR UPDATE',
      [datasetId, productId]
    );
    const item = existing.rows[0];
    const media = parseStoredMedia(item?.media_json);
    const byUrl = new Map(media.filter((entry: any) => entry?.url).map((entry: any) => [entry.url, entry]));
    let added = 0;
    for (const source of Array.isArray(payload.media) ? payload.media : []) {
      const mediaUrl = String(source?.url || '').trim();
      if (!/^https?:\/\//i.test(mediaUrl)) continue;
      if (!byUrl.has(mediaUrl)) {
        const entry: any = { url: mediaUrl, type: source.type === 'video' ? 'video' : 'image' };
        if (source.reviewTimestamp != null) entry.reviewTimestamp = source.reviewTimestamp;
        if (source.reviewDate) entry.reviewDate = source.reviewDate;
        media.push(entry);
        byUrl.set(mediaUrl, entry);
        added++;
      }
    }

    const reviews = (Array.isArray(payload.review_texts) ? payload.review_texts : [])
      .map((text: any) => String(text || '').trim())
      .filter((text: string) => Boolean(text) && !looksEncodingCorrupted(text));
    const title = preferValidText(payload.title, item?.title);
    const price = preferValidText(payload.price, item?.price);
    const productUrl = preferValidText(payload.product_url, item?.product_url || job?.product_url);
    const incomingReviewSummary = reviews.length
      ? ['รีวิวจริงจากผู้ซื้อ:', ...reviews.slice(0, 8).map((text: string) => `- ${text.slice(0, 180)}`)].join('\n')
      : '';
    const reviewSummary = preferValidText(incomingReviewSummary, item?.review_summary);
    // สเปกสินค้าจากหน้า Shopee (scraper ส่ง product_detail มา) — เก็บไว้ป้อน Gemini เป็น VERIFIED FACTS
    // ถ้ารอบนี้ scraper ไม่ส่งมา ให้คงค่าเดิมไว้ (preferValidText fallback เป็นค่าใน item)
    const productDetail = preferValidText(payload.product_detail, item?.product_detail);
    // รูปสินค้าทางการหลายมุม (scraper ส่ง official_images) — ใช้อ้างอิงเจน start/end frame
    // ถ้ารอบนี้ไม่ส่งมา (รีวิวหน้าถัดไป) คงรูปเดิมไว้
    const incomingOfficialImages = Array.isArray(payload.official_images)
      ? payload.official_images.filter((u: unknown) => typeof u === 'string' && /^https?:\/\//i.test(u))
      : [];
    const officialImages = incomingOfficialImages.length
      ? incomingOfficialImages
      : parseStoredMedia(item?.official_images);

    if (item) {
      await db.query(`
        UPDATE item
        SET title = $1, price = $2, product_url = $3, review_summary = $4, media_json = $5,
            product_detail = $6, official_images = $7
        WHERE id = $8
      `, [title, price, productUrl, reviewSummary, JSON.stringify(media), productDetail, JSON.stringify(officialImages), item.id]);
    } else {
      await db.query(`
        INSERT INTO item (dataset_id, product_id, title, price, product_url, review_summary, media_json, product_detail, official_images)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `, [datasetId, productId, title, price, productUrl, reviewSummary, JSON.stringify(media), productDetail, JSON.stringify(officialImages)]);
    }

    if (job) {
      await db.query(`
        UPDATE scrape_job
        SET title = $1, price = $2, reviews_count = reviews_count + $3, media_count = $4,
            message = $5, updated_at = NOW()
        WHERE id = $6
      `, [title, price, reviews.length, media.length, `received ${reviews.length} text reviews, +${added} media`, job.id]);
    }

    await db.query('COMMIT');
    return { mediaTotal: media.length, mediaAdded: added };
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    db.release();
  }
}

export async function finishScrapeJob(id: number, status: 'done' | 'failed', message = '') {
  await getPool().query(`
    UPDATE scrape_job
    SET status = $1, message = $2, updated_at = NOW()
    WHERE id = $3
  `, [status, message || status, id]);
}

export async function deleteScrapeJob(id: number) {
  const db = getPool();
  await db.query('DELETE FROM scrape_ingest_batch WHERE job_id = $1', [id]);
  await db.query('DELETE FROM scrape_job WHERE id = $1', [id]);
}
