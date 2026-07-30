export default function EmptyState({
  title,
  description,
}: {
  title: string;
  description?: string;
}) {
  return (
    <div className="empty-state">
      <div
        className="mb-2 flex h-9 w-9 items-center justify-center rounded-lg bg-surface-2 text-ink-faint"
        aria-hidden
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M21 8v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8" />
          <path d="M3 8l3.5-5h11L21 8" />
          <path d="M3 8h18" />
          <path d="M9 12a3 3 0 0 0 6 0" />
        </svg>
      </div>
      <p className="text-[13px] font-medium text-ink">{title}</p>
      {description && <p className="max-w-xs text-[13px] text-ink-muted">{description}</p>}
    </div>
  );
}
