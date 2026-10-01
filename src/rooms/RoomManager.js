import { AppError } from '../utils/AppError.js';
import { Participant } from './Participant.js';
import { Room } from './Room.js';

/**
 * Keeps the active rooms in memory and loads them from the database on demand.
 * A room is "active" while at least one person is connected to it.
 */
export class RoomManager {
  #rooms = new Map(); // code -> Room
  #loading = new Map(); // code -> Promise<Room | null> (avoids loading the same room twice)
  #roomRepository;
  #broadcaster;
  #capacity;

  constructor({ roomRepository, broadcaster, capacity }) {
    this.#roomRepository = roomRepository;
    this.#broadcaster = broadcaster;
    this.#capacity = capacity;
  }

  get capacity() {
    return this.#capacity;
  }

  get activeRoomCount() {
    return this.#rooms.size;
  }

  getActiveRoom(code) {
    return this.#rooms.get(code) ?? null;
  }

  /** Returns the active Room, loading it from the database if needed. Null if it doesn't exist. */
  async getRoom(code) {
    const active = this.#rooms.get(code);
    if (active) return active;

    let pending = this.#loading.get(code);
    if (!pending) {
      pending = this.#load(code).finally(() => this.#loading.delete(code));
      this.#loading.set(code, pending);
    }
    return pending;
  }

  async #load(code) {
    const record = await this.#roomRepository.findByCode(code);
    if (!record) return null;
    const room = new Room(record, { broadcaster: this.#broadcaster, capacity: this.#capacity });
    this.#rooms.set(code, room);
    return room;
  }

  /**
   * Adds a user to a room. Returns { room, participant, replaced }.
   * `replaced` is the previous entry if the same user was already connected
   * (e.g. a second browser tab); that entry keeps its role.
   */
  async join({ code, user, socketId }) {
    let room = await this.getRoom(code);
    if (!room) throw new AppError(404, 'Room not found', undefined, 'ROOM_NOT_FOUND');

    // The room may have been dropped from memory while we were awaiting. Re-register it
    // synchronously so two Room objects for the same code can never exist.
    const current = this.#rooms.get(code);
    if (current) room = current;
    else this.#rooms.set(code, room);

    const existing = room.getParticipant(user.userId);
    if (!existing && room.isFull()) {
      throw new AppError(409, 'Room is full', undefined, 'ROOM_FULL');
    }

    const participant = new Participant({
      userId: user.userId,
      username: user.username,
      role: existing ? existing.role : room.roleForUser(user.userId),
      socketId,
    });
    const replaced = room.addParticipant(participant);
    return { room, participant, replaced };
  }

  /**
   * Saves the room's current video so it survives a server restart.
   * Runs in the background: a database hiccup must not block or fail playback for everyone.
   */
  persistVideoId(room) {
    return this.#roomRepository
      .updateVideoId(room.id, room.videoId)
      .catch((err) => console.error(`[rooms] Could not save video for ${room.code}:`, err.message));
  }

  /** Removes a participant. Returns { room, participant } or null if nothing was removed. */
  leave({ code, userId, socketId }) {
    const room = this.#rooms.get(code);
    if (!room) return null;

    const participant = room.removeParticipant(userId, socketId);
    if (!participant) return null;

    if (room.isEmpty()) this.#rooms.delete(code);
    return { room, participant };
  }
}
