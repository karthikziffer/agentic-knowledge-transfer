"use client";

import { useEffect, useState } from "react";
import AlternativeSuggestions from "@/components/AlternativeSuggestions";
import type { AlternativeSuggestion, RunRecord, StepResult } from "@/server/types";

const POLL_MS = 2000;

function isTerminal(status: RunRecord["status"]): boolean {
  return status === "completed" || status === "error";
}

export default function AlternativesPageClient({
  runId,
  projectId,
  skillId,
  promptId,
  steps,
  initialVariantRuns,
  initialSuggestionsByStep,
}: {
  runId: string;
  projectId: string;
  skillId: string;
  promptId: string;
  steps: StepResult[];
  initialVariantRuns: RunRecord[];
  // Cache-only prefetch (src/server/runs.ts's getAlternativeSuggestions) —
  // null for a step that's never had "Find alternatives" run on it.
  initialSuggestionsByStep: Record<
    number,
    { candidates: AlternativeSuggestion[]; model: string; explorationScreenshot?: string } | null
  >;
}) {
  const [variantRuns, setVariantRuns] = useState(initialVariantRuns);

  // Keeps generated-alternative rows live (queued → running → completed/
  // error) without opening RunPreviewModal — otherwise a freshly generated
  // run would sit at "queued" in the list forever until the page reloads.
  useEffect(() => {
    const pending = variantRuns.filter((run) => !isTerminal(run.status));
    if (pending.length === 0) return;

    const timer = setInterval(async () => {
      const updates = await Promise.all(
        pending.map(async (run) => {
          try {
            const res = await fetch(`/api/runs/${run.id}`);
            if (!res.ok) return null;
            const body = await res.json();
            return body.record as RunRecord;
          } catch {
            return null;
          }
        }),
      );
      const byId = new Map(updates.filter((r): r is RunRecord => r !== null).map((r) => [r.id, r]));
      if (byId.size === 0) return;
      setVariantRuns((prev) => prev.map((run) => byId.get(run.id) ?? run));
    }, POLL_MS);

    return () => clearInterval(timer);
  }, [variantRuns]);

  const variantsByStep = new Map<number, RunRecord[]>();
  for (const run of variantRuns) {
    if (run.variantOfStepIndex === undefined) continue;
    const list = variantsByStep.get(run.variantOfStepIndex) ?? [];
    list.push(run);
    variantsByStep.set(run.variantOfStepIndex, list);
  }

  function handleGenerated(stepIndex: number, runId: string, candidate: AlternativeSuggestion) {
    const placeholder: RunRecord = {
      id: runId,
      userId: "",
      promptId: "",
      promptText: "",
      startUrl: "",
      status: "queued",
      createdAt: new Date().toISOString(),
      steps: [],
      variantOfStepIndex: stepIndex,
      variantLabel: candidate.description,
      variantTargetLocator: candidate.locator,
    };
    setVariantRuns((prev) => [placeholder, ...prev]);
  }

  return (
    <div className="flex flex-col gap-4">
      {steps.map((step) => (
        <div key={step.index} className="card flex items-start gap-4 p-4">
          {step.screenshot ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={`/api/artifacts/${runId}/${step.screenshot}`}
              alt=""
              className="h-20 w-28 shrink-0 rounded-md border border-edge object-cover object-top"
            />
          ) : (
            <div className="flex h-20 w-28 shrink-0 items-center justify-center rounded-md border border-dashed border-edge-strong bg-surface-2">
              <span className="font-mono text-[9px] text-ink-faint">no frame</span>
            </div>
          )}
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-medium text-ink-faint">Step {step.index + 1}</p>
            <p className="text-[13px] font-medium text-ink">{step.description ?? step.type}</p>
            <div className="mt-3">
              <AlternativeSuggestions
                runId={runId}
                projectId={projectId}
                skillId={skillId}
                promptId={promptId}
                stepIndex={step.index}
                existing={variantsByStep.get(step.index) ?? []}
                initialSuggestions={initialSuggestionsByStep[step.index]?.candidates ?? null}
                initialModel={initialSuggestionsByStep[step.index]?.model}
                initialExplorationScreenshot={initialSuggestionsByStep[step.index]?.explorationScreenshot}
                onGenerated={(runId, candidate) => handleGenerated(step.index, runId, candidate)}
              />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
