"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import OllamaStatusPill from "@/components/OllamaStatusPill";

type Skill = { id: string; name: string };
type Project = { id: string; name: string; skills: Skill[] };

type Match =
  | { kind: "project"; id: string; name: string; href: string }
  | { kind: "skill"; id: string; name: string; projectName: string; href: string };

const MAX_RESULTS = 8;

export default function TopBar({ projects }: { projects: Project[] }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const matches = useMemo<Match[]>(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const results: Match[] = [];
    for (const project of projects) {
      if (project.name.toLowerCase().includes(q)) {
        results.push({ kind: "project", id: project.id, name: project.name, href: `/projects/${project.id}` });
      }
      for (const skill of project.skills) {
        if (skill.name.toLowerCase().includes(q)) {
          results.push({
            kind: "skill",
            id: skill.id,
            name: skill.name,
            projectName: project.name,
            href: `/projects/${project.id}/skills/${skill.id}`,
          });
        }
      }
      if (results.length >= MAX_RESULTS) break;
    }
    return results.slice(0, MAX_RESULTS);
  }, [query, projects]);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  function go(match: Match) {
    router.push(match.href);
    setQuery("");
    setOpen(false);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      setOpen(false);
      return;
    }
    if (!open || matches.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % matches.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => (i - 1 + matches.length) % matches.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      go(matches[activeIndex]);
    }
  }

  return (
    <header className="flex h-14 shrink-0 items-center gap-4 border-b border-edge bg-surface px-6">
      <div ref={containerRef} className="relative w-full max-w-sm">
        <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-ink-faint" />
        <input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActiveIndex(0);
            setOpen(true);
          }}
          onFocus={() => query && setOpen(true)}
          onKeyDown={handleKeyDown}
          placeholder="Search projects and skills…"
          className="input pl-8"
        />
        {open && query && (
          <div className="absolute top-full left-0 z-30 mt-1.5 w-full overflow-hidden rounded-lg border border-edge bg-surface shadow-lg">
            {matches.length === 0 ? (
              <p className="px-3 py-3 text-[13px] text-ink-faint">No matches for &quot;{query}&quot;</p>
            ) : (
              <ul>
                {matches.map((match, i) => (
                  <li key={`${match.kind}-${match.id}`}>
                    <Link
                      href={match.href}
                      onClick={() => {
                        setQuery("");
                        setOpen(false);
                      }}
                      onMouseEnter={() => setActiveIndex(i)}
                      className={`flex items-center gap-2 px-3 py-2 text-[13px] transition-colors ${
                        i === activeIndex ? "bg-accent-soft text-accent" : "text-ink hover:bg-surface-2"
                      }`}
                    >
                      <span className={i === activeIndex ? "text-accent" : "text-ink-faint"}>
                        {match.kind === "project" ? <FolderIcon /> : <span className="font-mono text-[10px]">○</span>}
                      </span>
                      <span className="min-w-0 flex-1 truncate">{match.name}</span>
                      {match.kind === "skill" && (
                        <span className="shrink-0 truncate font-mono text-[11px] text-ink-faint">
                          {match.projectName}
                        </span>
                      )}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      <div className="flex-1" />

      <OllamaStatusPill />
    </header>
  );
}

function SearchIcon({ className = "" }: { className?: string }) {
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
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}

function FolderIcon() {
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
      aria-hidden
    >
      <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4l2 2h9A1.5 1.5 0 0 1 21 8.5v9A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z" />
    </svg>
  );
}
