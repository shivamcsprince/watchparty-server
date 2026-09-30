import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';

// Tests use fast hashing and a high rate limit. Must be set BEFORE the app is imported.
process.env.BCRYPT_ROUNDS = '4';
process.env.AUTH_RATE_LIMIT_MAX = '1000';

const { createApp } = await import('../src/app.js');
const { pool } = await import('../src/db/pool.js');

// Every test user has an email ending in this domain so cleanup can never touch real users.
const TEST_DOMAIN = '@watchparty-tests.invalid';
const unique = () => `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

let server;
let baseUrl;

async function post(path, body, headers = {}) {
  const res = await fetch(baseUrl + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function get(path, headers = {}) {
  const res = await fetch(baseUrl + path, { headers });
  return { status: res.status, body: await res.json() };
}

async function cleanup() {
  await pool.query('DELETE FROM users WHERE email LIKE $1', [`%${TEST_DOMAIN}`]);
}

before(async () => {
  await cleanup();
  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await cleanup();
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

describe('POST /api/auth/register', () => {
  test('creates a user and returns a token, never the password hash', async () => {
    const id = unique();
    const { status, body } = await post('/api/auth/register', {
      email: `${id}${TEST_DOMAIN}`,
      username: id.slice(0, 12),
      password: 'correct horse battery',
    });
    assert.equal(status, 201);
    assert.ok(body.token);
    assert.equal(body.user.email, `${id}${TEST_DOMAIN}`);
    assert.equal(body.user.passwordHash, undefined);
    assert.equal(body.user.password_hash, undefined);
  });

  test('rejects duplicate email (case-insensitive) with 409', async () => {
    const id = unique();
    const email = `${id}${TEST_DOMAIN}`;
    await post('/api/auth/register', { email, username: id.slice(0, 12), password: 'password123' });
    const { status, body } = await post('/api/auth/register', {
      email: email.toUpperCase(),
      username: `${id.slice(0, 10)}_2`,
      password: 'password123',
    });
    assert.equal(status, 409);
    assert.equal(body.details.field, 'email');
  });

  test('rejects duplicate username with 409', async () => {
    const a = unique();
    const b = unique();
    const username = a.slice(0, 12);
    await post('/api/auth/register', {
      email: `${a}${TEST_DOMAIN}`,
      username,
      password: 'password123',
    });
    const { status, body } = await post('/api/auth/register', {
      email: `${b}${TEST_DOMAIN}`,
      username: username.toUpperCase(),
      password: 'password123',
    });
    assert.equal(status, 409);
    assert.equal(body.details.field, 'username');
  });

  test('validates input (400 with field details)', async () => {
    const { status, body } = await post('/api/auth/register', {
      email: 'not-an-email',
      username: 'a',
      password: 'short',
    });
    assert.equal(status, 400);
    const fields = body.details.map((d) => d.field).sort();
    assert.deepEqual(fields, ['email', 'password', 'username']);
  });

  test('rejects passwords over 72 bytes', async () => {
    const id = unique();
    const { status } = await post('/api/auth/register', {
      email: `${id}${TEST_DOMAIN}`,
      username: id.slice(0, 12),
      password: 'x'.repeat(73),
    });
    assert.equal(status, 400);
  });

  test('rejects malformed JSON with 400', async () => {
    const { status } = await post('/api/auth/register', '{ not json');
    assert.equal(status, 400);
  });
});

describe('POST /api/auth/login and GET /api/auth/me', () => {
  const id = unique();
  const email = `${id}${TEST_DOMAIN}`;
  const password = 'correct horse battery';
  let token;

  before(async () => {
    const res = await post('/api/auth/register', { email, username: id.slice(0, 12), password });
    token = res.body.token;
  });

  test('logs in with correct credentials (email is case-insensitive)', async () => {
    const { status, body } = await post('/api/auth/login', {
      email: email.toUpperCase(),
      password,
    });
    assert.equal(status, 200);
    assert.ok(body.token);
  });

  test('wrong password and unknown email give the same 401 message', async () => {
    const wrong = await post('/api/auth/login', { email, password: 'wrong-password' });
    const unknown = await post('/api/auth/login', {
      email: `nobody${TEST_DOMAIN}`,
      password: 'whatever123',
    });
    assert.equal(wrong.status, 401);
    assert.equal(unknown.status, 401);
    assert.equal(wrong.body.error, unknown.body.error);
  });

  test('/me returns the profile with a valid token', async () => {
    const { status, body } = await get('/api/auth/me', { Authorization: `Bearer ${token}` });
    assert.equal(status, 200);
    assert.equal(body.user.email, email);
  });

  test('/me rejects missing, malformed and tampered tokens with 401', async () => {
    assert.equal((await get('/api/auth/me')).status, 401);
    assert.equal((await get('/api/auth/me', { Authorization: 'Bearer garbage' })).status, 401);
    const tampered = token.slice(0, -3) + (token.endsWith('aaa') ? 'bbb' : 'aaa');
    assert.equal((await get('/api/auth/me', { Authorization: `Bearer ${tampered}` })).status, 401);
  });
});
