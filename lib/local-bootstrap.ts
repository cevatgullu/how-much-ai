import { createHash, randomBytes } from "node:crypto";
// @ts-expect-error Node's native TypeScript test runner needs the extension.
import { assertStrictLocalEnvironment, strictLocalModeEnabled } from "./strict-local-mode.ts";

export const LOCAL_BOOTSTRAP_TTL_MS = 20_000;
const LOCAL_BOOTSTRAP_MAX_ENTRIES = 8;

export interface LocalBootstrapStore {
  issue(now?: number): string;
  consume(ticket: unknown, now?: number): boolean;
}

interface LocalBootstrapStoreOptions {
  retained?: Map<string, number>;
}

function digestTicket(ticket: string): string {
  return createHash("sha256").update(ticket, "utf8").digest("hex");
}

function canonicalTicket(value: unknown): value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) return false;
  try {
    const decoded = Buffer.from(value, "base64url");
    return decoded.length === 32 && decoded.toString("base64url") === value;
  } catch {
    return false;
  }
}

export function createLocalBootstrapStore(
  options: LocalBootstrapStoreOptions = {},
): LocalBootstrapStore {
  const retained = options.retained ?? new Map<string, number>();

  return {
    issue(now = Date.now()) {
      const ticket = randomBytes(32).toString("base64url");
      retained.clear();
      retained.set(digestTicket(ticket), now + LOCAL_BOOTSTRAP_TTL_MS);
      while (retained.size > LOCAL_BOOTSTRAP_MAX_ENTRIES) {
        const oldest = retained.keys().next().value;
        if (oldest === undefined) break;
        retained.delete(oldest);
      }
      return ticket;
    },

    consume(ticket, now = Date.now()) {
      const expiresAt = canonicalTicket(ticket)
        ? retained.get(digestTicket(ticket))
        : undefined;
      retained.clear();
      return expiresAt !== undefined && expiresAt > now;
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

export function issueLocalBootstrapTicket(now = Date.now()): string {
  assertBootstrapAvailable();
  return localBootstrapStore.issue(now);
}

export function consumeLocalBootstrapTicket(ticket: unknown, now = Date.now()): boolean {
  assertBootstrapAvailable();
  return localBootstrapStore.consume(ticket, now);
}
