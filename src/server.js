'use strict';
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');

// Optional KEY=VALUE file (see .env.example). Real environment variables win.
try {
  const f = process.env.ENV_FILE || `${os.homedir()}/.config/stremio-jellyfin-addon/env`;
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
} catch { /* no env file */ }
const env = process.env;
const PORT = Number(env.PORT || 8796);
const BIND_ADDRESS = env.BIND_ADDRESS || '127.0.0.1';
const JELLYFIN = new URL(env.JELLYFIN_URL || 'http://127.0.0.1:8096');
const KEY_FILE = env.JELLYFIN_KEY_FILE || `${os.homedir()}/.config/stremio-jellyfin-addon/jellyfin-key`;
const TOKEN_FILE = env.TOKEN_FILE || `${os.homedir()}/.config/stremio-jellyfin-addon/token`;
const REFRESH_MS = Number(env.REFRESH_SECONDS || 600) * 1000;
const PAGE = 100;

function readSecret(file, what) {
  let st;
  try { st = fs.statSync(file); } catch { die(`${what} file missing: ${file}`); }
  if (st.mode & 0o077) die(`${what} file must be mode 600: ${file}`);
  const v = fs.readFileSync(file, 'utf8').trim();
  if (!v) die(`${what} file is empty: ${file}`);
  return v;
}
function die(msg) { console.error(`stremio-jellyfin-addon: ${msg}`); process.exit(1); }

const TOKEN = readSecret(TOKEN_FILE, 'token');
const KEY = readSecret(KEY_FILE, 'Jellyfin key');
const TOKEN_HASH = crypto.createHash('sha256').update(TOKEN).digest();
const AUTH = { Authorization: `MediaBrowser Token="${KEY}"` };

