import { getRun } from "@/server/runManager";
import { getRunFromDb, getAlternativeSuggestions } from "@/server/runs";
import { enqueueAlternativesJob, alternativesProgressChannel } from "@/server/alternativesQueue";
import { subscribeOnce } from "@/server/redisPubSub";
import { getOptionalSession } from "@/server/dal";
import type { AlternativesProgress, RunRecord } from "@/server/types";

// Safety net for when no worker process (worker.ts, run as a separate
// docker-compose service) is up to pick the job off the queue at all — the
// job just sits "waiting" in Redis forever otherwise, and this stream would
// hang open with the client spinning indefinitely.
const JOB_TIMEOUT_MS = 3 * 60_000;

async function loadOwnedRun(runId: string, userId: string): Promise<RunRecord | null> {
  const job = getRun(runId);
  const record: RunRecord | null = job?.record ?? (await getRunFromDb(runId));
  if (!record || record.userId !== userId) return null;
  return record;
}

function parseStepIndex(record: RunRecord, raw: unknown): number | null {
  const stepIndex = Number(raw);
  if (!Number.isInteger(stepIndex) || stepIndex < 0 || stepIndex >= record.steps.length) return null;
  return stepIndex;
}

// Cache-only read — never runs the pipeline, just returns whatever's
// already been generated for this step (or null).
export async function GET(
  request: Request,
  ctx: RouteContext<"/api/runs/[runId]/alternatives/suggest">,
) {
  const session = await getOptionalSession();
  if (!session) {
    return Response.json({ error: "not authenticated" }, { status: 401 });
  }

  const { runId } = await ctx.params;
  const record = await loadOwnedRun(runId, session.userId);
  if (!record) {
    return Response.json({ error: "run not found" }, { status: 404 });
  }

  const url = new URL(request.url);
  const stepIndex = parseStepIndex(record, url.searchParams.get("stepIndex"));
  if (stepIndex === null) {
    return Response.json({ error: "Invalid step index" }, { status: 400 });
  }

  const cached = await getAlternativeSuggestions(runId, stepIndex);
  return Response.json({
    suggestions: cached?.candidates ?? null,
    model: cached?.model,
    generatedAt: cached?.generatedAt,
    explorationScreenshot: cached?.explorationScreenshot,
  });
}

// The expensive call — launches a real browser and makes two LLM calls, so
// it's only ever triggered by an explicit "Find alternatives" click, never
// automatically. Runs in a separate worker process (worker.ts /
// src/server/alternativesQueue.ts), not this web request — this just
// enqueues the job and relays its progress/result back over Redis pub/sub
// as newline-delimited JSON, same streaming shape /api/runs/[runId]/summary
// uses for the (in-process) flow-summary agent.
export async function POST(
  request: Request,
  ctx: RouteContext<"/api/runs/[runId]/alternatives/suggest">,
) {
  const session = await getOptionalSession();
  if (!session) {
    return Response.json({ error: "not authenticated" }, { status: 401 });
  }

  const { runId } = await ctx.params;
  const record = await loadOwnedRun(runId, session.userId);
  if (!record) {
    return Response.json({ error: "run not found" }, { status: 404 });
  }
  if (record.status === "running" || record.status === "queued") {
    return Response.json({ error: "Wait for the run to finish first" }, { status: 400 });
  }

  const body = await request.json().catch(() => null);
  const stepIndex = parseStepIndex(record, body?.stepIndex);
  if (stepIndex === null) {
    return Response.json({ error: "Invalid step index" }, { status: 400 });
  }

  const step = record.steps[stepIndex];
  if (!step.locator || (step.type !== "manual-click" && step.type !== "replay-click")) {
    return Response.json(
      { error: "This step has no recorded click target to find alternatives for" },
      { status: 400 },
    );
  }

  const channel = alternativesProgressChannel(runId, stepIndex);
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  let settled = false;

  function cleanup() {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    unsubscribe?.();
  }

  const stream = new ReadableStream({
    start(controller) {
      function send(line: object) {
        controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
      }

      // Subscribed before the job is enqueued below — the worker could
      // finish and publish "done" almost immediately after picking the job
      // up, and Redis pub/sub has no backlog: a message published before a
      // subscriber exists is lost forever.
      unsubscribe = subscribeOnce(channel, (payload) => {
        const msg = payload as
          | { type: "progress"; progress: AlternativesProgress }
          | { type: "done"; suggestions: unknown; explorationScreenshot?: string }
          | { type: "error"; error: string };
        if (msg.type === "progress") {
          send(msg);
          return;
        }
        if (settled) return;
        settled = true;
        cleanup();
        send(msg);
        controller.close();
      });

      timeoutHandle = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        send({ type: "error", error: "Timed out waiting for a worker to pick this up — is the worker running?" });
        controller.close();
      }, JOB_TIMEOUT_MS);

      enqueueAlternativesJob(runId, stepIndex).catch((err: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        const message = err instanceof Error ? err.message : "Failed to queue alternative-suggestion job";
        send({ type: "error", error: message });
        controller.close();
      });
    },
    cancel() {
      // Client disconnected early (closed tab, navigated away) — without
      // this the Redis subscriber connection and the pending timeout would
      // leak for up to JOB_TIMEOUT_MS.
      settled = true;
      cleanup();
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8" },
  });
}
