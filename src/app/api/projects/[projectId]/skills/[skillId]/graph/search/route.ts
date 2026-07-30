import { getOptionalSession } from "@/server/dal";
import { getSkillForUser } from "@/server/skills";
import { searchActions } from "@/server/actionGraph";
import { getRun } from "@/server/runManager";
import { getRunFromDb } from "@/server/runs";

export async function POST(
  request: Request,
  ctx: RouteContext<"/api/projects/[projectId]/skills/[skillId]/graph/search">,
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
  const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) {
    return Response.json({ error: "A prompt is required" }, { status: 400 });
  }

  // Scopes the search to the one source run this "Create alternatives" tab
  // is viewing, matching that tab's now run-scoped graph — required (unlike
  // src/server/agent.ts's own searchActions call, which deliberately omits
  // it to search across every run's graph for this skill).
  const graphRunId = typeof body?.runId === "string" ? body.runId : null;
  if (!graphRunId) {
    return Response.json({ error: "runId is required" }, { status: 400 });
  }
  const graphOwnerJob = getRun(graphRunId);
  const graphOwnerRecord = graphOwnerJob?.record ?? (await getRunFromDb(graphRunId));
  if (!graphOwnerRecord || graphOwnerRecord.userId !== session.userId) {
    return Response.json({ error: "run not found" }, { status: 404 });
  }

  try {
    const results = await searchActions(skillId, prompt, 5, graphRunId);
    return Response.json({ results });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Search failed" },
      { status: 502 },
    );
  }
}
