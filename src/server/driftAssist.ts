import { buffer as streamToBuffer } from "stream/consumers";
import type { CDPSession, Locator, Page } from "playwright";
import { SystemMessage, HumanMessage, type MessageContent } from "@langchain/core/messages";
import { DESCRIBE_AND_LOCATE_JS } from "./automation";
import { getArtifactStream, uploadArtifact } from "./artifacts";
import { invokeChatModel } from "./flowSummary";
import { getPrompt, renderPrompt } from "./promptLibrary";
import { getRunSummary } from "./runs";
import { listInteractiveElements } from "./variationDiscovery";
import type { ElementLocator } from "./types";

// When a recorded step's locator resolves to more than one candidate
// ("ambiguous") or to one untrustworthy candidate ("drifted",
// src/server/locatorReplay.ts), this offers a vision-model best guess for
// which real element matches the original recording. Two stages, cheapest/
// most-constrained first:
//   1. suggestFromCandidates — compares only the real elements that still
//      match the recorded locator's own query (semantic anchoring: grounded
//      in the flow's narrative + this step's caption, not just visual
//      similarity, so two visually-identical candidates can still be told
//      apart by what the flow is actually trying to do).
//   2. suggestFromWholePage — only tried if (1) finds nothing; looks past
//      the original (possibly now-wrong) locator entirely and considers
//      every real interactive element on the live page.
// Each returns a confidence level. src/server/replay.ts auto-applies "high"
// confidence suggestions and shows everything else ("medium"/"low") as a
// suggestion requiring a human's "Use this match" — see DriftSuggestion
// below. Nothing here ever invents a locator; every suggestion traces back
// to a real, already-discovered element.

function messageContentToText(content: MessageContent): string {
  if (typeof content === "string") return content;
  return content
    .map((part) => (typeof part === "string" ? part : "text" in part ? (part.text as string) : ""))
    .join(" ");
}

type Confidence = "high" | "medium" | "low";

// Shared by both stages — "Match:"/"Pick:" is stage-specific label text,
// everything else (confidence, reasoning) is identical. Defaults confidence
// to "low" if the model's response doesn't include a parseable one, so a
// malformed response can never accidentally qualify for auto-apply.
function parseSuggestionResponse(raw: string): { matchIndex: number | null; confidence: Confidence; reasoning: string } {
  const matchLine = raw.match(/(?:Match|Pick):\s*(none|\d+)/i);
  const confidenceLine = raw.match(/Confidence:\s*(high|medium|low)/i);
  const reasoningLine = raw.match(/Reasoning:\s*([\s\S]*)$/i);
  const matchValue = matchLine?.[1]?.toLowerCase();
  const matchIndex = matchValue && matchValue !== "none" && /^\d+$/.test(matchValue) ? Number(matchValue) : null;
  const confidence = (confidenceLine?.[1]?.toLowerCase() as Confidence | undefined) ?? "low";
  return { matchIndex, confidence, reasoning: reasoningLine?.[1]?.trim() ?? raw.trim() };
}

interface DescribedCandidate {
  index: number;
  description: string;
  locator: ElementLocator;
  box: { x: number; y: number; width: number; height: number };
  // From locatorReplay.ts's position check — how far this candidate's
  // current center is from where the original click landed. Undefined if no
  // recorded click point existed at all; that's different from a large
  // number, so it's kept absent rather than coerced to something like -1.
  positionDistance?: number;
  // From locatorReplay.ts's content-similarity check — cosine similarity
  // (0-1) between embeddings of this candidate's current sibling text and
  // the recorded element's sibling text. Undefined if there was nothing on
  // either side to embed and compare.
  contentSimilarity?: number;
}

