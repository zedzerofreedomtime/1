const REVIEW_MEDIA_START_ISO = '2025-08-01T00:00:00.000Z';
export const REVIEW_MEDIA_START_EPOCH_SECONDS = Date.parse(REVIEW_MEDIA_START_ISO) / 1000;

export type DatedReviewMedia = {
  url: string;
  type: string;
  reviewTimestamp?: number | string;
  reviewDate?: string;
};

export function mediaEntries(value: unknown): DatedReviewMedia[] {
  if (Array.isArray(value)) return value as DatedReviewMedia[];
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// เจ้าของสั่ง (2026-07-23): เลิกจำกัดวันที่รีวิว — ใช้รูปรีวิว "ทั้งหมด" ที่มี url
// (เดิมจำกัดเฉพาะ ส.ค. 2025 ขึ้นไป ทำให้เหลือสินค้าน้อยเกินจนบอทไม่มีงานทำ)
export function isEligibleReviewMedia(entry: DatedReviewMedia, _nowMs = Date.now()): boolean {
  return Boolean(entry?.url);
}

export function eligibleReviewMediaEntries(value: unknown, nowMs = Date.now()): DatedReviewMedia[] {
  return mediaEntries(value).filter((entry) => isEligibleReviewMedia(entry, nowMs));
}
