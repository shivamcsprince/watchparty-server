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
- `npm run check:socket` -> WebSocket connection test (server must be running)
- `npm test` -> integration tests (create and delete their own test users)

## API (Phase 2)

| Method | Path                 | Body                            | Notes                                 |
| ------ | -------------------- | ------------------------------- | ------------------------------------- |
| POST   | `/api/auth/register` | `{ email, username, password }` | 201 + `{ user, token }`               |
| POST   | `/api/auth/login`    | `{ email, password }`           | 200 + `{ user, token }`               |
| GET    | `/api/auth/me`       | -                               | needs `Authorization: Bearer <token>` |

Tokens expire after 1 hour.

## Scripts

| Script                            | Purpose                                        |
| --------------------------------- | ---------------------------------------------- |
| `npm run dev`                     | Start with auto-restart and `.env` loading     |
| `npm start`                       | Production start (env vars come from the host) |
| `npm run db:migrate`              | Apply `db/schema.sql` (safe to run repeatedly) |
| `npm test`                        | Run tests                                      |
| `npm run lint` / `npm run format` | ESLint / Prettier                              |

_Full architecture overview and live URL will be added in later phases._
