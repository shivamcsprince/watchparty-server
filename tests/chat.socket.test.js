import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.BCRYPT_ROUNDS = '4';
process.env.AUTH_RATE_LIMIT_MAX = '1000';
process.env.ROOM_CREATE_RATE_LIMIT_MAX = '1000';

const { VIDEO_A, cleanupUsers, closePool, createHarness, emit, nextEvent, noEvent, sleep } =
  await import('./helpers/harness.js');

const DOMAIN = '@watchparty-chat-tests.invalid';

let h;

before(async () => {
  await cleanupUsers(DOMAIN);
  h = await createHarness({ domain: DOMAIN });
});

after(async () => {
  await h.stop();
  await cleanupUsers(DOMAIN);
  await closePool();
});

/** host + moderator + participant + viewer, all joined. */
async function setupCast() {
  const { code, host, members } = await h.setupRoom({ guests: 3 });
  const [moderator, participant, viewer] = members;
  await emit(host.socket, 'assign_role', { userId: moderator.user.id, role: 'moderator' });
  await emit(host.socket, 'assign_role', { userId: viewer.user.id, role: 'viewer' });
  await sleep(50); // let the setup broadcasts settle
  return { code, host, moderator, participant, viewer };
}

describe('chat', () => {
  test('a message reaches everyone in the room, including the sender, with the right details', async () => {
    const { host, moderator, participant, viewer } = await setupCast();
    const everyone = [host, moderator, participant, viewer].map((m) =>
      nextEvent(m.socket, 'chat_message'),
    );

    const res = await emit(participant.socket, 'send_message', { text: '  hello everyone  ' });
    assert.equal(res.ok, true);
    assert.equal(res.message.text, 'hello everyone');

    for (const message of await Promise.all(everyone)) {
      assert.equal(message.id, res.message.id);
      assert.equal(message.text, 'hello everyone');
      assert.equal(message.userId, participant.user.id);
      assert.equal(message.username, participant.user.username);
      assert.equal(message.role, 'participant');
      assert.ok(Math.abs(Date.parse(message.sentAt) - Date.now()) < 5000);
    }
  });

  test('host, moderator and participant may chat; the viewer may not, and nobody hears the attempt', async () => {
    const { host, moderator, participant, viewer } = await setupCast();
    for (const member of [host, moderator, participant]) {
      assert.equal((await emit(member.socket, 'send_message', { text: 'hi' })).ok, true);
    }
    const silent = noEvent(host.socket, 'chat_message');
    const res = await emit(viewer.socket, 'send_message', { text: 'let me in' });
    assert.deepEqual([res.ok, res.code], [false, 'FORBIDDEN']);
    await silent;
  });

  test('a person demoted to viewer immediately loses the right to chat', async () => {
    const { host, participant } = await setupCast();
    assert.equal((await emit(participant.socket, 'send_message', { text: 'ok' })).ok, true);
    await emit(host.socket, 'assign_role', { userId: participant.user.id, role: 'viewer' });
    assert.equal(
      (await emit(participant.socket, 'send_message', { text: 'still?' })).code,
      'FORBIDDEN',
    );
  });

  test('the role shown on a message is the role at the time it was sent', async () => {
    const { host, participant } = await setupCast();
    await emit(participant.socket, 'send_message', { text: 'before' });
    await emit(host.socket, 'assign_role', { userId: participant.user.id, role: 'moderator' });
    const after = await emit(participant.socket, 'send_message', { text: 'after' });
    assert.equal(after.message.role, 'moderator');

    const late = await h.join(
      await h.registerUser(),
      (await emit(host.socket, 'request_sync')) && participant.res.room.code,
    );
    assert.deepEqual(
      late.res.messages.map((m) => [m.text, m.role]),
      [
        ['before', 'participant'],
        ['after', 'moderator'],
      ],
    );
  });

  test('invalid messages are refused: missing, empty, only whitespace', async () => {
    const { participant } = await setupCast();
    for (const payload of [undefined, null, {}, { text: '' }, { text: '   ' }]) {
      const res = await emit(participant.socket, 'send_message', payload);
      assert.deepEqual([res.ok, res.code], [false, 'INVALID_REQUEST'], JSON.stringify(payload));
    }
  });

  test('invalid messages are refused: too long, wrong type; the exact maximum is fine', async () => {
    const { participant } = await setupCast();
    for (const payload of [{ text: 'x'.repeat(501) }, { text: 42 }, { text: ['a'] }]) {
      const res = await emit(participant.socket, 'send_message', payload);
      assert.deepEqual([res.ok, res.code], [false, 'INVALID_REQUEST']);
    }
    assert.equal(
      (await emit(participant.socket, 'send_message', { text: 'x'.repeat(500) })).ok,
      true,
    );
  });

  test('invalid attempts also use up the rate limit, so spam cannot hide inside bad requests', async () => {
    const { participant } = await setupCast();
    for (let i = 0; i < 5; i += 1) await emit(participant.socket, 'send_message', { text: '' });
    const res = await emit(participant.socket, 'send_message', {
      text: 'a perfectly good message',
    });
    assert.equal(res.code, 'RATE_LIMITED');
  });

  test('control characters are removed; HTML is passed through untouched (clients render it as text)', async () => {
    const { participant } = await setupCast();
    const res = await emit(participant.socket, 'send_message', {
      text: 'a\u0000b\u001b<img src=x onerror=alert(1)>',
    });
    assert.equal(res.message.text, 'ab<img src=x onerror=alert(1)>');
  });

  test('someone who is not in a room cannot chat or react', async () => {
    const socket = await h.connect((await h.registerUser()).token);
    assert.equal((await emit(socket, 'send_message', { text: 'hi' })).code, 'NOT_IN_ROOM');
    assert.equal((await emit(socket, 'send_reaction', { emoji: '🔥' })).code, 'NOT_IN_ROOM');
  });

  test('a removed participant can no longer chat or hear the room', async () => {
    const { host, participant } = await setupCast();
    await emit(host.socket, 'remove_participant', { userId: participant.user.id });
    assert.equal(
      (await emit(participant.socket, 'send_message', { text: 'hello?' })).code,
      'NOT_IN_ROOM',
    );
    const silent = noEvent(participant.socket, 'chat_message');
    await emit(host.socket, 'send_message', { text: 'bye' });
    await silent;
  });

  test('rooms are separate: messages never leak between rooms', async () => {
    const roomA = await h.setupRoom({ guests: 1 });
    const roomB = await h.setupRoom({ guests: 1 });
    const silent = noEvent(roomB.members[0].socket, 'chat_message');
    await emit(roomA.host.socket, 'send_message', { text: 'only for room A' });
    await silent;
  });

  test('late joiners receive the recent history in order', async () => {
    const { code, host } = await setupCast();
    for (const text of ['one', 'two', 'three']) {
      assert.equal((await emit(host.socket, 'send_message', { text })).ok, true);
    }
    const late = await h.join(await h.registerUser(), code);
    assert.deepEqual(
      late.res.messages.map((m) => m.text),
      ['one', 'two', 'three'],
    );
  });

  test('history is not saved: once the room empties, it starts fresh', async () => {
    const { code, host, members } = await h.setupRoom({ guests: 1 });
    await emit(host.socket, 'send_message', { text: 'remember me?' });
    await emit(host.socket, 'leave_room');
    await emit(members[0].socket, 'leave_room');
    assert.equal(h.server.roomManager.getActiveRoom(code), null);

    const back = await h.join(host.user, code);
    assert.deepEqual(back.res.messages, []);
  });

  test('chat is rate limited (burst of 5, then slowly), and the limit is per connection', async () => {
    const { host, participant } = await setupCast();
    const results = [];
    for (let i = 0; i < 9; i += 1)
      results.push(await emit(participant.socket, 'send_message', { text: `spam ${i}` }));

    assert.deepEqual(
      results.slice(0, 5).map((r) => r.ok),
      [true, true, true, true, true],
    );
    assert.ok(results.slice(5).every((r) => r.code === 'RATE_LIMITED'));
    // Someone else is unaffected.
    assert.equal((await emit(host.socket, 'send_message', { text: 'still fine' })).ok, true);

    await sleep(1100); // one token has refilled
    assert.equal((await emit(participant.socket, 'send_message', { text: 'later' })).ok, true);
  });
});

