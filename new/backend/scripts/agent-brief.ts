/**
 * สร้างบรีฟกลางให้เอเจนต์ทุกตัวเห็นข้อมูลชุดเดียวกันโดยไม่ต้องรอเจ้าของมาบอก
 *
 * ทำสองอย่าง:
 *   1. เขียนสถานะสด (เวอร์ชัน, service, งานล่าสุด, ของที่ยังไม่ commit) ลงบล็อก AUTO ของ AGENTS.md
 *   2. คัดลอกบล็อก SHARED ของ AGENTS.md ไปไว้ใน CLAUDE.md ให้ตรงกันเป๊ะ
 *      เพราะ Codex/Antigravity อ่าน AGENTS.md เอง ส่วน Claude อ่าน CLAUDE.md เอง
 *      ถ้าปล่อยให้แยกกันเขียน สองฝั่งจะเพี้ยนกันภายในไม่กี่วัน (regression เช็คข้อนี้ไว้)
 */
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const AGENTS_FILE = path.join(ROOT, 'AGENTS.md');
const CLAUDE_FILE = path.join(ROOT, 'CLAUDE.md');

export const AUTO_START = '<!-- AUTO:START — บล็อกนี้สร้างด้วย `npm run brief` ห้ามแก้มือ -->';
export const AUTO_END = '<!-- AUTO:END -->';
export const SHARED_START = '<!-- SHARED:START -->';
export const SHARED_END = '<!-- SHARED:END -->';

export function sectionBetween(text: string, start: string, end: string): string | null {
  const from = text.indexOf(start);
  const to = text.indexOf(end);
  if (from < 0 || to < 0 || to < from) return null;
  return text.slice(from + start.length, to).trim();
}

function replaceBetween(text: string, start: string, end: string, body: string): string {
  const from = text.indexOf(start);
  const to = text.indexOf(end);
  if (from < 0 || to < 0) throw new Error(`ไม่พบ marker ${start} / ${end}`);
  return `${text.slice(0, from + start.length)}\n${body}\n${text.slice(to)}`;
}

function readManifestVersion(file: string): string {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')).version || '?';
  } catch {
    return '?';
  }
}

function readActiveVersion(): string {
  try {
    const source = fs.readFileSync(path.join(ROOT, 'backend/src/server/paths.ts'), 'utf8');
    return source.match(/ACTIVE_EXTENSION_VERSION\s*=\s*'([^']+)'/)?.[1] || '?';
  } catch {
    return '?';
  }
}

function git(args: string[]): string {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

/** ถาม service ตรงๆ ถ้าไม่ตอบใน 3 วิ ถือว่าดับ — บรีฟต้องไม่ค้างเพราะ service ตาย */
async function fetchRuntime(): Promise<any | null> {
  try {
    const response = await fetch('http://127.0.0.1:8110/api/dashboard', {
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

function formatJobs(jobs: any[]): string {
  if (!jobs.length) return 'ไม่มีข้อมูลงาน';
  const recent = jobs.slice(0, 6);
  const done = recent.filter((job) => job.status === 'completed').length;
  const tail = recent.map((job) => `#${job.id} ${job.status}`).join(' · ');
  return `${done}/${recent.length} งานล่าสุดจบสมบูรณ์ — ${tail}`;
}

async function buildAutoBlock(stampedAt: string): Promise<string> {
  const versions = [
    readManifestVersion(path.join(ROOT, 'extension/manifest.json')),
    readManifestVersion(path.join(ROOT, 'clipbot-flow-extension/manifest.json')),
    readActiveVersion(),
  ];
  const versionsAgree = versions.every((value) => value === versions[0]);
  const dashboard = await fetchRuntime();
  const runtime = dashboard?.runtime;
  const dirty = git(['status', '--short']).split('\n').filter(Boolean);
  const lastCommit = git(['log', '-1', '--format=%h %s']);

  const lines = [
    `> **สถานะสด ณ ${stampedAt}** — สร้างอัตโนมัติ ไม่ใช่ของที่พิมพ์มือ`,
    '',
    '| | |',
    '|---|---|',
    `| Extension | **${versions[0]}** ${versionsAgree ? '(ตรงกันครบ 3 จุด)' : `⚠️ **ไม่ตรงกัน** → ${versions.join(' / ')}`} |`,
    `| Local Service 8110 | ${runtime ? '🟢 ตอบอยู่' : '🔴 **ไม่ตอบ** — สตาร์ตด้วย `npm run control:auto` แบบ detached'} |`,
  ];

  if (runtime) {
    lines.push(
      `| บอท | \`running=${runtime.running}\` · \`creditLocked=${runtime.creditLocked}\` · \`connected=${runtime.connected}\` |`,
      `| งานที่กำลังทำ | ${runtime.currentJobId ? `**#${runtime.currentJobId}** — ห้ามรีสตาร์ต service ตอนนี้` : 'ไม่มี'} |`,
      `| งานล่าสุด | ${formatJobs(dashboard.jobs || [])} |`,
    );
  }

  lines.push(
    `| git | ${lastCommit || 'อ่านไม่ได้'}${dirty.length ? ` · **ยังไม่ commit ${dirty.length} ไฟล์**` : ' · working tree สะอาด'} |`,
  );

  if (dirty.length) {
    lines.push(
      '',
      '<details><summary>ไฟล์ที่ยังไม่ commit (ของเอเจนต์ตัวอื่นอาจกำลังแก้อยู่ — เช็คกระดานก่อนแตะ)</summary>',
      '',
      '```',
      ...dirty.slice(0, 30).map((line) => line.trim()),
      ...(dirty.length > 30 ? [`… อีก ${dirty.length - 30} ไฟล์`] : []),
      '```',
      '',
      '</details>',
    );
  }

  return lines.join('\n');
}

/** เวลาไทยแบบ ค.ศ. ให้ตรงกับวันที่ที่เขียนมือไว้ในเอกสารอื่น (th-TH ปกติจะได้ พ.ศ.) */
function bangkokStamp(): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Bangkok',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  const get = (type: string) => parts.find((part) => part.type === type)?.value || '';
  return `${get('day')} ${get('month')} ${get('year')} ${get('hour')}:${get('minute')} น. (เวลาไทย)`;
}

async function main() {
  const agentsText = fs.readFileSync(AGENTS_FILE, 'utf8');
  const shared = sectionBetween(agentsText, SHARED_START, SHARED_END);
  if (!shared) throw new Error(`AGENTS.md ไม่มี marker ${SHARED_START} / ${SHARED_END}`);

  const withStatus = replaceBetween(agentsText, AUTO_START, AUTO_END, await buildAutoBlock(bangkokStamp()));
  fs.writeFileSync(AGENTS_FILE, withStatus);

  const claudeText = fs.readFileSync(CLAUDE_FILE, 'utf8');
  fs.writeFileSync(CLAUDE_FILE, replaceBetween(claudeText, SHARED_START, SHARED_END, shared));

  console.log('อัปเดตแล้ว: AGENTS.md (สถานะสด) + CLAUDE.md (คัดลอกส่วนกลางให้ตรงกัน)');
}

// regression import ไฟล์นี้เพื่อใช้ marker ร่วมกัน จึงต้องไม่ทำงานตอนถูก import
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(`สร้างบรีฟไม่สำเร็จ: ${error.message}`);
    process.exit(1);
  });
}
