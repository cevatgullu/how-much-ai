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
const addAccountModalModule = await import("../components/AddAccountModal.tsx");
const {
  AddAccountModal,
  AddAccountSuccessCard,
  ClaudeLocalMachinePanel,
  ClaudePairingPanel,
  OpenAILocalMachinePanel,
  strictLocalClaudeConnectionErrorText,
  strictLocalOpenAILocalConnectionErrorText,
} = addAccountModalModule;
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
  assert.match(strictMarkup, /önerilen · bir kez bağla · otomatik yenilenir/i);
  assert.match(strictMarkup, /bu makinedeki geçerli oturumu kullan/i);
  assert.match(strictMarkup, /kimlik bilgileri şifreli yerel kasanızda saklanır/i);
  assert.doesNotMatch(strictMarkup, /recommended|use the claude code login|use this machine|credentials are encrypted/i);
  assert.doesNotMatch(strictMarkup, /use the secure claude connector/i);
  assert.doesNotMatch(strictMarkup, /use my existing claude code login|claude code credentials/i);

  const ordinaryMarkup = renderToStaticMarkup(
    createElement(AddAccountModal, { ...sharedProps, strictLocal: false }),
  );
  assert.match(ordinaryMarkup, /bu pano için özel oturumu yetkilendir/i);
  assert.match(ordinaryMarkup, /yetkilendirme kodunu yapıştır/i);
  assert.match(ordinaryMarkup, /<textarea/i);
});

