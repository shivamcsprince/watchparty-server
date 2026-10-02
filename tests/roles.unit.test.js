import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Participant } from '../src/rooms/Participant.js';
import { RequestQueue } from '../src/rooms/RequestQueue.js';
import { Room } from '../src/rooms/Room.js';
import { RoomManager } from '../src/rooms/RoomManager.js';
import { RoomModeration } from '../src/rooms/RoomModeration.js';
import { ACTIONS, RolePolicy } from '../src/rooms/RolePolicy.js';
import { ROLES } from '../src/rooms/roles.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeBroadcaster() {
  const room = [];
  const direct = [];
  return {
    room,
    direct,
    emitToRoom: (channel, event, payload, except) => room.push({ event, payload, except }),
    emitToSocket: (socketId, event, payload) => direct.push({ socketId, event, payload }),
  };
}

function fakeRepository() {
  const repo = {
    hostUpdates: [],
    async findByCode(code) {
      return code === 'ABCD2345'
        ? { id: 'room-1', code, hostUserId: 'host', videoId: null, createdAt: new Date() }
        : null;
    },
    async updateVideoId() {},
    async updateHostUserId(id, userId) {
      repo.hostUpdates.push(userId);
    },
  };
  return repo;
}

const user = (id) => ({ userId: id, username: `name-${id}` });

describe('RolePolicy matrix', () => {
  const expected = {
    [ROLES.HOST]: [
      ACTIONS.PLAYBACK_CONTROL,
      ACTIONS.ASSIGN_ROLE,
      ACTIONS.REMOVE_PARTICIPANT,
      ACTIONS.RESOLVE_REQUEST,
      ACTIONS.SEND_CHAT,
      ACTIONS.SEND_REACTION,
    ],
    [ROLES.MODERATOR]: [
      ACTIONS.PLAYBACK_CONTROL,
      ACTIONS.RESOLVE_REQUEST,
      ACTIONS.SEND_CHAT,
      ACTIONS.SEND_REACTION,
    ],
    [ROLES.PARTICIPANT]: [ACTIONS.REQUEST_ACTION, ACTIONS.SEND_CHAT, ACTIONS.SEND_REACTION],
    [ROLES.VIEWER]: [],
  };

  for (const [role, allowed] of Object.entries(expected)) {
    test(`${role} may do exactly: ${allowed.join(', ') || 'nothing'}`, () => {
      for (const action of Object.values(ACTIONS)) {
        assert.equal(RolePolicy.can(role, action), allowed.includes(action), `${role} ${action}`);
      }
    });
  }
});

describe('RequestQueue', () => {
  const alice = { userId: 'a', username: 'alice' };
  const bob = { userId: 'b', username: 'bob' };

  test('add / take: a request can be taken exactly once', () => {
    const queue = new RequestQueue({ ttlMs: 10_000 });
    const request = queue.add({ action: 'play', params: {}, requestedBy: alice });
    assert.equal(queue.size, 1);
    assert.equal(queue.take(request.id).id, request.id);
    assert.equal(queue.take(request.id), null);
    assert.equal(queue.size, 0);
    queue.clear();
  });

  test('limits pending requests per person, not per room', () => {
    const queue = new RequestQueue({ ttlMs: 10_000, maxPerUser: 3 });
    for (let i = 0; i < 3; i += 1) queue.add({ action: 'play', params: {}, requestedBy: alice });
    assert.throws(
      () => queue.add({ action: 'play', params: {}, requestedBy: alice }),
      (err) => err.code === 'TOO_MANY_REQUESTS',
    );
    queue.add({ action: 'play', params: {}, requestedBy: bob }); // someone else is unaffected
    queue.clear();
  });

  test('requests expire on their own and report it once', async () => {
    const expired = [];
    const queue = new RequestQueue({ ttlMs: 40, onExpire: (r) => expired.push(r.id) });
    const request = queue.add({ action: 'pause', params: {}, requestedBy: alice });
    await sleep(120);
    assert.deepEqual(expired, [request.id]);
    assert.equal(queue.size, 0);
  });

  test('a resolved request does not expire later', async () => {
    const expired = [];
    const queue = new RequestQueue({ ttlMs: 40, onExpire: (r) => expired.push(r.id) });
    const request = queue.add({ action: 'pause', params: {}, requestedBy: alice });
    queue.take(request.id);
    await sleep(120);
    assert.deepEqual(expired, []);
  });

  test("cancelForUser only removes that user's requests", () => {
    const queue = new RequestQueue({ ttlMs: 10_000 });
    queue.add({ action: 'play', params: {}, requestedBy: alice });
    queue.add({ action: 'play', params: {}, requestedBy: alice });
    queue.add({ action: 'play', params: {}, requestedBy: bob });
    assert.equal(queue.cancelForUser('a').length, 2);
    assert.equal(queue.size, 1);
    queue.clear();
  });
});

