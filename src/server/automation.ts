import path from "path";
import { chromium, type Browser, type BrowserContext, type CDPSession, type Page } from "playwright";
import type { RunJob } from "./runManager";
import { runScratchDir, cleanupScratchDir, uploadArtifact } from "./artifacts";
import { persistRun } from "./runs";
import { prisma } from "./db";
import { countVisibleMatches } from "./locatorReplay";
import type { ElementLocator, ManualInputEvent } from "./types";
import { trackRunEvent } from "./analytics";

export async function screenshotStep(page: Page, runId: string, index: number): Promise<string> {
  const fileName = `step-${index}.jpg`;
  const buffer = await page.screenshot({ type: "jpeg", quality: 70 });
  await uploadArtifact(runId, fileName, "image/jpeg", buffer);
  return fileName;
}

// Split in two (snapshot now, upload later) so a manual gesture's "before"
// DOM can be captured the instant it starts — before we even know the step
// index it'll end up attached to — without blocking the actual CDP input
// dispatch on a page.content() round-trip.
export async function domSnapshot(page: Page): Promise<string | undefined> {
  return page.content().catch(() => undefined);
}

export async function uploadDomSnapshot(
  runId: string,
  index: number,
  phase: "before" | "after",
  html: string | undefined,
): Promise<string | undefined> {
  if (html === undefined) return undefined;
  const fileName = `step-${index}-dom-${phase}.html`;
  await uploadArtifact(runId, fileName, "text/plain", Buffer.from(html, "utf-8")).catch(() => {});
  return fileName;
}

// Injected once per document (Playwright re-runs it on every navigation) so
// manual clicks/movement are visible in both the live view and the
// recorded video.webm — CDP's Input.dispatchMouseEvent drives the real
// page but draws no cursor of its own, so without this the recording would
// just show things happening with no indication of where or how.
//
// How long the cursor overlay's CSS transition takes to visibly glide to a
// new point, and how long callers should hold after a click before moving
// on to the next action — long enough that a human watching the live view
// (or the recorded video) can actually see the cursor travel and the click
// land, short enough that a multi-step run doesn't feel sluggish. Kept as
// TS constants (not just baked into the CSS string below) so glideCursorTo/
// settleAfterAction's waits stay in sync with what the overlay itself
// actually animates for.
export const CURSOR_GLIDE_MS = 400;
export const ACTION_SETTLE_MS = 350;

// Written as a plain JS string rather than a TS function passed to
// page.addInitScript(fn) — Playwright serializes a function via
// fn.toString(), which only captures the function's own source text. Under
// tsx/esbuild, a compiled function can reference a helper (e.g. a
// `__name` keep-names shim) that esbuild injected elsewhere in this
// module; that reference doesn't exist once the source is transplanted
// into the page, so it throws immediately. A raw content string sidesteps
// the compiler entirely.
const CURSOR_OVERLAY_SCRIPT = `
(function () {
  var w = window;
  if (w.__sbCursorInstalled) return;
  w.__sbCursorInstalled = true;
  try {
    // document_start runs before the parser has necessarily created
    // <html> yet, so document.documentElement can still be null here.
    // Create/attach the cursor lazily on first real use instead, by which
    // point a genuine input event has reached the page and parsing is done.
    var cursor = null;
    function ensureCursor() {
      if (!cursor) {
        cursor = document.createElement("div");
        Object.assign(cursor.style, {
          position: "fixed", top: "0", left: "0", width: "34px", height: "34px",
          borderRadius: "50%", background: "rgba(52,87,245,0.9)",
          border: "4px solid white", boxShadow: "0 2px 10px rgba(20,22,28,0.55)",
          pointerEvents: "none", zIndex: "2147483647",
          transform: "translate(-50%,-50%) scale(1)",
          // transform gets its own transition (separate timing/easing from
          // the position ones) so __sbClickRipple below can pulse just the
          // scale without disturbing the left/top tracking transition.
          // left/top glide over CURSOR_GLIDE_MS (kept in sync via string
          // interpolation, not a duplicated literal) — previously 0.05s,
          // fast enough to be an instant teleport rather than a visible
          // movement a human watching the live view could actually follow.
          transition: "left ${CURSOR_GLIDE_MS}ms cubic-bezier(0.4, 0, 0.2, 1), top ${CURSOR_GLIDE_MS}ms cubic-bezier(0.4, 0, 0.2, 1), opacity 0.2s, transform 0.15s ease-out",
          opacity: "0",
        });
        document.documentElement.appendChild(cursor);
      }
      return cursor;
    }
    w.__sbMoveCursor = function (x, y) {
      var el = ensureCursor();
      el.style.opacity = "1";
      el.style.left = x + "px";
      el.style.top = y + "px";
    };
    w.__sbClickRipple = function (x, y) {
      if (!document.documentElement) return;

      // Pulse the cursor dot itself — a quick scale-up-then-settle — as
      // direct feedback on the point that was clicked, on top of the
      // expanding ripple ring below.
      var el = ensureCursor();
      el.style.transform = "translate(-50%,-50%) scale(1.7)";
      setTimeout(function () {
        el.style.transform = "translate(-50%,-50%) scale(1)";
      }, 150);

      var ripple = document.createElement("div");
      Object.assign(ripple.style, {
        position: "fixed", top: y + "px", left: x + "px", width: "18px", height: "18px",
        borderRadius: "50%", border: "3px solid rgba(52,87,245,0.9)",
        pointerEvents: "none", zIndex: "2147483647",
        transform: "translate(-50%,-50%) scale(1)", opacity: "1",
        transition: "transform 0.5s ease-out, opacity 0.5s ease-out",
      });
      document.documentElement.appendChild(ripple);
      requestAnimationFrame(function () {
        ripple.style.transform = "translate(-50%,-50%) scale(5)";
        ripple.style.opacity = "0";
      });
      setTimeout(function () { ripple.remove(); }, 550);
    };
  } catch (err) {
    // best-effort visual aid only — never let this break the run
  }
})();
`;

