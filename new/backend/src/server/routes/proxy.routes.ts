import { readJson, sendJson, type RouteHandler } from '../http.js';
import {
  getAllProxyStatus,
  rotateProxy
} from '../../proxy/proxy-manager.js';
import { logger } from '../../utils/logger.js';

export const proxyRoutes: RouteHandler = async ({ req, res, url }) => {
  // GET /api/proxies
  if (url.pathname === '/api/proxies' && req.method === 'GET') {
    const proxies = getAllProxyStatus();
    sendJson(res, 200, { ok: true, data: proxies });
    return true;
  }

  // POST /api/proxies/rotate
  if (url.pathname === '/api/proxies/rotate' && req.method === 'POST') {
    try {
      const body = await readJson(req);
      const port = body.port;
      
      if (typeof port !== 'number') {
        sendJson(res, 400, { ok: false, error: 'ระบุ port เป็นตัวเลข' });
        return true;
      }

      const newProxy = rotateProxy(port);
      logger.info(`🔄 หมุนเวียน Proxy สำหรับ Port ${port}: ${newProxy || 'ไม่มี'}`);
      
      sendJson(res, 200, { ok: true, proxy: newProxy });
      return true;
    } catch (err) {
      logger.error(`❌ Rotate Proxy Error: ${(err as Error).message}`);
      sendJson(res, 500, { ok: false, error: 'Internal Server Error' });
      return true;
    }
  }

  return false;
};
