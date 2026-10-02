import { ZodError } from 'zod';
import { AppError } from '../utils/AppError.js';

export function toErrorResponse(err) {
  if (err instanceof ZodError) {
    return { ok: false, error: 'Invalid request', code: 'INVALID_REQUEST' };
  }
  if (err instanceof AppError) {
    return { ok: false, error: err.message, code: err.code ?? 'ERROR' };
  }
  console.error('[socket] Unexpected error:', err);
  return { ok: false, error: 'Something went wrong', code: 'INTERNAL_ERROR' };
}

/**
 * Wraps a socket event handler so that:
 *  - the client always gets an acknowledgement: { ok: true, ... } or { ok: false, error, code }
 *  - a connection that sends too many events is told to slow down
 *  - an error inside a handler can never crash the server
 */
export function withAck(handler, { limiter } = {}) {
  return async (payload, callback) => {
    const reply = typeof callback === 'function' ? callback : () => {};

    // `limiter` may be one limiter or a list (e.g. the connection-wide one plus a stricter one for chat).
    const limiters = [limiter].flat().filter(Boolean);
    for (const bucket of limiters) {
      if (!bucket.tryConsume()) {
        return reply({ ok: false, error: 'Too many requests, slow down', code: 'RATE_LIMITED' });
      }
    }

    try {
      reply({ ok: true, ...(await handler(payload)) });
    } catch (err) {
      reply(toErrorResponse(err));
    }
  };
}
