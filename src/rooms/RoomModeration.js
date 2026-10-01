import { AppError } from '../utils/AppError.js';
import { serializeRequest as serializeForEvent } from './RequestQueue.js';
import { ACTIONS, RolePolicy } from './RolePolicy.js';
import { ROLES } from './roles.js';

/** Roles the host may hand out. "host" is never assignable: it only changes through succession. */
export const ASSIGNABLE_ROLES = Object.freeze([ROLES.MODERATOR, ROLES.PARTICIPANT, ROLES.VIEWER]);

const forbidden = (message) => new AppError(403, message, undefined, 'FORBIDDEN');
const invalidTarget = (message) => new AppError(400, message, undefined, 'INVALID_TARGET');

/**
 * The rules for managing a room: who may change roles, remove people, and
 * request or approve actions. Every method gets the ACTING participant (taken from the
 * server's own records, never from the client), checks the policy first, and only then acts.
 */
export class RoomModeration {
  constructor({ roomManager }) {
    this.roomManager = roomManager;
  }

  #findTarget(room, actor, targetUserId) {
    const target = room.getParticipant(targetUserId);
    if (!target) {
      throw new AppError(
        404,
        'That person is not in this room',
        undefined,
        'PARTICIPANT_NOT_FOUND',
      );
    }
    if (target.userId === actor.userId) throw invalidTarget('You cannot do that to yourself');
    if (target.role === ROLES.HOST) throw invalidTarget('The host cannot be changed or removed');
    return target;
  }

  assignRole(room, actor, targetUserId, role) {
    if (!RolePolicy.can(actor.role, ACTIONS.ASSIGN_ROLE)) {
      throw forbidden('Only the host can assign roles');
    }
    if (!ASSIGNABLE_ROLES.includes(role)) {
      throw new AppError(400, 'That role cannot be assigned', undefined, 'INVALID_ROLE');
    }
    const target = this.#findTarget(room, actor, targetUserId);
    if (target.role === role) return { participant: target, changed: false };

    room.setRole(target.userId, role);

    // Viewers may not request anything, and moderators don't need approval: drop stale requests.
    if (!RolePolicy.can(role, ACTIONS.REQUEST_ACTION)) room.cancelRequestsFor(target.userId);

    room.broadcast('role_assigned', {
      userId: target.userId,
      username: target.username,
      role,
      participants: room.listParticipants(),
    });
    return { participant: target, changed: true };
  }

  /** Removes (kicks) someone. They may rejoin with the room code. Returns the removed participant. */
  removeParticipant(room, actor, targetUserId) {
    if (!RolePolicy.can(actor.role, ACTIONS.REMOVE_PARTICIPANT)) {
      throw forbidden('Only the host can remove participants');
    }
    const target = this.#findTarget(room, actor, targetUserId);

    room.removeParticipant(target.userId, target.socketId);
    room.cancelRequestsFor(target.userId);
    // The removed person is still in the room's channel at this moment, so they hear it too.
    room.broadcast('participant_removed', {
      userId: target.userId,
      username: target.username,
      participants: room.listParticipants(),
    });
    return target;
  }

  /** A participant asks for a playback change. Returns the stored request. */
  createRequest(room, actor, { action, params }) {
    if (!RolePolicy.can(actor.role, ACTIONS.REQUEST_ACTION)) {
      throw forbidden('You are not allowed to make requests');
    }
    if (action !== 'change_video' && !room.videoId) {
      throw new AppError(409, 'No video is loaded', undefined, 'NO_VIDEO');
    }

    const request = room.requests.add({
      action,
      params,
      requestedBy: { userId: actor.userId, username: actor.username },
    });
    room.notifyRequestAudience(request, 'request_created', { request: serializeForEvent(request) });
    return request;
  }

  /** A host or moderator approves or rejects. The first decision wins; later ones find nothing. */
  resolveRequest(room, actor, requestId, decision) {
    if (!RolePolicy.can(actor.role, ACTIONS.RESOLVE_REQUEST)) {
      throw forbidden('Only the host or a moderator can answer requests');
    }
    const request = room.requests.take(requestId);
    if (!request) {
      throw new AppError(
        404,
        'That request was not found or has already been answered',
        undefined,
        'REQUEST_NOT_FOUND',
      );
    }

    const resolvedBy = { userId: actor.userId, username: actor.username };

    if (decision === 'reject') {
      room.announceRequestResolved(request, 'rejected', { resolvedBy });
      return { request, status: 'rejected' };
    }

    try {
      this.roomManager.applyPlayback(room, request.action, request.params, {
        by: request.requestedBy,
        approvedBy: resolvedBy,
      });
    } catch (err) {
      room.announceRequestResolved(request, 'failed', { resolvedBy, reason: err.code ?? 'ERROR' });
      throw err;
    }
    room.announceRequestResolved(request, 'approved', { resolvedBy });
    return { request, status: 'approved' };
  }
}
