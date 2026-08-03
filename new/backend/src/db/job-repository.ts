import { getPool } from './database.js';
import type {
  JobStatus,
  GeminiVisionResult,
  BotStats,
} from '../types.js';

// ===== Review Items (อ่านจาก item table ของ backend เดิม) =====

// ===== Flow Jobs =====

/** อัพเดท job — flexible update */
export async function updateJob(
  jobId: number,
  updates: Partial<{
    status: JobStatus;
    visionResult: GeminiVisionResult;
    reviewImagePaths: string[];
    clipPaths: string[];
    clipUrls: string[];
    ttsAudioPath: string;
    ttsVoice: string;
    subtitlePath: string;
    finalVideoPath: string;
    errorMessage: string;
    retryCount: number;
    workerId: number | null;
  }>
): Promise<void> {
  const db = getPool();
  const sets: string[] = ['updated_at = NOW()'];
  const values: any[] = [jobId];
  let idx = 2;

  const jsonFields: Record<string, string> = {
    visionResult: 'vision_result',
    reviewImagePaths: 'review_image_paths',
    clipPaths: 'clip_paths',
    clipUrls: 'clip_urls',
  };

  const textFields: Record<string, string> = {
    status: 'status',
    ttsAudioPath: 'tts_audio_path',
    ttsVoice: 'tts_voice',
    subtitlePath: 'subtitle_path',
    finalVideoPath: 'final_video_path',
    errorMessage: 'error_message',
  };

  const intFields: Record<string, string> = {
    retryCount: 'retry_count',
    workerId: 'worker_id',
  };

  for (const [key, col] of Object.entries(jsonFields)) {
    if ((updates as any)[key] !== undefined) {
      sets.push(`${col} = $${idx}`);
      values.push(JSON.stringify((updates as any)[key]));
      idx++;
    }
  }

  for (const [key, col] of Object.entries(textFields)) {
    if ((updates as any)[key] !== undefined) {
      sets.push(`${col} = $${idx}`);
      values.push((updates as any)[key]);
      idx++;
    }
  }

  for (const [key, col] of Object.entries(intFields)) {
    if ((updates as any)[key] !== undefined) {
      sets.push(`${col} = $${idx}`);
      values.push((updates as any)[key]);
      idx++;
    }
  }

  // งานที่จบแล้ว (completed/failed) ต้องไม่เหลือ worker_id ค้าง — ปล่อยคนงานคืนเสมอ
  // เดิมแต่ละ call site ต้องจำใส่ workerId:null เอง ซึ่งลืมบ่อย (deep debug พบค้าง 73 งาน:
  // failed 52 + completed 21) ย้ายมาบังคับที่นี่จุดเดียว จะได้ครอบทุกเส้นทางอัตโนมัติ
  if ((updates.status === 'completed' || updates.status === 'failed') && updates.workerId === undefined) {
    sets.push('worker_id = NULL');
  }

  await db.query(
    `UPDATE flow_job SET ${sets.join(', ')} WHERE id = $1`,
    values
  );
}

/**
 * รูปตั้งต้นที่สินค้าตัวนี้ "เคยใช้ไปแล้ว" ในงานก่อนหน้า
 *
 * 🐛 เจ้าของทักเมื่อ 3 ส.ค. 2026 ว่า "รูปที่สุ่มออกมามีแต่รูปเดิมๆ ตลอดเลย" — จริงตามนั้น
 * โลชั่น Oriental Princess ถูกทำ 5 งาน (72/107/123/140/156) และเลือก `review_candidate_6`
 * ทั้งห้าครั้ง ทั้งที่สินค้านั้นมีสื่อในฐาน 175 ชิ้น
 *
 * คืนทั้ง URL (งานใหม่บันทึกไว้ตรงๆ) และ path (งานเก่าที่ยังไม่มี URL ให้ถอดเลขผู้สมัครเอา)
 */
export async function usedSourceImagesForItem(
  itemId: number,
  exceptJobId: number
): Promise<{ url: string | null; path: string | null }[]> {
  const db = getPool();
  const result = await db.query(
    `SELECT vision_result->>'sourceImageUrl' AS url,
            vision_result->>'sourceImagePath' AS path
       FROM flow_job
      WHERE item_id = $1 AND id <> $2 AND vision_result IS NOT NULL`,
    [itemId, exceptJobId]
  );
  return result.rows.map((row) => ({ url: row.url || null, path: row.path || null }));
}

/**
 * รีเซ็ต job ที่ตายค้าง (retry เต็ม) ให้กลับมาลองใหม่ได้
 *
 * ใช้ตอน "แก้ต้นเหตุแล้ว" เช่นเพิ่งเปิด FLOW_GENERATION_ENABLED หรือแก้ selector เสร็จ
 * — คลิปที่เจนไว้แล้วใน clip_paths จะไม่ถูกลบ worker จะทำต่อจาก checkpoint
 */
export async function resetExhaustedJobs(maxRetries: number): Promise<number> {
  const db = getPool();
  const result = await db.query(
    `UPDATE flow_job
     SET status = 'pending', retry_count = 0, worker_id = NULL, updated_at = NOW()
     WHERE status = 'failed' AND retry_count >= $1
     RETURNING id`,
    [maxRetries]
  );
  return result.rowCount ?? 0;
}

/** ดึงสถิติ */
export async function getStats(): Promise<BotStats> {
  const db = getPool();
  const result = await db.query(`
    SELECT
      COUNT(*) as total,
      COUNT(*) FILTER (WHERE status = 'completed') as completed,
      COUNT(*) FILTER (WHERE status = 'failed') as failed,
      COUNT(*) FILTER (WHERE status = 'pending') as pending,
      COUNT(*) FILTER (WHERE status NOT IN ('pending', 'completed', 'failed')) as in_progress,
      COALESCE(SUM(jsonb_array_length(clip_paths)) FILTER (WHERE status = 'completed'), 0) as total_clips,
      COUNT(*) FILTER (WHERE status = 'completed' AND final_video_path IS NOT NULL) as total_final,
      COUNT(DISTINCT worker_id) FILTER (WHERE status NOT IN ('pending', 'completed', 'failed')) as active_workers
    FROM flow_job
  `);

  const row = result.rows[0];
  return {
    totalJobs: parseInt(row.total),
    completedJobs: parseInt(row.completed),
    failedJobs: parseInt(row.failed),
    pendingJobs: parseInt(row.pending),
    inProgressJobs: parseInt(row.in_progress),
    totalClips: parseInt(row.total_clips),
    totalFinalVideos: parseInt(row.total_final),
    startTime: new Date(),
    activeWorkers: parseInt(row.active_workers),
  };
}

// ⛔ ไม่มี mapRowToJob แล้ว — แปลงแถว DB เป็น FlowJob ทั้งก้อน 20 ฟิลด์ โดยไม่มีใครเรียกเลย
// เหลือจากยุคที่ฝั่ง Node เป็นคนเดินงานเอง ตอนนี้ Extension ถือ checkpoint และผู้เรียกทุกคน
// อ่านเฉพาะคอลัมน์ที่ตัวเองต้องใช้ ไม่ได้ดึงทั้งแถวมาแปลง (ลบ 1 ส.ค. 2026)
