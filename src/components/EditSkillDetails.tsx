"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import Spinner from "@/components/Spinner";
import { useToast } from "@/components/Toast";

export default function EditSkillDetails({
  projectId,
  skillId,
  initialName,
  initialStartUrl,
}: {
  projectId: string;
  skillId: string;
  initialName: string;
  initialStartUrl: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(initialName);
  const [startUrl, setStartUrl] = useState(initialStartUrl);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/projects/${projectId}/skills/${skillId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, startUrl }),
    });
    const body = await res.json();
    setBusy(false);
    if (!res.ok) {
      const message = body.error ?? "Failed to save";
      setError(message);
      toast.error(message);
      return;
    }
    setEditing(false);
    router.refresh();
  }

  if (!editing) {
    return (
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <h1 className="page-title">{name}</h1>
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="text-xs font-medium text-accent hover:underline"
          >
            Edit
          </button>
        </div>
        <p className="font-mono text-xs text-ink-faint">{startUrl}</p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSave} className="card flex w-96 flex-col gap-3 p-4">
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
          className="input"
          value={startUrl}
          onChange={(e) => setStartUrl(e.target.value)}
        />
      </label>
      {error && <p className="text-xs text-error">{error}</p>}
      <div className="flex gap-2">
        <button type="submit" disabled={busy} className="btn btn-primary">
          {busy && <Spinner />}
          {busy ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          onClick={() => {
            setEditing(false);
            setName(initialName);
            setStartUrl(initialStartUrl);
            setError(null);
          }}
          className="btn btn-secondary"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
