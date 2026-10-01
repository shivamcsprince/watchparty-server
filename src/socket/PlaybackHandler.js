import { AppError } from '../utils/AppError.js';
import { parsePlaybackParams } from '../rooms/playbackActions.js';
import { ACTIONS, RolePolicy } from '../rooms/RolePolicy.js';
import { withAck } from './ack.js';
import { getRoomContext } from './context.js';

/**
 * Playback events for ONE connected socket: play, pause, seek, change_video, request_sync.
 * Every control event goes through the same steps:
 *   1. who is this, and are they really in a room?   (identity comes from the server, not the client)
 *   2. does their role allow it?                      (RolePolicy)
 *   3. validate the payload
 *   4. update the room's PlaybackState and broadcast sync_state to everyone
 */
export class PlaybackHandler {
  constructor({ socket, roomManager, limiter }) {
    this.socket = socket;
    this.roomManager = roomManager;
    this.limiter = limiter;
  }

  register() {
    const on = (event, fn) => this.socket.on(event, withAck(fn, { limiter: this.limiter }));

    for (const action of ['play', 'pause', 'seek', 'change_video']) {
      on(action, (payload) => this.#control(action, payload));
    }
    // Clients call this periodically to compare their player against the server's state.
    on('request_sync', () => ({ playback: this.#context().room.playback.snapshot() }));
  }

  #context() {
    return getRoomContext(this.socket, this.roomManager);
  }

  #control(action, payload) {
    const { room, participant } = this.#context();

    if (!RolePolicy.can(participant.role, ACTIONS.PLAYBACK_CONTROL)) {
      throw new AppError(
        403,
        'You do not have permission to control playback',
        undefined,
        'FORBIDDEN',
      );
    }

    const params = parsePlaybackParams(action, payload);
    const playback = this.roomManager.applyPlayback(room, action, params, {
      by: { userId: participant.userId, username: participant.username },
    });
    return { playback };
  }
}