// Reuses the exact same in-page description/locate logic recording uses
// (automation.ts) so a candidate's description reads the same way a
// recorded step's does, and its cssSelector is always positionally unique
// — even when the winning `strategy` is the same weak text/role match every
// other candidate shares, which is exactly why they collided in the first
// place.
// `positionDistances`/`contentSimilarities`, if given, are index-aligned to
// `candidates` (as produced by locatorReplay.ts's pickByRecordedPosition/
// pickByContentSimilarity) — carried through by original index since
// candidates without a usable bounding box/selector get skipped here, which
// would otherwise desync a parallel array.
async function describeCandidates(
  candidates: Locator[],
  positionDistances?: (number | null)[],
  contentSimilarities?: (number | null)[],
): Promise<DescribedCandidate[]> {
  const described: DescribedCandidate[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    const box = await candidate.boundingBox().catch(() => null);
    if (!box) continue;
    const result = (await candidate
      .evaluate(`(el) => { ${DESCRIBE_AND_LOCATE_JS} return describeAndLocate(el); }`)
      .catch(() => null)) as { description: string; locator: ElementLocator | null } | null;
    const cssSelector = result?.locator?.cssSelector;
    if (!cssSelector) continue;
    const positionDistance = positionDistances?.[i];
    const contentSimilarity = contentSimilarities?.[i];
    described.push({
      index: described.length,
      description: result?.description || `candidate ${described.length + 1}`,
      locator: { strategy: "css", value: cssSelector, cssSelector },
      box,
      positionDistance: positionDistance ?? undefined,
      contentSimilarity: contentSimilarity ?? undefined,
    });
  }
  return described;
}

// Draws a numbered red outline over each candidate directly on the live
// page, screenshots it, then removes the overlay. Document-relative
// (`position: absolute` + the scroll offset at draw time), not the
// viewport-relative "fixed" positioning this used before — combined with
// `fullPage: true` below, that's what makes candidates that are far apart
// vertically (a top-nav link and a footer link sharing the same name, say)
// both actually show up in the one screenshot the vision model sees. A
// plain viewport screenshot can only ever contain whichever single
// candidate happens to be scrolled into view — the other would be drawn
// completely outside the captured frame, making a real visual comparison
// between them impossible regardless of how good the model is.
async function screenshotWithHighlights(page: Page, candidates: DescribedCandidate[]): Promise<Buffer> {
  const items = candidates.map((c) => ({ index: c.index, box: c.box }));
  await page.evaluate((boxes: { index: number; box: DescribedCandidate["box"] }[]) => {
    const root = document.createElement("div");
    root.id = "__sb_drift_overlay";
    Object.assign(root.style, { position: "absolute", left: "0", top: "0", pointerEvents: "none", zIndex: "2147483647" });
    const scrollX = window.scrollX;
    const scrollY = window.scrollY;
    for (const item of boxes) {
      const box = document.createElement("div");
      Object.assign(box.style, {
        position: "absolute",
        left: `${item.box.x + scrollX}px`,
        top: `${item.box.y + scrollY}px`,
        width: `${item.box.width}px`,
        height: `${item.box.height}px`,
        border: "3px solid #f43f5e",
        boxSizing: "border-box",
      });
      const label = document.createElement("div");
      label.textContent = String(item.index);
      Object.assign(label.style, {
        position: "absolute",
        top: "-20px",
        left: "0",
        background: "#f43f5e",
        color: "#fff",
        font: "bold 12px monospace",
        padding: "1px 5px",
        borderRadius: "3px",
      });
      box.appendChild(label);
      root.appendChild(box);
    }
    document.documentElement.appendChild(root);
  }, items);
  try {
    return await page.screenshot({ type: "jpeg", quality: 70, fullPage: true });
  } finally {
    await page.evaluate(() => document.getElementById("__sb_drift_overlay")?.remove()).catch(() => {});
  }
}

export interface DriftSuggestion {
  description: string;
  reasoning: string;
  locator: ElementLocator;
  confidence: Confidence;
  source: "semantic" | "live-llm";
  candidatesScreenshot?: string;
}

const LOG_PREFIX = "[driftAssist]";

interface SemanticContext {
  flowNarrative?: string;
  stepCaption?: string;
}

