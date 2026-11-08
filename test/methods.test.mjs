/**
 * Self-check for the recognition pipeline. No network, no external tools:
 * Shazam, fetch and tool calls are mocked; ffmpeg (pitch) and the scanner run for real.
 *
 *   npm test
 */
import assert from 'assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';

const TMP = join(import.meta.dirname, '..', '.setscout-tmp', 'test');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
process.env.SETSCOUT_DATA = join(TMP, 'data'); // keep the real data/ untouched

const M = await import('../lib/methods.mjs');
const { scan } = await import('../lib/scanner.mjs');
const { indexDir } = await import('../lib/settings.mjs');
const { toRanges } = await import('../lib/format.mjs');
const { api, byId, effectiveSettings, createPipeline, pcmToWav } = M;
api.sleep = async () => {};

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log('  ok  ' + name); };
const settings = (methods, order) => effectiveSettings({ order, methods });
const jsonRes = (obj) => ({ text: async () => JSON.stringify(obj), status: 200 });
const pcm = Buffer.alloc(16000 * 2 * 2); // 2 s silence, s16le mono 16 kHz
const segPath = join(TMP, 'seg.raw'); writeFileSync(segPath, pcm);
const ctx = () => ({ pcm, segPath, pos: 0, segment: 2, file: 'x', signal: undefined });

await test('pcmToWav: RIFF header + size', () => {
  const w = pcmToWav(Buffer.alloc(10));
  assert.equal(w.toString('ascii', 0, 4), 'RIFF');
  assert.equal(w.readUInt32LE(24), 16000);
  assert.equal(w.readUInt32LE(40), 10);
  assert.equal(w.length, 54);
});

await test('keten: Shazam mist → AudD vindt, method = AudD', async () => {
  api.shazam = async () => null;
  globalThis.fetch = async (url, o) => {
    assert.equal(url, 'https://api.audd.io/');
    assert.equal(o.body.get('api_token'), 'K');
    return jsonRes({ status: 'success', result: { artist: 'A', title: 'T', album: 'Al', release_date: '2024-01-01' } });
  };
  const p = createPipeline(settings({ shazam: { enabled: true }, audd: { enabled: true, apiKey: 'K' } }, ['shazam', 'audd']));
  assert.deepEqual(p.active, ['Shazam', 'AudD']);
  const r = await p.recognize(ctx());
  assert.equal(r.method, 'AudD'); assert.equal(r.year, '2024');
});

await test('keten: volgorde telt — AudD eerst', async () => {
  const calls = [];
  api.shazam = async () => { calls.push('shazam'); return { artist: 'S', title: 'S' }; };
  globalThis.fetch = async () => { calls.push('audd'); return jsonRes({ status: 'success', result: null }); };
  const p = createPipeline(settings({ shazam: { enabled: true }, audd: { enabled: true, apiKey: 'K' } }, ['audd', 'shazam']));
  const r = await p.recognize(ctx());
  assert.deepEqual(calls, ['audd', 'shazam']); assert.equal(r.method, 'Shazam');
});

await test('AudD fout 901 schakelt AudD uit voor de rest van de scan', async () => {
  let n = 0;
  api.shazam = async () => null;
  globalThis.fetch = async () => { n++; return jsonRes({ status: 'error', error: { error_code: 901, error_message: 'limit' } }); };
  const p = createPipeline(settings({ shazam: { enabled: true }, audd: { enabled: true, apiKey: 'K' } }));
  assert.equal(await p.recognize(ctx()), null);
  assert.equal(await p.recognize(ctx()), null);
  assert.equal(n, 1);
});

await test('alle methodes falen → fout wordt doorgegeven', async () => {
  api.shazam = async () => { throw new Error('boom'); };
  const p = createPipeline(settings({ shazam: { enabled: true } }));
  await assert.rejects(p.recognize(ctx()), /Shazam: boom/);
});

await test('methode zonder sleutel doet niet mee', () => {
  const p = createPipeline(settings({ shazam: { enabled: false }, audd: { enabled: true } }));
  assert.deepEqual(p.active, []);
});

