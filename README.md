# watchparty-server

Node.js + Express + Socket.IO backend for the YouTube Watch Party app.

## Setup (Windows PowerShell)

```powershell
npm install
Copy-Item .env.example .env   # then edit .env and paste your Neon connection string
npm run dev
```

## Checks

- http://localhost:4000/health -> server is alive
- http://localhost:4000/health/db -> database is reachable
- `npm run check:socket` -> WebSocket connection test (server must be running)

## Scripts

| Script                            | Purpose                                        |
| --------------------------------- | ---------------------------------------------- |
| `npm run dev`                     | Start with auto-restart and `.env` loading     |
| `npm start`                       | Production start (env vars come from the host) |
| `npm run lint` / `npm run format` | ESLint / Prettier                              |

_Full architecture overview and live URL will be added in later phases._
