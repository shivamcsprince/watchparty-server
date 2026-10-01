import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Participant } from '../src/rooms/Participant.js';
import { PlaybackHandler } from '../src/socket/PlaybackHandler.js';
import { Room } from '../src/rooms/Room.js';
import { PlaybackState } from '../src/rooms/PlaybackState.js';
import { ACTIONS, RolePolicy } from '../src/rooms/RolePolicy.js';
import { ROLES } from '../src/rooms/roles.js';
import { TokenBucket } from '../src/utils/TokenBucket.js';
import { extractVideoId } from '../src/utils/youtube.js';

function fakeClock(start = 1_000_000) {
  let now = start;
  const clock = () => now;
  clock.advance = (seconds) => {
    now += seconds * 1000;
  };
  return clock;
}

describe('PlaybackState', () => {
  test('starts paused at 0 with the given video', () => {
    const state = new PlaybackState({ videoId: 'dQw4w9WgXcQ', clock: fakeClock() });
    const snap = state.snapshot();
    assert.deepEqual(
      [snap.videoId, snap.playState, snap.currentTime],
      ['dQw4w9WgXcQ', 'paused', 0],
    );
  });

  test('current time advances only while playing', () => {
    const clock = fakeClock();
    const state = new PlaybackState({ videoId: 'dQw4w9WgXcQ', clock });

    clock.advance(10);
    assert.equal(state.snapshot().currentTime, 0); // paused: time does not move

    state.play();
    clock.advance(5);
    assert.equal(state.snapshot().currentTime, 5);

    state.pause();
    clock.advance(100);
    assert.equal(state.snapshot().currentTime, 5); // frozen at the moment of pause
  });

  test('seek keeps the play state and continues from the new position', () => {
    const clock = fakeClock();
    const state = new PlaybackState({ videoId: 'dQw4w9WgXcQ', clock });
    state.play();
    clock.advance(3);
    state.seek(120);
    assert.equal(state.snapshot().currentTime, 120);
    clock.advance(2);
    assert.deepEqual([state.snapshot().playState, state.snapshot().currentTime], ['playing', 122]);

    state.pause();
    state.seek(10);
    clock.advance(50);
    assert.deepEqual([state.snapshot().playState, state.snapshot().currentTime], ['paused', 10]);
  });

  test('play while already playing does not restart the timeline', () => {
    const clock = fakeClock();
    const state = new PlaybackState({ videoId: 'dQw4w9WgXcQ', clock });
    state.play();
    clock.advance(4);
    state.play();
    assert.equal(state.snapshot().currentTime, 4);
  });

  test('changing the video resets to paused at 0:00', () => {
    const clock = fakeClock();
    const state = new PlaybackState({ videoId: 'dQw4w9WgXcQ', clock });
    state.play();
    clock.advance(30);
    state.changeVideo('9bZkp7q19f0');
    const snap = state.snapshot();
    assert.deepEqual(
      [snap.videoId, snap.playState, snap.currentTime],
      ['9bZkp7q19f0', 'paused', 0],
    );
  });

  test('play, pause and seek without a video fail with NO_VIDEO', () => {
    const state = new PlaybackState({ clock: fakeClock() });
    for (const action of [() => state.play(), () => state.pause(), () => state.seek(5)]) {
      assert.throws(action, (err) => err.code === 'NO_VIDEO');
    }
  });
});

describe('RolePolicy', () => {
  test('host and moderator may control playback; participant and viewer may not', () => {
    assert.equal(RolePolicy.can(ROLES.HOST, ACTIONS.PLAYBACK_CONTROL), true);
    assert.equal(RolePolicy.can(ROLES.MODERATOR, ACTIONS.PLAYBACK_CONTROL), true);
    assert.equal(RolePolicy.can(ROLES.PARTICIPANT, ACTIONS.PLAYBACK_CONTROL), false);
    assert.equal(RolePolicy.can(ROLES.VIEWER, ACTIONS.PLAYBACK_CONTROL), false);
  });

  test('unknown roles and unknown actions are denied', () => {
    assert.equal(RolePolicy.can('admin', ACTIONS.PLAYBACK_CONTROL), false);
    assert.equal(RolePolicy.can(undefined, ACTIONS.PLAYBACK_CONTROL), false);
    assert.equal(RolePolicy.can(ROLES.HOST, 'something:else'), false);
  });
});

