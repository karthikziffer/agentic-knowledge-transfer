import { getRun } from "@/server/runManager";
import { getRunFromDb, getRunSummary, getSkillsMd, saveSkillsMd } from "@/server/runs";
import { buildSkillsMd } from "@/server/skillsMd";
import { getOptionalSession } from "@/server/dal";
import { prisma } from "@/server/db";
import type { RunRecord } from "@/server/types";

async function loadOwnedRecord(runId: string, userId: string): Promise<RunRecord | null> {
  const job = getRun(runId);
  const record: RunRecord | null = job?.record ?? (await getRunFromDb(runId));
  if (!record || record.userId !== userId) return null;
  return record;
}

export async function POST(
  _request: Request,
  ctx: RouteContext<"/api/runs/[runId]/skills-md">,
) {
  const session = await getOptionalSession();
  if (!session) {
    return Response.json({ error: "not authenticated" }, { status: 401 });
  }

  const { runId } = await ctx.params;
  const record = await loadOwnedRecord(runId, session.userId);
  if (!record) {
    return Response.json({ error: "run not found" }, { status: 404 });
  }

  const summary = await getRunSummary(runId);
  if (!summary) {
    return Response.json({ error: "Generate a flow summary first" }, { status: 400 });
  }

  const promptRow = await prisma.prompt.findUnique({
    where: { id: record.promptId },
    select: { skill: { select: { name: true } } },
  });

  const skillsMd = buildSkillsMd({
    skillName: promptRow?.skill.name ?? "Untitled skill",
    startUrl: record.startUrl,
    promptText: record.promptText,
    status: record.status,
    runId,
    summary,
    steps: record.steps,
  });

  await saveSkillsMd(runId, skillsMd);
  return Response.json({ skillsMd });
}

export async function GET(
  _request: Request,
  ctx: RouteContext<"/api/runs/[runId]/skills-md">,
) {
  const session = await getOptionalSession();
  if (!session) {
    return new Response("Not authenticated", { status: 401 });
  }

  const { runId } = await ctx.params;
  const record = await loadOwnedRecord(runId, session.userId);
  if (!record) {
    return new Response("Not found", { status: 404 });
  }

  const skillsMd = await getSkillsMd(runId);
  if (!skillsMd) {
    return new Response("skills.md hasn't been generated for this run yet", { status: 404 });
  }

  return new Response(skillsMd, {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
}
