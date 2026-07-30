// Standalone entrypoint for the alternatives worker — a separate process
// (and, in docker-compose.yml, a separate container) from server.ts's web
// process. Deliberately doesn't call next() or open an HTTP/WebSocket
// server: unlike the "runs" queue in src/server/queue.ts, alternative-
// suggestion generation (src/server/alternativesAgent.ts) has no live view
// and no human-in-the-loop control to relay, so it's the one job type that
// can run fully out-of-process. Progress and results are relayed back to
// the web server's API route via Redis pub/sub (src/server/redisPubSub.ts)
// instead of an in-memory EventEmitter.
import "dotenv/config";
import { startAlternativesWorker } from "./src/server/alternativesQueue";

const concurrency = parseInt(process.env.MAX_CONCURRENT_ALTERNATIVES || "2", 10);
const worker = startAlternativesWorker(concurrency);

console.log(`[worker] alternatives worker ready (concurrency ${concurrency})`);

async function shutdown(signal: string) {
  console.log(`[worker] received ${signal}, closing`);
  await worker.close();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
