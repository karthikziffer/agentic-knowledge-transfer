"use client";

import { useState } from "react";
import { StatusBadge } from "@/components/LiveRunView";
import Modal from "@/components/Modal";
import type { StepResult } from "@/server/types";

const STEP_TYPE_LABELS: Record<string, string> = {
  "manual-start": "Session started",
  "manual-finish": "Session finished",
  "manual-click": "Clicked",
  "manual-scroll": "Scrolled",
  "manual-type": "Typed",
  "replay-click": "Clicked (auto)",
  "replay-scroll": "Scrolled (auto)",
  "replay-paused": "Paused for input",
  "variant-click": "Clicked (alternative)",
};

const CARD_W = 236;
const CARD_H = 214;
const GAP_X = 72;
const GAP_Y = 64;
const COLS = 4;
const PAD = 40;

interface Node {
  step: StepResult;
  x: number;
  y: number;
  col: number;
  row: number;
  reversed: boolean;
}

type ModalState = { kind: "image"; step: StepResult } | { kind: "dom"; step: StepResult } | null;

function layout(steps: StepResult[]): Node[] {
  return steps.map((step, i) => {
    const row = Math.floor(i / COLS);
    const reversed = row % 2 === 1;
    const colInRow = i % COLS;
    const col = reversed ? COLS - 1 - colInRow : colInRow;
    return {
      step,
      x: PAD + col * (CARD_W + GAP_X),
      y: PAD + row * (CARD_H + GAP_Y),
      col,
      row,
      reversed,
    };
  });
}

