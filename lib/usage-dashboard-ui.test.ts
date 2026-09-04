import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { transformSync } from "next/dist/build/swc/index.js";
import type { AccountSnapshot, BrowserAccount } from "./types.ts";
import type { NormalizedUsageBar } from "./format.ts";
import type { WeeklyAccountMetric } from "./quota-metrics.ts";

process.env.TZ = "UTC";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));

function sourceModule(target: string): string {
  for (const candidate of [target, `${target}.ts`, `${target}.tsx`]) {
    try {
      readFileSync(candidate);
      return pathToFileURL(candidate).href;
    } catch {}
  }
  return pathToFileURL(target).href;
}

const moduleHooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) {
      return {
        url: sourceModule(path.join(projectRoot, specifier.slice(2))),
        shortCircuit: true,
      };
    }
    if (
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      context.parentURL?.startsWith(pathToFileURL(projectRoot).href) &&
      !context.parentURL.includes("/node_modules/") &&
      path.extname(new URL(specifier, context.parentURL).pathname) === ""
    ) {
      return {
        url: sourceModule(fileURLToPath(new URL(specifier, context.parentURL))),
        shortCircuit: true,
      };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith(".tsx")) {
      const source = readFileSync(fileURLToPath(url), "utf8");
      const transformed = transformSync(source, {
        filename: fileURLToPath(url),
        jsc: {
          parser: { syntax: "typescript", tsx: true },
          transform: { react: { runtime: "automatic" } },
        },
        module: { type: "es6" },
      });
      return { format: "module", source: transformed.code, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const { UsageBar } = await import("../components/UsageBar.tsx");
const { AccountCard, deriveFiveHourPeak } = await import("../components/AccountCard.tsx");
const { AnthropicIcon, GrokIcon } = await import("../components/Icons.tsx");
const {
  dashboardOrderReducer,
  initialDashboardOrderState,
  resolvedDashboardOrder,
} = await import("./dashboard-order-state.ts");
const {
  DashboardAccountList,
  accountProviderOrdinals,
  commitDashboardSnapshot,
  dashboardVaultRecoveryNotice,
  dashboardOrderViewReducer,
  dashboardAccountRows,
  dashboardMetricForNow,
  initialDashboardOrderViewState,
  saveDashboardSortMode,
  scheduleDashboardAccountScroll,
  scheduleDashboardOrderScroll,
  strictLocalDashboardMessage,
} = await import("../components/Dashboard.tsx");

after(() => moduleHooks.deregister());

const NOW = Date.parse("2026-07-31T20:00:00.000Z");
const RESET_AT = "2026-07-31T22:30:00.000Z";

function usageBar(remainingPercent: number, overrides: Partial<NormalizedUsageBar> = {}): NormalizedUsageBar {
  return {
    key: "session",
    kind: "session",
    label: "5 saatlik limit",
    usedPercent: 100 - remainingPercent,
    remainingPercent,
    resetsAt: RESET_AT,
    severity: "normal",
    isActive: true,
    ...overrides,
  };
}

function account(id: string, provider: BrowserAccount["provider"] = "anthropic"): BrowserAccount {
  return {
    id,
    email: `${id}@private.invalid`,
    fullName: `Private ${id}`,
    plan: provider === "anthropic" ? "Max" : "ChatGPT Pro",
    addedAt: 1,
    credentialKind: "managed",
    provider,
    credentialExpiresAt: NOW + 86_400_000,
  };
}

const accountCardHandlers = {
  onRefresh() {},
  onRemove() {},
  onRename() {},
  onMobileExpandedChange() {},
  onInteractionFenceChange() {},
};

function metric(
  accountId: string,
  overrides: Partial<WeeklyAccountMetric> = {},
): WeeklyAccountMetric {
  return {
    accountId,
    sourceIndex: 0,
    highestWeeklyUsedPercent: 73,
    highestWeeklyLimitKey: "weekly_all",
    highestWeeklyLimitLabel: "Haftalık limit",
    nearestWeeklyResetAt: RESET_AT,
    nearestWeeklyResetKey: "weekly_all",
    nearestWeeklyResetLabel: "Haftalık limit",
    hasFreshReading: true,
    ...overrides,
  };
}

function renderAccountCard(
  accountValue: BrowserAccount,
  snapshot: AccountSnapshot | undefined,
  providerOrdinal = 1,
  overrides: Record<string, unknown> = {},
): string {
  return renderToStaticMarkup(createElement(AccountCard, {
    account: accountValue,
    snapshot,
    metric: metric(accountValue.id),
    fiveHourPeak: 84,
    now: NOW,
    providerOrdinal,
    strictLocal: true,
    mobileExpanded: false,
    ...accountCardHandlers,
    ...overrides,
  }));
}

test("the card avatar carries the provider mark, not an initial", () => {
  // The avatar answers "which service is this account on"; the name sits beside it already.
  // An initial made every provider look alike, and with three providers that ambiguity grows.
  for (const provider of ["anthropic", "openai", "grok"] as const) {
    const markup = renderAccountCard(account(`avatar-${provider}`, provider), undefined);
    // The palette is scoped by this attribute, so the mark and its colours travel together.
    assert.match(markup, new RegExp(`data-provider="${provider}"`));
    const avatar = markup.match(/rounded-sm border"[^>]*>([\s\S]*?)<\/div>/u);
    assert.ok(avatar, `${provider}: avatar bulunamadi`);
    assert.match(avatar[1], /<svg/u, `${provider}: avatarda logo yok`);
    // Guard the regression directly: a bare letter must not come back.
    assert.doesNotMatch(avatar[1], /^\s*[A-Z?]\s*$/u, `${provider}: avatarda hala harf var`);
  }
});

test("each provider gets its own accent scope so two cards never read alike", () => {
  // Grok inherited the Claude coral until it was given a palette, which made a Grok card
  // indistinguishable from a Claude one at a glance.
  const css = readFileSync(path.join(projectRoot, "app", "globals.css"), "utf8");
  const accents = new Map<string, string>();
  for (const provider of ["anthropic", "openai", "grok"]) {
    const block = css.match(
      new RegExp("\\[data-provider=\"" + provider + "\"\\]\\s*\\{([^}]*)\\}", "u"),
    );
    assert.ok(block, `${provider}: palet blogu yok`);
    const accent = block[1].match(/--accent:\s*([^;]+);/u);
    assert.ok(accent, `${provider}: --accent tanimsiz`);
    accents.set(provider, accent[1].trim());
  }
  assert.equal(new Set(accents.values()).size, accents.size, `paletler cakisiyor: ${[...accents]}`);
});

test("the existing Dashboard prop shape keeps one reachable card presentation before controlled integration", () => {
  const accountValue = account("legacy-dashboard", "openai");
  const markup = renderToStaticMarkup(createElement(AccountCard, {
    account: accountValue,
    snapshot: {
      status: "ready",
      usage: {
        five_hour: { utilization: 37, resets_at: RESET_AT },
        seven_day: { utilization: 68, resets_at: RESET_AT },
      },
    },
    now: NOW,
    index: 0,
    providerOrdinal: 1,
    onRefresh() {},
    onRemove() {},
    onRename() {},
  }));

  assert.doesNotMatch(markup, /data-ledger-expand=/, "an uncontrolled card must not replace reachable content with a no-op expander");
  assert.doesNotMatch(markup, /class="hidden min-w-0 flex-col gap-3 min-\[960px\]:flex/);
  assert.doesNotMatch(markup, /class="mt-5 hidden min-w-0 flex-1/);
  assert.match(markup, />ChatGPT 1</);
  assert.match(markup, /aria-label="legacy-dashboard@private.invalid hesabını adlandır"/);
  assert.match(markup, /aria-label="legacy-dashboard@private.invalid hesabını yenile"/);
  assert.match(markup, /aria-label="legacy-dashboard@private.invalid hesabını kaldır"/);
  assert.equal((markup.match(/role="progressbar"/g) ?? []).length, 2);
  assert.match(markup, /aria-valuenow="37"/);
  assert.match(markup, /aria-valuenow="68"/);
});

test("five-hour peak uses only the highest real session row without mutating bars", () => {
  const bars = [
    usageBar(71, { key: "weekly_all", kind: "weekly_all" }),
    usageBar(58, { key: "session-a" }),
    usageBar(24, { key: "session-b" }),
  ];
  const before = structuredClone(bars);

  assert.equal(typeof deriveFiveHourPeak, "function");
  if (typeof deriveFiveHourPeak !== "function") return;
  assert.equal(deriveFiveHourPeak(bars), 76);
  assert.equal(deriveFiveHourPeak([usageBar(0, { kind: "weekly_all" })]), null);
  assert.equal(deriveFiveHourPeak([]), null);
  assert.deepEqual(bars, before);
});

test("controlled mobile ledgers expose summaries, stable panels, and actions outside expand buttons", () => {
  const claude = { ...account("claude-ledger"), label: "Araştırma" };
  const chatgpt = account("chatgpt-ledger", "openai");
  const snapshots: Record<string, AccountSnapshot> = {
    [claude.id]: {
      status: "ready",
      usage: {
        five_hour: { utilization: 42, resets_at: RESET_AT },
        seven_day: { utilization: 73, resets_at: RESET_AT },
        seven_day_opus: { utilization: 91, resets_at: "2026-08-02T09:00:00.000Z" },
      },
    },
    [chatgpt.id]: { status: "idle" },
  };
  const props = new Map([
    [claude.id, {
      metric: metric(claude.id, { highestWeeklyUsedPercent: 91, highestWeeklyLimitKey: "weekly_scoped:opus", highestWeeklyLimitLabel: "Opus haftalık limiti" }),
      fiveHourPeak: 42,
      providerOrdinal: 2,
    }],
    [chatgpt.id, {
      metric: metric(chatgpt.id, {
        highestWeeklyUsedPercent: null,
        highestWeeklyLimitKey: null,
        highestWeeklyLimitLabel: null,
        nearestWeeklyResetAt: null,
        nearestWeeklyResetKey: null,
        nearestWeeklyResetLabel: null,
        hasFreshReading: false,
      }),
      fiveHourPeak: null,
      providerOrdinal: 1,
    }],
  ]);
  const renderRows = (rows: BrowserAccount[]) => renderToStaticMarkup(createElement(
    "ol",
    null,
    rows.map((accountValue) => createElement("li", { key: accountValue.id }, createElement(AccountCard, {
      account: accountValue,
      snapshot: snapshots[accountValue.id],
      now: NOW,
      mobileExpanded: true,
      ...props.get(accountValue.id),
      ...accountCardHandlers,
    }))),
  ));

  for (const markup of [renderRows([claude, chatgpt]), renderRows([chatgpt, claude])]) {
    assert.match(markup, />Claude 2</);
    assert.match(markup, />ChatGPT 1</);
    assert.ok(markup.indexOf(claude.label!) < markup.indexOf(claude.email), "nickname must precede the secondary email");
    assert.match(markup, />claude-ledger@private\.invalid</);
    // Dar ekran artık masaüstüyle aynı bilgiyi gösterir: özet veren "ledger" görünümü
    // kaldırıldı, her limit kendi cetvel çubuğuyla listelenir.
    assert.doesNotMatch(markup, /data-ledger-account=/, "ledger görünümü kaldırıldı");
    assert.doesNotMatch(markup, /data-ledger-expand=/, "ledger genişletme düğmesi kalmadı");
    assert.doesNotMatch(markup, /data-ledger-panel=/, "ledger paneli kalmadı");
    assert.match(markup, /class="[^"]*usage-ruler/, "her limit cetvel çubuğuyla gösterilir");
    assert.match(markup, /usage-ruler-major/, "cetvel çubuğunda ölçek bölmeleri bulunur");
    assert.match(markup, /aria-label="Araştırma hesabını yenile"/);
    assert.match(markup, /aria-label="Araştırma hesabını adlandır"/);
    assert.match(markup, /aria-label="Araştırma hesabını kaldır"/);
  }

  const closed = renderAccountCard(claude, snapshots[claude.id], 2, { mobileExpanded: false });
  // Ledger kaldırıldı: dar ekranda da kartın tamamı ve tüm limit satırları görünür.
  assert.doesNotMatch(closed, /data-ledger-/);
  assert.match(closed, /usage-ruler/);
});

test("mobile ledger names every local snapshot state while desktop and expanded views retain all rows", () => {
  const usage = {
    five_hour: { utilization: 35, resets_at: RESET_AT },
    seven_day: { utilization: 64, resets_at: RESET_AT },
    seven_day_opus: { utilization: 88, resets_at: "2026-08-02T09:00:00.000Z" },
  };
  const cases: Array<[string, AccountSnapshot | undefined, string]> = [
    ["idle", undefined, "İlk veri bekleniyor"],
    ["loading", { status: "loading", usage }, "Yenileniyor"],
    ["ready", { status: "ready", usage }, "Güncel"],
    ["stale", { status: "ready", usage, stale: true, fetchedAt: NOW - 180_000 }, "Güncel değil"],
    ["error", { status: "error", usage, error: "private detail", fetchedAt: NOW - 180_000 }, "Yenileme başarısız"],
    ["reauth", { status: "reauth", usage }, "Yeniden bağlanma gerekli"],
  ];

  for (const [expectedState, snapshot, expectedLabel] of cases) {
    const accountValue = account(`state-${expectedState}`);
    const markup = renderAccountCard(accountValue, snapshot, 1, { mobileExpanded: true });
    assert.doesNotMatch(markup, /data-ledger-state=/);
    void expectedLabel;
    if (snapshot?.usage && snapshot.status !== "reauth") {
      assert.equal((markup.match(/role="progressbar"/g) ?? []).length, 3, `${expectedState}: tek görünümde üç limit satırı da bulunmalı`);
      for (const used of [35, 64, 88]) {
        assert.equal((markup.match(new RegExp(`aria-valuenow="${used}"`, "g")) ?? []).length, 1);
      }
    }
    if (["loading", "stale", "error"].includes(expectedState)) {
      assert.equal((markup.match(/aria-live="polite"/g) ?? []).length, 1);
    }
  }
});

test("used allowance is the visible and accessible progress value without a false-zero first frame", () => {
  const markup = renderToStaticMarkup(createElement(UsageBar, {
    bar: usageBar(16),
    now: NOW,
    stale: true,
    freshnessDescriptionId: "freshness-1",
  }));

  assert.match(markup, />5 saatlik limit</);
  assert.match(markup, />%16 kaldı</);
  assert.match(markup, />%84</);
  const progress = markup.match(/<div role="progressbar"[^>]*>/)?.[0] ?? "";
  assert.match(progress, /aria-valuenow="84"/);
  assert.match(progress, /aria-describedby="freshness-1"/);
  assert.match(progress, /aria-valuetext="Kullanılan: %84[^"]*%16 kaldı[^"]*2 sa 30 dk sonra[^"]*31 Tem 22:30[^"]*Eski veri/);
  assert.match(markup, /<time dateTime="2026-07-31T22:30:00.000Z"[^>]*>[^<]*2 sa 30 dk sonra[^<]*31 Tem 22:30[^<]*<\/time>/);
  assert.match(markup, /style="width:84%;/);
  assert.doesNotMatch(markup, /style="width:0%;/);
});

test("remaining boundaries drive state colors while used allowance drives fill width", () => {
  // Severity runs low -> high as amber -> coral -> red. The 80 and 60 rows cover the
  // barely-used band, which had no case before and was the one rendering hotter than
  // the band above it.
  for (const [remaining, expectedText, expectedColor] of [
    [80, null, "var(--color-amber)"],
    [60, null, "var(--color-amber)"],
    [50, "Az kaldı", "var(--color-coral)"],
    [30, "Az kaldı", "var(--color-coral)"],
    [15, "Kritik", "var(--color-danger)"],
    [0, "Limit bitti", "var(--color-danger)"],
  ] as const) {
    const markup = renderToStaticMarkup(createElement(UsageBar, {
      bar: usageBar(remaining, { resetsAt: null }),
      now: NOW,
      stale: false,
    }));
    if (expectedText === null) {
      assert.doesNotMatch(markup, />Az kaldı<|>Kritik<|>Limit bitti</u, `${remaining}% remaining must carry no state badge`);
    } else {
      assert.match(markup, new RegExp(`>${expectedText}<`), `${remaining}% remaining must say ${expectedText}`);
    }
    assert.match(
      markup,
      new RegExp(`style="width:${100 - remaining}%;background-color:${expectedColor.replace(/[()]/g, "\\$&")}"`),
      `${remaining}% remaining must color a ${100 - remaining}% used fill with ${expectedColor}`,
    );
  }
});

test("provider severity cannot override the remaining-allowance visual state", () => {
  const markup = renderToStaticMarkup(createElement(UsageBar, {
    bar: usageBar(80, { resetsAt: null, severity: "critical" }),
    now: NOW,
    stale: false,
  }));
  assert.doesNotMatch(markup, />Az kaldı<|>Kritik<|>Limit bitti</);
  // The fill is a fixed severity colour, never the per-provider accent: tinting it by provider
  // made the same fill level a different hue on each card.
  assert.match(markup, /style="width:20%;background-color:var\(--color-amber\)"/);
  assert.doesNotMatch(markup, /background-color:var\(--accent/u);
});

test("OpenAI session rows identify Codex without synthesizing an absent five-hour window", () => {
  const sessionUsage = { five_hour: { utilization: 84, resets_at: RESET_AT } };
  const openaiMarkup = renderAccountCard(account("openai-session", "openai"), {
    status: "ready",
    usage: sessionUsage,
  });
  assert.match(openaiMarkup, />Codex · 5 saatlik limit</);

  const claudeMarkup = renderAccountCard(account("claude-session"), {
    status: "ready",
    usage: sessionUsage,
  });
  assert.match(claudeMarkup, />5 saatlik limit</);
  assert.doesNotMatch(claudeMarkup, /Codex · 5 saatlik limit/);

  const weeklyOnlyMarkup = renderAccountCard(account("openai-weekly", "openai"), {
    status: "ready",
    usage: { seven_day: { utilization: 17, resets_at: RESET_AT } },
  });
  assert.match(weeklyOnlyMarkup, />Haftalık limit</);
  assert.doesNotMatch(weeklyOnlyMarkup, /Codex · 5 saatlik limit/);
  assert.doesNotMatch(weeklyOnlyMarkup, />5 saatlik limit</);
});

test("ready-stale, loading, and error cards keep old bars with one live freshness status", () => {
  const usage = { five_hour: { utilization: 85, resets_at: RESET_AT } };
  const cases: Array<[string, AccountSnapshot, string]> = [
    ["ready-stale", { status: "ready", usage, stale: true, fetchedAt: NOW - 180_000 }, "Güncel değil — son veri 3 dk önce."],
    ["loading-stale", { status: "loading", usage, stale: true, fetchedAt: NOW - 180_000 }, "Yenileniyor — son veriler gösteriliyor. Son veri 3 dk önce."],
    ["error-stale", { status: "error", usage, stale: true, error: "private upstream detail", fetchedAt: NOW - 180_000 }, "Yenileme başarısız — son veriler gösteriliyor. Son veri 3 dk önce."],
  ];

  for (const [name, snapshot, freshnessText] of cases) {
    const markup = renderAccountCard(account(name), snapshot);
    assert.match(markup, /data-stale="true"/, `${name} must mark only the stale boolean`);
    assert.match(markup, />5 saatlik limit</, `${name} must retain its old bar`);
    assert.match(markup, new RegExp(`>${freshnessText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}<`));
    assert.doesNotMatch(markup, /\bago\b/);
    assert.equal((markup.match(/aria-live="polite"/g) ?? []).length, 1, `${name} must have one live region`);
    const freshnessId = markup.match(/id="([^"]+)"[^>]*role="status"[^>]*aria-live="polite"/)?.[1];
    assert.ok(freshnessId, `${name} must identify its freshness status`);
    assert.match(markup, new RegExp(`role="progressbar"[^>]*aria-describedby="${freshnessId}"`));
    assert.doesNotMatch(markup, /aria-live="polite"[^>]*role="progressbar"|role="progressbar"[^>]*aria-live="polite"/);
  }
});

test("stale freshness ages stay compact and entirely Turkish", () => {
  const usage = { five_hour: { utilization: 85, resets_at: RESET_AT } };
  for (const [elapsed, expected] of [
    [30_000, "az önce"],
    [180_000, "3 dk önce"],
    [7_200_000, "2 sa önce"],
    [172_800_000, "2 gün önce"],
  ] as const) {
    const markup = renderAccountCard(account(`age-${elapsed}`), {
      status: "ready",
      usage,
      stale: true,
      fetchedAt: NOW - elapsed,
    });
    assert.match(markup, new RegExp(`Güncel değil — son veri ${expected}\\.`));
    assert.doesNotMatch(markup, /\b(?:ago|just now)\b/);
  }
});

test("four Claude cards have ordered provider ordinals and unique semantic heading IDs", () => {
  const accounts = [1, 2, 3, 4].map((ordinal) => account(`claude-${ordinal}`));
  const markup = renderToStaticMarkup(createElement(
    "ol",
    null,
    accounts.map((accountValue, index) => createElement(
      "li",
      { key: accountValue.id },
      createElement(AccountCard, {
        account: accountValue,
        snapshot: { status: "idle" },
        now: NOW,
        index,
        providerOrdinal: index + 1,
        ...accountCardHandlers,
      }),
    )),
  ));

  assert.match(markup, /^<ol><li><article/);
  const headings = [...markup.matchAll(/<h2 id="([^"]+)" class="([^"]*)">(Claude \d+)<\/h2>/g)];
  assert.deepEqual(headings.map((match) => match[3]), ["Claude 1", "Claude 2", "Claude 3", "Claude 4"]);
  assert.equal(new Set(headings.map((match) => match[1])).size, 4);
  assert.ok(headings.every((match) => !match[2].split(/\s+/).includes("sr-only")), "provider headings must be visible");
  assert.match(markup, /<h2[^>]*>Claude 1<\/h2>[\s\S]*>claude-1@private.invalid</);
});

test("mixed providers compute independent ordinals without changing account order", () => {
  const accounts = [
    account("claude-1"),
    account("openai-1", "openai"),
    account("claude-2"),
    account("openai-2", "openai"),
  ];
  assert.equal(typeof accountProviderOrdinals, "function");
  if (typeof accountProviderOrdinals !== "function") return;
  const ordinals = accountProviderOrdinals(accounts);
  assert.deepEqual(accounts.map((accountValue) => ordinals.get(accountValue.id)), [1, 1, 2, 2]);

  const markup = accounts.map((accountValue) => renderAccountCard(
    accountValue,
    { status: "idle" },
    ordinals.get(accountValue.id),
  )).join("");
  assert.deepEqual(
    [...markup.matchAll(/<h2 id="[^"]+" class="[^"]*">((?:Claude|ChatGPT) \d+)<\/h2>/g)].map((match) => match[1]),
    ["Claude 1", "ChatGPT 1", "Claude 2", "ChatGPT 2"],
  );
});

test("OpenAI account guidance names ChatGPT while preserving login-kind badges", () => {
  const managedMarkup = renderAccountCard(account("managed-openai", "openai"), {
    status: "reauth",
  });
  assert.match(managedMarkup, /chatgpt ile yeniden oturum açın/i);
  assert.doesNotMatch(managedMarkup, /claude/i);
  assert.match(managedMarkup, /özel uygulama oturumu · otomatik yenilenir/i);

  const sharedMarkup = renderAccountCard(
    { ...account("shared-openai", "openai"), credentialKind: "rotating" },
    { status: "ready" },
  );
  assert.match(sharedMarkup, /paylaşılan cli oturumu/i);
  assert.match(sharedMarkup, /codex cli/i);
  assert.doesNotMatch(sharedMarkup, /claude code oturumunu paylaşır/i);
});

test("credential badges expose Turkish tooltips for every local credential kind", () => {
  const cases: Array<[BrowserAccount["credentialKind"], RegExp]> = [
    ["managed", /özel uygulama oturumu; codex cli oturumunu paylaşmadan otomatik yenilenir/i],
    ["long_lived", /eski kurulum belirteci; tahmini yenileme tarihi/i],
    ["rotating", /codex cli ile paylaşılır; özel uygulama oturumu daha güvenilirdir/i],
  ];
  for (const [credentialKind, expectedTitle] of cases) {
    const markup = renderAccountCard(
      { ...account(`tooltip-${credentialKind}`, "openai"), credentialKind },
      { status: "idle" },
    );
    assert.match(markup, expectedTitle);
    assert.doesNotMatch(markup, /Private app-owned|Legacy inference-only|Shared with Codex CLI/i);
  }
  assert.match(
    renderAccountCard(
      { ...account("hosted-tooltip", "openai"), credentialKind: "managed" },
      { status: "idle" },
      1,
      { strictLocal: false },
    ),
    /Özel uygulama oturumu; Codex CLI oturumunu paylaşmadan otomatik yenilenir/i,
  );
});

test("settled dashboard rows reorder presentation only while preserving source ordinals, keys, and expanded ids", () => {
  const accounts = [
    account("claude-first"),
    account("chatgpt", "openai"),
    account("claude-second"),
  ];
  const metrics = [
    metric("claude-first", { sourceIndex: 0, highestWeeklyUsedPercent: 20 }),
    metric("chatgpt", { sourceIndex: 1, highestWeeklyUsedPercent: 90 }),
    metric("claude-second", { sourceIndex: 2, highestWeeklyUsedPercent: 60 }),
  ];
  const snapshots = Object.fromEntries(accounts.map((value) => [value.id, {
    status: "ready" as const,
    usage: { seven_day: { utilization: metrics.find((entry) => entry.accountId === value.id)!.highestWeeklyUsedPercent } },
  }]));
  const ordinals = accountProviderOrdinals(accounts);
  const expandedIds = new Set(["claude-first"]);
  let state = initialDashboardOrderState(accounts.map((value) => value.id), "weekly-usage");

  const renderList = () => renderToStaticMarkup(createElement(DashboardAccountList, {
    accounts,
    visibleAccountIds: state.visibleAccountIds,
    snapshots,
    metrics,
    providerOrdinals: ordinals,
    expandedAccountIds: expandedIds,
    now: NOW,
    onMobileExpandedChange() {},
    onInteractionFenceChange() {},
    onRefresh() {},
    onRemove() {},
    onRename() {},
  }));
  const renderedIds = (markup: string) => [...markup.matchAll(/<li[^>]*data-dashboard-account="([^"]+)"/g)].map((match) => match[1]);

  assert.deepEqual(renderedIds(renderList()), ["claude-first", "claude-second", "chatgpt"], "aileler gruplanır, grup içinde kayıt sırası korunur");
  state = dashboardOrderReducer(state, { type: "batch_started", accountIds: accounts.map((value) => value.id) });
  state = dashboardOrderReducer(state, { type: "account_settled", accountId: "chatgpt" });
  state = dashboardOrderReducer(state, {
    type: "candidate_order",
    accountIds: resolvedDashboardOrder(metrics, "weekly-usage"),
    acceptedEpoch: 10,
  });
  assert.deepEqual(renderedIds(renderList()), ["claude-first", "claude-second", "chatgpt"], "kısmi sonuçlar sırayı bozmaz");
  state = dashboardOrderReducer(state, { type: "account_settled", accountId: "claude-first" });
  state = dashboardOrderReducer(state, { type: "account_settled", accountId: "claude-second" });
  state = dashboardOrderReducer(state, {
    type: "candidate_order",
    accountIds: resolvedDashboardOrder(metrics, "weekly-usage"),
    acceptedEpoch: 11,
  });

  const reordered = renderList();
  assert.deepEqual(renderedIds(reordered), ["claude-second", "claude-first", "chatgpt"], "aile grubu korunur, sıra grup içinde değişir");
  assert.deepEqual(
    [...reordered.matchAll(/<h2 id="[^"]+" class="[^"]*">((?:Claude|ChatGPT) \d+)<\/h2>/g)].map((match) => match[1]),
    ["Claude 2", "Claude 1", "ChatGPT 1"],
  );
  assert.doesNotMatch(reordered, /data-ledger-expand=/);
  assert.deepEqual(dashboardAccountRows(accounts, state.visibleAccountIds, metrics, ordinals, expandedIds).map((row) => row.key), state.visibleAccountIds);
  assert.deepEqual(accounts.map((value) => value.id), ["claude-first", "chatgpt", "claude-second"], "source accounts stay untouched");
});

test("one-account settlement can accept one order and missing metrics fall back stably to source", () => {
  const metrics = [
    metric("source-a", { sourceIndex: 0, highestWeeklyUsedPercent: null, nearestWeeklyResetAt: null }),
    metric("source-b", { sourceIndex: 1, highestWeeklyUsedPercent: null, nearestWeeklyResetAt: null }),
  ];
  assert.deepEqual(resolvedDashboardOrder(metrics, "weekly-usage"), ["source-a", "source-b"]);
  assert.deepEqual(resolvedDashboardOrder(metrics, "weekly-reset"), ["source-a", "source-b"]);

  let state = initialDashboardOrderState(["source-a"], "weekly-usage");
  state = dashboardOrderReducer(state, { type: "batch_started", accountIds: ["source-a"] });
  state = dashboardOrderReducer(state, { type: "account_settled", accountId: "source-a" });
  state = dashboardOrderReducer(state, { type: "candidate_order", accountIds: ["source-a"], acceptedEpoch: 3 });
  assert.deepEqual(state.visibleAccountIds, ["source-a"]);
  assert.equal(state.acceptedEpoch, 3);
});

test("snapshot commits are atomic and sort persistence writes the exact mode", () => {
  const original: Record<string, AccountSnapshot> = { a: { status: "idle" } };
  const first = commitDashboardSnapshot(original, "a", (previous) => ({ ...previous, status: "loading" }));
  const second = commitDashboardSnapshot(first, "b", () => ({ status: "ready" }));
  assert.notEqual(first, original);
  assert.notEqual(second, first);
  assert.deepEqual(original, { a: { status: "idle" } });
  assert.deepEqual(second, { a: { status: "loading" }, b: { status: "ready" } });

  let saved: unknown = null;
  assert.equal(saveDashboardSortMode(
    "weekly-reset",
    () => ({
      autoRefresh: false,
      sortMode: "source",
      localNotifications: { remainingWarnings: true, resetNotifications: false },
    }),
    (settings) => { saved = settings; return true; },
  ), true);
  assert.deepEqual(saved, {
    autoRefresh: false,
    sortMode: "weekly-reset",
    localNotifications: { remainingWarnings: true, resetNotifications: false },
  });
});

test("expired frozen reset copy changes with the clock without changing the accepted order", () => {
  const frozen = metric("expired", {
    nearestWeeklyResetAt: "2026-07-31T19:59:00.000Z",
    nearestWeeklyResetLabel: "Haftalık limit",
  });
  const acceptedOrder = resolvedDashboardOrder([frozen], "weekly-reset");
  const presented = dashboardMetricForNow(frozen, NOW);
  assert.equal(presented.nearestWeeklyResetAt, null);
  assert.equal(presented.nearestWeeklyResetLabel, "yenilenme verisi bekleniyor");
  assert.deepEqual(resolvedDashboardOrder([frozen], "weekly-reset"), acceptedOrder);
});

test("deferred reorder scrolls the released account into the nearest view after interaction", () => {
  const calls: Array<{ block?: ScrollLogicalPosition }> = [];
  const scheduled: Array<() => void> = [];
  const element = { scrollIntoView(options?: ScrollIntoViewOptions) { calls.push(options ?? {}); } };
  assert.equal(scheduleDashboardAccountScroll(element, (callback) => scheduled.push(callback)), true);
  assert.deepEqual(calls, []);
  scheduled[0]?.();
  assert.deepEqual(calls, [{ block: "nearest" }]);
  assert.equal(scheduleDashboardAccountScroll(null, (callback) => scheduled.push(callback)), false);
});

test("candidate and final focus leave without a render still publish and run the reorder scroll", () => {
  let state = initialDashboardOrderViewState(["focus-account", "other-account"], "source");
  state = dashboardOrderViewReducer(state, {
    type: "interaction_enter",
    accountId: "focus-account",
    channel: "focus",
  });
  state = dashboardOrderViewReducer(state, {
    type: "candidate_order",
    accountIds: ["other-account", "focus-account"],
    acceptedEpoch: 8,
  });
  state = dashboardOrderViewReducer(state, {
    type: "interaction_leave",
    accountId: "focus-account",
    channel: "focus",
  });

  assert.deepEqual(state.visibleAccountIds, ["other-account", "focus-account"]);
  assert.deepEqual(state.scrollRequest, { accountId: "focus-account", sequence: 1 });

  const calls: ScrollIntoViewOptions[] = [];
  const scheduled: Array<() => void> = [];
  const elements = new Map([["focus-account", {
    scrollIntoView(options?: ScrollIntoViewOptions) { calls.push(options ?? {}); },
  }]]);
  assert.equal(scheduleDashboardOrderScroll(
    state.scrollRequest,
    elements,
    (callback) => scheduled.push(callback),
  ), true);
  assert.deepEqual(calls, []);
  scheduled[0]?.();
  assert.deepEqual(calls, [{ block: "nearest" }]);
});

test("back-to-back focus and pointer exits scroll only when the final fence releases", () => {
  let state = initialDashboardOrderViewState(["focus-account", "pointer-account", "other-account"], "source");
  state = dashboardOrderViewReducer(state, {
    type: "interaction_enter",
    accountId: "focus-account",
    channel: "focus",
  });
  state = dashboardOrderViewReducer(state, {
    type: "interaction_enter",
    accountId: "pointer-account",
    channel: "pointer",
  });
  state = dashboardOrderViewReducer(state, {
    type: "candidate_order",
    accountIds: ["other-account", "pointer-account", "focus-account"],
    acceptedEpoch: 9,
  });
  state = dashboardOrderViewReducer(state, {
    type: "interaction_leave",
    accountId: "focus-account",
    channel: "focus",
  });
  assert.deepEqual(state.visibleAccountIds, ["focus-account", "pointer-account", "other-account"]);
  assert.equal(state.scrollRequest, null);

  state = dashboardOrderViewReducer(state, {
    type: "interaction_leave",
    accountId: "pointer-account",
    channel: "pointer",
  });
  assert.deepEqual(state.visibleAccountIds, ["other-account", "pointer-account", "focus-account"]);
  assert.deepEqual(state.scrollRequest, { accountId: "pointer-account", sequence: 1 });

  const calls: ScrollIntoViewOptions[] = [];
  const scheduled: Array<() => void> = [];
  const elements = new Map([["pointer-account", {
    scrollIntoView(options?: ScrollIntoViewOptions) { calls.push(options ?? {}); },
  }]]);
  assert.equal(scheduleDashboardOrderScroll(
    state.scrollRequest,
    elements,
    (callback) => scheduled.push(callback),
  ), true);
  assert.equal(scheduled.length, 1);
  scheduled[0]?.();
  assert.deepEqual(calls, [{ block: "nearest" }]);
});

test("forced-colors mode preserves canvas, text, and progress distinction", () => {
  const css = readFileSync(path.join(projectRoot, "app", "globals.css"), "utf8");
  assert.match(css, /@media \(forced-colors: active\)/);
  assert.match(css, /Canvas/);
  assert.match(css, /CanvasText/);
  assert.match(css, /Highlight/);
});

test("strict-local dashboard recovery and preference messages are Turkish while hosted copy stays unchanged", () => {
  assert.equal(typeof strictLocalDashboardMessage, "function");
  if (typeof strictLocalDashboardMessage !== "function") return;
  assert.equal(
    strictLocalDashboardMessage(true, "auto_refresh_save_failed"),
    "Otomatik yenileme tercihi bu cihaza kaydedilemedi.",
  );
  assert.equal(
    strictLocalDashboardMessage(true, "vault_unreadable"),
    "Yeniden yüklemek kayıtlı kasanın kilidini açamaz. Aşağıdaki kurtarma seçeneklerini kullanın veya önceki şifreleme anahtarını geri yükleyin.",
  );
  assert.equal(
    strictLocalDashboardMessage(false, "auto_refresh_save_failed"),
    "Otomatik yenileme tercihi bu cihaza kaydedilemedi.",
  );
  assert.equal(typeof dashboardVaultRecoveryNotice, "function");
  if (typeof dashboardVaultRecoveryNotice !== "function") return;
  assert.equal(
    dashboardVaultRecoveryNotice(true, { archive: "vault.archive", backupArchive: "backup.archive" }),
    "Okunamayan kasa vault.archive olarak, okunamayan son iyi yedeği de backup.archive olarak korundu. Hesaplarınızı şimdi yeniden bağlayabilirsiniz.",
  );
  assert.equal(
    dashboardVaultRecoveryNotice(false, { archive: "vault.archive" }),
    "Okunamayan kasa vault.archive olarak korundu. Hesaplarınızı şimdi yeniden bağlayabilirsiniz.",
  );
});

test("the Claude mark is the radial asterisk, not the Anthropic wordmark", () => {
  const markup = renderToStaticMarkup(createElement(AnthropicIcon, { className: "h-4 w-4" }));
  assert.equal([...markup.matchAll(/<rect/gu)].length, 12);
  assert.match(markup, /rotate\(30 12 12\)/u);
  assert.match(markup, /rotate\(330 12 12\)/u);
});

test("the Grok mark is the cut G, not a crossed ring", () => {
  const markup = renderToStaticMarkup(createElement(GrokIcon, { className: "h-4 w-4" }));
  assert.doesNotMatch(markup, /stroke=/u);
  assert.match(markup, /fill="currentColor"/u);
  assert.equal([...markup.matchAll(/<path/gu)].length, 1);
  const path = /\sd="([^"]+)"/u.exec(markup);
  assert.ok(path);
  assert.doesNotMatch(path[1], /[AaCcQqSsTt]/u, "kesik G eğri komut içermemeli");
});
