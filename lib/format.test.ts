import assert from "node:assert/strict";
import { test } from "node:test";
import "./providers/_resolve-ts.mjs";

const { extractBars, formatResetSchedule } = await import("./format.ts");

test("extractBars maps Claude flat buckets to stable Turkish remaining bars", () => {
  const bars = extractBars({
    five_hour: { utilization: 40, resets_at: "2026-08-01T00:00:00.000Z" },
    seven_day: { utilization: 30, resets_at: null },
    seven_day_oauth_apps: { utilization: 20, resets_at: null },
    seven_day_opus: { utilization: 80, resets_at: null },
    seven_day_sonnet: { utilization: 10, resets_at: null },
  });

  assert.deepEqual(bars, [
    {
      key: "session",
      kind: "session",
      label: "5 saatlik limit",
      usedPercent: 40,
      remainingPercent: 60,
      resetsAt: "2026-08-01T00:00:00.000Z",
      severity: "normal",
      isActive: false,
    },
    {
      key: "weekly_all",
      kind: "weekly_all",
      label: "Haftalık limit",
      usedPercent: 30,
      remainingPercent: 70,
      resetsAt: null,
      severity: "normal",
      isActive: false,
    },
    {
      key: "weekly_oauth_apps",
      kind: "weekly_oauth_apps",
      label: "Bağlı uygulamalar haftalık limiti",
      usedPercent: 20,
      remainingPercent: 80,
      resetsAt: null,
      severity: "normal",
      isActive: false,
    },
    {
      key: "weekly_scoped:opus",
      kind: "weekly_scoped",
      label: "Opus haftalık limiti",
      usedPercent: 80,
      remainingPercent: 20,
      resetsAt: null,
      severity: "normal",
      isActive: false,
    },
    {
      key: "weekly_scoped:sonnet",
      kind: "weekly_scoped",
      label: "Sonnet haftalık limiti",
      usedPercent: 10,
      remainingPercent: 90,
      resetsAt: null,
      severity: "normal",
      isActive: false,
    },
  ]);
});

test("extractBars keeps rich rows and fills only missing canonical flat buckets", () => {
  const bars = extractBars({
    limits: [
      { kind: "weekly_scoped", percent: 70, severity: "warning", resets_at: null, scope: { model: { id: "claude-opus-4", display_name: "Opus" } } },
      { kind: "weekly_all", percent: 50, severity: "elevated", resets_at: null, is_active: true },
      { kind: "session", percent: 15, severity: "normal", resets_at: null },
    ],
    five_hour: { utilization: 99, resets_at: null },
    seven_day: { utilization: 99, resets_at: null },
    seven_day_opus: { utilization: 99, resets_at: null },
    seven_day_sonnet: { utilization: 5, resets_at: null },
    seven_day_oauth_apps: { utilization: 7, resets_at: null },
  });

  assert.deepEqual(
    bars.map((bar) => [bar.key, bar.usedPercent, bar.label, bar.severity, bar.isActive]),
    [
      ["session", 15, "5 saatlik limit", "normal", false],
      ["weekly_all", 50, "Haftalık limit", "elevated", true],
      ["weekly_oauth_apps", 7, "Bağlı uygulamalar haftalık limiti", "normal", false],
      ["weekly_scoped:opus", 70, "Opus haftalık limiti", "warning", false],
      ["weekly_scoped:sonnet", 5, "Sonnet haftalık limiti", "normal", false],
    ],
  );
});

test("extractBars derives scoped keys independently of provider row order", () => {
  const limits = [
    { kind: "weekly_scoped", percent: 33, severity: "normal", resets_at: null, scope: { model: { id: "gpt-5", display_name: "GPT-5" } } },
    { kind: "weekly_scoped", percent: 44, severity: "normal", resets_at: null, scope: { model: { id: "gpt-5-codex", display_name: "GPT-5 Codex" } } },
  ];

  const forward = extractBars({ limits });
  const reverse = extractBars({ limits: [...limits].reverse() });

  assert.deepEqual(
    forward.map((bar) => [bar.key, bar.label]),
    [
      ["weekly_scoped:gpt-5", "GPT-5 haftalık limiti"],
      ["weekly_scoped:gpt-5-codex", "GPT-5 Codex haftalık limiti"],
    ],
  );
  assert.deepEqual(reverse, forward);
});

