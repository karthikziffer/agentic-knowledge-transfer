import { getOptionalSession } from "@/server/dal";
import { getPromptWithSkillForUser } from "@/server/prompts";
import { createRun, listRuns } from "@/server/runManager";
import { enqueueRun } from "@/server/queue";
import { listRunsForPrompt } from "@/server/runs";
import type { RunRecord } from "@/server/types";

export async function GET(
  _request: Request,
  ctx: RouteContext<"/api/prompts/[promptId]/runs">,
) {
  const session = await getOptionalSession();
  if (!session) {
    return Response.json({ error: "not authenticated" }, { status: 401 });
  }
  const { promptId } = await ctx.params;
  const prompt = await getPromptWithSkillForUser(promptId, session.userId);
  if (!prompt) {
    return Response.json({ error: "prompt not found" }, { status: 404 });
  }

  // Merge live in-memory jobs (this process's lifetime) with the durable
  // Postgres history — a run that finished before a restart only exists in
  // the DB, matching the pattern used everywhere else in this app.
  const inMemory = listRuns().filter((r) => r.promptId === promptId);
  const seen = new Set(inMemory.map((r) => r.id));
  const fromDb = (await listRunsForPrompt(promptId)).filter((r) => !seen.has(r.id));
  const runs: RunRecord[] = [...inMemory, ...fromDb].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );

  return Response.json({ runs });
}

export async function POST(
  _request: Request,
  ctx: RouteContext<"/api/prompts/[promptId]/runs">,
) {
  const session = await getOptionalSession();
  if (!session) {
    return Response.json({ error: "not authenticated" }, { status: 401 });
  }
  const { promptId } = await ctx.params;
  const prompt = await getPromptWithSkillForUser(promptId, session.userId);
  if (!prompt) {
    return Response.json({ error: "prompt not found" }, { status: 404 });
  }

  const job = await createRun({
    userId: session.userId,
    promptId: prompt.id,
    promptText: prompt.text,
    startUrl: prompt.skill.startUrl,
    projectId: prompt.skill.projectId,
    skillId: prompt.skill.id,
  });

  // Queued in Redis rather than launched immediately: caps how many
  // Chromium instances run at once. The client watches progress over /ws.
  await enqueueRun(job.record.id);

  return Response.json({ runId: job.record.id });
}
