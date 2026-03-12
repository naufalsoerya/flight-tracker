/**
 * App config from environment (used by Vercel serverless and optional local .env).
 */
function clampInt(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export function getConfig() {
  return {
    cesiumIonToken: process.env.CESIUM_ION_TOKEN || '',
    openskyClientId: process.env.OPENSKY_CLIENT_ID || '',
    openskyClientSecret: process.env.OPENSKY_CLIENT_SECRET || '',
    defaultRefreshMs: clampInt(
      process.env.DEFAULT_REFRESH_MS,
      30_000,
      10_000,
      300_000
    ),
    defaultFetchMode: ['camera', 'global'].includes(process.env.DEFAULT_FETCH_MODE)
      ? process.env.DEFAULT_FETCH_MODE
      : 'camera',
    demoMode: /^true$/i.test(process.env.DEMO_MODE || 'false'),
  };
}
