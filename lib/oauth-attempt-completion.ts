import {
  AnthropicError,
  exchangeSubscriptionCode,
  fetchProfile,
  fetchUsage,
} from "./anthropic";
import { saveResolvedAccount } from "./connect-account";

export type OAuthAttemptCompletionStage =
  | "exchange"
  | "verification"
  | "identity"
  | "mismatch"
  | "save";

export class OAuthAttemptCompletionError extends Error {
  readonly stage: OAuthAttemptCompletionStage;
  readonly status: number;

  constructor(stage: OAuthAttemptCompletionStage, status: number) {
    super("OAuth attempt failed");
    this.name = "OAuthAttemptCompletionError";
    this.stage = stage;
    this.status = status;
  }
}

function safeUpstreamStatus(error: unknown): number {
  if (!(error instanceof AnthropicError)) return 502;
  if (error.status === 429) return 429;
  if ([400, 401, 403, 404].includes(error.status)) return 400;
  return 502;
}

export async function completeOAuthAttempt(options: {
  userId: string;
  code: string;
  state: string;
  verifier: string;
  expectedAccountId?: string;
}): Promise<void> {
  let tokens: Awaited<ReturnType<typeof exchangeSubscriptionCode>>;
  try {
    tokens = await exchangeSubscriptionCode(
      options.code,
      options.state,
      options.verifier,
    );
  } catch (error) {
    throw new OAuthAttemptCompletionError("exchange", safeUpstreamStatus(error));
  }

  let profile: Awaited<ReturnType<typeof fetchProfile>>;
  try {
    const verified = await Promise.all([
      fetchUsage(tokens.accessToken),
      fetchProfile(tokens.accessToken),
    ]);
    profile = verified[1];
  } catch (error) {
    throw new OAuthAttemptCompletionError(
      "verification",
      safeUpstreamStatus(error),
    );
  }

  const accountId = profile.account?.uuid;
  if (!accountId) {
    throw new OAuthAttemptCompletionError("identity", 502);
  }
  if (
    options.expectedAccountId &&
    accountId !== options.expectedAccountId
  ) {
    throw new OAuthAttemptCompletionError("mismatch", 409);
  }

  try {
    await saveResolvedAccount(options.userId, profile, tokens, "managed");
  } catch {
    throw new OAuthAttemptCompletionError("save", 500);
  }
}
