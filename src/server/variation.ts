import type { CDPSession, Locator, Page } from "playwright";
import type { RunJob } from "./runManager";
import {
  launchRunBrowser,
  finalizeRunSession,
  screenshotStep,
  domSnapshot,
  uploadDomSnapshot,
  moveCursorOverlay,
  glideCursorTo,
  triggerClickRipple,
  settleAfterAction,
  finalizeWithoutRunning,
} from "./automation";
import { resolveLocator, resolveStepTarget } from "./locatorReplay";
import { getRunFromDb, persistRun } from "./runs";
import type { StepResult } from "./types";

// A target can be confirmed visible/enabled/stable by Playwright's own
// actionability checks and still be unclickable, because something else
// physically overlaps its click point at that instant — a sticky header, a
// mega-menu whose inactive panels occupy the same screen region as the
// active one, a breadcrumb bar. On sites where that overlap never resolves
// on its own, Playwright's normal retry-until-actionable click just times
// out. Only escalate to a forced click (bypassing the interception check)
// when the failure is specifically "intercepts pointer events" — every
// other failure (not found, detached, genuinely hidden) should still fail
// loudly rather than force-click something that was never actually there.
export async function clickResilient(locator: Locator, timeoutMs: number): Promise<void> {
  try {
    await locator.click({ timeout: timeoutMs });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes("intercepts pointer events")) throw err;
    await locator.click({ force: true, timeout: timeoutMs });
  }
}

// Replays a source run's steps up to (not including) `uptoIndex`,
// auto-driving clicks/scrolls exactly like replay.ts's walkSourceSteps —
// but with no human handoff at all. Also used, DB/job-free, by the
// alternative-suggestion pipeline's "site agent" step
// (src/server/alternativesAgent.ts) to reach the same page state before
// exploring it. A variation run is an unattended batch job; any
// uncertainty here just fails the whole variant cleanly rather than
// pausing, since nobody is watching N of these at once to unstick them.
//
// `animate` defaults to false — the alternativesAgent.ts caller has no live
// view at all (it's a background worker with nobody watching), so glide/
// settle pauses there would only slow down plan generation for no benefit.
// variantTask below passes true since that run *is* live-viewed.
export async function replayPrefixUnattended(
  page: Page,
  cdp: CDPSession,
  steps: StepResult[],
  uptoIndex: number,
  animate = false,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  for (const step of steps) {
    if (step.index >= uptoIndex) break;
    if (step.type === "manual-start" || step.type === "manual-finish") continue;

    if (step.type === "manual-click" || step.type === "replay-click") {
      const result = await resolveStepTarget(page, step);
      if (!result.ok) return { ok: false, reason: `step ${step.index + 1}: ${result.reason}` };
      const box = await result.locator.boundingBox().catch(() => null);
      if (box) {
        const x = box.x + box.width / 2;
        const y = box.y + box.height / 2;
        if (animate) {
          await glideCursorTo(page, cdp, x, y);
        } else {
          moveCursorOverlay(cdp, x, y);
        }
        triggerClickRipple(cdp, x, y);
      }
      try {
        await clickResilient(result.locator, 5000);
        if (animate) await settleAfterAction(page);
      } catch (err) {
        return {
          ok: false,
          reason: `step ${step.index + 1}: click failed (${err instanceof Error ? err.message : String(err)})`,
        };
      }
      continue;
    }

    if (step.type === "manual-type") {
      return { ok: false, reason: `step ${step.index + 1} needs typing — nothing to autofill` };
    }

    if (step.type === "manual-scroll" || step.type === "replay-scroll") {
      const down = !step.description?.includes("up");
      await page.evaluate((dy) => window.scrollBy(0, dy), down ? 600 : -600).catch(() => {});
      continue;
    }
  }
  return { ok: true };
}

