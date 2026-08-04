"use client";

export interface RunSection {
  key: string;
  label: string;
}

// A compact horizontal tab bar. Previously styled as a sequential progress
// stepper (dots joined by a filled line, implying "completed" steps up to
// the active one) — misleading for what these actually are: independently
// clickable views in no particular order, not steps that get done in
// sequence. Also considerably taller than a plain tab row needs to be.
export default function RunSectionNav({
  sections,
  active,
  onChange,
}: {
  sections: RunSection[];
  active: string;
  onChange: (key: string) => void;
}) {
  return (
    <div className="flex gap-1 border-b border-edge" role="tablist">
      {sections.map((section) => {
        const isActive = section.key === active;
        return (
          <button
            key={section.key}
            type="button"
            role="tab"
            onClick={() => onChange(section.key)}
            aria-selected={isActive}
            className={`shrink-0 border-b-2 px-2.5 py-2 font-mono text-[11px] font-medium tracking-wide uppercase transition-colors ${
              isActive
                ? "border-accent text-ink"
                : "border-transparent text-ink-faint hover:text-ink-muted"
            }`}
          >
            {section.label}
          </button>
        );
      })}
    </div>
  );
}
