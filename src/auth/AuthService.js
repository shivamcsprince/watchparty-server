import bcrypt from 'bcryptjs';
import { config } from '../config/env.js';
import { AppError } from '../utils/AppError.js';
import { signToken } from './tokens.js';

// A valid hash of a random string. Used so that logging in with an unknown
// email takes the same time as a wrong password (prevents email enumeration
// by measuring response times).
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', config.bcryptRounds);

/** Never send the password hash to clients. */
function toPublicUser(user) {
  return { id: user.id, email: user.email, username: user.username, createdAt: user.createdAt };
}

export class AuthService {
  constructor(userRepository) {
    this.users = userRepository;
  }

  async register({ email, username, password }) {
    const passwordHash = await bcrypt.hash(password, config.bcryptRounds);

    let user;
    try {
      user = await this.users.create({ email, username, passwordHash });
    } catch (err) {
      if (err.field) {
        throw new AppError(409, `That ${err.field} is already taken`, { field: err.field });
      }
      throw err;
    }
    return { user: toPublicUser(user), token: signToken(user) };
  }

  async login({ email, password }) {
    const user = await this.users.findByEmail(email);
    const matches = await bcrypt.compare(password, user ? user.passwordHash : DUMMY_HASH);

    // Same message for "no such user" and "wrong password" on purpose.
    if (!user || !matches) throw new AppError(401, 'Invalid email or password');

    return { user: toPublicUser(user), token: signToken(user) };
  }

  async getProfile(userId) {
    const user = await this.users.findById(userId);
    if (!user) throw new AppError(401, 'Account no longer exists');
    return toPublicUser(user);
  }
}
