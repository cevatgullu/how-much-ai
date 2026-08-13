import type { AccountTokens } from "../types";
import { expiryFromAccessToken } from "./openai-credential-source.mjs";
import { ProviderError } from "./types";

export const OPENAI_DEVICE_AUTH = {
  issuer: "https://auth.openai.com",
  clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
  verificationUrl: "https://auth.openai.com/codex/device",
  redirectUri: "https://auth.openai.com/deviceauth/callback",
  attemptTtlMs: 15 * 60_000,
} as const;

export interface OpenAIDeviceAuthorization {
  deviceAuthId: string;
  userCode: string;
  intervalMs: number;
  expiresAt: number;
}

export interface OpenAIDeviceAuthorizationGrant {
  authorizationCode: string;
  codeVerifier: string;
}

export type OpenAIDevicePollResult =
  | { status: "pending" }
  | { status: "authorized"; grant: OpenAIDeviceAuthorizationGrant };

type FetchImpl = typeof fetch;
type TimeoutSignal = (durationMs: number) => AbortSignal;

interface RequestOptions {
  fetchImpl?: FetchImpl;
  timeoutSignal?: TimeoutSignal;
}

interface StartOptions extends RequestOptions {
  now?: () => number;
}

export type OpenAIDeviceAuthErrorPhase = "start" | "poll" | "authorization" | "exchange";

export class OpenAIDeviceAuthError extends ProviderError {
  readonly phase: OpenAIDeviceAuthErrorPhase;

  constructor(message: string, status: number, phase: OpenAIDeviceAuthErrorPhase) {
    super(message, status, "openai");
    this.name = "OpenAIDeviceAuthError";
    this.phase = phase;
  }
}

const DEVICE_REQUEST_TIMEOUT_MS = 15_000;
const TOKEN_REQUEST_TIMEOUT_MS = 30_000;
const MAX_DEVICE_AUTH_ID_LENGTH = 4_096;
const MAX_USER_CODE_LENGTH = 128;
const MAX_AUTHORIZATION_FIELD_LENGTH = 4_096;

function boundedString(value: unknown, maximumLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumLength &&
    value.trim() === value
  );
}

function upstreamError(
  message: string,
  phase: OpenAIDeviceAuthErrorPhase,
  status = 502,
): OpenAIDeviceAuthError {
  return new OpenAIDeviceAuthError(message, status, phase);
}

async function requestJson(
  fetchImpl: FetchImpl,
  input: string,
  init: RequestInit,
  transportMessage: string,
  phase: OpenAIDeviceAuthErrorPhase,
): Promise<{ response: Response; data: Record<string, unknown> | null }> {
  let response: Response;
  try {
    response = await fetchImpl(input, init);
  } catch {
    throw upstreamError(transportMessage, phase);
  }

  const parsed = await response.json().catch(() => null);
  const data = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  return { response, data };
}

function dependencies(options: RequestOptions): { fetchImpl: FetchImpl; timeoutSignal: TimeoutSignal } {
  return {
    fetchImpl: options.fetchImpl ?? fetch,
    timeoutSignal: options.timeoutSignal ?? AbortSignal.timeout,
  };
}

export async function startOpenAIDeviceAuthorization(
  options: StartOptions = {},
): Promise<OpenAIDeviceAuthorization> {
  const { fetchImpl, timeoutSignal } = dependencies(options);
  const { response, data } = await requestJson(
    fetchImpl,
    `${OPENAI_DEVICE_AUTH.issuer}/api/accounts/deviceauth/usercode`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: OPENAI_DEVICE_AUTH.clientId }),
      redirect: "manual",
      cache: "no-store",
      signal: timeoutSignal(DEVICE_REQUEST_TIMEOUT_MS),
    },
    "Could not reach OpenAI to start device authorization.",
    "start",
  );

  if (!response.ok) {
    throw upstreamError(`OpenAI declined device authorization (HTTP ${response.status}).`, "start", response.status);
  }

  const deviceAuthId = data?.device_auth_id;
  const userCode = data?.user_code;
  const interval = data?.interval;
  if (
    !boundedString(deviceAuthId, MAX_DEVICE_AUTH_ID_LENGTH) ||
    !boundedString(userCode, MAX_USER_CODE_LENGTH) ||
    typeof interval !== "string" ||
    interval.length > 32 ||
    !/^\d+(?:\.\d+)?$/.test(interval)
  ) {
    throw upstreamError("OpenAI returned an invalid device authorization response.", "start");
  }

  const intervalSeconds = Number(interval);
  if (!Number.isFinite(intervalSeconds)) {
    throw upstreamError("OpenAI returned an invalid device authorization response.", "start");
  }

  return {
    deviceAuthId,
    userCode,
    intervalMs: Math.min(10, Math.max(1, intervalSeconds)) * 1_000,
    expiresAt: (options.now ?? Date.now)() + OPENAI_DEVICE_AUTH.attemptTtlMs,
  };
}

