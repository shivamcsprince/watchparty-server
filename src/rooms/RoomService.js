import { AppError } from '../utils/AppError.js';
import { generateRoomCode } from './roomCode.js';

const MAX_CODE_ATTEMPTS = 5;

/** Room operations used by the REST API. */
export class RoomService {
  constructor({ roomRepository, roomManager }) {
    this.rooms = roomRepository;
    this.manager = roomManager;
  }

  /** Creates a room; the creator becomes its host. */
  async createRoom(hostUserId) {
    for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt += 1) {
      try {
        return await this.rooms.create({ code: generateRoomCode(), hostUserId });
      } catch (err) {
        if (err.codeTaken) continue; // astronomically unlikely, but handled: try a new code
        if (err.code === '23503') throw new AppError(401, 'Account no longer exists');
        throw err;
      }
    }
    throw new Error('Could not generate a unique room code');
  }

  async getRoomInfo(code) {
    const room = await this.manager.getRoom(code);
    if (!room) throw new AppError(404, 'Room not found', undefined, 'ROOM_NOT_FOUND');
    return {
      code: room.code,
      participantCount: room.size,
      capacity: room.capacity,
    };
  }
}
