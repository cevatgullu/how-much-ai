import { NextResponse } from "next/server";
import { consumeLocalBootstrapTicket } from "@/lib/local-bootstrap";
import { browserMutationFailure, readJsonObject } from "@/lib/request-body";
import {
  assertStrictLocalEnvironment,
  sessionCookiePolicy,
  strictLocalModeEnabled,
} from "@/lib/strict-local-mode";
import {
  createSession,
  SESSION_COOKIE,
  SESSION_TTL_MS,
} from "@/lib/session";

export const runtime = "nodejs";

const STRICT_LOCAL_HOST = "127.0.0.1:37645";
const STRICT_LOCAL_ORIGIN = "http://127.0.0.1:37645";
const NO_STORE = { "Cache-Control": "no-store" };

export async function POST(req: Request) {
  if (!strictLocalModeEnabled()) {
    return NextResponse.json({ error: "Not found" }, { status: 404, headers: NO_STORE });
  }
  if (req.headers.get("host") !== STRICT_LOCAL_HOST) {
    return NextResponse.json({ error: "Bad request" }, { status: 421, headers: NO_STORE });
  }

  const guard = browserMutationFailure(req);
  const requestOrigin = new URL(req.url).origin;
  if (
    guard ||
    requestOrigin !== STRICT_LOCAL_ORIGIN ||
    req.headers.get("origin") !== STRICT_LOCAL_ORIGIN ||
    req.headers.get("sec-fetch-site")?.trim().toLowerCase() !== "same-origin"
  ) {
    return NextResponse.json(
      { error: "Request not allowed" },
      { status: 403, headers: NO_STORE },
    );
  }

  try {
    assertStrictLocalEnvironment();
  } catch {
    return NextResponse.json(
      { error: "Bootstrap unavailable" },
      { status: 503, headers: NO_STORE },
    );
  }

  let ticket: unknown;
  try {
    ticket = (await readJsonObject(req, 4 * 1024)).ticket;
  } catch {
    return NextResponse.json(
      { error: "Bootstrap failed" },
      { status: 400, headers: NO_STORE },
    );
  }
  if (!consumeLocalBootstrapTicket(ticket)) {
    return NextResponse.json(
      { error: "Bootstrap failed" },
      { status: 401, headers: NO_STORE },
    );
  }

  const response = NextResponse.json({ ok: true }, { headers: NO_STORE });
  const cookiePolicy = sessionCookiePolicy();
  response.cookies.set(SESSION_COOKIE, await createSession(), {
    httpOnly: true,
    secure: cookiePolicy.secure,
    sameSite: cookiePolicy.sameSite,
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
  return response;
}
