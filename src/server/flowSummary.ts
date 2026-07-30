import { text as streamToText, buffer as streamToBuffer } from "stream/consumers";
import { diffLines } from "diff";
import { StateGraph, Annotation, START, END } from "@langchain/langgraph";
import { ChatOllama } from "@langchain/ollama";
import { HumanMessage, SystemMessage, type MessageContent } from "@langchain/core/messages";
import { prisma } from "./db";
import { getRunFromDb } from "./runs";
import { getArtifactStream } from "./artifacts";
import { checkOllamaConnection, getOllamaUrl } from "./ollama";
import { getPrompt, renderPrompt } from "./promptLibrary";
import type { FlowSummaryProgress, RunFlowSummary, RunRecord, StepResult } from "./types";

type ProgressReporter = (progress: FlowSummaryProgress) => void;

const DEFAULT_MODEL = "qwen2.5vl:latest";
// Caps concurrent per-step vision calls — Ollama is running on the host,
// likely on a single GPU, so uncapped fan-out would just queue up anyway
// and risks starving the request.
const CAPTION_CONCURRENCY = 2;
const MAX_DIFF_SAMPLE_CHARS = 800;

export function getFlowSummaryModel(): string {
  return process.env.FLOW_SUMMARY_MODEL || DEFAULT_MODEL;
}

// Lazy singleton, same reasoning as the Prisma/MinIO clients elsewhere —
// constructing this at `next build` time would touch env vars that don't
// exist yet.
const globalKey = Symbol.for("skill-builder.flowSummaryChat");
type GlobalWithChat = typeof globalThis & { [globalKey]?: ChatOllama };

export function getChatModel(): ChatOllama {
  const g = globalThis as GlobalWithChat;
  return (g[globalKey] ??= new ChatOllama({ model: getFlowSummaryModel(), baseUrl: getOllamaUrl() }));
}

// How long to wait for one LLM call before giving up — the same problem
// embedText() (embeddings.ts) solves for embedding calls, applied here too.
// Without this, a hung/overloaded Ollama request blocks whatever's waiting
// on it indefinitely: a caption, a page-understanding description, an
// alternative-suggestion decision, a drift-assist match — every caller of
// this across flowSummary.ts, alternativesAgent.ts, and driftAssist.ts had
// zero timeout protection until now, so "Stop" on the run containing it
// could set the flag and close the browser but never actually unblock it.
// Vision calls carry an image payload and can legitimately take longer than
// a plain text embedding, hence the longer ceiling than embedText's 30s.
const CHAT_TIMEOUT_MS = 90_000;

export async function invokeChatModel(
  messages: Parameters<ChatOllama["invoke"]>[0],
): ReturnType<ChatOllama["invoke"]> {
  return Promise.race([
    getChatModel().invoke(messages),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`LLM call timed out after ${CHAT_TIMEOUT_MS}ms`)), CHAT_TIMEOUT_MS),
    ),
  ]);
}

