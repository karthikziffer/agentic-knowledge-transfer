"use client";

import { useState } from "react";
import Spinner from "@/components/Spinner";
import { StatusBadge } from "@/components/LiveRunView";
import RunPreviewModal from "@/components/RunPreviewModal";
import { useToast } from "@/components/Toast";
import type { AlternativeSuggestion, AlternativesProgress, RunRecord } from "@/server/types";

// Mirrors FlowSummaryView's ProgressLabel — the alternatives pipeline runs
// in a separate worker process now (src/server/alternativesQueue.ts,
// worker.ts), so this is the one signal the user has that it's actually
// making progress rather than stuck, beyond the generic "Finding…" spinner.
function progressLabel(progress: AlternativesProgress | null): string {
  switch (progress?.phase) {
    case "loading-context":
      return "Reading the flow's goal…";
    case "exploring-page":
      return "Launching a browser and looking at the live page…";
    case "deciding-alternatives":
      return "Deciding which elements are genuine alternatives…";
    default:
      return "Queued — waiting for a worker to pick this up…";
  }
}

// Finds a specific suggestion's already-generated run, if any, by matching
// the real target locator each carries — not by description text, which
// can legitimately change between "Find alternatives" runs.
function runFor(candidate: AlternativeSuggestion, existing: RunRecord[]): RunRecord | undefined {
  return existing.find((run) => {
    const target = run.variantTargetLocator;
    if (!target) return false;
    if (candidate.locator.cssSelector) return target.cssSelector === candidate.locator.cssSelector;
    return target.strategy === candidate.locator.strategy && target.value === candidate.locator.value;
  });
}

