"use client";

// Shared by SkillActionGraph.tsx's crawl depth goals and
// AlternativeSuggestions.tsx's plan depth goals — same underlying idea in
// both places: "depth" = hops from a starting page, "goal" = how many
// genuinely distinct destinations at that depth to keep looking for.
export interface DepthGoalRow {
  depth: number;
  goal: number;
}

// Bounds mirrored server-side by whichever route consumes these rows
// (graph/crawl/route.ts, alternatives/suggest/route.ts) — kept in sync by
// hand rather than fetched, same reasoning as other client-side mirrors of
// server constants in this codebase.
export const MAX_GOAL_DEPTH = 6;
export const MAX_GOAL_COUNT = 25;
const MAX_GOAL_ROWS = MAX_GOAL_DEPTH;

const DEPTH_STEP_NAMES: Record<number, string> = {
  1: "single-step",
  2: "double-step",
  3: "triple-step",
};

function depthStepLabel(depth: number): string {
  return DEPTH_STEP_NAMES[depth] ?? `${depth}-step`;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

// Same stroke-based line-icon style as Sidebar.tsx's icon set.
function InfoIcon() {
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
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5.5" />
      <circle cx="12" cy="7.75" r="0.25" fill="currentColor" stroke="none" />
    </svg>
  );
}

export default function DepthGoalEditor({
  rows,
  onChange,
  title = "Depth goals (optional)",
  infoText,
  emptyStateText,
}: {
  rows: DepthGoalRow[];
  onChange: (rows: DepthGoalRow[]) => void;
  title?: string;
  infoText: string;
  emptyStateText: string;
}) {
  function addRow() {
    const used = new Set(rows.map((r) => r.depth));
    let depth = 1;
    while (used.has(depth) && depth <= MAX_GOAL_DEPTH) depth++;
    if (depth > MAX_GOAL_DEPTH) return;
    onChange([...rows, { depth, goal: 1 }]);
  }

  function updateRow(index: number, patch: Partial<DepthGoalRow>) {
    onChange(rows.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }

  function removeRow(index: number) {
    onChange(rows.filter((_, i) => i !== index));
  }

  return (
    <div className="card flex flex-col gap-3 p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <h4 className="eyebrow">{title}</h4>
          <span
            className="flex h-3.5 w-3.5 shrink-0 cursor-help items-center justify-center rounded-full text-ink-faint hover:text-ink"
            title={infoText}
          >
            <InfoIcon />
          </span>
        </div>
        <button
          type="button"
          onClick={addRow}
          disabled={rows.length >= MAX_GOAL_ROWS}
          className="btn btn-secondary shrink-0 !py-1 !text-[12px]"
        >
          + Add depth
        </button>
      </div>
      {rows.length === 0 ? (
        <p className="text-[12px] text-ink-faint">{emptyStateText}</p>
      ) : (
        <div className="flex flex-wrap gap-3">
          {rows.map((row, i) => (
            <div
              key={i}
              className="flex items-end gap-3 rounded-lg border border-edge bg-surface-2 py-2 pr-2 pl-3 shadow-sm"
            >
              <div className="flex flex-col gap-1">
                <label className="text-[10px] font-medium tracking-wide text-ink-faint uppercase">Depth</label>
                <input
                  type="number"
                  min={1}
                  max={MAX_GOAL_DEPTH}
                  value={row.depth}
                  onChange={(e) => updateRow(i, { depth: clamp(Number(e.target.value), 1, MAX_GOAL_DEPTH) })}
                  className="input w-14 px-1.5 text-center"
                  aria-label="Depth (hops from the start page)"
                />
                <span className="text-[10px] text-ink-faint">{depthStepLabel(row.depth)}</span>
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-[10px] font-medium tracking-wide text-ink-faint uppercase">Goal</label>
                <input
                  type="number"
                  min={1}
                  max={MAX_GOAL_COUNT}
                  value={row.goal}
                  onChange={(e) => updateRow(i, { goal: clamp(Number(e.target.value), 1, MAX_GOAL_COUNT) })}
                  className="input w-14 px-1.5 text-center"
                  aria-label={`Goal count for depth ${row.depth}`}
                />
                <span className="text-[10px] text-ink-faint">page{row.goal === 1 ? "" : "s"}</span>
              </div>
              <button
                type="button"
                onClick={() => removeRow(i)}
                className="mb-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-ink-faint transition-colors hover:bg-error-soft hover:text-error"
                aria-label={`Remove depth ${row.depth} goal`}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
