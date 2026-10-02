import { z } from 'zod';

export const MAX_CHAT_LENGTH = 500;

/** The fixed set of reactions people can send. */
export const REACTION_EMOJIS = Object.freeze(['👍', '❤️', '😂', '😮', '😢', '👏', '🔥', '🎉']);

// Some keyboards send "❤" and others "❤️" (with an invisible variation selector, U+FE0F).
const stripVariationSelector = (text) => text.replaceAll('\uFE0F', '');
const CANONICAL = new Map(REACTION_EMOJIS.map((emoji) => [stripVariationSelector(emoji), emoji]));

/** Returns the canonical emoji for an allowed reaction, or null. */
export function canonicalReaction(input) {
  return CANONICAL.get(stripVariationSelector(String(input))) ?? null;
}

/** Removes control characters (tabs, escape codes, ...) but keeps newlines. */
function stripControlCharacters(text) {
  let result = '';
  for (const char of text) {
    const code = char.codePointAt(0);
    const isControl = (code < 0x20 && code !== 0x0a) || code === 0x7f;
    if (!isControl) result += char;
  }
  return result;
}

/**
 * Cleans what a user typed: removes control characters (keeps newlines), trims, and
 * limits blank lines. It does NOT escape HTML; clients must render messages as plain text.
 */
export function cleanChatText(raw) {
  return stripControlCharacters(String(raw).replace(/\r\n?/g, '\n'))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export const chatSchema = z.object({
  // The first limit bounds how much text we are willing to even look at.
  text: z
    .string()
    .max(MAX_CHAT_LENGTH * 4)
    .transform(cleanChatText)
    .pipe(z.string().min(1, 'Message is empty').max(MAX_CHAT_LENGTH, 'Message is too long')),
});

export const reactionSchema = z.object({
  emoji: z
    .string()
    .max(16)
    .transform(canonicalReaction)
    .refine((emoji) => emoji !== null, 'Not an allowed reaction'),
});
