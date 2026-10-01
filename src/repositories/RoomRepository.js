import { pool } from '../db/pool.js';

function toRoom(row) {
  if (!row) return null;
  return {
    id: row.id,
    code: row.code,
    hostUserId: row.host_user_id,
    videoId: row.video_id,
    createdAt: row.created_at,
  };
}

/** The only place that talks SQL about rooms. */
export class RoomRepository {
  constructor(db = pool) {
    this.db = db;
  }

  /** Throws an error with `.codeTaken = true` if the room code already exists. */
  async create({ code, hostUserId }) {
    try {
      const { rows } = await this.db.query(
        'INSERT INTO rooms (code, host_user_id) VALUES ($1, $2) RETURNING *',
        [code, hostUserId],
      );
      return toRoom(rows[0]);
    } catch (err) {
      if (err.code === '23505') {
        throw Object.assign(new Error('Room code already exists'), { codeTaken: true });
      }
      throw err;
    }
  }

  async updateVideoId(id, videoId) {
    await this.db.query('UPDATE rooms SET video_id = $2 WHERE id = $1', [id, videoId]);
  }

  async updateHostUserId(id, hostUserId) {
    await this.db.query('UPDATE rooms SET host_user_id = $2 WHERE id = $1', [id, hostUserId]);
  }

  async findByCode(code) {
    const { rows } = await this.db.query('SELECT * FROM rooms WHERE code = $1', [code]);
    return toRoom(rows[0]);
  }
}
