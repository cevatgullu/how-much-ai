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
      return nextResolve(
        pathToFileURL(path.join(projectRoot, path.extname(target) ? target : `${target}.ts`)).href,
        context,
      );
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

function validStrictEnvironment(): NodeJS.ProcessEnv {
  return {
    HMC_STRICT_LOCAL_MODE: "1",
    HMC_LISTEN_HOST: "127.0.0.1",
    HMC_LISTEN_PORT: "37645",
    PORT: "37645",
    NODE_ENV: "production",
    APP_PASSWORD: "p".repeat(64),
    AUTH_SECRET: "s".repeat(64),
    VAULT_ENCRYPTION_SECRET: "v".repeat(64),
    TRUST_PROXY_IP_HEADERS: "0",
    ENABLE_LOCAL_CONNECT: "1",
    VAULT_DATA_DIR: path.resolve(".strict-local-bootstrap-route-test-vault"),
    NEXT_TELEMETRY_DISABLED: "1",
  };
}

process.env = validStrictEnvironment();

const { NextRequest } = await import("next/server.js");
const { default: proxy } = await import("../proxy.ts");
const { POST: loginPost } = await import("../app/api/auth/login/route.ts");
const { POST: startPost } = await import("../app/api/auth/bootstrap/start/route.ts");
const { POST: consumePost } = await import("../app/api/auth/bootstrap/consume/route.ts");
const { beginBootstrapSession } = await import("./bootstrap-session.ts");
const { createSession, SESSION_COOKIE } = await import("./session.ts");

after(() => {
  process.env = originalEnv;
  moduleHooks.deregister();
});

function jsonRequest(
  pathname: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Request {
  return new Request(`http://127.0.0.1:37645${pathname}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Host: "127.0.0.1:37645",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

async function startTicket(): Promise<string> {
  const response = await startPost(
    jsonRequest("/api/auth/bootstrap/start", { password: process.env.APP_PASSWORD }),
  );
  assert.equal(response.status, 200);
  const data = (await response.json()) as Record<string, unknown>;
  assert.deepEqual(Object.keys(data).sort(), ["expiresInMs", "ticket"]);
  assert.equal(data.expiresInMs, 20_000);
  assert.match(data.ticket, /^[A-Za-z0-9_-]{43}$/);
  return data.ticket as string;
}

test("the three exact bootstrap paths bypass the session proxy without a broad prefix", async () => {
  process.env = validStrictEnvironment();
  for (const pathname of [
    "/bootstrap",
    "/api/auth/bootstrap/start",
    "/api/auth/bootstrap/consume",
  ]) {
    const response = await proxy(
      new NextRequest(`http://127.0.0.1:37645${pathname}`, {
        headers: { Host: "127.0.0.1:37645" },
      }),
    );
    assert.equal(response.status, 200, pathname);
    assert.equal(response.headers.get("x-middleware-next"), "1", pathname);
  }

  for (const pathname of ["/bootstrap/", "/api/auth/bootstrap/start/extra"]) {
    const response = await proxy(
      new NextRequest(`http://127.0.0.1:37645${pathname}`, {
        headers: { Host: "127.0.0.1:37645" },
      }),
    );
    assert.notEqual(response.headers.get("x-middleware-next"), "1", pathname);
  }
});

test("bootstrap start is strict-only, requires the exact Host, and rejects every Origin", async () => {
  process.env = { NODE_ENV: "production", APP_PASSWORD: "p".repeat(64) };
  let response = await startPost(
    jsonRequest("/api/auth/bootstrap/start", { password: process.env.APP_PASSWORD }),
  );
  assert.equal(response.status, 404);
  assert.equal(response.headers.get("cache-control"), "no-store");

  process.env = validStrictEnvironment();
  response = await startPost(
    jsonRequest(
      "/api/auth/bootstrap/start",
      { password: process.env.APP_PASSWORD },
      { Host: "localhost:37645" },
    ),
  );
  assert.equal(response.status, 421);

  for (const origin of ["http://127.0.0.1:37645", "https://attacker.example", "null"]) {
    response = await startPost(
      jsonRequest(
        "/api/auth/bootstrap/start",
        { password: process.env.APP_PASSWORD },
        { Origin: origin },
      ),
    );
    assert.equal(response.status, 403, origin);
  }
});

test("bootstrap start verifies the password without setting a cookie", async () => {
  process.env = validStrictEnvironment();
  const password = process.env.APP_PASSWORD;
  assert.ok(password);

  const denied = await startPost(
    jsonRequest("/api/auth/bootstrap/start", { password: `${password}x` }),
  );
  assert.equal(denied.status, 401);
  assert.equal((await denied.text()).includes(password), false);

  const response = await startPost(
    jsonRequest("/api/auth/bootstrap/start", { password }),
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("set-cookie"), null);
  const data = (await response.json()) as Record<string, unknown>;
  assert.deepEqual(Object.keys(data).sort(), ["expiresInMs", "ticket"]);
  assert.equal(data.expiresInMs, 20_000);
  assert.match(data.ticket, /^[A-Za-z0-9_-]{43}$/);
});

