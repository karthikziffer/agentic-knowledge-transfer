import { deleteSession } from "@/server/session";

export async function POST() {
  await deleteSession();
  return Response.json({ ok: true });
}