describe('extractVideoId', () => {
  const ID = 'dQw4w9WgXcQ';

  test('accepts a bare id and common link formats', () => {
    const valid = [
      ID,
      `  ${ID}  `,
      `https://www.youtube.com/watch?v=${ID}`,
      `https://www.youtube.com/watch?v=${ID}&t=42s&list=PL123`,
      `https://youtube.com/watch?feature=share&v=${ID}`,
      `youtube.com/watch?v=${ID}`,
      `https://m.youtube.com/watch?v=${ID}`,
      `https://music.youtube.com/watch?v=${ID}`,
      `https://youtu.be/${ID}`,
      `https://youtu.be/${ID}?t=10`,
      `https://www.youtube.com/embed/${ID}`,
      `https://www.youtube-nocookie.com/embed/${ID}`,
      `https://www.youtube.com/shorts/${ID}`,
      `https://www.youtube.com/live/${ID}`,
    ];
    for (const input of valid) assert.equal(extractVideoId(input), ID, input);
  });

  test('rejects anything else', () => {
    const invalid = [
      '',
      'hello',
      'dQw4w9WgXc', // 10 characters
      'dQw4w9WgXcQQ', // 12 characters
      'https://www.youtube.com/watch', // no v parameter
      'https://www.youtube.com/playlist?list=PL123',
      'https://www.youtube.com/@somechannel',
      'https://evil.com/watch?v=dQw4w9WgXcQ',
      'https://youtube.com.evil.com/watch?v=dQw4w9WgXcQ',
      'javascript:alert(1)',
      'https://www.youtube.com/watch?v=<script>alert(1)</script>',
      'https://youtu.be/',
    ];
    for (const input of invalid) assert.equal(extractVideoId(input), null, input);
  });
});

describe('TokenBucket', () => {
  test('allows a burst, then refuses, then refills over time', () => {
    const clock = fakeClock();
    const bucket = new TokenBucket({ capacity: 3, refillPerSecond: 1, clock });
    assert.deepEqual(
      [1, 2, 3, 4].map(() => bucket.tryConsume()),
      [true, true, true, false],
    );

    clock.advance(1);
    assert.equal(bucket.tryConsume(), true);
    assert.equal(bucket.tryConsume(), false);

    clock.advance(100); // refill never exceeds capacity
    assert.deepEqual(
      [1, 2, 3, 4].map(() => bucket.tryConsume()),
      [true, true, true, false],
    );
  });
});

describe('PlaybackHandler (defense in depth)', () => {
  // The join logic normally clears a replaced tab's room. This test proves the handler
  // refuses a stale connection even if that cleanup were ever missed.
  test('a socket that is no longer the registered one cannot control playback', async () => {
    const broadcasts = [];
    const room = new Room(
      { id: 'r', code: 'ABCD2345', hostUserId: 'host-user', videoId: 'dQw4w9WgXcQ' },
      { broadcaster: { emitToRoom: (...args) => broadcasts.push(args) }, capacity: 5 },
    );
    room.addParticipant(
      new Participant({
        userId: 'host-user',
        username: 'host',
        role: ROLES.HOST,
        socketId: 'new-socket',
      }),
    );

    const handlers = {};
    const staleSocket = {
      id: 'old-socket',
      data: { user: { userId: 'host-user', username: 'host' }, roomCode: 'ABCD2345' },
      on: (event, fn) => {
        handlers[event] = fn;
      },
    };
    const roomManager = { getActiveRoom: (code) => (code === 'ABCD2345' ? room : null) };
    new PlaybackHandler({ socket: staleSocket, roomManager, limiter: null }).register();

    const reply = await new Promise((resolve) => handlers.play({}, resolve));
    assert.deepEqual([reply.ok, reply.code], [false, 'NOT_IN_ROOM']);
    assert.equal(broadcasts.length, 0);
    assert.equal(room.playback.playState, 'paused');
  });
});
