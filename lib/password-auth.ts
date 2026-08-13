import {
  createLoginRateLimiter,
  loginClientKey,
  trustedLoginProxyHeaders,
  type LoginRateLimiter,
} from "./login-rate-limit";
import { readJsonObject, requestBodyFailure } from "./request-body";
import { appPassword, safeEqual } from "./session";

interface PasswordAuthenticationSuccess {
  ok: true;
  body: Record<string, unknown>;
}

interface PasswordAuthenticationFailure {
  ok: false;
  error: string;
  status: 400 | 401 | 413 | 415 | 429 | 503;
  headers?: Record<string, string>;
}

export type PasswordAuthenticationResult =
  | PasswordAuthenticationSuccess
  | PasswordAuthenticationFailure;

declare global {
  var __hmcLoginRateLimiter: LoginRateLimiter | undefined;
}

const limiter = globalThis.__hmcLoginRateLimiter ?? createLoginRateLimiter();
globalThis.__hmcLoginRateLimiter = limiter;

export async function authenticatePasswordRequest(
  req: Request,
): Promise<PasswordAuthenticationResult> {
  const expected = appPassword();
  if (!expected) {
    return {
      ok: false,
      error: "This instance has no password set. Set the APP_PASSWORD environment variable.",
      status: 503,
    };
  }

  const clientKey = loginClientKey(req.headers, trustedLoginProxyHeaders());
  const rate = limiter.check(clientKey);
  if (!rate.allowed) {
    return {
      ok: false,
      error: "Too many sign-in attempts. Please try again later.",
      status: 429,
      headers: { "Retry-After": String(rate.retryAfterSeconds), "Cache-Control": "no-store" },
    };
  }

  let body: Record<string, unknown>;
  try {
    body = await readJsonObject(req, 4 * 1024);
  } catch (error) {
    limiter.recordFailure(clientKey);
    const failure = requestBodyFailure(error);
    return { ok: false, ...failure };
  }

  const password = typeof body.password === "string" ? body.password : "";
  if (!password || !safeEqual(password, expected)) {
    limiter.recordFailure(clientKey);
    return { ok: false, error: "Incorrect password", status: 401 };
  }

  limiter.reset(clientKey);
  return { ok: true, body };
}
