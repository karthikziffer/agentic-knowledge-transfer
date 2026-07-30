import neo4j from "neo4j-driver";
import type { RunJob } from "./runManager";
import {
  launchRunBrowser,
  finalizeRunSession,
  screenshotStep,
  moveCursorOverlay,
  triggerClickRipple,
} from "./automation";
import { listInteractiveElements, type AlternativeTarget } from "./variationDiscovery";
import { clickResilient } from "./variation";
import { resolveLocator } from "./locatorReplay";
import { persistRun } from "./runs";
import { runCypher, ensureGraphSchema } from "./graphDb";
import { embedText } from "./embeddings";
import type { ElementLocator } from "./types";

// The resolved crawl-safety question: only ever auto-click nav links and
// tabs to discover a real destination — everything else (buttons, form
// fields, menu items, switches, ...) gets cataloged as an "unexplored" edge,
// never auto-executed. A real site's "Buy," "Delete," "Submit," "Log out"
// live behind exactly those other roles.
export const AUTO_FOLLOW_ROLES = new Set(["link", "tab"]);

// How far and how wide the crawler is allowed to wander from the skill's
// start URL in one pass — conservative defaults, kept modest since the
// queue is now also seeded with every previously-discovered-but-unvisited
// page (see crawlTask below), so a re-crawl already does more work per pass
// than it used to for the same budget. Lower than before as a memory
// safety margin too — a long crawl (screenshots, embeddings, an
// ever-growing in-page DOM) is real, sustained memory pressure on top of
// everything else in the Docker Compose stack.
const MAX_DEPTH = 2;
const MAX_PAGES = 10;

// Shared destination for every action the crawler chooses not to follow —
// keeps the graph schema simple (every :ACTION edge has two real endpoints)
// instead of leaving relationships dangling.
const UNEXPLORED_URL = "__unexplored__";

// How long one action gets, start to finish (navigate + resolve + click),
// before validateTask gives up on it and moves to the next one. Without
// this, a single bad action (an unreachable fromUrl, an element that never
// becomes actionable) could eat Playwright's own default timeouts one call
// at a time — goto's 30s alone — and with a user-selectable count that can
// run into the hundreds, a handful of stuck actions compounds into a
// validation run that looks frozen even though nothing has technically
// hung forever. Same "bound the whole attempt, not each sub-call"
// reasoning as CHAT_TIMEOUT_MS (flowSummary.ts) and EMBED_TIMEOUT_MS
// (embeddings.ts).
const VALIDATE_ACTION_TIMEOUT_MS = 15_000;

export async function upsertPageState(
  skillId: string,
  // The *source* run this node belongs to (RunRecord.graphRunId), not the
  // crawl run itself — every write is scoped by {skillId, runId} together so
  // each source run's "Create alternatives" tab gets its own independent
  // graph instead of one shared across every run under the skill.
  runId: string,
  url: string,
  description: string,
  screenshotArtifact?: string,
  // The crawl run (job.record.id) the screenshot was uploaded under —
  // artifacts are stored per-run (src/server/artifacts.ts), so the filename
  // alone isn't enough to build a servable URL; the graph UI needs both to
  // construct /api/artifacts/{screenshotRunId}/{screenshotArtifact}.
  screenshotRunId?: string,
): Promise<void> {
  await runCypher(
    `MERGE (p:PageState {skillId: $skillId, runId: $runId, url: $url})
     ON CREATE SET p.description = $description, p.screenshotArtifact = $screenshotArtifact,
                    p.screenshotRunId = $screenshotRunId, p.createdAt = datetime()
     ON MATCH SET p.description = $description,
                  p.screenshotArtifact = coalesce($screenshotArtifact, p.screenshotArtifact),
                  p.screenshotRunId = coalesce($screenshotRunId, p.screenshotRunId)`,
    { skillId, runId, url, description, screenshotArtifact: screenshotArtifact ?? null, screenshotRunId: screenshotRunId ?? null },
  );
}