await test('Shazam gepitcht: ffmpeg pitcht echt, volgorde −2,+2,−4; label', async () => {
  const lens = [];
  api.shazam = async (buf) => { lens.push(buf.length); return lens.length === 3 ? { artist: 'P', title: 'Q' } : null; };
  const p = createPipeline(settings({ shazam: { enabled: false }, 'shazam-pitch': { enabled: true, percents: '2,4', mode: 'vinyl' } }));
  const r = await p.recognize(ctx());
  assert.equal(r.method, 'Shazam −4%'); assert.equal(r.pitch, -4);
  // vinyl −2 %: slower → longer than the 64000-byte input; +2 %: shorter
  assert.ok(lens[0] > pcm.length && lens[1] < pcm.length, `lengtes ${lens}`);
});

await test('Shazam gepitcht keylock gebruikt atempo (andere lengte, zelfde richting)', async () => {
  const lens = [];
  api.shazam = async (buf) => { lens.push(buf.length); return null; };
  const p = createPipeline(settings({ shazam: { enabled: false }, 'shazam-pitch': { enabled: true, percents: '6', mode: 'keylock' } }));
  assert.equal(await p.recognize(ctx()), null);
  assert.equal(lens.length, 2); assert.ok(lens[0] > lens[1]);
});

await test('Shazam gepitcht modus beide (standaard): per stap eerst vinyl dan keylock; label met modus', async () => {
  assert.equal(effectiveSettings().methods['shazam-pitch'].mode, 'both');
  const lens = [];
  api.shazam = async (buf) => { lens.push(buf.length); return lens.length === 4 ? { artist: 'K', title: 'L' } : null; };
  const p = createPipeline(settings({ shazam: { enabled: false }, 'shazam-pitch': { enabled: true, percents: '2' } }));
  const r = await p.recognize(ctx());
  // volgorde: −2 vinyl, −2 keylock, +2 vinyl, +2 keylock (raak)
  assert.equal(lens.length, 4);
  assert.equal(r.method, 'Shazam +2% keylock'); assert.equal(r.pitch, 2); assert.equal(r.stretch, 1.02);
  assert.ok(lens[0] > pcm.length && lens[1] > pcm.length && lens[2] < pcm.length && lens[3] < pcm.length, `lengtes ${lens}`);
});

await test('AudioTag: upload → wait → poll → found (array-vorm)', async () => {
  const seen = [];
  globalThis.fetch = async (url, o) => {
    const action = o.body.get('action'); seen.push(action);
    if (action === 'identify') return jsonRes({ success: true, token: 'tok', job_status: 'wait' });
    return jsonRes({ success: true, result: seen.length < 3 ? 'wait' : 'found', data: [{ tracks: [['Titel', 'Artiest', 'Album', 2020]] }] });
  };
  const p = createPipeline(settings({ shazam: { enabled: false }, audiotag: { enabled: true, apiKey: 'k' } }));
  const r = await p.recognize(ctx());
  assert.deepEqual(seen, ['identify', 'get_result', 'get_result']);
  assert.equal(r.title, 'Titel'); assert.equal(r.artist, 'Artiest'); assert.equal(r.method, 'AudioTag');
});

await test('AcoustID: fpcalc (gemockt) → lookup → beste recording boven drempel', async () => {
  api.run = async (cmd, args) => { assert.equal(args[0], '-json'); return { code: 0, stdout: '{"duration":12.3,"fingerprint":"AQAD"}', stderr: '' }; };
  globalThis.fetch = async (url, o) => {
    assert.equal(o.body.get('duration'), '12');
    return jsonRes({ status: 'ok', results: [{ score: 0.3, recordings: [{ title: 'Laag' }] }, { score: 0.8, recordings: [{ title: 'Hoog', artists: [{ name: 'X' }, { name: 'Y' }] }] }] });
  };
  const p = createPipeline(settings({ shazam: { enabled: false }, acoustid: { enabled: true, apiKey: 'c', fpcalc: 'package.json' } }));
  const r = await p.recognize(ctx());
  assert.equal(r.title, 'Hoog'); assert.equal(r.artist, 'X, Y');
});

