import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/**
 * สถานะล่าสุดของ Extension ที่ฝั่ง service เก็บไว้
 *
 * เก็บเป็นไฟล์ (ไม่ใช่ในหน่วยความจำ) เพราะ service restart บ่อยเวลา deploy
 * แล้วหน้าเว็บกับ watchdog ต้องยังรู้ว่าบอทกำลังทำงานอยู่หรือไม่
 */
export type ExtensionRuntime = {
  connected: boolean;
  running: boolean;
  creditLocked: boolean;
  status: string;
  currentJobId: number | null;
  updatedAt: string;
  /** เวอร์ชันที่ Chrome โหลดอยู่จริง — ใช้ยืนยันว่า reload ติดแล้ว */
  version: string;
};

// backend/src/extension/ → ขึ้นสามชั้นถึงรากโปรเจกต์ (extension → src → backend → new)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const statePath = path.join(root, 'data', 'extension-state.json');

const defaultState: ExtensionRuntime = {
  connected: false,
  running: false,
  creditLocked: true,
  status: 'รอการเชื่อมต่อจาก Extension',
  currentJobId: null,
  updatedAt: new Date(0).toISOString(),
  version: '?',
};

export function readExtensionRuntime(): ExtensionRuntime {
  try {
    const state = { ...defaultState, ...JSON.parse(fs.readFileSync(statePath, 'utf8')) };
    // heartbeat เงียบเกิน 30 วิ = ถือว่าหลุด ไม่ใช่แค่ค่าเก่าค้างในไฟล์
    const fresh = Date.now() - new Date(state.updatedAt).getTime() < 30_000;
    return { ...state, connected: fresh };
  } catch {
    return defaultState;
  }
}

export function writeExtensionRuntime(input: Partial<ExtensionRuntime>): ExtensionRuntime {
  const state = {
    ...readExtensionRuntime(),
    ...input,
    connected: true,
    updatedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
  return state;
}
