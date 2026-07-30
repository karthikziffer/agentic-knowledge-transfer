import { getOptionalSession } from "@/server/dal";
import { getSkillForUser, getSkillPrompt } from "@/server/skills";
import { hasActiveRunsForPrompts } from "@/server/runs";
import { createRun, getRun } from "@/server/runManager";
import { getRunFromDb } from "@/server/runs";
import { enqueueRun } from "@/server/queue";

// Kicks off (or refreshes) one source run's whole-site action graph — a real
// Playwright crawl, so it's created and queued exactly like a recording/
// replay/variant run (see queue.ts's worker dispatch on `crawlSkillId`),
// watchable live via the same run page rather than blocking this request.
// The caller's `runId` (the run whose "Create alternatives" tab this was
// clicked from) becomes graphRunId — every node/edge this crawl writes
// (src/server/actionGraph.ts) is tagged with it, keeping this run's graph
// independent of every other run's.
export async function POST(
  request: Request,
  ctx: RouteContext<"/api/projects/[projectId]/skills/[skillId]/graph/crawl">,
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

  const prompt = await getSkillPrompt(skillId);
  if (!prompt) {
    return Response.json({ error: "This skill has no prompt to attach the crawl to" }, { status: 400 });
  }

  if (await hasActiveRunsForPrompts([prompt.id])) {
    return Response.json(
      { error: "A run is already active for this skill — wait for it to finish before crawling" },
      { status: 400 },
    );
  }

  const job = await createRun({
    userId: session.userId,
    promptId: prompt.id,
    promptText: "Crawl the site to build/refresh the action graph",
    startUrl: skill.startUrl,
    projectId,
    skillId,
    crawlSkillId: skillId,
    graphRunId,
  });
  await enqueueRun(job.record.id);

  return Response.json({ runId: job.record.id });
}