describe('Room: successor choice', () => {
  const make = () =>
    new Room(
      { id: 'r', code: 'ABCD2345', hostUserId: 'host' },
      { broadcaster: fakeBroadcaster(), capacity: 10 },
    );
  const add = (room, userId, role, joinedAt) =>
    room.addParticipant(
      new Participant({
        userId,
        username: userId,
        role,
        socketId: `s-${userId}`,
        joinedAt: new Date(joinedAt),
      }),
    );

  test('moderator beats an older participant; then oldest wins; viewer is the last resort', () => {
    const room = make();
    add(room, 'viewer', ROLES.VIEWER, 1);
    add(room, 'p-old', ROLES.PARTICIPANT, 2);
    add(room, 'p-new', ROLES.PARTICIPANT, 5);
    add(room, 'mod', ROLES.MODERATOR, 9);
    assert.equal(room.pickSuccessor().userId, 'mod');

    room.removeParticipant('mod', 's-mod');
    assert.equal(room.pickSuccessor().userId, 'p-old');

    room.removeParticipant('p-old', 's-p-old');
    room.removeParticipant('p-new', 's-p-new');
    assert.equal(room.pickSuccessor().userId, 'viewer');

    room.removeParticipant('viewer', 's-viewer');
    assert.equal(room.pickSuccessor(), null);
  });

  test('the current host is never chosen as their own successor', () => {
    const room = make();
    add(room, 'host', ROLES.HOST, 1);
    assert.equal(room.pickSuccessor(), null);
  });
});

describe('Room: approval audience and playback', () => {
  test('requests are visible to approvers and the requester, nobody else', () => {
    const room = new Room(
      { id: 'r', code: 'ABCD2345', hostUserId: 'host', videoId: 'dQw4w9WgXcQ' },
      { broadcaster: fakeBroadcaster(), capacity: 10 },
    );
    const add = (userId, role) => {
      const participant = new Participant({
        userId,
        username: userId,
        role,
        socketId: `s-${userId}`,
      });
      room.addParticipant(participant);
      return participant;
    };
    const host = add('host', ROLES.HOST);
    const mod = add('mod', ROLES.MODERATOR);
    const p1 = add('p1', ROLES.PARTICIPANT);
    const p2 = add('p2', ROLES.PARTICIPANT);
    const viewer = add('viewer', ROLES.VIEWER);

    room.requests.add({
      action: 'play',
      params: {},
      requestedBy: { userId: 'p1', username: 'p1' },
    });

    assert.equal(room.listRequestsFor(host).length, 1);
    assert.equal(room.listRequestsFor(mod).length, 1);
    assert.equal(room.listRequestsFor(p1).length, 1);
    assert.equal(room.listRequestsFor(p2).length, 0);
    assert.equal(room.listRequestsFor(viewer).length, 0);
    room.dispose();
  });

  test('announcements go only to approvers and the requester', () => {
    const broadcaster = fakeBroadcaster();
    const room = new Room(
      { id: 'r', code: 'ABCD2345', hostUserId: 'host' },
      { broadcaster, capacity: 10 },
    );
    for (const [userId, role] of [
      ['host', ROLES.HOST],
      ['mod', ROLES.MODERATOR],
      ['p1', ROLES.PARTICIPANT],
      ['p2', ROLES.PARTICIPANT],
    ]) {
      room.addParticipant(
        new Participant({ userId, username: userId, role, socketId: `s-${userId}` }),
      );
    }
    room.announceRequestResolved(
      {
        id: 'x',
        action: 'play',
        params: {},
        createdAt: 0,
        expiresAt: 1,
        requestedBy: { userId: 'p1', username: 'p1' },
      },
      'cancelled',
    );
    assert.deepEqual(broadcaster.direct.map((d) => d.socketId).sort(), ['s-host', 's-mod', 's-p1']);
  });

  test('applyPlayback broadcasts sync_state with who did it and who approved it', () => {
    const broadcaster = fakeBroadcaster();
    const room = new Room(
      { id: 'r', code: 'ABCD2345', hostUserId: 'host', videoId: 'dQw4w9WgXcQ' },
      { broadcaster, capacity: 10 },
    );
    room.applyPlayback(
      'play',
      {},
      { by: { userId: 'p1', username: 'p1' }, approvedBy: { userId: 'host', username: 'host' } },
    );
    const event = broadcaster.room.at(-1);
    assert.equal(event.event, 'sync_state');
    assert.equal(event.payload.playState, 'playing');
    assert.equal(event.payload.by.userId, 'p1');
    assert.equal(event.payload.approvedBy.userId, 'host');
  });
});

