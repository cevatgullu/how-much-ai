// Seven days of weekly-limit readings, kept on the device.
//
// The card answers "how much is left right now". This answers "is that number climbing", which is
// the question that actually changes behaviour a few days before a reset. Nothing upstream keeps a
// history — Anthropic, OpenAI and xAI all serve a single instantaneous percentage — so the trend
// only exists if the app writes down what it saw.
//
// It stays in localStorage rather than the vault on purpose. It is a derived, non-secret
// observation, it is worthless on another device (a phone and a laptop watch the same accounts and
// would both be writing the same numbers), and pushing it server-side would mean a schema, a
// migration, and a sync conflict for a chart. Losing it costs seven days of dots.
//
// One point per account per local day, last write wins. Taking the maximum instead would look
// tidier but would be a lie the day a limit rolls over: the window genuinely drops back to near
// zero, and a curve that refuses to come down stops describing the account.

const HISTORY_KEY = "usage.weekly-history.v1";
// Eight accounts × eight days of `{"day":"2026-08-16","percent":100}` fits inside this with room to
// spare; anything larger is a corrupt or hostile value rather than a history.
const MAX_HISTORY_BYTES = 32 * 1024;

/** Days drawn on the chart. */
export const WEEKLY_TREND_DAYS = 7;
/** Days kept on disk. One more than the chart shows, so a day is dropped only once it is fully out. */
export const WEEKLY_HISTORY_RETENTION_DAYS = 8;

export interface WeeklyHistoryPoint {
  /** Local calendar day, `YYYY-MM-DD`. Local because "bugün" is the user's day, not UTC's. */
  day: string;
  /** Highest weekly limit used on that day, 0–100. */
  percent: number;
}

export type WeeklyHistory = Record<string, WeeklyHistoryPoint[]>;

export interface WeeklyHistorySample {
  accountId: string;
  percent: number;
}

export interface WeeklyTrendSeries {
  accountId: string;
  /** One slot per chart day, oldest first. `null` marks a day with no reading. */
  points: (number | null)[];
  /** Most recent known value, or null when the account has no reading yet. */
  latest: number | null;
}

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

