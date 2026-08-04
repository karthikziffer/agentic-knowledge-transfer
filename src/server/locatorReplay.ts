import type { Page, Locator } from "playwright";
import { DESCRIBE_AND_LOCATE_JS, STRUCTURAL_SIGNALS_JS } from "./automation";
import { embedText } from "./embeddings";
import type { ElementLocator, StepResult } from "./types";

// Playwright's getByRole only accepts a fixed ARIA role union, not a plain
// string — our captured `locator.role` is a plain string computed in-page
// (automation.ts), which could in principle be something outside that
// union (e.g. an explicit but nonstandard `role` attribute). Cast at this
// one boundary rather than validating: an invalid role just resolves to
// zero matches at runtime, which resolveStepTarget already treats as
// "not found" — a safe failure mode, not a crash.
type AriaRole = Parameters<Page["getByRole"]>[0];

// The exact inverse of formatPlaywrightLocator in src/server/skillsMd.ts —
// that turns an ElementLocator into a *string* for humans to read; this
// turns it into an *executable* Playwright locator. `useScope` defaults to
// true — pass false to force the page-wide search, used as a fallback in
// resolveStepTarget when the recorded scope no longer resolves to anything
// (the page restructured since recording).
export function resolveLocator(page: Page, locator: ElementLocator, useScope = true): Locator {
  const scopable = locator.strategy === "role" || locator.strategy === "text" || locator.strategy === "placeholder";
  const root: Page | Locator =
    useScope && scopable && locator.scopeSelector ? page.locator(locator.scopeSelector) : page;
  switch (locator.strategy) {
    case "testId":
      return page.getByTestId(locator.value);
    case "role":
      // exact: true — Playwright's default (false) is a case-insensitive
      // *substring* match, but `locator.value` was captured as the
      // element's full, exact accessible name (automation.ts). Without
      // this, any other element whose name merely contains the recorded
      // one as a substring counts as a match too — false "ambiguous"
      // results at best, a silently wrong single match at worst.
      return root.getByRole((locator.role ?? "") as AriaRole, { name: locator.value, exact: true });
    case "placeholder":
      return root.getByPlaceholder(locator.value, { exact: true });
    case "text":
      return root.getByText(locator.value, { exact: true });
    case "css":
      return page.locator(locator.cssSelector || locator.value);
  }
}

export type ResolveResult =
  // `healedVia` is only set when resolution needed one of the corroboration
  // layers below (position/structural/content) rather than the recorded
  // locator resolving trivially on its own — the caller (replay.ts) uses it
  // to decide whether there's anything worth healing back onto the source
  // run's step (src/server/runs.ts's healSourceStepLocator). A trivial
  // single-match success has nothing to learn from; it already worked.
  | { ok: true; locator: Locator; healedVia?: "position" | "structural" | "content" }
  | { ok: false; reason: "not found"; detail?: string }
  // `detail` is extra diagnostic text (e.g. actual pixel distances) shown
  // alongside the generic reason in the replay pause step — without it, a
  // repeated "ambiguous"/"drifted" pause is a black box with no way to tell
  // whether the position check almost worked or wasn't close at all.
  // `candidates` carries the real, currently-resolved elements behind the
  // pause forward to the vision-assist pipeline (src/server/driftAssist.ts)
  // so it doesn't have to re-run the same query. `positionDistances` and
  // `contentSimilarities`, when available, are parallel to `candidates` —
  // the vision pipeline folds these numbers into its own prompt so a
  // near-miss on position/content (too far/dissimilar to trust on its own)
  // can still count as supporting evidence alongside what the model sees in
  // the screenshots, instead of the checks being fully blind to each other.
  | {
      ok: false;
      reason: "ambiguous" | "drifted";
      detail?: string;
      candidates: Locator[];
      positionDistances?: (number | null)[];
      contentSimilarities?: (number | null)[];
    };

// How close (px) a candidate's current center must be to where the step was
// originally clicked (step.x/step.y, captured live in automation.ts) to
// trust it as the same element, and — when disambiguating multiple
// candidates — how much closer than the runner-up it must be. Both required
// so multi-candidate resolution only fires for genuine near-duplicates (e.g.
// a desktop nav copy vs. a mobile-menu copy both visible at once) — not two
// unrelated elements that happen to share an accessible name but sit in
// different parts of the page.
const POSITION_MATCH_MAX_DISTANCE = 40;
const POSITION_MATCH_MIN_MARGIN = 30;

