// Escape from CT Hub — zero-dependency local server.
// Proxies + caches public Singapore APIs (no keys needed) and serves ./public.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

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

function distM(lat1, lng1, lat2, lng2) {
  const r = Math.PI / 180;
  const dLat = (lat2 - lat1) * r;
  const dLng = (lng2 - lng1) * r;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(a));
}

// SVY21 (Singapore grid) -> WGS84, used for HDB carpark coordinates.
function svy21ToLatLng(N, E) {
  const a = 6378137, f = 1 / 298.257223563;
  const oLat = 1.366666, oLon = 103.833333, oN = 38744.572, oE = 28001.642, k = 1;
  const rad = Math.PI / 180;
  const b = a * (1 - f);
  const e2 = 2 * f - f * f, e4 = e2 * e2, e6 = e4 * e2;
  const A0 = 1 - e2 / 4 - (3 * e4) / 64 - (5 * e6) / 256;
  const A2 = (3 / 8) * (e2 + e4 / 4 + (15 * e6) / 128);
  const A4 = (15 / 256) * (e4 + (3 * e6) / 4);
  const A6 = (35 * e6) / 3072;
  const calcM = (lat) => {
    const l = lat * rad;
    return a * (A0 * l - A2 * Math.sin(2 * l) + A4 * Math.sin(4 * l) - A6 * Math.sin(6 * l));
  };
  const n = (a - b) / (a + b), n2 = n * n, n3 = n2 * n, n4 = n2 * n2;
  const G = a * (1 - n) * (1 - n2) * (1 + (9 * n2) / 4 + (225 * n4) / 64) * rad;

  const Mprime = calcM(oLat) + (N - oN) / k;
  const sigma = (Mprime / G) * rad;
  const latP = sigma
    + ((3 * n) / 2 - (27 * n3) / 32) * Math.sin(2 * sigma)
    + ((21 * n2) / 16 - (55 * n4) / 32) * Math.sin(4 * sigma)
    + ((151 * n3) / 96) * Math.sin(6 * sigma)
    + ((1097 * n4) / 512) * Math.sin(8 * sigma);
  const s = Math.sin(latP), s2 = s * s;
  const rho = (a * (1 - e2)) / Math.pow(1 - e2 * s2, 1.5);
  const v = a / Math.sqrt(1 - e2 * s2);
  const psi = v / rho, psi2 = psi * psi, psi3 = psi2 * psi, psi4 = psi3 * psi;
  const t = Math.tan(latP), t2 = t * t, t4 = t2 * t2, t6 = t4 * t2;
  const Ep = E - oE;
  const x = Ep / (k * v), x3 = x ** 3, x5 = x ** 5, x7 = x ** 7;

  const lf = t / (k * rho);
  const lat = latP
    - lf * ((Ep * x) / 2)
    + lf * ((Ep * x3) / 24) * (-4 * psi2 + 9 * psi * (1 - t2) + 12 * t2)
    - lf * ((Ep * x5) / 720) * (8 * psi4 * (11 - 24 * t2) - 12 * psi3 * (21 - 71 * t2)
        + 15 * psi2 * (15 - 98 * t2 + 15 * t4) + 180 * psi * (5 * t2 - 3 * t4) + 360 * t4)
    + lf * ((Ep * x7) / 40320) * (1385 - 3633 * t2 + 4095 * t4 + 1575 * t6);

  const sec = 1 / Math.cos(latP);
  const lon = oLon * rad
    + x * sec
    - ((x3 * sec) / 6) * (psi + 2 * t2)
    + ((x5 * sec) / 120) * (-4 * psi3 * (1 - 6 * t2) + psi2 * (9 - 68 * t2) + 72 * psi * t2 + 24 * t4)
    - ((x7 * sec) / 5040) * (61 + 662 * t2 + 1320 * t4 + 720 * t6);

  return [lat / rad, lon / rad];
}

// ---------- data sources ----------
const getStops = () => diskCached('stops', DAY, () => getJSON('https://data.busrouter.sg/v1/stops.min.json'));
const getServices = () => diskCached('services', DAY, () => getJSON('https://data.busrouter.sg/v1/services.min.json'));

const getArrivals = (code) => cached('arr:' + code, 15000, () =>
  getJSON('https://arrivelah2.busrouter.sg/?id=' + encodeURIComponent(code)));

