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
const { DashboardHeader } = await import("../components/DashboardHeader.tsx");
const { DashboardSheets } = await import("../components/DashboardSheets.tsx");
const { MobileCommandBar } = await import("../components/MobileCommandBar.tsx");
const { ModalShell } = await import("../components/ModalShell.tsx");

after(() => moduleHooks.deregister());

test("modal controls and semantic hooks use the Turkish instrument vocabulary", () => {
  const markup = renderToStaticMarkup(createElement(ModalShell, {
    open: true,
    title: "Menü",
    onClose() {},
    children: createElement("p", null, "Yerel ayarlar"),
  }));
  assert.match(markup, /class="[^"]*modal-root/);
  assert.match(markup, /class="[^"]*modal-panel/);
  assert.match(markup, /aria-label="Kapat"/);
});

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





test("renders compact readings with account and winning limit identities", () => {
  const accounts = [
    account("highest", "anthropic", { label: "Yoğun hesap" }),
    // Kart adı artık sağlayıcıdan gelen fullName'i değil, takma adı ya da e-postayı kullanır.
    account("nearest", "openai", { label: "Yakın yenileme" }),
  ];
  const highest = metric("highest", 0, 88, "Opus haftalık limiti");
  const nearest = metric("nearest", 1, 40, "Bağlı uygulamalar haftalık limiti");
  const summary: WeeklyAccountSummary = { accountCount: 2, highestUsage: highest, nearestReset: nearest };
  const markup = renderToStaticMarkup(createElement(QuotaReadings, {
    summary,
    accountsById: new Map(accounts.map((value) => [value.id, value])),
    providerOrdinals: new Map([["highest", 1], ["nearest", 1]]),
    now: Date.parse("2026-08-12T12:00:00.000Z"),
  }));

  assert.match(markup, />Hesap<[\s\S]*>2</);
  assert.match(markup, />En yüksek haftalık kullanım<[\s\S]*Yoğun hesap[\s\S]*%88[\s\S]*Opus haftalık limiti/);
  assert.match(markup, />En yakın haftalık yenilenme<[\s\S]*Yakın yenileme[\s\S]*Bağlı uygulamalar haftalık limiti/);
  assert.match(markup, /<time[^>]*dateTime="2026-08-14T12:00:00.000Z"/);
  assert.match(markup, /2 gün sonra[\s\S]*14 Ağu/);
  assert.doesNotMatch(markup, />2026-08-14T12:00:00\.000Z</);
  assert.doesNotMatch(markup, /@private\.invalid/);
});



