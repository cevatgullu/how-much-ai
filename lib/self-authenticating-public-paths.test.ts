import assert from "node:assert/strict";
import test from "node:test";
import { isSelfAuthenticatingPublicPath } from "./self-authenticating-public-paths.ts";

test("only the reviewed exact public paths are admitted before a session exists", () => {
  for (const pathname of [
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
    `/api/connect/oauth/attempt/launch/${"A".repeat(43)}`,
    `/api/connect/oauth/attempt/launch/${"a0_-".repeat(10)}abc`,
  ]) {
    assert.equal(isSelfAuthenticatingPublicPath(pathname), true, pathname);
  }
});

test("suffixes, prefixes, and bootstrap lookalikes remain protected", () => {
  for (const pathname of [
    "/",
    "/login/",
    "/login/reset",
    "/api/auth/login/extra",
    "/api/cron/check/",
    "/api/connect/pair/complete/extra",
    "/bootstrap/",
    "/bootstrap/anything",
    "/bootstrap-evil",
    "/api/auth/bootstrap",
    "/api/auth/bootstrap/start/",
    "/api/auth/bootstrap/start/anything",
    "/api/auth/bootstrap/consume/",
    "/api/auth/bootstrap/consume-anything",
    "/oauth/callback/",
    "/oauth/callback/anything",
    "/api/connect/oauth",
    "/api/connect/oauth/",
    "/api/connect/oauth/attempt",
    "/api/connect/oauth/attempt/",
    "/api/connect/oauth/attempt/start/",
    "/api/connect/oauth/attempt/callback/extra",
    "/api/connect/oauth/attempt/status/",
    "/api/connect/oauth/attempt/launch",
    `/api/connect/oauth/attempt/launch/${"A".repeat(42)}`,
    `/api/connect/oauth/attempt/launch/${"A".repeat(44)}`,
    `/api/connect/oauth/attempt/launch/${"A".repeat(42)}+`,
    `/api/connect/oauth/attempt/launch/${"A".repeat(43)}/extra`,
    "//bootstrap",
  ]) {
    assert.equal(isSelfAuthenticatingPublicPath(pathname), false, pathname);
  }
});
