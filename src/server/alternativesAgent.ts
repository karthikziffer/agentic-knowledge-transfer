import { StateGraph, Annotation, START, END } from "@langchain/langgraph";
import { SystemMessage, HumanMessage, type MessageContent } from "@langchain/core/messages";
import { prisma } from "./db";
import { getRunFromDb, getSkillsMd, saveAlternativeSuggestions } from "./runs";
import { launchExplorationBrowser } from "./automation";
import { uploadArtifact } from "./artifacts";
import { replayPrefixUnattended } from "./variation";
import { listInteractiveElements, type AlternativeTarget } from "./variationDiscovery";
import { checkOllamaConnection, getOllamaUrl } from "./ollama";
import { getFlowSummaryModel, invokeChatModel } from "./flowSummary";
import { getPrompt, renderPrompt } from "./promptLibrary";
import type { AlternativeSuggestion, AlternativesProgress, RunRecord, StepResult } from "./types";

type ProgressReporter = (progress: AlternativesProgress) => void;

// How many real alternatives to surface — a handful of genuinely distinct
// options reads as useful; a long list reads as noise (and just means more
// unread suggestion cards, not better ones).
const MAX_SUGGESTIONS = 6;

function messageContentToText(content: MessageContent): string {
  if (typeof content === "string") return content;
  return content
    .map((part) => (typeof part === "string" ? part : "text" in part ? (part.text as string) : ""))
    .join(" ");
}

const AlternativesState = Annotation.Root({
  runId: Annotation<string>(),
  stepIndex: Annotation<number>(),
  run: Annotation<RunRecord | null>({ reducer: (_prev, next) => next, default: () => null }),
  targetStep: Annotation<StepResult | null>({ reducer: (_prev, next) => next, default: () => null }),
  context: Annotation<string>({ reducer: (_prev, next) => next, default: () => "" }),
  elements: Annotation<AlternativeTarget[]>({ reducer: (_prev, next) => next, default: () => [] }),
  pageUnderstanding: Annotation<string>({ reducer: (_prev, next) => next, default: () => "" }),
  explorationScreenshot: Annotation<string | undefined>({ reducer: (_prev, next) => next, default: () => undefined }),
  suggestions: Annotation<AlternativeSuggestion[]>({ reducer: (_prev, next) => next, default: () => [] }),
  error: Annotation<string | undefined>({ reducer: (_prev, next) => next, default: () => undefined }),
  onProgress: Annotation<ProgressReporter | undefined>({ reducer: (_prev, next) => next, default: () => undefined }),
});

type AlternativesStateType = typeof AlternativesState.State;

