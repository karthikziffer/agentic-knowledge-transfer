import { Queue, Worker } from "bullmq";
import { redisConnectionOptions } from "./redisConnection";
import { publish } from "./redisPubSub";
import { generateAlternativeSuggestions } from "./alternativesAgent";

// Separate from queue.ts's "runs" queue on purpose: a RunJob is a live,
// in-memory EventEmitter tied to a Chromium session and the WebSocket live
// view — none of which crosses a process boundary. Alternative-suggestion
// generation has no live view and no human-in-the-loop control, so it's the
// one job type that can actually run in a wholly separate worker process
// (see worker.ts) — decoupling it from the web server means a slow/hanging
// LLM or browser call here can no longer contend with the web process for
// memory or block other requests.
const QUEUE_NAME = "alternatives";

interface AlternativesJobData {
  runId: string;
  stepIndex: number;
}

let queue: Queue<AlternativesJobData> | undefined;

function getQueue(): Queue<AlternativesJobData> {
  return (queue ??= new Queue<AlternativesJobData>(QUEUE_NAME, { connection: redisConnectionOptions() }));
}

// One shared channel name derivation so the enqueuing side (the API route,
// subscribing before it enqueues) and the worker (publishing as it runs)
// always agree on which channel a given (runId, stepIndex) job talks on.
export function alternativesProgressChannel(runId: string, stepIndex: number): string {
  return `alt-progress:${runId}:${stepIndex}`;
}

// jobId = `${runId}-${stepIndex}` (BullMQ rejects ":" in custom job ids) —
// deliberately deterministic (not a fresh id per call) so a duplicate "Find
// alternatives" click while one is still in flight for the same step just
// attaches to the same job instead of launching a second browser, and
// "Regenerate" after a previous run completed (and was removed by
// removeOnComplete) always starts fresh.
export async function enqueueAlternativesJob(runId: string, stepIndex: number): Promise<string> {
  const jobId = `${runId}-${stepIndex}`;
  await getQueue().add(
    "suggest",
    { runId, stepIndex },
    { jobId, attempts: 1, removeOnComplete: true, removeOnFail: true },
  );
  return jobId;
}

let worker: Worker<AlternativesJobData> | undefined;

export function startAlternativesWorker(concurrency: number) {
  if (worker) return worker;
  worker = new Worker<AlternativesJobData>(
    QUEUE_NAME,
    async (bullJob) => {
      const { runId, stepIndex } = bullJob.data;
      const channel = alternativesProgressChannel(runId, stepIndex);
      try {
        const result = await generateAlternativeSuggestions(runId, stepIndex, (progress) => {
          publish(channel, { type: "progress", progress }).catch((err) => {
            console.error("[alternativesQueue] failed publishing progress", { runId, stepIndex }, err);
          });
        });
        await publish(channel, {
          type: "done",
          suggestions: result.suggestions,
          explorationScreenshot: result.explorationScreenshot,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await publish(channel, { type: "error", error: message });
        throw err;
      }
    },
    { connection: redisConnectionOptions(), concurrency },
  );
  worker.on("error", (err) => {
    console.error("alternatives worker error", err);
  });
  // Same reasoning as queue.ts's run worker: with attempts:1 +
  // removeOnFail, BullMQ would otherwise drop a failed job with no trace —
  // the error is already relayed to any listening client via the "error"
  // publish above, this is purely for the server log.
  worker.on("failed", (bullJob, err) => {
    console.error("alternatives job failed", bullJob?.id, err);
  });
  return worker;
}