test("local dashboard controls expose exact Turkish sorting and compact actions without hosted claims", () => {
  const noop = () => {};
  const header = renderToStaticMarkup(createElement(DashboardHeader, {
    healthLabel: "2 hesap güncel",
    autoRefresh: true,
    sortMode: "weekly-usage",
    sortUnavailable: false,
    refreshing: false,
    canRefresh: true,
    onRefresh: noop,
    onAddAccount: noop,
    onNotifications: noop,
    onSort: noop,
    onMenu: noop,
  }));
  assert.match(header, />How Much AI</);
  assert.match(header, />En çok kullanılan üstte</);
  assert.match(header, /aria-label="Hesap ekle"/);
  assert.doesNotMatch(header, /role="switch"/);

  const sortSheet = renderToStaticMarkup(createElement(DashboardSheets, {
    activeSheet: "sort",
    sortMode: "weekly-usage",
    autoRefresh: true,
    showSignOut: false,
    onClose: noop,
    onSortModeChange: noop,
    onAutoRefreshChange: noop,
    onSignOutError: noop,
  }));
  assert.equal((sortSheet.match(/type="radio"/g) ?? []).length, 5);
  assert.match(sortSheet, />Kayıt sırası</);
  assert.match(sortSheet, />En çok kullanılan üstte</);
  assert.match(sortSheet, />En az kullanılan üstte</);
  assert.match(sortSheet, />En yakın yenilenme</);
  assert.match(sortSheet, />En uzak yenilenme</);
  assert.match(sortSheet, /<input(?=[^>]*value="weekly-usage")(?=[^>]*checked="")[^>]*>/);
  assert.doesNotMatch(sortSheet, /role="switch"/);

  const menuSheet = renderToStaticMarkup(createElement(DashboardSheets, {
    activeSheet: "menu",
    sortMode: "weekly-usage",
    autoRefresh: true,
    showSignOut: true,
    onClose: noop,
    onSortModeChange: noop,
    onAutoRefreshChange: noop,
    onSignOutError: noop,
  }));
  assert.match(menuSheet, />Otomatik yenileme</);
  assert.match(menuSheet, /role="switch"[^>]*aria-checked="true"/);
  assert.match(menuSheet, /şifrelenmiş yerel kasada/);
  assert.match(menuSheet, /aria-label="Oturumu kapat"/);

  const commands = renderToStaticMarkup(createElement(MobileCommandBar, {
    refreshing: false,
    canRefresh: true,
    onRefresh: noop,
    onAddAccount: noop,
    onNotifications: noop,
    onMenu: noop,
  }));
  const labels = [...commands.matchAll(/<button[^>]*aria-label="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(labels, ["Yenile", "Hesap ekle", "Uyarılar", "Menü"]);
  assert.match(commands, />Yenile<[\s\S]*>Hesap<[\s\S]*>Uyarılar<[\s\S]*>Menü</);

  const allControls = `${header}${sortSheet}${menuSheet}${commands}`;
  assert.doesNotMatch(allControls, /canlı görünüm|sunucu izleyici|PWA|bulut|cloud|server monitor/i);
});

test("empty-board header can omit the sort strip", () => {
  const markup = renderToStaticMarkup(createElement(DashboardHeader, {
    healthLabel: "İlk veri bekleniyor",
    autoRefresh: true,
    sortMode: "source",
    sortUnavailable: false,
    refreshing: false,
    canRefresh: false,
    showSort: false,
    onRefresh() {},
    onAddAccount() {},
    onNotifications() {},
    onSort() {},
    onMenu() {},
  }));
  assert.match(markup, />How Much AI</);
  assert.match(markup, />İlk veri bekleniyor</);
  assert.doesNotMatch(markup, /dashboard-sort-strip/);
  assert.doesNotMatch(markup, />Sıralama</);
});

test("compact controls explain unavailable weekly sorting without changing the selected mode", () => {
  const markup = renderToStaticMarkup(createElement(DashboardHeader, {
    healthLabel: "İlk veri bekleniyor",
    autoRefresh: true,
    sortMode: "weekly-reset",
    sortUnavailable: true,
    refreshing: false,
    canRefresh: true,
    onRefresh() {},
    onAddAccount() {},
    onNotifications() {},
    onSort() {},
    onMenu() {},
  }));
  assert.match(markup, />En yakın yenilenme</);
  assert.match(markup, />Sıralamak için kullanılabilir haftalık veri yok</);
});

test("ModalShell renders center and sheet placements through the same dialog boundary", () => {
  const center = renderToStaticMarkup(createElement(ModalShell, {
    open: true,
    title: "Merkez",
    onClose() {},
    children: createElement("p", null, "İçerik"),
  }));
  const sheet = renderToStaticMarkup(createElement(ModalShell, {
    open: true,
    title: "Menü",
    placement: "sheet",
    onClose() {},
    children: createElement("p", null, "İçerik"),
  }));
  assert.match(center, /role="dialog"[^>]*data-placement="center"/);
  assert.match(sheet, /role="dialog"[^>]*data-placement="sheet"/);
  assert.match(center, /modal-root-center/);
  assert.match(sheet, /modal-root-sheet/);
  assert.equal((center.match(/aria-modal="true"/g) ?? []).length, 1);
  assert.equal((sheet.match(/aria-modal="true"/g) ?? []).length, 1);
});
