import { z } from 'zod';
import { roomChannel } from '../rooms/Room.js';
import { roomCodeSchema } from '../rooms/roomCode.js';
import { withAck } from './ack.js';

// In the assignment's contract the field is called "roomId"; its value is the 8-character room code.
const joinRoomSchema = z.object({ roomId: roomCodeSchema });

/**
 * Handles the room-membership events for ONE connected socket:
 *   join_room / leave_room (client -> server), plus disconnects.
 * It validates input, calls the RoomManager, and broadcasts the results.
 * Business rules live in Room / RoomManager, not here.
 */
export class RoomHandler {
  constructor({ io, socket, roomManager, limiter }) {
    this.io = io;
    this.socket = socket;
    this.roomManager = roomManager;
    this.limiter = limiter;
  }

  register() {
    this.socket.on(
      'join_room',
      withAck((payload) => this.#joinRoom(payload), { limiter: this.limiter }),
    );
    this.socket.on(
      'leave_room',
      withAck(() => this.#leaveRoom(), { limiter: this.limiter }),
    );
    this.socket.on('disconnect', () => this.#leaveCurrentRoom());
  }

  async #joinRoom(payload) {
    const { roomId: code } = joinRoomSchema.parse(payload);
    const { user } = this.socket.data;

    // Joining the room this socket is already in just returns the current state.
    if (this.socket.data.roomCode === code) {
      const room = this.roomManager.getActiveRoom(code);
      const you = room?.getParticipant(user.userId);
      if (room && you) return this.#snapshot(room, you);
    }

    const previousCode = this.socket.data.roomCode;
    const { room, participant, replaced } = await this.roomManager.join({
      code,
      user,
      socketId: this.socket.id,
    });

    // One room per connection: only leave the old room once the new join has succeeded.
    if (previousCode && previousCode !== code) await this.#leaveCurrentRoom();

    if (replaced && replaced.socketId !== this.socket.id) {
      this.#evictReplacedSocket(replaced.socketId, room);
    }

    this.socket.join(room.channel);
    this.socket.data.roomCode = code;

    // If the same user just replaced their own older connection, the list did not change.
    if (!replaced) {
      room.broadcast(
        'user_joined',
        {
          username: participant.username,
          userId: participant.userId,
          role: participant.role,
          participants: room.listParticipants(),
        },
        { exceptSocketId: this.socket.id },
      );
    }

    return this.#snapshot(room, participant);
  }

  async #leaveRoom() {
    await this.#leaveCurrentRoom();
    return {};
  }

  async #leaveCurrentRoom() {
    const code = this.socket.data.roomCode;
    if (!code) return;
    this.socket.data.roomCode = undefined;
    this.socket.leave(roomChannel(code));

    const { user } = this.socket.data;
    const result = this.roomManager.leave({
      code,
      userId: user.userId,
      socketId: this.socket.id,
    });
    if (!result) return; // this connection had already been replaced by a newer one

    result.room.broadcast('user_left', {
      username: result.participant.username,
      userId: result.participant.userId,
      participants: result.room.listParticipants(),
    });
  }

  /** The same user connected again (e.g. a second tab): the older connection is told and detached. */
  #evictReplacedSocket(oldSocketId, room) {
    const oldSocket = this.io.sockets.sockets.get(oldSocketId);
    if (!oldSocket) return;
    oldSocket.leave(room.channel);
    oldSocket.data.roomCode = undefined;
    oldSocket.emit('session_replaced', { roomId: room.code });
  }

  #snapshot(room, participant) {
    return {
      room: room.toJSON(),
      you: participant.toJSON(),
      participants: room.listParticipants(),
      playback: room.playback.snapshot(),
    };
  }
}
