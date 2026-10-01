import { PlaybackState } from './PlaybackState.js';
import { ROLES } from './roles.js';

export function roomChannel(code) {
  return `room:${code}`;
}

/**
 * An active watch room: who is connected, and how to talk to them.
 * It knows nothing about Socket.IO directly; it uses an injected "broadcaster".
 * That keeps the class easy to test and the rules separate from the transport.
 */
export class Room {
  #participants = new Map(); // userId -> Participant (insertion order = join order)
  #broadcaster;
  #capacity;

  constructor({ id, code, hostUserId, videoId = null, createdAt }, { broadcaster, capacity }) {
    this.id = id;
    this.code = code;
    this.hostUserId = hostUserId;
    this.playback = new PlaybackState({ videoId });
    this.createdAt = createdAt;
    this.#broadcaster = broadcaster;
    this.#capacity = capacity;
  }

  get videoId() {
    return this.playback.videoId;
  }

  get channel() {
    return roomChannel(this.code);
  }

  get size() {
    return this.#participants.size;
  }

  get capacity() {
    return this.#capacity;
  }

  isFull() {
    return this.size >= this.#capacity;
  }

  isEmpty() {
    return this.size === 0;
  }

  /** The room's host identity is stored in the database; everyone else starts as a participant. */
  roleForUser(userId) {
    return userId === this.hostUserId ? ROLES.HOST : ROLES.PARTICIPANT;
  }

  getParticipant(userId) {
    return this.#participants.get(userId) ?? null;
  }

  /** Adds or replaces a participant. Returns the previous entry if one was replaced. */
  addParticipant(participant) {
    const previous = this.#participants.get(participant.userId) ?? null;
    this.#participants.set(participant.userId, participant);
    return previous;
  }

  /**
   * Removes a participant, but ONLY if the given socket is still the one registered.
   * This stops a stale, replaced connection from removing its own replacement.
   */
  removeParticipant(userId, socketId) {
    const current = this.#participants.get(userId);
    if (!current || current.socketId !== socketId) return null;
    this.#participants.delete(userId);
    return current;
  }

  listParticipants() {
    return [...this.#participants.values()].map((participant) => participant.toJSON());
  }

  broadcast(event, payload, { exceptSocketId } = {}) {
    this.#broadcaster.emitToRoom(this.channel, event, payload, exceptSocketId);
  }

  toJSON() {
    return {
      id: this.id,
      code: this.code,
      hostUserId: this.hostUserId,
      videoId: this.videoId,
      capacity: this.#capacity,
    };
  }
}
