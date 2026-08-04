import type { CDPSession, Page } from "playwright";
import { SystemMessage, HumanMessage, type MessageContent } from "@langchain/core/messages";
import { prisma } from "./db";
import { getRunFromDb, getSkillsMd, saveAlternativePlans } from "./runs";
import { launchExplorationBrowser } from "./automation";
import { uploadArtifact } from "./artifacts";
import { replayPrefixUnattended, clickResilient } from "./variation";
import { resolveLocator } from "./locatorReplay";
import { listInteractiveElements } from "./variationDiscovery";
import { checkOllamaConnection, getOllamaUrl } from "./ollama";
import { getFlowSummaryModel, invokeChatModel } from "./flowSummary";
import { getPrompt, renderPrompt } from "./promptLibrary";
import type { AlternativePlan, AlternativeSuggestion, AlternativesProgress, CrawlDepthGoal } from "./types";

type ProgressReporter = (progress: AlternativesProgress) => void;

// How many candidate next-actions to actually try expanding from any one
// visited page — independent of MAX_PLAN_ACTIONS below, this keeps any
// single page from dominating the whole exploration budget by itself.
const MAX_HOPS_PER_NODE = 4;

// Hard ceiling on total pages visited across one whole generateAlternativePlans
// call, regardless of how generous the depth goals are. A multi-hop search
// branches fast (up to MAX_HOPS_PER_NODE candidates tried at every node, at
// every depth), so without this a large depth+goal combination could launch
// far more browser navigations and LLM calls than intended — same "bounded
// but generous" philosophy as actionGraph.ts's crawl budgets.
const MAX_PLAN_ACTIONS = 25;

function messageContentToText(content: MessageContent): string {
  if (typeof content === "string") return content;
  return content
    .map((part) => (typeof part === "string" ? part : "text" in part ? (part.text as string) : ""))
    .join(" ");
}

interface PlanContext {
  runId: string;
  stepIndex: number;
  context: string;
  targetDescription: string;
}

