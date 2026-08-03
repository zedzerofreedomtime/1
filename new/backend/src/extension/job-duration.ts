import { config } from '../config.js';

const ALLOWED_DURATIONS = new Set([16, 24]);

export function normalizeTargetDuration(value: unknown): 16 | 24 {
  // ล็อกที่ 16 วิเป็นค่าเริ่มต้น — เลือก 24 วิได้เฉพาะเมื่อระบุ 24 ชัดเจนเท่านั้น
  const duration = Number(value);
  return ALLOWED_DURATIONS.has(duration) && duration === 24 ? 24 : 16;
}

export function clipCountForDuration(durationSeconds: unknown): number {
  return normalizeTargetDuration(durationSeconds) / config.videoDurationSeconds;
}
