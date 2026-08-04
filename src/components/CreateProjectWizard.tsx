"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import Modal from "@/components/Modal";
import Spinner from "@/components/Spinner";
import { useToast } from "@/components/Toast";

type Step = "project" | "skill";

const STEPS: { key: Step; label: string }[] = [
  { key: "project", label: "Project" },
  { key: "skill", label: "Skill" },
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

  function openWizard() {
    setStep("project");
    setBusy(false);
    setError(null);
    setProjectName("");
    setProjectDescription("");
    setProjectId(null);
    setSkillName("");
    setStartUrl("");
    setOpen(true);
  }

  function closeWizard() {
    setOpen(false);
    // A project (and maybe a skill) may have been created even if the user
    // bails before the last step — refresh so the dashboard reflects it
    // either way.
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

  // Creates the skill, then immediately starts its session and navigates
  // straight to the real run page — no separate "start session" step or
  // in-modal live view. The modal's job is just collecting the two forms;
  // the actual session belongs on its own full page, already running by
  // the time you land on it.
  async function handleCreateSkill(e: React.FormEvent) {
    e.preventDefault();
    if (!projectId) return;
    setBusy(true);
    setError(null);
    const skillRes = await fetch(`/api/projects/${projectId}/skills`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: skillName, startUrl }),
    });
    const skillBody = await skillRes.json();
    if (!skillRes.ok) {
      setBusy(false);
      const message = skillBody.error ?? "Failed to create skill";
      setError(message);
      toast.error(message);
      return;
    }
    const skillId = skillBody.skill.id as string;
    const promptId = skillBody.skill.prompts[0].id as string;

    const runRes = await fetch(`/api/prompts/${promptId}/runs`, { method: "POST" });
    const runBody = await runRes.json();
    setBusy(false);
    if (!runRes.ok) {
      // The skill itself was created fine — only the auto-start failed —
      // so send them to the skill page rather than stranding them in the
      // modal with nothing left to retry in here.
      const message = runBody.error ?? "Skill created, but failed to start a session";
      toast.error(message);
      setOpen(false);
      router.push(`/projects/${projectId}/skills/${skillId}`);
      return;
    }
    setOpen(false);
    router.push(
      `/projects/${projectId}/skills/${skillId}/prompts/${promptId}/runs/${runBody.runId}`,
    );
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
                {busy ? "Starting session…" : "Create & start session"}
              </button>
            </form>
          )}
        </div>
      </Modal>
    </>
  );
}
