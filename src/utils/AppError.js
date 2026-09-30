/**
 * An error we expect and want to show to the client
 * (as opposed to a bug, which becomes a generic 500).
 */
export class AppError extends Error {
  constructor(status, message, details) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.details = details;
  }
}