// ---- own-collection engines: output parsers + lookup of the matched file's tags
const parse = (id, out) => byId[id].local.parse(out);
await test('Olaf JSON + CSV parser', () => {
  assert.deepEqual(parse('olaf', '{"query_index":1,"matches":[{"match_count":5,"path":"a.mp3"},{"match_count":14,"path":"b.mp3","query_start":1.5,"reference_start":31.5}]}'), { path: 'b.mp3', score: 14, offset: 30 });
  assert.deepEqual(parse('olaf', 'query_index, total_queries, query_path, query_offset, match_count, query_start, query_stop, path, match_identifier, reference_start, reference_stop\n1 ,1 ,q.wav, 0.000, 12 ,1.9 ,19.3, /music/c.mp3, 351, 70.8, 88.2'), { path: '/music/c.mp3', score: 12, offset: 70.8 - 1.9 });
  assert.equal(parse('olaf', '{"matches":[]}'), null);
});
await test('audfprint parser (dpwe-uitvoer)', () => {
  assert.deepEqual(parse('audfprint', 'Matched query.wav 5.573 sec 204 raw hashes as Nine_Lives/05-Full_Circle.mp3 at 50.085 s with 8 of 9 hashes'), { path: 'Nine_Lives/05-Full_Circle.mp3', score: 8, offset: 50.085 });
  assert.equal(parse('audfprint', 'NOMATCH query.wav 5.6 sec 204 raw hashes'), null);
});
await test('Panako parser (;-gescheiden, header overgeslagen)', () => {
  assert.deepEqual(parse('panako', 'Index;Total;Query path;Query start;Query stop;Match path;Match id;Match start;Match stop;Match score;Time factor (%);Freq factor (%);Seconds with match (%)\n1;1;q.wav;0;18;/music/d.flac;99;60;78;37;101;100;80'), { path: '/music/d.flac', score: 37, offset: 60 });
});
await test('Dejavu parser (Python-dict)', () => {
  assert.deepEqual(parse('dejavu', "{'results': [{'song_id': 1, 'song_name': b'Artist - Song', 'input_confidence': 0.42, 'offset_seconds': 12.5}]}"), { path: 'Artist - Song', score: 0.42, offset: 12.5 });
});

await test('Olaf via keten: index → query (gemockt) → tags uit bestandsnaam, drempel', async () => {
  const song = join(TMP, 'Daft Punk - Da Funk.wav');
  writeFileSync(song, pcmToWav(pcm));
  writeFileSync(join(indexDir('olaf'), 'files.json'), JSON.stringify({ [song]: 1 }));
  let score = 20;
  api.run = async (cmd, args, o) => {
    assert.equal(args[0], 'query'); assert.ok(o.env.HOME.endsWith(join('index', 'olaf')));
    return { code: 0, stdout: JSON.stringify({ matches: [{ match_count: score, path: song }] }), stderr: '' };
  };
  const p = createPipeline(settings({ shazam: { enabled: false }, olaf: { enabled: true, cmd: 'package.json', minScore: 10 } }));
  assert.deepEqual(p.active, ['Olaf']);
  const r = await p.recognize(ctx());
  assert.equal(r.artist, 'Daft Punk'); assert.equal(r.title, 'Da Funk'); assert.equal(r.method, 'Olaf');
  score = 5; assert.equal(await p.recognize(ctx()), null);
});

await test('Olaf index bouwen: batches, threads, files.json, alleen nieuwe bestanden', async () => {
  const music = join(TMP, 'music'); mkdirSync(join(music, 'sub'), { recursive: true });
  for (const n of ['a.mp3', 'sub/b.flac', 'c.txt', '.hidden.mp3']) writeFileSync(join(music, n), 'x');
  const calls = [];
  api.run = async (cmd, args) => { calls.push(args); return { code: 0, stdout: '', stderr: '' }; };
  const s = effectiveSettings({ methods: { olaf: { enabled: true, cmd: 'package.json' } }, collection: { roots: [music], threads: 3 } });
  const r1 = await M.buildIndex({ s });
  assert.equal(r1.files, 2);
  assert.deepEqual(calls[0].slice(0, 3), ['store', '--threads', '3']);
  assert.equal(calls[0].length, 5);
  const r2 = await M.buildIndex({ s });
  assert.equal(calls.length, 1, 'tweede keer niets nieuws');
  assert.equal(r2.summary[0].added, 0);
});

