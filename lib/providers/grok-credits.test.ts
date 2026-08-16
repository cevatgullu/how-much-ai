// What the Grok card is allowed to believe.
//
// The JSON fixture is the payload grok.com's Usage panel and the CLI billing facade both return,
// captured 2026-08-16. The protobuf fixtures are synthetic: field numbers are unpublished, so what
// is worth pinning there is the fallback reader's tolerance — an unrecognised layout must yield
// nothing rather than a wrong number.
import assert from "node:assert/strict";
import { test } from "node:test";
import "./_resolve-ts.mjs";

const {
  classifyGrokPool,
  decodeProtoMessage,
  epochToIso,
  grokCreditsReadingIsEmpty,
  grpcWebEmptyRequest,
  grpcWebPayload,
  normalizeGrokCredits,
  readGrokCreditsConfig,
  readGrokCreditsJson,
  readGrokCreditsProto,
} = await import("./grok-credits.ts");

// --- the documented payload ---------------------------------------------------------------------

const CONFIG_PAYLOAD = {
  config: {
    currentPeriod: {
      type: "USAGE_PERIOD_TYPE_WEEKLY",
      start: "2026-08-12T22:58:04.994998+00:00",
      end: "2026-08-19T22:58:04.994998+00:00",
    },
    creditUsagePercent: 7,
    productUsage: [
      { product: "GrokBuild", usagePercent: 5 },
      { product: "GrokAppBuilder", usagePercent: 2 },
      { product: "GrokChat" },
    ],
    billingPeriodEnd: "2026-08-19T22:58:04.994998+00:00",
  },
};

const CONFIG_RESET_ISO = "2026-08-19T22:58:04.994Z";

test("the documented payload reads exactly as the Usage panel shows it", () => {
  const reading = readGrokCreditsConfig(CONFIG_PAYLOAD);
  assert.ok(reading);
  // creditUsagePercent is already the *used* share. Inverting it would report 93% on an account
  // that has spent 7%, which is the worst possible direction to be wrong in.
  assert.equal(reading.usedPercent, 7);
  assert.equal(reading.resetsAt, CONFIG_RESET_ISO);
  assert.equal(reading.weekly, true);
  assert.deepEqual(
    reading.products.map((product) => [product.kind, product.usedPercent]),
    [["grok_build", 5], ["grok_app_builder", 2]],
  );
});

test("a product with no percentage of its own gets no bar", () => {
  // GrokChat draws on the shared pool rather than a separate allowance. Drawing it at 0% would
  // claim an untouched quota that does not exist.
  const reading = readGrokCreditsConfig(CONFIG_PAYLOAD);
  assert.equal(reading?.products.some((product) => product.kind === "grok_chat"), false);
});

test("product labels are the ones grok.com uses", () => {
  const labels = new Map(
    (readGrokCreditsConfig(CONFIG_PAYLOAD)?.products ?? []).map((product) => [product.kind, product.label]),
  );
  assert.equal(labels.get("grok_build"), "Grok Build");
  assert.equal(labels.get("grok_app_builder"), "App Builder");
  const extras = readGrokCreditsConfig({
    config: {
      currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: "2026-08-19T22:58:04Z" },
      creditUsagePercent: 7,
      productUsage: [
        { product: "GrokImagine", usagePercent: 3 },
        { product: "GrokChat", usagePercent: 9 },
        // A product added after this build shipped still has a real number behind it.
        { product: "GrokVoice", usagePercent: 4 },
      ],
    },
  });
  assert.deepEqual(
    extras?.products.map((product) => [product.kind, product.label]),
    [["grok_imagine", "Imagine"], ["grok_chat", "Sohbet"], ["grok_product", "Grok Voice"]],
  );
});

test("the period type decides the title, and an absent one reads as weekly", () => {
  assert.equal(readGrokCreditsConfig(CONFIG_PAYLOAD)?.weekly, true);
  const monthly = readGrokCreditsConfig({
    config: {
      currentPeriod: { type: "USAGE_PERIOD_TYPE_MONTHLY", end: "2026-09-01T00:00:00Z" },
      creditUsagePercent: 4,
    },
  });
  assert.equal(monthly?.weekly, false);
});

test("a present period with no percentage is zero used, not unknown", () => {
  // proto3 drops zero-valued scalars, so "no creditUsagePercent" is how a fresh week arrives.
  const reading = readGrokCreditsConfig({
    config: { currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: "2026-08-19T22:58:04Z" } },
  });
  assert.equal(reading?.usedPercent, 0);
});

