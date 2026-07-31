// @ts-expect-error Node's native TypeScript test runner needs the extension.
import { parseOAuthCallbackRepresentation } from "./oauth.ts";

export interface OAuthCallbackBrowser {
  location: {
    pathname: string;
    search: string;
    hash: string;
  };
  history: {
    replaceState(data: unknown, unused: string, destination?: string | URL | null): void;
  };
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export interface OAuthCallbackSessionAttempt {
  started: boolean;
  completion: Promise<boolean>;
}

function callbackFromFragment(hash: string): { code: string; state: string } | null {
  const match = /^#code=([^&]+)&state=([^&]+)$/.exec(hash);
  if (!match) return null;
  try {
    const code = decodeURIComponent(match[1]);
    const state = decodeURIComponent(match[2]);
    if (
      encodeURIComponent(code) !== match[1] ||
      encodeURIComponent(state) !== match[2]
    ) {
      return null;
    }
    return parseOAuthCallbackRepresentation(`${code}#${state}`);
  } catch {
    return null;
  }
}

export function beginOAuthCallbackSession(
  browser: OAuthCallbackBrowser,
): OAuthCallbackSessionAttempt {
  const { pathname, search, hash } = browser.location;
  browser.history.replaceState(null, "", pathname);

  const callback =
    pathname === "/oauth/callback" && search === ""
      ? callbackFromFragment(hash)
      : null;
  if (!callback) {
    return { started: false, completion: Promise.resolve(false) };
  }

  const completion = (async () => {
    try {
      const response = await browser.fetch("/api/connect/oauth/attempt/callback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(callback),
      });
      if (!response.ok) return false;
      const body: unknown = await response.json().catch(() => null);
      return Boolean(
        body &&
          typeof body === "object" &&
          !Array.isArray(body) &&
          Object.keys(body).length === 1 &&
          (body as Record<string, unknown>).status === "done",
      );
    } catch {
      return false;
    }
  })();
  return { started: true, completion };
}
