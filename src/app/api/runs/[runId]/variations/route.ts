import { getRun, createRun } from "@/server/runManager";
import { getRunFromDb, getAlternativeSuggestions, listVariantRuns } from "@/server/runs";
import { enqueueRun } from "@/server/queue";
import { getOptionalSession } from "@/server/dal";
import { prisma } from "@/server/db";
import type { RunRecord } from "@/server/types";

export async function POST(
  request: Request,
  ctx: RouteContext<"/api/runs/[runId]/variations">,
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
    return Response.json({ error: "Wait for the run to finish first" }, { status: 400 });
  }

  const body = await request.json().catch(() => null);
  const stepIndex = Number(body?.stepIndex);
  const candidateIndex = Number(body?.candidateIndex);
  if (!Number.isInteger(stepIndex) || stepIndex < 0 || stepIndex >= record.steps.length) {
    return Response.json({ error: "Invalid step index" }, { status: 400 });
  }

  const step = record.steps[stepIndex];
  if (!step.locator || (step.type !== "manual-click" && step.type !== "replay-click")) {
    return Response.json(
      { error: "This step has no recorded click target to generate alternatives for" },
      { status: 400 },
    );
  }

  // The specific target was already decided by the alternative-suggestion
  // pipeline (src/server/alternativesAgent.ts) — this route just looks up
  // the candidate the user picked from that cached list and hands it
  // straight to the new run. No rediscovery happens here.
  const cached = await getAlternativeSuggestions(runId, stepIndex);
  const chosen = cached?.candidates[candidateIndex];
  if (!chosen) {
    return Response.json({ error: "That suggestion no longer exists — try finding alternatives again" }, { status: 400 });
  }

  const promptRow = await prisma.prompt.findUnique({
    where: { id: record.promptId },
    select: { skill: { select: { id: true, projectId: true } } },
  });

  const existing = await listVariantRuns(runId, stepIndex);

  const variantJob = await createRun({
    userId: session.userId,
    promptId: record.promptId,
    promptText: record.promptText,
    startUrl: record.startUrl,
    projectId: promptRow?.skill.projectId,
    skillId: promptRow?.skill.id,
    sourceRunId: runId,
    variantOfStepIndex: stepIndex,
    variantIndex: existing.length,
    variantTargetLocator: chosen.locator,
    variantLabel: chosen.description,
  });
  await enqueueRun(variantJob.record.id);

  return Response.json({ runId: variantJob.record.id });
}
