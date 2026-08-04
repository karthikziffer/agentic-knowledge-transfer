"use client";

import { useMemo, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  Handle,
  Position,
  type Node,
  type Edge,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import Spinner from "@/components/Spinner";
import { StatusBadge } from "@/components/LiveRunView";
import RunPreviewModal from "@/components/RunPreviewModal";
import DepthGoalEditor, { type DepthGoalRow } from "@/components/DepthGoalEditor";
import { useToast } from "@/components/Toast";
import type { AlternativePlan, AlternativesProgress, RunRecord } from "@/server/types";

const PLAN_NODE_WIDTH = 190;
// Generous enough to fit the root node's screenshot + label — other nodes
// (no screenshot, just a label) render shorter, just with a bit of extra
// breathing room in their reserved dagre slot.
const PLAN_NODE_HEIGHT = 90;

interface PlanNodeData extends Record<string, unknown> {
  label: string;
  reasoning?: string;
  imageUrl?: string;
  isRoot?: boolean;
  isTerminal?: boolean;
  planIndex?: number;
  planColor?: string;
  planNumber?: number;
}

// One color per spoke so a plan's whole chain — and the edges leading to
// it — reads as one path at a glance. Cycles if there are more plans than
// colors.
const PLAN_COLORS = ["#C97A2B", "#B5566B", "#2E7D6B", "#3E6BAE", "#7B5EA7", "#6B7F3A"];

// Same stroke-based line-icon style as Sidebar.tsx's icon set — a play
// triangle marking a plan's terminal (clickable-to-execute) node.
function PlayIcon() {
  return (
    <svg width={11} height={11} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}

function PlanNodeComponent({ data }: { data: PlanNodeData }) {
  return (
    <div className="relative w-[190px]">
      {/* Badge lives outside the clipped card below — the card's own
          overflow-hidden (needed to round off the screenshot image) would
          otherwise slice the badge into a quarter-circle at the corner. */}
      {!data.isRoot && data.planColor && data.planNumber !== undefined && (
        <span
          className="absolute -left-1.5 -top-1.5 z-10 flex h-4 w-4 items-center justify-center rounded-full text-[9px] font-bold text-white shadow-sm"
          style={{ background: data.planColor }}
        >
          {data.planNumber}
        </span>
      )}
      <div
        className={`flex w-full flex-col items-center overflow-hidden rounded-xl shadow-sm ${
          data.isRoot
            ? "border-2 border-accent shadow-md"
            : data.isTerminal
              ? "border border-accent/60"
              : "border border-edge"
        }`}
        // Dynamic per-plan hex can't be expressed as a Tailwind class (JIT
        // only picks up statically-analyzable class names), hence inline style.
        style={
          !data.isRoot && !data.isTerminal && data.planColor
            ? { borderColor: `${data.planColor}66` }
            : undefined
        }
      >
        <Handle type="target" position={Position.Left} className="!border-none !bg-ink-faint" />
        {data.imageUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={data.imageUrl}
            alt=""
            className="h-[54px] w-full object-cover object-top"
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.display = "none";
            }}
          />
        )}
        <div
          className={`flex w-full flex-col items-center gap-1 px-3 py-2 text-center ${
            data.isRoot ? "bg-accent-soft" : "bg-surface"
          }`}
        >
          <p
            className={`w-full truncate text-[11px] ${data.isRoot ? "font-semibold text-accent" : "text-ink"}`}
            title={data.reasoning ? `${data.label} — ${data.reasoning}` : data.label}
          >
            {data.label}
          </p>
          {data.isTerminal && (
            <span className="flex items-center gap-1 text-[10px] font-medium text-accent">
              <PlayIcon />
              Run this plan
            </span>
          )}
        </div>
        <Handle type="source" position={Position.Right} className="!border-none !bg-ink-faint" />
      </div>
    </div>
  );
}

const nodeTypes = { planNode: PlanNodeComponent };

const RANK_GAP_X = 230;
const PLAN_GAP_Y = 110;