test("payloads that are not a credits config are refused outright", () => {
  // The invoice form of the same endpoint, and the two-hour rate limit. Both carry numbers that
  // would render as a quota bar and neither is one.
  assert.equal(readGrokCreditsConfig({ monthlyLimit: { val: 0 }, onDemandUsed: { val: 0 } }), null);
  assert.equal(readGrokCreditsConfig({ remainingQueries: 268, totalQueries: 270, windowSizeSeconds: 7200 }), null);
  assert.ok(grokCreditsReadingIsEmpty(readGrokCreditsJson({ remainingQueries: 268, totalQueries: 270 })));
  assert.ok(grokCreditsReadingIsEmpty(readGrokCreditsJson({ error: "no-credentials" })));
});

test("the reader tolerates the payload arriving without its config wrapper", () => {
  const reading = readGrokCreditsJson(CONFIG_PAYLOAD.config);
  assert.equal(reading.usedPercent, 7);
  assert.equal(reading.products.length, 2);
});

// --- protobuf fallback --------------------------------------------------------------------------

function varint(value: number): number[] {
  const out: number[] = [];
  let rest = value;
  do {
    const byte = rest & 0x7f;
    rest = Math.floor(rest / 128);
    out.push(rest > 0 ? byte | 0x80 : byte);
  } while (rest > 0);
  return out;
}

const tag = (field: number, wire: number) => varint(field * 8 + wire);

function double(field: number, value: number): number[] {
  const buffer = new DataView(new ArrayBuffer(8));
  buffer.setFloat64(0, value, true);
  return [...tag(field, 1), ...new Uint8Array(buffer.buffer)];
}

function delimited(field: number, payload: number[]): number[] {
  return [...tag(field, 2), ...varint(payload.length), ...payload];
}

const text = (field: number, value: string) => delimited(field, [...new TextEncoder().encode(value)]);
const uint = (field: number, value: number) => [...tag(field, 0), ...varint(value)];
const timestamp = (field: number, seconds: number) => delimited(field, uint(1, seconds));

// 20 Ağustos 2026 01:58 in Istanbul (UTC+3) — the stamp the account's Usage panel showed.
const RESET_SECONDS = Math.floor(Date.UTC(2026, 7, 19, 22, 58, 0) / 1000);
const RESET_ISO = "2026-08-19T22:58:00.000Z";

function creditsResponse(): Uint8Array {
  return new Uint8Array([
    ...delimited(1, [...text(1, "SUPER_GROK_PLUS_WEEKLY"), ...double(2, 6), ...timestamp(3, RESET_SECONDS)]),
    ...delimited(1, [...text(1, "GROK_BUILD"), ...double(2, 5)]),
    ...delimited(1, [...text(1, "APP_BUILDER"), ...double(2, 1)]),
  ]);
}

test("the protobuf reader refuses bytes that are not a complete message", () => {
  // Returning a half-parsed tree would let a truncated response become a confident reading.
  assert.equal(decodeProtoMessage(new Uint8Array([0x08])), null, "kesik varint");
  assert.equal(decodeProtoMessage(new Uint8Array([0x0a, 0x05, 0x01])), null, "eksik gövde");
  // Wire types 3 and 4 are proto2 groups; proto3 never emits them.
  assert.equal(decodeProtoMessage(new Uint8Array([0x0b])), null, "grup etiketi");
  assert.ok(decodeProtoMessage(new Uint8Array(uint(1, 42))), "geçerli mesaj okunmalı");
});

test("gRPC-web frames are peeled and raw protobuf is passed through untouched", () => {
  const body = new Uint8Array(uint(1, 7));
  const framed = new Uint8Array([0, 0, 0, 0, body.length, ...body]);
  assert.deepEqual([...grpcWebPayload(framed)], [...body]);
  // Some deployments answer the same method as bare protobuf; guessing "framed" would eat 5 bytes.
  assert.deepEqual([...grpcWebPayload(body)], [...body]);
  // A trailer frame carries an HTTP header block, not protobuf, and must not join the message.
  const trailer = [...new TextEncoder().encode("grpc-status:0\r\n")];
  const withTrailer = new Uint8Array([0, 0, 0, 0, body.length, ...body, 0x80, 0, 0, 0, trailer.length, ...trailer]);
  assert.deepEqual([...grpcWebPayload(withTrailer)], [...body]);
});

test("the request is one empty uncompressed frame", () => {
  assert.deepEqual([...grpcWebEmptyRequest()], [0, 0, 0, 0, 0]);
});

test("the protobuf fallback finds the pool, its reset, and the product pools", () => {
  const reading = readGrokCreditsProto(creditsResponse());
  assert.equal(reading.usedPercent, 6);
  assert.equal(reading.resetsAt, RESET_ISO);
  assert.deepEqual(
    reading.products.map((product) => [product.kind, product.usedPercent]),
    [["grok_build", 5], ["grok_app_builder", 1]],
  );
});

