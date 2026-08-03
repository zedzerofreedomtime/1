import pg from 'pg';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

const { Pool } = pg;

let pool: pg.Pool | null = null;

/** เชื่อมต่อ PostgreSQL */
export async function connectDB(): Promise<pg.Pool> {
  if (pool) return pool;

  // แปลง psycopg2 URL ให้เป็น pg URL (ถ้าจำเป็น)
  let dbUrl = config.databaseUrl;
  if (dbUrl.includes('+psycopg2')) {
    dbUrl = dbUrl.replace('+psycopg2', '');
  }
  if (dbUrl.startsWith('postgresql+')) {
    dbUrl = dbUrl.replace('postgresql+', 'postgresql');
  }

  pool = new Pool({
    connectionString: dbUrl,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });

  try {
    const client = await pool.connect();
    logger.info('✅ เชื่อมต่อ PostgreSQL สำเร็จ');
    client.release();
  } catch (error) {
    logger.error('❌ เชื่อมต่อ PostgreSQL ไม่ได้:', error);
    throw error;
  }

  return pool;
}

/** ปิดการเชื่อมต่อ */
export async function disconnectDB(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    logger.info('🔌 ปิดการเชื่อมต่อ PostgreSQL');
  }
}

/** ดึง pool instance */
export function getPool(): pg.Pool {
  if (!pool)
    throw new Error('Database not connected. Call connectDB() first.');
  return pool;
}

/**
 * ลบรูปในคลัง gallery (media_json ของ item) — 3 โหมด:
 *   image = ลบรูปเดียวตาม url · item = ลบรูปทั้งหมดของสินค้านั้น · all = ลบรูปทุกสินค้า
 * ลบเฉพาะ entry ชนิด image เท่านั้น (วิดีโอไม่โดน) และเก็บ row สินค้าไว้
 */
export async function deleteGalleryMedia(
  mode: 'image' | 'item' | 'all',
  itemId?: number,
  url?: string
): Promise<{ affected: number }> {
  const db = getPool();
  const stripImages = `COALESCE((SELECT jsonb_agg(elem) FROM jsonb_array_elements(media_json) elem WHERE elem->>'type' <> 'image'), '[]'::jsonb)`;
  if (mode === 'image') {
    if (!itemId || !url) throw new Error('โหมด image ต้องมี itemId และ url');
    const r = await db.query(
      `UPDATE item SET media_json = COALESCE((SELECT jsonb_agg(elem) FROM jsonb_array_elements(media_json) elem WHERE elem->>'url' <> $2), '[]'::jsonb) WHERE id = $1`,
      [itemId, url]
    );
    return { affected: r.rowCount || 0 };
  }
  if (mode === 'item') {
    if (!itemId) throw new Error('โหมด item ต้องมี itemId');
    const r = await db.query(`UPDATE item SET media_json = ${stripImages} WHERE id = $1`, [itemId]);
    return { affected: r.rowCount || 0 };
  }
  // ต้องเป็น 'all' ชัดเจนเท่านั้น — กัน mode ผิด/หาย มาลบล้างทั้ง gallery โดยไม่ตั้งใจ
  if (mode !== 'all') throw new Error(`mode ไม่ถูกต้อง: ${String(mode)} (ต้องเป็น image/item/all)`);
  const r = await db.query(`UPDATE item SET media_json = ${stripImages} WHERE media_json @> '[{"type":"image"}]'`);
  return { affected: r.rowCount || 0 };
}

/**
 * ทำให้ schema ที่ Node ใช้เป็น canonical และรองรับฐาน Python เดิม
 * ทุกคำสั่งต้องรันซ้ำได้ เพราะฟังก์ชันนี้ทำงานทุกครั้งที่ service เริ่มต้น
 */