await test('referentie: trackid.dev vult alleen gaten, op tijdstip', async () => {
  const urls = [];
  globalThis.fetch = async (url, o) => {
    urls.push(url);
    if (url.endsWith('/api/analyze')) { assert.match(o.body, /AbCdEfGhIjK/); return jsonRes({ jobId: 'j1', status: 'queued' }); }
    return jsonRes({ status: 'completed', tracks: [{ timestamp: 0, artist: 'A', title: 'Een' }, { timestamp: 100, artist: 'B', title: 'Twee' }, { timestamp: 50, isUnknown: true }] });
  };
  const p = createPipeline(settings({ shazam: { enabled: true }, trackid: { enabled: true } }));
  const segs = [{ pos: 0, match: { artist: 'S', title: 'Shz' } }, { pos: 30, match: null }, { pos: 120, match: null }];
  const rep = await p.fillGaps('Set [AbCdEfGhIjK].webm', segs);
  assert.deepEqual(rep, [{ method: 'trackid.dev', tracks: 2, filled: 2 }]);
  assert.equal(segs[0].match.title, 'Shz');
  assert.equal(segs[1].match.title, 'Een'); assert.equal(segs[2].match.title, 'Twee');
  assert.equal(segs[2].match.method, 'trackid.dev');
  const p2 = createPipeline(settings({ shazam: { enabled: true }, trackid: { enabled: true } })); // one pipeline = one scan/file
  assert.deepEqual(await p2.fillGaps('geen-id.mp3', [{ pos: 0, match: null }]), [{ method: 'trackid.dev', error: 'geen YouTube-ID in de bestandsnaam' }]);
});

await test('referentie: 1001Tracklists parse + nette fout bij blokkade', async () => {
  const page = `<div class="tlpItem x"><meta itemprop="name" content="Artist One - Song &amp; Co"><div class="cueValueField">01:02:03</div></div>
    <div class="tlpItem"><meta itemprop="name" content="Two - B"><div class="cueValueField"> 05:00</div></div>
    <div class="tlpItem"><meta itemprop="name" content="ID - ID"><div class="cueValueField">08:00</div></div>`;
  const calls = [];
  globalThis.fetch = async (url, o = {}) => {
    calls.push({ url, method: o.method || 'GET', body: o.body?.toString(), cookie: o.headers?.Cookie, referer: o.headers?.Referer });
    if (url.endsWith('.com/')) return { headers: { getSetCookie: () => ['guid=abc; Path=/; HttpOnly', 'uid=1; Path=/'] }, text: async () => '' };
    return { text: async () => url.includes('/search/') ? '<a href="/tracklist/zz/other-dj-boiler-room.html">x</a><a href="/tracklist/abc/andhim-das-festival-germany-2026.html">x</a>' : page };
  };
  const list = await byId['1001tl'].tracklist('Andhim (Full Set) - komm schon Alter, Das Festival 2026 [AbCdEfGhIjK].webm', {});
  assert.deepEqual(list, [{ start_sec: 3723, artist: 'Artist One', title: 'Song & Co', unknown: false }, { start_sec: 300, artist: 'Two', title: 'B', unknown: false }, { start_sec: 480, artist: 'ID', title: 'ID', unknown: true }]);
  // zoeken zoals het formulier van de site: POST met cookies van de homepage, zoekterm opgeschoond
  assert.equal(calls[1].method, 'POST');
  assert.equal(calls[1].body, 'main_search=Andhim+komm+schon+Alter+Das+Festival+2026&search_selection=9');
  assert.equal(calls[1].cookie, 'guid=abc; uid=1');
  assert.equal(calls[2].url, 'https://www.1001tracklists.com/tracklist/abc/andhim-das-festival-germany-2026.html', 'beste match, niet de eerste link');
  assert.equal(calls[2].referer, 'https://www.1001tracklists.com/search/result.php');
  globalThis.fetch = async () => ({ text: async () => 'Please wait, you will be forwarded' });
  await assert.rejects(byId['1001tl'].tracklist('x.mp3', {}), /geblokkeerd/);
  globalThis.fetch = async () => ({ text: async () => '<html>no results</html>' });
  await assert.rejects(byId['1001tl'].tracklist('x.mp3', { query: 'Andhim Das Festival' }), /geen passende tracklist gevonden voor "Andhim Das Festival"/);
  // Cloudflare Turnstile op de tracklistpagina: nette melding mét de gevonden link, geen poging om hem te omzeilen
  globalThis.fetch = async (url) => ({ text: async () => url.includes('/search/') ? '<a href="/tracklist/q1/andhim-das-festival.html">x</a>' : '<form method="POST"><input type="hidden" name="captcha" value="1"><div id="turnstile-container"></div></form><script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script>' });
  await assert.rejects(byId['1001tl'].tracklist('x.mp3', { query: 'Andhim Das Festival' }),
    (e) => e.message.includes('tracklist gevonden (https://www.1001tracklists.com/tracklist/q1/andhim-das-festival.html)') && e.message.includes('Turnstile'));
});

