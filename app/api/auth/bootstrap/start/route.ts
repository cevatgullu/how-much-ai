import { NextResponse } from "next/server";
import {
  completeLocalBootstrapChallenge,
  invalidateLocalBootstrapChallenge,
  issueLocalBootstrapChallenge,
  LOCAL_BOOTSTRAP_CHALLENGE_TTL_MS,
  LOCAL_BOOTSTRAP_TTL_MS,
} from "@/lib/local-bootstrap";
import { readJsonObject, requestBodyFailure } from "@/lib/request-body";
import {
  assertStrictLocalEnvironment,
  strictLocalModeEnabled,
} from "@/lib/strict-local-mode";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STRICT_LOCAL_HOST = "127.0.0.1:37645";
const LOCAL_BOOTSTRAP_HEADER = "x-hma-local-bootstrap";
const LOCAL_BOOTSTRAP_HEADER_VALUE = "proof-v1";
const NO_STORE = { "Cache-Control": "no-store" };
const FETCH_METADATA_HEADERS = [
  "sec-fetch-site",
  "sec-fetch-mode",
  "sec-fetch-dest",
  "sec-fetch-user",
] as const;

function requestGate(req: Request): NextResponse | null {
  if (!strictLocalModeEnabled()) {
    return NextResponse.json({ error: "Not found" }, { status: 404, headers: NO_STORE });
  }
  if (req.headers.get("host") !== STRICT_LOCAL_HOST) {
    return NextResponse.json({ error: "Bad request" }, { status: 421, headers: NO_STORE });
  }
  if (req.headers.has("origin")) {
    return NextResponse.json({ error: "Request not allowed" }, { status: 403, headers: NO_STORE });
  }
  if (
    req.headers.get(LOCAL_BOOTSTRAP_HEADER) !== LOCAL_BOOTSTRAP_HEADER_VALUE ||
    FETCH_METADATA_HEADERS.some((name) => req.headers.has(name))
  ) {
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
  return null;
}

export async function GET(req: Request) {
  const denied = requestGate(req);
  if (denied) return denied;

  const issued = issueLocalBootstrapChallenge();
  return NextResponse.json(
    {
      challenge: issued.challenge,
      serverProof: issued.serverProof,
      expiresInMs: LOCAL_BOOTSTRAP_CHALLENGE_TTL_MS,
    },
    { headers: NO_STORE },
  );
}

export async function POST(req: Request) {
  const denied = requestGate(req);
  if (denied) return denied;

  let body: Record<string, unknown>;
  try {
    body = await readJsonObject(req, 4 * 1024);
  } catch (error) {
    invalidateLocalBootstrapChallenge();
    const failure = requestBodyFailure(error);
    return NextResponse.json(
      { error: failure.error },
      { status: failure.status, headers: NO_STORE },
    );
  }

  const keys = Object.keys(body).sort();
  if (
    keys.length !== 2 ||
    keys[0] !== "challenge" ||
    keys[1] !== "proof" ||
    typeof body.challenge !== "string" ||
    typeof body.proof !== "string"
  ) {
    invalidateLocalBootstrapChallenge();
    return NextResponse.json(
      { error: "Invalid bootstrap proof" },
      { status: 400, headers: NO_STORE },
    );
  }

  const ticket = completeLocalBootstrapChallenge(body.challenge, body.proof);
  if (!ticket) {
    return NextResponse.json(
      { error: "Invalid bootstrap proof" },
      { status: 401, headers: NO_STORE },
    );
  }
  return NextResponse.json(
    {
      ticket,
      expiresInMs: LOCAL_BOOTSTRAP_TTL_MS,
    },
    { headers: NO_STORE },
  );
}