test("bootstrap consume requires the exact same origin, consumes once, and sets one host-only strict cookie", async () => {
  process.env = validStrictEnvironment();
  let ticket = await startTicket();
  const existingSession = await createSession();

  for (const headers of [
    { Host: "localhost:37645", Origin: "http://127.0.0.1:37645", "Sec-Fetch-Site": "same-origin" },
    { Origin: "https://attacker.example", "Sec-Fetch-Site": "cross-site" },
    { "Sec-Fetch-Site": "same-origin" },
  ]) {
    const response = await consumePost(
      jsonRequest("/api/auth/bootstrap/consume", { ticket }, headers),
    );
    assert.notEqual(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }

  const wrongTicket = await consumePost(
    jsonRequest(
      "/api/auth/bootstrap/consume",
      { ticket: "A".repeat(43) },
      { Origin: "http://127.0.0.1:37645", "Sec-Fetch-Site": "same-origin" },
    ),
  );
  assert.equal(wrongTicket.status, 401);

  const invalidatedTicket = await consumePost(
    jsonRequest(
      "/api/auth/bootstrap/consume",
      { ticket },
      { Origin: "http://127.0.0.1:37645", "Sec-Fetch-Site": "same-origin" },
    ),
  );
  assert.equal(invalidatedTicket.status, 401);
  ticket = await startTicket();

  const response = await consumePost(
    jsonRequest(
      "/api/auth/bootstrap/consume",
      { ticket },
      {
        Origin: "http://127.0.0.1:37645",
        "Sec-Fetch-Site": "same-origin",
        Cookie: `${SESSION_COOKIE}=${existingSession}`,
      },
    ),
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { ok: true });

  const setCookies = response.headers.getSetCookie();
  assert.equal(setCookies.length, 1);
  assert.match(setCookies[0], new RegExp(`^${SESSION_COOKIE}=`));
  assert.match(setCookies[0], /;\s*HttpOnly/i);
  assert.match(setCookies[0], /;\s*SameSite=Strict/i);
  assert.doesNotMatch(setCookies[0], /;\s*Secure/i);
  assert.doesNotMatch(setCookies[0], /;\s*Domain=/i);
  assert.equal(setCookies[0].includes(ticket), false);

  const replay = await consumePost(
    jsonRequest(
      "/api/auth/bootstrap/consume",
      { ticket },
      { Origin: "http://127.0.0.1:37645", "Sec-Fetch-Site": "same-origin" },
    ),
  );
  assert.equal(replay.status, 401);
  assert.equal((await replay.text()).includes(ticket), false);
});

test("an already-authenticated browser still erases, consumes, and cannot replay a new fragment", async () => {
  process.env = validStrictEnvironment();
  const ticket = await startTicket();
  const existingSession = await createSession();
  const events: string[] = [];
  const location = {
    pathname: "/bootstrap",
    search: "",
    hash: `#bootstrap=${ticket}`,
    replace(destination: string) {
      events.push(`replace:${destination}`);
    },
  };
  const history = {
    replaceState(_data: unknown, _unused: string, destination?: string | URL | null) {
      events.push(`history:${String(destination)}`);
      location.hash = "";
    },
  };

  const attempt = beginBootstrapSession({
    location,
    history,
    fetch: async (input, init) => {
      events.push("fetch");
      assert.deepEqual(events.slice(0, 2), ["history:/bootstrap", "fetch"]);
      const request = new Request(new URL(String(input), "http://127.0.0.1:37645"), {
        ...init,
        headers: {
          ...Object.fromEntries(new Headers(init?.headers)),
          Host: "127.0.0.1:37645",
          Origin: "http://127.0.0.1:37645",
          "Sec-Fetch-Site": "same-origin",
          Cookie: `${SESSION_COOKIE}=${existingSession}`,
        },
      });
      return consumePost(request);
    },
  });

  assert.equal(attempt.started, true);
  assert.equal(location.hash, "");
  assert.deepEqual(events, ["history:/bootstrap", "fetch"]);
  assert.equal(await attempt.completion, true);
  assert.deepEqual(events, ["history:/bootstrap", "fetch", "replace:/"]);

  const replay = await consumePost(
    jsonRequest(
      "/api/auth/bootstrap/consume",
      { ticket },
      { Origin: "http://127.0.0.1:37645", "Sec-Fetch-Site": "same-origin" },
    ),
  );
  assert.equal(replay.status, 401);
});

test("ordinary login and bootstrap start share one rate-limit bucket", async () => {
  process.env = validStrictEnvironment();
  const wrong = "not-the-password";

  for (let attempt = 0; attempt < 5; attempt++) {
    const handler = attempt % 2 === 0 ? loginPost : startPost;
    const pathname =
      attempt % 2 === 0 ? "/api/auth/login" : "/api/auth/bootstrap/start";
    const headers =
      attempt % 2 === 0
        ? { Origin: "http://127.0.0.1:37645", "Sec-Fetch-Site": "same-origin" }
        : {};
    const response = await handler(jsonRequest(pathname, { password: wrong }, headers));
    assert.equal(response.status, 401, `attempt ${attempt + 1}`);
  }

  const blocked = await startPost(
    jsonRequest("/api/auth/bootstrap/start", { password: process.env.APP_PASSWORD }),
  );
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get("retry-after")) >= 1);
  assert.equal(blocked.headers.get("cache-control"), "no-store");
});
