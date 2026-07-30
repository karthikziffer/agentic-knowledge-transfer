"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  type Node,
  type Edge,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import dagre from "@dagrejs/dagre";
import EmptyState from "@/components/EmptyState";
import LiveRunView from "@/components/LiveRunView";
import { useToast } from "@/components/Toast";
import type { ElementLocator } from "@/server/types";

interface GraphNode {
  url: string;
  description: string;
  screenshotArtifact?: string;
  screenshotRunId?: string;
}

interface GraphEdge {
  fromUrl: string;
  toUrl: string;
  description: string;
  role: string;
  status: "explored" | "unexplored";
  autoFollowed: boolean;
  locator: ElementLocator;
  lastValidationStatus?: "passed" | "failed";
  lastValidatedAt?: string;
  lastValidationError?: string;
}

// Shared shape for whatever's currently shown in the details panel — a
// GraphEdge (clicked in the canvas) always has autoFollowed, so it's optional
// here rather than forcing every caller to fake a value.
interface SelectedAction {
  fromUrl: string;
  toUrl: string;
  description: string;
  role: string;
  status: "explored" | "unexplored";
  locator: ElementLocator;
  autoFollowed?: boolean;
  lastValidationStatus?: "passed" | "failed";
  lastValidatedAt?: string;
  lastValidationError?: string;
}

const UNEXPLORED_URL = "__unexplored__";
// How often to poll the crawl run's status while it's in progress — cheap
// enough for a background poll, frequent enough that "Build graph" doesn't
// feel stuck (same interval AlternativesPageClient uses for variant runs).
const POLL_MS = 2000;

// Client-side mirror of src/server/skillsMd.ts's formatPlaywrightLocator —
// same reasoning as the copy already in FlowSummaryView.tsx: kept in sync by
// hand rather than importing the server module into the client bundle.
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

