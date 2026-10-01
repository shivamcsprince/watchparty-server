/**
 * Lets domain classes (Room) send events without importing Socket.IO.
 * It is created first and bound to the Socket.IO server afterwards, which avoids
 * a circular dependency (Socket.IO needs the HTTP server, which needs the app,
 * which needs the RoomManager, which needs a broadcaster).
 * Before binding (e.g. in REST-only tests) it does nothing.
 */
export class Broadcaster {
  #io = null;

  bind(io) {
    this.#io = io;
  }

  emitToRoom(channel, event, payload, exceptSocketId) {
    if (!this.#io) return;
    let target = this.#io.to(channel);
    if (exceptSocketId) target = target.except(exceptSocketId);
    target.emit(event, payload);
  }

  /** Every socket automatically sits in a private room named after its own id. */
  emitToSocket(socketId, event, payload) {
    if (!this.#io) return;
    this.#io.to(socketId).emit(event, payload);
  }
}
