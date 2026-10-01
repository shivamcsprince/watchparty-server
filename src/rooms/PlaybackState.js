import { AppError } from '../utils/AppError.js';

const round3 = (n) => Math.round(n * 1000) / 1000;

/**
 * The single source of truth for what the room is watching.
 *
 * We do NOT store "the current time" (it would be stale a moment later).
 * Instead we store the position at the moment of the last change plus when that
 * happened. While playing, the current position is computed:
 *     position + (now - updatedAt)
 * so a late joiner, or a client checking for drift, always gets the right answer.
 */
export class PlaybackState {
  #videoId;
  #playState = 'paused';
  #position = 0; // seconds, at the moment of #updatedAt
  #updatedAt;
  #clock;

  constructor({ videoId = null, clock = Date.now } = {}) {
    this.#videoId = videoId;
    this.#clock = clock;
    this.#updatedAt = clock();
  }

  get videoId() {
    return this.#videoId;
  }

  get playState() {
    return this.#playState;
  }

  #positionAt(now) {
    if (this.#playState !== 'playing') return this.#position;
    return this.#position + Math.max(0, now - this.#updatedAt) / 1000;
  }

  #requireVideo() {
    if (!this.#videoId) throw new AppError(409, 'No video is loaded', undefined, 'NO_VIDEO');
  }

  play() {
    this.#requireVideo();
    if (this.#playState === 'playing') return; // already playing: keep the existing timeline
    this.#playState = 'playing';
    this.#updatedAt = this.#clock();
  }

  pause() {
    this.#requireVideo();
    if (this.#playState === 'paused') return;
    const now = this.#clock();
    this.#position = this.#positionAt(now);
    this.#playState = 'paused';
    this.#updatedAt = now;
  }

  /** Jumps to `seconds`, keeping the current play/pause state. */
  seek(seconds) {
    this.#requireVideo();
    this.#position = seconds;
    this.#updatedAt = this.#clock();
  }

  /** A new video always starts paused at 0:00. */
  changeVideo(videoId) {
    this.#videoId = videoId;
    this.#playState = 'paused';
    this.#position = 0;
    this.#updatedAt = this.#clock();
  }

  /** `serverTime` lets clients work out how old this snapshot is. */
  snapshot() {
    const now = this.#clock();
    return {
      videoId: this.#videoId,
      playState: this.#playState,
      currentTime: round3(this.#positionAt(now)),
      serverTime: now,
    };
  }
}