// Agent 1 — reads the run's skills.md (what this flow is actually for), so
// the decision agent has a notion of purpose rather than just raw DOM.
async function loadContextNode(
  state: AlternativesStateType,
): Promise<Partial<AlternativesStateType>> {
  state.onProgress?.({ phase: "loading-context" });
  const run = await getRunFromDb(state.runId);
  const targetStep = run?.steps.find((s) => s.index === state.stepIndex) ?? null;
  if (
    !run ||
    !targetStep ||
    !targetStep.locator ||
    (targetStep.type !== "manual-click" && targetStep.type !== "replay-click")
  ) {
    return { error: "This step has no recorded click target to find alternatives for" };
  }

  const [skillsMd, promptRow] = await Promise.all([
    getSkillsMd(state.runId),
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

  return { run, targetStep, context };
}

// Agent 2 — actually looks at the live page: replays the source run up to
// the target step in a throwaway, DB-free browser (launchExplorationBrowser
// never touches Postgres or produces a Run row — this isn't a recording),
// enumerates every real visible clickable element (listInteractiveElements,
// not a sibling walk), and writes one plain-language paragraph describing
// the page from a screenshot — genuine "understanding," grounded in what's
// actually on screen, without risking the model rewriting/hallucinating
// individual element locators (only the decision agent below ever maps
// text back to a specific real element, and only by index).
async function explorePageNode(
  state: AlternativesStateType,
): Promise<Partial<AlternativesStateType>> {
  if (state.error || !state.run || !state.targetStep) return {};
  state.onProgress?.({ phase: "exploring-page" });

  let session: Awaited<ReturnType<typeof launchExplorationBrowser>> | undefined;
  try {
    session = await launchExplorationBrowser(state.run.startUrl);
    const prefix = await replayPrefixUnattended(
      session.page,
      session.cdp,
      state.run.steps,
      state.stepIndex,
    );
    if (!prefix.ok) {
      return { error: `Couldn't reach step ${state.stepIndex + 1}: ${prefix.reason}` };
    }

    const elements = await listInteractiveElements(session.cdp);
    if (elements.length === 0) {
      return { error: "Couldn't find any clickable elements on this page" };
    }

    let pageUnderstanding = "";
    let explorationScreenshot: string | undefined;
    const screenshot = await session.page.screenshot({ type: "jpeg", quality: 70 }).catch(() => null);
    if (screenshot) {
      // Persisted regardless of whether the vision call below succeeds —
      // this is the one artifact from the whole alternatives pipeline worth
      // keeping (launchExplorationBrowser is otherwise deliberately
      // artifact-free), so a suggestion can later be checked against what
      // the page actually looked like when it was generated.
      const fileName = `alt-step-${state.stepIndex}-exploration.jpg`;
      explorationScreenshot = await uploadArtifact(state.runId, fileName, "image/jpeg", screenshot)
        .then(() => fileName)
        .catch(() => undefined);

      try {
        const list = elements.map((e, i) => `${i}. ${e.description}`).join("\n");
        const response = await invokeChatModel([
          new SystemMessage(getPrompt("alternativesAgent.explorePage.system")),
          new HumanMessage({
            content: [
              {
                type: "text",
                text: renderPrompt("alternativesAgent.explorePage.human", { list }),
              },
              {
                type: "image_url",
                image_url: { url: `data:image/jpeg;base64,${screenshot.toString("base64")}` },
              },
            ],
          }),
        ]);
        pageUnderstanding = messageContentToText(response.content).trim();
      } catch {
        // Non-fatal — decideAlternativesNode still has the full real
        // element list without this extra grounding paragraph.
      }
    }

    return { elements, pageUnderstanding, explorationScreenshot };
  } finally {
    await session?.browser.close().catch(() => {});
  }
}

// Agent 3 — decides which of the real elements agent 2 found are genuinely
// distinct, meaningful alternatives to the recorded step, grounded in what
// agent 1 learned about the flow's purpose. Can only ever point at an
// index into the real list already gathered — never invents a locator.
async function decideAlternativesNode(
  state: AlternativesStateType,
): Promise<Partial<AlternativesStateType>> {
  if (state.error || !state.targetStep || state.elements.length === 0) return {};
  state.onProgress?.({ phase: "deciding-alternatives" });

  const list = state.elements.map((e, i) => `${i}. ${e.description}`).join("\n");
  const prompt = [
    state.context,
    state.pageUnderstanding
      ? renderPrompt("alternativesAgent.decideAlternatives.pageUnderstandingLine", {
          pageUnderstanding: state.pageUnderstanding,
        })
      : null,
    renderPrompt("alternativesAgent.decideAlternatives.targetClickedLine", {
      targetDescription: state.targetStep.description ?? state.targetStep.type,
    }),
    renderPrompt("alternativesAgent.decideAlternatives.elementsLine", { list }),
    renderPrompt("alternativesAgent.decideAlternatives.instructionsLine", {
      maxSuggestions: String(MAX_SUGGESTIONS),
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
      if (!Number.isInteger(idx) || idx < 0 || idx >= state.elements.length) continue;
      const el = state.elements[idx];
      const key = el.locator.cssSelector || `${el.locator.strategy}:${el.locator.value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      suggestions.push({ description: el.description, locator: el.locator, reasoning: match[2].trim() });
      if (suggestions.length >= MAX_SUGGESTIONS) break;
    }
    return { suggestions };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

function buildGraph() {
  return new StateGraph(AlternativesState)
    .addNode("loadContext", loadContextNode)
    .addNode("explorePage", explorePageNode)
    .addNode("decideAlternatives", decideAlternativesNode)
    .addEdge(START, "loadContext")
    .addEdge("loadContext", "explorePage")
    .addEdge("explorePage", "decideAlternatives")
    .addEdge("decideAlternatives", END)
    .compile();
}

let graph: ReturnType<typeof buildGraph> | undefined;
function getGraph() {
  return (graph ??= buildGraph());
}

export async function generateAlternativeSuggestions(
  runId: string,
  stepIndex: number,
  onProgress?: ProgressReporter,
): Promise<{ suggestions: AlternativeSuggestion[]; explorationScreenshot?: string }> {
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

  const result = await getGraph().invoke({ runId, stepIndex, onProgress });
  if (result.error) {
    throw new Error(result.error);
  }
  if (result.suggestions.length === 0) {
    throw new Error("Couldn't find any meaningful alternatives on this page");
  }

  await saveAlternativeSuggestions(runId, stepIndex, result.suggestions, modelName, result.explorationScreenshot);
  return { suggestions: result.suggestions, explorationScreenshot: result.explorationScreenshot };
}