test("extractBars rounds and clamps only finite numeric utilization", () => {
  const bars = extractBars({
    limits: [
      { kind: "session", percent: Number.NaN, severity: "normal", resets_at: null },
      { kind: "weekly_all", percent: Number.POSITIVE_INFINITY, severity: "normal", resets_at: null },
      { kind: "weekly_oauth_apps", percent: "20", severity: "normal", resets_at: null },
    ] as any,
    five_hour: { utilization: -0.6, resets_at: null },
    seven_day: { utilization: 100.5, resets_at: null },
    seven_day_oauth_apps: { utilization: Number.NEGATIVE_INFINITY, resets_at: null },
  });

  assert.deepEqual(
    bars.map((bar) => [bar.key, bar.usedPercent, bar.remainingPercent]),
    [
      ["session", 0, 100],
      ["weekly_all", 100, 0],
    ],
  );
});

test("formatResetSchedule presents deterministic Turkish future reset times", () => {
  assert.deepEqual(formatResetSchedule("2026-07-31T22:30:00.000Z", Date.parse("2026-07-31T20:00:00.000Z"), { timeZone: "UTC" }), {
    exact: "31 Tem 22:30",
    countdown: "2 sa 30 dk sonra",
    state: "future",
  });
});

test("formatResetSchedule accepts and presents an exact numeric +03:00 reset", () => {
  assert.deepEqual(
    formatResetSchedule(
      "2026-08-01T03:00:00+03:00",
      Date.parse("2026-07-31T23:00:00.000Z"),
      { timeZone: "UTC" },
    ),
    {
      exact: "1 Ağu 00:00",
      countdown: "1 sa sonra",
      state: "future",
    },
  );
});

test("formatResetSchedule distinguishes reset edges, past timestamps, and invalid values", () => {
  const now = Date.parse("2026-07-31T20:00:00.000Z");
  assert.deepEqual(formatResetSchedule("2026-07-31T20:02:00.000Z", now, { timeZone: "UTC" }), {
    exact: "31 Tem 20:02",
    countdown: "Sıfırlanıyor…",
    state: "resetting",
  });
  assert.deepEqual(formatResetSchedule("2026-07-31T19:58:00.000Z", now, { timeZone: "UTC" }), {
    exact: "31 Tem 19:58",
    countdown: "Sıfırlanıyor…",
    state: "resetting",
  });
  assert.deepEqual(formatResetSchedule("2026-07-31T20:02:00.001Z", now, { timeZone: "UTC" }), {
    exact: "31 Tem 20:02",
    countdown: "3 dk sonra",
    state: "future",
  });
  assert.deepEqual(formatResetSchedule("2026-07-31T19:57:59.999Z", now, { timeZone: "UTC" }), {
    exact: "31 Tem 19:57",
    countdown: null,
    state: "past",
  });
  assert.equal(formatResetSchedule(null, now, { timeZone: "UTC" }), null);
  assert.equal(formatResetSchedule("not-a-date", now, { timeZone: "UTC" }), null);
});

test("formatResetSchedule rejects invalid calendar and timezone-less timestamps", () => {
  const now = Date.parse("2024-02-28T00:00:00.000Z");
  for (const invalid of [
    "2026-02-31T20:00:00.000Z",
    "2025-02-29T00:00:00.000Z",
    "2026-01-01T00:00:00",
    "2026-01-01",
    "not-a-date",
  ]) {
    assert.equal(formatResetSchedule(invalid, now, { timeZone: "UTC" }), null, invalid);
  }
  assert.deepEqual(formatResetSchedule("2024-02-29T00:00:00.000Z", now, { timeZone: "UTC" }), {
    exact: "29 Şub 00:00",
    countdown: "1 gün sonra",
    state: "future",
  });
});
