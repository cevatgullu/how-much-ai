import path from "node:path";

export type StrictLocalEnvironment = Readonly<Record<string, string | undefined>>;

const REQUIRED_SECRETS = ["APP_PASSWORD", "AUTH_SECRET", "VAULT_ENCRYPTION_SECRET"] as const;
const FORBIDDEN_REMOTE_VALUES = [
  "CONVEX_URL",
  "NEXT_PUBLIC_CONVEX_URL",
  "VAULT_ACCESS_SECRET",
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "APP_URL",
  "HMC_URL",
  "HOW_MUCH_AI_URL",
  "AUTH_MODE",
  "VERCEL",
  "CF_PAGES",
  "FLY_APP_NAME",
  "CRON_SECRET",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "WEBHOOK_URL",
  "VAPID_PUBLIC",
  "VAPID_PRIVATE",
  "VAPID_SUBJECT",
] as const;

const FORBIDDEN_PROCESS_OVERRIDES = [
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_EXTRA_CA_CERTS",
  "NODE_TLS_REJECT_UNAUTHORIZED",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "OPENSSL_CONF",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
] as const;

function present(value: string | undefined): boolean {
  return Boolean(value?.trim());
}

export function strictLocalModeEnabled(env: StrictLocalEnvironment = process.env): boolean {
  return env.HMC_STRICT_LOCAL_MODE?.trim() === "1";
}

export function strictLocalRequestHostAllowed(
  host: string | null,
  env: StrictLocalEnvironment = process.env,
): boolean {
  return !strictLocalModeEnabled(env) || host === "127.0.0.1:37645";
}

export function strictLocalEnvironmentErrors(env: StrictLocalEnvironment = process.env): string[] {
  if (!strictLocalModeEnabled(env)) return [];
  const errors: string[] = [];

  if (env.HMC_LISTEN_HOST !== "127.0.0.1") errors.push("HMC_LISTEN_HOST must be 127.0.0.1");
  if (env.HMC_LISTEN_PORT !== "37645") errors.push("HMC_LISTEN_PORT must be 37645");
  if (env.PORT !== "37645") errors.push("PORT must be 37645");
  if (env.NODE_ENV !== "production") errors.push("NODE_ENV must be production");
  if (env.TRUST_PROXY_IP_HEADERS !== "0") errors.push("proxy IP headers must remain untrusted");
  if (env.ENABLE_LOCAL_CONNECT !== "1") errors.push("ENABLE_LOCAL_CONNECT must be 1");
  if (env.NEXT_TELEMETRY_DISABLED !== "1") errors.push("NEXT_TELEMETRY_DISABLED must be 1");
  if (!env.VAULT_DATA_DIR || !path.isAbsolute(env.VAULT_DATA_DIR)) {
    errors.push("VAULT_DATA_DIR must be an absolute path");
  }

  const values: string[] = [];
  for (const name of REQUIRED_SECRETS) {
    const value = env[name]?.trim() ?? "";
    if (value.length < 32) errors.push(`${name} must contain at least 32 characters`);
    values.push(value);
  }
  if (values.every(Boolean) && new Set(values).size !== values.length) {
    errors.push("strict-local secrets must be independent");
  }

  for (const name of FORBIDDEN_REMOTE_VALUES) {
    if (present(env[name])) errors.push(`${name} is disabled in strict-local mode`);
  }
  for (const name of FORBIDDEN_PROCESS_OVERRIDES) {
    if (present(env[name])) errors.push(`${name} is disabled in strict-local mode`);
  }
  return errors;
}

export function assertStrictLocalEnvironment(env: StrictLocalEnvironment = process.env): void {
  const errors = strictLocalEnvironmentErrors(env);
  if (errors.length > 0) {
    throw new Error(`Strict-local configuration refused to start: ${errors.join("; ")}`);
  }
}

export function sessionCookiePolicy(
  env: StrictLocalEnvironment = process.env,
): { secure: boolean; sameSite: "lax" | "strict" } {
  if (strictLocalModeEnabled(env)) {
    assertStrictLocalEnvironment(env);
    return { secure: false, sameSite: "strict" };
  }
  return { secure: env.NODE_ENV === "production", sameSite: "lax" };
}
