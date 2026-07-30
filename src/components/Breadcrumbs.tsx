import Link from "next/link";

export default function Breadcrumbs({
  items,
}: {
  items: { label: string; href?: string }[];
}) {
  return (
    <nav className="mb-3 flex flex-wrap items-center gap-1.5 font-mono text-xs text-ink-faint">
      {items.map((item, i) => (
        <span key={i} className="flex items-center gap-1.5">
          {i > 0 && <span className="text-edge-strong">/</span>}
          {item.href ? (
            <Link href={item.href} className="hover:text-accent">
              {item.label}
            </Link>
          ) : (
            <span className="text-ink-muted">{item.label}</span>
          )}
        </span>
      ))}
    </nav>
  );
}
