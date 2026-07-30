import { prisma } from "./db";
import { listProjectsWithSkills } from "./projects";

export interface DashboardSkillRow {
  id: string;
  name: string;
  startUrl: string;
  lastRun: { id: string; promptId: string; status: string; createdAt: string } | null;
}

export interface DashboardProjectRow {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
  skills: DashboardSkillRow[];
}

// Feeds the Dashboard's collapsible project -> skill table. Run has no
// skillId of its own (it hangs off Prompt, which hangs off Skill), so the
// "latest run per skill" join has to go through Prompt — fetch every run
// for the user's skills ordered newest-first and keep only the first one
// seen per skillId, rather than N+1 queries per skill.
export async function listDashboardProjects(userId: string): Promise<DashboardProjectRow[]> {
  const projects = await listProjectsWithSkills(userId);
  const skillIds = projects.flatMap((p) => p.skills.map((s) => s.id));

  const runs = skillIds.length
    ? await prisma.run.findMany({
        // Both "Test the skill" replays and generated alternatives set
        // sourceRunId — neither is a fresh recording of its own, and both
        // are already reachable from the real session they were derived
        // from (see the identical isDerivedRun filter in the skill page,
        // src/app/projects/[projectId]/skills/[skillId]/page.tsx) — so the
        // dashboard's "last run" should only ever point at a real session.
        where: { userId, prompt: { skillId: { in: skillIds } }, sourceRunId: null },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          status: true,
          createdAt: true,
          promptId: true,
          prompt: { select: { skillId: true } },
        },
      })
    : [];

  const lastRunBySkill = new Map<string, (typeof runs)[number]>();
  for (const run of runs) {
    if (!lastRunBySkill.has(run.prompt.skillId)) lastRunBySkill.set(run.prompt.skillId, run);
  }

  return projects.map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    createdAt: p.createdAt.toISOString(),
    skills: p.skills.map((s) => {
      const lastRun = lastRunBySkill.get(s.id);
      return {
        id: s.id,
        name: s.name,
        startUrl: s.startUrl,
        lastRun: lastRun
          ? {
              id: lastRun.id,
              promptId: lastRun.promptId,
              status: lastRun.status,
              createdAt: lastRun.createdAt.toISOString(),
            }
          : null,
      };
    }),
  }));
}
