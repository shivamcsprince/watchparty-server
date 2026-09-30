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
  // Comma-separated list, e.g. "http://localhost:5173,https://my-app.vercel.app"
  clientOrigins: (process.env.CLIENT_ORIGIN ?? 'http://localhost:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
});
