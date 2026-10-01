import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Room } from '../src/rooms/Room.js';
import { RoomManager } from '../src/rooms/RoomManager.js';
import { Participant } from '../src/rooms/Participant.js';
import { ROLES } from '../src/rooms/roles.js';
import {
  ROOM_CODE_LENGTH,
  generateRoomCode,
  isValidRoomCode,
  normalizeRoomCode,
} from '../src/rooms/roomCode.js';

const HOST_ID = 'host-user';

function fakeBroadcaster() {
  const events = [];
  return {
    events,
    emitToRoom: (channel, event, payload, except) =>
      events.push({ channel, event, payload, except }),
  };
}

function fakeRepository({ delayMs = 0 } = {}) {
  const repo = {
    findCalls: 0,
    async findByCode(code) {
      repo.findCalls += 1;
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      return code === 'ABCD2345'
        ? { id: 'room-1', code, hostUserId: HOST_ID, videoId: null, createdAt: new Date() }
        : null;
    },
  };
  return repo;
}

const makeManager = (options = {}) =>
  new RoomManager({
    roomRepository: options.repo ?? fakeRepository(),
    broadcaster: options.broadcaster ?? fakeBroadcaster(),
    capacity: options.capacity ?? 50,
  });

const user = (id) => ({ userId: id, username: `name-${id}` });

describe('room codes', () => {
  test('generated codes are 8 characters and valid, without look-alike characters', () => {
    for (let i = 0; i < 500; i += 1) {
      const code = generateRoomCode();
      assert.equal(code.length, ROOM_CODE_LENGTH);
      assert.ok(isValidRoomCode(code));
      assert.ok(!/[01OI]/.test(code));
    }
  });

  test('codes are effectively unique', () => {
    const codes = new Set(Array.from({ length: 5000 }, generateRoomCode));
    assert.equal(codes.size, 5000);
  });

  test('normalization accepts lowercase, spaces and dashes', () => {
    assert.equal(normalizeRoomCode('abcd-2345'), 'ABCD2345');
    assert.equal(normalizeRoomCode(' abcd 2345 '), 'ABCD2345');
  });

  test('validation rejects wrong length and excluded characters', () => {
    assert.equal(isValidRoomCode('ABCD234'), false);
    assert.equal(isValidRoomCode('ABCD23456'), false);
    assert.equal(isValidRoomCode('ABCD234O'), false); // letter O
    assert.equal(isValidRoomCode('ABCD2341'), false); // digit 1
  });
});

describe('Room', () => {
  const record = { id: 'r', code: 'ABCD2345', hostUserId: HOST_ID };

  test('assigns host to the creator and participant to everyone else', () => {
    const room = new Room(record, { broadcaster: fakeBroadcaster(), capacity: 5 });
    assert.equal(room.roleForUser(HOST_ID), ROLES.HOST);
    assert.equal(room.roleForUser('someone-else'), ROLES.PARTICIPANT);
  });

  test('a stale socket cannot remove its own replacement', () => {
    const room = new Room(record, { broadcaster: fakeBroadcaster(), capacity: 5 });
    const base = { userId: 'u1', username: 'a', role: ROLES.PARTICIPANT };
    room.addParticipant(new Participant({ ...base, socketId: 'old' }));
    const replaced = room.addParticipant(new Participant({ ...base, socketId: 'new' }));

    assert.equal(replaced.socketId, 'old');
    assert.equal(room.removeParticipant('u1', 'old'), null);
    assert.equal(room.size, 1);
    assert.ok(room.removeParticipant('u1', 'new'));
    assert.ok(room.isEmpty());
  });

  test('participant list never exposes socket ids', () => {
    const room = new Room(record, { broadcaster: fakeBroadcaster(), capacity: 5 });
    room.addParticipant(
      new Participant({ userId: 'u1', username: 'a', role: ROLES.HOST, socketId: 's' }),
    );
    assert.deepEqual(room.listParticipants(), [{ userId: 'u1', username: 'a', role: 'host' }]);
  });

  test('broadcast goes through the injected broadcaster to the room channel', () => {
    const broadcaster = fakeBroadcaster();
    const room = new Room(record, { broadcaster, capacity: 5 });
    room.broadcast('hello', { a: 1 }, { exceptSocketId: 's1' });
    assert.deepEqual(broadcaster.events, [
      { channel: 'room:ABCD2345', event: 'hello', payload: { a: 1 }, except: 's1' },
    ]);
  });
});

