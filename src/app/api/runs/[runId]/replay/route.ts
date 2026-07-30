import { getRun, createRun } from "@/server/runManager";
import { getRunFromDb } from "@/server/runs";
import { enqueueRun } from "@/server/queue";
import { getOptionalSession } from "@/server/dal";
import { prisma } from "@/server/db";
import type { RunRecord } from "@/server/types";

export async function POST(
  _request: Request,
  ctx: RouteContext<"/api/runs/[runId]/replay">,
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
    return Response.json({ error: "Wait for the run to finish before replaying it" }, { status: 400 });
  }
  if (record.steps.length === 0) {
    return Response.json({ error: "This run has no recorded steps to replay" }, { status: 400 });
  }

  const promptRow = await prisma.prompt.findUnique({
    where: { id: record.promptId },
    select: { skill: { select: { id: true, projectId: true } } },
  });

  // Replays against the same Skill/Prompt, using the *recorded* startUrl —
  // not whatever the Skill's URL has since been edited to. If it drifted,
  // the replay engine's drift handoff (src/server/replay.ts) catches that
  // the same way it catches any other locator mismatch.
  const replayJob = await createRun({
    userId: session.userId,
    promptId: record.promptId,
    promptText: record.promptText,
    startUrl: record.startUrl,
    projectId: promptRow?.skill.projectId,
    skillId: promptRow?.skill.id,
    sourceRunId: runId,
  });

  await enqueueRun(replayJob.record.id);

  return Response.json({ runId: replayJob.record.id });
}
