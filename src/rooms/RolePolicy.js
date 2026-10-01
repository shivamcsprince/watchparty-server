import { ROLES } from './roles.js';

export const ACTIONS = Object.freeze({
  PLAYBACK_CONTROL: 'playback:control', // play, pause, seek, change video
});

const PERMISSIONS = Object.freeze({
  [ROLES.HOST]: new Set([ACTIONS.PLAYBACK_CONTROL]),
  [ROLES.MODERATOR]: new Set([ACTIONS.PLAYBACK_CONTROL]),
  [ROLES.PARTICIPANT]: new Set(),
  [ROLES.VIEWER]: new Set(),
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
