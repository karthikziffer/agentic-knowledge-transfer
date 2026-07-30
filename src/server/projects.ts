import { prisma } from "./db";

export async function listProjects(userId: string) {
  return prisma.project.findMany({ where: { userId }, orderBy: { createdAt: "desc" } });
}

// Feeds the sidebar's nested project → skill navigation tree. A single
// query rather than N+1 per project — the whole tree is small (one user's
// projects/skills), so there's no pagination concern.
export async function listProjectsWithSkills(userId: string) {
  return prisma.project.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    include: {
      skills: {
        orderBy: { createdAt: "desc" },
        select: { id: true, name: true, startUrl: true },
      },
    },
  });
}

export async function createProject(userId: string, name: string, description?: string) {
  return prisma.project.create({ data: { userId, name, description } });
}

export async function getProjectForUser(projectId: string, userId: string) {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project || project.userId !== userId) return null;
  return project;
}

export async function deleteProject(projectId: string) {
  await prisma.project.delete({ where: { id: projectId } });
}

// Every Prompt under this Project, across all of its Skills — used to check
// for active runs and to clean up on-disk artifacts before a cascade delete.
export async function getDescendantPromptIds(projectId: string): Promise<string[]> {
  const skills = await prisma.skill.findMany({ where: { projectId }, select: { id: true } });
  if (skills.length === 0) return [];
  const prompts = await prisma.prompt.findMany({
    where: { skillId: { in: skills.map((s) => s.id) } },
    select: { id: true },
  });
  return prompts.map((p) => p.id);
}