async function distanceFromRecordedPoint(candidate: Locator, x: number, y: number): Promise<number | null> {
  const box = await candidate.boundingBox().catch(() => null);
  if (!box) return null;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  return Math.hypot(cx - x, cy - y);
}

// Picks the one candidate whose current position clearly, unambiguously
// corresponds to the recorded click point — returns no locator (not a
// guess) if the closest candidate isn't close enough, or if a runner-up is
// nearly as close (genuine ambiguity, not just stale coordinates). `detail`
// always explains the outcome, success or failure, in actual pixel terms.
async function pickByRecordedPosition(
  candidates: Locator[],
  x: number,
  y: number,
): Promise<{ locator: Locator | null; detail: string; distances: (number | null)[] }> {
  // `distances` stays parallel to `candidates` (index-aligned, nulls kept in
  // place) — callers forward it as-is to the vision-assist pipeline, which
  // describes candidates in this same order.
  const distances: (number | null)[] = [];
  const ranked: { index: number; distance: number }[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const distance = await distanceFromRecordedPoint(candidates[i], x, y);
    distances.push(distance);
    if (distance !== null) ranked.push({ index: i, distance });
  }
  if (ranked.length === 0) {
    return { locator: null, detail: "none of the candidates exposed a position to compare", distances };
  }
  ranked.sort((a, b) => a.distance - b.distance);
  const [closest, runnerUp] = ranked;
  const closestPx = Math.round(closest.distance);
  if (closest.distance > POSITION_MATCH_MAX_DISTANCE) {
    return {
      locator: null,
      detail: `closest candidate was ${closestPx}px from the recorded click point (needed ≤${POSITION_MATCH_MAX_DISTANCE}px)`,
      distances,
    };
  }
  if (runnerUp && runnerUp.distance - closest.distance < POSITION_MATCH_MIN_MARGIN) {
    return {
      locator: null,
      detail: `closest candidate was ${closestPx}px away, but another was ${Math.round(runnerUp.distance)}px away — too close to call`,
      distances,
    };
  }
  return { locator: candidates[closest.index], detail: `${closestPx}px from the recorded click point`, distances };
}

interface StructuralSignals {
  ancestorChain: string;
  siblingBefore: string;
  siblingAfter: string;
  siblingIndex: number;
}

async function structuralSignalsOf(candidate: Locator): Promise<StructuralSignals | null> {
  return (await candidate
    .evaluate(`(el) => { ${STRUCTURAL_SIGNALS_JS} return computeStructuralSignals(el); }`)
    .catch(() => null)) as StructuralSignals | null;
}

// True only when every signal actually captured at record time (automation.
// ts's computeStructuralSignals) is present and exactly equal on the live
// candidate — a partial match counts as no match, same "never guess" bar as
// the position check above. Returns false with nothing to compare against
// at all (an old recording predating this, or an element with no siblings/
// ancestors worth recording).
function structuralSignalsMatch(recorded: ElementLocator, live: StructuralSignals | null): boolean {
  if (!live) return false;
  const checks: boolean[] = [];
  if (recorded.ancestorChain !== undefined) checks.push(recorded.ancestorChain === live.ancestorChain);
  if (recorded.siblingBefore !== undefined) checks.push(recorded.siblingBefore === live.siblingBefore);
  if (recorded.siblingAfter !== undefined) checks.push(recorded.siblingAfter === live.siblingAfter);
  if (recorded.siblingIndex !== undefined) checks.push(recorded.siblingIndex === live.siblingIndex);
  if (checks.length === 0) return false;
  return checks.every(Boolean);
}

// Picks the one candidate whose structural signals (ancestor breadcrumb,
// sibling text/position) exactly match everything recorded — a second,
// independent line of evidence from the position check, for when a step has
// no recorded coordinates or the page has scrolled/reflowed enough that
// position alone can't decide. Returns null (not a guess) unless exactly
// one candidate matches on every signal that was actually recorded.
async function pickByStructuralMatch(candidates: Locator[], recorded: ElementLocator): Promise<Locator | null> {
  const matches: Locator[] = [];
  for (const candidate of candidates) {
    const live = await structuralSignalsOf(candidate);
    if (structuralSignalsMatch(recorded, live)) matches.push(candidate);
  }
  return matches.length === 1 ? matches[0] : null;
}

