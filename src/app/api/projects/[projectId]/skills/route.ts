import { getOptionalSession } from "@/server/dal";
import { getProjectForUser } from "@/server/projects";
import { createSkill, listSkillsForProject } from "@/server/skills";

export async function GET(
  _request: Request,
  ctx: RouteContext<"/api/projects/[projectId]/skills">,
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
  const skills = await listSkillsForProject(projectId);
  return Response.json({ skills });
}

export async function POST(
  request: Request,
  ctx: RouteContext<"/api/projects/[projectId]/skills">,
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

  const skill = await createSkill(projectId, session.userId, name, startUrl);
  return Response.json({ skill });
}