function messageContentToText(content: MessageContent): string {
  if (typeof content === "string") return content;
  return content
    .map((part) => (typeof part === "string" ? part : "text" in part ? (part.text as string) : ""))
    .join(" ");
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function loadArtifactText(runId: string, file?: string): Promise<string> {
  if (!file) return "";
  try {
    return await streamToText(await getArtifactStream(runId, file));
  } catch {
    return "";
  }
}

// Condenses a before/after DOM snapshot pair into a short, LLM-friendly
// description — full HTML would blow the prompt budget for no benefit, the
// model only needs a sense of what changed, not the literal markup.
function summarizeDomDiff(before: string, after: string): string {
  if (!before && !after) return "";
  const changes = diffLines(before, after);
  let added = 0;
  let removed = 0;
  const sampleLines: string[] = [];
  let sampleChars = 0;
  for (const part of changes) {
    if (!part.added && !part.removed) continue;
    const lines = part.value.replace(/\n$/, "").split("\n");
    if (part.added) added += lines.length;
    if (part.removed) removed += lines.length;
    for (const line of lines) {
      if (sampleChars > MAX_DIFF_SAMPLE_CHARS) break;
      const rendered = `${part.added ? "+" : "-"} ${line.trim().slice(0, 160)}`;
      sampleLines.push(rendered);
      sampleChars += rendered.length;
    }
  }
  if (added === 0 && removed === 0) return "";
  return `Page structure changed (+${added}/-${removed} lines). Sample:\n${sampleLines.slice(0, 20).join("\n")}`;
}

interface StepCaption {
  index: number;
  caption: string;
  // What the model reports observing in the screenshot and why it
  // interpreted the step that way — surfaced in the UI as "What the model
  // saw" so the caption above isn't a black box.
  reasoning: string;
}

const NO_SCREENSHOT_REASONING =
  "No screenshot was captured for this step — captioned from the recorded step type only.";

// Lenient "Label: text" parsing, same philosophy as parseSynthesisResponse
// below — a small local model's instruction-following is weaker than a
// hosted one, so a strict format (e.g. JSON) is more likely to fail than a
// couple of regexes over plain text.
function parseStepResponse(raw: string, fallback: string): { caption: string; reasoning: string } {
  const reasoningMatch = raw.match(/Reasoning:\s*([\s\S]*?)(?=\n\s*Caption:|$)/i);
  const captionMatch = raw.match(/Caption:\s*([\s\S]*)$/i);
  const reasoning = reasoningMatch?.[1]?.trim() ?? "";
  const caption = captionMatch?.[1]?.trim() || (!reasoningMatch ? raw.trim() : "") || fallback;
  return { caption, reasoning };
}

// Gives the model a concrete anchor instead of purely guessing from
// pixels — the locator was computed live against the real DOM at recording
// time (automation.ts), so it's more reliable than anything derivable from
// a screenshot after the fact.
function describeLocatorForPrompt(step: StepResult): string | null {
  const { locator } = step;
  if (locator?.strategy === "role") return `Recorded target: ${locator.role} "${locator.value}"`;
  if (locator?.strategy === "testId") return `Recorded target: element with test id "${locator.value}"`;
  if (locator?.strategy === "placeholder") return `Recorded target: field with placeholder "${locator.value}"`;
  if (locator?.strategy === "text") return `Recorded target: element with text "${locator.value}"`;
  if (step.x !== undefined && step.y !== undefined) {
    return `Recorded click position: (${step.x}, ${step.y})`;
  }
  return null;
}

async function captionStep(runId: string, step: StepResult): Promise<StepCaption> {
  const fallback = step.description ?? step.type;
  if (!step.screenshot) {
    return { index: step.index, caption: fallback, reasoning: NO_SCREENSHOT_REASONING };
  }

  try {
    const [imgBuffer, beforeText, afterText] = await Promise.all([
      getArtifactStream(runId, step.screenshot).then(streamToBuffer),
      loadArtifactText(runId, step.domBefore),
      loadArtifactText(runId, step.domAfter),
    ]);
    const domDiffSummary = summarizeDomDiff(beforeText, afterText);

    const promptText = [
      renderPrompt("flowSummary.captionStep.stepTypeLine", { stepType: step.type }),
      step.description
        ? renderPrompt("flowSummary.captionStep.descriptionLine", { description: step.description })
        : null,
      describeLocatorForPrompt(step),
      step.url ? renderPrompt("flowSummary.captionStep.urlLine", { url: step.url }) : null,
      domDiffSummary || null,
      getPrompt("flowSummary.captionStep.instructions"),
    ]
      .filter(Boolean)
      .join("\n");

    const response = await invokeChatModel([
      new SystemMessage(getPrompt("flowSummary.captionStep.system")),
      // @langchain/ollama only understands the (TS-deprecated but
      // functional) `image_url` content-block shape — see
      // node_modules/@langchain/ollama/dist/utils.js's
      // convertHumanGenericMessagesToOllama.
      new HumanMessage({
        content: [
          { type: "text", text: promptText },
          { type: "image_url", image_url: { url: `data:image/jpeg;base64,${imgBuffer.toString("base64")}` } },
        ],
      }),
    ]);
    const { caption, reasoning } = parseStepResponse(messageContentToText(response.content), fallback);
    return { index: step.index, caption, reasoning };
  } catch {
    return {
      index: step.index,
      caption: fallback,
      reasoning: "The model call for this step failed — showing the recorded description instead.",
    };
  }
}

function formatDuration(startedAt?: string, finishedAt?: string): string {
  if (!startedAt || !finishedAt) return "unknown";
  const ms = new Date(finishedAt).getTime() - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "unknown";
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  return `${Math.floor(totalSeconds / 60)}m ${(totalSeconds % 60).toString().padStart(2, "0")}s`;
}

function parseSynthesisResponse(raw: string): { narrative: string; keySteps: string[]; outcome: string } {
  const summaryMatch = raw.match(/##\s*Summary\s*\n([\s\S]*?)(?=\n##|$)/i);
  const keyStepsMatch = raw.match(/##\s*Key steps\s*\n([\s\S]*?)(?=\n##|$)/i);
  const outcomeMatch = raw.match(/##\s*Outcome\s*\n([\s\S]*?)(?=\n##|$)/i);

  const narrative = summaryMatch?.[1]?.trim() || raw.trim();
  const outcome = outcomeMatch?.[1]?.trim() || "";
  const keySteps = keyStepsMatch?.[1]
    ? keyStepsMatch[1]
        .split("\n")
        .map((line) => line.replace(/^[-*]\s*/, "").trim())
        .filter(Boolean)
    : [];

  return { narrative, keySteps, outcome };
}

const FlowSummaryState = Annotation.Root({
  runId: Annotation<string>(),
  // Not graph data, just a per-call hook nodes report through — read-only
  // to every node, never reduced/merged.
  onProgress: Annotation<ProgressReporter | undefined>({
    reducer: (_prev, next) => next,
    default: () => undefined,
  }),
  run: Annotation<RunRecord | null>({ reducer: (_prev, next) => next, default: () => null }),
  skillName: Annotation<string>({ reducer: (_prev, next) => next, default: () => "" }),
  startUrl: Annotation<string>({ reducer: (_prev, next) => next, default: () => "" }),
  promptText: Annotation<string>({ reducer: (_prev, next) => next, default: () => "" }),
  stepCaptions: Annotation<StepCaption[]>({ reducer: (_prev, next) => next, default: () => [] }),
  narrative: Annotation<string>({ reducer: (_prev, next) => next, default: () => "" }),
  keySteps: Annotation<string[]>({ reducer: (_prev, next) => next, default: () => [] }),
  outcome: Annotation<string>({ reducer: (_prev, next) => next, default: () => "" }),
  error: Annotation<string | undefined>({ reducer: (_prev, next) => next, default: () => undefined }),
});

type FlowSummaryStateType = typeof FlowSummaryState.State;

async function loadRunNode(state: FlowSummaryStateType): Promise<Partial<FlowSummaryStateType>> {
  state.onProgress?.({ phase: "loading" });
  const run = await getRunFromDb(state.runId);
  if (!run || run.steps.length === 0) {
    return { error: "This run has no recorded steps to summarize." };
  }
  const promptRow = await prisma.prompt.findUnique({
    where: { id: run.promptId },
    select: { skill: { select: { name: true } } },
  });
  return {
    run,
    skillName: promptRow?.skill.name ?? "",
    startUrl: run.startUrl,
    promptText: run.promptText,
  };
}

async function captionStepsNode(state: FlowSummaryStateType): Promise<Partial<FlowSummaryStateType>> {
  if (state.error || !state.run) return {};
  const total = state.run.steps.length;
  let completed = 0;
  state.onProgress?.({ phase: "captioning", completed, total });
  const captions = await mapWithConcurrency(state.run.steps, CAPTION_CONCURRENCY, async (step) => {
    const caption = await captionStep(state.runId, step);
    completed += 1;
    state.onProgress?.({ phase: "captioning", completed, total });
    return caption;
  });
  return { stepCaptions: captions };
}

async function synthesizeNode(state: FlowSummaryStateType): Promise<Partial<FlowSummaryStateType>> {
  if (state.error || !state.run) return {};
  state.onProgress?.({ phase: "synthesizing" });
  const run = state.run;
  const stepsList = state.stepCaptions
    .slice()
    .sort((a, b) => a.index - b.index)
    .map((c) => `${c.index + 1}. ${c.caption}`)
    .join("\n");

  const prompt = renderPrompt("flowSummary.synthesize.human", {
    skillName: state.skillName || "Unnamed skill",
    startUrl: state.startUrl,
    promptText: state.promptText,
    statusLine: `${run.status}${run.error ? ` (${run.error})` : ""}`,
    duration: formatDuration(run.startedAt, run.finishedAt),
    stepsList: stepsList || "(no steps captured)",
  });

  const response = await invokeChatModel([
    new SystemMessage(getPrompt("flowSummary.synthesize.system")),
    new HumanMessage(prompt),
  ]);
  return parseSynthesisResponse(messageContentToText(response.content));
}

function buildGraph() {
  return new StateGraph(FlowSummaryState)
    .addNode("loadRun", loadRunNode)
    .addNode("captionSteps", captionStepsNode)
    .addNode("synthesize", synthesizeNode)
    .addEdge(START, "loadRun")
    .addEdge("loadRun", "captionSteps")
    .addEdge("captionSteps", "synthesize")
    .addEdge("synthesize", END)
    .compile();
}

let graph: ReturnType<typeof buildGraph> | undefined;
function getGraph() {
  return (graph ??= buildGraph());
}

export async function generateFlowSummary(
  runId: string,
  onProgress?: ProgressReporter,
): Promise<RunFlowSummary> {
  const modelName = getFlowSummaryModel();
  const status = await checkOllamaConnection();
  if (!status.connected) {
    throw new Error(`Ollama isn't reachable at ${status.baseUrl} — is it running?`);
  }
  if (!status.models.some((m) => m.name === modelName)) {
    throw new Error(
      `Model "${modelName}" isn't pulled on this Ollama server — run \`ollama pull ${modelName}\` (or set FLOW_SUMMARY_MODEL to a model you already have).`,
    );
  }

  const result = await getGraph().invoke({ runId, onProgress });
  if (result.error) {
    throw new Error(result.error);
  }
  onProgress?.({ phase: "done" });

  return {
    narrative: result.narrative || "No summary could be generated.",
    keySteps: result.keySteps,
    outcome: result.outcome,
    stepCaptions: result.stepCaptions.slice().sort((a, b) => a.index - b.index),
    model: modelName,
    generatedAt: new Date().toISOString(),
  };
}