// ---- Jellyfin ----
function jfRequest(path, { headers = {}, timeout = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const secure = JELLYFIN.protocol === 'https:';
    const r = (secure ? https : http).request({
      host: JELLYFIN.hostname, port: JELLYFIN.port || (secure ? 443 : 80), method: 'GET',
      path: JELLYFIN.pathname.replace(/\/+$/, '') + path, // keep a reverse-proxy base path such as /jellyfin
      headers: { ...AUTH, ...headers },
    }, resolve);
    r.setTimeout(timeout, () => r.destroy(new Error('Jellyfin timeout')));
    r.on('error', reject);
    r.end();
  });
}
async function jfJson(path) {
  const res = await jfRequest(path);
  const chunks = [];
  for await (const c of res) chunks.push(c);
  if (res.statusCode !== 200) throw new Error(`Jellyfin ${res.statusCode}`);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

// ---- index (in memory) ----
let index = { movies: [], series: [], byId: new Map(), episodes: new Map() };
const metaId = it => it.imdb || `jf:${it.id}`;
async function refresh() {
  const d = await jfJson('/Items?Recursive=true&IncludeItemTypes=Movie,Series,Episode&CollapseBoxSetItems=false&Fields=ProviderIds,Overview,Genres,ProductionYear,CommunityRating,PremiereDate');
  const next = { movies: [], series: [], byId: new Map(), episodes: new Map() };
  for (const i of d.Items) {
    const it = { id: i.Id, name: i.Name, year: i.ProductionYear, imdb: i.ProviderIds && i.ProviderIds.Imdb, overview: i.Overview, genres: i.Genres, rating: i.CommunityRating, premiere: i.PremiereDate };
    if (i.Type === 'Movie') { next.movies.push(it); next.byId.set(metaId(it), it); }
    else if (i.Type === 'Series') { next.series.push(it); next.byId.set(metaId(it), it); }
    else if (i.Type === 'Episode' && i.SeriesId && i.ParentIndexNumber != null && i.IndexNumber != null) {
      const list = next.episodes.get(i.SeriesId) || [];
      list.push({ ...it, season: i.ParentIndexNumber, episode: i.IndexNumber });
      next.episodes.set(i.SeriesId, list);
    }
  }
  index = next;
  console.log(`index: ${next.movies.length} movies, ${next.series.length} series`);
}
let refreshing = false;
async function safeRefresh() {
  if (refreshing) return;
  refreshing = true;
  try { await refresh(); } catch (e) { console.error(`refresh failed: ${e.message}`); } finally { refreshing = false; }
}

// ---- Stremio responses ----
const manifest = {
  id: env.ADDON_ID || 'io.github.stremio-jellyfin-addon',
  version: '1.0.0',
  name: env.ADDON_NAME || 'Jellyfin (self-hosted)',
  description: 'Your own Jellyfin library, LAN only',
  resources: ['catalog', 'meta', 'stream'],
  types: ['movie', 'series'],
  idPrefixes: ['tt', 'jf:'],
  catalogs: [
    { type: 'movie', id: 'jf-movies', name: 'Jellyfin Movies', extra: [{ name: 'search' }, { name: 'skip' }] },
    { type: 'series', id: 'jf-series', name: 'Jellyfin Series', extra: [{ name: 'search' }, { name: 'skip' }] },
  ],
};
const img = (base, id, kind) => `${base}/img/${id}/${kind}`;
function metaOf(it, type, base) {
  return {
    id: metaId(it), type, name: it.name,
    poster: img(base, it.id, 'Primary'), background: img(base, it.id, 'Backdrop'),
    description: it.overview, genres: it.genres, releaseInfo: it.year ? String(it.year) : undefined,
    imdbRating: it.rating ? String(it.rating.toFixed(1)) : undefined,
  };
}
function parseExtra(s) {
  const out = {};
  if (!s) return out;
  for (const part of decodeURIComponent(s).split('&')) { const k = part.indexOf('='); if (k > 0) out[part.slice(0, k)] = part.slice(k + 1); }
  return out;
}
function catalog(type, id, extra, base) {
  const list = type === 'movie' && id === 'jf-movies' ? index.movies : type === 'series' && id === 'jf-series' ? index.series : null;
  if (!list) return null;
  const x = parseExtra(extra);
  let items = list;
  if (x.search) items = items.filter(i => i.name.toLowerCase().includes(x.search.toLowerCase()));
  const skip = Number(x.skip) || 0;
  return { metas: items.slice(skip, skip + PAGE).map(i => metaOf(i, type, base)) };
}
function meta(type, id, base) {
  const it = index.byId.get(id);
  if (!it || !(type === 'movie' ? index.movies : index.series).includes(it)) return { meta: null };
  const m = metaOf(it, type, base);
  if (type === 'series') {
    m.videos = (index.episodes.get(it.id) || []).map(e => ({
      id: `${metaId(it)}:${e.season}:${e.episode}`, title: e.name, season: e.season, episode: e.episode,
      released: e.premiere || '1970-01-01T00:00:00.000Z', overview: e.overview, thumbnail: img(base, e.id, 'Primary'),
    }));
  }
  return { meta: m };
}
function streams(type, id, base) {
  let item;
  if (type === 'movie') item = index.movies.includes(index.byId.get(id)) ? index.byId.get(id) : null;
  else {
    const p = id.split(':');
    const [sid, s, e] = p[0] === 'jf' ? [`jf:${p[1]}`, p[2], p[3]] : [p[0], p[1], p[2]];
    const series = index.byId.get(sid);
    if (series && index.series.includes(series)) item = (index.episodes.get(series.id) || []).find(x => x.season === Number(s) && x.episode === Number(e));
  }
  if (!item) return { streams: [] };
  return { streams: [{ name: 'Jellyfin', title: item.name, url: `${base}/play/${item.id}` }] };
}

// ---- proxies ----
const COPY = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag'];
async function proxy(req, res, path, headers, timeout) {
  let up;
  try { up = await jfRequest(path, { headers, timeout }); } catch { return send(res, 502, 'upstream unavailable'); }
  const h = {};
  for (const k of COPY) if (up.headers[k]) h[k] = up.headers[k];
  res.writeHead(up.statusCode, h);
  up.on('error', () => res.destroy());
  res.on('close', () => up.destroy());
  up.pipe(res);
}
function play(req, res, id) {
  const h = {};
  for (const k of ['range', 'if-range']) if (req.headers[k]) h[k] = req.headers[k];
  return proxy(req, res, `/Videos/${id}/stream?static=true`, h, 30000);
}
const IMG_QUERY = { Primary: 'maxHeight=600&quality=85', Backdrop: 'maxWidth=1280&quality=80' };
function image(req, res, id, kind) {
  if (!Object.hasOwn(IMG_QUERY, kind)) return send(res, 404, 'not found');
  return proxy(req, res, `/Items/${id}/Images/${kind}?${IMG_QUERY[kind]}`, {}, 10000);
}

// ---- http ----
function send(res, status, body, type = 'text/plain') {
  const buf = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': typeof body === 'string' ? type : 'application/json', 'Content-Length': Buffer.byteLength(buf) });
  res.end(buf);
}
function tokenOk(seg) {
  const h = crypto.createHash('sha256').update(seg).digest();
  return crypto.timingSafeEqual(h, TOKEN_HASH);
}
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  const log = status => console.log(`${req.method} ${req.url.replace(/^\/[^/?]*/, '/<token>')} ${status}`);
  res.on('finish', () => log(res.statusCode));
  try {
    if (req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for']) return send(res, 403, 'forbidden');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    const url = new URL(req.url, 'http://x');
    const parts = url.pathname.split('/').filter(Boolean);
    if (!parts.length || !tokenOk(decodeURIComponent(parts[0]))) return send(res, 404, 'not found');
    const base = `http://${req.headers.host}/${parts[0]}`;
    const [, kind, a, b, c] = parts;
    const strip = s => decodeURIComponent(s || '').replace(/\.json$/, '');
    if (kind === 'manifest.json') return send(res, 200, manifest);
    if (kind === 'catalog' && a && b) {
      const r = catalog(a, strip(b), c && strip(c), base);
      return r ? send(res, 200, r) : send(res, 404, 'not found');
    }
    if (kind === 'meta' && a && b) return send(res, 200, meta(a, strip(b), base));
    if (kind === 'stream' && a && b) return send(res, 200, streams(a, strip(b), base));
    if (kind === 'play' && /^[A-Za-z0-9-]{1,64}$/.test(a || '')) return play(req, res, a);
    if (kind === 'img' && /^[A-Za-z0-9-]{1,64}$/.test(a || '')) return image(req, res, a, b);
    return send(res, 404, 'not found');
  } catch (e) {
    console.error(`error: ${e.message}`);
    if (!res.headersSent) send(res, 500, 'error');
  }
});
server.on('error', e => die(`listen failed on ${BIND_ADDRESS}:${PORT}: ${e.message}`));
server.listen(PORT, BIND_ADDRESS, () => {
  console.log(`listening on ${BIND_ADDRESS}:${PORT}`);
  safeRefresh();
  setInterval(safeRefresh, REFRESH_MS).unref();
});
