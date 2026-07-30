import fs from "fs";
import path from "path";
// Named import, not `import yaml from "js-yaml"` — js-yaml's real ESM build
// has no default export (only named exports like `load`/`dump`). A default
// import happens to work under ts-node/tsx's CJS interop, but fails a real
// Turbopack/webpack production build, which resolves the actual .mjs.
import { load } from "js-yaml";

// Prompt text for the LangGraph agents lives in prompts/prompts.yaml, not
// inline in the agent code, so wording can be edited without touching
// TypeScript. This module just loads and interpolates it; composition
// (which lines are included, loops) stays in the agent code.
const PROMPTS_PATH = path.join(process.cwd(), "src/server/prompts/prompts.yaml");

type PromptNode = string | { [key: string]: PromptNode };

let cached: PromptNode | undefined;

function loadPrompts(): PromptNode {
  if (!cached) {
    const raw = fs.readFileSync(PROMPTS_PATH, "utf-8");
    cached = load(raw) as PromptNode;
  }
  return cached;
}

// Looks up a dotted path, e.g. "flowSummary.synthesize.system".
function lookup(keyPath: string): string {
  const parts = keyPath.split(".");
  let node: PromptNode = loadPrompts();
  for (const part of parts) {
    if (typeof node !== "object" || node === null || !(part in node)) {
      throw new Error(`Prompt "${keyPath}" not found (missing "${part}")`);
    }
    node = node[part];
  }
  if (typeof node !== "string") {
    throw new Error(`Prompt "${keyPath}" does not resolve to text`);
  }
  return node;
}

// A prompt line/template with no variables, e.g. a system message.
export function getPrompt(keyPath: string): string {
  return lookup(keyPath);
}

// Fills {{var}} placeholders in a prompt template. Deliberately simple
// (no loops/conditionals) — those stay in the agent code, which decides
// whether a line is included at all before rendering it.
export function renderPrompt(keyPath: string, vars: Record<string, string>): string {
  const template = lookup(keyPath);
  return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) => {
    if (!(name in vars)) throw new Error(`Missing template var "${name}" for prompt "${keyPath}"`);
    return vars[name];
  });
}
