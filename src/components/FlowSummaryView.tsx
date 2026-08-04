"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import EmptyState from "@/components/EmptyState";
import Modal from "@/components/Modal";
import LiveRunView, { StatusBadge } from "@/components/LiveRunView";
import RunSectionNav from "@/components/RunSectionNav";
import SkillActionGraph from "@/components/SkillActionGraph";
import SkillAgentPanel from "@/components/SkillAgentPanel";
import AlternativesPageClient from "@/components/AlternativesPageClient";
import RunFlow from "@/components/RunFlow";
import Collapsible from "@/components/Collapsible";
import { useToast } from "@/components/Toast";
import type {
  AlternativePlan,
  CrawlDepthGoal,
  ElementLocator,
  FlowSummaryProgress,
  RunFlowSummary,
  RunRecord,
  StepResult,
} from "@/server/types";

// Three staggered dots for phases with no fraction to show (loading /
// synthesizing / done) — a small "still working" signal next to the label,
// distinct from the step-counter pop used during captioning.
function DotPulse() {
  return (
    <span className="ml-1 inline-flex items-center gap-0.5 align-middle" aria-hidden>
      {[0, 160, 320].map((delay) => (
        <span
          key={delay}
          className="progress-dot h-1 w-1 rounded-full bg-ink-faint"
          style={{ animationDelay: `${delay}ms` }}
        />
      ))}
    </span>
  );
}

// Circular ring around the progress state: a determinate arc (matching the
// bar below) once captioning has a real completed/total fraction, otherwise
// a spinning indeterminate arc — same shape throughout instead of swapping
// a generic spinner in and out as the phase changes.
function ProgressRing({ percent }: { percent: number | null }) {
  const size = 40;
  const stroke = 3;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = percent !== null ? circumference * (1 - percent / 100) : circumference * 0.75;

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="mb-2" aria-hidden>
      <circle cx={size / 2} cy={size / 2} r={radius} fill="none" strokeWidth={stroke} className="stroke-edge" />
      {/* The -90° "start at 12 o'clock" rotation lives on this wrapping <g>
          as a plain SVG attribute, deliberately kept off the circle itself —
          the indeterminate spin below animates the CSS `transform` property
          on the circle, which (per the CSS Transforms spec) fully replaces
          any SVG `transform` attribute on that same element rather than
          composing with it. Putting both on the circle silently lost the
          center-pivot rotation, making it spin around the SVG's top-left
          corner instead of its own center. */}
      <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          style={{ transformBox: "fill-box", transformOrigin: "center" }}
          className={`stroke-accent transition-[stroke-dashoffset] duration-500 ease-out ${
            percent === null ? "progress-ring-indeterminate" : ""
          }`}
        />
      </g>
    </svg>
  );
}

function ProgressLabel({ progress, stepCount }: { progress: FlowSummaryProgress | null; stepCount: number }) {
  if (!progress) {
    return (
      <>
        Summarizing {stepCount} step{stepCount === 1 ? "" : "s"} locally via Ollama…
      </>
    );
  }
  switch (progress.phase) {
    case "loading":
      return (
        <>
          Loading the recorded run…
          <DotPulse />
        </>
      );
    case "captioning":
      return (
        <>
          Captioning step{" "}
          <span
            key={progress.completed}
            className="progress-pop inline-block font-mono text-accent tabular-nums"
          >
            {progress.completed}
          </span>{" "}
          of {progress.total}…
        </>
      );
    case "synthesizing":
      return (
        <>
          Writing the summary…
          <DotPulse />
        </>
      );
    case "done":
      return (
        <>
          Finishing up…
          <DotPulse />
        </>
      );
  }
}

// Client-side mirror of the slug logic in src/server/skillsMd.ts — kept
// separate rather than importing the server module into the client bundle;
// only used to name the downloaded file, the server route is what actually
// generates the content.
function slugify(input: string): string {
  return input.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "skill";
}

