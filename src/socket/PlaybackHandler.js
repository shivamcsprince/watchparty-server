import { z } from 'zod';
import { AppError } from '../utils/AppError.js';
import { extractVideoId } from '../utils/youtube.js';
import { ACTIONS, RolePolicy } from '../rooms/RolePolicy.js';
import { withAck } from './ack.js';

const MAX_SEEK_SECONDS = 7 * 24 * 60 * 60;

const seekSchema = z.object({ time: z.number().min(0).max(MAX_SEEK_SECONDS) });

// "videoId" may be an 11-character id or a pasted YouTube link; either way only the clean id is kept.
const changeVideoSchema = z.object({
  videoId: z
    .string()
    .max(300)
    .transform(extractVideoId)
    .refine((id) => id !== null, 'Not a valid YouTube video or link'),
});

/**
 * Playback events for ONE connected socket: play, pause, seek, change_video, request_sync.
 * Every control event goes through the same steps:
 *   1. who is this, and are they really in a room?   (identity comes from the server, not the client)
 *   2. does their role allow it?                      (RolePolicy)
 *   3. validate the payload
 *   4. update the room's PlaybackState
 *   5. broadcast the new state to everyone (sync_state)
 */
export class PlaybackHandler {
  constructor({ socket, roomManager, limiter }) {
    this.socket = socket;
    this.roomManager = roomManager;
    this.limiter = limiter;
  }

  register() {
    const on = (event, fn) => this.socket.on(event, withAck(fn, { limiter: this.limiter }));

    on('play', () => this.#control('play', (playback) => playback.play()));
    on('pause', () => this.#control('pause', (playback) => playback.pause()));
    on('seek', (payload) => {
      return this.#control('seek', (playback) => playback.seek(seekSchema.parse(payload).time));
    });
    on('change_video', (payload) => {
      return this.#control(
        'change_video',
        (playback) => playback.changeVideo(changeVideoSchema.parse(payload).videoId),
        { persistVideo: true },
      );
    });
    // Clients call this periodically to compare their player against the server's state.
    on('request_sync', () => ({ playback: this.#context().room.playback.snapshot() }));
  }

  /** The room this socket is in and the server's record of who they are. */
  #context() {
    const { user, roomCode } = this.socket.data;
    const room = roomCode ? this.roomManager.getActiveRoom(roomCode) : null;
    const participant = room?.getParticipant(user.userId);

    // A connection that was replaced by a newer one (e.g. an old tab) must not be able to act.
    if (!room || !participant || participant.socketId !== this.socket.id) {
      throw new AppError(409, 'You are not in a room', undefined, 'NOT_IN_ROOM');
    }
    return { room, participant };
  }

  #control(action, apply, { persistVideo = false } = {}) {
    const { room, participant } = this.#context();

    if (!RolePolicy.can(participant.role, ACTIONS.PLAYBACK_CONTROL)) {
      throw new AppError(
        403,
        'You do not have permission to control playback',
        undefined,
        'FORBIDDEN',
      );
    }

    apply(room.playback);
    const playback = room.playback.snapshot();

    // Everyone in the room, including the sender, receives the same update.
    room.broadcast('sync_state', {
      ...playback,
      action,
      by: { userId: participant.userId, username: participant.username },
    });

    if (persistVideo) this.roomManager.persistVideoId(room);
    return { playback };
  }
}
