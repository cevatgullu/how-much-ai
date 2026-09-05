// The installed iPhone shell. The manifest (see pwa-manifest.test.ts) is what makes the install
// offer appear; this file covers what the window does once it is installed — the chrome iOS reads
// from meta tags rather than the manifest, and the scroll containment that stops the shell drifting
// under the status bar.
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import "./providers/_resolve-ts.mjs";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const css = readFileSync(path.join(projectRoot, "app", "globals.css"), "utf8");
const { appMetadata, appViewport, APP_NAME } = await import("./pwa-shell.ts");

test("iOS is told this is a standalone app, with its own home-screen name", () => {
  // Safari reads apple-mobile-web-app-* rather than the manifest for the installed window, so a
  // manifest alone leaves the app running inside browser chrome.
  const apple = appMetadata.appleWebApp;
  assert.ok(apple && typeof apple === "object", "appleWebApp bildirilmemiş");
  assert.equal(apple.capable, true);
  assert.equal(apple.title, APP_NAME);
  // Drawing under the status bar is only safe because every shell edge pads by safe-area insets.
  assert.equal(apple.statusBarStyle, "black-translucent");
});

test("the home-screen tile has a real raster icon behind it", () => {
  const apple = appMetadata.icons && typeof appMetadata.icons === "object"
    ? (appMetadata.icons as { apple?: unknown }).apple
    : undefined;
  const entries = Array.isArray(apple) ? apple : [apple];
  assert.ok(entries.length > 0, "apple touch icon yok");
  for (const entry of entries) {
    const url = typeof entry === "string" ? entry : (entry as { url?: string } | undefined)?.url;
    assert.ok(typeof url === "string" && url.startsWith("/"), "apple icon yolu yok");
    // An SVG here installs as a blank tile on iOS; the asset must exist and be a real PNG.
    const file = path.join(projectRoot, "public", url.replace(/^\//u, ""));
    assert.ok(statSync(file).isFile(), `${url} yok`);
    assert.deepEqual([...readFileSync(file).subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], `${url} PNG değil`);
  }
});

test("the canvas reaches the notch without taking pinch-zoom away", () => {
  assert.equal(appViewport.viewportFit, "cover");
  assert.equal(appViewport.initialScale, 1);
  assert.equal(appViewport.width, "device-width");
  // Locking zoom is a common shortcut for "stop the page moving". It is an accessibility
  // regression and it is not what fixes the bounce, so it must not creep back in.
  assert.equal(appViewport.userScalable, undefined);
  assert.equal(appViewport.maximumScale, undefined);
});

test("the document refuses pull-to-refresh and end-of-page bounce", () => {
  const root = /html\s*\{([^}]*)\}/u.exec(css);
  const body = /\nbody\s*\{([^}]*)\}/u.exec(css);
  assert.ok(root && body);
  assert.match(root[1], /overscroll-behavior:\s*none/u);
  assert.match(body[1], /overscroll-behavior:\s*none/u);
});

