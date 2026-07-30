"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import Modal from "@/components/Modal";
import Spinner from "@/components/Spinner";
import LiveRunView from "@/components/LiveRunView";
import { useToast } from "@/components/Toast";

type Step = "project" | "skill" | "run";

const STEPS: { key: Step; label: string }[] = [
  { key: "project", label: "Project" },
  { key: "skill", label: "Skill" },
  { key: "run", label: "Run" },
];

export default function CreateProjectWizard() {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>("project");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [projectName, setProjectName] = useState("");
  const [projectDescription, setProjectDescription] = useState("");
  const [projectId, setProjectId] = useState<string | null>(null);

  const [skillName, setSkillName] = useState("");
  const [startUrl, setStartUrl] = useState("");
  const [promptId, setPromptId] = useState<string | null>(null);

  const [runId, setRunId] = useState<string | null>(null);

  function openWizard() {
    setStep("project");
    setBusy(false);
    setError(null);
    setProjectName("");
    setProjectDescription("");
    setProjectId(null);
    setSkillName("");
    setStartUrl("");
    setPromptId(null);
    setRunId(null);
    setOpen(true);
  }

  function closeWizard() {
    setOpen(false);
    // A project (and maybe a skill/run) may have been created even if the
    // user bails before the last step — refresh so the dashboard reflects
    // it either way.
    router.refresh();
  }

  async function handleCreateProject(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: projectName, description: projectDescription }),
    });
    const body = await res.json();
    setBusy(false);
    if (!res.ok) {
      const message = body.error ?? "Failed to create project";
      setError(message);
      toast.error(message);
      return;
    }
    setProjectId(body.project.id);
    setStep("skill");
  }

  async function handleCreateSkill(e: React.FormEvent) {
    e.preventDefault();
    if (!projectId) return;
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/projects/${projectId}/skills`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: skillName, startUrl }),
    });
    const body = await res.json();
    setBusy(false);
    if (!res.ok) {
      const message = body.error ?? "Failed to create skill";
      setError(message);
      toast.error(message);
      return;
    }
    setPromptId(body.skill.prompts[0].id);
    setStep("run");
  }

  async function handleStartRun() {
    if (!promptId) return;
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/prompts/${promptId}/runs`, { method: "POST" });
    const body = await res.json();
    setBusy(false);
    if (!res.ok) {
      const message = body.error ?? "Failed to start run";
      setError(message);
      toast.error(message);
      return;
    }
    setRunId(body.runId);
  }

  return (
    <>
      <button type="button" onClick={openWizard} className="btn btn-primary">
        + New project
      </button>

      <Modal open={open} onClose={closeWizard} title="New project">
        <div className="flex flex-col gap-4 p-5">
          <ol className="flex items-center gap-2">
            {STEPS.map((s, i) => {
              const currentIndex = STEPS.findIndex((x) => x.key === step);
              const state = i < currentIndex ? "done" : i === currentIndex ? "current" : "upcoming";
              return (
                <li key={s.key} className="flex items-center gap-2">
                  <span
                    className={`flex h-5 w-5 items-center justify-center rounded-full font-mono text-[10px] font-medium ${
                      state === "done"
                        ? "bg-done text-white"
                        : state === "current"
                          ? "bg-accent text-white"
                          : "bg-surface-2 text-ink-faint"
                    }`}
                  >
                    {state === "done" ? "✓" : i + 1}
                  </span>
                  <span
                    className={`text-xs font-medium ${state === "upcoming" ? "text-ink-faint" : "text-ink"}`}
                  >
                    {s.label}
                  </span>
                  {i < STEPS.length - 1 && <span className="h-px w-6 bg-edge" aria-hidden />}
                </li>
              );
            })}
          </ol>

          {step === "project" && (
            <form onSubmit={handleCreateProject} className="flex flex-col gap-3">
              <label className="field-label">
                Name
                <input
                  autoFocus
                  required
                  className="input"
                  value={projectName}
                  onChange={(e) => setProjectName(e.target.value)}
                />
              </label>
              <label className="field-label">
                Description (optional)
                <input
                  className="input"
                  value={projectDescription}
                  onChange={(e) => setProjectDescription(e.target.value)}
                />
              </label>
              {error && <p className="text-xs text-error">{error}</p>}
              <button type="submit" disabled={busy} className="btn btn-primary self-start">
                {busy && <Spinner />}
                {busy ? "Creating…" : "Next: add a skill"}
              </button>
            </form>
          )}

          {step === "skill" && (
            <form onSubmit={handleCreateSkill} className="flex flex-col gap-3">
              <label className="field-label">
                Name
                <input
                  autoFocus
                  required
                  className="input"
                  value={skillName}
                  onChange={(e) => setSkillName(e.target.value)}
                />
              </label>
              <label className="field-label">
                Start URL
                <input
                  required
                  placeholder="https://example.com"
                  className="input"
                  value={startUrl}
                  onChange={(e) => setStartUrl(e.target.value)}
                />
                <span className="field-hint">
                  Every run for this skill starts here, under your direct control.
                </span>
              </label>

              {error && <p className="text-xs text-error">{error}</p>}
              <button type="submit" disabled={busy} className="btn btn-primary self-start">
                {busy && <Spinner />}
                {busy ? "Creating…" : "Next: start a run"}
              </button>
            </form>
          )}

          {step === "run" && (
            <div className="flex flex-col gap-3">
              {!runId ? (
                <>
                  <p className="text-[13px] text-ink-muted">
                    <span className="font-medium text-ink">{skillName}</span> is ready inside{" "}
                    <span className="font-medium text-ink">{projectName}</span>. Start a run to watch it
                    live right here.
                  </p>
                  {error && <p className="text-xs text-error">{error}</p>}
                  <div className="flex gap-2">
                    <button type="button" onClick={handleStartRun} disabled={busy} className="btn btn-primary">
                      {busy && <Spinner />}
                      {busy ? "Starting…" : "Start session"}
                    </button>
                    <button type="button" onClick={closeWizard} className="btn btn-secondary">
                      Skip for now
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <LiveRunView runId={runId} />
                  <button type="button" onClick={closeWizard} className="btn btn-secondary self-start">
                    Done
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </Modal>
    </>
  );
}
