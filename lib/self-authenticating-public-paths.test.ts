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
    "//bootstrap",
  ]) {
    assert.equal(isSelfAuthenticatingPublicPath(pathname), false, pathname);
  }
});
