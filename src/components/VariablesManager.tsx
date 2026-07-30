"use client";

import { useState } from "react";
import Spinner from "@/components/Spinner";
import { useToast } from "@/components/Toast";

export interface VariableSummary {
  key: string;
  updatedAt: string;
}

export default function VariablesManager({
  endpoint,
  title,
  hint,
  initialVariables,
}: {
  endpoint: string;
  title: string;
  hint: string;
  initialVariables: VariableSummary[];
}) {
  const toast = useToast();
  const [variables, setVariables] = useState(initialVariables);
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);

    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, value }),
    });
    const body = await res.json();
    setBusy(false);

    if (!res.ok) {
      const message = body.error ?? "Failed to save variable";
      setError(message);
      toast.error(message);
      return;
    }

    setVariables((prev) => {
      const existing = prev.find((v) => v.key === key);
      const updated = { key, updatedAt: new Date().toISOString() };
      return existing
        ? prev.map((v) => (v.key === key ? updated : v))
        : [...prev, updated].sort((a, b) => a.key.localeCompare(b.key));
    });
    setKey("");
    setValue("");
  }

  async function handleDelete(k: string) {
    if (!window.confirm(`Delete variable ${k}?`)) return;
    const res = await fetch(`${endpoint}/${k}`, { method: "DELETE" });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      toast.error(body.error ?? "Failed to delete variable");
      return;
    }
    setVariables((prev) => prev.filter((v) => v.key !== k));
  }

  return (
    <div className="card flex flex-col gap-3 p-4">
      <div>
        <h3 className="text-[13px] font-semibold text-ink">{title}</h3>
        <p className="field-hint">{hint}</p>
      </div>

      {variables.length > 0 && (
        <ul className="overflow-hidden rounded-md border border-edge">
          {variables.map((v) => (
            <li
              key={v.key}
              className="row flex items-center justify-between !py-1.5"
            >
              <code className="mono text-[13px] text-ink">{v.key}</code>
              <div className="flex items-center gap-3">
                <span className="font-mono text-xs text-ink-faint">••••••••</span>
                <button
                  type="button"
                  onClick={() => handleDelete(v.key)}
                  className="text-xs font-medium text-error hover:underline"
                >
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={handleAdd} className="flex flex-col gap-2">
        <label className="field-label text-xs">
          Key
          <input
            required
            className="input"
            value={key}
            onChange={(e) => setKey(e.target.value.replace(/[^A-Za-z0-9_]/g, "").toUpperCase())}
            placeholder="MY_SITE_USER"
          />
        </label>
        <label className="field-label text-xs">
          Value
          <input
            required
            type="password"
            className="input"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        </label>
        <button type="submit" disabled={busy} className="btn btn-primary">
          {busy && <Spinner />}
          {busy ? "Saving…" : "Set"}
        </button>
      </form>
      {error && <p className="text-xs text-error">{error}</p>}
    </div>
  );
}