test("an installed shell owns its own scroll instead of moving the document", () => {
  const block = /@media \(display-mode: standalone\) \{([\s\S]*?)\n\}/u.exec(css);
  assert.ok(block, "standalone bloğu yok");
  assert.match(block[1], /overflow:\s*hidden/u, "belge kaydırması kilitlenmemiş");
  assert.match(block[1], /\.instrument-app\s*\{[\s\S]*?overflow-y:\s*auto/u, "kabuk kaydırılabilir değil");
  assert.match(block[1], /overscroll-behavior-y:\s*contain/u);
  // Pages without the dashboard shell have nothing to hand the scroll to; locking the document
  // there would clip the login form with no way to reach the button.
  assert.match(block[1], /html:has\(\.instrument-app\)/u, "kilit :has ile sınırlandırılmamış");
});

test("the standalone lock is declared after the rule it has to override", () => {
  // Media queries add no specificity. Declared above `.instrument-app { min-height: 100dvh }`, the
  // lock loses and the shell measures taller than its clipped parent, hiding the last card.
  const base = css.indexOf(".instrument-app { min-height:");
  const lock = css.indexOf("@media (display-mode: standalone)");
  assert.ok(base >= 0 && lock >= 0);
  assert.ok(lock > base, "standalone bloğu temel kuraldan önce geliyor");
  assert.match(
    /@media \(display-mode: standalone\) \{([\s\S]*?)\n\}/u.exec(css)![1],
    /min-height:\s*0/u,
    "temel 100dvh tabanı sıfırlanmamış",
  );
});

test("phone meter, quota, and login overrides are declared after the base rules they replace", () => {
  // Media queries add no specificity. The meter/login blocks used to sit below the 959.98px
  // query, so the phone font-size and login alignment never won.
  const baseMeter = css.indexOf(".usage-meter-used {");
  const baseLogin = css.indexOf(".login-page {");
  const phone = css.lastIndexOf("@media (max-width: 959.98px)");
  assert.ok(baseMeter >= 0 && baseLogin >= 0 && phone >= 0);
  assert.ok(phone > baseMeter, "telefon sayaç kuralı temel kuraldan önce");
  assert.ok(phone > baseLogin, "telefon giriş kuralı temel kuraldan önce");
  const nextQuery = css.indexOf("@media (min-width: 960px)", phone);
  const phoneBlock = css.slice(phone, nextQuery === -1 ? undefined : nextQuery);
  assert.match(phoneBlock, /html \.usage-meter-used\s*\{[^}]*font-size:\s*1\.85rem/u);
  assert.match(phoneBlock, /html \.quota-readings\s*\{[^}]*grid-template-columns:\s*5\.25rem/u);
  assert.match(phoneBlock, /html \.login-page\s*\{[^}]*align-items:\s*flex-start/u);
});

test("every shell edge still pads by its safe-area inset", () => {
  // black-translucent draws under the clock and the home indicator; without these the header sits
  // beneath the status bar and the command bar under the gesture area.
  assert.match(css, /--safe-top:\s*env\(safe-area-inset-top/u);
  assert.match(css, /--safe-bottom:\s*env\(safe-area-inset-bottom/u);
  for (const [selector, token] of [
    [".instrument-header", "--safe-top"],
    [".instrument-shell", "--safe-bottom"],
    [".mobile-command-bar", "--safe-bottom"],
  ] as const) {
    const rules = [...css.matchAll(new RegExp(`\\${selector}[^{]*\\{([^}]*)\\}`, "gu"))];
    assert.ok(rules.length > 0, `${selector} kuralı yok`);
    assert.ok(rules.some((rule) => rule[1].includes(token)), `${selector}: ${token} yok`);
  }
});

test("sheets consume the safe area and hide the tab bar while open", () => {
  assert.match(css, /\.modal-root-center\s*\{[^}]*var\(--safe-top\)/u);
  assert.match(css, /\.modal-panel\[data-placement="sheet"\]\s*\{[^}]*var\(--safe-bottom\)/u);
  assert.match(css, /html:has\(\.modal-root\) \.mobile-command-bar/u);
});

test("the phone command bar is an iOS tab row, not a padded iPhone 8 brick", () => {
  // 72px content + home-indicator padding floated the labels above a dead band.
  // Native item row is ~50px; the inset is padding on the same painted bar.
  assert.match(css, /--tab-content:\s*50px/u);
  const bar = /\.mobile-command-bar\s*\{([^}]*)\}/u.exec(css);
  assert.ok(bar);
  assert.match(bar[1], /min-height:\s*calc\(var\(--tab-content\) \+ var\(--safe-bottom\)\)/u);
  assert.match(bar[1], /padding-bottom:\s*var\(--safe-bottom\)/u);
  assert.doesNotMatch(bar[1], /72px/u);
  const item = /\.mobile-command-bar > button\s*\{([^}]*)\}/u.exec(css);
  assert.ok(item);
  assert.match(item[1], /height:\s*var\(--tab-content\)/u);
});
