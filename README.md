# Valheim Server Monitor

Lightweight real-time monitoring dashboard for a Dockerized Valheim server.

## Features

- Live player tracking (SteamID + nickname when available)
- Detects successful joins vs wrong password attempts
- Server readiness detection based on real log events
- Docker container + process health check
- Auto-refresh dashboard (every 5 seconds)
- Debug routes and raw log access
- Clean responsive UI (dark theme)

## Tech Stack

- Node.js (ESM)
- Express
- EJS templates
- Docker log tailing
- In-memory state engine

## Routes

| Route | Description |
|-------|------------|
| `/` | Dashboard |
| `/debug` | Extended debug info |
| `/debug/raw` | Last raw log lines |
| `/api/status` | JSON API |

## Environment Variables

```bash
PORT=8080
VALHEIM_CONTAINER=valheim
DOCKER_LOG_TAIL=400
STALE_LOG_SECONDS=180
PENDING_TTL_MS=120000
PLAYER_SEEN_TTL_MS=600000
```

## Run

```bash
npm install
node server.js
```

## License

MIT
