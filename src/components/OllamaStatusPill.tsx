"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { OllamaStatus } from "@/server/ollama";

export default function OllamaStatusPill() {
  const [status, setStatus] = useState<OllamaStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function check() {
      try {
        const res = await fetch("/api/ollama/status");
        const body = await res.json();
        if (!cancelled) setStatus(res.ok ? body : { connected: false, baseUrl: "", models: [] });
      } catch {
        if (!cancelled) setStatus({ connected: false, baseUrl: "", models: [] });
      }
    }
    void check();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!status) {
    return <span className="h-5 w-24 animate-pulse rounded-full bg-surface-2" aria-hidden />;
  }

  return (
    <Link
      href="/settings"
      title={
        status.connected
          ? `Ollama connected — ${status.models.length} model${status.models.length === 1 ? "" : "s"}`
          : "Ollama not connected"
      }
      className={`pill transition-opacity hover:opacity-80 ${status.connected ? "pill-done" : "pill-queued"}`}
    >
      <span className="pill-glyph">{status.connected ? "✓" : "○"}</span>
      {status.connected ? `Ollama · ${status.models.length}` : "Ollama offline"}
    </Link>
  );
}
