import { ChatLog } from './ChatLog.js';
import { PlaybackState } from './PlaybackState.js';
import { RequestQueue, serializeRequest } from './RequestQueue.js';
import { ACTIONS, RolePolicy } from './RolePolicy.js';
import { ROLES } from './roles.js';

export function roomChannel(code) {
  return `room:${code}`;
}

// When the host is gone, the next host is the longest-present moderator, then participant, then viewer.
const SUCCESSOR_RANK = { [ROLES.MODERATOR]: 0, [ROLES.PARTICIPANT]: 1, [ROLES.VIEWER]: 2 };

/**
 * An active watch room: who is connected, what is playing, which requests are pending,
 * and how to talk to the people in it.
 * It knows nothing about Socket.IO directly; it uses an injected "broadcaster".
 * That keeps the class easy to test and the rules separate from the transport.
 */
export class Room {
  #participants = new Map(); // userId -> Participant (insertion order = join order)
  #broadcaster;
  #capacity;
  #requests;

  constructor(
    { id, code, hostUserId, videoId = null, createdAt },
    { broadcaster, capacity, requestTtlMs = 120_000 },
  ) {
    this.id = id;
    this.code = code;
    this.hostUserId = hostUserId;
    this.playback = new PlaybackState({ videoId });
    this.chat = new ChatLog();
    this.createdAt = createdAt;
    this.#broadcaster = broadcaster;
    this.#capacity = capacity;
    this.#requests = new RequestQueue({
      ttlMs: requestTtlMs,
      onExpire: (request) => this.announceRequestResolved(request, 'expired'),
    });
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

  get requests() {
    return this.#requests;
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

  hostPresent() {
    return this.#participants.has(this.hostUserId);
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

  setRole(userId, role) {
    const participant = this.#participants.get(userId);
    if (!participant) return null;
    participant.role = role;
    return participant;
  }

  /** Makes this user the room's host (identity and role). */
  setHost(userId) {
    this.hostUserId = userId;
    return this.setRole(userId, ROLES.HOST);
  }

  /** The best person to take over as host, or null if nobody else is here. */
  pickSuccessor() {
    const candidates = [...this.#participants.values()].filter((p) => p.userId !== this.hostUserId);
    candidates.sort(
      (a, b) => SUCCESSOR_RANK[a.role] - SUCCESSOR_RANK[b.role] || a.joinedAt - b.joinedAt,
    );
    return candidates[0] ?? null;
  }

  listParticipants() {
    return [...this.#participants.values()].map((participant) => participant.toJSON());
  }

  // ---- talking to people ---------------------------------------------------

  broadcast(event, payload, { exceptSocketId } = {}) {
    this.#broadcaster.emitToRoom(this.channel, event, payload, exceptSocketId);
  }

  /** Sends an event only to the participants for whom `predicate(participant)` is true. */
  emitToParticipants(predicate, event, payload) {
    for (const participant of this.#participants.values()) {
      if (predicate(participant))
        this.#broadcaster.emitToSocket(participant.socketId, event, payload);
    }
  }

  // ---- playback ------------------------------------------------------------

  /**
   * Applies a playback action and tells the whole room.
   * `by` is who the change is attributed to; `approvedBy` is set when a request was approved.
   */
  applyPlayback(action, params, { by, approvedBy } = {}) {
    switch (action) {
      case 'play':
        this.playback.play();
        break;
      case 'pause':
        this.playback.pause();
        break;
      case 'seek':
        this.playback.seek(params.time);
        break;
      case 'change_video':
        this.playback.changeVideo(params.videoId);
        break;
      default:
        throw new Error(`Unknown playback action: ${action}`);
    }

    const snapshot = this.playback.snapshot();
    this.broadcast('sync_state', { ...snapshot, action, by, ...(approvedBy && { approvedBy }) });
    return snapshot;
  }

  // ---- approval requests ---------------------------------------------------

  /** Requests are only shown to the people who can resolve them, and to whoever made them. */
  notifyRequestAudience(request, event, payload) {
    this.emitToParticipants(
      (p) =>
        p.userId === request.requestedBy.userId || RolePolicy.can(p.role, ACTIONS.RESOLVE_REQUEST),
      event,
      payload,
    );
  }

  announceRequestResolved(request, status, extra = {}) {
    this.notifyRequestAudience(request, 'request_resolved', {
      requestId: request.id,
      status,
      request: serializeRequest(request),
      ...extra,
    });
  }

  /** Drops a person's pending requests (they left, were removed, or no longer need approval). */
  cancelRequestsFor(userId) {
    for (const request of this.#requests.cancelForUser(userId)) {
      this.announceRequestResolved(request, 'cancelled');
    }
  }

  listRequestsFor(participant) {
    const canSeeAll = RolePolicy.can(participant.role, ACTIONS.RESOLVE_REQUEST);
    return this.#requests
      .list()
      .filter((request) => canSeeAll || request.requestedBy.userId === participant.userId)
      .map(serializeRequest);
  }

  /** Called when the room is no longer in use: stops all timers. */
  dispose() {
    this.#requests.clear();
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
