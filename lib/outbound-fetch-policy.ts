import { strictLocalModeEnabled, type StrictLocalEnvironment } from "./strict-local-mode";

const ALLOWED_PROVIDER_ORIGINS = new Set([
  "https://api.anthropic.com",
  "https://platform.claude.com",
  "https://auth.openai.com",
  "https://chatgpt.com",
  "https://grok.com",
]);

export class OutboundPolicyError extends Error {
  constructor() {
    super("Strict-local outbound policy blocked a destination");
    this.name = "OutboundPolicyError";
  }
}

function inputUrl(input: RequestInfo | URL): URL {
  let raw: string;
  if (input instanceof Request) raw = input.url;
  else if (input instanceof URL) raw = input.href;
  else if (typeof input === "string") raw = input;
  else throw new OutboundPolicyError();

  try {
    return new URL(raw);
  } catch {
    throw new OutboundPolicyError();
  }
}

export function createStrictLocalFetch(
  upstreamFetch: typeof fetch,
  env: StrictLocalEnvironment = process.env,
): typeof fetch {
  if (!strictLocalModeEnabled(env)) return upstreamFetch;
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = inputUrl(input);
    if (url.username || url.password || !ALLOWED_PROVIDER_ORIGINS.has(url.origin)) {
      throw new OutboundPolicyError();
    }
    return upstreamFetch(input, { ...init, redirect: "manual" });
  };
}

let installed = false;

export function installStrictLocalFetchPolicy(
  env: StrictLocalEnvironment = process.env,
): void {
  if (!strictLocalModeEnabled(env) || installed) return;
  globalThis.fetch = createStrictLocalFetch(globalThis.fetch, env);
  installed = true;
}
