import { getOptionalSession } from "@/server/dal";
import {
  isValidVariableKey,
  listGlobalVariables,
  setGlobalVariable,
} from "@/server/variables";

export async function GET() {
  const session = await getOptionalSession();
  if (!session) {
    return Response.json({ error: "not authenticated" }, { status: 401 });
  }
  const variables = await listGlobalVariables(session.userId);
  return Response.json({ variables });
}

export async function POST(request: Request) {
  const session = await getOptionalSession();
  if (!session) {
    return Response.json({ error: "not authenticated" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const key = typeof body?.key === "string" ? body.key.trim() : "";
  const value = typeof body?.value === "string" ? body.value : "";

  if (!isValidVariableKey(key)) {
    return Response.json(
      { error: "Key must contain only letters, numbers, and underscores" },
      { status: 400 },
    );
  }
  if (!value) {
    return Response.json({ error: "Value is required" }, { status: 400 });
  }

  await setGlobalVariable(session.userId, key, value);
  return Response.json({ ok: true });
}
