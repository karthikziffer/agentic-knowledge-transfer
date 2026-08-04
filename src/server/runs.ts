import { prisma } from "./db";
import type { Prisma, Run as PrismaRun } from "@/generated/prisma/client";
import type {
  AlternativePlan,
  AlternativePlansByStep,
  CrawlDepthGoal,
  ElementLocator,
  HealedLocatorRecord,
  RunFlowSummary,
  RunRecord,
  StepResult,
} from "./types";

// StepResult[] is a concrete TS type, not a bare index-signature object, so
// Prisma's InputJsonValue union rejects it directly — round-trip through
// JSON to get a plain structurally-typed value.
function toJsonValue(steps: StepResult[]): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(steps));
}

function toRunRecord(row: PrismaRun): RunRecord {
  return {
    id: row.id,
    userId: row.userId,
    promptId: row.promptId,
    promptText: row.promptText,
    startUrl: row.startUrl,
    status: row.status as RunRecord["status"],
    error: row.error ?? undefined,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString(),
    finishedAt: row.finishedAt?.toISOString(),
    steps: row.report as unknown as StepResult[],
    sourceRunId: row.sourceRunId ?? undefined,
    variantOfStepIndex: row.variantOfStepIndex ?? undefined,
    variantIndex: row.variantIndex ?? undefined,
    variantLabel: row.variantLabel ?? undefined,
    variantTargetLocator: (row.variantTargetLocator as unknown as ElementLocator | null) ?? undefined,
    variantPlanSteps: (row.variantPlanSteps as unknown as ElementLocator[] | null) ?? undefined,
    crawlSkillId: row.crawlSkillId ?? undefined,
    crawlDepthGoals: (row.crawlDepthGoals as unknown as CrawlDepthGoal[] | null) ?? undefined,
    validateSkillId: row.validateSkillId ?? undefined,
    validateCount: row.validateCount ?? undefined,
    agentSkillId: row.agentSkillId ?? undefined,
    agentPrompt: row.agentPrompt ?? undefined,
    graphRunId: row.graphRunId ?? undefined,
  };
}

export async function insertRun(record: RunRecord) {
  await prisma.run.create({
    data: {
      id: record.id,
      userId: record.userId,
      promptId: record.promptId,
      promptText: record.promptText,
      startUrl: record.startUrl,
      status: record.status,
      report: toJsonValue(record.steps),
      sourceRunId: record.sourceRunId,
      variantOfStepIndex: record.variantOfStepIndex,
      variantIndex: record.variantIndex,
      variantLabel: record.variantLabel,
      variantTargetLocator: record.variantTargetLocator
        ? (JSON.parse(JSON.stringify(record.variantTargetLocator)) as Prisma.InputJsonValue)
        : undefined,
      variantPlanSteps: record.variantPlanSteps
        ? (JSON.parse(JSON.stringify(record.variantPlanSteps)) as Prisma.InputJsonValue)
        : undefined,
      crawlSkillId: record.crawlSkillId,
      crawlDepthGoals: record.crawlDepthGoals
        ? (JSON.parse(JSON.stringify(record.crawlDepthGoals)) as Prisma.InputJsonValue)
        : undefined,
      validateSkillId: record.validateSkillId,
      validateCount: record.validateCount,
      agentSkillId: record.agentSkillId,
      agentPrompt: record.agentPrompt,
      graphRunId: record.graphRunId,
    },
  });
}

// Called at every status transition and after every step — Postgres is the
// durable record, the in-memory RunJob (see runManager.ts) is only for live
// WS streaming within this process's lifetime.
export async function persistRun(record: RunRecord) {
  await prisma.run.update({
    where: { id: record.id },
    data: {
      status: record.status,
      error: record.error ?? null,
      report: toJsonValue(record.steps),
      startedAt: record.startedAt ? new Date(record.startedAt) : undefined,
      finishedAt: record.finishedAt ? new Date(record.finishedAt) : undefined,
      variantLabel: record.variantLabel,
    },
  });
}

// Feeds the Flow Summary page's per-step "alternatives already generated"
// list — every variant run created from a given source run's step, newest
// first.
export async function listVariantRuns(sourceRunId: string, stepIndex: number): Promise<RunRecord[]> {
  const rows = await prisma.run.findMany({
    where: { sourceRunId, variantOfStepIndex: stepIndex },
    orderBy: { createdAt: "desc" },
  });
  return rows.map(toRunRecord);
}

