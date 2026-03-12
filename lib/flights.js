import { getConfig } from './config.js';

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

export function sanitizeBounds(searchParams) {
  const lamin = maybeFloat(searchParams.get('lamin'));
  const lomin = maybeFloat(searchParams.get('lomin'));
  const lamax = maybeFloat(searchParams.get('lamax'));
  const lomax = maybeFloat(searchParams.get('lomax'));

  if ([lamin, lomin, lamax, lomax].some((v) => v === null)) return null;

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

export function sanitizeIcao24(values) {
  return values
    .flatMap((v) => String(v || '').split(','))
    .map((v) => v.trim().toLowerCase())
    .filter((v) => /^[0-9a-f]{6}$/.test(v));
}

function sanitizeTime(value) {
  const parsed = maybeInt(value);
  if (parsed === null || parsed <= 0) return null;
  return parsed;
}

export function parseFlightRequest(searchParams) {
  const bounds = sanitizeBounds(searchParams);
  const mode = searchParams.get('mode') === 'global' ? 'global' : 'camera';
  const includeExtended = searchParams.get('extended') !== '0';
  const icao24 = sanitizeIcao24(searchParams.getAll('icao24'));
  const timeValue = sanitizeTime(searchParams.get('time'));
  return { mode, bounds, includeExtended, icao24, time: timeValue };
}

export function filterStates(states, bounds, icao24Filters) {
  const wantedIcaos = new Set(
    (icao24Filters || []).map((v) => v.toLowerCase())
  );
  return states.filter((row) => {
    const icao24 = String(row?.[0] || '').toLowerCase();
    if (wantedIcaos.size > 0 && !wantedIcaos.has(icao24)) return false;
    if (!bounds) return true;
    const longitude = Number(row?.[5]);
    const latitude = Number(row?.[6]);
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude))
      return false;
    return (
      latitude >= bounds.lamin &&
      latitude <= bounds.lamax &&
      longitude >= bounds.lomin &&
      longitude <= bounds.lomax
    );
  });
}

export function buildMockPayload(requestOptions, metaOverrides, template) {
  const t = structuredClone(template);
  const bounds = requestOptions.mode === 'camera' ? requestOptions.bounds : null;
  const filteredStates = filterStates(
    t.states || [],
    bounds,
    requestOptions.icao24
  );
  t.states = filteredStates;
  t.time = Math.floor(Date.now() / 1000);
  return {
    data: t,
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

async function safeReadText(response) {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

let accessTokenCache = null;

async function getOpenSkyAccessToken() {
  const CONFIG = getConfig();
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
    }
  );
  if (!tokenResponse.ok) {
    const snippet = await safeReadText(tokenResponse);
    throw new Error(
      `OpenSky OAuth token request failed (${tokenResponse.status}${snippet ? `: ${snippet.slice(0, 180)}` : ''})`
    );
  }
  const tokenData = await tokenResponse.json();
  accessTokenCache = {
    accessToken: tokenData.access_token,
    expiresAt: Date.now() + Number(tokenData.expires_in || 1800) * 1000,
  };
  return accessTokenCache.accessToken;
}

export async function fetchOpenSkyPayload(requestOptions) {
  const CONFIG = getConfig();
  const authenticated = Boolean(
    CONFIG.openskyClientId && CONFIG.openskyClientSecret
  );
  const params = new URLSearchParams();
  if (requestOptions.includeExtended) params.set('extended', '1');
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
    headers.Authorization = `Bearer ${await getOpenSkyAccessToken()}`;
  }
  const endpoint = `https://opensky-network.org/api/states/all${params.toString() ? `?${params.toString()}` : ''}`;
  const apiResponse = await fetch(endpoint, {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(12_000),
  });
  if (!apiResponse.ok) {
    const snippet = await safeReadText(apiResponse);
    throw new Error(
      `OpenSky request failed (${apiResponse.status}${snippet ? `: ${snippet.slice(0, 180)}` : ''})`
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
      rateLimitRetryAfterSeconds: apiResponse.headers.get(
        'x-rate-limit-retry-after-seconds'
      ),
      message: authenticated
        ? 'Live OpenSky data via OAuth2 client credentials.'
        : 'Live OpenSky data using anonymous access.',
    },
  };
}
