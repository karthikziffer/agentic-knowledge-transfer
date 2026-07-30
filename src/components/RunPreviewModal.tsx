"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import Modal from "@/components/Modal";
import { StatusBadge } from "@/components/LiveRunView";
import type { RunRecord } from "@/server/types";

const POLL_MS = 2000;

// A quick "what is this run doing" popup for a generated alternative —
// video + step list, without leaving the alternatives list. Polls
// GET /api/runs/[runId] (already used elsewhere, e.g. DeleteButton's
// sibling checks) while the run is still queued/running so steps and
// status update live, and stops once it reaches a terminal state.
export default function RunPreviewModal({
  runId,
  projectId,
  skillId,
  promptId,
  open,
  onClose,
}: {
  runId: string | null;
  projectId: string;
  skillId: string;
  promptId: string;
  open: boolean;
  onClose: () => void;
}) {
  const [record, setRecord] = useState<RunRecord | null>(null);
  const [videoFailed, setVideoFailed] = useState(false);

  useEffect(() => {
    if (!open || !runId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    // Reset when the modal is (re)opened for a (possibly different) run —
    // stale data from a previous run would otherwise flash before the
    // first fetch below resolves.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRecord(null);
    setVideoFailed(false);

    async function load() {
      try {
        const res = await fetch(`/api/runs/${runId}`);
        if (!res.ok || cancelled) return;
        const body = await res.json();
        const next = body.record as RunRecord;
        if (cancelled) return;
        setRecord(next);
        if ((next.status === "completed" || next.status === "error") && timer) {
          clearInterval(timer);
          timer = null;
        }
      } catch {
        // transient — the next poll (or the user reopening) will retry
      }
    }

    load();
    timer = setInterval(load, POLL_MS);

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [open, runId]);

  const isTerminal = record?.status === "completed" || record?.status === "error";

  return (
    <Modal
      open={open && !!runId}
      onClose={onClose}
      title={record?.variantLabel ? `Alternative: ${record.variantLabel}` : "Run preview"}
    >
      <div className="flex flex-col gap-4 p-4">
        {!record ? (
          <div className="flex items-center justify-center py-12">
            <span className="h-5 w-5 animate-spin rounded-full border-2 border-edge border-t-accent" />
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between">
              <StatusBadge status={record.status} />
              <Link
                href={`/projects/${projectId}/skills/${skillId}/prompts/${promptId}/runs/${record.id}`}
                className="text-[12px] font-medium text-accent hover:underline"
              >
                Open full page →
              </Link>
            </div>

            {record.error && (
              <p className="rounded-md border border-error/25 bg-error/10 px-3 py-2 text-[13px] text-error">
                {record.error}
              </p>
            )}

            {isTerminal && !videoFailed && (
              <video
                controls
                preload="metadata"
                className="w-full rounded-md border border-edge bg-black"
                src={`/api/artifacts/${record.id}/video.webm`}
                onError={() => setVideoFailed(true)}
              />
            )}

            {record.steps.length > 0 ? (
              <ol className="flex flex-col gap-2">
                {record.steps.map((step) => (
                  <li key={step.index} className="card flex items-center gap-3 p-2.5">
                    {step.screenshot ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={`/api/artifacts/${record.id}/${step.screenshot}`}
                        alt=""
                        className="h-14 w-20 shrink-0 rounded border border-edge object-cover object-top"
                      />
                    ) : (
                      <div className="flex h-14 w-20 shrink-0 items-center justify-center rounded border border-dashed border-edge-strong bg-surface-2">
                        <span className="font-mono text-[8px] text-ink-faint">no frame</span>
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[12px] font-medium text-ink">
                        {step.description ?? step.type}
                      </p>
                      <p className="font-mono text-[10px] text-ink-faint">{step.status}</p>
                    </div>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="py-4 text-center text-[12px] text-ink-faint">
                {record.status === "queued" ? "Waiting to start…" : "No steps recorded yet."}
              </p>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