// Client-side mirror of src/server/skillsMd.ts's formatPlaywrightLocator —
// same reasoning as slugify() above, kept in sync by hand rather than
// importing the server module into the client bundle.
function formatPlaywrightLocator(locator: ElementLocator): string {
  const scopable = locator.strategy === "role" || locator.strategy === "text" || locator.strategy === "placeholder";
  const root = scopable && locator.scopeSelector ? `page.locator('${locator.scopeSelector}')` : "page";
  switch (locator.strategy) {
    case "testId":
      return `page.getByTestId('${locator.value}')`;
    case "role":
      return `${root}.getByRole('${locator.role}', { name: '${locator.value}', exact: true })`;
    case "placeholder":
      return `${root}.getByPlaceholder('${locator.value}', { exact: true })`;
    case "text":
      return `${root}.getByText('${locator.value}', { exact: true })`;
    case "css":
      return `page.locator('${locator.value}')`;
  }
}

type SectionKey = "artifacts" | "summary" | "skillsmd" | "test" | "plan" | "alternatives" | "agent";

const SECTIONS: { key: SectionKey; label: string }[] = [
  { key: "artifacts", label: "Session artifacts" },
  { key: "summary", label: "Flow summary" },
  { key: "skillsmd", label: "Skills.md" },
  { key: "test", label: "Test the skill" },
  { key: "plan", label: "Plan alternatives" },
  { key: "alternatives", label: "Create alternatives" },
  { key: "agent", label: "Agent" },
];

