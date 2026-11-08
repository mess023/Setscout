/**
 * Recognition methods + pipeline (keten).
 *
 * Every method is one object in METHODS. Groups:
 *   recognize — tried per fragment, in the user's order; first match wins
 *   reference — fetch an existing tracklist once per set; fills fragments nothing recognised
 *   enrich    — adds metadata (MusicBrainz) or analysis (Essentia BPM/key) to a match
 *   none      — shown in the UI with the reason it can't be built (yet)
 *
 * Methods with `local` fingerprint the user's own music folders into data/index/<id>/.
 * External tools are detected (where/which), never installed from here.
 */
import { spawn, spawnSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { join, resolve, basename, extname } from 'path';
import { hasCommand } from './audio.mjs';
import { recognize as shazamRecognize } from './recognize.mjs';
import { sameTrack, sameBaseTrack } from './format.mjs';
import { ROOT, indexDir, loadSettings } from './settings.mjs';

/** Swappable in tests (mock Shazam, external commands, waiting). */
export const api = { shazam: shazamRecognize, run: (...a) => run(...a), sleep: (ms) => new Promise(r => setTimeout(r, ms)) };
const sleep = (ms) => api.sleep(ms);
const WIN = process.platform === 'win32';
export const AUDIO_EXT = new Set(['.mp3', '.wav', '.flac', '.m4a', '.aac', '.ogg', '.opus', '.webm', '.mp4', '.mkv', '.aiff', '.wma']);

// ---------------------------------------------------------------- helpers

class MethodError extends Error { constructor(msg, fatal = false) { super(msg); this.fatal = fatal; } }

/** Settings value → runnable command, or null. Bare names go through where/which; paths resolve against the app dir. */
export function toolPath(cmd) {
  cmd = String(cmd || '').trim();
  if (!cmd) return null;
  if (/[\\/]/.test(cmd)) { const p = resolve(ROOT, cmd); return existsSync(p) ? p : null; }
  return /^[\w.+-]+$/.test(cmd) && hasCommand(cmd) ? cmd : null; // charset guard: hasCommand runs through a shell
}

/** Python: explicit setting, else the project venv, else python3/python on PATH. */
function pythonCmd(cfg) {
  if (cfg.python) return toolPath(cfg.python);
  for (const p of [join(ROOT, '.venv', 'Scripts', 'python.exe'), join(ROOT, '.venv', 'bin', 'python')]) if (existsSync(p)) return p;
  return toolPath(WIN ? 'python' : 'python3') || toolPath('python');
}

const statusCache = new Map(); // ponytail: 60 s cache so the settings page doesn't spawn python/java on every render
function cached(key, fn) {
  const hit = statusCache.get(key);
  if (hit && Date.now() - hit.t < 60_000) return hit.v;
  const v = fn(); statusCache.set(key, { t: Date.now(), v }); return v;
}
const pyHas = (py, mods) => cached(`py:${py}:${mods}`, () => spawnSync(py, ['-c', `import ${mods}`], { stdio: 'ignore', windowsHide: true }).status === 0);
function javaMajor() {
  return cached('java', () => {
    const r = spawnSync('java', ['-version'], { encoding: 'utf8', windowsHide: true });
    const m = /version "(\d+)(?:\.(\d+))?/.exec((r.stderr || '') + (r.stdout || ''));
    return !m ? 0 : m[1] === '1' ? +m[2] : +m[1];
  });
}

/** Run a command, collect output. Never throws on exit code; throws on spawn failure/abort. */
export function run(cmd, args, { env, signal, timeout = 120_000 } = {}) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args, { env: env ? { ...process.env, ...env } : process.env, windowsHide: true, signal, timeout });
    let out = '', err = '';
    p.stdout.on('data', d => out += d); p.stderr.on('data', d => err += d);
    p.on('error', rej);
    p.on('close', code => res({ code, stdout: out, stderr: err }));
  });
}

/** Tool error for the UI: first + last stderr line (Olaf puts the cause first, Python tracebacks last). */
const errLine = (r) => {
  const l = String(r.stderr || '').split('\n').map(x => x.trim()).filter(Boolean);
  return (l.length > 1 ? `${l[0]} … ${l.at(-1)}` : l[0] || `exit ${r.code}`).slice(0, 300);
};

/** 44-byte WAV header around the scanner's s16le mono 16 kHz PCM. */
export function pcmToWav(pcm, rate = 16000) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/** Artist/title of a file in the user's collection: tags via ffprobe, else "Artist - Title" filename. */
const tagCache = new Map();
export function tagsOf(path) {
  if (tagCache.has(path)) return tagCache.get(path);
  let t = {};
  const r = spawnSync('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_format', path], { encoding: 'utf8', windowsHide: true });
  try { for (const [k, v] of Object.entries(JSON.parse(r.stdout).format.tags || {})) t[k.toLowerCase()] = v; } catch {}
  const stem = basename(path, extname(path));
  const [fa, ...ft] = stem.split(' - ');
  const out = {
    artist: t.artist || t.album_artist || (ft.length ? fa : ''),
    title: t.title || (ft.length ? ft.join(' - ') : stem),
    album: t.album || '',
    year: String(t.date || t.year || '').slice(0, 4),
  };
  tagCache.set(path, out); return out;
}

async function fetchJson(url, opts = {}, signal) {
  const r = await fetch(url, { ...opts, signal });
  const text = await r.text();
  try { return JSON.parse(text); }
  catch { throw new MethodError(`HTTP ${r.status}: geen JSON (${text.slice(0, 80).replace(/\s+/g, ' ')})`); }
}

function fileForm(fields, wavBuf) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, String(v));
  fd.append('file', new Blob([wavBuf], { type: 'audio/wav' }), 'fragment.wav');
  return fd;
}

/**
 * Read a Sound Search result from a `uiautomator dump`. Two layouts:
 *  - song card: title/artist in nodes whose resource-id matches cfg.titleId / cfg.artistId;
 *  - search results page (current Google app): the recognised "Artist Title" lands in the search box
 *    (resource-id …srp_search_box_text, or a "<query> - Google Search" node). Artist and title are then split
 *    with help from the same screen — a YouTube channel "<Artist> - Topic" or a result "<Artist> - <Title …>"
 *    whose artist is a prefix of the query; otherwise the whole query becomes the title.
 * `texts` lists all visible texts with their id, for tuning.
 */
export function parseSoundSearch(xml, cfg) {
  const dec = (s) => s.replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const nodes = [...String(xml).matchAll(/<node\b[^>]*>/g)].map(([n]) => ({
    text: dec(/\stext="([^"]*)"/.exec(n)?.[1] || ''), desc: dec(/\scontent-desc="([^"]*)"/.exec(n)?.[1] || ''),
    id: /\sresource-id="([^"]*)"/.exec(n)?.[1] || '',
  }));
  const shown = nodes.filter(n => n.text.trim());
  let tRe, aRe;
  try { tRe = new RegExp(cfg.titleId || 'title', 'i'); aRe = new RegExp(cfg.artistId || 'artist', 'i'); }
  catch (e) { throw new MethodError(`ongeldige regex: ${e.message}`, true); }
  const texts = shown.map(n => `${n.text} [${n.id.split('/').pop()}]`);
  let title = shown.find(n => tRe.test(n.id) && !/srp_search_box/i.test(n.id))?.text;
  let artist = shown.find(n => aRe.test(n.id) && n.text !== title)?.text;
  if (title) return { title, artist, texts };
  const query = (shown.find(n => /srp_search_box_text/i.test(n.id))?.text
    || shown.map(n => /^(.+) - Google Search$/.exec(n.text)?.[1]).find(Boolean) || '').trim();
  if (!query) return { title: undefined, artist: undefined, texts };
  const q = query.toLowerCase();
  const all = nodes.flatMap(n => [n.text, n.desc]).filter(Boolean);
  const cands = all.flatMap(t => [/^(.+?) - Topic\b/.exec(t)?.[1], /^(.+?) [-–—] /.exec(t)?.[1], /·\s*(.+?) - Topic\b/.exec(t)?.[1]])
    .filter(a => a && a.length < query.length && q.startsWith(a.toLowerCase().trim() + ' '));
  artist = cands.sort((a, b) => b.length - a.length)[0]?.trim() || '';
  title = artist ? query.slice(artist.length).trim() : query;
  // Google only gives "Artist Title" — not which remix/version. Versions named on the same results page
  // ("Broken Glass (Helsloot Remix)") are kept as a hint for the user, never chosen automatically.
  const esc = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const vRe = new RegExp(`(${esc}\\s*[([][^)\\]]+[)\\]])`, 'i');
  const versions = [...new Set(all.map(t => vRe.exec(t)?.[1]?.replace(/\s+/g, ' ').trim()).filter(Boolean))];
  return { title, artist, texts, query, versions };
}

// ---------------------------------------------------------------- reference tracklists: search + text parsing