// Fire-and-forget calls into the overlay above — swallow errors since the
// page may be mid-navigation (the overlay isn't installed yet on the new
// document) or already closed.
export function moveCursorOverlay(cdp: CDPSession, x: number, y: number) {
  void cdp
    .send("Runtime.evaluate", {
      expression: `window.__sbMoveCursor && window.__sbMoveCursor(${x}, ${y})`,
    })
    .catch(() => {});
}

export function triggerClickRipple(cdp: CDPSession, x: number, y: number) {
  void cdp
    .send("Runtime.evaluate", {
      expression: `window.__sbClickRipple && window.__sbClickRipple(${x}, ${y})`,
    })
    .catch(() => {});
}

// Moves the cursor overlay to (x, y) and holds for CURSOR_GLIDE_MS —
// exactly as long as its CSS transition takes to actually get there — before
// returning. Callers driving a live-viewed run (replay/variant/agent/crawl
// tasks) should await this before triggering a click, so the glide renders
// as a visible movement instead of moveCursorOverlay+triggerClickRipple+
// click() all firing in the same tick with nothing in between for a screencast
// frame to ever catch.
export async function glideCursorTo(page: Page, cdp: CDPSession, x: number, y: number): Promise<void> {
  moveCursorOverlay(cdp, x, y);
  await page.waitForTimeout(CURSOR_GLIDE_MS).catch(() => {});
}

// Brief pause after an action completes — long enough for its visible
// result (the click ripple fading, the page reacting) to actually render
// before the next action starts.
export async function settleAfterAction(page: Page): Promise<void> {
  await page.waitForTimeout(ACTION_SETTLE_MS).catch(() => {});
}

// How long to wait after the last wheel/keystroke event before treating a
// scroll or typing gesture as "done" and logging one summary step for it —
// otherwise every wheel tick or keystroke would produce its own step.
const SCROLL_IDLE_MS = 700;
const TYPE_IDLE_MS = 900;
// Ignore wheel deltas smaller than this — trackpad micro-ticks shouldn't
// produce a "Scrolled" step of their own.
const SCROLL_MIN_PX = 24;

// Wires the RunJob's finish/manual-input events (raised by the WS handler
// in server.ts, in response to messages from the live-view client) to the
// actual page/CDP session, which only automation.ts has in scope. Returns a
// cleanup function to remove the listeners once the run ends, so a
// long-lived RunJob doesn't hold dead closures forever.
interface ElementInfo {
  description: string;
  locator: ElementLocator | null;
  // Only populated by the in-page heuristic below (DESCRIBE_AND_LOCATE_JS) —
  // used by the full-tree AX enumeration (variationDiscovery.ts), irrelevant
  // to point-capture callers since a live click can only land on something
  // already visible.
  visible?: boolean;
}

const NO_ELEMENT_INFO: ElementInfo = { description: "the page", locator: null };

// Cheap, synchronous corroborating evidence about *where* an element sits —
// captured alongside the primary locator at record time (no extra latency,
// same in-page walk cost as the css path already computed below) and
// recomputed identically for each candidate at replay time
// (locatorReplay.ts) to check against. The point is redundancy: a locator
// string alone is one point of failure; when it stops uniquely resolving,
// these give the replay engine other independent evidence for "is this
// really the same element" instead of falling straight back to a human.
export const STRUCTURAL_SIGNALS_JS = `
function computeStructuralSignals(el) {
  function textOf(node) {
    if (!node) return "";
    return (node.innerText || node.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 80);
  }

  // Ancestor breadcrumb (tag, or tag[role=x] where present) for up to 4
  // levels above the element — broader context than the single nearest
  // landmark captured below, e.g. "a > li > ul > nav[role=navigation]".
  var chainParts = [];
  var chainCur = el.parentElement;
  var chainDepth = 0;
  while (chainCur && chainCur !== document.body && chainDepth < 4) {
    var cTag = chainCur.tagName.toLowerCase();
    var cRole = chainCur.getAttribute("role");
    chainParts.push(cRole ? cTag + "[role=" + cRole + "]" : cTag);
    chainCur = chainCur.parentElement;
    chainDepth++;
  }

  // The visible text of the sibling immediately before/after this element
  // among its parent's children, plus its ordinal position — real,
  // human-visible context ("the link right after 'Getting started'") that's
  // cheap to recompute and compare later.
  var parentEl = el.parentElement;
  var siblingBefore = "";
  var siblingAfter = "";
  var siblingIndex = -1;
  var siblingCount = 0;
  if (parentEl) {
    var siblings = Array.prototype.slice.call(parentEl.children);
    siblingCount = siblings.length;
    siblingIndex = siblings.indexOf(el);
    if (siblingIndex > 0) siblingBefore = textOf(siblings[siblingIndex - 1]);
    if (siblingIndex >= 0 && siblingIndex < siblings.length - 1) siblingAfter = textOf(siblings[siblingIndex + 1]);
  }

  return {
    ancestorChain: chainParts.join(" > "),
    siblingBefore: siblingBefore,
    siblingAfter: siblingAfter,
    siblingIndex: siblingIndex,
    siblingCount: siblingCount,
  };
}
`;

