export interface BootstrapSessionBrowser {
  location: {
    pathname: string;
    search: string;
    hash: string;
    replace(destination: string): void;
  };
  history: {
    replaceState(data: unknown, unused: string, destination?: string | URL | null): void;
  };
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export interface BootstrapSessionAttempt {
  started: boolean;
  completion: Promise<boolean>;
}

export function beginBootstrapSession(
  browser: BootstrapSessionBrowser,
): BootstrapSessionAttempt {
  const { pathname, search, hash } = browser.location;
  browser.history.replaceState(null, "", `${pathname}${search}`);

  const match =
    pathname === "/bootstrap" && search === ""
      ? /^#bootstrap=([A-Za-z0-9_-]{43})$/.exec(hash)
      : null;
  if (!match) {
    return { started: false, completion: Promise.resolve(false) };
  }

  const ticket = match[1];
  const completion = (async () => {
    try {
      const response = await browser.fetch("/api/auth/bootstrap/consume", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ ticket }),
      });
      if (!response.ok) return false;
      browser.location.replace("/");
      return true;
    } catch {
      return false;
    }
  })();
  return { started: true, completion };
}
