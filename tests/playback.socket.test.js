import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { io as connectClient } from 'socket.io-client';

process.env.BCRYPT_ROUNDS = '4';
process.env.AUTH_RATE_LIMIT_MAX = '1000';
process.env.ROOM_CREATE_RATE_LIMIT_MAX = '1000';

const { createServer } = await import('../src/server.js');
const { pool } = await import('../src/db/pool.js');

// Unique domain: test files run in parallel and each cleans up only its own users.
const TEST_DOMAIN = '@watchparty-playback-tests.invalid';
const VIDEO_A = 'dQw4w9WgXcQ';
const VIDEO_B = '9bZkp7q19f0';
const unique = () => `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let server;
let baseUrl;
const openSockets = [];

async function api(method, path, { token, body } = {}) {
  const res = await fetch(baseUrl + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

async function registerUser() {
  const id = unique();
  const { body } = await api('POST', '/api/auth/register', {
    body: { email: `${id}${TEST_DOMAIN}`, username: id.slice(0, 12), password: 'password123' },
  });
  return { ...body.user, token: body.token };
}

function connect(token) {
  return new Promise((resolve, reject) => {
    const socket = connectClient(baseUrl, {
      auth: { token },
      transports: ['websocket'],
      reconnection: false,
    });
    openSockets.push(socket);
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}

const emit = (socket, event, payload) =>
  new Promise((resolve) => socket.emit(event, payload, resolve));

const nextEvent = (socket, event, timeoutMs = 2000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out waiting for "${event}"`)),
      timeoutMs,
    );
    socket.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });

const noEvent = (socket, event, ms = 300) =>
  new Promise((resolve, reject) => {
    const handler = () => reject(new Error(`Unexpected "${event}" event`));
    socket.once(event, handler);
    setTimeout(() => {
      socket.off(event, handler);
      resolve();
    }, ms);
  });

/** Creates a room with a host and one participant, both connected and joined. */
async function setupRoom() {
  const host = await registerUser();
  const guest = await registerUser();
  const { body } = await api('POST', '/api/rooms', { token: host.token });
  const code = body.room.code;

  const hostSocket = await connect(host.token);
  await emit(hostSocket, 'join_room', { roomId: code });
  const guestSocket = await connect(guest.token);
  await emit(guestSocket, 'join_room', { roomId: code });
  return { host, guest, code, hostSocket, guestSocket };
}

async function cleanup() {
  await pool.query('DELETE FROM users WHERE email LIKE $1', [`%${TEST_DOMAIN}`]);
}

before(async () => {
  await cleanup();
  server = createServer();
  await new Promise((resolve) => server.httpServer.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.httpServer.address().port}`;
});

after(async () => {
  openSockets.forEach((socket) => socket.close());
  await server.socketServer.close();
  await cleanup();
  await pool.end();
});

describe('playback: host control and broadcast', () => {
  test('a new room has no video and everyone can see that on join', async () => {
    const { hostSocket } = await setupRoom();
    const sync = await emit(hostSocket, 'request_sync');
    assert.deepEqual(
      [sync.playback.videoId, sync.playback.playState, sync.playback.currentTime],
      [null, 'paused', 0],
    );
  });

  test('play/pause/seek without a video -> NO_VIDEO', async () => {
    const { hostSocket } = await setupRoom();
    for (const [event, payload] of [['play'], ['pause'], ['seek', { time: 5 }]]) {
      const res = await emit(hostSocket, event, payload);
      assert.deepEqual([res.ok, res.code], [false, 'NO_VIDEO']);
    }
  });

  test('change_video accepts a pasted link and everyone (including the sender) gets sync_state', async () => {
    const { host, hostSocket, guestSocket } = await setupRoom();
    const hostSees = nextEvent(hostSocket, 'sync_state');
    const guestSees = nextEvent(guestSocket, 'sync_state');

    const res = await emit(hostSocket, 'change_video', {
      videoId: `https://www.youtube.com/watch?v=${VIDEO_A}&t=30s`,
    });
    assert.equal(res.ok, true);
    assert.equal(res.playback.videoId, VIDEO_A);

    for (const event of [await hostSees, await guestSees]) {
      assert.equal(event.videoId, VIDEO_A);
      assert.equal(event.playState, 'paused');
      assert.equal(event.currentTime, 0);
      assert.equal(event.action, 'change_video');
      assert.equal(event.by.userId, host.id);
      assert.equal(typeof event.serverTime, 'number');
    }
  });

  test('play, seek and pause are broadcast to the participant', async () => {
    const { hostSocket, guestSocket } = await setupRoom();
    // Wait for the guest to receive the change_video broadcast before moving on,
    // otherwise that earlier event could be mistaken for the next one.
    let seen = nextEvent(guestSocket, 'sync_state');
    await emit(hostSocket, 'change_video', { videoId: VIDEO_A });
    assert.equal((await seen).action, 'change_video');

    seen = nextEvent(guestSocket, 'sync_state');
    await emit(hostSocket, 'play');
    let event = await seen;
    assert.deepEqual([event.action, event.playState], ['play', 'playing']);

    seen = nextEvent(guestSocket, 'sync_state');
    await emit(hostSocket, 'seek', { time: 90 });
    event = await seen;
    assert.deepEqual([event.action, event.playState], ['seek', 'playing']);
    assert.ok(event.currentTime >= 90 && event.currentTime < 92);

    seen = nextEvent(guestSocket, 'sync_state');
    await emit(hostSocket, 'pause');
    event = await seen;
    assert.deepEqual([event.action, event.playState], ['pause', 'paused']);
    assert.ok(event.currentTime >= 90 && event.currentTime < 92);
  });

  test('a late joiner receives the live position, not the stale one', async () => {
    const { code, hostSocket } = await setupRoom();
    await emit(hostSocket, 'change_video', { videoId: VIDEO_A });
    await emit(hostSocket, 'seek', { time: 50 });
    await emit(hostSocket, 'play');
    await sleep(1200);

    const late = await registerUser();
    const lateSocket = await connect(late.token);
    const res = await emit(lateSocket, 'join_room', { roomId: code });
    assert.equal(res.playback.playState, 'playing');
    assert.equal(res.playback.videoId, VIDEO_A);
    assert.ok(
      res.playback.currentTime >= 51.1 && res.playback.currentTime < 53,
      res.playback.currentTime,
    );
  });
});

