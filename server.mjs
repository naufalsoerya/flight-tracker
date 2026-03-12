import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, 'public');
const MOCK_FILE = path.join(__dirname, 'data', 'mock-states.json');
const ENV_FILE = path.join(__dirname, '.env');

loadEnvFile(ENV_FILE);

const CONFIG = {
  host: process.env.HOST || '0.0.0.0',
  port: Number.parseInt(process.env.PORT || '8787', 10),
  cesiumIonToken: process.env.CESIUM_ION_TOKEN || '',
  openskyClientId: process.env.OPENSKY_CLIENT_ID || '',
  openskyClientSecret: process.env.OPENSKY_CLIENT_SECRET || '',
  defaultRefreshMs: clampInt(process.env.DEFAULT_REFRESH_MS, 30_000, 10_000, 300_000),
  defaultFetchMode: ['camera', 'global'].includes(process.env.DEFAULT_FETCH_MODE) ? process.env.DEFAULT_FETCH_MODE : 'camera',
  demoMode: /^true$/i.test(process.env.DEMO_MODE || 'false'),
};

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

const cache = new Map();
let accessTokenCache = null;
const mockStatesTemplate = JSON.parse(await readFile(MOCK_FILE, 'utf8'));

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url || '/', `http://${request.headers.host || `localhost:${CONFIG.port}`}`);

    if (request.method === 'GET' && url.pathname === '/api/config') {
      return sendJson(response, 200, {
        appName: 'SkyTrace 3D',
        cesiumToken: CONFIG.cesiumIonToken,
        defaultRefreshMs: CONFIG.defaultRefreshMs,
        defaultFetchMode: CONFIG.defaultFetchMode,
        hasCesiumToken: Boolean(CONFIG.cesiumIonToken),
        openskyAuthConfigured: Boolean(CONFIG.openskyClientId && CONFIG.openskyClientSecret),
        demoMode: CONFIG.demoMode,
      });
    }

    if (request.method === 'GET' && url.pathname === '/api/health') {
      return sendJson(response, 200, {
        ok: true,
        timestamp: new Date().toISOString(),
        demoMode: CONFIG.demoMode,
        openskyAuthConfigured: Boolean(CONFIG.openskyClientId && CONFIG.openskyClientSecret),
      });
    }

    if (request.method === 'GET' && url.pathname === '/api/flights') {
      return await handleFlightsRequest(url, response);
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return sendJson(response, 405, { error: 'Method Not Allowed' });
    }

    return await serveStaticAsset(url.pathname, response);
  } catch (error) {
    const statusCode = error?.statusCode || 500;
    const message = error instanceof Error ? error.message : 'Unknown server error';
    return sendJson(response, statusCode, { error: message });
  }
});

server.listen(CONFIG.port, CONFIG.host, () => {
  console.log(`SkyTrace 3D listening on http://${CONFIG.host}:${CONFIG.port}`);
  console.log(`Demo mode: ${CONFIG.demoMode ? 'enabled' : 'disabled'}`);
  console.log(`OpenSky OAuth configured: ${CONFIG.openskyClientId && CONFIG.openskyClientSecret ? 'yes' : 'no'}`);
  console.log(`Cesium ion token configured: ${CONFIG.cesiumIonToken ? 'yes' : 'no'}`);
});

async function handleFlightsRequest(url, response) {
  const requestOptions = parseFlightRequest(url.searchParams);
  const cacheKey = JSON.stringify(requestOptions);
  const now = Date.now();
  const cached = cache.get(cacheKey);

  if (cached && now - cached.cachedAt < 10_000) {
    return sendJson(response, 200, {
      ...cached.payload,
      meta: {
        ...cached.payload.meta,
        cache: 'hit',
      },
    });
  }

  try {
    let payload;

    if (CONFIG.demoMode) {
      payload = buildMockPayload(requestOptions, {
        source: 'demo',
        authenticated: false,
        degraded: false,
        message: 'Serving bundled demo flight data.',
      });
    } else {
      payload = await fetchOpenSkyPayload(requestOptions);
    }

    cache.set(cacheKey, { cachedAt: now, payload });
    cleanupCache();
    return sendJson(response, 200, payload);
  } catch (error) {
    const fallback = buildMockPayload(requestOptions, {
      source: 'sample-fallback',
      authenticated: false,
      degraded: true,
      message: error instanceof Error ? error.message : 'Falling back to sample flight data.',
    });

    const stale = cache.get(cacheKey);
    if (stale) {
      return sendJson(response, 200, {
        ...stale.payload,
        meta: {
          ...stale.payload.meta,
          cache: 'stale',
          degraded: true,
          message: fallback.meta.message,
        },
      });
    }

    return sendJson(response, 200, fallback);
  }
}

