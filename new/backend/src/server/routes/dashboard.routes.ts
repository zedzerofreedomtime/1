import { deleteGalleryMedia, getPool } from '../../db/database.js';
import { eligibleReviewMediaEntries, mediaEntries, REVIEW_MEDIA_START_EPOCH_SECONDS } from '../../utils/review-media.js';
import { listScrapeJobs } from '../../scrape/harvester-api.js';
import { readExtensionRuntime } from '../../extension/extension-api.js';
import { readJson, sendJson, type RouteHandler } from '../http.js';
import { readFlowRuntimeFlags } from '../runtime-flags.js';

/** ข้อมูลทั้งหมดที่หน้าเว็บมอนิเตอร์ใช้แสดงผล (อ่านอย่างเดียว ไม่สั่งงานบอท) */
async function dashboardData() {
  const db = getPool();
  const [jobs, reviews] = await Promise.all([
    db.query(`
      SELECT j.id, j.item_id, j.status, j.review_text, j.review_image_paths, j.vision_result,
             j.clip_paths, j.final_video_path, j.error_message, j.retry_count,
             j.target_duration_seconds, j.updated_at, i.title, i.media_json, (i.id IS NULL) AS source_deleted
      FROM flow_job j
      LEFT JOIN item i ON i.id = j.item_id
      ORDER BY j.updated_at DESC, j.id DESC
      LIMIT 100
    `),
    db.query(`
      SELECT i.id, i.title, i.review_summary, i.media_json,
             ROW_NUMBER() OVER (ORDER BY i.id ASC)::int AS display_number
      FROM item i
      INNER JOIN dataset d ON d.id = i.dataset_id
      WHERE d.name = 'Shopee Scrape'
        AND i.review_summary <> ''
        AND i.media_json IS NOT NULL
        AND i.media_json <> '[]'
        AND EXISTS (
          SELECT 1 FROM jsonb_array_elements(i.media_json::jsonb) AS media
          WHERE media->>'type' = 'image'
            AND $1::double precision IS NOT NULL /* date filter removed — ใช้รูปทั้งหมด */
        )
      ORDER BY i.id ASC LIMIT 100
    `, [REVIEW_MEDIA_START_EPOCH_SECONDS]),
  ]);

  return {
    runtime: readExtensionRuntime(),
    featureFlags: readFlowRuntimeFlags(),
    scrapeJobs: await listScrapeJobs(),
    jobs: jobs.rows.map((row) => ({
      id: row.id,
      itemId: row.item_id,
      title: row.source_deleted ? `งาน #${row.id} · สินค้าต้นทางถูกลบ` : (row.title || `งาน #${row.id}`),
      sourceDeleted: row.source_deleted,
      status: row.status,
      reviewText: row.review_text,
      selectedImagePath: row.vision_result?.generatedImagePath || row.review_image_paths?.[0] || null,
      sourceProductImagePath: row.review_image_paths?.[0] || null,
      generatedImagePath: row.vision_result?.generatedImagePath || null,
      handGender: row.vision_result?.handGender || null,
      backgroundStyle: row.vision_result?.backgroundStyle || null,
      narrationRepairs: row.vision_result?.videoNarration?.repairs
        || row.vision_result?.upfrontNarration?.repairs
        || row.vision_result?.narrationRepairs
        || [],
      targetDurationSeconds: row.target_duration_seconds === 16 ? 16 : 24,
      clipCount: row.target_duration_seconds === 16 ? 2 : 3,
      clipPaths: row.clip_paths || [],
      finalVideoPath: row.final_video_path,
      errorMessage: row.error_message,
      retryCount: row.retry_count,
      updatedAt: row.updated_at,
      sourceImageUrl: mediaEntries(row.media_json).find((m: any) => m?.type === 'image')?.url
        || mediaEntries(row.media_json)[0]?.url || null,
    })),
    reviews: reviews.rows.map((row) => {
      const media = eligibleReviewMediaEntries(row.media_json);
      const imageCount = media.filter((entry: any) => entry?.type === 'image').length;
      return {
        id: row.id,
        displayNumber: row.display_number,
        title: `สินค้า #${row.display_number} · ${imageCount} รูป`,
        productTitle: row.title || '',
        reviewText: row.review_summary,
        imageCount,
        imageUrl: media.find((entry: any) => entry?.type === 'image')?.url || media[0]?.url || null,
        // รูปทั้งหมดของรีวิวนี้ — ใช้กับแท็บ "รูปที่เก็บมา" (gallery) ในเว็บ
        images: media.filter((entry: any) => entry?.type === 'image').map((entry: any) => entry.url),
      };
    }),
  };
}

export const dashboardRoutes: RouteHandler = async ({ req, res, url }) => {
  if (url.pathname === '/api/dashboard' && req.method === 'GET') {
    sendJson(res, 200, await dashboardData());
    return true;
  }

  // ลบรูปในคลัง gallery: {mode:'image'|'item'|'all', itemId?, url?}
  if (url.pathname === '/api/gallery/delete' && req.method === 'POST') {
    const body = await readJson(req);
    if (!['image', 'item', 'all'].includes(body.mode)) {
      sendJson(res, 400, { error: 'mode ต้องเป็น image/item/all เท่านั้น' });
      return true;
    }
    const result = await deleteGalleryMedia(body.mode, body.itemId ? Number(body.itemId) : undefined, body.url);
    sendJson(res, 200, { ok: true, ...result });
    return true;
  }

  return false;
};
