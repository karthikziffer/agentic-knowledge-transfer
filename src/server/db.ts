import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";

const globalKey = Symbol.for("skill-builder.prisma");
type GlobalWithPrisma = typeof globalThis & { [globalKey]?: PrismaClient };
const g = globalThis as GlobalWithPrisma;

function createClient(): PrismaClient {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not set");
  return new PrismaClient({ adapter: new PrismaPg(connectionString) });
}

function getClient(): PrismaClient {
  return g[globalKey] ?? (g[globalKey] = createClient());
}

// Constructing PrismaClient touches DATABASE_URL, which isn't available at
// `next build` time (only at container runtime). Defer construction until
// the client is actually used via this Proxy, rather than at module load.
export const prisma = new Proxy({} as PrismaClient, {
  get(_target, prop, receiver) {
    return Reflect.get(getClient() as object, prop, receiver);
  },
});
