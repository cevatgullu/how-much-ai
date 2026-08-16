// The connect dialog parses the pasted Grok session in the browser before it is sent, and the
// server parses it again on arrival. These are two separate implementations of the same rule,
// so they are pinned against the same cases: a divergence would let the dialog accept input the
// server rejects (or worse, the reverse).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { transformSync } from "next/dist/build/swc/index.js";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const moduleHooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    const asSource = (target: string) => {
      for (const candidate of [`${target}.ts`, `${target}.tsx`, target]) {
        try {
          readFileSync(candidate);
          return pathToFileURL(candidate).href;
        } catch {}
      }
      return pathToFileURL(target).href;
    };
    if (specifier.startsWith("@/")) {
      return { url: asSource(path.join(projectRoot, specifier.slice(2))), shortCircuit: true };
    }
    // Components import siblings without an extension (`./Icons`); Node's ESM resolver will not
    // guess one, so the same source lookup is applied to relative in-repo specifiers.
    if (
      (specifier.startsWith("./") || specifier.startsWith("../"))
      && context.parentURL?.startsWith(pathToFileURL(projectRoot).href)
      && !context.parentURL.includes("/node_modules/")
      && path.extname(new URL(specifier, context.parentURL).pathname) === ""
    ) {
      return { url: asSource(fileURLToPath(new URL(specifier, context.parentURL))), shortCircuit: true };
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

const { parseGrokSession } = await import("../components/providers-ui.tsx");
const { grokProvider } = await import("./providers/grok.ts");

// A structurally valid JWT. Unsigned: both parsers treat it as opaque and never verify it.
const BEARER = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1LTEifQ.c2ln";

const CASES: { input: string; expect: string | null; why: string }[] = [
  { input: BEARER, expect: BEARER, why: "çıplak CLI token'ı" },
  { input: JSON.stringify({ "grok.com": { key: BEARER } }), expect: BEARER, why: "~/.grok/auth.json" },
  { input: JSON.stringify({ a: { access_token: BEARER } }), expect: BEARER, why: "access_token alanı" },
  { input: JSON.stringify({ hello: "world" }), expect: null, why: "auth dosyası olmayan JSON" },
  { input: "abc123", expect: "sso=abc123", why: "çıplak değer" },
  { input: "  sso=abc123  ", expect: "sso=abc123", why: "ad=değer çifti" },
  { input: "i18nextLng=tr; sso=abc123; x-userid=z", expect: "sso=abc123", why: "tam çerez başlığı" },
  // Base64url session values end in padding; splitting on the first '=' must not truncate them.
  { input: "sso=a.b==", expect: "sso=a.b==", why: "dolgu karakteri korunur" },
  { input: "", expect: null, why: "boş" },
  { input: "x-userid=z", expect: null, why: "sso içermeyen başlık" },
  { input: "two words", expect: null, why: "boşluklu değer bir çerez değil" },
];

test("the dialog and the server read a pasted session identically", () => {
  for (const { input, expect, why } of CASES) {
    const client = parseGrokSession(input);
    const server = grokProvider.parseManualCredential!(input);
    assert.equal(client?.accessToken ?? null, expect, `istemci: ${why}`);
    assert.equal(server?.accessToken ?? null, expect, `sunucu: ${why}`);
    assert.deepEqual(client, server, `iki ayrıştırıcı ayrışmamalı: ${why}`);
  }
  moduleHooks.deregister();
});
