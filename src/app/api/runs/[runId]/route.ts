import { deleteRun, getRun } from "@/server/runManager";
import { deleteRunArtifacts } from "@/server/artifacts";
import { deleteRunRow, getRunFromDb } from "@/server/runs";
import { getOptionalSession } from "@/server/dal";
import type { RunRecord } from "@/server/types";

export async function GET(
  _request: Request,
  ctx: RouteContext<"/api/runs/[runId]">,
) {
  const session = await getOptionalSession();
  if (!session) {
    return Response.json({ error: "not authenticated" }, { status: 401 });
  }

  const { runId } = await ctx.params;

  const job = getRun(runId);
  const record: RunRecord | null = job?.record ?? (await getRunFromDb(runId));

  // Treat another user's run the same as a nonexistent one.
  if (!record || record.userId !== session.userId) {
    return Response.json({ error: "run not found" }, { status: 404 });
  }

  return Response.json({ record });
}

export async function DELETE(
  _request: Request,
  ctx: RouteContext<"/api/runs/[runId]">,
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

  if (job && (job.record.status === "running" || job.record.status === "queued")) {
    return Response.json(
      { error: "Stop the run before deleting it" },
      { status: 400 },
    );
  }

  deleteRun(runId);
  await deleteRunArtifacts(runId);
  await deleteRunRow(runId);

  return Response.json({ ok: true });
}