// How similar (cosine, on nomic-embed-text embeddings of the recorded vs.
// live sibling text) a candidate's textual neighborhood must be to trust it
// as the same element, and — when disambiguating multiple candidates — how
// much more similar than the runner-up. A third, independent corroboration
// layer alongside position and exact structural match: tolerant of *minor*
// content drift (a price or count that changed) in a way exact string
// equality (structuralSignalsMatch above) never can be, while still keeping
// a high, wide-margin bar — a wrong guess here is a wrong click, same
// "never guess" standard as the other two layers. Not empirically tuned
// against real drift examples yet; revisit these if they prove too strict
// or too loose in practice.
const CONTENT_SIMILARITY_MIN_SCORE = 0.9;
const CONTENT_SIMILARITY_MIN_MARGIN = 0.05;

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// The element's *own* text is deliberately excluded — every ambiguous
// candidate already shares it (that's what makes them ambiguous in the
// first place). Its neighbors' text is what actually varies row-to-row,
// list-item-to-list-item, which is exactly what makes it useful here.
function contentSignatureOf(siblingBefore?: string, siblingAfter?: string): string | null {
  const text = [siblingBefore, siblingAfter].filter(Boolean).join(" | ").trim();
  return text.length > 0 ? text : null;
}

// Third corroboration layer, tried after position and exact structural match
// both fail to decide — embeds the recorded element's neighboring text
// (siblingBefore/siblingAfter, already captured at record time by
// automation.ts's computeStructuralSignals) and each live candidate's
// current neighboring text, then picks the one whose embedding is closest,
// under the same "confident, not a close call" double gate as
// pickByRecordedPosition above. Returns no locator (not a guess) if there's
// nothing recorded to compare, if no candidate has comparable text, or if
// the closest candidate isn't convincingly closer than the runner-up.
// `similarities` stays parallel to `candidates` (nulls where no comparison
// was possible) so callers can forward it to the vision-assist pipeline the
// same way pickByRecordedPosition's distances are forwarded.
async function pickByContentSimilarity(
  candidates: Locator[],
  recorded: ElementLocator,
): Promise<{ locator: Locator | null; detail: string; similarities: (number | null)[] }> {
  const recordedSignature = contentSignatureOf(recorded.siblingBefore, recorded.siblingAfter);
  if (!recordedSignature) {
    return { locator: null, detail: "no recorded surrounding text to compare", similarities: candidates.map(() => null) };
  }

  let recordedEmbedding: number[];
  try {
    recordedEmbedding = await embedText(recordedSignature);
  } catch {
    return {
      locator: null,
      detail: "couldn't embed the recorded surrounding text",
      similarities: candidates.map(() => null),
    };
  }

  const similarities: (number | null)[] = [];
  const ranked: { index: number; similarity: number }[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const live = await structuralSignalsOf(candidates[i]);
    const signature = live ? contentSignatureOf(live.siblingBefore, live.siblingAfter) : null;
    if (!signature) {
      similarities.push(null);
      continue;
    }
    try {
      const embedding = await embedText(signature);
      const similarity = cosineSimilarity(recordedEmbedding, embedding);
      similarities.push(similarity);
      ranked.push({ index: i, similarity });
    } catch {
      similarities.push(null);
    }
  }

  if (ranked.length === 0) {
    return { locator: null, detail: "none of the candidates had surrounding text to compare", similarities };
  }
  ranked.sort((a, b) => b.similarity - a.similarity);
  const [closest, runnerUp] = ranked;
  const closestPct = Math.round(closest.similarity * 100);
  if (closest.similarity < CONTENT_SIMILARITY_MIN_SCORE) {
    return {
      locator: null,
      detail: `closest candidate's surrounding text was only ${closestPct}% similar (needed ≥${Math.round(CONTENT_SIMILARITY_MIN_SCORE * 100)}%)`,
      similarities,
    };
  }
  if (runnerUp && closest.similarity - runnerUp.similarity < CONTENT_SIMILARITY_MIN_MARGIN) {
    return {
      locator: null,
      detail: `closest candidate's surrounding text was ${closestPct}% similar, but another was ${Math.round(runnerUp.similarity * 100)}% similar — too close to call`,
      similarities,
    };
  }
  return { locator: candidates[closest.index], detail: `${closestPct}% similar surrounding text`, similarities };
}

// Counts how many currently-visible elements a locator matches — the same
// scope-then-unscoped-fallback, prefer-visible resolution resolveStepTarget
// uses below, exposed standalone so the recorder (automation.ts) can warn
// about an ambiguous locator the instant it's captured, right when a human
// is still there to see it, instead of only discovering it at some future
// replay with nobody watching.
export async function countVisibleMatches(page: Page, locator: ElementLocator): Promise<number> {
  const resolved = resolveLocator(page, locator);
  let matches = await resolved.all().catch(() => []);
  if (matches.length === 0 && locator.scopeSelector) {
    matches = await resolveLocator(page, locator, false)
      .all()
      .catch(() => []);
  }
  if (matches.length === 0) return 0;
  let visibleCount = 0;
  for (const candidate of matches) {
    if (await candidate.isVisible().catch(() => false)) visibleCount++;
  }
  return visibleCount > 0 ? visibleCount : matches.length;
}

