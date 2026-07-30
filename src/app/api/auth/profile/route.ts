import { prisma } from "@/server/db";
import { verifySession } from "@/server/dal";

export async function PATCH(request: Request) {
  const session = await verifySession();

  const body = await request.json().catch(() => null);
  const name = typeof body?.name === "string" ? body.name.trim().slice(0, 100) : undefined;
  const bio = typeof body?.bio === "string" ? body.bio.trim().slice(0, 500) : undefined;

  const user = await prisma.user.update({
    where: { id: session.userId },
    data: {
      ...(name !== undefined && { name: name || null }),
      ...(bio !== undefined && { bio: bio || null }),
    },
    select: { id: true, email: true, name: true, bio: true, createdAt: true },
  });

  return Response.json({ user });
}