// Shared by inspectElementAt/inspectFocusedField below — inlined into two
// separate CDP Runtime.evaluate calls (not a module import; this text runs
// in-page), turning a DOM element into both a human-readable description
// (so steps read like "Clicked button 'Sign in'") and a best-effort,
// Playwright-idiomatic locator for it. Deliberately "good enough for a
// recorded step" — not a full ARIA accname implementation or a guaranteed-
// unique CSS path.
export const DESCRIBE_AND_LOCATE_JS = `
${STRUCTURAL_SIGNALS_JS}
function describeAndLocate(el) {
  if (!el) return { description: "the page", locator: null };
  var tag = el.tagName.toLowerCase();
  if (tag === "input" && el.type === "password") return { description: "a password field", locator: null };

  var testId = el.getAttribute("data-testid") || el.getAttribute("data-test-id") || el.getAttribute("data-test");
  var explicitRole = el.getAttribute("role");
  var impliedRole = explicitRole || (
    tag === "a" && el.hasAttribute("href") ? "link" :
    tag === "button" ? "button" :
    tag === "select" ? "combobox" :
    tag === "textarea" ? "textbox" :
    tag === "input" && (el.type === "submit" || el.type === "button") ? "button" :
    tag === "input" ? "textbox" : null
  );
  // 200, not a tighter "display-only" length — these two values are also
  // what locator.value gets set to below, and resolveLocator() now matches
  // them with exact:true (see locatorReplay.ts), so silently truncating
  // here would make a long accessible name/placeholder permanently
  // unmatchable at replay time (the truncated prefix never equals the
  // real, full string).
  var accessibleName = (el.getAttribute("aria-label") || el.innerText || el.getAttribute("alt") || el.getAttribute("title") || "").trim().slice(0, 200);
  var placeholder = (el.getAttribute("placeholder") || "").trim().slice(0, 200);
  var label = accessibleName || placeholder || "";
  // impliedRole (e.g. "link"), not the raw tag name — a plain <a> element's
  // tagName is literally "a", which reads as the indefinite article ("a
  // 'About'" looks like a typo, not a description) rather than what it
  // actually is (a link named "About").
  var roleLabel = impliedRole || tag;
  var description = label ? roleLabel + " \\"" + label.replace(/"/g, "'") + "\\"" : roleLabel;

  function cssPath(node) {
    var parts = [];
    var cur = node;
    var depth = 0;
    while (cur && cur.nodeType === 1 && depth < 4) {
      if (cur.id) { parts.unshift("#" + CSS.escape(cur.id)); break; }
      var part = cur.tagName.toLowerCase();
      var parent = cur.parentElement;
      if (parent) {
        var siblings = Array.prototype.filter.call(parent.children, function (c) { return c.tagName === cur.tagName; });
        if (siblings.length > 1) part += ":nth-of-type(" + (Array.prototype.indexOf.call(siblings, cur) + 1) + ")";
      }
      parts.unshift(part);
      cur = parent;
      depth++;
    }
    return parts.join(" > ");
  }
  var cssSelector = cssPath(el);

  // Only meaningful for the full-page enumeration case (variationDiscovery.ts
  // via the accessibility tree, which returns nodes regardless of whether
  // they're actually on screen) — a live click can only ever land on
  // something visible, so this is a no-op for the point-capture callers.
  function isVisible(node) {
    if (!node || !node.isConnected) return false;
    var style = getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
    if (node.offsetParent === null && style.position !== "fixed") return false;
    var rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  var locator = null;
  if (testId) locator = { strategy: "testId", value: testId, cssSelector: cssSelector };
  else if (impliedRole && accessibleName) locator = { strategy: "role", role: impliedRole, value: accessibleName, cssSelector: cssSelector };
  else if (placeholder) locator = { strategy: "placeholder", value: placeholder, cssSelector: cssSelector };
  else if (accessibleName) locator = { strategy: "text", value: accessibleName, cssSelector: cssSelector };
  else if (cssSelector) locator = { strategy: "css", value: cssSelector, cssSelector: cssSelector };

  // Redundant corroborating evidence, attached regardless of which strategy
  // won above — cheap (same walk cost as the css path already computed),
  // and useful at replay time even for a testId/css locator, not just the
  // weaker page-wide-search strategies scoping below is limited to.
  if (locator) {
    var signals = computeStructuralSignals(el);
    if (signals.ancestorChain) locator.ancestorChain = signals.ancestorChain;
    if (signals.siblingBefore) locator.siblingBefore = signals.siblingBefore;
    if (signals.siblingAfter) locator.siblingAfter = signals.siblingAfter;
    if (signals.siblingIndex >= 0) locator.siblingIndex = signals.siblingIndex;
  }

  // Only the weaker, page-wide-search strategies benefit from scoping —
  // testId is already unique by definition, and css already encodes a full
  // structural path. Walk up for the nearest landmark ancestor (a semantic
  // region or anything explicitly labeled) so a duplicate label living in a
  // different part of the page (a sidebar TOC link vs. a main-content
  // heading, both literally "Quickstart") doesn't collide at replay time.
  if (locator && (locator.strategy === "role" || locator.strategy === "text" || locator.strategy === "placeholder")) {
    var LANDMARK_TAGS = { NAV: 1, MAIN: 1, ASIDE: 1, HEADER: 1, FOOTER: 1 };
    var LANDMARK_ROLES = { navigation: 1, main: 1, complementary: 1, banner: 1, contentinfo: 1, search: 1, region: 1 };
    var landmark = null;
    var cur = el.parentElement;
    var depth = 0;
    while (cur && cur !== document.body && depth < 12) {
      var curRole = cur.getAttribute("role");
      if (LANDMARK_TAGS[cur.tagName] || (curRole && LANDMARK_ROLES[curRole]) || cur.hasAttribute("aria-label")) {
        landmark = cur;
        break;
      }
      cur = cur.parentElement;
      depth++;
    }
    if (landmark) {
      var landmarkTag = landmark.tagName.toLowerCase();
      var landmarkLabel = landmark.getAttribute("aria-label");
      var landmarkRole = landmark.getAttribute("role");
      locator.scopeSelector = cssPath(landmark);
      locator.scopeDescription = landmarkLabel
        ? landmarkTag + " \\"" + landmarkLabel.replace(/"/g, "'") + "\\""
        : landmarkRole
          ? landmarkTag + " [role=" + landmarkRole + "]"
          : landmarkTag;
    }
  }

  return { description: description, locator: locator, visible: isVisible(el) };
}
`;

