import { NextResponse } from "next/server";
import { oauthAttemptStore } from "@/lib/oauth-attempt-store";
import { authenticatePasswordRequest } from "@/lib/password-auth";
import {
  assertStrictLocalEnvironment,
  strictLocalModeEnabled,
} from "@/lib/strict-local-mode";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STRICT_LOCAL_HOST = "127.0.0.1:37645";
const NO_STORE = { "Cache-Control": "no-store" };
const ALLOWED_FIELDS = new Set(["password", "attemptId"]);

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
  if (
    Object.keys(body).some((field) => !ALLOWED_FIELDS.has(field)) ||
    typeof body.attemptId !== "string"
  ) {
    return NextResponse.json(
      { error: "OAuth attempt unavailable" },
      { status: 400, headers: NO_STORE },
    );
  }
  const status = oauthAttemptStore.status(body.attemptId);
  if (!status) {
    return NextResponse.json(
      { error: "OAuth attempt unavailable" },
      { status: 404, headers: NO_STORE },
    );
  }
  return NextResponse.json(status, { headers: NO_STORE });
}
