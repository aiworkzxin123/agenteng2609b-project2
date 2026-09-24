// Escape from CT Hub — zero-dependency local server.
// Proxies + caches public Singapore APIs (no keys needed) and serves ./public.
// The data shaping lives in public/core.js, shared with the static GitHub Pages build.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const core = require('./public/core.js');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const DAY = 24 * 3600 * 1000;

// ---------- helpers ----------
const memo = new Map(); // key -> { t, value, pending }

// Cache an async fetch for `ttl` ms; dedupe concurrent calls; serve stale on error.
async function cached(key, ttl, fn) {
  const hit = memo.get(key);
  if (hit && hit.value !== undefined && Date.now() - hit.t < ttl) return hit.value;
  if (hit && hit.pending) return hit.pending;
  const pending = (async () => {
    try {
      const value = await fn();
      memo.set(key, { t: Date.now(), value });
      return value;
    } catch (err) {
      if (hit && hit.value !== undefined) {
        memo.set(key, { ...hit, pending: null });
        return hit.value;
      }
      memo.delete(key);
      throw err;
    }
  })();
  memo.set(key, { ...(hit || {}), pending });
  return pending;
}

// Like cached(), but also persisted to ./data so big static datasets survive restarts.
async function diskCached(name, ttl, fn) {
  const file = path.join(DATA_DIR, name + '.json');
  return cached('disk:' + name, ttl, async () => {
    try {
      const st = fs.statSync(file);
      if (Date.now() - st.mtimeMs < ttl) return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {}
    try {
      const value = await fn();
      fs.writeFileSync(file, JSON.stringify(value));
      return value;
    } catch (err) {
      if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
      throw err;
    }
  });
}

async function getJSON(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'escape-from-ct-hub/1.0', Accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`${res.status} from ${url}`);
  return res.json();
}

// ---------- data sources ----------
const { URLS } = core;
const getStops = () => diskCached('stops', DAY, () => getJSON(URLS.stops));
const getServices = () => diskCached('services', DAY, () => getJSON(URLS.services));
const getArrivals = (code) => cached('arr:' + code, 15000, () => getJSON(URLS.arrivals(code)));
const getCarparkInfo = () => diskCached('carpark-info', 7 * DAY, async () =>
  core.carparkInfoFromRecords((await getJSON(URLS.carparkInfo)).result.records));
const gov = (p, ttl) => cached('gov:' + p, ttl, () => getJSON(URLS.gov(p)));

// ---------- API handlers ----------
const latLng = (q) => [+q.get('lat'), +q.get('lng')];

const routes = {
  '/api/stops': async () => core.stopsList(await getStops()),

  '/api/bus': async (q) => {
    const [lat, lng] = latLng(q);
    const [stops, services] = await Promise.all([getStops(), getServices()]);
    return core.planBus({ lat, lng, dest: q.get('dest'), stops, services, getArrivals });
  },

  '/api/taxi': async (q) => core.taxiSummary(await gov('transport/taxi-availability', 30000), ...latLng(q)),

  '/api/carparks': async (q) => {
    const [info, avail] = await Promise.all([getCarparkInfo(), gov('transport/carpark-availability', 60000)]);
    return core.carparkSummary(info, avail, ...latLng(q));
  },

  '/api/cams': async () => core.camsSummary(await gov('transport/traffic-images', 60000)),

  '/api/weather': async (q) => {
    const [lat, lng] = latLng(q);
    const key = lat.toFixed(2) + ',' + lng.toFixed(2);
    const safe = (p) => p.catch(() => null);
    const [fc, rain, temp, uv, pm, om] = await Promise.all([
      safe(gov('environment/2-hour-weather-forecast', 5 * 60000)),
      safe(gov('environment/rainfall', 5 * 60000)),
      safe(gov('environment/air-temperature', 5 * 60000)),
      safe(gov('environment/uv-index', 15 * 60000)),
      safe(gov('environment/pm25', 15 * 60000)),
      safe(cached('om:' + key, 10 * 60000, () => getJSON(URLS.openMeteo(lat, lng)))),
    ]);
    return core.weatherSummary({ fc, rain, temp, uv, pm, om }, lat, lng);
  },

  '/api/fx': () => cached('fx', 6 * 3600 * 1000, async () => core.fxSummary(await getJSON(URLS.fx))),
};

// ---------- server ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const handler = routes[url.pathname];
  if (handler) {
    try {
      const data = await handler(url.searchParams);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(data));
    } catch (err) {
      console.error(url.pathname, err.message);
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }
  const rel = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`\n  ESCAPE FROM CT HUB  >>  http://localhost:${PORT}\n`);
    // Warm the big static datasets in the background.
    getStops().catch(() => {}); getServices().catch(() => {}); getCarparkInfo().catch(() => {});
  });
}

module.exports = { svy21ToLatLng: core.svy21ToLatLng, distM: core.distM };
