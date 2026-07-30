"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import Spinner from "@/components/Spinner";

export default function DeleteButton({
  endpoint,
  confirmMessage,
  redirectTo,
  className,
  label = "Delete",
}: {
  endpoint: string;
  confirmMessage: string;
  redirectTo?: string;
  className?: string;
  label?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function handleDelete(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (!window.confirm(confirmMessage)) return;

    setBusy(true);
    const res = await fetch(endpoint, { method: "DELETE" });
    setBusy(false);

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      window.alert(body.error ?? "Failed to delete");
      return;
    }

    if (redirectTo) {
      router.push(redirectTo);
    }
    // Refresh regardless of whether we're navigating — the sidebar's
    // project list lives in the shared layout and only refetches on
    // an explicit refresh, not on a plain client-side push.
    router.refresh();
  }

  return (
    <button
      type="button"
      onClick={handleDelete}
      disabled={busy}
      className={className ?? "btn btn-danger"}
    >
      {busy && <Spinner />}
      {busy ? "Deleting…" : label}
    </button>
  );
}
