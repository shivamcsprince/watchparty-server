import jwt from 'jsonwebtoken';
import { config } from '../config/env.js';

const ALGORITHM = 'HS256';

/** Creates a signed token. `sub` (subject) is the user id. */
export function signToken(user) {
  return jwt.sign({ username: user.username }, config.jwtSecret, {
    algorithm: ALGORITHM,
    subject: user.id,
    expiresIn: config.jwtExpiresIn,
  });
}

/**
 * Verifies signature and expiry. Returns { userId, username }.
 * Throws if the token is invalid or expired.
 * We pin the algorithm so a forged token cannot choose its own (e.g. "none").
 */
export function verifyToken(token) {
  const payload = jwt.verify(token, config.jwtSecret, { algorithms: [ALGORITHM] });
  return { userId: payload.sub, username: payload.username };
}
