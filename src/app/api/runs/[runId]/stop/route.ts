import { getRun } from "@/server/runManager";
import { getOptionalSession } from "@/server/dal";
import { cancelQueuedRun } from "@/server/queue";
import { finalizeWithoutRunning } from "@/server/automation";

export async function POST(
  _request: Request,
  ctx: RouteContext<"/api/runs/[runId]/stop">,
) {
  const session = await getOptionalSession();
  if (!session) {
    return Response.json({ error: "not authenticated" }, { status: 401 });
  }

  const { runId } = await ctx.params;

  const job = getRun(runId);
  if (!job || job.record.userId !== session.userId) {
    return Response.json({ error: "run not found" }, { status: 404 });
  }
  if (job.record.status !== "running" && job.record.status !== "queued") {
    return Response.json(
      { error: "run is not currently running or queued" },
      { status: 400 },
    );
  }

  const wasQueued = job.record.status === "queued";
  job.requestStop();

  if (wasQueued) {
    const cancelled = await cancelQueuedRun(runId);
    // If cancellation failed, the worker already grabbed it in the race
    // between our status check and the cancel call — runTask's own
    // stopRequested check (job.requestStop() already set the flag above)
    // will finalize it instead.
    if (cancelled) {
      finalizeWithoutRunning(job, "Stopped by user");
    }
  }

  return Response.json({ ok: true });
}
