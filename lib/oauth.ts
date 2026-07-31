// Browser-side PKCE helpers for a Claude subscription login owned only by this app.
// The user authorizes once, then the server exchanges the single-use code and stores the
// renewable credential in the encrypted vault. The verifier is not a credential and never leaves
// this browser except for the one authenticated exchange request.

export const CLAUDE_OAUTH = {
  clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  authorizeUrl: "https://claude.com/cai/oauth/authorize",
  redirectUri: "https://platform.claude.com/oauth/code/callback",
  // Least privilege for the two endpoints this product calls. The same public client supports a
  // one-scope inference-only grant; adding user:profile is what Anthropic's usage endpoint requires.
  scopes: "user:profile user:inference",
} as const;

export interface PkceBundle {
  verifier: string;
  challenge: string;
  state: string;
  createdAt: number;
}

const PKCE_KEY = "usage.pkce.v2";
const PKCE_MAX_AGE_MS = 30 * 60_000;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const CALLBACK_ORIGIN = "https://platform.claude.com";
const CALLBACK_PATH = "/oauth/code/callback";
const CALLBACK_CODE_MAX_LENGTH = 4 * 1024;
const CALLBACK_STATE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function validBundle(value: unknown, now = Date.now()): value is PkceBundle {
  if (!value || typeof value !== "object") return false;
  const bundle = value as Partial<PkceBundle>;
  return Boolean(
    typeof bundle.verifier === "string" &&
      bundle.verifier.length >= 43 &&
      bundle.verifier.length <= 128 &&
      BASE64URL_PATTERN.test(bundle.verifier) &&
      typeof bundle.challenge === "string" &&
      bundle.challenge.length >= 43 &&
      bundle.challenge.length <= 128 &&
      BASE64URL_PATTERN.test(bundle.challenge) &&
      typeof bundle.state === "string" &&
      bundle.state.length >= 32 &&
      bundle.state.length <= 128 &&
      BASE64URL_PATTERN.test(bundle.state) &&
      typeof bundle.createdAt === "number" &&
      Number.isFinite(bundle.createdAt) &&
      bundle.createdAt <= now &&
      now - bundle.createdAt <= PKCE_MAX_AGE_MS,
  );
}

export async function createPkce(now = Date.now()): Promise<PkceBundle> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return {
    verifier,
    challenge: base64url(new Uint8Array(digest)),
    state: base64url(crypto.getRandomValues(new Uint8Array(32))),
    createdAt: now,
  };
}

export async function loadOrCreatePkce(): Promise<PkceBundle> {
  if (typeof window !== "undefined") {
    try {
      const stored = window.sessionStorage.getItem(PKCE_KEY);
      if (stored) {
        const parsed: unknown = JSON.parse(stored);
        if (validBundle(parsed)) return parsed;
      }
    } catch {
      // Create a fresh bundle below when storage is unavailable or malformed.
    }
  }

  const bundle = await createPkce();
  if (typeof window !== "undefined") {
    try {
      window.sessionStorage.setItem(PKCE_KEY, JSON.stringify(bundle));
    } catch {
      // The in-memory bundle remains usable for this open modal.
    }
  }
  return bundle;
}

export function clearPkce(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(PKCE_KEY);
  } catch {
    // Nothing else is required; authorization codes are single-use.
  }
}

export function buildAuthorizeUrl(bundle: PkceBundle): string {
  return buildAuthorizeUrlFromChallenge(bundle.challenge, bundle.state);
}

export function buildAuthorizeUrlFromChallenge(
  challenge: string,
  state: string,
): string {
  const params = new URLSearchParams({
    code: "true",
    client_id: CLAUDE_OAUTH.clientId,
    response_type: "code",
    redirect_uri: CLAUDE_OAUTH.redirectUri,
    scope: CLAUDE_OAUTH.scopes,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  });
  return `${CLAUDE_OAUTH.authorizeUrl}?${params.toString()}`;
}

export interface OAuthCallbackValue {
  code: string;
  state: string;
}

function validCallbackCode(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= CALLBACK_CODE_MAX_LENGTH &&
    !/[\u0000-\u0020\u007f]/.test(value) &&
    !value.includes("#")
  );
}

function parseCallbackBody(raw: string): OAuthCallbackValue | null {
  const trimmed = raw.trim();
  const separator = trimmed.indexOf("#");
  if (separator <= 0 || separator !== trimmed.lastIndexOf("#")) return null;
  const code = trimmed.slice(0, separator);
  const state = trimmed.slice(separator + 1);
  return validCallbackCode(code) && CALLBACK_STATE_PATTERN.test(state)
    ? { code, state }
    : null;
}

function parseCallbackUrl(url: URL): OAuthCallbackValue | null {
  if (
    url.origin !== CALLBACK_ORIGIN ||
    url.pathname !== CALLBACK_PATH ||
    url.username !== "" ||
    url.password !== ""
  ) {
    return null;
  }
  const keys = [...url.searchParams.keys()];
  if (
    keys.some((key) => key !== "code" && key !== "state") ||
    url.searchParams.getAll("code").length !== 1 ||
    url.searchParams.getAll("state").length > 1
  ) {
    return null;
  }
  const code = url.searchParams.get("code") ?? "";
  const queryStates = url.searchParams.getAll("state");
  if (!validCallbackCode(code)) return null;

  let state: string;
  if (queryStates.length === 1) {
    if (url.hash !== "") return null;
    state = queryStates[0];
  } else {
    if (!url.hash.startsWith("#")) return null;
    state = url.hash.slice(1);
  }
  return CALLBACK_STATE_PATTERN.test(state) ? { code, state } : null;
}

// Accept only the exact provider callback URL or the provider page's complete `code#state` body.
// URL-shaped lookalikes never fall through to the body grammar.
export function parseOAuthCallbackRepresentation(raw: string): OAuthCallbackValue | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    return parseCallbackUrl(url);
  } catch {
    return parseCallbackBody(trimmed);
  }
}

// The extension passes both the exact current URL and the whole visible body. A malformed URL
// representation is terminal; body fallback is allowed only when the callback URL has no payload.
export function parseOAuthProviderCallback(
  href: string,
  visibleBody: string,
): OAuthCallbackValue | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (
    url.origin !== CALLBACK_ORIGIN ||
    url.pathname !== CALLBACK_PATH ||
    url.username !== "" ||
    url.password !== ""
  ) {
    return null;
  }
  if (url.search !== "" || url.hash !== "") return parseCallbackUrl(url);
  if (href !== `${CALLBACK_ORIGIN}${CALLBACK_PATH}`) return null;
  return parseCallbackBody(visibleBody);
}

// Legacy non-strict UI compatibility. Strict-local mode never renders or executes this path.
export function parsePastedCode(raw: string): { code: string; state?: string } {
  return parseOAuthCallbackRepresentation(raw) ?? { code: "" };
}
