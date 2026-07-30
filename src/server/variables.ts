import { prisma } from "./db";
import { encrypt } from "./crypto";

const KEY_PATTERN = /^[A-Za-z0-9_]+$/;

export function isValidVariableKey(key: string): boolean {
  return KEY_PATTERN.test(key);
}

export interface VariableSummary {
  key: string;
  updatedAt: Date;
}

// --- Global (per-user) variables ---

export async function listGlobalVariables(userId: string): Promise<VariableSummary[]> {
  return prisma.globalVariable.findMany({
    where: { userId },
    select: { key: true, updatedAt: true },
    orderBy: { key: "asc" },
  });
}

export async function setGlobalVariable(userId: string, key: string, value: string) {
  const valueCipher = encrypt(value);
  await prisma.globalVariable.upsert({
    where: { userId_key: { userId, key } },
    create: { userId, key, valueCipher },
    update: { valueCipher },
  });
}

export async function deleteGlobalVariable(userId: string, key: string) {
  await prisma.globalVariable.deleteMany({ where: { userId, key } });
}
