// Grok weekly credits — the numbers grok.com itself shows under Settings → Usage.
//
// WHY THIS REPLACED THE TWO-HOUR MODE WINDOWS
// -------------------------------------------
// The first Grok reader polled POST /rest/rate-limits once per mode and drew a bar per mode over a
// rolling two-hour window. Those numbers are real, but they are not the quota a SuperGrok Plus
// subscriber runs out of: since xAI moved every product (Chat, Imagine, Voice, Build, API) onto one
// shared weekly pool, the two-hour counters only describe burst throttling. A card full of
// "Fast · 268/270" said nothing about the percentage the account actually spends.
//
// Three other readings look like quota and are not. None of them may drive a bar:
//   * remainingQueries / totalQueries / windowSizeSeconds — the two-hour rate limit above.
//   * /v1/billing without `?format=credits` — the money invoice, $0 on a subscription.
//   * onDemandUsed / monthlyLimit — pay-as-you-go, 0/0 unless the account enabled it.
//
// THE PAYLOAD
// -----------
// One `GrokCreditsConfig` message, reachable two ways depending on which credential the account
// holds. Both carry the same fields:
//
//   session cookie -> POST https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig
//   CLI bearer     -> GET  https://cli-chat-proxy.grok.com/v1/billing?format=credits
//
//   { "config": {
//       "currentPeriod": { "type": "USAGE_PERIOD_TYPE_WEEKLY", "start": …, "end": … },
//       "creditUsagePercent": 7,
//       "productUsage": [ { "product": "GrokBuild", "usagePercent": 5 },
//                         { "product": "GrokAppBuilder", "usagePercent": 2 },
//                         { "product": "GrokChat" } ],
//       "billingPeriodEnd": … } }
//
// `creditUsagePercent` is already the *used* share — it is shown as-is, never inverted. A product
// with no `usagePercent` (GrokChat above) has no separate allowance and gets no bar; drawing it at
// 0% would claim an untouched pool that does not exist.
//
// The named reader below handles that shape. Two fallbacks sit behind it — a loose key search for a
// renamed JSON field, and a generic protobuf walker for the binary gRPC-web form — because the RPC
// is internal and unversioned. All three yield null rather than a number when they do not recognise
// what came back: a missing reading is honest, an invented one sends the user to spend an allowance
// that may already be gone.

import type { LimitEntry, UsageData } from "../types";

export const GROK_WEEKLY_SURFACE = "Haftalık havuz";

/**
 * Product id → the bar kind it becomes. Fixed kinds rather than generated keys so a bar's identity
 * (which the notification store remembers) cannot move when xAI reorders or renames the list.
 */
const PRODUCT_KINDS: Record<string, string> = {
  grokbuild: "grok_build",
  grokappbuilder: "grok_app_builder",
  grokchat: "grok_chat",
  grokimagine: "grok_imagine",
  imagine: "grok_imagine",
};

/** Display names for products with no dedicated kind yet. */
function productLabel(product: string): string {
  const spaced = product.replace(/^Grok(?=[A-Z])/u, "").replace(/([a-z\d])([A-Z])/gu, "$1 $2").trim();
  return spaced ? `Grok ${spaced}` : "Grok";
}

export interface GrokCreditsProduct {
  /** Raw product id as sent, e.g. "GrokBuild". */
  id: string;
  /** Bar kind; a known product maps to a fixed one, anything else shares `grok_product`. */
  kind: string;
  label: string;
  usedPercent: number;
}

export interface GrokCreditsReading {
  /** Share of the shared pool consumed, 0–100, or null when unreadable. Already "used", not "left". */
  usedPercent: number | null;
  /** ISO stamp the period rolls over at, or null when the response carried none. */
  resetsAt: string | null;
  /** True when the period is the weekly one, which is what the bar title says. */
  weekly: boolean;
  products: GrokCreditsProduct[];
}

const EMPTY_READING: GrokCreditsReading = {
  usedPercent: null,
  resetsAt: null,
  weekly: true,
  products: [],
};

export function grokCreditsReadingIsEmpty(reading: GrokCreditsReading): boolean {
  return reading.usedPercent === null && reading.products.length === 0;
}

