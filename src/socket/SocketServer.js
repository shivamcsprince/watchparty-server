import { Server } from 'socket.io';
import { config } from '../config/env.js';
import { authenticateSocket } from './socketAuth.js';
import { RoomHandler } from './RoomHandler.js';

/**
 * Wraps the Socket.IO server: CORS, authentication, and one handler per connection.
 * Later phases register more handlers here (playback, roles, chat).
 */
export class SocketServer {
  constructor(httpServer, { roomManager }) {
    this.io = new Server(httpServer, {
      cors: { origin: config.clientOrigins, methods: ['GET', 'POST'] },
    });
    this.roomManager = roomManager;

    this.io.use(authenticateSocket);
    this.io.on('connection', (socket) => this.#onConnection(socket));
  }

  #onConnection(socket) {
    const { username } = socket.data.user;
    console.log(`[socket] connected: ${socket.id} (${username})`);

    new RoomHandler({ io: this.io, socket, roomManager: this.roomManager }).register();

    socket.on('disconnect', (reason) => {
      console.log(`[socket] disconnected: ${socket.id} (${username}, ${reason})`);
    });
  }

  /** Closes all connections and the underlying HTTP server. */
  close() {
    return this.io.close();
  }
}
