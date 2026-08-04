// A best-effort, Playwright-idiomatic way to re-find the element a manual
// click/keystroke targeted — computed once at recording time (automation.ts)
// since it requires DOM access to the live page, not reconstructable later
// from a screenshot alone. Priority order, best-to-worst for stability
// across re-runs of the same page: testId > role+name > placeholder >
// visible text > css fallback. `cssSelector` is always computed regardless
// of which strategy wins, as a last-resort fallback.
export interface ElementLocator {
  strategy: "testId" | "role" | "placeholder" | "text" | "css";
  value: string;
  role?: string;
  cssSelector?: string;
  // The nearest landmark ancestor (nav/main/aside/header/footer, or a
  // [role=navigation|main|complementary|banner|contentinfo|search|region],
  // or an [aria-label]) at record time — used to scope replay lookups for
  // the weaker (role/placeholder/text) strategies. A "Quickstart" sidebar
  // link and a "Quickstart" main-content heading share identical text but
  // live in different landmarks, so scoping avoids that ambiguity outright
  // instead of having to disambiguate it after the fact.
  scopeSelector?: string;
  scopeDescription?: string;
  // Redundant corroborating signals captured alongside the primary locator
  // (automation.ts's computeStructuralSignals) — cheap, synchronous DOM
  // reads with no extra recording latency. Independent of the locator
  // strategy above, so when that strategy stops uniquely resolving at
  // replay time (locatorReplay.ts), these give other real evidence to check
  // a candidate against instead of falling straight back to a human.
  ancestorChain?: string;
  siblingBefore?: string;
  siblingAfter?: string;
  siblingIndex?: number;
}

export interface StepResult {
  index: number;
  type: string;
  description?: string;
  status: "pending" | "running" | "done" | "error";
  screenshot?: string;
  // Full-page DOM snapshots (filenames of artifacts, same pattern as
  // `screenshot`) taken immediately before and after this step's action —
  // lets the report page show exactly what changed in the page structure,
  // not just what it looked like.
  domBefore?: string;
  domAfter?: string;
  error?: string;
  startedAt: string;
  finishedAt?: string;
  url?: string;
  llmDecision?: unknown;
  // Viewport-relative click coordinates — only set for click steps, and
  // only as a last-resort replay hint (fragile across viewport sizes).
  x?: number;
  y?: number;
  locator?: ElementLocator;
  // Set at recording time (automation.ts) when the just-clicked element's
  // locator already matches more than one visible element on the page
  // *right then* — a strong predictor that a future replay will hit the
  // same "ambiguous" pause, surfaced immediately instead of only being
  // discovered later with nobody watching.
  recordedAmbiguityWarning?: string;
  // Set by the replay engine (src/server/replay.ts) on a step it
  // auto-drove, pointing at the source run's step index it replayed —
  // lets the UI mark which steps were automatic vs. human-handled.
  replayOf?: number;
  // Set on a "replay-paused" step when the vision-assist pipeline
  // (src/server/driftAssist.ts) found a candidate it believes matches the
  // recorded element. At "medium"/"low" confidence this is purely a
  // suggestion — the live view shows it with a "Use this match" button the
  // human has to press (RunJob.requestApplyDriftSuggestion in
  // src/server/runManager.ts). At "high" confidence, replay.ts applies it
  // automatically instead of pausing — see DriftSuggestion in driftAssist.ts.
  driftSuggestion?: {
    description: string;
    reasoning: string;
    locator: ElementLocator;
    confidence: "high" | "medium" | "low";
    // Which resolution stage produced this — the narrower, candidate-scoped
    // vision comparison, or the broader whole-page fallback that looks past
    // the original (possibly now-wrong) locator entirely.
    source: "semantic" | "live-llm";
    // Artifact filename (this run's own id) for the numbered, highlighted
    // screenshot driftAssist.ts drew over the live candidates and compared
    // against the original recording — persisted so the suggestion can be
    // reviewed later, not just discarded right after the vision call.
    candidatesScreenshot?: string;
  };
  // Set when a pause resolved via anything other than the trivially-correct
  // recorded locator (position/structural corroboration, a human's "Use
  // this match", or the semantic/live-LLM layers) — a proven-good override
  // written back onto the *source* run's own step (src/server/runs.ts's
  // healSourceStepLocator), so every future replay of this flow tries it
  // first (src/server/locatorReplay.ts's resolveHealedLocator) instead of
  // re-solving the same drift every single time. Additive, never replaces
  // `locator` — the original recording stays inspectable.
  healedLocator?: HealedLocatorRecord;
  // Set on an "agent-step" step (src/server/agent.ts's agentTask) — the full
  // decision trail behind that one planned step, not just the one-line
  // pass/fail description: every candidate action the vector search
  // shortlisted from the skill's action graph, which one (if any) the
  // picker LLM chose, and its stated reasoning. Surfaced in the UI so a
  // prompt-driven run is inspectable rather than a black box, especially
  // useful on a step that failed to match anything.
  agentDecision?: {
    plannedStep: string;
    candidates: { description: string; similarity: number; status: "explored" | "unexplored"; role: string }[];
    pickedIndex: number | null;
    reasoning: string;
  };
}

