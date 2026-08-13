import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseOAuthProviderCallback } from "./oauth.ts";

const manifestPath = fileURLToPath(
  new URL("../scripts/windows/oauth-handoff-extension/manifest.json", import.meta.url),
);
const callbackPath = fileURLToPath(
  new URL("../scripts/windows/oauth-handoff-extension/callback.js", import.meta.url),
);
const providerCallback = "https://platform.claude.com/oauth/code/callback";
const localCallback = "http://127.0.0.1:37645/oauth/callback";
const state = "s".repeat(43);

interface ExtensionRun {
  readonly bodyReads: number;
  readonly forbiddenAccesses: readonly string[];
  readonly navigations: readonly string[];
}

function runExtension(href: string, bodyText: string): ExtensionRun {
  const forbiddenAccesses: string[] = [];
  const navigations: string[] = [];
  let bodyReads = 0;

  const location = Object.create(null) as {
    href: string;
    replace(destination: string): void;
  };
  Object.defineProperty(location, "href", {
    enumerable: true,
    get: () => href,
    set: () => {
      throw new Error("callback.js must navigate only with location.replace");
    },
  });
  location.replace = (destination: string) => {
    navigations.push(String(destination));
  };

  const body = Object.create(null);
  Object.defineProperty(body, "innerText", {
    enumerable: true,
    get: () => {
      bodyReads += 1;
      return bodyText;
    },
  });
  const document = Object.create(null);
  Object.defineProperty(document, "body", {
    enumerable: true,
    get: () => body,
  });

  const sandbox = {
    document,
    encodeURIComponent,
    location,
    URL,
  } as Record<string, unknown>;
  const forbid = (target: object, property: string, label = property) => {
    Object.defineProperty(target, property, {
      configurable: false,
      enumerable: false,
      get: () => {
        forbiddenAccesses.push(label);
        throw new Error(`${label} is unavailable`);
      },
      set: () => {
        forbiddenAccesses.push(label);
        throw new Error(`${label} is unavailable`);
      },
    });
  };
  for (const globalName of [
    "BroadcastChannel",
    "chrome",
    "console",
    "fetch",
    "indexedDB",
    "localStorage",
    "postMessage",
    "sessionStorage",
    "WebSocket",
    "XMLHttpRequest",
  ]) {
    forbid(sandbox, globalName);
  }
  const navigator = Object.create(null);
  forbid(navigator, "clipboard", "navigator.clipboard");
  forbid(navigator, "sendBeacon", "navigator.sendBeacon");
  Object.defineProperty(sandbox, "navigator", {
    enumerable: false,
    value: navigator,
  });
  const window = { document, location, navigator } as Record<string, unknown>;
  for (const windowProperty of [
    "chrome",
    "console",
    "fetch",
    "indexedDB",
    "localStorage",
    "postMessage",
    "sessionStorage",
    "WebSocket",
    "XMLHttpRequest",
  ]) {
    forbid(window, windowProperty, `window.${windowProperty}`);
  }
  Object.defineProperty(sandbox, "window", {
    enumerable: false,
    value: window,
  });
  Object.defineProperty(sandbox, "self", {
    enumerable: false,
    value: window,
  });
  forbid(document, "cookie", "document.cookie");
  for (const selectorApi of [
    "getElementById",
    "getElementsByClassName",
    "getElementsByTagName",
    "querySelector",
    "querySelectorAll",
  ]) {
    forbid(document, selectorApi, `document.${selectorApi}`);
  }

  const source = readFileSync(callbackPath, "utf8");
  vm.runInContext(source, vm.createContext(sandbox, {
    codeGeneration: { strings: false, wasm: false },
  }), {
    filename: callbackPath,
    timeout: 1_000,
  });
  return { bodyReads, forbiddenAccesses, navigations };
}

test("the MV3 manifest grants only the exact Claude callback content-script match", () => {
  const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.deepEqual(manifest, {
    manifest_version: 3,
    name: "How Much AI secure OAuth handoff",
    version: "1.0.0",
    description: "Transfers one Claude OAuth callback to the local How Much AI service.",
    content_scripts: [
      {
        matches: [`${providerCallback}*`],
        js: ["callback.js"],
        run_at: "document_idle",
      },
    ],
  });
});

