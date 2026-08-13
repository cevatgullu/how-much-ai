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
// Every endpoint answers an OAuth token except the one that carries remaining quota, which is
// exactly the number this app exists to show. Do not "fix" this by reintroducing the CLI token:
// it will authenticate fine and then 403 on the only call that matters.
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
import { normalizeGrokUsage, type GrokModeReading, type GrokRateLimitPayload } from "./grok-usage";

const ORIGIN = "https://grok.com";
const RATE_LIMITS_URL = `${ORIGIN}/rest/rate-limits`;
const MODES_URL = `${ORIGIN}/rest/modes`;
const SUBSCRIPTIONS_URL = `${ORIGIN}/rest/subscriptions`;
const SESSION_URL = `${ORIGIN}/api/auth/session`;
const USER_AGENT = "how-much-ai/0.1.0";
const TIMEOUT_MS = 15_000;

// `requestKind` is required by the endpoint but does not partition the pool: all eight accepted
// values returned identical counts on the measured tier. Sent as DEFAULT purely to satisfy it.
const REQUEST_KIND = "DEFAULT";

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

interface GrokMode {
  id?: unknown;
  title?: unknown;
  description?: unknown;
  availability?: { requiresUpgrade?: { minimumSubscriptionTier?: unknown } | null } | null;
}

/**
 * Modes the account can actually use. A tier-gated mode reports `requiresUpgrade`; querying it
 * still returns a number, so filtering here is what keeps the card free of quota the user cannot
 * spend. Mode ids are discovered rather than hardcoded — the rate-limit endpoint rejects the
 * marketing model names (`grok-4-6` and every spelling of it 404s) and only accepts these ids.
 */
export function availableGrokModes(payload: unknown): GrokModeReading[] {
  const modes = (payload as { modes?: unknown } | null)?.modes;
  if (!Array.isArray(modes)) return [];
  const out: GrokModeReading[] = [];
  for (const raw of modes as GrokMode[]) {
    if (typeof raw?.id !== "string" || !raw.id) continue;
    if (raw.availability?.requiresUpgrade) continue;
    out.push({
      id: raw.id,
      title: typeof raw.title === "string" && raw.title ? raw.title : raw.id,
      description: typeof raw.description === "string" ? raw.description : null,
      payload: {},
    });
  }
  return out;
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
    const modes = availableGrokModes(await grokFetch(MODES_URL, tokens, {}));
    if (modes.length === 0) return { limits: [] };
    const readings: GrokModeReading[] = [];
    for (const mode of modes) {
      const payload = (await grokFetch(RATE_LIMITS_URL, tokens, {
        modelName: mode.id,
        requestKind: REQUEST_KIND,
      })) as GrokRateLimitPayload;
      readings.push({ ...mode, payload });
    }
    return normalizeGrokUsage(readings);
  },

  async resolveIdentity(tokens: AccountTokens): Promise<ProviderProfile> {
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
   * Accepts the `sso` cookie, either bare or as a `name=value` pair, and tolerates a full
   * `document.cookie`-style string so a copied cookie header also works. Returns null when
   * nothing usable is present so the connect dialog can say so.
   */
  parseManualCredential(raw: string): AccountTokens | null {
    const text = raw.trim();
    if (!text) return null;
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