// --- Accessibility-tree based role/name lookup ------------------------------
// Chrome's accessibility tree computes role + accessible name per the full
// ARIA spec (label associations, aria-labelledby, native tag semantics) — far
// more accurate than the aria-label/innerText/alt/title heuristic above, and
// it's the same computation Playwright's own getByRole() relies on at replay
// time, so a captured name lines up with what replay will actually match.
// Used to *upgrade* describeAndLocate's role/name guess when the tree has
// something usable; the heuristic above still supplies testId/placeholder/
// cssSelector and remains the fallback when the tree has nothing.

// "generic"/"none"/"presentation" mean Chrome computed no semantic role for
// the node at all — not something getByRole could ever target.
const AX_SKIP_ROLES = new Set(["generic", "none", "presentation"]);

// The broader, principled interactive-role set used by the full-page
// enumeration in variationDiscovery.ts, replacing its old hardcoded CSS
// selector list (which missed custom-role widgets like role="switch" and
// plain text inputs entirely).
export const INTERACTIVE_AX_ROLES = new Set([
  "button", "link", "checkbox", "radio", "combobox", "textbox", "menuitem",
  "menuitemcheckbox", "menuitemradio", "tab", "option", "switch", "slider",
  "searchbox", "spinbutton",
]);

const FIND_INTERACTIVE_ANCESTOR_JS = `
function findInteractiveAncestor(el) {
  var depth = 0;
  var cur = el;
  while (cur && cur.nodeType === 1 && depth < 8) {
    var tag = cur.tagName.toLowerCase();
    if (cur.hasAttribute("role") || ["a", "button", "input", "textarea", "select"].indexOf(tag) !== -1) {
      return cur;
    }
    cur = cur.parentElement;
    depth++;
  }
  return el;
}
`;

// Point-hit-testing (elementFromPoint, and DOM.getNodeForLocation below)
// returns the deepest leaf node under the pixel — clicking an icon button
// lands on its <svg>/<path>, which has no accessibility-tree entry of its
// own. Walk up to the nearest real interactive ancestor before asking the
// accessibility tree for a role/name, same as a human's click is understood
// to mean "activate the button", not "hit this exact pixel of the icon".
async function findInteractiveAncestorBackendNodeId(
  cdp: CDPSession,
  leafBackendNodeId: number,
): Promise<number> {
  const resolved = await cdp.send("DOM.resolveNode", { backendNodeId: leafBackendNodeId });
  if (!resolved.object?.objectId) return leafBackendNodeId;
  // Deliberately no returnByValue — a live object handle is needed so
  // DOM.describeNode can map it back to a backendNodeId below, not a
  // serialized copy of the element.
  const ancestor = await cdp.send("Runtime.callFunctionOn", {
    objectId: resolved.object.objectId,
    functionDeclaration: `function() { ${FIND_INTERACTIVE_ANCESTOR_JS}\nreturn findInteractiveAncestor(this); }`,
  });
  if (!ancestor.result?.objectId) return leafBackendNodeId;
  const described = await cdp.send("DOM.describeNode", { objectId: ancestor.result.objectId });
  return described.node?.backendNodeId ?? leafBackendNodeId;
}

interface AxRoleName {
  role: string;
  name: string;
  // The queried node's own tag — NOT necessarily the tag of whatever pixel
  // was originally clicked. getAxRoleNameAtPoint below may resolve an icon's
  // <svg>/<circle> up to its enclosing <button> first; without this, the
  // step description would misleadingly read "Clicked circle ..." for a
  // click that's actually replayed as a button-role locator.
  tag?: string;
}

async function getAxRoleName(cdp: CDPSession, backendNodeId: number): Promise<AxRoleName | null> {
  try {
    const [ax, described] = await Promise.all([
      cdp.send("Accessibility.getPartialAXTree", { backendNodeId, fetchRelatives: false }),
      cdp.send("DOM.describeNode", { backendNodeId }).catch(() => null),
    ]);
    const node = ax.nodes?.[0];
    if (!node || node.ignored) return null;
    const role = node.role?.value as string | undefined;
    // Same 200-char cap as DESCRIBE_AND_LOCATE_JS — resolveLocator() matches
    // with exact:true, so a silently truncated name would be permanently
    // unmatchable at replay time.
    const name = ((node.name?.value as string | undefined) ?? "").trim().slice(0, 200);
    if (!role || !name || AX_SKIP_ROLES.has(role)) return null;
    return { role, name, tag: described?.node?.nodeName?.toLowerCase() };
  } catch {
    return null;
  }
}

