import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { config } from '../src/config.js';
import { logger } from '../src/utils/logger.js';
import { loadProxies, getProxyForPort } from '../src/proxy/proxy-manager.js';
import { loadAccounts } from '../src/proxy/account-manager.js';

/**
 * เปิด Chrome หลาย instances พร้อม Remote Debugging Port
 *
 * ใช้ user-data-dir แยกกัน เพื่อให้แต่ละ Chrome login คนละบัญชีได้
 * ครั้งแรก: ต้อง login Google ด้วยมือในแต่ละ Chrome
 * หลังจากนั้น: session จะถูกเก็บไว้ใน user-data-dir อัตโนมัติ
 */
async function main(): Promise<void> {
  const chromeExe = config.chromeExecutable;
  const ports = config.chromeDebugPorts;

  // ตรวจสอบว่า Chrome มีอยู่
  if (!fs.existsSync(chromeExe)) {
    logger.error(`❌ ไม่พบ Chrome ที่ path: ${chromeExe}`);
    logger.info('💡 ตรวจสอบ CHROME_EXECUTABLE ใน .env');
    logger.info('💡 ปกติอยู่ที่: C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
    process.exit(1);
  }

  // Load proxy and account data
  loadProxies();
  loadAccounts();

  logger.info(`🖥️ กำลังเปิด ${ports.length} Chrome instances...`);
  logger.info(`📂 Chrome: ${chromeExe}`);

  for (const port of ports) {
    const userDataDir = path.join(
      'C:\\clipbot-chrome',
      `profile-${port}`
    );

    // สร้าง user data dir ถ้ายังไม่มี
    if (!fs.existsSync(userDataDir)) {
      fs.mkdirSync(userDataDir, { recursive: true });
    }

    const args = [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
    ];

    const proxy = getProxyForPort(port);
    if (proxy) {
      args.push(`--proxy-server=${proxy}`);
      logger.info(`🔗 ใช้ Proxy: ${proxy} สำหรับ Port ${port}`);
    }

    args.push(config.flowUrl);

    try {
      const child = spawn(chromeExe, args, {
        detached: true,
        stdio: 'ignore',
      });

      child.unref();

      logger.info(
        `✅ Chrome เปิดแล้ว — port ${port} | profile: profile-${port}`
      );
    } catch (error) {
      logger.error(`❌ เปิด Chrome port ${port} ไม่ได้:`, error);
    }
  }

  logger.info('');
  logger.info('══════════════════════════════════════════════');
  logger.info('📌 สิ่งที่ต้องทำ:');
  logger.info('  1. Login Google ในแต่ละ Chrome window');
  logger.info('  2. ไปที่ Google Flow แล้วยืนยัน Terms (ถ้ามี)');
  logger.info('  3. ลองสร้างรูป/วิดีโอด้วยมือ 1 ครั้ง เพื่อยืนยัน');
  logger.info('  4. ปล่อย Chrome เปิดไว้ แล้วรัน: npm run start');
  logger.info('══════════════════════════════════════════════');
  logger.info('');
  logger.info(`💡 ทดสอบการเชื่อมต่อ: npm run test-connection`);
}

main().catch((error) => {
  logger.error('💥 Error:', error);
  process.exit(1);
});
