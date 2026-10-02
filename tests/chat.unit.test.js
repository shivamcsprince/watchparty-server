import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ChatLog } from '../src/rooms/ChatLog.js';
import {
  MAX_CHAT_LENGTH,
  REACTION_EMOJIS,
  canonicalReaction,
  chatSchema,
  cleanChatText,
  reactionSchema,
} from '../src/rooms/chatMessages.js';

describe('cleanChatText', () => {
  test('trims and keeps normal text, including emoji and non-latin scripts', () => {
    assert.equal(cleanChatText('  hello there  '), 'hello there');
    assert.equal(cleanChatText('नमस्ते 👋 こんにちは'), 'नमस्ते 👋 こんにちは');
  });

  test('removes control characters (null, escape, bell, tab, delete) but keeps newlines', () => {
    assert.equal(cleanChatText('a\u0000b\u001bc\u0007d\te\u007ff'), 'abcdef');
    assert.equal(cleanChatText('line1\nline2'), 'line1\nline2');
  });

  test('normalizes Windows newlines and limits blank lines', () => {
    assert.equal(cleanChatText('a\r\nb\rc'), 'a\nb\nc');
    assert.equal(cleanChatText('a\n\n\n\n\nb'), 'a\n\nb');
  });

  test('does not touch HTML: clients must render text safely', () => {
    assert.equal(cleanChatText('<b>hi</b> & <script>'), '<b>hi</b> & <script>');
  });

  test('a message of only whitespace/control characters becomes empty', () => {
    assert.equal(cleanChatText(' \t\u0000\n  '), '');
  });
});

describe('chatSchema', () => {
  test('accepts a normal message and returns the cleaned text', () => {
    assert.equal(chatSchema.parse({ text: '  hi  ' }).text, 'hi');
  });

  test('rejects empty, too long, and non-string input', () => {
    assert.throws(() => chatSchema.parse({ text: '' }));
    assert.throws(() => chatSchema.parse({ text: ' \u0000 ' }));
    assert.throws(() => chatSchema.parse({ text: 'x'.repeat(MAX_CHAT_LENGTH + 1) }));
    assert.throws(() => chatSchema.parse({ text: 'x'.repeat(MAX_CHAT_LENGTH * 4 + 1) }));
    for (const bad of [undefined, null, {}, { text: 123 }, { text: ['a'] }, { text: null }]) {
      assert.throws(() => chatSchema.parse(bad));
    }
  });

  test('exactly the maximum length is allowed', () => {
    assert.equal(
      chatSchema.parse({ text: 'x'.repeat(MAX_CHAT_LENGTH) }).text.length,
      MAX_CHAT_LENGTH,
    );
  });
});

describe('reactions', () => {
  test('every allowed emoji is accepted as itself', () => {
    for (const emoji of REACTION_EMOJIS) assert.equal(reactionSchema.parse({ emoji }).emoji, emoji);
  });

  test('a heart typed without the invisible variation selector is canonicalized', () => {
    assert.equal(canonicalReaction('\u2764'), '❤️');
    assert.equal(reactionSchema.parse({ emoji: '\u2764' }).emoji, '❤️');
  });

  test('anything outside the set is rejected', () => {
    for (const bad of ['💩', 'a', '', '👍👍', '<script>', undefined, 5, null]) {
      assert.throws(() => reactionSchema.parse({ emoji: bad }), String(bad));
    }
    assert.throws(() => reactionSchema.parse({}));
  });
});

describe('ChatLog', () => {
  test('keeps messages in order and drops the oldest beyond the limit', () => {
    const log = new ChatLog({ limit: 3 });
    for (let i = 1; i <= 5; i += 1) log.add({ id: i });
    assert.deepEqual(
      log.recent().map((m) => m.id),
      [3, 4, 5],
    );
    assert.equal(log.size, 3);
  });

  test('recent() returns a copy', () => {
    const log = new ChatLog();
    log.add({ id: 1 });
    log.recent().push({ id: 'intruder' });
    assert.equal(log.size, 1);
  });
});
