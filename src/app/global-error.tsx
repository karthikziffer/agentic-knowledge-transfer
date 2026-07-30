"use client";

// Next.js's error boundary for the *root layout itself* failing — a much
// rarer case than error.tsx (which only catches page/nested-route errors,
// not the layout.tsx that wraps them). This replaces the entire document,
// so it can't assume ToastProvider or anything else from layout.tsx ever
// mounted — it renders its own complete <html>/<body> and a self-contained
// fallback rather than depending on the app that just failed.
import "./globals.css";

export default function GlobalRootError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body className="flex h-full min-h-screen flex-col items-center justify-center gap-3 bg-shell p-8 text-center text-ink">
        <p className="text-[14px] font-medium">Something went wrong.</p>
        <p className="max-w-sm text-[13px] text-ink-muted">{error.message}</p>
        <button type="button" onClick={reset} className="btn btn-primary">
          Try again
        </button>
      </body>
    </html>
  );
}
