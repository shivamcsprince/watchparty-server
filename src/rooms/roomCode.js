import { randomInt } from 'node:crypto';
import { z } from 'zod';

export const ROOM_CODE_LENGTH = 8;

// 32 characters, with look-alikes removed (no 0/O, 1/I). 32^8 is about 1.1 trillion codes.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_PATTERN = new RegExp(`^[${ALPHABET}]{${ROOM_CODE_LENGTH}}$`);

/** Uses crypto.randomInt so every character is uniformly random and unpredictable. */
export function generateRoomCode() {
  let code = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i += 1) {
    code += ALPHABET[randomInt(ALPHABET.length)];
  }
  return code;
}

/** Lets people type codes in lowercase, or with spaces/dashes (e.g. "abcd-2345"). */
export function normalizeRoomCode(input) {
  return String(input).toUpperCase().replace(/[\s-]/g, '');
}

export function isValidRoomCode(code) {
  return CODE_PATTERN.test(code);
}

/** Zod schema reused by REST routes and socket events. */
export const roomCodeSchema = z
  .string()
  .transform(normalizeRoomCode)
  .refine(isValidRoomCode, 'Invalid room code');
