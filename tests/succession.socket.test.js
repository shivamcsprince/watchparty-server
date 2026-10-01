import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.BCRYPT_ROUNDS = '4';
process.env.AUTH_RATE_LIMIT_MAX = '1000';
process.env.ROOM_CREATE_RATE_LIMIT_MAX = '1000';

const {
  VIDEO_A,
  cleanupUsers,
  closePool,
  createHarness,
  emit,
  noEvent,
  nextEvent,
  pool,
  record,
  sleep,
  waitFor,
} = await import('./helpers/harness.js');

const DOMAIN = '@watchparty-succession-tests.invalid';
const GRACE_MS = 500;

let h;

before(async () => {
  await cleanupUsers(DOMAIN);
  h = await createHarness({ domain: DOMAIN, hostGraceMs: GRACE_MS });
});

after(async () => {
  await h.stop();
  await cleanupUsers(DOMAIN);
  await closePool();
});

const hostInDb = async (code) =>
  (await pool.query('SELECT host_user_id FROM rooms WHERE code = $1', [code])).rows[0].host_user_id;

describe('host leaves on purpose (Leave button)', () => {
  test('a moderator takes over immediately, after everyone hears the host left; it is saved', async () => {
    const { code, host, members } = await h.setupRoom({ guests: 3 });
    const [participant, moderator, other] = members; // the moderator joined AFTER the participant
    await emit(host.socket, 'assign_role', { userId: moderator.user.id, role: 'moderator' });
    await sleep(50);
    const log = record(other.socket, ['user_left', 'role_assigned']);

    await emit(host.socket, 'leave_room');
    await waitFor(() => log.length >= 2);

    assert.deepEqual(
      log.map((e) => e.event),
      ['user_left', 'role_assigned'],
    );
    const promotion = log[1].payload;
    assert.deepEqual(
      [promotion.userId, promotion.role, promotion.reason],
      [moderator.user.id, 'host', 'host_left'],
    );
    assert.deepEqual(
      promotion.participants.map((p) => p.role),
      ['participant', 'host', 'participant'],
    );
    assert.equal(await waitFor(async () => (await hostInDb(code)) === moderator.user.id), true);

    // The new host really has host powers; the older participant still does not.
    assert.equal((await emit(moderator.socket, 'change_video', { videoId: VIDEO_A })).ok, true);
    assert.equal((await emit(participant.socket, 'play')).code, 'FORBIDDEN');
  });

  test('the old host comes back as a plain participant', async () => {
    const { code, host, members } = await h.setupRoom({ guests: 1 });
    await emit(host.socket, 'leave_room');
    await waitFor(async () => (await hostInDb(code)) === members[0].user.id);

    const back = await h.join(host.user, code);
    assert.equal(back.res.you.role, 'participant');
    assert.equal((await emit(back.socket, 'play')).code, 'FORBIDDEN');
  });

  test('with no moderator, the longest-present participant is chosen; viewers only as a last resort', async () => {
    const { host, members } = await h.setupRoom({ guests: 3 });
    const [viewer, older, newer] = members; // the viewer is the OLDEST of the three
    const log = record(viewer.socket, ['role_assigned']); // events arrive in order, so count them
    await emit(host.socket, 'assign_role', { userId: viewer.user.id, role: 'viewer' });
    await waitFor(() => log.length >= 1);

    await emit(host.socket, 'leave_room');
    await waitFor(() => log.length >= 2);
    // the oldest *participant* is chosen, not the older viewer
    assert.equal(log[1].payload.userId, older.user.id);

    // The new host leaves too: only the viewer and one participant remain.
    await emit(older.socket, 'leave_room');
    await waitFor(() => log.length >= 3);
    assert.equal(log[2].payload.userId, newer.user.id);

    // Last resort: only the viewer is left.
    await emit(newer.socket, 'leave_room');
    await waitFor(() => log.length >= 4);
    assert.deepEqual([log[3].payload.userId, log[3].payload.role], [viewer.user.id, 'host']);
  });

  test('a leaving non-host triggers no succession', async () => {
    const { host, members } = await h.setupRoom({ guests: 2 });
    const quiet = noEvent(host.socket, 'role_assigned', GRACE_MS + 300);
    await emit(members[0].socket, 'leave_room');
    await quiet;
  });
});

describe('host connection drops (grace period)', () => {
  test('nobody is promoted during the grace period, and a returning host keeps the role', async () => {
    const { code, host, members } = await h.setupRoom({ guests: 1 });
    const [guest] = members;
    const quiet = noEvent(guest.socket, 'role_assigned', GRACE_MS + 400);

    host.socket.close(); // connection lost, not the Leave button
    await sleep(GRACE_MS / 3);
    const back = await h.join(host.user, code); // reconnects in time
    assert.equal(back.res.you.role, 'host');

    await quiet; // and nothing happens once the grace period would have ended
    assert.equal(await hostInDb(code), host.user.id);
    assert.equal((await emit(back.socket, 'change_video', { videoId: VIDEO_A })).ok, true);
  });

  test('a host who stays away is replaced when the grace period ends', async () => {
    const { code, host, members } = await h.setupRoom({ guests: 2 });
    const [participant, moderator] = members;
    await emit(host.socket, 'assign_role', { userId: moderator.user.id, role: 'moderator' });
    await sleep(50);

    const early = noEvent(participant.socket, 'role_assigned', GRACE_MS - 200);
    host.socket.close();
    await early; // still waiting

    const promotion = await nextEvent(participant.socket, 'role_assigned', GRACE_MS + 1000);
    assert.deepEqual(
      [promotion.userId, promotion.role, promotion.reason],
      [moderator.user.id, 'host', 'host_timeout'],
    );
    assert.equal(await waitFor(async () => (await hostInDb(code)) === moderator.user.id), true);

    // Late return: now just a participant.
    const late = await h.join(host.user, code);
    assert.equal(late.res.you.role, 'participant');
  });

  test('if the host never connects, the countdown starts when the first other person arrives', async () => {
    const { code, members } = await h.setupRoom({ guests: 1, joinHost: false });
    const promotion = await nextEvent(members[0].socket, 'role_assigned', GRACE_MS + 1500);
    assert.deepEqual([promotion.userId, promotion.reason], [members[0].user.id, 'host_timeout']);
    assert.equal(await waitFor(async () => (await hostInDb(code)) === members[0].user.id), true);
  });

  test('a host who is alone and disconnects leaves an empty room with no promotion', async () => {
    const { code, host } = await h.setupRoom({ guests: 0 });
    host.socket.close();
    await waitFor(() => h.server.roomManager.getActiveRoom(code) === null);
    await sleep(GRACE_MS + 200);
    assert.equal(await hostInDb(code), host.user.id);

    // They can come back and are still the host.
    const back = await h.join(host.user, code);
    assert.equal(back.res.you.role, 'host');
  });
});