// One page's worth of "what could you click here, and why" — the same two
// LLM calls the old single-shot pipeline made once (a vision "page
// understanding" pass, then a text decision pass over the real element
// list), now reusable per node visited while planning multi-hop paths.
// Never invents a locator: every returned suggestion traces back to
// something listInteractiveElements actually found on the live page.
async function decideAtCurrentPage(
  page: Page,
  cdp: CDPSession,
  planCtx: PlanContext,
  // Set only for the root node — the one screenshot worth persisting as the
  // plan graph's root, everything else is just an intermediate hop.
  captureScreenshotAs?: string,
): Promise<{ suggestions: AlternativeSuggestion[]; screenshot?: string }> {
  const elements = await listInteractiveElements(cdp);
  if (elements.length === 0) return { suggestions: [] };

  let pageUnderstanding = "";
  let screenshot: string | undefined;
  const shot = await page.screenshot({ type: "jpeg", quality: 70 }).catch(() => null);
  if (shot) {
    if (captureScreenshotAs) {
      screenshot = await uploadArtifact(planCtx.runId, captureScreenshotAs, "image/jpeg", shot)
        .then(() => captureScreenshotAs)
        .catch(() => undefined);
    }

    try {
      const list = elements.map((e, i) => `${i}. ${e.description}`).join("\n");
      const response = await invokeChatModel([
        new SystemMessage(getPrompt("alternativesAgent.explorePage.system")),
        new HumanMessage({
          content: [
            { type: "text", text: renderPrompt("alternativesAgent.explorePage.human", { list }) },
            { type: "image_url", image_url: { url: `data:image/jpeg;base64,${shot.toString("base64")}` } },
          ],
        }),
      ]);
      pageUnderstanding = messageContentToText(response.content).trim();
    } catch {
      // Non-fatal — the decide call below still has the full real element
      // list without this extra grounding paragraph.
    }
  }

  const list = elements.map((e, i) => `${i}. ${e.description}`).join("\n");
  const prompt = [
    planCtx.context,
    pageUnderstanding
      ? renderPrompt("alternativesAgent.decideAlternatives.pageUnderstandingLine", { pageUnderstanding })
      : null,
    renderPrompt("alternativesAgent.decideAlternatives.targetClickedLine", {
      targetDescription: planCtx.targetDescription,
    }),
    renderPrompt("alternativesAgent.decideAlternatives.elementsLine", { list }),
    renderPrompt("alternativesAgent.decideAlternatives.instructionsLine", {
      maxSuggestions: String(MAX_HOPS_PER_NODE),
    }),
    getPrompt("alternativesAgent.decideAlternatives.formatLine"),
  ]
    .filter(Boolean)
    .join("\n\n");

  try {
    const response = await invokeChatModel([
      new SystemMessage(getPrompt("alternativesAgent.decideAlternatives.system")),
      new HumanMessage(prompt),
    ]);
    const text = messageContentToText(response.content);

    const suggestions: AlternativeSuggestion[] = [];
    const seen = new Set<string>();
    for (const line of text.split("\n")) {
      const match = line.match(/^\s*(\d+)\s*[:.\-]\s*(.+)$/);
      if (!match) continue;
      const idx = Number(match[1]);
      if (!Number.isInteger(idx) || idx < 0 || idx >= elements.length) continue;
      const el = elements[idx];
      const key = el.locator.cssSelector || `${el.locator.strategy}:${el.locator.value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      suggestions.push({ description: el.description, locator: el.locator, reasoning: match[2].trim() });
      if (suggestions.length >= MAX_HOPS_PER_NODE) break;
    }
    return { suggestions, screenshot };
  } catch {
    return { suggestions: [], screenshot };
  }
}

// Plans a set of genuinely distinct, multi-hop alternative paths starting
// from a recorded step's page — a depth-D goal means "keep exploring until
// `goal` plans that are exactly D real clicks long, each ending on a
// different real page, are found." A depth-1 plan is exactly what the old
// single-shot "Find alternatives" used to produce (one click instead of the
// recorded one); deeper goals chain further real clicks on from there.
//
// Depth-first: from the current node, ask the same "genuinely distinct,
// meaningful alternatives" question decideAtCurrentPage always asks, click
// each candidate in turn, and either count it as a new plan (if its depth
// has a goal and its destination isn't already claimed by another plan at
// that same depth — "same final destination = duplicate," never fuzzy) or
// just use it as a stepping stone toward a deeper goal, then return to this
// node's page (an explicit page.goto, never browser history) to try the
// next sibling. Bounded overall by MAX_PLAN_ACTIONS regardless of how the
// goals are shaped, since branching-and-chaining can grow fast.
export async function generateAlternativePlans(
  runId: string,
  stepIndex: number,
  depthGoalsInput: CrawlDepthGoal[],
  onProgress?: ProgressReporter,
): Promise<{ plans: AlternativePlan[]; rootScreenshot?: string }> {
  onProgress?.({ phase: "loading-context" });

  const modelName = getFlowSummaryModel();
  const status = await checkOllamaConnection();
  if (!status.connected) {
    throw new Error(`Ollama isn't reachable at ${status.baseUrl || getOllamaUrl()} — is it running?`);
  }
  if (!status.models.some((m) => m.name === modelName)) {
    throw new Error(
      `Model "${modelName}" isn't pulled on this Ollama server — run \`ollama pull ${modelName}\` (or set FLOW_SUMMARY_MODEL to a model you already have).`,
    );
  }

  // No explicit goals submitted still needs to do *something* useful —
  // falls back to "up to MAX_HOPS_PER_NODE distinct single-click
  // alternatives," the same shape the old single-shot pipeline always
  // produced.
  const depthGoals = depthGoalsInput.length > 0 ? depthGoalsInput : [{ depth: 1, goal: MAX_HOPS_PER_NODE }];
  const maxDepth = Math.max(...depthGoals.map((g) => g.depth));
  const goalByDepth = new Map(depthGoals.map((g) => [g.depth, g.goal]));

  const run = await getRunFromDb(runId);
  const targetStep = run?.steps.find((s) => s.index === stepIndex);
  if (
    !run ||
    !targetStep ||
    !targetStep.locator ||
    (targetStep.type !== "manual-click" && targetStep.type !== "replay-click")
  ) {
    throw new Error("This step has no recorded click target to plan alternatives for");
  }

  const [skillsMd, promptRow] = await Promise.all([
    getSkillsMd(runId),
    prisma.prompt.findUnique({
      where: { id: run.promptId },
      select: { skill: { select: { name: true } } },
    }),
  ]);
  const context = [
    `Skill: ${promptRow?.skill.name ?? "Unnamed skill"}`,
    `Goal: ${run.promptText}`,
    skillsMd ? `Flow spec (skills.md):\n${skillsMd}` : null,
  ]
    .filter(Boolean)
    .join("\n\n");

  const planCtx: PlanContext = {
    runId,
    stepIndex,
    context,
    targetDescription: targetStep.description ?? targetStep.type,
  };

  const plans: AlternativePlan[] = [];
  const seenAtDepth = new Map<number, Set<string>>();
  const foundAtDepth = new Map<number, number>();
  let visited = 0;
  let rootScreenshot: string | undefined;

  function allGoalsMet(): boolean {
    for (const [depth, goal] of goalByDepth) {
      if ((foundAtDepth.get(depth) ?? 0) < goal) return false;
    }
    return true;
  }

  let session: Awaited<ReturnType<typeof launchExplorationBrowser>> | undefined;
  try {
    session = await launchExplorationBrowser(run.startUrl);
    const { page, cdp } = session;
    const prefix = await replayPrefixUnattended(page, cdp, run.steps, stepIndex);
    if (!prefix.ok) {
      throw new Error(`Couldn't reach step ${stepIndex + 1}: ${prefix.reason}`);
    }
    const rootUrl = page.url();

    async function explore(fromUrl: string, hopsSoFar: AlternativeSuggestion[], depth: number): Promise<void> {
      if (depth >= maxDepth || visited >= MAX_PLAN_ACTIONS || allGoalsMet()) return;

      if (page.url() !== fromUrl) {
        await page.goto(fromUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
      }
      visited++;
      onProgress?.({ phase: "exploring", visited, plansFound: plans.length });

      const isRoot = depth === 0;
      const { suggestions, screenshot } = await decideAtCurrentPage(
        page,
        cdp,
        planCtx,
        isRoot ? `alt-plan-step-${stepIndex}-root.jpg` : undefined,
      );
      if (isRoot) rootScreenshot = screenshot;

      for (const candidate of suggestions) {
        if (visited >= MAX_PLAN_ACTIONS || allGoalsMet()) break;

        const locator = resolveLocator(page, candidate.locator);
        const visible = await locator.isVisible().catch(() => false);
        if (!visible) continue;

        try {
          await clickResilient(locator, 5000);
          await page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
          const destUrl = page.url();
          if (destUrl === fromUrl) {
            // Didn't actually go anywhere (a modal, a no-op toggle) —
            // not a useful plan-ending point, nothing further to chain
            // from here either.
            continue;
          }

          const newHops = [...hopsSoFar, candidate];
          const newDepth = depth + 1;
          const goal = goalByDepth.get(newDepth);
          if (goal !== undefined) {
            const seen = seenAtDepth.get(newDepth) ?? new Set<string>();
            seenAtDepth.set(newDepth, seen);
            const found = foundAtDepth.get(newDepth) ?? 0;
            if (!seen.has(destUrl) && found < goal) {
              seen.add(destUrl);
              foundAtDepth.set(newDepth, found + 1);
              const finalDescription = await page.title().catch(() => destUrl);
              plans.push({ steps: newHops, finalUrl: destUrl, finalDescription });
              onProgress?.({ phase: "exploring", visited, plansFound: plans.length });
            }
          }

          // Keep exploring deeper from here regardless of whether *this*
          // candidate's plan was actually counted — a duplicate destination
          // can still be a useful stepping stone toward a deeper goal.
          if (newDepth < maxDepth && !allGoalsMet()) {
            await explore(destUrl, newHops, newDepth);
          }
        } catch {
          // Couldn't actually click it — skip, nothing to chain from here.
        } finally {
          if (page.url() !== fromUrl) {
            await page.goto(fromUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
          }
        }
      }
    }

    await explore(rootUrl, [], 0);
  } finally {
    await session?.browser.close().catch(() => {});
  }

  if (plans.length === 0) {
    throw new Error("Couldn't find any meaningful alternative plans on this page");
  }

  await saveAlternativePlans(runId, stepIndex, plans, modelName, depthGoals, rootScreenshot);
  return { plans, rootScreenshot };
}
