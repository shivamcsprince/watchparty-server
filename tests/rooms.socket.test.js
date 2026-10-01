import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { io as connectClient } from 'socket.io-client';

process.env.BCRYPT_ROUNDS = '4';
process.env.AUTH_RATE_LIMIT_MAX = '1000';
process.env.ROOM_CREATE_RATE_LIMIT_MAX = '1000';
process.env.ROOM_CAPACITY = '3';

const { createServer } = await import('../src/server.js');
const { pool } = await import('../src/db/pool.js');

// A different domain from auth.test.js, because both files run in parallel and each cleans up its own.
const TEST_DOMAIN = '@watchparty-rooms-tests.invalid';
const unique = () => `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

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
      auth: token === undefined ? {} : { token },
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

async function cleanup() {
  await pool.query('DELETE FROM users WHERE email LIKE $1', [`%${TEST_DOMAIN}`]); // rooms cascade
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

describe('REST: rooms', () => {
  test('creating a room requires login and returns an 8-character code', async () => {
    assert.equal((await api('POST', '/api/rooms')).status, 401);

    const host = await registerUser();
    const { status, body } = await api('POST', '/api/rooms', { token: host.token });
    assert.equal(status, 201);
    assert.match(body.room.code, /^[A-HJ-NP-Z2-9]{8}$/);
    assert.equal(body.room.hostUserId, host.id);
  });

  test('GET room info: found, not found, invalid code', async () => {
    const host = await registerUser();
    const { body } = await api('POST', '/api/rooms', { token: host.token });

    const found = await api('GET', `/api/rooms/${body.room.code.toLowerCase()}`, {
      token: host.token,
    });
    assert.equal(found.status, 200);
    assert.equal(found.body.room.code, body.room.code);
    assert.equal(found.body.room.participantCount, 0);

    assert.equal((await api('GET', '/api/rooms/ZZZZ2222', { token: host.token })).status, 404);
    assert.equal((await api('GET', '/api/rooms/bad', { token: host.token })).status, 400);
  });
});

describe('Socket: authentication', () => {
  test('rejects connections without a token or with a bad token', async () => {
    await assert.rejects(connect(undefined), /Authentication required/);
    await assert.rejects(connect('garbage'), /Invalid or expired token/);
  });
});

describe('Socket: join / leave', () => {
  test('host joins as host, guest joins as participant, both see the same list', async () => {
    const host = await registerUser();
    const guest = await registerUser();
    const { body } = await api('POST', '/api/rooms', { token: host.token });
    const code = body.room.code;

    const hostSocket = await connect(host.token);
    const hostJoin = await emit(hostSocket, 'join_room', { roomId: code });
    assert.equal(hostJoin.ok, true);
    assert.equal(hostJoin.you.role, 'host');
    assert.equal(hostJoin.participants.length, 1);

    const guestSocket = await connect(guest.token);
    const joinedEvent = nextEvent(hostSocket, 'user_joined');
    const joinerGetsNoEcho = noEvent(guestSocket, 'user_joined'); // you don't get told about yourself
    const guestJoin = await emit(guestSocket, 'join_room', { roomId: code.toLowerCase() });
    assert.equal(guestJoin.you.role, 'participant');
    assert.equal(guestJoin.participants.length, 2);

    const event = await joinedEvent;
    await joinerGetsNoEcho;
    assert.equal(event.userId, guest.id);
    assert.equal(event.username, guest.username);
    assert.equal(event.role, 'participant');
    assert.deepEqual(
      event.participants.map((p) => p.role),
      ['host', 'participant'],
    );

    // Leaving notifies the others.
    const leftEvent = nextEvent(hostSocket, 'user_left');
    assert.equal((await emit(guestSocket, 'leave_room', {})).ok, true);
    const left = await leftEvent;
    assert.equal(left.userId, guest.id);
    assert.equal(left.participants.length, 1);
  });

  test('disconnecting also notifies the room', async () => {
    const host = await registerUser();
    const guest = await registerUser();
    const { body } = await api('POST', '/api/rooms', { token: host.token });

    const hostSocket = await connect(host.token);
    await emit(hostSocket, 'join_room', { roomId: body.room.code });
    const guestSocket = await connect(guest.token);
    await emit(guestSocket, 'join_room', { roomId: body.room.code });

    const leftEvent = nextEvent(hostSocket, 'user_left');
    guestSocket.close();
    assert.equal((await leftEvent).userId, guest.id);
  });

  test('a client cannot choose its own identity: username comes from the token', async () => {
    const host = await registerUser();
    const { body } = await api('POST', '/api/rooms', { token: host.token });
    const socket = await connect(host.token);
    const res = await emit(socket, 'join_room', {
      roomId: body.room.code,
      username: 'hacker',
      userId: 'someone-else',
      role: 'host',
    });
    assert.equal(res.you.username, host.username);
    assert.equal(res.you.userId, host.id);
  });

  test('errors: unknown room, invalid payload', async () => {
    const user = await registerUser();
    const socket = await connect(user.token);

    const missing = await emit(socket, 'join_room', { roomId: 'ZZZZ2222' });
    assert.deepEqual([missing.ok, missing.code], [false, 'ROOM_NOT_FOUND']);

    for (const bad of [undefined, null, {}, { roomId: 123 }, { roomId: 'nope' }]) {
      const res = await emit(socket, 'join_room', bad);
      assert.deepEqual([res.ok, res.code], [false, 'INVALID_REQUEST']);
    }
  });

  test('room capacity is enforced (capacity = 3 in this test)', async () => {
    const host = await registerUser();
    const { body } = await api('POST', '/api/rooms', { token: host.token });
    const users = [host, await registerUser(), await registerUser(), await registerUser()];

    const results = [];
    for (const u of users) {
      const socket = await connect(u.token);
      results.push(await emit(socket, 'join_room', { roomId: body.room.code }));
    }
    assert.deepEqual(
      results.map((r) => r.ok),
      [true, true, true, false],
    );
    assert.equal(results[3].code, 'ROOM_FULL');
  });

  test('second tab replaces the first: old tab is told, list does not change', async () => {
    const host = await registerUser();
    const guest = await registerUser();
    const { body } = await api('POST', '/api/rooms', { token: host.token });

    const hostSocket = await connect(host.token);
    await emit(hostSocket, 'join_room', { roomId: body.room.code });

    const tab1 = await connect(guest.token);
    await emit(tab1, 'join_room', { roomId: body.room.code });

    const replacedNotice = nextEvent(tab1, 'session_replaced');
    const noDuplicateJoin = noEvent(hostSocket, 'user_joined');
    const tab2 = await connect(guest.token);
    const res = await emit(tab2, 'join_room', { roomId: body.room.code });

    assert.equal(res.participants.length, 2);
    assert.equal((await replacedNotice).roomId, body.room.code);
    await noDuplicateJoin;

    // The old tab disconnecting must not remove the new tab's session.
    const noLeave = noEvent(hostSocket, 'user_left');
    tab1.close();
    await noLeave;
    const info = await api('GET', `/api/rooms/${body.room.code}`, { token: host.token });
    assert.equal(info.body.room.participantCount, 2);
  });

  test('joining another room moves the connection (one room per connection)', async () => {
    const host = await registerUser();
    const a = (await api('POST', '/api/rooms', { token: host.token })).body.room.code;
    const b = (await api('POST', '/api/rooms', { token: host.token })).body.room.code;
    const watcher = await registerUser();

    const hostSocket = await connect(host.token);
    await emit(hostSocket, 'join_room', { roomId: a });
    const watcherSocket = await connect(watcher.token);
    await emit(watcherSocket, 'join_room', { roomId: a });

    const leftEvent = nextEvent(hostSocket, 'user_left');
    await emit(watcherSocket, 'join_room', { roomId: b });
    assert.equal((await leftEvent).userId, watcher.id);
  });

  test('a returning participant gets the default role again', async () => {
    const host = await registerUser();
    const guest = await registerUser();
    const { body } = await api('POST', '/api/rooms', { token: host.token });
    const hostSocket = await connect(host.token);
    await emit(hostSocket, 'join_room', { roomId: body.room.code });

    const first = await connect(guest.token);
    await emit(first, 'join_room', { roomId: body.room.code });
    await emit(first, 'leave_room', {});
    const second = await connect(guest.token);
    const res = await emit(second, 'join_room', { roomId: body.room.code });
    assert.equal(res.you.role, 'participant');
  });
});
