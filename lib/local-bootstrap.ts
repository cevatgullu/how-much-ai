import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
// @ts-expect-error Node's native TypeScript test runner needs the extension.
import { assertStrictLocalEnvironment, strictLocalModeEnabled } from "./strict-local-mode.ts";

export const LOCAL_BOOTSTRAP_TTL_MS = 20_000;
export const LOCAL_BOOTSTRAP_CHALLENGE_TTL_MS = 10_000;
export const LOCAL_BOOTSTRAP_SERVER_PROOF_CONTEXT =
  "how-much-ai:local-bootstrap:server-proof:v1";
export const LOCAL_BOOTSTRAP_CLIENT_PROOF_CONTEXT =
  "how-much-ai:local-bootstrap:client-proof:v1";

export interface LocalBootstrapStore {
  issue(now?: number): string;
  consume(ticket: unknown, now?: number): boolean;
  issueChallenge(secret: string, now?: number): {
    challenge: string;
    serverProof: string;
  };
  consumeChallenge(
    challenge: unknown,
    proof: unknown,
    secret: string,
    now?: number,
  ): boolean;
  invalidateChallenges(): void;
}

interface LocalBootstrapStoreOptions {
  retained?: Map<string, number>;
  retainedChallenges?: Map<string, number>;
}

function digestCapability(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalCapability(value: unknown): value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) return false;
  try {
    const decoded = Buffer.from(value, "base64url");
    return decoded.length === 32 && decoded.toString("base64url") === value;
  } catch {
    return false;
  }
}

function bootstrapProof(secret: string, context: string, challenge: string): string {
  return createHmac("sha256", secret)
    .update(context, "utf8")
    .update(Buffer.from([0]))
    .update(challenge, "utf8")
    .digest("base64url");
}

function fixedTimeProofMatches(actual: unknown, expected: string): boolean {
  if (!canonicalCapability(actual)) return false;
  const actualBytes = Buffer.from(actual, "ascii");
  const expectedBytes = Buffer.from(expected, "ascii");
  return (
    actualBytes.length === expectedBytes.length &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}

export function createLocalBootstrapStore(
  options: LocalBootstrapStoreOptions = {},
): LocalBootstrapStore {
  const retained = options.retained ?? new Map<string, number>();
  const retainedChallenges = options.retainedChallenges ?? new Map<string, number>();

  return {
    issue(now = Date.now()) {
      const ticket = randomBytes(32).toString("base64url");
      retained.clear();
      retained.set(digestCapability(ticket), now + LOCAL_BOOTSTRAP_TTL_MS);
      return ticket;
    },

    consume(ticket, now = Date.now()) {
      const expiresAt = canonicalCapability(ticket)
        ? retained.get(digestCapability(ticket))
        : undefined;
      retained.clear();
      return expiresAt !== undefined && expiresAt > now;
    },

    issueChallenge(secret, now = Date.now()) {
      const challenge = randomBytes(32).toString("base64url");
      retainedChallenges.clear();
      retainedChallenges.set(
        digestCapability(challenge),
        now + LOCAL_BOOTSTRAP_CHALLENGE_TTL_MS,
      );
      return {
        challenge,
        serverProof: bootstrapProof(
          secret,
          LOCAL_BOOTSTRAP_SERVER_PROOF_CONTEXT,
          challenge,
        ),
      };
    },

    consumeChallenge(challenge, proof, secret, now = Date.now()) {
      const expiresAt = canonicalCapability(challenge)
        ? retainedChallenges.get(digestCapability(challenge))
        : undefined;
      // Invalidate before checking expiry or the supplied proof. A failed attempt can never be
      // repaired or replayed against the same capability.
      retainedChallenges.clear();
      if (expiresAt === undefined || expiresAt <= now || !canonicalCapability(challenge)) {
        return false;
      }
      const expected = bootstrapProof(
        secret,
        LOCAL_BOOTSTRAP_CLIENT_PROOF_CONTEXT,
        challenge,
      );
      return fixedTimeProofMatches(proof, expected);
    },

    invalidateChallenges() {
      retainedChallenges.clear();
    },
  };
}

declare global {
  var __hmcLocalBootstrapStore: LocalBootstrapStore | undefined;
}

export const localBootstrapStore =
  globalThis.__hmcLocalBootstrapStore ?? createLocalBootstrapStore();
globalThis.__hmcLocalBootstrapStore = localBootstrapStore;

function assertBootstrapAvailable(): void {
  if (!strictLocalModeEnabled()) throw new Error("Local bootstrap is unavailable");
  assertStrictLocalEnvironment();
}

function bootstrapSecret(): string {
  return process.env.AUTH_SECRET ?? "";
}

export function issueLocalBootstrapChallenge(now = Date.now()): {
  challenge: string;
  serverProof: string;
} {
  assertBootstrapAvailable();
  return localBootstrapStore.issueChallenge(bootstrapSecret(), now);
}

export function completeLocalBootstrapChallenge(
  challenge: unknown,
  proof: unknown,
  now = Date.now(),
): string | null {
  assertBootstrapAvailable();
  const accepted = localBootstrapStore.consumeChallenge(
    challenge,
    proof,
    bootstrapSecret(),
    now,
  );
  return accepted ? localBootstrapStore.issue(now) : null;
}

export function invalidateLocalBootstrapChallenge(): void {
  localBootstrapStore.invalidateChallenges();
}

export function consumeLocalBootstrapTicket(ticket: unknown, now = Date.now()): boolean {
  assertBootstrapAvailable();
  return localBootstrapStore.consume(ticket, now);
}
