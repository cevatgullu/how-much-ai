import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) {
      return nextResolve(pathToFileURL(path.join(projectRoot, `${specifier.slice(2)}.ts`)).href, context);
    }
    return nextResolve(specifier, context);
  },
});
const { browserMutationFailure, readJsonObject, RequestBodyError } = await import("./request-body.ts");

function post(body: string, headers?: HeadersInit): Request {
  return new Request("http://localhost/test", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body,
  });
}

test("bounded JSON reader returns only object-shaped bodies", async () => {
  assert.deepEqual(await readJsonObject(post('{"accountId":"account-1"}')), { accountId: "account-1" });

  for (const primitive of ["null", "[]", '"string"', "42", "true"]) {
    await assert.rejects(
      () => readJsonObject(post(primitive)),
      (error: unknown) => error instanceof RequestBodyError && error.status === 400,
    );
  }
});

test("bounded JSON reader requires an actual JSON media type", async () => {
  await assert.rejects(
    () => readJsonObject(post("{}", { "Content-Type": "text/plain" })),
    (error: unknown) => error instanceof RequestBodyError && error.status === 415,
  );
  assert.deepEqual(
    await readJsonObject(post('{"ok":true}', { "Content-Type": "application/problem+json; charset=utf-8" })),
    { ok: true },
  );
});

test("browser mutation guard rejects explicit and Fetch-Metadata cross-origin requests", () => {
  assert.deepEqual(
    browserMutationFailure(
      new Request("http://localhost/api/test", { headers: { Origin: "https://attacker.example" } }),
    ),
    { error: "Cross-origin request is not allowed", status: 403 },
  );
  assert.deepEqual(
    browserMutationFailure(
      new Request("http://localhost/api/test", { headers: { "Sec-Fetch-Site": "cross-site" } }),
    ),
    { error: "Cross-origin request is not allowed", status: 403 },
  );
  assert.equal(
    browserMutationFailure(
      new Request("http://localhost/api/test", {
        headers: { Origin: "http://localhost", "Sec-Fetch-Site": "same-origin" },
      }),
    ),
    null,
  );
  assert.equal(browserMutationFailure(new Request("http://localhost/api/test")), null);
});

test("strict-local browser mutation guard trusts only its public loopback origin", () => {
  const previousStrictLocalMode = process.env.HMC_STRICT_LOCAL_MODE;
  process.env.HMC_STRICT_LOCAL_MODE = "1";
  try {
    assert.equal(
      browserMutationFailure(
        new Request("http://next-internal.invalid:3000/api/test", {
          headers: {
            Host: "127.0.0.1:37645",
            Origin: "http://127.0.0.1:37645",
            "Sec-Fetch-Site": "same-origin",
          },
        }),
      ),
      null,
    );
    assert.deepEqual(
      browserMutationFailure(
        new Request("http://next-internal.invalid:3000/api/test", {
          headers: { Host: "127.0.0.1:37645", Origin: "https://attacker.example" },
        }),
      ),
      { error: "Cross-origin request is not allowed", status: 403 },
    );
    assert.deepEqual(
      browserMutationFailure(
        new Request("http://next-internal.invalid:3000/api/test", {
          headers: { Host: "next-internal.invalid:3000", Origin: "http://127.0.0.1:37645" },
        }),
      ),
      { error: "Cross-origin request is not allowed", status: 403 },
    );
    for (const fetchSite of ["cross-site", "same-site"]) {
      assert.deepEqual(
        browserMutationFailure(
          new Request("http://next-internal.invalid:3000/api/test", {
            headers: {
              Host: "127.0.0.1:37645",
              Origin: "http://127.0.0.1:37645",
              "Sec-Fetch-Site": fetchSite,
            },
          }),
        ),
        { error: "Cross-origin request is not allowed", status: 403 },
      );
    }
  } finally {
    if (previousStrictLocalMode === undefined) delete process.env.HMC_STRICT_LOCAL_MODE;
    else process.env.HMC_STRICT_LOCAL_MODE = previousStrictLocalMode;
  }
});

test("bounded JSON reader rejects malformed and missing bodies as 400", async () => {
  await assert.rejects(() => readJsonObject(post("{")), /Invalid JSON body/);
  await assert.rejects(
    () => readJsonObject(new Request("http://localhost/test", { method: "POST" })),
    (error: unknown) => error instanceof RequestBodyError && error.status === 400,
  );
});

test("declared and streamed body sizes are capped in bytes with 413", async () => {
  await assert.rejects(
    () => readJsonObject(post("{}", { "Content-Length": "999" }), 32),
    (error: unknown) => error instanceof RequestBodyError && error.status === 413,
  );

  const multibyte = JSON.stringify({ value: "😀😀😀😀" });
  assert.ok(new TextEncoder().encode(multibyte).byteLength > 16);
  await assert.rejects(
    () => readJsonObject(post(multibyte), 16),
    (error: unknown) => error instanceof RequestBodyError && error.status === 413,
  );
});
