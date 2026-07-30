"use client";

import { useState } from "react";

export default function Collapsible({
  title,
  meta,
  defaultOpen = false,
  // List-type content (session/run history) is capped and internally
  // scrollable so it can never grow the page; other content (e.g. a
  // video) should render at its natural size instead.
  scrollable = true,
  children,
}: {
  title: string;
  meta?: React.ReactNode;
  defaultOpen?: boolean;
  scrollable?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="card overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-4 py-2.5 text-left transition-colors hover:bg-surface-2"
      >
        <span className="flex items-center gap-2">
          <ChevronDownIcon
            className={`text-ink-faint transition-transform duration-150 ${open ? "" : "-rotate-90"}`}
          />
          <span className="eyebrow">{title}</span>
        </span>
        {meta && <span className="font-mono text-[11px] text-ink-faint">{meta}</span>}
      </button>
      {open && (
        <div className={`border-t border-edge ${scrollable ? "max-h-64 overflow-y-auto" : ""}`}>
          {children}
        </div>
      )}
    </div>
  );
}

function ChevronDownIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      width={14}
      height={14}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}