// Guarantees a PageState node exists without touching an already-visited
// page's real title/screenshot — unlike upsertPageState above, there is
// deliberately no ON MATCH clause, so calling this against a node that
// already has real data (set by the actual crawl visit below) is a pure
// no-op rather than clobbering it with a placeholder.
async function ensurePageStateExists(
  skillId: string,
  runId: string,
  url: string,
  placeholderDescription: string,
): Promise<void> {
  await runCypher(
    `MERGE (p:PageState {skillId: $skillId, runId: $runId, url: $url})
     ON CREATE SET p.description = $description, p.createdAt = datetime()`,
    { skillId, runId, url, description: placeholderDescription },
  );
}

// `toUrl: null` means "cataloged, not (yet) executed" — points the edge at
// the shared UNEXPLORED_URL placeholder instead of a real page. The MERGE
// pattern matches on {skillId, runId, description, locatorKey} — the things
// that identify "the same action" across re-crawls of the same source run —
// so re-running a crawl updates an existing edge (fresh embedding/status/
// timestamp) rather than duplicating it.
export async function upsertAction(
  skillId: string,
  runId: string,
  fromUrl: string,
  target: AlternativeTarget,
  toUrl: string | null,
  autoFollowed: boolean,
): Promise<void> {
  const destUrl = toUrl ?? UNEXPLORED_URL;
  // The destination node must exist before the relationship MERGE below can
  // match it — a plain MATCH silently finds zero rows and no-ops the whole
  // write (no error) rather than failing loudly. In a BFS crawl, a freshly
  // auto-followed link's destination page hasn't been visited/created yet
  // at the moment it's first discovered, so this can't be skipped for the
  // "explored" case either — ensurePageStateExists leaves an already-real
  // node's title/screenshot untouched, only stamping a placeholder on a
  // genuinely new one, so this never clobbers data set by the actual visit.
  await ensurePageStateExists(skillId, runId, destUrl, toUrl === null ? "Not yet explored" : destUrl);
  const embedding = await embedText(target.description);
  const locatorKey = target.locator.cssSelector || target.locator.value;

  await runCypher(
    `MATCH (from:PageState {skillId: $skillId, runId: $runId, url: $fromUrl})
     MATCH (to:PageState {skillId: $skillId, runId: $runId, url: $destUrl})
     MERGE (from)-[a:ACTION {skillId: $skillId, runId: $runId, description: $description, locatorKey: $locatorKey}]->(to)
     SET a.role = $role,
         a.locator = $locatorJson,
         a.status = $status,
         a.autoFollowed = $autoFollowed,
         a.embedding = $embedding,
         a.discoveredAt = datetime()`,
    {
      skillId,
      runId,
      fromUrl,
      destUrl,
      description: target.description,
      locatorKey,
      role: target.role,
      locatorJson: JSON.stringify(target.locator),
      status: toUrl ? "explored" : "unexplored",
      autoFollowed,
      embedding,
    },
  );
}