export interface HealedLocatorRecord {
  locator: ElementLocator;
  source: "position" | "structural" | "content" | "semantic" | "live-llm" | "human-suggestion";
  healedAt: string;
}

// Why a replay (src/server/replay.ts) handed control to a human mid-run —
// surfaced over the control-mode WS message so the live view can explain
// itself instead of just saying "you're in control" with no context.
export type ControlModeReason = "typing" | "drift";

// Forwarded from the live-view client straight onto the run's CDP session
// (Input.dispatchMouseEvent / Input.dispatchKeyEvent) during manual control
// — the `kind` values intentionally match CDP's own event `type` values so
// the server can pass them through without a translation layer.
export type ManualInputEvent =
  | {
      kind: "mousePressed" | "mouseReleased" | "mouseMoved";
      x: number;
      y: number;
      button?: "left" | "right" | "middle";
      clickCount?: number;
    }
  | { kind: "mouseWheel"; x: number; y: number; deltaX: number; deltaY: number }
  | {
      kind: "rawKeyDown" | "keyUp" | "char";
      key: string;
      code: string;
      keyCode: number;
      text?: string;
    };

// One entry in a crawl's goal-directed depth budget — see RunRecord's
// crawlDepthGoals below and actionGraph.ts's crawlTask.
export interface CrawlDepthGoal {
  depth: number;
  goal: number;
}

export interface RunRecord {
  id: string;
  userId: string;
  promptId: string;
  promptText: string;
  startUrl: string;
  status: "queued" | "running" | "completed" | "error";
  error?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  steps: StepResult[];
  // Set when this run is a deterministic replay of another run
  // (src/server/replay.ts) rather than a fresh manual recording.
  sourceRunId?: string;
  // Set when this run is one generated alternative for a single step of
  // sourceRunId (src/server/variation.ts) — clicked a different, real
  // element instead of what was actually recorded.
  variantOfStepIndex?: number;
  variantIndex?: number;
  variantLabel?: string;
  // The exact real target the alternative-suggestion pipeline
  // (src/server/alternativesAgent.ts) decided on for this variant, set at
  // creation time — variantTask (src/server/variation.ts) clicks it
  // directly rather than rediscovering or narrowing anything itself.
  variantTargetLocator?: ElementLocator;
  // Set when this run is a whole-site action-graph crawl for a skill
  // (src/server/actionGraph.ts) rather than a recording/replay/variant —
  // holds the Skill.id being crawled. See queue.ts's worker dispatch.
  crawlSkillId?: string;
  // Set when this run batch-executes every cataloged action in a skill's
  // action graph (src/server/actionGraph.ts's validateTask) to score how
  // many still work — holds the Skill.id being validated. See queue.ts's
  // worker dispatch.
  validateSkillId?: string;
  // Set alongside crawlSkillId — how many genuinely distinct pages (not
  // near-duplicates, see actionGraph.ts's crawlTask) to find at each
  // hop-distance from the start page before the crawl stops, e.g.
  // [{depth:1,goal:2},{depth:2,goal:4}] means "find 2 distinct pages one
  // click away, 4 two clicks away." Undefined/empty means the original
  // flat-budget behavior (MAX_PAGES/MAX_DEPTH), not goal-directed at all.
  crawlDepthGoals?: CrawlDepthGoal[];
  // Set alongside crawlSkillId/validateSkillId — the *source* run whose
  // "Create alternatives" tab this crawl/validation was launched from
  // (src/components/SkillActionGraph.tsx), not this crawl/validate run's own
  // id. Every PageState/ACTION node the crawl writes (src/server/
  // actionGraph.ts) is tagged with this, so each source run gets its own
  // independent action graph instead of one shared across every run under
  // the skill — switching to a different run's "Create alternatives" tab
  // shows that run's own (possibly empty) graph, not a leftover one.
  graphRunId?: string;
  // How many of the skill's cataloged actions to actually validate — set by
  // the user via the "Validate alternatives" count field. Undefined means
  // "every cataloged action" (the original default behavior).
  validateCount?: number;
  // Set when this run is a prompt-driven agent execution for a skill
  // (src/server/agent.ts's agentTask) — holds the Skill.id whose action
  // graph the agent searches for known actions, and the natural-language
  // instruction it's carrying out. See queue.ts's worker dispatch.
  agentSkillId?: string;
  agentPrompt?: string;
  // Set when this run executes a multi-step alternative plan (src/server/
  // alternativesAgent.ts's generateAlternativePlans, src/server/
  // variation.ts's variantTask) rather than the older single-click variant
  // — an ordered list of locators to click one after another, each on the
  // page the previous click landed on. variantTargetLocator above still
  // holds the *first* hop for backward compatibility with anything reading
  // just that field; this holds the full sequence (length 1 for what used
  // to be a plain single-click variant, length 2+ for a real plan).
  variantPlanSteps?: ElementLocator[];
}

