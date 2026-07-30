import type { CDPSession, Page } from "playwright";
import type { RunJob } from "./runManager";
import {
  launchRunBrowser,
  finalizeRunSession,
  screenshotStep,
  domSnapshot,
  uploadDomSnapshot,
  moveCursorOverlay,
  triggerClickRipple,
  wireManualControl,
  waitUntilStopped,
  finalizeWithoutRunning,
} from "./automation";
import {
  elementLocatorForCandidate,
  resolveHealedLocator,
  resolveLocator,
  resolveStepTarget,
  type ResolveResult,
} from "./locatorReplay";
import { suggestDriftCandidate } from "./driftAssist";
import { getRunFromDb, healSourceStepLocator, persistRun } from "./runs";
import type { ElementLocator, HealedLocatorRecord, StepResult } from "./types";

// Resolves once either a human hits "Continue replay" or the run is
// stopped/finished — whichever happens first wins. Mirrors
// automation.ts's waitUntilStopped, but also unblocks on the new
// "resume-replay" signal (RunJob.requestResumeReplay()).
//
// `checkBeforeResume`, if given, runs at the moment Continue is actually
// pressed (not when the pause started) — return a warning message to hold
// the resume and surface it instead ("continue-warning" job event, shown by
// LiveRunView), or null to let it proceed immediately. Pressing Continue a
// second time always proceeds — the warning is a heads-up, not a hard
// block, since there's no way to know for certain the human didn't mean to
// skip the step on purpose. This exists because "Continue" previously
// advanced unconditionally even when the paused action never actually
// happened, silently leaving replay on the wrong page for every step after
// — see the docs.langchain.com "not found" cascade this was built to catch.
function waitForResumeOrStop(job: RunJob, checkBeforeResume?: () => string | null): Promise<"resume" | "stop"> {
  if (job.stopRequested) return Promise.resolve("stop");
  return new Promise((resolve) => {
    let warned = false;
    const cleanup = () => {
      job.off("resume-replay", onResume);
      job.off("stop-requested", onStop);
    };
    const onResume = () => {
      if (checkBeforeResume && !warned) {
        const warning = checkBeforeResume();
        if (warning) {
          warned = true;
          job.emit("continue-warning", warning);
          return;
        }
      }
      cleanup();
      resolve("resume");
    };
    const onStop = () => {
      cleanup();
      resolve("stop");
    };
    job.on("resume-replay", onResume);
    job.once("stop-requested", onStop);
  });
}

const DRIFT_REASON_COPY: Record<string, string> = {
  "not found": "Couldn't find the recorded target on the page — it may have changed.",
  ambiguous: "The recorded target now matches more than one element on the page.",
  drifted: "Found a matching element, but it doesn't look like the one that was recorded.",
};

// Fire-and-forget — healing is a convenience cache (see healSourceStepLocator
// in runs.ts), never something replay should block or fail on.
function healIfNeeded(
  job: RunJob,
  sourceStep: StepResult,
  locator: ElementLocator,
  source: HealedLocatorRecord["source"],
) {
  const sourceRunId = job.record.sourceRunId;
  if (!sourceRunId) return;
  void healSourceStepLocator(sourceRunId, sourceStep.index, locator, source).catch(() => {});
}

