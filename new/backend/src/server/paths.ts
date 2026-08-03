import path from 'path';
import { fileURLToPath } from 'url';
import { config } from '../config.js';

/** backend/src/server/ → ขึ้นสามชั้นถึงรากโปรเจกต์ (server → src → backend → new) */
export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** ผลลัพธ์ build ของ frontend ที่ server เสิร์ฟเป็นไฟล์ static */
export const webDist = path.join(root, 'frontend', 'dist');

/** ไฟล์ของ Chrome Extension — เปิดดูผ่านเบราว์เซอร์ได้เวลาต้อง debug */
export const extensionRoot = path.join(root, 'extension');

/** โฟลเดอร์สื่อที่ /api/media ยอมเสิร์ฟ (กันอ่านไฟล์นอกขอบเขต) */
export const outputRoot = path.resolve(root, config.outputDir);

/** ไฟล์คำสั่งรีโมตแบบ one-shot ที่ Extension มารับตอน heartbeat */
export const remoteCommandFile = path.join(root, 'data', 'remote-command.json');

export const port = Number(process.env.WEB_PORT || 8110);

/**
 * เวอร์ชัน Extension ที่ระบบยอมรับ ณ ตอนนี้
 *
 * Chrome เปิด unpacked หลายชุดพร้อมกันได้ ถ้าไม่กันไว้ ชุดเก่าจะแย่งงาน
 * และแย่ง "คำสั่งรีโมต" ไปจากชุดที่ใช้จริง จนไล่บั๊กไม่เจอ
 */
export const ACTIVE_EXTENSION_VERSION = '2.8.4';