export async function getAxRoleNameAtPoint(
  cdp: CDPSession,
  x: number,
  y: number,
): Promise<AxRoleName | null> {
  // Integer coordinates required — DOM.getNodeForLocation rejects floats
  // with "Invalid parameters". includeUserAgentShadowDOM is deliberately
  // left at its default (false): with it on, clicking a plain <input>
  // resolves into Chrome's internal shadow-DOM text-field implementation
  // instead of the host <input>.
  const loc = await cdp
    .send("DOM.getNodeForLocation", { x: Math.round(x), y: Math.round(y) })
    .catch(() => null);
  if (!loc?.backendNodeId) return null;
  const targetId = await findInteractiveAncestorBackendNodeId(cdp, loc.backendNodeId).catch(
    () => loc.backendNodeId,
  );
  return getAxRoleName(cdp, targetId);
}

export async function getAxRoleNameForActiveElement(cdp: CDPSession): Promise<AxRoleName | null> {
  try {
    const active = await cdp.send("Runtime.evaluate", {
      expression: "document.activeElement === document.body ? null : document.activeElement",
    });
    if (!active.result?.objectId) return null;
    const described = await cdp.send("DOM.describeNode", { objectId: active.result.objectId });
    const backendNodeId = described.node?.backendNodeId;
    if (!backendNodeId) return null;
    return getAxRoleName(cdp, backendNodeId);
  } catch {
    return null;
  }
}

// Overrides a heuristic-computed locator's role/name with the accessibility
// tree's version when one is available. testId always wins regardless (it's
// already the strongest possible signal), and a password field's explicit
// redaction (see DESCRIBE_AND_LOCATE_JS) is left untouched — everything else
// (placeholder/text/css) only stands when the accessibility tree found
// nothing usable.
export function upgradeWithAxRoleName(info: ElementInfo, axRoleName: AxRoleName | null): ElementInfo {
  if (!axRoleName) return info;
  if (info.description === "the page" || info.description === "a password field") return info;
  if (info.locator?.strategy === "testId") return info;
  // The accessibility tree's own role (e.g. "link", "button") — not
  // axRoleName.tag, which is the raw DOM tag name ("a" for every anchor)
  // and reads like a stray indefinite article in front of the name rather
  // than a description ("a 'About'" instead of "link 'About'").
  const roleLabel = axRoleName.role || axRoleName.tag || info.description.match(/^(\w+)/)?.[1] || "element";
  return {
    description: `${roleLabel} "${axRoleName.name}"`,
    locator: {
      strategy: "role",
      role: axRoleName.role,
      value: axRoleName.name,
      cssSelector: info.locator?.cssSelector,
    },
    visible: info.visible,
  };
}

// Full-tree enumeration case (variationDiscovery.ts): the AX node's role/name
// is already known from Accessibility.getFullAXTree, so this only needs to
// resolve testId/placeholder/cssSelector/visibility for the same DOM node via
// the existing heuristic, then apply the same override rule as above.
export async function describeElementAtBackendNodeId(
  cdp: CDPSession,
  backendNodeId: number,
  axRoleName: { role: string; name: string },
): Promise<ElementInfo | null> {
  const resolved = await cdp.send("DOM.resolveNode", { backendNodeId }).catch(() => null);
  if (!resolved?.object?.objectId) return null;
  const result = await cdp
    .send("Runtime.callFunctionOn", {
      objectId: resolved.object.objectId,
      functionDeclaration: `function() { ${DESCRIBE_AND_LOCATE_JS}\nreturn describeAndLocate(this); }`,
      returnByValue: true,
    })
    .catch(() => null);
  const info = (result?.result?.value as ElementInfo | undefined) ?? null;
  if (!info) return null;
  return upgradeWithAxRoleName(info, axRoleName);
}

