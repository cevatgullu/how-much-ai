import { NextResponse } from "next/server";
import { createSession, SESSION_COOKIE, SESSION_TTL_MS } from "@/lib/session";
import { sessionCookiePolicy } from "@/lib/strict-local-mode";
import { authenticatePasswordRequest } from "@/lib/password-auth";
import { browserMutationFailure } from "@/lib/request-body";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const guard = browserMutationFailure(req);
  if (guard) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const authentication = await authenticatePasswordRequest(req);
  if (!authentication.ok) {
    return NextResponse.json(
      { error: authentication.error },
      { status: authentication.status, headers: authentication.headers },
    );
  }

  const res = NextResponse.json({ ok: true });
  const cookiePolicy = sessionCookiePolicy();
  res.cookies.set(SESSION_COOKIE, await createSession(), {
    httpOnly: true,
    secure: cookiePolicy.secure,
    sameSite: cookiePolicy.sameSite,
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
  return res;
}
