import { notFound } from "next/navigation";
import Link from "next/link";
import { verifySession } from "@/server/dal";
import { getProjectForUser } from "@/server/projects";
import { getSkillForUser, getSkillPrompt } from "@/server/skills";
import { listRunsForPrompt } from "@/server/runs";
import { listRuns } from "@/server/runManager";
import Breadcrumbs from "@/components/Breadcrumbs";
import DeleteButton from "@/components/DeleteButton";
import EditSkillDetails from "@/components/EditSkillDetails";
import CreateSessionButton from "@/components/CreateSessionButton";
import LiveSessionPanel from "@/components/LiveSessionPanel";
import EmptyState from "@/components/EmptyState";
import { StatusBadge } from "@/components/LiveRunView";
import type { RunRecord } from "@/server/types";

export const dynamic = "force-dynamic";

const HISTORY_COLS = "grid-cols-[1fr_110px_90px_24px]";

function formatDuration(startedAt?: string, finishedAt?: string): string {
  if (!startedAt || !finishedAt) return "—";
  const ms = new Date(finishedAt).getTime() - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
}

export default async function SkillPage(
  props: PageProps<"/projects/[projectId]/skills/[skillId]">,
) {
  const session = await verifySession();
  const { projectId, skillId } = await props.params;

  const project = await getProjectForUser(projectId, session.userId);
  if (!project) notFound();
  const skill = await getSkillForUser(skillId, session.userId);
  if (!skill || skill.projectId !== projectId) notFound();

  const prompt = await getSkillPrompt(skillId);

  let runs: RunRecord[] = [];
  let activeRun: RunRecord | undefined;
  if (prompt) {
    const inMemory = listRuns().filter((r) => r.promptId === prompt.id);
    const seen = new Set(inMemory.map((r) => r.id));
    const fromDb = (await listRunsForPrompt(prompt.id)).filter((r) => !seen.has(r.id));
    // None of these are a fresh recording of their own, and each is already
    // reachable from wherever it was actually launched — "Test the skill"
    // replays and generated alternatives (sourceRunId) from the Run page's
    // Test/Create-alternatives tabs, crawl/validate/agent runs from the
    // Create-alternatives/Agent tabs themselves — so keep this table (and
    // the "Live session" panel below, which picks its run from this same
    // list) to real recordings only.
    const isDerivedRun = (r: RunRecord) =>
      Boolean(r.sourceRunId || r.crawlSkillId || r.validateSkillId || r.agentSkillId);
    runs = [...inMemory, ...fromDb]
      .filter((r) => !isDerivedRun(r))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    // A session already in flight for this skill — the header button reads
    // this instead of offering to start a second one on top.
    activeRun = runs.find((r) => r.status === "queued" || r.status === "running");
  }

  return (
    <div className="w-full px-8 py-6">
      <Breadcrumbs
        items={[
          { label: "Dashboard", href: "/" },
          { label: project.name, href: `/projects/${projectId}` },
          { label: skill.name },
        ]}
      />

      <div className="mb-6 flex items-start justify-between gap-4">
        <EditSkillDetails
          projectId={projectId}
          skillId={skillId}
          initialName={skill.name}
          initialStartUrl={skill.startUrl}
        />
        <div className="flex shrink-0 items-center gap-2">
          {prompt && (
            <CreateSessionButton
              promptId={prompt.id}
              runId={activeRun?.id}
              status={activeRun?.status}
            />
          )}
          <DeleteButton
            endpoint={`/api/projects/${projectId}/skills/${skillId}`}
            confirmMessage="Delete this skill and all its sessions?"
            redirectTo={`/projects/${projectId}`}
          />
        </div>
      </div>

      {!prompt ? (
        <p className="text-[13px] text-error">No session found for this skill.</p>
      ) : (
        <div className="flex flex-col gap-6">
          {activeRun && (
            <div>
              <h2 className="eyebrow mb-3">Live session</h2>
              <LiveSessionPanel runId={activeRun.id} />
            </div>
          )}

          <div>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="eyebrow">Session history</h2>
              <span className="font-mono text-[11px] text-ink-faint">{runs.length} sessions</span>
            </div>
            {runs.length === 0 ? (
              <EmptyState
                title="No sessions yet"
                description="Create one above to see it here."
              />
            ) : (
              <div className="card overflow-hidden">
                <div
                  className={`sticky top-0 z-10 grid ${HISTORY_COLS} items-center gap-3 border-b border-edge bg-surface-2/95 px-4 py-1.5 font-mono text-[10px] font-medium tracking-wider text-ink-faint uppercase backdrop-blur`}
                >
                  <span>Started</span>
                  <span>Status</span>
                  <span>Duration</span>
                  <span />
                </div>
                <ul>
                  {runs.map((run) => (
                    <li key={run.id}>
                      <Link
                        href={`/projects/${projectId}/skills/${skillId}/prompts/${prompt.id}/runs/${run.id}`}
                        className={`row group grid ${HISTORY_COLS} items-center gap-3`}
                      >
                        <span className="truncate font-mono text-xs text-ink-muted">
                          {new Date(run.createdAt).toLocaleString()}
                        </span>
                        <StatusBadge status={run.status} />
                        <span className="font-mono text-xs text-ink-faint">
                          {formatDuration(run.startedAt, run.finishedAt)}
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
      )}
    </div>
  );
}
