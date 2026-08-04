"use client";

import { useEffect, useRef, useState } from "react";
import { useToast } from "@/components/Toast";
import AgentDecisionPanel from "@/components/AgentDecisionPanel";
import type { ControlModeReason, ManualInputEvent, RunRecord, StepResult } from "@/server/types";

type WsMessage =
  | { type: "history"; record: RunRecord }
  | { type: "frame"; data: string }
  | { type: "step"; step: StepResult }
  | { type: "status"; status: RunRecord["status"]; error?: string }
  | { type: "control-mode"; mode: "auto" | "manual"; reason?: ControlModeReason }
  | { type: "continue-warning"; message: string };

const CONTROL_REASON_COPY: Record<ControlModeReason, string> = {
  typing:
    "This step needs typing — recorded sessions never store what was typed, for privacy. Fill it in, then continue.",
  drift:
    "Couldn't find the recorded target — the page may have changed. Fix it manually, then continue.",
};

const STATUS_PILL: Record<string, string> = {
  queued: "pill-queued",
  pending: "pill-queued",
  running: "pill-running",
  done: "pill-done",
  completed: "pill-done",
  error: "pill-error",
};

// With no color to lean on, each status gets its own glyph shape instead —
// hollow/solid/check/cross reads at a glance the way red/amber/green used
// to.
const STATUS_GLYPH: Record<string, string> = {
  queued: "○",
  pending: "○",
  running: "●",
  done: "✓",
  completed: "✓",
  error: "✕",
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`pill ${STATUS_PILL[status] ?? "pill-queued"}`}>
      <span className="pill-glyph">{STATUS_GLYPH[status] ?? "○"}</span>
      {status}
    </span>
  );
}

// Caps outgoing mousemove messages so dragging across the frame doesn't
// flood the WS / CDP with hundreds of events per second.
const MOUSE_MOVE_MIN_INTERVAL_MS = 16;

