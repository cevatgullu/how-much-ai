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
]);

export function isSelfAuthenticatingPublicPath(pathname: string): boolean {
  return SELF_AUTHENTICATING_PUBLIC_PATHS.has(pathname);
}
