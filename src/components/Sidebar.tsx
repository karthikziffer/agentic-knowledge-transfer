"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { logoutAction } from "@/server/actions";

type SidebarSkill = { id: string; name: string };
type SidebarProject = { id: string; name: string; skills: SidebarSkill[] };

const COLLAPSE_KEY = "sb-sidebar-collapsed";

export default function Sidebar({
  user,
  projects,
}: {
  user: { email: string; name: string | null };
  projects: SidebarProject[];
}) {
  const pathname = usePathname();
  const initial = (user.name || user.email).slice(0, 1).toUpperCase();
  const [collapsed, setCollapsed] = useState(false);
  const [expandOverrides, setExpandOverrides] = useState<Record<string, boolean>>({});

  useEffect(() => {
    // One-time sync from localStorage on mount — SSR has no access to it,
    // so the collapsed flag can't be part of the initial render without
    // causing a hydration mismatch.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (localStorage.getItem(COLLAPSE_KEY) === "1") setCollapsed(true);
  }, []);

  function toggleCollapsed() {
    setCollapsed((v) => {
      localStorage.setItem(COLLAPSE_KEY, v ? "0" : "1");
      return !v;
    });
  }

  function isProjectOpen(project: SidebarProject) {
    const isActive = pathname.startsWith(`/projects/${project.id}`);
    return expandOverrides[project.id] ?? isActive;
  }

  function toggleProject(project: SidebarProject) {
    setExpandOverrides((prev) => ({ ...prev, [project.id]: !isProjectOpen(project) }));
  }

  return (
    <aside
      className={`flex shrink-0 flex-col border-r border-edge bg-surface transition-[width] duration-200 ${
        collapsed ? "w-16" : "w-64"
      }`}
    >
      <div className={`flex h-14 items-center gap-1.5 ${collapsed ? "justify-center px-0" : "justify-between px-4"}`}>
        {!collapsed && (
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-accent text-[13px] font-bold text-white">
              S
            </span>
            <Link href="/" className="truncate text-[13px] font-semibold tracking-tight text-ink">
              Skill Builder
            </Link>
          </div>
        )}
        <button
          type="button"
          onClick={toggleCollapsed}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink"
        >
          <CollapseIcon collapsed={collapsed} />
        </button>
      </div>

      <nav className={`flex flex-1 flex-col gap-5 overflow-y-auto py-3 ${collapsed ? "px-2" : "px-3"}`}>
        <div className="flex flex-col gap-0.5">
          <SidebarLink href="/" active={pathname === "/"} icon={<GridIcon />} collapsed={collapsed}>
            Dashboard
          </SidebarLink>
        </div>

        {/* Every project renders the same generic FolderIcon — fine with a
            name/chevron next to it, but as a bare icon rail it's just a
            column of identical, misaligned-looking glyphs with nothing to
            actually distinguish one project from another. Hidden entirely
            in the collapsed rail rather than shown that way; "Dashboard"
            above still gets you back to the project list. */}
        {!collapsed && (
          <div className="flex flex-col gap-0.5">
            <div className="flex items-center justify-between px-2.5 pb-1">
              <span className="eyebrow">Projects</span>
              <Link
                href="/"
                className="font-mono text-[11px] font-medium text-ink-faint hover:text-accent"
                title="Create a project from the dashboard"
              >
                + new
              </Link>
            </div>
            {projects.length === 0 ? (
              <p className="px-2.5 text-[13px] text-ink-faint">No projects yet</p>
            ) : (
              projects.map((project) => {
                const open = isProjectOpen(project);
                return (
                  <div key={project.id}>
                    <div className="group/proj flex items-center">
                      <button
                        type="button"
                        onClick={() => toggleProject(project)}
                        aria-label={open ? `Collapse ${project.name}` : `Expand ${project.name}`}
                        className="flex h-6 w-6 shrink-0 items-center justify-center text-ink-faint transition-colors hover:text-ink"
                      >
                        {project.skills.length > 0 && (
                          <ChevronIcon className={`transition-transform duration-150 ${open ? "rotate-90" : ""}`} />
                        )}
                      </button>
                      <SidebarLink
                        href={`/projects/${project.id}`}
                        active={pathname === `/projects/${project.id}`}
                        icon={<FolderIcon />}
                        collapsed={false}
                        className="flex-1"
                      >
                        {project.name}
                      </SidebarLink>
                    </div>

                    {open && project.skills.length > 0 && (
                      <div className="mt-0.5 ml-[27px] flex flex-col gap-0.5 border-l border-edge pl-2.5">
                        {project.skills.map((skill) => (
                          <Link
                            key={skill.id}
                            href={`/projects/${project.id}/skills/${skill.id}`}
                            className={`flex items-center gap-2 truncate rounded-md px-2 py-1 text-[13px] font-medium transition-colors ${
                              pathname.startsWith(`/projects/${project.id}/skills/${skill.id}`)
                                ? "bg-accent-soft text-accent"
                                : "text-ink-muted hover:bg-surface-2 hover:text-ink"
                            }`}
                          >
                            <span className="truncate">{skill.name}</span>
                          </Link>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        )}
      </nav>

      <div className={`border-t border-edge py-3 ${collapsed ? "px-2" : "px-3"}`}>
        <div className="mb-2 flex flex-col gap-0.5">
          <SidebarLink
            href="/profile"
            active={pathname === "/profile"}
            icon={<UserIcon />}
            collapsed={collapsed}
          >
            Profile
          </SidebarLink>
          <SidebarLink
            href="/settings"
            active={pathname === "/settings"}
            icon={<GearIcon />}
            collapsed={collapsed}
          >
            Settings
          </SidebarLink>
        </div>

        <div className={`mb-2 flex items-center gap-2 px-2 ${collapsed ? "justify-center px-0" : ""}`}>
          <span
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[11px] font-semibold text-accent"
            title={user.name || user.email}
          >
            {initial}
          </span>
          {!collapsed && (
            <span className="truncate text-xs font-medium text-ink-muted">
              {user.name || user.email}
            </span>
          )}
        </div>
        <form action={logoutAction}>
          <button
            type="submit"
            title="Sign out"
            className={`btn btn-ghost w-full ${collapsed ? "justify-center px-0" : "justify-start px-2"}`}
          >
            <SignOutIcon />
            {!collapsed && "Sign out"}
          </button>
        </form>
      </div>
    </aside>
  );
}

function SidebarLink({
  href,
  active,
  icon,
  collapsed,
  className = "",
  children,
}: {
  href: string;
  active: boolean;
  icon: React.ReactNode;
  collapsed: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      title={collapsed ? String(children) : undefined}
      className={`flex min-w-0 items-center gap-2.5 truncate rounded-lg py-1.5 text-[13px] font-medium transition-colors ${
        collapsed ? "justify-center px-0" : "px-2.5"
      } ${active ? "bg-accent-soft text-accent" : "text-ink-muted hover:bg-surface-2 hover:text-ink"} ${className}`}
    >
      <span className={`shrink-0 ${active ? "text-accent" : "text-ink-faint"}`}>{icon}</span>
      {!collapsed && <span className="truncate">{children}</span>}
    </Link>
  );
}

const ICON_PROPS = {
  width: 16,
  height: 16,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

function GridIcon() {
  return (
    <svg {...ICON_PROPS} aria-hidden>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </svg>
  );
}

function UserIcon() {
  return (
    <svg {...ICON_PROPS} aria-hidden>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M4.5 20c1.5-4 4-6 7.5-6s6 2 7.5 6" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg {...ICON_PROPS} aria-hidden>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
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

function ChevronIcon({ className = "" }: { className?: string }) {
  return (
    <svg {...ICON_PROPS} width={12} height={12} className={`shrink-0 ${className}`} aria-hidden>
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

function CollapseIcon({ collapsed }: { collapsed: boolean }) {
  return (
    <svg {...ICON_PROPS} className={`shrink-0 transition-transform ${collapsed ? "rotate-180" : ""}`} aria-hidden>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M15 4v16" />
      <path d="M10.5 9.5 8 12l2.5 2.5" />
    </svg>
  );
}

function SignOutIcon() {
  return (
    <svg {...ICON_PROPS} aria-hidden>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="M16 17l5-5-5-5" />
      <path d="M21 12H9" />
    </svg>
  );
}
