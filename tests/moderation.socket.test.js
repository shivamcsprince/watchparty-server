import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.BCRYPT_ROUNDS = '4';
process.env.AUTH_RATE_LIMIT_MAX = '1000';
process.env.ROOM_CREATE_RATE_LIMIT_MAX = '1000';

const {
  VIDEO_A,
  VIDEO_B,
  cleanupUsers,
  closePool,
  createHarness,
  emit,
  nextEvent,
  noEvent,
  record,
  sleep,
} = await import('./helpers/harness.js');

// Unique per test file: files run in parallel and each cleans up only its own users.
const DOMAIN = '@watchparty-moderation-tests.invalid';

let h; // main harness (requests live for 5 seconds)
let shortLived; // harness where requests expire after 400 ms

before(async () => {
  await cleanupUsers(DOMAIN);
  h = await createHarness({ domain: DOMAIN, requestTtlMs: 5000 });
  shortLived = await createHarness({ domain: DOMAIN, requestTtlMs: 400 });
});

after(async () => {
  await h.stop();
  await shortLived.stop();
  await cleanupUsers(DOMAIN);
  await closePool();
});

const roleOf = (list, userId) => list.find((p) => p.userId === userId)?.role;

describe('assign_role', () => {
  test('host promotes a participant to moderator; everyone is told; the new moderator can control playback', async () => {
    const { code, host, members } = await h.setupRoom({ guests: 2 });
    const [target, bystander] = members;

    const everyone = [host, target, bystander].map((m) => nextEvent(m.socket, 'role_assigned'));
    const res = await emit(host.socket, 'assign_role', {
      userId: target.user.id,
      role: 'moderator',
    });
    assert.equal(res.ok, true);
    assert.equal(roleOf(res.participants, target.user.id), 'moderator');

    for (const event of await Promise.all(everyone)) {
      assert.equal(event.userId, target.user.id);
      assert.equal(event.role, 'moderator');
      assert.equal(roleOf(event.participants, target.user.id), 'moderator');
    }

    // Before: forbidden. After: allowed. The bystander is still forbidden.
    assert.equal((await emit(target.socket, 'change_video', { videoId: VIDEO_A })).ok, true);
    assert.equal(
      (await emit(bystander.socket, 'change_video', { videoId: VIDEO_B })).code,
      'FORBIDDEN',
    );

    // A returning/reconnecting person's view of the room reflects the new role too.
    const info = await emit((await h.join(await h.registerUser(), code)).socket, 'request_sync');
    assert.equal(info.playback.videoId, VIDEO_A);
  });

  test('demoting to viewer removes control and the ability to request', async () => {
    const { host, members } = await h.setupRoom({ guests: 1 });
    const [member] = members;
    await emit(host.socket, 'assign_role', { userId: member.user.id, role: 'moderator' });
    await emit(host.socket, 'assign_role', { userId: member.user.id, role: 'viewer' });

    assert.equal((await emit(member.socket, 'play')).code, 'FORBIDDEN');
    assert.equal(
      (await emit(member.socket, 'request_action', { action: 'play' })).code,
      'FORBIDDEN',
    );
  });

  test('only the host may assign roles', async () => {
    const { host, members } = await h.setupRoom({ guests: 3 });
    const [mod, participant, victim] = members;
    await emit(host.socket, 'assign_role', { userId: mod.user.id, role: 'moderator' });

    for (const actor of [mod, participant]) {
      const res = await emit(actor.socket, 'assign_role', {
        userId: victim.user.id,
        role: 'viewer',
      });
      assert.deepEqual([res.ok, res.code], [false, 'FORBIDDEN']);
    }
    // ...and the victim's role did not change.
    const state = await emit(host.socket, 'assign_role', {
      userId: victim.user.id,
      role: 'participant',
    });
    assert.equal(roleOf(state.participants, victim.user.id), 'participant');
  });

  test('invalid requests: host role, unknown role, yourself, someone who is not here, bad payload', async () => {
    const { host, members } = await h.setupRoom({ guests: 1 });
    const [member] = members;
    const outsider = await h.registerUser();

    const cases = [
      [{ userId: member.user.id, role: 'host' }, 'INVALID_REQUEST'],
      [{ userId: member.user.id, role: 'admin' }, 'INVALID_REQUEST'],
      [{ userId: host.user.id, role: 'viewer' }, 'INVALID_TARGET'],
      [{ userId: outsider.id, role: 'viewer' }, 'PARTICIPANT_NOT_FOUND'],
      [{ role: 'viewer' }, 'INVALID_REQUEST'],
      [undefined, 'INVALID_REQUEST'],
    ];
    for (const [payload, code] of cases) {
      const res = await emit(host.socket, 'assign_role', payload);
      assert.deepEqual([res.ok, res.code], [false, code], JSON.stringify(payload));
    }
    // The host is still the host.
    const check = await emit(host.socket, 'change_video', { videoId: VIDEO_A });
    assert.equal(check.ok, true);
  });

  test('assigning the role someone already has succeeds quietly (no broadcast)', async () => {
    const { host, members } = await h.setupRoom({ guests: 1 });
    const quiet = noEvent(members[0].socket, 'role_assigned');
    const res = await emit(host.socket, 'assign_role', {
      userId: members[0].user.id,
      role: 'participant',
    });
    assert.equal(res.ok, true);
    await quiet;
  });
});

