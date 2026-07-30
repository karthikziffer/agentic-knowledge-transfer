import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { decrypt, SESSION_COOKIE_NAME } from "./session";
import { prisma } from "./db";

// Optimistic checks happen in proxy.ts. This is the real enforcement point —
// call it from Server Components, Route Handlers, and Server Actions.
export const verifySession = cache(async () => {
  const cookieStore = await cookies();
  const session = await decrypt(cookieStore.get(SESSION_COOKIE_NAME)?.value);
  if (!session?.userId) {
    redirect("/login");
  }
  return session;
});

// Like verifySession, but returns null instead of redirecting — for routes
// that need to branch on auth state rather than always requiring it.
export const getOptionalSession = cache(async () => {
  const cookieStore = await cookies();
  return decrypt(cookieStore.get(SESSION_COOKIE_NAME)?.value);
});

export const getUser = cache(async () => {
  const session = await getOptionalSession();
  if (!session) return null;
  try {
    return await prisma.user.findUnique({
      where: { id: session.userId },
      select: { id: true, email: true, name: true, bio: true, createdAt: true },
    });
  } catch {
    return null;
  }
});
