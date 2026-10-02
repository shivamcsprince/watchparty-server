import { Server } from 'socket.io';
import { config } from '../config/env.js';
import { authenticateSocket } from './socketAuth.js';
import { TokenBucket } from '../utils/TokenBucket.js';
import { RoomHandler } from './RoomHandler.js';
import { PlaybackHandler } from './PlaybackHandler.js';
import { ModerationHandler } from './ModerationHandler.js';
import { ChatHandler } from './ChatHandler.js';
import { RoomModeration } from '../rooms/RoomModeration.js';

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
    this.moderation = new RoomModeration({ roomManager });

    this.io.use(authenticateSocket);
    this.io.on('connection', (socket) => this.#onConnection(socket));
  }

  #onConnection(socket) {
    const { username } = socket.data.user;
    console.log(`[socket] connected: ${socket.id} (${username})`);

    // One limiter per connection, shared by all its event handlers (burst of 20, then 10 events/second).
    const limiter = new TokenBucket({ capacity: 20, refillPerSecond: 10 });
    const { io, roomManager } = this;
    new RoomHandler({ io, socket, roomManager, limiter }).register();
    const { moderation } = this;
    new PlaybackHandler({ socket, roomManager, limiter }).register();
    new ModerationHandler({ io, socket, roomManager, moderation, limiter }).register();

    // Chat and reactions are the easiest things to spam, so they get stricter limits of their own.
    new ChatHandler({
      socket,
      roomManager,
      limiter,
      chatLimiter: new TokenBucket({ capacity: 5, refillPerSecond: 1 }),
      reactionLimiter: new TokenBucket({ capacity: 10, refillPerSecond: 3 }),
    }).register();

    socket.on('disconnect', (reason) => {
      console.log(`[socket] disconnected: ${socket.id} (${username}, ${reason})`);
    });
  }

  /** Closes all connections and the underlying HTTP server. */
  close() {
    return this.io.close();
  }
}
