#!/usr/bin/env node
/**
 * Setscout — local UI server for mix-id.
 *
 *   node server.mjs            → http://localhost:3847
 *   PORT=4000 node server.mjs
 *
 * Env (Docker/TrueNAS):
 *   HOST=0.0.0.0               listen address (default 127.0.0.1)
 *   SETSCOUT_ROOTS=/sets:/music:/exports   file browser + scan + collection limited to these (path.delimiter-separated)
 *   SETSCOUT_PASSWORD=…        optional HTTP Basic auth (any username)
 *   SETSCOUT_DATA=/data        settings, indexes (default ./data)
 *   SETSCOUT_EXPORT_DIR=/exports  default target for "save on server"
 *   SETSCOUT_TMP=/tmp/setscout temporary fragments (default ./.setscout-tmp)
 *   NO_OPEN=1                  don't open a browser on start
 *
 * Endpoints:
 *   GET /api/health                     ffmpeg/ffprobe availability + start dir
 *   GET /api/browse?path=<dir>          list subdirs + audio files (no path → start dir, "drives" → drive list)
 *   GET /api/scan?file=&step=&segment=  Server-Sent Events stream of scan progress, ends with `done`
 *   GET /api/methods                    methods + status + settings (secrets blanked)
 *   POST /api/settings                  merge settings, returns /api/methods
 *   GET /api/index                      SSE: (re)build the collection index; /api/index/stop aborts
 *   POST /api/export {name, body}       write an export file on the server
 */

import { createServer } from 'http';
import { readdirSync, statSync, existsSync, readFileSync, writeFileSync, mkdirSync, realpathSync } from 'fs';
import { join, dirname, resolve, extname, basename, delimiter, sep } from 'path';
import { timingSafeEqual } from 'crypto';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import { scan } from './lib/scanner.mjs';
import { toRanges } from './lib/format.mjs';
import { hasCommand } from './lib/audio.mjs';
import { effectiveSettings, describe, createPipeline, buildIndex, byId, AUDIO_EXT } from './lib/methods.mjs';
import { loadSettings, saveSettings, EXPORT_DIR } from './lib/settings.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const UI_DIR = join(ROOT, 'ui');
const TMP_DIR = process.env.SETSCOUT_TMP || join(ROOT, '.setscout-tmp');
const PORT = Number(process.env.PORT) || 3847;
const HOST = process.env.HOST || '127.0.0.1';
const PASSWORD = process.env.SETSCOUT_PASSWORD || '';
const ROOTS = (process.env.SETSCOUT_ROOTS || '').split(delimiter).filter(Boolean).map(p => resolve(p));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
};

// ---- file browser -------------------------------------------------------

function listDrives() {
  if (process.platform !== 'win32') return [{ name: '/', path: '/' }];
  const drives = [];
  for (const c of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
    const p = `${c}:\\`;
    if (existsSync(p)) drives.push({ name: p, path: p });
  }
  return drives;
}

/** Inside one of SETSCOUT_ROOTS (symlinks resolved)? No roots configured → everything allowed (local use). */
function inRoots(p) {
  if (!ROOTS.length) return true;
  let real; try { real = realpathSync(p); } catch { real = resolve(p); }
  return ROOTS.some(r => real === r || real.startsWith(r.endsWith(sep) ? r : r + sep));
}

function browse(dirPath) {
  if (!dirPath || dirPath === 'drives') {
    const dirs = ROOTS.length ? ROOTS.map(r => ({ name: r, path: r })) : listDrives();
    return { path: '', parent: null, dirs, files: [] };
  }
  const abs = resolve(dirPath);
  if (!inRoots(abs)) throw new Error(`Buiten de toegestane mappen: ${abs}`);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new Error(`Map niet gevonden: ${abs}`);
  const dirs = [], files = [];
  for (const ent of readdirSync(abs, { withFileTypes: true })) {
    if (ent.name.startsWith('.') || ent.name === 'node_modules') continue;
    const full = join(abs, ent.name);
    try {
      if (ent.isDirectory()) dirs.push({ name: ent.name, path: full });
      else if (ent.isFile() && AUDIO_EXT.has(extname(ent.name).toLowerCase())) {
        files.push({ name: ent.name, path: full, size: statSync(full).size });
      }
    } catch { /* unreadable entry (permissions, junction) — skip */ }
  }
  const cmp = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });
  dirs.sort(cmp); files.sort(cmp);
  const parentDir = dirname(abs);
  const parent = parentDir === abs || ROOTS.includes(abs) ? 'drives' : parentDir; // at drive/root → go to the list
  return { path: abs, parent, dirs, files };
}

// ---- scan (SSE) ---------------------------------------------------------

