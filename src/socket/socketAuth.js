import { verifyToken } from '../auth/tokens.js';

/**
 * Socket.IO middleware that runs once per connection attempt.
 * The client must connect with: io(url, { auth: { token } })
 * The identity (userId, username) comes from the verified token, never from
 * anything the client sends later, so it cannot be spoofed.
 */
export function authenticateSocket(socket, next) {
  const token = socket.handshake.auth?.token;
  if (typeof token !== 'string' || token === '') {
    return next(new Error('Authentication required'));
  }
  try {
    socket.data.user = verifyToken(token); // { userId, username }
    next();
  } catch {
    next(new Error('Invalid or expired token'));
  }
}
