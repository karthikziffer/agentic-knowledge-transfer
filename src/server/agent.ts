import { SystemMessage, HumanMessage, type MessageContent } from "@langchain/core/messages";
import type { RunJob } from "./runManager";
import { launchRunBrowser, finalizeRunSession, screenshotStep, glideCursorTo, triggerClickRipple, settleAfterAction } from "./automation";
import { clickResilient } from "./variation";
import { resolveLocator } from "./locatorReplay";
import { persistRun } from "./runs";
import { searchActions, type SearchActionResult } from "./actionGraph";
import { invokeChatModel } from "./flowSummary";
import { getPrompt, renderPrompt } from "./promptLibrary";

// How many candidate known actions (ranked by embedding similarity) to hand
// the picker LLM per planned step — enough for it to genuinely choose among
// real options without blowing up the prompt.
const CANDIDATES_PER_STEP = 5;

function messageContentToText(content: MessageContent): string {
  if (typeof content === "string") return content;
  return content
    .map((part) => (typeof part === "string" ? part : "text" in part ? (part.text as string) : ""))
    .join(" ");
}

// Turns the free-text instruction into an ordered list of single-action
// steps — e.g. "log in then open settings" -> ["click the Log in link",
// "click the Settings link"]. Falls back to treating the whole instruction
// as one step if the model's response doesn't parse as a numbered list, so
// a single simple prompt (the common case) never depends on this working
// perfectly.
async function planSteps(instruction: string): Promise<string[]> {
  const response = await invokeChatModel([
    new SystemMessage(getPrompt("agent.planSteps.system")),
    new HumanMessage(renderPrompt("agent.planSteps.human", { prompt: instruction })),
  ]);
  const text = messageContentToText(response.content);
  const steps = text
    .split("\n")
    .map((line) => line.match(/^\s*\d+[.)]\s*(.+)/)?.[1]?.trim())
    .filter((line): line is string => Boolean(line));
  return steps.length > 0 ? steps : [instruction];
}

// Asks the model which (if any) of the top similarity-ranked candidates
// genuinely matches a single planned step — the vector search alone ranks
// by embedding distance, which is a good shortlist but not always the right
// pick (e.g. "log out" and "log in" read as similar text); this is the
// judgment call on top of that shortlist. Saying "none" is a valid, and
// often correct, answer. Returns the reasoning alongside the pick (not just
// the winner) so the caller can attach the full decision — including why a
// step matched nothing — onto the step for the UI to show, rather than
// this judgment call being a black box.
async function chooseCandidate(
  step: string,
  candidates: SearchActionResult[],
): Promise<{ chosen: SearchActionResult | null; index: number | null; reasoning: string }> {
  const candidatesList = candidates
    .map((c, i) => `${i}. ${c.description} (${c.status}, role: ${c.role}, similarity: ${c.similarity.toFixed(2)})`)
    .join("\n");
  const response = await invokeChatModel([
    new SystemMessage(getPrompt("agent.chooseCandidate.system")),
    new HumanMessage(renderPrompt("agent.chooseCandidate.human", { step, candidatesList })),
  ]);
  const text = messageContentToText(response.content);
  const pickMatch = text.match(/Pick:\s*(none|\d+)/i);
  const reasoningMatch = text.match(/Reasoning:\s*([\s\S]*)$/i);
  const pickValue = pickMatch?.[1]?.toLowerCase();
  const index = pickValue && pickValue !== "none" && /^\d+$/.test(pickValue) ? Number(pickValue) : null;
  const reasoning = reasoningMatch?.[1]?.trim() ?? text.trim();
  if (index === null || index < 0 || index >= candidates.length) {
    return { chosen: null, index: null, reasoning };
  }
  return { chosen: candidates[index], index, reasoning };
}