describe('RoomManager: host succession', () => {
  const GRACE = 80;
  const setup = () => {
    const repo = fakeRepository();
    const broadcaster = fakeBroadcaster();
    const manager = new RoomManager({
      roomRepository: repo,
      broadcaster,
      capacity: 10,
      hostGraceMs: GRACE,
    });
    const join = (userId, socketId = `s-${userId}`) =>
      manager.join({ code: 'ABCD2345', user: user(userId), socketId });
    const promotions = () => broadcaster.room.filter((e) => e.event === 'role_assigned');
    return { repo, broadcaster, manager, join, promotions };
  };

  test('explicit leave by the host promotes immediately, and persists it', async () => {
    const { repo, manager, join, promotions } = setup();
    await join('host');
    await join('p1');
    manager.leave({ code: 'ABCD2345', userId: 'host', socketId: 's-host', explicit: true });

    assert.equal(promotions().length, 1);
    assert.deepEqual(
      [
        promotions()[0].payload.userId,
        promotions()[0].payload.role,
        promotions()[0].payload.reason,
      ],
      ['p1', 'host', 'host_left'],
    );
    assert.deepEqual(repo.hostUpdates, ['p1']);
    assert.equal(manager.getActiveRoom('ABCD2345').hostUserId, 'p1');
  });

  test('user_left is announced before the new host', async () => {
    const { broadcaster, manager, join } = setup();
    await join('host');
    await join('p1');
    manager.leave({ code: 'ABCD2345', userId: 'host', socketId: 's-host', explicit: true });
    const names = broadcaster.room
      .map((e) => e.event)
      .filter((e) => ['user_left', 'role_assigned'].includes(e));
    assert.deepEqual(names, ['user_left', 'role_assigned']);
  });

  test('a dropped host connection waits for the grace period, then someone takes over', async () => {
    const { manager, join, promotions } = setup();
    await join('host');
    await join('p1');
    manager.leave({ code: 'ABCD2345', userId: 'host', socketId: 's-host', explicit: false });

    await sleep(GRACE / 2);
    assert.equal(promotions().length, 0);
    await sleep(GRACE);
    assert.equal(promotions().length, 1);
    assert.equal(promotions()[0].payload.reason, 'host_timeout');
    assert.equal(manager.getActiveRoom('ABCD2345').hostUserId, 'p1');
  });

  test('a host who returns within the grace period stays host and nobody is promoted', async () => {
    const { manager, join, promotions } = setup();
    await join('host');
    await join('p1');
    manager.leave({ code: 'ABCD2345', userId: 'host', socketId: 's-host', explicit: false });
    await sleep(GRACE / 3);
    const back = await join('host', 's-host-2');
    assert.equal(back.participant.role, ROLES.HOST);

    await sleep(GRACE * 2);
    assert.equal(promotions().length, 0);
    assert.equal(manager.getActiveRoom('ABCD2345').hostUserId, 'host');
  });

  test('every disconnect gets a full, fresh grace period (a stale countdown must not carry over)', async () => {
    const { manager, join, promotions } = setup();
    await join('host');
    await join('p1');

    manager.leave({ code: 'ABCD2345', userId: 'host', socketId: 's-host', explicit: false }); // t = 0
    await sleep(GRACE * 0.3);
    await join('host', 's-host-2'); // back in time
    await sleep(GRACE * 0.3);
    manager.leave({ code: 'ABCD2345', userId: 'host', socketId: 's-host-2', explicit: false }); // drops again

    // Now we are past the FIRST countdown's deadline, but only ~0.4 of the grace into the second one.
    await sleep(GRACE * 0.7);
    assert.equal(promotions().length, 0, 'promoted using the stale countdown');

    await sleep(GRACE * 0.8); // past the second countdown's full period
    assert.equal(promotions().length, 1);
  });

  test('after being replaced, the old host returns as a plain participant', async () => {
    const { manager, join } = setup();
    await join('host');
    await join('p1');
    manager.leave({ code: 'ABCD2345', userId: 'host', socketId: 's-host', explicit: true });
    const back = await join('host', 's-host-2');
    assert.equal(back.participant.role, ROLES.PARTICIPANT);
  });

  test('if the host never shows up, the countdown starts when the first other person joins', async () => {
    const { manager, join, promotions } = setup();
    await join('p1');
    await sleep(GRACE * 2);
    assert.equal(promotions().length, 1);
    assert.equal(manager.getActiveRoom('ABCD2345').hostUserId, 'p1');
  });

  test('an empty room has no countdown and nobody is promoted', async () => {
    const { manager, join, promotions } = setup();
    await join('host');
    manager.leave({ code: 'ABCD2345', userId: 'host', socketId: 's-host', explicit: false });
    await sleep(GRACE * 2);
    assert.equal(promotions().length, 0);
    assert.equal(manager.activeRoomCount, 0);
  });

  test('a replacement session keeps its place in the succession queue', async () => {
    const { manager, join } = setup();
    await join('host');
    const first = await join('older');
    await sleep(5);
    await join('newer');
    const replacement = await join('older', 's-older-2'); // same user, new connection
    assert.deepEqual(replacement.participant.joinedAt, first.participant.joinedAt);
    manager.leave({ code: 'ABCD2345', userId: 'host', socketId: 's-host', explicit: true });
    assert.equal(manager.getActiveRoom('ABCD2345').hostUserId, 'older');
  });
});

