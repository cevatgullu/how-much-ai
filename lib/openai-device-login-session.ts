export const OPENAI_DEVICE_VERIFICATION_URL = "https://auth.openai.com/codex/device" as const;

export interface OpenAIDeviceConnectedAccount {
  id: string;
  email: string;
  plan: string;
  label: string;
  alreadyConnected: boolean;
}

interface OpenAIDeviceAuthorizationView {
  userCode: string;
  verificationUrl: typeof OPENAI_DEVICE_VERIFICATION_URL;
  expiresAt: number;
}

export type OpenAIDeviceLoginState =
  | { status: "starting" }
  | ({ status: "waiting" | "processing" } & OpenAIDeviceAuthorizationView)
  | { status: "done"; account: OpenAIDeviceConnectedAccount }
  | { status: "failed" | "expired" };

interface OpenAIDeviceLoginDependencies<TimerHandle> {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  open(url: typeof OPENAI_DEVICE_VERIFICATION_URL): void;
  setTimeout(callback: () => void, delay: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
  navigateToLogin(): void;
  onState(state: OpenAIDeviceLoginState): void;
  onConnected(account: OpenAIDeviceConnectedAccount): void;
  onBusyChange?(busy: boolean): void;
}

export interface OpenAIDeviceLoginSession {
  start(expectedAccountId?: string): Promise<void>;
  cancel(): void;
}

interface StartResponse {
  attemptId: string;
  userCode: string;
  verificationUrl: typeof OPENAI_DEVICE_VERIFICATION_URL;
  pollAfterMs: number;
  expiresAt: number;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function startResponse(value: unknown): StartResponse | null {
  const data = record(value);
  if (
    !data ||
    typeof data.attemptId !== "string" ||
    !data.attemptId ||
    typeof data.userCode !== "string" ||
    !data.userCode ||
    data.verificationUrl !== OPENAI_DEVICE_VERIFICATION_URL ||
    !finiteNonNegative(data.pollAfterMs) ||
    !finiteNonNegative(data.expiresAt)
  ) {
    return null;
  }
  return {
    attemptId: data.attemptId,
    userCode: data.userCode,
    verificationUrl: OPENAI_DEVICE_VERIFICATION_URL,
    pollAfterMs: data.pollAfterMs,
    expiresAt: data.expiresAt,
  };
}

function connectedAccount(value: unknown): OpenAIDeviceConnectedAccount | null {
  const account = record(value);
  if (!account) return null;
  const keys = Object.keys(account).sort();
  if (
    keys.length !== 5 ||
    keys[0] !== "alreadyConnected" ||
    keys[1] !== "email" ||
    keys[2] !== "id" ||
    keys[3] !== "label" ||
    keys[4] !== "plan" ||
    typeof account.id !== "string" ||
    !account.id ||
    typeof account.email !== "string" ||
    !account.email ||
    typeof account.plan !== "string" ||
    typeof account.label !== "string" ||
    typeof account.alreadyConnected !== "boolean"
  ) {
    return null;
  }
  return {
    id: account.id,
    email: account.email,
    plan: account.plan,
    label: account.label,
    alreadyConnected: account.alreadyConnected,
  };
}

async function responseData(response: Response): Promise<Record<string, unknown> | null> {
  return record(await response.json().catch(() => null));
}

export function createOpenAIDeviceLoginSession<TimerHandle>(
  deps: OpenAIDeviceLoginDependencies<TimerHandle>,
): OpenAIDeviceLoginSession {
  let active = false;
  let generation = 0;
  let timer: TimerHandle | null = null;
  let request: AbortController | null = null;

  const current = (candidate: number): boolean => active && candidate === generation;

  const clearPoll = () => {
    if (timer === null) return;
    deps.clearTimeout(timer);
    timer = null;
  };

  const finish = (candidate: number, state?: OpenAIDeviceLoginState) => {
    if (!current(candidate)) return false;
    active = false;
    clearPoll();
    request = null;
    if (state) deps.onState(state);
    deps.onBusyChange?.(false);
    return true;
  };

  const signedOut = (candidate: number) => {
    if (!finish(candidate)) return;
    deps.navigateToLogin();
  };

  const failed = (candidate: number) => {
    finish(candidate, { status: "failed" });
  };

  const schedulePoll = (
    candidate: number,
    attemptId: string,
    authorization: OpenAIDeviceAuthorizationView,
    delay: number,
  ) => {
    if (!current(candidate)) return;
    clearPoll();
    timer = deps.setTimeout(() => {
      timer = null;
      void poll(candidate, attemptId, authorization);
    }, delay);
  };

  const poll = async (
    candidate: number,
    attemptId: string,
    authorization: OpenAIDeviceAuthorizationView,
  ): Promise<void> => {
    if (!current(candidate)) return;
    const controller = new AbortController();
    request = controller;
    try {
      const response = await deps.fetch("/api/connect/openai/device/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ attemptId }),
        cache: "no-store",
        signal: controller.signal,
      });
      const data = await responseData(response);
      if (!current(candidate)) return;
      if (response.status === 401 && data?.error === "Not signed in") {
        signedOut(candidate);
        return;
      }
      if (!response.ok || !data) {
        failed(candidate);
        return;
      }
      if (data.status === "pending" || data.status === "processing") {
        if (!finiteNonNegative(data.pollAfterMs) || !finiteNonNegative(data.expiresAt)) {
          failed(candidate);
          return;
        }
        deps.onState({
          status: data.status === "processing" ? "processing" : "waiting",
          ...authorization,
          expiresAt: data.expiresAt,
        });
        schedulePoll(candidate, attemptId, { ...authorization, expiresAt: data.expiresAt }, data.pollAfterMs);
        return;
      }
      if (data.status === "expired") {
        finish(candidate, { status: "expired" });
        return;
      }
      if (data.status === "failed") {
        failed(candidate);
        return;
      }
      if (data.status === "done") {
        const responseKeys = Object.keys(data).sort();
        if (
          responseKeys.length !== 2 ||
          responseKeys[0] !== "account" ||
          responseKeys[1] !== "status"
        ) {
          failed(candidate);
          return;
        }
        const account = connectedAccount(data.account);
        if (!account) {
          failed(candidate);
          return;
        }
        if (!finish(candidate, { status: "done", account })) return;
        deps.onConnected(account);
        return;
      }
      failed(candidate);
    } catch {
      if (current(candidate)) failed(candidate);
    } finally {
      if (request === controller) request = null;
    }
  };

