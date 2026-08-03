import { config } from '../src/config.js';
import { logger } from '../src/utils/logger.js';
import {
  connectDB,
  disconnectDB,
  initFlowTables,
  getPool,
} from '../src/db/database.js';
import { resetExhaustedJobs } from '../src/db/job-repository.js';

/**
 * กู้ job ที่ตายค้างเพราะ retry เต็ม ให้กลับมาลองใหม่
 *
 * ใช้เมื่อ "แก้ต้นเหตุแล้ว" เช่น เพิ่งเปิด FLOW_GENERATION_ENABLED
 * หรือแก้ selector เสร็จ — คลิปที่เจนไปแล้วจะไม่ถูกลบ
 * worker จะทำต่อจาก checkpoint (ไม่ต้องจ่าย credit ซ้ำ)
 */
async function main(): Promise<void> {
  try {
    await connectDB();
    await initFlowTables();
    const db = getPool();

    // โชว์ก่อนว่าจะกู้อะไรบ้าง
    const before = await db.query(
      `SELECT id, item_id, retry_count, jsonb_array_length(clip_paths) AS clips,
              left(error_message, 90) AS err
       FROM flow_job
       WHERE status = 'failed' AND retry_count >= $1
       ORDER BY id`,
      [config.maxRetries]
    );

    if (before.rows.length === 0) {
      logger.info('✅ ไม่มี job ที่ตายค้าง — ไม่ต้องกู้อะไร');
      await disconnectDB();
      return;
    }

    logger.info(`🔍 พบ ${before.rows.length} job ที่ตายค้าง:`);
    let savedClips = 0;
    for (const row of before.rows) {
      const clips = row.clips ?? 0;
      savedClips += clips;
      logger.info(`   #${row.id} (item ${row.item_id}) retry=${row.retry_count} | คลิปที่เจนไว้แล้ว: ${clips}`);
      logger.info(`      เหตุผลที่ตาย: ${row.err || '(ไม่ระบุ)'}`);
    }

    if (savedClips > 0) {
      logger.info(`💰 มี ${savedClips} คลิปที่จ่าย credit ไปแล้ว — จะใช้ต่อ ไม่เจนซ้ำ`);
    }

    const count = await resetExhaustedJobs(config.maxRetries);
    logger.info(`♻️ กู้ ${count} job กลับเข้าคิวแล้ว (retry_count = 0)`);

    if (!config.flowGenerationEnabled) {
      logger.warn('🔒 แต่ FLOW_GENERATION_ENABLED=false อยู่ — บอทจะยังไม่รัน');
      logger.warn('   เปิดใน .env ก่อน แล้วค่อย npm run start');
    } else {
      logger.info('▶️ รันต่อได้เลย: npm run start');
    }

    await disconnectDB();
  } catch (error) {
    logger.error('❌ กู้ job ไม่สำเร็จ:', error);
    process.exit(1);
  }
}

main();
