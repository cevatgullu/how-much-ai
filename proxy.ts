import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, authOpen, verifySession } from "@/lib/session";
import { strictLocalRequestHostAllowed } from "@/lib/strict-local-mode";
import { isSelfAuthenticatingPublicPath } from "@/lib/self-authenticating-public-paths";

function bounceToLogin(req: NextRequest): NextResponse {
  const { pathname } = req.nextUrl;
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.searchParams.set("next", `${pathname}${req.nextUrl.search}`);
  return NextResponse.redirect(url);
}

export default async function proxy(req: NextRequest): Promise<NextResponse> {
  if (!strictLocalRequestHostAllowed(req.headers.get("host"))) {
    return NextResponse.json({ error: "Bad request" }, { status: 421 });
  }

  const { pathname } = req.nextUrl;

  if (authOpen()) {
    if (pathname === "/login") {
      const url = req.nextUrl.clone();
      url.pathname = "/";
      return NextResponse.redirect(url);
    }
    return NextResponse.next();
  }

  if (isSelfAuthenticatingPublicPath(pathname)) return NextResponse.next();
  if (await verifySession(req.cookies.get(SESSION_COOKIE)?.value)) return NextResponse.next();
  return bounceToLogin(req);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