export function wireManualControl(job: RunJob, page: Page, cdp: CDPSession): () => void {
  // Best-effort DOM lookups so steps read like "Clicked button 'Sign in'"
  // instead of just "Clicked", and so a locator is available for replay
  // tooling later. Never include the actual text a user typed, and
  // explicitly redact password fields.
  async function inspectElementAt(x: number, y: number): Promise<ElementInfo> {
    try {
      const [result, axRoleName] = await Promise.all([
        cdp.send("Runtime.evaluate", {
          expression: `(() => {
            ${DESCRIBE_AND_LOCATE_JS}
            var el = document.elementFromPoint(${x}, ${y});
            return describeAndLocate(el);
          })()`,
          returnByValue: true,
        }),
        getAxRoleNameAtPoint(cdp, x, y).catch(() => null),
      ]);
      const info = (result.result?.value as ElementInfo) ?? NO_ELEMENT_INFO;
      return upgradeWithAxRoleName(info, axRoleName);
    } catch {
      return NO_ELEMENT_INFO;
    }
  }

  async function inspectFocusedField(): Promise<ElementInfo> {
    try {
      const [result, axRoleName] = await Promise.all([
        cdp.send("Runtime.evaluate", {
          expression: `(() => {
            ${DESCRIBE_AND_LOCATE_JS}
            var el = document.activeElement;
            if (!el || el === document.body) return { description: "the page", locator: null };
            return describeAndLocate(el);
          })()`,
          returnByValue: true,
        }),
        getAxRoleNameForActiveElement(cdp).catch(() => null),
      ]);
      const info = (result.result?.value as ElementInfo) ?? NO_ELEMENT_INFO;
      return upgradeWithAxRoleName(info, axRoleName);
    } catch {
      return NO_ELEMENT_INFO;
    }
  }

  async function logManualStep(
    type: string,
    description: string,
    domBeforePromise?: Promise<string | undefined>,
    extra?: { x?: number; y?: number; locator?: ElementLocator; recordedAmbiguityWarning?: string },
  ) {
    const step = job.addStep({
      type,
      description,
      status: "done",
      startedAt: new Date().toISOString(),
      url: page.url(),
      x: extra?.x,
      y: extra?.y,
      locator: extra?.locator,
      recordedAmbiguityWarning: extra?.recordedAmbiguityWarning,
    });
    // Give the page a beat to react (navigation, menu opening, etc.) before
    // capturing the screenshot.
    await page.waitForTimeout(150).catch(() => {});
    step.url = page.url();
    step.screenshot = await screenshotStep(page, job.record.id, step.index).catch(
      () => undefined,
    );
    const domBeforeHtml = domBeforePromise ? await domBeforePromise.catch(() => undefined) : undefined;
    step.domBefore = await uploadDomSnapshot(job.record.id, step.index, "before", domBeforeHtml);
    step.domAfter = await uploadDomSnapshot(
      job.record.id,
      step.index,
      "after",
      await domSnapshot(page),
    );
    step.finishedAt = new Date().toISOString();
    job.updateStep(step.index, step);
    await persistRun(job.record).catch(() => {});
  }

  let scrollTimer: ReturnType<typeof setTimeout> | null = null;
  let scrollDelta = 0;
  // Captured on the first wheel tick of a burst — by the time flushScroll
  // fires (debounced), "now" would already reflect every tick's effect, so
  // the pre-scroll DOM has to be grabbed at burst-start, not flush-time.
  let scrollDomBeforePromise: Promise<string | undefined> | undefined;

  function flushScroll() {
    if (scrollTimer) {
      clearTimeout(scrollTimer);
      scrollTimer = null;
    }
    const delta = scrollDelta;
    scrollDelta = 0;
    const domBeforePromise = scrollDomBeforePromise;
    scrollDomBeforePromise = undefined;
    if (Math.abs(delta) >= SCROLL_MIN_PX) {
      void logManualStep("manual-scroll", `Scrolled ${delta > 0 ? "down" : "up"}`, domBeforePromise);
    }
  }

  let typeTimer: ReturnType<typeof setTimeout> | null = null;
  let typeTargetPromise: Promise<ElementInfo> | null = null;
  let typeDomBeforePromise: Promise<string | undefined> | undefined;

  function flushTyping() {
    if (typeTimer) {
      clearTimeout(typeTimer);
      typeTimer = null;
    }
    const targetPromise = typeTargetPromise;
    typeTargetPromise = null;
    const domBeforePromise = typeDomBeforePromise;
    typeDomBeforePromise = undefined;
    if (targetPromise) {
      void targetPromise.then((info) =>
        logManualStep("manual-type", `Typed into ${info.description}`, domBeforePromise, {
          locator: info.locator ?? undefined,
        }),
      );
    }
  }

  // Takes a closing screenshot before actually triggering shutdown, so the
  // report ends on a real frame instead of just cutting off.
  const handleFinish = async () => {
    flushScroll();
    flushTyping();
    const step = job.addStep({
      type: "manual-finish",
      description: "Session finished",
      status: "done",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      url: page.url(),
    });
    step.screenshot = await screenshotStep(page, job.record.id, step.index).catch(
      () => undefined,
    );
    job.updateStep(step.index, step);
    await persistRun(job.record).catch(() => {});
    job.confirmFinish();
  };

  const handleManualInput = async (event: ManualInputEvent) => {
    try {
      switch (event.kind) {
        case "mouseWheel": {
          // Only snapshot at the start of a scroll burst — mid-burst ticks
          // reuse the same "before" reference so the diff spans the whole
          // gesture, not just its last tick.
          if (!scrollTimer) scrollDomBeforePromise = domSnapshot(page);
          await cdp.send("Input.dispatchMouseEvent", {
            type: "mouseWheel",
            x: event.x,
            y: event.y,
            deltaX: event.deltaX,
            deltaY: event.deltaY,
          });
          flushTyping();
          scrollDelta += event.deltaY;
          if (scrollTimer) clearTimeout(scrollTimer);
          scrollTimer = setTimeout(flushScroll, SCROLL_IDLE_MS);
          break;
        }
        case "mousePressed":
        case "mouseReleased":
        case "mouseMoved": {
          const domBeforePromise = event.kind === "mousePressed" ? domSnapshot(page) : undefined;
          await cdp.send("Input.dispatchMouseEvent", {
            type: event.kind,
            x: event.x,
            y: event.y,
            button: event.button ?? "left",
            buttons: event.kind === "mouseReleased" ? 0 : 1,
            clickCount: event.clickCount ?? 1,
          });
          moveCursorOverlay(cdp, event.x, event.y);
          if (event.kind === "mousePressed") {
            flushScroll();
            flushTyping();
            triggerClickRipple(cdp, event.x, event.y);
            void inspectElementAt(event.x, event.y).then(async (info) => {
              // Checked immediately, on the same page state the click just
              // happened on — a locator that's already ambiguous right now
              // will almost certainly still be ambiguous (or worse) at some
              // future replay. Surfacing it here, while a human is actually
              // watching, beats discovering it unattended later.
              const matchCount = info.locator
                ? await countVisibleMatches(page, info.locator).catch(() => 1)
                : 1;
              const recordedAmbiguityWarning =
                matchCount > 1
                  ? `This locator currently matches ${matchCount} elements on the page — a future replay may need to pause and pick one.`
                  : undefined;
              return logManualStep("manual-click", `Clicked ${info.description}`, domBeforePromise, {
                x: event.x,
                y: event.y,
                locator: info.locator ?? undefined,
                recordedAmbiguityWarning,
              });
            });
          }
          break;
        }
        case "rawKeyDown":
        case "keyUp":
        case "char": {
          const isBurstStart = event.kind === "char" && !typeTargetPromise;
          const domBeforePromise = isBurstStart ? domSnapshot(page) : undefined;
          await cdp.send("Input.dispatchKeyEvent", {
            type: event.kind,
            key: event.key,
            code: event.code,
            text: event.text,
            unmodifiedText: event.text,
            windowsVirtualKeyCode: event.keyCode,
            nativeVirtualKeyCode: event.keyCode,
          });
          if (event.kind === "char") {
            flushScroll();
            if (!typeTargetPromise) {
              typeTargetPromise = inspectFocusedField();
              typeDomBeforePromise = domBeforePromise;
            }
            if (typeTimer) clearTimeout(typeTimer);
            typeTimer = setTimeout(flushTyping, TYPE_IDLE_MS);
          }
          break;
        }
      }
    } catch {
      // page/context may be mid-navigation or already closed; drop the event
    }
  };

  job.on("finish-requested", handleFinish);
  job.on("manual-input", handleManualInput);

  return () => {
    if (scrollTimer) clearTimeout(scrollTimer);
    if (typeTimer) clearTimeout(typeTimer);
    job.off("finish-requested", handleFinish);
    job.off("manual-input", handleManualInput);
  };
}