await test('keten: tracklist bovenaan → eerst overgenomen, Shazam alleen voor ID/vóór eerste cue; Van = cue', async () => {
  const page = ['01:00|A - Een', '03:00|ID - ID', '05:00|B - Twee'].map(r => { const [c, n] = r.split('|'); return `<div class="tlpItem"><meta itemprop="name" content="${n}"><div class="cueValueField">${c}</div></div>`; }).join('');
  let fetches = 0;
  globalThis.fetch = async (url) => { fetches++; return { text: async () => url.includes('/search/') ? '<a href="/tracklist/x/andhim-awakenings-festival.html">x</a>' : page }; };
  const shazamAt = [];
  api.shazam = async () => { shazamAt.push(cur); return { artist: 'S', title: 'Shazam-vondst' }; };
  let cur;
  const p = createPipeline(settings({ shazam: { enabled: true }, '1001tl': { enabled: true } }, ['1001tl', 'shazam']));
  assert.deepEqual(p.active, ['1001Tracklists', 'Shazam']);
  const segs = [];
  for (const pos of [0, 60, 90, 180, 240, 300, 330]) {
    cur = pos;
    segs.push({ pos, match: await p.recognize({ ...ctx(), pos, file: 'Andhim Awakenings.mp3' }) });
    assert.equal(p.pause(), shazamAt.at(-1) === pos ? 3000 : 0, 'alleen pauze na een Shazam-call');
  }
  assert.deepEqual(shazamAt, [0, 180, 240], 'Shazam alleen vóór de eerste cue en in het ID-blok');
  assert.equal(fetches, 3, 'tracklist één keer opgehaald (home + zoeken + pagina)');
  const r = toRanges(segs, 12, 30);
  assert.deepEqual(r.map(t => [t.title, t.method, t.start_sec, t.exact]),
    [['Shazam-vondst', 'Shazam', 0, false], ['Een', '1001Tracklists', 60, true], ['Shazam-vondst', 'Shazam', 180, false], ['Twee', '1001Tracklists', 300, true]]);
});

await test('tracklist-tekst: tijd voor/achter, nummering, labels, ID; volgorde-check', () => {
  const t = M.parseTimedLines(`Tracklist:\n00:00 Aberton - Me Out\n2. [05:00] Jonny Calypso – Teenager 2K15 [Label]\nVictor Vera - Pressure (Daniel Sbert Remix) 08:00\n1:02:03 ID - ID\nmooie set!`);
  assert.deepEqual(t.map(x => [x.start_sec, x.artist, x.title, x.unknown]), [
    [0, 'Aberton', 'Me Out', false], [300, 'Jonny Calypso', 'Teenager 2K15', false],
    [480, 'Victor Vera', 'Pressure (Daniel Sbert Remix)', false], [3723, 'ID', 'ID', true]]);
  assert.deepEqual(M.parseTimedLines('41:30 was silly business'), [], 'losse comment met één tijd is geen tracklist');
  assert.deepEqual(M.parseTimedLines('10:00 A - B\n02:00 C - D\n05:00 E - F\n01:00 G - H'), [], 'door elkaar = geen tracklist');
});