test("callback.js matches the shared parser for both reviewed representations", () => {
  const fixtures = [
    {
      name: "query state",
      href: `${providerCallback}?code=auth-code-query&state=${state}`,
      body: "ignored provider content",
      expected: `${localCallback}#code=auth-code-query&state=${state}`,
      expectedBodyReads: 0,
    },
    {
      name: "hash state",
      href: `${providerCallback}?code=auth-code-hash#${state}`,
      body: "ignored provider content",
      expected: `${localCallback}#code=auth-code-hash&state=${state}`,
      expectedBodyReads: 0,
    },
    {
      name: "whole visible body",
      href: providerCallback,
      body: `\n auth-code-body#${state} \t`,
      expected: `${localCallback}#code=auth-code-body&state=${state}`,
      expectedBodyReads: 1,
    },
    {
      name: "encoded code",
      href: `${providerCallback}?code=auth%2Bcode%2Fone%3Fx%3Dy&state=${state}`,
      body: "ignored provider content",
      expected: `${localCallback}#code=auth%2Bcode%2Fone%3Fx%3Dy&state=${state}`,
      expectedBodyReads: 0,
    },
  ] as const;

  for (const fixture of fixtures) {
    const parsed = parseOAuthProviderCallback(fixture.href, fixture.body);
    assert.notEqual(parsed, null, fixture.name);
    const result = runExtension(fixture.href, fixture.body);
    assert.deepEqual(result.navigations, [fixture.expected], fixture.name);
    assert.equal(result.bodyReads, fixture.expectedBodyReads, fixture.name);
    assert.deepEqual(result.forbiddenAccesses, [], fixture.name);
  }
});

test("callback.js is synchronous, navigates once, and enforces exact input bounds", () => {
  const maximumCode = "c".repeat(4_096);
  assert.notEqual(parseOAuthProviderCallback(providerCallback, `${maximumCode}#${state}`), null);
  const accepted = runExtension(providerCallback, `${maximumCode}#${state}`);
  assert.equal(accepted.navigations.length, 1);
  assert.equal(
    accepted.navigations[0],
    `${localCallback}#code=${maximumCode}&state=${state}`,
  );
  assert.deepEqual(accepted.forbiddenAccesses, []);

  for (const [name, href, body] of [
    ["empty code", providerCallback, `#${state}`],
    ["code too long", providerCallback, `${"c".repeat(4_097)}#${state}`],
    ["short state", providerCallback, `code#${"s".repeat(42)}`],
    ["long state", providerCallback, `code#${"s".repeat(44)}`],
    ["body ambiguity", providerCallback, `code#${state}#extra`],
    ["body whitespace in code", providerCallback, `auth code#${state}`],
    ["body control in code", providerCallback, `auth\tcode#${state}`],
    ["body DEL in code", providerCallback, `auth\u007fcode#${state}`],
  ] as const) {
    assert.equal(parseOAuthProviderCallback(href, body), null, name);
    const rejected = runExtension(href, body);
    assert.deepEqual(rejected.navigations, [], name);
    assert.deepEqual(rejected.forbiddenAccesses, [], name);
  }
});

test("any provider-format mismatch is terminal and never falls back to another payload", () => {
  const validBody = `valid-body-code#${state}`;
  const invalidFixtures = [
    ["attacker origin", `https://attacker.example/oauth/code/callback?code=x&state=${state}`],
    ["userinfo", `https://user@platform.claude.com/oauth/code/callback`],
    ["alternate port", `https://platform.claude.com:444/oauth/code/callback?code=x&state=${state}`],
    ["path suffix", `${providerCallback}-suffix?code=x&state=${state}`],
    ["trailing slash", `${providerCallback}/?code=x&state=${state}`],
    ["empty query delimiter", `${providerCallback}?`],
    ["empty hash delimiter", `${providerCallback}#`],
    ["missing state", `${providerCallback}?code=x`],
    ["extra query", `${providerCallback}?code=x&state=${state}&extra=1`],
    ["duplicate code", `${providerCallback}?code=x&code=y&state=${state}`],
    ["duplicate state", `${providerCallback}?code=x&state=${state}&state=${state}`],
    ["conflicting state", `${providerCallback}?code=x&state=${state}#${state}`],
    ["space in query code", `${providerCallback}?code=auth%20code&state=${state}`],
    ["hash in query code", `${providerCallback}?code=auth%23code&state=${state}`],
  ] as const;

  for (const [name, href] of invalidFixtures) {
    assert.equal(parseOAuthProviderCallback(href, validBody), null, name);
    const result = runExtension(href, validBody);
    assert.deepEqual(result.navigations, [], name);
    assert.deepEqual(result.forbiddenAccesses, [], name);
  }
});
