import { getOptionalSession } from "@/server/dal";
import { checkOllamaConnection } from "@/server/ollama";

export async function GET() {
  const session = await getOptionalSession();
  if (!session) {
    return Response.json({ error: "not authenticated" }, { status: 401 });
  }
  const status = await checkOllamaConnection();
  return Response.json(status);
}
