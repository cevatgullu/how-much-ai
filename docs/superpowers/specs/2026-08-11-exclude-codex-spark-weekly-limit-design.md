# Exclude the GPT-5.3-Codex-Spark Weekly Limit

## Goal

Ignore the OpenAI `GPT-5.3-Codex-Spark` weekly quota everywhere in How Much AI while preserving the account-wide weekly quota and every other model-scoped quota.

## Design

Filter this provider-specific quota at the `normalizeOpenAIUsage` boundary before it becomes a normalized `LimitEntry`. Skip only a weekly-scoped row whose `metered_feature` is exactly `codex_bengalfox` and whose displayed name is exactly `GPT-5.3-Codex-Spark`. Requiring the weekly kind and both identities preserves other models and any non-weekly Spark row.

Filtering at normalization removes the quota consistently from account cards, Peak weekly statistics, local notifications, and cron notifications because all of those consumers use the normalized bars. No UI-specific filtering or notification exception is added.

## Verification

Add a provider regression test whose payload contains:

- the account-wide weekly limit;
- the excluded Spark weekly limit; and
- another model-scoped weekly limit.

The normalized bars must retain the first and third entries and omit only Spark. Run the focused provider test, then the repository-required `npm test`, `npm run typecheck`, and `npm run build` sequence before installation.