function hostAndPath(url: string): string {
  if (url === UNEXPLORED_URL) return "Not yet explored";
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname}`.replace(/\/$/, "") || u.hostname;
  } catch {
    return url;
  }
}

// Validation status (once present) is the freshest, most concrete signal —
// it wins over the explored/unexplored styling, which only describes how
// the crawler discovered the action, not whether it actually still works.
function edgeColor(e: GraphEdge): string {
  if (e.lastValidationStatus === "passed") return "var(--color-done)";
  if (e.lastValidationStatus === "failed") return "var(--color-error)";
  return e.status === "explored" ? "var(--color-accent)" : "var(--color-ink-faint)";
}

// Worst-case color for a whole group of collapsed (unexplored) actions — any
// failure anywhere in the group is the thing worth noticing at a glance.
function stubColor(actions: GraphEdge[]): string {
  if (actions.some((a) => a.lastValidationStatus === "failed")) return "var(--color-error)";
  if (actions.length > 0 && actions.every((a) => a.lastValidationStatus === "passed")) return "var(--color-done)";
  return "var(--color-ink-faint)";
}

interface PageNodeData extends Record<string, unknown> {
  description: string;
  imageUrl?: string;
}

interface StubNodeData extends Record<string, unknown> {
  actions: GraphEdge[];
}

const PAGE_NODE_WIDTH = 200;
const PAGE_NODE_HEIGHT = 130;
const STUB_NODE_WIDTH = 170;
const STUB_NODE_HEIGHT = 52;

// Turns the server's flat node/edge list into what actually gets drawn —
// the one structural change that matters most for readability: every action
// that doesn't lead anywhere real (toUrl === the shared UNEXPLORED_URL
// placeholder) used to become its own edge, and since EVERY such action
// across the WHOLE graph pointed at that one shared node, the canvas turned
// into a tangle all converging on one point. Instead, each source page gets
// its OWN small local stub node collecting just its own uninvestigated
// actions — short edges, no cross-canvas convergence.
//
// The same treatment now also applies to a *real*, distinctly-URLed
// destination that was merely discovered (an auto-followed link's target
// gets a PageState node the instant the link is found — see
// ensurePageStateExists/upsertAction in actionGraph.ts) but never actually
// visited (no screenshot) — a crawl's page budget or an interrupted run
// leaves plenty of these. Without this, every one of them rendered as its
// own full-size "no preview" node, since it has a real distinct URL rather
// than the shared placeholder and so never collapsed on its own.
function buildFlowGraph(nodes: GraphNode[], edges: GraphEdge[]): { flowNodes: Node[]; flowEdges: Edge[] } {
  const unvisitedUrls = new Set(
    nodes.filter((n) => n.url !== UNEXPLORED_URL && !n.screenshotArtifact).map((n) => n.url),
  );
  const isStubWorthy = (url: string) => url === UNEXPLORED_URL || unvisitedUrls.has(url);

  const realNodes = nodes.filter((n) => !isStubWorthy(n.url));
  const realEdges = edges.filter((e) => !isStubWorthy(e.toUrl));

  const collapsedBySource = new Map<string, GraphEdge[]>();
  for (const e of edges) {
    if (!isStubWorthy(e.toUrl)) continue;
    const list = collapsedBySource.get(e.fromUrl) ?? [];
    list.push(e);
    collapsedBySource.set(e.fromUrl, list);
  }

  const flowNodes: Node[] = realNodes.map((n) => ({
    id: n.url,
    type: "pageNode",
    position: { x: 0, y: 0 },
    data: {
      description: n.description,
      imageUrl:
        n.screenshotArtifact && n.screenshotRunId
          ? `/api/artifacts/${n.screenshotRunId}/${n.screenshotArtifact}`
          : undefined,
    } satisfies PageNodeData,
  }));

  const flowEdges: Edge[] = realEdges.map((e, i) => ({
    id: `${e.fromUrl}->${e.toUrl}->${i}`,
    source: e.fromUrl,
    target: e.toUrl,
    type: "smoothstep",
    animated: e.status === "unexplored" && !e.lastValidationStatus,
    data: { action: e },
    style: { stroke: edgeColor(e), strokeWidth: e.lastValidationStatus ? 2 : 1 },
  }));

  for (const [fromUrl, actions] of collapsedBySource) {
    const stubId = `stub:${fromUrl}`;
    flowNodes.push({
      id: stubId,
      type: "stubNode",
      position: { x: 0, y: 0 },
      data: { actions } satisfies StubNodeData,
    });
    flowEdges.push({
      id: `${fromUrl}->${stubId}`,
      source: fromUrl,
      target: stubId,
      type: "smoothstep",
      style: {
        stroke: stubColor(actions),
        strokeDasharray: actions.every((a) => !a.lastValidationStatus) ? "4 3" : undefined,
      },
    });
  }

  return { flowNodes, flowEdges };
}

// dagre positions by actual graph structure (rankdir "LR": start page on the
// left, pages flowing rightward by crawl depth) instead of the previous
// sqrt-grid, which placed nodes in raw Cypher result order with no relation
// to the site's real structure — that mismatch was the other major source of
// edges crossing everywhere.
function layoutWithDagre(flowNodes: Node[], flowEdges: Edge[]): Node[] {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "LR", nodesep: 36, ranksep: 90 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of flowNodes) {
    const isStub = n.type === "stubNode";
    g.setNode(n.id, {
      width: isStub ? STUB_NODE_WIDTH : PAGE_NODE_WIDTH,
      height: isStub ? STUB_NODE_HEIGHT : PAGE_NODE_HEIGHT,
    });
  }
  for (const e of flowEdges) {
    if (typeof e.source === "string" && typeof e.target === "string") g.setEdge(e.source, e.target);
  }
  dagre.layout(g);
  return flowNodes.map((n) => {
    const pos = g.node(n.id);
    const isStub = n.type === "stubNode";
    const width = isStub ? STUB_NODE_WIDTH : PAGE_NODE_WIDTH;
    const height = isStub ? STUB_NODE_HEIGHT : PAGE_NODE_HEIGHT;
    return pos ? { ...n, position: { x: pos.x - width / 2, y: pos.y - height / 2 } } : n;
  });
}

// Custom node renderers — registered once at module scope (not recreated
// per-render) via the `nodeTypes` map below, as React Flow requires.
function PageNodeComponent({ data }: { data: PageNodeData }) {
  return (
    <div className="w-[200px] overflow-hidden rounded-lg border border-edge bg-surface shadow-sm">
      <Handle type="target" position={Position.Left} className="!border-none !bg-ink-faint" />
      {data.imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={data.imageUrl}
          alt=""
          className="h-[90px] w-full object-cover object-top"
          onError={(e) => {
            (e.currentTarget as HTMLImageElement).style.visibility = "hidden";
          }}
        />
      ) : (
        <div className="flex h-[90px] w-full items-center justify-center bg-surface-2 text-[10px] text-ink-faint">
          no preview
        </div>
      )}
      <div className="truncate px-2 py-1.5 text-[11px] text-ink" title={data.description}>
        {data.description}
      </div>
      <Handle type="source" position={Position.Right} className="!border-none !bg-ink-faint" />
    </div>
  );
}

function StubNodeComponent({ data }: { data: StubNodeData }) {
  const total = data.actions.length;
  const passed = data.actions.filter((a) => a.lastValidationStatus === "passed").length;
  const failed = data.actions.filter((a) => a.lastValidationStatus === "failed").length;
  const unvalidated = total - passed - failed;
  return (
    <div className="flex w-[170px] flex-col items-center gap-1 rounded-lg border border-dashed border-edge-strong bg-surface-2 px-2 py-2 text-center text-[11px] text-ink-faint">
      <Handle type="target" position={Position.Left} className="!border-none !bg-ink-faint" />
      <span>
        {total} action{total === 1 ? "" : "s"} here
      </span>
      <span className="flex gap-2 font-mono text-[10px]">
        {passed > 0 && <span className="text-[var(--color-done)]">{passed} ok</span>}
        {failed > 0 && <span className="text-error">{failed} failed</span>}
        {unvalidated > 0 && <span>{unvalidated} unknown</span>}
      </span>
    </div>
  );
}

const nodeTypes = { pageNode: PageNodeComponent, stubNode: StubNodeComponent };

function validationScore(edges: GraphEdge[]): { passed: number; failed: number; unvalidated: number } {
  let passed = 0;
  let failed = 0;
  for (const e of edges) {
    if (e.lastValidationStatus === "passed") passed++;
    else if (e.lastValidationStatus === "failed") failed++;
  }
  return { passed, failed, unvalidated: edges.length - passed - failed };
}

export default function SkillActionGraph({
  projectId,
  skillId,
  runId,
  autoValidateSignal,
  onAutoValidateConsumed,
  controlsSlot,
}: {
  projectId: string;
  skillId: string;
  // The source run whose "Create alternatives" tab this is — the action
  // graph is scoped per run (RunRecord.graphRunId, written by crawlTask/
  // validateTask in src/server/actionGraph.ts), not shared across every run
  // under the skill, so switching to a different run always starts from
  // that run's own (possibly still-empty) graph.
  runId: string;
  // Set (to any defined value) by FlowSummaryView once "Test the skill"
  // completes cleanly — triggers a validation run automatically. Ownership
  // of "has this already fired" deliberately lives in the *parent*, not a
  // ref here comparing against a previous value: this component unmounts
  // and remounts every time the section tab switches away from and back to
  // "alternatives" (see FlowSummaryView's `{section === "alternatives" && ...}`
  // conditional render), and the section switch + signal set happen in the
  // same render batch — so on the mount that matters, this component would
  // already see the "new" value as its very first value, making a
  // ref-initialized-to-current-prop comparison always read as "unchanged."
  // The parent calling onAutoValidateConsumed() to reset the signal back to
  // undefined right after this fires is what makes it one-shot instead.
  autoValidateSignal?: number;
  onAutoValidateConsumed?: () => void;
  // DOM node (owned by FlowSummaryView, set once its ref callback fires) to
  // portal the Validate/Refresh/score controls into, so they render inside
  // the run header's shared row instead of this component's own card. Falls
  // back to rendering inline (e.g. briefly undefined before the parent's ref
  // callback fires) so nothing breaks if it's ever absent.
  controlsSlot?: HTMLDivElement | null;
}) {
  const toast = useToast();
  const [graph, setGraph] = useState<{ nodes: GraphNode[]; edges: GraphEdge[] } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [crawlRunId, setCrawlRunId] = useState<string | null>(null);
  const [crawlError, setCrawlError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [validateRunId, setValidateRunId] = useState<string | null>(null);
  const [validateError, setValidateError] = useState<string | null>(null);
  const [validateStarting, setValidateStarting] = useState(false);
  // How many cataloged actions to actually run — null until the user
  // touches the field, at which point it defaults to "all" (see the input's
  // `value` below). Kept separate from a plain number so "the user hasn't
  // chosen a smaller count yet" is distinguishable from "the user chose the
  // full count."
  const [validateCount, setValidateCount] = useState<number | null>(null);
  const [selected, setSelected] = useState<SelectedAction | null>(null);
  // Set when a stub node ("N actions here") is clicked instead of a single
  // edge — mutually exclusive with `selected`, see selectAction/selectGroup.
  const [selectedGroup, setSelectedGroup] = useState<GraphEdge[] | null>(null);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const validatePollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const graphUrl = `/api/projects/${projectId}/skills/${skillId}/graph?runId=${runId}`;

  const loadGraph = useCallback(async () => {
    try {
      const res = await fetch(graphUrl);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Failed to load graph");
      setGraph(body);
      setLoadError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load graph";
      setLoadError(message);
      toast.error(message);
    }
  }, [graphUrl, toast]);

  useEffect(() => {
    // Deferred via setTimeout rather than calling the (setState-triggering)
    // async loadGraph() directly in the effect body — same "state updates
    // happen inside a nested timer callback, not synchronously in the
    // effect itself" shape AlternativesPageClient's polling effect uses.
    const timer = setTimeout(loadGraph, 0);
    return () => clearTimeout(timer);
  }, [loadGraph]);

  // Polls the crawl run's status while one is active, refetching the graph
  // and clearing crawlRunId once it reaches a terminal state — same
  // "queued"/"running" polling pattern AlternativesPageClient uses for
  // variant runs, just against the single crawl run instead of a list. Also
  // refetches the graph on every still-running tick (not just at the end) —
  // the crawler discovers/visits pages incrementally, so this is what makes
  // new nodes/edges actually appear while a long crawl is still going,
  // rather than the canvas looking frozen until it finishes or gets stuck.
  useEffect(() => {
    if (!crawlRunId) return;
    let cancelled = false;

    async function poll() {
      try {
        const res = await fetch(`/api/runs/${crawlRunId}`);
        const body = await res.json();
        const status = body?.record?.status as string | undefined;
        if (cancelled) return;
        if (status === "completed" || status === "error") {
          if (status === "error") {
            const message = body.record.error ?? "Crawl failed";
            setCrawlError(message);
            toast.error(message);
          }
          setCrawlRunId(null);
          await loadGraph();
          return;
        }
        await loadGraph();
      } catch {
        // transient — keep polling
      }
      pollTimer.current = setTimeout(poll, POLL_MS);
    }
    poll();

    return () => {
      cancelled = true;
      if (pollTimer.current) clearTimeout(pollTimer.current);
    };
  }, [crawlRunId, loadGraph, toast]);

  // Same polling shape as the crawl effect above, against the validate run
  // instead — refetches the graph on every tick so edge colors/scores pick
  // up freshly-written lastValidationStatus values as validation progresses,
  // not just once the whole run finishes.
  useEffect(() => {
    if (!validateRunId) return;
    let cancelled = false;

    async function poll() {
      try {
        const res = await fetch(`/api/runs/${validateRunId}`);
        const body = await res.json();
        const status = body?.record?.status as string | undefined;
        if (cancelled) return;
        if (status === "completed" || status === "error") {
          if (status === "error") {
            const message = body.record.error ?? "Validation failed";
            setValidateError(message);
            toast.error(message);
          }
          setValidateRunId(null);
          await loadGraph();
          return;
        }
        await loadGraph();
      } catch {
        // transient — keep polling
      }
      validatePollTimer.current = setTimeout(poll, POLL_MS);
    }
    poll();

    return () => {
      cancelled = true;
      if (validatePollTimer.current) clearTimeout(validatePollTimer.current);
    };
  }, [validateRunId, loadGraph, toast]);

  async function startCrawl() {
    setStarting(true);
    setCrawlError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/skills/${skillId}/graph/crawl`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Failed to start crawl");
      setCrawlRunId(body.runId as string);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to start crawl";
      setCrawlError(message);
      toast.error(message);
    } finally {
      setStarting(false);
    }
  }

  const startValidate = useCallback(async () => {
    setValidateStarting(true);
    setValidateError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/skills/${skillId}/graph/validate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ count: validateCount ?? undefined, runId }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Failed to start validation");
      setValidateRunId(body.runId as string);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to start validation";
      setValidateError(message);
      toast.error(message);
    } finally {
      setValidateStarting(false);
    }
  }, [projectId, skillId, runId, validateCount, toast]);

  // Fires startValidate() whenever FlowSummaryView sets autoValidateSignal
  // after a clean test pass, then immediately tells the parent to reset it
  // back to undefined — see the prop's doc comment above for why "one-shot"
  // has to be parent-owned rather than compared against a ref here.
  useEffect(() => {
    if (autoValidateSignal === undefined) return;
    // Deferred via setTimeout — same "state updates happen inside a nested
    // timer callback, not synchronously in the effect itself" reasoning as
    // the initial loadGraph() effect above. Applies to onAutoValidateConsumed
    // too, since it resets state one level up in FlowSummaryView.
    const timer = setTimeout(() => {
      onAutoValidateConsumed?.();
      startValidate();
    }, 0);
    return () => clearTimeout(timer);
  }, [autoValidateSignal, onAutoValidateConsumed, startValidate]);

  const hasGraph = graph && graph.nodes.length > 0;

  const { flowNodes, flowEdges } = useMemo(() => {
    const built = buildFlowGraph(graph?.nodes ?? [], graph?.edges ?? []);
    return { flowNodes: layoutWithDagre(built.flowNodes, built.flowEdges), flowEdges: built.flowEdges };
  }, [graph]);

  const totalActions = graph?.edges.length ?? 0;
  // Clamped so a stale count from before a "Refresh graph" (which can
  // shrink or grow the total) never silently requests more actions than
  // currently exist.
  const effectiveValidateCount = Math.min(validateCount ?? totalActions, totalActions);

  // Validate/Refresh/score controls — normally portaled into FlowSummaryView's
  // shared header row (alongside the hostname/step-count/duration pills and
  // Delete button) via `controlsSlot`; rendered inline here as a fallback so
  // nothing's lost if the slot hasn't mounted yet.
  const controls = (
    <>
      {hasGraph && (
        <div className="flex shrink-0 items-center gap-1.5 text-[13px]">
          <label htmlFor="validate-count" className="text-ink-faint">
            Validate
          </label>
          <input
            id="validate-count"
            type="number"
            min={1}
            max={totalActions}
            value={effectiveValidateCount}
            onChange={(e) => {
              const next = Number(e.target.value);
              setValidateCount(Number.isFinite(next) ? Math.max(1, Math.min(totalActions, Math.trunc(next))) : 1);
            }}
            disabled={validateStarting || validateRunId !== null || crawlRunId !== null}
            className="input w-14 px-1.5 text-center"
          />
          <span className="text-ink-faint">of {totalActions}</span>
        </div>
      )}
      {hasGraph && (
        <button
          type="button"
          onClick={startValidate}
          disabled={validateStarting || validateRunId !== null || crawlRunId !== null}
          className="btn btn-secondary shrink-0"
          title="Actually executes the selected number of cataloged actions, including buttons/forms the crawler never auto-clicks"
        >
          {validateStarting ? "Starting…" : validateRunId ? "Validating…" : "Validate alternatives"}
        </button>
      )}
      <button
        type="button"
        onClick={startCrawl}
        disabled={starting || crawlRunId !== null}
        className="btn btn-primary shrink-0"
      >
        {starting ? "Starting…" : crawlRunId ? "Crawling…" : hasGraph ? "Refresh graph" : "Build graph"}
      </button>

      {hasGraph && !crawlRunId && !validateRunId && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 text-[13px]">
          {(() => {
            const score = validationScore(graph.edges);
            return (
              <>
                <span className="font-medium text-ink">Validation score:</span>
                <span className="pill pill-done">{score.passed} passed</span>
                {score.failed > 0 && <span className="pill pill-error">{score.failed} failed</span>}
                {score.unvalidated > 0 && (
                  <span className="pill pill-queued">{score.unvalidated} not yet validated</span>
                )}
              </>
            );
          })()}
        </div>
      )}
    </>
  );

  return (
    <div className="flex flex-col gap-4">
      {controlsSlot ? (
        createPortal(controls, controlsSlot)
      ) : (
        <div className="card flex flex-wrap items-center gap-3 p-5">{controls}</div>
      )}

      {(crawlError || validateError) && (
        <div className="card flex flex-col gap-1.5 p-5">
          {crawlError && <p className="text-[13px] text-error">{crawlError}</p>}
          {validateError && <p className="text-[13px] text-error">{validateError}</p>}
        </div>
      )}

      {crawlRunId && (
        <div className="lg:h-[420px] lg:min-h-0">
          <LiveRunView runId={crawlRunId} endControl="stop" />
        </div>
      )}

      {validateRunId && (
        <div className="lg:h-[420px] lg:min-h-0">
          <LiveRunView runId={validateRunId} endControl="stop" />
        </div>
      )}

      {loadError && <p className="text-[13px] text-error">{loadError}</p>}

      {!hasGraph && !crawlRunId ? (
        <EmptyState
          title="No graph yet"
          description="Build the action graph to see every page and action discovered for this skill."
        />
      ) : hasGraph ? (
        <div className="grid gap-4 lg:grid-cols-[1fr_280px]">
            <div className="card h-[520px] overflow-hidden p-0">
              <ReactFlow
                nodes={flowNodes}
                edges={flowEdges}
                nodeTypes={nodeTypes}
                onEdgeClick={(_, edge) => {
                  const action = (edge.data as { action?: GraphEdge } | undefined)?.action;
                  if (!action) return;
                  setSelected(action);
                  setSelectedGroup(null);
                }}
                onNodeClick={(_, node) => {
                  if (node.type !== "stubNode") return;
                  const actions = (node.data as StubNodeData).actions;
                  setSelectedGroup(actions);
                  setSelected(null);
                }}
                fitView
                proOptions={{ hideAttribution: true }}
              >
                <Background />
                <Controls />
                <MiniMap pannable zoomable />
              </ReactFlow>
            </div>

            <div className="card flex h-[520px] flex-col p-0">
              <h4 className="eyebrow shrink-0 px-4 pt-4 pb-2">Details</h4>
              <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
              {selected ? (
                <div className="flex flex-col gap-2 text-[12px]">
                  <p className="font-medium text-ink">{selected.description}</p>
                  <p className="text-ink-faint">
                    {selected.status}
                    {selected.autoFollowed ? ", auto-followed" : ""} · role: {selected.role}
                  </p>
                  <p className="break-words text-ink-muted">
                    From: {hostAndPath(selected.fromUrl)}
                  </p>
                  <p className="break-words text-ink-muted">To: {hostAndPath(selected.toUrl)}</p>
                  <p className="mt-1 font-mono text-[11px] break-words text-accent/80">
                    {formatPlaywrightLocator(selected.locator)}
                  </p>
                  {selected.lastValidationStatus && (
                    <div className="mt-1 border-t border-edge pt-2">
                      <p
                        className={
                          selected.lastValidationStatus === "passed"
                            ? "font-medium text-[var(--color-done)]"
                            : "font-medium text-error"
                        }
                      >
                        Last validated: {selected.lastValidationStatus}
                      </p>
                      {selected.lastValidatedAt && (
                        <p className="text-ink-faint">
                          {new Date(selected.lastValidatedAt).toLocaleString()}
                        </p>
                      )}
                      {selected.lastValidationError && (
                        <p className="mt-1 text-ink-muted">{selected.lastValidationError}</p>
                      )}
                    </div>
                  )}
                </div>
              ) : selectedGroup ? (
                <ol className="flex flex-col gap-1.5">
                  {selectedGroup.map((action, i) => (
                    <li key={i}>
                      <button
                        type="button"
                        onClick={() => {
                          setSelected(action);
                          setSelectedGroup(null);
                        }}
                        className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1 text-left text-[12px] hover:bg-surface-2"
                      >
                        <span className="truncate text-ink">{action.description}</span>
                        {action.lastValidationStatus && (
                          <span
                            className={
                              action.lastValidationStatus === "passed"
                                ? "shrink-0 text-[11px] text-[var(--color-done)]"
                                : "shrink-0 text-[11px] text-error"
                            }
                          >
                            {action.lastValidationStatus}
                          </span>
                        )}
                      </button>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="text-[12px] text-ink-faint">
                  Click an edge or a node badge in the graph to inspect it.
                </p>
              )}
              </div>
            </div>
          </div>
      ) : null}
    </div>
  );
}
