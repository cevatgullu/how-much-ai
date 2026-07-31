import { NextResponse } from "next/server";
import { issueLocalBootstrapTicket, LOCAL_BOOTSTRAP_TTL_MS } from "@/lib/local-bootstrap";
import { authenticatePasswordRequest } from "@/lib/password-auth";
import {
  assertStrictLocalEnvironment,
  strictLocalModeEnabled,
} from "@/lib/strict-local-mode";

export const runtime = "nodejs";

const STRICT_LOCAL_HOST = "127.0.0.1:37645";
const NO_STORE = { "Cache-Control": "no-store" };

export async function POST(req: Request) {
  if (!strictLocalModeEnabled()) {
    return NextResponse.json({ error: "Not found" }, { status: 404, headers: NO_STORE });
  }
  if (req.headers.get("host") !== STRICT_LOCAL_HOST) {
    return NextResponse.json({ error: "Bad request" }, { status: 421, headers: NO_STORE });
  }
  if (req.headers.has("origin")) {
    return NextResponse.json({ error: "Request not allowed" }, { status: 403, headers: NO_STORE });
  }

  try {
    assertStrictLocalEnvironment();
  } catch {
    return NextResponse.json(
      { error: "Bootstrap unavailable" },
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

  return NextResponse.json(
    {
      ticket: issueLocalBootstrapTicket(),
      expiresInMs: LOCAL_BOOTSTRAP_TTL_MS,
    },
    { headers: NO_STORE },
  );
}
