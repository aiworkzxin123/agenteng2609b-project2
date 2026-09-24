// Kiasu Kommute — data logic shared by the Node server (server.js) and the
// static GitHub Pages build (client-api.js). No I/O here: callers fetch, core shapes.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EcthCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const URLS = {
    stops: 'https://data.busrouter.sg/v1/stops.min.json',
    services: 'https://data.busrouter.sg/v1/services.min.json',
    arrivals: (code) => 'https://arrivelah2.busrouter.sg/?id=' + encodeURIComponent(code),
    carparkInfo: 'https://data.gov.sg/api/action/datastore_search?resource_id=d_23f946fa557947f93a8043bbef41dd09&limit=5000',
    gov: (p) => 'https://api.data.gov.sg/v1/' + p,
    openMeteo: (lat, lng) =>
      `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(3)}&longitude=${lng.toFixed(3)}` +
      '&minutely_15=precipitation,precipitation_probability&forecast_minutely_15=9' +
      '&current=temperature_2m,apparent_temperature,relative_humidity_2m,precipitation&timezone=Asia%2FSingapore',
    fx: 'https://api.frankfurter.dev/v1/latest?base=SGD&symbols=MYR,USD',
  };

  function distM(lat1, lng1, lat2, lng2) {
    const r = Math.PI / 180;
    const dLat = (lat2 - lat1) * r;
    const dLng = (lng2 - lng1) * r;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLng / 2) ** 2;
    return 2 * 6371000 * Math.asin(Math.sqrt(a));
  }

  function nearestBy(list, lat, lng, getLL) {
    let best = null, bestD = Infinity;
    for (const item of list) {
      const [la, ln] = getLL(item);
      const d = distM(lat, lng, la, ln);
      if (d < bestD) { bestD = d; best = item; }
    }
    return best ? { item: best, dist: bestD } : null;
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

  // ---------- bus stops ----------
  const stopsList = (stops) => Object.entries(stops).map(([code, [lng, lat, name, road]]) => [code, name, road, lat, lng]);

  // ---------- routing ----------
  const rideMin = (km) => Math.round((km / 19) * 60 + 1);
  const TRANSFER_WAIT_MIN = 8; // assumed average wait for the 2nd bus

  // Direct ride from origin on this service into any destination stop.
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
          const cand = { stops: j - i, km: +km.toFixed(1), rideMin: rideMin(km), alight: route[j] };
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
          const leg = { no, stops: j - i, km: +km.toFixed(1), rideMin: rideMin(km), alight: route[j] };
          const prev = idx.get(route[i]);
          if (!prev || leg.km < prev.km) idx.set(route[i], leg);
        }
      }
    }
    return idx;
  }

  // Origin service -> best transfer stop along its route where a direct leg to the destination starts.
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
        const ride1 = rideMin(km1);
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

  // Nearby stops with live arrivals; with a destination, only services that get there (direct or 1 transfer).
  async function planBus({ lat, lng, dest, stops, services, getArrivals }) {
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
      let list = [];
      let error = null;
      try {
        const arr = await getArrivals(s.code);
        list = (arr.services || []).map((sv) => {
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
        list = list.filter((x) => x.reach)
          .sort((a, b) => (!!a.reach.transfer - !!b.reach.transfer) || a.reach.rideMin - b.reach.rideMin);
        const direct = list.filter((x) => !x.reach.transfer);
        list = direct.concat(list.filter((x) => x.reach.transfer).slice(0, Math.max(0, 5 - direct.length)));
      } else {
        list.sort((a, b) => (parseInt(a.no) - parseInt(b.no)) || a.no.localeCompare(b.no));
      }
      return { ...s, services: list, error };
    }));

    return { dest: destInfo, stops: destSet ? results.filter((s) => s.services.length || s.error) : results, fetchedAt: new Date().toISOString() };
  }

  // ---------- taxis ----------
  function taxiSummary(j, lat, lng) {
    const f = j.features[0];
    const near = [];
    let c250 = 0, c500 = 0, c1000 = 0;
    for (const [ln, la] of f.geometry.coordinates) {
      const d = distM(lat, lng, la, ln);
      if (d <= 250) c250++;
      if (d <= 500) c500++;
      if (d <= 1000) c1000++;
      if (d <= 1500) near.push([la, ln, Math.round(d)]);
    }
    return { total: f.properties.taxi_count, c250, c500, c1000, near, timestamp: f.properties.timestamp };
  }

  // ---------- carparks ----------
  function carparkInfoFromRecords(records) {
    const out = {};
    for (const r of records) {
      const [lat, lng] = svy21ToLatLng(+r.y_coord, +r.x_coord);
      out[r.car_park_no] = {
        address: r.address, lat: +lat.toFixed(6), lng: +lng.toFixed(6), type: r.car_park_type,
        free: r.free_parking, night: r.night_parking, height: +r.gantry_height || null,
      };
    }
    return out;
  }
  function carparkSummary(info, avail, lat, lng) {
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

  // ---------- checkpoint cams ----------
  const CAM_NAMES = {
    '2701': 'Woodlands Causeway → Johor',
    '2702': 'Woodlands Checkpoint (to BKE)',
    '2704': 'Woodlands Flyover (BKE)',
    '4703': 'Tuas Second Link → Johor',
    '4713': 'Tuas Checkpoint',
    '4712': 'AYE after Tuas West Rd',
  };
  function camsSummary(j) {
    const order = Object.keys(CAM_NAMES);
    const cams = j.items[0].cameras
      .filter((c) => CAM_NAMES[c.camera_id])
      .map((c) => ({ id: c.camera_id, name: CAM_NAMES[c.camera_id], image: c.image, timestamp: c.timestamp, lat: c.location.latitude, lng: c.location.longitude }))
      .sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
    return { cams };
  }

  // ---------- weather ----------
  function weatherSummary({ fc, rain, temp, uv, pm, om }, lat, lng) {
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
      out.nowcast = om.minutely_15.time.map((t, i) => ({
        time: t, mm: om.minutely_15.precipitation[i],
        prob: om.minutely_15.precipitation_probability ? om.minutely_15.precipitation_probability[i] : null,
      }));
      out.current = om.current;
    }
    return out;
  }

  const fxSummary = (j) => ({ date: j.date, myr: j.rates.MYR, usd: j.rates.USD });

  return {
    URLS, distM, nearestBy, svy21ToLatLng, stopsList,
    reachInfo, buildBoardingIndex, transferInfo, planBus,
    taxiSummary, carparkInfoFromRecords, carparkSummary, camsSummary, weatherSummary, fxSummary,
  };
});