describe('remove_participant (kick)', () => {
  test('host removes someone: everyone including the target is told, and the target loses access', async () => {
    const { code, host, members } = await h.setupRoom({ guests: 2 });
    const [target, other] = members;
    await emit(host.socket, 'change_video', { videoId: VIDEO_A });

    const heard = [host, target, other].map((m) => nextEvent(m.socket, 'participant_removed'));
    const res = await emit(host.socket, 'remove_participant', { userId: target.user.id });
    assert.equal(res.ok, true);
    assert.equal(res.participants.length, 2);

    for (const event of await Promise.all(heard)) {
      assert.equal(event.userId, target.user.id);
      assert.equal(event.participants.length, 2);
      assert.ok(!event.participants.some((p) => p.userId === target.user.id));
    }

    // The removed connection can no longer do anything in the room...
    assert.equal((await emit(target.socket, 'request_sync')).code, 'NOT_IN_ROOM');
    assert.equal(
      (await emit(target.socket, 'request_action', { action: 'play' })).code,
      'NOT_IN_ROOM',
    );
    // ...and does not hear about the room any more.
    const silent = noEvent(target.socket, 'sync_state');
    await emit(host.socket, 'play');
    await silent;

    // Kick, not ban: they can rejoin with the code, as a plain participant.
    const back = await emit(target.socket, 'join_room', { roomId: code });
    assert.equal(back.ok, true);
    assert.equal(back.you.role, 'participant');
  });

  test('closing the removed connection afterwards does not announce a second departure', async () => {
    const { host, members } = await h.setupRoom({ guests: 1 });
    await emit(host.socket, 'remove_participant', { userId: members[0].user.id });
    const quiet = noEvent(host.socket, 'user_left');
    members[0].socket.close();
    await quiet;
  });

  test('only the host may remove people; the host cannot be removed or remove themselves', async () => {
    const { host, members } = await h.setupRoom({ guests: 3 });
    const [mod, participant, victim] = members;
    await emit(host.socket, 'assign_role', { userId: mod.user.id, role: 'moderator' });

    for (const actor of [mod, participant]) {
      const res = await emit(actor.socket, 'remove_participant', { userId: victim.user.id });
      assert.deepEqual([res.ok, res.code], [false, 'FORBIDDEN']);
    }
    assert.equal(
      (await emit(mod.socket, 'remove_participant', { userId: host.user.id })).code,
      'FORBIDDEN',
    );
    assert.equal(
      (await emit(host.socket, 'remove_participant', { userId: host.user.id })).code,
      'INVALID_TARGET',
    );
    assert.equal(
      (await emit(host.socket, 'remove_participant', { userId: 'nobody' })).code,
      'PARTICIPANT_NOT_FOUND',
    );
    assert.equal((await emit(host.socket, 'remove_participant', {})).code, 'INVALID_REQUEST');

    // Everyone is still in the room.
    const state = await emit(host.socket, 'assign_role', {
      userId: victim.user.id,
      role: 'participant',
    });
    assert.equal(state.participants.length, 4);
  });
});

