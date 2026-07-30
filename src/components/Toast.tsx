"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

type ToastKind = "error" | "success" | "info";

interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
}

interface ToastContextValue {
  error: (message: string) => void;
  success: (message: string) => void;
  info: (message: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

// Errors stay up longer — they're the ones worth actually reading, not just
// glancing at.
const DURATION_MS: Record<ToastKind, number> = {
  error: 8000,
  success: 4000,
  info: 5000,
};

const KIND_STYLES: Record<ToastKind, string> = {
  error: "border-error/30 bg-error-soft text-error",
  success: "border-done/30 bg-done-soft text-done",
  info: "border-edge-strong bg-surface text-ink",
};

const KIND_GLYPH: Record<ToastKind, string> = {
  error: "✕",
  success: "✓",
  info: "ℹ",
};

let nextId = 1;

// Falls back to console output rather than throwing if something somehow
// renders outside ToastProvider (mounted once at the root layout) — a
// missing toast is a much smaller problem than a crash caused by the thing
// meant to report crashes.
const FALLBACK: ToastContextValue = {
  error: (m) => console.error(m),
  success: (m) => console.log(m),
  info: (m) => console.log(m),
};

export function useToast(): ToastContextValue {
  return useContext(ToastContext) ?? FALLBACK;
}

export default function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (kind: ToastKind, message: string) => {
      const id = nextId++;
      setToasts((prev) => [...prev, { id, kind, message }]);
      setTimeout(() => dismiss(id), DURATION_MS[kind]);
    },
    [dismiss],
  );

  // Stable identity across renders (memoized on `push`, which is itself
  // stable via useCallback) so effects/callbacks elsewhere that take
  // `toast` as a dependency don't re-run on every toast list change.
  const value = useMemo<ToastContextValue>(
    () => ({
      error: (m) => push("error", m),
      success: (m) => push("success", m),
      info: (m) => push("info", m),
    }),
    [push],
  );

  // The safety net: catches errors nothing explicitly handled — an uncaught
  // throw anywhere in client code, or a promise rejection nobody attached a
  // .catch() to. Every explicit toast.error() call elsewhere in the app is
  // additive on top of this, not a replacement for it.
  useEffect(() => {
    function onError(event: ErrorEvent) {
      value.error(event.message || "An unexpected error occurred");
    }
    function onRejection(event: PromiseRejectionEvent) {
      const reason: unknown = event.reason;
      const message =
        reason instanceof Error
          ? reason.message
          : typeof reason === "string"
            ? reason
            : "An unexpected error occurred";
      value.error(message);
    }
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, [value]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed right-4 bottom-4 z-[1000] flex w-full max-w-sm flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            role={t.kind === "error" ? "alert" : "status"}
            className={`toast-enter pointer-events-auto flex items-start gap-2.5 rounded-lg border px-3.5 py-3 text-[13px] shadow-lg ${KIND_STYLES[t.kind]}`}
          >
            <span className="mt-0.5 shrink-0 font-mono text-[11px]" aria-hidden>
              {KIND_GLYPH[t.kind]}
            </span>
            <span className="min-w-0 flex-1 break-words">{t.message}</span>
            <button
              type="button"
              onClick={() => dismiss(t.id)}
              className="shrink-0 text-ink-faint hover:text-ink"
              aria-label="Dismiss"
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
