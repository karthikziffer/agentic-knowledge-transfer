"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import LiveRunView from "@/components/LiveRunView";
import { useToast } from "@/components/Toast";

// Same polling interval as SkillActionGraph's crawl/validate runs — cheap
// enough for a background poll, frequent enough that "Run agent" doesn't
// feel stuck.
const POLL_MS = 2000;

// The "Agent" tab: a free-text prompt (what to do) plus the URL to do it on
// (prefilled with the skill's own start URL, editable), executed by
// src/server/agent.ts's agentTask — it searches the skill's action graph
// (built by the crawler on the previous tab) for the closest known real
// action to each planned step and clicks it live, rather than rediscovering
// the page from scratch.
export default function SkillAgentPanel({
  projectId,
  skillId,
  defaultStartUrl,
}: {
  projectId: string;
  skillId: string;
  defaultStartUrl: string;
}) {
  const toast = useToast();
  const [prompt, setPrompt] = useState("");
  const [startUrl, setStartUrl] = useState(defaultStartUrl);
  const [runId, setRunId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!runId) return;
    let cancelled = false;

    async function poll() {
      try {
        const res = await fetch(`/api/runs/${runId}`);
        const body = await res.json();
        const status = body?.record?.status as string | undefined;
        if (cancelled) return;
        if (status === "completed" || status === "error") {
          if (status === "error") {
            const message = body.record.error ?? "Agent run failed";
            setError(message);
            toast.error(message);
          }
          setRunId(null);
          return;
        }
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
  }, [runId, toast]);

  const startAgent = useCallback(async () => {
    if (!prompt.trim() || !startUrl.trim()) return;
    setStarting(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/skills/${skillId}/agent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, startUrl }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Failed to start the agent");
      setRunId(body.runId as string);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to start the agent";
      setError(message);
      toast.error(message);
    } finally {
      setStarting(false);
    }
  }, [projectId, skillId, prompt, startUrl, toast]);

  return (
    <div className="flex flex-col gap-4">
      <div className="card flex flex-col gap-3 p-5">
        <div>
          <h3 className="text-[13px] font-semibold text-ink">Agent</h3>
          <p className="mt-0.5 text-[13px] text-ink-muted">
            Describe what to do, on which page — the agent looks up each step against this
            skill&apos;s action graph and clicks the closest known real match live.
          </p>
          {error && <p className="mt-1.5 text-[13px] text-error">{error}</p>}
        </div>

        <div className="flex flex-col gap-2">
          <input
            type="text"
            value={startUrl}
            onChange={(e) => setStartUrl(e.target.value)}
            placeholder="URL to run on"
            disabled={!!runId || starting}
            className="input"
          />
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="e.g. click Quickstart, then click Install"
            rows={3}
            disabled={!!runId || starting}
            className="input resize-y"
          />
          <button
            type="button"
            onClick={startAgent}
            disabled={starting || !!runId || !prompt.trim() || !startUrl.trim()}
            className="btn btn-primary self-start"
          >
            {starting ? "Starting…" : runId ? "Running…" : "Run agent"}
          </button>
        </div>
      </div>

      {runId && (
        <div className="lg:h-[560px] lg:min-h-0">
          <LiveRunView
            runId={runId}
            endControl="stop"
            // Fires immediately on a successful Stop instead of waiting for
            // this component's own poll to notice up to POLL_MS later —
            // Stop should re-enable the prompt/URL fields and "Run agent"
            // right away, not after a multi-second delay.
            onStatusChange={(status) => {
              if (status === "completed" || status === "error") {
                setRunId(null);
              }
            }}
          />
        </div>
      )}
    </div>
  );
}
