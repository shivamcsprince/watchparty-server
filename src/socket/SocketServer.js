import { Server } from 'socket.io';
import { config } from '../config/env.js';

/**
 * Wraps the Socket.IO server. In later phases this class will register the
 * auth middleware and the feature handlers (rooms, playback, roles, chat).
 */
export class SocketServer {
  constructor(httpServer) {
    this.io = new Server(httpServer, {
      cors: { origin: config.clientOrigins, methods: ['GET', 'POST'] },
    });
    this.#registerConnectionHandler();
  }

  #registerConnectionHandler() {
    this.io.on('connection', (socket) => {
      console.log(`[socket] connected: ${socket.id}`);

      // Phase 1 smoke test: the client sends "ping_check" and gets "pong" back.
      socket.on('ping_check', (callback) => {
        if (typeof callback === 'function') callback('pong');
      });

      socket.on('disconnect', (reason) => {
        console.log(`[socket] disconnected: ${socket.id} (${reason})`);
      });
    });
  }

  /** Closes all connections and the underlying HTTP server. */
  close() {
    return this.io.close();
  }
}