test("strict-local add-account success, machine, and pairing branches render Turkish controls and statuses", () => {
  assert.equal(typeof AddAccountSuccessCard, "function");
  assert.equal(typeof ClaudeLocalMachinePanel, "function");
  assert.equal(typeof ClaudePairingPanel, "function");
  if (
    typeof AddAccountSuccessCard !== "function"
    || typeof ClaudeLocalMachinePanel !== "function"
    || typeof ClaudePairingPanel !== "function"
  ) return;

  const success = renderToStaticMarkup(createElement(AddAccountSuccessCard, {
    strictLocal: true,
    connected: { email: "private@example.invalid", label: "Araştırma", plan: "Max" },
    completionError: null,
    onRetry() {},
  }));
  assert.match(success, /Araştırma bağlandı/);
  assert.match(success, /kimlik bilgisi güvenle kaydedildi\. Pano eşitleniyor/i);
  assert.doesNotMatch(success, /connected|credential|dashboard/i);

  const successError = renderToStaticMarkup(createElement(AddAccountSuccessCard, {
    strictLocal: true,
    connected: { email: "private@example.invalid", label: "Araştırma" },
    completionError: "Hesap bağlandı, ancak pano yeniden yüklenemedi.",
    onRetry() {},
  }));
  assert.match(successError, />Pano eşitlemesini yeniden dene</);

  const hostedSuccess = renderToStaticMarkup(createElement(AddAccountSuccessCard, {
    strictLocal: false,
    connected: { email: "private@example.invalid", label: "Research" },
    completionError: null,
    onRetry() {},
  }));
  assert.match(hostedSuccess, /Connected Research/);
  assert.match(hostedSuccess, /Kimlik bilgisi güvenle kaydedildi\. Pano eşitleniyor/i);

  const machine = renderToStaticMarkup(createElement(ClaudeLocalMachinePanel, {
    strictLocal: true,
    busy: false,
    working: false,
    error: null,
    onConnect() {},
  }));
  assert.match(machine, /bu bilgisayardaki claude code oturumunu okuyacağız/i);
  assert.match(machine, />Bu makineden bağlan</);
  assert.doesNotMatch(machine, /we(?:&#x27;|')ll|connect from/i);

  const hostedMachine = renderToStaticMarkup(createElement(ClaudeLocalMachinePanel, {
    strictLocal: false,
    busy: false,
    working: false,
    error: null,
    onConnect() {},
  }));
  assert.match(hostedMachine, /bu bilgisayardaki claude code oturumunu okuyacağız/i);
  assert.match(hostedMachine, />Bu makineden bağlan</);

  const pairingStates = ["starting", "waiting", "processing", "expired", "error"] as const;
  for (const state of pairingStates) {
    const pairing = renderToStaticMarkup(createElement(ClaudePairingPanel, {
      strictLocal: true,
      state,
      command: state === "waiting" || state === "processing" ? "npx helper" : "",
      error: state === "error" ? "Eşleştirme hizmetine ulaşılamadı." : null,
      busy: false,
      copied: false,
      onCopy() {},
      onRetry() {},
    }));
    assert.match(pairing, /hesabın açık olduğu yerde tek bir komut çalıştır/i);
    assert.doesNotMatch(pairing, /run one command|getting|waiting|account verified|try again|>copy</i);
  }

  const hostedPairing = renderToStaticMarkup(createElement(ClaudePairingPanel, {
    strictLocal: false,
    state: "starting",
    command: "",
    error: null,
    busy: false,
    copied: false,
    onCopy() {},
    onRetry() {},
  }));
  assert.match(hostedPairing, /Hesabın açık olduğu yerde tek bir komut çalıştır/);
  assert.match(hostedPairing, /Tek kullanımlık eşleştirme kodu alınıyor/);
});

test("strict-local Claude failures discard server detail and retain only a validated opaque reference", () => {
  assert.equal(typeof strictLocalClaudeConnectionErrorText, "function");
  if (typeof strictLocalClaudeConnectionErrorText !== "function") return;
  assert.equal(
    strictLocalClaudeConnectionErrorText(401, "AnthropicError: private upstream detail", "err_0123456789ab"),
    "Claude yetkilendirme kodu kabul edilmedi. Yeni bir oturum açıp yeniden deneyin. Referans: err_0123456789ab.",
  );
  for (const malformed of ["err_0123456789ab\nsecret", "ERR_0123456789AB", "err_0123456789abc", null]) {
    const message = strictLocalClaudeConnectionErrorText(502, "AnthropicError: private upstream detail", malformed);
    assert.equal(message, "Claude bağlantısı tamamlanamadı. Yeniden deneyin.");
    assert.doesNotMatch(message, /AnthropicError|private upstream detail|secret/);
  }
});

test("strict-local OpenAI same-machine details, actions, and failures stay Turkish and generic", () => {
  assert.equal(typeof OpenAILocalMachinePanel, "function");
  assert.equal(typeof strictLocalOpenAILocalConnectionErrorText, "function");
  if (
    typeof OpenAILocalMachinePanel !== "function"
    || typeof strictLocalOpenAILocalConnectionErrorText !== "function"
  ) return;

  const ready = renderToStaticMarkup(createElement(OpenAILocalMachinePanel, {
    strictLocal: true,
    busy: false,
    working: false,
    error: null,
    onConnect() {},
  }));
  assert.match(ready, /bu bilgisayardaki codex oturumunu oku/i);
  assert.match(ready, /codex cli(?:&#x27;|')ın bu makinedeki/i);
  assert.match(ready, />ChatGPT oturumunu bu makineden oku</);
  assert.doesNotMatch(ready, /read the codex login|connection timed out|network error/i);

  const working = renderToStaticMarkup(createElement(OpenAILocalMachinePanel, {
    strictLocal: true,
    busy: true,
    working: true,
    error: null,
    onConnect() {},
  }));
  assert.match(working, />Okunuyor…</);

  const cases = [
    ["provider", "Bu makinedeki Codex oturumu okunamadı. Referans: err_abcdef012345."],
    ["timeout", "Codex oturumunu okuma işlemi zaman aşımına uğradı. Yeniden deneyin."],
    ["network", "Codex oturumu okunamadı. Uygulamanın çalıştığını denetleyip yeniden deneyin."],
  ] as const;
  for (const [kind, expected] of cases) {
    const message = strictLocalOpenAILocalConnectionErrorText(
      kind,
      "OpenAIError: private upstream detail",
      kind === "provider" ? "err_abcdef012345" : null,
    );
    assert.equal(message, expected);
    const failed = renderToStaticMarkup(createElement(OpenAILocalMachinePanel, {
      strictLocal: true,
      busy: false,
      working: false,
      error: { message },
      onConnect() {},
    }));
    assert.match(failed, /role="alert"/);
    assert.match(failed, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
    assert.doesNotMatch(failed, /OpenAIError|private upstream detail|connection timed out|network error/i);
  }

  for (const malformed of ["err_abcdef012345\nsecret", "ERR_ABCDEF012345", "err_abcdef0123456", null]) {
    const message = strictLocalOpenAILocalConnectionErrorText(
      "provider",
      "OpenAIError: private upstream detail",
      malformed,
    );
    assert.equal(message, "Bu makinedeki Codex oturumu okunamadı.");
    assert.doesNotMatch(message, /OpenAIError|private upstream detail|secret|Referans/);
  }

  const hosted = renderToStaticMarkup(createElement(OpenAILocalMachinePanel, {
    strictLocal: false,
    busy: false,
    working: false,
    error: { message: "Hosted upstream detail" },
    onConnect() {},
  }));
  assert.match(hosted, /Hosted upstream detail/);
  assert.match(hosted, />ChatGPT oturumunu bu makineden oku</);
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
    /~\/\.codex\/auth\.json içeriğini yapıştırın|<textarea/i,
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
  assert.match(markup, /~\/\.codex\/auth\.json içeriğini yapıştırın/i);
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
  // The manifest is a route (app/manifest.ts), not layout metadata, so the document itself
  // stays free of install plumbing while the shell is still installable on a phone.
  assert.doesNotMatch(layout, /appleWebApp/i);
  for (const token of ["#111614", "#19201D", "#697770", "#F1F4EF", "#A5B1AA", "#78A7BF", "#D97757", "#D9A557", "#E05B5B"]) {
    assert.match(css, new RegExp(token, "i"));
  }
  assert.match(css, /@media \(max-width: 959\.98px\)/);
  assert.match(css, /@media \(min-width: 960px\) and \(max-width: 1919\.98px\)/);
  assert.match(css, /@media \(min-width: 1920px\) and \(max-width: 2879\.98px\)/);
  assert.match(css, /@media \(min-width: 2880px\)/);
  assert.match(css, /orientation:\s*landscape[^\{]*min-width:\s*900px[^\{]*max-height:\s*500px/);
  assert.match(css, /env\(safe-area-inset-(?:top|right|bottom|left)\)/);
  assert.match(
    css,
    /@media \(min-width: 960px\) and \(max-width: 1919\.98px\)[\s\S]*?\.instrument-shell\s*\{[^}]*width:\s*calc\(100% - 2 \* clamp\(24px, 4vw, 64px\)\)[^}]*margin-inline:\s*auto[^}]*\}[\s\S]*?padding-inline:\s*env\(safe-area-inset-left\) env\(safe-area-inset-right\)/,
  );
  assert.match(
    css,
    /@media \(min-width: 1920px\) and \(max-width: 2879\.98px\)[\s\S]*?\.instrument-shell\s*\{[^}]*width:\s*min\(3264px, 90vw\)[^}]*margin-inline:\s*auto[^}]*\}[\s\S]*?padding-inline:\s*env\(safe-area-inset-left\) env\(safe-area-inset-right\)/,
  );
  assert.match(
    css,
    /@media \(min-width: 2880px\)[\s\S]*?\.instrument-shell\s*\{[^}]*width:\s*min\(3264px, 90vw\)[^}]*margin-inline:\s*auto[^}]*\}[\s\S]*?padding-inline:\s*env\(safe-area-inset-left\) env\(safe-area-inset-right\)/,
  );
  // Regression guard for the fractional-pixel gap: an integer upper bound adjacent to the next
  // breakpoint's integer min-width leaves fractional viewports matching no query at all, which
  // collapses the grid to the one-column base rule.
  assert.doesNotMatch(css, /max-width:\s*(?:959|1919|2879)px/);
  assert.doesNotMatch(css, /(?:radial|linear)-gradient|backdrop-filter|card-lift|@keyframes shimmer/i);
});
