import { getOptionalSession } from "@/server/dal";
import { getSkillForUser, getSkillPrompt } from "@/server/skills";
import { hasActiveRunsForPrompts } from "@/server/runs";
import { createRun } from "@/server/runManager";
import { enqueueRun } from "@/server/queue";

// Kicks off a prompt-driven agent run for a skill — the instruction and
// target URL come from the request body, not the skill's own recorded
// prompt, but it's still created and queued exactly like a recording/replay/
// crawl/validate run (see queue.ts's worker dispatch on `agentSkillId`),
// watchable live via the same run page.
export async function POST(
  request: Request,
  ctx: RouteContext<"/api/projects/[projectId]/skills/[skillId]/agent">,
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
  const instruction = typeof body?.prompt === "string" ? body.prompt.trim() : "";
  if (!instruction) {
    return Response.json({ error: "A prompt is required" }, { status: 400 });
  }
  const startUrl = typeof body?.startUrl === "string" && body.startUrl.trim() ? body.startUrl.trim() : skill.startUrl;

  const prompt = await getSkillPrompt(skillId);
  if (!prompt) {
    return Response.json({ error: "This skill has no prompt to attach the agent run to" }, { status: 400 });
  }

  if (await hasActiveRunsForPrompts([prompt.id])) {
    return Response.json(
      { error: "A run is already active for this skill — wait for it to finish before running the agent" },
      { status: 400 },
    );
  }

  const job = await createRun({
    userId: session.userId,
    promptId: prompt.id,
    promptText: instruction,
    startUrl,
    projectId,
    skillId,
    agentSkillId: skillId,
    agentPrompt: instruction,
  });
  await enqueueRun(job.record.id);

  return Response.json({ runId: job.record.id });
}
