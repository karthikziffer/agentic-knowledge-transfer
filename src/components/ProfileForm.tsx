"use client";

import { useState } from "react";
import Spinner from "@/components/Spinner";
import { useToast } from "@/components/Toast";

export default function ProfileForm({
  initialName,
  initialBio,
}: {
  initialName: string;
  initialBio: string;
}) {
  const toast = useToast();
  const [name, setName] = useState(initialName);
  const [bio, setBio] = useState(initialBio);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);

    const res = await fetch("/api/auth/profile", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, bio }),
    });
    setBusy(false);

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const message = body.error ?? "Failed to save";
      setError(message);
      toast.error(message);
      return;
    }
    setSaved(true);
  }

  return (
    <form onSubmit={handleSubmit} className="card flex flex-col gap-3 p-4">
      <label className="field-label">
        Name
        <input
          className="input"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setSaved(false);
          }}
        />
      </label>
      <label className="field-label">
        Bio
        <textarea
          className="input h-24"
          value={bio}
          onChange={(e) => {
            setBio(e.target.value);
            setSaved(false);
          }}
        />
      </label>
      {error && <p className="text-xs text-error">{error}</p>}
      {saved && <p className="text-xs text-done">Saved.</p>}
      <button type="submit" disabled={busy} className="btn btn-primary self-start">
        {busy && <Spinner />}
        {busy ? "Saving…" : "Save changes"}
      </button>
    </form>
  );
}