// Stage 1 — compares only the real elements that still match the recorded
// locator's own query, grounded in the flow's narrative and this step's
// caption (semantic anchoring) as well as the two screenshots. Best-effort
// only — every path below returns undefined (no suggestion) rather than
// throwing, since this is a convenience on top of the existing manual
// handoff, not a required step. Each failure/decline point logs *why*,
// though — a bare "no suggestion" used to be indistinguishable from "it
// crashed" from the outside; now it's greppable in the server logs.
async function suggestFromCandidates(params: {
  page: Page;
  runId: string;
  sourceStepIndex: number;
  sourceRunId: string;
  recordedScreenshotFile: string;
  targetDescription: string;
  candidates: Locator[];
  positionDistances?: (number | null)[];
  contentSimilarities?: (number | null)[];
  context: SemanticContext;
}): Promise<DriftSuggestion | undefined> {
  const {
    page,
    runId,
    sourceStepIndex,
    sourceRunId,
    recordedScreenshotFile,
    targetDescription,
    candidates,
    positionDistances,
    contentSimilarities,
    context,
  } = params;
  const logCtx = { runId, sourceRunId, sourceStepIndex };

  let described: DescribedCandidate[];
  try {
    described = await describeCandidates(candidates, positionDistances, contentSimilarities);
  } catch (err) {
    console.error(`${LOG_PREFIX} failed describing candidates`, logCtx, err);
    return undefined;
  }
  if (described.length === 0) {
    console.warn(`${LOG_PREFIX} no candidates had a usable bounding box/selector — nothing to suggest from`, {
      ...logCtx,
      candidateCount: candidates.length,
    });
    return undefined;
  }

  let recordedScreenshot: Buffer;
  let currentScreenshot: Buffer;
  try {
    [recordedScreenshot, currentScreenshot] = await Promise.all([
      getArtifactStream(sourceRunId, recordedScreenshotFile).then(streamToBuffer),
      screenshotWithHighlights(page, described),
    ]);
  } catch (err) {
    console.error(`${LOG_PREFIX} failed preparing screenshots`, logCtx, err);
    return undefined;
  }

  // Persisted under the *current* (replay) run's own artifact namespace
  // regardless of what the model decides below — the highlighted image is
  // useful on its own as a record of what was on screen at the pause, even
  // if the model finds no confident match. Upload failure is logged but
  // non-fatal to the suggestion itself (candidatesScreenshot just ends up
  // undefined on the returned suggestion).
  const candidatesScreenshotFile = `drift-step-${sourceStepIndex}-candidates.jpg`;
  const candidatesScreenshot = await uploadArtifact(runId, candidatesScreenshotFile, "image/jpeg", currentScreenshot)
    .then(() => candidatesScreenshotFile)
    .catch((err) => {
      console.error(`${LOG_PREFIX} failed uploading candidates screenshot`, logCtx, err);
      return undefined;
    });

  // Surfaces locatorReplay.ts's own position and content-similarity checks
  // as numeric hints inside the same prompt, instead of them being separate,
  // invisible-to-the-model gates — a candidate too far/dissimilar to trust
  // on either signal alone can still be the right one; the model now gets
  // to weigh both alongside what it sees in the screenshots rather than
  // never seeing them at all.
  const candidatesList = described
    .map((c) => {
      const notes: string[] = [];
      if (c.positionDistance !== undefined) notes.push(`${Math.round(c.positionDistance)}px from the recorded click position`);
      if (c.contentSimilarity !== undefined) notes.push(`${Math.round(c.contentSimilarity * 100)}% similar surrounding text`);
      return `${c.index}. ${c.description}${notes.length ? ` (${notes.join(", ")})` : ""}`;
    })
    .join("\n");

  let responseText: string;
  try {
    const response = await invokeChatModel([
      new SystemMessage(getPrompt("driftAssist.suggest.system")),
      new HumanMessage({
        content: [
          {
            type: "text",
            text: [
              context.flowNarrative
                ? renderPrompt("driftAssist.suggest.flowContextLine", { flowNarrative: context.flowNarrative })
                : null,
              context.stepCaption
                ? renderPrompt("driftAssist.suggest.stepCaptionLine", { stepCaption: context.stepCaption })
                : null,
              renderPrompt("driftAssist.suggest.human", { targetDescription, candidatesList }),
            ]
              .filter(Boolean)
              .join("\n\n"),
          },
          { type: "image_url", image_url: { url: `data:image/jpeg;base64,${recordedScreenshot.toString("base64")}` } },
          { type: "image_url", image_url: { url: `data:image/jpeg;base64,${currentScreenshot.toString("base64")}` } },
        ],
      }),
    ]);
    responseText = messageContentToText(response.content);
  } catch (err) {
    console.error(`${LOG_PREFIX} vision model call failed`, logCtx, err);
    return undefined;
  }

  const { matchIndex, confidence, reasoning } = parseSuggestionResponse(responseText);
  if (matchIndex === null) {
    console.info(`${LOG_PREFIX} model found no confident match`, {
      ...logCtx,
      candidateCount: described.length,
      response: responseText,
    });
    return undefined;
  }
  if (matchIndex < 0 || matchIndex >= described.length) {
    console.warn(`${LOG_PREFIX} model returned an out-of-range match index — discarding`, {
      ...logCtx,
      matchIndex,
      candidateCount: described.length,
      response: responseText,
    });
    return undefined;
  }

  const picked = described[matchIndex];
  console.info(
    `${LOG_PREFIX} suggested candidate ${matchIndex} ("${picked.description}", confidence: ${confidence})`,
    logCtx,
  );
  return { description: picked.description, reasoning, locator: picked.locator, confidence, source: "semantic", candidatesScreenshot };
}