// Prompt-driven execution of a skill: takes a free-text instruction (set on
// this run at creation time, alongside its own target startUrl), breaks it
// into steps, and for each one searches the skill's action graph (built by
// actionGraph.ts's crawler) for the closest known real action, then actually
// clicks it in a live browser — the "Agent" tab's whole point is running on
// accumulated graph knowledge rather than rediscovering the page from
// scratch every time. Structurally similar to validateTask (same
// launch/navigate/click/log/finalize shape), but driven by a ranked,
// LLM-picked action per planned step instead of "every cataloged action."
export async function agentTask(job: RunJob): Promise<void> {
  const skillId = job.record.agentSkillId;
  const instruction = job.record.agentPrompt;
  if (!skillId || !instruction) {
    job.record.status = "error";
    job.record.error = "This run is missing its agent target skill or instruction";
    await persistRun(job.record).catch(() => {});
    return;
  }

  const session = await launchRunBrowser(job);
  if (!session) return;
  const { page, cdp } = session;

  try {
    await page.goto(job.record.startUrl, { waitUntil: "domcontentloaded" });

    const startStep = job.addStep({
      type: "manual-start",
      description: `Agent started: ${instruction}`,
      status: "done",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      url: page.url(),
    });
    startStep.screenshot = await screenshotStep(page, job.record.id, startStep.index).catch(() => undefined);
    job.updateStep(startStep.index, startStep);
    await persistRun(job.record).catch(() => {});

    const steps = await planSteps(instruction);

    const planStep = job.addStep({
      type: "agent-plan",
      description: `Planned ${steps.length} step${steps.length === 1 ? "" : "s"}:\n${steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}`,
      status: "done",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      url: page.url(),
    });
    job.updateStep(planStep.index, planStep);
    await persistRun(job.record).catch(() => {});

    let succeeded = 0;
    let failed = 0;

    for (const step of steps) {
      if (job.stopRequested) break;
      const startedAt = new Date().toISOString();
      // Built up as the step progresses so it's attached to whichever
      // outcome (success or failure) actually happens below — candidates is
      // the only part that might be genuinely empty (no known actions
      // found at all, before the picker LLM even runs).
      const decision: NonNullable<
        Parameters<typeof job.addStep>[0]["agentDecision"]
      > = { plannedStep: step, candidates: [], pickedIndex: null, reasoning: "" };

      try {
        const candidates = await searchActions(skillId, step, CANDIDATES_PER_STEP);
        decision.candidates = candidates.map((c) => ({
          description: c.description,
          similarity: c.similarity,
          status: c.status,
          role: c.role,
        }));
        if (candidates.length === 0) {
          throw new Error("No known actions found in the action graph for this step");
        }

        const { chosen, index, reasoning } = await chooseCandidate(step, candidates);
        decision.pickedIndex = index;
        decision.reasoning = reasoning;
        if (!chosen) {
          throw new Error("No cataloged action confidently matched this step");
        }

        if (page.url() !== chosen.fromUrl) {
          await page.goto(chosen.fromUrl, { waitUntil: "domcontentloaded" });
        }
        const resolved = resolveLocator(page, chosen.locator);
        const visible = await resolved.isVisible().catch(() => false);
        if (!visible) throw new Error(`Matched action "${chosen.description}" but it isn't visible on the page`);

        const box = await resolved.boundingBox().catch(() => null);
        if (box) {
          await glideCursorTo(page, cdp, box.x + box.width / 2, box.y + box.height / 2);
          triggerClickRipple(cdp, box.x + box.width / 2, box.y + box.height / 2);
        }
        await clickResilient(resolved, 5000);
        await page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
        await settleAfterAction(page);
        succeeded++;

        const resultStep = job.addStep({
          type: "agent-step",
          description: `✓ ${step} — clicked "${chosen.description}" (similarity ${chosen.similarity.toFixed(2)})`,
          status: "done",
          startedAt,
          finishedAt: new Date().toISOString(),
          url: page.url(),
          locator: chosen.locator,
          agentDecision: decision,
        });
        resultStep.screenshot = await screenshotStep(page, job.record.id, resultStep.index).catch(() => undefined);
        job.updateStep(resultStep.index, resultStep);
      } catch (err) {
        failed++;
        const message = err instanceof Error ? err.message : String(err);
        const resultStep = job.addStep({
          type: "agent-step",
          description: `✗ ${step}: ${message}`,
          status: "error",
          error: message,
          startedAt,
          finishedAt: new Date().toISOString(),
          url: page.url(),
          agentDecision: decision,
        });
        resultStep.screenshot = await screenshotStep(page, job.record.id, resultStep.index).catch(() => undefined);
        job.updateStep(resultStep.index, resultStep);
      }
      await persistRun(job.record).catch(() => {});
    }

    const summaryStep = job.addStep({
      type: "manual-finish",
      description: `Agent finished — ${succeeded} step${succeeded === 1 ? "" : "s"} succeeded, ${failed} failed`,
      status: "done",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      url: page.url(),
    });
    summaryStep.screenshot = await screenshotStep(page, job.record.id, summaryStep.index).catch(() => undefined);
    job.updateStep(summaryStep.index, summaryStep);
    await persistRun(job.record).catch(() => {});

    // Same philosophy as crawlTask/validateTask: individual step failures
    // are expected, recorded output — only a genuine crash or user-requested
    // stop makes the run itself an error.
    job.record.status = job.stopRequested ? "error" : "completed";
    job.record.error = job.stopRequested ? "Stopped by user" : undefined;
  } catch (err) {
    job.record.status = "error";
    job.record.error = job.stopRequested
      ? "Stopped by user"
      : err instanceof Error
        ? err.message
        : String(err);
  } finally {
    job.record.finishedAt = new Date().toISOString();
    await finalizeRunSession(job, session);
  }
}
