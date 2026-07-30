// Pure jose-based JWT sign/verify — no Next.js imports. Safe to load from
// both the Next.js bundle (route handlers, server components) and the
// custom server (server.ts, run directly via tsx), which can't touch
// next/headers outside of Next's own request-handling runtime.
import { SignJWT, jwtVerify } from "jose";

export const SESSION_COOKIE_NAME = "session";

function encodedKey(): Uint8Array {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is not set");
  return new TextEncoder().encode(secret);
}

export async function encrypt(userId: string, expiresAt: Date): Promise<string> {
  return new SignJWT({ userId, expiresAt: expiresAt.toISOString() })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(expiresAt)
    .sign(encodedKey());
}

export async function decrypt(
  session: string | undefined,
): Promise<{ userId: string } | null> {
  if (!session) return null;
  try {
    const { payload } = await jwtVerify(session, encodedKey(), {
      algorithms: ["HS256"],
    });
    if (typeof payload.userId !== "string") return null;
    return { userId: payload.userId };
  } catch {
    return null;
  }
}
