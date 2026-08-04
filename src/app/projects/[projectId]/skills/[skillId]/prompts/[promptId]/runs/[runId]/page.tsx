import { notFound } from "next/navigation";
import { verifySession } from "@/server/dal";
import { getRun } from "@/server/runManager";
import {
  getRunFromDb,
  getRunSummary,
  getSkillsMd,
  listAllVariantRuns,
  getAlternativePlans,
} from "@/server/runs";
import { hasArtifact } from "@/server/artifacts";
import { prisma } from "@/server/db";
import Breadcrumbs from "@/components/Breadcrumbs";
import FlowSummaryView from "@/components/FlowSummaryView";
import RunHeader from "@/components/RunHeader";
import type { RunRecord } from "@/server/types";

export const dynamic = "force-dynamic";

// Every Run under a skill shares the exact same promptText ("Manual
// session" — see SESSION_PROMPT_TEXT in src/server/skills.ts, the one
// hidden Prompt every skill gets), whether it's the real recording, a
// "Test the skill" replay, or a generated alternative variant — so showing
// it verbatim as this page's title is misleading for the latter two. Derive
// what this run actually is from sourceRunId/variantOfStepIndex instead.
function describeRunKind(record: RunRecord): string {
  if (record.variantOfStepIndex != null) {
    return record.variantLabel ? `Alternative session — ${record.variantLabel}` : "Alternative session";
  }
  if (record.sourceRunId) return "Test replay";
  return record.promptText;
}

export default async function RunPage(
  props: PageProps<"/projects/[projectId]/skills/[skillId]/prompts/[promptId]/runs/[runId]">,
) {
  const session = await verifySession();
  const { projectId, skillId, promptId, runId } = await props.params;

  const job = getRun(runId);
  const record: RunRecord | null = job?.record ?? (await getRunFromDb(runId));
  if (!record || record.userId !== session.userId || record.promptId !== promptId) {
    notFound();
  }

  const [hasVideo, hasTrace, summary, skillsMd, variantRuns, promptWithNames] = await Promise.all([
    hasArtifact(runId, "video.webm"),
    hasArtifact(runId, "trace.zip"),
    getRunSummary(runId),
    getSkillsMd(runId),
    listAllVariantRuns(runId),
    prisma.prompt.findUnique({
      where: { id: promptId },
      include: { skill: { include: { project: true } } },
    }),
  ]);

  // Cache-only reads — never runs the alternative-plan pipeline itself
  // (src/server/alternativesAgent.ts), just preloads whatever's already
  // been generated so a revisit doesn't look empty.
  const clickSteps = record.steps.filter(
    (s) => s.locator && (s.type === "manual-click" || s.type === "replay-click"),
  );
  const planEntries = await Promise.all(
    clickSteps.map((step) => getAlternativePlans(runId, step.index)),
  );
  const initialPlansByStep = Object.fromEntries(
    clickSteps.map((step, i) => [step.index, planEntries[i]]),
  );

  return (
    <div className="w-full px-8 py-6">
      <Breadcrumbs
        items={[
          { label: "Dashboard", href: "/" },
          {
            label: promptWithNames?.skill.project.name ?? "Project",
            href: `/projects/${projectId}`,
          },
          {
            label: promptWithNames?.skill.name ?? "Skill",
            href: `/projects/${projectId}/skills/${skillId}`,
          },
        ]}
      />

      <RunHeader
        runId={runId}
        projectId={projectId}
        skillId={skillId}
        runKind={describeRunKind(record)}
        createdAt={record.createdAt}
        status={record.status}
        startUrl={record.startUrl}
        stepCount={record.steps.length}
        startedAt={record.startedAt}
        finishedAt={record.finishedAt}
      />

      {record.error && (
        <p className="mb-4 rounded-md border border-error/25 bg-error/10 px-3 py-2 text-[13px] text-error">
          {record.error}
        </p>
      )}

      <FlowSummaryView
        runId={runId}
        projectId={projectId}
        skillId={skillId}
        promptId={promptId}
        skillName={promptWithNames?.skill.name ?? "skill"}
        startUrl={record.startUrl}
        initialSummary={summary}
        initialSkillsMd={skillsMd}
        steps={record.steps}
        initialVariantRuns={variantRuns}
        initialPlansByStep={initialPlansByStep}
        hasVideo={hasVideo}
        hasTrace={hasTrace}
      />
    </div>
  );
}
