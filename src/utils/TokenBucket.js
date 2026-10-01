/**
 * Simple rate limiter: holds up to `capacity` tokens and refills continuously.
 * Each action costs one token; when empty, actions are refused until it refills.
 * Used per socket connection so one client cannot flood a room with events.
 */
export class TokenBucket {
  #capacity;
  #refillPerSecond;
  #tokens;
  #lastRefill;
  #clock;

  constructor({ capacity, refillPerSecond, clock = Date.now }) {
    this.#capacity = capacity;
    this.#refillPerSecond = refillPerSecond;
    this.#clock = clock;
    this.#tokens = capacity;
    this.#lastRefill = clock();
  }

  tryConsume() {
    const now = this.#clock();
    const elapsedSeconds = Math.max(0, now - this.#lastRefill) / 1000;
    this.#tokens = Math.min(this.#capacity, this.#tokens + elapsedSeconds * this.#refillPerSecond);
    this.#lastRefill = now;

    if (this.#tokens < 1) return false;
    this.#tokens -= 1;
    return true;
  }
}
