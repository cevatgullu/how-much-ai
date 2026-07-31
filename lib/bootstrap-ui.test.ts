import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { transformSync } from "next/dist/build/swc/index.js";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const navigationModule = `data:text/javascript,${encodeURIComponent(`
  export function redirect(path) {
    const error = new Error("redirect");
    error.destination = path;
    throw error;
  }
  export function useRouter() {
    return { replace() {}, refresh() {} };
  }
  export function useSearchParams() {
    return new URLSearchParams();
  }
`)}`;

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
    if (specifier === "next/navigation") {
      return { url: navigationModule, shortCircuit: true };
    }
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

const originalEnv = { ...process.env };
const { beginBootstrapSession } = await import("./bootstrap-session.ts");
const { PasswordLogin } = await import("../components/PasswordLogin.tsx");
const { default: LoginPage } = await import("../app/login/page.tsx");
const { default: BootstrapPage } = await import("../app/bootstrap/page.tsx");
const { default: OAuthCallbackPage } = await import(
  "../app/oauth/callback/page.tsx"
);
const { AddAccountModal } = await import("../components/AddAccountModal.tsx");
const { default: HomePage } = await import("../app/page.tsx");

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
    APP_PASSWORD: "p".repeat(64),
    AUTH_SECRET: "s".repeat(64),
    VAULT_ENCRYPTION_SECRET: "v".repeat(64),
    TRUST_PROXY_IP_HEADERS: "0",
    ENABLE_LOCAL_CONNECT: "1",
    VAULT_DATA_DIR: path.resolve(".strict-local-bootstrap-ui-test-vault"),
    NEXT_TELEMETRY_DISABLED: "1",
  };
}

test("bootstrap fragment removal is synchronous even when the fragment is malformed", async () => {
  const events: string[] = [];
  const location = {
    pathname: "/bootstrap",
    search: "",
    hash: "#bootstrap=not-a-ticket",
    replace(destination: string) {
      events.push(`replace:${destination}`);
    },
  };
  const attempt = beginBootstrapSession({
    location,
    history: {
      replaceState(_data: unknown, _unused: string, destination?: string | URL | null) {
        events.push(`history:${String(destination)}`);
        location.hash = "";
      },
    },
    fetch: async () => {
      events.push("fetch");
      return new Response(null, { status: 500 });
    },
  });

  assert.equal(attempt.started, false);
  assert.equal(location.hash, "");
  assert.deepEqual(events, ["history:/bootstrap"]);
  assert.equal(await attempt.completion, false);
});

test("strict login renders launcher guidance without a password input while ordinary login keeps the form", () => {
  process.env = validStrictEnvironment();
  const strictPage = LoginPage() as { props: { strictLocal: boolean } };
  assert.equal(strictPage.props.strictLocal, true);
  const strictMarkup = renderToStaticMarkup(PasswordLogin(strictPage.props));
  assert.match(strictMarkup, /open how much ai from its secure launcher/i);
  assert.doesNotMatch(strictMarkup, /<input/i);

  process.env = { NODE_ENV: "production", APP_PASSWORD: "ordinary-password" };
  const ordinaryPage = LoginPage() as { props: { strictLocal: boolean } };
  assert.equal(ordinaryPage.props.strictLocal, false);
  const ordinaryMarkup = renderToStaticMarkup(PasswordLogin(ordinaryPage.props));
  assert.match(ordinaryMarkup, /type="password"/i);
  assert.match(ordinaryMarkup, /autocomplete="off"/i);
});

test("the bootstrap page renders its consumer only in validated strict-local mode", () => {
  process.env = { NODE_ENV: "production", APP_PASSWORD: "ordinary-password" };
  assert.throws(
    () => BootstrapPage(),
    (error: unknown) =>
      error instanceof Error &&
      (error as Error & { destination?: string }).destination === "/login",
  );

  process.env = validStrictEnvironment();
  const page = BootstrapPage() as { type?: { name?: string } };
  assert.equal(page.type?.name, "BootstrapSession");
});

test("the OAuth callback page is strict-only and renders only generic completion state", () => {
  process.env = { NODE_ENV: "production", APP_PASSWORD: "ordinary-password" };
  assert.throws(
    () => OAuthCallbackPage(),
    (error: unknown) =>
      error instanceof Error &&
      (error as Error & { destination?: string }).destination === "/login",
  );

  process.env = validStrictEnvironment();
  const page = OAuthCallbackPage() as { type?: { name?: string } };
  assert.equal(page.type?.name, "OAuthCallbackSession");
  const markup = renderToStaticMarkup(
    page as Parameters<typeof renderToStaticMarkup>[0],
  );
  assert.match(markup, /completing your secure claude connection/i);
  assert.doesNotMatch(markup, /textarea|input|authorization code|account id/i);
});

test("strict dashboard connection UI delegates Claude to the connector and never renders browser PKCE or paste controls", () => {
  process.env = validStrictEnvironment();
  const page = HomePage() as { props?: Record<string, unknown> };
  assert.equal(page.props?.strictLocal, true);

  const sharedProps = {
    open: true,
    onClose() {},
    onServerConnected() {},
  };
  const strictMarkup = renderToStaticMarkup(
    createElement(AddAccountModal, { ...sharedProps, strictLocal: true }),
  );
  assert.match(strictMarkup, /secure claude connector/i);
  assert.doesNotMatch(
    strictMarkup,
    /authorization code|preparing secure sign-in|claude-credentials|private app login/i,
  );
  assert.doesNotMatch(strictMarkup, /<textarea/i);

  const ordinaryMarkup = renderToStaticMarkup(
    createElement(AddAccountModal, { ...sharedProps, strictLocal: false }),
  );
  assert.match(ordinaryMarkup, /authorize a private login/i);
  assert.match(ordinaryMarkup, /paste the authorization code/i);
  assert.match(ordinaryMarkup, /<textarea/i);
});

test("strict OpenAI selection keeps the same-machine action and never renders credential paste", () => {
  process.env = validStrictEnvironment();
  const strictOpenAiMarkup = renderToStaticMarkup(
    createElement(AddAccountModal, {
      open: true,
      strictLocal: true,
      onClose() {},
      onServerConnected() {},
      reconnectAccount: {
        id: "openai-account",
        email: "account@example.invalid",
        plan: "ChatGPT Pro",
        addedAt: 1,
        credentialKind: "managed",
        provider: "openai",
        credentialExpiresAt: 2,
      },
    }),
  );

  assert.match(strictOpenAiMarkup, /read chatgpt login from this machine/i);
  assert.doesNotMatch(
    strictOpenAiMarkup,
    /paste your ~\/\.codex\/auth\.json|<textarea/i,
  );
});
