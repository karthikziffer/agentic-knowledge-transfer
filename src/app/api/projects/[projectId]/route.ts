import { getOptionalSession } from "@/server/dal";
import {
  deleteProject,
  getDescendantPromptIds,
  getProjectForUser,
} from "@/server/projects";
import { hasActiveRunsForPrompts, listRunIdsForPrompts } from "@/server/runs";
import { deleteRunArtifacts } from "@/server/artifacts";
import { deleteRun } from "@/server/runManager";

export async function GET(
  _request: Request,
  ctx: RouteContext<"/api/projects/[projectId]">,
) {
  const session = await getOptionalSession();
  if (!session) {
    return Response.json({ error: "not authenticated" }, { status: 401 });
  }
  const { projectId } = await ctx.params;
  const project = await getProjectForUser(projectId, session.userId);
  if (!project) {
    return Response.json({ error: "project not found" }, { status: 404 });
  }
  return Response.json({ project });
}

export async function DELETE(
  _request: Request,
  ctx: RouteContext<"/api/projects/[projectId]">,
) {
  const session = await getOptionalSession();
  if (!session) {
    return Response.json({ error: "not authenticated" }, { status: 401 });
  }
  const { projectId } = await ctx.params;
  const project = await getProjectForUser(projectId, session.userId);
  if (!project) {
    return Response.json({ error: "project not found" }, { status: 404 });
  }

  const promptIds = await getDescendantPromptIds(projectId);
  if (await hasActiveRunsForPrompts(promptIds)) {
    return Response.json(
      { error: "Stop all active runs in this project before deleting it" },
      { status: 400 },
    );
  }

  const runIds = await listRunIdsForPrompts(promptIds);
  for (const runId of runIds) {
    deleteRun(runId);
    await deleteRunArtifacts(runId);
  }

  await deleteProject(projectId);
  return Response.json({ ok: true });
}
