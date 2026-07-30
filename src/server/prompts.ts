import { prisma } from "./db";

// Includes the parent Skill so callers can read startUrl without a second
// round trip — used when starting a run, which needs both.
export async function getPromptWithSkillForUser(promptId: string, userId: string) {
  const prompt = await prisma.prompt.findUnique({
    where: { id: promptId },
    include: { skill: true },
  });
  if (!prompt || prompt.userId !== userId) return null;
  return prompt;
}
