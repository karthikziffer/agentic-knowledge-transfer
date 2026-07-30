import { createServer, type IncomingMessage } from "http";
import { parse } from "url";
import next from "next";
import { WebSocketServer, WebSocket } from "ws";
import { getRun } from "./src/server/runManager";
import { decrypt, SESSION_COOKIE_NAME } from "./src/server/jwt";
import { startRunWorker } from "./src/server/queue";
import { reconcileOrphanedRuns } from "./src/server/runs";
import type { ManualInputEvent } from "./src/server/types";

function getSessionCookie(req: IncomingMessage): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === SESSION_COOKIE_NAME) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

const dev = process.env.NODE_ENV !== "production";
const port = parseInt(process.env.PORT || "3000", 10);

const app = next({ dev });
const handle = app.getRequestHandler();

app.prepare().then(async () => {
  const server = createServer((req, res) => {
    handle(req, res);
  });

  // Before accepting new work — any run still marked running/queued at this
  // point is left over from before this process started (RunJob state is
  // in-memory only) and needs to be marked as such, not picked up as if it
  // were live.
  await reconcileOrphanedRuns().catch((err) => {
    console.error("[startup] failed to reconcile orphaned runs", err);
  });

  const maxConcurrentRuns = parseInt(process.env.MAX_CONCURRENT_RUNS || "2", 10);
  startRunWorker(maxConcurrentRuns);

  // Route upgrades ourselves instead of handing `server` to WebSocketServer:
  // that would make `ws` claim every upgrade request on this server,
  // including Next's own HMR websocket, and 400-reject anything whose path
  // isn't /ws.
  const wss = new WebSocketServer({ noServer: true });
  const nextUpgradeHandler = app.getUpgradeHandler();

  server.on("upgrade", (req, socket, head) => {
    const { pathname } = parse(req.url ?? "");
    if (pathname === "/ws") {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    } else {
      nextUpgradeHandler(req, socket, head);
    }
  });

  wss.on("connection", (ws, req) => {
    const { query } = parse(req.url ?? "", true);
    const runId = typeof query.runId === "string" ? query.runId : undefined;

    if (!runId) {
      ws.close(1008, "runId query param required");
      return;
    }

    const job = getRun(runId);
    if (!job) {
      ws.close(1008, "run not found");
      return;
    }

    void (async () => {
      const session = await decrypt(getSessionCookie(req));
      if (!session || session.userId !== job.record.userId) {
        ws.close(1008, "not authorized");
        return;
      }

      ws.send(JSON.stringify({ type: "history", record: job.record }));

      const send = (payload: unknown) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(payload));
        }
      };

      const onFrame = (data: string) => send({ type: "frame", data });
      const onStep = (step: unknown) => send({ type: "step", step });
      const onStatus = (status: unknown) =>
        send({ type: "status", ...(status as object) });
      const onControlMode = (payload: unknown) =>
        send({ type: "control-mode", ...(payload as object) });
      const onContinueWarning = (message: string) => send({ type: "continue-warning", message });

      job.on("frame", onFrame);
      job.on("step", onStep);
      job.on("status", onStatus);
      job.on("control-mode", onControlMode);
      job.on("continue-warning", onContinueWarning);

      send({ type: "control-mode", mode: job.controlMode });

      // Client -> server: "finish" / forwarded mouse+keyboard input during
      // manual control. Only the run's owner can reach this handler at all
      // (checked above before any listeners are attached), so no further
      // auth check is needed per-message.
      ws.on("message", (raw) => {
        let msg: { type?: string; event?: ManualInputEvent };
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (msg.type === "finish") job.requestFinish();
        else if (msg.type === "input" && msg.event) job.dispatchInput(msg.event);
        else if (msg.type === "resume-replay") job.requestResumeReplay();
        else if (msg.type === "apply-drift-suggestion") job.requestApplyDriftSuggestion();
      });

      ws.on("close", () => {
        job.off("frame", onFrame);
        job.off("step", onStep);
        job.off("status", onStatus);
        job.off("control-mode", onControlMode);
        job.off("continue-warning", onContinueWarning);
      });
    })();
  });

  server.listen(port, () => {
    console.log(`> skill-builder ready on http://localhost:${port}`);
  });
});