describe('reactions', () => {
  test('a reaction reaches everyone and records where in the video it happened', async () => {
    const { host, moderator, participant, viewer } = await setupCast();
    await emit(host.socket, 'change_video', { videoId: VIDEO_A });
    await emit(host.socket, 'seek', { time: 120 });
    await emit(host.socket, 'play');
    await sleep(1100);

    const everyone = [host, moderator, participant, viewer].map((m) =>
      nextEvent(m.socket, 'reaction'),
    );
    const res = await emit(participant.socket, 'send_reaction', { emoji: '🔥' });
    assert.equal(res.ok, true);

    for (const reaction of await Promise.all(everyone)) {
      assert.equal(reaction.emoji, '🔥');
      assert.equal(reaction.userId, participant.user.id);
      assert.equal(reaction.username, participant.user.username);
      assert.ok(reaction.currentTime >= 121 && reaction.currentTime < 124, reaction.currentTime);
    }
  });

  test('with no video loaded the moment is 0', async () => {
    const { participant } = await setupCast();
    assert.equal(
      (await emit(participant.socket, 'send_reaction', { emoji: '👍' })).reaction.currentTime,
      0,
    );
  });

  test('only the fixed set of emoji is allowed; a plain heart is accepted as the red heart', async () => {
    const { participant } = await setupCast();
    for (const bad of ['💩', 'hello', '', '👍👍', 5, null, undefined]) {
      const res = await emit(participant.socket, 'send_reaction', { emoji: bad });
      assert.deepEqual([res.ok, res.code], [false, 'INVALID_REQUEST'], String(bad));
    }
    assert.equal((await emit(participant.socket, 'send_reaction', {})).code, 'INVALID_REQUEST');
    assert.equal(
      (await emit(participant.socket, 'send_reaction', { emoji: '\u2764' })).reaction.emoji,
      '❤️',
    );
  });

  test('viewers cannot react, and reactions are not saved for late joiners', async () => {
    const { code, host, viewer } = await setupCast();
    const res = await emit(viewer.socket, 'send_reaction', { emoji: '🎉' });
    assert.deepEqual([res.ok, res.code], [false, 'FORBIDDEN']);

    await emit(host.socket, 'send_reaction', { emoji: '🎉' });
    const late = await h.join(await h.registerUser(), code);
    assert.equal(late.res.reactions, undefined);
  });

  test('reactions are rate limited separately from chat', async () => {
    const { participant } = await setupCast();
    for (let i = 0; i < 5; i += 1)
      await emit(participant.socket, 'send_message', { text: `m${i}` });
    assert.equal(
      (await emit(participant.socket, 'send_message', { text: 'blocked' })).code,
      'RATE_LIMITED',
    );
    // Chat is exhausted, but reactions still work.
    assert.equal((await emit(participant.socket, 'send_reaction', { emoji: '👏' })).ok, true);

    const results = [];
    for (let i = 0; i < 14; i += 1)
      results.push(await emit(participant.socket, 'send_reaction', { emoji: '👍' }));
    assert.ok(results.some((r) => r.code === 'RATE_LIMITED'));
  });
});
