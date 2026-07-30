import neo4j, { type Driver } from "neo4j-driver";

// Embedding vector width written by src/server/embeddings.ts — must match
// whatever EMBEDDING_MODEL actually produces (nomic-embed-text is 768-dim).
// Override if you switch to a model with a different output width.
export function getEmbeddingDimension(): number {
  return Number(process.env.EMBEDDING_DIMENSION) || 768;
}

function createDriver(): Driver {
  const url = process.env.MEMGRAPH_URL;
  if (!url) throw new Error("MEMGRAPH_URL is not set");
  // Memgraph doesn't require auth by default, but the driver's API still
  // needs an auth token object — empty credentials are accepted as-is.
  return neo4j.driver(url, neo4j.auth.basic("", ""));
}

const globalKey = Symbol.for("skill-builder.graphDriver");
type GlobalWithGraphDriver = typeof globalThis & { [globalKey]?: Driver };
const g = globalThis as GlobalWithGraphDriver;

// Constructing the driver touches MEMGRAPH_URL, which isn't available at
// `next build` time (only at container runtime) — same lazy-construction
// reasoning as the Prisma client in db.ts and the MinIO client in
// artifacts.ts. Unlike those two, this is a plain function rather than a
// Proxy-wrapped singleton: nothing outside this module needs to call
// methods on the driver directly, and a `get`-trap Proxy actively breaks
// neo4j-driver — `proxy.session()` invokes the real session() method with
// `this` bound to the Proxy wrapper (not the real Driver instance), which
// corrupts the driver's internal session/connection-tracking state instead
// of throwing an obvious error.
function getDriver(): Driver {
  return g[globalKey] ?? (g[globalKey] = createDriver());
}

export async function runCypher<T = Record<string, unknown>>(
  query: string,
  params: Record<string, unknown> = {},
): Promise<T[]> {
  const session = getDriver().session();
  try {
    const result = await session.run(query, params);
    return result.records.map((record) => record.toObject() as T);
  } finally {
    await session.close();
  }
}

let schemaReady: Promise<void> | undefined;

// Called before every graph write/search in actionGraph.ts — cheap once the
// index already exists. Memgraph's vector-index DDL has no "IF NOT EXISTS"
// clause and doesn't accept query parameters inside WITH CONFIG, so the
// dimension is inlined directly (it's a validated local number, not user
// input) and a duplicate-index error is swallowed rather than avoided
// up front.
export function ensureGraphSchema(): Promise<void> {
  return (schemaReady ??= (async () => {
    const dimension = getEmbeddingDimension();
    await runCypher(
      `CREATE VECTOR EDGE INDEX action_embeddings ON :ACTION(embedding) WITH CONFIG {"dimension": ${dimension}, "capacity": 100000, "metric": "cos"}`,
    ).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      if (!message.toLowerCase().includes("already exists")) throw err;
    });
  })());
}
