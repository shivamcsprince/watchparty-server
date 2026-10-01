// Shared helpers for socket integration tests.
// Test files must set process.env (BCRYPT_ROUNDS etc.) BEFORE importing this module.
import { io as connectClient } from 'socket.io-client';
import { createServer } from '../../src/server.js';
import { pool } from '../../src/db/pool.js';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const VIDEO_A = 'dQw4w9WgXcQ';
export const VIDEO_B = '9bZkp7q19f0';

const unique = () => `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export const emit = (socket, event, payload) =>
  new Promise((resolve) => socket.emit(event, payload, resolve));

export const nextEvent = (socket, event, timeoutMs = 2000) =>
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

/** Resolves if the event does NOT arrive within `ms`; rejects if it does. */
export const noEvent = (socket, event, ms = 300) =>
  new Promise((resolve, reject) => {
    const handler = () => reject(new Error(`Unexpected "${event}" event`));
    socket.once(event, handler);
    setTimeout(() => {
      socket.off(event, handler);
      resolve();
    }, ms);
  });

/** Records every listed event in order, so tests can check what happened and in which order. */
export function record(socket, events) {
  const log = [];
  for (const event of events) socket.on(event, (payload) => log.push({ event, payload }));
  return log;
}

/** Polls until `check()` returns a truthy value (used for background work like database saves). */
export async function waitFor(check, { timeoutMs = 2000, intervalMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await sleep(intervalMs);
  }
}

export async function cleanupUsers(domain) {
  await pool.query('DELETE FROM users WHERE email LIKE $1', [`%${domain}`]); // rooms cascade
}

export const closePool = () => pool.end();
export { pool };

/** Starts a real server on a random port. `overrides` set timings (hostGraceMs, requestTtlMs, capacity). */
export async function createHarness({ domain, ...overrides }) {
  const server = createServer(overrides);
  await new Promise((resolve) => server.httpServer.listen(0, resolve));
  const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}`;
  const sockets = [];

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
      body: { email: `${id}${domain}`, username: id.slice(0, 12), password: 'password123' },
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
      sockets.push(socket);
      socket.once('connect', () => resolve(socket));
      socket.once('connect_error', reject);
    });
  }

  /** Connects a user's socket and joins the room. Returns { socket, res }. */
  async function join(user, code) {
    const socket = await connect(user.token);
    const res = await emit(socket, 'join_room', { roomId: code });
    return { user, socket, res };
  }

  /**
   * Creates a room. The host and `guests` participants all connect and join, in that order.
   * (Pass joinHost: false to create the room without the host connecting.)
   */
  async function setupRoom({ guests = 1, joinHost = true } = {}) {
    const hostUser = await registerUser();
    const { body } = await api('POST', '/api/rooms', { token: hostUser.token });
    const code = body.room.code;

    const host = joinHost ? await join(hostUser, code) : { user: hostUser, socket: null };
    const members = [];
    for (let i = 0; i < guests; i += 1) members.push(await join(await registerUser(), code));
    return { code, host, members };
  }

  async function stop() {
    sockets.forEach((socket) => socket.close());
    await server.socketServer.close();
  }

  return { server, baseUrl, api, registerUser, connect, join, setupRoom, stop };
}
