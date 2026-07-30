import { text } from "stream/consumers";
import { diffLines } from "diff";
import { getArtifactStream } from "@/server/artifacts";
import { getRun } from "@/server/runManager";
import { getRunFromDb } from "@/server/runs";
import { getOptionalSession } from "@/server/dal";
import type { RunRecord } from "@/server/types";

export const runtime = "nodejs";

const CONTEXT_LINES = 3;
const MAX_RENDERED_LINES = 3000;

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderLine(sign: string, cls: string, line: string): string {
  return `<div class="line ${cls}"><span class="sign">${sign}</span>${escapeHtml(line)}</div>`;
}

export async function GET(
  _request: Request,
  ctx: RouteContext<"/api/runs/[runId]/steps/[index]/dom-diff">,
) {
  const session = await getOptionalSession();
  if (!session) {
    return new Response("Not authenticated", { status: 401 });
  }

  const { runId, index } = await ctx.params;
  const stepIndex = Number(index);
  if (!Number.isInteger(stepIndex)) {
    return new Response("Invalid step index", { status: 400 });
  }

  const job = getRun(runId);
  const record: RunRecord | null = job?.record ?? (await getRunFromDb(runId));
  if (!record || record.userId !== session.userId) {
    return new Response("Not found", { status: 404 });
  }

  const step = record.steps.find((s) => s.index === stepIndex);
  if (!step) {
    return new Response("Step not found", { status: 404 });
  }
  if (!step.domBefore && !step.domAfter) {
    return new Response("No DOM snapshot was recorded for this step.", { status: 404 });
  }

  const [before, after] = await Promise.all([
    step.domBefore
      ? getArtifactStream(runId, step.domBefore)
          .then((s) => text(s))
          .catch(() => "")
      : Promise.resolve(""),
    step.domAfter
      ? getArtifactStream(runId, step.domAfter)
          .then((s) => text(s))
          .catch(() => "")
      : Promise.resolve(""),
  ]);

  const changes = diffLines(before, after);
  let added = 0;
  let removed = 0;
  let rendered = 0;
  let truncated = false;
  const parts: string[] = [];

  outer: for (const part of changes) {
    const lines = part.value.replace(/\n$/, "").split("\n");
    const cls = part.added ? "add" : part.removed ? "rm" : "ctx";
    const sign = part.added ? "+" : part.removed ? "-" : " ";
    if (part.added) added += lines.length;
    if (part.removed) removed += lines.length;

    // Unchanged blocks are collapsed to a few lines of context on either
    // side — otherwise a single-character change deep in a large page
    // would render the entire surrounding HTML verbatim.
    const isLongContext = cls === "ctx" && lines.length > CONTEXT_LINES * 2 + 1;
    const toRender = isLongContext
      ? [...lines.slice(0, CONTEXT_LINES), null, ...lines.slice(-CONTEXT_LINES)]
      : lines;

    for (const line of toRender) {
      if (rendered >= MAX_RENDERED_LINES) {
        truncated = true;
        break outer;
      }
      if (line === null) {
        parts.push(`<div class="line skip">⋯ ${lines.length - CONTEXT_LINES * 2} unchanged lines ⋯</div>`);
      } else {
        parts.push(renderLine(sign, cls, line));
      }
      rendered++;
    }
  }

  if (truncated) {
    parts.push(`<div class="line skip">⋯ output truncated ⋯</div>`);
  }

  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>DOM diff — step ${stepIndex + 1}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: ui-monospace, "SF Mono", Menlo, monospace; background: #f3f4f7; color: #14161c; }
  header { position: sticky; top: 0; display: flex; align-items: center; gap: 12px; padding: 10px 16px; background: #fff; border-bottom: 1px solid #e6e8ef; font-family: ui-sans-serif, system-ui, sans-serif; }
  header h1 { font-size: 13px; font-weight: 600; margin: 0; }
  header .stats { font-size: 12px; color: #6b7280; }
  header .add-count { color: #16a34a; font-weight: 600; }
  header .rm-count { color: #dc2626; font-weight: 600; }
  main { padding: 12px 0 40px; }
  .line { padding: 1px 16px; font-size: 12px; line-height: 1.6; white-space: pre-wrap; word-break: break-all; }
  .line .sign { display: inline-block; width: 14px; color: #9aa1ac; user-select: none; }
  .line.add { background: #e7f8ed; }
  .line.add .sign { color: #16a34a; }
  .line.rm { background: #fdecec; }
  .line.rm .sign { color: #dc2626; }
  .line.ctx { color: #6b7280; }
  .line.skip { color: #9aa1ac; font-style: italic; padding: 6px 16px; }
</style>
</head>
<body>
  <header>
    <h1>DOM diff — step ${stepIndex + 1} · ${escapeHtml(step.type)}</h1>
    <span class="stats"><span class="add-count">+${added}</span> <span class="rm-count">-${removed}</span></span>
  </header>
  <main>${parts.join("") || '<div class="line ctx">No differences.</div>'}</main>
</body>
</html>`;

  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}