// ponytail: one scan at a time — Shazam rate-limits per IP anyway, so parallel
// scans would only trip the backoff. The UI queues sets client-side.
let scanning = false;
let currentAbort = null;

async function handleScan(req, res, params) {
  const file = params.get('file');
  const step = Math.max(10, parseInt(params.get('step') || '30', 10) || 30);
  const segment = Math.min(Math.max(5, parseInt(params.get('segment') || '18', 10) || 18), step);
  if (!file || !existsSync(file) || !statSync(file).isFile()) return json(res, 400, { error: `Bestand niet gevonden: ${file}` });
  if (!inRoots(file)) return json(res, 403, { error: 'Bestand ligt buiten de toegestane mappen.' });
  if (scanning) return json(res, 409, { error: 'Er loopt al een scan.' });
  let send = () => {};
  const pipeline = createPipeline(effectiveSettings(), (message) => send('note', { message }));
  if (!pipeline.active.length && !pipeline.refs.length) return json(res, 400, { error: 'Geen actieve herkenningsmethode die klaar is — zie Instellingen.' });

  scanning = true;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  send = sse(res);
  const ac = new AbortController();
  currentAbort = ac;
  req.on('close', () => ac.abort());

  try {
    const result = await scan(file, {
      step, segment, tmpDir: TMP_DIR, signal: ac.signal,
      recognize: pipeline.recognize, pause: pipeline.pause,
      onProgress: (evt) => send(evt.type, { ...evt, chain: pipeline.active }),
    });
    let reference = [];
    if (!result.aborted && pipeline.refs.length) {
      send('note', { message: `Referentie-tracklists ophalen: ${pipeline.refs.join(', ')}…` });
      reference = await pipeline.fillGaps(file, result.segments, ac.signal);
    }
    send('done', {
      reference,
      aborted: result.aborted,
      duration: result.duration,
      segmentsScanned: result.segmentsScanned,
      tracks: toRanges(result.segments, segment, step),
    });
  } catch (err) {
    send('error', { message: err.message });
  } finally {
    scanning = false;
    currentAbort = null;
    res.end();
  }
}

const sse = (res) => (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);

// ---- settings / collection index / export ----------------------------------

