import type { StepResult } from "@/server/types";

// The full candidate list + reasoning behind one Agent step (src/server/
// agent.ts's agentTask sets StepResult.agentDecision) — shared between the
// live view (LiveRunView.tsx, expanded inline while the run is happening)
// and the historical view (RunFlow.tsx, opened in a modal after the fact),
// so a prompt-driven run's choices read the same way whether you're
// watching it live or reviewing it later.
export default function AgentDecisionPanel({
  decision,
}: {
  decision: NonNullable<StepResult["agentDecision"]>;
}) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-[11px] font-medium tracking-wide text-ink-faint uppercase">
        Candidates considered
      </p>
      {decision.candidates.length === 0 ? (
        <p className="text-[12px] text-ink-muted">
          No known actions in the action graph matched this step at all.
        </p>
      ) : (
        <ol className="flex flex-col gap-1">
          {decision.candidates.map((c, i) => {
            const picked = i === decision.pickedIndex;
            return (
              <li
                key={i}
                className={`flex items-center gap-2 rounded-md px-2 py-1 text-[12px] ${
                  picked ? "bg-accent/10 text-ink" : "text-ink-muted"
                }`}
              >
                <span className={`shrink-0 font-mono text-[10px] ${picked ? "text-accent" : "text-ink-faint"}`}>
                  {picked ? "✓ picked" : "—"}
                </span>
                <span className="flex-1 truncate">{c.description}</span>
                <span className="shrink-0 text-ink-faint">
                  {c.role} · {c.status}
                </span>
                <span className="shrink-0 font-mono text-[11px] text-ink-faint">{c.similarity.toFixed(2)}</span>
              </li>
            );
          })}
        </ol>
      )}
      {decision.reasoning && (
        <p className="text-[12px] text-ink-muted italic">“{decision.reasoning}”</p>
      )}
    </div>
  );
}
