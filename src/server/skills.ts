import { prisma } from "./db";

// Every skill is a recording/live-control target — it has no free-text goal
// for an LLM to work toward, just a starting point a human drives from. A
// Run still needs a Prompt row (the FK the rest of the schema is built
// around), so each skill gets exactly one hidden one, created here rather
// than through any user-facing form.
const SESSION_PROMPT_TEXT = "Manual session";

export async function listSkillsForProject(projectId: string) {
  return prisma.skill.findMany({ where: { projectId }, orderBy: { createdAt: "desc" } });
}

// Feeds the Project page's skills table with each skill's most recent run
// status. Run has no skillId of its own (it hangs off Prompt, which hangs
// off Skill), so the join goes through Prompt — one query for every run
// across the project's skills, newest first, keeping only the first seen
// per skillId, rather than N+1 queries per skill.
export async function listSkillsForProjectWithLastRun(projectId: string) {
  const skills = await listSkillsForProject(projectId);
  const skillIds = skills.map((s) => s.id);

  const runs = skillIds.length
    ? await prisma.run.findMany({
        where: { prompt: { skillId: { in: skillIds } } },
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

  return skills.map((skill) => {
    const lastRun = lastRunBySkill.get(skill.id);
    return {
      ...skill,
      lastRun: lastRun
        ? { id: lastRun.id, promptId: lastRun.promptId, status: lastRun.status, createdAt: lastRun.createdAt }
        : null,
    };
  });
}

export async function createSkill(
  projectId: string,
  userId: string,
  name: string,
  startUrl: string,
) {
  return prisma.skill.create({
    data: {
      projectId,
      userId,
      name,
      startUrl,
      prompts: {
        create: { userId, text: SESSION_PROMPT_TEXT },
      },
    },
    // The creation wizard (project -> skill -> start a run) needs the
    // just-created prompt's id immediately to kick off a run, without a
    // second round-trip to look it up.
    include: { prompts: true },
  });
}

// Every skill has exactly one Prompt (created alongside the skill above) —
// this is how the Skill page finds it to start/resume a session.
export async function getSkillPrompt(skillId: string) {
  return prisma.prompt.findFirst({ where: { skillId }, orderBy: { createdAt: "asc" } });
}

export async function getSkillForUser(skillId: string, userId: string) {
  const skill = await prisma.skill.findUnique({ where: { id: skillId } });
  if (!skill || skill.userId !== userId) return null;
  return skill;
}

export async function deleteSkill(skillId: string) {
  await prisma.skill.delete({ where: { id: skillId } });
}

export async function updateSkill(skillId: string, name: string, startUrl: string) {
  return prisma.skill.update({ where: { id: skillId }, data: { name, startUrl } });
}

export async function getDescendantPromptIdsForSkill(skillId: string): Promise<string[]> {
  const prompts = await prisma.prompt.findMany({ where: { skillId }, select: { id: true } });
  return prompts.map((p) => p.id);
}
