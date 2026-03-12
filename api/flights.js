import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConfig } from '../lib/config.js';
import {
  parseFlightRequest,
  buildMockPayload,
  fetchOpenSkyPayload,
} from '../lib/flights.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CACHE_TTL_MS = 10_000;
const cache = new Map();

function sendJson(res, statusCode, payload) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.status(statusCode).end(JSON.stringify(payload));
}

async function getMockTemplate() {
  const mockPath = path.join(
    path.dirname(__dirname),
    'data',
    'mock-states.json'
  );
  const raw = await readFile(mockPath, 'utf8');
  return JSON.parse(raw);
}

let mockTemplatePromise = null;
function loadMockTemplate() {
  if (!mockTemplatePromise) mockTemplatePromise = getMockTemplate();
  return mockTemplatePromise;
}

function cleanupCache() {
  const cutoff = Date.now() - 60_000;
  for (const [key, value] of cache.entries()) {
    if (value.cachedAt < cutoff) cache.delete(key);
  }
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendJson(res, 405, { error: 'Method Not Allowed' });
  }

  const CONFIG = getConfig();
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const requestOptions = parseFlightRequest(url.searchParams);
  const cacheKey = JSON.stringify(requestOptions);
  const now = Date.now();
  const cached = cache.get(cacheKey);

  if (cached && now - cached.cachedAt < CACHE_TTL_MS) {
    return sendJson(res, 200, {
      ...cached.payload,
      meta: { ...cached.payload.meta, cache: 'hit' },
    });
  }

  try {
    let payload;
    if (CONFIG.demoMode) {
      const template = await loadMockTemplate();
      payload = buildMockPayload(
        requestOptions,
        {
          source: 'demo',
          authenticated: false,
          degraded: false,
          message: 'Serving bundled demo flight data.',
        },
        template
      );
    } else {
      payload = await fetchOpenSkyPayload(requestOptions);
    }
    cache.set(cacheKey, { cachedAt: now, payload });
    cleanupCache();
    return sendJson(res, 200, payload);
  } catch (error) {
    const template = await loadMockTemplate();
    const fallback = buildMockPayload(
      requestOptions,
      {
        source: 'sample-fallback',
        authenticated: false,
        degraded: true,
        message:
          error instanceof Error
            ? error.message
            : 'Falling back to sample flight data.',
      },
      template
    );
    const stale = cache.get(cacheKey);
    if (stale) {
      return sendJson(res, 200, {
        ...stale.payload,
        meta: {
          ...stale.payload.meta,
          cache: 'stale',
          degraded: true,
          message: fallback.meta.message,
        },
      });
    }
    return sendJson(res, 200, fallback);
  }
}
