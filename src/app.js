import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { config } from './config/env.js';
import { checkDatabase } from './db/pool.js';

export function createApp() {
  const app = express();

  app.use(helmet());
  app.use(cors({ origin: config.clientOrigins }));
  app.use(express.json({ limit: '10kb' }));

  // Liveness check. Deliberately does NOT touch the database:
  // hosting platforms ping this regularly, and querying Neon every time
  // would stop it from ever suspending and waste free compute hours.
  app.get('/health', (req, res) => {
    res.json({ status: 'ok', uptimeSeconds: Math.round(process.uptime()) });
  });

  // Manual check that the database is reachable.
  app.get('/health/db', async (req, res) => {
    try {
      await checkDatabase();
      res.json({ status: 'ok', database: 'up' });
    } catch (err) {
      console.error('[health] Database check failed:', err.message);
      res.status(503).json({ status: 'error', database: 'down' });
    }
  });

  app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // Central error handler (Express 5 forwards errors from async handlers here).
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error('[error]', err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}