export default function FlowSummaryView({
  runId,
  projectId,
  skillId,
  promptId,
  skillName,
  startUrl,
  initialSummary,
  initialSkillsMd,
  steps,
  initialVariantRuns,
  initialPlansByStep,
  hasVideo,
  hasTrace,
}: {
  runId: string;
  projectId: string;
  skillId: string;
  promptId: string;
  skillName: string;
  startUrl: string;
  initialSummary: RunFlowSummary | null;
  initialSkillsMd: string | null;
  steps: StepResult[];
  initialVariantRuns: RunRecord[];
  initialPlansByStep: Record<
    number,
    { plans: AlternativePlan[]; model: string; depthGoals: CrawlDepthGoal[]; rootScreenshot?: string } | null
  >;
  hasVideo: boolean;
  hasTrace: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [section, setSection] = useState<SectionKey>("summary");
  const [alternativesControlsSlot, setAlternativesControlsSlot] = useState<HTMLDivElement | null>(null);
  const [summary, setSummary] = useState(initialSummary);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<FlowSummaryProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [skillsMd, setSkillsMd] = useState(initialSkillsMd);
  const [skillsMdLoading, setSkillsMdLoading] = useState(false);
  const [skillsMdError, setSkillsMdError] = useState<string | null>(null);
  const [showRawSkillsMd, setShowRawSkillsMd] = useState(false);
  const [expandedStep, setExpandedStep] = useState<StepResult | null>(null);
  const [testRunId, setTestRunId] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);
  // Bumped only when a "Test & validate alternatives" run finishes with a
  // clean pass — SkillActionGraph watches this to auto-trigger validation.
  // A plain "Start test session" never touches this.
  const [autoValidateSignal, setAutoValidateSignal] = useState<number | undefined>(undefined);
  const gateIntoValidation = useRef(false);
  const testPollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stepCount = steps.length;

  // The route streams newline-delimited JSON ("progress" lines as each
  // stage/step completes, then one "done" or "error" line) instead of a
  // single Response.json, so this reads the body incrementally rather than
  // awaiting res.json().
  async function generate() {
    setLoading(true);
    setError(null);
    setProgress(null);
    try {
      const res = await fetch(`/api/runs/${runId}/summary`, { method: "POST" });
      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "Failed to generate summary");
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let finalSummary: RunFlowSummary | null = null;
      let streamError: string | null = null;

      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newlineIndex: number;
        while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newlineIndex);
          buffer = buffer.slice(newlineIndex + 1);
          if (!line.trim()) continue;
          const msg = JSON.parse(line) as
            | { type: "progress"; progress: FlowSummaryProgress }
            | { type: "done"; summary: RunFlowSummary }
            | { type: "error"; error: string };
          if (msg.type === "progress") setProgress(msg.progress);
          else if (msg.type === "done") finalSummary = msg.summary;
          else if (msg.type === "error") streamError = msg.error;
        }
      }

      if (streamError) throw new Error(streamError);
      if (!finalSummary) throw new Error("Failed to generate summary");
      setSummary(finalSummary);
      router.refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to generate summary";
      setError(message);
      toast.error(message);
    } finally {
      setLoading(false);
      setProgress(null);
    }
  }

  async function generateSkillsMd() {
    setSkillsMdLoading(true);
    setSkillsMdError(null);
    try {
      const res = await fetch(`/api/runs/${runId}/skills-md`, { method: "POST" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Failed to generate skills.md");
      setSkillsMd(body.skillsMd as string);
      router.refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to generate skills.md";
      setSkillsMdError(message);
      toast.error(message);
    } finally {
      setSkillsMdLoading(false);
    }
  }

  async function startTest(gate = false) {
    gateIntoValidation.current = gate;
    setTesting(true);
    setTestError(null);
    try {
      const res = await fetch(`/api/runs/${runId}/replay`, { method: "POST" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Failed to start test session");
      setTestRunId(body.runId as string);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to start test session";
      setTestError(message);
      toast.error(message);
    } finally {
      setTesting(false);
    }
  }

  // Only relevant when startTest(true) kicked this test off — polls until
  // the test run reaches a terminal state and, only then, decides whether
  // to gate into alternative validation. Mirrors SkillActionGraph.tsx's
  // exact crawl-polling shape (recursive setTimeout, a `cancelled` flag,
  // terminate on "completed"|"error").
  //
  // "Ran without any error" is stricter than the run's own terminal status:
  // a replay's `status` becomes "completed" once it walks to the end or a
  // human confirms finish, but individual steps along the way (a drift pause
  // that failed once before auto-healing, a lower-confidence suggestion a
  // human approved) can still be logged with `status: "error"` without ever
  // flipping the run-level status — so both conditions are checked here,
  // not just `record.status`.
  useEffect(() => {
    if (!testRunId) return;
    let cancelled = false;

    async function poll() {
      try {
        const res = await fetch(`/api/runs/${testRunId}`);
        const body = await res.json();
        const record = body?.record as RunRecord | undefined;
        if (cancelled || !record) {
          testPollTimer.current = setTimeout(poll, 2000);
          return;
        }
        if (record.status === "completed" || record.status === "error") {
          if (!gateIntoValidation.current) return;
          const ranCleanly = record.status === "completed" && !record.steps.some((s) => s.status === "error");
          if (ranCleanly) {
            setSection("alternatives");
            setAutoValidateSignal(Date.now());
          } else {
            const message =
              record.status === "error"
                ? (record.error ?? "Test failed")
                : "The test completed but at least one step failed — skipping alternative validation.";
            setTestError(message);
            toast.error(message);
          }
          return;
        }
      } catch {
        // transient — keep polling
      }
      testPollTimer.current = setTimeout(poll, 2000);
    }
    poll();

    return () => {
      cancelled = true;
      if (testPollTimer.current) clearTimeout(testPollTimer.current);
    };
  }, [testRunId, toast]);

  const captionByIndex = new Map(summary?.stepCaptions.map((c) => [c.index, c]) ?? []);
  const hasSkillsMdChecklist = !!summary && summary.stepCaptions.length > 0;

  return (
    <div className="flex flex-col gap-4">
      {/* Populated via a portal from SkillActionGraph (only mounted while
          section === "alternatives") with its Validate/Refresh/score
          controls — keeps that component's state/logic fully encapsulated
          while visually relocating the controls here. empty:hidden so it
          takes up no space at all on every other tab, when it has nothing
          portaled into it. Run identity/status/Delete now live in
          RunHeader (this run page's own header), not here. */}
      <div ref={setAlternativesControlsSlot} className="flex flex-wrap items-center gap-2 empty:hidden" />

      <RunSectionNav sections={SECTIONS} active={section} onChange={(key) => setSection(key as SectionKey)} />

      {section === "artifacts" && (
        <div className="flex flex-col gap-3">
          {(hasVideo || hasTrace) && (
            <div className="card flex flex-wrap items-center gap-2 p-5">
              {hasVideo && (
                <a
                  href={`/api/artifacts/${runId}/video.webm`}
                  download
                  className="btn btn-secondary"
                >
                  Download video
                </a>
              )}
              {hasTrace && (
                <a
                  href={`/api/artifacts/${runId}/trace.zip`}
                  download
                  className="btn btn-secondary"
                  title="Open with: npx playwright show-trace trace.zip"
                >
                  Download trace.zip
                </a>
              )}
            </div>
          )}

          {steps.length > 0 && <RunFlow runId={runId} steps={steps} />}

          {hasVideo && (
            <Collapsible title="Video" scrollable={false}>
              <video
                controls
                preload="metadata"
                className="w-full max-w-3xl bg-black"
                src={`/api/artifacts/${runId}/video.webm`}
              />
            </Collapsible>
          )}

          {!hasVideo && !hasTrace && steps.length === 0 && (
            <EmptyState
              title="No artifacts yet"
              description="Video, trace files, and the flow diagram are captured while a session records — check back once one finishes."
            />
          )}
        </div>
      )}

      {section === "summary" &&
        (loading ? (
          <div className="empty-state">
            <ProgressRing
              percent={
                progress?.phase === "captioning" && progress.total > 0
                  ? Math.round((progress.completed / progress.total) * 100)
                  : null
              }
            />
            <p key={progress?.phase ?? "idle"} className="progress-fade-in text-[13px] font-medium text-ink">
              <ProgressLabel progress={progress} stepCount={stepCount} />
            </p>
            {progress?.phase === "captioning" && progress.total > 0 && (
              <div className="mt-3 h-1.5 w-48 overflow-hidden rounded-full bg-surface-2">
                <div
                  className="relative h-full overflow-hidden rounded-full bg-accent transition-[width] duration-500 ease-out"
                  style={{ width: `${Math.round((progress.completed / progress.total) * 100)}%` }}
                >
                  <div
                    className="progress-bar-shimmer absolute inset-0"
                    style={{
                      background: "linear-gradient(90deg, transparent, rgba(255,255,255,0.5), transparent)",
                    }}
                  />
                </div>
              </div>
            )}
            <p className="mt-2 max-w-xs text-[13px] text-ink-muted">
              Vision calls to a local model can take a minute for longer sessions.
            </p>
          </div>
        ) : !summary ? (
          <div className="flex flex-col gap-3">
            <EmptyState
              title="No summary yet"
              description="Generate a plain-language recap of this session from its screenshots and DOM changes."
            />
            {error && <p className="text-center text-[13px] text-error">{error}</p>}
            <button type="button" onClick={generate} className="btn btn-primary self-center">
              Generate summary
            </button>
          </div>
        ) : (
          <>
            <div className="card p-5">
              <h2 className="eyebrow mb-3">AI summary</h2>
              <p className="text-[14px] leading-relaxed text-ink">{summary.narrative}</p>

              {summary.keySteps.length > 0 && (
                <div className="mt-5">
                  <h3 className="eyebrow mb-2.5">Key steps</h3>
                  <ol className="flex flex-col gap-2">
                    {summary.keySteps.map((step, i) => (
                      <li key={i} className="flex items-start gap-2.5 text-[13px] text-ink-muted">
                        <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-accent-soft font-mono text-[9px] font-semibold text-accent">
                          {i + 1}
                        </span>
                        {step}
                      </li>
                    ))}
                  </ol>
                </div>
              )}

              {summary.outcome && (
                <div className="mt-5 rounded-lg border-l-2 border-accent bg-accent-soft/40 py-2.5 pr-3 pl-3.5">
                  <h3 className="eyebrow mb-1 text-accent/70">Outcome</h3>
                  <p className="text-[13px] text-ink">{summary.outcome}</p>
                </div>
              )}

              <div className="mt-5 flex items-center justify-between border-t border-edge pt-3.5">
                <p className="font-mono text-[11px] text-ink-faint">
                  {summary.model} · {new Date(summary.generatedAt).toLocaleString()}
                </p>
                <button type="button" onClick={generate} className="btn btn-secondary">
                  Regenerate
                </button>
              </div>
              {error && <p className="mt-2 text-[13px] text-error">{error}</p>}
            </div>

            {steps.length > 0 && (
              <div>
                <div className="mb-4 flex items-center justify-between">
                  <h2 className="eyebrow">Step by step</h2>
                  <span className="font-mono text-[11px] text-ink-faint">
                    {captionByIndex.size} of {steps.length} analyzed by {summary.model}
                  </span>
                </div>

                <ol className="flex flex-col">
                  {steps.map((step, i) => {
                    const captioned = captionByIndex.get(step.index);
                    const caption = captioned?.caption ?? step.description ?? step.type;
                    const reasoning = captioned?.reasoning;
                    const isLast = i === steps.length - 1;

                    return (
                      <li key={step.index} className="flex gap-3">
                        <div className="flex flex-col items-center">
                          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent-soft font-mono text-[11px] font-semibold text-accent">
                            {step.index + 1}
                          </span>
                          {!isLast && <div className="my-1 w-px flex-1 bg-edge-strong" aria-hidden />}
                        </div>

                        <div className={`min-w-0 flex-1 ${isLast ? "" : "pb-5"}`}>
                          <div className="card card-hover flex items-start gap-4 p-3.5">
                            {step.screenshot ? (
                              <button
                                type="button"
                                onClick={() => setExpandedStep(step)}
                                className="group relative shrink-0 overflow-hidden rounded-md border border-edge"
                                title="View what the model saw"
                              >
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img
                                  src={`/api/artifacts/${runId}/${step.screenshot}`}
                                  alt=""
                                  className="h-24 w-32 object-cover object-top transition-transform duration-150 group-hover:scale-105"
                                />
                                <span className="absolute inset-0 flex items-center justify-center bg-ink/0 opacity-0 transition-all duration-150 group-hover:bg-ink/40 group-hover:opacity-100">
                                  <EyeIcon className="text-white" />
                                </span>
                              </button>
                            ) : (
                              <div className="flex h-24 w-32 shrink-0 items-center justify-center rounded-md border border-dashed border-edge-strong bg-surface-2">
                                <span className="font-mono text-[9px] text-ink-faint">no frame</span>
                              </div>
                            )}
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <p className="text-[13px] font-medium text-ink">{caption}</p>
                                {step.replayOf !== undefined && (
                                  <span className="pill pill-done shrink-0">auto</span>
                                )}
                                {step.recordedAmbiguityWarning && (
                                  <span
                                    className="shrink-0 text-amber-600"
                                    title={step.recordedAmbiguityWarning}
                                    aria-label={step.recordedAmbiguityWarning}
                                  >
                                    ⚠
                                  </span>
                                )}
                              </div>
                              {step.recordedAmbiguityWarning && (
                                <p className="mt-1 text-[11px] text-amber-600">
                                  {step.recordedAmbiguityWarning}
                                </p>
                              )}
                              {reasoning && (
                                <div className="mt-2.5 border-l-2 border-edge-strong pl-2.5">
                                  <p className="eyebrow mb-1 text-[9px]">Model reasoning</p>
                                  <p className="font-mono text-[11px] leading-relaxed text-ink-faint">
                                    {reasoning}
                                  </p>
                                </div>
                              )}
                              {step.locator ? (
                                <p className="mt-2 font-mono text-[11px] text-accent/80">
                                  Target: {formatPlaywrightLocator(step.locator)}
                                </p>
                              ) : step.x !== undefined && step.y !== undefined ? (
                                <p className="mt-2 font-mono text-[11px] text-ink-faint">
                                  Target: ({step.x}, {step.y})
                                </p>
                              ) : null}
                              {step.driftSuggestion && (
                                <div className="mt-2.5 flex items-start gap-2.5 border-l-2 border-accent/40 pl-2.5">
                                  {step.driftSuggestion.candidatesScreenshot && (
                                    // eslint-disable-next-line @next/next/no-img-element
                                    <img
                                      src={`/api/artifacts/${runId}/${step.driftSuggestion.candidatesScreenshot}`}
                                      alt="Highlighted candidates the AI compared"
                                      className="h-14 w-20 shrink-0 rounded-md border border-edge object-cover object-top"
                                    />
                                  )}
                                  <div className="min-w-0">
                                    <div className="mb-1 flex items-center gap-1.5">
                                      <p className="eyebrow text-[9px] text-accent/70">AI suggestion</p>
                                      <span className="pill pill-queued text-[9px]">
                                        {step.driftSuggestion.confidence} confidence
                                      </span>
                                    </div>
                                    <p className="text-[11px] text-ink">{step.driftSuggestion.description}</p>
                                    <p className="mt-0.5 font-mono text-[10px] leading-relaxed text-ink-faint">
                                      {step.driftSuggestion.reasoning}
                                    </p>
                                  </div>
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ol>
              </div>
            )}
          </>
        ))}

      {section === "skillsmd" && (
        <div className="card overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
            <div className="flex items-start gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-ink-faint">
                <FileIcon />
              </span>
              <div>
                <h3 className="text-[13px] font-semibold text-ink">Export as skills.md</h3>
                <p className="mt-0.5 text-[13px] text-ink-muted">
                  A markdown spec of this flow, formatted for AI agents to read.
                </p>
              </div>
            </div>
            {skillsMd ? (
              <div className="flex shrink-0 items-center gap-2">
                <a
                  href={`/api/runs/${runId}/skills-md`}
                  download={`${slugify(skillName)}-skill.md`}
                  className="btn btn-primary"
                >
                  <DownloadIcon /> Download skills.md
                </a>
                <button
                  type="button"
                  onClick={generateSkillsMd}
                  disabled={skillsMdLoading}
                  className="btn btn-secondary"
                >
                  {skillsMdLoading ? "Regenerating…" : "Regenerate"}
                </button>
              </div>
            ) : summary ? (
              <button
                type="button"
                onClick={generateSkillsMd}
                disabled={skillsMdLoading}
                className="btn btn-secondary shrink-0"
              >
                {skillsMdLoading ? "Generating…" : "Generate skills.md"}
              </button>
            ) : (
              <span className="shrink-0 text-[12px] text-ink-faint">
                Generate a flow summary first
              </span>
            )}
          </div>
          {skillsMdError && <p className="px-5 pb-3 text-[13px] text-error">{skillsMdError}</p>}
          {skillsMd && (
            <div className="border-t border-edge">
              {hasSkillsMdChecklist ? (
                <>
                  <div className="flex items-center justify-between border-b border-edge bg-surface-2/60 px-4 py-2">
                    <span className="font-mono text-[11px] text-ink-faint">
                      <FileIcon small /> {slugify(skillName)}-skill.md — steps taken
                    </span>
                    <button
                      type="button"
                      onClick={() => setShowRawSkillsMd((v) => !v)}
                      className="font-mono text-[11px] font-medium text-ink-faint hover:text-accent"
                    >
                      {showRawSkillsMd ? "Hide raw markdown" : "View raw markdown"}
                    </button>
                  </div>
                  <ol className="divide-y divide-edge">
                    {summary.stepCaptions
                      .slice()
                      .sort((a, b) => a.index - b.index)
                      .map((caption, i) => {
                        const step = steps.find((s) => s.index === caption.index);
                        return (
                          <li key={caption.index} className="flex items-start gap-3 px-4 py-3">
                            <span className="mt-0.5 shrink-0 font-mono text-[11px] text-ink-faint">{i + 1}.</span>
                            <div className="min-w-0 flex-1">
                              <p className="text-[13px] text-ink">{caption.caption}</p>
                              {step?.locator ? (
                                <p className="mt-0.5 truncate font-mono text-[11px] text-ink-faint">
                                  Target: {formatPlaywrightLocator(step.locator)}
                                </p>
                              ) : step?.x !== undefined && step?.y !== undefined ? (
                                <p className="mt-0.5 font-mono text-[11px] text-ink-faint">
                                  Coordinates: ({step.x}, {step.y})
                                </p>
                              ) : null}
                            </div>
                            <span className="shrink-0">
                              <StatusBadge status={step?.status ?? "pending"} />
                            </span>
                          </li>
                        );
                      })}
                  </ol>
                </>
              ) : null}
              {(showRawSkillsMd || !hasSkillsMdChecklist) && (
                <>
                  <div
                    className={`flex items-center gap-2 border-edge bg-surface-2/60 px-4 py-2 font-mono text-[11px] text-ink-faint ${
                      hasSkillsMdChecklist ? "border-t border-b" : "border-b"
                    }`}
                  >
                    <FileIcon small /> {slugify(skillName)}-skill.md
                  </div>
                  <pre className="max-h-96 overflow-y-auto p-4 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-ink-muted">
                    {skillsMd}
                  </pre>
                </>
              )}
            </div>
          )}
        </div>
      )}

      {section === "test" && (
        <div className="flex flex-col gap-4">
          <div className="card flex flex-wrap items-center justify-between gap-3 p-5">
            <div>
              <h3 className="text-[13px] font-semibold text-ink">Test the skill</h3>
              <p className="mt-0.5 text-[13px] text-ink-muted">
                Auto-drive the recorded clicks/scrolls in a live browser session, pausing for you
                on any typing or drifted step. Test sessions don&apos;t appear in the skill&apos;s
                session history.
              </p>
              {testError && <p className="mt-1.5 text-[13px] text-error">{testError}</p>}
            </div>
            <div className="flex shrink-0 gap-2">
              <button
                type="button"
                onClick={() => startTest(false)}
                disabled={testing || !!testRunId}
                className="btn btn-secondary"
              >
                {testing || (testRunId && !gateIntoValidation.current)
                  ? testRunId
                    ? "Test running"
                    : "Starting…"
                  : "Start test session"}
              </button>
              <button
                type="button"
                onClick={() => startTest(true)}
                disabled={testing || !!testRunId}
                className="btn btn-primary"
                title="Only proceeds to alternative validation if this test run completes with zero errors"
              >
                {testing || (testRunId && gateIntoValidation.current)
                  ? testRunId
                    ? "Testing…"
                    : "Starting…"
                  : "Test & validate alternatives"}
              </button>
            </div>
          </div>
          {testRunId && (
            <div className="lg:h-[560px] lg:min-h-0">
              <LiveRunView runId={testRunId} />
            </div>
          )}
        </div>
      )}

      {section === "plan" && (
        <AlternativesPageClient
          runId={runId}
          projectId={projectId}
          skillId={skillId}
          promptId={promptId}
          steps={steps}
          initialVariantRuns={initialVariantRuns}
          initialPlansByStep={initialPlansByStep}
        />
      )}

      {section === "alternatives" && (
        <SkillActionGraph
          projectId={projectId}
          skillId={skillId}
          runId={runId}
          autoValidateSignal={autoValidateSignal}
          onAutoValidateConsumed={() => setAutoValidateSignal(undefined)}
          controlsSlot={alternativesControlsSlot}
        />
      )}

      {section === "agent" && (
        <SkillAgentPanel projectId={projectId} skillId={skillId} defaultStartUrl={startUrl} />
      )}

      <Modal
        open={expandedStep !== null}
        onClose={() => setExpandedStep(null)}
        title={expandedStep ? `What the model saw · step ${expandedStep.index + 1}` : undefined}
      >
        {expandedStep?.screenshot && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={`/api/artifacts/${runId}/${expandedStep.screenshot}`}
            alt=""
            className="w-full object-contain"
          />
        )}
      </Modal>
    </div>
  );
}

function FileIcon({ small = false }: { small?: boolean }) {
  const size = small ? 12 : 16;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg
      width={13}
      height={13}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 3v12" />
      <path d="m7 10 5 5 5-5" />
      <path d="M5 21h14" />
    </svg>
  );
}

function EyeIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      width={18}
      height={18}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}
