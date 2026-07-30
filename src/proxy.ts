import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { decrypt, SESSION_COOKIE_NAME } from "@/server/session";

// Optimistic check only — reads the session cookie, no database access.
// Real enforcement (ownership, etc.) happens in the DAL (src/server/dal.ts)
// and in each route handler.
const PUBLIC_ROUTES = new Set(["/login", "/register"]);

export default async function proxy(req: NextRequest) {
  const path = req.nextUrl.pathname;
  const isPublic = PUBLIC_ROUTES.has(path);

  const session = await decrypt(req.cookies.get(SESSION_COOKIE_NAME)?.value);

  if (!isPublic && !session?.userId) {
    const loginUrl = new URL("/login", req.nextUrl);
    loginUrl.searchParams.set("next", path);
    return NextResponse.redirect(loginUrl);
  }

  if (isPublic && session?.userId) {
    return NextResponse.redirect(new URL("/", req.nextUrl));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"],
};