export async function replayTask(job: RunJob) {
  if (!job.record.sourceRunId) {
    finalizeWithoutRunning(job, "This run has no source run to replay");
    return;
  }

  const session = await launchRunBrowser(job);
  if (!session) return;
  const { page, cdp } = session;

  const sourceRun = await getRunFromDb(job.record.sourceRunId);
  const unwireManualControl = wireManualControl(job, page, cdp);

  try {
    await page.goto(job.record.startUrl, { waitUntil: "domcontentloaded" });

    const startStep = job.addStep({
      type: "manual-start",
      description: "Replay started",
      status: "done",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      url: page.url(),
    });
    startStep.screenshot = await screenshotStep(page, job.record.id, startStep.index).catch(
      () => undefined,
    );
    job.updateStep(startStep.index, startStep);
    await persistRun(job.record).catch(() => {});

    if (!sourceRun || sourceRun.steps.length === 0) {
      // Nothing to replay against — hand the whole thing to a human rather
      // than silently completing an empty run.
      job.setControlMode("manual", "drift");
      await waitUntilStopped(job);
    } else {
      await walkSourceSteps(job, page, cdp, sourceRun.steps);
    }

    if (!job.finishRequested && !job.stopRequested) {
      // Walked off the end of the recorded steps without the human ending
      // it early — that's a clean, successful replay. Log a closing step
      // (with a final screenshot) the same way a human clicking "Finish"
      // would, so the report doesn't just stop mid-list.
      const endStep = job.addStep({
        type: "manual-finish",
        description: "Replay finished",
        status: "done",
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        url: page.url(),
      });
      endStep.screenshot = await screenshotStep(page, job.record.id, endStep.index).catch(
        () => undefined,
      );
      job.updateStep(endStep.index, endStep);
      await persistRun(job.record).catch(() => {});
      job.confirmFinish();
    }

    job.record.status = job.finishRequested ? "completed" : "error";
    job.record.error = job.finishRequested ? undefined : "Stopped by user";
  } catch (err) {
    job.record.status = job.finishRequested ? "completed" : "error";
    job.record.error = job.finishRequested
      ? undefined
      : job.stopRequested
        ? "Stopped by user"
        : err instanceof Error
          ? err.message
          : String(err);
  } finally {
    unwireManualControl();
    job.record.finishedAt = new Date().toISOString();
    await finalizeRunSession(job, session);
  }
}

async function logReplayStep(
  job: RunJob,
  page: Page,
  partial: Omit<StepResult, "index" | "screenshot" | "domAfter" | "finishedAt">,
  domBeforeHtml?: string,
): Promise<StepResult> {
  const step = job.addStep(partial);
  await page.waitForTimeout(150).catch(() => {});
  step.url = page.url();
  step.screenshot = await screenshotStep(page, job.record.id, step.index).catch(() => undefined);
  step.domBefore = await uploadDomSnapshot(job.record.id, step.index, "before", domBeforeHtml);
  step.domAfter = await uploadDomSnapshot(job.record.id, step.index, "after", await domSnapshot(page));
  step.finishedAt = new Date().toISOString();
  job.updateStep(step.index, step);
  await persistRun(job.record).catch(() => {});
  return step;
}