const getCarparkInfo = () => diskCached('carpark-info', 7 * DAY, async () => {
  const j = await getJSON('https://data.gov.sg/api/action/datastore_search?resource_id=d_23f946fa557947f93a8043bbef41dd09&limit=5000');
  const out = {};
  for (const r of j.result.records) {
    const [lat, lng] = svy21ToLatLng(+r.y_coord, +r.x_coord);
    out[r.car_park_no] = {
      address: r.address, lat, lng, type: r.car_park_type,
      free: r.free_parking, night: r.night_parking, height: +r.gantry_height || null,
    };
  }
  return out;
});

const gov = (p, ttl) => cached('gov:' + p, ttl, () => getJSON('https://api.data.gov.sg/v1/' + p));

// ---------- API handlers ----------
function nearestBy(list, lat, lng, getLL) {
  let best = null, bestD = Infinity;
  for (const item of list) {
    const [la, ln] = getLL(item);
    const d = distM(lat, lng, la, ln);
    if (d < bestD) { bestD = d; best = item; }
  }
  return best ? { item: best, dist: bestD } : null;
}

async function apiStops() {
  const stops = await getStops();
  return Object.entries(stops).map(([code, [lng, lat, name, road]]) => [code, name, road, lat, lng]);
}

// Find for a given origin stop + service whether (and how far) it reaches any destination stop.
function reachInfo(svc, origin, destSet, stops) {
  if (!svc || !destSet) return null;
  let best = null;
  for (const route of svc.routes) {
    for (let i = 0; i < route.length; i++) {
      if (route[i] !== origin) continue;
      for (let j = i + 1; j < route.length; j++) {
        if (!destSet.has(route[j])) continue;
        let m = 0;
        for (let q = i; q < j; q++) {
          const A = stops[route[q]], B = stops[route[q + 1]];
          if (A && B) m += distM(A[1], A[0], B[1], B[0]);
        }
        const km = (m * 1.15) / 1000;
        const cand = { stops: j - i, km: +km.toFixed(1), rideMin: Math.round((km / 19) * 60 + 1), alight: route[j] };
        if (!best || cand.stops < best.stops) best = cand;
        break;
      }
    }
  }
  return best;
}

// For every stop from which some service rides directly into destSet, remember the best such leg.
function buildBoardingIndex(services, destSet, stops) {
  const idx = new Map(); // stopCode -> { no, stops, km, rideMin, alight }
  for (const [no, svc] of Object.entries(services)) {
    for (const route of svc.routes) {
      const j = route.findIndex((c) => destSet.has(c));
      if (j < 1) continue;
      let m = 0;
      for (let i = j - 1; i >= 0; i--) {
        const A = stops[route[i]], B = stops[route[i + 1]];
        if (A && B) m += distM(A[1], A[0], B[1], B[0]);
        const km = (m * 1.15) / 1000;
        const leg = { no, stops: j - i, km: +km.toFixed(1), rideMin: Math.round((km / 19) * 60 + 1), alight: route[j] };
        const prev = idx.get(route[i]);
        if (!prev || leg.km < prev.km) idx.set(route[i], leg);
      }
    }
  }
  return idx;
}

const TRANSFER_WAIT_MIN = 8; // assumed average wait for the 2nd bus

// Origin service -> first transfer stop along its route where a direct leg to the destination starts.
function transferInfo(no, svc, origin, boarding, stops) {
  if (!svc) return null;
  let best = null;
  for (const route of svc.routes) {
    const i = route.indexOf(origin);
    if (i < 0) continue;
    let m = 0;
    for (let t = i + 1; t < route.length; t++) {
      const A = stops[route[t - 1]], B = stops[route[t]];
      if (A && B) m += distM(A[1], A[0], B[1], B[0]);
      const leg2 = boarding.get(route[t]);
      if (!leg2 || leg2.no === no) continue;
      const km1 = (m * 1.15) / 1000;
      const ride1 = Math.round((km1 / 19) * 60 + 1);
      const total = ride1 + TRANSFER_WAIT_MIN + leg2.rideMin;
      if (!best || total < best.rideMin) {
        best = {
          stops: t - i, km: +(km1 + leg2.km).toFixed(1), rideMin: total, alight: leg2.alight,
          transfer: { at: route[t], ride1, stops1: t - i, no: leg2.no, stops2: leg2.stops, ride2: leg2.rideMin, wait: TRANSFER_WAIT_MIN },
        };
      }
    }
  }
  return best;
}

