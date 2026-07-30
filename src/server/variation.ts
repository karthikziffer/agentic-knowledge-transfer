import type { CDPSession, Locator, Page } from "playwright";
import type { RunJob } from "./runManager";
import {
  launchRunBrowser,
  finalizeRunSession,
  screenshotStep,
  domSnapshot,
  uploadDomSnapshot,
  moveCursorOverlay,
  triggerClickRipple,
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
export async function replayPrefixUnattended(
  page: Page,
  cdp: CDPSession,
  steps: StepResult[],
  uptoIndex: number,
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
        moveCursorOverlay(cdp, x, y);
        triggerClickRipple(cdp, x, y);
      }
      try {
        await clickResilient(result.locator, 5000);
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

// A generated alternative's target is decided once, upfront, by the
// alternative-suggestion pipeline (src/server/alternativesAgent.ts) and
// handed to this run at creation time (job.record.variantTargetLocator,
// set by the /variations API route from the suggestion the user picked) —
// this worker's only job is to reach that step and click the one,
// already-decided real target. No rediscovery, no narrowing: the thinking
// already happened.
export async function variantTask(job: RunJob) {
  const { sourceRunId, variantOfStepIndex, variantTargetLocator } = job.record;
  if (!sourceRunId || variantOfStepIndex == null || !variantTargetLocator) {
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

    const prefix = await replayPrefixUnattended(page, cdp, sourceRun.steps, variantOfStepIndex);
    if (!prefix.ok) {
      job.record.status = "error";
      job.record.error = `Couldn't reach step ${variantOfStepIndex + 1}: ${prefix.reason}`;
    } else {
      const domBeforeHtml = await domSnapshot(page);
      const clickLocator = resolveLocator(page, variantTargetLocator);

      // The decision agent already confirmed this was a real, visible
      // element — but a real page can still surprise us between discovery
      // and click (a layout shift, an animation that hasn't settled), so
      // re-check right before clicking rather than burning the full click
      // timeout on something already known to be unclickable.
      const visible = await clickLocator.isVisible().catch(() => false);
      if (!visible) {
        job.record.status = "error";
        job.record.error = "The chosen alternative target is no longer visible on the page";
      } else {
        const box = await clickLocator.boundingBox().catch(() => null);
        if (box) {
          const x = box.x + box.width / 2;
          const y = box.y + box.height / 2;
          moveCursorOverlay(cdp, x, y);
          triggerClickRipple(cdp, x, y);
        }
        try {
          await clickResilient(clickLocator, 8000);
          const step = job.addStep({
            type: "variant-click",
            description: `Clicked ${job.record.variantLabel ?? "alternative target"}`,
            status: "done",
            startedAt: new Date().toISOString(),
            locator: variantTargetLocator,
            replayOf: variantOfStepIndex,
          });
          await page.waitForTimeout(150).catch(() => {});
          step.url = page.url();
          step.screenshot = await screenshotStep(page, job.record.id, step.index).catch(() => undefined);
          step.domBefore = await uploadDomSnapshot(job.record.id, step.index, "before", domBeforeHtml);
          step.domAfter = await uploadDomSnapshot(job.record.id, step.index, "after", await domSnapshot(page));
          step.finishedAt = new Date().toISOString();
          job.updateStep(step.index, step);
          job.record.status = "completed";
        } catch (err) {
          job.record.status = "error";
          job.record.error = `Couldn't click the alternative target (${err instanceof Error ? err.message : String(err)})`;
        }
      }
    }
  } catch (err) {
    job.record.status = "error";
    job.record.error = err instanceof Error ? err.message : String(err);
  } finally {
    job.record.finishedAt = new Date().toISOString();
    await finalizeRunSession(job, session);
  }
}
