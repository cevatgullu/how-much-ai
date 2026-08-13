import type { LimitEntry, ProfileData, UsageData } from "./types";

export interface NormalizedUsageBar {
  key: string;
  kind: string;
  label: string;
  usedPercent: number;
  remainingPercent: number;
  resetsAt: string | null;
  severity: string;
  isActive: boolean;
}

const KIND_LABELS: Record<string, string> = {
  session: "5 saatlik limit",
  weekly_all: "Haftalık limit",
  weekly_oauth_apps: "Bağlı uygulamalar haftalık limiti",
};

function normalizeUsed(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function resetAt(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function scopeText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function scopedLimit(scope: LimitEntry["scope"], group: unknown, fallback: string | null = null) {
  const model = scope?.model;
  const display = scopeText(model?.display_name);
  const stable = scopeText(model?.id) ?? display ?? scopeText(scope?.surface) ?? scopeText(group) ?? fallback ?? "diğer";
  const knownClaudeScope = display?.toLowerCase();
  const keyScope = knownClaudeScope === "opus" || knownClaudeScope === "sonnet" ? knownClaudeScope : stable.toLowerCase();
  return { key: `weekly_scoped:${encodeURIComponent(keyScope)}`, label: `${display ?? stable} haftalık limiti` };
}

function kindRank(kind: string): number {
  // Grok's two-hour window is the shortest horizon on any card, so it leads like `session` does.
  if (kind === "grok_mode") return 0;
  if (kind === "session") return 0;
  if (kind === "weekly_all") return 1;
  if (kind === "weekly_oauth_apps") return 2;
  if (kind === "weekly_scoped") return 3;
  return 4;
}

function canonicalRichLimit(limit: LimitEntry): { key: string; kind: string; label: string } | null {
  if (typeof limit.kind !== "string") return null;
  // Grok reports one rolling window per mode. The label already carries the mode name and the
  // raw counts (see grok-usage.ts), so it is used verbatim rather than fitted to a fixed phrase.
  if (limit.kind === "grok_mode") {
    const display = scopeText(limit.scope?.model?.display_name);
    const stable = scopeText(limit.scope?.model?.id) ?? scopeText(limit.group) ?? "mod";
    return {
      key: `grok_mode:${encodeURIComponent(stable.toLowerCase())}`,
      kind: "grok_mode",
      label: display ?? stable,
    };
  }
  if (limit.kind === "weekly_scoped") {
    const scoped = scopedLimit(limit.scope, limit.group);
    return { ...scoped, kind: "weekly_scoped" };
  }
  if (limit.kind in KIND_LABELS) return { key: limit.kind, kind: limit.kind, label: KIND_LABELS[limit.kind] };
  return null;
}

function flatScopedLimit(scope: string) {
  return scopedLimit(null, null, scope);
}

// Rich provider rows carry severity and active state. Flat buckets fill only canonical limits
// missing from those rows, so a provider cannot create duplicate notification identities.
export function extractBars(usage: UsageData): NormalizedUsageBar[] {
  const bars = new Map<string, NormalizedUsageBar>();
  const add = (
    identity: { key: string; kind: string; label: string } | null,
    usedValue: unknown,
    resetsValue: unknown,
    severity: unknown = "normal",
    isActive: unknown = false,
  ) => {
    const usedPercent = normalizeUsed(usedValue);
    if (!identity || usedPercent === null || bars.has(identity.key)) return;
    bars.set(identity.key, {
      ...identity,
      usedPercent,
      remainingPercent: 100 - usedPercent,
      resetsAt: resetAt(resetsValue),
      severity: typeof severity === "string" ? severity : "normal",
      isActive: isActive === true,
    });
  };

  for (const candidate of usage.limits ?? []) {
    if (!candidate || typeof candidate !== "object") continue;
    const limit = candidate as LimitEntry;
    add(canonicalRichLimit(limit), limit.percent, limit.resets_at, limit.severity, limit.is_active);
  }

  const addFlat = (identity: { key: string; kind: string; label: string }, bucket: unknown) => {
    if (!bucket || typeof bucket !== "object") return;
    const source = bucket as { utilization?: unknown; resets_at?: unknown };
    add(identity, source.utilization, source.resets_at);
  };
  addFlat({ key: "session", kind: "session", label: KIND_LABELS.session }, usage.five_hour);
  addFlat({ key: "weekly_all", kind: "weekly_all", label: KIND_LABELS.weekly_all }, usage.seven_day);
  addFlat(
    { key: "weekly_oauth_apps", kind: "weekly_oauth_apps", label: KIND_LABELS.weekly_oauth_apps },
    usage.seven_day_oauth_apps,
  );
  for (const [scope, bucket] of [
    ["Opus", usage.seven_day_opus],
    ["Sonnet", usage.seven_day_sonnet],
  ] as const) {
    const scoped = flatScopedLimit(scope);
    addFlat({ ...scoped, kind: "weekly_scoped" }, bucket);
  }

  return [...bars.values()].sort((a, b) => kindRank(a.kind) - kindRank(b.kind) || a.key.localeCompare(b.key));
}

export function parseResetTimestamp(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, timeZone] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const daysInMonth = month === 2 ? (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth || hour > 23 || minute > 59 || second > 59) return null;
  if (timeZone !== "Z" && (Number(timeZone.slice(1, 3)) > 23 || Number(timeZone.slice(4, 6)) > 59)) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

export function formatResetSchedule(
  resetsAt: string | null,
  now: number,
  options: { locale?: string; timeZone?: string } = {},
): { exact: string; countdown: string | null; state: "future" | "resetting" | "past" } | null {
  if (!resetsAt) return null;
  const resetMs = parseResetTimestamp(resetsAt);
  if (resetMs === null) return null;
  const exact = new Intl.DateTimeFormat(options.locale ?? "tr-TR", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    ...(options.timeZone ? { timeZone: options.timeZone } : {}),
  })
    .format(new Date(resetMs))
    .replace(",", "")
    .replace(/\s+/g, " ");
  const delta = resetMs - now;
  if (delta > 120_000) {
    const minutes = Math.ceil(delta / 60_000);
    const unitValues: Array<[number, string]> = [
      [Math.floor(minutes / 1440), "gün"],
      [Math.floor((minutes % 1440) / 60), "sa"],
      [minutes % 60, "dk"],
    ];
    const units = unitValues.filter(([value]) => value > 0).slice(0, 2);
    return { exact, countdown: `${units.map(([value, label]) => `${value} ${label}`).join(" ")} sonra`, state: "future" };
  }
  if (delta >= -120_000) return { exact, countdown: "Sıfırlanıyor…", state: "resetting" };
  return { exact, countdown: null, state: "past" };
}

export function planLabel(profile?: ProfileData | null): string {
  const tier = profile?.organization?.rate_limit_tier ?? "";
  const match = tier.match(/max_(\d+)x/);
  if (match) return `Max ${match[1]}×`;
  const orgType = profile?.organization?.organization_type ?? "";
  if (orgType.includes("max") || profile?.account?.has_claude_max) return "Max";
  if (orgType.includes("pro") || profile?.account?.has_claude_pro) return "Pro";
  if (orgType.includes("enterprise")) return "Enterprise";
  if (orgType.includes("team")) return "Team";
  return "Claude";
}

export function timeUntil(iso: string | null, now: number = Date.now()): string | null {
  if (!iso) return null;
  const target = Date.parse(iso);
  if (Number.isNaN(target)) return null;
  const diff = target - now;
  // A slightly-past stamp is just clock skew or a bucket Anthropic hasn't rolled yet.
  // Showing "resetting…" next to a still-full bar reads as a contradiction, so once
  // it's meaningfully past we simply drop the countdown until the next poll corrects it.
  if (diff <= 0) return diff > -120_000 ? "Sıfırlanıyor…" : null;
  const minutes = Math.floor(diff / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return `${days} gün ${hours} sa sonra`;
  if (hours > 0) return `${hours} sa ${mins} dk sonra`;
  return `${Math.max(1, mins)} dk sonra`;
}

export function severityColor(percent: number, severity: string): string {
  if (severity === "critical" || percent >= 90) return "var(--color-danger)";
  if (severity === "warning" || severity === "elevated" || percent >= 70) return "var(--color-amber)";
  // Normal/low fill follows the card's provider accent (see [data-provider] tokens); coral by default.
  return "var(--accent, var(--color-coral))";
}

export function formatClock(ts: number): string {
  return new Date(ts).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

// Compact "how long ago" for the stale banner (e.g. "just now", "3m ago", "2h ago").
export function timeAgo(ts: number, now: number = Date.now()): string {
  const diff = Math.max(0, now - ts);
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "az önce";
  if (mins < 60) return `${mins} dk önce`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} sa önce`;
  return `${Math.floor(hours / 24)} gün önce`;
}
