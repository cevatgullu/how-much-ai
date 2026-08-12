import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { transformSync } from "next/dist/build/swc/index.js";
import type { WeeklyAccountMetric, WeeklyAccountSummary } from "./quota-metrics.ts";
import type { BrowserAccount } from "./types.ts";

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
      return { url: sourceModule(path.join(projectRoot, specifier.slice(2))), shortCircuit: true };
    }
    if (
      (specifier.startsWith("./") || specifier.startsWith("../"))
      && context.parentURL?.startsWith(pathToFileURL(projectRoot).href)
      && !context.parentURL.includes("/node_modules/")
      && path.extname(new URL(specifier, context.parentURL).pathname) === ""
    ) {
      return { url: sourceModule(fileURLToPath(new URL(specifier, context.parentURL))), shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith(".tsx")) {
      const transformed = transformSync(readFileSync(fileURLToPath(url), "utf8"), {
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

const { QuotaReadings } = await import("../components/QuotaReadings.tsx");
const { QuotaRuler, quotaRulerPopupReducer } = await import("../components/QuotaRuler.tsx");

after(() => moduleHooks.deregister());

function account(
  id: string,
  provider: BrowserAccount["provider"] = "anthropic",
  display: Partial<Pick<BrowserAccount, "label" | "fullName">> = {},
): BrowserAccount {
  return {
    id,
    email: `${id}@private.invalid`,
    plan: provider === "openai" ? "ChatGPT Pro" : "Max",
    addedAt: 1,
    credentialKind: "managed",
    provider,
    credentialExpiresAt: Date.parse("2026-08-20T12:00:00.000Z"),
    ...display,
  };
}

function metric(
  accountId: string,
  sourceIndex: number,
  percent: number | null,
  label: string | null = "Haftalık limit",
): WeeklyAccountMetric {
  return {
    accountId,
    sourceIndex,
    highestWeeklyUsedPercent: percent,
    highestWeeklyLimitKey: percent === null ? null : "weekly_all",
    highestWeeklyLimitLabel: percent === null ? null : label,
    nearestWeeklyResetAt: percent === null ? null : `2026-08-${String(13 + sourceIndex).padStart(2, "0")}T12:00:00.000Z`,
    nearestWeeklyResetKey: percent === null ? null : "weekly_all",
    nearestWeeklyResetLabel: percent === null ? null : label,
    hasFreshReading: percent !== null,
  };
}

test("renders calibrated visual tracks and a complete named semantic account list without email", () => {
  const accounts = [
    account("nickname", "anthropic", { label: "Kişisel" }),
    account("full-name", "openai", { fullName: "İş hesabı" }),
    account("email-only"),
  ];
  const metrics = [
    metric("nickname", 0, 72, "Opus haftalık limiti"),
    metric("full-name", 1, 43, "Bağlı uygulamalar haftalık limiti"),
    metric("email-only", 2, null, null),
  ];
  const markup = renderToStaticMarkup(createElement(QuotaRuler, {
    metrics,
    accountsById: new Map(accounts.map((value) => [value.id, value])),
    providerOrdinals: new Map([["nickname", 1], ["full-name", 1], ["email-only", 2]]),
  }));

  assert.match(markup, />Kota cetveli</);
  assert.equal((markup.match(/data-ruler-tick="primary"/g) ?? []).length, 8, "desktop and mobile tracks each expose four primary visual ticks");
  assert.equal((markup.match(/data-ruler-tick="secondary"/g) ?? []).length, 4, "desktop and mobile tracks each expose two secondary visual ticks");
  for (const tick of ["0", "25", "50", "75", "85", "100"]) {
    assert.match(markup, new RegExp(`data-ruler-value="${tick}"`));
  }
  assert.equal((markup.match(/aria-hidden="true"/g) ?? []).length >= 2, true);
  assert.match(markup, /<ol[^>]*aria-label="Kota cetveli hesapları"/);
  assert.equal((markup.match(/<li data-ruler-account=/g) ?? []).length, 3);
  assert.match(markup, /Kişisel[\s\S]*%72[\s\S]*Opus haftalık limiti[\s\S]*son veri/);
  assert.match(markup, /İş hesabı[\s\S]*%43[\s\S]*Bağlı uygulamalar haftalık limiti[\s\S]*son veri/);
  assert.match(markup, /data-state="waiting"[\s\S]*Claude 2[\s\S]*İlk veri bekleniyor/);
  assert.doesNotMatch(markup.match(/<li data-ruler-account="email-only"[\s\S]*?<\/li>/)?.[0] ?? "", /%0/);
  assert.doesNotMatch(markup, /@private\.invalid/);
  assert.match(markup, /En yoğun[\s\S]*Kişisel[\s\S]*%72/);
});

test("renders dense +N clusters as named buttons with accessible member content", () => {
  const accounts = Array.from({ length: 7 }, (_, index) => account(`dense-${index}`, "anthropic", { label: `Hesap ${index + 1}` }));
  const metrics = accounts.map((value, index) => metric(value.id, index, 50, "Uzun haftalık kullanım limiti"));
  const markup = renderToStaticMarkup(createElement(QuotaRuler, {
    metrics,
    accountsById: new Map(accounts.map((value) => [value.id, value])),
    providerOrdinals: new Map(accounts.map((value, index) => [value.id, index + 1])),
  }));

  const clusterButton = markup.match(/<button[^>]*data-ruler-cluster[^>]*>[\s\S]*?<\/button>/)?.[0] ?? "";
  assert.match(clusterButton, /aria-label="4 hesaplık kümeyi aç"/);
  assert.match(clusterButton, /aria-expanded="false"/);
  assert.match(clusterButton, />\+4</);
  assert.match(markup, /role="dialog"[^>]*hidden=""/);
  assert.match(markup, /Hesap 4[\s\S]*Hesap 7/);
});

test("renders compact readings with account and winning limit identities", () => {
  const accounts = [
    account("highest", "anthropic", { label: "Yoğun hesap" }),
    account("nearest", "openai", { fullName: "Yakın yenileme" }),
  ];
  const highest = metric("highest", 0, 88, "Opus haftalık limiti");
  const nearest = metric("nearest", 1, 40, "Bağlı uygulamalar haftalık limiti");
  const summary: WeeklyAccountSummary = { accountCount: 2, highestUsage: highest, nearestReset: nearest };
  const markup = renderToStaticMarkup(createElement(QuotaReadings, {
    summary,
    accountsById: new Map(accounts.map((value) => [value.id, value])),
    providerOrdinals: new Map([["highest", 1], ["nearest", 1]]),
  }));

  assert.match(markup, />Hesap<[\s\S]*>2</);
  assert.match(markup, />En yüksek haftalık kullanım<[\s\S]*Yoğun hesap[\s\S]*%88[\s\S]*Opus haftalık limiti/);
  assert.match(markup, />En yakın haftalık yenilenme<[\s\S]*Yakın yenileme[\s\S]*Bağlı uygulamalar haftalık limiti/);
  assert.match(markup, /<time[^>]*dateTime="2026-08-14T12:00:00.000Z"/);
  assert.doesNotMatch(markup, /@private\.invalid/);
});

test("quota ruler popup reducer opens and closes through pointer and keyboard actions", () => {
  assert.equal(quotaRulerPopupReducer(null, { type: "open", clusterId: "cluster-a" }), "cluster-a");
  assert.equal(quotaRulerPopupReducer("cluster-a", { type: "close" }), null);
  assert.equal(quotaRulerPopupReducer(null, { type: "key", key: "Enter", clusterId: "cluster-b" }), "cluster-b");
  assert.equal(quotaRulerPopupReducer("cluster-b", { type: "key", key: "Escape" }), null);
  assert.equal(quotaRulerPopupReducer("cluster-b", { type: "key", key: "ArrowDown", clusterId: "cluster-c" }), "cluster-b");
});