function readBody(req, limit = 5 << 20) {
  return new Promise((ok, fail) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { fail(new Error('Te groot')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { ok(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { fail(new Error('Ongeldige JSON')); } });
  });
}

const methodsPayload = () => {
  const s = effectiveSettings();
  return { methods: describe(s), collection: s.collection, export: s.export, roots: ROOTS, exportDefault: EXPORT_DIR };
};

/** Merge a partial settings update. Secret fields: '' keeps the stored value, null clears it. */
function updateSettings(patch) {
  const cur = loadSettings();
  if (Array.isArray(patch.order)) cur.order = patch.order.filter(id => byId[id]);
  for (const [id, vals] of Object.entries(patch.methods || {})) {
    const m = byId[id]; if (!m) continue;
    const next = { ...(cur.methods?.[id] || {}) };
    if ('enabled' in vals) next.enabled = Boolean(vals.enabled);
    for (const f of m.fields) {
      if (!(f.key in vals)) continue;
      const v = vals[f.key];
      if (f.type === 'secret') { if (v === null) delete next[f.key]; else if (v) next[f.key] = String(v).trim(); }
      else next[f.key] = f.type === 'number' ? Number(v) : String(v ?? '');
    }
    (cur.methods ??= {})[id] = next;
  }
  if (patch.collection) {
    const c = { ...(cur.collection || {}) };
    if (Array.isArray(patch.collection.roots)) {
      const bad = patch.collection.roots.find(r => !existsSync(r) || !inRoots(r));
      if (bad) throw new Error(`Map niet toegestaan of niet gevonden: ${bad}`);
      c.roots = [...new Set(patch.collection.roots.map(r => resolve(r)))];
    }
    if ('threads' in patch.collection) c.threads = Math.min(64, Math.max(1, parseInt(patch.collection.threads, 10) || 1));
    cur.collection = c;
  }
  if (patch.export) {
    const e = { ...(cur.export || {}) };
    if (patch.export.target) e.target = patch.export.target === 'server' ? 'server' : 'browser';
    if ('dir' in patch.export) {
      if (patch.export.dir && !inRoots(patch.export.dir)) throw new Error('Exportmap ligt buiten de toegestane mappen.');
      e.dir = patch.export.dir ? resolve(patch.export.dir) : '';
    }
    cur.export = e;
  }
  saveSettings(cur);
}

let indexAbort = null;
async function handleIndex(req, res) {
  // errors go out as SSE events too: EventSource can't read a JSON error body
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const send = sse(res);
  const s = effectiveSettings();
  const refuse = indexAbort ? 'Er loopt al een indexering.' : !s.collection.roots.length ? 'Kies eerst minstens één muziekmap.' : null;
  if (refuse) { send('error', { message: refuse }); return res.end(); }
  const ac = indexAbort = new AbortController();
  req.on('close', () => ac.abort());
  try {
    send('done', await buildIndex({ s, signal: ac.signal, onProgress: (p) => send('progress', p) }));
  } catch (err) { send('error', { message: err.message }); }
  finally { indexAbort = null; res.end(); }
}

function handleExport(body) {
  const dir = effectiveSettings().export.dir || EXPORT_DIR;
  const name = basename(String(body.name || '')).replace(/[<>:"|?*\x00-\x1f]/g, '_');
  if (!name || !/\.(txt|csv|json)$/i.test(name)) throw new Error('Ongeldige bestandsnaam');
  if (dir !== EXPORT_DIR && !inRoots(dir)) throw new Error('Exportmap ligt buiten de toegestane mappen.');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, String(body.body ?? ''));
  return path;
}

/** Optional HTTP Basic auth (SETSCOUT_PASSWORD). Any username; constant-time compare. */
function authorized(req) {
  if (!PASSWORD) return true;
  const m = /^Basic (.+)$/.exec(req.headers.authorization || '');
  const pass = m ? Buffer.from(m[1], 'base64').toString('utf8').replace(/^[^:]*:/, '') : '';
  const a = Buffer.from(pass), b = Buffer.from(PASSWORD);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---- http ---------------------------------------------------------------

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (!authorized(req)) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Setscout", charset="UTF-8"' });
    return res.end('Wachtwoord vereist');
  }
  try {
    if (url.pathname === '/api/health') {
      return json(res, 200, { ffmpeg: hasCommand('ffmpeg'), ffprobe: hasCommand('ffprobe'), startDir: ROOTS.length ? '' : process.cwd() });
    }
    if (url.pathname === '/api/browse') {
      try { return json(res, 200, browse(url.searchParams.get('path') ?? process.cwd())); }
      catch (err) { return json(res, 404, { error: err.message }); }
    }
    if (url.pathname === '/api/scan') {
      return handleScan(req, res, url.searchParams);
    }
    if (url.pathname === '/api/scan/stop') {
      // Abort between segments; the running SSE stream then emits `done` with aborted:true + partial tracks.
      currentAbort?.abort();
      return json(res, 200, { stopping: Boolean(currentAbort) });
    }
    if (url.pathname === '/api/methods') return json(res, 200, methodsPayload());
    if (url.pathname === '/api/settings' && req.method === 'POST') {
      try { updateSettings(await readBody(req)); return json(res, 200, methodsPayload()); }
      catch (err) { return json(res, 400, { error: err.message }); }
    }
    if (url.pathname === '/api/index') return handleIndex(req, res);
    if (url.pathname === '/api/index/stop') { indexAbort?.abort(); return json(res, 200, { stopping: Boolean(indexAbort) }); }
    if (url.pathname === '/api/export' && req.method === 'POST') {
      try { return json(res, 200, { path: handleExport(await readBody(req)) }); }
      catch (err) { return json(res, 400, { error: err.message }); }
    }
    // static UI
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const filePath = resolve(UI_DIR, rel);
    if (!filePath.startsWith(UI_DIR) || !existsSync(filePath) || !statSync(filePath).isFile()) {
      return json(res, 404, { error: 'Niet gevonden' });
    }
    res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] || 'application/octet-stream' });
    res.end(readFileSync(filePath));
  } catch (err) {
    json(res, 500, { error: err.message });
  }
});

server.listen(PORT, HOST, () => {
  const addr = `http://localhost:${PORT}`;
  // length only (never the value): lets the user spot a password truncated by compose's `$` interpolation
  console.log(`Setscout draait op http://${HOST}:${PORT}${PASSWORD ? ` (met wachtwoord, ${PASSWORD.length} tekens)` : ''}${ROOTS.length ? ' · mappen: ' + ROOTS.join(', ') : ''}`);
  if (!PASSWORD && !['127.0.0.1', 'localhost', '::1'].includes(HOST)) console.warn('Let op: geen SETSCOUT_PASSWORD gezet — iedereen op het netwerk kan Setscout openen. (Een $ in docker compose schrijf je als $$.)');
  if (!hasCommand('ffmpeg') || !hasCommand('ffprobe')) console.warn('Let op: ffmpeg/ffprobe niet gevonden op PATH — scannen werkt niet.');
  if (!process.env.NO_OPEN) {
    const opener = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', addr]]
      : process.platform === 'darwin' ? ['open', [addr]] : ['xdg-open', [addr]];
    spawnSync(opener[0], opener[1], { stdio: 'ignore' });
  }
});
