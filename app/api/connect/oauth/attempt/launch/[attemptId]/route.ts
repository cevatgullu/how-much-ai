import { NextResponse } from "next/server";
import { oauthAttemptStore } from "@/lib/oauth-attempt-store";
import { buildAuthorizeUrlFromChallenge } from "@/lib/oauth";
import {
  assertStrictLocalEnvironment,
  strictLocalModeEnabled,
} from "@/lib/strict-local-mode";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STRICT_LOCAL_HOST = "127.0.0.1:37645";
const STRICT_LOCAL_ORIGIN = "http://127.0.0.1:37645";
const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(
  req: Request,
  context: { params: Promise<{ attemptId: string }> },
) {
  if (!strictLocalModeEnabled()) {
    return NextResponse.json(
      { error: "Not found" },
      { status: 404, headers: NO_STORE },
    );
  }
  const requestUrl = new URL(req.url);
  if (
    req.headers.get("host") !== STRICT_LOCAL_HOST ||
    requestUrl.origin !== STRICT_LOCAL_ORIGIN
  ) {
    return NextResponse.json(
      { error: "Bad request" },
      { status: 421, headers: NO_STORE },
    );
  }
  if (requestUrl.search !== "") {
    return NextResponse.json(
      { error: "Invalid request" },
      { status: 400, headers: NO_STORE },
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

  const { attemptId } = await context.params;
  if (
    requestUrl.pathname !==
    `/api/connect/oauth/attempt/launch/${attemptId}`
  ) {
    return NextResponse.json(
      { error: "OAuth attempt unavailable" },
      { status: 404, headers: NO_STORE },
    );
  }
  const launched = oauthAttemptStore.launch(attemptId);
  if (!launched) {
    return NextResponse.json(
      { error: "OAuth attempt unavailable" },
      { status: 404, headers: NO_STORE },
    );
  }
  return new Response(null, {
    status: 302,
    headers: {
      ...NO_STORE,
      Location: buildAuthorizeUrlFromChallenge(
        launched.challenge,
        launched.state,
      ),
    },
  });
}