test("the same response read through a gRPC-web frame gives the same numbers", () => {
  const body = creditsResponse();
  const framed = new Uint8Array([0, 0, 0, (body.length >> 8) & 0xff, body.length & 0xff, ...body]);
  assert.deepEqual(readGrokCreditsProto(framed), readGrokCreditsProto(body));
});

test("an unreadable or unrecognised response reads as empty, never as zero used", () => {
  // A card with no bar is recoverable. A card claiming "0% used" sends the user to spend a quota
  // that may already be gone, so absence must not collapse into a number.
  const empty = readGrokCreditsProto(new Uint8Array([0xff, 0xff, 0xff]));
  assert.equal(empty.usedPercent, null);
  assert.ok(grokCreditsReadingIsEmpty(empty));
});

test("enum and count varints cannot masquerade as a percentage", () => {
  // A node with no label and no period is field detail, not a pool; reading its varints as
  // percentages was the failure mode that made every message in the tree look like a quota.
  const noisy = new Uint8Array(delimited(1, [...uint(1, 3), ...uint(2, 12)]));
  assert.ok(grokCreditsReadingIsEmpty(readGrokCreditsProto(noisy)));
});

test("pools are matched by name in every spelling the payload might use", () => {
  assert.equal(classifyGrokPool("GROK_CREDIT_TYPE_APP_BUILDER"), "grok_app_builder");
  assert.equal(classifyGrokPool("app-builder"), "grok_app_builder");
  assert.equal(classifyGrokPool("Grok Build"), "grok_build");
  assert.equal(classifyGrokPool("SUPER_GROK_PLUS_WEEKLY"), "pool");
  assert.equal(classifyGrokPool("something-else"), null);
  assert.equal(classifyGrokPool(null), null);
});

test("an unlabelled pool is identified by the period stamp only it carries", () => {
  const unlabelled = new Uint8Array(delimited(1, [...double(2, 6), ...timestamp(3, RESET_SECONDS)]));
  const reading = readGrokCreditsProto(unlabelled);
  assert.equal(reading.usedPercent, 6);
  assert.equal(reading.resetsAt, RESET_ISO);
  // Nothing names it as a product, so nothing is published as one rather than guessed.
  assert.deepEqual(reading.products, []);
});

test("epoch stamps outside a plausible billing period are counters, not dates", () => {
  assert.equal(epochToIso(42), null);
  assert.equal(epochToIso(RESET_SECONDS), RESET_ISO);
});

// --- normalisation ------------------------------------------------------------------------------

test("the pool is a weekly_all bar so Grok joins the summary, sorting, and the trend", () => {
  // Giving it a Grok-only kind would quietly drop the account out of every weekly view in the app.
  const usage = normalizeGrokCredits(readGrokCreditsConfig(CONFIG_PAYLOAD)!, "SuperGrok Plus");
  const weekly = usage.limits?.find((limit) => limit.kind === "weekly_all");
  assert.ok(weekly);
  assert.equal(weekly.percent, 7);
  assert.equal(weekly.resets_at, CONFIG_RESET_ISO);
  assert.equal(weekly.scope?.model?.display_name, "Haftalık SuperGrok Plus limiti");
});

test("product bars follow the pool and repeat no reset date", () => {
  const usage = normalizeGrokCredits(readGrokCreditsConfig(CONFIG_PAYLOAD)!, "SuperGrok Plus");
  assert.deepEqual(
    usage.limits?.map((limit) => [limit.kind, limit.percent]),
    [["weekly_all", 7], ["grok_build", 5], ["grok_app_builder", 2]],
  );
  for (const limit of usage.limits ?? []) {
    if (limit.kind === "weekly_all") continue;
    // One shared rollover printed under three bars reads as three independent schedules.
    assert.equal(limit.resets_at, null, `${limit.kind} kendi tarihini taşımamalı`);
  }
});

test("a non-weekly period says so instead of claiming a week", () => {
  const usage = normalizeGrokCredits(
    { usedPercent: 4, resetsAt: null, weekly: false, products: [] },
    "SuperGrok",
  );
  assert.equal(usage.limits?.[0].scope?.model?.display_name, "Dönemlik SuperGrok limiti");
});

test("severity follows the same thresholds the rest of the instrument uses", () => {
  const at = (percent: number) =>
    normalizeGrokCredits({ usedPercent: percent, resetsAt: null, weekly: true, products: [] }, "SuperGrok Plus")
      .limits?.[0]?.severity;
  assert.equal(at(6), "normal");
  assert.equal(at(55), "elevated");
  assert.equal(at(75), "warning");
  assert.equal(at(95), "critical");
});

test("a reading with nothing in it produces no bars at all", () => {
  const usage = normalizeGrokCredits(
    { usedPercent: null, resetsAt: null, weekly: true, products: [] },
    "Grok",
  );
  assert.deepEqual(usage.limits, []);
});
