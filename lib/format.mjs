/**
 * Output formatting — TXT, CUE, and JSON.
 */

import { writeFileSync } from 'fs';
import { basename } from 'path';

/** Format seconds as H:MM:SS or MM:SS. */
export function formatTime(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Remove consecutive duplicate tracks (handles transition bouncing). */
export function dedupe(tracks) {
  const result = [];
  for (const t of tracks) {
    const prev = result[result.length - 1];
    if (prev && prev.title === t.title && prev.artist === t.artist) continue;
    result.push(t);
  }
  return result;
}

/**
 * Turn per-segment scan results into tracks with a from/to range.
 *
 *  start_sec — exact when the methods report an offset (position inside the original
 *              track): every detection estimates "track start in the mix" as
 *              pos − offset·k, with k = mix seconds per track second
 *              (= stretch / (1 + timeskew): Shazam-gepitcht's correction factor and the
 *              DJ's tempo deviation Shazam measures). start = median of those estimates,
 *              clamped between the previous track's start and the first detection
 *              (a DJ may start a track past its intro). `spread` = max − min of the
 *              estimates (s): small = trustworthy. No offsets → first detection (±step).
 *  end_sec   — start of the NEXT track (exact when it has offsets, else its first
 *              detection). Unknown gap ≤ 3 steps without exact next start → midpoint;
 *              longer gap → an unidentified track sits in between: end = last detection
 *              + one step. Final track (or an aborted scan): last detection + segment.
 *
 * Unknown gaps between two detections of the SAME track are bridged without
 * limit, so a track that drops out for a few segments stays one entry.
 * Comparison is case-insensitive on artist + title.
 *
 * ponytail: no bisection around transitions — offsets already give the start to the second;
 * the end of the LAST track still uses last detection + segment (track length unknown).
 */
export function toRanges(segments, segmentLen = 18, step = null) {
  const det = segments.filter(s => s.match);
  if (!det.length) return [];
  step ??= segments.length > 1 ? segments[1].pos - segments[0].pos : 30;
  const maxGap = 3 * step;
  const estimate = ({ pos, match: m }) =>
    Number.isFinite(m.offset) ? pos - m.offset * (m.stretch || 1) / (1 + (m.timeskew || 0)) : null;

  // 1. group consecutive detections of the same track (unknowns in between are skipped)
  const runs = [];
  for (const s of det) {
    const prev = runs[runs.length - 1];
    const e = estimate(s);
    if (prev && sameTrack(prev, s.match)) { prev.last_sec = s.pos; prev.hits++; if (e != null) prev.est.push(e); continue; }
    runs.push({ ...s.match, first_sec: s.pos, last_sec: s.pos, hits: 1, est: e != null ? [e] : [] });
  }

  // 2. drop a single stray detection sandwiched between two runs of the same track
  //    (Shazam misfire during a long track: Y Y X Y Y → Y). A real 30 s track inside
  //    another track does not happen in a DJ set.
  for (let i = 1; i < runs.length - 1; i++) {
    if (runs[i].hits === 1 && sameTrack(runs[i - 1], runs[i + 1])) {
      runs[i - 1].last_sec = runs[i + 1].last_sec;
      runs[i - 1].hits += runs[i + 1].hits;
      runs[i - 1].est.push(...runs[i + 1].est);
      runs.splice(i, 2); i--;
    }
  }

  // 3. start: the largest cluster of estimates that agree within ±2 s (tracks with repeated
  //    sections or DJ loops give a few estimates that are off by a bar or more; a median
  //    would drift). Tie → the cluster of the earliest detection. Lower bound: the previous
  //    track was still confirmed playing until its last detection; allow one step of
  //    overlap (blend). Below that, the DJ started this track mid-way → start unknown:
  //    first detection, not exact.
  let prev = null;
  for (const r of runs) {
    const low = prev ? Math.max(prev.start_sec + 1, prev.last_sec - step) : segments[0].pos;
    r.exact = false;
    if (r.est.length) {
      // a track starts at the latest inside its first detected fragment, and not while the previous one still owned the mix
      const ok = r.est.filter(e => e < r.first_sec + segmentLen && e >= low); // it may start inside its first fragment
      let best = [];
      for (const c of ok) { const g = ok.filter(e => Math.abs(e - c) <= 2); if (g.length > best.length) best = g; }
      r.spread = Math.round((Math.max(...r.est) - Math.min(...r.est)) * 10) / 10;
      r.agree = `${best.length}/${r.est.length}`;
      if (best.length) { r.start_sec = Math.round(best.reduce((a, b) => a + b, 0) / best.length); r.exact = true; }
    }
    if (!r.exact) r.start_sec = Math.max(r.first_sec, prev ? prev.start_sec + 1 : 0);
    prev = r;
  }

  // 4. end: start of the next track
  return runs.map((r, i) => {
    const next = runs[i + 1];
    const { first_sec, last_sec, est, offset, timeskew, stretch, score, pitch, ...rest } = r; // keeps `hits` (1 = possible misfire)
    let end_sec;
    if (!next) end_sec = last_sec + segmentLen;
    else {
      const gap = next.first_sec - last_sec;
      if (gap > maxGap) end_sec = last_sec + step;
      else if (next.exact || gap <= step) end_sec = next.start_sec;
      else end_sec = Math.max(last_sec + segmentLen, Math.round((last_sec + next.first_sec) / 2));
    }
    return { ...rest, end_sec: Math.max(end_sec, r.start_sec + 1) };
  });
}

/**
 * Shazam is not stable in how it names the same track between calls:
 * "Deco" vs "Deco (BE)", "JUNO ( DE )", "A & B" vs "A, B". Compare on the
 * title plus the artist stripped of bracketed tags and punctuation.
 */
const norm = (s) => String(s || '').toLowerCase().replace(/[(\[][^)\]]*[)\]]/g, '').replace(/[^\p{L}\p{N}]+/gu, '');
const normTitle = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
export function sameTrack(a, b) {
  return normTitle(a.title) === normTitle(b.title) && norm(a.artist) === norm(b.artist);
}

/** Write paste-friendly tracklist. */
export function writeTXT(tracks, outPath) {
  const lines = tracks.map(t => `${t.artist} - ${t.title} ${t.timestamp}`);
  writeFileSync(outPath, lines.join('\n') + '\n');
}

/** Write CUE sheet. */
export function writeCUE(tracks, outPath, audioFilename) {
  const title = basename(outPath, '.cue').replace(/[-_]/g, ' ');
  let cue = `REM GENRE DJ Mix\nTITLE "${title}"\nFILE "${audioFilename}" MP3\n`;

  tracks.forEach((t, i) => {
    const num = String(i + 1).padStart(2, '0');
    const mm = String(Math.floor(t.position_sec / 60)).padStart(2, '0');
    const ss = String(t.position_sec % 60).padStart(2, '0');
    cue += `  TRACK ${num} AUDIO\n`;
    cue += `    TITLE "${t.title}"\n`;
    cue += `    PERFORMER "${t.artist}"\n`;
    cue += `    INDEX 01 ${mm}:${ss}:00\n`;
  });

  writeFileSync(outPath, cue);
}

/** Write JSON tracklist with metadata. */
export function writeJSON(tracks, outPath, meta = {}) {
  writeFileSync(outPath, JSON.stringify({ ...meta, tracks }, null, 2));
}