function isPercent(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

const SECONDS_MIN = 1_500_000_000; // 2017; anything older is a counter, not a billing period
const SECONDS_MAX = 4_000_000_000; // 2096

/** Epoch seconds or milliseconds to an ISO stamp `parseResetTimestamp` accepts, or null. */
export function epochToIso(value: number): string | null {
  if (!Number.isFinite(value)) return null;
  const seconds = value >= SECONDS_MAX ? value / 1000 : value;
  if (seconds < SECONDS_MIN || seconds > SECONDS_MAX) return null;
  return new Date(Math.round(seconds * 1000)).toISOString();
}

function isoStamp(value: unknown): string | null {
  if (typeof value === "number") return epochToIso(value);
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return epochToIso(numeric);
    const parsed = Date.parse(value);
    // The payload's stamps carry microseconds ("…:04.994998+00:00"); Date.parse keeps the
    // milliseconds and drops the rest, which is the precision the UI shows anyway.
    return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
  }
  if (value && typeof value === "object") {
    const seconds = (value as { seconds?: unknown }).seconds;
    if (typeof seconds === "number" || typeof seconds === "string") return epochToIso(Number(seconds));
  }
  return null;
}

// ---------------------------------------------------------------------------
// The named reader
// ---------------------------------------------------------------------------

function readProducts(value: unknown): GrokCreditsProduct[] {
  if (!Array.isArray(value)) return [];
  const products: GrokCreditsProduct[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as { product?: unknown; usagePercent?: unknown; usage_percent?: unknown };
    const id = typeof row.product === "string" ? row.product.trim() : "";
    const percent = isPercent(row.usagePercent)
      ? row.usagePercent
      : isPercent(row.usage_percent)
        ? row.usage_percent
        : null;
    // A product without its own percentage draws no allowance from a separate pool.
    if (!id || percent === null) continue;
    const kind = PRODUCT_KINDS[id.toLowerCase().replace(/[^a-z\d]/gu, "")] ?? "grok_product";
    // Two rows mapping to one kind would collide on the bar key; the first wins.
    if (seen.has(kind === "grok_product" ? `grok_product:${id.toLowerCase()}` : kind)) continue;
    seen.add(kind === "grok_product" ? `grok_product:${id.toLowerCase()}` : kind);
    products.push({ id, kind, label: KNOWN_PRODUCT_LABELS[kind] ?? productLabel(id), usedPercent: clampPercent(percent) });
  }
  return products;
}

const KNOWN_PRODUCT_LABELS: Record<string, string> = {
  grok_build: "Grok Build",
  grok_app_builder: "App Builder",
  grok_chat: "Sohbet",
  grok_imagine: "Imagine",
};

/**
 * Read the documented `{ config: … }` payload. Returns null when the shape is not present at all,
 * so the caller can fall through to the tolerant readers rather than reporting an empty account.
 */
export function readGrokCreditsConfig(payload: unknown): GrokCreditsReading | null {
  if (!payload || typeof payload !== "object") return null;
  const root = payload as Record<string, unknown>;
  const config = (root.config && typeof root.config === "object" ? root.config : root) as Record<string, unknown>;
  const period = (config.currentPeriod && typeof config.currentPeriod === "object"
    ? config.currentPeriod
    : {}) as Record<string, unknown>;

  const rawPercent = config.creditUsagePercent ?? config.credit_usage_percent;
  const products = readProducts(config.productUsage ?? config.product_usage);
  const hasPeriod = typeof period.type === "string" || typeof period.end === "string";
  // proto3 omits zero-valued scalars, so a present period with no percentage is 0% used. Without a
  // period and without products there is no evidence this payload is a credits config at all.
  if (!isPercent(rawPercent) && !hasPeriod && products.length === 0) return null;

  const periodType = typeof period.type === "string" ? period.type : "";
  return {
    usedPercent: isPercent(rawPercent) ? clampPercent(rawPercent) : hasPeriod ? 0 : null,
    resetsAt: isoStamp(period.end) ?? isoStamp(config.billingPeriodEnd) ?? isoStamp(config.billing_period_end),
    // Absent type defaults to weekly: every subscription period xAI bills on today is weekly, and
    // the alternative is a title that hedges about a schedule it does know.
    weekly: periodType === "" || /WEEK/u.test(periodType.toUpperCase()),
    products,
  };
}

// ---------------------------------------------------------------------------
// Tolerant fallbacks
// ---------------------------------------------------------------------------

