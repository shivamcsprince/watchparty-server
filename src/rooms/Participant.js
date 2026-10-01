/** One connected person inside a room. */
export class Participant {
  constructor({ userId, username, role, socketId }) {
    this.userId = userId;
    this.username = username;
    this.role = role;
    this.socketId = socketId;
    this.joinedAt = new Date();
  }

  /** What other clients are allowed to see (never the socket id). */
  toJSON() {
    return { userId: this.userId, username: this.username, role: this.role };
  }
}
