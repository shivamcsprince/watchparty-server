import { z } from 'zod';
import { extractVideoId } from '../utils/youtube.js';

export const PLAYBACK_ACTIONS = Object.freeze(['play', 'pause', 'seek', 'change_video']);

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
 * Validates and cleans the extra data an action needs. Used both for direct control
 * and for approval requests, so both accept exactly the same input.
 * Returns the params to store/apply, e.g. { time: 90 } or { videoId: "dQw4w9WgXcQ" }.
 */
export function parsePlaybackParams(action, payload) {
  switch (action) {
    case 'seek':
      return { time: seekSchema.parse(payload).time };
    case 'change_video':
      return { videoId: changeVideoSchema.parse(payload).videoId };
    default:
      return {};
  }
}
