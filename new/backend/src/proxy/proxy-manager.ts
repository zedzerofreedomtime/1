import fs from 'fs';
import path from 'path';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

export interface ProxyEntry {
  url: string;
  assignedPort: number | null;
  status: 'active' | 'cooldown' | 'dead';
  failCount: number;
  successCount: number;
  lastUsed: number;
  cooldownUntil: number;
}

const PROXIES_FILE = path.join(process.cwd(), 'data', 'proxies.json');
let proxies: ProxyEntry[] = [];

/**
 * โหลด proxies จาก ENV และไฟล์ data/proxies.json
 */
export function loadProxies(): void {
  const loadedProxies = new Map<string, ProxyEntry>();

  // 1. โหลดจาก ENV
  if (config.proxyList && config.proxyList.length > 0) {
    for (const url of config.proxyList) {
      loadedProxies.set(url, {
        url,
        assignedPort: null,
        status: 'active',
        failCount: 0,
        successCount: 0,
        lastUsed: 0,
        cooldownUntil: 0
      });
    }
  }

  // 2. โหลดจากไฟล์ proxies.json
  try {
    if (fs.existsSync(PROXIES_FILE)) {
      const fileData = fs.readFileSync(PROXIES_FILE, 'utf-8');
      const fileProxies = JSON.parse(fileData) as ProxyEntry[];
      
      for (const p of fileProxies) {
        if (!loadedProxies.has(p.url)) {
          loadedProxies.set(p.url, {
            ...p,
            status: 'active', // รีเซ็ตสถานะเมื่อโหลดใหม่
            failCount: 0,
            cooldownUntil: 0
          });
        }
      }
    }
  } catch (error) {
    logger.error(`❌ ไม่สามารถโหลดไฟล์ proxies.json ได้: ${(error as Error).message}`);
  }

  proxies = Array.from(loadedProxies.values());
  logger.info(`✅ โหลด Proxies สำเร็จทั้งหมด ${proxies.length} รายการ`);
}

/**
 * หา proxy ที่ว่างอยู่ หรือที่ใช้อยู่แล้วสำหรับพอร์ตนี้
 */
export function getProxyForPort(port: number): string | null {
  if (proxies.length === 0) return null;

  // ตรวจสอบว่าพอร์ตนี้มี proxy ที่ assign ไว้และยังใช้งานได้อยู่หรือไม่
  const current = proxies.find(p => p.assignedPort === port && p.status === 'active');
  if (current) {
    current.lastUsed = Date.now();
    return current.url;
  }

  // ถ้าไม่มี ให้หา proxy ที่ว่างและสถานะพร้อมใช้งานแบบ round-robin
  // จัดเรียงตาม lastUsed เพื่อกระจายการใช้งาน
  const available = proxies
    .filter(p => p.assignedPort === null && p.status === 'active')
    .sort((a, b) => a.lastUsed - b.lastUsed);

  if (available.length > 0) {
    const selected = available[0];
    selected.assignedPort = port;
    selected.lastUsed = Date.now();
    logger.info(`🔄 Assign Proxy ${selected.url} ให้กับ Port ${port}`);
    return selected.url;
  }

  logger.warn(`⚠️ ไม่มี Proxy ว่างสำหรับ Port ${port}`);
  return null;
}

/**
 * รายงานว่า proxy มีปัญหา
 */
export function reportProxyFailure(port: number): void {
  const p = proxies.find(x => x.assignedPort === port);
  if (!p) return;

  p.failCount += 1;
  logger.warn(`⚠️ Proxy ${p.url} ล้มเหลว (ครั้งที่ ${p.failCount}/${config.proxyMaxFailCount})`);

  if (p.failCount >= config.proxyMaxFailCount) {
    p.status = 'dead';
    p.assignedPort = null;
    logger.error(`❌ Proxy ${p.url} ถูกระงับการใช้งาน (dead)`);
  } else {
    p.status = 'cooldown';
    p.cooldownUntil = Date.now() + config.proxyHealthCheckIntervalMs;
    p.assignedPort = null;
  }
}

/**
 * รายงานว่า proxy ใช้งานสำเร็จ
 */
export function reportProxySuccess(port: number): void {
  const p = proxies.find(x => x.assignedPort === port);
  if (!p) return;

  p.successCount += 1;
  p.failCount = 0; // รีเซ็ตเมื่อสำเร็จ
}

/**
 * เปลี่ยน proxy สำหรับพอร์ตนั้น
 */
export function rotateProxy(port: number): string | null {
  const current = proxies.find(p => p.assignedPort === port);
  if (current) {
    current.assignedPort = null;
  }
  return getProxyForPort(port);
}

/**
 * ดึงสถานะ proxy ทั้งหมด
 */
export function getAllProxyStatus(): ProxyEntry[] {
  // รีเฟรชสถานะ cooldown
  const now = Date.now();
  for (const p of proxies) {
    if (p.status === 'cooldown' && now > p.cooldownUntil) {
      p.status = 'active';
      p.failCount = 0;
      logger.info(`✅ Proxy ${p.url} ฟื้นตัวจาก cooldown แล้ว`);
    }
  }
  return proxies;
}