async function apiBus(q) {
  const lat = +q.get('lat'), lng = +q.get('lng');
  const dest = q.get('dest');
  const [stops, services] = await Promise.all([getStops(), getServices()]);

  let destSet = null, destInfo = null;
  if (dest && stops[dest]) {
    const [dl, dlat, dname, droad] = stops[dest];
    destInfo = { code: dest, name: dname, road: droad, lat: dlat, lng: dl };
    destSet = new Set([dest]);
    for (const [code, s] of Object.entries(stops)) {
      if (distM(dlat, dl, s[1], s[0]) <= 300) destSet.add(code);
    }
  }

  const boarding = destSet ? buildBoardingIndex(services, destSet, stops) : null;
  const radius = destSet ? 900 : 500;
  const maxStops = destSet ? 10 : 6;
  const near = Object.entries(stops)
    .map(([code, s]) => ({ code, name: s[2], road: s[3], lat: s[1], lng: s[0], dist: Math.round(distM(lat, lng, s[1], s[0])) }))
    .filter((s) => s.dist <= radius)
    .sort((a, b) => a.dist - b.dist)
    .slice(0, maxStops);

  const results = await Promise.all(near.map(async (s) => {
    let services_ = [];
    let error = null;
    try {
      const arr = await getArrivals(s.code);
      services_ = (arr.services || []).map((sv) => {
        const arrivals = [sv.next, sv.subsequent, sv.next3]
          .filter((a) => a && a.time)
          .map((a) => ({ time: a.time, load: a.load, type: a.type, wab: a.feature === 'WAB', lat: a.lat, lng: a.lng, live: !!a.monitored }));
        const meta = services[sv.no];
        return {
          no: sv.no, operator: sv.operator, name: meta ? meta.name : '',
          arrivals, reach: reachInfo(meta, s.code, destSet, stops) || (boarding ? transferInfo(sv.no, meta, s.code, boarding, stops) : null),
        };
      });
    } catch (e) { error = 'arrivals unavailable'; }
    if (destSet) {
      services_ = services_.filter((x) => x.reach)
        .sort((a, b) => (!!a.reach.transfer - !!b.reach.transfer) || a.reach.rideMin - b.reach.rideMin);
      const direct = services_.filter((x) => !x.reach.transfer);
      services_ = direct.concat(services_.filter((x) => x.reach.transfer).slice(0, Math.max(0, 5 - direct.length)));
    } else {
      services_.sort((a, b) => (parseInt(a.no) - parseInt(b.no)) || a.no.localeCompare(b.no));
    }
    return { ...s, services: services_, error };
  }));

  return { dest: destInfo, stops: destSet ? results.filter((s) => s.services.length || s.error) : results, fetchedAt: new Date().toISOString() };
}

async function apiTaxi(q) {
  const lat = +q.get('lat'), lng = +q.get('lng');
  const j = await gov('transport/taxi-availability', 30000);
  const f = j.features[0];
  const coords = f.geometry.coordinates;
  const near = [];
  let c250 = 0, c500 = 0, c1000 = 0;
  for (const [ln, la] of coords) {
    const d = distM(lat, lng, la, ln);
    if (d <= 250) c250++;
    if (d <= 500) c500++;
    if (d <= 1000) c1000++;
    if (d <= 1500) near.push([la, ln, Math.round(d)]);
  }
  return { total: f.properties.taxi_count, c250, c500, c1000, near, timestamp: f.properties.timestamp };
}

async function apiCarparks(q) {
  const lat = +q.get('lat'), lng = +q.get('lng');
  const [info, avail] = await Promise.all([getCarparkInfo(), gov('transport/carpark-availability', 60000)]);
  const item = avail.items[0];
  const list = [];
  for (const cp of item.carpark_data) {
    const meta = info[cp.carpark_number];
    if (!meta) continue;
    const d = distM(lat, lng, meta.lat, meta.lng);
    if (d > 2000) continue;
    const car = cp.carpark_info.find((x) => x.lot_type === 'C') || cp.carpark_info[0];
    list.push({
      id: cp.carpark_number, ...meta, dist: Math.round(d),
      available: +car.lots_available, total: +car.total_lots, updated: cp.update_datetime,
    });
  }
  list.sort((a, b) => a.dist - b.dist);
  return { carparks: list.slice(0, 10), timestamp: item.timestamp };
}

