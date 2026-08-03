# Handoff to Claude — ClipForge recovery (22 Jul 2026)

> ⛔ **เอกสารเก่า (22 ก.ค. 2026) — ไม่ใช่สถานะปัจจุบันแล้ว** เก็บไว้อ้างอิงประวัติเท่านั้น
> สถานะจริงอยู่ท้าย `AGENT-COORDINATION.md` และใน `CLAUDE.md`

## Database/schema update — Codex (22 Jul 2026, 10:17 Bangkok)

- Root cause confirmed: Node did not own the legacy Python `dataset`/`item`
  schema. This is now fixed with idempotent schema migration v1 in
  `src/db/database.ts` and migration tracking in `clipforge_schema_migration`.
- Defaults/backfills now cover `dataset.active`, `dataset.created_at`, and all
  five blocking item columns: `status`, `post_state`, `posted_verified`,
  `post_message`, and `post_ref`.
- `item.media_json` was safely migrated from VARCHAR to JSONB after verifying
  every existing value. No legacy row was discarded.
- A rollback probe using the exact seven-column item insert succeeded, including
  Thai UTF-8 text and all defaults. Real scraper retries then increased item
  count from 15 to 29, confirming ingest works end to end.
- Legacy `scrapejob` remains untouched/read-only. Node uses `scrape_job` only.
- The incomplete-narration truncation bug is also fixed: normalization no longer
  leaves sentences ending in connectors such as "จะได้" or "กำลัง".
- Regression tests and TypeScript checks pass. Service was restarted after the
  final edits; dashboard is connected, stopped, and credit-locked.

## Latest Codex handoff — client reference videos and narration (22 Jul 2026, 09:30 Bangkok)

This section supersedes the older Job #42 checkpoint notes below.

### Client requirement and reference material

The client supplied seven portrait review videos in:
`C:\Users\edit01\Downloads\ตัวอย่าง\`

The required style is a real hands-on sales review, not a passive product
animation. Every generated story must include:

1. A problem-first hook or a short reason for choosing the product.
2. The product raised into view, then a shallow left-right reveal while its
   front identity remains readable.
3. A close-up of a verified label/detail and a verified feature.
4. A plain-language explanation of the practical problem or inconvenience
   that feature addresses. Never invent medical efficacy or guarantee results.
5. A natural, non-pushy check-details/order CTA in the final shot only.

For 16-second jobs, combine this into two clips. For 24-second jobs, use three
clips. Narration must follow what is visibly happening in each shot, use spoken
Thai rather than stitched review text, and include short breathing pauses.

### Code changed by Codex

- `src/gemini/prompt-generator.ts`
  - Added mandatory conversion coverage for hook, left-right/detail reveal,
    verified feature, buyer problem, and final CTA.
  - Added the client-reference requirement to the per-job prompt.
  - Made narration wording more conversational and visually grounded.
  - Replaced unsafe generic narration padding with visible-action wording.
- `src/config.ts`
  - TTS style now asks for micro-pauses after important phrases and avoids a
    uniform AI/advertisement cadence.
- `src/gemini/tts-generator.ts`
  - The slow/natural retry style now reinforces breathing pauses and rejects a
    commercial-announcer delivery.
- `src/scripts/regression-check.ts`
  - Added regression coverage for the client story structure and voice style.

Verification completed after the edits:

- `npm.cmd run test-regression` — passed all checks.
- `npx.cmd tsc --noEmit` — passed.

### Current live state

- Local service is reachable at `http://127.0.0.1:8110`.
- Dashboard reports Extension `2.6.18`, `connected=true`, `running=false`, and
  `creditLocked=true`.
- Job #42 now has all three 8-second source clips and
  `data/output/job_42/job_42_final.mp4`; the older section below saying clip 3
  is missing is stale.
- Runtime stopped safely because the generated narration was only 14.3 seconds
  for a 24-second video. This is the next unresolved production issue. The new
  narration/TTS instructions have passed code tests but have not yet been
  validated by spending another Flow credit.
- Do not unlock or start the bot until the user explicitly asks for a live run.

### Recommended next work

1. Inspect Job #42 final video and its narration timing before changing code.
2. Keep the one-voice-per-job continuous TTS path; do not synthesize each clip
   separately because that caused voice/personality drift previously.
3. If narration remains below the existing minimum duration, improve the
   script-generation length or retry style. Do not merely stretch a 14-second
   voice to 24 seconds because it will sound artificial.
