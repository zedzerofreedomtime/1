import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { randomInt } from '../utils/delay.js';
import { assertValidVideo, getMediaDuration, getFFprobePath } from '../utils/media.js';

const execFileAsync = promisify(execFile);

/** หางท้ายคลิป — กันไม่ให้ตัดจบทันทีที่พูดคำสุดท้ายจบ (วินาที) */

/**
 * ต่อคลิปวิดีโอ + เสียงพากย์ + ซับไตเติ้ล + เพลง background ด้วย FFmpeg
 *
 * Pipeline:
 * 1. ต่อ 3 คลิปเข้าด้วยกัน (concat)
 * 2. เพิ่มเสียงพากย์ (TTS audio)
 * 3. เพิ่มซับไตเติ้ลภาษาไทย (burn-in subtitles)
 * 4. เพิ่มเพลง background (volume ต่ำ)
 * 5. Output: วิดีโอพร้อมลง
 */
export async function assembleVideo(options: {
  clipPaths: string[];       // 3 คลิปจาก Flow
  ttsAudioPath: string;      // เสียงพากย์
  subtitlePath: string;      // ไฟล์ .srt
  bgmPath?: string;          // เพลง background (optional)
  outputPath: string;        // ไฟล์ output
  workerId: number;
  /**
   * แผนตัดต่อจาก Gemini (optional)
   *
   * ถ้าไม่ส่งมา = ต่อทุกคลิปเต็มๆ ตามลำดับแล้วตัดหางตามความยาวเสียง
   * ซึ่งทำให้ฟุตเทจที่จ่ายเงินไปหายฟรี และช็อตปิดการขายอาจโดนตัดทิ้ง
   * ถ้าส่งมา = ตัดเฉพาะช่วงที่ Gemini เลือก เรียงตามที่มันสั่ง
   */
}): Promise<string> {
  const { clipPaths, ttsAudioPath, subtitlePath, outputPath, workerId } = options;
  const log = (msg: string) => logger.info(msg, { worker: workerId });

  // สร้างโฟลเดอร์ output
  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // === Step 1: Normalize ทุกคลิปให้พารามิเตอร์ตรงกัน ===
  //
  // จำเป็นมาก! concat demuxer + '-c copy' ต่อคลิปได้ "เฉพาะตอนที่ทุกคลิปมี
  // resolution / fps / codec / pixel format / timebase ตรงกันเป๊ะ" เท่านั้น
  // ถ้าไม่ตรง FFmpeg จะไม่ error แต่คืนไฟล์ภาพเพี้ยน/กระตุก/ตัดกลางแบบเงียบๆ
  // คลิปจาก Flow ไม่มีอะไรการันตีว่าจะตรงกัน → ต้อง re-encode ให้ตรงก่อน
  //
  // ตัดเสียงของคลิปทิ้งด้วย (-an) เพราะเดี๋ยวใช้เสียงพากย์แทนอยู่แล้ว
  // และช่วยกำจัดสาเหตุ mismatch ฝั่ง audio stream ไปในตัว
  // แปลงแผนของ Gemini เป็นรายการช่วงที่จะตัด — ถ้าไม่มีแผนก็ใช้ทุกคลิปเต็มๆ ตามลำดับ
  const cuts = clipPaths.map((p) => ({
    path: p,
    start: null as number | null,
    end: null as number | null,
  }));

  const normalizedPaths: string[] = [];
  log(`🔧 Normalize และเรียง ${clipPaths.length} คลิปแบบ 1→2→3 → ${config.videoWidth}x${config.videoHeight} @ ${config.videoFps}fps...`);

  for (let i = 0; i < cuts.length; i++) {
    const cut = cuts[i];
    const normPath = outputPath.replace(/\.\w+$/, `_norm_${i + 1}.mp4`);

    // -ss/-to ต้องอยู่ "ก่อน -i" เพื่อให้ seek เร็ว และตัดตรงจุดจริง
    const trimArgs: string[] = [];
    if (cut.start !== null) trimArgs.push('-ss', String(cut.start));
    if (cut.end !== null) trimArgs.push('-to', String(cut.end));

    // เก็บเสียงบรรยากาศของคลิปไว้ (Veo ใส่ foley มาให้: เสียงช้อน เสียงห้อง)
    // ถ้าคลิปไหนไม่มีเสียง ต้องยัดเสียงเงียบเข้าไปแทน ไม่งั้นตอน concat
    // จำนวน stream จะไม่เท่ากันแล้วพัง
    const hasAudio = await hasAudioStream(cut.path);
    const silenceArgs = hasAudio
      ? []
      : ['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo'];

    await runFFmpeg([
      ...trimArgs,
      '-i', cut.path,
      ...silenceArgs,
      '-map', '0:v:0',
      '-map', hasAudio ? '0:a:0' : '1:a:0',
      '-vf',
      `scale=${config.videoWidth}:${config.videoHeight}:force_original_aspect_ratio=decrease,` +
        `pad=${config.videoWidth}:${config.videoHeight}:(ow-iw)/2:(oh-ih)/2:black,` +
        `fps=${config.videoFps},setsar=1`,
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', '23',
      '-pix_fmt', 'yuv420p',
      '-video_track_timescale', '90000',
      '-c:a', 'aac',
      '-ar', '44100',
      '-ac', '2',
      '-b:a', '128k',
      ...(hasAudio ? [] : ['-shortest']),
      '-y',
      normPath,
    ]);
    normalizedPaths.push(normPath);
  }

  // === Step 2: สร้าง concat list ===
  const concatListPath = outputPath.replace(/\.\w+$/, '_concat.txt');
  const concatContent = normalizedPaths
    .map((p) => `file '${path.resolve(p).replace(/\\/g, '/')}'`)
    .join('\n');
  fs.writeFileSync(concatListPath, concatContent, 'utf-8');

  // === Step 3: ต่อคลิป (ตอนนี้ '-c copy' ปลอดภัยแล้วเพราะทุกคลิปสเปคตรงกัน) ===
  const concatOutputPath = outputPath.replace(/\.\w+$/, '_concat.mp4');
  log('🔗 ต่อคลิป...');

  await runFFmpeg([
    '-f', 'concat',
    '-safe', '0',
    '-i', concatListPath,
    '-c', 'copy',
    '-y',
    concatOutputPath,
  ]);

  // === Step 3: หาเพลง background ===
  const bgmPath = options.bgmPath || getRandomBGM();

  // === Step 4: คำนวณความยาวคลิปสุดท้าย ===
  //
  // ความยาว final ยึดคลิป 1→2→3 เต็มทุกเฟรม เสียงพากย์ถูกจัดช่องเวลา
  // ให้ตรงแต่ละคลิปตั้งแต่ขั้น TTS แล้ว ด่านนี้ปฏิเสธเสียงที่ยังยาวผิดปกติ
  const videoDuration = await getMediaDuration(concatOutputPath);
  const audioDuration = await getMediaDuration(ttsAudioPath);
  const targetDuration = Math.round(videoDuration * 1000) / 1000;

  // ห้ามตัดเสียงกลางประโยคแบบเงียบ ๆ อีก ถ้าบทยังยาวเกินให้หยุดพร้อมสาเหตุ
  // ก่อนสร้างไฟล์ final เพื่อให้แก้บท/สร้างเสียงใหม่ได้โดยไม่ทำไฟล์เสียออกมา
  if (audioDuration > videoDuration + 0.35) {
    safeDelete(concatListPath);
    safeDelete(concatOutputPath);
    normalizedPaths.forEach(safeDelete);
    throw new Error(
      `เสียงพากย์ยาวกว่าวิดีโอ (${audioDuration.toFixed(1)}s > ${videoDuration.toFixed(1)}s) — ปฏิเสธการตัดเสียงกลางประโยค`
    );
  }

  log(
    `⏱️ คลิป 1→2→3 ${videoDuration.toFixed(1)}s | เสียงพากย์ ${audioDuration.toFixed(1)}s → ไฟล์สุดท้าย ${targetDuration.toFixed(1)}s`
  );

  // === Step 5: รวมทุกอย่าง ===
  log('🎬 รวม: วิดีโอ + เสียงพากย์ + ซับ + เพลง...');

  // เตรียม FFmpeg filter complex
  const subtitlePathEscaped = path.resolve(subtitlePath)
    .replace(/\\/g, '/')
    .replace(/:/g, '\\:');

  const inputArgs: string[] = [];

  // input 0: วิดีโอที่ต่อแล้วเต็มลำดับ 1→2→3
  inputArgs.push('-i', concatOutputPath);

  // input 1: เสียงพากย์
  inputArgs.push('-i', ttsAudioPath);

  // ── ผสมเสียง 3 ชั้น + ดันความดังให้ได้มาตรฐาน ──
  //
  // [0:a] = เสียงบรรยากาศจากคลิป Veo (foley) — ทำให้ฟังเหมือนถ่ายจริง ไม่ใช่ TTS ลอยๆ
  // [1:a] = เสียงพากย์ (ตัวเอก)
  // [2:a] = เพลง background (ถ้ามี)
  //
  // amix ใส่ normalize=0 เพราะค่าเริ่มต้นมันจะหารความดังด้วยจำนวน input
  // (ผสม 3 ทาง = เสียงเบาลง 3 เท่า!) แล้วปิดท้ายด้วย loudnorm ดันขึ้น target ทีเดียว
  //
  // loudnorm จำเป็นมาก: ของเดิมวัดได้ -18.5 LUFS แต่ TikTok ใช้ราว -14
  // → คลิปเราเบากว่าคนอื่นชัดเจนตอนเลื่อนฟีดผ่าน
  const loudnorm = `loudnorm=I=${config.targetLufs}:TP=-1.5:LRA=11`;
  const ambience = `[0:a]aresample=44100,volume=${config.ambienceVolume}[amb]`;
  let audioMix: string;

  if (bgmPath && fs.existsSync(bgmPath)) {
    // input 2: เพลง background — วนซ้ำให้คลุมทั้งคลิป
    inputArgs.push('-stream_loop', '-1', '-i', bgmPath);
    audioMix =
      `${ambience};[1:a]aresample=44100,apad=whole_dur=${targetDuration},atrim=0:${targetDuration}[tts];[2:a]aresample=44100,volume=${config.bgmVolume}[bgm];` +
      `[tts][amb][bgm]amix=inputs=3:duration=first:dropout_transition=2:normalize=0,${loudnorm},aresample=44100[aout]`;
    log(`🔊 ผสม: พากย์ + บรรยากาศ Veo (${config.ambienceVolume}) + เพลง (${config.bgmVolume}) → ${config.targetLufs} LUFS`);
  } else {
    audioMix =
      `${ambience};[1:a]aresample=44100,apad=whole_dur=${targetDuration},atrim=0:${targetDuration}[tts];` +
      `[tts][amb]amix=inputs=2:duration=first:dropout_transition=2:normalize=0,${loudnorm},aresample=44100[aout]`;
    log(`🔊 ผสม: พากย์ + บรรยากาศ Veo (${config.ambienceVolume}) → ${config.targetLufs} LUFS (ไม่มีเพลง BGM)`);
  }

  // ซับไตเติ้ล — เบิร์นลงวิดีโอเฉพาะเมื่อเปิดใช้เท่านั้น
  //
  // ค่าเริ่มต้นคือ "ไม่เบิร์น" เพราะบทที่ Gemini เขียนมีไว้เป็นเสียงพากย์
  // การเอาข้อความเดียวกันมาแปะทับจอด้วยจะบังสินค้าและดูรก
  // (ไฟล์ .srt ยังถูกสร้างและเก็บไว้เสมอ เผื่อเอาไปใช้ตอนโพสต์)
  let videoChain: string;
  if (config.subtitleBurnIn) {
    const subtitleFilter = `subtitles='${subtitlePathEscaped}':force_style='FontSize=${config.subtitleFontsize},FontName=${config.subtitleFont},PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=3,Outline=2,Shadow=1,MarginV=30'`;
    videoChain = `[0:v]${subtitleFilter}[vout]`;
    log('📝 เบิร์นซับลงคลิป (SUBTITLE_BURN_IN=true)');
  } else {
    videoChain = '[0:v]null[vout]';
    log('🔇 ไม่เบิร์นซับ — ใช้เสียงพากย์อย่างเดียว (ตั้ง SUBTITLE_BURN_IN=true ถ้าอยากได้ซับ)');
  }

  await runFFmpeg([
    ...inputArgs,
    '-filter_complex', `${audioMix};${videoChain}`,
    '-map', '[vout]',
    '-map', '[aout]',
    '-c:v', 'libx264',
    '-preset', 'fast',
    '-crf', '23',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ar', '44100',
    '-t', String(targetDuration),
    '-y',
    outputPath,
  ]);

  // Cleanup temp files
  safeDelete(concatListPath);
  safeDelete(concatOutputPath);
  normalizedPaths.forEach(safeDelete);

  // === Step สุดท้าย (optional): ทำวิดีโอให้ลื่น + คมขึ้น ===
  //
  // interpolate เฟรม 24→60fps แบบ motion-compensated (สร้างเฟรมกลางจากการวิเคราะห์
  // การเคลื่อนไหว) + upscale เป็น 1080p — ให้ใกล้ความลื่นของคลิปอ้างอิงที่เจ้าของส่งมา
  // ทำ interpolate ก่อน scale (ที่ res เดิม 720) แล้วค่อย upscale → เร็วกว่าสลับลำดับ
  // แยกเป็น pass ที่ 2 (ไม่ยุ่งกับ filtergraph ประกอบที่พิสูจน์แล้ว) audio copy ตรงๆ
  // ⚠️ minterpolate ช้ามาก — เพิ่มเวลา ~2-3 นาที/คลิป (ปิดด้วย OUTPUT_SMOOTH=false)
  if (config.outputSmooth && fs.existsSync(outputPath)) {
    const smoothTemp = outputPath.replace(/\.mp4$/i, '.smooth.mp4');
    const smoothVf = `minterpolate=fps=${config.outputFps}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1,`
      + `scale=${config.outputWidth}:${config.outputHeight}:flags=lanczos`;
    log(`🎞️ ทำวิดีโอให้ลื่น: ${config.videoFps}→${config.outputFps}fps + upscale ${config.outputWidth}x${config.outputHeight} (ช้า ~2-3 นาที)`);
    try {
      await runFFmpeg([
        '-i', outputPath,
        '-vf', smoothVf,
        '-c:v', 'libx264', '-preset', config.outputSmoothPreset, '-crf', '18',
        '-c:a', 'copy',
        '-y', smoothTemp,
      ], config.outputSmoothTimeoutMs);
      await assertValidVideo(smoothTemp);
      safeDelete(outputPath);
      fs.renameSync(smoothTemp, outputPath);
      log(`✅ ทำวิดีโอให้ลื่นสำเร็จ (${config.outputFps}fps ${config.outputWidth}x${config.outputHeight})`);
    } catch (error: unknown) {
      // ถ้า interpolate ล้ม อย่าทำให้ทั้ง job พัง — ใช้ไฟล์ 24fps เดิมที่ประกอบสำเร็จแล้ว
      safeDelete(smoothTemp);
      logger.warn(
        `⚠️ ทำวิดีโอให้ลื่นล้มเหลว — ใช้ไฟล์ ${config.videoFps}fps เดิมแทน: ${String(error instanceof Error ? error.message : error).slice(0, 120)}`,
        { worker: workerId }
      );
    }
  }

  // === Step สุดท้ายทางเลือกที่ 2: upscale 1080x1920 แบบเร็ว (ไม่สร้างเฟรมกลาง) ===
  //
  // รีวิว job_96 ขอไฟล์ปลายทาง 1080x1920 / 30fps / 6-10 Mbps แต่ minterpolate ด้านบน
  // ใช้เวลา 5-6 นาทีต่อคลิป ซึ่งเจ้าของเคยสั่งว่า "ถ้ามันนานไปก็ไม่ต้องทำ"
  // ขั้นนี้จึงทำแค่ scale + ตั้ง bitrate ให้ตรงสเปก ใช้เวลาราว 10-20 วินาที
  // ข้ามทันทีถ้า outputSmooth ทำงานสำเร็จไปแล้ว (มันทำ upscale ให้ในตัว)
  if (config.outputUpscale && !config.outputSmooth && fs.existsSync(outputPath)) {
    const upscaleTemp = outputPath.replace(/\.mp4$/i, '.up.mp4');
    // เปลี่ยน fps ตรงนี้ได้เฉพาะตอนที่ "หารลงตัว" เท่านั้น ไม่งั้นได้เฟรมซ้ำเป็นจังหวะ = ภาพกระตุก
    // (job_99: 24→30 ก็อปเฟรมทุก 4 เฟรม) ค่าเริ่มต้น 0 = ไม่แตะเฟรมเรตเลย
    const fpsFilter = config.outputUpscaleFps > 0 && config.outputUpscaleFps !== config.videoFps
      ? `,fps=${config.outputUpscaleFps}`
      : '';
    if (fpsFilter && config.outputUpscaleFps % config.videoFps !== 0) {
      logger.warn(
        `⚠️ OUTPUT_UPSCALE_FPS=${config.outputUpscaleFps} หารกับต้นทาง ${config.videoFps}fps ไม่ลงตัว — จะเกิดเฟรมซ้ำและภาพกระตุก`,
        { worker: workerId }
      );
    }
    log(`⬆️ Upscale เป็น ${config.outputWidth}x${config.outputHeight}${fpsFilter ? ` @ ${config.outputUpscaleFps}fps` : ` (คงที่ ${config.videoFps}fps)`}`);
    try {
      await runFFmpeg([
        '-i', outputPath,
        '-vf', `scale=${config.outputWidth}:${config.outputHeight}:flags=lanczos${fpsFilter}`,
        '-c:v', 'libx264', '-preset', 'medium', '-crf', String(config.outputUpscaleCrf),
        '-maxrate', config.outputUpscaleMaxrate, '-bufsize', '20M',
        '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
        '-c:a', 'copy',
        '-y', upscaleTemp,
      ]);
      await assertValidVideo(upscaleTemp);
      safeDelete(outputPath);
      fs.renameSync(upscaleTemp, outputPath);
      log(`✅ Upscale สำเร็จ (${config.outputWidth}x${config.outputHeight} @ ${config.outputUpscaleFps > 0 ? config.outputUpscaleFps : config.videoFps}fps)`);
    } catch (error: unknown) {
      // upscale เป็นของแถม ห้ามทำให้งานที่ประกอบสำเร็จแล้วพัง — ใช้ไฟล์ 720p เดิมต่อ
      safeDelete(upscaleTemp);
      logger.warn(
        `⚠️ Upscale ล้มเหลว — ใช้ไฟล์ ${config.videoWidth}x${config.videoHeight} เดิมแทน: ${String(error instanceof Error ? error.message : error).slice(0, 120)}`,
        { worker: workerId }
      );
    }
  }

  // ตรวจสอบ output
  if (!fs.existsSync(outputPath)) {
    throw new Error(`FFmpeg ไม่ได้สร้างไฟล์: ${outputPath}`);
  }
  // A zero-exit FFmpeg process is not enough to mark a paid job completed.
  // Verify that the final artifact is readable, non-trivial, has a video stream,
  // and has a positive duration before the repository stores completed status.
  await assertValidVideo(outputPath);

  const fileSize = fs.statSync(outputPath).size;
  log(`✅ วิดีโอพร้อมลง: ${outputPath} (${(fileSize / 1024 / 1024).toFixed(1)} MB)`);

  return outputPath;
}