// Surfaces the alternative-suggestion pipeline's picks (src/server/
// alternativesAgent.ts — a context agent, a site-exploring agent, and a
// decision agent, run once and cached) as a real list to choose from,
// instead of the old blind "type a number" control.
export default function AlternativeSuggestions({
  runId,
  projectId,
  skillId,
  promptId,
  stepIndex,
  existing,
  initialSuggestions,
  initialModel,
  initialExplorationScreenshot,
  onGenerated,
}: {
  runId: string;
  projectId: string;
  skillId: string;
  promptId: string;
  stepIndex: number;
  existing: RunRecord[];
  initialSuggestions: AlternativeSuggestion[] | null;
  initialModel?: string;
  // Artifact filename (this run's own id) for the page screenshot the
  // exploration agent captured while generating these suggestions — see
  // explorePageNode in src/server/alternativesAgent.ts.
  initialExplorationScreenshot?: string;
  onGenerated: (runId: string, candidate: AlternativeSuggestion) => void;
}) {
  const toast = useToast();
  const [suggestions, setSuggestions] = useState(initialSuggestions);
  // No setter — the worker's "done" payload never carried a model name even
  // before this moved to a background job (src/server/alternativesQueue.ts's
  // publish only sends suggestions/explorationScreenshot), so this only
  // ever reflects what the cached GET loaded the component with.
  const [model] = useState(initialModel);
  const [explorationScreenshot, setExplorationScreenshot] = useState(initialExplorationScreenshot);
  const [finding, setFinding] = useState(false);
  const [findError, setFindError] = useState<string | null>(null);
  const [findProgress, setFindProgress] = useState<AlternativesProgress | null>(null);
  const [generatingIndex, setGeneratingIndex] = useState<number | null>(null);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [viewingRunId, setViewingRunId] = useState<string | null>(null);

  // The route streams newline-delimited JSON (a "progress" line per stage
  // the worker reports via Redis pub/sub, then one "done" or "error" line)
  // instead of a single Response.json — same shape as FlowSummaryView's
  // /api/runs/[runId]/summary, and for the same reason: the actual work now
  // runs in a separate worker process (src/server/alternativesQueue.ts),
  // and can take a while (a real browser launch plus two LLM calls).
  async function findAlternatives() {
    setFinding(true);
    setFindError(null);
    setFindProgress(null);
    try {
      const res = await fetch(`/api/runs/${runId}/alternatives/suggest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stepIndex }),
      });
      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "Failed to find alternatives");
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let done: { suggestions: AlternativeSuggestion[]; explorationScreenshot?: string } | null = null;
      let streamError: string | null = null;

      for (;;) {
        const { value, done: readerDone } = await reader.read();
        if (readerDone) break;
        buffer += decoder.decode(value, { stream: true });
        let newlineIndex: number;
        while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newlineIndex);
          buffer = buffer.slice(newlineIndex + 1);
          if (!line.trim()) continue;
          const msg = JSON.parse(line) as
            | { type: "progress"; progress: AlternativesProgress }
            | { type: "done"; suggestions: AlternativeSuggestion[]; explorationScreenshot?: string }
            | { type: "error"; error: string };
          if (msg.type === "progress") setFindProgress(msg.progress);
          else if (msg.type === "done") done = msg;
          else if (msg.type === "error") streamError = msg.error;
        }
      }

      if (streamError) throw new Error(streamError);
      if (!done) throw new Error("Failed to find alternatives");
      setSuggestions(done.suggestions);
      setExplorationScreenshot(done.explorationScreenshot);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to find alternatives";
      setFindError(message);
      toast.error(message);
    } finally {
      setFinding(false);
      setFindProgress(null);
    }
  }

  async function generate(candidateIndex: number, candidate: AlternativeSuggestion) {
    setGeneratingIndex(candidateIndex);
    setGenerateError(null);
    try {
      const res = await fetch(`/api/runs/${runId}/variations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stepIndex, candidateIndex }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Failed to generate this alternative");
      onGenerated(body.runId as string, candidate);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to generate this alternative";
      setGenerateError(message);
      toast.error(message);
    } finally {
      setGeneratingIndex(null);
    }
  }

  if (!suggestions) {
    return (
      <div>
        <button
          type="button"
          onClick={findAlternatives}
          disabled={finding}
          className="btn btn-secondary"
        >
          {finding ? "Finding alternatives…" : "Find alternatives"}
        </button>
        {finding && <p className="mt-1.5 text-[11px] text-ink-faint">{progressLabel(findProgress)}</p>}
        {findError && <p className="mt-1.5 text-[11px] text-error">{findError}</p>}
      </div>
    );
  }

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          {explorationScreenshot && (
            <a
              href={`/api/artifacts/${runId}/${explorationScreenshot}`}
              target="_blank"
              rel="noreferrer"
              title="What the AI saw while exploring this page"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`/api/artifacts/${runId}/${explorationScreenshot}`}
                alt="What the AI saw while exploring this page"
                className="h-8 w-11 shrink-0 rounded border border-edge object-cover object-top"
              />
            </a>
          )}
          <span className="truncate font-mono text-[10px] text-ink-faint">
            {suggestions.length} alternative{suggestions.length === 1 ? "" : "s"} found
            {model ? ` · ${model}` : ""}
          </span>
        </div>
        <button
          type="button"
          onClick={findAlternatives}
          disabled={finding}
          className="shrink-0 text-[11px] font-medium text-accent hover:underline disabled:opacity-50"
        >
          {finding ? "Finding…" : "Regenerate"}
        </button>
      </div>
      {findError && <p className="mb-2 text-[11px] text-error">{findError}</p>}
      {generateError && <p className="mb-2 text-[11px] text-error">{generateError}</p>}
      {suggestions.length === 0 ? (
        <p className="text-[12px] text-ink-faint">No meaningful alternatives found on this page.</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {suggestions.map((candidate, i) => {
            const run = runFor(candidate, existing);
            return (
              <li key={i} className="card card-hover flex items-center gap-3 p-2.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[12px] font-medium text-ink">{candidate.description}</p>
                  <p className="truncate text-[11px] text-ink-muted">{candidate.reasoning}</p>
                </div>
                {!run && (
                  <button
                    type="button"
                    onClick={() => generate(i, candidate)}
                    disabled={generatingIndex === i}
                    className="btn btn-secondary shrink-0"
                  >
                    {generatingIndex === i ? "Generating…" : "Generate"}
                  </button>
                )}
                {run?.status === "queued" && (
                  <div className="flex shrink-0 items-center gap-2 text-[12px] text-ink-faint">
                    <Spinner />
                    Queued…
                  </div>
                )}
                {run && run.status !== "queued" && (
                  <div className="flex shrink-0 items-center gap-2">
                    <StatusBadge status={run.status} />
                    <button
                      type="button"
                      onClick={() => setViewingRunId(run.id)}
                      className="font-medium text-accent hover:underline"
                    >
                      View
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <RunPreviewModal
        runId={viewingRunId}
        projectId={projectId}
        skillId={skillId}
        promptId={promptId}
        open={viewingRunId !== null}
        onClose={() => setViewingRunId(null)}
      />
    </div>
  );
}