export async function crawlTask(job: RunJob): Promise<void> {
  const skillId = job.record.crawlSkillId;
  const graphRunId = job.record.graphRunId;
  if (!skillId || !graphRunId) {
    job.record.status = "error";
    job.record.error = "This run is missing its crawl target skill";
    await persistRun(job.record).catch(() => {});
    return;
  }

  const session = await launchRunBrowser(job);
  if (!session) return;
  const { page, cdp } = session;

  try {
    await ensureGraphSchema();
    await page.goto(job.record.startUrl, { waitUntil: "domcontentloaded" });

    const startStep = job.addStep({
      type: "manual-start",
      description: "Crawl started",
      status: "done",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      url: page.url(),
    });
    startStep.screenshot = await screenshotStep(page, job.record.id, startStep.index).catch(
      () => undefined,
    );
    job.updateStep(startStep.index, startStep);
    await persistRun(job.record).catch(() => {});

    const visited = new Set<string>();
    // Every crawl used to start its BFS from scratch, discovering (and
    // permanently graphing) the same shallow layer of links every single
    // time without ever making progress on the pages found-but-never-
    // visited by a previous, budget-limited pass — the count of "no
    // preview" nodes only ever grew. Seed the queue with those too, so a
    // "Refresh graph" click actually advances the crawl instead of
    // re-treading the same ground.
    const previouslyDiscovered = await runCypher<{ url: string }>(
      `MATCH (p:PageState {skillId: $skillId, runId: $runId})
       WHERE p.url <> $unexploredUrl AND p.screenshotArtifact IS NULL
       RETURN p.url AS url`,
      { skillId, runId: graphRunId, unexploredUrl: UNEXPLORED_URL },
    ).catch(() => []);
    const queue: { url: string; depth: number }[] = [
      { url: page.url(), depth: 0 },
      ...previouslyDiscovered
        .filter((r) => r.url !== page.url())
        .map((r) => ({ url: r.url, depth: 0 })),
    ];
    // Every upsertAction() failure below is still caught (one bad element
    // shouldn't kill the whole crawl), but that used to mean a total
    // failure — e.g. Ollama going down mid-crawl — produced a "completed"
    // run that silently recorded little or nothing, with zero signal
    // anything went wrong. Counted here and reported in the closing step.
    let embedFailures = 0;
    function recordEmbedFailure(context: string, err: unknown) {
      embedFailures++;
      console.error(`[actionGraph] failed to record an action (${context})`, {
        skillId,
        runId: job.record.id,
        err,
      });
    }

    // Auto-follow is meant to explore the target site, not wander off it —
    // a real page almost always links out to other domains too (social
    // icons, "GitHub," a conference/ticket banner, footer links). Without
    // this, every one of those burns a full MAX_PAGES slot and a whole
    // page's worth of element-scanning/embedding time on content that has
    // nothing to do with the skill, which is what made real, content-heavy
    // sites (a docs site with GitHub/LinkedIn/YouTube icons, for instance)
    // feel like the crawl had stalled — it hadn't, it was just off exploring
    // an unrelated domain.
    const startOrigin = new URL(job.record.startUrl).origin;

    while (queue.length > 0 && visited.size < MAX_PAGES) {
      if (job.stopRequested) break;
      const next = queue.shift();
      if (!next) break;
      const { url, depth } = next;
      if (visited.has(url)) continue;
      visited.add(url);

      if (page.url() !== url) {
        await page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => {});
      }
      const currentUrl = page.url();
      const title = await page.title().catch(() => currentUrl);

      const step = job.addStep({
        type: "crawl-page",
        description: `Exploring ${title || currentUrl}`,
        status: "done",
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        url: currentUrl,
      });
      step.screenshot = await screenshotStep(page, job.record.id, step.index).catch(() => undefined);
      job.updateStep(step.index, step);
      await persistRun(job.record).catch(() => {});

      await upsertPageState(skillId, graphRunId, currentUrl, title || currentUrl, step.screenshot, job.record.id);

      const elements = await listInteractiveElements(cdp);
      for (const el of elements) {
        if (job.stopRequested) break;
        let canAutoFollow = depth < MAX_DEPTH && AUTO_FOLLOW_ROLES.has(el.role);
        const locator = canAutoFollow ? resolveLocator(page, el.locator) : null;

        // For a plain anchor, the href alone already tells us the
        // destination's origin — checking it up front skips the click
        // entirely for an off-site link, instead of navigating away and
        // back just to find out. Non-anchor "link"/"tab" roles (a custom
        // widget, a client-side tab switch) have no href to inspect here;
        // those fall through to the post-click check below instead.
        if (canAutoFollow && el.role === "link" && locator) {
          const href = await locator.getAttribute("href").catch(() => null);
          if (href) {
            try {
              if (new URL(href, currentUrl).origin !== startOrigin) canAutoFollow = false;
            } catch {
              // Unparseable href (e.g. "javascript:void(0)") — let the
              // post-click check be the judge instead of guessing here.
            }
          }
        }

        if (!canAutoFollow || !locator) {
          await upsertAction(skillId, graphRunId, currentUrl, el, null, false).catch((err) =>
            recordEmbedFailure(el.description, err),
          );
          continue;
        }

        const visible = await locator.isVisible().catch(() => false);
        if (!visible) {
          await upsertAction(skillId, graphRunId, currentUrl, el, null, false).catch((err) =>
            recordEmbedFailure(el.description, err),
          );
          continue;
        }

        try {
          const box = await locator.boundingBox().catch(() => null);
          if (box) {
            const x = box.x + box.width / 2;
            const y = box.y + box.height / 2;
            moveCursorOverlay(cdp, x, y);
            triggerClickRipple(cdp, x, y);
          }
          await clickResilient(locator, 5000);
          await page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
          const destUrl = page.url();
          // The click itself already succeeded (real navigation happened)
          // even if recording it fails — still worth queuing the
          // destination for exploration rather than losing it because of
          // one embedding hiccup.
          await upsertAction(skillId, graphRunId, currentUrl, el, destUrl, true).catch((err) =>
            recordEmbedFailure(el.description, err),
          );
          // Backstop for the cases the href pre-check couldn't cover (no
          // href, or the click's real navigation went somewhere the href
          // didn't predict) — never queue an off-site destination for
          // further crawling, same reasoning as the pre-check above.
          const destOrigin = (() => {
            try {
              return new URL(destUrl).origin;
            } catch {
              return null;
            }
          })();
          if (!visited.has(destUrl) && destUrl !== currentUrl && destOrigin === startOrigin) {
            queue.push({ url: destUrl, depth: depth + 1 });
          }
          // Return to the page this action was found on so the remaining
          // elements in this same batch are still evaluated against it,
          // rather than whatever page the click just landed on.
          if (page.url() !== currentUrl) {
            await page.goto(currentUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
          }
        } catch {
          // Couldn't actually click it (timed out, covered by something
          // else, etc.) — still worth cataloging as a known, if unreliable,
          // action rather than silently dropping it.
          await upsertAction(skillId, graphRunId, currentUrl, el, null, false).catch((err) =>
            recordEmbedFailure(el.description, err),
          );
        }
      }
    }

    {
      const pagesExplored = visited.size;
      const finishStep = job.addStep({
        type: "manual-finish",
        description:
          `Crawl finished — ${pagesExplored} page${pagesExplored === 1 ? "" : "s"} explored` +
          (embedFailures > 0 ? `, ${embedFailures} action${embedFailures === 1 ? "" : "s"} failed to record` : ""),
        status: embedFailures > 0 ? "error" : "done",
        error: embedFailures > 0 ? `${embedFailures} action(s) failed to record — see server logs` : undefined,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        url: page.url(),
      });
      job.updateStep(finishStep.index, finishStep);
      await persistRun(job.record).catch(() => {});
    }

    // A crawl has no human "Finish" gesture like a manual session — it
    // either drains its queue naturally (completed) or gets stopped mid-way
    // (the only other way out of the loop above).
    job.record.status = job.stopRequested ? "error" : "completed";
    job.record.error = job.stopRequested ? "Stopped by user" : undefined;
  } catch (err) {
    job.record.status = "error";
    job.record.error = job.stopRequested
      ? "Stopped by user"
      : err instanceof Error
        ? err.message
        : String(err);
  } finally {
    job.record.finishedAt = new Date().toISOString();
    await finalizeRunSession(job, session);
  }
}

