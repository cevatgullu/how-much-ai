// The manifest is what makes the shell installable, and iOS only delivers Web Push to an
// installed shell — so these are notification prerequisites, not cosmetics.
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import "./providers/_resolve-ts.mjs";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const { default: manifest } = await import("../app/manifest.ts");

test("the manifest declares an installable standalone shell", () => {
  const m = manifest();
  // iOS offers "Add to Home Screen" for a standalone display mode; without it there is no
  // installed shell and therefore no Web Push on iPhone at all.
  assert.equal(m.display, "standalone");
  assert.equal(m.start_url, "/");
  assert.equal(m.scope, "/");
  assert.equal(m.id, "/");
  assert.equal(m.lang, "tr");
  // Matches the instrument canvas so the splash and status bar do not flash a different colour.
  assert.equal(m.background_color, "#0b0d14");
  assert.equal(m.theme_color, "#0b0d14");
});

test("icons cover both the plain and maskable purposes", () => {
  const icons = manifest().icons ?? [];
  const bySize = new Map(icons.map((icon) => [`${icon.sizes}:${icon.purpose}`, icon]));
  assert.ok(bySize.get("192x192:any"), "192 any eksik");
  assert.ok(bySize.get("512x512:any"), "512 any eksik");
  // A maskable icon must be its own asset: reusing an `any` icon gets the mark cropped by the
  // platform mask, because `any` art has no safe-zone padding.
  const maskable = bySize.get("512x512:maskable");
  assert.ok(maskable, "512 maskable eksik");
  assert.notEqual(maskable.src, bySize.get("512x512:any").src);
});

test("every declared icon exists as a real file", () => {
  for (const icon of manifest().icons ?? []) {
    const file = path.join(projectRoot, "public", icon.src.replace(/^\//u, ""));
    const stat = statSync(file);
    assert.ok(stat.isFile(), `${icon.src} yok`);
    // A truncated or placeholder PNG installs as a blank tile; require real pixel data.
    assert.ok(stat.size > 512, `${icon.src} fazla küçük (${stat.size} B)`);
    const header = readFileSync(file).subarray(0, 8);
    assert.deepEqual([...header], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], `${icon.src} PNG değil`);
  }
});
