function safeTrim(s) {
  return (s ?? "").toString().trim();
}

function nowMs() {
  return Date.now();
}

function parseLogTimeMs(line) {
  // Matches: "02/17/2026 20:08:01: ..."
  const m = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}):(\d{2}):/.exec(line);
  if (!m) return null;

  const month = Number(m[1]);
  const day = Number(m[2]);
  const year = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6]);

  // Treat as local time on the host (Kyiv). This is fine for UI.
  const d = new Date(year, month - 1, day, hour, minute, second);
  const ms = d.getTime();
  return Number.isFinite(ms) ? ms : null;
}

export function createValheimState(options = {}) {
  const cfg = {
    pendingTtlMs: Number(options.pendingTtlMs ?? 2 * 60 * 1000), // 2 min
    playerSeenTtlMs: Number(options.playerSeenTtlMs ?? 10 * 60 * 1000), // 10 min
    attemptsKeep: Number(options.attemptsKeep ?? 30),
  };

  const state = {
    // General
    serverReadyFromLog: false,
    world: null,
    serverVersion: null, // { version, network }
    lastLine: null,

    // Timestamps (ms)
    firstSeenMs: null,
    lastSeenMs: null,
    readyMs: null,

    // Players
    pending: new Map(), // steamId -> { steamId, firstSeenMs, lastSeenMs, stage, lastReason }
    players: new Map(), // steamId -> { steamId, name, connectedMs, lastSeenMs, online, lastEvent }

    // Recent attempts and events
    recentAttempts: [], // newest last: { steamId, atMs, type, detail, line }
  };

  const re = {
    version: /Valheim version:\s*([0-9.]+)\s*\(network version\s*([0-9]+)\)/i,
    world: /Load world:\s*([^(]+)\s*\(/i,
    ready1: /Opened Steam server/i,
    ready2: /ZNET START/i,
    ready3: /Game server connected/i,
    ready4: /Registering lobby/i,

    conn: /Got connection SteamID\s+(\d+)/i,
    handshake: /Got handshake from client\s+(\d+)/i,
    wrongPw: /Peer\s+(\d+)\s+has wrong password/i,

    // Example: "Got character ZDOID from Pikus : 912527495:1"
    char: /Got character ZDOID from\s+(.+?)\s*:\s*/i,

    // Example: "RPC_Disconnect" and/or "Closing socket 7656..."
    closing: /Closing socket\s+(\d+)/i,
    closedByPeer: /Socket closed by peer/i,
    rpcDisconnect: /RPC_Disconnect\b/i,

    // Optional: can appear in some builds
    peerDisconnected: /Peer\s+(\d+)\s+disconnected/i,
  };

  function touch(atMs) {
    if (state.firstSeenMs === null) state.firstSeenMs = atMs;
    state.lastSeenMs = atMs;
  }

  function pushAttempt({ steamId, atMs, type, detail, line }) {
    state.recentAttempts.push({ steamId, atMs, type, detail, line });
    if (state.recentAttempts.length > cfg.attemptsKeep) {
      state.recentAttempts.splice(0, state.recentAttempts.length - cfg.attemptsKeep);
    }
  }

  function ensurePending(steamId, atMs) {
    let p = state.pending.get(steamId);
    if (!p) {
      p = {
        steamId,
        firstSeenMs: atMs,
        lastSeenMs: atMs,
        stage: "connected",
        lastReason: null,
      };
      state.pending.set(steamId, p);
    } else {
      p.lastSeenMs = atMs;
    }
    return p;
  }

  function ensurePlayer(steamId) {
    let p = state.players.get(steamId);
    if (!p) {
      p = {
        steamId,
        name: null,
        connectedMs: null,
        lastSeenMs: null,
        online: false,
        lastEvent: null,
      };
      state.players.set(steamId, p);
    }
    return p;
  }

  function markPlayerOnline(steamId, atMs, nameFromLine = null) {
    const player = ensurePlayer(steamId);

    const pend = state.pending.get(steamId);
    if (player.connectedMs === null) {
      player.connectedMs = pend?.firstSeenMs ?? atMs;
    }

    player.lastSeenMs = atMs;
    player.online = true;
    player.lastEvent = "in_world";
    if (nameFromLine) player.name = nameFromLine;

    if (pend) state.pending.delete(steamId);
  }

  function markPendingDrop(steamId, atMs, type, detail, line) {
    // Drop pending so it doesn't count as online
    const p = state.pending.get(steamId);
    if (p) {
      p.lastSeenMs = atMs;
      p.lastReason = type;
      state.pending.delete(steamId);
    }
    pushAttempt({ steamId, atMs, type, detail, line });
  }

  function markPlayerOffline(steamId, atMs, reason = "disconnect") {
    const player = state.players.get(steamId);
    if (!player) return;
    player.lastSeenMs = atMs;
    player.online = false;
    player.lastEvent = reason;
  }

  function cleanup(atMs) {
    // Drop stale pending
    for (const [steamId, p] of state.pending.entries()) {
      if (atMs - p.lastSeenMs > cfg.pendingTtlMs) {
        markPendingDrop(
          steamId,
          atMs,
          "pending_timeout",
          `Pending TTL exceeded (stage=${p.stage})`,
          null
        );
      }
    }

    // Optionally mark stale online players offline (if no activity for long time)
    for (const [steamId, p] of state.players.entries()) {
      if (p.online && p.lastSeenMs && atMs - p.lastSeenMs > cfg.playerSeenTtlMs) {
        p.online = false;
        p.lastEvent = "stale_timeout";
      }
    }
  }

  function findMostRecentPendingId() {
    // choose pending with latest lastSeenMs
    let best = null;
    for (const p of state.pending.values()) {
      if (!best || p.lastSeenMs > best.lastSeenMs) best = p;
    }
    return best?.steamId ?? null;
  }

  function ingest(line, atMs = nowMs()) {
    const l = safeTrim(line);
    if (!l) return;

    const parsedMs = parseLogTimeMs(l);
    const tMs = Number.isFinite(atMs) ? atMs : (parsedMs ?? nowMs());

    state.lastLine = l;
    touch(tMs);
    cleanup(tMs);

    if (!state.readyMs && (re.ready3.test(l) || re.ready4.test(l))) {
      state.readyMs = tMs;
    }

    // Ready markers
    if (!state.serverReadyFromLog && (re.ready1.test(l) || re.ready2.test(l))) {
      state.serverReadyFromLog = true;
    }

    // Version
    const mv = l.match(re.version);
    if (mv) {
      state.serverVersion = { version: mv[1], network: mv[2] };
    }

    // World
    const mw = l.match(re.world);
    if (mw) {
      state.world = safeTrim(mw[1]);
    }

    // Got connection SteamID
    const mc = l.match(re.conn);
    if (mc) {
      const steamId = mc[1];
      const p = ensurePending(steamId, atMs);
      p.stage = "connected";
      return;
    }

    // Handshake
    const mh = l.match(re.handshake);
    if (mh) {
      const steamId = mh[1];
      const p = ensurePending(steamId, atMs);
      p.stage = "handshake";
      return;
    }

    // Wrong password
    const mwp = l.match(re.wrongPw);
    if (mwp) {
      const steamId = mwp[1];
      ensurePending(steamId, atMs);
      markPendingDrop(steamId, atMs, "wrong_password", "Rejected at password prompt", l);
      // Ensure not counted online
      markPlayerOffline(steamId, atMs, "wrong_password");
      return;
    }

    // Character ZDOID => player is actually in the world
    const mchar = l.match(re.char);
    if (mchar) {
      const name = safeTrim(mchar[1]);
      // Usually SteamID already exists in pending. Bind to the most recent pending.
      const steamId = findMostRecentPendingId();
      if (steamId) {
        markPlayerOnline(steamId, atMs, name);
      } else {
        // No pending? Create pseudo player keyed by name hash-ish? Better: keep as "unknown"
        // We'll store under "unknown:<name>" to avoid losing info.
        const pseudoId = `unknown:${name}`;
        const p = ensurePlayer(pseudoId);
        if (p.connectedMs === null) p.connectedMs = atMs;
        p.lastSeenMs = atMs;
        p.online = true;
        p.lastEvent = "in_world";
        p.name = name;
      }
      return;
    }

    // Closing socket <steamId>
    const mclose = l.match(re.closing);
    if (mclose) {
      const steamId = mclose[1];
      // If still pending -> attempt (didn't enter world)
      if (state.pending.has(steamId)) {
        const p = state.pending.get(steamId);
        markPendingDrop(
          steamId,
          atMs,
          "disconnect_before_join",
          `Closed before join (stage=${p?.stage ?? "unknown"})`,
          l
        );
      } else if (state.players.has(steamId)) {
        // Player was online (or known) -> mark offline
        markPlayerOffline(steamId, atMs, "closing_socket");
      }
      return;
    }

    // Peer disconnected (if present)
    const mpd = l.match(re.peerDisconnected);
    if (mpd) {
      const steamId = mpd[1];
      markPlayerOffline(steamId, atMs, "peer_disconnected");
      return;
    }

    // Generic disconnect markers: useful but without steamId we can't attribute reliably
    if (re.rpcDisconnect.test(l) || re.closedByPeer.test(l)) {
      // We don't flip everyone offline on generic line — it may be one player.
      // Just keep state touched.
      return;
    }

    cleanup(atMs);
  }

  function getSnapshot() {
    const players = Array.from(state.players.values())
      .filter((p) => p.online)
      .sort((a, b) => (b.lastSeenMs ?? 0) - (a.lastSeenMs ?? 0));

    // Also expose pending for debug
    const pending = Array.from(state.pending.values()).sort(
      (a, b) => (b.lastSeenMs ?? 0) - (a.lastSeenMs ?? 0)
    );

    const recentAttempts = state.recentAttempts
      .slice()
      .reverse(); // newest first for UI

    return {
      serverReadyFromLog: state.serverReadyFromLog,
      world: state.world,
      serverVersion: state.serverVersion,
      lastLine: state.lastLine,
      firstSeenMs: state.firstSeenMs,
      lastSeenMs: state.lastSeenMs,
      readyMs: state.readyMs,
      playersOnline: players.length,
      players,
      pending,
      recentAttempts,
    };
  }

  function reset() {
    state.serverReadyFromLog = false;
    state.world = null;
    state.serverVersion = null;
    state.lastLine = null;
    state.firstSeenMs = null;
    state.lastSeenMs = null;
    state.pending.clear();
    state.players.clear();
    state.recentAttempts.length = 0;
  }

  return {
    ingest,
    getSnapshot,
    reset,
  };
}