await test('YouTube: hoofdstukken > beste comment (meeste regels, vastgepind); ID uit bestandsnaam, anders zoeken', async () => {
  const list = '00:00 A - Een\n03:00 B - Twee\n06:00 C - Drie';
  assert.equal(M.bestYoutubeTracklist({ chapters: [], description: 'geen', comments: [{ text: '41:30 lol' }] }), null);
  const best = M.bestYoutubeTracklist({ description: '', comments: [{ text: list, like_count: 3 }, { text: list + '\n09:00 D - Vier', is_pinned: true }] });
  assert.equal(best.tracks.length, 4);
  assert.equal(M.bestYoutubeTracklist({ chapters: [{ start_time: 0, title: 'X - Y' }, { start_time: 60, title: 'P - Q' }, { start_time: 120, title: 'R - S' }], comments: [{ text: list + '\n09:00 D - Vier' }] }).from, 'hoofdstukken');
  const calls = [];
  api.run = async (cmd, args) => { calls.push(args.at(-1)); return { code: 0, stdout: JSON.stringify({ title: 'Set', description: list, comments: [] }) + '\n', stderr: '' }; };
  const m = byId.youtube, cfg = { ytdlp: 'package.json', maxComments: 50 };
  const t = await m.tracklist('Andhim (Full Set) - Das Festival 2026 [AbCdEfGhIjK].webm', cfg);
  assert.equal(calls[0], 'https://www.youtube.com/watch?v=AbCdEfGhIjK');
  assert.deepEqual(t.map(x => x.start_sec), [0, 180, 360]);
  await m.tracklist('Andhim - Das Festival 2026.mp3', cfg);
  assert.equal(calls[1], 'ytsearch1:Andhim Das Festival 2026');
  api.run = async () => ({ code: 0, stdout: JSON.stringify({ title: 'Kale set', comments: [{ text: 'NICE SET' }] }), stderr: '' });
  await assert.rejects(m.tracklist('x [AbCdEfGhIjK].webm', cfg), /geen tracklist met tijden gevonden bij "Kale set".*1 comments/);
  api.run = async () => ({ code: 1, stdout: '', stderr: 'ERROR: Video unavailable' });
  await assert.rejects(m.tracklist('x [AbCdEfGhIjK].webm', cfg), /yt-dlp: ERROR: Video unavailable/);
});

await test('MixesDB: zoeken (rangschikken + jaar) → ruwe wikitekst → [mmm]-minuten, "?" onbekend', async () => {
  const raw = '== Tracklist ==\n# [000] WhoMadeWho - There\'s A Way (andhim Remix) [Get Physical]\n# [006] andhim - Rollercoaster [Monaberry]\n# [023] ?\n# [1:02:03] X - Y\n# Zonder Tijd - Track\n[[Category:2015]]';
  assert.deepEqual(M.parseMixesdb(raw).map(t => [t.start_sec, t.artist, t.title, t.unknown]), [
    [0, 'WhoMadeWho', "There's A Way (andhim Remix)", false], [360, 'andhim', 'Rollercoaster', false], [1380, '', '?', true], [3723, 'X', 'Y', false]]);
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(url);
    if (url.includes('list=search')) return jsonRes({ query: { search: [{ title: '2013-06-28 - andhim @ Fusion Festival, Germany' }, { title: '2015-06-28 - andhim @ Awakenings Festival, Amsterdam' }] } });
    return { text: async () => raw };
  };
  const t = await byId.mixesdb.tracklist('andhim - Awakenings 2015.mp3', {});
  assert.match(urls[0], /^https:\/\/www\.mixesdb\.com\/w\/api\.php\?.*srsearch=andhim%20Awakenings%202015/);
  assert.match(urls[1], /title=2015-06-28_-_andhim_%40_Awakenings_Festival%2C_Amsterdam/, 'beste match met juist jaar');
  assert.equal(t.length, 4);
  await assert.rejects(byId.mixesdb.tracklist('andhim - Das Festival 2026.mp3', {}), /geen passende mix gevonden voor "andhim Das Festival 2026"/, 'zelfde DJ, ander jaar = geen match');
});

