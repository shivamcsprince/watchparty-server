# watchparty-server

Node.js + Express + Socket.IO backend for the YouTube Watch Party app.
Pairs with [watchparty-client](../watchparty-client).

## Setup (Windows PowerShell)

```powershell
npm install
Copy-Item .env.example .env       # then edit .env (see below)
npm run db:migrate                # creates/updates tables in your database
npm run dev
```

In `.env` set `DATABASE_URL` (Neon connection string), `JWT_SECRET` and
`CLIENT_ORIGIN`. Generate a secret with:

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

Open more terminals for more people (usernames are 3-20 characters).
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
| `send_message` | client -> server | `{ text }` (1-500 characters) | Not viewers. Ack: `{ ok: true, message }` |
| `send_reaction` | client -> server | `{ emoji }` (one of 👍 ❤️ 😂 😮 😢 👏 🔥 🎉) | Not viewers. Ack: `{ ok: true, reaction }` |
| `chat_message` | server -> whole room | `{ id, userId, username, role, text, sentAt }` | Includes the sender. `role` is the role when it was sent |
| `reaction` | server -> whole room | `{ id, userId, username, emoji, currentTime, sentAt }` | `currentTime` = video position (seconds) when they reacted |
| `role_assigned` | server -> whole room | `{ userId, username, role, participants, reason? }` | A role changed. `reason` is `host_left` or `host_timeout` when a new host took over |
| `participant_removed` | server -> whole room | `{ userId, username, participants }` | Also received by the removed person |
| `request_created` | server -> approvers + requester | `{ request }` | `request = { id, action, params, requestedBy, createdAt, expiresAt }` |
| `request_resolved` | server -> approvers + requester | `{ requestId, status, request, resolvedBy?, reason? }` | `status`: `approved`, `rejected`, `expired`, `cancelled`, `failed` |
| `sync_state` | server -> whole room | `{ videoId, playState, currentTime, serverTime, action, by, approvedBy? }` | Sent after every successful control event, to everyone including the sender. `approvedBy` is set when a request was approved (`by` is then the requester) |

`playback` / `sync_state` fields: `playState` is `"playing"` or `"paused"`; `currentTime` is the position in seconds
**at `serverTime`** (milliseconds since epoch, server clock). While playing, the position right now is
`currentTime + (now - serverTime) / 1000`, where `now` is the client's time adjusted by its clock offset.
`join_room`'s ack also contains `playback` (so a late joiner starts at the live position), `requests` (the pending
approval requests that person may see) and `messages` (the last 50 chat messages).

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

### Chat and reactions

Messages are plain text: the server removes control characters but does **not** escape HTML, so clients must render
them as text (React does this by default). The last 50 messages of a room are kept in memory and sent to people who
join; they are not saved to the database, so a room that empties starts with a fresh chat. Reactions are not stored.
Limits per connection: chat allows a burst of 5 then 1 per second; reactions a burst of 10 then 3 per second.
Invalid attempts count against these limits.

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

## Environment variables

| Var             | Example                                                                                       | Notes                                                |
| --------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `DATABASE_URL`  | `postgres://user:pass@host/db?sslmode=require`                                                | Neon connection string. Never commit.                |
| `JWT_SECRET`    | a long random hex string                                                                      | Never commit.                                        |
| `CLIENT_ORIGIN` | dev: `http://localhost:5173` <br> prod: `https://watchparty-client.vercel.app`                | CORS allowlist for HTTP **and** Socket.IO handshake. |
| `PORT`          | `4000`                                                                                        | Render sets this automatically.                      |
| `ROOM_CAPACITY` | `50`                                                                                          | Optional.                                            |
| `HOST_GRACE_MS` | `120000`                                                                                      | Optional. Host drop grace period.                    |
| `REQUEST_TTL_MS`| `120000`                                                                                      | Optional. Approval request expiry.                   |

## Integrating with the client

The client ([watchparty-client](../watchparty-client)) talks to this server
over two channels:

1. **HTTP** for auth and room creation:
   - `POST /api/auth/register`
   - `POST /api/auth/login`
   - `GET  /api/auth/me`
   - `POST /api/rooms`
2. **Socket.IO** for everything real-time. The client stores the JWT from
   login/register, then connects with:

   ```js
   io(serverUrl, { auth: { token }, transports: ["websocket"] })
   ```

   `authenticateSocket` verifies the token in the handshake, so the client
   never needs to (and never should) send a role or username on events.

The client mirrors the role matrix above and hides/disables controls the
current role can't use, but **every action is re-checked on the server**
(`RolePolicy.can`). Forging a role in a payload does nothing; the server uses
`socket.data.user.userId` to look up the real role.

For a deeper walkthrough, see [../watchparty-client/ARCHITECTURE.md](../watchparty-client/ARCHITECTURE.md).

## Deployment (Render)

1. Push this repo to GitHub.
2. Render → **New +** → **Web Service** → connect the repo.
3. Settings:
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `node src/index.js`
   - **Instance Type:** Free
4. Environment variables (Render → service → Environment):
   - `DATABASE_URL` = your Neon connection string
   - `JWT_SECRET`   = a long random hex string
   - `CLIENT_ORIGIN` = `http://localhost:5173` for now (update after the
     client deploys to Vercel)
   - Do **not** set `PORT` — Render injects it.
5. Deploy. Note the URL, e.g.
   `https://watchparty-server.onrender.com`.
6. Once the client is on Vercel, update `CLIENT_ORIGIN` to the Vercel URL
   (e.g. `https://watchparty-client.vercel.app`). Render redeploys
   automatically.
7. Free tier sleeps after ~15 minutes of inactivity. First request takes
   ~30 s to wake. Worth mentioning in the demo.

**Live URL:** _paste your Render URL here_

_Full architecture overview: [../watchparty-client/ARCHITECTURE.md](../watchparty-client/ARCHITECTURE.md)._