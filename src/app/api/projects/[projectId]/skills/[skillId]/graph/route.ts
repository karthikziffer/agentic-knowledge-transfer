import { getOptionalSession } from "@/server/dal";
import { getSkillForUser } from "@/server/skills";
import { getRunGraph } from "@/server/actionGraph";
import { getRun } from "@/server/runManager";
import { getRunFromDb } from "@/server/runs";

// The graph is scoped per source run (RunRecord.graphRunId, written by
// crawlTask/validateTask) rather than per skill — every "Create
// alternatives" tab passes the run it's viewing as ?runId=, so switching to
// a different run under the same skill shows that run's own (possibly
// still-empty) graph instead of one shared across every run.
export async function GET(
  request: Request,
  ctx: RouteContext<"/api/projects/[projectId]/skills/[skillId]/graph">,
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

  const runId = new URL(request.url).searchParams.get("runId");
  if (!runId) {
    return Response.json({ error: "runId is required" }, { status: 400 });
  }
  const job = getRun(runId);
  const record = job?.record ?? (await getRunFromDb(runId));
  if (!record || record.userId !== session.userId) {
    return Response.json({ error: "run not found" }, { status: 404 });
  }

  const graph = await getRunGraph(skillId, runId);
  return Response.json(graph);
}
