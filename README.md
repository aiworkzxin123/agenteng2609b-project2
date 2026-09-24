# Kiasu Kommute 🕹️

*Never miss the bus again, lah.* An arcade-style, real-time dashboard for getting out of CT Hub (Kallang), or anywhere in Singapore. It started life as "Escape from CT Hub".

```
npm start        # or: node server.js
# open http://localhost:3000
```

Needs Node 18+ and no `npm install`. The app has no dependencies and uses no API keys.

**Hosted version:** https://aiworkzxin123.github.io/kiasu-kommute/ (live, via GitHub Pages) · snapshot copy at [`/snapshot/`](https://aiworkzxin123.github.io/kiasu-kommute/snapshot/)

## What it does

| Panel | Question it answers | Data |
|---|---|---|
| 01 Mission briefing | Overall verdict (RUN!!! / WALK. NOW. / CHILL / GRAB A TAXI), plus stat meters and a kiasu score | everything below |
| 02 Radar | Map of you, nearby stops, the live position of each approaching bus, taxis and carparks. Click or drag to move. | OSM tiles |
| 03 Which bus do I run for? | Every nearby bus, judged by *your* walk and run speed: CHILL / WALK / RUN! / MISS. Pick a destination to see only buses that get there, including **1-transfer routes** when nothing goes direct. | arrivelah, busrouter.sg stops and routes |
| 04 Umbrella or not? | Umbrella verdict from the NEA 2-hr forecast, the nearest rain gauge, and a 15-min rain nowcast; also temperature, UV, PM2.5 and humidity | data.gov.sg, Open-Meteo |
| 05 Cab luck | Taxis within 250 m / 500 m / 1 km, expected wait (longer in rain), and fare and time to your destination | data.gov.sg taxi-availability |
| 06 …but park where? | Nearest HDB carparks with live free lots | data.gov.sg carpark availability + HDB carpark info (SVY21 → WGS84) |
| 07 Escape to Johor | Woodlands and Tuas checkpoint cams, SGD→MYR with a laksa calculator, and one-tap bus plans to the JB and Woodlands checkpoints | data.gov.sg traffic-images, Frankfurter (ECB) |

Tips: pick a runner profile (🧓 Auntie → ⚡ Bolt) or tune the sliders. Toggle **SFX** for 8-bit beeps when it's time to run.
Deep-link a destination with `?dest=<stop code>`, e.g. `/?dest=46211` for the JB Checkpoint.

## GitHub Pages

Every upstream API allows cross-origin requests, so the same `public/` folder also works as a static site. On `localhost` the page goes through `server.js`. On any other host it calls the APIs straight from the browser through `public/client-api.js`. Both modes share the data logic in `public/core.js`. The `.github/workflows/pages.yml` workflow deploys `public/` on every push to `main`, and puts the Artifact snapshot at `/snapshot/`.

## Notes
- The server (`server.js`) proxies and caches every upstream API (15 s for buses, 30 s for taxis, 1 min for carparks and cams, 5 min for weather). Bus stops, routes and carpark metadata are cached to `./data/`.
- Walk and run times use straight-line distance × 1.25. Ride times assume about 19 km/h, and transfers assume an 8-minute wait. Taxi fares are rough estimates.

## Artifact (snapshot) version

A single-file version runs as a claude.ai Artifact: https://claude.ai/artifact/RpXU6XAQABi54WJAaHqcnF

Artifacts can't call outside APIs, so `artifact/build.js` fetches live data (bus arrivals, taxis, carparks, weather, FX, and camera frames as embedded images) and builds it into `artifact/template.html`. The result is `artifact/escape-from-ct-hub.html`. Bus countdowns run from the capture time. Destination search and one-transfer routing still run inside the page, using the built-in stop and route data. Map tiles are blocked in artifacts, so the page draws its own radar instead.

```
npm start                 # the build reads taxis, carparks, weather, FX and cams from the local server
node artifact/build.js    # writes artifact/escape-from-ct-hub.html
```
