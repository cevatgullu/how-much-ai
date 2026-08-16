// Grok (SuperGrok) provider.
//
// WHY THIS USES A SESSION COOKIE AND NOT OAUTH
// --------------------------------------------
// The obvious design — mirror the Codex reader and consume the official CLI's OAuth token from
// ~/.grok/auth.json — was built and tested first. It does not work, and the reason is a
// deliberate policy on xAI's side rather than a missing scope. Measured 2026-08-13 with a live
// Grok CLI 1.0.3 token on a SuperGrok Plus account:
//
//   GET  /rest/subscriptions   Bearer -> 200
//   POST /rest/modes           Bearer -> 200
//   GET  /rest/user-settings   Bearer -> 200
//   GET  api.x.ai/v1/models    Bearer -> 200
//   POST /rest/rate-limits     Bearer -> 403
//        {"code":7,"message":"Action cannot be performed by OAuth2 token users.
//         [WKE=unauthorized:oauth2-auth-forbidden]"}
//
// Every endpoint answers an OAuth token except the ones that carry quota, which is exactly the
// number this app exists to show. Do not "fix" this by reintroducing the CLI token: it will
// authenticate fine and then 403 on the only calls that matter.
//
// The browser session (`sso`, HttpOnly) is therefore the credential. It also serves identity and
// plan, so the account needs one credential rather than two. The cost is honest and should be
// surfaced in the UI: an `sso` cookie is full account authority, not a scoped token, and it
// expires without a refresh path — the account goes to reauth and the user pastes a new one.
//
// Endpoints and payload shapes verified live; see docs/provider-research-grok.md.

import { ProviderError } from "./types";
import type { Provider, ProviderProfile } from "./types";
import type { AccountTokens, UsageData } from "../types";
import {
  grokCreditsReadingIsEmpty,
  grpcWebEmptyRequest,
  normalizeGrokCredits,
  readGrokCreditsJson,
  readGrokCreditsProto,
  type GrokCreditsReading,
} from "./grok-credits";

const ORIGIN = "https://grok.com";
// The Grok CLI's own billing facade. Same GrokCreditsConfig payload as the gRPC method below, but
// served as plain JSON to a bearer token — which is the only credential it accepts.
const CLI_BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const SUBSCRIPTIONS_URL = `${ORIGIN}/rest/subscriptions`;
const SESSION_URL = `${ORIGIN}/api/auth/session`;
// The weekly pool the Settings -> Usage panel reads. See the note at the top of grok-credits.ts.
const CREDITS_URL = `${ORIGIN}/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig`;
const USER_AGENT = "how-much-ai/0.1.0";
const TIMEOUT_MS = 15_000;

export function grokPlanLabel(tier: string | null | undefined): string {
  switch ((tier ?? "").toUpperCase()) {
    case "SUBSCRIPTION_TIER_SUPER_GROK_HEAVY":
      return "SuperGrok Heavy";
    case "SUBSCRIPTION_TIER_SUPER_GROK_PLUS":
      return "SuperGrok Plus";
    case "SUBSCRIPTION_TIER_GROK_PRO":
      return "SuperGrok";
    case "":
      return "Grok";
    default:
      return "Grok";
  }
}

function cookieHeader(tokens: AccountTokens): string {
  const value = tokens.accessToken.trim();
  if (!value) throw new ProviderError("Grok oturumu boş.", 401, "grok");
  return value.includes("=") ? value : `sso=${value}`;
}

const JWT_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;

/**
 * Which credential this account holds, and therefore which quota source can answer for it.
 *
 * Both exist because neither covers every install. The hosted deployment cannot read a file on the
 * user's machine, so it takes a pasted `sso` cookie; a local install has the CLI's token sitting in
 * ~/.grok/auth.json and should use it, because a bearer is a scoped, refreshable credential and a
 * session cookie is full account authority that expires with no way to renew it.
 */
export function grokCredentialKind(accessToken: string): "cookie" | "bearer" {
  return JWT_PATTERN.test(accessToken.trim()) ? "bearer" : "cookie";
}

