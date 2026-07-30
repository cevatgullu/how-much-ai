import assert from "node:assert/strict";
import { after, test } from "node:test";
import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const moduleHooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "next/server") return nextResolve("next/server.js", context);
    if (specifier.startsWith("@/")) {
      const target = specifier.slice(2);
      return nextResolve(pathToFileURL(path.join(projectRoot, path.extname(target) ? target : `${target}.ts`)).href, context);
    }
    if (
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      context.parentURL?.startsWith(pathToFileURL(projectRoot).href) &&
      !context.parentURL.includes("/node_modules/") &&
      path.extname(new URL(specifier, context.parentURL).pathname) === ""
    ) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

const originalEnv = { ...process.env };
const { NextRequest } = await import("next/server.js");
const { default: proxy } = await import("../proxy.ts");
const { POST: loginPost } = await import("../app/api/auth/login/route.ts");

after(() => {
  process.env = originalEnv;
  moduleHooks.deregister();
});

function validStrictEnvironment(): NodeJS.ProcessEnv {
  return {
    HMC_STRICT_LOCAL_MODE: "1",
    HMC_LISTEN_HOST: "127.0.0.1",
    HMC_LISTEN_PORT: "37645",
    PORT: "37645",
    NODE_ENV: "production",
    APP_PASSWORD: "a".repeat(64),
    AUTH_SECRET: "b".repeat(64),
    VAULT_ENCRYPTION_SECRET: "c".repeat(64),
    TRUST_PROXY_IP_HEADERS: "0",
    ENABLE_LOCAL_CONNECT: "1",
    VAULT_DATA_DIR: path.resolve(".strict-local-proxy-test-vault"),
    NEXT_TELEMETRY_DISABLED: "1",
  };
}

function proxyRequest(pathname: string, host?: string): InstanceType<typeof NextRequest> {
  const headers = new Headers();
  if (host !== undefined) headers.set("host", host);
  return new NextRequest(`http://127.0.0.1:37645${pathname}`, { headers });
}

test("strict proxy accepts the exact Host and proceeds to public or protected routing", async () => {
  process.env = validStrictEnvironment();

  const publicResponse = await proxy(proxyRequest("/api/auth/login", "127.0.0.1:37645"));
  assert.equal(publicResponse.status, 200);
  assert.equal(publicResponse.headers.get("x-middleware-next"), "1");

  const protectedResponse = await proxy(proxyRequest("/api/usage", "127.0.0.1:37645"));
  assert.equal(protectedResponse.status, 401);
  assert.deepEqual(await protectedResponse.json(), { error: "Not signed in" });
});

test("strict proxy returns a static 421 for every non-exact Host on public and protected paths", async () => {
  process.env = validStrictEnvironment();
  const rejectedHosts: Array<[string, string | undefined]> = [
    ["missing", undefined],
    ["blank", ""],
    ["malformed", "127.0.0.1:37645/path"],
    ["localhost", "localhost:37645"],
    ["IPv6", "[::1]:37645"],
    ["alternate port", "127.0.0.1:3000"],
    ["hostile", "attacker.example"],
  ];

  for (const pathname of ["/api/auth/login", "/api/usage"]) {
    for (const [label, host] of rejectedHosts) {
      const response = await proxy(proxyRequest(pathname, host));
      assert.equal(response.status, 421, `${label} Host on ${pathname}`);
      assert.deepEqual(await response.json(), { error: "Bad request" }, `${label} Host on ${pathname}`);
    }
  }
});

test("strict Host rejection occurs before invalid strict environment handling", async () => {
  process.env = { HMC_STRICT_LOCAL_MODE: "1" };

  const response = await proxy(proxyRequest("/api/usage", "attacker.example"));
  assert.equal(response.status, 421);
  assert.deepEqual(await response.json(), { error: "Bad request" });
  await assert.rejects(
    () => proxy(proxyRequest("/api/usage", "127.0.0.1:37645")),
    /configuration refused to start/i,
  );
});

test("non-strict proxy preserves upstream Host behavior", async () => {
  process.env = { NODE_ENV: "production" };

  for (const pathname of ["/api/auth/login", "/api/usage"]) {
    const response = await proxy(proxyRequest(pathname, "attacker.example"));
    assert.equal(response.status, 200, pathname);
    assert.equal(response.headers.get("x-middleware-next"), "1", pathname);
  }
});

test("strict login emits a host-only HttpOnly SameSite=Strict cookie usable on loopback HTTP", async () => {
  process.env = validStrictEnvironment();
  const password = process.env.APP_PASSWORD;
  assert.ok(password);

  const response = await loginPost(
    new Request("http://127.0.0.1:37645/api/auth/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Host: "127.0.0.1:37645",
        Origin: "http://127.0.0.1:37645",
        "Sec-Fetch-Site": "same-origin",
      },
      body: JSON.stringify({ password }),
    }),
  );

  assert.equal(response.status, 200);
  const setCookie = response.headers.get("set-cookie");
  assert.ok(setCookie);
  const attributes = setCookie
    .split(";")
    .slice(1)
    .map((attribute) => attribute.trim().toLowerCase());
  assert.ok(attributes.includes("httponly"));
  assert.ok(attributes.includes("samesite=strict"));
  assert.equal(attributes.includes("secure"), false);
  assert.equal(attributes.some((attribute) => attribute.startsWith("domain=")), false);
});