// Batch-executes every cataloged action in a skill's graph — deliberately
// including ones the crawler above never auto-clicked (buttons, form
// submits: "Delete", "Submit", "Buy", "Log out"). Unlike crawlTask, this
// isn't gated by AUTO_FOLLOW_ROLES at all: this is a user-triggered,
// explicit "actually run everything and score it" pass, not the same
// safety-conscious discovery crawl. Each action is validated independently
// — always re-navigates to its own fromUrl rather than chaining off wherever
// the previous click landed, since a prior destructive action may have left
// the page in a different state.
export async function validateTask(job: RunJob): Promise<void> {
  const skillId = job.record.validateSkillId;
  const graphRunId = job.record.graphRunId;
  if (!skillId || !graphRunId) {
    job.record.status = "error";
    job.record.error = "This run is missing its validation target skill";
    await persistRun(job.record).catch(() => {});
    return;
  }

  const session = await launchRunBrowser(job);
  if (!session) return;
  const { page, cdp } = session;

  try {
    const allActions = await runCypher<{
      fromUrl: string;
      description: string;
      locator: string;
      locatorKey: string;
    }>(
      `MATCH (from:PageState {skillId: $skillId, runId: $runId})-[a:ACTION {skillId: $skillId, runId: $runId}]->(:PageState)
       RETURN from.url AS fromUrl, a.description AS description, a.locator AS locator, a.locatorKey AS locatorKey`,
      { skillId, runId: graphRunId },
    );
    // The user-selected count (src/components/SkillActionGraph.tsx's count
    // field) caps how many of the cataloged actions actually get executed —
    // undefined/out-of-range means "every cataloged action," the original
    // behavior. Cypher's own result order isn't meaningful here (no ORDER
    // BY), so this is already an arbitrary subset either way; no need for
    // an explicit random sample on top of that.
    const count = job.record.validateCount;
    const actions =
      typeof count === "number" && count > 0 && count < allActions.length
        ? allActions.slice(0, count)
        : allActions;

    const startStep = job.addStep({
      type: "manual-start",
      description: `Validating ${actions.length} action${actions.length === 1 ? "" : "s"}${
        actions.length !== allActions.length ? ` of ${allActions.length}` : ""
      }`,
      status: "done",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      url: page.url(),
    });
    job.updateStep(startStep.index, startStep);
    await persistRun(job.record).catch(() => {});

    let passed = 0;
    let failed = 0;

    for (const action of actions) {
      if (job.stopRequested) break;
      const locator: ElementLocator = JSON.parse(action.locator);
      const startedAt = new Date().toISOString();

      try {
        await Promise.race([
          (async () => {
            await page.goto(action.fromUrl, { waitUntil: "domcontentloaded" });
            const resolved = resolveLocator(page, locator);
            const visible = await resolved.isVisible().catch(() => false);
            if (!visible) throw new Error("Element not found or not visible");

            const box = await resolved.boundingBox().catch(() => null);
            if (box) {
              moveCursorOverlay(cdp, box.x + box.width / 2, box.y + box.height / 2);
              triggerClickRipple(cdp, box.x + box.width / 2, box.y + box.height / 2);
            }
            await clickResilient(resolved, 5000);
          })(),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error(`Action timed out after ${VALIDATE_ACTION_TIMEOUT_MS}ms`)),
              VALIDATE_ACTION_TIMEOUT_MS,
            ),
          ),
        ]);
        passed++;
        await recordValidationResult(skillId, graphRunId, action.fromUrl, action.description, action.locatorKey, "passed");

        const step = job.addStep({
          type: "validate-action",
          description: `✓ ${action.description}`,
          status: "done",
          startedAt,
          finishedAt: new Date().toISOString(),
          url: action.fromUrl,
          locator,
        });
        step.screenshot = await screenshotStep(page, job.record.id, step.index).catch(() => undefined);
        job.updateStep(step.index, step);
      } catch (err) {
        failed++;
        const message = err instanceof Error ? err.message : String(err);
        await recordValidationResult(
          skillId,
          graphRunId,
          action.fromUrl,
          action.description,
          action.locatorKey,
          "failed",
          message,
        ).catch(() => {});

        const step = job.addStep({
          type: "validate-action",
          description: `✗ ${action.description}: ${message}`,
          status: "error",
          error: message,
          startedAt,
          finishedAt: new Date().toISOString(),
          url: action.fromUrl,
          locator,
        });
        step.screenshot = await screenshotStep(page, job.record.id, step.index).catch(() => undefined);
        job.updateStep(step.index, step);
      }
      await persistRun(job.record).catch(() => {});
    }

    const summaryStep = job.addStep({
      type: "manual-finish",
      description: `Validated ${actions.length} action${actions.length === 1 ? "" : "s"} — ${passed} passed, ${failed} failed`,
      status: "done",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      url: page.url(),
    });
    summaryStep.screenshot = await screenshotStep(page, job.record.id, summaryStep.index).catch(
      () => undefined,
    );
    job.updateStep(summaryStep.index, summaryStep);
    await persistRun(job.record).catch(() => {});

    // Same philosophy as crawlTask/replay.ts: individual action failures are
    // expected, recorded output (that's the whole point of "score how many
    // failed") — only a genuine crash or user-requested stop makes the run
    // itself an error.
    job.record.status = job.stopRequested ? "error" : "completed";
    job.record.error = job.stopRequested ? "Stopped by user" : undefined;
  } catch (err) {
    job.record.status = "error";
    job.record.error = job.stopRequested
      ? "Stopped by user"
      : err instanceof Error
        ? err.message
        : String(err);
  } finally {
    job.record.finishedAt = new Date().toISOString();
    await finalizeRunSession(job, session);
  }
}

