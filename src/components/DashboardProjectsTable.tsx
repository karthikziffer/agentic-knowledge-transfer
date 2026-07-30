"use client";

import Link from "next/link";
import { useState } from "react";
import { StatusBadge } from "@/components/LiveRunView";
import EmptyState from "@/components/EmptyState";
import type { DashboardProjectRow } from "@/server/dashboard";

const COLS = "grid-cols-[28px_1fr_90px_140px_110px_28px]";

export default function DashboardProjectsTable({ projects }: { projects: DashboardProjectRow[] }) {
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(projects.length === 1 ? [projects[0].id] : []),
  );

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  if (projects.length === 0) {
    return <EmptyState title="No projects yet" description="Create one to start building skills." />;
  }

  return (
    <div className="card overflow-hidden">
      <div
        className={`grid ${COLS} items-center gap-3 border-b border-edge bg-surface-2/60 px-4 py-2 font-mono text-[10px] font-medium tracking-wider text-ink-faint uppercase`}
      >
        <span />
        <span>Project</span>
        <span>Skills</span>
        <span>Last run</span>
        <span>Created</span>
        <span />
      </div>

      {projects.map((project) => {
        const open = expanded.has(project.id);
        return (
          <div key={project.id}>
            <div
              role="button"
              tabIndex={0}
              onClick={() => toggle(project.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  toggle(project.id);
                }
              }}
              className={`group grid ${COLS} w-full cursor-pointer items-center gap-3 border-b border-edge px-4 py-3 text-left transition-colors last:border-b-0 hover:bg-surface-2/60`}
            >
              <ChevronIcon
                className={`text-ink-faint transition-transform duration-150 ${open ? "rotate-90" : ""}`}
              />
              <span className="flex min-w-0 items-center gap-3">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
                  <FolderIcon />
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-[13px] font-medium text-ink">{project.name}</span>
                  {project.description && (
                    <span className="block truncate text-xs text-ink-muted">{project.description}</span>
                  )}
                </span>
              </span>
              <span className="font-mono text-xs text-ink-muted">{project.skills.length}</span>
              <ProjectStatusSummary skills={project.skills} />
              <span className="font-mono text-xs text-ink-faint">
                {new Date(project.createdAt).toLocaleDateString()}
              </span>
              <Link
                href={`/projects/${project.id}`}
                onClick={(e) => e.stopPropagation()}
                title="Open project"
                className="flex h-6 w-6 items-center justify-center rounded-md text-ink-faint opacity-0 transition-opacity group-hover:opacity-100 hover:text-accent"
              >
                ›
              </Link>
            </div>

            {open && (
              <div className="bg-surface-2/30">
                {project.skills.length === 0 ? (
                  <div className="py-4 pl-11 text-[13px] text-ink-faint">No skills yet.</div>
                ) : (
                  project.skills.map((skill) => (
                    <Link
                      key={skill.id}
                      href={
                        skill.lastRun
                          ? `/projects/${project.id}/skills/${skill.id}/prompts/${skill.lastRun.promptId}/runs/${skill.lastRun.id}`
                          : `/projects/${project.id}/skills/${skill.id}`
                      }
                      className={`group grid ${COLS} items-center gap-3 border-b border-edge/60 py-2.5 pr-4 pl-11 transition-colors last:border-b-0 hover:bg-surface-2`}
                    >
                      <span />
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="min-w-0">
                          <span className="block truncate text-[13px] text-ink">{skill.name}</span>
                          <span className="block truncate font-mono text-[11px] text-ink-faint">
                            {skill.startUrl}
                          </span>
                        </span>
                      </span>
                      <span />
                      <span>
                        {skill.lastRun ? (
                          <StatusBadge status={skill.lastRun.status} />
                        ) : (
                          <span className="text-xs text-ink-faint">No runs</span>
                        )}
                      </span>
                      <span className="font-mono text-xs text-ink-faint">
                        {skill.lastRun ? new Date(skill.lastRun.createdAt).toLocaleDateString() : "—"}
                      </span>
                      <span className="flex h-6 w-6 items-center justify-center text-ink-faint opacity-0 transition-opacity group-hover:opacity-100">
                        ›
                      </span>
                    </Link>
                  ))
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// Rolls a project's skills' last-run statuses up into one glance-able
// badge on the collapsed row: any run still going takes priority, then
// any failure, then a clean "done", otherwise there's simply nothing to
// report yet.
function ProjectStatusSummary({ skills }: { skills: DashboardProjectRow["skills"] }) {
  const statuses = skills.map((s) => s.lastRun?.status).filter(Boolean) as string[];
  if (statuses.length === 0) return <span className="text-xs text-ink-faint">No runs</span>;
  if (statuses.some((s) => s === "running" || s === "queued")) return <StatusBadge status="running" />;
  if (statuses.some((s) => s === "error")) return <StatusBadge status="error" />;
  return <StatusBadge status="done" />;
}

const ICON_PROPS = {
  width: 14,
  height: 14,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

function ChevronIcon({ className = "" }: { className?: string }) {
  return (
    <svg {...ICON_PROPS} className={`shrink-0 ${className}`} aria-hidden>
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg {...ICON_PROPS} aria-hidden>
      <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4l2 2h9A1.5 1.5 0 0 1 21 8.5v9A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z" />
    </svg>
  );
}
