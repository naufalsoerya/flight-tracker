# SkyTrace 3D

A lightweight 3D flight tracking web app that renders live aircraft on a Cesium globe and pulls aircraft state vectors from OpenSky through a backend proxy.

## What it does

- Renders aircraft on a 3D globe
- Uses camera-bounds mode by default so the app only requests flights in the current view
- Supports search by callsign, ICAO24, and origin country
- Click a flight to inspect its details and optionally follow it with the camera
- Draws short history trails for visible flights
- Falls back to bundled sample data if the live feed is unavailable
- Supports OpenSky OAuth2 client credentials when configured
- Supports Cesium ion terrain and OSM Buildings when a token is configured

## Quick start

```bash
cp .env.example .env
node server.mjs
```

Then open `http://localhost:8787`.

### Deploy to Vercel

The project is set up for [Vercel](https://vercel.com): static files are served from `public/` and the backend runs as serverless functions under `api/`.

1. Push the repo to GitHub and import the project in Vercel.
2. Set environment variables in the Vercel project (e.g. `CESIUM_ION_TOKEN`, `OPENSKY_CLIENT_ID`, `OPENSKY_CLIENT_SECRET`, `DEMO_MODE`).
3. Deploy. The app will be available at your Vercel URL.

Local development still uses `node server.mjs`; the same env vars (e.g. from `.env`) apply.

You can also run bundled demo data only:

```bash
DEMO_MODE=true node server.mjs
```

## Configuration

Create a `.env` file from `.env.example`.

### Cesium

Set `CESIUM_ION_TOKEN` to your own browser-safe Cesium ion token if you want:

- Cesium World Terrain
- Cesium OSM Buildings
- cleaner production behavior than relying on any default evaluation token

### OpenSky

Set both of these to enable authenticated OpenSky requests:

- `OPENSKY_CLIENT_ID`
- `OPENSKY_CLIENT_SECRET`

If you leave them blank, the app still works with anonymous access, but with tighter limits.

## App structure

```text
.
├── api/                 # Vercel serverless (deploy)
│   ├── config.js
│   ├── health.js
│   └── flights.js
├── data/
│   └── mock-states.json
├── lib/                 # Shared logic for api/ and server.mjs
│   ├── config.js
│   └── flights.js
├── public/
│   ├── app.js
│   ├── favicon.svg
│   ├── index.html
│   ├── plane-marker.svg
│   └── styles.css
├── .env.example
├── package.json
├── README.md
├── server.mjs           # Local dev server
└── vercel.json
```

## Notes

- The server uses only Node built-ins. There are no runtime npm dependencies.
- The frontend uses the CesiumJS CDN.
- In camera-bounds mode, moving the camera triggers a debounced refresh.
- The backend caches identical OpenSky requests briefly to avoid burning credits too aggressively.