const PERCENT_KEYS = [
  "creditUsagePercent", "credit_usage_percent",
  "usagePercent", "usage_percent",
  "usedPercent", "used_percent",
  "percentUsed", "percent_used",
];
const RESET_KEYS = [
  "end", "resetTime", "reset_time", "resetsAt", "resets_at", "resetAt", "reset_at",
  "nextResetTime", "next_reset_time",
  "billingPeriodEnd", "billing_period_end", "periodEnd", "period_end",
];

/**
 * Loose key search, for a payload that carries the same numbers under renamed fields.
 *
 * Deliberately does not accept a bare `percent` key or a lone number: the response also contains
 * rate-limit and invoice values, and a reader that grabs the first plausible number would happily
 * publish "$0 spent" as a quota.
 */
export function readGrokCreditsJson(payload: unknown): GrokCreditsReading {
  const named = readGrokCreditsConfig(payload);
  if (named && !grokCreditsReadingIsEmpty(named)) return named;

  let usedPercent: number | null = null;
  let resetsAt: string | null = null;
  const walk = (value: unknown, depth: number): void => {
    if (depth > 8 || !value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    const record = value as Record<string, unknown>;
    for (const key of PERCENT_KEYS) {
      if (usedPercent === null && isPercent(record[key])) usedPercent = clampPercent(record[key] as number);
    }
    for (const key of RESET_KEYS) {
      if (resetsAt === null) resetsAt = isoStamp(record[key]);
    }
    for (const nested of Object.values(record)) walk(nested, depth + 1);
  };
  walk(payload, 0);
  if (usedPercent === null) return EMPTY_READING;
  return { usedPercent, resetsAt, weekly: true, products: [] };
}

// ---------------------------------------------------------------------------
// gRPC-web framing + minimal protobuf wire reader
// ---------------------------------------------------------------------------

/** The request body: one uncompressed DATA frame carrying an empty message. */
export function grpcWebEmptyRequest(): Uint8Array<ArrayBuffer> {
  return new Uint8Array([0, 0, 0, 0, 0]);
}

/**
 * Peel gRPC-web DATA frames. Returns the input unchanged when it is not framed — some deployments
 * answer the same method as raw protobuf, and guessing wrong loses the whole response.
 */
export function grpcWebPayload(bytes: Uint8Array): Uint8Array {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  while (offset + 5 <= bytes.length) {
    const flag = bytes[offset];
    // Bit 7 marks a trailer frame (a header block, not protobuf); bit 0 marks compression, which
    // the client never negotiates. Anything else is not a frame header.
    if ((flag & 0b0111_1110) !== 0) return bytes;
    const size = (bytes[offset + 1] << 24 | bytes[offset + 2] << 16 | bytes[offset + 3] << 8 | bytes[offset + 4]) >>> 0;
    if (offset + 5 + size > bytes.length) return bytes;
    if ((flag & 0x80) === 0 && (flag & 1) === 0) chunks.push(bytes.subarray(offset + 5, offset + 5 + size));
    offset += 5 + size;
  }
  if (offset !== bytes.length || chunks.length === 0) return bytes;
  if (chunks.length === 1) return chunks[0];
  const merged = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let cursor = 0;
  for (const chunk of chunks) {
    merged.set(chunk, cursor);
    cursor += chunk.length;
  }
  return merged;
}

export type ProtoValue =
  | { wire: 0; varint: number }
  | { wire: 1; bytes: Uint8Array }
  | { wire: 2; bytes: Uint8Array }
  | { wire: 5; bytes: Uint8Array };

export interface ProtoNode {
  fields: Map<number, ProtoValue[]>;
}

/**
 * Read one varint as a Number.
 *
 * Values above 2^53 lose precision, which is acceptable here and nowhere else: varints are only
 * consumed as tags, small enums, percentages, and epoch seconds. The byte walk stays exact, so
 * framing is never lost even when a value is not.
 */
function readVarint(bytes: Uint8Array, start: number): { value: number; offset: number } | null {
  let value = 0;
  let scale = 1;
  let offset = start;
  // Ten groups is the maximum a 64-bit varint can occupy; more means the buffer is not protobuf.
  for (let read = 0; read < 10; read += 1) {
    if (offset >= bytes.length) return null;
    const byte = bytes[offset];
    offset += 1;
    value += (byte & 0x7f) * scale;
    if ((byte & 0x80) === 0) return { value, offset };
    scale *= 128;
  }
  return null;
}

/**
 * Decode one protobuf message into field number → raw values. Returns null on anything that does
 * not consume the buffer exactly, which is also how a length-delimited field is classified: bytes
 * that parse cleanly are a nested message, bytes that do not are a scalar.
 */
export function decodeProtoMessage(bytes: Uint8Array): ProtoNode | null {
  const fields = new Map<number, ProtoValue[]>();
  const push = (field: number, value: ProtoValue) => {
    const list = fields.get(field);
    if (list) list.push(value);
    else fields.set(field, [value]);
  };
  let offset = 0;
  while (offset < bytes.length) {
    const tag = readVarint(bytes, offset);
    if (!tag) return null;
    offset = tag.offset;
    const field = Math.floor(tag.value / 8);
    const wire = tag.value % 8;
    if (field < 1 || field > 536_870_911) return null;
    if (wire === 0) {
      const scalar = readVarint(bytes, offset);
      if (!scalar) return null;
      offset = scalar.offset;
      push(field, { wire: 0, varint: scalar.value });
    } else if (wire === 1 || wire === 5) {
      const size = wire === 1 ? 8 : 4;
      if (offset + size > bytes.length) return null;
      push(field, { wire, bytes: bytes.subarray(offset, offset + size) });
      offset += size;
    } else if (wire === 2) {
      const header = readVarint(bytes, offset);
      if (!header) return null;
      const size = header.value;
      if (!Number.isSafeInteger(size) || size < 0 || header.offset + size > bytes.length) return null;
      push(field, { wire: 2, bytes: bytes.subarray(header.offset, header.offset + size) });
      offset = header.offset + size;
    } else {
      // Wire types 3/4 are proto2 groups and 6/7 do not exist.
      return null;
    }
  }
  return { fields };
}

function fixedToNumber(value: ProtoValue): number | null {
  if (value.wire !== 1 && value.wire !== 5) return null;
  const view = new DataView(value.bytes.buffer, value.bytes.byteOffset, value.bytes.byteLength);
  const decoded = value.wire === 1 ? view.getFloat64(0, true) : view.getFloat32(0, true);
  return Number.isFinite(decoded) ? decoded : null;
}

const PRINTABLE = /^[\x20-\x7e]+$/u;

function asLabel(bytes: Uint8Array): string | null {
  if (bytes.length === 0 || bytes.length > 128) return null;
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  return PRINTABLE.test(text) ? text : null;
}

/** A `google.protobuf.Timestamp` is `{1: seconds, 2: nanos}` and nothing else. */
function timestampOf(node: ProtoNode): string | null {
  const seconds = node.fields.get(1)?.[0];
  if (!seconds || seconds.wire !== 0) return null;
  for (const field of node.fields.keys()) {
    if (field !== 1 && field !== 2) return null;
  }
  return epochToIso(seconds.varint);
}

interface ProtoPool {
  label: string | null;
  percent: number;
  resetAt: string | null;
}

function collectPools(node: ProtoNode, out: ProtoPool[]): void {
  let percent: number | null = null;
  let varintPercent: number | null = null;
  let label: string | null = null;
  let resetAt: string | null = null;
  const children: ProtoNode[] = [];

  for (const values of node.fields.values()) {
    for (const value of values) {
      if (value.wire === 1 || value.wire === 5) {
        const decoded = fixedToNumber(value);
        if (percent === null && decoded !== null && isPercent(decoded)) percent = decoded;
        continue;
      }
      if (value.wire === 0) {
        if (varintPercent === null && Number.isSafeInteger(value.varint) && isPercent(value.varint)) {
          varintPercent = value.varint;
        }
        if (resetAt === null) resetAt = epochToIso(value.varint);
        continue;
      }
      const nested = decodeProtoMessage(value.bytes);
      if (nested) {
        const stamp = timestampOf(nested);
        if (stamp !== null) {
          if (resetAt === null) resetAt = stamp;
          continue;
        }
        children.push(nested);
        continue;
      }
      if (label === null) label = asLabel(value.bytes);
    }
  }

  // A bare varint counts as a percentage only when the node offers no float and does carry an
  // identity: without that guard every enum value and repeat count in the tree becomes a "pool".
  const scalar = percent ?? ((label !== null || resetAt !== null) ? varintPercent : null);
  const resolved = scalar ?? (label !== null && classifyGrokPool(label) !== null ? 0 : null);
  if (resolved !== null) {
    out.push({ label, percent: resolved, resetAt });
    // A pool is a leaf in this taxonomy: its children are field detail, not further pools.
    return;
  }
  for (const child of children) collectPools(child, out);
}

/** Match a pool by whatever name the payload carries — enum spelling, product id, or title. */
export function classifyGrokPool(label: string | null): string | null {
  if (!label) return null;
  const text = label.toLowerCase();
  if (/app[\s_-]*builder|builder[\s_-]*app/u.test(text)) return "grok_app_builder";
  if (/build/u.test(text)) return "grok_build";
  if (/imagine/u.test(text)) return "grok_imagine";
  if (/chat/u.test(text)) return "grok_chat";
  if (/week|super[\s_-]*grok|subscription|plan|pool|credit/u.test(text)) return "pool";
  return null;
}

/**
 * Read the credits response as protobuf (gRPC-web framed or raw).
 *
 * Field numbers are not published, so this walks the wire format generically and matches pools by
 * the strings and timestamps they sit next to. It is the last resort behind both JSON readers.
 */
export function readGrokCreditsProto(bytes: Uint8Array): GrokCreditsReading {
  const node = decodeProtoMessage(grpcWebPayload(bytes));
  if (!node) return EMPTY_READING;
  const pools: ProtoPool[] = [];
  collectPools(node, pools);
  if (pools.length === 0) return EMPTY_READING;

  const products: GrokCreditsProduct[] = [];
  const claimed = new Set<string>();
  let overall: ProtoPool | null = null;
  const rest: ProtoPool[] = [];
  for (const pool of pools) {
    const kind = classifyGrokPool(pool.label);
    if (kind === "pool") {
      overall ??= pool;
    } else if (kind && !claimed.has(kind)) {
      claimed.add(kind);
      products.push({
        id: pool.label ?? kind,
        kind,
        label: KNOWN_PRODUCT_LABELS[kind] ?? productLabel(pool.label ?? kind),
        usedPercent: clampPercent(pool.percent),
      });
    } else if (!kind) {
      rest.push(pool);
    }
  }
  // Unlabelled pools: only the subscription period has a rollover, so the one carrying a timestamp
  // is the overall pool. Anything left over is not published rather than guessed into a product.
  overall ??= rest.find((pool) => pool.resetAt !== null) ?? rest[0] ?? null;
  if (!overall) return EMPTY_READING;
  return {
    usedPercent: clampPercent(overall.percent),
    resetsAt: overall.resetAt ?? pools.find((pool) => pool.resetAt !== null)?.resetAt ?? null,
    weekly: true,
    products,
  };
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

function severityFor(usedPercent: number): LimitEntry["severity"] {
  if (usedPercent >= 90) return "critical";
  if (usedPercent >= 70) return "warning";
  if (usedPercent >= 50) return "elevated";
  return "normal";
}

/**
 * Build the card's bars.
 *
 * The pool is emitted as `weekly_all` so it joins every other provider's weekly limit in the
 * summary, the sort modes, and the seven-day trend — it is the same kind of number, and a
 * Grok-only kind would silently drop the account out of all three. Its scope carries the plan name
 * so the label reads "Haftalık SuperGrok Plus limiti" rather than the generic phrase.
 *
 * Product pools share that rollover, so they carry no stamp of their own: one date printed under
 * three bars reads as three independent schedules.
 */
export function normalizeGrokCredits(reading: GrokCreditsReading, planLabel: string): UsageData {
  const limits: LimitEntry[] = [];
  if (reading.usedPercent !== null) {
    limits.push({
      kind: "weekly_all",
      group: "credits",
      percent: reading.usedPercent,
      severity: severityFor(reading.usedPercent),
      resets_at: reading.resetsAt,
      scope: {
        model: {
          id: "credits",
          display_name: `${reading.weekly ? "Haftalık" : "Dönemlik"} ${planLabel} limiti`,
        },
        surface: GROK_WEEKLY_SURFACE,
      },
      is_active: true,
    });
  }
  for (const product of reading.products) {
    limits.push({
      kind: product.kind,
      group: product.id,
      percent: product.usedPercent,
      severity: severityFor(product.usedPercent),
      resets_at: null,
      scope: { model: { id: product.id, display_name: product.label }, surface: GROK_WEEKLY_SURFACE },
      is_active: true,
    });
  }
  return { limits };
}