/** Search term from the set's filename: no extension, YouTube-ID, "(Full Set)" or punctuation. */
export function cleanQuery(file, cfg = {}) {
  return (cfg.query || basename(file, extname(file)).replace(/\[[\w-]{11}\]/g, '').replace(/\((full set|live|dj set)\)/gi, '')
    .replace(/[^\p{L}\p{N}&' ]+/gu, ' ')).replace(/\s+/g, ' ').trim().slice(0, 150);
}

/**
 * Rank items (strings) by how many search words they contain; the first word (usually the DJ) counts double.
 * `ok` = plausible match: DJ word present, the year (if the query has one) present, plus at least one other word.
 * Generic words (festival, live, set, …) don't count — every festival set would match them.
 */
const GENERIC = new Set(['festival', 'live', 'set', 'full', 'mix', 'stage', 'the', 'and', 'dj', 'b2b', 'official', 'video', 'recording']);
export function rankByWords(q, items) {
  const fold = (s) => String(s).toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
  const words = [...new Set(fold(q).split(/[^a-z0-9]+/).filter(w => w.length >= 3 && !GENERIC.has(w)))];
  const year = words.find(w => /^(19|20)\d\d$/.test(w));
  return items.map(item => {
    const f = fold(item), hit = words.map(w => f.includes(w));
    const score = hit.reduce((n, h, i) => n + (h ? (i ? 1 : 2) : 0), 0);
    const ok = Boolean(hit[0]) && words.length >= 2 && (!year || f.includes(year)) && hit.slice(1).some(Boolean); // DJ alone is not enough
    return { item, score, ok };
  }).sort((a, b) => b.ok - a.ok || b.score - a.score);
}

const toSec = (t) => t.split(':').reduce((a, x) => a * 60 + +x, 0);
const isUnknown = (artist, title) => !title || /^(id|\?+|unknown)$/i.test(title.trim()) || /^\?+$/.test(`${artist}${title}`.trim());
const splitName = (s) => {
  const [artist, ...rest] = s.replace(/\s+[–—]\s+/g, ' - ').split(' - ');
  return rest.length ? { artist: artist.trim(), title: rest.join(' - ').trim() } : { artist: '', title: s.trim() };
};

/** "mm:ss Artist - Title" lines (time first or last, optional numbering/brackets) → tracks. */
export function parseTimedLines(text) {
  const T = '((?:\\d{1,2}:)?\\d{1,2}:\\d{2})';
  const lead = new RegExp(`^\\W{0,3}(?:\\d{1,3}[.)]\\s*)?[\\[(]?${T}[\\])]?\\s*[-–—|:.]?\\s*(.+)$`);
  const trail = new RegExp(`^\\W{0,3}(?:\\d{1,3}[.)]\\s*)?(.+?)\\s*[-–—|(\\[]?\\s*${T}[\\])]?$`);
  const tracks = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    let m = lead.exec(line.trim()), time, rest;
    if (m) [, time, rest] = m; else if ((m = trail.exec(line.trim()))) [, rest, time] = m; else continue;
    rest = rest.replace(/\s*\[[^\]]*\]\s*$/, '').trim(); // trailing [Label]
    if (!rest || /^(tracklist|setlist)\b/i.test(rest)) continue;
    const { artist, title } = splitName(rest);
    tracks.push({ start_sec: toSec(time), artist, title, unknown: isUnknown(artist, title) });
  }
  // a real tracklist runs forward in time; drop lists that are mostly out of order (comment chatter)
  const forward = tracks.filter((t, i) => i === 0 || t.start_sec >= tracks[i - 1].start_sec).length;
  return tracks.length >= 3 && forward >= tracks.length * 0.8 ? tracks : [];
}

/** Best tracklist in yt-dlp info JSON: chapters, description, or the comment with most timed lines (pinned/likes break ties). */
export function bestYoutubeTracklist(info) {
  const cands = [];
  const ch = (info.chapters || []).filter(c => c.title);
  if (ch.length >= 3) cands.push({ from: 'hoofdstukken', tracks: ch.map(c => ({ start_sec: Math.round(c.start_time), ...splitName(c.title) })).map(t => ({ ...t, unknown: isUnknown(t.artist, t.title) })), rank: 1e9 });
  const d = parseTimedLines(info.description);
  if (d.length) cands.push({ from: 'beschrijving', tracks: d, rank: d.length * 1000 + 500 });
  for (const c of info.comments || []) {
    const t = parseTimedLines(c.text);
    if (t.length) cands.push({ from: 'comment', tracks: t, rank: t.length * 1000 + (c.is_pinned ? 900 : 0) + Math.min(400, c.like_count || 0) });
  }
  return cands.sort((a, b) => b.rank - a.rank)[0] || null;
}

/** MixesDB wikitext: "# [mmm] Artist - Title [Label]" (minutes, or h:mm:ss / mm:ss); "?" = unknown. */
export function parseMixesdb(raw) {
  const tracks = [];
  for (const line of String(raw || '').split(/\r?\n/)) {
    const m = /^#\s*\[([\d:]+)\]\s*(.*)$/.exec(line.trim());
    if (!m) continue; // lines without a time can't be placed on the timeline
    const start_sec = m[1].includes(':') ? toSec(m[1]) : +m[1] * 60;
    const name = m[2].replace(/\s*\[[^\]]*\]\s*$/, '').trim();
    const { artist, title } = splitName(name);
    tracks.push({ start_sec, artist, title, unknown: isUnknown(artist, title) });
  }
  return tracks;
}

// ---------------------------------------------------------------- collection index bookkeeping

export function indexedFiles(id) {
  try { return JSON.parse(readFileSync(join(indexDir(id), 'files.json'), 'utf8')); } catch { return {}; }
}
const saveIndexed = (id, files) => writeFileSync(join(indexDir(id), 'files.json'), JSON.stringify(files));

/** All audio files under the given roots (recursive, skips dot-folders). */
export function walkAudio(roots) {
  const out = [];
  const walk = (dir) => {
    let ents; try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.name.startsWith('.')) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && AUDIO_EXT.has(extname(e.name).toLowerCase())) out.push(p);
    }
  };
  for (const r of roots) walk(resolve(r));
  return out;
}

/** Status for local (own collection) methods: tool first, then index. */
function localStatus(id, toolOk, installMsg) {
  if (!toolOk) return { state: 'tool', msg: 'Niet geïnstalleerd', install: installMsg };
  const n = Object.keys(indexedFiles(id)).length;
  return n ? { state: 'ok', msg: `Klaar · ${n} tracks in index` } : { state: 'index', msg: 'Index leeg — bouw de index onder Collectie' };
}

/** Shared recognize() for local engines: run the query, parse, look up tags of the matched file. */
async function localRecognize(m, ctx, cfg) {
  let hit;
  if (m.local.queryFn) hit = await m.local.queryFn(ctx.wavBuf(), cfg, ctx.signal); // HTTP worker (NAFP)
  else {
    const [cmd, args, env] = m.local.query(ctx.wav(), cfg);
    const r = await api.run(cmd, args, { env, signal: ctx.signal, timeout: 60_000 });
    if (r.code !== 0 && !r.stdout) throw new MethodError(errLine(r));
    hit = m.local.parse(r.stdout, cfg);
  }
  if (!hit || hit.score < (+cfg.minScore || 0)) return null;
  let path = hit.path;
  if (!existsSync(path)) { // some tools return only the stem → map back via our own index list
    const stem = basename(path, extname(path));
    path = Object.keys(indexedFiles(m.id)).find(f => basename(f, extname(f)) === stem) || path;
  }
  return { ...tagsOf(path), method: m.label, score: hit.score, ...(Number.isFinite(hit.offset) && { offset: hit.offset }) };
}

// ---------------------------------------------------------------- NAFP worker (separate container, HTTP)

/** GET <url>/health synchronously (status() is sync): a tiny node subprocess with a 3 s timeout, cached 60 s. */
function workerHealth(url) {
  return cached(`nafp:${url}`, () => {
    const js = `fetch(${JSON.stringify(String(url).replace(/\/$/, '') + '/health')}, { signal: AbortSignal.timeout(3000) }).then(r => r.text()).then(t => process.stdout.write(t)).catch(() => {})`;
    try { return JSON.parse(spawnSync(process.execPath, ['-e', js], { encoding: 'utf8', timeout: 5000, windowsHide: true }).stdout); } catch { return null; }
  });
}

