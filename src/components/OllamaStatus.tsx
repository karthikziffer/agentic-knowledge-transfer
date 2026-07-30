"use client";

import { useEffect, useState } from "react";
import Spinner from "@/components/Spinner";
import type { OllamaStatus as OllamaStatusData } from "@/server/ollama";

function formatSize(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
}

export default function OllamaStatus() {
  const [status, setStatus] = useState<OllamaStatusData | null>(null);
  const [checking, setChecking] = useState(true);

  async function check() {
    setChecking(true);
    try {
      const res = await fetch("/api/ollama/status");
      const body = await res.json();
      setStatus(res.ok ? body : { connected: false, baseUrl: "", models: [], error: body.error });
    } catch {
      setStatus({ connected: false, baseUrl: "", models: [], error: "Request failed" });
    }
    setChecking(false);
  }

  useEffect(() => {
    // Auto-check on mount — connecting "automatically" is the whole point,
    // no user action should be required to see the current status.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void check();
  }, []);

  return (
    <div className="card flex flex-col gap-3 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-[13px] font-semibold text-ink">Ollama</h3>
          <p className="field-hint">
            Local models running on your machine, reached automatically via Docker.
          </p>
        </div>
        <button
          type="button"
          onClick={check}
          disabled={checking}
          className="btn btn-secondary shrink-0"
        >
          {checking && <Spinner />}
          {checking ? "Checking…" : "Refresh"}
        </button>
      </div>

      {status && (
        <>
          <div className="flex items-center gap-2">
            {status.connected ? (
              <span className="pill pill-done">
                <span className="pill-glyph">✓</span>
                Connected
              </span>
            ) : (
              <span className="pill pill-error">
                <span className="pill-glyph">✕</span>
                Not connected
              </span>
            )}
            {status.baseUrl && <span className="font-mono text-xs text-ink-faint">{status.baseUrl}</span>}
          </div>

          {!status.connected && status.error && (
            <p className="text-xs text-error">
              {status.error} — make sure Ollama is running on your host machine.
            </p>
          )}

          {status.connected && (
            <>
              {status.models.length === 0 ? (
                <p className="text-[13px] text-ink-muted">
                  No models pulled yet — run <code className="mono">ollama pull llama3.1</code> on your
                  host.
                </p>
              ) : (
                <ul className="overflow-hidden rounded-md border border-edge">
                  {status.models.map((model) => (
                    <li key={model.name} className="row flex items-center justify-between gap-3 !py-2">
                      <div className="min-w-0">
                        <code className="mono text-[13px] text-ink">{model.name}</code>
                        <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                          {model.parameterSize && (
                            <span className="font-mono text-[11px] text-ink-faint">
                              {model.parameterSize}
                            </span>
                          )}
                          {model.quantization && (
                            <span className="font-mono text-[11px] text-ink-faint">
                              · {model.quantization}
                            </span>
                          )}
                          {model.capabilities.map((cap) => (
                            <span
                              key={cap}
                              className="rounded-full bg-accent-soft px-1.5 py-0.5 font-mono text-[10px] font-medium text-accent"
                            >
                              {cap}
                            </span>
                          ))}
                        </div>
                      </div>
                      <span className="shrink-0 font-mono text-xs text-ink-faint">
                        {formatSize(model.sizeBytes)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
