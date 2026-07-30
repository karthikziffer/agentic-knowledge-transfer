import path from "path";
import { Readable } from "stream";
import {
  getArtifactStream,
  getArtifactRange,
  statArtifact,
} from "@/server/artifacts";
import { getRun } from "@/server/runManager";
import { getRunFromDb } from "@/server/runs";
import { getOptionalSession } from "@/server/dal";

export const runtime = "nodejs";

const CONTENT_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".zip": "application/zip",
  ".json": "application/json",
  ".webm": "video/webm",
};

export async function GET(
  request: Request,
  ctx: RouteContext<"/api/artifacts/[runId]/[file]">,
) {
  const session = await getOptionalSession();
  if (!session) {
    return Response.json({ error: "not authenticated" }, { status: 401 });
  }

  const { runId, file } = await ctx.params;

  // Reject path traversal / nested segments before touching object storage.
  if (!/^[a-zA-Z0-9._-]+$/.test(runId) || !/^[a-zA-Z0-9._-]+$/.test(file)) {
    return Response.json({ error: "invalid path" }, { status: 400 });
  }

  const record = getRun(runId)?.record ?? (await getRunFromDb(runId));
  if (!record || record.userId !== session.userId) {
    return Response.json({ error: "not found" }, { status: 404 });
  }

  const contentType = CONTENT_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";

  // Video playback needs Range support to seek without downloading the
  // whole file first — everything else is small enough to just send whole.
  const rangeHeader = request.headers.get("range");
  if (rangeHeader) {
    let size: number;
    try {
      size = (await statArtifact(runId, file)).size;
    } catch {
      return Response.json({ error: "not found" }, { status: 404 });
    }

    const match = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader);
    if (!match) {
      return Response.json({ error: "invalid range" }, { status: 416 });
    }
    const start = Number(match[1]);
    const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
    if (start >= size || start > end) {
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${size}` },
      });
    }

    const nodeStream = await getArtifactRange(runId, file, start, end - start + 1);
    return new Response(Readable.toWeb(nodeStream) as ReadableStream, {
      status: 206,
      headers: {
        "Content-Type": contentType,
        "Content-Range": `bytes ${start}-${end}/${size}`,
        "Content-Length": String(end - start + 1),
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, max-age=31536000, immutable",
      },
    });
  }

  let nodeStream;
  try {
    nodeStream = await getArtifactStream(runId, file);
  } catch {
    return Response.json({ error: "not found" }, { status: 404 });
  }

  return new Response(Readable.toWeb(nodeStream) as ReadableStream, {
    headers: {
      "Content-Type": contentType,
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, max-age=31536000, immutable",
    },
  });
}