// Resolves once the job is stopped or finished — requestFinish() and
// requestStop() both eventually emit "stop-requested" (confirmFinish() does
// so directly), so this is the one thing runTask needs to wait on.
export function waitUntilStopped(job: RunJob): Promise<void> {
  if (job.stopRequested) return Promise.resolve();
  return new Promise((resolve) => job.once("stop-requested", () => resolve()));
}

// Used when a run is cancelled while still queued in Redis (never dequeued,
// so runTask below never executes for it) — records the same terminal state
// runTask would have written, without ever launching a browser.
export function finalizeWithoutRunning(job: RunJob, reason: string) {
  job.record.status = "error";
  job.record.error = reason;
  job.record.finishedAt = new Date().toISOString();
  void persistRun(job.record);
  job.emitStatus();
  trackRunEvent({
    eventType: "error",
    runId: job.record.id,
    userId: job.record.userId,
    promptId: job.record.promptId,
    status: "error",
    error: reason,
  });
}

export interface RunSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  cdp: CDPSession;
  scratchDir: string;
  projectId?: string;
  skillId?: string;
}

// Everything a run needs before it can actually start doing anything —
// shared verbatim by runTask (manual) and replayTask (src/server/replay.ts):
// looks up the owning skill, flips the run to "running", launches Chromium,
// wires the CDP screencast (live view) and tracing/video recording. Callers
// should return immediately if this resolves to null — that means the job
// was already stopped/invalid and finalizeWithoutRunning() already handled
// it, so no browser was ever launched.
export async function launchRunBrowser(job: RunJob): Promise<RunSession | null> {
  if (job.stopRequested) {
    finalizeWithoutRunning(job, "Stopped by user");
    return null;
  }

  const { userId, promptId } = job.record;

  const promptRow = await prisma.prompt.findUnique({
    where: { id: promptId },
    select: { skill: { select: { id: true, projectId: true } } },
  });
  if (!promptRow) {
    finalizeWithoutRunning(job, "Prompt no longer exists");
    return null;
  }
  const projectId = promptRow.skill.projectId;
  const skillId = promptRow.skill.id;

  job.record.status = "running";
  job.record.startedAt = new Date().toISOString();
  await persistRun(job.record);
  job.emitStatus();
  trackRunEvent({
    eventType: "started",
    runId: job.record.id,
    userId,
    promptId,
    projectId,
    skillId,
  });

  const browser = await chromium.launch({ headless: true });

  // Registered immediately after launch so a stop request during context/
  // page/tracing setup below still closes the browser promptly.
  job.once("stop-requested", () => {
    browser.close().catch(() => {});
  });

  // Everything below can throw (video recording setup, CDP session/domain
  // enablement, etc.) — without this try/catch, a failure here would leak
  // `browser` forever: every caller (runTask, replayTask, variantTask,
  // agentTask, crawlTask/validateTask) only ever gets a session object back
  // on success, so none of them have anything to close if we never
  // returned one.
  try {
    // Playwright can only write videos/traces to a real filesystem path —
    // this is a transient scratch location; everything in it gets uploaded
    // to MinIO and discarded (see finalizeRunSession below).
    const scratchDir = runScratchDir(job.record.id);

    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      recordVideo: { dir: scratchDir, size: { width: 1280, height: 800 } },
    });
    const page = await context.newPage();
    // Re-injected by Playwright on every navigation — draws the cursor/click
    // overlay that makes manual input (and, for a replay, auto-driven
    // clicks) visible in both the live view and the recorded video.
    await page.addInitScript({ content: CURSOR_OVERLAY_SCRIPT });

    await context.tracing.start({ screenshots: true, snapshots: true });

    const cdp = await context.newCDPSession(page);
    // Needed by the AX-tree-based locator lookups below (DOM.getNodeForLocation,
    // Accessibility.getPartialAXTree) — captured steps' role/name now come from
    // Chrome's real accessibility tree, not just the in-page DOM heuristic.
    await cdp.send("DOM.enable");
    await cdp.send("Accessibility.enable");
    await cdp.send("Page.startScreencast", {
      format: "jpeg",
      quality: 60,
      maxWidth: 1280,
      maxHeight: 800,
      everyNthFrame: 1,
    });
    cdp.on("Page.screencastFrame", async (frame) => {
      job.emitFrame(frame.data);
      try {
        await cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId });
      } catch {
        // session may already be closed
      }
    });

    return { browser, context, page, cdp, scratchDir, projectId, skillId };
  } catch (err) {
    await browser.close().catch(() => {});
    throw err;
  }
}

