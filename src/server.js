import http from 'node:http';
import { config } from './config/env.js';
import { createApp } from './app.js';
import { RoomRepository } from './repositories/RoomRepository.js';
import { RoomManager } from './rooms/RoomManager.js';
import { Broadcaster } from './socket/Broadcaster.js';
import { SocketServer } from './socket/SocketServer.js';

/**
 * Composition root: the one place where all the pieces are created and connected.
 * Used by index.js (real server) and by the tests.
 */
export function createServer() {
  const broadcaster = new Broadcaster();
  const roomManager = new RoomManager({
    roomRepository: new RoomRepository(),
    broadcaster,
    capacity: config.roomCapacity,
  });

  const app = createApp({ roomManager });
  const httpServer = http.createServer(app);
  const socketServer = new SocketServer(httpServer, { roomManager });
  broadcaster.bind(socketServer.io);

  return { httpServer, socketServer, roomManager };
}
