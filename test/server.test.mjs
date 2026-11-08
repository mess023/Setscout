/**
 * Server self-check (local only, port 3848): password, roots jail, secret masking, server export.
 *   npm test
 */
import assert from 'assert/strict';
import { spawn } from 'child_process';
import { mkdirSync, rmSync, readFileSync, writeFileSync, } from 'fs';
import { join, delimiter } from 'path';

const ROOT = join(import.meta.dirname, '..');
const TMP = join(ROOT, '.setscout-tmp', 'srvtest');
rmSync(TMP, { recursive: true, force: true });
const [sets, music, exp, data] = ['sets', 'music', 'exports', 'data'].map(d => join(TMP, d));
for (const d of [sets, music, exp]) mkdirSync(d, { recursive: true });
writeFileSync(join(sets, 'mix.mp3'), 'x');

const PORT = 3848, base = `http://127.0.0.1:${PORT}`;
const srv = spawn(process.execPath, ['server.mjs'], {
  cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'],
  env: { ...process.env, PORT, NO_OPEN: '1', SETSCOUT_PASSWORD: 'geheim', SETSCOUT_DATA: data, SETSCOUT_EXPORT_DIR: exp, SETSCOUT_ROOTS: [sets, music, exp].join(delimiter) },
});
await new Promise(r => srv.stdout.once('data', r));
const auth = { Authorization: 'Basic ' + Buffer.from('x:geheim').toString('base64') };
const get = (p, h = auth) => fetch(base + p, { headers: h });
const post = (p, body) => fetch(base + p, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

try {
  assert.equal((await get('/api/health', {})).status, 401, 'zonder wachtwoord');
  assert.equal((await get('/api/health', { Authorization: 'Basic ' + Buffer.from('x:fout').toString('base64') })).status, 401);
  const h = await (await get('/api/health')).json();
  assert.equal(h.startDir, '');

  const top = await (await get('/api/browse?path=')).json();
  assert.deepEqual(top.dirs.map(d => d.path), [sets, music, exp]);
  const inside = await (await get('/api/browse?path=' + encodeURIComponent(sets))).json();
  assert.equal(inside.files[0].name, 'mix.mp3'); assert.equal(inside.parent, 'drives');
  assert.equal((await get('/api/browse?path=' + encodeURIComponent(ROOT))).status, 404, 'buiten roots');
  assert.equal((await get('/api/scan?file=' + encodeURIComponent(join(ROOT, 'package.json')))).status, 403);

  let m = await (await post('/api/settings', { methods: { audd: { enabled: true, apiKey: 'SECRET123' } } })).json();
  let audd = m.methods.find(x => x.id === 'audd');
  assert.equal(audd.values.apiKey, ''); assert.equal(audd.secrets.apiKey, true); assert.equal(audd.state, 'ok');
  assert.ok(!JSON.stringify(m).includes('SECRET123'), 'sleutel lekt niet naar de UI');
  assert.match(readFileSync(join(data, 'settings.json'), 'utf8'), /SECRET123/);
  m = await (await post('/api/settings', { methods: { audd: { apiKey: '' } } })).json();
  assert.equal(m.methods.find(x => x.id === 'audd').secrets.apiKey, true, 'leeg = behouden');
  m = await (await post('/api/settings', { methods: { audd: { apiKey: null } } })).json();
  assert.equal(m.methods.find(x => x.id === 'audd').state, 'key', 'null = wissen');

  m = await (await post('/api/settings', { order: ['audd', 'shazam', 'bestaatniet'] })).json();
  assert.deepEqual(m.methods.slice(0, 2).map(x => x.id), ['audd', 'shazam']);

  assert.equal((await post('/api/settings', { collection: { roots: [ROOT] } })).status, 400, 'collectie buiten roots');
  m = await (await post('/api/settings', { collection: { roots: [music], threads: 99 } })).json();
  assert.deepEqual(m.collection, { roots: [music], threads: 64 });

  const ex = await (await post('/api/export', { name: '../../evil set_tracklist.txt', body: 'hallo' })).json();
  assert.equal(ex.path, join(exp, 'evil set_tracklist.txt'));
  assert.equal(readFileSync(ex.path, 'utf8'), 'hallo');
  assert.equal((await post('/api/export', { name: 'x.exe', body: '' })).status, 400);
  assert.equal((await post('/api/settings', { export: { dir: ROOT } })).status, 400, 'exportmap buiten roots');

  const idx = await (await get('/api/index')).text(); // olaf off → done with empty summary
  assert.match(idx, /event: done/);
  console.log('server: alle checks geslaagd');
} finally {
  srv.kill();
  rmSync(TMP, { recursive: true, force: true });
}
