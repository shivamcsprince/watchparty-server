import { ROLES } from './roles.js';

export const ACTIONS = Object.freeze({
  PLAYBACK_CONTROL: 'playback:control', // play, pause, seek, change video
  ASSIGN_ROLE: 'roles:assign',
  REMOVE_PARTICIPANT: 'participants:remove',
  REQUEST_ACTION: 'requests:create', // ask a host/moderator to do something
  RESOLVE_REQUEST: 'requests:resolve', // approve or reject such a request
});

const PERMISSIONS = Object.freeze({
  [ROLES.HOST]: new Set([
    ACTIONS.PLAYBACK_CONTROL,
    ACTIONS.ASSIGN_ROLE,
    ACTIONS.REMOVE_PARTICIPANT,
    ACTIONS.RESOLVE_REQUEST,
  ]),
  [ROLES.MODERATOR]: new Set([ACTIONS.PLAYBACK_CONTROL, ACTIONS.RESOLVE_REQUEST]),
  [ROLES.PARTICIPANT]: new Set([ACTIONS.REQUEST_ACTION]),
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
