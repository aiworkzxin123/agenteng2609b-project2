// Kiasu Kommute — browser-side stand-in for server.js, used on static hosting (GitHub Pages).
// Every upstream API sends Access-Control-Allow-Origin: *, so the page can call them directly.
(function () {
  'use strict';
  const core = window.EcthCore;
  const { URLS } = core;
  const DAY = 24 * 3600 * 1000;
  const memo = new Map();

  async function getJSON(url) {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`${res.status} from ${new URL(url).host}`);
    return res.json();
  }

  // In-memory cache with request dedupe; serves the last good value if a refresh fails.
  function cached(key, ttl, fn) {
    const hit = memo.get(key);
    if (hit && hit.value !== undefined && Date.now() - hit.t < ttl) return Promise.resolve(hit.value);
    if (hit && hit.pending) return hit.pending;
    const pending = fn().then((value) => { memo.set(key, { t: Date.now(), value }); return value; }, (err) => {
      if (hit && hit.value !== undefined) { memo.set(key, { t: hit.t, value: hit.value }); return hit.value; }
      memo.delete(key); throw err;
    });
    memo.set(key, { ...(hit || {}), pending });
    return pending;
  }

  // Big, slow-changing datasets also persist in localStorage (best effort) to skip re-downloading.
  function persisted(name, ttl, fn) {
    const key = 'ecth:data:' + name;
    return cached('ls:' + name, ttl, async () => {
      try {
        const raw = localStorage.getItem(key);
        if (raw) { const { t, v } = JSON.parse(raw); if (Date.now() - t < ttl) return v; }
      } catch {}
      const v = await fn();
      try { localStorage.setItem(key, JSON.stringify({ t: Date.now(), v })); } catch {}
      return v;
    });
  }

  const getStops = () => persisted('stops', DAY, () => getJSON(URLS.stops));
  const getServices = () => persisted('services', DAY, () => getJSON(URLS.services));
  const getArrivals = (code) => cached('arr:' + code, 15000, () => getJSON(URLS.arrivals(code)));
  const getCarparkInfo = () => persisted('carpark-info', 7 * DAY, async () =>
    core.carparkInfoFromRecords((await getJSON(URLS.carparkInfo)).result.records));
  const gov = (p, ttl) => cached('gov:' + p, ttl, () => getJSON(URLS.gov(p)));
  const safe = (p) => p.catch(() => null);

  const routes = {
    '/api/stops': async () => core.stopsList(await getStops()),
    '/api/bus': async (lat, lng, q) => {
      const [stops, services] = await Promise.all([getStops(), getServices()]);
      return core.planBus({ lat, lng, dest: q.get('dest'), stops, services, getArrivals });
    },
    '/api/taxi': async (lat, lng) => core.taxiSummary(await gov('transport/taxi-availability', 30000), lat, lng),
    '/api/carparks': async (lat, lng) => {
      const [info, avail] = await Promise.all([getCarparkInfo(), gov('transport/carpark-availability', 60000)]);
      return core.carparkSummary(info, avail, lat, lng);
    },
    '/api/cams': async () => core.camsSummary(await gov('transport/traffic-images', 60000)),
    '/api/weather': async (lat, lng) => {
      const [fc, rain, temp, uv, pm, om] = await Promise.all([
        safe(gov('environment/2-hour-weather-forecast', 5 * 60000)),
        safe(gov('environment/rainfall', 5 * 60000)),
        safe(gov('environment/air-temperature', 5 * 60000)),
        safe(gov('environment/uv-index', 15 * 60000)),
        safe(gov('environment/pm25', 15 * 60000)),
        safe(cached('om:' + lat.toFixed(2) + ',' + lng.toFixed(2), 10 * 60000, () => getJSON(URLS.openMeteo(lat, lng)))),
      ]);
      return core.weatherSummary({ fc, rain, temp, uv, pm, om }, lat, lng);
    },
    '/api/fx': () => cached('fx', 6 * 3600 * 1000, async () => core.fxSummary(await getJSON(URLS.fx))),
  };

  // Same signature as the server's routes: api('/api/bus?lat=..&lng=..&dest=..')
  window.EcthClientAPI = function (path) {
    const u = new URL(path, location.href);
    const fn = routes[u.pathname.replace(/^.*(\/api\/)/, '$1')];
    if (!fn) return Promise.reject(new Error('Unknown route ' + u.pathname));
    return fn(+u.searchParams.get('lat'), +u.searchParams.get('lng'), u.searchParams);
  };
})();
