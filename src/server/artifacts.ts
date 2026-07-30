import fs from "fs";
import os from "os";
import path from "path";
import { Client } from "minio";

const BUCKET = process.env.MINIO_BUCKET || "skill-builder-artifacts";

function createClient(): Client {
  const endPoint = process.env.MINIO_ENDPOINT;
  if (!endPoint) throw new Error("MINIO_ENDPOINT is not set");
  return new Client({
    endPoint,
    port: process.env.MINIO_PORT ? Number(process.env.MINIO_PORT) : 9000,
    useSSL: process.env.MINIO_USE_SSL === "true",
    accessKey: process.env.MINIO_ACCESS_KEY || "",
    secretKey: process.env.MINIO_SECRET_KEY || "",
  });
}

const globalKey = Symbol.for("skill-builder.minio");
type GlobalWithMinio = typeof globalThis & { [globalKey]?: Client };
const g = globalThis as GlobalWithMinio;

function getClient(): Client {
  return g[globalKey] ?? (g[globalKey] = createClient());
}

// Constructing the client touches MINIO_ENDPOINT, which isn't available at
// `next build` time (only at container runtime) — same reasoning as the
// lazy Prisma client in db.ts. Defer construction until first use via this
// Proxy rather than at module load.
const minio = new Proxy({} as Client, {
  get(_target, prop, receiver) {
    return Reflect.get(getClient() as object, prop, receiver);
  },
});

let bucketReady: Promise<void> | undefined;

// Called before every operation below — cheap once the bucket exists
// (bucketExists is a single HEAD-ish call), memoized so it only actually
// creates the bucket once per process.
function ensureBucket(): Promise<void> {
  return (bucketReady ??= (async () => {
    const exists = await minio.bucketExists(BUCKET).catch(() => false);
    if (!exists) await minio.makeBucket(BUCKET);
  })());
}

function objectKey(runId: string, file: string): string {
  return `${runId}/${file}`;
}

function scratchRoot(runId: string): string {
  return path.join(os.tmpdir(), "skill-builder-artifacts", runId);
}

// Playwright needs a real filesystem path to write a trace.zip to (there's
// no direct "give me a buffer" API for tracing.stop()) — this is purely a
// transient scratch location for that single write; the durable copy is in
// MinIO. Screenshots don't need this at all, since page.screenshot() can
// return a Buffer directly.
export function runScratchDir(runId: string): string {
  const dir = scratchRoot(runId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function cleanupScratchDir(runId: string): void {
  fs.rmSync(scratchRoot(runId), { recursive: true, force: true });
}

export async function uploadArtifact(
  runId: string,
  file: string,
  contentType: string,
  data: Buffer | string, // string = local file path, streamed via fPutObject
): Promise<void> {
  await ensureBucket();
  const key = objectKey(runId, file);
  if (typeof data === "string") {
    await minio.fPutObject(BUCKET, key, data, { "Content-Type": contentType });
  } else {
    await minio.putObject(BUCKET, key, data, data.length, { "Content-Type": contentType });
  }
}

export async function getArtifactStream(runId: string, file: string) {
  await ensureBucket();
  return minio.getObject(BUCKET, objectKey(runId, file));
}

// Total object size, for serving HTTP Range requests (video seeking).
export async function statArtifact(runId: string, file: string): Promise<{ size: number }> {
  await ensureBucket();
  const stat = await minio.statObject(BUCKET, objectKey(runId, file));
  return { size: stat.size };
}

export async function getArtifactRange(
  runId: string,
  file: string,
  offset: number,
  length: number,
) {
  await ensureBucket();
  return minio.getPartialObject(BUCKET, objectKey(runId, file), offset, length);
}

export async function hasArtifact(runId: string, file: string): Promise<boolean> {
  await ensureBucket();
  try {
    await minio.statObject(BUCKET, objectKey(runId, file));
    return true;
  } catch {
    return false;
  }
}

export async function deleteRunArtifacts(runId: string): Promise<void> {
  if (!/^[a-zA-Z0-9_-]+$/.test(runId)) {
    throw new Error("invalid run id");
  }
  await ensureBucket();

  const prefix = `${runId}/`;
  const names: string[] = [];
  await new Promise<void>((resolve, reject) => {
    const stream = minio.listObjectsV2(BUCKET, prefix, true);
    stream.on("data", (obj) => {
      if (obj.name) names.push(obj.name);
    });
    stream.on("end", () => resolve());
    stream.on("error", reject);
  });
  if (names.length) await minio.removeObjects(BUCKET, names);

  cleanupScratchDir(runId);
}
