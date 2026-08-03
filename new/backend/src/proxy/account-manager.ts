import fs from 'fs';
import path from 'path';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

export interface AccountProfile {
  port: number;
  profileDir: string;
  status: 'active' | 'flagged' | 'cooldown' | 'banned';
  proxy: string | null;
  jobsCompleted: number;
  flagCount: number;
  lastFlaggedAt: number | null;
  cooldownUntil: number | null;
  dailyJobCount: number;
  lastDailyReset: string;
}

const ACCOUNTS_FILE = path.join(process.cwd(), 'data', 'accounts.json');
let accounts: AccountProfile[] = [];

/**
 * ดึงวันที่ปัจจุบันแบบ YYYY-MM-DD
 */
function getTodayString(): string {
  return new Date().toISOString().split('T')[0];
}

/**
 * โหลดหรือสร้างข้อมูลบัญชี
 */
export function loadAccounts(): void {
  // ลองโหลดจากไฟล์
  if (fs.existsSync(ACCOUNTS_FILE)) {
    try {
      const data = fs.readFileSync(ACCOUNTS_FILE, 'utf-8');
      accounts = JSON.parse(data) as AccountProfile[];
      logger.info(`✅ โหลดข้อมูล Accounts จำนวน ${accounts.length} รายการจากไฟล์`);
    } catch (error) {
      logger.error(`❌ ไม่สามารถอ่านไฟล์ accounts.json ได้: ${(error as Error).message}`);
    }
  }

  const today = getTodayString();
  const existingPorts = new Set(accounts.map(a => a.port));

  // สร้างบัญชีใหม่สำหรับพอร์ตที่เพิ่งเพิ่มเข้ามา
  for (const port of config.chromeDebugPorts) {
    if (!existingPorts.has(port)) {
      accounts.push({
        port,
        profileDir: path.join(process.cwd(), 'data', `chrome-profile-${port}`),
        status: 'active',
        proxy: null, // จะถูกตั้งตอนเปิด Chrome
        jobsCompleted: 0,
        flagCount: 0,
        lastFlaggedAt: null,
        cooldownUntil: null,
        dailyJobCount: 0,
        lastDailyReset: today
      });
      logger.info(`✅ สร้าง Account Profile สำหรับ Port ${port}`);
    }
  }

  // รีเซ็ตรายวัน
  for (const account of accounts) {
    if (account.lastDailyReset !== today) {
      account.dailyJobCount = 0;
      account.lastDailyReset = today;
      if (account.status === 'banned') {
        // แบนคือเฉพาะของวันนั้นๆ ข้ามวันก็ปลด (ตาม policy ปัจจุบัน)
        account.status = 'active';
        account.flagCount = 0;
      }
    }
  }

  saveAccounts();
}

/**
 * บันทึกข้อมูลบัญชี
 */
export function saveAccounts(): void {
  try {
    const dataDir = path.dirname(ACCOUNTS_FILE);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2), 'utf-8');
  } catch (error) {
    logger.error(`❌ ไม่สามารถบันทึกไฟล์ accounts.json ได้: ${(error as Error).message}`);
  }
}

/**
 * แฟลกว่าบัญชีมีปัญหา
 */
export function flagAccount(port: number, reason: string): void {
  const account = accounts.find(a => a.port === port);
  if (!account) return;

  account.flagCount += 1;
  account.lastFlaggedAt = Date.now();
  
  // คำนวณเวลา cooldown: 2h, 4h, 12h, 24h
  let cooldownDuration = config.accountCooldownBaseMs; // 2 hours
  if (account.flagCount === 2) cooldownDuration = config.accountCooldownBaseMs * 2; // 4h
  else if (account.flagCount === 3) cooldownDuration = config.accountCooldownBaseMs * 6; // 12h
  else if (account.flagCount >= 4) cooldownDuration = config.accountCooldownBaseMs * 12; // 24h

  if (account.flagCount >= 4) {
    account.status = 'banned';
    logger.error(`❌ Account Port ${port} โดนแบนวันนี้เนื่องจากโดน Flag เกินกำหนด (เหตุผล: ${reason})`);
  } else {
    account.status = 'cooldown';
    account.cooldownUntil = Date.now() + cooldownDuration;
    logger.warn(`⚠️ Account Port ${port} ติด Cooldown ${(cooldownDuration / 3600000).toFixed(1)} ชั่วโมง (เหตุผล: ${reason})`);
  }

  saveAccounts();
}

/**
 * ปลดล็อคบัญชี
 */
export function recoverAccount(port: number): void {
  const account = accounts.find(a => a.port === port);
  if (!account) return;

  account.status = 'active';
  account.cooldownUntil = null;
  account.flagCount = 0;
  logger.info(`✅ ปลดล็อค Account Port ${port} กลับมาพร้อมใช้งาน`);
  
  saveAccounts();
}

/**
 * เลือกบัญชีที่พร้อมทำงานมากที่สุด (โหลดงานน้อยสุดและพร้อมใช้)
 */
export function getNextAvailableAccount(): AccountProfile | null {
  const now = Date.now();
  const today = getTodayString();

  // ปลด cooldown
  let changed = false;
  for (const account of accounts) {
    if (account.lastDailyReset !== today) {
      account.dailyJobCount = 0;
      account.lastDailyReset = today;
      if (account.status === 'banned') {
        account.status = 'active';
        account.flagCount = 0;
      }
      changed = true;
    }

    if (account.status === 'cooldown' && account.cooldownUntil && now > account.cooldownUntil) {
      account.status = 'active';
      account.flagCount = 0;
      logger.info(`✅ Account Port ${account.port} พ้นช่วง Cooldown แล้ว`);
      changed = true;
    }
  }
  
  if (changed) saveAccounts();

  const available = accounts.filter(a => a.status === 'active');
  if (available.length === 0) return null;

  // เรียงตามงานที่ทำวันนี้น้อยที่สุด
  available.sort((a, b) => a.dailyJobCount - b.dailyJobCount);
  return available[0];
}

/**
 * บันทึกว่าทำงานสำเร็จ
 */
export function recordJobCompleted(port: number): void {
  const account = accounts.find(a => a.port === port);
  if (!account) return;

  account.jobsCompleted += 1;
  account.dailyJobCount += 1;
  saveAccounts();
}

/**
 * คืนค่าบัญชีทั้งหมด
 */
export function getAllAccounts(): AccountProfile[] {
  return accounts;
}
