import { pool } from '../db/pool.js';

/** Converts a database row (snake_case) into the object the app uses. */
function toUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    username: row.username,
    passwordHash: row.password_hash,
    createdAt: row.created_at,
  };
}

/** The only place that talks SQL about users. */
export class UserRepository {
  constructor(db = pool) {
    this.db = db;
  }

  /**
   * Inserts a user. Throws an error with `.field` set to "email" or
   * "username" if that value is already taken.
   */
  async create({ email, username, passwordHash }) {
    try {
      const { rows } = await this.db.query(
        `INSERT INTO users (email, username, password_hash)
         VALUES ($1, $2, $3)
         RETURNING *`,
        [email, username, passwordHash],
      );
      return toUser(rows[0]);
    } catch (err) {
      if (err.code === '23505') {
        const duplicate = new Error('Duplicate user field');
        duplicate.field = err.constraint === 'users_email_unique' ? 'email' : 'username';
        throw duplicate;
      }
      throw err;
    }
  }

  async findByEmail(email) {
    const { rows } = await this.db.query('SELECT * FROM users WHERE lower(email) = lower($1)', [
      email,
    ]);
    return toUser(rows[0]);
  }

  async findById(id) {
    const { rows } = await this.db.query('SELECT * FROM users WHERE id = $1', [id]);
    return toUser(rows[0]);
  }
}