/** Pull the first usable token out of a pasted ~/.grok/auth.json. */
export function grokTokenFromAuthFile(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const candidates: unknown[] = [payload, ...Object.values(payload as Record<string, unknown>)];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const entry = candidate as { key?: unknown; access_token?: unknown; accessToken?: unknown };
    for (const value of [entry.key, entry.access_token, entry.accessToken]) {
      if (typeof value === "string" && JWT_PATTERN.test(value.trim())) return value.trim();
    }
  }
  return null;
}

/** Identity claims from a bearer token. Display only — never trusted for authorisation. */
export function grokBearerClaims(token: string): { sub: string; email: string } {
  try {
    const segment = token.split(".")[1] ?? "";
    let base64 = segment.replace(/-/gu, "+").replace(/_/gu, "/");
    base64 += "=".repeat((4 - (base64.length % 4)) % 4);
    const payload = JSON.parse(Buffer.from(base64, "base64").toString("utf8")) as Record<string, unknown>;
    return {
      sub: typeof payload.sub === "string" ? payload.sub : "",
      email: typeof payload.email === "string" ? payload.email : "",
    };
  } catch {
    return { sub: "", email: "" };
  }
}

async function grokFetch(
  url: string,
  tokens: AccountTokens,
  body?: unknown,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        cookie: cookieHeader(tokens),
        "content-type": "application/json",
        "user-agent": USER_AGENT,
        accept: "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
      cache: "no-store",
    });
  } catch {
    throw new ProviderError("Grok'a ulaşılamadı.", 0, "grok");
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 401 || res.status === 403) {
    throw new ProviderError(
      "Grok oturumu geçersiz veya süresi dolmuş. Hesabı yeniden bağlayın.",
      res.status,
      "grok",
    );
  }
  if (!res.ok) {
    throw new ProviderError(`Grok ${res.status} döndürdü.`, res.status, "grok");
  }
  try {
    return await res.json();
  } catch {
    throw new ProviderError("Grok beklenmeyen bir yanıt döndürdü.", res.status, "grok");
  }
}

interface GrokRpcResponse {
  status: number;
  grpcStatus: string | null;
  bytes: Uint8Array;
  text: string;
}

/**
 * POST to the credits RPC. Kept separate from `grokFetch` because this endpoint answers binary and
 * signals failure in a `grpc-status` header while still returning HTTP 200 — a JSON-shaped reader
 * would silently treat "no-credentials" as an empty reading.
 */
async function grokRpc(
  tokens: AccountTokens,
  contentType: string,
  body: string | Uint8Array<ArrayBuffer>,
): Promise<GrokRpcResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(CREDITS_URL, {
      method: "POST",
      headers: {
        cookie: cookieHeader(tokens),
        "content-type": contentType,
        accept: contentType,
        "user-agent": USER_AGENT,
        // The web client sends this on every gRPC-web call; some edges reject the request without it.
        "x-grpc-web": "1",
      },
      body,
      signal: controller.signal,
      cache: "no-store",
    });
  } catch {
    throw new ProviderError("Grok'a ulaşılamadı.", 0, "grok");
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 401 || res.status === 403) {
    throw new ProviderError(
      "Grok oturumu geçersiz veya süresi dolmuş. Hesabı yeniden bağlayın.",
      res.status,
      "grok",
    );
  }
  const buffer = res.ok ? new Uint8Array(await res.arrayBuffer()) : new Uint8Array();
  return {
    status: res.status,
    grpcStatus: res.headers.get("grpc-status"),
    bytes: buffer,
    text: res.ok ? new TextDecoder().decode(buffer) : "",
  };
}

/**
 * Read the credits config from the CLI's billing facade. Bearer credentials only.
 *
 * `?format=credits` is load-bearing: without it the same path returns the money invoice, which on a
 * subscription is $0 and would render as "no usage" on a card the user is actively spending.
 */