async function apiCams() {
  const j = await gov('transport/traffic-images', 60000);
  const names = {
    '2701': 'Woodlands Causeway → Johor',
    '2702': 'Woodlands Checkpoint (to BKE)',
    '2704': 'Woodlands Flyover (BKE)',
    '4703': 'Tuas Second Link → Johor',
    '4713': 'Tuas Checkpoint',
    '4712': 'AYE after Tuas West Rd',
  };
  const cams = j.items[0].cameras
    .filter((c) => names[c.camera_id])
    .map((c) => ({ id: c.camera_id, name: names[c.camera_id], image: c.image, timestamp: c.timestamp, lat: c.location.latitude, lng: c.location.longitude }))
    .sort((a, b) => Object.keys(names).indexOf(a.id) - Object.keys(names).indexOf(b.id));
  return { cams };
}

async function apiWeather(q) {
  const lat = +q.get('lat'), lng = +q.get('lng');
  const key = lat.toFixed(2) + ',' + lng.toFixed(2);
  const safe = (p) => p.catch(() => null);
  const [fc, rain, temp, uv, pm, om] = await Promise.all([
    safe(gov('environment/2-hour-weather-forecast', 5 * 60000)),
    safe(gov('environment/rainfall', 5 * 60000)),
    safe(gov('environment/air-temperature', 5 * 60000)),
    safe(gov('environment/uv-index', 15 * 60000)),
    safe(gov('environment/pm25', 15 * 60000)),
    safe(cached('om:' + key, 10 * 60000, () => getJSON(
      `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(3)}&longitude=${lng.toFixed(3)}` +
      '&minutely_15=precipitation,precipitation_probability&forecast_minutely_15=9' +
      '&current=temperature_2m,apparent_temperature,relative_humidity_2m,precipitation&timezone=Asia%2FSingapore'))),
  ]);

  const out = {};
  if (fc && fc.items && fc.items[0]) {
    const n = nearestBy(fc.area_metadata, lat, lng, (a) => [a.label_location.latitude, a.label_location.longitude]);
    const f = fc.items[0].forecasts.find((x) => x.area === n.item.name);
    out.forecast = { area: n.item.name, text: f ? f.forecast : '?', validTo: fc.items[0].valid_period && fc.items[0].valid_period.end };
  }
  const stationReading = (j) => {
    if (!j || !j.items || !j.items[0]) return null;
    const readings = j.items[0].readings;
    const stations = j.metadata.stations.filter((s) => readings.some((r) => r.station_id === s.id));
    const n = nearestBy(stations, lat, lng, (s) => [s.location.latitude, s.location.longitude]);
    if (!n) return null;
    const r = readings.find((x) => x.station_id === n.item.id);
    return { station: n.item.name, value: r.value, distKm: +(n.dist / 1000).toFixed(1), timestamp: j.items[0].timestamp };
  };
  out.rain = stationReading(rain);
  out.temp = stationReading(temp);
  if (uv && uv.items && uv.items[0]) out.uv = { value: uv.items[0].index[0].value, timestamp: uv.items[0].index[0].timestamp };
  if (pm && pm.items && pm.items[0]) {
    const n = nearestBy(pm.region_metadata.filter((r) => r.name !== 'national'), lat, lng,
      (r) => [r.label_location.latitude, r.label_location.longitude]);
    out.pm25 = { region: n.item.name, value: pm.items[0].readings.pm25_one_hourly[n.item.name] };
  }
  if (om && om.minutely_15) {
    out.nowcast = om.minutely_15.time.map((t, i) => ({ time: t, mm: om.minutely_15.precipitation[i], prob: om.minutely_15.precipitation_probability ? om.minutely_15.precipitation_probability[i] : null }));
    out.current = om.current;
  }
  return out;
}

async function apiFx() {
  return cached('fx', 6 * 3600 * 1000, async () => {
    const j = await getJSON('https://api.frankfurter.dev/v1/latest?base=SGD&symbols=MYR,USD');
    return { date: j.date, myr: j.rates.MYR, usd: j.rates.USD };
  });
}

const routes = {
  '/api/stops': apiStops,
  '/api/bus': apiBus,
  '/api/taxi': apiTaxi,
  '/api/carparks': apiCarparks,
  '/api/cams': apiCams,
  '/api/weather': apiWeather,
  '/api/fx': apiFx,
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

module.exports = { svy21ToLatLng, distM };
