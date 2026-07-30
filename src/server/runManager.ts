import { EventEmitter } from "events";
import { nanoid } from "nanoid";
import type { ControlModeReason, ElementLocator, ManualInputEvent, RunRecord, StepResult } from "./types";
import { insertRun } from "./runs";
import { trackRunEvent } from "./analytics";

export interface CreateRunParams {
  userId: string;
  promptId: string;
  promptText: string;
  startUrl: string;
  // Optional — only used to enrich the "created" analytics event. The
  // caller already has these on hand (from the Prompt-with-Skill lookup),
  // so this avoids a second DB round trip just for tracking.
  projectId?: string;
  skillId?: string;
  // Set when this run is a deterministic replay of another run
  // (src/server/replay.ts) — see queue.ts's worker branch.
  sourceRunId?: string;
  // Set when this run is one generated alternative for a single step of
  // sourceRunId (src/server/variation.ts) — see queue.ts's worker branch.
  variantOfStepIndex?: number;
  variantIndex?: number;
  // The exact real target the alternative-suggestion pipeline
  // (src/server/alternativesAgent.ts) decided on — variantTask clicks this
  // directly rather than rediscovering/narrowing anything itself.
  variantTargetLocator?: ElementLocator;
  variantLabel?: string;
  // Set when this run is a whole-site action-graph crawl for a skill
  // (src/server/actionGraph.ts) — see queue.ts's worker branch.
  crawlSkillId?: string;
  // Set when this run batch-executes every cataloged action in a skill's
  // action graph (src/server/actionGraph.ts's validateTask) — see queue.ts's
  // worker branch.
  validateSkillId?: string;
  // How many of the skill's cataloged actions to actually validate —
  // undefined means "every cataloged action". See queue.ts's worker branch.
  validateCount?: number;
  // Set alongside crawlSkillId/validateSkillId — see types.ts's RunRecord
  // field of the same name.
  graphRunId?: string;
  // Set when this run is a prompt-driven agent execution
  // (src/server/agent.ts's agentTask) — see queue.ts's worker branch.
  agentSkillId?: string;
  agentPrompt?: string;
}

export class RunJob extends EventEmitter {
  record: RunRecord;
  stopRequested = false;
  // Set alongside stopRequested when a session is ended via "Finish" rather
  // than "Stop" — same shutdown path (closes the browser, etc.) but the
  // final status lands as "completed" with no error instead of
  // "error"/"Stopped by user".
  finishRequested = false;
  // Live-only, never persisted — the report reflects the session starting
  // via the "manual-start" step automation.ts adds instead. Every run is
  // under human control from the moment it starts; this just tells the
  // live-view client when that control has actually taken effect (there's
  // a brief window between "queued" and the browser being ready).
  controlMode: "auto" | "manual" = "auto";

  constructor(params: CreateRunParams) {
    super();
    this.setMaxListeners(50);
    this.record = {
      id: nanoid(10),
      userId: params.userId,
      promptId: params.promptId,
      promptText: params.promptText,
      startUrl: params.startUrl,
      status: "queued",
      createdAt: new Date().toISOString(),
      steps: [],
      sourceRunId: params.sourceRunId,
      variantOfStepIndex: params.variantOfStepIndex,
      variantIndex: params.variantIndex,
      variantTargetLocator: params.variantTargetLocator,
      variantLabel: params.variantLabel,
      crawlSkillId: params.crawlSkillId,
      validateSkillId: params.validateSkillId,
      validateCount: params.validateCount,
      graphRunId: params.graphRunId,
      agentSkillId: params.agentSkillId,
      agentPrompt: params.agentPrompt,
    };
  }

  emitFrame(data: string) {
    this.emit("frame", data);
  }

  // Steps happen live and aren't known up front, so they're appended one at
  // a time rather than pre-sized and updated by index.
  addStep(partial: Omit<StepResult, "index">): StepResult {
    const step: StepResult = { ...partial, index: this.record.steps.length };
    this.record.steps.push(step);
    this.emit("step", step);
    return step;
  }

  updateStep(index: number, patch: Partial<StepResult>) {
    const step = this.record.steps[index];
    if (!step) return;
    Object.assign(step, patch);
    this.emit("step", step);
  }

  emitStatus() {
    this.emit("status", { status: this.record.status, error: this.record.error });
  }

  requestStop() {
    if (this.record.status !== "running" && this.record.status !== "queued") {
      return;
    }
    this.stopRequested = true;
    this.emit("stop-requested");
  }

  // Only requests the finish — automation.ts logs a final screenshotted
  // step first, then calls confirmFinish() to actually trigger shutdown, so
  // the report gets a closing screenshot instead of the browser just
  // vanishing mid-frame.
  requestFinish() {
    if (this.record.status !== "running") return;
    this.emit("finish-requested");
  }

  // Reuses the exact same shutdown path as requestStop() (closing the
  // browser etc.), just tagged so the final status comes out "completed"
  // instead of "error".
  confirmFinish() {
    this.finishRequested = true;
    this.stopRequested = true;
    this.emit("stop-requested");
  }

  setControlMode(mode: "auto" | "manual", reason?: ControlModeReason) {
    this.controlMode = mode;
    this.emit("control-mode", { mode, reason });
  }

  // Forwarded to automation.ts's "manual-input" listener, which has the
  // live CDP session in scope to actually dispatch it.
  dispatchInput(event: ManualInputEvent) {
    this.emit("manual-input", event);
  }

  // Sent by the live-view client's "Continue replay" button — a one-shot
  // signal, consumed by whichever `await` in replay.ts is currently
  // paused waiting for a human to finish a typing/drift-recovery step.
  // No-op outside manual control (e.g. a stray double-click) since there's
  // nothing waiting to resume.
  requestResumeReplay() {
    if (this.controlMode !== "manual") return;
    this.emit("resume-replay");
  }

  // Sent by the live-view client's "Use this match" button when a
  // vision-assist suggestion is showing on a drift pause (StepResult.
  // driftSuggestion) — consumed by replay.ts's handleApplyDriftSuggestion,
  // which performs the actual click and then calls requestResumeReplay()
  // itself once it's done. No-op outside manual control, same reasoning as
  // requestResumeReplay above.
  requestApplyDriftSuggestion() {
    if (this.controlMode !== "manual") return;
    this.emit("apply-drift-suggestion");
  }
}

// The custom server (server.ts, run directly via tsx) and the Next.js API
// routes (compiled into Next's own server bundle) each load this module as a
// separate instance, so a plain module-level Map would not be shared between
// them. Anchoring it on globalThis makes it a true process-wide singleton.
const globalKey = Symbol.for("skill-builder.runs");
type GlobalWithRuns = typeof globalThis & { [globalKey]?: Map<string, RunJob> };
const g = globalThis as GlobalWithRuns;
const runs = g[globalKey] ?? (g[globalKey] = new Map<string, RunJob>());

export async function createRun(params: CreateRunParams): Promise<RunJob> {
  const job = new RunJob(params);
  runs.set(job.record.id, job);
  await insertRun(job.record);
  trackRunEvent({
    eventType: "created",
    runId: job.record.id,
    userId: params.userId,
    promptId: params.promptId,
    projectId: params.projectId,
    skillId: params.skillId,
  });
  return job;
}

export function getRun(id: string): RunJob | undefined {
  return runs.get(id);
}

export function deleteRun(id: string) {
  runs.delete(id);
}

export function listRuns(): RunRecord[] {
  return Array.from(runs.values())
    .map((job) => job.record)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
