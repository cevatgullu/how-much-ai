// Resolve the single self-hosted tenant. Every ordinary request requires the signed
// password-session cookie; strict Windows bootstrap creates the same session without open mode.
import { authOpen, SESSION_COOKIE, verifySession } from "./session";

export async function requireUser(req: Request): Promise<string | null> {
  if (authOpen()) return "default";

  const cookie = req.headers.get("cookie") ?? "";
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
  return (await verifySession(match?.[1])) ? "default" : null;
}