// A generated alternative plan is decided once, upfront, by the
// alternative-plan pipeline (src/server/alternativesAgent.ts) and handed to
// this run at creation time (job.record.variantPlanSteps, an ordered list
// of locators, set by the /variations API route from the plan the user
// picked) — this worker's only job is to reach the first step and then walk
// the plan's hops in order, each on the page the previous hop landed on. No
// rediscovery, no narrowing: the thinking already happened.
//
// Fails fast on the first hop that can't be clicked rather than skipping it
// and continuing — a multi-hop plan is inherently stateful (hop N assumes
// hop N-1 actually landed somewhere real), so pressing on past a failed hop
// would just mean every hop after it replays against a page state the plan
// never anticipated.
export async function variantTask(job: RunJob) {
  const { sourceRunId, variantOfStepIndex, variantTargetLocator, variantPlanSteps } = job.record;
  const planSteps = variantPlanSteps?.length ? variantPlanSteps : variantTargetLocator ? [variantTargetLocator] : null;
  if (!sourceRunId || variantOfStepIndex == null || !planSteps) {
    finalizeWithoutRunning(job, "This run is missing variation parameters");
    return;
  }

  const sourceRun = await getRunFromDb(sourceRunId);
  const targetStep = sourceRun?.steps.find((s) => s.index === variantOfStepIndex);
  if (
    !sourceRun ||
    !targetStep ||
    !targetStep.locator ||
    (targetStep.type !== "manual-click" && targetStep.type !== "replay-click")
  ) {
    finalizeWithoutRunning(job, "The source step no longer exists or has no recorded target");
    return;
  }

  const session = await launchRunBrowser(job);
  if (!session) return;
  const { page, cdp } = session;

  try {
    await page.goto(job.record.startUrl, { waitUntil: "domcontentloaded" });

    const startStep = job.addStep({
      type: "manual-start",
      description: "Variation started",
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

    const prefix = await replayPrefixUnattended(page, cdp, sourceRun.steps, variantOfStepIndex, true);
    if (!prefix.ok) {
      job.record.status = "error";
      job.record.error = `Couldn't reach step ${variantOfStepIndex + 1}: ${prefix.reason}`;
    } else {
      let failed = false;
      for (let hopIndex = 0; hopIndex < planSteps.length; hopIndex++) {
        const hopLocator = planSteps[hopIndex];
        const domBeforeHtml = await domSnapshot(page);
        const clickLocator = resolveLocator(page, hopLocator);

        // The decision agent already confirmed this was a real, visible
        // element — but a real page can still surprise us between
        // discovery and click (a layout shift, an animation that hasn't
        // settled), so re-check right before clicking rather than burning
        // the full click timeout on something already known to be
        // unclickable.
        const visible = await clickLocator.isVisible().catch(() => false);
        if (!visible) {
          job.record.status = "error";
          job.record.error =
            planSteps.length > 1
              ? `Step ${hopIndex + 1} of the plan is no longer visible on the page`
              : "The chosen alternative target is no longer visible on the page";
          failed = true;
          break;
        }

        const box = await clickLocator.boundingBox().catch(() => null);
        if (box) {
          const x = box.x + box.width / 2;
          const y = box.y + box.height / 2;
          await glideCursorTo(page, cdp, x, y);
          triggerClickRipple(cdp, x, y);
        }
        try {
          await clickResilient(clickLocator, 8000);
          const step = job.addStep({
            type: "variant-click",
            description:
              planSteps.length > 1
                ? `Step ${hopIndex + 1}/${planSteps.length}: clicked ${job.record.variantLabel ?? "plan target"}`
                : `Clicked ${job.record.variantLabel ?? "alternative target"}`,
            status: "done",
            startedAt: new Date().toISOString(),
            locator: hopLocator,
            replayOf: hopIndex === 0 ? variantOfStepIndex : undefined,
          });
          await settleAfterAction(page);
          step.url = page.url();
          step.screenshot = await screenshotStep(page, job.record.id, step.index).catch(() => undefined);
          step.domBefore = await uploadDomSnapshot(job.record.id, step.index, "before", domBeforeHtml);
          step.domAfter = await uploadDomSnapshot(job.record.id, step.index, "after", await domSnapshot(page));
          step.finishedAt = new Date().toISOString();
          job.updateStep(step.index, step);
          await persistRun(job.record).catch(() => {});
        } catch (err) {
          job.record.status = "error";
          job.record.error =
            planSteps.length > 1
              ? `Couldn't click step ${hopIndex + 1} of the plan (${err instanceof Error ? err.message : String(err)})`
              : `Couldn't click the alternative target (${err instanceof Error ? err.message : String(err)})`;
          failed = true;
          break;
        }
      }
      if (!failed) job.record.status = "completed";
    }
  } catch (err) {
    job.record.status = "error";
    job.record.error = err instanceof Error ? err.message : String(err);
  } finally {
    job.record.finishedAt = new Date().toISOString();
    await finalizeRunSession(job, session);
  }
}
