import { NextResponse } from "next/server";
import {
  OAuthAttemptCompletionError,
  completeOAuthAttempt,
} from "@/lib/oauth-attempt-completion";
import { oauthAttemptStore } from "@/lib/oauth-attempt-store";
import { parseOAuthCallbackRepresentation } from "@/lib/oauth";
import {
  browserMutationFailure,
  readJsonObject,
  requestBodyFailure,
} from "@/lib/request-body";
import {
  assertStrictLocalEnvironment,
  strictLocalModeEnabled,
} from "@/lib/strict-local-mode";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STRICT_LOCAL_HOST = "127.0.0.1:37645";
const STRICT_LOCAL_ORIGIN = "http://127.0.0.1:37645";
const NO_STORE = { "Cache-Control": "no-store" };
const ALLOWED_FIELDS = new Set(["code", "state"]);

export async function POST(req: Request) {
  if (!strictLocalModeEnabled()) {
    return NextResponse.json(
      { status: "failed" },
      { status: 404, headers: NO_STORE },
    );
  }
  if (req.headers.get("host") !== STRICT_LOCAL_HOST) {
    return NextResponse.json(
      { status: "failed" },
      { status: 421, headers: NO_STORE },
    );
  }
  const requestOrigin = new URL(req.url).origin;
  const mutationFailure = browserMutationFailure(req);
  if (
    mutationFailure ||
    requestOrigin !== STRICT_LOCAL_ORIGIN ||
    req.headers.get("origin") !== STRICT_LOCAL_ORIGIN ||
    req.headers.get("sec-fetch-site")?.trim().toLowerCase() !== "same-origin"
  ) {
    return NextResponse.json(
      { status: "failed" },
      { status: 403, headers: NO_STORE },
    );
  }
  try {
    assertStrictLocalEnvironment();
  } catch {
    return NextResponse.json(
      { status: "failed" },
      { status: 503, headers: NO_STORE },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = await readJsonObject(req, 8 * 1024);
  } catch (error) {
    const failure = requestBodyFailure(error);
    return NextResponse.json(
      { status: "failed" },
      { status: failure.status, headers: NO_STORE },
    );
  }
  if (Object.keys(body).some((field) => !ALLOWED_FIELDS.has(field))) {
    return NextResponse.json(
      { status: "failed" },
      { status: 400, headers: NO_STORE },
    );
  }
  if (typeof body.code !== "string" || typeof body.state !== "string") {
    return NextResponse.json(
      { status: "failed" },
      { status: 400, headers: NO_STORE },
    );
  }
  const callback = parseOAuthCallbackRepresentation(
    `${body.code}#${body.state}`,
  );
  if (!callback) {
    return NextResponse.json(
      { status: "failed" },
      { status: 400, headers: NO_STORE },
    );
  }

  // This is deliberately synchronous and immediately precedes the first provider await.
  const claim = oauthAttemptStore.claim(callback.state);
  if (!claim) {
    return NextResponse.json(
      { status: "failed" },
      { status: 409, headers: NO_STORE },
    );
  }

  try {
    await completeOAuthAttempt({
      userId: "default",
      code: callback.code,
      state: callback.state,
      verifier: claim.verifier,
      expectedAccountId: claim.expectedAccountId,
    });
    if (!oauthAttemptStore.finish(claim.attemptId, { status: "done" })) {
      return NextResponse.json(
        { status: "failed" },
        { status: 500, headers: NO_STORE },
      );
    }
    return NextResponse.json({ status: "done" }, { headers: NO_STORE });
  } catch (error) {
    oauthAttemptStore.finish(claim.attemptId, { status: "failed" });
    const status =
      error instanceof OAuthAttemptCompletionError ? error.status : 500;
    return NextResponse.json(
      { status: "failed" },
      { status, headers: NO_STORE },
    );
  }
}
