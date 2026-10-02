/** The most recent chat messages of a room, kept in memory (oldest are dropped first). */
export class ChatLog {
  #messages = [];
  #limit;

  constructor({ limit = 50 } = {}) {
    this.#limit = limit;
  }

  get size() {
    return this.#messages.length;
  }

  add(message) {
    this.#messages.push(message);
    if (this.#messages.length > this.#limit) this.#messages.shift();
    return message;
  }

  /** Oldest first. A copy, so callers cannot change the log. */
  recent() {
    return [...this.#messages];
  }
}
