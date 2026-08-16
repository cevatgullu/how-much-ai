// Client-side presentation metadata for providers. The client can't import the server provider
// registry (it pulls in Node built-ins), so the display label + icon + connect capabilities live here.
import type { ReactElement } from "react";
import type { ProviderId } from "@/lib/providers/types";
import { AnthropicIcon, GrokIcon, OpenAIIcon } from "./Icons";

export interface ProviderMeta {
  id: ProviderId;
  label: string;
  Icon: (props: { className?: string }) => ReactElement;
  supportsOAuth: boolean;
  supportsPrivateLogin: boolean;
}

export const PROVIDER_META: Record<ProviderId, ProviderMeta> = {
  anthropic: {
    id: "anthropic",
    label: "Claude",
    Icon: AnthropicIcon,
    supportsOAuth: true,
    supportsPrivateLogin: true,
  },
  openai: {
    id: "openai",
    label: "ChatGPT",
    Icon: OpenAIIcon,
    supportsOAuth: false,
    supportsPrivateLogin: true,
  },
  grok: {
    id: "grok",
    label: "Grok",
    Icon: GrokIcon,
    // xAI refuses quota reads from OAuth tokens, so the only connect paths are a pasted
    // credential. See the note at the top of lib/providers/grok.ts.
    supportsOAuth: false,
    supportsPrivateLogin: false,
  },
};

// Picker order (matches lib/providers PROVIDERS).
export const PROVIDER_ORDER: ProviderId[] = ["anthropic", "openai", "grok"];

export function providerMeta(id: ProviderId | undefined): ProviderMeta {
  return PROVIDER_META[id ?? "anthropic"] ?? PROVIDER_META.anthropic;
}

export interface ParsedCredentialTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
}

// Browser-safe decode of an access token's `exp` claim (epoch ms), or 0. Identity only — never trusted.
function jwtExpiryMs(token: string): number {
  try {
    const seg = token.split(".")[1];
    if (!seg) return 0;
    let b64 = seg.replace(/-/g, "+").replace(/_/g, "/");
    b64 += "=".repeat((4 - (b64.length % 4)) % 4);
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const payload = JSON.parse(new TextDecoder().decode(bytes)) as { exp?: unknown };
    return typeof payload.exp === "number" && payload.exp > 0 ? payload.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

/**
 * Read whichever Grok credential the user pastes.
 *
 * Two are usable and they authenticate different sources: a `~/.grok/auth.json` bearer (or the bare
 * JWT inside it) reaches the CLI billing facade, and the `sso` cookie reaches grok.com. The cookie
 * is accepted bare, as an `sso=…` pair, or inside a whole `document.cookie` string copied from
 * devtools. Mirrors the server-side parser in lib/providers/grok.ts — the two must agree, so both
 * accept the same shapes.
 *
 * There is no expiry to read from either: a session cookie carries none in its value and the bearer
 * is treated as opaque here, so `expiresAt` is 0 ("unknown") and a dead credential surfaces as the
 * 401 that routes the card to reconnect.
 */
const GROK_JWT_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;

function grokBearerFromAuthFile(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const candidates: unknown[] = [payload, ...Object.values(payload as Record<string, unknown>)];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const entry = candidate as { key?: unknown; access_token?: unknown; accessToken?: unknown };
    for (const value of [entry.key, entry.access_token, entry.accessToken]) {
      if (typeof value === "string" && GROK_JWT_PATTERN.test(value.trim())) return value.trim();
    }
  }
  return null;
}

export function parseGrokSession(text: string): ParsedCredentialTokens | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{")) {
    try {
      const bearer = grokBearerFromAuthFile(JSON.parse(trimmed) as unknown);
      // A JSON document that is not an auth file carries no cookie either; falling through would
      // store the raw text as a session value and produce an account that can never authenticate.
      return bearer ? { accessToken: bearer, refreshToken: null, expiresAt: 0 } : null;
    } catch {
      return null;
    }
  }
  if (GROK_JWT_PATTERN.test(trimmed)) {
    return { accessToken: trimmed, refreshToken: null, expiresAt: 0 };
  }
  let value = "";
  if (trimmed.includes("=")) {
    for (const part of trimmed.split(";")) {
      const [name, ...rest] = part.split("=");
      if (name.trim() === "sso" && rest.length > 0) {
        value = rest.join("=").trim();
        break;
      }
    }
    if (!value) return null;
  } else {
    value = trimmed;
  }
  if (!value || /\s/u.test(value)) return null;
  return { accessToken: `sso=${value}`, refreshToken: null, expiresAt: 0 };
}

// Parse a pasted ~/.codex/auth.json (or a bare tokens object) client-side into vault tokens. Mirrors
// the server-side extractOpenAITokens; kept here so the Connect dialog never imports Node-only code.
export function parseCodexCredential(text: string): ParsedCredentialTokens | null {
  let obj: unknown;
  try {
    obj = JSON.parse(text.trim());
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const root = obj as Record<string, unknown>;
  const tokens = (root.tokens && typeof root.tokens === "object" ? root.tokens : root) as Record<string, unknown>;
  const accessToken = tokens.access_token ?? tokens.accessToken;
  if (typeof accessToken !== "string" || !accessToken) return null;
  const refreshRaw = tokens.refresh_token ?? tokens.refreshToken;
  const exp = jwtExpiryMs(accessToken);
  return {
    accessToken,
    refreshToken: typeof refreshRaw === "string" && refreshRaw ? refreshRaw : null,
    expiresAt: exp > 0 ? exp : Date.now() + 10 * 24 * 60 * 60 * 1000,
  };
}
