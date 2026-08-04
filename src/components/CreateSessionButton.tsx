"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import Spinner from "@/components/Spinner";
import { useToast } from "@/components/Toast";

export default function CreateSessionButton({
  promptId,
  runId,
  status,
}: {
  promptId: string;
  runId?: string | null;
  status?: string | null;
}) {
  const router = useRouter();
  const toast = useToast();
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isActive = status === "queued" || status === "running";

  async function startRun() {
    setStarting(true);
    setError(null);
    try {
      const res = await fetch(`/api/prompts/${promptId}/runs`, { method: "POST" });
      const body = await res.json();
      if (!res.ok) {
        const message = body.error ?? "Failed to start session";
        setError(message);
        toast.error(message);
        return;
      }
      router.refresh();
    } catch (err) {
      // A network-level failure (fetch itself throwing, e.g. the server was
      // unreachable for a moment) — without this catch, the exception would
      // skip straight past setStarting(false) below and leave the button
      // stuck showing "Starting…" forever, unrecoverable without a reload.
      const message = err instanceof Error ? err.message : "Failed to start session";
      setError(message);
      toast.error(message);
    } finally {
      setStarting(false);
    }
  }

  async function stopRun() {
    if (!runId) return;
    setStopping(true);
    try {
      const res = await fetch(`/api/runs/${runId}/stop`, { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        toast.error(body.error ?? "Failed to stop session");
        return;
      }
      router.refresh();
    } catch (err) {
      // Same reasoning as startRun's catch above — otherwise a network-level
      // failure leaves this button stuck showing "Stopping…" forever.
      const message = err instanceof Error ? err.message : "Failed to stop session";
      toast.error(message);
    } finally {
      setStopping(false);
    }
  }

  if (isActive) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-[13px] font-medium text-ink">Session {status}…</span>
        <button onClick={stopRun} disabled={stopping} className="btn btn-danger">
          {stopping ? "Stopping…" : "Stop"}
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      {error && <p className="text-[12px] text-error">{error}</p>}
      <button onClick={startRun} disabled={starting} className="btn btn-primary">
        {starting && <Spinner />}
        {starting ? "Starting…" : "Create session"}
      </button>
    </div>
  );
}