describe('approval requests', () => {
  /** host + moderator + two participants + one viewer, with a video loaded. */
  async function setupCast(harness = h) {
    const { code, host, members } = await harness.setupRoom({ guests: 4 });
    const [moderator, p1, p2, viewer] = members;
    await emit(host.socket, 'assign_role', { userId: moderator.user.id, role: 'moderator' });
    await emit(host.socket, 'assign_role', { userId: viewer.user.id, role: 'viewer' });
    await emit(host.socket, 'change_video', { videoId: VIDEO_A });
    await sleep(50); // let the setup broadcasts settle before tests start listening
    return { code, host, moderator, p1, p2, viewer };
  }

  test('a request reaches the host, moderators and the requester only', async () => {
    const { host, moderator, p1, p2, viewer } = await setupCast();
    const seen = [host, moderator, p1].map((m) => nextEvent(m.socket, 'request_created'));
    const silentP2 = noEvent(p2.socket, 'request_created');
    const silentViewer = noEvent(viewer.socket, 'request_created');

    const res = await emit(p1.socket, 'request_action', { action: 'seek', time: 90 });
    assert.equal(res.ok, true);
    assert.deepEqual(
      [res.request.action, res.request.params, res.request.requestedBy.userId],
      ['seek', { time: 90 }, p1.user.id],
    );
    assert.ok(Date.parse(res.request.expiresAt) > Date.now());

    for (const event of await Promise.all(seen)) assert.equal(event.request.id, res.request.id);
    await silentP2;
    await silentViewer;
  });

  test('approving applies the action for everyone, credited to the requester and approver', async () => {
    const { host, moderator, p1, p2 } = await setupCast();
    const { request } = await emit(p1.socket, 'request_action', { action: 'seek', time: 120 });

    const syncs = [host, moderator, p1, p2].map((m) => nextEvent(m.socket, 'sync_state'));
    const resolved = [host, moderator, p1].map((m) => nextEvent(m.socket, 'request_resolved'));
    const silentP2 = noEvent(p2.socket, 'request_resolved');

    const res = await emit(moderator.socket, 'resolve_request', {
      requestId: request.id,
      decision: 'approve',
    });
    assert.deepEqual([res.ok, res.status], [true, 'approved']);

    for (const sync of await Promise.all(syncs)) {
      assert.equal(sync.action, 'seek');
      assert.ok(sync.currentTime >= 120 && sync.currentTime < 122);
      assert.equal(sync.by.userId, p1.user.id);
      assert.equal(sync.approvedBy.userId, moderator.user.id);
    }
    for (const event of await Promise.all(resolved)) {
      assert.equal(event.status, 'approved');
      assert.equal(event.requestId, request.id);
      assert.equal(event.resolvedBy.userId, moderator.user.id);
    }
    await silentP2;
  });

  test('a participant can request a video change using a pasted link', async () => {
    const { host, p1 } = await setupCast();
    const { request } = await emit(p1.socket, 'request_action', {
      action: 'change_video',
      videoId: `https://youtu.be/${VIDEO_B}?t=5`,
    });
    assert.deepEqual(request.params, { videoId: VIDEO_B });

    const sync = nextEvent(p1.socket, 'sync_state');
    await emit(host.socket, 'resolve_request', { requestId: request.id, decision: 'approve' });
    const event = await sync;
    assert.deepEqual([event.videoId, event.playState, event.currentTime], [VIDEO_B, 'paused', 0]);
  });

  test('rejecting changes nothing, and tells the requester', async () => {
    const { host, p1 } = await setupCast();
    const before = (await emit(host.socket, 'request_sync')).playback;
    const { request } = await emit(p1.socket, 'request_action', { action: 'play' });

    const verdict = nextEvent(p1.socket, 'request_resolved');
    const silent = noEvent(host.socket, 'sync_state');
    assert.equal(
      (await emit(host.socket, 'resolve_request', { requestId: request.id, decision: 'reject' }))
        .status,
      'rejected',
    );
    assert.equal((await verdict).status, 'rejected');
    await silent;

    const after = (await emit(host.socket, 'request_sync')).playback;
    assert.equal(after.playState, before.playState);
  });

  test('the first decision wins: a second approver finds nothing to answer', async () => {
    const { host, moderator, p1 } = await setupCast();
    const { request } = await emit(p1.socket, 'request_action', { action: 'play' });

    const first = await emit(host.socket, 'resolve_request', {
      requestId: request.id,
      decision: 'approve',
    });
    const second = await emit(moderator.socket, 'resolve_request', {
      requestId: request.id,
      decision: 'reject',
    });
    assert.equal(first.ok, true);
    assert.deepEqual([second.ok, second.code], [false, 'REQUEST_NOT_FOUND']);

    const state = (await emit(host.socket, 'request_sync')).playback;
    assert.equal(state.playState, 'playing'); // the late rejection had no effect
  });

  test('simultaneous approvals apply the action only once', async () => {
    const { host, moderator, p1 } = await setupCast();
    const { request } = await emit(p1.socket, 'request_action', { action: 'seek', time: 30 });
    const syncs = [];
    host.socket.on('sync_state', (s) => syncs.push(s));

    const results = await Promise.all([
      emit(host.socket, 'resolve_request', { requestId: request.id, decision: 'approve' }),
      emit(moderator.socket, 'resolve_request', { requestId: request.id, decision: 'approve' }),
    ]);
    await sleep(150);
    assert.equal(results.filter((r) => r.ok).length, 1);
    assert.equal(syncs.filter((s) => s.action === 'seek').length, 1);
  });

  test('who may request and who may answer', async () => {
    const { host, moderator, p1, p2, viewer } = await setupCast();

    for (const member of [host, moderator, viewer]) {
      const res = await emit(member.socket, 'request_action', { action: 'play' });
      assert.deepEqual([res.ok, res.code], [false, 'FORBIDDEN']);
    }

    const { request } = await emit(p1.socket, 'request_action', { action: 'play' });
    for (const member of [p1, p2, viewer]) {
      const res = await emit(member.socket, 'resolve_request', {
        requestId: request.id,
        decision: 'approve',
      });
      assert.deepEqual([res.ok, res.code], [false, 'FORBIDDEN']);
    }
    // The request is still pending and approvable by someone allowed.
    assert.equal(
      (await emit(host.socket, 'resolve_request', { requestId: request.id, decision: 'approve' }))
        .ok,
      true,
    );
  });

  test('validation: unknown action, bad time, bad link, missing video, bad resolve payload', async () => {
    const { host, p1 } = await setupCast();
    for (const payload of [
      undefined,
      {},
      { action: 'delete_room' },
      { action: 'seek' },
      { action: 'seek', time: -5 },
      { action: 'change_video', videoId: 'https://evil.com/x' },
    ]) {
      const res = await emit(p1.socket, 'request_action', payload);
      assert.deepEqual([res.ok, res.code], [false, 'INVALID_REQUEST'], JSON.stringify(payload));
    }
    for (const payload of [
      undefined,
      {},
      { requestId: 'x' },
      { requestId: 'x', decision: 'maybe' },
    ]) {
      assert.equal((await emit(host.socket, 'resolve_request', payload)).code, 'INVALID_REQUEST');
    }
    assert.equal(
      (await emit(host.socket, 'resolve_request', { requestId: 'nope', decision: 'approve' })).code,
      'REQUEST_NOT_FOUND',
    );
  });

  test('requesting play/pause/seek with no video loaded is refused up front', async () => {
    const { members } = await h.setupRoom({ guests: 1 });
    const res = await emit(members[0].socket, 'request_action', { action: 'play' });
    assert.deepEqual([res.ok, res.code], [false, 'NO_VIDEO']);
    // ...but asking for a video is fine.
    assert.equal(
      (
        await emit(members[0].socket, 'request_action', {
          action: 'change_video',
          videoId: VIDEO_A,
        })
      ).ok,
      true,
    );
  });

  test('at most 3 pending requests per person', async () => {
    const { p1, p2 } = await setupCast();
    for (let i = 0; i < 3; i += 1) {
      assert.equal((await emit(p1.socket, 'request_action', { action: 'play' })).ok, true);
    }
    const res = await emit(p1.socket, 'request_action', { action: 'play' });
    assert.deepEqual([res.ok, res.code], [false, 'TOO_MANY_REQUESTS']);
    assert.equal((await emit(p2.socket, 'request_action', { action: 'play' })).ok, true); // others unaffected
  });

  test('requests vanish when the requester leaves, is removed, or is demoted to viewer', async () => {
    const { host, moderator, p1, p2 } = await setupCast();
    const log = record(host.socket, ['request_resolved']);

    await emit(p1.socket, 'request_action', { action: 'play' });
    await emit(p2.socket, 'request_action', { action: 'pause' });
    const third = await h.registerUser();
    // (a third participant to demote)
    const extra = await h.join(
      third,
      (await emit(host.socket, 'request_sync')) && moderator.res.room.code,
    );
    await emit(extra.socket, 'request_action', { action: 'seek', time: 10 });

    await emit(p1.socket, 'leave_room'); // leaves
    await emit(host.socket, 'remove_participant', { userId: p2.user.id }); // removed
    await emit(host.socket, 'assign_role', { userId: third.id, role: 'viewer' }); // demoted
    await sleep(100);

    assert.deepEqual(
      log.map((e) => e.payload.status),
      ['cancelled', 'cancelled', 'cancelled'],
    );
    assert.equal((await emit(host.socket, 'list_requests')).requests.length, 0);
  });

  test('list_requests: approvers see everything, others only their own; joining returns the queue', async () => {
    const { code, host, p1, p2, viewer } = await setupCast();
    await emit(p1.socket, 'request_action', { action: 'play' });
    await emit(p2.socket, 'request_action', { action: 'pause' });

    assert.equal((await emit(host.socket, 'list_requests')).requests.length, 2);
    assert.equal((await emit(p1.socket, 'list_requests')).requests.length, 1);
    assert.equal((await emit(p2.socket, 'list_requests')).requests.length, 1);
    assert.equal((await emit(viewer.socket, 'list_requests')).requests.length, 0);

    // The host reconnecting (e.g. a page refresh) immediately gets the pending queue.
    const reconnected = await h.join(host.user, code);
    assert.equal(reconnected.res.requests.length, 2);
  });

  test('a user outside any room cannot use any of these events', async () => {
    const user = await h.registerUser();
    const socket = await h.connect(user.token);
    for (const [event, payload] of [
      ['assign_role', { userId: 'x', role: 'viewer' }],
      ['remove_participant', { userId: 'x' }],
      ['request_action', { action: 'play' }],
      ['resolve_request', { requestId: 'x', decision: 'approve' }],
      ['list_requests'],
    ]) {
      assert.equal((await emit(socket, event, payload)).code, 'NOT_IN_ROOM', event);
    }
  });

  test('unanswered requests expire, and can no longer be answered', async () => {
    const { host, p1 } = await setupCast(shortLived);
    const { request } = await emit(p1.socket, 'request_action', { action: 'play' });

    const expiredForHost = nextEvent(host.socket, 'request_resolved');
    const expiredForP1 = nextEvent(p1.socket, 'request_resolved');
    assert.equal((await expiredForHost).status, 'expired');
    assert.equal((await expiredForP1).requestId, request.id);

    const late = await emit(host.socket, 'resolve_request', {
      requestId: request.id,
      decision: 'approve',
    });
    assert.equal(late.code, 'REQUEST_NOT_FOUND');
    assert.equal((await emit(host.socket, 'request_sync')).playback.playState, 'paused');
  });
});
