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
const { AccountCard } = await import("../components/AccountCard.tsx");
const { accountProviderOrdinals } = await import("../components/Dashboard.tsx");

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

function account(id: string, provider: "anthropic" | "openai" = "anthropic"): BrowserAccount {
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
};

function renderAccountCard(
  accountValue: BrowserAccount,
  snapshot: AccountSnapshot,
  providerOrdinal = 1,
): string {
  return renderToStaticMarkup(createElement(AccountCard, {
    account: accountValue,
    snapshot,
    now: NOW,
    index: 0,
    providerOrdinal,
    ...accountCardHandlers,
  }));
}

test("used allowance is the visible and accessible progress value without a false-zero first frame", () => {
  const markup = renderToStaticMarkup(createElement(UsageBar, {
    bar: usageBar(16),
    now: NOW,
    stale: true,
    freshnessDescriptionId: "freshness-1",
  }));

  assert.match(markup, />5 saatlik limit</);
  assert.match(markup, />%16 kaldı</);
  assert.match(markup, />Kullanılan: %84</);
  const progress = markup.match(/<div role="progressbar"[^>]*>/)?.[0] ?? "";
  assert.match(progress, /aria-valuenow="84"/);
  assert.match(progress, /aria-describedby="freshness-1"/);
  assert.match(progress, /aria-valuetext="Kullanılan: %84[^"]*%16 kaldı[^"]*2 sa 30 dk sonra[^"]*31 Tem 22:30[^"]*Eski veri/);
  assert.match(markup, /<time dateTime="2026-07-31T22:30:00.000Z"[^>]*>[^<]*2 sa 30 dk sonra[^<]*31 Tem 22:30[^<]*<\/time>/);
  assert.match(markup, /style="width:84%;/);
  assert.doesNotMatch(markup, /style="width:0%;/);
});

test("remaining boundaries drive state colors while used allowance drives fill width", () => {
  for (const [remaining, expectedText, expectedColor] of [
    [50, "Az kaldı", "var(--color-amber)"],
    [30, "Az kaldı", "var(--color-amber)"],
    [15, "Kritik", "var(--color-danger)"],
    [0, "Limit bitti", "var(--color-danger)"],
  ] as const) {
    const markup = renderToStaticMarkup(createElement(UsageBar, {
      bar: usageBar(remaining, { resetsAt: null }),
      now: NOW,
      stale: false,
    }));
    assert.match(markup, new RegExp(`>${expectedText}<`), `${remaining}% remaining must say ${expectedText}`);
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
  assert.match(markup, /style="width:20%;background-color:var\(--accent, var\(--color-coral\)\)"/);
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
  assert.match(markup, /<h2[^>]*>Claude 1<\/h2>[\s\S]*>Private claude-1</);
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
  assert.match(managedMarkup, /sign in with chatgpt again/i);
  assert.doesNotMatch(managedMarkup, /claude/i);
  assert.match(managedMarkup, /private app login · auto-renews/i);

  const sharedMarkup = renderAccountCard(
    { ...account("shared-openai", "openai"), credentialKind: "rotating" },
    { status: "ready" },
  );
  assert.match(sharedMarkup, /shared cli login/i);
  assert.match(sharedMarkup, /codex cli/i);
  assert.doesNotMatch(sharedMarkup, /shares claude code/i);
});

test("dashboard source wires provider ordinals into a direct ordered card list", () => {
  const source = readFileSync(path.join(projectRoot, "components", "Dashboard.tsx"), "utf8");
  assert.match(source, /const providerOrdinals = useMemo/);
  assert.match(source, /useMemo\(\(\) => accountProviderOrdinals\(accounts\), \[accounts\]\)/);
  assert.match(source, /<ol role="list" className="grid [^"]*">\s*\{accounts\.map/s);
  assert.match(source, /accounts\.map\(\(account, i\) => \(\s*<li key=\{account\.id\}>\s*<AccountCard[\s\S]*?providerOrdinal=\{providerOrdinals\.get\(account\.id\)!\}/);
});

test("forced-colors mode preserves canvas, text, and progress distinction", () => {
  const css = readFileSync(path.join(projectRoot, "app", "globals.css"), "utf8");
  assert.match(css, /@media \(forced-colors: active\)/);
  assert.match(css, /Canvas/);
  assert.match(css, /CanvasText/);
  assert.match(css, /Highlight/);
});
