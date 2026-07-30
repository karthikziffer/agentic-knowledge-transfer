import type { RedisOptions } from "ioredis";

// Shared by every BullMQ Queue/Worker (src/server/queue.ts,
// src/server/alternativesQueue.ts) and the raw pub/sub clients
// (src/server/redisPubSub.ts) — one place to parse REDIS_URL instead of
// each call site doing it slightly differently. Typed as ioredis's own
// RedisOptions (a member of bullmq's broader ConnectionOptions union)
// rather than that union itself — bullmq's union also includes live
// Redis/Cluster instances, which made `new Redis(redisConnectionOptions())`
// in redisPubSub.ts ambiguous across ioredis's constructor overloads.
export function redisConnectionOptions(): RedisOptions {
  const url = process.env.REDIS_URL || "redis://localhost:6379";
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 6379,
    password: parsed.password || undefined,
  };
}