describe('playback: validation', () => {
  test('rejects invalid links and invalid seek times', async () => {
    const { hostSocket } = await setupRoom();
    await emit(hostSocket, 'change_video', { videoId: VIDEO_A });

    for (const bad of [undefined, {}, { videoId: 123 }, { videoId: 'https://evil.com/x' }]) {
      const res = await emit(hostSocket, 'change_video', bad);
      assert.deepEqual([res.ok, res.code], [false, 'INVALID_REQUEST']);
    }
    for (const bad of [
      undefined,
      {},
      { time: -1 },
      { time: 'abc' },
      { time: null },
      { time: 1e12 },
    ]) {
      const res = await emit(hostSocket, 'seek', bad);
      assert.deepEqual([res.ok, res.code], [false, 'INVALID_REQUEST']);
    }
  });
});

describe('playback: permissions (enforced on the server)', () => {
  test('a participant cannot play, pause, seek or change the video, and nobody is notified', async () => {
    const { hostSocket, guestSocket } = await setupRoom();
    await emit(hostSocket, 'change_video', { videoId: VIDEO_A });
    const before = (await emit(hostSocket, 'request_sync')).playback;

    const quiet = noEvent(hostSocket, 'sync_state');
    for (const [event, payload] of [
      ['play'],
      ['pause'],
      ['seek', { time: 99 }],
      ['change_video', { videoId: VIDEO_B }],
    ]) {
      const res = await emit(guestSocket, event, payload);
      assert.deepEqual([res.ok, res.code], [false, 'FORBIDDEN'], event);
    }
    await quiet;

    const after = (await emit(hostSocket, 'request_sync')).playback;
    assert.equal(after.videoId, VIDEO_A);
    assert.equal(after.playState, before.playState);
    assert.equal(after.currentTime, before.currentTime);
  });

  test('a client cannot claim a role in the payload', async () => {
    const { guestSocket } = await setupRoom();
    const res = await emit(guestSocket, 'play', { role: 'host', userId: 'whoever' });
    assert.equal(res.code, 'FORBIDDEN');
  });

  test('a user who has not joined a room cannot control or sync anything', async () => {
    const user = await registerUser();
    const socket = await connect(user.token);
    for (const event of ['play', 'request_sync']) {
      const res = await emit(socket, event);
      assert.deepEqual([res.ok, res.code], [false, 'NOT_IN_ROOM'], event);
    }
  });

  test('a replaced (old) tab loses its right to act; the new tab keeps it', async () => {
    const host = await registerUser();
    const { body } = await api('POST', '/api/rooms', { token: host.token });
    const oldTab = await connect(host.token);
    await emit(oldTab, 'join_room', { roomId: body.room.code });
    const newTab = await connect(host.token);
    await emit(newTab, 'join_room', { roomId: body.room.code });

    assert.equal((await emit(oldTab, 'change_video', { videoId: VIDEO_A })).code, 'NOT_IN_ROOM');
    assert.equal((await emit(newTab, 'change_video', { videoId: VIDEO_A })).ok, true);
  });

  test('a participant who leaves cannot keep controlling the room', async () => {
    const { hostSocket, guestSocket } = await setupRoom();
    await emit(guestSocket, 'leave_room', {});
    assert.equal((await emit(guestSocket, 'request_sync')).code, 'NOT_IN_ROOM');
    assert.equal((await emit(hostSocket, 'request_sync')).ok, true);
  });
});

describe('playback: rate limiting and persistence', () => {
  test('a client that floods events is rate limited', async () => {
    const { guestSocket } = await setupRoom();
    const results = await Promise.all(
      Array.from({ length: 60 }, () => emit(guestSocket, 'request_sync')),
    );
    assert.ok(results.some((r) => r.ok === true));
    assert.ok(results.some((r) => r.code === 'RATE_LIMITED'));
  });

  test('the current video is saved and restored when the room is reloaded', async () => {
    const { host, code, hostSocket, guestSocket } = await setupRoom();
    await emit(hostSocket, 'change_video', { videoId: VIDEO_B });
    await emit(hostSocket, 'seek', { time: 77 });
    await emit(hostSocket, 'play');

    // Persistence runs in the background, so wait until the database has it.
    let saved;
    for (let i = 0; i < 20 && saved !== VIDEO_B; i += 1) {
      await sleep(50);
      saved = (await pool.query('SELECT video_id FROM rooms WHERE code = $1', [code])).rows[0]
        .video_id;
    }
    assert.equal(saved, VIDEO_B);

    // Everyone leaves, so the room is dropped from memory; the next join reloads it from the database.
    await emit(hostSocket, 'leave_room', {});
    await emit(guestSocket, 'leave_room', {});
    assert.equal(server.roomManager.getActiveRoom(code), null);

    const returning = await connect(host.token);
    const res = await emit(returning, 'join_room', { roomId: code });
    assert.equal(res.playback.videoId, VIDEO_B);
    assert.deepEqual([res.playback.playState, res.playback.currentTime], ['paused', 0]);
  });
});
