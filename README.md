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

Then type commands in either terminal: `video <youtube-link>`, `play`, `pause`, `seek 90`, `sync`, `quit`.
The host's commands succeed and appear in both terminals as `[sync_state]`; the participant's are refused with `FORBIDDEN`.

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
| `sync_state` | server -> whole room | `{ videoId, playState, currentTime, serverTime, action, by }` | Sent after every successful control event, to everyone including the sender |

`playback` / `sync_state` fields: `playState` is `"playing"` or `"paused"`; `currentTime` is the position in seconds
**at `serverTime`** (milliseconds since epoch, server clock). While playing, the position right now is
`currentTime + (now - serverTime) / 1000`, where `now` is the client's time adjusted by its clock offset.
`join_room`'s ack also contains `playback`, so a late joiner starts at the live position.

Error codes: `INVALID_REQUEST`, `ROOM_NOT_FOUND`, `ROOM_FULL`, `NOT_IN_ROOM`, `NO_VIDEO`, `FORBIDDEN`,
`RATE_LIMITED`, `INTERNAL_ERROR`.

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
