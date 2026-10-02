import { ROLES } from './roles.js';

export const ACTIONS = Object.freeze({
  PLAYBACK_CONTROL: 'playback:control', // play, pause, seek, change video
  ASSIGN_ROLE: 'roles:assign',
  REMOVE_PARTICIPANT: 'participants:remove',
  REQUEST_ACTION: 'requests:create', // ask a host/moderator to do something
  RESOLVE_REQUEST: 'requests:resolve', // approve or reject such a request
  SEND_CHAT: 'chat:send',
  SEND_REACTION: 'reactions:send',
});

const PERMISSIONS = Object.freeze({
  [ROLES.HOST]: new Set([
    ACTIONS.PLAYBACK_CONTROL,
    ACTIONS.ASSIGN_ROLE,
    ACTIONS.REMOVE_PARTICIPANT,
    ACTIONS.RESOLVE_REQUEST,
    ACTIONS.SEND_CHAT,
    ACTIONS.SEND_REACTION,
  ]),
  [ROLES.MODERATOR]: new Set([
    ACTIONS.PLAYBACK_CONTROL,
    ACTIONS.RESOLVE_REQUEST,
    ACTIONS.SEND_CHAT,
    ACTIONS.SEND_REACTION,
  ]),
  [ROLES.PARTICIPANT]: new Set([ACTIONS.REQUEST_ACTION, ACTIONS.SEND_CHAT, ACTIONS.SEND_REACTION]),
  [ROLES.VIEWER]: new Set(), // fully read-only
});

/**
 * The single place that decides "may this role do this?".
 * Anything not explicitly granted is denied (including unknown roles).
 * Handlers call RolePolicy.can(...) instead of scattering role checks around.
 */
export class RolePolicy {
  static can(role, action) {
    return PERMISSIONS[role]?.has(action) ?? false;
  }
}
