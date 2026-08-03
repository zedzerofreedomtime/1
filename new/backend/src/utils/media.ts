import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { config } from '../config.js';

const execFileAsync = promisify(execFile);

/**
 * หา path ของ ffprobe จาก FFMPEG_PATH
 * เช่น 'ffmpeg' → 'ffprobe', 'C:\\bin\\ffmpeg.exe' → 'C:\\bin\\ffprobe.exe'
 * (ffprobe ติดมาคู่กับ ffmpeg เสมอ)
 */
export function getFFprobePath(): string {
  const replaced = config.ffmpegPath.replace(
    /ffmpeg(\.exe)?$/i,
    (m) => (m.toLowerCase().endsWith('.exe') ? 'ffprobe.exe' : 'ffprobe')
  );
  return replaced === config.ffmpegPath ? 'ffprobe' : replaced;
}

/**
 * ตรวจว่าไฟล์เป็นวิดีโอที่ใช้งานได้จริง — ต้องมี video stream และความยาว > 0
 *
 * ใช้เช็คคลิปที่โหลดมาจาก Flow ทันทีที่โหลดเสร็จ เพื่อให้พังตั้งแต่ตรงนั้น
 * ไม่ใช่ปล่อยไฟล์เสีย (0 ไบต์ / HTML error page / วิดีโอไม่สมบูรณ์) ไหลไป
 * พังที่ FFmpeg ตอน Phase 5 หลังเสีย credit กับเวลาไปแล้ว
 *
 * @throws ถ้าไฟล์ใช้ไม่ได้ พร้อมบอกเหตุผล
 */
export async function assertValidVideo(filePath: string): Promise<number> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`ไม่พบไฟล์วิดีโอ: ${filePath}`);
  }

  const size = fs.statSync(filePath).size;
  if (size < 1024) {
    throw new Error(`ไฟล์วิดีโอเล็กผิดปกติ (${size} ไบต์) — น่าจะโหลดไม่สมบูรณ์: ${filePath}`);
  }

  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      getFFprobePath(),
      [
        '-v', 'error',
        '-select_streams', 'v:0',
        '-show_entries', 'stream=codec_name:format=duration',
        '-of', 'default=nw=1',
        filePath,
      ],
      { timeout: 30000 }
    ));
  } catch (error: any) {
    throw new Error(
      `ไฟล์วิดีโอเสีย ffprobe อ่านไม่ได้: ${filePath} — ${String(error?.stderr || error?.message).slice(0, 200)}`
    );
  }

  if (!/codec_name=/.test(stdout)) {
    throw new Error(`ไฟล์ไม่มี video stream (อาจไม่ใช่วิดีโอ): ${filePath}`);
  }

  const match = stdout.match(/duration=([\d.]+)/);
  const duration = match ? parseFloat(match[1]) : NaN;
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`วิดีโอความยาวเป็น 0 หรืออ่านไม่ได้: ${filePath}`);
  }

  return duration;
}

/** ตรวจว่าผลรูปจาก Flow เป็นรูปจริงและมีขนาดใช้งานได้ */
export async function assertValidImage(filePath: string): Promise<{ width: number; height: number }> {
  if (!fs.existsSync(filePath)) throw new Error(`ไม่พบไฟล์รูปภาพ: ${filePath}`);
  const size = fs.statSync(filePath).size;
  if (size < 2048) throw new Error(`ไฟล์รูปภาพเล็กผิดปกติ (${size} ไบต์): ${filePath}`);

  try {
    const { stdout } = await execFileAsync(
      getFFprobePath(),
      [
        '-v', 'error',
        '-select_streams', 'v:0',
        '-show_entries', 'stream=codec_type,width,height',
        '-of', 'json',
        filePath,
      ],
      { timeout: 30000 }
    );
    const stream = JSON.parse(stdout)?.streams?.[0];
    const width = Number(stream?.width || 0);
    const height = Number(stream?.height || 0);
    if (stream?.codec_type !== 'video' || width < 256 || height < 256) {
      throw new Error(`ขนาดรูปไม่ถูกต้อง (${width}x${height})`);
    }
    return { width, height };
  } catch (error: any) {
    throw new Error(`ไฟล์รูปจาก Flow ใช้ไม่ได้: ${String(error?.message || error).slice(0, 200)}`);
  }
}

/** อ่านความยาวจริงของไฟล์เสียง/วิดีโอ (วินาที) ด้วย ffprobe */
export async function getMediaDuration(filePath: string): Promise<number> {
  const { stdout } = await execFileAsync(
    getFFprobePath(),
    [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'csv=p=0',
      filePath,
    ],
    { timeout: 30000 }
  );

  const duration = parseFloat(stdout.trim());
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`อ่านความยาวไฟล์ไม่ได้: ${filePath}`);
  }
  return duration;
}

