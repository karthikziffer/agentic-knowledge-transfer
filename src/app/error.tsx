"use client";

import { useEffect } from "react";
import { useToast } from "@/components/Toast";

// Next.js's own error-boundary convention — catches render/data-fetching
// errors thrown anywhere under this segment (i.e. the whole app, since this
// file lives at the app root) that nothing else caught. The root layout
// (and therefore ToastProvider) stays mounted around this boundary, so the
// toast still shows even though the page content itself got replaced by
// this fallback.
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const toast = useToast();

  useEffect(() => {
    toast.error(error.message || "Something went wrong");
    // Only re-fire if a genuinely new error object shows up — `toast` is a
    // stable ref identity (see Toast.tsx) so it's safe to omit here without
    // risking a stale closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [error]);

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
      <p className="text-[14px] font-medium text-ink">Something went wrong.</p>
      <p className="max-w-sm text-[13px] text-ink-muted">{error.message}</p>
      <button type="button" onClick={reset} className="btn btn-primary">
        Try again
      </button>
    </div>
  );
}