async function fetchCliCredits(tokens: AccountTokens): Promise<GrokCreditsReading> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(CLI_BILLING_URL, {
      headers: {
        authorization: `Bearer ${tokens.accessToken.trim()}`,
        "x-xai-token-auth": "xai-grok-cli",
        accept: "application/json",
        "user-agent": USER_AGENT,
      },
      signal: controller.signal,
      cache: "no-store",
    });
  } catch {
    throw new ProviderError("Grok'a ulaşılamadı.", 0, "grok");
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 401 || res.status === 403) {
    throw new ProviderError(
      "Grok oturumu süresi doldu. `grok login` ile yenileyip hesabı yeniden bağlayın.",
      res.status,
      "grok",
    );
  }
  if (!res.ok) throw new ProviderError(`Grok ${res.status} döndürdü.`, res.status, "grok");

  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    throw new ProviderError("Grok beklenmeyen bir yanıt döndürdü.", res.status, "grok");
  }
  const reading = readGrokCreditsJson(payload);
  if (grokCreditsReadingIsEmpty(reading)) {
    throw new ProviderError("Grok kullanım verisi okunamadı.", res.status, "grok");
  }
  return reading;
}

/**
 * Read the shared pool from grok.com, protobuf first and JSON second. Session-cookie credentials.
 *
 * Both shapes are attempted because the method is an internal RPC with no published contract: the
 * binary form is what the web client sends, and the Connect JSON form carries field *names*, which
 * is the self-describing evidence to fall back on if the wire layout moves. An unreadable response
 * raises rather than returning zeros — a Grok card with no bar is recoverable, a card claiming 0%
 * used is not.
 */
async function fetchWebCredits(tokens: AccountTokens): Promise<GrokCreditsReading> {
  let lastStatus = 0;
  try {
    const proto = await grokRpc(tokens, "application/grpc-web+proto", grpcWebEmptyRequest());
    lastStatus = proto.status;
    if (proto.status === 200 && (proto.grpcStatus === null || proto.grpcStatus === "0")) {
      const reading = readGrokCreditsProto(proto.bytes);
      if (!grokCreditsReadingIsEmpty(reading)) return reading;
    }
  } catch (err) {
    // A dead session is terminal for both attempts; anything else falls through to JSON.
    if (err instanceof ProviderError && (err.status === 401 || err.status === 403)) throw err;
  }

  const json = await grokRpc(tokens, "application/json", "{}");
  lastStatus = json.status || lastStatus;
  if (json.status === 200 && (json.grpcStatus === null || json.grpcStatus === "0")) {
    try {
      const reading = readGrokCreditsJson(JSON.parse(json.text) as unknown);
      if (!grokCreditsReadingIsEmpty(reading)) return reading;
    } catch {
      // Not JSON either.
    }
  }
  throw new ProviderError(
    "Grok haftalık kullanımı okunamadı. Oturum yenilenmiş olabilir; hesabı yeniden bağlayın.",
    lastStatus || 502,
    "grok",
  );
}

/** Dispatch to whichever source the account's credential can authenticate against. */
export async function fetchGrokCredits(tokens: AccountTokens): Promise<GrokCreditsReading> {
  return grokCredentialKind(tokens.accessToken) === "bearer"
    ? fetchCliCredits(tokens)
    : fetchWebCredits(tokens);
}

/**
 * The active subscription. `/rest/subscriptions` keeps superseded rows — an upgraded account
 * still lists the previous tier as INACTIVE — so taking `[0]` reports the wrong plan.
 */
export function activeGrokTier(payload: unknown): string | null {
  const subs = (payload as { subscriptions?: unknown } | null)?.subscriptions;
  if (!Array.isArray(subs)) return null;
  for (const sub of subs as { status?: unknown; tier?: unknown }[]) {
    if (sub?.status === "SUBSCRIPTION_STATUS_ACTIVE" && typeof sub.tier === "string") {
      return sub.tier;
    }
  }
  return null;
}

