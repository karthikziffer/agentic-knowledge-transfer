"use client";

import { useState } from "react";
import { StatusBadge } from "@/components/LiveRunView";
import DeleteButton from "@/components/DeleteButton";
import type { RunRecord } from "@/server/types";

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function formatDuration(startedAt?: string, finishedAt?: string): string {
  if (!startedAt || !finishedAt) return "—";
  const ms = new Date(finishedAt).getTime() - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  return `${Math.floor(totalSeconds / 60)}m ${(totalSeconds % 60).toString().padStart(2, "0")}s`;
}

// Same stroke-based line-icon style as Sidebar.tsx's icon set.
function ChevronIcon({ expanded }: { expanded: boolean }) {
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
      className={`shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`}
      aria-hidden
    >
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

// Collapsed by default to just the run name — everything else (timestamp,
// status, hostname/step-count/duration) used to always render across two
// separate rows (one from this run page, one from FlowSummaryView's own
// header) and took up a lot of vertical space for information that's
// rarely needed at a glance. Delete stays reachable either way since it's
// an action, not information to skim.
export default function RunHeader({
  runId,
  projectId,
  skillId,
  runKind,
  createdAt,
  status,
  startUrl,
  stepCount,
  startedAt,
  finishedAt,
}: {
  runId: string;
  projectId: string;
  skillId: string;
  runKind: string;
  createdAt: string;
  status: RunRecord["status"];
  startUrl: string;
  stepCount: number;
  startedAt?: string;
  finishedAt?: string;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="mb-4">
      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="flex min-w-0 items-center gap-1.5 text-left"
        >
          <ChevronIcon expanded={expanded} />
          <span className="truncate text-[13px] font-medium text-ink">{runKind}</span>
        </button>
        <DeleteButton
          endpoint={`/api/runs/${runId}`}
          confirmMessage="Delete this run and its artifacts?"
          redirectTo={`/projects/${projectId}/skills/${skillId}`}
          className="btn btn-danger shrink-0 !px-2.5 !py-1 !text-[12px]"
        />
      </div>
      {expanded && (
        <div className="mt-2 flex flex-wrap items-center gap-2 pl-[21px]">
          <StatusBadge status={status} />
          <span className="pill pill-queued">{hostnameOf(startUrl)}</span>
          <span className="pill pill-queued">
            {stepCount} step{stepCount === 1 ? "" : "s"}
          </span>
          <span className="pill pill-queued">{formatDuration(startedAt, finishedAt)}</span>
          <span className="font-mono text-[11px] text-ink-faint">{new Date(createdAt).toLocaleString()}</span>
        </div>
      )}
    </div>
  );
}
