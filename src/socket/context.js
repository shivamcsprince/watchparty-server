import { AppError } from '../utils/AppError.js';

/**
 * Works out, from the server's own records, which room this socket is in and who they are there.
 * A connection that was replaced by a newer one (e.g. an old tab) is treated as "not in a room".
 */
export function getRoomContext(socket, roomManager) {
  const { user, roomCode } = socket.data;
  const room = roomCode ? roomManager.getActiveRoom(roomCode) : null;
  const participant = room?.getParticipant(user.userId);

  if (!room || !participant || participant.socketId !== socket.id) {
    throw new AppError(409, 'You are not in a room', undefined, 'NOT_IN_ROOM');
  }
  return { room, participant };
}
