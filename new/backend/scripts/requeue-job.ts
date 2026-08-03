import { connectDB, disconnectDB, getPool } from '../src/db/database.js';

async function main(): Promise<void> {
  const jobId = Number(process.argv[2]);
  if (!Number.isInteger(jobId) || jobId < 1) {
    throw new Error('Usage: npm run requeue-job -- <job-id>');
  }

  await connectDB();
  try {
    const result = await getPool().query(
      `UPDATE flow_job
       SET status = 'pending', worker_id = NULL, error_message = NULL,
           retry_count = 0, updated_at = NOW()
       WHERE id = $1
         AND vision_result IS NOT NULL
         AND (
           COALESCE(vision_result->>'generatedImagePath', '') <> ''
           OR jsonb_array_length(clip_paths) > 0
         )
       RETURNING id, status`,
      [jobId]
    );
    if (!result.rows[0]) {
      throw new Error(`Job #${jobId} has no safe image/video checkpoint to resume`);
    }
    console.log(`Job #${jobId} requeued from its saved checkpoint`);
  } finally {
    await disconnectDB();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
