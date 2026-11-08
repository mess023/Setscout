/**
 * Track recognition via Shazam with rate-limit retry.
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { Shazam, s16LEToSamplesArray } = require('shazam-api');

const shazam = new Shazam();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const MAX_RETRIES = 3;
const BACKOFF_BASE_MS = 10_000; // 10s, 20s, 40s

/**
 * Recognize a track from raw s16le PCM audio data.
 * Retries with exponential backoff on rate-limit (HTML response).
 * Returns { title, artist, album, year } or null.
 */
export async function recognize(pcmBuffer) {
  const samples = s16LEToSamplesArray(pcmBuffer);

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      // fullRecognizeSong keeps matches[0].offset/timeskew, which recognizeSong() drops
      const res = await shazam.fullRecognizeSong(samples);
      if (!res?.track) return null;
      const meta = res.track.sections?.find(s => s.type === 'SONG')?.metadata || [];
      const m = res.matches?.[0] || {};

      return {
        title: res.track.title || 'Unknown',
        artist: res.track.subtitle || 'Unknown',
        album: meta.find(e => e.title === 'Album')?.text || '',
        year: meta.find(e => e.title === 'Released')?.text || '',
        // offset: seconds into the original track where this fragment starts; timeskew: mix tempo vs original
        ...(typeof m.offset === 'number' && { offset: m.offset, timeskew: m.timeskew || 0 }),
      };
    } catch (err) {
      // shazam-api 0.3.0 reads `response.matches.length` unguarded; a JSON error body
      // without `matches` (e.g. a 429 served as JSON) surfaces as a TypeError → treat as rate limit.
      const isRateLimit = err instanceof TypeError || (err.message && (
        err.message.includes('<!doctype') ||
        err.message.includes('<!DOCTYPE') ||
        err.message.includes('is not valid JSON')
      ));

      if (isRateLimit && attempt < MAX_RETRIES) {
        const wait = BACKOFF_BASE_MS * Math.pow(2, attempt);
        process.stdout.write(`\n   ⏳ Rate limited — waiting ${wait / 1000}s before retry...\n`);
        await sleep(wait);
        continue;
      }

      throw err;
    }
  }

  return null;
}