// Stage 2 — only tried when stage 1 finds nothing. Looks past the original
// (possibly now-wrong) locator entirely and considers every real
// interactive element currently on the page (variationDiscovery.ts's
// accessibility-tree walk — same one the alternative-suggestion pipeline
// uses, so results are already visible, real, and never invented), scored
// against the flow's narrative and this step's caption rather than any
// resemblance to the original locator's own strategy.
// variationDiscovery.ts's own MAX_ELEMENTS (40) is sized for its other
// callers (the alternatives pipeline, the site crawl); this fallback sends
// its elements straight into an Ollama vision prompt on top of a screenshot,
// and 40 fully-described elements plus a full-page image was enough to blow
// past a 4096-token context window in practice (a real page tripped a
// 5256-token request). Re-capped smaller here rather than lowering the
// shared constant, since those other callers aren't context-constrained the
// same way.
const MAX_WHOLE_PAGE_ELEMENTS = 20;
const MAX_ELEMENT_DESCRIPTION_CHARS = 80;
// Bounds the screenshot to a couple of viewport heights instead of the
// page's full scroll height — the biggest single contributor to the
// over-budget request above, since a vision model's image-token cost scales
// with pixel area and a long marketing/content page can run many multiples
// of one viewport tall. Most "what to click next" decisions live near the
// top of the page anyway; this trades away matching on elements far below
// the fold in exchange for the fallback actually returning a result instead
// of failing outright.
const MAX_SCREENSHOT_VIEWPORTS = 2;

