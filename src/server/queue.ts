import { Queue, Worker } from "bullmq";
import { getRun } from "./runManager";
import { runTask } from "./automation";
import { replayTask } from "./replay";
import { variantTask } from "./variation";
import { crawlTask, validateTask } from "./actionGraph";
import { agentTask } from "./agent";
import { markRunLost } from "./runs";
import { redisConnectionOptions as connection } from "./redisConnection";

const QUEUE_NAME = "runs";

// Constructing a Queue/Worker opens a Redis connection immediately, which
// isn't available (and shouldn't be attempted) at `next build` time — same
// reasoning as the lazy Prisma client in db.ts. Defer both until first use.
let queue: Queue<{ runId: string }> | undefined;

function getQueue(): Queue<{ runId: string }> {
  return (queue ??= new Queue<{ runId: string }>(QUEUE_NAME, {
    connection: connection(),
  }));
}

// Enqueue by runId, not the run spec itself: the RunJob (an EventEmitter
// holding live state) already lives in the in-memory registry in this same
// process — Redis here is purely a concurrency limiter for how many
// Chromium instances run at once, not a cross-process work distributor.
export async function enqueueRun(runId: string) {
  await getQueue().add(
    "run",
    { runId },
    { jobId: runId, attempts: 1, removeOnComplete: true, removeOnFail: true },
  );
}

// Removes a run from the queue if it hasn't started yet. Returns true if it
// was still waiting and got cancelled; false if it already started (or
// never existed), in which case the normal in-process stop path applies.
export async function cancelQueuedRun(runId: string): Promise<boolean> {
  const job = await getQueue().getJob(runId);
  if (!job) return false;
  const state = await job.getState();
  if (state === "waiting" || state === "delayed") {
    await job.remove();
    return true;
  }
  return false;
}

let worker: Worker<{ runId: string }> | undefined;

export function startRunWorker(concurrency: number) {
  if (worker) return worker;
  worker = new Worker<{ runId: string }>(
    QUEUE_NAME,
    async (bullJob) => {
      const job = getRun(bullJob.data.runId);
      if (!job) {
        // The process that created this run's in-memory RunJob (and enqueued
        // this very job) died before picking it up — nothing left anywhere
        // can ever drive it to completion. Mark it lost now instead of
        // leaving the DB row stuck at "queued"/"running" forever waiting for
        // someone to notice and clean it up by hand.
        await markRunLost(bullJob.data.runId).catch((err) => {
          console.error("failed marking orphaned run as lost", bullJob.data.runId, err);
        });
        return;
      }
      if (job.record.crawlSkillId) await crawlTask(job);
      else if (job.record.validateSkillId) await validateTask(job);
      else if (job.record.agentSkillId) await agentTask(job);
      else if (job.record.variantOfStepIndex != null) await variantTask(job);
      else if (job.record.sourceRunId) await replayTask(job);
      else await runTask(job);
    },
    { connection: connection(), concurrency },
  );
  worker.on("error", (err) => {
    console.error("run worker error", err);
  });
  // Each task function (runTask/replayTask/etc.) already writes its own
  // terminal status/error onto the run record — this is purely so an
  // exception thrown *outside* that (e.g. before launchRunBrowser sets
  // "running") doesn't vanish silently. With attempts:1 + removeOnFail,
  // BullMQ would otherwise just drop the job with no trace at all.
  worker.on("failed", (bullJob, err) => {
    console.error("run job failed", bullJob?.id, err);
  });
  return worker;
}
