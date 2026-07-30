import { OllamaEmbeddings } from "@langchain/ollama";
import { getOllamaUrl } from "./ollama";

const DEFAULT_MODEL = "nomic-embed-text";

export function getEmbeddingModel(): string {
  return process.env.EMBEDDING_MODEL || DEFAULT_MODEL;
}

// Lazy singleton, same reasoning as getChatModel() in flowSummary.ts —
// constructing this at `next build` time would touch env vars that don't
// exist yet.
const globalKey = Symbol.for("skill-builder.embeddingsClient");
type GlobalWithEmbeddings = typeof globalThis & { [globalKey]?: OllamaEmbeddings };

function getEmbeddingsClient(): OllamaEmbeddings {
  const g = globalThis as GlobalWithEmbeddings;
  return (g[globalKey] ??= new OllamaEmbeddings({ model: getEmbeddingModel(), baseUrl: getOllamaUrl() }));
}

// How long to wait for one embedding call before giving up — without this,
// a hung/overloaded Ollama request blocks whatever's waiting on it (e.g.
// actionGraph.ts's crawl, one call per discovered element) indefinitely,
// with nothing distinguishing "slow" from "actually stuck" from the
// outside. embedQuery() itself takes no abort signal, so this races it
// against a plain timer instead.
const EMBED_TIMEOUT_MS = 30_000;

export async function embedText(text: string): Promise<number[]> {
  return Promise.race([
    getEmbeddingsClient().embedQuery(text),
    new Promise<number[]>((_, reject) =>
      setTimeout(() => reject(new Error(`Embedding call timed out after ${EMBED_TIMEOUT_MS}ms`)), EMBED_TIMEOUT_MS),
    ),
  ]);
}
