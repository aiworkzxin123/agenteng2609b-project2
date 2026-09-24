/* Escape from CT Hub — front end. Talks only to the local server's /api/* routes. */
(() => {
  'use strict';

  const CT_HUB = { lat: 1.3106, lng: 103.8633, name: 'CT HUB, KALLANG' };
  const DETOUR = 1.25;   // straight line → walking path
  const BOARD_S = 10;    // seconds to tap in and board
  const PRESETS = [
    { label: '🇲🇾 JB CHECKPT', code: '46211' },
    { label: "W'LANDS CHECKPT", code: '46101' },
    { label: '✈ CHANGI T3', code: '95109' },
    { label: 'ORCHARD/ION', code: '09023' },
    { label: 'BUGIS', code: '01059' },
    { label: 'MBS', code: '03509' },
    { label: 'NUS', code: '16009' },
    { label: 'JURONG EAST', code: '28009' },
  ];
  const PROFILES = [
    { label: '🧓 AUNTIE', walk: 3.5, run: 6 },
    { label: '👔 OFFICE', walk: 4.8, run: 10 },
    { label: '🎖 NS MAN', walk: 5.5, run: 15 },
    { label: '⚡ BOLT', walk: 6.5, run: 22 },
  ];

  // ---------- storage (best effort) ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem('ecth:' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('ecth:' + k, JSON.stringify(v)); } catch {} },
  };

  const state = {
    loc: store.get('loc', CT_HUB),
    dest: store.get('dest', null),
    walk: store.get('walk', 4.8),
    run: store.get('run', 10),
    sfx: false,
    showAll: store.get('showAll', false),
    stops: [], stopIndex: {},
    bus: null, taxi: null, weather: null, carparks: null, cams: null, fx: null,
    lastBig: null,
  };

  // ---------- utils ----------
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
  const pad = (n) => String(n).padStart(2, '0');
  const mmss = (s) => { s = Math.max(0, Math.round(s)); return `${Math.floor(s / 60)}:${pad(s % 60)}`; };
  const hhmm = (d) => { d = new Date(d); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  function distM(lat1, lng1, lat2, lng2) {
    const r = Math.PI / 180, dLat = (lat2 - lat1) * r, dLng = (lng2 - lng1) * r;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLng / 2) ** 2;
    return 2 * 6371000 * Math.asin(Math.sqrt(a));
  }
  // On localhost the Node server proxies the APIs; anywhere else (e.g. GitHub Pages) the page calls them directly.
  const STATIC = !['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  async function api(path) {
    if (STATIC) return window.EcthClientAPI(path);
    const res = await fetch(path);
    const j = await res.json();
    if (!res.ok) throw new Error(j.error || res.status);
    return j;
  }
  const qs = () => `lat=${state.loc.lat}&lng=${state.loc.lng}`;
  let toastT;
  function toast(msg) {
    const t = $('toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), 3500);
  }

  // ---------- 8-bit sfx ----------
  let actx;
  function beep(seq = [880, 1320]) {
    if (!state.sfx) return;
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      let t = actx.currentTime;
      for (const f of seq) {
        const o = actx.createOscillator(), g = actx.createGain();
        o.type = 'square'; o.frequency.value = f;
        g.gain.setValueAtTime(0.06, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
        o.connect(g).connect(actx.destination); o.start(t); o.stop(t + 0.13); t += 0.13;
      }
    } catch {}
  }

  // ---------- map ----------
  const map = L.map('map', { zoomControl: true, attributionControl: true }).setView([state.loc.lat, state.loc.lng], 17);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, className: 'tiles-dark',
    attribution: '© OpenStreetMap contributors',
  }).addTo(map);
  const pin = (cls, text) => L.divIcon({ className: '', html: `<div class="pin ${cls}">${esc(text)}</div>`, iconSize: null });
  const layers = {
    stops: L.layerGroup().addTo(map), buses: L.layerGroup().addTo(map), taxis: L.layerGroup().addTo(map),
    parks: L.layerGroup().addTo(map), dest: L.layerGroup().addTo(map),
  };
  const youMarker = L.marker([state.loc.lat, state.loc.lng], { icon: pin('you', '◆ YOU'), draggable: true, zIndexOffset: 1000 }).addTo(map);
  const radius = L.circle([state.loc.lat, state.loc.lng], { radius: 500, color: '#ff2e88', weight: 1, dashArray: '4 6', fillOpacity: 0.04 }).addTo(map);
  youMarker.on('dragend', () => { const p = youMarker.getLatLng(); setLoc(p.lat, p.lng); });
  map.on('click', (e) => setLoc(e.latlng.lat, e.latlng.lng));

  // ---------- location ----------
  function nearestStopName(lat, lng) {
    let best = null, bd = Infinity;
    for (const s of state.stops) { const d = distM(lat, lng, s[3], s[4]); if (d < bd) { bd = d; best = s; } }
    return best ? `NEAR ${best[1].toUpperCase()}` : `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
  }
  function setLoc(lat, lng, name) {
    state.loc = { lat, lng, name: name || nearestStopName(lat, lng) };
    store.set('loc', state.loc);
    youMarker.setLatLng([lat, lng]); radius.setLatLng([lat, lng]);
    $('locName').textContent = state.loc.name;
    refreshBus(); refreshTaxi(); refreshParks(); refreshWeather();
  }
  $('btnHome').onclick = () => { map.setView([CT_HUB.lat, CT_HUB.lng], 17); setLoc(CT_HUB.lat, CT_HUB.lng, CT_HUB.name); };
  $('btnGps').onclick = () => {
    if (!navigator.geolocation) return toast('No GPS in this browser');
    toast('Locating player 1…');
    navigator.geolocation.getCurrentPosition(
      (p) => { map.setView([p.coords.latitude, p.coords.longitude], 17); setLoc(p.coords.latitude, p.coords.longitude); },
      () => toast('GPS denied. Staying put.'), { enableHighAccuracy: true, timeout: 10000 });
  };
  $('btnSfx').onclick = (e) => {
    state.sfx = !state.sfx;
    e.currentTarget.setAttribute('aria-pressed', state.sfx);
    e.currentTarget.textContent = state.sfx ? '♪ SFX ON' : '♪ SFX OFF';
    beep([660, 990, 1320]);
  };

  // ---------- destination picker ----------
  const destInput = $('destInput'), destList = $('destList');
  let destMatches = [], destActive = -1;
  function searchStops(q) {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    const out = [];
    for (const s of state.stops) {
      const hay = `${s[1]} ${s[2]} ${s[0]}`.toLowerCase();
      if (words.every((w) => hay.includes(w))) out.push(s);
    }
    const q0 = words[0];
    out.sort((a, b) => (b[1].toLowerCase().startsWith(q0) - a[1].toLowerCase().startsWith(q0)) || a[1].localeCompare(b[1]));
    return out.slice(0, 12);
  }
  function renderDropdown() {
    if (!destMatches.length) { destList.hidden = true; return; }
    destList.innerHTML = destMatches.map((s, i) =>
      `<li data-code="${esc(s[0])}" class="${i === destActive ? 'active' : ''}">${esc(s[1])} <small>${esc(s[2])} · ${esc(s[0])}</small></li>`).join('');
    destList.hidden = false;
  }
  destInput.addEventListener('input', () => { destMatches = searchStops(destInput.value); destActive = -1; renderDropdown(); });
  destInput.addEventListener('keydown', (e) => {
    if (destList.hidden) return;
    if (e.key === 'ArrowDown') { destActive = Math.min(destActive + 1, destMatches.length - 1); renderDropdown(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { destActive = Math.max(destActive - 1, 0); renderDropdown(); e.preventDefault(); }
    else if (e.key === 'Enter') { const s = destMatches[Math.max(destActive, 0)]; if (s) setDest(s[0]); }
    else if (e.key === 'Escape') { destList.hidden = true; }
  });
  destList.addEventListener('mousedown', (e) => { const li = e.target.closest('li'); if (li) setDest(li.dataset.code); });
  destInput.addEventListener('blur', () => setTimeout(() => (destList.hidden = true), 150));
  $('destClear').onclick = () => setDest(null);

  function setDest(code) {
    state.dest = code;
    store.set('dest', code);
    destList.hidden = true;
    const s = code && state.stopIndex[code];
    destInput.value = s ? s[1] : '';
    renderDestMeta();
    renderPresets();
    state.bus = null;
    $('busList').innerHTML = '<div class="empty">Recalculating escape routes…</div>';
    refreshBus();
  }
  function renderDestMeta() {
    layers.dest.clearLayers();
    const s = state.dest && state.stopIndex[state.dest];
    if (!s) { $('destNow').textContent = 'No destination: showing every bus nearby.'; return; }
    const km = distM(state.loc.lat, state.loc.lng, s[3], s[4]) / 1000;
    $('destNow').textContent = `▶ ${s[1]} (${s[2]}, ${s[0]}), ${km.toFixed(1)} km away. Showing direct buses, or 1-transfer routes if none go direct.`;
    L.marker([s[3], s[4]], { icon: pin('dest', '★ ' + s[1]) }).addTo(layers.dest);
  }
  function renderPresets() {
    $('presets').innerHTML = PRESETS.map((p) =>
      `<button class="chip ${state.dest === p.code ? 'on' : ''}" data-code="${p.code}">${esc(p.label)}</button>`).join('');
  }
  $('presets').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setDest(state.dest === b.dataset.code ? null : b.dataset.code); });

  // ---------- speeds ----------
  function renderSpeeds() {
    $('walk').value = state.walk; $('run').value = state.run;
    $('walkVal').textContent = (+state.walk).toFixed(1); $('runVal').textContent = (+state.run).toFixed(1);
    $('profiles').innerHTML = PROFILES.map((p, i) =>
      `<button class="chip ${p.walk === +state.walk && p.run === +state.run ? 'on' : ''}" data-i="${i}">${esc(p.label)}</button>`).join('');
  }
  $('walk').oninput = (e) => { state.walk = +e.target.value; if (state.run < state.walk + 1) state.run = state.walk + 1; store.set('walk', state.walk); store.set('run', state.run); renderSpeeds(); tick(); };
  $('run').oninput = (e) => { state.run = Math.max(+e.target.value, state.walk + 1); store.set('run', state.run); renderSpeeds(); tick(); };
  $('profiles').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const p = PROFILES[+b.dataset.i]; state.walk = p.walk; state.run = p.run;
    store.set('walk', p.walk); store.set('run', p.run); renderSpeeds(); tick(); beep([520, 780]);
  });

  // ---------- bus judgement ----------
  // Can I catch a bus arriving in `secs` from a stop `dist` metres away?
  function judge(dist, secs) {
    if (secs < -15) return null; // already left
    const d = dist * DETOUR;
    if (d < 20) return secs < 240 ? { k: 'walk', leaveIn: 0, atStop: true } : { k: 'chill', leaveIn: secs - 240, atStop: true };
    const walkT = d / (state.walk / 3.6), runT = d / (state.run / 3.6);
    const slack = secs - walkT - BOARD_S;
    if (slack >= 240) return { k: 'chill', leaveIn: slack };
    if (slack >= 0) return { k: 'walk', leaveIn: slack };
    if (secs - runT - BOARD_S / 2 >= 0) return { k: 'run', need: (d / Math.max(secs - BOARD_S / 2, 1)) * 3.6 };
    return { k: 'miss' };
  }
  const LOAD = { SEA: 'seats', SDA: 'standing', LSD: 'packed' };
  const TYPE = { SD: 'single', DD: 'double', BD: 'bendy' };

  // Evaluate every service at every stop; return enriched list + the best option overall.
  function evaluateBuses() {
    if (!state.bus) return { stops: [], best: null };
    const now = Date.now();
    let best = null;
    const stops = state.bus.stops.map((st) => {
      const services = st.services.map((sv) => {
        const arrs = sv.arrivals.map((a) => {
          const secs = (new Date(a.time).getTime() - now) / 1000;
          return { ...a, secs, j: judge(st.dist, secs) };
        }).filter((a) => a.j);
        const idx = arrs.findIndex((a) => a.j.k !== 'miss');
        const catchable = idx >= 0 ? arrs[idx] : null;
        const row = { ...sv, arrs, catchable, skipped: idx > 0 };
        if (catchable) {
          const arriveAt = now + catchable.secs * 1000 + (sv.reach ? sv.reach.rideMin * 60000 : 0);
          const cand = { stop: st, svc: row, a: catchable, arriveAt };
          if (!best || cand.arriveAt < best.arriveAt) best = cand;
        }
        return row;
      });
      return { ...st, services };
    });
    // For each service, the stop where you'd catch it soonest (or nearest if none catchable).
    const home = {};
    for (const st of stops) for (const sv of st.services) {
      const cur = home[sv.no];
      const t = sv.catchable ? sv.catchable.secs : Infinity;
      if (!cur || t < cur.t) home[sv.no] = { code: st.code, t };
    }
    return { stops, best, home };
  }

  function adviceText(row) {
    const c = row.catchable;
    if (!c) return '<b>No catchable bus</b> in the next few';
    const pre = row.skipped ? 'Let the first go. ' : '';
    if (c.j.atStop) return `${pre}You're at the stop. <b>Due in ${mmss(c.secs)}</b>`;
    if (c.j.k === 'chill') return `${pre}<b>Chill.</b> Leave in ${mmss(c.j.leaveIn)}`;
    if (c.j.k === 'walk') return `${pre}<b>Walk now-ish.</b> Leave within ${mmss(c.j.leaveIn)}`;
    if (c.j.need < state.walk + 1.5) return `${pre}<b>Speed-walk!</b> ~${c.j.need.toFixed(1)} km/h`;
    return `${pre}<b>RUN!</b> Need ~${c.j.need.toFixed(0)} km/h`;
  }

  function renderBus(ev) {
    const el = $('busList');
    if (!state.bus) return;
    if (!ev.stops.length) {
      const s = state.dest && state.stopIndex[state.dest];
      el.innerHTML = `<div class="empty">${s
        ? `No bus route (even with one transfer) to <b>${esc(s[1])}</b> from any stop within 900 m. Try a cab (panel 05), a nearby destination, or move the pin.`
        : 'No bus stops within 500 m. Move the pin closer to civilisation.'}</div>`;
      return;
    }
    const bestKey = ev.best ? ev.best.stop.code + '|' + ev.best.svc.no : '';
    const shown = state.showAll ? ev.stops : ev.stops
      .map((st) => ({ ...st, hidden: st.services.filter((sv) => ev.home[sv.no].code !== st.code).length, services: st.services.filter((sv) => ev.home[sv.no].code === st.code) }))
      .filter((st) => st.services.length || st.error);
    el.innerHTML = shown.map((st) => {
      const walkMin = (st.dist * DETOUR) / (state.walk / 3.6) / 60;
      const rows = st.services.length ? st.services.map((sv) => {
        const etas = sv.arrs.slice(0, 3).map((a) =>
          `<span class="eta ${a.j.k}" title="${esc(TYPE[a.type] || '')} deck${a.wab ? ', wheelchair accessible' : ''}${a.live ? '' : ', scheduled (not tracked live)'}">${a.secs <= 30 ? 'ARR' : mmss(a.secs)}<span class="ld">${esc(LOAD[a.load] || '')}${a.live ? '' : '*'}</span></span>`).join('');
        let route = esc(sv.name || '');
        if (sv.reach) {
          const al = state.stopIndex[sv.reach.alight];
          const arriveAt = sv.catchable ? hhmm(Date.now() + sv.catchable.secs * 1000 + sv.reach.rideMin * 60000) : '?';
          const tr = sv.reach.transfer;
          if (tr) {
            const at = state.stopIndex[tr.at];
            route = `⇄ ${tr.stops1} stops, change at ${esc(at ? at[1] : tr.at)} to bus ${esc(tr.no)} (${tr.stops2} stops) · ~${sv.reach.rideMin} min incl. ~${tr.wait} min wait · arrive ~${arriveAt}`;
          } else {
            route = `→ ${esc(al ? al[1] : sv.reach.alight)} · ${sv.reach.stops} stops · ${sv.reach.km} km · ~${sv.reach.rideMin} min · arrive ~${arriveAt}`;
          }
        }
        return `<div class="svc ${bestKey === st.code + '|' + sv.no ? 'best' : ''}">
          <div class="no">${esc(sv.no)}</div>
          <div class="info"><div class="advice">${adviceText(sv)}</div><div class="route" title="${route}">${route}</div></div>
          <div class="etas">${etas || '<span class="eta miss">NO SVC</span>'}</div>
        </div>`;
      }).join('') : `<div class="svc"><div></div><div class="info">${st.error ? 'Arrival data unavailable right now' : 'No services running'}</div><div></div></div>`;
      return `<div class="stopcard">
        <div class="stophead"><span class="nm">${esc(st.name)}</span>
          <span class="meta">${esc(st.road)} · #${esc(st.code)} · ${st.dist} m · ${walkMin < 1 ? '<1' : walkMin.toFixed(0)} min walk</span></div>
        ${rows}${st.hidden ? `<div class="also">+ ${st.hidden} more service${st.hidden > 1 ? 's' : ''} here, better caught at another stop</div>` : ''}</div>`;
    }).join('');
  }
  function renderShowAll() {
    const b = $('btnAll');
    b.setAttribute('aria-pressed', state.showAll);
    b.textContent = state.showAll ? 'ALL STOPS' : 'BEST STOP PER BUS';
  }
  $('btnAll').onclick = () => { state.showAll = !state.showAll; store.set('showAll', state.showAll); renderShowAll(); tick(); };

  // ---------- taxi estimate ----------
  function taxiEstimate() {
    if (!state.taxi) return null;
    const wet = umbrellaVerdict().level === 'yes';
    const { c500, c1000 } = state.taxi;
    let wait = c500 >= 6 ? 2 : c500 >= 2 ? 4 : c1000 >= 3 ? 7 : 12;
    if (wet) wait = Math.round(wait * 1.6);
    const s = state.dest && state.stopIndex[state.dest];
    if (!s) return { wait };
    const km = (distM(state.loc.lat, state.loc.lng, s[3], s[4]) / 1000) * 1.35;
    const ride = Math.round((km / (km > 6 ? 40 : 28)) * 60 + 2);
    const fare = 4.4 + Math.max(0, km - 1) * 0.65;
    return { wait, ride, km, fare, arriveAt: Date.now() + (wait + ride) * 60000 };
  }

  // ---------- weather verdict ----------
  function umbrellaVerdict() {
    const w = state.weather;
    if (!w) return { level: 'maybe', text: 'Weather loading…', why: '' };
    const why = [];
    const fc = w.forecast ? w.forecast.text : '';
    const fcWet = /rain|shower|thunder/i.test(fc);
    const thunder = /thunder/i.test(fc);
    const rainNow = (w.rain && w.rain.value > 0) || (w.current && w.current.precipitation > 0);
    const next = (w.nowcast || []).slice(0, 5);
    const maxProb = Math.max(0, ...next.map((x) => x.prob || 0));
    const maxMm = Math.max(0, ...next.map((x) => x.mm || 0));
    if (rainNow) why.push(`raining now${w.rain && w.rain.value > 0 ? ` (${w.rain.value} mm in 5 min at ${w.rain.station})` : ''}`);
    if (fc) why.push(`NEA: “${fc}” over ${w.forecast.area}`);
    if (next.length) why.push(`${maxProb}% chance in the next hour`);
    const uv = w.uv ? w.uv.value : 0;
    let level = 'no';
    if (rainNow || fcWet || maxMm >= 0.5 || (maxProb >= 70 && maxMm >= 0.2)) level = 'yes';
    else if (maxProb >= 40 || maxMm > 0) level = 'maybe';
    let text = { yes: 'BRING UMBRELLA', maybe: 'PACK A FOLDABLE', no: 'NO NEED LAH' }[level];
    if (thunder) text = 'UMBRELLA + STAY OFF OPEN FIELDS';
    if (level === 'no' && uv >= 8) { text = 'NO RAIN, BUT PARASOL LAH'; why.push(`UV ${uv} is very high`); }
    return { level, text, why: why.join(' · '), thunder, uv, maxProb };
  }

  // ---------- mission briefing ----------
  function renderMission(ev) {
    const big = $('verdictBig'), line = $('verdictLine'), sub = $('verdictSub');
    if (!state.bus) return;
    const u = umbrellaVerdict();
    const taxi = taxiEstimate();
    const b = ev.best;
    let k, bigText, lineHtml;
    const dest = state.dest && state.stopIndex[state.dest];

    const busLine = (x) => {
      const where = `${esc(x.stop.name)} (${x.stop.dist} m)`;
      const due = x.a.secs <= 30 ? 'arriving now' : `due in ${mmss(x.a.secs)}`;
      const how = x.a.j.atStop ? "you're already there"
        : x.a.j.k === 'run' ? (x.a.j.need < state.walk + 1.5 ? `speed-walk at ~${x.a.j.need.toFixed(1)} km/h` : `sprint at ~${x.a.j.need.toFixed(0)} km/h`)
        : `leave within ${mmss(x.a.j.leaveIn)}`;
      const tr = x.svc.reach && x.svc.reach.transfer;
      const trAt = tr && state.stopIndex[tr.at];
      const arr = x.svc.reach
        ? `${tr ? `, change at ${esc(trAt ? trAt[1] : tr.at)} to bus <b>${esc(tr.no)}</b>` : ''}, reach ${esc(dest ? dest[1] : 'destination')} ~${hhmm(x.arriveAt)}`
        : '';
      return `Bus <b>${esc(x.svc.no)}</b> from ${where}, ${due}. ${how}${arr}.`;
    };

    const taxiMuchFaster = dest && taxi && taxi.arriveAt && (!b || taxi.arriveAt < b.arriveAt - 10 * 60000);
    if (taxiMuchFaster) {
      k = 'taxi'; bigText = '🚕 GRAB A TAXI';
      lineHtml = `A cab gets you to ${esc(dest[1])} around ${hhmm(taxi.arriveAt)} (about S$${taxi.fare.toFixed(0)}, est.)` +
        (b ? `, vs ${hhmm(b.arriveAt)} by bus ${esc(b.svc.no)}.` : '. No bus route found.');
    } else if (b) {
      k = b.a.j.k === 'chill' ? 'chill' : b.a.j.k;
      bigText = { run: b.a.j.need < state.walk + 1.5 ? 'HURRY UP!' : 'RUN!!!', walk: 'WALK. NOW.', chill: 'CHILL. KOPI FIRST.' }[k];
      lineHtml = busLine(b);
    } else {
      k = 'stay';
      bigText = state.taxi && state.taxi.c500 ? '🚕 TRY A TAXI' : 'GAME OVER?';
      lineHtml = dest ? `No catchable direct bus to ${esc(dest[1])} right now.` : 'No catchable bus nearby right now.';
    }
    if (big.dataset.k !== k || big.textContent !== bigText) {
      big.className = 'big ' + k + (k === 'run' ? ' blink' : '');
      big.dataset.k = k; big.textContent = bigText;
    }
    if (state.lastBig !== k) { if (k === 'run') beep([988, 1319, 988, 1319]); state.lastBig = k; }
    line.innerHTML = lineHtml;

    const bits = [`☂ ${u.text.toLowerCase()}`];
    if (state.taxi) bits.push(`🚕 ${state.taxi.c500} cabs within 500 m${taxi && taxi.arriveAt && k !== 'taxi' ? `, taxi ~${hhmm(taxi.arriveAt)} for ~S$${taxi.fare.toFixed(0)}` : ''}`);
    if (u.thunder && k === 'run') bits.push('⚡ thundery: maybe don’t sprint across the open field');
    sub.textContent = bits.join('   ·   ');

    // stat meters
    const w = state.weather || {};
    const pm = w.pm25 ? w.pm25.value : null;
    const stats = [
      { name: 'BUS', v: b ? clamp(1 - b.a.secs / 900) : 0, c: 'var(--pink)', why: b ? `next catchable ${mmss(b.a.secs)}` : 'none catchable' },
      { name: 'DRY', v: u.level === 'yes' ? 0.15 : 1 - (u.maxProb || 0) / 100, c: 'var(--cyan)', why: u.text.toLowerCase() },
      { name: 'CABS', v: state.taxi ? clamp(state.taxi.c500 / 10) : 0, c: 'var(--yellow)', why: state.taxi ? `${state.taxi.c500} within 500 m` : '…' },
      { name: 'AIR', v: pm == null ? 0.5 : clamp(1 - (pm - 10) / 60), c: 'var(--green)', why: pm == null ? '…' : `PM2.5 ${pm} µg/m³` },
      { name: 'SHADE', v: w.uv ? clamp(1 - w.uv.value / 11) : 0.5, c: 'var(--purple)', why: w.uv ? `UV ${w.uv.value}` : '…' },
    ];
    $('stats').innerHTML = stats.map((s) => {
      const on = Math.round(s.v * 10);
      return `<div class="stat" style="--c:${s.c}"><div class="name"><span>${s.name}</span><span>${on}/10</span></div>
        <div class="meter">${Array.from({ length: 10 }, (_, i) => `<i class="${i < on ? 'on' : ''}"></i>`).join('')}</div>
        <div class="why">${esc(s.why)}</div></div>`;
    }).join('');
    const score = Math.round(stats.reduce((a, s) => a + s.v, 0) / stats.length * 99990 / 10) * 10;
    $('score').textContent = String(score).padStart(5, '0');
    const hi = Math.max(store.get('hi', 0), score);
    store.set('hi', hi);
    $('hiscore').textContent = String(hi).padStart(5, '0');
  }

  // ---------- weather render ----------
  function renderWeather() {
    const w = state.weather; if (!w) return;
    const u = umbrellaVerdict();
    $('umbIcon').textContent = u.thunder ? '⛈' : u.level === 'yes' ? '☂' : u.level === 'maybe' ? '⛅' : u.uv >= 8 ? '⛱' : '😎';
    $('umbVerdict').className = 'umb-verdict ' + u.level;
    $('umbVerdict').textContent = u.text;
    $('umbWhy').textContent = u.why;

    const nc = w.nowcast || [];
    $('bars').innerHTML = nc.length ? nc.map((x) => {
      const h = x.prob != null ? x.prob : Math.min(100, x.mm * 50);
      return `<div class="bar ${x.mm > 0 || (x.prob || 0) >= 50 ? 'wet' : ''}" style="height:${Math.max(3, h)}%" title="${x.time.slice(11)}: ${x.prob ?? '?'}% · ${x.mm} mm"><span>${x.prob ?? ''}${x.prob != null ? '%' : ''}</span></div>`;
    }).join('') : '<div class="empty">nowcast unavailable</div>';
    const lbl = $('bars').nextElementSibling;
    const lblHtml = nc.map((x, i) => `<span>${i % 2 === 0 ? x.time.slice(11, 16) : ''}</span>`).join('');
    if (lbl && lbl.classList.contains('bar-lbls')) lbl.innerHTML = lblHtml;
    else $('bars').insertAdjacentHTML('afterend', `<div class="bar-lbls">${lblHtml}</div>`);

    const pmBand = (v) => v <= 55 ? 'normal' : v <= 150 ? 'elevated' : v <= 250 ? 'high' : 'very high';
    const uvBand = (v) => v <= 2 ? 'low' : v <= 5 ? 'moderate' : v <= 7 ? 'high' : v <= 10 ? 'very high' : 'extreme';
    const cells = [];
    if (w.forecast) cells.push(['2-HR FORECAST', w.forecast.text, `${w.forecast.area}${w.forecast.validTo ? ` · until ${hhmm(w.forecast.validTo)}` : ''}`]);
    if (w.temp) cells.push(['AIR TEMP', `${w.temp.value}°C`, w.current ? `feels ${Math.round(w.current.apparent_temperature)}°C · ${w.temp.station}` : w.temp.station]);
    if (w.rain) cells.push(['RAIN GAUGE', `${w.rain.value} mm`, `last 5 min · ${w.rain.station} (${w.rain.distKm} km)`]);
    if (w.uv) cells.push(['UV INDEX', w.uv.value, uvBand(w.uv.value)]);
    if (w.pm25) cells.push(['PM2.5', w.pm25.value, `${pmBand(w.pm25.value)} · ${w.pm25.region}`]);
    if (w.current) cells.push(['HUMIDITY', `${w.current.relative_humidity_2m}%`, 'sticky index']);
    $('wxGrid').innerHTML = cells.map(([h, v, s]) => `<div class="wx"><div class="h">${h}</div><div class="v">${esc(v)}</div><div class="s">${esc(s)}</div></div>`).join('');
  }

  // ---------- taxi render ----------
  function renderTaxi() {
    const t = state.taxi; if (!t) return;
    $('taxi500').textContent = t.c500;
    const luck = t.c500 >= 8 ? 'JACKPOT' : t.c500 >= 3 ? 'DECENT' : t.c1000 >= 3 ? 'WALK A BIT' : 'GOOD LUCK';
    const est = taxiEstimate();
    const s = state.dest && state.stopIndex[state.dest];
    const rows = [
      ['Within 250 m', t.c250], ['Within 1 km', t.c1000], ['Island-wide', t.total],
      ['Cab luck', luck], ['Expected wait', est ? `~${est.wait} min` : '?'],
    ];
    if (s && est && est.ride) rows.push([`To ${s[1]}`, `~${est.ride} min · ~S$${est.fare.toFixed(0)} (est.)`]);
    rows.push(['Updated', hhmm(t.timestamp)]);
    $('taxiRows').innerHTML = rows.map(([a, b]) => `<div><span>${esc(a)}</span><b>${esc(b)}</b></div>`).join('');
    layers.taxis.clearLayers();
    for (const [la, ln] of t.near) {
      L.circleMarker([la, ln], { radius: 4, color: '#000', weight: 1, fillColor: '#ffe600', fillOpacity: 1 }).addTo(layers.taxis);
    }
  }

  // ---------- carparks render ----------
  function renderParks() {
    const c = state.carparks; if (!c) return;
    layers.parks.clearLayers();
    if (!c.carparks.length) { $('parkList').innerHTML = '<div class="empty">No HDB carparks within 2 km.</div>'; return; }
    $('parkList').innerHTML = c.carparks.slice(0, 8).map((p, i) => {
      const pct = p.total ? p.available / p.total : 0;
      const col = p.available === 0 ? 'var(--red)' : pct > 0.3 ? 'var(--green)' : pct > 0.1 ? 'var(--yellow)' : 'var(--orange)';
      return `<div class="cp" data-i="${i}">
        <div class="r1"><span class="addr">${esc(p.address)}</span><span class="lots" style="color:${col}">${p.available === 0 ? 'FULL' : p.available}/${p.total}</span></div>
        <div class="cbar"><i style="width:${(pct * 100).toFixed(0)}%;background:${col}"></i></div>
        <div class="r2">${p.dist} m · ${esc(p.id)} · ${esc((p.type || '').toLowerCase())}${p.height ? ` · ${p.height} m gantry` : ''}${p.free && p.free !== 'NO' ? ` · free: ${esc(p.free.toLowerCase())}` : ''}</div>
      </div>`;
    }).join('');
    c.carparks.slice(0, 8).forEach((p) => {
      L.marker([p.lat, p.lng], { icon: pin('park', `P ${p.available}`) })
        .bindPopup(`<b>${esc(p.address)}</b><br>${p.available}/${p.total} lots free<br>${esc(p.id)} · ${p.dist} m`).addTo(layers.parks);
    });
  }
  $('parkList').addEventListener('click', (e) => {
    const el = e.target.closest('.cp'); if (!el || !state.carparks) return;
    const p = state.carparks.carparks[+el.dataset.i];
    map.setView([p.lat, p.lng], 17);
    layers.parks.eachLayer((m) => { const ll = m.getLatLng(); if (ll.lat === p.lat && ll.lng === p.lng) m.openPopup(); });
  });

  // ---------- cams / fx ----------
  function renderCams() {
    const c = state.cams; if (!c) return;
    $('cams').innerHTML = c.cams.length ? c.cams.map((x) =>
      `<div class="cam"><a href="${esc(x.image)}" target="_blank" rel="noopener"><img loading="lazy" src="${esc(x.image)}" alt="${esc(x.name)} traffic camera"></a>
        <div class="cap"><span>${esc(x.name)}</span><span>${hhmm(x.timestamp)}</span></div></div>`).join('')
      : '<div class="empty">Checkpoint cameras are offline right now.</div>';
  }
  function renderFx() {
    const f = state.fx; if (!f) { $('fxRate').textContent = 'FX unavailable'; return; }
    $('fxRate').textContent = `S$1 = RM ${f.myr.toFixed(4)}`;
    const sgd = Math.max(0, +$('fxIn').value || 0);
    const rm = sgd * f.myr;
    $('fxOut').textContent = `RM ${rm.toFixed(2)}`;
    const laksa = Math.floor(rm / 9), kopi = Math.floor(rm / 2.2);
    $('fxFun').textContent = `≈ ${laksa} bowls of JB laksa (RM 9) or ${kopi} kopi-O (RM 2.20). ECB rate as of ${f.date}; your money changer will differ.`;
  }
  $('fxIn').oninput = renderFx;
  const goJohor = (code) => { setDest(code); document.querySelector('.bus').scrollIntoView({ behavior: 'smooth' }); };
  $('goJB').onclick = () => goJohor('46211');
  $('goWL').onclick = () => goJohor('46101');

  // ---------- bus map layer ----------
  function renderBusMap() {
    layers.stops.clearLayers(); layers.buses.clearLayers();
    if (!state.bus) return;
    const seen = new Set();
    for (const st of state.bus.stops) {
      L.marker([st.lat, st.lng], { icon: pin('stop', st.code) })
        .bindPopup(`<b>${esc(st.name)}</b><br>${esc(st.road)} · ${st.dist} m<br>${st.services.map((s) => esc(s.no)).join(', ') || 'no services'}`)
        .addTo(layers.stops);
      for (const sv of st.services) {
        const a = sv.arrivals[0];
        if (!a || !a.lat || !a.live) continue;
        const key = sv.no + '@' + a.lat.toFixed(4);
        if (seen.has(key)) continue;
        seen.add(key);
        L.marker([a.lat, a.lng], { icon: pin('bus', '🚌' + sv.no) }).bindPopup(`Bus ${esc(sv.no)} heading to ${esc(st.name)}`).addTo(layers.buses);
      }
    }
  }

  // ---------- refreshers ----------
  const inflight = {};
  const guard = (name, fn) => async () => {
    if (inflight[name]) return; inflight[name] = true;
    try { await fn(); } catch (e) { console.warn(name, e); } finally { inflight[name] = false; }
  };
  const refreshBus = guard('bus', async () => {
    const d = state.dest ? `&dest=${encodeURIComponent(state.dest)}` : '';
    const reqLoc = state.loc, reqDest = state.dest;
    const data = await api(`/api/bus?${qs()}${d}`);
    if (reqLoc !== state.loc || reqDest !== state.dest) return refreshBusSoon();
    state.bus = data; renderBusMap(); tick();
  });
  const refreshBusSoon = () => setTimeout(refreshBus, 50);
  const refreshTaxi = guard('taxi', async () => { state.taxi = await api(`/api/taxi?${qs()}`); renderTaxi(); tick(); });
  const refreshParks = guard('parks', async () => { state.carparks = await api(`/api/carparks?${qs()}`); renderParks(); });
  const refreshWeather = guard('wx', async () => { state.weather = await api(`/api/weather?${qs()}`); renderWeather(); renderTaxi(); tick(); });
  const refreshCams = guard('cams', async () => { state.cams = await api('/api/cams'); renderCams(); });
  const refreshFx = guard('fx', async () => { try { state.fx = await api('/api/fx'); } catch { state.fx = null; } renderFx(); });

  function tick() {
    const n = new Date();
    $('clock').textContent = `${pad(n.getHours())}:${pad(n.getMinutes())}:${pad(n.getSeconds())}`;
    const ev = evaluateBuses();
    renderBus(ev);
    renderMission(ev);
  }

  // ---------- boot ----------
  async function boot() {
    $('locName').textContent = state.loc.name || CT_HUB.name;
    renderSpeeds(); renderPresets(); renderShowAll();
    try {
      state.stops = await api('/api/stops');
      for (const s of state.stops) state.stopIndex[s[0]] = s;
    } catch (e) { toast('Could not load bus stops. Is the server online?'); }
    const urlDest = new URLSearchParams(location.search).get('dest');
    if (urlDest && state.stopIndex[urlDest]) { state.dest = urlDest; store.set('dest', urlDest); renderPresets(); }
    if (state.dest && state.stopIndex[state.dest]) destInput.value = state.stopIndex[state.dest][1];
    renderDestMeta();
    refreshBus(); refreshTaxi(); refreshParks(); refreshWeather(); refreshCams(); refreshFx();
    setInterval(tick, 1000);
    setInterval(refreshBus, 20000);
    setInterval(refreshTaxi, 30000);
    setInterval(refreshParks, 60000);
    setInterval(refreshCams, 60000);
    setInterval(refreshWeather, 5 * 60000);
  }
  boot();
})();
