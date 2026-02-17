import { spawn } from "node:child_process";
import readline from "node:readline";

export function createValheimLogTail({ container, tailLines = 400 }) {
  let proc = null;
  let rl = null;
  let restarting = false;
  let stoppedManually = false;

  const handlers = {
    line: [],
    error: [],
  };

  function onLine(fn) {
    handlers.line.push(fn);
  }

  function onError(fn) {
    handlers.error.push(fn);
  }

  function emitLine(line) {
    for (const fn of handlers.line) {
      try { fn(line); } catch {}
    }
  }

  function emitError(err) {
    for (const fn of handlers.error) {
      try { fn(err); } catch {}
    }
  }

  function start() {
    if (proc) {
      // already running
      return;
    }

    stoppedManually = false;

    proc = spawn(
      "docker",
      ["logs", "-f", "--tail", String(tailLines), container],
      { stdio: ["ignore", "pipe", "pipe"] }
    );

    proc.on("error", (err) => {
      emitError(err);
    });

    rl = readline.createInterface({ input: proc.stdout });

    rl.on("line", (line) => {
      emitLine(line);
    });

    let errBuf = "";

    proc.stderr.on("data", (chunk) => {
      errBuf += chunk.toString("utf8");
      if (errBuf.length > 8000) {
        errBuf = errBuf.slice(-8000);
      }
    });

    proc.on("close", (code, signal) => {
      cleanup();

      if (stoppedManually) return;

      const msg =
        `docker logs exited (code=${code}, signal=${signal})` +
        (errBuf ? ` | ${errBuf.trim()}` : "");

      emitError(new Error(msg));

      if (!restarting) {
        restarting = true;
        setTimeout(() => {
          restarting = false;
          start();
        }, 1500);
      }
    });
  }

  function stop() {
    stoppedManually = true;

    if (proc) {
      proc.kill("SIGTERM");
    }

    cleanup();
  }

  function cleanup() {
    if (rl) {
      rl.removeAllListeners();
      rl.close();
      rl = null;
    }

    if (proc) {
      proc.removeAllListeners();
      proc = null;
    }
  }

  return {
    onLine,
    onError,
    start,
    stop,
  };
}
