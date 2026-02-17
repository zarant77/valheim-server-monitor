# Valheim Server Monitor

Lightweight real-time monitoring dashboard for a self-hosted Valheim dedicated server running in Docker.

Designed for Raspberry Pi / home servers.

---

## Features

- Real-time log tailing (`docker logs -f`)
- Online players detection (SteamID + nickname)
- Wrong password detection
- Pending connection tracking
- Server readiness detection
- Container + process health checks
- Clean web dashboard (Express + EJS)
- JSON API endpoint

---

## Requirements

- Node.js 18+
- Docker
- Valheim dedicated server running in container

---

## Installation

```bash
git clone https://github.com/YOUR_USERNAME/valheim-server-monitor.git
cd valheim-server-monitor
npm install
node server.js
```

Open:

```
http://localhost:8080
```

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| PORT | 8080 | Web server port |
| VALHEIM_CONTAINER | valheim | Docker container name |
| STALE_LOG_SECONDS | 180 | Log freshness window |
| DOCKER_LOG_TAIL | 400 | Initial log lines to read |

Example:

```bash
PORT=8080 VALHEIM_CONTAINER=valheim node server.js
```

---

## Running as systemd Service (Recommended)

Create a service file:

```bash
sudo nano /etc/systemd/system/valheim-server-monitor.service
```

Paste:

```
[Unit]
Description=Valheim Server Monitor
After=docker.service
Requires=docker.service

[Service]
Type=simple
User=zar
WorkingDirectory=/home/zar/valheim-server-monitor
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
Environment=PORT=8080
Environment=VALHEIM_CONTAINER=valheim

[Install]
WantedBy=multi-user.target
```

Then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable valheim-server-monitor
sudo systemctl start valheim-server-monitor
```

Check status:

```bash
sudo systemctl status valheim-server-monitor
```

View logs:

```bash
journalctl -u valheim-server-monitor -f
```

---

## API

### GET /api/status

Returns JSON with full server state.

---

## License

MIT