function nafpMethod(id, label, model, tip, minDefault = 0.3, useOffset = true) {
  const base = (cfg) => String(cfg.url || '').replace(/\/$/, '');
  const call = async (cfg, path, body, headers, signal) => {
    const r = await fetch(`${base(cfg)}${path}?model=${model}`, { method: 'POST', body, headers, signal });
    const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
    if (!r.ok) throw new MethodError(`${label}-worker: ${j?.error || `HTTP ${r.status}`}`);
    return j;
  };
  return {
    id, label, group: 'recognize', kind: 'Eigen collectie', tip,
    fields: [
      { key: 'url', label: 'Worker-URL', type: 'text', default: 'http://setscout-nafp:8099', tip: 'Adres van de container setscout-nafp binnen de compose-app. Lokaal zonder Docker niet beschikbaar.' },
      MIN(minDefault, 'Aandeel (0–1) van de 0,5 s-stukjes van het fragment dat op hetzelfde nummer én tijdstip uitkomt. Hoger = strenger. Nog niet afgesteld op echte DJ-sets; stel bij na de eerste scans.'),
    ],
    status(c) {
      const h = workerHealth(c.url);
      if (!h?.ok) return { state: 'tool', msg: 'Worker niet bereikbaar', install: 'Voeg de service setscout-nafp toe aan je TrueNAS-YAML (zie README, image ghcr.io/mess023/setscout-nafp) en controleer de Worker-URL.' };
      return localStatus(id, true, '');
    },
    local: {
      batch: 5, // one HTTP request per 5 files: embedding on CPU takes a few seconds per track
      async indexFn(files, cfg, signal) { await call(cfg, '/index', JSON.stringify({ files }), { 'Content-Type': 'application/json' }, signal); },
      async queryFn(wavBuf, cfg, signal) {
        const j = await call(cfg, '/query', wavBuf, { 'Content-Type': 'audio/wav' }, signal);
        return j && j.path ? { path: j.path, score: +j.score || 0, ...(useOffset && { offset: +j.offset }) } : null;
      },
    },
  };
}

// ---------------------------------------------------------------- the methods

const KEY = (label = 'API-sleutel', tip = '') => ({ key: 'apiKey', label, type: 'secret', tip });
const MIN = (def, tip) => ({ key: 'minScore', label: 'Drempel', type: 'number', default: def, tip });
const PY = { key: 'python', label: 'Python', type: 'text', default: '', tip: 'Leeg = automatisch: .venv in de app-map, anders python3/python op het PATH.' };

