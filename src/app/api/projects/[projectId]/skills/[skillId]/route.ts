import { getOptionalSession } from "@/server/dal";
import {
  deleteSkill,
  getDescendantPromptIdsForSkill,
  getSkillForUser,
  updateSkill,
} from "@/server/skills";
import { hasActiveRunsForPrompts, listRunIdsForPrompts } from "@/server/runs";
import { deleteRunArtifacts } from "@/server/artifacts";
import { deleteRun } from "@/server/runManager";

export async function GET(
  _request: Request,
  ctx: RouteContext<"/api/projects/[projectId]/skills/[skillId]">,
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
  return Response.json({ skill });
}

export async function PATCH(
  request: Request,
  ctx: RouteContext<"/api/projects/[projectId]/skills/[skillId]">,
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
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const startUrl = typeof body?.startUrl === "string" ? body.startUrl.trim() : "";

  if (!name) {
    return Response.json({ error: "Name is required" }, { status: 400 });
  }
  try {
    new URL(startUrl);
  } catch {
    return Response.json({ error: "A valid start URL is required" }, { status: 400 });
  }

  const updated = await updateSkill(skillId, name, startUrl);
  return Response.json({ skill: updated });
}

export async function DELETE(
  _request: Request,
  ctx: RouteContext<"/api/projects/[projectId]/skills/[skillId]">,
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

  const promptIds = await getDescendantPromptIdsForSkill(skillId);
  if (await hasActiveRunsForPrompts(promptIds)) {
    return Response.json(
      { error: "Stop all active runs for this skill before deleting it" },
      { status: 400 },
    );
  }

  const runIds = await listRunIdsForPrompts(promptIds);
  for (const runId of runIds) {
    deleteRun(runId);
    await deleteRunArtifacts(runId);
  }

  await deleteSkill(skillId);
  return Response.json({ ok: true });
}
