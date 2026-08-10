import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import {
  OpenAIDeviceAttemptCapacityError,
  openAIDeviceAttemptStore,
} from "@/lib/openai-device-attempt-store";
import {
  OPENAI_DEVICE_AUTH,
  OpenAIDeviceAuthError,
  startOpenAIDeviceAuthorization,
} from "@/lib/providers/openai-device-auth";
import { browserMutationFailure, readJsonObject, requestBodyFailure } from "@/lib/request-body";
import { reportServerError } from "@/lib/server-error-diagnostics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };
const BODY_LIMIT = 4 * 1024;
const EXPECTED_ACCOUNT_LIMIT = 200;
const ALLOWED_FIELDS = new Set(["expectedAccountId"]);

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
  if (Object.keys(body).some((field) => !ALLOWED_FIELDS.has(field))) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400, headers: NO_STORE });
  }

  const expectedAccountId =
    typeof body.expectedAccountId === "string" ? body.expectedAccountId.trim() : undefined;
  if (
    body.expectedAccountId !== undefined &&
    (typeof body.expectedAccountId !== "string" ||
      !expectedAccountId ||
      expectedAccountId.length > EXPECTED_ACCOUNT_LIMIT ||
      /[\u0000-\u001f\u007f]/.test(expectedAccountId))
  ) {
    return NextResponse.json(
      { error: "Invalid expected account id" },
      { status: 400, headers: NO_STORE },
    );
  }

  try {
    const authorization = await startOpenAIDeviceAuthorization();
    const attempt = openAIDeviceAttemptStore.start(userId, authorization, expectedAccountId);
    return NextResponse.json(
      { ...attempt, verificationUrl: OPENAI_DEVICE_AUTH.verificationUrl },
      { headers: NO_STORE },
    );
  } catch (error) {
    const { errorId } = reportServerError("connect.openai.device.start", error);
    const status =
      error instanceof OpenAIDeviceAttemptCapacityError
        ? 429
        : error instanceof OpenAIDeviceAuthError && error.status === 429
          ? 429
          : 502;
    return NextResponse.json(
      { error: "OpenAI device login is temporarily unavailable. Try again.", errorId },
      { status, headers: NO_STORE },
    );
  }
}