export const METHODS = [
  // ---------- recognize: cloud ----------
  {
    id: 'shazam', label: 'Shazam', group: 'recognize', kind: 'Cloud',
    tip: 'Shazam via het npm-pakket shazam-api (onofficieel). Gratis, geen sleutel; bij te veel verzoeken wacht Setscout automatisch (backoff).',
    fields: [],
    status: () => ({ state: 'ok', msg: 'Klaar' }),
    recognize: async (ctx) => { const r = await api.shazam(ctx.pcm); return r && { ...r, method: 'Shazam' }; },
  },
  {
    id: 'shazam-pitch', label: 'Shazam gepitcht', group: 'recognize', kind: 'Cloud',
    tip: 'DJ\'s draaien tracks vaak sneller of langzamer (pitch-fader). Setscout pitcht het fragment met ffmpeg terug (omlaag) en omhoog en vraagt Shazam opnieuw. Kost per mislukt fragment extra Shazam-verzoeken.',
    fields: [
      { key: 'percents', label: 'Percentages', type: 'text', default: '2,4,6', tip: 'Komma-gescheiden. Elk percentage wordt eerst omlaag (−) en dan omhoog (+) geprobeerd.' },
      { key: 'mode', label: 'Modus', type: 'select', default: 'both', options: [['both', 'Beide (vinyl + keylock)'], ['vinyl', 'Vinyl (toon + tempo)'], ['keylock', 'Keylock (alleen tempo)']], tip: 'Vinyl: toonhoogte en tempo veranderen samen, zoals een pitch-fader zonder keylock/master tempo, of een plaat (asetrate). Keylock: alleen het tempo verandert, de toon blijft gelijk, zoals CDJ-spelers met master tempo aan (atempo). Beide: per percentage eerst vinyl, dan keylock — dubbel zoveel Shazam-verzoeken bij een mislukt fragment.' },
      { key: 'pauseMs', label: 'Pauze (ms)', type: 'number', default: 1500, tip: 'Wachttijd tussen twee Shazam-verzoeken, tegen de ratelimit (maximum aantal verzoeken per tijd).' },
    ],
    status: () => hasCommand('ffmpeg') ? { state: 'ok', msg: 'Klaar' } : { state: 'tool', msg: 'ffmpeg ontbreekt', install: 'Installeer ffmpeg (Windows: winget install Gyan.FFmpeg)' },
    async recognize(ctx, cfg) {
      const pcts = String(cfg.percents || '').split(/[,\s]+/).map(Number).filter(p => p > 0 && p < 50);
      const modes = cfg.mode === 'both' ? ['vinyl', 'keylock'] : [cfg.mode === 'keylock' ? 'keylock' : 'vinyl'];
      for (const p of pcts) for (const sign of [-1, 1]) for (const mode of modes) {
        if (ctx.signal?.aborted) return null;
        const f = 1 + sign * p / 100;
        const af = mode === 'keylock' ? `atempo=${f}` : `asetrate=${Math.round(16000 * f)},aresample=16000`;
        const r = spawnSync('ffmpeg', ['-v', 'quiet', '-f', 's16le', '-ar', '16000', '-ac', '1', '-i', ctx.segPath, '-af', af, '-f', 's16le', '-ac', '1', '-ar', '16000', 'pipe:1'], { maxBuffer: 64 << 20, windowsHide: true });
        if (r.status !== 0) throw new MethodError('ffmpeg kon het fragment niet pitchen');
        await sleep(+cfg.pauseMs || 0);
        const m = await api.shazam(r.stdout);
        if (m) return { ...m, method: `Shazam ${sign < 0 ? '−' : '+'}${p}%${modes.length > 1 ? ` ${mode}` : ''}`, pitch: sign * p, stretch: f, pitchMode: mode }; // stretch: mix s per query s
      }
      return null;
    },
  },
  {
    id: 'audd', label: 'AudD', group: 'recognize', kind: 'Cloud',
    tip: 'AudD (audd.io) REST-API. 300 gratis verzoeken bij aanmelden, daarna betaald (vanaf $5 per 1.000). Elk fragment = 1 verzoek.',
    fields: [KEY('API-token', 'Te vinden op dashboard.audd.io. Wordt alleen op de server bewaard (data/settings.json).')],
    status: (c) => c.apiKey ? { state: 'ok', msg: 'Klaar' } : { state: 'key', msg: 'Sleutel ontbreekt', install: 'Aanmelden op dashboard.audd.io (300 gratis verzoeken) → API-token kopiëren en hier plakken.' },
    async recognize(ctx, cfg) {
      const j = await fetchJson('https://api.audd.io/', { method: 'POST', body: fileForm({ api_token: cfg.apiKey }, ctx.wavBuf()) }, ctx.signal);
      if (j.status === 'error') {
        const code = j.error?.error_code;
        throw new MethodError(`AudD fout ${code}: ${j.error?.error_message || ''}`.trim(), code === 900 || code === 901 || code === 902);
      }
      const r = j.result;
      return r && r.title ? { artist: r.artist || '', title: r.title, album: r.album || '', year: String(r.release_date || '').slice(0, 4), label: r.label || '', method: 'AudD', ...(/^\d+:\d\d$/.test(r.timecode || '') && { offset: r.timecode.split(':').reduce((a, x) => a * 60 + +x, 0) }) } : null;
    },
  },
  {
    id: 'audiotag', label: 'AudioTag.info', group: 'recognize', kind: 'Cloud',
    tip: 'AudioTag.info REST-API: uploaden, daarna resultaat ophalen (pollen). 3 uur audio per maand gratis; elk fragment telt mee.',
    fields: [KEY('API-sleutel', 'Te vinden onder je account op user.audiotag.info.'), { key: 'maxPolls', label: 'Max. pogingen', type: 'number', default: 30, tip: 'Hoe vaak (1× per seconde) Setscout naar het resultaat vraagt voordat het fragment als niet herkend telt.' }],
    status: (c) => c.apiKey ? { state: 'ok', msg: 'Klaar' } : { state: 'key', msg: 'Sleutel ontbreekt', install: 'Account maken op user.audiotag.info → API-sleutel kopiëren en hier plakken.' },
    async recognize(ctx, cfg) {
      const URL_ = 'https://audiotag.info/api';
      let j = await fetchJson(URL_, { method: 'POST', body: fileForm({ action: 'identify', apikey: cfg.apiKey, start_time: 0, time_len: Math.round(ctx.segment) }, ctx.wavBuf()) }, ctx.signal);
      if (!j.success) throw new MethodError(`AudioTag: ${j.error || 'upload geweigerd'}`, /key|limit|quota/i.test(j.error || ''));
      let status = j.job_status || j.result;
      for (let i = 0; status === 'wait' && i < (+cfg.maxPolls || 30); i++) {
        await sleep(1000);
        j = await fetchJson(URL_, { method: 'POST', body: new URLSearchParams({ action: 'get_result', token: j.token, apikey: cfg.apiKey }) }, ctx.signal);
        status = j.result;
      }
      const t = status === 'found' && j.data?.[0]?.tracks?.[0];
      if (!t) return null;
      // Docs (PDF) not machine-readable here: tracks are [title, artist, album, year] or an object — accept both.
      const [title, artist, album, year] = Array.isArray(t) ? t : [t.track_name || t.title, t.artist_name || t.artist, t.album_name || t.album, t.year];
      return title ? { artist: artist || '', title, album: album || '', year: String(year || ''), method: 'AudioTag' } : null;
    },
  },
  // ---------- recognize: own collection ----------
  {
    id: 'olaf', label: 'Olaf', group: 'recognize', kind: 'Eigen collectie',
    tip: 'Olaf (JorenSix, AGPL-3.0): landmark-fingerprinting in C. Indexeert jouw muziekmappen in data/index/olaf en zoekt fragmenten daarin terug. Offline, snel.',
    fields: [{ key: 'cmd', label: 'Programma', type: 'text', default: WIN ? 'tools/olaf/olaf.exe' : 'olaf', tip: 'Pad naar olaf(.exe) of de naam op het PATH.' }, MIN(10, 'Minimaal aantal overeenkomende fingerprints (match_count). Lager = meer treffers, meer missers.')],
    status(c) { return localStatus('olaf', toolPath(c.cmd), 'Windows: download olaf_cli-windows-x86_64.zip (v3.3.3) van github.com/JorenSix/Olaf/releases en pak uit in tools\\olaf\\. Docker: zit in de image.'); },
    // Olaf keeps its LMDB under ~/.olaf → point HOME/USERPROFILE at our index dir so it stays in data/.
    local: {
      env: () => ({ HOME: indexDir('olaf'), USERPROFILE: indexDir('olaf') }),
      index(files, cfg, threads) { return [toolPath(cfg.cmd), ['store', '--threads', String(threads), ...files], this.env()]; },
      query(wav, cfg) { return [toolPath(cfg.cmd), ['query', '--format', 'json', wav], this.env()]; },
      parse(out) {
        let best = null;
        let whole; try { whole = [].concat(JSON.parse(out)); } catch {}
        for (const line of whole || out.split('\n')) {
          let j; try { j = typeof line === 'object' ? line : JSON.parse(line); } catch { // CSV fallback: …, match_count(4), …, path(7), …
            const c = line.split(',').map(s => s.trim());
            if (c.length >= 11 && +c[4] > 0) j = { matches: [{ match_count: +c[4], path: c[7], query_start: +c[5], reference_start: +c[9] }] };
          }
          for (const m of j?.matches || []) if (m.path && (!best || m.match_count > best.score)) best = { path: m.path, score: m.match_count, offset: m.reference_start - m.query_start };
        }
        return best;
      },
    },
  },
  {
    id: 'audfprint', label: 'audfprint', group: 'recognize', kind: 'Eigen collectie',
    tip: 'audfprint (Dan Ellis, MIT, Python): landmark-fingerprinting. Indexeert jouw muziekmappen in data/index/audfprint/fp.pklz. Gekozen variant: het origineel dpwe/audfprint (zie rapport).',
    fields: [{ key: 'script', label: 'audfprint.py', type: 'text', default: 'tools/audfprint/audfprint.py', tip: 'Pad naar audfprint.py uit github.com/dpwe/audfprint.' }, PY, MIN(20, 'Minimaal aantal gemeenschappelijke hashes. Ter vergelijking: WerZatSong rekent ≥25 als zwak, ≥70 als zeker.')],
    status(c) {
      const py = pythonCmd(c);
      return localStatus('audfprint', py && existsSync(resolve(ROOT, c.script || '')) && pyHas(py, 'numpy, scipy, docopt, joblib'),
        '.venv: py -3 -m venv .venv  →  .venv\\Scripts\\pip install numpy scipy docopt joblib psutil; dpwe/audfprint uitpakken in tools\\audfprint\\. Docker: zit in de image.');
    },
    local: {
      db: () => join(indexDir('audfprint'), 'fp.pklz'),
      index(files, cfg, threads) { return [pythonCmd(cfg), [resolve(ROOT, cfg.script), existsSync(this.db()) ? 'add' : 'new', '--dbase', this.db(), '--ncores', String(threads), ...files]]; },
      query(wav, cfg) { return [pythonCmd(cfg), [resolve(ROOT, cfg.script), 'match', '--dbase', this.db(), '--max-matches', '1', wav]]; },
      parse(out) {
        const m = / as (.+?) at\s+(-?[\d.]+)\s*s(?:ec)? with\s+(\d+) of/.exec(out);
        return m && { path: m[1].trim(), score: +m[3], offset: +m[2] }; // `at X s`: reference time at query start
      },
    },
  },
  {
    id: 'panako', label: 'Panako', group: 'recognize', kind: 'Eigen collectie',
    tip: 'Panako (JorenSix, AGPL-3.0, Java 17): herkent ook bij ±10 % pitch/tempo — handig bij DJ-sets. Indexeert jouw muziekmappen. Officieel niet ondersteund op Windows; draait in de Docker-image.',
    fields: [{ key: 'cmd', label: 'Programma', type: 'text', default: WIN ? 'tools/panako/panako.jar' : 'panako', tip: 'Pad naar Panako-…-all.jar (wordt met java -jar gestart) of de naam van een startscript op het PATH.' }, MIN(10, 'Minimale Panako-score (aantal overeenkomende fingerprints).')],
    status(c) {
      const t = toolPath(c.cmd);
      const ok = t && (!/\.jar$/i.test(t) || javaMajor() >= 17);
      return localStatus('panako', ok, `Java 17+ nodig (gevonden: ${javaMajor() || 'geen'}). Windows wordt niet ondersteund door Panako; gebruik de Docker-image.`);
    },
    local: {
      // Java ignores $HOME for ~ → user.home via JAVA_TOOL_OPTIONS so ~/.panako lands in data/index/panako.
      // Java 17+: Panako's LMDB binding needs java.nio opened (JDK_JAVA_OPTIONS reaches the java launcher).
      env: () => ({
        HOME: indexDir('panako'), JAVA_TOOL_OPTIONS: `-Duser.home=${indexDir('panako')}`,
        JDK_JAVA_OPTIONS: '--add-opens=java.base/java.nio=ALL-UNNAMED --add-opens=java.base/sun.nio.ch=ALL-UNNAMED',
      }),
      // STRATEGY=PANAKO: the pitch/tempo-tolerant strategy; Panako's default (OLAF) would duplicate the Olaf method
      cmd(cfg, args) { const t = toolPath(cfg.cmd), a = ['STRATEGY=PANAKO', ...args]; return /\.jar$/i.test(t) ? ['java', ['-jar', t, ...a], this.env()] : [t, a, this.env()]; },
      index(files, cfg) { return this.cmd(cfg, ['store', ...files]); },
      query(wav, cfg) { return this.cmd(cfg, ['query', wav]); },
      parse(out) { // Index;Total;Query path;Query start;Query stop;Match path;Match id;Match start;Match stop;Match score;…
        let best = null;
        for (const line of out.split('\n')) {
          const c = line.split(';').map(s => s.trim());
          if (c.length >= 10 && c[5] && c[5] !== 'null' && !isNaN(+c[9]) && (!best || +c[9] > best.score)) best = { path: c[5], score: +c[9], offset: +c[7] - +c[3] };
        }
        return best;
      },
    },
  },
  {
    id: 'dejavu', label: 'Dejavu', group: 'recognize', kind: 'Eigen collectie',
    tip: 'Dejavu (bcollazo-fork van worldveil/dejavu, MIT, Python): landmark-fingerprinting van jouw muziekmappen. Deze fork gebruikt SQLAlchemy, dus de index is één SQLite-bestand in data/index/dejavu — geen databaseserver nodig. De code is uit 2020; de Docker-image past hem aan voor Python 3.13 en numpy 2 en test hem bij het bouwen.',
    fields: [
      { key: 'home', label: 'Dejavu-map', type: 'text', default: WIN ? 'tools/dejavu' : '/opt/dejavu', tip: 'Map met de dejavu-broncode (bcollazo/dejavu). In de Docker-image: /opt/dejavu.' },
      PY, MIN(10, 'Minimaal aantal in tijd uitgelijnde hashes (Dejavu-"confidence"). Lager = meer treffers, meer missers.'),
    ],
    status(c) {
      const py = pythonCmd(c);
      return localStatus('dejavu', py && existsSync(join(resolve(ROOT, c.home || ''), 'dejavu', '__init__.py')) && pyHas(py, 'sqlalchemy, sqlalchemy_utils, pydub, matplotlib, tenacity, scipy'),
        'Docker: zit in de image. Lokaal: bcollazo/dejavu (commit 11be7f1) in tools\\dejavu\\ + pip install matplotlib pydub audioop-lts SQLAlchemy sqlalchemy-utils tenacity six scipy (en de patches uit de Dockerfile).');
    },
    local: {
      db: () => join(indexDir('dejavu'), 'dejavu.sqlite'),
      env: (cfg) => ({ DEJAVU_HOME: resolve(ROOT, cfg.home || ''), MPLBACKEND: 'Agg', DEJAVU_TMP: join(indexDir('dejavu'), 'tmp') }),
      index(files, cfg) { return [pythonCmd(cfg), [join(ROOT, 'tools', 'dejavu_cli.py'), 'index', this.db(), ...files], this.env(cfg)]; },
      query(wav, cfg) { return [pythonCmd(cfg), [join(ROOT, 'tools', 'dejavu_cli.py'), 'query', this.db(), wav], this.env(cfg)]; },
      parse(out) {
        let j; try { j = JSON.parse(out.trim().split('\n').pop()); } catch { return null; }
        return j && j.path ? { path: j.path, score: +j.confidence || 0, offset: +j.offset } : null;
      },
    },
  },
  nafpMethod('nafp', 'NeuralFP (NAFP)', 'neuralfp',
    'Neural audio fingerprinting (Chang e.a., ICASSP 2021) met het pretrained NeuralFP-model: een neuraal netwerk maakt per seconde audio een vingerafdruk (128 getallen); fragmenten worden in een FAISS-index van jouw collectie gezocht. Draait in de aparte container setscout-nafp (TensorFlow, CPU). Code CC BY-NC-SA 4.0 (niet-commercieel).'),
  nafpMethod('peaknetfp', 'PeakNetFP', 'peaknetfp',
    'PeakNetFP (Cortès e.a., 2025): neurale fingerprinting op spectrale pieken, gemaakt om bestand te zijn tegen sterke tempo-/pitchwijziging — interessant voor DJ-sets. Zelfde aparte container setscout-nafp als NeuralFP, eigen index. In de synthetische test vond hij het juiste bestand maar minder precies de tijd dan NeuralFP; zet NeuralFP daarom hoger in de keten. Experimenteel: zijn tijdstip (offset) wordt nog niet gebruikt voor Van/Tot. Code CC BY-NC-SA 4.0 (niet-commercieel).', 0.15, false),
  {
    id: 'acoustid', label: 'AcoustID', group: 'recognize', kind: 'Cloud',
    tip: 'AcoustID + Chromaprint (fpcalc). Gratis voor niet-commercieel gebruik, max. 3 verzoeken/s. Let op: AcoustID is gemaakt voor HELE tracks; volgens de eigen FAQ herkent het geen korte fragmenten. Verwacht weinig treffers in een mix.',
    fields: [KEY('Client-key', 'Gratis aan te vragen op acoustid.org/new-application.'), { key: 'fpcalc', label: 'fpcalc', type: 'text', default: WIN ? 'tools/fpcalc/fpcalc.exe' : 'fpcalc', tip: 'Pad naar fpcalc (Chromaprint) of de naam op het PATH.' }, MIN(0.5, 'Minimale AcoustID-score (0–1).')],
    status(c) {
      if (!toolPath(c.fpcalc)) return { state: 'tool', msg: 'fpcalc niet geïnstalleerd', install: 'Windows: chromaprint-fpcalc-1.6.2-windows-x86_64.zip uitpakken in tools\\fpcalc\\. Docker: zit in de image (libchromaprint-tools).' };
      return c.apiKey ? { state: 'ok', msg: 'Klaar' } : { state: 'key', msg: 'Sleutel ontbreekt', install: 'Gratis client-key aanvragen op acoustid.org/new-application en hier plakken.' };
    },
    async recognize(ctx, cfg) {
      const r = await api.run(toolPath(cfg.fpcalc), ['-json', ctx.wav()], { signal: ctx.signal });
      let fp; try { fp = JSON.parse(r.stdout); } catch { throw new MethodError('fpcalc gaf geen fingerprint'); }
      const j = await fetchJson('https://api.acoustid.org/v2/lookup', { method: 'POST', body: new URLSearchParams({ client: cfg.apiKey, duration: Math.round(fp.duration), fingerprint: fp.fingerprint, meta: 'recordings', format: 'json' }) }, ctx.signal);
      if (j.status !== 'ok') throw new MethodError(`AcoustID: ${j.error?.message || 'fout'}`, /key/i.test(j.error?.message || ''));
      const hit = (j.results || []).find(x => x.score >= (+cfg.minScore || 0) && x.recordings?.[0]?.title);
      const rec = hit?.recordings[0];
      return rec ? { artist: (rec.artists || []).map(a => a.name).join(', '), title: rec.title, album: '', year: '', method: 'AcoustID', score: hit.score } : null;
    },
  },
  // ---------- reference tracklists ----------
  {
    id: 'trackid', label: 'trackid.dev', group: 'reference', kind: 'Referentie',
    tip: 'trackid.dev maakt gratis een tracklist van een YouTube-mix (Chromaprint/AcoustID). Werkt alleen als de bestandsnaam een YouTube-ID bevat, zoals yt-dlp die maakt: "… [AbCdEfGhIjK].webm". Max. 10 verzoeken per 15 min. Staat hij bovenaan in de keten, dan wacht de scan op de tracklist (kan minuten duren); lager in de keten vult hij wat de methodes erboven niet vonden.',
    fields: [{ key: 'timeoutMin', label: 'Max. wachttijd (min)', type: 'number', default: 20, tip: 'trackid.dev verwerkt de hele mix; daarna geeft Setscout het op.' }],
    status: () => ({ state: 'ok', msg: 'Klaar (alleen bij YouTube-ID in de bestandsnaam)' }),
    async tracklist(file, cfg, signal) {
      const id = /\[([\w-]{11})\]/.exec(basename(file))?.[1];
      if (!id) throw new MethodError('geen YouTube-ID in de bestandsnaam');
      const job = await fetchJson('https://trackid.dev/api/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: `https://www.youtube.com/watch?v=${id}` }) }, signal);
      if (!job.jobId) throw new MethodError(`trackid.dev: ${job.error || 'geen job aangemaakt'}`);
      const until = Date.now() + (+cfg.timeoutMin || 20) * 60_000;
      while (Date.now() < until) {
        await sleep(10_000);
        const j = await fetchJson(`https://trackid.dev/api/job/${job.jobId}`, {}, signal);
        if (j.status === 'failed') throw new MethodError(`trackid.dev: ${j.error || 'analyse mislukt'}`);
        if (j.status === 'completed') return (j.tracks || []).map(t => ({ start_sec: +t.timestamp, artist: t.artist || '', title: t.title || '', unknown: Boolean(t.isUnknown || !t.title) }));
      }
      throw new MethodError('trackid.dev: time-out');
    },
  },
  {
    id: '1001tl', label: '1001Tracklists', group: 'reference', kind: 'Referentie',
    tip: 'Zoekt op 1001tracklists.com naar de setnaam (via het zoekformulier van de site) en neemt de tracklist met cue-tijden over. Beperkt: zoeken werkt, maar 1001Tracklists zet tracklistpagina’s achter een Cloudflare-botcheck (Turnstile); dan kan Setscout de tracks niet lezen en toont de scanlog de gevonden link. Geen officiële API; mogelijk niet binnen hun gebruiksvoorwaarden (ToS-risico). Bovenaan in de keten: de tracklist wordt eerst overgenomen (Van = cue-tijd) en alleen "ID"-tracks en stukken zonder cue gaan naar de methodes eronder.',
    fields: [{ key: 'query', label: 'Zoekterm', type: 'text', default: '', tip: 'Leeg = bestandsnaam van de set (zonder extensie en YouTube-ID).' }],
    status: () => ({ state: 'ok', msg: 'Beperkt: tracklistpagina’s vaak achter botcheck' }),
    async tracklist(file, cfg, signal) {
      // Search like the site's own form: POST /search/result.php (a GET only returns the empty search shell),
      // with the cookies from the homepage and a Referer, as a browser sends them.
      const BASE = 'https://www.1001tracklists.com';
      const q = cleanQuery(file, cfg);
      const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36', 'Accept-Language': 'en', Accept: 'text/html,application/xhtml+xml' };
      const home = await fetch(BASE + '/', { headers, signal });
      const cookie = (home.headers?.getSetCookie?.() || []).map(c => c.split(';')[0]).join('; ');
      if (cookie) headers.Cookie = cookie;
      const blocked = (html) => /you will be forwarded|captcha|cf-chl|turnstile/i.test(html);
      const s = await (await fetch(BASE + '/search/result.php', {
        method: 'POST', signal, body: new URLSearchParams({ main_search: q, search_selection: '9' }),
        headers: { ...headers, Referer: BASE + '/', 'Content-Type': 'application/x-www-form-urlencoded' },
      })).text();
      if (blocked(s)) throw new MethodError('zoekpagina geblokkeerd (anti-bot)');
      // the search is fuzzy: rank result links by how many search words appear in their slug
      const best = rankByWords(q, [...new Set([...s.matchAll(/href="(\/tracklist\/[^"]+?\.html)"/g)].map(m => m[1]))])[0];
      if (!best?.ok) throw new MethodError(`geen passende tracklist gevonden voor "${q}"${best ? ` (beste gok: ${BASE}${best.item})` : ''} — pas zo nodig de Zoekterm aan (DJ + event)`);
      const link = best.item;
      const html = await (await fetch(BASE + link, { headers: { ...headers, Referer: BASE + '/search/result.php' }, signal })).text();
      // Tracklist pages sit behind a Cloudflare Turnstile bot check (a JS challenge a real browser solves);
      // Setscout does not try to get past that — report the page so the user can open it.
      if (/turnstile|challenges\.cloudflare\.com/i.test(html)) throw new MethodError(`tracklist gevonden (${BASE}${link}), maar 1001Tracklists beschermt tracklistpagina's met een Cloudflare-botcheck (Turnstile) die Setscout niet automatisch kan doorlopen`);
      if (blocked(html)) throw new MethodError('tracklistpagina geblokkeerd (anti-bot doorstuurpagina)');
      const tracks = [];
      for (const chunk of html.split(/class="[^"]*tlpItem/).slice(1)) {
        const name = /itemprop="name" content="([^"]+)"/.exec(chunk)?.[1];
        const cue = /cueValueField[^>]*>\s*([\d:]+)/.exec(chunk)?.[1];
        if (!name || !cue) continue;
        const [artist, ...title] = name.replace(/&amp;/g, '&').replace(/&#0?39;/g, "'").split(' - ');
        tracks.push({ start_sec: cue.split(':').reduce((a, x) => a * 60 + +x, 0), artist, title: title.join(' - '), unknown: /^id$/i.test(title.join(' - ').trim()) });
      }
      if (!tracks.length) throw new MethodError('tracklist gevonden maar zonder leesbare tracks met cue-tijden');
      return tracks;
    },
  },
  {
    id: 'youtube', label: 'YouTube-tracklist', group: 'reference', kind: 'Referentie',
    tip: 'Haalt de tracklist uit de YouTube-video van de set: hoofdstukken, de beschrijving of de comment met de meeste regels "mm:ss Artiest - Titel" (vaak een vastgepinde of veel gelikete reactie). Gebruikt het YouTube-ID uit de bestandsnaam (zoals yt-dlp die maakt: "… [abcdefghijk].webm"), anders zoekt hij de set op YouTube op naam. Open bron, geen account nodig. Bovenaan in de keten: tracklist eerst overnemen (Van = tijdstempel), alleen gaten en "ID"-tracks gaan naar de methodes eronder.',
    fields: [
      { key: 'ytdlp', label: 'yt-dlp', type: 'text', default: 'yt-dlp', tip: 'Pad of naam van yt-dlp. In de Docker-image aanwezig (met Deno voor YouTube).' },
      { key: 'query', label: 'Zoekterm', type: 'text', default: '', tip: 'Alleen gebruikt als de bestandsnaam geen YouTube-ID bevat. Leeg = bestandsnaam van de set.' },
      { key: 'maxComments', label: 'Max. comments', type: 'number', default: 300, tip: 'Hoeveel top-comments yt-dlp ophaalt om een tracklist in te zoeken. Meer = trager.' },
    ],
    status: (c) => toolPath(c.ytdlp) ? { state: 'ok', msg: 'Klaar' } : { state: 'tool', msg: 'yt-dlp niet gevonden', install: 'Docker: zit in de image. Windows: winget install yt-dlp.yt-dlp (plus Deno voor YouTube).' },
    async tracklist(file, cfg, signal) {
      const id = /\[([\w-]{11})\]/.exec(basename(file))?.[1];
      const target = id ? `https://www.youtube.com/watch?v=${id}` : `ytsearch1:${cleanQuery(file, cfg)}`;
      const r = await api.run(toolPath(cfg.ytdlp), ['-j', '--skip-download', '--no-playlist', '--no-warnings', '--write-comments',
        '--extractor-args', `youtube:max_comments=${Math.max(0, +cfg.maxComments || 0)},${Math.max(0, +cfg.maxComments || 0)},0,0;comment_sort=top`, target],
        { signal, timeout: 5 * 60_000 });
      let info; try { info = JSON.parse(r.stdout.trim().split('\n')[0]); } catch { throw new MethodError(`yt-dlp: ${errLine(r)}`); }
      const best = bestYoutubeTracklist(info);
      if (!best) throw new MethodError(`geen tracklist met tijden gevonden bij "${info.title || id}" (hoofdstukken, beschrijving, ${(info.comments || []).length} comments)`);
      return best.tracks;
    },
  },
  {
    id: 'mixesdb', label: 'MixesDB', group: 'reference', kind: 'Referentie',
    tip: 'Zoekt de set op MixesDB (open wiki met DJ-mixen, sterk in house/techno) via de officiële MediaWiki-API en neemt de tracklist over: regels "[mm] Artiest - Titel". Tracks zonder tijd kunnen niet op een tijdstip geplaatst worden. Bovenaan in de keten: tracklist eerst overnemen, alleen gaten en "?"-tracks gaan naar de methodes eronder.',
    fields: [{ key: 'query', label: 'Zoekterm', type: 'text', default: '', tip: 'Leeg = bestandsnaam van de set. MixesDB-titels zien eruit als "2015-06-28 - andhim @ Awakenings Festival, Amsterdam".' }],
    status: () => ({ state: 'ok', msg: 'Klaar' }),
    async tracklist(file, cfg, signal) {
      const API = 'https://www.mixesdb.com/w/api.php', UA = { 'User-Agent': 'Setscout/1.0 (https://github.com/mess023/Setscout)' };
      const q = cleanQuery(file, cfg);
      const j = await fetchJson(`${API}?action=query&list=search&srnamespace=0&srlimit=20&format=json&srsearch=${encodeURIComponent(q)}`, { headers: UA }, signal);
      const best = rankByWords(q, (j.query?.search || []).map(r => r.title))[0];
      if (!best?.ok) throw new MethodError(`geen passende mix gevonden voor "${q}"${best ? ` (beste gok: ${best.item})` : ''} — pas zo nodig de Zoekterm aan`);
      const raw = await (await fetch(`https://www.mixesdb.com/w/index.php?action=raw&title=${encodeURIComponent(best.item.replace(/ /g, '_'))}`, { headers: UA, signal })).text();
      const tracks = parseMixesdb(raw);
      if (tracks.filter(t => !t.unknown).length < 2) throw new MethodError(`"${best.item}" heeft geen tracklist met tijden`);
      return tracks;
    },
  },
  // ---------- enrich ----------
  {
    id: 'musicbrainz', label: 'MusicBrainz', group: 'enrich', kind: 'Verrijking',
    tip: 'Zoekt elke gevonden track op in MusicBrainz (open muziekdatabase) en vult album, jaar, ISRC (internationale opnamecode) en MBID (MusicBrainz-ID) aan. Herkent zelf niets. Max. 1 verzoek/s.',
    fields: [{ key: 'contact', label: 'Contact (e-mail)', type: 'text', default: '', tip: 'MusicBrainz vraagt een contactadres in de User-Agent. Optioneel.' }, MIN(90, 'Minimale zoekscore (0–100) om een resultaat over te nemen.')],
    status: () => ({ state: 'ok', msg: 'Klaar' }),
    async enrich(match, ctx, cfg) {
      const wait = 1100 - (Date.now() - (this.last || 0)); if (wait > 0) await sleep(wait);
      this.last = Date.now();
      const q = `recording:"${match.title.replace(/"/g, '')}" AND artist:"${match.artist.replace(/"/g, '')}"`;
      const j = await fetchJson(`https://musicbrainz.org/ws/2/recording?fmt=json&limit=1&query=${encodeURIComponent(q)}`, { headers: { 'User-Agent': `Setscout/1.0 ( ${cfg.contact || 'https://github.com/skip5this/mix-id'} )` } }, ctx.signal);
      const r = j.recordings?.[0];
      if (!r || r.score < (+cfg.minScore || 0)) return {};
      const rel = r.releases?.[0];
      return { mbid: r.id, isrc: r.isrcs?.[0] || '', album: match.album || rel?.title || '', year: match.year || String(rel?.date || '').slice(0, 4) };
    },
  },
  {
    id: 'essentia', label: 'Essentia (BPM/key)', group: 'enrich', kind: 'Analyse',
    tip: 'Essentia (MTG/UPF) analyseert het fragment van elke nieuwe track: BPM (tempo) en key (toonsoort). Herkent zelf niets. Python-wheels bestaan alleen voor Linux/macOS → praktisch alleen in de Docker-image.',
    fields: [PY],
    status(c) {
      const py = pythonCmd(c);
      return py && pyHas(py, 'essentia') ? { state: 'ok', msg: 'Klaar' } : { state: 'tool', msg: 'Niet geïnstalleerd', install: 'pip install essentia (alleen Linux/macOS). Docker: zit in de image. Windows: geen pip-wheel.' };
    },
    async enrich(match, ctx, cfg) {
      const r = await api.run(pythonCmd(cfg), [join(ROOT, 'tools', 'essentia_bpmkey.py'), ctx.wav()], { signal: ctx.signal, timeout: 60_000 });
      try { const j = JSON.parse(r.stdout); return { bpm: j.bpm, key: j.key }; } catch { throw new MethodError('Essentia: ' + (r.stderr.trim().split('\n').pop() || 'geen uitvoer')); }
    },
  },
  // ---------- recognize: Google via Android emulator (experimental) ----------
  {
    id: 'google', label: 'Google "Zoek een nummer"', group: 'recognize', kind: 'Emulator',
    tip: 'Experimenteel, geen officiële API. Setscout opent "Zoek een nummer" in de Google-app van een Android-emulator (container "android"), speelt het fragment af in de virtuele microfoon (PulseAudio) en leest het resultaat van het scherm (uiautomator). Kan breken bij elke update van de Google-app, en het Google-account kan gemarkeerd worden voor geautomatiseerd gebruik. Realtime: ±15–30 s per fragment. Zet hem achteraan in de keten.',
    fields: [
      { key: 'adb', label: 'adb', type: 'text', default: 'adb', tip: 'ADB (Android Debug Bridge): pad of naam op het PATH.' },
      { key: 'device', label: 'Emulator', type: 'text', default: 'android:5555', tip: 'ADB-adres (host:poort) van de emulator-container. Lokaal bijvoorbeeld 127.0.0.1:5555.' },
      { key: 'paplay', label: 'paplay', type: 'text', default: 'paplay', tip: 'PulseAudio-afspeler (pakket pulseaudio-utils) die het fragment naar de virtuele microfoon stuurt.' },
      { key: 'pulse', label: 'PulseAudio-server', type: 'text', default: 'tcp:android:4713', tip: 'PULSE_SERVER van de emulator-container. Daar staat de null-sink (virtuele audio-uitgang) waarvan de monitor de microfoon van de emulator is.' },
      { key: 'sink', label: 'Sink', type: 'text', default: 'virtmic', tip: 'Naam van de null-sink in de emulator-container.' },
      { key: 'action', label: 'Intent', type: 'text', default: 'com.google.android.googlequicksearchbox.MUSIC_SEARCH', tip: 'Android-intent die "Zoek een nummer" opent. Niet geverifieerd voor de Google-app van 2026; pas aan als het scherm niet opent.' },
      { key: 'second', label: 'Tweede mening voor remix', type: 'select', default: 'on', options: [['on', 'Aan'], ['off', 'Uit']], tip: 'Google noemt alleen artiest + titel, niet de remix. Staan er op de resultatenpagina meerdere versies ("versies?"), dan vraagt Setscout hetzelfde fragment ook aan de methodes hieronder (alleen als ze aan staan en nog niet geprobeerd zijn). Hun versienaam beslist. Kost 1 tot 3 extra verzoeken per zo’n Google-hit; AudD telt van je 300 gratis verzoeken, AudioTag van je 3 gratis uur per maand, Shazam gepitcht tot 6–12 Shazam-verzoeken.' },
      { key: 'secondAudd', label: '… vraag AudD', type: 'select', default: 'on', options: [['on', 'Ja'], ['off', 'Nee']], tip: 'Tweede mening via AudD (1 verzoek, van je AudD-tegoed).' },
      { key: 'secondAudiotag', label: '… vraag AudioTag', type: 'select', default: 'on', options: [['on', 'Ja'], ['off', 'Nee']], tip: 'Tweede mening via AudioTag.info (1 upload, telt mee voor je gratis uren).' },
      { key: 'secondPitch', label: '… vraag Shazam gepitcht', type: 'select', default: 'on', options: [['on', 'Ja'], ['off', 'Nee']], tip: 'Tweede mening via Shazam gepitcht (meerdere Shazam-verzoeken, langzamer).' },
      { key: 'pkg', label: 'App-pakket', type: 'text', default: 'com.google.android.googlequicksearchbox', tip: 'Android-pakket van de Google-app. Wordt vóór en na elk fragment afgesloten (force-stop), zodat een oud resultaat niet als nieuw gelezen wordt.' },
      { key: 'waitSec', label: 'Max. wachten (s)', type: 'number', default: 20, tip: 'Hoe lang na het afspelen naar een resultaat op het scherm wordt gezocht.' },
      { key: 'titleId', label: 'Titel-id', type: 'text', default: 'title', tip: 'Regex op de resource-id van het tekstveld met de titel. Lukt herkennen niet, dan toont de scanlog de zichtbare teksten met hun id; stel dit daarmee af.' },
      { key: 'artistId', label: 'Artiest-id', type: 'text', default: 'artist|subtitle', tip: 'Regex op de resource-id van het tekstveld met de artiest.' },
    ],
    status(c) {
      const adb = toolPath(c.adb);
      if (!adb) return { state: 'tool', msg: 'adb niet gevonden', install: 'Docker: zit in de image (pakket adb). Windows: Android platform-tools.' };
      if (!toolPath(c.paplay)) return { state: 'tool', msg: 'paplay ontbreekt', install: 'Docker: zit in de image (pulseaudio-utils). Op Windows niet beschikbaar: gebruik de Docker-opzet.' };
      const st = cached(`adb:${c.device}`, () => {
        spawnSync(adb, ['connect', c.device], { timeout: 5000, windowsHide: true });
        return (spawnSync(adb, ['-s', c.device, 'get-state'], { encoding: 'utf8', timeout: 5000, windowsHide: true }).stdout || '').trim();
      });
      return st === 'device' ? { state: 'ok', msg: 'Klaar · emulator verbonden' }
        : { state: 'tool', msg: 'Emulator niet bereikbaar', install: 'Start de emulator: docker compose --profile google up -d (vraagt /dev/kvm), en log één keer in met een Google-account — zie de stappen in docker/android/README.md.' };
    },
    async recognize(ctx, cfg) {
      const adb = (...a) => api.run(toolPath(cfg.adb), ['-s', cfg.device, ...a], { signal: ctx.signal, timeout: 30_000 });
      const dump = async () => parseSoundSearch((await adb('exec-out', 'uiautomator', 'dump', '/dev/tty')).stdout, cfg);
      const pkg = cfg.pkg || 'com.google.android.googlequicksearchbox';
      // Close the Google app completely before and after: otherwise the previous fragment's results page
      // (WebView — also the crash-prone part on a software GPU) is still there and gets read as the new result.
      const close = () => adb('shell', 'am', 'force-stop', pkg);
      await close();
      await adb('shell', 'am', 'start', '-a', cfg.action);
      await sleep(2500); // cold start after force-stop: let the listening screen open before the audio starts
      // A result only counts after we've seen the app in its listening state (no result on screen): then it comes
      // from THIS recognition. The same title as the previous fragment is fine — a track lasts several minutes.
      let listened = !(await dump()).title;
      try {
        const play = await api.run(toolPath(cfg.paplay), [`--server=${cfg.pulse}`, `--device=${cfg.sink}`, ctx.wav()], { signal: ctx.signal, timeout: 120_000 });
        if (play.code !== 0) throw new MethodError('paplay: ' + (play.stderr.trim().split('\n').pop() || `exit ${play.code}`));
        const until = Date.now() + (+cfg.waitSec || 20) * 1000;
        let seen = [];
        do {
          const r = await dump();
          if (!r.title) listened = true;
          else if (listened) return { artist: r.artist || '', title: r.title, album: '', year: '', method: 'Google', ...(r.versions?.length && { versions: r.versions.join(' | ') }) };
          seen = r.texts;
          await sleep(2000);
        } while (Date.now() < until && !ctx.signal?.aborted);
        throw new MethodError(listened
          ? `geen resultaat op het scherm; zichtbaar: ${seen.slice(0, 10).join(' | ') || '(niets)'}`
          : `geen nieuwe herkenning: het luisterscherm verscheen niet (oude pagina bleef staan; controleer de Intent); zichtbaar: ${seen.slice(0, 10).join(' | ')}`);
      } finally {
        await close().catch(() => {});
      }
    },
  },
  // ---------- not possible (shown with reason) ----------

];
export const byId = Object.fromEntries(METHODS.map(m => [m.id, m]));

// ---------------------------------------------------------------- settings ↔ methods

const DEFAULT_ON = new Set(['shazam']);

/** Settings merged with defaults: { order, methods: {id: cfg}, collection, export }. */
export function effectiveSettings(s = loadSettings()) {
  const order = (s.order || []).filter(id => byId[id]);
  for (const m of METHODS) if (!order.includes(m.id)) order.push(m.id);
  const methods = {};
  for (const m of METHODS) {
    const def = { enabled: DEFAULT_ON.has(m.id) };
    for (const f of m.fields) def[f.key] = f.default ?? '';
    methods[m.id] = { ...def, ...(s.methods?.[m.id] || {}) };
  }
  return { order, methods, collection: { roots: [], threads: 2, ...(s.collection || {}) }, export: { target: 'browser', dir: '', ...(s.export || {}) } };
}

/** For the UI: method definitions + status + values with secrets blanked. */
export function describe(s = effectiveSettings()) {
  return s.order.map(id => {
    const m = byId[id], cfg = s.methods[id];
    const values = { ...cfg };
    const secrets = {};
    for (const f of m.fields) if (f.type === 'secret') { secrets[f.key] = Boolean(cfg[f.key]); values[f.key] = ''; }
    let st; try { st = m.status(cfg); } catch (e) { st = { state: 'tool', msg: e.message }; }
    return { id, label: m.label, group: m.group, kind: m.kind, tip: m.tip, fields: m.fields, local: Boolean(m.local), values, secrets, ...st };
  });
}

// ---------------------------------------------------------------- pipeline

/**
 * Build the per-scan pipeline from settings. Status checks run once here.
 * Returns { recognize(ctx), fillGaps(file, segments, signal), pause, active }.
 */
export function createPipeline(s = effectiveSettings(), log = () => {}) {
  const ready = (m) => s.methods[m.id].enabled && m.status(s.methods[m.id]).state === 'ok';
  // one chain: recognition methods and reference tracklists in the user's order
  const chain = s.order.map(id => byId[id]).filter(m => (m.group === 'recognize' || m.group === 'reference') && ready(m));
  const rec = chain.filter(m => m.group === 'recognize'), refs = chain.filter(m => m.group === 'reference');
  const enr = s.order.map(id => byId[id]).filter(m => m.group === 'enrich' && ready(m));
  // references before the first recognition method are "leading": wait for their tracklist,
  // so a tracklist on top really comes first. Later ones never block; leftovers via fillGaps().
  const firstRec = chain.findIndex(m => m.group === 'recognize');
  const leading = new Set(chain.filter((m, i) => m.group === 'reference' && (firstRec < 0 || i < firstRec)).map(m => m.id));
  const dead = new Set(), warned = new Set();
  const enrichCache = new Map();
  const lists = new Map(); // ref id → { promise, list?, error? }
  let usedShazam = false;

  /** Start fetching every reference tracklist once (in parallel). */
  function prepare(file, signal) {
    for (const m of refs) {
      if (lists.has(m.id)) continue;
      const st = {};
      st.promise = m.tracklist(file, s.methods[m.id], signal).then(
        (l) => { st.list = l.sort((a, b) => a.start_sec - b.start_sec); },
        (e) => { st.error = e.message; if (e.name !== 'AbortError') log(`${m.label}: ${e.message}`); });
      lists.set(m.id, st);
    }
  }
  /** Track playing at `pos` per a reference list; null before the first cue or in an "ID"/unknown entry. */
  const lookup = (list, pos) => { const t = list[list.findLastIndex(t => t.start_sec <= pos)]; return t && !t.unknown ? t : null; };
  // offset = pos − cue → toRanges puts Van exactly on the tracklist's cue time
  const refMatch = (m, t, pos) => ({ artist: t.artist, title: t.title, album: '', year: '', method: m.label, offset: pos - t.start_sec });

  async function enrich(match, ctx) {
    const key = `${match.artist}|${match.title}`.toLowerCase();
    if (!enrichCache.has(key)) {
      const extra = {};
      for (const m of enr) {
        try { Object.assign(extra, await m.enrich({ ...match, ...extra }, ctx, s.methods[m.id])); }
        catch (e) { log(`${m.label}: ${e.message}`); }
      }
      enrichCache.set(key, extra);
    }
    return { ...match, ...enrichCache.get(key) };
  }

  /**
   * Google only knows artist + base title. With a "versies?" hint, ask the switched-on methods that haven't
   * tried this fragment yet (those after Google in the chain) for the same fragment; a result for the same base
   * song decides the version (or confirms the original). Anything else (other song, nothing, error) keeps Google's.
   */
  const SECOND = { audd: 'secondAudd', audiotag: 'secondAudiotag', 'shazam-pitch': 'secondPitch' };
  async function secondOpinion(m, r, ctx, at) {
    const gcfg = s.methods[m.id];
    if (m.id !== 'google' || !r.versions || gcfg.second === 'off') return r;
    for (const o of chain.slice(at + 1).filter(o => SECOND[o.id] && gcfg[SECOND[o.id]] !== 'off' && !dead.has(o.id))) {
      try {
        const v = await o.recognize(ctx, s.methods[o.id]);
        if (o.id.startsWith('shazam')) usedShazam = true;
        if (v && sameBaseTrack(r, v)) {
          const { versions, ...rest } = r;
          return { ...rest, artist: v.artist || r.artist, title: v.title, album: v.album || r.album, year: v.year || r.year,
            method: `${v.method || o.label} + ${r.method}`, ...(v.offset != null && { offset: v.offset, timeskew: v.timeskew, stretch: v.stretch }) };
        }
      } catch (e) {
        if (e.fatal) dead.add(o.id);
        log(`${o.label} (tweede mening): ${e.message}`);
      }
    }
    return r;
  }

  async function recognize(ctx) {
    // lazy WAV for methods that upload/feed a file; written once per fragment
    let wavBuf, wavPath;
    ctx.wavBuf = () => wavBuf ??= pcmToWav(ctx.pcm);
    ctx.wav = () => { if (!wavPath) { wavPath = ctx.segPath + '.wav'; writeFileSync(wavPath, ctx.wavBuf()); } return wavPath; };
    prepare(ctx.file, ctx.signal);
    usedShazam = false;
    const done = (r) => enr.length ? enrich(r, ctx) : r;
    const errors = [];
    let tried = 0;
    for (const m of chain) {
      if (dead.has(m.id) || ctx.signal?.aborted) continue;
      if (m.group === 'reference') {
        const st = lists.get(m.id);
        if (leading.has(m.id) && !st.list && !st.error) await st.promise;
        const t = st.list && lookup(st.list, ctx.pos);
        if (t) return done(refMatch(m, t, ctx.pos));
        continue;
      }
      tried++;
      if (m.id.startsWith('shazam')) usedShazam = true;
      try {
        const r = m.local ? await localRecognize(m, ctx, s.methods[m.id]) : await m.recognize(ctx, s.methods[m.id]);
        if (r) return done(await secondOpinion(m, { method: m.label, ...r }, ctx, chain.indexOf(m)));
      } catch (e) {
        if (e.name === 'AbortError') return null;
        errors.push(`${m.label}: ${e.message}`);
        if (e.fatal) { dead.add(m.id); log(`${m.label} uitgeschakeld voor deze scan: ${e.message}`); }
        else if (!warned.has(m.id)) { warned.add(m.id); log(`${m.label}: ${e.message} (verdere fouten van deze methode worden niet gelogd)`); }
      }
    }
    if (tried && errors.length === tried) throw new Error(errors.join(' · '));
    return null;
  }

  /** After the scan: let every reference fill fragments that are still unknown (waits for slow ones). */
  async function fillGaps(file, segments, signal) {
    prepare(file, signal);
    const report = [];
    for (const m of refs) {
      const st = lists.get(m.id);
      await st.promise;
      if (st.error) { report.push({ method: m.label, error: st.error }); continue; }
      let filled = 0;
      for (const seg of segments) {
        if (seg.match) continue;
        const t = lookup(st.list, seg.pos);
        if (t) { seg.match = refMatch(m, t, seg.pos); filled++; }
      }
      report.push({ method: m.label, tracks: st.list.filter(t => !t.unknown).length, filled });
    }
    return report;
  }

  return {
    recognize, fillGaps,
    pause: () => usedShazam ? 3000 : 0, // Shazam politeness only after a fragment that actually called Shazam
    active: chain.map(m => m.label), refs: refs.map(m => m.label),
  };
}

// ---------------------------------------------------------------- collection indexing

/**
 * Add new/changed files under the collection roots to every enabled local method's index.
 * onProgress({ method, done, total, file?, error? }).
 */
export async function buildIndex({ s = effectiveSettings(), onProgress = () => {}, signal } = {}) {
  const files = walkAudio(s.collection.roots);
  const threads = Math.max(1, +s.collection.threads || 1);
  const summary = [];
  for (const id of s.order) {
    const m = byId[id], cfg = s.methods[id];
    if (!m.local || !cfg.enabled) continue;
    const st = m.status(cfg);
    if (st.state === 'tool') { onProgress({ method: m.label, error: st.msg }); summary.push({ method: m.label, error: st.msg }); continue; }
    const done = indexedFiles(id);
    const todo = files.filter(f => { try { return done[f] !== statSync(f).mtimeMs; } catch { return false; } });
    const batch = m.local.batch || (m.local.perFile ? 1 : 20); // ponytail: fixed batch per tool call; tools parallelise internally via `threads`
    let n = 0, added = 0, errors = 0;
    onProgress({ method: m.label, done: 0, total: todo.length });
    for (let i = 0; i < todo.length && !signal?.aborted; i += batch) {
      const chunk = todo.slice(i, i + batch);
      try {
        if (m.local.indexFn) await m.local.indexFn(chunk, cfg, signal); // HTTP worker (NAFP)
        else {
          const [cmd, args, env] = m.local.index(chunk, cfg, threads);
          const r = await api.run(cmd, args, { env, signal, timeout: 30 * 60_000 });
          if (r.code !== 0) throw new Error(errLine(r));
        }
        for (const f of chunk) done[f] = statSync(f).mtimeMs;
        saveIndexed(id, done);
        added += chunk.length;
      } catch (e) {
        if (e.name === 'AbortError') break;
        errors++; onProgress({ method: m.label, error: e.message, file: chunk[0] });
      }
      n += chunk.length;
      onProgress({ method: m.label, done: n, total: todo.length, file: basename(chunk[chunk.length - 1]) });
    }
    summary.push({ method: m.label, added, errors, total: Object.keys(done).length });
  }
  return { files: files.length, summary, aborted: Boolean(signal?.aborted) };
}
