"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import Spinner from "@/components/Spinner";
import { useToast } from "@/components/Toast";

export default function LoginPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const toast = useToast();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);

    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const body = await res.json();
    setBusy(false);

    if (!res.ok) {
      const message = body.error ?? "Failed to sign in";
      setError(message);
      toast.error(message);
      return;
    }

    router.push(searchParams.get("next") || "/");
    router.refresh();
  }

  return (
    <div className="flex flex-1 items-center justify-center px-6 py-16">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <div className="flex flex-col items-center gap-2 text-center">
          <span className="mb-1 flex h-9 w-9 items-center justify-center rounded-lg bg-accent text-base font-bold text-white">
            A
          </span>
          <h1 className="page-title">Sign in</h1>
          <p className="text-[13px] text-ink-muted">Welcome back to agenticKT.</p>
        </div>

        <form onSubmit={handleSubmit} className="card flex flex-col gap-3 p-5">
          <label className="field-label">
            Email
            <input
              type="email"
              required
              autoComplete="email"
              className="input"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <label className="field-label">
            Password
            <input
              type="password"
              required
              autoComplete="current-password"
              className="input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          {error && <p className="text-xs text-error">{error}</p>}
          <button type="submit" disabled={busy} className="btn btn-primary mt-1">
            {busy && <Spinner />}
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>

        <p className="text-center text-[13px] text-ink-muted">
          Don&apos;t have an account?{" "}
          <Link href="/register" className="font-medium text-accent hover:underline">
            Create one
          </Link>
        </p>
      </div>
    </div>
  );
}