function formatGap(fromIso: string, toIso: string): string | null {
  const ms = new Date(toIso).getTime() - new Date(fromIso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export default function RunFlow({ runId, steps }: { runId: string; steps: StepResult[] }) {
  const [zoom, setZoom] = useState(1);
  const [open, setOpen] = useState(true);
  const [modal, setModal] = useState<ModalState>(null);

  if (steps.length === 0) return null;

  const nodes = layout(steps);
  const rows = Math.max(...nodes.map((n) => n.row)) + 1;
  const canvasWidth = PAD * 2 + COLS * CARD_W + (COLS - 1) * GAP_X;
  const canvasHeight = PAD * 2 + rows * CARD_H + (rows - 1) * GAP_Y;

  const edges = nodes.slice(1).map((to, i) => {
    const from = nodes[i];
    const wrapping = to.col === (from.reversed ? COLS - 1 : 0) && to.row !== from.row && to.col === from.col;
    let x1: number, y1: number, x2: number, y2: number, c1x: number, c1y: number, c2x: number, c2y: number;

    if (wrapping) {
      x1 = from.x + CARD_W / 2;
      y1 = from.y + CARD_H;
      x2 = to.x + CARD_W / 2;
      y2 = to.y;
      c1x = x1;
      c1y = y1 + GAP_Y / 2;
      c2x = x2;
      c2y = y2 - GAP_Y / 2;
    } else if (!from.reversed) {
      x1 = from.x + CARD_W;
      y1 = from.y + CARD_H / 2;
      x2 = to.x;
      y2 = to.y + CARD_H / 2;
      c1x = x1 + GAP_X / 2;
      c1y = y1;
      c2x = x2 - GAP_X / 2;
      c2y = y2;
    } else {
      x1 = from.x;
      y1 = from.y + CARD_H / 2;
      x2 = to.x + CARD_W;
      y2 = to.y + CARD_H / 2;
      c1x = x1 - GAP_X / 2;
      c1y = y1;
      c2x = x2 + GAP_X / 2;
      c2y = y2;
    }

    const gapLabel = to.step.startedAt && from.step.finishedAt
      ? formatGap(from.step.finishedAt, to.step.startedAt)
      : null;

    return {
      key: `${from.step.index}-${to.step.index}`,
      d: `M ${x1} ${y1} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${x2} ${y2}`,
      mx: (x1 + x2) / 2,
      my: (y1 + y2) / 2,
      isError: to.step.status === "error",
      gapLabel,
    };
  });

  return (
    <div className="card relative overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between border-b border-edge px-4 py-2.5 text-left transition-colors hover:bg-surface-2"
      >
        <span className="flex items-center gap-2">
          <ChevronDownIcon className={`text-ink-faint transition-transform duration-150 ${open ? "" : "-rotate-90"}`} />
          <span className="eyebrow">Run flow</span>
        </span>
        <span className="font-mono text-[11px] text-ink-faint">{steps.length} steps</span>
      </button>

      {open && (
        <>
          <div className="canvas-dots relative overflow-auto" style={{ maxHeight: 640 }}>
            <div
              className="relative"
              style={{
                width: canvasWidth * zoom,
                height: canvasHeight * zoom,
              }}
            >
              <div
                className="absolute top-0 left-0"
                style={{
                  width: canvasWidth,
                  height: canvasHeight,
                  transform: `scale(${zoom})`,
                  transformOrigin: "top left",
                }}
              >
                <svg width={canvasWidth} height={canvasHeight} className="pointer-events-none absolute top-0 left-0">
                  {edges.map((e) => (
                    <path
                      key={e.key}
                      d={e.d}
                      fill="none"
                      stroke={e.isError ? "var(--error)" : "var(--accent)"}
                      strokeWidth={2}
                      strokeDasharray="1 6"
                      strokeLinecap="round"
                      opacity={0.55}
                    />
                  ))}
                </svg>

                {edges.map(
                  (e) =>
                    e.gapLabel && (
                      <div
                        key={`label-${e.key}`}
                        className="absolute flex items-center justify-center rounded-full border border-edge bg-surface px-1.5 py-0.5 font-mono text-[10px] font-medium whitespace-nowrap text-ink-muted shadow-sm"
                        style={{ left: e.mx, top: e.my, transform: "translate(-50%, -50%)" }}
                      >
                        +{e.gapLabel}
                      </div>
                    ),
                )}

                {nodes.map(({ step, x, y }) => {
                  const hasDom = Boolean(step.domBefore || step.domAfter);
                  return (
                    <div
                      key={step.index}
                      className="card-hover absolute flex flex-col overflow-hidden rounded-lg border border-edge bg-surface"
                      style={{ left: x, top: y, width: CARD_W, height: CARD_H }}
                    >
                      {step.screenshot ? (
                        <button
                          type="button"
                          onClick={() => setModal({ kind: "image", step })}
                          className="block shrink-0"
                          title="View screenshot"
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={`/api/artifacts/${runId}/${step.screenshot}`}
                            alt={step.description ?? step.type}
                            className="h-24 w-full border-b border-edge object-cover object-top"
                          />
                        </button>
                      ) : (
                        <div className="flex h-24 w-full shrink-0 items-center justify-center border-b border-edge bg-surface-2">
                          <span className="font-mono text-[10px] text-ink-faint">no frame</span>
                        </div>
                      )}
                      <div className="flex min-h-0 flex-1 flex-col gap-1 p-2.5">
                        <div className="flex items-center justify-between gap-1.5">
                          <span className="flex items-center gap-1 text-[11px] font-semibold text-ink">
                            <span className="mono text-ink-faint">
                              {String(step.index + 1).padStart(2, "0")}
                            </span>
                            <span className="truncate">{STEP_TYPE_LABELS[step.type] ?? step.type}</span>
                          </span>
                          <StatusBadge status={step.status} />
                        </div>
                        {step.description && (
                          <p className="line-clamp-2 text-[11px] leading-snug text-ink-muted">
                            {step.description}
                          </p>
                        )}
                        {step.error && <p className="line-clamp-1 text-[11px] text-error">{step.error}</p>}
                        {hasDom && (
                          <button
                            type="button"
                            onClick={() => setModal({ kind: "dom", step })}
                            className="mt-auto flex items-center gap-1 self-start font-mono text-[10px] font-medium text-accent hover:underline"
                          >
                            <DomIcon /> DOM diff
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          <div className="absolute right-3 bottom-3 flex items-center gap-1 rounded-lg border border-edge bg-surface p-1 shadow-md">
            <button
              type="button"
              onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.1).toFixed(2)))}
              className="flex h-7 w-7 items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
              aria-label="Zoom out"
            >
              −
            </button>
            <span className="w-9 text-center font-mono text-[11px] text-ink-muted">
              {Math.round(zoom * 100)}%
            </span>
            <button
              type="button"
              onClick={() => setZoom((z) => Math.min(1.5, +(z + 0.1).toFixed(2)))}
              className="flex h-7 w-7 items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
              aria-label="Zoom in"
            >
              +
            </button>
          </div>
        </>
      )}

      <Modal
        open={modal !== null}
        onClose={() => setModal(null)}
        title={
          modal
            ? `Step ${modal.step.index + 1} · ${modal.kind === "image" ? "Screenshot" : "DOM diff"}`
            : undefined
        }
      >
        {modal?.kind === "image" && modal.step.screenshot && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={`/api/artifacts/${runId}/${modal.step.screenshot}`}
            alt={modal.step.description ?? modal.step.type}
            className="w-full object-contain"
          />
        )}
        {modal?.kind === "dom" && (
          <iframe
            src={`/api/runs/${runId}/steps/${modal.step.index}/dom-diff`}
            title="DOM diff"
            className="h-[70vh] w-full border-0"
          />
        )}
      </Modal>
    </div>
  );
}

function ChevronDownIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      width={14}
      height={14}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

function DomIcon() {
  return (
    <svg
      width={11}
      height={11}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <polyline points="8 6 3 12 8 18" />
      <polyline points="16 6 21 12 16 18" />
    </svg>
  );
}
