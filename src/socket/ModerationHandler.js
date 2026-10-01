import { z } from 'zod';
import { PLAYBACK_ACTIONS, parsePlaybackParams } from '../rooms/playbackActions.js';
import { ASSIGNABLE_ROLES } from '../rooms/RoomModeration.js';
import { serializeRequest } from '../rooms/RequestQueue.js';
import { withAck } from './ack.js';
import { getRoomContext } from './context.js';

const userIdSchema = z.string().min(1).max(64);

const assignRoleSchema = z.object({ userId: userIdSchema, role: z.enum(ASSIGNABLE_ROLES) });
const removeSchema = z.object({ userId: userIdSchema });
const requestSchema = z.object({ action: z.enum(PLAYBACK_ACTIONS) });
const resolveSchema = z.object({
  requestId: z.string().min(1).max(64),
  decision: z.enum(['approve', 'reject']),
});

/**
 * Role management and approval requests for ONE connected socket:
 *   assign_role, remove_participant, request_action, resolve_request, list_requests.
 * This class only translates events; the rules live in RoomModeration.
 */
export class ModerationHandler {
  constructor({ io, socket, roomManager, moderation, limiter }) {
    this.io = io;
    this.socket = socket;
    this.roomManager = roomManager;
    this.moderation = moderation;
    this.limiter = limiter;
  }

  register() {
    const on = (event, fn) => this.socket.on(event, withAck(fn, { limiter: this.limiter }));

    on('assign_role', (payload) => this.#assignRole(payload));
    on('remove_participant', (payload) => this.#removeParticipant(payload));
    on('request_action', (payload) => this.#requestAction(payload));
    on('resolve_request', (payload) => this.#resolveRequest(payload));
    on('list_requests', () => {
      const { room, participant } = this.#context();
      return { requests: room.listRequestsFor(participant) };
    });
  }

  #context() {
    return getRoomContext(this.socket, this.roomManager);
  }

  #assignRole(payload) {
    const { room, participant: actor } = this.#context();
    const { userId, role } = assignRoleSchema.parse(payload);
    this.moderation.assignRole(room, actor, userId, role);
    return { participants: room.listParticipants() };
  }

  #removeParticipant(payload) {
    const { room, participant: actor } = this.#context();
    const { userId } = removeSchema.parse(payload);
    const removed = this.moderation.removeParticipant(room, actor, userId);

    // Detach the removed person's connection from the room. They may rejoin with the code.
    const removedSocket = this.io.sockets.sockets.get(removed.socketId);
    if (removedSocket) {
      removedSocket.leave(room.channel);
      removedSocket.data.roomCode = undefined;
    }
    return { participants: room.listParticipants() };
  }

  #requestAction(payload) {
    const { room, participant: actor } = this.#context();
    const { action } = requestSchema.parse(payload);
    const params = parsePlaybackParams(action, payload);
    const request = this.moderation.createRequest(room, actor, { action, params });
    return { request: serializeRequest(request) };
  }

  #resolveRequest(payload) {
    const { room, participant: actor } = this.#context();
    const { requestId, decision } = resolveSchema.parse(payload);
    const { status } = this.moderation.resolveRequest(room, actor, requestId, decision);
    return { requestId, status };
  }
}
