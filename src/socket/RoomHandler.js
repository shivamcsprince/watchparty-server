import { z, ZodError } from 'zod';
import { AppError } from '../utils/AppError.js';
import { roomChannel } from '../rooms/Room.js';
import { roomCodeSchema } from '../rooms/roomCode.js';

// In the assignment's contract the field is called "roomId"; its value is the 8-character room code.
const joinRoomSchema = z.object({ roomId: roomCodeSchema });

/**
 * Handles the room-membership events for ONE connected socket:
 *   join_room / leave_room (client -> server), plus disconnects.
 * It validates input, calls the RoomManager, and broadcasts the results.
 * Business rules live in Room / RoomManager, not here.
 */
export class RoomHandler {
  constructor({ io, socket, roomManager }) {
    this.io = io;
    this.socket = socket;
    this.roomManager = roomManager;
  }

  register() {
    this.socket.on(
      'join_room',
      this.#withAck((payload) => this.#joinRoom(payload)),
    );
    this.socket.on(
      'leave_room',
      this.#withAck(() => this.#leaveRoom()),
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
    };
  }

  /**
   * Wraps an event handler so the client always gets an acknowledgement
   * ({ ok: true, ... } or { ok: false, error, code }) and an error can never crash the server.
   */
  #withAck(handler) {
    return async (payload, callback) => {
      const reply = typeof callback === 'function' ? callback : () => {};
      try {
        reply({ ok: true, ...(await handler(payload)) });
      } catch (err) {
        reply(this.#toErrorResponse(err));
      }
    };
  }

  #toErrorResponse(err) {
    if (err instanceof ZodError) {
      return { ok: false, error: 'Invalid request', code: 'INVALID_REQUEST' };
    }
    if (err instanceof AppError) {
      return { ok: false, error: err.message, code: err.code ?? 'ERROR' };
    }
    console.error('[socket] Unexpected error:', err);
    return { ok: false, error: 'Something went wrong', code: 'INTERNAL_ERROR' };
  }
}
