import { NextResponse } from "next/server";
import {
  OAuthAttemptCapacityError,
  oauthAttemptStore,
} from "@/lib/oauth-attempt-store";
import { authenticatePasswordRequest } from "@/lib/password-auth";
import {
  assertStrictLocalEnvironment,
  strictLocalModeEnabled,
} from "@/lib/strict-local-mode";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STRICT_LOCAL_HOST = "127.0.0.1:37645";
const NO_STORE = { "Cache-Control": "no-store" };
const ALLOWED_FIELDS = new Set(["password", "expectedAccountId"]);
const EXPECTED_ACCOUNT_LIMIT = 200;

export async function POST(req: Request) {
  if (!strictLocalModeEnabled()) {
    return NextResponse.json(
      { error: "Not found" },
      { status: 404, headers: NO_STORE },
    );
  }
  if (req.headers.get("host") !== STRICT_LOCAL_HOST) {
    return NextResponse.json(
      { error: "Bad request" },
      { status: 421, headers: NO_STORE },
    );
  }
  if (req.headers.has("origin")) {
    return NextResponse.json(
      { error: "Request not allowed" },
      { status: 403, headers: NO_STORE },
    );
  }
  try {
    assertStrictLocalEnvironment();
  } catch {
    return NextResponse.json(
      { error: "OAuth connection unavailable" },
      { status: 503, headers: NO_STORE },
    );
  }

  const authentication = await authenticatePasswordRequest(req);
  if (!authentication.ok) {
    return NextResponse.json(
      { error: authentication.error },
      {
        status: authentication.status,
        headers: { ...authentication.headers, ...NO_STORE },
      },
    );
  }
  const body = authentication.body;
  if (Object.keys(body).some((field) => !ALLOWED_FIELDS.has(field))) {
    return NextResponse.json(
      { error: "Invalid request" },
      { status: 400, headers: NO_STORE },
    );
  }
  const expectedAccountId =
    typeof body.expectedAccountId === "string"
      ? body.expectedAccountId.trim()
      : undefined;
  if (
    body.expectedAccountId !== undefined &&
    (typeof body.expectedAccountId !== "string" ||
      !expectedAccountId ||
      expectedAccountId.length > EXPECTED_ACCOUNT_LIMIT ||
      /[\u0000-\u001f\u007f]/.test(expectedAccountId))
  ) {
    return NextResponse.json(
      { error: "Invalid request" },
      { status: 400, headers: NO_STORE },
    );
  }

  try {
    return NextResponse.json(
      oauthAttemptStore.start(
        expectedAccountId ? { expectedAccountId } : undefined,
      ),
      { headers: NO_STORE },
    );
  } catch (error) {
    const status = error instanceof OAuthAttemptCapacityError ? 429 : 503;
    return NextResponse.json(
      { error: "OAuth connection unavailable" },
      { status, headers: NO_STORE },
    );
  }
}
