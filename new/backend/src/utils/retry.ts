import { sleep } from './delay.js';
import { logger } from './logger.js';

/**
 * error ชั่วคราวที่ลองใหม่แล้วมีโอกาสผ่าน (เน็ตกระตุก / โดน rate limit / ปลายทางล่มชั่วครู่)
 *
 * ประกาศไว้ที่เดียวเพราะเคยมีสำเนาอยู่ใน tts-generator.ts ตัวเดียว แล้วฝั่งที่เรียก Gemini
 * ไม่มีตัวนี้เลย → "fetch failed" ครั้งเดียวทำงานตาย ทั้งที่ยังไม่ได้จ่ายเครดิตอะไรสักบาท
 * (บทเรียนเดียวกับ IN_USE_ACTION_PATTERN ที่เคยประกาศสองที่แล้วเพี้ยนกันจนบทตกทั้งชุด)
 */
const TRANSIENT_NETWORK_ERROR =
  /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket|network|timeout|ws_connect|WebSocket|handshake|50[0234]|429|rate.?limit|temporarily|unavailable|overloaded/i;

export function isTransientNetworkError(error: unknown): boolean {
  const message = error instanceof Error ? `${error.message} ${error.stack || ''}` : String(error);
  return TRANSIENT_NETWORK_ERROR.test(message);
}

interface RetryOptions {
  maxRetries: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffMultiplier?: number;
  retryOn?: (error: any) => boolean;
}

/**
 * ลองทำซ้ำด้วย exponential backoff
 * @param fn ฟังก์ชันที่ต้องการ retry
 * @param options ตัวเลือกการ retry
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions
): Promise<T> {
  const {
    maxRetries,
    initialDelayMs = 1000,
    maxDelayMs = 30000,
    backoffMultiplier = 2,
    retryOn,
  } = options;

  let lastError: any;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // ตรวจสอบว่าควร retry ไหม
      if (retryOn && !retryOn(error)) {
        throw error;
      }

      if (attempt === maxRetries) {
        logger.error(
          `❌ ล้มเหลวหลังลองใหม่ ${maxRetries} ครั้ง:`,
          error
        );
        throw error;
      }

      const delay = Math.min(
        initialDelayMs * Math.pow(backoffMultiplier, attempt),
        maxDelayMs
      );

      logger.warn(
        `⚠️ ลองใหม่ครั้งที่ ${attempt + 1}/${maxRetries} — รอ ${Math.round(delay / 1000)}s`
      );
      await sleep(delay);
    }
  }

  throw lastError;
}
