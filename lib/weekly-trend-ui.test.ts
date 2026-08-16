// What the trend actually draws. The geometry is deliberately computed rather than measured, so a
// server render is the whole picture and these assertions cover the real output.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { transformSync } from "next/dist/build/swc/index.js";
import type { BrowserAccount } from "./types.ts";
import type { WeeklyTrendSeries } from "./weekly-history.ts";

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
        jsc: { parser: { syntax: "typescript", tsx: true }, transform: { react: { runtime: "automatic" } } },
        module: { type: "es6" },
      });
      return { format: "module", source: transformed.code, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const { WeeklyTrend, weeklyTrendRuns, weeklyTrendStroke, weeklyTrendDash } =
  await import("../components/WeeklyTrend.tsx");
const { AnthropicIcon, GrokIcon } = await import("../components/Icons.tsx");

after(() => moduleHooks.deregister());

const DAYS = ["2026-08-10", "2026-08-11", "2026-08-12", "2026-08-13", "2026-08-14", "2026-08-15", "2026-08-16"];

function account(id: string, provider: BrowserAccount["provider"], label: string): BrowserAccount {
  return {
    id,
    email: `${id}@example.test`,
    label,
    plan: "Max",
    addedAt: 0,
    credentialKind: "rotating",
    provider,
    credentialExpiresAt: 0,
  };
}

function render(series: readonly WeeklyTrendSeries[], accounts: readonly BrowserAccount[]): string {
  return renderToStaticMarkup(createElement(WeeklyTrend, {
    series,
    days: DAYS,
    accountsById: new Map(accounts.map((entry) => [entry.id, entry])),
    providerOrdinals: new Map(accounts.map((entry, index) => [entry.id, index + 1])),
  }));
}

const series = (accountId: string, points: (number | null)[]): WeeklyTrendSeries => ({
  accountId,
  points,
  latest: [...points].reverse().find((point) => point !== null) ?? null,
});

test("a missing day stays a gap instead of being bridged", () => {
  // An unopened day is not a day of zero usage. Joining across it would draw a measurement that
  // was never taken, which is the one thing a history chart must not do.
  const runs = weeklyTrendRuns([10, 20, null, null, 55, 60, 70]);
  assert.deepEqual(runs.map((run) => run.map((point) => point.slot)), [[0, 1], [4, 5, 6]]);
  assert.deepEqual(weeklyTrendRuns([null, null, null]), []);
});

test("the first day of collection is a dot with an explanation, not an empty frame", () => {
  const markup = render([series("a", [null, null, null, null, null, null, 6])], [account("a", "grok", "Grok")]);
  assert.match(markup, /Bugünden itibaren birikmeye başladı\./u);
  // One point has no line to draw; without the dot the chart would look broken on day one.
  assert.match(markup, /<circle/u);
  assert.doesNotMatch(markup, /<polyline/u);
});

test("a second day turns the dot into a line and drops the starting note", () => {
  const markup = render(
    [series("a", [null, null, null, null, null, 4, 6])],
    [account("a", "anthropic", "Claude")],
  );
  assert.match(markup, /<polyline/u);
  assert.doesNotMatch(markup, /birikmeye başladı/u);
});

test("each curve carries its account's name and latest reading", () => {
  const accounts = [account("a", "anthropic", "Ana Claude"), account("b", "grok", "Grok hesabı")];
  const markup = render(
    [series("a", [null, 30, 40, 50, 60, 70, 80]), series("b", [null, null, 2, 3, 4, 5, 6])],
    accounts,
  );
  assert.match(markup, /Ana Claude/u);
  assert.match(markup, /Grok hesabı/u);
  assert.match(markup, /%80/u);
  assert.match(markup, /%6/u);
  // A screen reader gets the same summary the legend shows sighted users.
  assert.match(markup, /aria-label="Ana Claude: %80, Grok hesabı: %6"/u);
});

test("accounts with no reading yet are absent rather than drawn flat at zero", () => {
  const markup = render(
    [series("a", [null, null, null, null, null, null, 6]), series("ghost", [null, null, null, null, null, null, null])],
    [account("a", "grok", "Grok"), account("ghost", "openai", "Codex")],
  );
  assert.match(markup, /data-account="a"/u);
  assert.doesNotMatch(markup, /data-account="ghost"/u);
});

test("nothing renders at all until some account has a reading", () => {
  assert.equal(render([series("a", [null, null, null, null, null, null, null])], [account("a", "grok", "Grok")]), "");
});

test("curve colour follows the provider accent and repeats separate by dash", () => {
  // Reusing the severity palette here would make a 90%-spent Claude curve the same red as a
  // danger bar, and the two scales mean different things.
  assert.equal(weeklyTrendStroke("anthropic"), "var(--claude-coral)");
  assert.equal(weeklyTrendStroke("openai"), "var(--calibration-blue)");
  assert.notEqual(weeklyTrendStroke("grok"), weeklyTrendStroke("anthropic"));
  assert.equal(weeklyTrendDash(1), undefined);
  assert.notEqual(weeklyTrendDash(2), undefined);
  assert.notEqual(weeklyTrendDash(2), weeklyTrendDash(3));
});

test("the plot geometry is fixed, so a server render is the whole picture", () => {
  const markup = render([series("a", [0, null, null, null, null, null, 100])], [account("a", "grok", "Grok")]);
  assert.match(markup, /viewBox="0 0 336 108"/u);
  // 0% sits on the bottom gridline and 100% on the top one; an inverted axis here would read as
  // "more left" and invert the meaning of every curve on the chart.
  const zero = /cy="([\d.]+)"[^>]*\/><\/g>|<circle[^>]*cy="([\d.]+)"/u;
  assert.ok(zero.test(markup));
  assert.match(markup, /<line[^>]*y1="8"/u, "üst kılavuz çizgisi %100'de değil");
  assert.match(markup, /<line[^>]*y1="98"/u, "alt kılavuz çizgisi %0'da değil");
});

// --- provider marks -----------------------------------------------------------------------------

test("the Claude mark is the radial asterisk, not the Anthropic wordmark", () => {
  const markup = renderToStaticMarkup(createElement(AnthropicIcon, { className: "h-4 w-4" }));
  // Twelve rotated spokes around one centre. The old mark was a single "A" glyph path, so the
  // count is what tells the two apart.
  assert.equal([...markup.matchAll(/<rect/gu)].length, 12);
  assert.match(markup, /rotate\(30 12 12\)/u);
  assert.match(markup, /rotate\(330 12 12\)/u);
});

test("the Grok mark is the cut G, not a crossed ring", () => {
  const markup = renderToStaticMarkup(createElement(GrokIcon, { className: "h-4 w-4" }));
  // The stand-in was two stroked paths — a diagonal and an arc. A filled letterform has neither.
  assert.doesNotMatch(markup, /stroke=/u);
  assert.match(markup, /fill="currentColor"/u);
  assert.equal([...markup.matchAll(/<path/gu)].length, 1);
  // Straight-cut bevels are the point: an arc command would mean a circle crept back in.
  const path = /\sd="([^"]+)"/u.exec(markup);
  assert.ok(path);
  assert.doesNotMatch(path[1], /[AaCcQqSsTt]/u, "kesik G eğri komut içermemeli");
});
