import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const moduleUrl = pathToFileURL(
  path.resolve("scripts/audit/prove-runtime-immutability.mjs"),
).href;

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "hma-immutable-source-"));
  const runtime = new Map([
    ["package.json", Buffer.from('{"private":true}\n')],
    [".next/server/app.js", Buffer.from("compiled\n")],
    ["node_modules/example/index.js", Buffer.from("dependency\n")],
  ]);
  for (const [relative, bytes] of runtime) {
    const absolute = path.join(root, ...relative.split("/"));
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, bytes);
  }
  const nodeBytes = await readFile(process.execPath);
  return {
    root,
    manifest: {
      commit: "e".repeat(40),
      nodeSha256: sha256(nodeBytes),
      runtimeFiles: [...runtime.entries()]
        .map(([relative, bytes]) => ({
          path: relative,
          size: bytes.byteLength,
          sha256: sha256(bytes),
        }))
        .sort((left, right) => left.path.localeCompare(right.path, "en")),
      bootstrapFiles: [],
    },
  };
}

test("two injected production cycles leave every staged runtime byte unchanged", async () => {
  const { proveRuntimeImmutability } = (await import(moduleUrl)) as {
    proveRuntimeImmutability: (options: {
      root: string;
      manifest: unknown;
      nodePath: string;
      applyPrivateAcl: () => Promise<void>;
      runCycle: (context: {
        stageRoot: string;
        cycle: number;
        environment: Record<string, string>;
      }) => Promise<void>;
    }) => Promise<{ ok: boolean; cycles: number; files: number }>;
  };
  const fixture = await createFixture();
  const seenSecrets = new Set<string>();

  try {
    const result = await proveRuntimeImmutability({
      root: fixture.root,
      manifest: fixture.manifest,
      nodePath: process.execPath,
      applyPrivateAcl: async () => {},
      runCycle: async ({ stageRoot, cycle, environment }) => {
        assert.equal(cycle === 1 || cycle === 2, true);
        assert.equal(environment.HMC_STRICT_LOCAL_MODE, "1");
        assert.equal(environment.HMC_LISTEN_HOST, "127.0.0.1");
        assert.equal(environment.PORT, "37645");
        assert.match(environment.APP_PASSWORD, /^[A-Za-z0-9_-]{43}$/u);
        seenSecrets.add(environment.APP_PASSWORD);
        assert.equal(
          await readFile(path.join(stageRoot, ".next", "server", "app.js"), "utf8"),
          "compiled\n",
        );
      },
    });

    assert.deepEqual(result, { ok: true, cycles: 2, files: 3 });
    assert.equal(seenSecrets.size, 2);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a child-created runtime file is rejected with no path, hash, or secret in the error", async () => {
  const { proveRuntimeImmutability } = (await import(moduleUrl)) as {
    proveRuntimeImmutability: (options: {
      root: string;
      manifest: unknown;
      nodePath: string;
      applyPrivateAcl: () => Promise<void>;
      runCycle: (context: {
        stageRoot: string;
        cycle: number;
        environment: Record<string, string>;
      }) => Promise<void>;
    }) => Promise<unknown>;
  };
  const fixture = await createFixture();
  let canary = "";

  try {
    await assert.rejects(
      proveRuntimeImmutability({
        root: fixture.root,
        manifest: fixture.manifest,
        nodePath: process.execPath,
        applyPrivateAcl: async () => {},
        runCycle: async ({ stageRoot, cycle, environment }) => {
          canary = environment.APP_PASSWORD;
          if (cycle === 1) {
            const added = path.join(stageRoot, ".next", "cache", "created.txt");
            await mkdir(path.dirname(added), { recursive: true });
            await writeFile(added, "mutation\n", "utf8");
          }
        },
      }),
      (error: unknown) => {
        const message = String(error);
        assert.equal(message.includes(canary), false);
        assert.equal(message.includes("created.txt"), false);
        assert.equal(message.includes(fixture.root), false);
        assert.equal(/[a-f0-9]{64}/u.test(message), false);
        return /runtime-immutability-failed/u.test(message);
      },
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("changed source bytes and wrong Node hash are rejected before a cycle", async () => {
  const { proveRuntimeImmutability } = (await import(moduleUrl)) as {
    proveRuntimeImmutability: (options: {
      root: string;
      manifest: {
        nodeSha256: string;
        runtimeFiles: Array<{ path: string; size: number; sha256: string }>;
      };
      nodePath: string;
      applyPrivateAcl: () => Promise<void>;
      runCycle: () => Promise<void>;
    }) => Promise<unknown>;
  };
  const fixture = await createFixture();
  let cycles = 0;

  try {
    await writeFile(
      path.join(fixture.root, "package.json"),
      '{"private":false}\n',
      "utf8",
    );
    await assert.rejects(
      proveRuntimeImmutability({
        root: fixture.root,
        manifest: fixture.manifest,
        nodePath: process.execPath,
        applyPrivateAcl: async () => {},
        runCycle: async () => {
          cycles += 1;
        },
      }),
      /runtime-immutability-failed/u,
    );
    assert.equal(cycles, 0);

    const fresh = await createFixture();
    try {
      fresh.manifest.nodeSha256 = "0".repeat(64);
      await assert.rejects(
        proveRuntimeImmutability({
          root: fresh.root,
          manifest: fresh.manifest,
          nodePath: process.execPath,
          applyPrivateAcl: async () => {},
          runCycle: async () => {
            cycles += 1;
          },
        }),
        /runtime-immutability-failed/u,
      );
      assert.equal(cycles, 0);
    } finally {
      await rm(fresh.root, { recursive: true, force: true });
    }
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test(
  "the real Windows private-stage ACL path supports a clean proof",
  { skip: process.platform !== "win32" },
  async () => {
    const { proveRuntimeImmutability } = (await import(moduleUrl)) as {
      proveRuntimeImmutability: (options: {
        root: string;
        manifest: unknown;
        nodePath: string;
        runCycle: () => Promise<void>;
        onSanitizedFailure: (code: string) => void;
      }) => Promise<{ ok: boolean; cycles: number }>;
    };
    const fixture = await createFixture();
    let failureCode = "";
    try {
      let result;
      try {
        result = await proveRuntimeImmutability({
          root: fixture.root,
          manifest: fixture.manifest,
          nodePath: process.execPath,
          runCycle: async () => {},
          onSanitizedFailure: (code) => {
            failureCode = code;
          },
        });
      } catch {
        assert.fail(`sanitized failure code: ${failureCode}`);
      }
      assert.equal(result.ok, true);
      assert.equal(result.cycles, 2);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  },
);
