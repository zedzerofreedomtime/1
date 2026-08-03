/**
 * mouse-math.js — ไลบรารีคำนวณเส้นทางเมาส์แบบมนุษย์
 *
 * ใช้ร่วมกับ content.js เพื่อสร้างการเคลื่อนที่ที่สมจริง:
 *   • Cubic Bezier curve path (ไม่ใช่เส้นตรง)
 *   • Easing functions หลายแบบ
 *   • Micro-jitter (มือสั่นเล็กน้อย)
 *   • Variable speed profile (เร่ง-เร็ว-ชะลอ)
 *   • Overshoot & correction (เลยเป้าแล้ววกกลับ)
 *   • Random target offset (ไม่คลิกตรงกลางเป๊ะ)
 */

// ╔═══════════════════════════════════════════════════════════╗
// ║  Easing Functions                                         ║
// ╚═══════════════════════════════════════════════════════════╝

function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }
function easeOutQuint(t) { return 1 - Math.pow(1 - t, 5); }
function easeInOutSine(t) { return -(Math.cos(Math.PI * t) - 1) / 2; }
function easeOutExpo(t) { return t >= 1 ? 1 : 1 - Math.pow(2, -10 * t); }
function easeOutBounce(t) {
  if (t < 1 / 2.75) return 7.5625 * t * t;
  if (t < 2 / 2.75) { t -= 1.5 / 2.75; return 7.5625 * t * t + 0.75; }
  if (t < 2.5 / 2.75) { t -= 2.25 / 2.75; return 7.5625 * t * t + 0.9375; }
  t -= 2.625 / 2.75; return 7.5625 * t * t + 0.984375;
}

const EASING_FUNCTIONS = [easeOutCubic, easeOutQuint, easeInOutSine, easeOutExpo];

// ╔═══════════════════════════════════════════════════════════╗
// ║  Smooth Noise — Perlin-like continuous jitter              ║
// ╚═══════════════════════════════════════════════════════════╝

/**
 * สร้าง noise generator ที่ให้ค่าต่อเนื่อง (ไม่กระโดด)
 * ใช้ interpolation ระหว่างจุดสุ่ม — ได้คลื่นเนียนกว่า random.choice
 */
function createNoiseGenerator(seed) {
  // สร้างจุดควบคุมสุ่ม 16 จุด
  const anchors = [];
  let s = seed || (Math.random() * 1000) | 0;
  for (let i = 0; i < 16; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    anchors.push(((s / 0x7fffffff) - 0.5) * 2); // -1 ถึง 1
  }

  return function smoothNoise(stepIndex, scale, amplitude) {
    scale = scale || 0.15;
    amplitude = amplitude || 1.5;
    const t = stepIndex * scale;
    const index = Math.floor(t) % anchors.length;
    const nextIndex = (index + 1) % anchors.length;
    const frac = t - Math.floor(t);
    // Smoothstep interpolation
    const smooth = frac * frac * (3 - 2 * frac);
    const value = anchors[index] * (1 - smooth) + anchors[nextIndex] * smooth;
    return Math.round(value * amplitude);
  };
}

// ╔═══════════════════════════════════════════════════════════╗
// ║  Bezier Curve Path Generation                             ║
// ╚═══════════════════════════════════════════════════════════╝

/**
 * คำนวณจุดบน Cubic Bezier curve
 * P(t) = (1-t)³P₀ + 3(1-t)²tP₁ + 3(1-t)t²P₂ + t³P₃
 */
function cubicBezier(t, p0x, p0y, p1x, p1y, p2x, p2y, p3x, p3y) {
  const u = 1 - t;
  const tt = t * t;
  const uu = u * u;
  const uuu = uu * u;
  const ttt = tt * t;
  return {
    x: uuu * p0x + 3 * uu * t * p1x + 3 * u * tt * p2x + ttt * p3x,
    y: uuu * p0y + 3 * uu * t * p1y + 3 * u * tt * p2y + ttt * p3y,
  };
}

/**
 * สร้างเส้นทาง Bezier จากจุดเริ่มต้นไปยังเป้าหมาย
 *
 * @param {number} startX - พิกัด X เริ่มต้น
 * @param {number} startY - พิกัด Y เริ่มต้น
 * @param {number} endX   - พิกัด X ปลายทาง
 * @param {number} endY   - พิกัด Y ปลายทาง
 * @returns {Array<{x: number, y: number, delay: number}>} - ลำดับจุดพร้อม delay
 */
