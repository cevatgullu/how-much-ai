# Exclude Codex Spark Weekly Limit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the `GPT-5.3-Codex-Spark` weekly quota from every How Much AI calculation and display while retaining all other OpenAI limits.

**Architecture:** Exclude the quota at the OpenAI `/wham/usage` normalization boundary only when the row is weekly-scoped and both its stable `metered_feature` identity (`codex_bengalfox`) and display name (`GPT-5.3-Codex-Spark`) match. Existing cards, peak statistics, and notification paths will then receive the same filtered normalized bars without downstream special cases.

**Tech Stack:** TypeScript, Node.js test runner, Next.js 16.

## Global Constraints

- Preserve the account-wide OpenAI weekly limit.
- Preserve all model-scoped limits except `codex_bengalfox`.
- Do not change Claude normalization, UI components, or notification code.
- Follow RED-GREEN TDD and the repository validation order.

---

### Task 1: Filter the Spark quota at OpenAI normalization

**Files:**
- Modify: `lib/providers/openai-usage.ts:97-107`
- Test: `lib/providers/openai.test.ts`

**Interfaces:**
- Consumes: `WhamUsagePayload.additional_rate_limits` and `OpenAIAdditionalLimit.metered_feature`.
- Produces: `normalizeOpenAIUsage(payload): UsageData` without the exact weekly `GPT-5.3-Codex-Spark` / `codex_bengalfox` `LimitEntry`.

- [ ] **Step 1: Write the failing regression test**

Add a test that passes an account-wide weekly window, the Spark additional window, and a control model-scoped window to `normalizeOpenAIUsage`, then asserts:

```ts
assert.deepEqual(
  extractBars(normalizeOpenAIUsage(payload)).map(({ key, usedPercent }) => [key, usedPercent]),
  [
    ["weekly_all", 10],
    ["weekly_scoped:gpt-5-codex", 20],
  ],
);
```

The Spark fixture must use `limit_name: "GPT-5.3-Codex-Spark"`, `metered_feature: "codex_bengalfox"`, and a 604,800-second primary window. The control row must use `limit_name: "GPT-5 Codex"`, `metered_feature: "gpt-5-codex"`, and a 604,800-second primary window.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
node --import ./scripts/test-environment.mjs --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test --test-concurrency=1 lib/providers/openai.test.ts
```

Expected: the new assertion fails because the result still contains `weekly_scoped:codex_bengalfox`; all pre-existing tests remain green.

- [ ] **Step 3: Implement the minimal exclusion**

In the `additional_rate_limits` loop, derive `kind` once and skip only the exact weekly Spark row before calling `addWindow`:

```ts
const kind = seconds != null && seconds <= SESSION_MAX_S ? "session" : "weekly_scoped";
if (kind === "weekly_scoped" && name === "GPT-5.3-Codex-Spark" && extra?.metered_feature === "codex_bengalfox") {
  continue;
}
```

- [ ] **Step 4: Run focused verification and verify GREEN**

Run the Step 2 command again. Expected: every test in `lib/providers/openai.test.ts` passes, the control model-scoped row remains present, and no non-weekly row is excluded.

- [ ] **Step 5: Run repository-required validation**

Run in this exact order:

```powershell
npm test
npm run typecheck
npm run build
```

Expected: every command exits 0; the build's vault-trace assertion passes.

- [ ] **Step 6: Commit the implementation**

```powershell
git add -- lib/providers/openai-usage.ts lib/providers/openai.test.ts
git commit -m "fix: exclude Codex Spark weekly limit"
```