// Tries a previously-healed override (StepResult.healedLocator, written by
// runs.ts's healSourceStepLocator) before the normal recorded-locator
// pipeline runs at all — the fast, already-proven path. Only trusted if it
// still resolves to exactly one visible element; returns null rather than
// guessing if it doesn't, so a stale healed override degrades gracefully
// back to the full resolution pipeline instead of becoming a trap of its
// own (see walkSourceSteps in replay.ts).
export async function resolveHealedLocator(page: Page, locator: ElementLocator): Promise<Locator | null> {
  const resolved = resolveLocator(page, locator);
  const matches = await resolved.all().catch(() => []);
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0];
  const visible: Locator[] = [];
  for (const candidate of matches) {
    if (await candidate.isVisible().catch(() => false)) visible.push(candidate);
  }
  return visible.length === 1 ? visible[0] : null;
}

// Turns an already-matched Locator into a storable ElementLocator override
// — reuses the exact same in-page description logic recording uses
// (automation.ts) so the result's cssSelector is always positionally
// unique, regardless of whether the *original* recorded locator's strategy
// (e.g. a non-unique role+name) is what got this candidate matched in the
// first place. Used for locator healing (runs.ts) and by driftAssist.ts's
// candidate descriptions.
export async function elementLocatorForCandidate(candidate: Locator): Promise<ElementLocator | null> {
  const result = (await candidate
    .evaluate(`(el) => { ${DESCRIBE_AND_LOCATE_JS} return describeAndLocate(el); }`)
    .catch(() => null)) as { locator: ElementLocator | null } | null;
  const cssSelector = result?.locator?.cssSelector;
  return cssSelector ? { strategy: "css", value: cssSelector, cssSelector } : null;
}

