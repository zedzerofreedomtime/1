import {
  claimNextScrapeJob,
  createScrapeJobs,
  deleteScrapeJob,
  finishScrapeJob,
  ingestScrapeBatch,
  listScrapeJobs,
} from '../../scrape/harvester-api.js';
import { readJson, sendJson, type RouteHandler } from '../http.js';

/**
 * API ที่ Shopee Harvester extension คุยด้วย — คิวงาน scrape + รับ batch รีวิว
 * (คนละตัวกับ ClipBot Flow extension ที่ใช้ /api/extension/*)
 */
export const scrapeRoutes: RouteHandler = async ({ req, res, url }) => {
  const method = req.method;

  if (url.pathname === '/api/scrape/dashboard' && method === 'GET') {
    sendJson(res, 200, { ok: true, jobs: await listScrapeJobs() });
    return true;
  }

  const isJobList = url.pathname === '/api/scrape/jobs' || url.pathname === '/api/admin/scrape-jobs';
  if (isJobList && method === 'GET') {
    sendJson(res, 200, { ok: true, jobs: await listScrapeJobs() });
    return true;
  }
  if (isJobList && method === 'POST') {
    const created = await createScrapeJobs(await readJson(req));
    sendJson(res, 201, { ok: true, created });
    return true;
  }

  const deleteMatch = url.pathname.match(/^\/api\/admin\/scrape-jobs\/(\d+)$/);
  if (deleteMatch && method === 'DELETE') {
    await deleteScrapeJob(Number(deleteMatch[1]));
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (url.pathname === '/api/scrape/next' && method === 'POST') {
    sendJson(res, 200, { ok: true, job: await claimNextScrapeJob() });
    return true;
  }

  if (url.pathname === '/api/scrape/ingest' && method === 'POST') {
    const result = await ingestScrapeBatch(await readJson(req));
    sendJson(res, 200, {
      ok: true,
      media_total: result.mediaTotal,
      media_added: result.mediaAdded,
    });
    return true;
  }

  if (url.pathname === '/api/scrape/status' && method === 'POST') {
    sendJson(res, 200, { ok: true });
    return true;
  }

  const doneMatch = url.pathname.match(/^\/api\/scrape\/(\d+)\/(done|failed)$/);
  if (doneMatch && method === 'POST') {
    const body = await readJson(req);
    await finishScrapeJob(
      Number(doneMatch[1]),
      doneMatch[2] as 'done' | 'failed',
      String(body.message || '')
    );
    sendJson(res, 200, { ok: true });
    return true;
  }

  return false;
};
