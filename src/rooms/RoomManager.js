import { AppError } from '../utils/AppError.js';
import { Participant } from './Participant.js';
import { Room } from './Room.js';

/**
 * Keeps the active rooms in memory and loads them from the database on demand.
 * A room is "active" while at least one person is connected to it.
 * It also owns the host-succession rules, because they depend on timers and on people
 * joining and leaving.
 */
export class RoomManager {
  #rooms = new Map(); // code -> Room
  #loading = new Map(); // code -> Promise<Room | null> (avoids loading the same room twice)
  #hostTimers = new Map(); // code -> timeout handle (counts down while the host is absent)
  #roomRepository;
  #broadcaster;
  #capacity;
  #hostGraceMs;
  #requestTtlMs;

  constructor({
    roomRepository,
    broadcaster,
    capacity,
    hostGraceMs = 120_000,
    requestTtlMs = 120_000,
  }) {
    this.#roomRepository = roomRepository;
    this.#broadcaster = broadcaster;
    this.#capacity = capacity;
    this.#hostGraceMs = hostGraceMs;
    this.#requestTtlMs = requestTtlMs;
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
    const room = new Room(record, {
      broadcaster: this.#broadcaster,
      capacity: this.#capacity,
      requestTtlMs: this.#requestTtlMs,
    });
    this.#rooms.set(code, room);
    return room;
  }

  /**
   * Adds a user to a room. Returns { room, participant, replaced }.
   * `replaced` is the previous entry if the same user was already connected
   * (e.g. a second browser tab); that entry keeps its role and its seniority.
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
      joinedAt: existing ? existing.joinedAt : new Date(),
    });
    const replaced = room.addParticipant(participant);

    this.#syncHostTimer(room);
    return { room, participant, replaced };
  }

  /**
   * Removes a participant and tells the room. Returns { room, participant } or null if nothing was removed.
   * `explicit` is true when the person chose to leave (the Leave button). If that is the host,
   * someone takes over immediately. A dropped connection instead starts the grace period.
   */
  leave({ code, userId, socketId, explicit = false }) {
    const room = this.#rooms.get(code);
    if (!room) return null;

    const participant = room.removeParticipant(userId, socketId);
    if (!participant) return null;

    room.cancelRequestsFor(userId);
    room.broadcast('user_left', {
      username: participant.username,
      userId: participant.userId,
      participants: room.listParticipants(),
    });

    if (room.isEmpty()) {
      this.#dropRoom(room);
    } else if (explicit && userId === room.hostUserId) {
      this.#promoteSuccessor(room, 'host_left');
    } else {
      this.#syncHostTimer(room);
    }
    return { room, participant };
  }

  /** Applies a playback action to a room and saves the video if it changed. */
  applyPlayback(room, action, params, meta) {
    const snapshot = room.applyPlayback(action, params, meta);
    if (action === 'change_video') this.persistVideoId(room);
    return snapshot;
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

  // ---- host succession -----------------------------------------------------

  #dropRoom(room) {
    this.#clearHostTimer(room.code);
    room.dispose();
    this.#rooms.delete(room.code);
  }

  #clearHostTimer(code) {
    clearTimeout(this.#hostTimers.get(code));
    this.#hostTimers.delete(code);
  }

  /**
   * Keeps the "host is absent" countdown correct: running while people are in the room
   * but the host is not, stopped otherwise. If the host comes back in time, they simply
   * stay host (the database still names them).
   */
  #syncHostTimer(room) {
    if (room.isEmpty() || room.hostPresent()) {
      this.#clearHostTimer(room.code);
      return;
    }
    if (this.#hostTimers.has(room.code)) return;

    const timer = setTimeout(() => {
      this.#hostTimers.delete(room.code);
      const active = this.#rooms.get(room.code);
      if (active && !active.isEmpty() && !active.hostPresent()) {
        this.#promoteSuccessor(active, 'host_timeout');
      }
    }, this.#hostGraceMs);
    timer.unref(); // never keep the process alive just for this
    this.#hostTimers.set(room.code, timer);
  }

  #promoteSuccessor(room, reason) {
    this.#clearHostTimer(room.code);
    const successor = room.pickSuccessor();
    if (!successor) return;

    room.setHost(successor.userId);
    room.cancelRequestsFor(successor.userId); // a host does not need approval
    this.#roomRepository
      .updateHostUserId(room.id, successor.userId)
      .catch((err) => console.error(`[rooms] Could not save host for ${room.code}:`, err.message));

    room.broadcast('role_assigned', {
      userId: successor.userId,
      username: successor.username,
      role: successor.role,
      participants: room.listParticipants(),
      reason,
    });
  }
}