4. Validate with one controlled 16-second job first when the user authorizes a
   live run, then evaluate product fidelity, spoken naturalness, and CTA timing.

## Current safe state

- Local service: healthy on `http://127.0.0.1:8110`.
- PostgreSQL: connected.
- Chrome Extension: connected from **Chrome Profile 9**.
- Extension version: `2.6.18`.
- Runtime: `running=false`, `creditLocked=true`, `currentJobId=null`.
- The queued `stop` command was consumed successfully after Profile 9 was reopened.
- Do not start a new job until the user explicitly asks to resume.

## Root cause of Claude being unable to control the bot

Commands in `data/remote-command.json` are delivered only when the Extension
posts its 15-second heartbeat to `POST /api/extension/status`. Chrome was being
used in Profile 8, while the working unpacked ClipForge Extension was active in
Profile 9. The last heartbeat was 21 Jul 2026 17:31 Bangkok time, so Claude's
`stop` command remained unread.

`data/extension-state.json` retains the last raw `connected` value and can look
connected while stale. Use `GET /api/dashboard` and trust
`runtime.connected`; the server applies the heartbeat TTL there.

## Job #42 recovery checkpoint

- Database status: `pending`.
- Target: 24 seconds / 3 clips.
- Generated start image exists:
  `data/output/job_42/job_42_generated_start.jpg` (90,898 bytes).
- Clip 1 exists and passed ffprobe:
  `data/output/job_42/job_42_video_1.mp4` — H.264, 720x1280, 8.0s.
- Clip 2 exists and passed ffprobe:
  `data/output/job_42/job_42_video_2.mp4` — H.264, 720x1280, 8.0s.
- Clip 3 and final video do not exist yet.
- The job was paused with `/api/extension/jobs/42/pause`; paid checkpoints
  were preserved. `claimAndPrepareExtensionJob()` must resume at clip index 2
  using the last frame of clip 2. It must not regenerate the image or clips 1–2.

## Safe resume procedure

1. Keep Chrome **Profile 9** open on Google Flow, or install/reload the unpacked
   Extension in the profile that will actually be used.
2. Confirm `GET /api/dashboard` returns `runtime.connected=true`, and confirm
   `runtime.updatedAt` is fresh (under 60 seconds old).
3. Write one command at a time and wait until the file is consumed before
   writing the next command:
   - `{"command":"unlock"}`
   - after heartbeat confirms `creditLocked=false`, `{"command":"start"}`
4. Confirm the claimed job is #42 and its next clip is clip index 2 (clip 3/3).
5. Never click or issue Generate twice. Do not auto-retry a failed generation.
6. If Flow reports unusual activity, pause the job and lock credits immediately.

## Notes

- The operational profile mismatch is fixed for now by reopening Profile 9.
- Current dashboard verification after recovery:
  `connected=true`, `running=false`, `creditLocked=true`, version `2.6.18`.
- Web App and database were not the cause of the control failure.

## 22 Jul 2026 scraper/schema follow-up (Codex)

- Live DB is now schema v2. `scrape_ingest_batch(job_id,batch_id)` makes extension retries idempotent.
- `src/scrape/harvester-api.ts` now uses a transaction, row locking, canonical media validation, and rejects corrupted `?`/replacement-character text from overwriting valid Thai.
- A live disposable probe sent the same batch twice and verified exactly one review and one media entry; probe rows were cleaned up.
- Shopee Harvester source is v0.2.3. It buffers ratings responses received before `START_HARVEST`, serializes captures, waits for ingest acknowledgement before reporting done, preserves failed batches, and logs response field shapes without review text.
- Updated archive: `X:/ทีมมีเดีย/เฟรนด์/app/clipbot/Shopee-Harvester-0.2.3.zip`.
- Service restarted on PID 4952. Verified `connected=true`, `running=false`, `creditLocked=true`, Extension 2.6.18.
- Chrome still needs a manual Reload of the unpacked Shopee Harvester so its service worker/content scripts switch from 0.2.2 to 0.2.3.
- No Flow generation was triggered and no credits were spent during this repair.

### Live v0.2.3 verification

The user reloaded the unpacked extension and pressed Start. Controlled job #77
for Shopee item `398478671/23419564909` completed successfully across 10 pages:
19 text reviews and 54 captured media. The canonical item now has 57 unique URLs
(39 images, 18 videos), all with review timestamps. Seven batch IDs were stored,
no new HTTP errors occurred, and the `ratings.shape` diagnostic confirms the new
extension code is active. Queue state after completion: no pending/running jobs.