// Every variant run for a source run, regardless of which step — the Flow
// Summary page fetches this once and groups by variantOfStepIndex, rather
// than issuing one query per step.
export async function listAllVariantRuns(sourceRunId: string): Promise<RunRecord[]> {
  const rows = await prisma.run.findMany({
    where: { sourceRunId, variantOfStepIndex: { not: null } },
    orderBy: { createdAt: "desc" },
  });
  return rows.map(toRunRecord);
}

export async function getRunFromDb(runId: string): Promise<RunRecord | null> {
  const row = await prisma.run.findUnique({ where: { id: runId } });
  return row ? toRunRecord(row) : null;
}

export async function listRunsForPrompt(promptId: string): Promise<RunRecord[]> {
  const rows = await prisma.run.findMany({
    where: { promptId },
    orderBy: { createdAt: "desc" },
  });
  return rows.map(toRunRecord);
}

// Feeds the Skill page's "Recent runs" section — a skill can have several
// Prompts, each with their own runs, so this flattens runs across all of
// them (capped, newest first) rather than making the caller union N
// separate listRunsForPrompt() calls.
export async function listRunsForPromptIds(
  promptIds: string[],
  limit = 30,
): Promise<RunRecord[]> {
  if (promptIds.length === 0) return [];
  const rows = await prisma.run.findMany({
    where: { promptId: { in: promptIds } },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return rows.map(toRunRecord);
}

export async function deleteRunRow(runId: string) {
  await prisma.run.deleteMany({ where: { id: runId } });
}

// Used when cascading a Project/Skill/Prompt delete — need every descendant
// run id up front so on-disk artifacts (screenshots/trace.zip) can be
// removed before the DB cascade fires.
export async function listRunIdsForPrompts(promptIds: string[]): Promise<string[]> {
  if (promptIds.length === 0) return [];
  const rows = await prisma.run.findMany({
    where: { promptId: { in: promptIds } },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

export async function hasActiveRunsForPrompts(promptIds: string[]): Promise<boolean> {
  if (promptIds.length === 0) return false;
  const count = await prisma.run.count({
    where: { promptId: { in: promptIds }, status: { in: ["queued", "running"] } },
  });
  return count > 0;
}

// Called by the run worker (src/server/queue.ts) the moment it picks up a
// BullMQ job whose runId has no matching in-memory RunJob — the one race
// reconcileOrphanedRuns() below can't catch, since it only sweeps rows
// already stuck at boot time. Here, the run was created and enqueued by a
// process that died (restart/crash/redeploy) before this process's worker
// got to it: the RunJob object that would have driven it to completion no
// longer exists anywhere, so without this the DB row would sit "queued"
// forever with nothing left able to ever finish it. Silently no-ops if the
// row already moved on (e.g. a human already marked it errored by hand)
// rather than clobbering a real status.
export async function markRunLost(runId: string): Promise<void> {
  const result = await prisma.run.updateMany({
    where: { id: runId, status: { in: ["running", "queued"] } },
    data: { status: "error", error: "Stopped: lost during server restart", finishedAt: new Date() },
  });
  if (result.count > 0) {
    console.warn(`[queue] marked orphaned run ${runId} as errored — no in-memory job to process it`);
  }
}

// Called once at process startup (server.ts), before the run worker starts
// picking up new work. RunJob state (runManager.ts's `runs` map) is entirely
// in-memory and anchored to this process — it never survives a restart or
// crash, so any DB row still saying "running"/"queued" at boot time is
// guaranteed to be orphaned, not actually in progress, regardless of run
// type (manual/replay/variant/crawl/validate all go through the same
// status field). Left alone, such a row sits "running" forever with
// nothing left to ever finish it — same as the docs.langchain.com crawl
// that had to be fixed by hand before this existed.
export async function reconcileOrphanedRuns(): Promise<void> {
  const result = await prisma.run.updateMany({
    where: { status: { in: ["running", "queued"] } },
    data: { status: "error", error: "Stopped: server restarted", finishedAt: new Date() },
  });
  if (result.count > 0) {
    console.warn(`[startup] reconciled ${result.count} orphaned run(s) left over from a previous process`);
  }
}

// Independent of the run state machine above (persistRun/RunJob) — a
// summary is generated on demand, well after a run has already finished.
export async function saveRunSummary(runId: string, summary: RunFlowSummary): Promise<void> {
  await prisma.run.update({
    where: { id: runId },
    data: {
      summary: JSON.parse(JSON.stringify(summary)) as Prisma.InputJsonValue,
      summaryModel: summary.model,
      summaryGeneratedAt: new Date(summary.generatedAt),
    },
  });
}

export async function getRunSummary(runId: string): Promise<RunFlowSummary | null> {
  const row = await prisma.run.findUnique({ where: { id: runId }, select: { summary: true } });
  return (row?.summary as unknown as RunFlowSummary | null) ?? null;
}

// A deterministic markdown rendering of the summary above — see
// src/server/skillsMd.ts. Also independent of the run state machine.
export async function saveSkillsMd(runId: string, skillsMd: string): Promise<void> {
  await prisma.run.update({
    where: { id: runId },
    data: { skillsMd, skillsMdGeneratedAt: new Date() },
  });
}

export async function getSkillsMd(runId: string): Promise<string | null> {
  const row = await prisma.run.findUnique({ where: { id: runId }, select: { skillsMd: true } });
  return row?.skillsMd ?? null;
}

type AlternativePlanEntry = AlternativePlansByStep[string];

// Cached output of the alternative-plan pipeline
// (src/server/alternativesAgent.ts), one entry per step index — a
// read-modify-write since the column holds every step's plans together, not
// just the one being (re)generated.
export async function saveAlternativePlans(
  runId: string,
  stepIndex: number,
  plans: AlternativePlan[],
  model: string,
  depthGoals: CrawlDepthGoal[],
  rootScreenshot?: string,
): Promise<AlternativePlanEntry> {
  const row = await prisma.run.findUnique({
    where: { id: runId },
    select: { alternativePlans: true },
  });
  const existing = (row?.alternativePlans as unknown as AlternativePlansByStep | null) ?? {};
  const entry: AlternativePlanEntry = {
    plans,
    model,
    generatedAt: new Date().toISOString(),
    depthGoals,
    rootScreenshot,
  };
  const next: AlternativePlansByStep = { ...existing, [String(stepIndex)]: entry };

  await prisma.run.update({
    where: { id: runId },
    data: {
      alternativePlans: JSON.parse(JSON.stringify(next)) as Prisma.InputJsonValue,
      alternativePlansModel: model,
      alternativePlansGeneratedAt: new Date(entry.generatedAt),
    },
  });
  return entry;
}

// Writes a proven-good replacement locator back onto the *source* run's own
// recorded step — read-modify-write, same reasoning as saveAlternativePlans
// above (the column holds every step's data together). Every future replay
// of this flow tries this healed override first (locatorReplay.ts's
// resolveHealedLocator, called from replay.ts's walkSourceSteps) before
// falling back to the original recorded locator's full resolution
// pipeline — a pause resolved once (by position/structural corroboration, a
// human's "Use this match", or the semantic/live-LLM layers) doesn't have
// to be re-solved on every subsequent replay. Never touches the original
// `locator` field, so the actual recording stays inspectable regardless of
// how many times this gets healed.
//
// Best-effort, no locking: two replays of the same source run healing
// different steps at the same moment could theoretically race and one
// write could clobber the other's read-before-write — acceptable for a
// convenience cache that degrades gracefully (resolveHealedLocator just
// falls through to the normal pipeline if the healed override is missing or
// stale), not worth transactional complexity for.
export async function healSourceStepLocator(
  runId: string,
  stepIndex: number,
  locator: ElementLocator,
  source: HealedLocatorRecord["source"],
): Promise<void> {
  const row = await prisma.run.findUnique({ where: { id: runId }, select: { report: true } });
  const steps = (row?.report as unknown as StepResult[] | null) ?? [];
  const step = steps.find((s) => s.index === stepIndex);
  if (!step) return;
  step.healedLocator = { locator, source, healedAt: new Date().toISOString() };
  await prisma.run.update({
    where: { id: runId },
    data: { report: toJsonValue(steps) },
  });
}

// Cache-only read — never runs the pipeline, just returns whatever's
// already stored (or null if this step has never had plans generated).
export async function getAlternativePlans(
  runId: string,
  stepIndex: number,
): Promise<AlternativePlanEntry | null> {
  const row = await prisma.run.findUnique({
    where: { id: runId },
    select: { alternativePlans: true },
  });
  const all = (row?.alternativePlans as unknown as AlternativePlansByStep | null) ?? null;
  return all?.[String(stepIndex)] ?? null;
}
