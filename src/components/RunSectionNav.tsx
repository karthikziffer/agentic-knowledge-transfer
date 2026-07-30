"use client";

export interface RunSection {
  key: string;
  label: string;
}

// A horizontal status-line switcher — same visual language as a progress
// slider (a filled track up to the active point) but each point is an
// independently clickable view rather than a sequential step.
export default function RunSectionNav({
  sections,
  active,
  onChange,
}: {
  sections: RunSection[];
  active: string;
  onChange: (key: string) => void;
}) {
  const activeIndex = Math.max(
    0,
    sections.findIndex((s) => s.key === active),
  );
  const progressPct = sections.length > 1 ? (activeIndex / (sections.length - 1)) * 100 : 0;

  return (
    <div className="relative pt-1 pb-1">
      <div className="absolute top-[15px] right-3 left-3 h-0.5 rounded-full bg-edge" aria-hidden />
      <div
        className="absolute top-[15px] left-3 h-0.5 rounded-full bg-accent transition-all duration-300 ease-out"
        style={{ width: `calc(${progressPct}% * (100% - 1.5rem) / 100%)` }}
        aria-hidden
      />
      <div className="relative flex items-start justify-between">
        {sections.map((section, i) => {
          const isActive = section.key === active;
          const isPast = i < activeIndex;
          return (
            <button
              key={section.key}
              type="button"
              onClick={() => onChange(section.key)}
              aria-current={isActive ? "true" : undefined}
              className="group flex flex-1 flex-col items-center gap-2.5 px-1"
            >
              <span
                className={`h-3 w-3 shrink-0 rounded-full border-2 transition-colors ${
                  isActive
                    ? "border-accent bg-accent shadow-[0_0_0_4px_var(--color-accent-soft)]"
                    : isPast
                      ? "border-accent bg-accent/40"
                      : "border-edge-strong bg-surface group-hover:border-accent/50"
                }`}
              />
              <span
                className={`text-center font-mono text-[10px] leading-tight font-medium tracking-wide uppercase transition-colors ${
                  isActive ? "text-ink" : "text-ink-faint group-hover:text-ink-muted"
                }`}
              >
                {section.label}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
