// @ts-expect-error Node's direct TypeScript test runner needs the source extension.
import { parseResetTimestamp } from "./format.ts";
import type { LocalLimitState } from "./local-notify-detect";

export const LOCAL_NOTIFY_STATE_VERSION = 1;
export const MAX_LOCAL_NOTIFY_STATE_BYTES = 64 * 1024;
export const MAX_LOCAL_NOTIFY_RECORDS = 512;
export const LOCAL_NOTIFY_STATE_STORAGE_KEY = "hma:local-notify-state:v1";

const ACCOUNT_HASH = /^[0-9a-f]{64}$/u;
const SAFE_LIMIT_KEY = /^[A-Za-z0-9][A-Za-z0-9._:%!~*'()-]{0,159}$/u;
const RESERVED_LIMIT_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const DOCUMENT_KEYS = ["version", "records"] as const;
const RECORD_KEYS = [
  "accountHash",
  "limitKey",
  "lastResetAt",
  "nextBoundaryIndex",
  "lastObservedUtilization",
] as const;

export interface LocalNotifyRecord extends LocalLimitState {
  accountHash: string;
  limitKey: string;
}

export interface LocalNotifyDocument {
  version: 1;
  records: LocalNotifyRecord[];
}

type ParseError = "corrupt" | "oversized" | "future_version";
type ParseResult =
  | { ok: true; document: LocalNotifyDocument }
  | { ok: false; document: LocalNotifyDocument; error: ParseError };

function emptyDocument(): LocalNotifyDocument {
  return { version: LOCAL_NOTIFY_STATE_VERSION, records: [] };
}

function failed(error: ParseError): ParseResult {
  return { ok: false, document: emptyDocument(), error };
}

function ownDataValues<T extends readonly string[]>(value: unknown, keys: T): Record<T[number], unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  if (Object.getPrototypeOf(value) !== Object.prototype) return null;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length || !keys.every((key) => ownKeys.includes(key))) return null;

  const values = Object.create(null) as Record<T[number], unknown>;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) return null;
    values[key as T[number]] = descriptor.value;
  }
  return values;
}

function arrayHasOnlyDenseDataItems(value: unknown[]): boolean {
  const ownKeys = Reflect.ownKeys(value);
  if (Object.getPrototypeOf(value) !== Array.prototype || ownKeys.length !== value.length + 1) return false;
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor)) return false;
  }
  return ownKeys.includes("length");
}

function validLimitKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    SAFE_LIMIT_KEY.test(value) &&
    !RESERVED_LIMIT_KEYS.has(value)
  );
}

function validTimestamp(value: unknown): value is string | null {
  return (
    value === null ||
    (typeof value === "string" && value.length <= 40 && parseResetTimestamp(value) !== null)
  );
}