function parseFlightRequest(searchParams) {
  const bounds = sanitizeBounds(searchParams);
  const mode = searchParams.get('mode') === 'global' ? 'global' : 'camera';
  const includeExtended = searchParams.get('extended') !== '0';
  const icao24 = sanitizeIcao24(searchParams.getAll('icao24'));
  const timeValue = sanitizeTime(searchParams.get('time'));

  return {
    mode,
    bounds,
    includeExtended,
    icao24,
    time: timeValue,
  };
}

async function fetchOpenSkyPayload(requestOptions) {
  const authenticated = Boolean(CONFIG.openskyClientId && CONFIG.openskyClientSecret);
  const params = new URLSearchParams();

  if (requestOptions.includeExtended) {
    params.set('extended', '1');
  }

  if (requestOptions.time && authenticated) {
    params.set('time', String(requestOptions.time));
  }

  for (const icao of requestOptions.icao24) {
    params.append('icao24', icao);
  }

  if (requestOptions.mode === 'camera' && requestOptions.bounds) {
    params.set('lamin', requestOptions.bounds.lamin.toFixed(4));
    params.set('lomin', requestOptions.bounds.lomin.toFixed(4));
    params.set('lamax', requestOptions.bounds.lamax.toFixed(4));
    params.set('lomax', requestOptions.bounds.lomax.toFixed(4));
  }

  const headers = {
    Accept: 'application/json',
    'User-Agent': 'SkyTrace3D/1.0',
  };

  if (authenticated) {
    const accessToken = await getOpenSkyAccessToken();
    headers.Authorization = `Bearer ${accessToken}`;
  }

  const endpoint = `https://opensky-network.org/api/states/all${params.toString() ? `?${params.toString()}` : ''}`;
  const apiResponse = await fetch(endpoint, {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(12_000),
  });

  if (!apiResponse.ok) {
    const bodySnippet = await safeReadText(apiResponse);
    throw new Error(
      `OpenSky request failed (${apiResponse.status}${bodySnippet ? `: ${bodySnippet.slice(0, 180)}` : ''})`,
    );
  }

  const data = await apiResponse.json();

  return {
    data,
    meta: {
      authenticated,
      source: 'opensky',
      retrievedAt: new Date().toISOString(),
      degraded: false,
      mode: requestOptions.mode,
      bounds: requestOptions.bounds,
      rateLimitRemaining: apiResponse.headers.get('x-rate-limit-remaining'),
      rateLimitRetryAfterSeconds: apiResponse.headers.get('x-rate-limit-retry-after-seconds'),
      message: authenticated
        ? 'Live OpenSky data via OAuth2 client credentials.'
        : 'Live OpenSky data using anonymous access.',
    },
  };
}

async function getOpenSkyAccessToken() {
  if (!CONFIG.openskyClientId || !CONFIG.openskyClientSecret) {
    throw new Error('OpenSky OAuth client credentials are not configured.');
  }

  if (accessTokenCache && accessTokenCache.expiresAt > Date.now() + 60_000) {
    return accessTokenCache.accessToken;
  }

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: CONFIG.openskyClientId,
    client_secret: CONFIG.openskyClientSecret,
  });

  const tokenResponse = await fetch(
    'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body,
      signal: AbortSignal.timeout(12_000),
    },
  );

  if (!tokenResponse.ok) {
    const bodySnippet = await safeReadText(tokenResponse);
    throw new Error(
      `OpenSky OAuth token request failed (${tokenResponse.status}${bodySnippet ? `: ${bodySnippet.slice(0, 180)}` : ''})`,
    );
  }

  const tokenData = await tokenResponse.json();
  accessTokenCache = {
    accessToken: tokenData.access_token,
    expiresAt: Date.now() + Number(tokenData.expires_in || 1800) * 1000,
  };

  return accessTokenCache.accessToken;
}

function buildMockPayload(requestOptions, metaOverrides = {}) {
  const template = structuredClone(mockStatesTemplate);
  const bounds = requestOptions.mode === 'camera' ? requestOptions.bounds : null;
  const filteredStates = filterStates(template.states || [], bounds, requestOptions.icao24);

  template.states = filteredStates;
  template.time = Math.floor(Date.now() / 1000);

  return {
    data: template,
    meta: {
      authenticated: false,
      source: metaOverrides.source || 'sample',
      retrievedAt: new Date().toISOString(),
      degraded: Boolean(metaOverrides.degraded),
      mode: requestOptions.mode,
      bounds,
      rateLimitRemaining: null,
      rateLimitRetryAfterSeconds: null,
      message: metaOverrides.message || 'Serving bundled sample data.',
    },
  };
}

