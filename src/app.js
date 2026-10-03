import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { config } from './config/env.js';
import { ZodError } from 'zod';
import { checkDatabase } from './db/pool.js';
import { UserRepository } from './repositories/UserRepository.js';
import { AuthService } from './auth/AuthService.js';
import { createAuthRouter } from './auth/authRoutes.js';
import { AppError } from './utils/AppError.js';
import { RoomRepository } from './repositories/RoomRepository.js';
import { RoomManager } from './rooms/RoomManager.js';
import { RoomService } from './rooms/RoomService.js';
import { createRoomRouter } from './rooms/roomRoutes.js';
import { Broadcaster } from './socket/Broadcaster.js';

export function createApp({ roomManager } = {}) {
  const roomRepository = new RoomRepository();
  // REST-only usage (e.g. auth tests) gets a manager with a silent broadcaster.
  roomManager ??= new RoomManager({
    roomRepository,
    broadcaster: new Broadcaster(),
    capacity: config.roomCapacity,
    hostGraceMs: config.hostGraceMs,
    requestTtlMs: config.requestTtlMs,
  });

  const app = express();

  app.set('trust proxy', config.trustProxy);

  // Helmet's default Cross-Origin-Resource-Policy (same-origin) blocks the
  // CORS preflight from Vercel. Relax it to cross-origin so our API is
  // reachable from the deployed client, and disable policies that aren't
  // meaningful for a JSON API.
  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      crossOriginOpenerPolicy: false,
      contentSecurityPolicy: false,
    }),
  );

  const corsOptions = {
    origin(origin, callback) {
      // No Origin header = curl, Postman, health probes, server-to-server.
      if (!origin) return callback(null, true);
      if (config.clientOrigins.includes(origin)) return callback(null, true);
      // Not allowed: resolve without an error so we don't turn this into a
      // 500 in the error handler. The browser will see the missing
      // Access-Control-Allow-Origin header and block the request itself.
      return callback(null, false);
    },
    credentials: false,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    optionsSuccessStatus: 204,
  };

  app.use(cors(corsOptions));

  // Express 5 does not route OPTIONS through the middleware stack the way
  // Express 4 did, so we answer preflights explicitly here.
  // app.options(/.*/, cors(corsOptions));

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

  // Dependencies are created here and passed down (simple dependency injection).
  const authService = new AuthService(new UserRepository());
  app.use('/api/auth', createAuthRouter(authService));
  app.use('/api/rooms', createRoomRouter(new RoomService({ roomRepository, roomManager })));

  app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // Central error handler (Express 5 forwards errors from async handlers here).
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof ZodError) {
      const details = err.issues.map((issue) => ({
        field: issue.path.join('.'),
        message: issue.message,
      }));
      return res.status(400).json({ error: 'Validation failed', details });
    }
    if (err instanceof AppError) {
      return res.status(err.status).json({ error: err.message, details: err.details });
    }
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'Request body is not valid JSON' });
    }
    if (err.type === 'entity.too.large') {
      return res.status(413).json({ error: 'Request body too large' });
    }
    console.error('[error]', err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}