export const grokProvider: Provider = {
  id: "grok",
  label: "Grok",
  supportsOAuth: false,

  // A browser session has no refresh grant. Returning the credential unchanged keeps the shared
  // refresh machinery happy; an expired cookie surfaces as the 401 above and routes to reauth.
  async refresh(tokens: AccountTokens): Promise<AccountTokens> {
    return tokens;
  },

  async fetchUsage(tokens: AccountTokens): Promise<UsageData> {
    // The plan name is presentational — it only spells the pool bar's label — so a failure here
    // must not cost the reading itself. Read before the quota so a subscription upgrade shows up
    // on the same refresh the new allowance does.
    let plan = "SuperGrok Plus";
    try {
      plan = grokPlanLabel(activeGrokTier(await grokFetch(SUBSCRIPTIONS_URL, tokens)));
    } catch {
      // Fall through with the tier this endpoint is only reachable on anyway.
    }
    return normalizeGrokCredits(await fetchGrokCredits(tokens), plan);
  },

  async resolveIdentity(tokens: AccountTokens): Promise<ProviderProfile> {
    // A bearer token names its own holder. grok.com's session endpoint is cookie-authenticated, so
    // asking it about a CLI token would 401 on an otherwise perfectly usable credential.
    if (grokCredentialKind(tokens.accessToken) === "bearer") {
      const claims = grokBearerClaims(tokens.accessToken);
      if (!claims.sub && !claims.email) {
        throw new ProviderError("Grok kimliği okunamadı.", 401, "grok");
      }
      let bearerPlan = "Grok";
      try {
        bearerPlan = grokPlanLabel(activeGrokTier(await grokFetch(SUBSCRIPTIONS_URL, tokens)));
      } catch {
        // Plan is presentational; a readable identity is enough to finish connecting.
      }
      return { id: claims.sub || claims.email, email: claims.email, plan: bearerPlan };
    }

    const session = (await grokFetch(SESSION_URL, tokens)) as {
      session?: { userId?: unknown; email?: unknown; givenName?: unknown; familyName?: unknown };
    } | null;
    const inner = session?.session;
    const id = typeof inner?.userId === "string" ? inner.userId : "";
    const email = typeof inner?.email === "string" ? inner.email : "";
    if (!id && !email) {
      throw new ProviderError("Grok kimliği okunamadı.", 401, "grok");
    }
    const first = typeof inner?.givenName === "string" ? inner.givenName.trim() : "";
    const last = typeof inner?.familyName === "string" ? inner.familyName.trim() : "";
    const fullName = [first, last].filter(Boolean).join(" ");

    let plan = "Grok";
    try {
      plan = grokPlanLabel(activeGrokTier(await grokFetch(SUBSCRIPTIONS_URL, tokens)));
    } catch {
      // Plan is presentational; a readable identity is enough to finish connecting.
    }
    return { id: id || email, email, fullName: fullName || undefined, plan };
  },

  /**
   * Accepts either credential the reader can use.
   *
   * A pasted ~/.grok/auth.json (or the bare JWT inside it) becomes a bearer, which is the better
   * credential where it is available: scoped, renewable with `grok login`, and accepted by the CLI
   * billing facade. Everything else is read as the `sso` cookie — bare, as a `name=value` pair, or
   * inside a whole `document.cookie` string copied from devtools. Returns null when nothing usable
   * is present so the connect dialog can say so.
   */
  parseManualCredential(raw: string): AccountTokens | null {
    const text = raw.trim();
    if (!text) return null;
    if (text.startsWith("{")) {
      try {
        const bearer = grokTokenFromAuthFile(JSON.parse(text) as unknown);
        // A JSON blob that is not an auth file carries no cookie either; do not fall through and
        // store the raw document as a session value.
        return bearer ? { accessToken: bearer, refreshToken: null, expiresAt: 0 } : null;
      } catch {
        return null;
      }
    }
    if (grokCredentialKind(text) === "bearer") {
      return { accessToken: text, refreshToken: null, expiresAt: 0 };
    }
    let value = "";
    if (text.includes("=")) {
      for (const part of text.split(";")) {
        const [name, ...rest] = part.split("=");
        if (name.trim() === "sso" && rest.length > 0) {
          value = rest.join("=").trim();
          break;
        }
      }
      if (!value) return null;
    } else {
      value = text;
    }
    if (!value || /\s/u.test(value)) return null;
    return { accessToken: `sso=${value}`, refreshToken: null, expiresAt: 0 };
  },
};