export function historyDayKey(timestamp: number): string {
  const date = new Date(timestamp);
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * The calendar days a window covers, oldest first.
 *
 * Stepping by day index rather than by subtracting 86_400_000 keeps it correct across a daylight
 * saving change, where one local day is 23 or 25 hours long and fixed-millisecond arithmetic
 * silently repeats or skips a date.
 */
export function historyDayWindow(now: number, days: number): string[] {
  const today = new Date(now);
  const window: string[] = [];
  for (let back = days - 1; back >= 0; back -= 1) {
    const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() - back);
    window.push(historyDayKey(date.getTime()));
  }
  return window;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

/** Record today's reading for each sampled account, replacing any earlier reading from today. */
export function recordWeeklyHistory(
  history: WeeklyHistory,
  samples: readonly WeeklyHistorySample[],
  now: number,
): WeeklyHistory {
  if (samples.length === 0) return history;
  const today = historyDayKey(now);
  const next: WeeklyHistory = { ...history };
  for (const sample of samples) {
    if (!sample.accountId || !Number.isFinite(sample.percent)) continue;
    const point: WeeklyHistoryPoint = { day: today, percent: clampPercent(sample.percent) };
    const existing = next[sample.accountId] ?? [];
    next[sample.accountId] = [...existing.filter((entry) => entry.day !== today), point]
      .sort((a, b) => a.day.localeCompare(b.day));
  }
  return next;
}

/**
 * Drop points outside the retention window, and accounts left with nothing.
 *
 * The retained days are enumerated rather than compared as timestamps: a day key either is one of
 * the last eight local dates or it is not, which needs no timezone reasoning to be right.
 */
export function pruneWeeklyHistory(
  history: WeeklyHistory,
  now: number,
  accountIds?: readonly string[],
): WeeklyHistory {
  const keep = new Set(historyDayWindow(now, WEEKLY_HISTORY_RETENTION_DAYS));
  const live = accountIds ? new Set(accountIds) : null;
  const next: WeeklyHistory = {};
  for (const [accountId, points] of Object.entries(history)) {
    // A removed account's dots would draw a line for a card that is no longer on screen.
    if (live && !live.has(accountId)) continue;
    const kept = points.filter((point) => keep.has(point.day));
    if (kept.length > 0) next[accountId] = kept;
  }
  return next;
}

function readPoints(value: unknown): WeeklyHistoryPoint[] {
  if (!Array.isArray(value)) return [];
  const points: WeeklyHistoryPoint[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const candidate = entry as { day?: unknown; percent?: unknown };
    if (typeof candidate.day !== "string" || !DAY_PATTERN.test(candidate.day)) continue;
    if (typeof candidate.percent !== "number" || !Number.isFinite(candidate.percent)) continue;
    if (seen.has(candidate.day)) continue;
    seen.add(candidate.day);
    points.push({ day: candidate.day, percent: clampPercent(candidate.percent) });
  }
  return points.sort((a, b) => a.day.localeCompare(b.day));
}

export function parseWeeklyHistory(raw: string | null): WeeklyHistory {
  if (!raw || new TextEncoder().encode(raw).byteLength > MAX_HISTORY_BYTES) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const history: WeeklyHistory = {};
  for (const [accountId, value] of Object.entries(parsed as Record<string, unknown>)) {
    const points = readPoints(value);
    if (points.length > 0) history[accountId] = points;
  }
  return history;
}

export function loadWeeklyHistory(): WeeklyHistory {
  if (typeof window === "undefined") return {};
  try {
    return parseWeeklyHistory(window.localStorage.getItem(HISTORY_KEY));
  } catch {
    return {};
  }
}

export function saveWeeklyHistory(history: WeeklyHistory): boolean {
  if (typeof window === "undefined") return true;
  try {
    const serialised = JSON.stringify(history);
    if (new TextEncoder().encode(serialised).byteLength > MAX_HISTORY_BYTES) return false;
    window.localStorage.setItem(HISTORY_KEY, serialised);
    return true;
  } catch {
    return false;
  }
}

/** Project the stored history onto the chart's day slots, in the account order given. */
export function weeklyTrendSeries(
  history: WeeklyHistory,
  accountIds: readonly string[],
  now: number,
): WeeklyTrendSeries[] {
  const days = historyDayWindow(now, WEEKLY_TREND_DAYS);
  return accountIds.map((accountId) => {
    const byDay = new Map((history[accountId] ?? []).map((point) => [point.day, point.percent]));
    const points = days.map((day) => byDay.get(day) ?? null);
    let latest: number | null = null;
    for (const point of points) if (point !== null) latest = point;
    return { accountId, points, latest };
  });
}

/** How many of the chart's days carry at least one reading. One means "started collecting today". */
export function weeklyTrendFilledDays(series: readonly WeeklyTrendSeries[]): number {
  let filled = 0;
  for (let slot = 0; slot < WEEKLY_TREND_DAYS; slot += 1) {
    if (series.some((entry) => entry.points[slot] !== null)) filled += 1;
  }
  return filled;
}

/** Accounts whose fresh reading should be written down. Stale or errored cards contribute nothing. */
export function weeklyHistorySamples(
  metrics: readonly { accountId: string; highestWeeklyUsedPercent: number | null; hasFreshReading: boolean }[],
): WeeklyHistorySample[] {
  const samples: WeeklyHistorySample[] = [];
  for (const metric of metrics) {
    // A stale card is repeating an old number; writing it under today's date would invent a
    // reading for a day the account was never actually measured on.
    if (!metric.hasFreshReading || metric.highestWeeklyUsedPercent === null) continue;
    samples.push({ accountId: metric.accountId, percent: metric.highestWeeklyUsedPercent });
  }
  return samples;
}
