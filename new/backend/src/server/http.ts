import fs from 'fs';
import http from 'http';
import path from 'path';

/**
 * CORS headers ที่ "ทุก" response ต้องมี
 *
 * ⚠️ สำคัญมาก: content.js ของ Extension รันบน origin https://labs.google
 * แล้วยิง fetch มาที่ Local Service → เป็น cross-origin เต็มตัว
 * MV3 ไม่ให้ content script ใช้ host_permissions ข้าม CORS ด้วย
 * → ถ้า response ไหนไม่มี header พวกนี้ เบราว์เซอร์บล็อกทันที
 *   แล้ว Extension จะได้ error โล้นๆ ว่า "Failed to fetch" หาสาเหตุไม่เจอ
 *
 * เคยพลาดมาแล้ว: /api/media เขียน header เองโดยลืมใส่ CORS
 * → บอทโหลด Start frame ไม่ได้เลยสักครั้ง (job ตายทุกงาน)
 */
export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Source-Url',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
} as const;

export function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    ...CORS_HEADERS,
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(data));
}

export async function readJson(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  if (chunks.length === 0) return {};
  // ตัด BOM ทิ้งก่อน parse — ผู้ส่งบางตัวเติม BOM มาให้เอง แล้ว JSON.parse
  // จะพังทั้งที่เนื้อ JSON ถูกต้อง (เคยทำให้ /api/mouse/path ตอบ Failed to fetch)
  return JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, ''));
}

export async function readBuffer(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/**
 * ส่งไฟล์เป็น stream พร้อมเลือก Content-Type จากนามสกุล
 *
 * @param fallbackMime ใช้เมื่อไม่รู้จักนามสกุล — แต่ละ route กำหนดเองได้
 *   (/api/media เดาเป็นรูปภาพ เพราะไฟล์ส่วนใหญ่เป็น .jpg ที่ไม่มีนามสกุลกำกับชัด
 *    ส่วนไฟล์ static ทั่วไปใช้ octet-stream ตามมาตรฐาน)
 */
export function streamFile(
  res: http.ServerResponse,
  filePath: string,
  mimeByExtension: Record<string, string>,
  extraHeaders: Record<string, string> = {},
  fallbackMime = 'application/octet-stream'
): void {
  const extension = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    'Content-Type': mimeByExtension[extension] || fallbackMime,
    ...extraHeaders,
  });
  fs.createReadStream(filePath).pipe(res);
}

export type RouteContext = {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  /** id สำหรับผูก log ของ request เดียวกันเข้าด้วยกัน */
  traceId: string;
};

/**
 * คืน true = route นี้จัดการ request แล้ว (ตอบ response ไปเรียบร้อย)
 * คืน false = ไม่ใช่ของ route นี้ ให้ router ลองตัวถัดไป
 *
 * รูปแบบนี้แปลจาก if-chain เดิมแบบตรงตัว ลำดับการลองจึงเหมือนเดิมเป๊ะ
 */
export type RouteHandler = (ctx: RouteContext) => Promise<boolean>;