export async function initFlowTables(): Promise<void> {
  const db = getPool();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      CREATE TABLE IF NOT EXISTS clipforge_schema_migration (
        version INTEGER PRIMARY KEY,
        description TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS dataset (
        id SERIAL PRIMARY KEY,
        name VARCHAR NOT NULL,
        active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );

      ALTER TABLE dataset ADD COLUMN IF NOT EXISTS active BOOLEAN;
      ALTER TABLE dataset ADD COLUMN IF NOT EXISTS created_at TIMESTAMP;
      UPDATE dataset SET active = TRUE WHERE active IS NULL;
      UPDATE dataset SET created_at = NOW() WHERE created_at IS NULL;
      ALTER TABLE dataset ALTER COLUMN active SET DEFAULT TRUE;
      ALTER TABLE dataset ALTER COLUMN active SET NOT NULL;
      ALTER TABLE dataset ALTER COLUMN created_at SET DEFAULT NOW();
      ALTER TABLE dataset ALTER COLUMN created_at SET NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_dataset_name_unique ON dataset(name);

      CREATE TABLE IF NOT EXISTS item (
        id SERIAL PRIMARY KEY,
        dataset_id INTEGER NOT NULL,
        product_id BIGINT NOT NULL,
        title VARCHAR NOT NULL DEFAULT '',
        price VARCHAR NOT NULL DEFAULT '',
        product_url VARCHAR NOT NULL DEFAULT '',
        review_summary VARCHAR NOT NULL DEFAULT '',
        media_json JSONB NOT NULL DEFAULT '[]'::jsonb,
        status VARCHAR NOT NULL DEFAULT 'pending',
        locked_by INTEGER,
        locked_at TIMESTAMP,
        done_by INTEGER,
        done_at TIMESTAMP,
        post_state VARCHAR NOT NULL DEFAULT '',
        posted_verified BOOLEAN NOT NULL DEFAULT FALSE,
        post_message VARCHAR NOT NULL DEFAULT '',
        post_ref VARCHAR NOT NULL DEFAULT '',
        posted_at TIMESTAMP
      );

      ALTER TABLE item ADD COLUMN IF NOT EXISTS title VARCHAR;
      ALTER TABLE item ADD COLUMN IF NOT EXISTS price VARCHAR;
      ALTER TABLE item ADD COLUMN IF NOT EXISTS product_url VARCHAR;
      ALTER TABLE item ADD COLUMN IF NOT EXISTS review_summary VARCHAR;
      -- สเปก/รายละเอียดสินค้าที่ scrape มาจากหน้า Shopee (ป้อนเป็น VERIFIED FACTS ให้ Gemini พากย์)
      ALTER TABLE item ADD COLUMN IF NOT EXISTS product_detail TEXT;
      -- รูปสินค้าทางการหลายมุมจาก Shopee PDP — ใช้อ้างอิงเจน start/end frame (Veo interpolate)
      ALTER TABLE item ADD COLUMN IF NOT EXISTS official_images JSONB;
      ALTER TABLE item ADD COLUMN IF NOT EXISTS media_json JSONB;
      ALTER TABLE item ADD COLUMN IF NOT EXISTS status VARCHAR;
      ALTER TABLE item ADD COLUMN IF NOT EXISTS post_state VARCHAR;
      ALTER TABLE item ADD COLUMN IF NOT EXISTS posted_verified BOOLEAN;
      ALTER TABLE item ADD COLUMN IF NOT EXISTS post_message VARCHAR;
      ALTER TABLE item ADD COLUMN IF NOT EXISTS post_ref VARCHAR;

      UPDATE item SET title = '' WHERE title IS NULL;
      UPDATE item SET price = '' WHERE price IS NULL;
      UPDATE item SET product_url = '' WHERE product_url IS NULL;
      UPDATE item SET review_summary = '' WHERE review_summary IS NULL;
      UPDATE item SET status = 'pending' WHERE status IS NULL;
      UPDATE item SET post_state = '' WHERE post_state IS NULL;
      UPDATE item SET posted_verified = FALSE WHERE posted_verified IS NULL;
      UPDATE item SET post_message = '' WHERE post_message IS NULL;
      UPDATE item SET post_ref = '' WHERE post_ref IS NULL;

      ALTER TABLE item ALTER COLUMN title SET DEFAULT '';
      ALTER TABLE item ALTER COLUMN price SET DEFAULT '';
      ALTER TABLE item ALTER COLUMN product_url SET DEFAULT '';
      ALTER TABLE item ALTER COLUMN review_summary SET DEFAULT '';
      ALTER TABLE item ALTER COLUMN status SET DEFAULT 'pending';
      ALTER TABLE item ALTER COLUMN post_state SET DEFAULT '';
      ALTER TABLE item ALTER COLUMN posted_verified SET DEFAULT FALSE;
      ALTER TABLE item ALTER COLUMN post_message SET DEFAULT '';
      ALTER TABLE item ALTER COLUMN post_ref SET DEFAULT '';

      ALTER TABLE item ALTER COLUMN title SET NOT NULL;
      ALTER TABLE item ALTER COLUMN price SET NOT NULL;
      ALTER TABLE item ALTER COLUMN product_url SET NOT NULL;
      ALTER TABLE item ALTER COLUMN review_summary SET NOT NULL;
      ALTER TABLE item ALTER COLUMN status SET NOT NULL;
      ALTER TABLE item ALTER COLUMN post_state SET NOT NULL;
      ALTER TABLE item ALTER COLUMN posted_verified SET NOT NULL;
      ALTER TABLE item ALTER COLUMN post_message SET NOT NULL;
      ALTER TABLE item ALTER COLUMN post_ref SET NOT NULL;

      CREATE UNIQUE INDEX IF NOT EXISTS idx_item_dataset_product_unique
        ON item(dataset_id, product_id);
      CREATE INDEX IF NOT EXISTS idx_item_status ON item(status);

      CREATE TABLE IF NOT EXISTS flow_job (
        id SERIAL PRIMARY KEY,
        item_id INTEGER NOT NULL,
        review_text TEXT NOT NULL DEFAULT '',
        vision_result JSONB,
        review_image_paths JSONB DEFAULT '[]'::jsonb,
        clip_paths JSONB DEFAULT '[]'::jsonb,
        clip_urls JSONB DEFAULT '[]'::jsonb,
        tts_audio_path TEXT,
        tts_voice TEXT,
        subtitle_path TEXT,
        final_video_path TEXT,
        status VARCHAR(50) NOT NULL DEFAULT 'pending',
        worker_id INTEGER,
        error_message TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0,
        target_duration_seconds INTEGER NOT NULL DEFAULT 24,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_flow_job_status ON flow_job(status);
      CREATE INDEX IF NOT EXISTS idx_flow_job_item_id ON flow_job(item_id);
      CREATE INDEX IF NOT EXISTS idx_flow_job_worker_id ON flow_job(worker_id);
      ALTER TABLE flow_job
        ADD COLUMN IF NOT EXISTS target_duration_seconds INTEGER NOT NULL DEFAULT 24;
      UPDATE flow_job
      SET target_duration_seconds = 24
      WHERE target_duration_seconds NOT IN (16, 24);

      CREATE TABLE IF NOT EXISTS scrape_job (
        id SERIAL PRIMARY KEY,
        dataset_name TEXT NOT NULL DEFAULT 'Shopee Scrape',
        product_url TEXT NOT NULL DEFAULT '',
        shopid TEXT NOT NULL DEFAULT '',
        itemid TEXT NOT NULL,
        filter INTEGER NOT NULL DEFAULT 0,
        status VARCHAR(50) NOT NULL DEFAULT 'pending',
        message TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL DEFAULT '',
        price TEXT NOT NULL DEFAULT '',
        reviews_count INTEGER NOT NULL DEFAULT 0,
        media_count INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_scrape_job_status ON scrape_job(status);
      CREATE INDEX IF NOT EXISTS idx_scrape_job_itemid ON scrape_job(itemid);

      CREATE TABLE IF NOT EXISTS scrape_ingest_batch (
        job_id INTEGER NOT NULL,
        batch_id TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (job_id, batch_id)
      );
      CREATE INDEX IF NOT EXISTS idx_scrape_ingest_batch_created_at
        ON scrape_ingest_batch(created_at);
    `);

    const mediaType = await client.query<{ data_type: string }>(`
      SELECT data_type
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'item' AND column_name = 'media_json'
    `);
    if (mediaType.rows[0]?.data_type !== 'jsonb') {
      const invalid = await client.query<{ id: number }>(`
        SELECT id FROM item
        WHERE media_json IS NULL
           OR BTRIM(media_json::text) = ''
           OR NOT pg_input_is_valid(media_json::text, 'jsonb')
        LIMIT 5
      `);
      if (invalid.rows.length) {
        throw new Error(
          `item.media_json มี JSON ไม่ถูกต้อง (item ids: ${invalid.rows.map((row) => row.id).join(', ')}) — หยุด migration เพื่อไม่ทำข้อมูลหาย`
        );
      }
      await client.query(`
        ALTER TABLE item
        ALTER COLUMN media_json TYPE JSONB USING media_json::jsonb
      `);
    }
    await client.query(`
      UPDATE item SET media_json = '[]'::jsonb WHERE media_json IS NULL;
      ALTER TABLE item ALTER COLUMN media_json SET DEFAULT '[]'::jsonb;
      ALTER TABLE item ALTER COLUMN media_json SET NOT NULL;

      INSERT INTO clipforge_schema_migration (version, description)
      VALUES (1, 'Own dataset/item/flow_job/scrape_job schema and migrate legacy Python defaults')
      ON CONFLICT (version) DO UPDATE SET description = EXCLUDED.description;

      INSERT INTO clipforge_schema_migration (version, description)
      VALUES (2, 'Make scraper ingest batches idempotent')
      ON CONFLICT (version) DO UPDATE SET description = EXCLUDED.description;
    `);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  const legacyScrapeTable = await db.query<{ exists: string | null }>(
    `SELECT to_regclass('public.scrapejob')::text AS exists`
  );
  if (legacyScrapeTable.rows[0]?.exists) {
    logger.warn('⚠️ พบตาราง Python เก่า scrapejob — เก็บไว้แบบ read-only; Node ใช้ scrape_job เท่านั้น');
  }
  logger.info('✅ ClipForge schema v2 พร้อมใช้งาน (dataset, item, flow_job, scrape_job, scrape_ingest_batch)');
}
