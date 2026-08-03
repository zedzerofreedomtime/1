import { readJson, sendJson, type RouteHandler } from '../http.js';
import {
  getAllAccounts,
  flagAccount,
  recoverAccount,
  getNextAvailableAccount,
  recordJobCompleted
} from '../../proxy/account-manager.js';
import { logger } from '../../utils/logger.js';

export const accountRoutes: RouteHandler = async ({ req, res, url }) => {
  // GET /api/accounts
  if (url.pathname === '/api/accounts' && req.method === 'GET') {
    const accounts = getAllAccounts();
    sendJson(res, 200, { ok: true, data: accounts });
    return true;
  }

  // GET /api/accounts/next
  if (url.pathname === '/api/accounts/next' && req.method === 'GET') {
    const account = getNextAvailableAccount();
    if (!account) {
      sendJson(res, 404, { ok: false, error: 'ไม่มีบัญชีที่พร้อมใช้งานในขณะนี้' });
      return true;
    }
    sendJson(res, 200, { ok: true, data: account });
    return true;
  }

  // POST /api/accounts/flag
  if (url.pathname === '/api/accounts/flag' && req.method === 'POST') {
    try {
      const body = await readJson(req);
      const port = body.port;
      const reason = body.reason || 'ไม่ระบุสาเหตุ';
      
      if (typeof port !== 'number') {
        sendJson(res, 400, { ok: false, error: 'ระบุ port เป็นตัวเลข' });
        return true;
      }

      flagAccount(port, reason);
      sendJson(res, 200, { ok: true, message: `ระงับบัญชีที่พอร์ต ${port} สำเร็จ` });
      return true;
    } catch (err) {
      logger.error(`❌ Flag Account Error: ${(err as Error).message}`);
      sendJson(res, 500, { ok: false, error: 'Internal Server Error' });
      return true;
    }
  }

  // POST /api/accounts/recover
  if (url.pathname === '/api/accounts/recover' && req.method === 'POST') {
    try {
      const body = await readJson(req);
      const port = body.port;
      
      if (typeof port !== 'number') {
        sendJson(res, 400, { ok: false, error: 'ระบุ port เป็นตัวเลข' });
        return true;
      }

      recoverAccount(port);
      sendJson(res, 200, { ok: true, message: `กู้คืนบัญชีที่พอร์ต ${port} สำเร็จ` });
      return true;
    } catch (err) {
      logger.error(`❌ Recover Account Error: ${(err as Error).message}`);
      sendJson(res, 500, { ok: false, error: 'Internal Server Error' });
      return true;
    }
  }

  // POST /api/accounts/job-completed
  if (url.pathname === '/api/accounts/job-completed' && req.method === 'POST') {
    try {
      const body = await readJson(req);
      const port = body.port;
      
      if (typeof port !== 'number') {
        sendJson(res, 400, { ok: false, error: 'ระบุ port เป็นตัวเลข' });
        return true;
      }

      recordJobCompleted(port);
      sendJson(res, 200, { ok: true });
      return true;
    } catch (err) {
      logger.error(`❌ Job Completed Account Error: ${(err as Error).message}`);
      sendJson(res, 500, { ok: false, error: 'Internal Server Error' });
      return true;
    }
  }

  return false;
};
