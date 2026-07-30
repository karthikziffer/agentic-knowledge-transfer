"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import Spinner from "@/components/Spinner";
import { useToast } from "@/components/Toast";

export default function CreateSkillForm({ projectId }: { projectId: string }) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [startUrl, setStartUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);

    const res = await fetch(`/api/projects/${projectId}/skills`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, startUrl }),
    });
    const body = await res.json();
    setBusy(false);

    if (!res.ok) {
      const message = body.error ?? "Failed to create skill";
      setError(message);
      toast.error(message);
      return;
    }

    router.push(`/projects/${projectId}/skills/${body.skill.id}`);
  }

  return (
    <div className="relative">
      <button type="button" onClick={() => setOpen((v) => !v)} className="btn btn-primary">
        + New skill
      </button>

      {open && (
        <>
          <button
            type="button"
            aria-label="Close"
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-10 cursor-default"
          />
          <form
            onSubmit={handleSubmit}
            className="card absolute top-full right-0 z-20 mt-2 flex w-96 flex-col gap-3 p-4 shadow-lg"
          >
            <label className="field-label">
              Name
              <input
                autoFocus
                required
                className="input"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label className="field-label">
              Start URL
              <input
                required
                placeholder="https://example.com"
                className="input"
                value={startUrl}
                onChange={(e) => setStartUrl(e.target.value)}
              />
              <span className="field-hint">
                Every run for this skill starts here, under your direct control.
              </span>
            </label>

            {error && <p className="text-xs text-error">{error}</p>}
            <div className="flex gap-2">
              <button type="submit" disabled={busy} className="btn btn-primary">
                {busy && <Spinner />}
                {busy ? "Creating…" : "Create skill"}
              </button>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="btn btn-secondary"
              >
                Cancel
              </button>
            </div>
          </form>
        </>
      )}
    </div>
  );
}