  return {
    async start(expectedAccountId?: string): Promise<void> {
      if (active) return;
      const candidate = ++generation;
      active = true;

      // This exact literal is opened before the first await so the explicit click retains its
      // browser user activation. The server response is still required to match it before polling.
      try {
        deps.open(OPENAI_DEVICE_VERIFICATION_URL);
      } catch {
        failed(candidate);
        return;
      }
      deps.onBusyChange?.(true);
      deps.onState({ status: "starting" });

      const controller = new AbortController();
      request = controller;
      try {
        const response = await deps.fetch("/api/connect/openai/device/start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ expectedAccountId }),
          cache: "no-store",
          signal: controller.signal,
        });
        const data = await responseData(response);
        if (!current(candidate)) return;
        if (response.status === 401 && data?.error === "Not signed in") {
          signedOut(candidate);
          return;
        }
        if (!response.ok) {
          failed(candidate);
          return;
        }
        const started = startResponse(data);
        if (!started) {
          failed(candidate);
          return;
        }
        const authorization: OpenAIDeviceAuthorizationView = {
          userCode: started.userCode,
          verificationUrl: OPENAI_DEVICE_VERIFICATION_URL,
          expiresAt: started.expiresAt,
        };
        deps.onState({ status: "waiting", ...authorization });
        schedulePoll(candidate, started.attemptId, authorization, started.pollAfterMs);
      } catch {
        if (current(candidate)) failed(candidate);
      } finally {
        if (request === controller) request = null;
      }
    },

    cancel(): void {
      const wasActive = active;
      generation += 1;
      active = false;
      request?.abort();
      request = null;
      clearPoll();
      if (wasActive) deps.onBusyChange?.(false);
    },
  };
}