export interface GraphNode {
  url: string;
  description: string;
  screenshotArtifact?: string;
  screenshotRunId?: string;
}

export interface GraphEdge {
  fromUrl: string;
  toUrl: string;
  description: string;
  role: string;
  status: "explored" | "unexplored";
  autoFollowed: boolean;
  locator: ElementLocator;
  // Set by validateTask below once this action has actually been executed
  // (via the "Validate alternatives" flow) — absent until the first
  // validation pass runs.
  lastValidationStatus?: "passed" | "failed";
  lastValidatedAt?: string;
  lastValidationError?: string;
}

// Full node/edge list for one source run's crawled graph — shaped directly
// for the UI (src/components/SkillActionGraph.tsx) rather than raw Cypher
// rows. Scoped by {skillId, runId} together — runId (RunRecord.graphRunId)
// is what actually isolates one source run's graph from every other run's,
// skillId is kept alongside it mostly for potential future cross-run
// tooling, not as the partition key on its own anymore.
export async function getRunGraph(skillId: string, runId: string): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
  const nodeRows = await runCypher<{
    url: string;
    description: string;
    screenshotArtifact: string | null;
    screenshotRunId: string | null;
  }>(
    `MATCH (p:PageState {skillId: $skillId, runId: $runId})
     RETURN p.url AS url, p.description AS description, p.screenshotArtifact AS screenshotArtifact,
            p.screenshotRunId AS screenshotRunId`,
    { skillId, runId },
  );
  const edgeRows = await runCypher<{
    fromUrl: string;
    toUrl: string;
    description: string;
    role: string;
    status: string;
    autoFollowed: boolean;
    locator: string;
    lastValidationStatus: string | null;
    lastValidatedAt: string | null;
    lastValidationError: string | null;
  }>(
    `MATCH (from:PageState {skillId: $skillId, runId: $runId})-[a:ACTION {runId: $runId}]->(to:PageState {skillId: $skillId, runId: $runId})
     RETURN from.url AS fromUrl, to.url AS toUrl, a.description AS description, a.role AS role,
            a.status AS status, a.autoFollowed AS autoFollowed, a.locator AS locator,
            a.lastValidationStatus AS lastValidationStatus,
            toString(a.lastValidatedAt) AS lastValidatedAt,
            a.lastValidationError AS lastValidationError`,
    { skillId, runId },
  );

  return {
    nodes: nodeRows.map((n) => ({
      url: n.url,
      description: n.description,
      screenshotArtifact: n.screenshotArtifact ?? undefined,
      screenshotRunId: n.screenshotRunId ?? undefined,
    })),
    edges: edgeRows.map((e) => ({
      fromUrl: e.fromUrl,
      toUrl: e.toUrl,
      description: e.description,
      role: e.role,
      status: e.status as "explored" | "unexplored",
      autoFollowed: e.autoFollowed,
      locator: JSON.parse(e.locator) as ElementLocator,
      lastValidationStatus: (e.lastValidationStatus as "passed" | "failed" | null) ?? undefined,
      lastValidatedAt: e.lastValidatedAt ?? undefined,
      lastValidationError: e.lastValidationError ?? undefined,
    })),
  };
}

