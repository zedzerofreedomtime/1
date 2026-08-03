import fs from 'fs';
import path from 'path';

const logDir = path.resolve(process.env.LOG_DIR || './logs');
const args = process.argv.slice(2);
const valueAfter = (name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const jobId = valueAfter('--job');
const level = valueAfter('--level');
const source = valueAfter('--source');
const limit = Math.max(1, Number(valueAfter('--limit') || 80));

const files = fs.existsSync(logDir)
  ? fs.readdirSync(logDir).filter((name) => /^events-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).sort()
  : [];
const records = files.flatMap((name) =>
  fs.readFileSync(path.join(logDir, name), 'utf8').split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  })
).filter((event) =>
  (!jobId || String(event.jobId) === jobId)
  && (!level || event.level === level)
  && (!source || event.source === source)
).slice(-limit);

if (!records.length) {
  console.log('ไม่พบ log ที่ตรงกับตัวกรอง');
  process.exit(0);
}

for (const event of records) {
  const time = new Date(event.at).toLocaleString('th-TH', { hour12: false });
  const context = [event.source, event.stage, event.jobId != null ? `งาน #${event.jobId}` : '', event.clipIndex != null ? `คลิป ${event.clipIndex + 1}` : ''].filter(Boolean).join(' · ');
  console.log(`${time}  ${String(event.level || 'info').toUpperCase().padEnd(5)}  ${context}`);
  console.log(`  ${event.message}${event.durationMs != null ? ` (${event.durationMs} ms)` : ''}`);
  if (event.error) console.log(`  ERROR: ${event.error.message || JSON.stringify(event.error)}`);
}
