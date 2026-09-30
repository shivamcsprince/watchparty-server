import { AppError } from '../utils/AppError.js';
import { verifyToken } from './tokens.js';

/** Express middleware: requires "Authorization: Bearer <token>". */
export function requireAuth(req, res, next) {
  const header = req.headers.authorization ?? '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return next(new AppError(401, 'Authentication required'));
  }

  try {
    req.auth = verifyToken(token); // { userId, username }
    next();
  } catch {
    next(new AppError(401, 'Invalid or expired token'));
  }
}
