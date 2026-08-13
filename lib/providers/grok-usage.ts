// Grok (SuperGrok) usage normalisation.
//
// grok.com exposes one quota reading per *mode* — the same taxonomy the web UI shows
// (auto / fast / expert / heavy / build) — via POST /rest/rate-limits with
// {modelName, requestKind}. Verified live 2026-08-13 against a SuperGrok Plus account;
// see docs/provider-research-grok.md for the captured payloads.
//
// Two properties differ from Anthropic/OpenAI and drive the shape below:
//
//  1. The window is a *rolling* two hours (windowSizeSeconds: 7200), not a calendar bucket.
//     The response carries no reset timestamp and none can be derived: knowing the window is
//     two hours long says nothing about when the oldest query in it ages out. `resets_at` is
//     therefore null rather than a fabricated `now + 7200s`, which would read as precise and
//     be wrong. A null stamp also keeps the reset detector quiet for Grok by construction,
//     while remaining-percent threshold alerts still work.
//
//  2. Quotas are small and integral (Build is 10 queries per window), so a percentage alone
//     loses information — 1 query is 10%. The raw counts ride along in the label.

import type { LimitEntry, UsageData } from "../types";

export const GROK_WINDOW_LABEL = "2 saatlik pencere";

export interface GrokRateLimitPayload {
  windowSizeSeconds?: unknown;
  remainingQueries?: unknown;
  totalQueries?: unknown;
  lowEffortRateLimits?: unknown;
  highEffortRateLimits?: unknown;
}

export interface GrokModeReading {
  /** Mode id from /rest/modes, e.g. "build". Also the `modelName` sent to /rest/rate-limits. */
  id: string;
  /** Human title from /rest/modes, e.g. "Build". */
  title: string;
  /** Mode description, e.g. "Build apps and sites · Grok 4.6". Carries the real model name. */
  description?: string | null;
  payload: GrokRateLimitPayload;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Percentage of the window consumed, rounded to a whole number and clamped to 0–100.
 * A zero (or absent) total means the tier grants no quota for this mode at all — Build reads
 * 0/0 on plain SuperGrok. That is "unavailable", not "0% used", so it yields null and the
 * caller drops the bar rather than drawing an empty gauge that looks fully available.
 */
export function grokUsedPercent(payload: GrokRateLimitPayload): number | null {
  const total = finiteNumber(payload.totalQueries);
  const remaining = finiteNumber(payload.remainingQueries);
  if (total === null || remaining === null || total <= 0) return null;
  const used = (1 - Math.max(0, Math.min(remaining, total)) / total) * 100;
  return Math.max(0, Math.min(100, Math.round(used)));
}

function severityFor(usedPercent: number): LimitEntry["severity"] {
  if (usedPercent >= 90) return "critical";
  if (usedPercent >= 70) return "warning";
  if (usedPercent >= 50) return "elevated";
  return "normal";
}

/**
 * Label for one mode's bar. Keeps the mode's own words and appends the remaining count, because
 * "3 / 10" is materially more actionable than "%70" on a ten-query window.
 */
export function grokModeLabel(reading: GrokModeReading): string {
  const remaining = finiteNumber(reading.payload.remainingQueries);
  const total = finiteNumber(reading.payload.totalQueries);
  const counts = remaining !== null && total !== null ? ` · ${remaining}/${total}` : "";
  return `${reading.title}${counts}`;
}

/**
 * Build a UsageData from the per-mode readings. Modes the tier does not grant are omitted
 * entirely so the card shows only quota the account actually has.
 */
export function normalizeGrokUsage(readings: readonly GrokModeReading[]): UsageData {
  const limits: LimitEntry[] = [];
  for (const reading of readings) {
    const percent = grokUsedPercent(reading.payload);
    if (percent === null) continue;
    limits.push({
      kind: "grok_mode",
      group: reading.id,
      percent,
      severity: severityFor(percent),
      // Rolling window: deliberately no timestamp. See the header note.
      resets_at: null,
      scope: {
        model: { id: reading.id, display_name: grokModeLabel(reading) },
        surface: GROK_WINDOW_LABEL,
      },
      is_active: true,
    });
  }
  return { limits };
}