function filterStates(states, bounds, icao24Filters) {
  const wantedIcaos = new Set((icao24Filters || []).map((value) => value.toLowerCase()));

  return states.filter((row) => {
    const icao24 = String(row?.[0] || '').toLowerCase();
    if (wantedIcaos.size > 0 && !wantedIcaos.has(icao24)) {
      return false;
    }

    if (!bounds) {
      return true;
    }

    const longitude = Number(row?.[5]);
    const latitude = Number(row?.[6]);

    if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) {
      return false;
    }

    return (
      latitude >= bounds.lamin &&
      latitude <= bounds.lamax &&
      longitude >= bounds.lomin &&
      longitude <= bounds.lomax
    );
  });
}

async function serveStaticAsset(requestPathname, response) {
  const normalizedPath = requestPathname === '/' ? '/index.html' : requestPathname;
  const decodedPath = decodeURIComponent(normalizedPath);
  const safeRelativePath = decodedPath.replace(/^\/+/, '');
  let filePath = path.join(PUBLIC_DIR, safeRelativePath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    throw Object.assign(new Error('Forbidden'), { statusCode: 403 });
  }

  try {
    const fileStats = await stat(filePath);
    if (fileStats.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
    }
  } catch (error) {
    if (!path.extname(filePath)) {
      filePath = path.join(PUBLIC_DIR, 'index.html');
    } else if (error?.code === 'ENOENT') {
      throw Object.assign(new Error('Not Found'), { statusCode: 404 });
    } else {
      throw error;
    }
  }

  let fileBuffer;
  try {
    fileBuffer = await readFile(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw Object.assign(new Error('Not Found'), { statusCode: 404 });
    }
    throw error;
  }

  const ext = path.extname(filePath).toLowerCase();
  response.writeHead(200, {
    'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
    'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=300',
  });
  response.end(fileBuffer);
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(payload));
}

function sanitizeBounds(searchParams) {
  const lamin = maybeFloat(searchParams.get('lamin'));
  const lomin = maybeFloat(searchParams.get('lomin'));
  const lamax = maybeFloat(searchParams.get('lamax'));
  const lomax = maybeFloat(searchParams.get('lomax'));

  if ([lamin, lomin, lamax, lomax].some((value) => value === null)) {
    return null;
  }

  const bounded = {
    lamin: clamp(lamin, -85, 85),
    lomin: clamp(lomin, -180, 180),
    lamax: clamp(lamax, -85, 85),
    lomax: clamp(lomax, -180, 180),
  };

  if (
    bounded.lamax <= bounded.lamin ||
    bounded.lomax <= bounded.lomin ||
    bounded.lamax - bounded.lamin > 170 ||
    bounded.lomax - bounded.lomin > 340
  ) {
    return null;
  }

  return bounded;
}

function sanitizeIcao24(values) {
  return values
    .flatMap((value) => String(value || '').split(','))
    .map((value) => value.trim().toLowerCase())
    .filter((value) => /^[0-9a-f]{6}$/.test(value));
}

function sanitizeTime(value) {
  const parsed = maybeInt(value);
  if (parsed === null || parsed <= 0) {
    return null;
  }
  return parsed;
}

function cleanupCache() {
  const cutoff = Date.now() - 60_000;
  for (const [key, value] of cache.entries()) {
    if (value.cachedAt < cutoff) {
      cache.delete(key);
    }
  }
}

function loadEnvFile(filePath) {
  try {
    const raw = requireText(filePath);
    for (const line of raw.split(/\r?\n/u)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        continue;
      }

      const separatorIndex = trimmed.indexOf('=');
      if (separatorIndex <= 0) {
        continue;
      }

      const key = trimmed.slice(0, separatorIndex).trim();
      let value = trimmed.slice(separatorIndex + 1).trim();

      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      if (!(key in process.env)) {
        process.env[key] = value;
      }
    }
  } catch {
    // .env file is optional.
  }
}

function requireText(filePath) {
  return readFileSync(filePath, 'utf8');
}

function clamp(number, min, max) {
  return Math.min(max, Math.max(min, number));
}

function maybeFloat(value) {
  const parsed = Number.parseFloat(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function maybeInt(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function clampInt(value, fallback, min, max) {
  const parsed = maybeInt(value);
  if (parsed === null) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

async function safeReadText(response) {
  try {
    return await response.text();
  } catch {
    return '';
  }
}
