import { getOptionalSession } from "@/server/dal";
import { getSkillForUser, getSkillPrompt } from "@/server/skills";
import { hasActiveRunsForPrompts } from "@/server/runs";
import { createRun, getRun } from "@/server/runManager";
import { getRunFromDb } from "@/server/runs";
import { enqueueRun } from "@/server/queue";

// Kicks off a batch validation pass over one source run's action graph —
// actually executes every cataloged action (including ones the crawler
// never auto-clicked), so like the crawl route it's created and queued
// exactly like a recording/replay/variant run (see queue.ts's worker
// dispatch on `validateSkillId`), watchable live via the same run page.
export async function POST(
  request: Request,
  ctx: RouteContext<"/api/projects/[projectId]/skills/[skillId]/graph/validate">,
) {
  const session = await getOptionalSession();
  if (!session) {
    return Response.json({ error: "not authenticated" }, { status: 401 });
  }
  const { projectId, skillId } = await ctx.params;
  const skill = await getSkillForUser(skillId, session.userId);
  if (!skill || skill.projectId !== projectId) {
    return Response.json({ error: "skill not found" }, { status: 404 });
  }

  const body = await request.json().catch(() => null);

  const graphRunId = typeof body?.runId === "string" ? body.runId : null;
  if (!graphRunId) {
    return Response.json({ error: "runId is required" }, { status: 400 });
  }
  const graphOwnerJob = getRun(graphRunId);
  const graphOwnerRecord = graphOwnerJob?.record ?? (await getRunFromDb(graphRunId));
  if (!graphOwnerRecord || graphOwnerRecord.userId !== session.userId) {
    return Response.json({ error: "run not found" }, { status: 404 });
  }

  // Optional — how many cataloged actions to actually execute, chosen by the
  // user (src/components/SkillActionGraph.tsx's count field). Absent, zero,
  // or not a positive integer all mean "every cataloged action" — the
  // original default behavior — rather than rejecting the request.
  const rawCount = body?.count;
  const count = typeof rawCount === "number" && Number.isInteger(rawCount) && rawCount > 0 ? rawCount : undefined;

  const prompt = await getSkillPrompt(skillId);
  if (!prompt) {
    return Response.json({ error: "This skill has no prompt to attach the validation run to" }, { status: 400 });
  }

  if (await hasActiveRunsForPrompts([prompt.id])) {
    return Response.json(
      { error: "A run is already active for this skill — wait for it to finish before validating" },
      { status: 400 },
    );
  }

  const job = await createRun({
    userId: session.userId,
    promptId: prompt.id,
    promptText:
      count !== undefined
        ? `Validate ${count} cataloged action${count === 1 ? "" : "s"} in the skill's action graph`
        : "Validate every cataloged action in the skill's action graph",
    startUrl: skill.startUrl,
    projectId,
    skillId,
    validateSkillId: skillId,
    validateCount: count,
    graphRunId,
  });
  await enqueueRun(job.record.id);

  return Response.json({ runId: job.record.id });
}
