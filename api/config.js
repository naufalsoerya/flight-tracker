import { getConfig } from '../lib/config.js';

function sendJson(res, statusCode, payload) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.status(statusCode).end(JSON.stringify(payload));
}

export default function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendJson(res, 405, { error: 'Method Not Allowed' });
  }
  const CONFIG = getConfig();
  sendJson(res, 200, {
    appName: 'SkyTrace 3D',
    cesiumToken: CONFIG.cesiumIonToken,
    defaultRefreshMs: CONFIG.defaultRefreshMs,
    defaultFetchMode: CONFIG.defaultFetchMode,
    hasCesiumToken: Boolean(CONFIG.cesiumIonToken),
    openskyAuthConfigured: Boolean(
      CONFIG.openskyClientId && CONFIG.openskyClientSecret
    ),
    demoMode: CONFIG.demoMode,
  });
}
