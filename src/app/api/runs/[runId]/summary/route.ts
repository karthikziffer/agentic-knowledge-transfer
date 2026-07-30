import { getRun } from "@/server/runManager";
import { getRunFromDb, saveRunSummary } from "@/server/runs";
import { generateFlowSummary } from "@/server/flowSummary";
import { getOptionalSession } from "@/server/dal";
import type { RunRecord } from "@/server/types";

export async function POST(
  _request: Request,
  ctx: RouteContext<"/api/runs/[runId]/summary">,
) {
  const session = await getOptionalSession();
  if (!session) {
    return Response.json({ error: "not authenticated" }, { status: 401 });
  }

  const { runId } = await ctx.params;

  const job = getRun(runId);
  const record: RunRecord | null = job?.record ?? (await getRunFromDb(runId));
  if (!record || record.userId !== session.userId) {
    return Response.json({ error: "run not found" }, { status: 404 });
  }

  if (record.status === "running" || record.status === "queued") {
    return Response.json({ error: "Wait for the run to finish before summarizing it" }, { status: 400 });
  }

  // Streamed as newline-delimited JSON rather than one final Response.json:
  // generation runs the flowSummary agent's loadRun -> captionSteps (one
  // vision call per step) -> synthesize pipeline, which can take a minute
  // on longer sessions — the client renders each "progress" line as it
  // arrives instead of showing one opaque spinner for the whole thing.
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      function send(line: object) {
        controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
      }
      try {
        const summary = await generateFlowSummary(runId, (progress) => send({ type: "progress", progress }));
        await saveRunSummary(runId, summary);
        send({ type: "done", summary });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to generate summary";
        send({ type: "error", error: message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8" },
  });
}
