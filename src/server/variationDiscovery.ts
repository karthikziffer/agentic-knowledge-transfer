import type { CDPSession } from "playwright";
import { INTERACTIVE_AX_ROLES, describeElementAtBackendNodeId } from "./automation";
import type { ElementLocator } from "./types";

export interface AlternativeTarget {
  description: string;
  locator: ElementLocator;
  // The accessibility tree's role for this element — independent of which
  // locator strategy ended up winning. `locator.role` is only ever set when
  // `locator.strategy === "role"`; an element with a testId still has a real
  // semantic role (e.g. "link"), which callers that need to classify by role
  // (src/server/actionGraph.ts's auto-follow allowlist) would otherwise miss.
  role: string;
}

// Hard ceiling on how many real elements to collect off one page — keeps
// CDP round trips (and the alternative-suggestion agent's prompt size)
// bounded on pages with very large nav/menu structures. Narrowing down to a
// handful of genuinely meaningful alternatives happens in the decision agent
// (src/server/alternativesAgent.ts). Also used by actionGraph.ts's crawl,
// where each element gets its own embedding call (and, if auto-followable,
// a full click+navigate+navigate-back cycle) — lowered from 60 to reduce
// peak per-page memory/time on a large sidebar/TOC page, a real contributor
// to sustained memory pressure on long crawls.
const MAX_ELEMENTS = 40;

// Enumerates every real, currently-visible, clickable element on the page —
// not just structural siblings of one original element — for the
// alternative-suggestion pipeline's "site agent" step
// (src/server/alternativesAgent.ts) to describe and the decision agent to
// choose from. Never invents a selector; every result traces back to a real
// DOM element via the same describeAndLocate() logic used at recording time,
// with its role/name upgraded from Chrome's real accessibility tree.
//
// Walks Accessibility.getFullAXTree() rather than querying a hardcoded CSS
// selector list — that old list ("a[href], button, [role='button'], ...")
// missed plain text inputs and any custom-role widget (e.g. role="switch")
// entirely, since it could only match tags/roles someone remembered to add
// up front. The accessibility tree already knows which roles are genuinely
// interactive, for any element, native or custom.
export async function listInteractiveElements(cdp: CDPSession): Promise<AlternativeTarget[]> {
  try {
    const { nodes } = await cdp.send("Accessibility.getFullAXTree", {});
    const results: AlternativeTarget[] = [];
    const seen = new Set<string>();

    for (const node of nodes) {
      if (results.length >= MAX_ELEMENTS) break;
      if (node.ignored) continue;
      const role = node.role?.value as string | undefined;
      if (!role || !INTERACTIVE_AX_ROLES.has(role)) continue;
      const name = ((node.name?.value as string | undefined) ?? "").trim().slice(0, 200);
      if (!name || !node.backendDOMNodeId) continue;

      const info = await describeElementAtBackendNodeId(cdp, node.backendDOMNodeId, { role, name }).catch(
        () => null,
      );
      // Real sites very often render the same nav twice (a desktop copy and
      // a CSS-hidden mobile-menu copy, or a dropdown item that only exists in
      // the DOM once its parent menu is expanded). A human could never click
      // something that isn't actually on screen, and Playwright's own
      // click() will just time out waiting for it to become actionable —
      // filter those out here so the decision agent is never offered a
      // candidate nothing can click.
      if (!info?.locator || !info.visible) continue;

      const key = info.locator.cssSelector || info.locator.value;
      if (seen.has(key)) continue;
      seen.add(key);
      results.push({ description: info.description, locator: info.locator, role });
    }
    return results;
  } catch {
    return [];
  }
}
