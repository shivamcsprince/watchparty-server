import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { config } from '../config/env.js';
import { requireAuth } from '../auth/authMiddleware.js';
import { roomCodeSchema } from './roomCode.js';

export function createRoomRouter(roomService) {
  const router = Router();

  const createLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: config.roomCreateRateLimitMax,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many rooms created, please try again later' },
  });

  router.post('/', requireAuth, createLimiter, async (req, res) => {
    const room = await roomService.createRoom(req.auth.userId);
    res.status(201).json({ room });
  });

  router.get('/:code', requireAuth, async (req, res) => {
    const code = roomCodeSchema.parse(req.params.code);
    res.json({ room: await roomService.getRoomInfo(code) });
  });

  return router;
}