export default function LiveRunView({
  runId,
  onStatusChange,
  endControl = "finish",
}: {
  runId: string;
  onStatusChange?: (status: RunRecord["status"]) => void;
  // "finish" (default) sends the WS "finish" message — only meaningful for
  // manual/replay sessions, which wireManualControl (automation.ts) listens
  // for. Background runs with no such listener (crawlTask/validateTask in
  // actionGraph.ts) need "stop" instead — a real abort via the REST
  // /api/runs/{id}/stop route (job.requestStop(), which those tasks' loops
  // actually check), not a signal nothing is listening for.
  endControl?: "finish" | "stop";
}) {
  const toast = useToast();
  const [status, setStatus] = useState<RunRecord["status"] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [steps, setSteps] = useState<StepResult[]>([]);
  const [frame, setFrame] = useState<string | null>(null);
  const [controlMode, setControlMode] = useState<"auto" | "manual">("auto");
  const [controlReason, setControlReason] = useState<ControlModeReason | undefined>(undefined);
  const [continueWarning, setContinueWarning] = useState<string | null>(null);
  // Which step's decision-trail disclosure (step.agentDecision) is open, if
  // any — only steps from an Agent run have one to expand.
  const [expandedStep, setExpandedStep] = useState<number | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const lastMouseMoveAt = useRef(0);

  useEffect(() => {
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${protocol}://${window.location.host}/ws?runId=${runId}`);
    wsRef.current = ws;

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data) as WsMessage;
      if (msg.type === "history") {
        setSteps(msg.record.steps);
        setStatus(msg.record.status);
        setError(msg.record.error ?? null);
        onStatusChange?.(msg.record.status);
      } else if (msg.type === "frame") {
        setFrame(msg.data);
      } else if (msg.type === "step") {
        setSteps((prev) => {
          const next = [...prev];
          const idx = next.findIndex((s) => s.index === msg.step.index);
          if (idx >= 0) next[idx] = msg.step;
          else next.push(msg.step);
          return next;
        });
        setContinueWarning(null);
      } else if (msg.type === "status") {
        setStatus(msg.status);
        // A live failure happening right now — unlike the "history" branch
        // above (msg.record.error), which can just be replaying a run's
        // already-known past outcome on initial connect and would toast
        // stale news every time someone reopens an already-errored run.
        if (msg.error) {
          setError(msg.error);
          toast.error(msg.error);
        }
        onStatusChange?.(msg.status);
      } else if (msg.type === "control-mode") {
        setControlMode(msg.mode);
        setControlReason(msg.reason);
        setContinueWarning(null);
      } else if (msg.type === "continue-warning") {
        setContinueWarning(msg.message);
      }
    };

    // The server closes the socket immediately (code 1008, "run not found")
    // whenever getRun(runId) has nothing — including the moment a run gets
    // caught by queue.ts's markRunLost() as orphaned, or simply because this
    // process died mid-session (a restart/redeploy/crash) and dropped the
    // connection outright. Either way, without this the view would freeze
    // forever at whatever the last WS message said (e.g. stuck "queued")
    // instead of ever learning the run actually finished/errored. Falls back
    // to the real, persisted status rather than trusting stale in-memory
    // state that can no longer be updated by anything.
    ws.onclose = () => {
      fetch(`/api/runs/${runId}`)
        .then((res) => res.json())
        .then((body: { record?: RunRecord }) => {
          if (!body.record) return;
          setStatus(body.record.status);
          setError(body.record.error ?? null);
          onStatusChange?.(body.record.status);
        })
        .catch(() => {});
    };

    return () => {
      ws.onclose = null;
      ws.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  function sendInput(event: ManualInputEvent) {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "input", event }));
    }
  }

  function finish() {
    wsRef.current?.send(JSON.stringify({ type: "finish" }));
  }

  // REST, not WS — this is job.requestStop() (the same mechanism the
  // /api/runs/{id}/stop route already exposes for the run list's own stop
  // action), which crawlTask/validateTask's loops actually check, unlike
  // "finish" above.
  async function stopRun() {
    try {
      const res = await fetch(`/api/runs/${runId}/stop`, { method: "POST" });
      if (!res.ok) {
        // Previously swallowed silently — a click that fails (e.g. the run
        // already finished/errored moments earlier, so it's no longer
        // "running"/"queued" server-side) looked exactly like a click that
        // did nothing at all, with zero feedback either way.
        const body = await res.json().catch(() => ({}));
        toast.error(body.error ?? "Failed to stop this run");
        return;
      }
      // Stop takes priority over waiting for the server to confirm — a
      // successful stop request means this run is done, full stop, so
      // reflect that immediately rather than sitting in "queued"/"running"
      // until the next WS "status" push (or, if the socket already closed,
      // the next poll tick) catches up. Anything upstream tracking "is this
      // run still active" via onStatusChange (e.g. SkillActionGraph's
      // crawl/validate buttons) learns about it right away instead of
      // staying disabled for up to a few seconds after Stop was clicked.
      // The eventual WS "status" message still arrives and overwrites this
      // with the authoritative error text — this is just the immediate,
      // optimistic signal.
      setStatus("error");
      setError("Stopped by user");
      onStatusChange?.("error");
    } catch {
      toast.error("Failed to stop this run — check your connection and try again");
    }
  }

  function resumeReplay() {
    wsRef.current?.send(JSON.stringify({ type: "resume-replay" }));
  }

  function applyDriftSuggestion() {
    wsRef.current?.send(JSON.stringify({ type: "apply-drift-suggestion" }));
  }

  // Scales a click/move position from the displayed (CSS-sized) image to
  // the actual frame pixel space the CDP session expects (1280x800).
  //
  // The <img> uses object-cover (className below) so the frame always fills
  // its box completely with no letterbox bars — whenever the box's own
  // aspect ratio doesn't exactly match the frame's (1280x800 = 1.6:1), the
  // picture is scaled up until it fully covers the box and the overflow on
  // one axis is cropped off, centered. getBoundingClientRect() still
  // reports the (smaller) visible box, not the larger true rendered image —
  // naively dividing by the box size drifts the more the box's aspect ratio
  // diverges from the frame's. Compute the true rendered image's rect
  // (cover-fit math: scale by the *larger* ratio, not the smaller one
  // object-contain would use) and map against that instead, so a click near
  // a cropped edge still lands on the right pixel of the real page rather
  // than one that's already scrolled off-screen.
  function frameCoords(e: { clientX: number; clientY: number }): { x: number; y: number } | null {
    const img = imgRef.current;
    if (!img || !img.naturalWidth || !img.naturalHeight) return null;
    const rect = img.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;

    const scale = Math.max(rect.width / img.naturalWidth, rect.height / img.naturalHeight);
    const renderedWidth = img.naturalWidth * scale;
    const renderedHeight = img.naturalHeight * scale;
    const offsetX = rect.left - (renderedWidth - rect.width) / 2;
    const offsetY = rect.top - (renderedHeight - rect.height) / 2;

    const x = (e.clientX - offsetX) / scale;
    const y = (e.clientY - offsetY) / scale;
    if (x < 0 || y < 0 || x > img.naturalWidth || y > img.naturalHeight) return null;
    return { x, y };
  }

  function handleMouseDown(e: React.MouseEvent<HTMLDivElement>) {
    if (controlMode !== "manual") return;
    e.preventDefault();
    e.currentTarget.focus();
    const c = frameCoords(e);
    if (c) sendInput({ kind: "mousePressed", x: c.x, y: c.y, button: "left", clickCount: 1 });
  }

  function handleMouseUp(e: React.MouseEvent) {
    if (controlMode !== "manual") return;
    e.preventDefault();
    const c = frameCoords(e);
    if (c) sendInput({ kind: "mouseReleased", x: c.x, y: c.y, button: "left", clickCount: 1 });
  }

  function handleMouseMove(e: React.MouseEvent) {
    if (controlMode !== "manual") return;
    const now = performance.now();
    if (now - lastMouseMoveAt.current < MOUSE_MOVE_MIN_INTERVAL_MS) return;
    lastMouseMoveAt.current = now;
    const c = frameCoords(e);
    if (c) sendInput({ kind: "mouseMoved", x: c.x, y: c.y });
  }

  // React attaches its synthetic onWheel listener as passive by default, so
  // e.preventDefault() inside a plain JSX onWheel prop is silently ignored
  // — the outer page scrolls right along with (or instead of) the forwarded
  // input. A real, non-passive listener is required to actually stop it.
  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;

    const onWheelNative = (e: WheelEvent) => {
      if (controlMode !== "manual") return;
      e.preventDefault();
      const c = frameCoords(e);
      if (c) sendInput({ kind: "mouseWheel", x: c.x, y: c.y, deltaX: e.deltaX, deltaY: e.deltaY });
    };

    el.addEventListener("wheel", onWheelNative, { passive: false });
    return () => el.removeEventListener("wheel", onWheelNative);
  }, [controlMode]);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (controlMode !== "manual") return;
    e.preventDefault();
    sendInput({ kind: "rawKeyDown", key: e.key, code: e.code, keyCode: e.keyCode });
    const isPrintable = e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;
    if (isPrintable) {
      sendInput({ kind: "char", key: e.key, code: e.code, keyCode: e.keyCode, text: e.key });
    }
  }

  function handleKeyUp(e: React.KeyboardEvent) {
    if (controlMode !== "manual") return;
    e.preventDefault();
    sendInput({ kind: "keyUp", key: e.key, code: e.code, keyCode: e.keyCode });
  }

  const isRunning = status === "running";
  const isQueued = status === "queued";
  const manual = controlMode === "manual";
  // The paused step is always the most recently added one right before
  // control-mode flips to manual/drift — once resumed, the next logged step
  // (the actual click, or the human's own manual action) becomes the last
  // one and this naturally stops showing.
  const driftSuggestion =
    manual && controlReason === "drift" ? steps[steps.length - 1]?.driftSuggestion : undefined;

  return (
    <div className="flex flex-col gap-3 lg:h-full lg:min-h-0">
      <div className="flex shrink-0 items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h2 className="eyebrow">Live view</h2>
          {status && <StatusBadge status={status} />}
        </div>
        {(isRunning || isQueued) && (
          <div className="flex items-center gap-2">
            {controlReason && (
              <button onClick={resumeReplay} className="btn btn-primary">
                Continue replay
              </button>
            )}
            {/* Nothing's actually running yet while queued — there's no live
                control-mode session for "Finish" to gracefully end, so the
                only sensible action is cancelling the queue entry itself,
                regardless of what endControl says a *running* instance of
                this same run type would show. */}
            {isQueued || endControl === "stop" ? (
              <button onClick={stopRun} className="btn btn-secondary">
                Stop
              </button>
            ) : (
              <button onClick={finish} className={controlReason ? "btn btn-secondary" : "btn btn-primary"}>
                Finish
              </button>
            )}
          </div>
        )}
      </div>

      {continueWarning && (
        <p className="shrink-0 text-xs font-medium text-amber-600">⚠ {continueWarning}</p>
      )}

      {/* items-stretch (the grid default) makes the step list match the
          frame column's rendered height, so it — not the page — is the
          thing that scrolls when there are more steps than fit. */}
      <div className="grid grid-cols-1 gap-4 lg:min-h-0 lg:flex-1 lg:grid-cols-[1fr_320px]">
        <div className="flex flex-col gap-3 lg:min-h-0">
          <div
            ref={frameRef}
            tabIndex={manual ? 0 : -1}
            onMouseDown={handleMouseDown}
            onMouseUp={handleMouseUp}
            onMouseMove={handleMouseMove}
            onKeyDown={handleKeyDown}
            onKeyUp={handleKeyUp}
            onContextMenu={(e) => manual && e.preventDefault()}
            className={`flex aspect-video items-center justify-center overflow-hidden rounded-lg border bg-black outline-none lg:aspect-auto lg:min-h-0 lg:flex-1 ${
              manual ? "cursor-crosshair border-accent ring-2 ring-accent/40" : "border-edge"
            }`}
          >
            {frame ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                ref={imgRef}
                src={`data:image/jpeg;base64,${frame}`}
                alt="Live browser view"
                draggable={false}
                className="h-full w-full select-none object-cover"
              />
            ) : status === "error" || status === "completed" ? (
              // The run already reached a terminal state without ever
              // sending a frame — e.g. it was caught as orphaned
              // (queue.ts's markRunLost) or errored before the browser
              // finished launching. A spinner + "waiting" here would
              // falsely suggest something is still in progress; nothing
              // will ever arrive for this run.
              <div className="flex flex-col items-center gap-2 px-4 text-center">
                <span className="text-lg text-white/30">✕</span>
                <p className="font-mono text-xs text-white/40">
                  No live frame was captured — this run ended before a browser view was available.
                </p>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-2">
                <span className="h-6 w-6 animate-spin rounded-full border-2 border-white/20 border-t-white/50" />
                <p className="skeleton font-mono text-xs text-white/40">
                  Waiting for browser to start…
                </p>
              </div>
            )}
          </div>

          {driftSuggestion && (
            <div className="card flex shrink-0 items-start gap-3 p-3">
              {driftSuggestion.candidatesScreenshot && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={`/api/artifacts/${runId}/${driftSuggestion.candidatesScreenshot}`}
                  alt="Highlighted candidates the AI compared"
                  className="h-16 w-24 shrink-0 rounded-md border border-edge object-cover object-top"
                />
              )}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <p className="text-[12px] font-medium text-ink">AI suggestion: {driftSuggestion.description}</p>
                  <span className="pill pill-queued shrink-0 text-[9px]">{driftSuggestion.confidence} confidence</span>
                </div>
                <p className="mt-1 text-[11px] text-ink-muted">{driftSuggestion.reasoning}</p>
                <button type="button" onClick={applyDriftSuggestion} className="btn btn-primary mt-2">
                  Use this match
                </button>
              </div>
            </div>
          )}

          {manual && (
            <p className="shrink-0 text-xs font-medium text-ink">
              {controlReason ? (
                CONTROL_REASON_COPY[controlReason]
              ) : (
                <>
                  You&apos;re in control — click into the frame and interact with it like a normal
                  browser window. Click &quot;Finish&quot; when you&apos;re done.
                </>
              )}
            </p>
          )}

          {error && <p className="shrink-0 text-xs text-error">{error}</p>}
        </div>

        {steps.length > 0 && (
          <ol className="card overflow-y-auto lg:h-full lg:min-h-0">
            {steps.map((step) => {
              const hasDecision = Boolean(step.agentDecision);
              const isExpanded = expandedStep === step.index;
              return (
                <li key={step.index} className="flex flex-col">
                  <button
                    type="button"
                    disabled={!hasDecision}
                    onClick={() => setExpandedStep(isExpanded ? null : step.index)}
                    className="row flex w-full items-center gap-3 text-left disabled:cursor-default"
                  >
                    <StatusBadge status={step.status} />
                    <span className="flex-1 truncate text-[13px] text-ink">
                      {step.description ?? step.type}
                    </span>
                    {step.replayOf !== undefined && <span className="pill pill-done shrink-0">auto</span>}
                    {step.recordedAmbiguityWarning && (
                      <span
                        className="shrink-0 text-amber-600"
                        title={step.recordedAmbiguityWarning}
                        aria-label={step.recordedAmbiguityWarning}
                      >
                        ⚠
                      </span>
                    )}
                    {step.error && (
                      <span className="max-w-[40%] truncate text-xs text-error">{step.error}</span>
                    )}
                    {hasDecision && (
                      <span className="shrink-0 text-ink-faint">{isExpanded ? "▾" : "▸"}</span>
                    )}
                  </button>

                  {hasDecision && isExpanded && (
                    <div className="border-t border-edge bg-surface-2/60 px-3 py-2.5">
                      <AgentDecisionPanel decision={step.agentDecision!} />
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </div>
  );
}