await test('rankByWords: DJ + jaar + ander woord nodig; generieke woorden tellen niet', () => {
  const r = (q, items) => M.rankByWords(q, items)[0];
  assert.equal(r('Andhim komm schon Alter Das Festival 2026', ['2016-08-13 - andhim @ DGTL Festival, Barcelona']).ok, false);
  assert.equal(r('Andhim Das Festival 2026', ['/tracklist/a/andhim-das-festival-netherlands-2026-05-23.html']).ok, true);
  assert.equal(r('Andhim Festival', ['x andhim @ Melt Festival']).ok, false, '"festival" alleen is te generiek');
});

await test('verrijking: MusicBrainz vult isrc/album aan, één keer per track (cache)', async () => {
  let n = 0;
  api.shazam = async () => ({ artist: 'A', title: 'T', album: '', year: '' });
  globalThis.fetch = async (url, o) => {
    n++; assert.match(o.headers['User-Agent'], /^Setscout/);
    return jsonRes({ recordings: [{ id: 'mb1', score: 100, isrcs: ['NL123'], releases: [{ title: 'Rel', date: '2019-05-01' }] }] });
  };
  const p = createPipeline(settings({ shazam: { enabled: true }, musicbrainz: { enabled: true } }));
  const r = await p.recognize(ctx()); await p.recognize(ctx());
  assert.equal(r.isrc, 'NL123'); assert.equal(r.album, 'Rel'); assert.equal(r.year, '2019'); assert.equal(r.method, 'Shazam');
  assert.equal(n, 1);
});