function boundedInteger(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isInteger(value) && (value as number) >= minimum && (value as number) <= maximum;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalRecords(records: LocalNotifyRecord[]): LocalNotifyRecord[] {
  return records
    .map((record) => ({
      accountHash: record.accountHash,
      limitKey: record.limitKey,
      lastResetAt: record.lastResetAt,
      nextBoundaryIndex: record.nextBoundaryIndex,
      lastObservedUtilization: record.lastObservedUtilization,
    }))
    .sort(
      (left, right) =>
        compareText(left.accountHash, right.accountHash) || compareText(left.limitKey, right.limitKey),
    );
}

function validateDocument(candidate: unknown):
  | { ok: true; document: LocalNotifyDocument }
  | { ok: false; error: "corrupt" | "oversized" | "future_version" } {
  const document = ownDataValues(candidate, DOCUMENT_KEYS);
  if (!document) return { ok: false, error: "corrupt" };
  if (document.version !== LOCAL_NOTIFY_STATE_VERSION) {
    return typeof document.version === "number" && Number.isInteger(document.version) && document.version > 1
      ? { ok: false, error: "future_version" }
      : { ok: false, error: "corrupt" };
  }
  if (!Array.isArray(document.records) || !arrayHasOnlyDenseDataItems(document.records)) {
    return { ok: false, error: "corrupt" };
  }
  if (document.records.length > MAX_LOCAL_NOTIFY_RECORDS) return { ok: false, error: "oversized" };

  const records: LocalNotifyRecord[] = [];
  const identities = new Set<string>();
  for (const candidateRecord of document.records) {
    const values = ownDataValues(candidateRecord, RECORD_KEYS);
    if (
      !values ||
      typeof values.accountHash !== "string" ||
      !ACCOUNT_HASH.test(values.accountHash) ||
      !validLimitKey(values.limitKey) ||
      !validTimestamp(values.lastResetAt) ||
      !boundedInteger(values.nextBoundaryIndex, 0, 8) ||
      !boundedInteger(values.lastObservedUtilization, 0, 100)
    ) {
      return { ok: false, error: "corrupt" };
    }

    const identity = values.accountHash + "\0" + values.limitKey;
    if (identities.has(identity)) return { ok: false, error: "corrupt" };
    identities.add(identity);
    records.push({
      accountHash: values.accountHash,
      limitKey: values.limitKey,
      lastResetAt: values.lastResetAt,
      nextBoundaryIndex: values.nextBoundaryIndex,
      lastObservedUtilization: values.lastObservedUtilization,
    });
  }

  return {
    ok: true,
    document: { version: LOCAL_NOTIFY_STATE_VERSION, records: canonicalRecords(records) },
  };
}

export function parseLocalNotifyDocument(raw: string | null): ParseResult {
  if (raw === null) return { ok: true, document: emptyDocument() };
  if (typeof raw !== "string") return failed("corrupt");
  if (new TextEncoder().encode(raw).byteLength > MAX_LOCAL_NOTIFY_STATE_BYTES) return failed("oversized");

  let candidate: unknown;
  try {
    candidate = JSON.parse(raw);
  } catch {
    return failed("corrupt");
  }
  const validated = validateDocument(candidate);
  return validated.ok
    ? { ok: true, document: validated.document }
    : failed(validated.error);
}

export function loadLocalNotifyDocument(storage: Storage):
  | { ok: true; document: LocalNotifyDocument }
  | { ok: false; document: LocalNotifyDocument; error: "unavailable" | ParseError } {
  let raw: string | null;
  try {
    raw = storage.getItem(LOCAL_NOTIFY_STATE_STORAGE_KEY);
  } catch {
    return { ok: false, document: emptyDocument(), error: "unavailable" };
  }
  return parseLocalNotifyDocument(raw);
}

function serializeCanonicalDocument(document: LocalNotifyDocument): string {
  let serialized = `{"version":${LOCAL_NOTIFY_STATE_VERSION},"records":[`;
  for (let index = 0; index < document.records.length; index += 1) {
    const record = document.records[index];
    if (index > 0) serialized += ",";
    serialized +=
      `{"accountHash":"${record.accountHash}","limitKey":"${record.limitKey}",` +
      `"lastResetAt":${record.lastResetAt === null ? "null" : `"${record.lastResetAt}"`},` +
      `"nextBoundaryIndex":${record.nextBoundaryIndex},` +
      `"lastObservedUtilization":${record.lastObservedUtilization}}`;
  }
  return serialized + "]}";
}

export function saveLocalNotifyDocument(
  storage: Storage,
  document: LocalNotifyDocument,
): { ok: true } | { ok: false; error: "unavailable" | "oversized" } {
  try {
    const validated = validateDocument(document);
    if (!validated.ok) {
      return { ok: false, error: validated.error === "oversized" ? "oversized" : "unavailable" };
    }
    const serialized = serializeCanonicalDocument(validated.document);
    if (new TextEncoder().encode(serialized).byteLength > MAX_LOCAL_NOTIFY_STATE_BYTES) {
      return { ok: false, error: "oversized" };
    }
    storage.setItem(LOCAL_NOTIFY_STATE_STORAGE_KEY, serialized);
    return { ok: true };
  } catch {
    return { ok: false, error: "unavailable" };
  }
}

function bytesToHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  return bytesToHex(await globalThis.crypto.subtle.digest("SHA-256", bytes));
}

export async function hashLocalAccountId(accountId: string): Promise<string> {
  return sha256(accountId);
}

export async function localNotificationTag(accountHash: string, limitKey: string): Promise<string> {
  return "hma:" + (await sha256(accountHash + "\0" + limitKey)).slice(0, 32);
}
