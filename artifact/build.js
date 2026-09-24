// Builds a self-contained snapshot of Escape from CT Hub for publishing as a claude.ai Artifact.
// Artifacts cannot call external APIs, so live data is fetched here and baked into the page.
//
// Usage: start the local server (npm start), then: node artifact/build.js
// Output: artifact/escape-from-ct-hub.html
const fs = require('fs');
const path = require('path');

const BASE = process.env.BASE || 'http://localhost:3000';
const CT_HUB = { lat: 1.3106, lng: 103.8633, name: 'CT HUB, KALLANG' };
const NEAR_RADIUS = 900, NEAR_MAX = 10;
const ROOT = path.join(__dirname, '..');

const getJSON = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
};
const qs = `lat=${CT_HUB.lat}&lng=${CT_HUB.lng}`;

function distM(lat1, lng1, lat2, lng2) {
  const r = Math.PI / 180, dLat = (lat2 - lat1) * r, dLng = (lng2 - lng1) * r;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(a));
}

async function imageDataUri(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return `data:${res.headers.get('content-type') || 'image/jpeg'};base64,${buf.toString('base64')}`;
}

(async () => {
  const stopsRaw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'stops.json'), 'utf8'));
  const servicesRaw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'services.json'), 'utf8'));

  // Round stop coordinates to 5 dp (~1 m) to keep the page small.
  const stops = {};
  for (const [code, [lng, lat, name, road]] of Object.entries(stopsRaw)) stops[code] = [+lng.toFixed(5), +lat.toFixed(5), name, road];
  const services = {};
  for (const [no, s] of Object.entries(servicesRaw)) services[no] = { name: s.name, routes: s.routes };

  const near = Object.entries(stops)
    .map(([code, s]) => ({ code, name: s[2], road: s[3], lat: s[1], lng: s[0], dist: Math.round(distM(CT_HUB.lat, CT_HUB.lng, s[1], s[0])) }))
    .filter((s) => s.dist <= NEAR_RADIUS)
    .sort((a, b) => a.dist - b.dist)
    .slice(0, NEAR_MAX);

  const nearStops = await Promise.all(near.map(async (s) => {
    try {
      const arr = await getJSON('https://arrivelah2.busrouter.sg/?id=' + s.code);
      const svcs = (arr.services || []).map((sv) => ({
        no: sv.no, operator: sv.operator,
        arrivals: [sv.next, sv.subsequent, sv.next3].filter((a) => a && a.time).map((a) => ({
          time: a.time, load: a.load, type: a.type, wab: a.feature === 'WAB',
          lat: a.lat ? +a.lat.toFixed(5) : 0, lng: a.lng ? +a.lng.toFixed(5) : 0, live: !!a.monitored,
        })),
      }));
      return { ...s, services: svcs };
    } catch (e) {
      return { ...s, services: [], error: true };
    }
  }));

  const [taxi, carparks, weather, fx, cams] = await Promise.all([
    getJSON(`${BASE}/api/taxi?${qs}`),
    getJSON(`${BASE}/api/carparks?${qs}`),
    getJSON(`${BASE}/api/weather?${qs}`),
    getJSON(`${BASE}/api/fx`).catch(() => null),
    getJSON(`${BASE}/api/cams`),
  ]);
  for (const c of cams.cams) {
    try { c.img = await imageDataUri(c.image); } catch { c.img = null; }
    delete c.image;
  }
  taxi.near = taxi.near.map(([la, ln, d]) => [+la.toFixed(5), +ln.toFixed(5), d]);

  const snapshot = {
    takenAt: new Date().toISOString(), loc: CT_HUB,
    nearStops, stops, services, taxi, carparks: carparks.carparks, weather, fx, cams: cams.cams,
  };

  const json = JSON.stringify(snapshot).replace(/</g, '\\u003c');
  const tpl = fs.readFileSync(path.join(__dirname, 'template.html'), 'utf8');
  const out = tpl.replace('/*__SNAPSHOT__*/null', () => json);
  const file = path.join(__dirname, 'escape-from-ct-hub.html');
  fs.writeFileSync(file, out);
  console.log(`wrote ${file} (${(out.length / 1024 / 1024).toFixed(2)} MB), snapshot ${snapshot.takenAt}`);
  console.log(`  ${nearStops.length} stops, ${nearStops.reduce((a, s) => a + s.services.length, 0)} services, ${taxi.c500} taxis <500m, ${snapshot.carparks.length} carparks, ${cams.cams.filter((c) => c.img).length} cams`);
})().catch((e) => { console.error(e); process.exit(1); });
