const SELF_AUTHENTICATING_PUBLIC_PATHS = new Set([
  "/login",
  "/api/auth/login",
  "/api/cron/check",
  "/api/connect/pair/complete",
  "/icon.svg",
  "/sw.js",
  "/bootstrap",
  "/api/auth/bootstrap/start",
  "/api/auth/bootstrap/consume",
  "/oauth/callback",
  "/api/connect/oauth/attempt/start",
  "/api/connect/oauth/attempt/callback",
  "/api/connect/oauth/attempt/status",
]);

export function isSelfAuthenticatingPublicPath(pathname: string): boolean {
  return (
    SELF_AUTHENTICATING_PUBLIC_PATHS.has(pathname) ||
    /^\/api\/connect\/oauth\/attempt\/launch\/[A-Za-z0-9_-]{43}$/.test(
      pathname,
    )
  );
}