await test('Google Zoek een nummer: intent → paplay → uiautomator-poll → titel/artiest, terug-toets', async () => {
  const xml = (t) => `<?xml version="1.0"?><hierarchy><node text="" resource-id="x:id/root"><node text="Luisteren…" resource-id="com.google:id/status"/>${t}</node></hierarchy>UI hierchary dumped to: /dev/tty`;
  const calls = []; let dumps = 0;
  api.run = async (cmd, args) => {
    calls.push(args.join(' '));
    if (args.includes('uiautomator')) return { code: 0, stdout: ++dumps < 2 ? xml('') : xml('<node text="Da Funk" resource-id="com.google:id/song_title"/><node text="Daft Punk &amp; Co" resource-id="com.google:id/song_artist"/>'), stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const cfg = { ...effectiveSettings().methods.google, adb: 'package.json', paplay: 'package.json' };
  const c = { ...ctx(), wav: () => 'frag.wav' };
  const r = await byId.google.recognize(c, cfg);
  assert.deepEqual([r.title, r.artist, r.method], ['Da Funk', 'Daft Punk & Co', 'Google']);
  assert.match(calls[0], /-s android:5555 shell am start -a com\.google\.android\.googlequicksearchbox\.MUSIC_SEARCH/);
  assert.equal(calls[1], '--server=tcp:android:4713 --device=virtmic frag.wav');
  assert.match(calls.at(-1), /keyevent KEYCODE_BACK/);
  assert.equal(dumps, 2);
});

await test('Google: geen resultaat → fout met zichtbare teksten (voor afstellen); paplay-fout netjes', async () => {
  api.run = async (cmd, args) => ({ code: 0, stdout: args.includes('uiautomator') ? '<node text="Probeer het opnieuw" resource-id="g:id/msg"/>' : '', stderr: '' });
  const cfg = { ...effectiveSettings().methods.google, adb: 'package.json', paplay: 'package.json', waitSec: 0 };
  await assert.rejects(byId.google.recognize({ ...ctx(), wav: () => 'f.wav' }, cfg), /Probeer het opnieuw \[msg\]/);
  api.run = async (cmd, args) => ({ code: args[0]?.startsWith('--server') ? 1 : 0, stdout: '', stderr: 'Connection refused' });
  await assert.rejects(byId.google.recognize({ ...ctx(), wav: () => 'f.wav' }, cfg), /paplay: Connection refused/);
  assert.equal(byId.google.status({ ...cfg, paplay: 'bestaat-niet-xyz' }).state, 'tool');
});

await test('scanner + keten end-to-end: echte ffmpeg-knip, method blijft tot in toRanges', async () => {
  const mix = join(TMP, 'mix.wav');
  assert.equal(spawnSync('ffmpeg', ['-v', 'quiet', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=40', mix]).status, 0);
  api.shazam = async () => null;
  let i = 0;
  globalThis.fetch = async () => jsonRes({ status: 'success', result: { artist: 'X', title: ++i <= 2 ? 'Eerste' : 'Tweede' } });
  const p = createPipeline(settings({ shazam: { enabled: true }, audd: { enabled: true, apiKey: 'K' } }));
  const res = await scan(mix, { step: 10, segment: 5, tmpDir: TMP, recognize: p.recognize, pause: 0, onProgress: () => {} });
  const tracks = toRanges(res.segments, 5, 10);
  assert.equal(res.segmentsScanned, 4);
  assert.deepEqual(tracks.map(t => [t.title, t.method, t.start_sec]), [['Eerste', 'AudD', 0], ['Tweede', 'AudD', 20]]);
});

await test('toRanges: exacte Van/Tot uit offsets (cluster, timeskew, stretch, grenzen)', () => {
  const A = { artist: 'A', title: 'Een' }, B = { artist: 'B', title: 'Twee' }, X = { artist: 'X', title: 'Misser' };
  const segs = [
    { pos: 500, match: null },
    { pos: 530, match: { ...A, offset: 0.5 } },                        // → 529.5
    { pos: 600, match: { ...A, offset: 69.118, timeskew: 0.0086 } },  // echte Shazam-waarden (CS - What We Had) → 531.47
    { pos: 630, match: { ...A, offset: 99.379, timeskew: 0.0088 } },  // → 531.48
    { pos: 660, match: { ...A, offset: 130.5 } },                     // → 529.5
    { pos: 690, match: { ...A, offset: 177 } },                       // herhaalde sectie → 513, kleiner cluster
    { pos: 720, match: { ...X, offset: 400 } },                       // 1×-misser: schatting vóór de vorige track → niet exact
    { pos: 750, match: { ...B, offset: 25, stretch: 0.96 } },         // Shazam −4 %: 750 − 25·0.96 = 726
    { pos: 780, match: { ...B } },                                     // zonder offset telt niet mee
  ];
  const r = toRanges(segs, 12, 30);
  assert.deepEqual(r.map(t => [t.title, t.start_sec, t.end_sec, t.exact, t.agree, t.spread, t.hits]), [
    ['Een', 530, 720, true, '4/5', 18.5, 5],     // cluster ±2 s rond 529.5: {529.5, 531.47, 531.48, 529.5} → 530.5 → 530; 513 valt erbuiten
    ['Misser', 720, 726, false, '0/1', 0, 1],
    ['Twee', 726, 792, true, '1/1', 0, 2],
  ]);
  assert.ok(!('offset' in r[0]) && !('timeskew' in r[0]));
  // een track kan niet starten na zijn eerste detectie: alleen schattingen ≤ eerste detectie + 3 s
  assert.equal(toRanges([{ pos: 0, match: null }, { pos: 30, match: { ...A, offset: -40 } }], 12, 30)[0].exact, false);
  // zonder offsets: oude gedrag (eerste detectie)
  assert.deepEqual(toRanges([{ pos: 0, match: A }, { pos: 30, match: B }], 12, 30).map(t => [t.start_sec, t.end_sec, t.exact]), [[0, 30, false], [30, 42, false]]);
});

await test('scanner zonder recognize-optie gebruikt nog steeds Shazam (CLI-pad)', async () => {
  const src = (await import('fs')).readFileSync(join(import.meta.dirname, '..', 'lib', 'scanner.mjs'), 'utf8');
  assert.match(src, /opts\.recognize \?\? \(\(\{ pcm \}\) => recognize\(pcm\)\)/);
});

console.log(`\n${passed} tests geslaagd`);
rmSync(TMP, { recursive: true, force: true });
