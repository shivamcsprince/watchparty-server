import { randomUUID } from 'node:crypto';
import { AppError } from '../utils/AppError.js';

/** The shape clients see. */
export function serializeRequest(request) {
  return {
    id: request.id,
    action: request.action,
    params: request.params,
    requestedBy: request.requestedBy,
    createdAt: new Date(request.createdAt).toISOString(),
    expiresAt: new Date(request.expiresAt).toISOString(),
  };
}

/**
 * Pending approval requests for one room. Each request expires on its own timer
 * and the queue limits how many one person can have open at once.
 */
export class RequestQueue {
  #requests = new Map(); // id -> request
  #timers = new Map(); // id -> timeout handle
  #ttlMs;
  #maxPerUser;
  #onExpire;
  #clock;

  constructor({ ttlMs, maxPerUser = 3, onExpire = () => {}, clock = Date.now }) {
    this.#ttlMs = ttlMs;
    this.#maxPerUser = maxPerUser;
    this.#onExpire = onExpire;
    this.#clock = clock;
  }

  get size() {
    return this.#requests.size;
  }

  add({ action, params, requestedBy }) {
    const open = this.list().filter((r) => r.requestedBy.userId === requestedBy.userId).length;
    if (open >= this.#maxPerUser) {
      throw new AppError(
        429,
        `You already have ${this.#maxPerUser} pending requests`,
        undefined,
        'TOO_MANY_REQUESTS',
      );
    }

    const createdAt = this.#clock();
    const request = {
      id: randomUUID(),
      action,
      params,
      requestedBy,
      createdAt,
      expiresAt: createdAt + this.#ttlMs,
    };
    this.#requests.set(request.id, request);

    // unref(): a pending request must never keep the server process alive on shutdown.
    const timer = setTimeout(() => {
      if (this.take(request.id)) this.#onExpire(request);
    }, this.#ttlMs);
    timer.unref();
    this.#timers.set(request.id, timer);

    return request;
  }

  /** Removes and returns a request (null if it is already gone). This is what makes "first decision wins". */
  take(id) {
    const request = this.#requests.get(id);
    if (!request) return null;
    this.#requests.delete(id);
    clearTimeout(this.#timers.get(id));
    this.#timers.delete(id);
    return request;
  }

  cancelForUser(userId) {
    return this.list()
      .filter((request) => request.requestedBy.userId === userId)
      .map((request) => this.take(request.id));
  }

  list() {
    return [...this.#requests.values()];
  }

  clear() {
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
    this.#requests.clear();
  }
}