// One real, already-discovered element the alternative-plan pipeline
// (src/server/alternativesAgent.ts) considers a genuinely distinct,
// meaningful alternative — `locator` always traces back to something
// `listInteractiveElements` (src/server/variationDiscovery.ts) actually
// found on the live page, never invented. One hop in an AlternativePlan
// below; a depth-1 plan is just `{ steps: [oneHop] }`.
export interface AlternativeSuggestion {
  description: string;
  locator: ElementLocator;
  reasoning: string;
}

// A full alternative path — one or more hops (AlternativeSuggestion) clicked
// in order, each on the page the previous hop landed on, starting from the
// recorded step's own page. `steps.length` is this plan's depth. Two plans
// of the *same* depth are only both kept if their `finalUrl`s differ — see
// generateAlternativePlans's per-depth dedup in src/server/alternativesAgent.ts.
export interface AlternativePlan {
  steps: AlternativeSuggestion[];
  finalUrl: string;
  finalDescription: string;
}

// Cached per-step output of the alternative-plan pipeline, stored on
// Run.alternativePlans keyed by step index (as a plain object, since
// Postgres Json columns don't preserve Map/array-sparseness well).
export type AlternativePlansByStep = Record<
  string,
  {
    plans: AlternativePlan[];
    model: string;
    generatedAt: string;
    depthGoals: CrawlDepthGoal[];
    // Artifact filename (uploadArtifact/getArtifactStream, this Run's own
    // id) for the target step's own page screenshot, captured once up front
    // — the graph UI's root node. Absent if the capture itself failed.
    rootScreenshot?: string;
  }
>;

// Emitted while src/server/alternativesAgent.ts's generateAlternativePlans()
// runs — published to Redis (src/server/redisPubSub.ts) by the alternatives
// worker (src/server/alternativesQueue.ts, a separate process from the web
// server) and relayed to the client as newline-delimited JSON by
// /api/runs/[runId]/alternatives/suggest, same "show what stage it's at"
// reasoning as FlowSummaryProgress below. `visited`/`plansFound` update
// continuously through "exploring" since a plan search can visit many pages
// before settling — a single "thinking..." spinner would give no sense of
// whether it's making progress or stuck.
export type AlternativesProgress =
  | { phase: "loading-context" }
  | { phase: "exploring"; visited: number; plansFound: number };

// Emitted while src/server/flowSummary.ts's generateFlowSummary() runs, so a
// caller (the /api/runs/[runId]/summary route, streamed to the client) can
// show what stage it's at instead of one opaque spinner for the whole thing.
export type FlowSummaryProgress =
  | { phase: "loading" }
  | { phase: "captioning"; completed: number; total: number }
  | { phase: "synthesizing" }
  | { phase: "done" };

// Generated on demand by the flow-summary agent (src/server/flowSummary.ts)
// from a completed run's steps — a plain-language narrative, independent of
// the run state machine above.
export interface RunFlowSummary {
  narrative: string;
  keySteps: string[];
  outcome: string;
  // `reasoning` is optional in the type (not just the prompt) because
  // summaries generated before this field existed are still stored as-is
  // in `Run.summary` — nothing migrates old JSON blobs, callers must
  // handle its absence rather than assume the schema is current.
  stepCaptions: { index: number; caption: string; reasoning?: string }[];
  model: string;
  generatedAt: string;
}