/**
 * ดึงเฟรมแรกของคลิปไว้ตรวจว่า Flow วาดสินค้าตรงกับรูปที่ป้อนเข้าไปหรือเปล่า
 *
 * job #124: โหมดส่วนผสมไม่ได้เอาพิกเซลของรูปตั้งต้นมาขยับ แต่ "วาดสินค้าขึ้นใหม่"
 * โดยใช้รูปที่แนบเป็นแค่ตัวอ้างอิง เฟรมที่ 0 จึงผิดได้ตั้งแต่วินาทีแรก
 * (ฉลาก "บ้านไผ่ รู้ใจคนรักความสะอาด" กลายเป็น "Brapt Cemual", "L 420" เป็น "L x2G")
 * เทียบเฟรมนี้กับรูปอ้างอิงคือวิธีเดียวที่จับได้ก่อนคลิปเสียจะไหลไปถึงวิดีโอจริง
 */
export async function extractFirstFrame(
  videoPath: string,
  outputPath: string
): Promise<string> {
  await assertValidVideo(videoPath);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  try {
    await execFileAsync(
      config.ffmpegPath,
      ['-y', '-i', videoPath, '-frames:v', '1', '-q:v', '2', outputPath],
      { timeout: 30000 }
    );
  } catch (error: any) {
    throw new Error(
      `ดึงเฟรมแรกไม่สำเร็จ: ${String(error?.stderr || error?.message).slice(0, 240)}`
    );
  }

  const size = fs.existsSync(outputPath) ? fs.statSync(outputPath).size : 0;
  if (size < 2048) {
    throw new Error(`เฟรมแรกผิดปกติ (${size} bytes): ${outputPath}`);
  }
  return outputPath;
}

/**
 * Extract the last usable frame for chaining Flow clips. Seeking a fraction
 * before EOF avoids landing after the final decodable frame on some MP4s.
 */
export async function extractLastFrame(
  videoPath: string,
  outputPath: string
): Promise<string> {
  await assertValidVideo(videoPath);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  try {
    await execFileAsync(
      config.ffmpegPath,
      [
        '-y',
        '-sseof', '-0.08',
        '-i', videoPath,
        '-frames:v', '1',
        '-q:v', '2',
        outputPath,
      ],
      { timeout: 30000 }
    );
  } catch (error: any) {
    throw new Error(
      `ดึงเฟรมสุดท้ายไม่สำเร็จ: ${String(error?.stderr || error?.message).slice(0, 240)}`
    );
  }

  const size = fs.existsSync(outputPath) ? fs.statSync(outputPath).size : 0;
  if (size < 2048) {
    throw new Error(`เฟรมสุดท้ายผิดปกติ (${size} bytes): ${outputPath}`);
  }
  return outputPath;
}

/**
 * หมุนไฟล์รูปให้ตั้งตรง — เขียนทับไฟล์เดิม
 *
 * 🐛 job_155 (ผ้ารองรีด Yanuo Xuan): รูปรีวิวต้นฉบับถ่ายมากลับหัว ระบบทำตามอย่างซื่อสัตย์
 * ทั้งเส้นทาง ตัวหนังสือ "IRONING BOARD COVER" จึงกลับหัวตลอด 16 วินาที คลิปใช้ไม่ได้เลย
 *
 * ⚠️ ด่านเทียบสินค้าจับไม่ได้เพราะมันถาม "ตรงต้นฉบับไหม" ซึ่งตรงเป๊ะ — นี่คือ job #122
 * ซ้ำรอย และคำสั่งในพรอมต์ ("Rotate only so the front label reads horizontally, right way up")
 * ก็เอาไม่อยู่ เพราะรูปที่อัปเข้าไปคือความจริงที่โมเดลยึดแน่นกว่าคำสั่ง
 *
 * ทางแก้ที่ได้ผลแน่นอนคือแก้ที่พิกเซลก่อนอัป ไม่ใช่ขอให้โมเดลช่วยหมุนให้
 */
export async function rotateImageUpright(filePath: string, degreesClockwise: number): Promise<boolean> {
  const normalized = ((Math.round(degreesClockwise / 90) * 90) % 360 + 360) % 360;
  if (normalized === 0) return false;
  const filter = normalized === 90 ? 'transpose=1'
    : normalized === 270 ? 'transpose=2'
      : 'transpose=1,transpose=1';
  const rotated = `${filePath}.upright.jpg`;
  await execFileAsync(config.ffmpegPath, ['-y', '-i', filePath, '-vf', filter, '-q:v', '2', rotated]);
  fs.renameSync(rotated, filePath);
  return true;
}