describe('RoomManager', () => {
  test('unknown room -> ROOM_NOT_FOUND', async () => {
    const manager = makeManager();
    await assert.rejects(
      manager.join({ code: 'ZZZZ2222', user: user('u1'), socketId: 's1' }),
      (err) => err.code === 'ROOM_NOT_FOUND' && err.status === 404,
    );
  });

  test('room creator joins as host, others as participant', async () => {
    const manager = makeManager();
    const host = await manager.join({ code: 'ABCD2345', user: user(HOST_ID), socketId: 's1' });
    const guest = await manager.join({ code: 'ABCD2345', user: user('u2'), socketId: 's2' });
    assert.equal(host.participant.role, ROLES.HOST);
    assert.equal(guest.participant.role, ROLES.PARTICIPANT);
    assert.equal(guest.room.size, 2);
  });

  test('enforces capacity, but a user replacing their own session does not count twice', async () => {
    const manager = makeManager({ capacity: 2 });
    await manager.join({ code: 'ABCD2345', user: user('u1'), socketId: 's1' });
    await manager.join({ code: 'ABCD2345', user: user('u2'), socketId: 's2' });

    await assert.rejects(
      manager.join({ code: 'ABCD2345', user: user('u3'), socketId: 's3' }),
      (err) => err.code === 'ROOM_FULL' && err.status === 409,
    );
    const again = await manager.join({ code: 'ABCD2345', user: user('u1'), socketId: 's1b' });
    assert.equal(again.replaced.socketId, 's1');
    assert.equal(again.room.size, 2);
  });

  test('a replacement session keeps the existing role', async () => {
    const manager = makeManager();
    await manager.join({ code: 'ABCD2345', user: user(HOST_ID), socketId: 's1' });
    const second = await manager.join({ code: 'ABCD2345', user: user(HOST_ID), socketId: 's2' });
    assert.equal(second.participant.role, ROLES.HOST);
  });

  test('concurrent joins load the room from the database only once', async () => {
    const repo = fakeRepository({ delayMs: 20 });
    const manager = makeManager({ repo });
    const results = await Promise.all([
      manager.join({ code: 'ABCD2345', user: user('u1'), socketId: 's1' }),
      manager.join({ code: 'ABCD2345', user: user('u2'), socketId: 's2' }),
      manager.join({ code: 'ABCD2345', user: user('u3'), socketId: 's3' }),
    ]);
    assert.equal(repo.findCalls, 1);
    assert.ok(results.every((r) => r.room === results[0].room));
    assert.equal(results[0].room.size, 3);
  });

  test('room is removed from memory when the last person leaves, and reloadable', async () => {
    const repo = fakeRepository();
    const manager = makeManager({ repo });
    await manager.join({ code: 'ABCD2345', user: user('u1'), socketId: 's1' });
    assert.equal(manager.activeRoomCount, 1);

    const left = manager.leave({ code: 'ABCD2345', userId: 'u1', socketId: 's1' });
    assert.equal(left.participant.userId, 'u1');
    assert.equal(manager.activeRoomCount, 0);

    const rejoined = await manager.join({ code: 'ABCD2345', user: user('u1'), socketId: 's9' });
    assert.equal(rejoined.room.size, 1);
    assert.equal(repo.findCalls, 2);
  });

  test('leave with a stale socket id is ignored', async () => {
    const manager = makeManager();
    await manager.join({ code: 'ABCD2345', user: user('u1'), socketId: 'old' });
    await manager.join({ code: 'ABCD2345', user: user('u1'), socketId: 'new' });
    assert.equal(manager.leave({ code: 'ABCD2345', userId: 'u1', socketId: 'old' }), null);
    assert.equal(manager.getActiveRoom('ABCD2345').size, 1);
  });
});
