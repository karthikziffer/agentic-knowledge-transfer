import { prisma } from "@/server/db";
import { verifyPassword } from "@/server/auth";
import { createSession } from "@/server/session";

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body?.password === "string" ? body.password : "";

  if (!email || !password) {
    return Response.json(
      { error: "Email and password are required" },
      { status: 400 },
    );
  }

  const user = await prisma.user.findUnique({ where: { email } });
  // Always run a bcrypt compare, even for an unknown email, so response
  // timing doesn't reveal whether the address is registered.
  const DUMMY_HASH = "$2a$10$CwTycUXWue0Thq9StjUM0uJ8lc8j9Vzq3vqzP2r0jT8sKKlm2vLXm";
  const valid = await verifyPassword(password, user?.passwordHash ?? DUMMY_HASH);

  if (!user || !valid) {
    return Response.json({ error: "Invalid email or password" }, { status: 401 });
  }

  await createSession(user.id);

  return Response.json({
    user: { id: user.id, email: user.email, name: user.name },
  });
}
