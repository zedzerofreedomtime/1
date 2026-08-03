import { logger } from '../src/utils/logger.js';
import { connectDB, disconnectDB, initFlowTables } from '../src/db/database.js';
import { getStats } from '../src/db/job-repository.js';

/** แสดงสถานะ queue ปัจจุบัน */
async function main(): Promise<void> {
  try {
    await connectDB();
    await initFlowTables();
    const stats = await getStats();

    logger.info('═'.repeat(50));
    logger.info('📊 ClipBot Flow v2 — สถานะปัจจุบัน');
    logger.info('═'.repeat(50));
    logger.info(`   📋 Jobs ทั้งหมด:       ${stats.totalJobs}`);
    logger.info(`   ⏳ Pending:            ${stats.pendingJobs}`);
    logger.info(`   🔄 In Progress:        ${stats.inProgressJobs}`);
    logger.info(`   ✅ Completed:          ${stats.completedJobs}`);
    logger.info(`   ❌ Failed:             ${stats.failedJobs}`);
    logger.info(`   🎬 คลิปทั้งหมด:        ${stats.totalClips}`);
    logger.info(`   🎥 วิดีโอพร้อมลง:      ${stats.totalFinalVideos}`);
    logger.info(`   👷 Active Workers:     ${stats.activeWorkers}`);
    logger.info('═'.repeat(50));

    await disconnectDB();
  } catch (error) {
    logger.error('❌ ไม่สามารถดึงสถานะได้:', error);
    process.exit(1);
  }
}

main();