// Resolves a recorded step's locator against the *current* page and
// decides whether it's safe to trust — the replay engine (src/server/
// replay.ts) never guesses, so anything short of "exactly one confident
// match" is treated as drift and handed to a human. A recorded click
// position that clearly corroborates a candidate (see pickByRecordedPosition
// above) counts as confident evidence from the original recording, though —
// not an invented guess — and can resolve both a multi-match "ambiguous"
// case and a single-match "drifted" (css tag mismatch) case.
export async function resolveStepTarget(page: Page, step: StepResult): Promise<ResolveResult> {
  if (!step.locator) return { ok: false, reason: "not found" };

  const locator = resolveLocator(page, step.locator);
  let matches = await locator.all().catch(() => []);
  if (matches.length === 0 && step.locator.scopeSelector) {
    // The recorded landmark scope no longer matches anything current (the
    // page restructured since recording) — fall back to the unscoped,
    // page-wide search rather than treating this as "not found" outright.
    matches = await resolveLocator(page, step.locator, false)
      .all()
      .catch(() => []);
  }
  if (matches.length === 0) return { ok: false, reason: "not found" };

  // A recorded click could only ever have landed on a *visible* element —
  // many real sites render the same nav link twice (a desktop sidebar copy
  // and a mobile-menu copy, CSS-hidden depending on viewport), both
  // matching the exact same accessible name/text. That's not genuine
  // ambiguity once you exclude what a human physically couldn't have
  // clicked. Only fall back to counting hidden matches too if literally
  // nothing is visible — same "not found"/"ambiguous" behavior as before
  // in that edge case.
  const visible: Locator[] = [];
  for (const candidate of matches) {
    if (await candidate.isVisible().catch(() => false)) visible.push(candidate);
  }
  const candidates = visible.length > 0 ? visible : matches;

  let resolved: Locator;
  // Set whenever a corroboration layer (not the recorded locator resolving
  // trivially on its own) was what actually decided this — tells the
  // caller (replay.ts) there's something worth healing back onto the
  // source step.
  let healedVia: "position" | "structural" | "content" | undefined;
  if (candidates.length > 1) {
    let picked: Locator | null = null;
    let detail: string | undefined;
    let positionDistances: (number | null)[] | undefined;
    let contentSimilarities: (number | null)[] | undefined;

    if (step.x !== undefined && step.y !== undefined) {
      const match = await pickByRecordedPosition(candidates, step.x, step.y);
      picked = match.locator;
      detail = match.detail;
      positionDistances = match.distances;
      if (picked) healedVia = "position";
    } else {
      detail = "no recorded click position to disambiguate with";
    }

    if (!picked) {
      // Position alone wasn't conclusive — try the independent structural
      // signals (ancestor chain, sibling text/position) before giving up.
      picked = await pickByStructuralMatch(candidates, step.locator);
      if (picked) healedVia = "structural";
    }

    if (!picked) {
      // Neither position nor an exact structural match decided it — try
      // embedding similarity on the sibling text, which tolerates the kind
      // of minor content drift (a price, a count) exact-match can't.
      const contentMatch = await pickByContentSimilarity(candidates, step.locator);
      picked = contentMatch.locator;
      contentSimilarities = contentMatch.similarities;
      if (picked) {
        healedVia = "content";
      } else if (step.x === undefined || step.y === undefined) {
        // Nothing from the position check was worth keeping (it never ran)
        // — the content check's detail is strictly more informative alone.
        detail = contentMatch.detail;
      } else {
        // Keep the position check's pixel diagnostic and add this one,
        // rather than losing it — both are genuinely informative about why
        // the pause happened.
        detail = `${detail}; ${contentMatch.detail}`;
      }
    }

    if (!picked) return { ok: false, reason: "ambiguous", detail, candidates, positionDistances, contentSimilarities };
    resolved = picked;
  } else {
    resolved = candidates[0];
  }

  // The "css" strategy is our weakest, structural fallback (an nth-of-type
  // path) — most likely to silently resolve to the *wrong* element after a
  // layout change rather than to no element at all. Cross-check it against
  // the recorded description (already `tag "label"`, e.g. `button "Confirm
  // order"`) before trusting it. Stronger strategies (testid/role+name/
  // placeholder/text) skip this — a unique match on one of those is already
  // strong evidence on its own.
  if (step.locator.strategy === "css" && step.description) {
    const tagMatch = step.description.match(/^(\w+)/)?.[1];
    if (tagMatch) {
      const actualTag = await resolved.evaluate((el) => el.tagName.toLowerCase()).catch(() => null);
      if (actualTag && actualTag !== tagMatch) {
        // A tag change alone used to always pause. Two independent lines of
        // corroborating evidence get a chance to overrule it before giving
        // up: the recorded click position lining up with this element's
        // current position, or its structural signals (ancestor breadcrumb,
        // sibling text/position) matching exactly. A wrapper/element-type
        // change at the same visual spot with the same surroundings is far
        // more likely to be the same element than an unrelated one
        // coincidentally landing there.
        let positionDetail: string | undefined;
        let measuredDistance: number | null = null;
        if (step.x !== undefined && step.y !== undefined) {
          measuredDistance = await distanceFromRecordedPoint(resolved, step.x, step.y);
          if (measuredDistance !== null && measuredDistance <= POSITION_MATCH_MAX_DISTANCE) {
            return { ok: true, locator: resolved, healedVia: "position" };
          }
          positionDetail =
            measuredDistance === null
              ? "its position couldn't be checked"
              : `it's ${Math.round(measuredDistance)}px from the recorded click point (needed ≤${POSITION_MATCH_MAX_DISTANCE}px)`;
        }

        const structuralLive = await structuralSignalsOf(resolved);
        if (structuralSignalsMatch(step.locator, structuralLive)) {
          return { ok: true, locator: resolved, healedVia: "structural" };
        }

        // Third and last chance to corroborate this single candidate before
        // giving up — embedding similarity on the sibling text, same as the
        // multi-candidate "ambiguous" path above (with only one candidate,
        // there's no runner-up to compare against, so just the absolute
        // similarity bar applies).
        const contentMatch = await pickByContentSimilarity([resolved], step.locator);
        if (contentMatch.locator) {
          return { ok: true, locator: resolved, healedVia: "content" };
        }

        return {
          ok: false,
          reason: "drifted",
          detail:
            `element type changed (recorded ${tagMatch}, found ${actualTag}); ` +
            (positionDetail ?? "there's no recorded click position to corroborate it") +
            "; structural signals didn't match either; " +
            contentMatch.detail,
          candidates: [resolved],
          positionDistances: measuredDistance !== null ? [measuredDistance] : undefined,
          contentSimilarities: contentMatch.similarities,
        };
      }
    }
  }

  return { ok: true, locator: resolved, healedVia };
}