// Matched by the same {skillId, runId, description, locatorKey} tuple
// upsertAction uses as the edge's identity — a plain MATCH (not MERGE) is
// correct here since validateTask only ever validates actions that already
// exist.
async function recordValidationResult(
  skillId: string,
  runId: string,
  fromUrl: string,
  description: string,
  locatorKey: string,
  status: "passed" | "failed",
  errorMessage?: string,
): Promise<void> {
  await runCypher(
    `MATCH (from:PageState {skillId: $skillId, runId: $runId, url: $fromUrl})-[a:ACTION {skillId: $skillId, runId: $runId, description: $description, locatorKey: $locatorKey}]->(:PageState)
     SET a.lastValidationStatus = $status, a.lastValidatedAt = datetime(), a.lastValidationError = $errorMessage`,
    { skillId, runId, fromUrl, description, locatorKey, status, errorMessage: errorMessage ?? null },
  );
}

export interface SearchActionResult {
  fromUrl: string;
  toUrl: string;
  description: string;
  role: string;
  status: "explored" | "unexplored";
  locator: ElementLocator;
  similarity: number;
}

// Vector-search over actions discovered for this skill, ranked by how well
// their description matches the free-text prompt — the retrieval half of
// the write path above. `search_edges` (not `search`) because the embedding
// lives on the :ACTION relationship, not on a node.
//
// `runId` is optional and deliberately left that way: src/components/
// SkillActionGraph.tsx's own search box always passes the current source
// run's id, matching that tab's now run-scoped graph — but src/server/
// agent.ts's agentTask intentionally omits it, since the agent should be
// able to find and click a known action regardless of which run originally
// discovered it, not just the one it happens to be running under.
//
// The index itself isn't scoped by skill (one shared index across every
// skill crawled), so this over-fetches candidates and filters/truncates
// afterward rather than trusting the raw top-K to already contain enough
// matches for this skill (and run, when given).
export async function searchActions(
  skillId: string,
  prompt: string,
  topK = 5,
  runId?: string,
): Promise<SearchActionResult[]> {
  const queryEmbedding = await embedText(prompt);
  const overFetch = Math.min(topK * 5, 100);

  const rows = await runCypher<{
    fromUrl: string;
    toUrl: string;
    description: string;
    role: string;
    status: string;
    locator: string;
    similarity: number;
  }>(
    // startNode()/endNode() rather than a second MATCH pattern on `edge` —
    // Memgraph rejects re-binding a variable already YIELDed by the vector
    // search call inside a subsequent MATCH relationship pattern
    // ("Redeclaring variable").
    `CALL vector_search.search_edges('action_embeddings', $overFetch, $queryEmbedding) YIELD edge, similarity
     WITH edge, similarity, startNode(edge) AS from, endNode(edge) AS to
     WHERE edge.skillId = $skillId AND ($runId IS NULL OR edge.runId = $runId)
     RETURN from.url AS fromUrl, to.url AS toUrl, edge.description AS description, edge.role AS role,
            edge.status AS status, edge.locator AS locator, similarity
     ORDER BY similarity DESC
     LIMIT $topK`,
    // neo4j-driver sends plain JS numbers as Cypher Floats by default — both
    // vector_search.search_edges's limit argument and a Cypher LIMIT clause
    // require an actual Integer, so these two need explicit neo4j.int()
    // wrapping (unlike $queryEmbedding, which is genuinely a float list).
    { overFetch: neo4j.int(overFetch), queryEmbedding, skillId, runId: runId ?? null, topK: neo4j.int(topK) },
  );

  return rows.map((r) => ({
    fromUrl: r.fromUrl,
    toUrl: r.toUrl,
    description: r.description,
    role: r.role,
    status: r.status as "explored" | "unexplored",
    locator: JSON.parse(r.locator) as ElementLocator,
    similarity: r.similarity,
  }));
}
