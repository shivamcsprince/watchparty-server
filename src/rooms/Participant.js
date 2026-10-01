/** One connected person inside a room. */
export class Participant {
  constructor({ userId, username, role, socketId, joinedAt = new Date() }) {
    this.userId = userId;
    this.username = username;
    this.role = role;
    this.socketId = socketId;
    this.joinedAt = joinedAt;
  }

  /** What other clients are allowed to see (never the socket id). */
  toJSON() {
    return { userId: this.userId, username: this.username, role: this.role };
  }
}
