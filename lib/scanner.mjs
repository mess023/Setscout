/**
 * Core scanner — splits audio into segments and identifies tracks.
 */

import { mkdtempSync, mkdirSync, readFileSync, unlinkSync, rmSync } from 'fs';
import { join, basename } from 'path';
import { tmpdir } from 'os';
import { getDuration, extractSegment } from './audio.mjs';
import { recognize } from './recognize.mjs';
import { formatTime } from './format.mjs';

const RATE_LIMIT_MS = 3000; // Be polite to Shazam
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Scan an audio file and identify tracks.
 *
 * @param {string} file       - Path to audio file
 * @param {object} opts
 * @param {number} opts.step        - Seconds between scan points (default: 30)
 * @param {number} opts.segment     - Seconds per sample (default: 18)
 * @param {number} opts.start       - Start position in seconds (default: 0)
 * @param {boolean} opts.quiet      - Suppress progress output (default: true when onProgress given)
 * @param {function} opts.onProgress - Called with { type: 'start'|'segment', ... } per scan point
 * @param {AbortSignal} opts.signal - Abort the scan between segments
 * @param {string} opts.tmpDir      - Directory for temporary PCM segments (default: os tmpdir)
 * @param {function} opts.recognize - (ctx: { pcm, segPath, pos, segment, file, signal }) => match|null (default: Shazam)
 * @param {number} opts.pause       - ms to wait after each fragment (default: 3000, Shazam politeness)
 * @returns {Promise<{ tracks: Array, segments: Array, duration: number, segmentsScanned: number, aborted: boolean }>}
 *   tracks   — first-detection list (consecutive duplicates collapsed by caller via dedupe)
 *   segments — every scan point: { pos, match|null } (use format.toRanges for from/to)
 */
export async function scan(file, opts = {}) {
  const step = opts.step ?? 30;
  const segment = opts.segment ?? 18;
  const start = opts.start ?? 0;
  const onProgress = opts.onProgress ?? (() => {});
  const quiet = opts.quiet ?? Boolean(opts.onProgress);
  const signal = opts.signal;
  const recognizeFn = opts.recognize ?? (({ pcm }) => recognize(pcm));
  const pause = opts.pause ?? RATE_LIMIT_MS;

  const duration = getDuration(file);
  const totalSegs = Math.max(1, Math.floor((duration - segment - start) / step) + 1);
  let tmpDir;
  if (opts.tmpDir) {
    mkdirSync(opts.tmpDir, { recursive: true });
    tmpDir = mkdtempSync(join(opts.tmpDir, 'scan-'));
  } else {
    tmpDir = mkdtempSync(join(tmpdir(), 'mix-id-'));
  }

  const log = quiet ? () => {} : (msg) => process.stdout.write(msg);

  if (!quiet) {
    console.log(`\n🎵 mix-id`);
    console.log('─'.repeat(50));
    console.log(`File:     ${basename(file)}`);
    console.log(`Duration: ${formatTime(duration)}`);
    console.log(`Settings: ${step}s step, ${segment}s sample`);
    console.log('─'.repeat(50) + '\n');
  }
  onProgress({ type: 'start', duration, total: totalSegs, step, segment });

  const tracks = [];
  const segments = [];
  let lastTrack = null;
  let segNum = 0;
  let aborted = false;

  for (let pos = start; pos + segment <= duration; pos += step) {
    if (signal?.aborted) { aborted = true; break; }
    segNum++;
    const ts = formatTime(pos);
    const pct = Math.round((segNum / totalSegs) * 100);
    log(`[${ts}] ${pct}% `);

    const segPath = join(tmpDir, `seg.raw`);
    const evt = { type: 'segment', pos, timestamp: ts, pct, index: segNum, total: totalSegs, match: null, status: 'none' };

    if (!extractSegment(file, pos, segment, segPath)) {
      log('⚠️  skip\n');
      evt.status = 'skip';
      segments.push({ pos, match: null });
      onProgress(evt);
      continue;
    }

    try {
      const pcm = readFileSync(segPath);
      const match = await recognizeFn({ pcm, segPath, pos, segment, file, signal });

      if (match) {
        const same = lastTrack
          && lastTrack.title === match.title
          && lastTrack.artist === match.artist;

        if (same) {
          log(`↩️  ${match.artist} — ${match.title}\n`);
          evt.status = 'same';
        } else {
          log(`✅ ${match.artist} — ${match.title}\n`);
          tracks.push({ timestamp: ts, position_sec: pos, ...match });
          lastTrack = match;
          evt.status = 'match';
        }
        evt.match = match;
        segments.push({ pos, match });
      } else {
        log('❓\n');
        lastTrack = null;
        segments.push({ pos, match: null });
      }
    } catch (err) {
      log(`⚠️  ${err.message}\n`);
      lastTrack = null;
      evt.status = 'error';
      evt.message = err.message;
      segments.push({ pos, match: null });
    }

    try { unlinkSync(segPath); } catch {}
    onProgress(evt);
    await sleep(pause);
  }

  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  return { tracks, segments, duration, segmentsScanned: segNum, aborted };
}