async function suggestFromWholePage(params: {
  page: Page;
  cdp: CDPSession;
  runId: string;
  sourceRunId: string;
  sourceStepIndex: number;
  targetDescription: string;
  context: SemanticContext;
}): Promise<DriftSuggestion | undefined> {
  const { page, cdp, runId, sourceRunId, sourceStepIndex, targetDescription, context } = params;
  const logCtx = { runId, sourceRunId, sourceStepIndex };

  try {
    const allElements = await listInteractiveElements(cdp);
    if (allElements.length === 0) {
      console.warn(`${LOG_PREFIX} whole-page fallback found no interactive elements`, logCtx);
      return undefined;
    }
    const elements = allElements.slice(0, MAX_WHOLE_PAGE_ELEMENTS);

    const viewport = page.viewportSize() ?? { width: 1280, height: 800 };
    const scrollHeight = await page
      .evaluate(() => document.documentElement.scrollHeight)
      .catch(() => viewport.height);
    const clipHeight = Math.min(scrollHeight, viewport.height * MAX_SCREENSHOT_VIEWPORTS);
    const screenshot = await page
      .screenshot({
        type: "jpeg",
        quality: 70,
        clip: { x: 0, y: 0, width: viewport.width, height: clipHeight },
      })
      .catch(() => null);
    if (!screenshot) {
      console.warn(`${LOG_PREFIX} whole-page fallback couldn't capture a screenshot`, logCtx);
      return undefined;
    }

    const elementsList = elements
      .map((e, i) => `${i}. ${e.description.slice(0, MAX_ELEMENT_DESCRIPTION_CHARS)}`)
      .join("\n");
    const response = await invokeChatModel([
      new SystemMessage(getPrompt("driftAssist.suggestWholePage.system")),
      new HumanMessage({
        content: [
          {
            type: "text",
            text: renderPrompt("driftAssist.suggestWholePage.human", {
              flowNarrative: context.flowNarrative || "(no flow narrative available)",
              stepCaption: context.stepCaption || targetDescription,
              targetDescription,
              elementsList,
            }),
          },
          { type: "image_url", image_url: { url: `data:image/jpeg;base64,${screenshot.toString("base64")}` } },
        ],
      }),
    ]);
    const responseText = messageContentToText(response.content);
    const { matchIndex, confidence, reasoning } = parseSuggestionResponse(responseText);

    if (matchIndex === null) {
      console.info(`${LOG_PREFIX} whole-page fallback found no confident pick`, {
        ...logCtx,
        candidateCount: elements.length,
        response: responseText,
      });
      return undefined;
    }
    if (matchIndex < 0 || matchIndex >= elements.length) {
      console.warn(`${LOG_PREFIX} whole-page fallback returned an out-of-range index — discarding`, {
        ...logCtx,
        matchIndex,
        candidateCount: elements.length,
        response: responseText,
      });
      return undefined;
    }

    const picked = elements[matchIndex];
    console.info(
      `${LOG_PREFIX} whole-page fallback picked "${picked.description}" (confidence: ${confidence})`,
      logCtx,
    );
    return { description: picked.description, reasoning, locator: picked.locator, confidence, source: "live-llm" };
  } catch (err) {
    console.error(`${LOG_PREFIX} whole-page fallback failed`, logCtx, err);
    return undefined;
  }
}

// Public entry point — src/server/replay.ts calls this once per pause.
// Loads the flow's narrative + this step's caption once (from the source
// run's flow summary, if one has been generated — gracefully omitted from
// both prompts otherwise, same degrade-without-it pattern used everywhere
// else this codebase pulls in optional grounding context), then tries stage
// 1 before stage 2.
export async function suggestDriftCandidate(params: {
  page: Page;
  cdp: CDPSession;
  runId: string;
  sourceStepIndex: number;
  sourceRunId: string;
  recordedScreenshotFile: string;
  targetDescription: string;
  candidates: Locator[];
  positionDistances?: (number | null)[];
  contentSimilarities?: (number | null)[];
}): Promise<DriftSuggestion | undefined> {
  const {
    page,
    cdp,
    runId,
    sourceStepIndex,
    sourceRunId,
    recordedScreenshotFile,
    targetDescription,
    candidates,
    positionDistances,
    contentSimilarities,
  } = params;

  const summary = await getRunSummary(sourceRunId).catch(() => null);
  const context: SemanticContext = {
    flowNarrative: summary?.narrative,
    stepCaption: summary?.stepCaptions.find((c) => c.index === sourceStepIndex)?.caption,
  };

  const fromCandidates = await suggestFromCandidates({
    page,
    runId,
    sourceStepIndex,
    sourceRunId,
    recordedScreenshotFile,
    targetDescription,
    candidates,
    positionDistances,
    contentSimilarities,
    context,
  });
  if (fromCandidates) return fromCandidates;

  return suggestFromWholePage({ page, cdp, runId, sourceRunId, sourceStepIndex, targetDescription, context });
}
