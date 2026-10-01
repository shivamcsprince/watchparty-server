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
# terminal 1: logs in, creates a room, prints the code and waits for events
node scripts/room-demo.js create alice@example.com password123

# terminal 2: joins that room
node scripts/room-demo.js join ABCD2345 bob@example.com password123
```

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

Error codes: `INVALID_REQUEST`, `ROOM_NOT_FOUND`, `ROOM_FULL`, `INTERNAL_ERROR`.

Rules: the room creator joins as `host`, everyone else as `participant`. A connection is in one room at a time.
Room capacity defaults to 50 (`ROOM_CAPACITY`).

## Scripts

| Script                            | Purpose                                        |
| --------------------------------- | ---------------------------------------------- |
| `npm run dev`                     | Start with auto-restart and `.env` loading     |
| `npm start`                       | Production start (env vars come from the host) |
| `npm run db:migrate`              | Apply `db/schema.sql` (safe to run repeatedly) |
| `npm test`                        | Run tests                                      |
| `npm run lint` / `npm run format` | ESLint / Prettier                              |

_Full architecture overview and live URL will be added in later phases._
