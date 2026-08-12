import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement, type ComponentType } from "react";
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
const openAIDeviceLoginModule = await import("../components/OpenAIDeviceLogin.tsx") as unknown as Record<string, unknown>;
const { PROVIDER_META } = await import("../components/providers-ui.tsx");
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

function validOrdinaryProductionEnvironment(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production",
    APP_PASSWORD: "p".repeat(64),
    AUTH_SECRET: "s".repeat(64),
    VAULT_ENCRYPTION_SECRET: "v".repeat(64),
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
  assert.match(strictMarkup, /güvenli başlatıcıdan açın/i);
  assert.doesNotMatch(strictMarkup, /<input/i);

  process.env = validOrdinaryProductionEnvironment();
  const ordinaryPage = LoginPage() as { props: { strictLocal: boolean } };
  assert.equal(ordinaryPage.props.strictLocal, false);
  const ordinaryMarkup = renderToStaticMarkup(PasswordLogin(ordinaryPage.props));
  assert.match(ordinaryMarkup, /type="password"/i);
  assert.match(ordinaryMarkup, /autocomplete="off"/i);
});

test("the bootstrap page renders its consumer only in validated strict-local mode", () => {
  process.env = validOrdinaryProductionEnvironment();
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
  process.env = validOrdinaryProductionEnvironment();
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
  assert.match(markup, /güvenli claude bağlantınız tamamlanıyor/i);
  assert.doesNotMatch(markup, /textarea|input|authorization code|account id/i);
});

test("strict dashboard connection UI renders the Claude PKCE form without a launcher-only dead end", () => {
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
  assert.match(strictMarkup, /güvenli claude oturum açma sayfasını aç/i);
  assert.match(strictMarkup, /claude yetkilendirme kodu/i);
  assert.match(strictMarkup, /<textarea/i);
  assert.doesNotMatch(strictMarkup, /use the secure claude connector/i);
  assert.doesNotMatch(strictMarkup, /use my existing claude code login|claude code credentials/i);

  const ordinaryMarkup = renderToStaticMarkup(
    createElement(AddAccountModal, { ...sharedProps, strictLocal: false }),
  );
  assert.match(ordinaryMarkup, /bu pano için özel oturumu yetkilendir/i);
  assert.match(ordinaryMarkup, /yetkilendirme kodunu yapıştır/i);
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

  assert.match(strictOpenAiMarkup, /özel chatgpt oturumunu bağla/i);
  assert.match(strictOpenAiMarkup, /özel uygulama oturumu · otomatik yenilenir/i);
  assert.match(
    strictOpenAiMarkup,
    /<details(?![^>]*\bopen\b)[^>]*>[\s\S]*<summary[^>]*>[\s\S]*eski paylaşılan cli oturumu/i,
  );
  assert.match(strictOpenAiMarkup, /codex cli yenilemesi panonun bağlantısını kesebilir/i);
  assert.match(strictOpenAiMarkup, /chatgpt oturumunu bu makineden oku/i);
  assert.doesNotMatch(
    strictOpenAiMarkup,
    /paste your ~\/\.codex\/auth\.json|<textarea/i,
  );
});

test("ordinary OpenAI selection keeps credential import inside the secondary legacy disclosure", () => {
  const markup = renderToStaticMarkup(
    createElement(AddAccountModal, {
      open: true,
      strictLocal: false,
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

  assert.match(markup, /özel chatgpt oturumunu bağla/i);
  assert.match(markup, /eski paylaşılan cli oturumu/i);
  assert.match(markup, /paste your ~\/\.codex\/auth\.json/i);
  assert.match(markup, /<textarea/i);
});

test("OpenAI provider metadata advertises private login support", () => {
  assert.equal(PROVIDER_META.openai.supportsPrivateLogin, true);
});

test("the private ChatGPT starting state provides an explicit cancel action", () => {
  const StartingState = openAIDeviceLoginModule.OpenAIDeviceLoginStartingState;
  assert.equal(typeof StartingState, "function");
  if (typeof StartingState !== "function") return;

  const markup = renderToStaticMarkup(createElement(
    StartingState as ComponentType<{ onCancel(): void }>,
    { onCancel() {} },
  ));
  assert.match(markup, /role="status"[^>]*>[^<]*<svg[\s\S]*tek kullanımlık kod alınıyor/i);
  assert.match(markup, /<button[^>]*type="button"[^>]*>[\s\S]*oturum açmayı iptal et[\s\S]*<\/button>/i);
});

test("document and visual system expose the Turkish local instrument contract", () => {
  const layout = readFileSync(path.join(projectRoot, "app", "layout.tsx"), "utf8");
  const css = readFileSync(path.join(projectRoot, "app", "globals.css"), "utf8");
  assert.match(layout, /<html lang="tr"/);
  assert.match(layout, /viewportFit:\s*"cover"/);
  assert.match(layout, /Barlow_Condensed/);
  assert.match(layout, /Atkinson_Hyperlegible_Next/);
  assert.match(layout, /Atkinson_Hyperlegible_Mono/);
  assert.doesNotMatch(layout, /manifest|appleWebApp/i);
  for (const token of ["#111614", "#19201D", "#697770", "#F1F4EF", "#A5B1AA", "#78A7BF", "#D97757", "#D9A557", "#E05B5B"]) {
    assert.match(css, new RegExp(token, "i"));
  }
  assert.match(css, /@media \(max-width: 959px\)/);
  assert.match(css, /@media \(min-width: 960px\) and \(max-width: 1919px\)/);
  assert.match(css, /@media \(min-width: 1920px\) and \(max-width: 2879px\)/);
  assert.match(css, /@media \(min-width: 2880px\)/);
  assert.match(css, /orientation:\s*landscape[^\{]*min-width:\s*900px[^\{]*max-height:\s*500px/);
  assert.match(css, /env\(safe-area-inset-(?:top|right|bottom|left)\)/);
  assert.doesNotMatch(css, /(?:radial|linear)-gradient|backdrop-filter|card-lift|@keyframes shimmer/i);
});