export async function pollOpenAIDeviceAuthorization(
  authorization: OpenAIDeviceAuthorization,
  options: RequestOptions = {},
): Promise<OpenAIDevicePollResult> {
  const { fetchImpl, timeoutSignal } = dependencies(options);
  const poll = await requestJson(
    fetchImpl,
    `${OPENAI_DEVICE_AUTH.issuer}/api/accounts/deviceauth/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        device_auth_id: authorization.deviceAuthId,
        user_code: authorization.userCode,
      }),
      redirect: "manual",
      cache: "no-store",
      signal: timeoutSignal(DEVICE_REQUEST_TIMEOUT_MS),
    },
    "Could not reach OpenAI while checking device authorization.",
    "poll",
  );

  if (poll.response.status === 403 || poll.response.status === 404) return { status: "pending" };
  if (!poll.response.ok) {
    throw upstreamError(
      `OpenAI declined the device authorization poll (HTTP ${poll.response.status}).`,
      "poll",
      poll.response.status,
    );
  }

  const authorizationCode = poll.data?.authorization_code;
  const codeVerifier = poll.data?.code_verifier;
  if (
    !boundedString(authorizationCode, MAX_AUTHORIZATION_FIELD_LENGTH) ||
    !boundedString(codeVerifier, MAX_AUTHORIZATION_FIELD_LENGTH)
  ) {
    throw upstreamError("OpenAI returned an invalid device authorization result.", "authorization");
  }

  return {
    status: "authorized",
    grant: { authorizationCode, codeVerifier },
  };
}

export async function exchangeOpenAIDeviceAuthorization(
  grant: OpenAIDeviceAuthorizationGrant,
  options: RequestOptions = {},
): Promise<AccountTokens> {
  if (
    !boundedString(grant.authorizationCode, MAX_AUTHORIZATION_FIELD_LENGTH) ||
    !boundedString(grant.codeVerifier, MAX_AUTHORIZATION_FIELD_LENGTH)
  ) {
    throw upstreamError("OpenAI returned an invalid device authorization result.", "authorization");
  }

  const { fetchImpl, timeoutSignal } = dependencies(options);

  const form = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: OPENAI_DEVICE_AUTH.clientId,
    code: grant.authorizationCode,
    redirect_uri: OPENAI_DEVICE_AUTH.redirectUri,
    code_verifier: grant.codeVerifier,
  });
  const exchange = await requestJson(
    fetchImpl,
    `${OPENAI_DEVICE_AUTH.issuer}/oauth/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      redirect: "manual",
      cache: "no-store",
      signal: timeoutSignal(TOKEN_REQUEST_TIMEOUT_MS),
    },
    "Could not reach OpenAI to finish device authorization.",
    "exchange",
  );

  if (!exchange.response.ok) {
    throw upstreamError(
      `OpenAI declined the device token exchange (HTTP ${exchange.response.status}).`,
      "exchange",
      exchange.response.status,
    );
  }

  const accessToken = exchange.data?.access_token;
  const refreshToken = exchange.data?.refresh_token;
  if (!boundedString(accessToken, Number.MAX_SAFE_INTEGER) || !boundedString(refreshToken, Number.MAX_SAFE_INTEGER)) {
    throw upstreamError("OpenAI returned an invalid device token response.", "exchange");
  }

  return {
    accessToken,
    refreshToken,
    expiresAt: expiryFromAccessToken(accessToken),
  };
}
