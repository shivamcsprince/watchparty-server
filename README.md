# watchparty-server

Node.js + Express + Socket.IO backend for the YouTube Watch Party app.

## Setup (Windows PowerShell)

```powershell
npm install
Copy-Item .env.example .env       # then edit .env (see below)
npm run db:migrate                # creates/updates tables in your database
npm run dev
```

In `.env` set `DATABASE_URL` (Neon connection string) and `JWT_SECRET`.
Generate a secret with:

```powershell
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

## Checks

- http://localhost:4000/health -> server is alive (does not touch the database)
- http://localhost:4000/health/db -> database is reachable
- `npm test` -> unit + integration tests (they create and delete their own test users)

## Manual test with two terminals

Register two users first (see the auth API below), then:

```powershell
# terminal 1: logs in, creates a room (you are the host), prints the code
node scripts/room-demo.js create alice@example.com password123

# terminal 2: joins that room (you are a participant)
node scripts/room-demo.js join ABCD2345 bob@example.com password123
```

Open more terminals for more people (`mo`-style short names won't work: usernames are 3-20 characters).
Commands are listed at the top of `scripts/room-demo.js`; the main ones:

| Who              | Commands                                                                   |
| ---------------- | -------------------------------------------------------------------------- |
| Host / moderator | `video <link>`, `play`, `pause`, `seek 90`, `approve <id>`, `reject <id>`  |
| Host only        | `role <username> moderator\|participant\|viewer`, `remove <username>`      |
| Participant      | `request play`, `request pause`, `request seek 90`, `request video <link>` |
| Anyone           | `who`, `requests`, `sync`, `leave`, `quit`                                 |

Try: make a second user a moderator, then as a participant `request seek 90`; the host or moderator sees the request
and answers it. A viewer's `request ...` is refused, and so is a participant's `play`.

## REST API

| Method | Path                 | Body                            | Notes                                                         |
| ------ | -------------------- | ------------------------------- | ------------------------------------------------------------- |
| POST   | `/api/auth/register` | `{ email, username, password }` | 201 + `{ user, token }`                                       |
| POST   | `/api/auth/login`    | `{ email, password }`           | 200 + `{ user, token }`                                       |
| GET    | `/api/auth/me`       | -                               | needs `Authorization: Bearer <token>`                         |
| POST   | `/api/rooms`         | -                               | needs token; creator becomes Host; 201 + `{ room }`           |
| GET    | `/api/rooms/:code`   | -                               | needs token; `{ room: { code, participantCount, capacity } }` |

Tokens expire after 1 hour. Room codes are 8 characters (letters and digits, no look-alikes such as 0/O or 1/I);
input is accepted in any case and with spaces or dashes.

## Socket.IO events

Connect with `io(url, { auth: { token } })`. The user's identity comes from the token, never from event payloads.

| Event              | Direction            | Payload                                    | Notes                                                                        |
| ------------------ | -------------------- | ------------------------------------------ | ---------------------------------------------------------------------------- |
| `join_room`        | client -> server     | `{ roomId }` (the 8-character code)        | Ack: `{ ok: true, room, you, participants }` or `{ ok: false, error, code }` |
| `leave_room`       | client -> server     | `{}`                                       | Ack: `{ ok: true }`                                                          |
| `user_joined`      | server -> others     | `{ username, userId, role, participants }` | Not sent to the joiner                                                       |
| `user_left`        | server -> room       | `{ username, userId, participants }`       | Also sent on disconnect                                                      |
| `session_replaced` | server -> one client | `{ roomId }`                               | The same user joined from another tab                                        |

| `play` | client -> server | none | Host/Moderator only. Ack: `{ ok: true, playback }` |
| `pause` | client -> server | none | Host/Moderator only |
| `seek` | client -> server | `{ time }` (seconds) | Host/Moderator only |
| `change_video` | client -> server | `{ videoId }` (11-character id **or** a YouTube link) | Host/Moderator only; the new video starts paused at 0:00 |
| `request_sync` | client -> server | none | Any member. Ack: `{ ok: true, playback }`, used for drift checks |
| `assign_role` | client -> server | `{ userId, role }` (`moderator`, `participant` or `viewer`) | Host only. Ack: `{ ok: true, participants }` |
| `remove_participant` | client -> server | `{ userId }` | Host only. Kicks (they can rejoin with the code). Ack: `{ ok: true, participants }` |
| `request_action` | client -> server | `{ action: "play"\|"pause"\|"seek"\|"change_video", time?, videoId? }` | Participants only. Ack: `{ ok: true, request }` |
| `resolve_request` | client -> server | `{ requestId, decision: "approve"\|"reject" }` | Host/moderator. First decision wins. Ack: `{ ok: true, status }` |
| `list_requests` | client -> server | none | Approvers see all pending requests, others only their own |
| `role_assigned` | server -> whole room | `{ userId, username, role, participants, reason? }` | A role changed. `reason` is `host_left` or `host_timeout` when a new host took over |
| `participant_removed` | server -> whole room | `{ userId, username, participants }` | Also received by the removed person |
| `request_created` | server -> approvers + requester | `{ request }` | `request = { id, action, params, requestedBy, createdAt, expiresAt }` |
| `request_resolved` | server -> approvers + requester | `{ requestId, status, request, resolvedBy?, reason? }` | `status`: `approved`, `rejected`, `expired`, `cancelled`, `failed` |
| `sync_state` | server -> whole room | `{ videoId, playState, currentTime, serverTime, action, by, approvedBy? }` | Sent after every successful control event, to everyone including the sender. `approvedBy` is set when a request was approved (`by` is then the requester) |

`playback` / `sync_state` fields: `playState` is `"playing"` or `"paused"`; `currentTime` is the position in seconds
**at `serverTime`** (milliseconds since epoch, server clock). While playing, the position right now is
`currentTime + (now - serverTime) / 1000`, where `now` is the client's time adjusted by its clock offset.
`join_room`'s ack also contains `playback`, so a late joiner starts at the live position.

Error codes: `INVALID_REQUEST`, `ROOM_NOT_FOUND`, `ROOM_FULL`, `NOT_IN_ROOM`, `NO_VIDEO`, `FORBIDDEN`,
`INVALID_TARGET`, `PARTICIPANT_NOT_FOUND`, `REQUEST_NOT_FOUND`, `TOO_MANY_REQUESTS`, `RATE_LIMITED`, `INTERNAL_ERROR`.

### Roles

| Role          | Can do                                                                 |
| ------------- | ---------------------------------------------------------------------- |
| `host`        | Everything: playback, assign roles, remove people, answer requests     |
| `moderator`   | Playback and answering requests (cannot assign roles or remove people) |
| `participant` | Watch, and **request** playback changes for approval                   |
| `viewer`      | Watch only (cannot control, request, or answer)                        |

The room creator is the host; everyone else joins as `participant`. The host cannot be demoted or removed, and
`host` cannot be assigned with `assign_role`. Roles are not remembered: someone who leaves and comes back is a
`participant` again.

### Approval requests

A participant's request is shown to the host, moderators and the requester only. The first host/moderator to answer
decides; later answers get `REQUEST_NOT_FOUND`. Approving applies the original action for everyone. A participant may
have at most 3 requests open. Requests expire after 2 minutes (`REQUEST_TTL_MS`), and are cancelled if the requester
leaves, is removed, or becomes a viewer or moderator.

### Host succession

- **Host presses Leave** (`leave_room`): someone takes over immediately.
- **Host's connection drops**: a grace period of 2 minutes (`HOST_GRACE_MS`) starts. If the host reconnects in time they
  are still host; otherwise someone takes over. Every drop gets a full, fresh grace period.
- If the host has not connected at all when others are in the room, the same countdown applies.
- **Who takes over**: the longest-present moderator, then the longest-present participant, then (last resort) a viewer.
  The change is saved, and the old host returns as a `participant`.

Rules: the room creator joins as `host`, everyone else as `participant`. A connection is in one room at a time.
Room capacity defaults to 50 (`ROOM_CAPACITY`). Each connection may send a burst of 20 events, then 10 per second.
Permissions are decided on the server from the participant's stored role (`RolePolicy`), never from the payload.

## Scripts

| Script                            | Purpose                                        |
| --------------------------------- | ---------------------------------------------- |
| `npm run dev`                     | Start with auto-restart and `.env` loading     |
| `npm start`                       | Production start (env vars come from the host) |
| `npm run db:migrate`              | Apply `db/schema.sql` (safe to run repeatedly) |
| `npm test`                        | Run tests                                      |
| `npm run lint` / `npm run format` | ESLint / Prettier                              |

_Full architecture overview and live URL will be added in later phases._