// The other half of launchRunBrowser — terminal-status persistence,
// analytics, and shutting everything launchRunBrowser started back down.
// Shared verbatim by runTask and replayTask; callers set
// job.record.status/error/finishedAt themselves first (the two tasks reach
// their terminal status via different paths), this just does the common
// wrap-up.
export async function finalizeRunSession(job: RunJob, session: RunSession) {
  const { browser, context, page, cdp, scratchDir, projectId, skillId } = session;

  // Persist the terminal status immediately, before the slower cleanup
  // below (stopping the screencast, flushing the trace, closing the
  // browser) — otherwise a client that sees "error"/"completed" via the
  // live WS and immediately deletes the run can race ahead of the DB
  // write and hit a stale "still active" check.
  await persistRun(job.record).catch(() => {});
  job.emitStatus();

  const startedAtMs = job.record.startedAt ? new Date(job.record.startedAt).getTime() : undefined;
  const finishedAtMs = job.record.finishedAt ? new Date(job.record.finishedAt).getTime() : undefined;
  trackRunEvent({
    eventType: job.record.status === "completed" ? "completed" : "error",
    runId: job.record.id,
    userId: job.record.userId,
    promptId: job.record.promptId,
    projectId,
    skillId,
    status: job.record.status,
    error: job.record.error,
    stepCount: job.record.steps.length,
    durationMs:
      startedAtMs !== undefined && finishedAtMs !== undefined
        ? finishedAtMs - startedAtMs
        : undefined,
  });

  try {
    await cdp.send("Page.stopScreencast");
  } catch {
    // ignore
  }
  try {
    // tracing.stop() only writes to a real filesystem path (no buffer
    // API) — write to the scratch dir, upload it, then discard the local
    // copy. The durable copy lives in MinIO, same as screenshots.
    const traceLocalPath = path.join(scratchDir, "trace.zip");
    await context.tracing.stop({ path: traceLocalPath });
    await uploadArtifact(job.record.id, "trace.zip", "application/zip", traceLocalPath);
  } catch {
    // browser may already be closed if the run was stopped
  }

  try {
    // The video file is only finalized once its context closes — do that
    // before browser.close() below so page.video()?.path() resolves
    // reliably rather than racing the browser process tearing down.
    await context.close();
    const videoPath = await page.video()?.path();
    if (videoPath) {
      await uploadArtifact(job.record.id, "video.webm", "video/webm", videoPath);
    }
  } catch {
    // context may already be closed if the run was stopped
  }

  cleanupScratchDir(job.record.id);
  await browser.close().catch(() => {});
}

export interface ExplorationSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  cdp: CDPSession;
}

// A much lighter alternative to launchRunBrowser, for pure "look and think"
// work that never produces a recording — the alternative-suggestion
// pipeline (src/server/alternativesAgent.ts) needs a real browser to
// explore a live page, but launchRunBrowser/finalizeRunSession/persistRun
// all hard-require a pre-inserted Run row (persistRun is a Prisma update,
// not upsert) and a resolvable Prompt lookup. No screencast, cursor
// overlay, tracing, video, or artifact uploads — nothing a user would ever
// watch live. Callers must close `browser` themselves (a `finally`).
export async function launchExplorationBrowser(startUrl: string): Promise<ExplorationSession> {
  const browser = await chromium.launch({ headless: true });
  // Everything below can throw (a slow/unreachable startUrl most commonly,
  // via page.goto) — without this try/catch, a failure here would leak
  // `browser` forever: the caller only ever gets a session object back on
  // success, so its own cleanup (`session?.browser.close()`) has nothing to
  // close when we never returned one.
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    // listInteractiveElements (src/server/variationDiscovery.ts) now walks the
    // real accessibility tree to enumerate alternatives.
    await cdp.send("DOM.enable");
    await cdp.send("Accessibility.enable");
    await page.goto(startUrl, { waitUntil: "domcontentloaded" });
    return { browser, context, page, cdp };
  } catch (err) {
    await browser.close().catch(() => {});
    throw err;
  }
}

export async function runTask(job: RunJob) {
  const session = await launchRunBrowser(job);
  if (!session) return;
  const { page, cdp } = session;

  const unwireManualControl = wireManualControl(job, page, cdp);

  try {
    await page.goto(job.record.startUrl, { waitUntil: "domcontentloaded" });

    // Every run starts already under human control — logged with an
    // opening screenshot (of the real start page, hence doing this after
    // goto), same as the finish handoff.
    const step = job.addStep({
      type: "manual-start",
      description: "Session started",
      status: "done",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      url: page.url(),
    });
    step.screenshot = await screenshotStep(page, job.record.id, step.index).catch(
      () => undefined,
    );
    job.updateStep(step.index, step);
    await persistRun(job.record).catch(() => {});
    job.setControlMode("manual");

    await waitUntilStopped(job);

    job.record.status = job.finishRequested ? "completed" : "error";
    job.record.error = job.finishRequested ? undefined : "Stopped by user";
  } catch (err) {
    job.record.status = job.finishRequested ? "completed" : "error";
    job.record.error = job.finishRequested
      ? undefined
      : job.stopRequested
        ? "Stopped by user"
        : err instanceof Error
          ? err.message
          : String(err);
  } finally {
    unwireManualControl();
    job.record.finishedAt = new Date().toISOString();
    await finalizeRunSession(job, session);
  }
}