// Every plan renders as its own independent chain from the root — plans
// don't share visual prefixes even when they happen to start with the same
// first hop, since the depth-goal search (src/server/alternativesAgent.ts)
// doesn't guarantee a deeper plan's earlier hops were themselves ever
// counted as their own shallower plan (a depth-1 bucket can fill up before
// a depth-2 branch through the same first hop gets explored) — merging
// would sometimes misrepresent the data.
//
// Layout is a hand-rolled radial fan rather than dagre's ranked tree: the
// root sits at the hub, each plan claims a vertical slot symmetric around
// it, and a hop's y eases toward that slot's full offset (1 - 0.55^hop)
// instead of jumping straight there — early hops across plans start close
// together and spread out over subsequent hops, like spokes opening out of
// a wheel rather than parallel rail tracks.
function buildPlanFlowGraph(
  plans: AlternativePlan[],
  runId: string,
  rootScreenshot: string | undefined,
): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [
    {
      id: "root",
      type: "planNode",
      position: { x: -PLAN_NODE_WIDTH / 2, y: -PLAN_NODE_HEIGHT / 2 },
      data: {
        label: "Recorded step",
        isRoot: true,
        imageUrl: rootScreenshot ? `/api/artifacts/${runId}/${rootScreenshot}` : undefined,
      } satisfies PlanNodeData,
    },
  ];
  const edges: Edge[] = [];

  const centerSlot = (plans.length - 1) / 2;

  plans.forEach((plan, planIndex) => {
    const color = PLAN_COLORS[planIndex % PLAN_COLORS.length];
    const slotY = (planIndex - centerSlot) * PLAN_GAP_Y;
    let prevId = "root";

    plan.steps.forEach((hop, hopIndex) => {
      const nodeId = `plan-${planIndex}-hop-${hopIndex}`;
      const isTerminal = hopIndex === plan.steps.length - 1;
      const spread = 1 - Math.pow(0.55, hopIndex + 1);
      const x = (hopIndex + 1) * RANK_GAP_X;
      const y = slotY * spread;

      nodes.push({
        id: nodeId,
        type: "planNode",
        position: { x: x - PLAN_NODE_WIDTH / 2, y: y - PLAN_NODE_HEIGHT / 2 },
        data: {
          label: isTerminal ? plan.finalDescription : hop.description,
          reasoning: hop.reasoning,
          isTerminal,
          planIndex,
          planColor: color,
          planNumber: planIndex + 1,
        } satisfies PlanNodeData,
      });
      edges.push({
        id: `${prevId}->${nodeId}`,
        source: prevId,
        target: nodeId,
        type: "default",
        animated: false,
        style: { stroke: color, strokeWidth: 1.75 },
      });
      prevId = nodeId;
    });
  });

  return { nodes, edges };
}

function progressLabel(progress: AlternativesProgress | null): string {
  if (!progress) return "Queued — waiting for a worker to pick this up…";
  if (progress.phase === "loading-context") return "Reading the flow's goal…";
  return `Exploring the site — ${progress.visited} page${progress.visited === 1 ? "" : "s"} visited, ${
    progress.plansFound
  } plan${progress.plansFound === 1 ? "" : "s"} found so far…`;
}