/**
 * สุ่มเลือกเพลง background จากโฟลเดอร์ BGM
 */
function getRandomBGM(): string | null {
  if (!fs.existsSync(config.bgmDir)) {
    fs.mkdirSync(config.bgmDir, { recursive: true });
    logger.warn(`📁 สร้างโฟลเดอร์ BGM: ${config.bgmDir} — ใส่ไฟล์เพลง .mp3/.wav ลงในนี้`);
    return null;
  }

  const files = fs
    .readdirSync(config.bgmDir)
    .filter((f) => /\.(mp3|wav|m4a|ogg|aac)$/i.test(f));

  if (files.length === 0) {
    logger.warn('⚠️ ไม่มีเพลงใน BGM folder — ใส่ไฟล์ .mp3/.wav ลง ' + config.bgmDir);
    return null;
  }

  const picked = files[randomInt(0, files.length - 1)];
  logger.info(`🎵 เพลง BGM: ${picked}`);
  return path.join(config.bgmDir, picked);
}

/**
 * เรียก FFmpeg
 */
async function runFFmpeg(args: string[], timeoutMs = 300000): Promise<void> {
  try {
    const { stderr } = await execFileAsync(config.ffmpegPath, args, {
      timeout: timeoutMs, // ค่าเริ่มต้น 5 นาที; smooth pass (minterpolate 1080p) ต้องนานกว่า
      maxBuffer: 10 * 1024 * 1024,
    });

    if (stderr && stderr.includes('Error')) {
      logger.debug(`FFmpeg stderr: ${stderr.substring(0, 500)}`);
    }
  } catch (error: any) {
    if (error?.message?.includes('ENOENT')) {
      logger.error('❌ ไม่พบ FFmpeg — ต้องติดตั้งก่อน:');
      logger.error('   https://ffmpeg.org/download.html');
      logger.error('   หรือ: winget install ffmpeg');
    }
    throw new Error(`FFmpeg error: ${error?.stderr || error?.message}`);
  }
}

/** คลิปนี้มี audio stream ไหม — ต้องรู้ก่อน normalize ไม่งั้น concat พัง */
async function hasAudioStream(filePath: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      getFFprobePath(),
      ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', filePath],
      { timeout: 30000 }
    );
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/** ลบไฟล์แบบ safe (ไม่ throw ถ้าลบไม่ได้) */
function safeDelete(filepath: string): void {
  try {
    if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
  } catch {
    // ไม่เป็นไร
  }
}