// Steps through the source run's recorded steps, driving clicks/scrolls
// automatically via their captured locators and handing control to a human
// (job.setControlMode("manual", reason)) the moment it hits a typed-input
// step or a locator that doesn't resolve confidently — see
// src/server/locatorReplay.ts for what "confidently" means. Never guesses.
async function walkSourceSteps(
  job: RunJob,
  page: Page,
  cdp: CDPSession,
  sourceSteps: StepResult[],
) {
  // Set right before a drift pause that got a vision-assist suggestion, and
  // read by handleApplyDriftSuggestion below when the human presses "Use
  // this match" in the live view — only one pause is ever active at a time
  // since the walk is sequential, so a single slot is enough.
  let pendingDriftApply: { sourceStep: StepResult; locator: ElementLocator } | null = null;

  // Shared by the human-triggered "Use this match" path and the automatic
  // high-confidence path below — clicks a suggested locator, heals it back
  // onto the source step on success, and logs either outcome. Returns
  // whether the click succeeded, so callers can decide what to do next
  // (resume vs. fall through to a manual handoff) without this needing to
  // know which caller it is.
  async function clickTargetAndHeal(
    sourceStep: StepResult,
    locator: ElementLocator,
    healSource: HealedLocatorRecord["source"],
    label: string,
  ): Promise<boolean> {
    try {
      const domBeforeHtml = await domSnapshot(page);
      const target = resolveLocator(page, locator);
      const box = await target.boundingBox().catch(() => null);
      if (box) {
        const x = box.x + box.width / 2;
        const y = box.y + box.height / 2;
        moveCursorOverlay(cdp, x, y);
        triggerClickRipple(cdp, x, y);
      }
      await target.click({ timeout: 5000 });
      healIfNeeded(job, sourceStep, locator, healSource);
      await logReplayStep(
        job,
        page,
        {
          type: "replay-click",
          description: `Clicked ${sourceStep.description ?? "the recorded target"} (${label})`,
          status: "done",
          startedAt: new Date().toISOString(),
          locator,
          replayOf: sourceStep.index,
        },
        domBeforeHtml,
      );
      return true;
    } catch (err) {
      await logReplayStep(job, page, {
        type: "replay-paused",
        description: `Couldn't click the ${label} target.`,
        error: err instanceof Error ? err.message : String(err),
        status: "error",
        startedAt: new Date().toISOString(),
        replayOf: sourceStep.index,
      });
      return false;
    }
  }

  async function handleApplyDriftSuggestion() {
    const pending = pendingDriftApply;
    if (!pending) return;
    pendingDriftApply = null;
    // Whether the click succeeds or fails, the human already made the call
    // — move the walk on rather than leaving it stuck on this step.
    await clickTargetAndHeal(pending.sourceStep, pending.locator, "human-suggestion", "AI-suggested match");
    job.requestResumeReplay();
  }

  job.on("apply-drift-suggestion", handleApplyDriftSuggestion);

  try {
    for (let stepPos = 0; stepPos < sourceSteps.length; stepPos++) {
      const sourceStep = sourceSteps[stepPos];
      // Recomputed fresh per-iteration from the array rather than tracked
      // across the loop's several `continue`s — used below to tell whether
      // this step's original click was expected to navigate.
      const previousSourceUrl = stepPos > 0 ? sourceSteps[stepPos - 1].url : undefined;

      if (job.stopRequested) return;
      if (sourceStep.type === "manual-start" || sourceStep.type === "manual-finish") continue;

      if (sourceStep.type === "manual-click") {
        // A previously-healed override, if one exists, gets first crack —
        // the fast, already-proven path. Falls through to the normal
        // recorded-locator pipeline if it's gone stale (resolveHealedLocator
        // returns null rather than guessing).
        let result: ResolveResult;
        if (sourceStep.healedLocator) {
          const healedTarget = await resolveHealedLocator(page, sourceStep.healedLocator.locator);
          result = healedTarget ? { ok: true, locator: healedTarget } : await resolveStepTarget(page, sourceStep);
        } else {
          result = await resolveStepTarget(page, sourceStep);
        }

        if (result.ok) {
          if (result.healedVia) {
            const via = result.healedVia;
            void elementLocatorForCandidate(result.locator).then((healedLocator) => {
              if (healedLocator) healIfNeeded(job, sourceStep, healedLocator, via);
            });
          }
          const domBeforeHtml = await domSnapshot(page);
          const box = await result.locator.boundingBox().catch(() => null);
          if (box) {
            const x = box.x + box.width / 2;
            const y = box.y + box.height / 2;
            moveCursorOverlay(cdp, x, y);
            triggerClickRipple(cdp, x, y);
          }
          try {
            await result.locator.click({ timeout: 5000 });
            await logReplayStep(
              job,
              page,
              {
                type: "replay-click",
                description: sourceStep.description ?? "Clicked",
                status: "done",
                startedAt: new Date().toISOString(),
                locator: sourceStep.locator,
                replayOf: sourceStep.index,
              },
              domBeforeHtml,
            );
            continue;
          } catch (err) {
            await logReplayStep(job, page, {
              type: "replay-paused",
              description: "Couldn't click the recorded target.",
              error: err instanceof Error ? err.message : String(err),
              status: "error",
              startedAt: new Date().toISOString(),
              replayOf: sourceStep.index,
            });
            // falls through to the drift handoff below
          }
        } else {
          const driftSuggestion =
            result.reason !== "not found" && sourceStep.screenshot && job.record.sourceRunId
              ? await suggestDriftCandidate({
                  page,
                  cdp,
                  runId: job.record.id,
                  sourceStepIndex: sourceStep.index,
                  sourceRunId: job.record.sourceRunId,
                  recordedScreenshotFile: sourceStep.screenshot,
                  targetDescription: sourceStep.description ?? sourceStep.type,
                  candidates: result.candidates,
                })
              : undefined;

          if (driftSuggestion?.confidence === "high") {
            // High-confidence suggestion — click immediately instead of
            // pausing. Still logged distinctly and still healed, same as
            // any other resolved pause, just without a human in the loop
            // for this one specifically.
            const label = `${driftSuggestion.source === "semantic" ? "AI match" : "AI judgment"}, auto-resolved`;
            const clicked = await clickTargetAndHeal(sourceStep, driftSuggestion.locator, driftSuggestion.source, label);
            if (clicked) continue;
            // The click itself failed even though confidence was high (e.g.
            // the element became unclickable between suggestion and click)
            // — clickTargetAndHeal already logged that failure step; fall
            // through to the manual handoff below rather than logging a
            // second, redundant paused step.
            pendingDriftApply = null;
          } else {
            await logReplayStep(job, page, {
              type: "replay-paused",
              description: result.detail
                ? `${DRIFT_REASON_COPY[result.reason]} (${result.detail})`
                : DRIFT_REASON_COPY[result.reason],
              error: result.reason,
              status: "error",
              startedAt: new Date().toISOString(),
              replayOf: sourceStep.index,
              driftSuggestion,
            });

            pendingDriftApply = driftSuggestion ? { sourceStep, locator: driftSuggestion.locator } : null;
          }
        }

        // If this step's original click changed the page (its recorded URL
        // differs from the step before it), and the live page hasn't moved
        // at all since this pause started by the time Continue is pressed,
        // that's a strong sign the paused action never actually happened —
        // warn instead of silently walking every later step against the
        // wrong page (see the docs.langchain.com cascade this was built to
        // catch: a skipped navigation pause, then two "not found" steps in
        // a row against a page that was never reached).
        const expectedToNavigate =
          sourceStep.url !== undefined && previousSourceUrl !== undefined && sourceStep.url !== previousSourceUrl;
        const pausedAtUrl = page.url();

        job.setControlMode("manual", "drift");
        const outcome = await waitForResumeOrStop(
          job,
          expectedToNavigate
            ? () =>
                page.url() === pausedAtUrl
                  ? "It doesn't look like the page changed since this pause started — if you meant to skip this step, click Continue again to proceed anyway."
                  : null
            : undefined,
        );
        pendingDriftApply = null;
        if (outcome === "stop") return;
        job.setControlMode("auto");
        continue;
      }

      if (sourceStep.type === "manual-type") {
        // Typed content is never recorded (see automation.ts) — always hand
        // off to a human here, there's nothing to autofill.
        await logReplayStep(job, page, {
          type: "replay-paused",
          description: "This step needs typing — recorded sessions never store what was typed.",
          status: "done",
          startedAt: new Date().toISOString(),
          locator: sourceStep.locator,
          replayOf: sourceStep.index,
        });
        job.setControlMode("manual", "typing");
        const outcome = await waitForResumeOrStop(job);
        if (outcome === "stop") return;
        job.setControlMode("auto");
        continue;
      }

      if (sourceStep.type === "manual-scroll") {
        const domBeforeHtml = await domSnapshot(page);
        const down = !sourceStep.description?.includes("up");
        await page
          .evaluate((dy) => window.scrollBy(0, dy), down ? 600 : -600)
          .catch(() => {});
        await logReplayStep(
          job,
          page,
          {
            type: "replay-scroll",
            description: sourceStep.description ?? "Scrolled",
            status: "done",
            startedAt: new Date().toISOString(),
            replayOf: sourceStep.index,
          },
          domBeforeHtml,
        );
        continue;
      }
    }
  } finally {
    job.off("apply-drift-suggestion", handleApplyDriftSuggestion);
  }
}
