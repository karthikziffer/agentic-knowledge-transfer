import { getOptionalSession } from "@/server/dal";
import { getSkillForUser, getSkillPrompt } from "@/server/skills";
import { hasActiveRunsForPrompts } from "@/server/runs";
import { createRun, getRun } from "@/server/runManager";
import { getRunFromDb } from "@/server/runs";
import { enqueueRun } from "@/server/queue";
import type { CrawlDepthGoal } from "@/server/types";

// Bounds on the depth-goal editor (src/components/SkillActionGraph.tsx) —
// generous enough for any real use, tight enough to keep a mistyped goal
// from asking the crawler to chase down an unreasonable number of pages.
// Depth itself is capped separately (not just by these bounds) since it
// also controls how many hops the crawler is willing to auto-follow at all.
const MAX_GOAL_DEPTH = 6;
const MAX_GOAL_COUNT = 25;

function parseDepthGoals(raw: unknown): CrawlDepthGoal[] | null {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return null;
  const seen = new Set<number>();
  const goals: CrawlDepthGoal[] = [];
  for (const entry of raw) {
    const depth = entry?.depth;
    const goal = entry?.goal;
    if (
      !Number.isInteger(depth) ||
      depth < 1 ||
      depth > MAX_GOAL_DEPTH ||
      !Number.isInteger(goal) ||
      goal < 1 ||
      goal > MAX_GOAL_COUNT ||
      seen.has(depth)
    ) {
      return null;
    }
    seen.add(depth);
    goals.push({ depth, goal });
  }
  return goals;
}

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

  const depthGoals = parseDepthGoals(body?.depthGoals);
  if (depthGoals === null) {
    return Response.json(
      {
        error: `Invalid depth goals — each needs a depth (1-${MAX_GOAL_DEPTH}) and a goal count (1-${MAX_GOAL_COUNT}), with no depth repeated`,
      },
      { status: 400 },
    );
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
    promptText: depthGoals.length
      ? `Crawl the site to build/refresh the action graph (goals: ${depthGoals
          .map((g) => `${g.goal} at depth ${g.depth}`)
          .join(", ")})`
      : "Crawl the site to build/refresh the action graph",
    startUrl: skill.startUrl,
    projectId,
    skillId,
    crawlSkillId: skillId,
    crawlDepthGoals: depthGoals.length ? depthGoals : undefined,
    graphRunId,
  });
  await enqueueRun(job.record.id);

  return Response.json({ runId: job.record.id });
}
