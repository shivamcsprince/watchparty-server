/**
 * Central place for reading environment variables.
 * Fails fast at startup with a clear message instead of crashing later
 * with a confusing error deep inside a library.
 */

function required(name) {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

function parseInteger(name, value, { min, max }) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max} (got "${value}")`);
  }
  return number;
}

function requiredSecret(name) {
  const value = required(name);
  if (value.length < 32) {
    throw new Error(`${name} must be at least 32 characters long`);
  }
  return value;
}

function parsePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be an integer between 1 and 65535 (got "${value}")`);
  }
  return port;
}

const nodeEnv = process.env.NODE_ENV ?? 'development';

export const config = Object.freeze({
  nodeEnv,
  isProduction: nodeEnv === 'production',
  port: parsePort(process.env.PORT ?? '4000'),
  databaseUrl: required('DATABASE_URL'),
  jwtSecret: requiredSecret('JWT_SECRET'),
  jwtExpiresIn: '1h',
  // bcrypt cost: each +1 doubles the time. 10 is a good balance on small free servers.
  bcryptRounds: parseInteger('BCRYPT_ROUNDS', process.env.BCRYPT_ROUNDS ?? '10', {
    min: 4,
    max: 14,
  }),
  // Number of reverse proxies in front of the app (Render = 1). Needed so that
  // rate limiting sees the real client IP instead of the proxy's IP.
  trustProxy: parseInteger('TRUST_PROXY', process.env.TRUST_PROXY ?? '0', { min: 0, max: 5 }),
  roomCapacity: parseInteger('ROOM_CAPACITY', process.env.ROOM_CAPACITY ?? '50', {
    min: 2,
    max: 1000,
  }),
  roomCreateRateLimitMax: parseInteger(
    'ROOM_CREATE_RATE_LIMIT_MAX',
    process.env.ROOM_CREATE_RATE_LIMIT_MAX ?? '20',
    { min: 1, max: 100000 },
  ),
  // How long a host may be absent before someone else takes over (default 2 minutes).
  hostGraceMs: parseInteger('HOST_GRACE_MS', process.env.HOST_GRACE_MS ?? '120000', {
    min: 50,
    max: 3_600_000,
  }),
  // How long an approval request stays open (default 2 minutes).
  requestTtlMs: parseInteger('REQUEST_TTL_MS', process.env.REQUEST_TTL_MS ?? '120000', {
    min: 50,
    max: 3_600_000,
  }),
  authRateLimitMax: parseInteger('AUTH_RATE_LIMIT_MAX', process.env.AUTH_RATE_LIMIT_MAX ?? '30', {
    min: 1,
    max: 100000,
  }),
  // Comma-separated list, e.g. "http://localhost:5173,https://my-app.vercel.app"
  clientOrigins: (process.env.CLIENT_ORIGIN ?? 'http://localhost:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
});
