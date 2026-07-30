import { notFound } from "next/navigation";
import Link from "next/link";
import { verifySession } from "@/server/dal";
import { getProjectForUser } from "@/server/projects";
import { listSkillsForProjectWithLastRun } from "@/server/skills";
import Breadcrumbs from "@/components/Breadcrumbs";
import CreateSkillForm from "@/components/CreateSkillForm";
import DeleteButton from "@/components/DeleteButton";
import EmptyState from "@/components/EmptyState";
import { StatusBadge } from "@/components/LiveRunView";

export const dynamic = "force-dynamic";

const SKILLS_COLS = "grid-cols-[1fr_110px_110px_24px]";

export default async function ProjectPage(props: PageProps<"/projects/[projectId]">) {
  const session = await verifySession();
  const { projectId } = await props.params;

  const project = await getProjectForUser(projectId, session.userId);
  if (!project) notFound();

  const skills = await listSkillsForProjectWithLastRun(projectId);

  return (
    <div className="w-full px-8 py-6">
      <Breadcrumbs items={[{ label: "Dashboard", href: "/" }, { label: project.name }]} />

      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="page-title">{project.name}</h1>
          {project.description && (
            <p className="text-[13px] text-ink-muted">{project.description}</p>
          )}
        </div>
        <DeleteButton
          endpoint={`/api/projects/${projectId}`}
          confirmMessage="Delete this project and everything in it (skills, prompts, runs)?"
          redirectTo="/"
        />
      </div>

      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="eyebrow">Skills</h2>
          <CreateSkillForm projectId={projectId} />
        </div>
        {skills.length === 0 ? (
          <EmptyState title="No skills yet" description="Create one to give this project something to run." />
        ) : (
          <div className="card overflow-hidden">
            <div
              className={`grid ${SKILLS_COLS} items-center gap-3 border-b border-edge bg-surface-2/60 px-4 py-1.5 font-mono text-[10px] font-medium tracking-wider text-ink-faint uppercase`}
            >
              <span>Skill</span>
              <span>Last run</span>
              <span>Created</span>
              <span />
            </div>
            <ul>
              {skills.map((skill) => (
                <li key={skill.id}>
                  <Link
                    href={`/projects/${projectId}/skills/${skill.id}`}
                    className={`row group grid ${SKILLS_COLS} items-center gap-3`}
                  >
                    <div className="min-w-0">
                      <div className="truncate text-[13px] font-medium text-ink">
                        {skill.name}
                      </div>
                      <div className="truncate font-mono text-xs text-ink-faint">
                        {skill.startUrl}
                      </div>
                    </div>
                    {skill.lastRun ? (
                      <StatusBadge status={skill.lastRun.status} />
                    ) : (
                      <span className="text-xs text-ink-faint">No runs</span>
                    )}
                    <span className="font-mono text-xs text-ink-faint">
                      {new Date(skill.createdAt).toLocaleDateString()}
                    </span>
                    <span className="row-chevron">›</span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