// Surfaces the alternative-plan pipeline's output (src/server/
// alternativesAgent.ts — depth-goal-directed multi-hop exploration, run
// once and cached) as one combined branching graph: the recorded step's
// page as the root, every plan fanning out as its own path, click a plan's
// terminal node to actually execute it.
export default function AlternativeSuggestions({
  runId,
  projectId,
  skillId,
  promptId,
  stepIndex,
  existing,
  initialPlans,
  initialModel,
  initialDepthGoals,
  initialRootScreenshot,
  onGenerated,
}: {
  runId: string;
  projectId: string;
  skillId: string;
  promptId: string;
  stepIndex: number;
  existing: RunRecord[];
  initialPlans: AlternativePlan[] | null;
  initialModel?: string;
  initialDepthGoals?: DepthGoalRow[];
  // Artifact filename (this run's own id) for the target step's own page
  // screenshot, captured once while planning.
  initialRootScreenshot?: string;
  onGenerated: (runId: string, planLabel: string) => void;
}) {
  const toast = useToast();
  const [plans, setPlans] = useState(initialPlans);
  const [model, setModel] = useState(initialModel);
  const [rootScreenshot, setRootScreenshot] = useState(initialRootScreenshot);
  const [depthGoalRows, setDepthGoalRows] = useState<DepthGoalRow[]>(
    initialDepthGoals?.length ? initialDepthGoals : [{ depth: 1, goal: 3 }],
  );
  const [generating, setGenerating] = useState(false);
  const [genProgress, setGenProgress] = useState<AlternativesProgress | null>(null);
  const [genError, setGenError] = useState<string | null>(null);
  const [executingPlanIndex, setExecutingPlanIndex] = useState<number | null>(null);
  const [executeError, setExecuteError] = useState<string | null>(null);
  const [viewingRunId, setViewingRunId] = useState<string | null>(null);

  const { flowNodes, flowEdges } = useMemo(() => {
    if (!plans) return { flowNodes: [] as Node[], flowEdges: [] as Edge[] };
    const { nodes, edges } = buildPlanFlowGraph(plans, runId, rootScreenshot);
    return { flowNodes: nodes, flowEdges: edges };
  }, [plans, runId, rootScreenshot]);

  // The route streams newline-delimited JSON (a "progress" line per page
  // visited while planning, then one "done" or "error" line) instead of a
  // single Response.json — same shape as FlowSummaryView's own streaming
  // endpoints, and for the same reason: this can take a while (a real
  // browser exploring multiple pages, two LLM calls per page visited).
  async function generatePlans() {
    setGenerating(true);
    setGenError(null);
    setGenProgress(null);
    try {
      const res = await fetch(`/api/runs/${runId}/alternatives/suggest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stepIndex, depthGoals: depthGoalRows }),
      });
      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "Failed to plan alternatives");
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let done: { plans: AlternativePlan[]; rootScreenshot?: string } | null = null;
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
            | { type: "done"; plans: AlternativePlan[]; rootScreenshot?: string }
            | { type: "error"; error: string };
          if (msg.type === "progress") setGenProgress(msg.progress);
          else if (msg.type === "done") done = msg;
          else if (msg.type === "error") streamError = msg.error;
        }
      }

      if (streamError) throw new Error(streamError);
      if (!done) throw new Error("Failed to plan alternatives");
      setPlans(done.plans);
      setRootScreenshot(done.rootScreenshot);
      setModel(undefined);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to plan alternatives";
      setGenError(message);
      toast.error(message);
    } finally {
      setGenerating(false);
      setGenProgress(null);
    }
  }

  async function executePlan(planIndex: number) {
    setExecutingPlanIndex(planIndex);
    setExecuteError(null);
    try {
      const res = await fetch(`/api/runs/${runId}/variations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stepIndex, planIndex }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Failed to execute this plan");
      const plan = plans?.[planIndex];
      const label = plan ? plan.steps.map((s) => s.description).join(" → ") : "plan";
      onGenerated(body.runId as string, label);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to execute this plan";
      setExecuteError(message);
      toast.error(message);
    } finally {
      setExecutingPlanIndex(null);
    }
  }

  if (!plans) {
    return (
      <div className="flex flex-col gap-3">
        <DepthGoalEditor
          rows={depthGoalRows}
          onChange={setDepthGoalRows}
          title="Plan depth goals"
          infoText={
            "Depth = how many real clicks the plan is (1 = single-step, matching what used to be a plain " +
            "\"alternative click\"; 2 = double-step; 3 = triple-step, ...). Goal = how many genuinely " +
            "distinct plans at that depth to look for — two plans that land on the same final page are " +
            "treated as the same plan, only the first is kept."
          }
          emptyStateText="Add at least one depth goal to plan alternatives — e.g. 3 single-step, 2 double-step."
        />
        <div>
          <button
            type="button"
            onClick={generatePlans}
            disabled={generating || depthGoalRows.length === 0}
            className="btn btn-secondary"
          >
            {generating ? "Planning…" : "Plan alternatives"}
          </button>
          {generating && <p className="mt-1.5 text-[11px] text-ink-faint">{progressLabel(genProgress)}</p>}
          {genError && <p className="mt-1.5 text-[11px] text-error">{genError}</p>}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <span className="truncate font-mono text-[10px] text-ink-faint">
          {plans.length} plan{plans.length === 1 ? "" : "s"} found{model ? ` · ${model}` : ""}
        </span>
        <button
          type="button"
          onClick={() => setPlans(null)}
          disabled={generating}
          className="shrink-0 text-[11px] font-medium text-accent hover:underline disabled:opacity-50"
        >
          Plan again
        </button>
      </div>
      {executeError && <p className="text-[11px] text-error">{executeError}</p>}

      <div className="card h-[320px] overflow-hidden p-0">
        <ReactFlow
          nodes={flowNodes}
          edges={flowEdges}
          nodeTypes={nodeTypes}
          onNodeClick={(_, node) => {
            const data = node.data as PlanNodeData;
            if (!data.isTerminal || data.planIndex === undefined) return;
            if (executingPlanIndex !== null) return;
            void executePlan(data.planIndex);
          }}
          fitView
          proOptions={{ hideAttribution: true }}
        >
          <Background />
          <Controls />
        </ReactFlow>
      </div>

      {executingPlanIndex !== null && (
        <p className="flex items-center gap-2 text-[12px] text-ink-faint">
          <Spinner />
          Starting a run for this plan…
        </p>
      )}

      {existing.length > 0 && (
        <div>
          <h5 className="eyebrow mb-1.5">Generated so far</h5>
          <ul className="flex flex-col gap-1.5">
            {existing.map((run) => (
              <li
                key={run.id}
                className="card card-hover flex items-center justify-between gap-3 p-2.5 text-[12px]"
              >
                <span className="min-w-0 flex-1 truncate text-ink">{run.variantLabel ?? "Alternative"}</span>
                <div className="flex shrink-0 items-center gap-2">
                  {run.status === "queued" ? (
                    <span className="flex items-center gap-1.5 text-ink-faint">
                      <Spinner />
                      Queued…
                    </span>
                  ) : (
                    <StatusBadge status={run.status} />
                  )}
                  <button
                    type="button"
                    onClick={() => setViewingRunId(run.id)}
                    className="font-medium text-accent hover:underline"
                  >
                    View
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
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
