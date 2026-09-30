import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { config } from '../config/env.js';
import { requireAuth } from './authMiddleware.js';
import { loginSchema, registerSchema } from './validation.js';

export function createAuthRouter(authService) {
  const router = Router();

  // Slows down password guessing and account spam (per IP address).
  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: config.authRateLimitMax,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many attempts, please try again later' },
  });

  router.post('/register', limiter, async (req, res) => {
    const input = registerSchema.parse(req.body);
    res.status(201).json(await authService.register(input));
  });

  router.post('/login', limiter, async (req, res) => {
    const input = loginSchema.parse(req.body);
    res.json(await authService.login(input));
  });

  router.get('/me', requireAuth, async (req, res) => {
    res.json({ user: await authService.getProfile(req.auth.userId) });
  });

  return router;
}
