import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { resolveProviderAccount, saveProviderAccount } from "@/lib/connect-account";
import { openAIDeviceAttemptStore } from "@/lib/openai-device-attempt-store";
import {
  exchangeOpenAIDeviceAuthorization,
  OpenAIDeviceAuthError,
  pollOpenAIDeviceAuthorization,
} from "@/lib/providers/openai-device-auth";
import { browserMutationFailure, readJsonObject, requestBodyFailure } from "@/lib/request-body";
import { reportServerError } from "@/lib/server-error-diagnostics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };
const BODY_LIMIT = 4 * 1024;
const POLL_OWNER_RENEW_MS = 10_000;
const ALLOWED_FIELDS = new Set(["attemptId"]);

function unavailable(status = 404) {
  return NextResponse.json(
    { error: "OpenAI device login attempt unavailable" },
    { status, headers: NO_STORE },
  );
}

function retryablePreCodeError(error: unknown): error is OpenAIDeviceAuthError {
  return (
    error instanceof OpenAIDeviceAuthError &&
    error.phase === "poll" &&
    (error.status === 429 || error.status >= 500)
  );
}

export async function POST(req: Request) {
  const guard = browserMutationFailure(req);
  if (guard) {
    return NextResponse.json({ error: guard.error }, { status: guard.status, headers: NO_STORE });
  }
  const userId = await requireUser(req);
  if (!userId) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401, headers: NO_STORE });
  }

  let body: Record<string, unknown>;
  try {
    body = await readJsonObject(req, BODY_LIMIT);
  } catch (error) {
    const failure = requestBodyFailure(error);
    return NextResponse.json({ error: failure.error }, { status: failure.status, headers: NO_STORE });
  }
  if (
    Object.keys(body).some((field) => !ALLOWED_FIELDS.has(field)) ||
    typeof body.attemptId !== "string"
  ) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400, headers: NO_STORE });
  }

  const visible = openAIDeviceAttemptStore.status(body.attemptId, userId);
  if (!visible) return unavailable();
  if (visible.status === "done" || visible.status === "failed" || visible.status === "expired") {
    return NextResponse.json(visible, { headers: NO_STORE });
  }

  const claim = openAIDeviceAttemptStore.claimPoll(body.attemptId, userId);
  if (!claim) return unavailable();
  if (claim.kind !== "poll") {
    return NextResponse.json(
      { status: claim.kind, pollAfterMs: claim.pollAfterMs, expiresAt: claim.expiresAt },
      { headers: NO_STORE },
    );
  }

  let saving = false;
  let consuming = false;
  let ownerAlive = true;
  let renewalActive = true;
  const renewal = setInterval(() => {
    if (!openAIDeviceAttemptStore.renewPoll(body.attemptId, claim.owner)) ownerAlive = false;
  }, POLL_OWNER_RENEW_MS);
  const stopRenewal = () => {
    if (!renewalActive) return;
    renewalActive = false;
    clearInterval(renewal);
  };
  const requireCurrentOwner = () => {
    if (!ownerAlive) throw new Error("OpenAI device login poll ownership was lost");
  };
  try {
    const result = await pollOpenAIDeviceAuthorization(claim.authorization);
    requireCurrentOwner();
    if (result.status === "pending") {
      if (!openAIDeviceAttemptStore.releasePending(body.attemptId, claim.owner)) return unavailable(409);
      const pending = openAIDeviceAttemptStore.status(body.attemptId, userId);
      return pending ? NextResponse.json(pending, { headers: NO_STORE }) : unavailable();
    }

    if (!openAIDeviceAttemptStore.beginConsume(body.attemptId, claim.owner)) {
      return unavailable(409);
    }
    consuming = true;
    stopRenewal();

    const tokens = await exchangeOpenAIDeviceAuthorization(result.grant);
    const { identity } = await resolveProviderAccount(tokens, "openai");
    if (claim.expectedAccountId && identity.id !== claim.expectedAccountId) {
      openAIDeviceAttemptStore.fail(body.attemptId, claim.owner);
      return NextResponse.json(
        {
          error: "This ChatGPT login belongs to a different account. Start a new login for the selected account.",
        },
        { status: 409, headers: NO_STORE },
      );
    }

    saving = true;
    const account = await saveProviderAccount(userId, identity, tokens, "openai", "managed");
    if (!openAIDeviceAttemptStore.complete(body.attemptId, claim.owner, account)) {
      throw new Error("OpenAI device login completion ownership was lost");
    }
    return NextResponse.json({ status: "done", account }, { headers: NO_STORE });
  } catch (error) {
    const retryable = !consuming && retryablePreCodeError(error);
    if (retryable) openAIDeviceAttemptStore.releasePending(body.attemptId, claim.owner);
    else openAIDeviceAttemptStore.fail(body.attemptId, claim.owner);

    const { errorId } = reportServerError(
      saving ? "connect.openai.device.save" : "connect.openai.device.poll",
      error,
    );
    const status = saving ? 500 : retryable && error.status === 429 ? 429 : 502;
    return NextResponse.json(
      {
        error: saving
          ? "The account was verified, but its encrypted credential could not be saved. Start a new login and try again."
          : retryable
            ? "OpenAI device login could not be checked. Try again shortly."
            : "OpenAI device login could not be completed. Start a new login and try again.",
        errorId,
      },
      { status, headers: NO_STORE },
    );
  } finally {
    stopRenewal();
  }
}
