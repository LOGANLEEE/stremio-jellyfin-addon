// Acceptance checks for plan.md AC0..AC18. Run against the real add-on and the real Jellyfin library.
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

const HOME = os.homedir();
const BIND = process.env.ADDON_HOST || process.env.BIND_ADDRESS;
if (!BIND) { console.error('set ADDON_HOST to the add-on LAN address'); process.exit(2); }
const PORT = Number(process.env.PORT || 8796);
const BASE = `http://${BIND}:${PORT}`;
const KEY_FILE = process.env.JELLYFIN_KEY_FILE || `${HOME}/.config/stremio-jellyfin-addon/jellyfin-key`;
const TOKEN_FILE = process.env.TOKEN_FILE || `${HOME}/.config/stremio-jellyfin-addon/token`;
const LABEL = process.env.LAUNCHD_LABEL || 'io.github.stremio-jellyfin-addon';
const PLIST = `${HOME}/Library/LaunchAgents/${LABEL}.plist`;
const LOG = `${HOME}/Library/Logs/stremio-jellyfin-addon.log`;
const HERE = path.dirname(new URL(import.meta.url).pathname);
const JF = (process.env.JELLYFIN_URL || 'http://127.0.0.1:8096').replace(/\/$/, '');
const PROJECTOR = process.env.PROJECTOR_ADB; // optional: adb target of a TV, enables AC0 and AC14

const sleep = ms => new Promise(r => setTimeout(r, ms));
const assert = (c, m) => { if (!c) throw new Error(m); };
const readKey = () => fs.readFileSync(KEY_FILE, 'utf8').trim();
const readToken = () => fs.readFileSync(TOKEN_FILE, 'utf8').trim();

function req(url, { headers = {}, timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.get(url, { headers, timeout }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    r.on('timeout', () => r.destroy(new Error('timeout ' + url)));
    r.on('error', reject);
  });
}
const json = r => JSON.parse(r.body.toString('utf8'));
const jf = async p => json(await req(JF + p, { headers: { Authorization: `MediaBrowser Token="${readKey()}"` } }));
const addon = (p, o) => req(`${BASE}/${readToken()}${p}`, o);

async function pagedCatalog(type, id) {
  const all = [];
  for (let skip = 0; skip < 5000; skip += 100) {
    const r = await addon(`/catalog/${type}/${id}/${skip ? `skip=${skip}` : 'x=1'}.json`.replace('/x=1', ''));
    assert(r.status === 200, `catalog ${type} skip=${skip} status ${r.status}`);
    const m = json(r).metas;
    if (!m.length) break;
    all.push(...m);
  }
  return all;
}

let cache;
async function data() {
  if (cache) return cache;
  // CollapseBoxSetItems=false: Jellyfin otherwise hides box-set members and counts the BoxSet itself as a Movie.
  const all = (await jf('/Items?Recursive=true&IncludeItemTypes=Movie,Series,Episode&CollapseBoxSetItems=false&Fields=ProviderIds')).Items;
  const n = t => all.filter(i => i.Type === t).length;
  const total = async t => n(t);
  const movie = all.find(m => m.Type === 'Movie' && m.ProviderIds?.Imdb);
  const series = all.filter(i => i.Type === 'Series');
  let tv;
  for (const s of series) {
    if (!s.ProviderIds?.Imdb) continue;
    const eps = (await jf(`/Items?ParentId=${s.Id}&Recursive=true&IncludeItemTypes=Episode&Fields=ProviderIds`)).Items;
    if (eps.length) { tv = { series: s, eps }; break; }
  }
  return (cache = { nMovie: await total('Movie'), nSeries: await total('Series'), nEpisode: await total('Episode'), movie, tv });
}

async function rangeCheck(url) {
  const r = await req(url, { headers: { Range: 'bytes=0-1023' } });
  assert(r.status === 206, `Range status ${r.status}, want 206`);
  assert(r.body.length === 1024, `Range body ${r.body.length} bytes, want 1024`);
}