function generateBezierPath(startX, startY, endX, endY) {
  const dx = endX - startX;
  const dy = endY - startY;
  const distance = Math.sqrt(dx * dx + dy * dy);

  // จำนวน step ขึ้นกับระยะทาง (ไกล = step เยอะ)
  const numSteps = Math.max(18, Math.min(60, Math.round(distance / 8)));

  // จุดควบคุม Bezier 2 จุด — สุ่มเยื้องจากเส้นตรงเล็กน้อย
  const perpX = -dy / (distance || 1);  // ตั้งฉากกับทิศทาง
  const perpY = dx / (distance || 1);
  const curve1 = (Math.random() - 0.5) * distance * 0.3;
  const curve2 = (Math.random() - 0.5) * distance * 0.2;

  const p1x = startX + dx * 0.3 + perpX * curve1;
  const p1y = startY + dy * 0.3 + perpY * curve1;
  const p2x = startX + dx * 0.7 + perpX * curve2;
  const p2y = startY + dy * 0.7 + perpY * curve2;

  // สุ่ม easing function
  const easing = EASING_FUNCTIONS[Math.floor(Math.random() * EASING_FUNCTIONS.length)];

  // สร้าง noise generator สำหรับ micro-jitter
  const noise = createNoiseGenerator();

  // Overshoot — เลยเป้า 3-8px แล้ววกกลับ
  const overshootPx = 3 + Math.random() * 5;
  const overshootRatio = 1 + (overshootPx / (distance || 1));

  // ตำแหน่งสำหรับ micro-pause (สุ่ม 1-2 จุดในช่วง 30-70% ของเส้นทาง)
  const pauseCount = 1 + Math.floor(Math.random() * 2);
  const pausePositions = [];
  for (let i = 0; i < pauseCount; i++) {
    pausePositions.push(0.3 + Math.random() * 0.4);
  }

  const points = [];

  for (let i = 1; i <= numSteps; i++) {
    const rawT = i / numSteps;
    const easedT = easing(rawT);

    // ใช้ overshoot ratio สำหรับ 90% แรกของเส้นทาง จากนั้นวกกลับ
    let effectiveT;
    if (rawT <= 0.9) {
      effectiveT = easedT * overshootRatio;
    } else {
      // ช่วงสุดท้าย: วกกลับจาก overshoot ไปยังเป้าหมายจริง
      const returnProgress = (rawT - 0.9) / 0.1; // 0→1 ใน 10% สุดท้าย
      const overshootEased = easing(0.9) * overshootRatio;
      effectiveT = overshootEased + (1 - overshootEased) * easeOutCubic(returnProgress);
    }

    const point = cubicBezier(
      Math.min(effectiveT, 1.05), // clamp เผื่อ overshoot
      startX, startY, p1x, p1y, p2x, p2y, endX, endY
    );

    // เพิ่ม micro-jitter
    const jitterX = noise(i, 0.2, 1);
    const jitterY = noise(i + 50, 0.18, 1.2);

    // Delay — 3-phase speed profile + ±15% variance
    let baseDelay;
    if (rawT < 0.2) {
      baseDelay = 0.010 + Math.random() * 0.020;  // ช้าตอนต้น
    } else if (rawT < 0.8) {
      baseDelay = 0.005 + Math.random() * 0.010;  // เร็วตอนกลาง
    } else {
      baseDelay = 0.015 + Math.random() * 0.030;  // ชะลอตอนท้าย
    }
    const variance = 1 + (Math.random() - 0.5) * 0.3;  // ±15%
    const delay = baseDelay * variance;

    points.push({
      x: Math.round(point.x + jitterX),
      y: Math.round(point.y + jitterY),
      delay: delay * 1000, // แปลงเป็น ms
    });

    // Micro-pause injection
    for (const pausePos of pausePositions) {
      if (Math.abs(rawT - pausePos) < 1 / numSteps) {
        points.push({
          x: Math.round(point.x + jitterX),
          y: Math.round(point.y + jitterY),
          delay: 50 + Math.random() * 100, // 50-150ms หยุดชั่วขณะ
        });
      }
    }
  }

  // ── จุดสุดท้าย: ตรงเป้าหมายเป๊ะ (ลบ jitter) ──
  points.push({ x: endX, y: endY, delay: 0 });

  return points;
}

/**
 * สุ่มตำแหน่งคลิกภายใน element (ไม่ตรงกลางเป๊ะ)
 *
 * @param {DOMRect} rect - getBoundingClientRect() ของ element
 * @param {number} [maxOffsetRatio=0.15] - สัดส่วนสูงสุดที่เยื้องจากกลาง (0.15 = ±15%)
 * @returns {{x: number, y: number}}
 */
function randomClickTarget(rect, maxOffsetRatio) {
  maxOffsetRatio = maxOffsetRatio || 0.15;
  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;
  const offsetX = (Math.random() - 0.5) * 2 * maxOffsetRatio * rect.width;
  const offsetY = (Math.random() - 0.5) * 2 * maxOffsetRatio * rect.height;
  return {
    x: Math.round(centerX + offsetX),
    y: Math.round(centerY + offsetY),
  };
}

// Export สำหรับ content script ใช้งาน (เก็บใน globalThis)
globalThis.__mouseMath = {
  easeOutCubic,
  easeOutQuint,
  easeInOutSine,
  easeOutExpo,
  easeOutBounce,
  createNoiseGenerator,
  cubicBezier,
  generateBezierPath,
  randomClickTarget,
};