describe('RoomModeration: target guards (each checked on its own)', () => {
  // Only the host can assign roles or remove people today, so the two guards overlap.
  // These tests pin each guard individually so that widening a permission later cannot silently weaken them.
  function setup() {
    const room = new Room(
      { id: 'r', code: 'ABCD2345', hostUserId: 'h1' },
      { broadcaster: fakeBroadcaster(), capacity: 10 },
    );
    const add = (userId, role) => {
      const participant = new Participant({
        userId,
        username: userId,
        role,
        socketId: `s-${userId}`,
      });
      room.addParticipant(participant);
      return participant;
    };
    return { room, add, moderation: new RoomModeration({ roomManager: {} }) };
  }

  for (const [name, call] of [
    ['assignRole', (m, room, actor, target) => m.assignRole(room, actor, target, ROLES.VIEWER)],
    ['removeParticipant', (m, room, actor, target) => m.removeParticipant(room, actor, target)],
  ]) {
    test(`${name}: refuses to act on yourself, with its own message`, () => {
      const { room, add, moderation } = setup();
      const host = add('h1', ROLES.HOST);
      assert.throws(
        () => call(moderation, room, host, 'h1'),
        (err) => err.code === 'INVALID_TARGET' && /yourself/.test(err.message),
      );
    });

    test(`${name}: refuses to act on a host, even for someone allowed to use the action`, () => {
      const { room, add, moderation } = setup();
      const actor = add('h1', ROLES.HOST);
      add('h2', ROLES.HOST); // an impossible-but-defended-against second host
      assert.throws(
        () => call(moderation, room, actor, 'h2'),
        (err) => err.code === 'INVALID_TARGET' && /host cannot be changed/.test(err.message),
      );
    });

    test(`${name}: unknown target`, () => {
      const { room, add, moderation } = setup();
      const host = add('h1', ROLES.HOST);
      assert.throws(
        () => call(moderation, room, host, 'ghost'),
        (err) => err.code === 'PARTICIPANT_NOT_FOUND',
      );
    });
  }
});
