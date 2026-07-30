import { getOptionalSession } from "@/server/dal";
import { deleteGlobalVariable } from "@/server/variables";

export async function DELETE(
  _request: Request,
  ctx: RouteContext<"/api/variables/global/[key]">,
) {
  const session = await getOptionalSession();
  if (!session) {
    return Response.json({ error: "not authenticated" }, { status: 401 });
  }
  const { key } = await ctx.params;
  await deleteGlobalVariable(session.userId, key);
  return Response.json({ ok: true });
}
