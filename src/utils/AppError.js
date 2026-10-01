/**
 * An error we expect and want to show to the client
 * (as opposed to a bug, which becomes a generic 500).
 * `code` is a stable machine-readable string (e.g. "ROOM_FULL") for the frontend.
 */
export class AppError extends Error {
  constructor(status, message, details, code) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.details = details;
    this.code = code;
  }
}
