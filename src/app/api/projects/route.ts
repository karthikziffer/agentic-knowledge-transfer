import { getOptionalSession } from "@/server/dal";
import { createProject, listProjects } from "@/server/projects";
import { Prisma } from "@/generated/prisma/client";
import { deleteSession } from "@/server/session";

export async function GET() {
  const session = await getOptionalSession();
  if (!session) {
    return Response.json({ error: "not authenticated" }, { status: 401 });
  }
  const projects = await listProjects(session.userId);
  return Response.json({ projects });
}

export async function POST(request: Request) {
  const session = await getOptionalSession();
  if (!session) {
    return Response.json({ error: "not authenticated" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const description =
    typeof body?.description === "string" ? body.description.trim() : undefined;

  if (!name) {
    return Response.json({ error: "Name is required" }, { status: 400 });
  }

  try {
    const project = await createProject(session.userId, name, description || undefined);
    return Response.json({ project });
  } catch (err) {
    // The session JWT is self-contained and doesn't check the DB — if the
    // user row it points to is gone (e.g. account removed elsewhere), this
    // insert fails on the userId foreign key. Clear the stale cookie and
    // ask for a fresh login instead of surfacing a raw 500.
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2003"
    ) {
      await deleteSession();
      return Response.json(
        { error: "Your session is no longer valid. Please sign in again." },
        { status: 401 },
      );
    }
    throw err;
  }
}
