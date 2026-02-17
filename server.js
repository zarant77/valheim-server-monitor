import express from "express";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { createValheimLogTail } from "./lib/valheimLogTail.js";
import { createValheimState } from "./lib/valheimState.js";

const execFileAsync = promisify(execFile);

const app = express();

const CONFIG = {
  port: Number(process.env.PORT || 8080),
  container: process.env.VALHEIM_CONTAINER || "valheim",

  // How many lines keep in memory for /debug/raw
  rawKeepLines: Number(process.env.RAW_KEEP_LINES || 600),

  // Log freshness window (if no log lines for too long => logs stale)
  staleLogSeconds: Number(process.env.STALE_LOG_SECONDS || 180),

  // Tail settings
  tailLines: Number(process.env.DOCKER_LOG_TAIL || 400),

  // State tuning
  pendingTtlMs: Number(process.env.PENDING_TTL_MS || 2 * 60 * 1000),
  playerSeenTtlMs: Number(process.env.PLAYER_SEEN_TTL_MS || 10 * 60 * 1000),
};

function safeTrim(s) {
  return (s ?? "").toString().trim();
}

async function dockerInspect(container) {
  try {
    const { stdout } = await execFileAsync("docker", [
      "inspect",
      container,
      "--format",
      "{{json .State}}",
    ]);
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

async function dockerExec(container, cmd) {
  const { stdout } = await execFileAsync(
    "docker",
    ["exec", "-i", container, "sh", "-lc", cmd],
    { maxBuffer: 10 * 1024 * 1024 }
  );
  return stdout.toString();
}

async function isValheimProcessRunning(container) {
  try {
    const out = await dockerExec(container, "pgrep -af 'valheim_server\\.exe' || true");
    if (safeTrim(out)) return true;
  } catch {}

  try {
    const out = await dockerExec(
      container,
      "ps aux | grep -i 'valheim_server\\.exe' | grep -v grep || true"
    );
    return Boolean(safeTrim(out));
  } catch {
    return false;
  }
}

// ---------- In-memory log tail + state ----------

const state = createValheimState({
  pendingTtlMs: CONFIG.pendingTtlMs,
  playerSeenTtlMs: CONFIG.playerSeenTtlMs,
  attemptsKeep: 30,
});

const rawLines = [];
function pushRaw(line) {
  rawLines.push(line);
  if (rawLines.length > CONFIG.rawKeepLines) {
    rawLines.splice(0, rawLines.length - CONFIG.rawKeepLines);
  }
}

const tail = createValheimLogTail({
  container: CONFIG.container,
  tailLines: CONFIG.tailLines,
});

tail.onLine((line) => {
  pushRaw(line);
  // docker logs doesn't provide reliable original timestamps => use now
  state.ingest(line, Date.now());
});

tail.onError((err) => {
  console.error("[valheimLogTail]", err?.message || err);
});

tail.start();

// ---------- Helpers for templates ----------

app.set("view engine", "ejs");

app.locals.fmtDateTime = (value) => {
  if (value === null || value === undefined || value === "") return "—";

  const d = typeof value === "number" ? new Date(value) : new Date(String(value));
  if (Number.isNaN(d.getTime())) return String(value);

  return new Intl.DateTimeFormat("uk-UA", {
    timeZone: "Europe/Kyiv",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(d);
};

app.locals.fmtAgo = (valueMs) => {
  if (!valueMs) return "—";
  const diff = Date.now() - valueMs;
  if (!Number.isFinite(diff) || diff < 0) return "—";

  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
};

// ---------- Build status for routes ----------

async function buildStatus() {
  const atMs = Date.now();

  const dockerState = await dockerInspect(CONFIG.container);
  const containerExists = Boolean(dockerState);
  const containerRunning = Boolean(dockerState?.Running);
  const containerStatus = dockerState?.Status || "unknown";
  const containerRestarting = Boolean(dockerState?.Restarting);

  const procRunning = containerRunning ? await isValheimProcessRunning(CONFIG.container) : false;

  const snap = state.getSnapshot();

  const logAgeSec =
    snap.lastSeenMs ? Math.max(0, Math.floor((Date.now() - snap.lastSeenMs) / 1000)) : null;

  const logFresh = logAgeSec !== null ? logAgeSec <= CONFIG.staleLogSeconds : false;

  const containerStartedAtMs = dockerState?.StartedAt ? Date.parse(dockerState.StartedAt) : null;

  const lastSeenOk =
    Boolean(snap.lastSeenMs) && (Date.now() - snap.lastSeenMs <= CONFIG.staleLogSeconds * 1000);

  // "Ready" = we saw ready marker AND it happened after current container start AND logs aren't stale
  const serverReady =
    containerRunning &&
    procRunning &&
    Boolean(snap.readyMs) &&
    (!containerStartedAtMs || snap.readyMs >= containerStartedAtMs) &&
    lastSeenOk;

  // "Online" (alive) = container+proc alive AND we saw fresh activity
  const online =
    containerRunning &&
    procRunning &&
    lastSeenOk;

  const lastError =
    !containerExists ? "Container not found" :
    !containerRunning ? `Container not running (${containerStatus})` :
    containerRestarting ? "Container restarting" :
    !procRunning ? "valheim_server.exe process not running" :
    !lastSeenOk ? `No fresh logs (${logAgeSec ?? "?"}s old)` :
    (!snap.readyMs ? "Server not ready yet (no ready marker seen)" :
      (containerStartedAtMs && snap.readyMs < containerStartedAtMs) ? "Ready marker is from previous container start" :
      null);

  return {
    atMs,

    container: CONFIG.container,
    containerExists,
    containerRunning,
    containerStatus,
    procRunning,

    logAgeSec,
    serverReady,
    online,
    lastError,

    connectionsHint: `proc=${procRunning ? "yes" : "no"}, logsFresh=${logFresh ? "yes" : "no"}`,

    world: snap.world,
    serverVersion: snap.serverVersion,
    lastLine: snap.lastLine,
    lastSeenMs: snap.lastSeenMs,
    firstSeenMs: snap.firstSeenMs,
    readyMs: snap.readyMs,

    playersOnline: snap.playersOnline,
    players: snap.players,

    pending: snap.pending,
    recentAttempts: snap.recentAttempts,
  };
}

// ---------- Routes ----------

app.get("/", async (req, res) => {
  const data = await buildStatus();
  res.render("index", { data, active: "dashboard" });
});

app.get("/debug", async (req, res) => {
  const data = await buildStatus();
  res.render("debug", { data, active: "debug" });
});

app.get("/debug/raw", async (req, res) => {
  res.type("text/plain").send(rawLines.slice(-400).join("\n"));
});

app.get("/api/status", async (req, res) => {
  const data = await buildStatus();
  res.json(data);
});

app.listen(CONFIG.port, "0.0.0.0", () => {
  console.log(`Valheim-status listening on http://0.0.0.0:${CONFIG.port}`);
});