function spawnAddon(env) {
  const child = spawn(process.execPath, [path.join(HERE, 'src/server.js')], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  child.stderr.on('data', d => (err += d));
  child.stdout.on('data', d => (err += d));
  const exited = new Promise(r => child.on('exit', code => r(code)));
  return { child, out: () => err, exited };
}
function tmpFile(content, mode) {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sja-')), 'f');
  fs.writeFileSync(f, content); fs.chmodSync(f, mode); return f;
}
async function waitFor(fn, ms, step = 300) {
  const t0 = Date.now();
  for (;;) { try { const v = await fn(); if (v) return v; } catch {} if (Date.now() - t0 > ms) return null; await sleep(step); }
}

const checks = {
  async AC0() {
    const f = path.join(HERE, 'evidence/ac0-install.png');
    assert(fs.existsSync(f) && fs.statSync(f).size > 1000, 'evidence/ac0-install.png missing');
  },
  async AC1() {
    const d = await data();
    const metas = await pagedCatalog('movie', 'jf-movies');
    assert(metas.length === d.nMovie, `catalog ${metas.length} movies, Jellyfin ${d.nMovie}`);
    const bad = metas.filter(m => !m.name || !m.poster?.includes('/img/') || !m.id);
    assert(!bad.length, `${bad.length} entries lack name, id or add-on poster`);
  },
  async AC2() {
    const d = await data();
    const metas = await pagedCatalog('series', 'jf-series');
    assert(metas.length === d.nSeries, `catalog ${metas.length} series, Jellyfin ${d.nSeries}`);
  },
  async AC3() {
    const d = await data();
    const term = d.movie.Name;
    const r = await addon(`/catalog/movie/jf-movies/search=${encodeURIComponent(term)}.json`);
    assert(r.status === 200, `status ${r.status}`);
    const m = json(r).metas;
    assert(m.some(x => x.id === d.movie.ProviderIds.Imdb), 'known movie missing');
    const other = m.filter(x => !x.name.toLowerCase().includes(term.toLowerCase()));
    assert(!other.length, `unrelated: ${other.map(x => x.name).join(', ')}`);
  },
  async AC4() {
    const d = await data();
    const r = await addon(`/meta/series/${d.tv.series.ProviderIds.Imdb}.json`);
    assert(r.status === 200, `status ${r.status}`);
    const v = json(r).meta.videos;
    assert(v.length === d.tv.eps.length, `${v.length} videos, Jellyfin ${d.tv.eps.length} episodes`);
    assert(v.every(x => /^tt\d+:\d+:\d+$/.test(x.id)), 'video id not tt:season:episode');
  },
  async AC5() {
    const d = await data();
    const r = await addon(`/stream/movie/${d.movie.ProviderIds.Imdb}.json`);
    const s = json(r).streams;
    assert(s.length === 1, `${s.length} streams, want 1`);
    await rangeCheck(s[0].url);
  },
  async AC6() {
    const d = await data();
    const e = d.tv.eps.find(x => x.ParentIndexNumber != null && x.IndexNumber != null);
    const r = await addon(`/stream/series/${d.tv.series.ProviderIds.Imdb}:${e.ParentIndexNumber}:${e.IndexNumber}.json`);
    const s = json(r).streams;
    assert(s.length >= 1, 'no stream for a real episode');
    await rangeCheck(s[0].url);
  },
  async AC7() {
    const r = await addon('/stream/movie/tt9999999.json');
    assert(r.status === 200 && json(r).streams.length === 0, `status ${r.status}, streams not empty`);
  },
  async AC18() {
    const d = await data();
    const r = await addon(`/stream/series/${d.tv.series.ProviderIds.Imdb}:0:999.json`);
    assert(r.status === 200 && json(r).streams.length === 0, `status ${r.status}, streams not empty`);
  },
  async AC8() {
    const key = readKey();
    const d = await data();
    const cat = await addon('/catalog/movie/jf-movies.json');
    const poster = json(cat).metas[0].poster;
    const st = await addon(`/stream/movie/${d.movie.ProviderIds.Imdb}.json`);
    const url = json(st).streams[0].url;
    const play = await req(url, { headers: { Range: 'bytes=0-99' } });
    const img = await req(poster);
    assert(img.status === 200 && /^image\//.test(img.headers['content-type'] || ''), `poster status ${img.status}`);
    const parts = [await addon('/manifest.json'), cat, await addon(`/meta/series/${d.tv.series.ProviderIds.Imdb}.json`), st, play];
    for (const p of parts) {
      const hdr = JSON.stringify(p.headers);
      const body = p.body.length < 1e6 ? p.body.toString('latin1') : '';
      assert(!hdr.includes(key) && !body.includes(key), 'key value in a response');
      assert(!/api_key/i.test(hdr) && !/api_key/i.test(body), 'api_key parameter in a response');
    }
    assert(!/api_key/i.test(poster + url), 'api_key in poster or stream url');
    assert(fs.existsSync(LOG) && fs.statSync(LOG).size > 0, `log ${LOG} missing or empty`);
    const log = fs.readFileSync(LOG, 'latin1');
    assert(!log.includes(key) && !/api_key/i.test(log), 'key or api_key in launchd log');
  },
  async AC9() {
    const d = await data();
    const url = json(await addon(`/stream/movie/${d.movie.ProviderIds.Imdb}.json`)).streams[0].url;
    const bad = url.replace(readToken(), 'f'.repeat(64));
    const r = await req(bad, { headers: { Range: 'bytes=0-1023' } });
    assert([403, 404].includes(r.status), `wrong token status ${r.status}`);
    assert(r.body.length < 512, `wrong token returned ${r.body.length} bytes`);
    const log = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8') : '';
    assert(!log.includes(readToken()), 'token value in log');
    const src = fs.readFileSync(path.join(HERE, 'src/server.js'), 'utf8');
    assert(src.includes('timingSafeEqual'), 'token compare is not timingSafeEqual');
  },
  async AC10() {
    for (const h of [{ 'Cf-Connecting-Ip': '1.2.3.4' }, { 'X-Forwarded-For': '1.2.3.4' }]) {
      const r = await addon('/manifest.json', { headers: h });
      assert(r.status === 403, `${Object.keys(h)[0]} status ${r.status}, want 403`);
    }
  },
  async AC11() {
    const r = await addon('/manifest.json');
    assert(r.headers['access-control-allow-origin'] === '*', 'CORS header missing');
    const m = json(r);
    for (const x of ['catalog', 'meta', 'stream']) assert(JSON.stringify(m.resources).includes(`"${x}"`), `resource ${x} missing`);
    for (const x of ['movie', 'series']) assert(m.types.includes(x), `type ${x} missing`);
  },
  async AC12() {
    const tokenFile = tmpFile('t'.repeat(64), 0o600);
    const run = async (jfUrl, port) => {
      const a = spawnAddon({ PORT: port, BIND_ADDRESS: '127.0.0.1', TOKEN_FILE: tokenFile, JELLYFIN_KEY_FILE: KEY_FILE, JELLYFIN_URL: jfUrl, REFRESH_SECONDS: '2' });
      return a;
    };
    const b = port => `http://127.0.0.1:${port}/${'t'.repeat(64)}`;
    // first start, Jellyfin down
    const a1 = await run('http://127.0.0.1:1', '8741');
    try {
      assert(await waitFor(async () => (await req(`${b(8741)}/manifest.json`)).status === 200, 5000), 'manifest not 200 with Jellyfin down');
      const c = await req(`${b(8741)}/catalog/movie/jf-movies.json`);
      assert(c.status === 200 && json(c).metas.length === 0, 'first-start catalog not empty list with 200');
      const t0 = Date.now();
      const p = await req(`${b(8741)}/play/abc`);
      assert([502, 503].includes(p.status) && Date.now() - t0 < 10000, `play while down: ${p.status}`);
      assert(a1.child.exitCode === null, 'process exited');
    } finally { a1.child.kill(); }
    // good index, then Jellyfin goes down
    let down = false;
    const proxy = http.createServer((q, s) => {
      if (down) return q.socket.destroy();
      const u = http.request({ host: '127.0.0.1', port: 8096, path: q.url, method: q.method, headers: q.headers }, r => { s.writeHead(r.statusCode, r.headers); r.pipe(s); });
      u.on('error', () => s.destroy()); q.pipe(u);
    });
    await new Promise(r => proxy.listen(0, '127.0.0.1', r));
    const a2 = await run(`http://127.0.0.1:${proxy.address().port}`, '8742');
    try {
      const n = await waitFor(async () => { const m = json(await req(`${b(8742)}/catalog/movie/jf-movies.json`)).metas.length; return m; }, 20000);
      assert(n, 'index never loaded: ' + a2.out().replace(/\n/g, ' | ').slice(0, 300));
      down = true; await sleep(5000);
      const after = json(await req(`${b(8742)}/catalog/movie/jf-movies.json`)).metas.length;
      assert(after > 0, 'cached catalog lost when Jellyfin went down');
      const st = await req(`${b(8742)}/stream/movie/tt0111161.json`);
      assert(st.status === 200 && json(st).streams.length === 0, 'stream while down not empty 200');
      assert(a2.child.exitCode === null, 'process exited');
    } finally { a2.child.kill(); proxy.close(); }
  },
  async AC13() {
    assert(fs.existsSync(PLIST), `plist ${PLIST} missing`);
    const pl = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', PLIST]).toString());
    assert(pl.Label === LABEL, 'wrong label');
    assert(pl.RunAtLoad === true, 'RunAtLoad not true');
    assert(pl.KeepAlive, 'KeepAlive missing');
    const node = pl.ProgramArguments?.[0];
    assert(node && node.startsWith('/') && fs.existsSync(node), `node path not absolute or missing: ${node}`);
    const uid = process.getuid();
    const pid = () => Number((execFileSync('launchctl', ['print', `gui/${uid}/${LABEL}`]).toString().match(/\bpid = (\d+)/) || [])[1]);
    const up = async () => (await addon('/manifest.json')).status === 200;
    assert(await waitFor(up, 5000), 'manifest not answering before kill');
    const p0 = pid(); assert(p0, 'no pid in launchctl print');
    process.kill(p0, 'SIGKILL');
    assert(await waitFor(async () => (await up()) && pid() !== p0, 15000, 500), 'not back within 15 s after kill');
    execFileSync('launchctl', ['bootout', `gui/${uid}/${LABEL}`]);
    await sleep(1000);
    execFileSync('launchctl', ['bootstrap', `gui/${uid}`, PLIST]);
    assert(await waitFor(up, 15000, 500), 'not back within 15 s after bootout/bootstrap');
  },
  async AC14() {
    const t = readToken();
    const cmd = `printf 'GET /${t}/manifest.json HTTP/1.0\\r\\n\\r\\n' | toybox nc -w 3 ${BIND} ${PORT}`;
    const out = execFileSync('adb', ['-s', PROJECTOR, 'shell', cmd], { timeout: 20000 }).toString();
    assert(/^HTTP\/1\.\d 200/.test(out), 'projector did not get HTTP 200');
    assert(out.includes('"resources"'), 'projector response has no manifest');
  },
  async AC15() {
    const out = execFileSync('lsof', ['-nP', `-iTCP:${PORT}`, '-sTCP:LISTEN']).toString();
    assert(out.includes(`${BIND}:${PORT}`), `not listening on ${BIND}:${PORT}`);
    assert(!out.includes(`*:${PORT}`), 'listening on *');
    let refused = false;
    try { await req(`http://127.0.0.1:${PORT}/x`, { timeout: 3000 }); } catch { refused = true; }
    assert(refused, '127.0.0.1 accepted a connection');
  },
  async AC16() {
    const d = await data();
    const t = readToken();
    for (const host of [`${BIND}:${PORT}`, `example.lan:${PORT}`]) {
      const r = await req(`${BASE}/${t}/stream/movie/${d.movie.ProviderIds.Imdb}.json`, { headers: { Host: host } });
      const u = json(r).streams[0].url;
      assert(u.startsWith(`http://${host}/`), `url ${u.split('/').slice(0, 3).join('/')} for Host ${host}`);
    }
  },
  async AC19() {
    // Jellyfin behind HTTPS and a base path (reverse proxy): the add-on must use TLS and keep the prefix.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sja-tls-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${dir}/k.pem`, '-out', `${dir}/c.pem`, '-days', '1', '-subj', '/CN=127.0.0.1'], { stdio: 'ignore' });
    const seen = [];
    const srv = https.createServer({ key: fs.readFileSync(`${dir}/k.pem`), cert: fs.readFileSync(`${dir}/c.pem`) }, (q, s) => {
      seen.push({ url: q.url, auth: q.headers.authorization });
      const ok = q.url.startsWith('/jf/Items?');
      s.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' });
      s.end(JSON.stringify({ Items: [{ Id: 'a'.repeat(32), Name: 'Tls Movie', Type: 'Movie', ProductionYear: 2020, ProviderIds: { Imdb: 'tt0000001' } }] }));
    });
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    const dummyKey = tmpFile('dummy-key-for-tls-test', 0o600);
    const a = spawnAddon({ PORT: '8744', BIND_ADDRESS: '127.0.0.1', TOKEN_FILE: tmpFile('t'.repeat(64), 0o600), JELLYFIN_KEY_FILE: dummyKey, JELLYFIN_URL: `https://127.0.0.1:${srv.address().port}/jf/`, NODE_TLS_REJECT_UNAUTHORIZED: '0', REFRESH_SECONDS: '600' });
    try {
      const m = await waitFor(async () => { const j = json(await req(`http://127.0.0.1:8744/${'t'.repeat(64)}/catalog/movie/jf-movies.json`)); return j.metas.length ? j.metas : null; }, 10000);
      assert(m && m[0].name === 'Tls Movie', 'catalog did not come through https with base path /jf: ' + a.out().slice(0, 200));
      assert(seen.every(x => x.url.startsWith('/jf/')), 'a request lost the /jf prefix: ' + seen.map(x => x.url).join(' '));
      assert(seen[0].auth === 'MediaBrowser Token="dummy-key-for-tls-test"', 'Authorization header missing over https');
    } finally { a.child.kill(); srv.close(); }
  },
  async AC20() {
    for (const kind of ['constructor', '__proto__', 'toString']) {
      const r = await addon(`/img/${'0'.repeat(32)}/${kind}`);
      assert(r.status === 404, `img kind ${kind} returned ${r.status}, want 404`);
    }
  },
  async AC17() {
    const goodToken = () => tmpFile('t'.repeat(64), 0o600);
    const base = { PORT: '8743', BIND_ADDRESS: '127.0.0.1', JELLYFIN_URL: JF, JELLYFIN_KEY_FILE: KEY_FILE };
    const empty = tmpFile('', 0o600), loose = tmpFile('t'.repeat(64), 0o644), keyLoose = tmpFile('dummykeyvalue', 0o644);
    const cases = [
      ['token missing', { TOKEN_FILE: '/nonexistent/token' }, '/nonexistent/token'],
      ['token empty', { TOKEN_FILE: empty }, empty],
      ['token mode 644', { TOKEN_FILE: loose }, loose],
      ['key missing', { TOKEN_FILE: goodToken(), JELLYFIN_KEY_FILE: '/nonexistent/key' }, '/nonexistent/key'],
      ['key mode 644', { TOKEN_FILE: goodToken(), JELLYFIN_KEY_FILE: keyLoose }, keyLoose],
    ];
    for (const [name, env, file] of cases) {
      const a = spawnAddon({ ...base, ...env });
      const code = await Promise.race([a.exited, sleep(5000).then(() => 'alive')]);
      if (code === 'alive') a.child.kill();
      assert(code !== 'alive' && code !== 0, `${name}: did not exit non-zero (${code})`);
      assert(a.out().includes(file), `${name}: message lacks the file path`);
      assert(!a.out().includes('dummykeyvalue') && !a.out().includes('t'.repeat(64)), `${name}: message shows a secret value`);
    }
    let rows = '';
    try { rows = execFileSync('lsof', ['-nP', '-iTCP:8743', '-sTCP:LISTEN'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch {} // lsof exits 1 when nothing listens
    assert(rows === '', 'something listens on 8743');
  },
};

const only = process.argv.slice(2);
const needsTv = ['AC0', 'AC14'];
const names = Object.keys(checks).filter(n => (!only.length || only.includes(n)) && (PROJECTOR || !needsTv.includes(n)));
if (!PROJECTOR) console.log('skip AC0 AC14 (set PROJECTOR_ADB=<host:port> to run them)');
let passed = 0, failed = 0;
for (const n of names) {
  try { await checks[n](); console.log(`ok ${n}`); passed++; }
  catch (e) { console.log(`FAIL ${n}: ${String(e.message).split('\n')[0]}`); failed++; }
}
console.log(`${names.length} checks (${passed} passed, ${failed} failed)`);
process.exit(failed ? 1 : 0);
