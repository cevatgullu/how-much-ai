import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const generatorUrl = pathToFileURL(
  path.resolve("scripts/audit/create-runtime-manifest.mjs"),
).href;
const scannerUrl = pathToFileURL(
  path.resolve("scripts/audit/safe-secret-scan.mjs"),
).href;

const bootstrapPaths = [
  "scripts/windows/connect-claude-secure.ps1",
  "scripts/windows/oauth-handoff-extension/callback.js",
  "scripts/windows/oauth-handoff-extension/manifest.json",
  "scripts/windows/open-secure-local.ps1",
  "scripts/windows/SecureLocalIntegrity.psm1",
  "scripts/windows/SecureLocalRuntime.psm1",
  "scripts/windows/SecureLocalSecrets.psm1",
  "scripts/windows/start-secure-local.ps1",
  "scripts/windows/verify-final-local-state.ps1",
];

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "hma-manifest-"));
  const files = new Map<string, string | Buffer>([
    ["package.json", '{"private":true}\n'],
    ["package-lock.json", '{"lockfileVersion":3}\n'],
    ["next.config.ts", "export default {};\n"],
    ["public/icon.svg", "<svg></svg>\n"],
    ["node_modules/example/index.js", "module.exports = true;\n"],
    [".next/server/app.js", "production bundle\n"],
    [".next/cache/transient.bin", Buffer.from([1, 2, 3])],
    ...bootstrapPaths.map(
      (entry) =>
        [
          entry,
          entry.endsWith(".json") ? '{"manifest_version":3}\n' : "reviewed\n",
        ] as [string, string],
    ),
    ["scripts/windows/install-secure-local.ps1", "public installer\n"],
  ]);
  for (const [relative, content] of files) {
    const absolute = path.join(root, ...relative.split("/"));
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
  }
  return root;
}

test("runtime manifest is deterministic and selects only exact installable files", async () => {
  const { createRuntimeManifest } = (await import(generatorUrl)) as {
    createRuntimeManifest: (options: {
      root: string;
      commit: string;
      nodePath: string;
      trackedPaths: Set<string>;
    }) => Promise<{
      manifest: {
        commit: string;
        nodeSha256: string;
        runtimeFiles: Array<{ path: string; size: number; sha256: string }>;
        bootstrapFiles: Array<{ path: string; size: number; sha256: string }>;
      };
      bytes: Buffer;
      sha256: string;
    }>;
  };
  const root = await createFixture();

  try {
    const options = {
      root,
      commit: "a".repeat(40),
      nodePath: process.execPath,
      trackedPaths: new Set(bootstrapPaths),
    };
    const first = await createRuntimeManifest(options);
    const second = await createRuntimeManifest(options);
    const runtimePaths = first.manifest.runtimeFiles.map((entry) => entry.path);

    assert.deepEqual(first.bytes, second.bytes);
    assert.equal(first.sha256, second.sha256);
    assert.equal(
      first.sha256,
      createHash("sha256").update(first.bytes).digest("hex"),
    );
    assert.deepEqual(runtimePaths, [
      ".next/server/app.js",
      "next.config.ts",
      "node_modules/example/index.js",
      "package-lock.json",
      "package.json",
      "public/icon.svg",
    ]);
    assert.deepEqual(
      first.manifest.bootstrapFiles.map((entry) => entry.path),
      bootstrapPaths,
    );
    assert.equal(runtimePaths.includes(".next/cache/transient.bin"), false);
    assert.equal(
      first.manifest.bootstrapFiles.some((entry) =>
        entry.path.endsWith("install-secure-local.ps1"),
      ),
      false,
    );
    assert.match(first.manifest.nodeSha256, /^[a-f0-9]{64}$/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("manifest paths are all examined by the non-content-emitting scanner", async () => {
  const { createRuntimeManifest } = (await import(generatorUrl)) as {
    createRuntimeManifest: (options: {
      root: string;
      commit: string;
      nodePath: string;
      trackedPaths: Set<string>;
    }) => Promise<{
      manifest: {
        runtimeFiles: Array<{ path: string }>;
        bootstrapFiles: Array<{ path: string }>;
      };
      bytes: Buffer;
    }>;
  };
  const { scanSecrets } = (await import(scannerUrl)) as {
    scanSecrets: (options: {
      cwd: string;
      manifestPath: string;
    }) => Promise<{
      filesScanned: number;
      examinedPathHashes: string[];
    }>;
  };
  const root = await createFixture();
  const manifestPath = path.join(root, "manifest.json");

  try {
    const generated = await createRuntimeManifest({
      root,
      commit: "b".repeat(40),
      nodePath: process.execPath,
      trackedPaths: new Set(bootstrapPaths),
    });
    await writeFile(manifestPath, generated.bytes);
    const scanned = await scanSecrets({ cwd: root, manifestPath });
    const manifestPaths = [
      ...generated.manifest.runtimeFiles,
      ...generated.manifest.bootstrapFiles,
    ];

    assert.equal(scanned.filesScanned, manifestPaths.length);
    assert.equal(
      scanned.examinedPathHashes.length,
      new Set(manifestPaths.map((entry) => entry.path)).size,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("manifest generation rejects missing, additional, untracked, and colliding inputs", async () => {
  const {
    assertUniqueNormalizedPaths,
    createRuntimeManifest,
  } = (await import(generatorUrl)) as {
    assertUniqueNormalizedPaths: (paths: string[]) => void;
    createRuntimeManifest: (options: {
      root: string;
      commit: string;
      nodePath: string;
      trackedPaths: Set<string>;
    }) => Promise<unknown>;
  };
  const root = await createFixture();

  try {
    await assert.rejects(
      createRuntimeManifest({
        root,
        commit: "c".repeat(40),
        nodePath: process.execPath,
        trackedPaths: new Set(bootstrapPaths.slice(1)),
      }),
      /runtime-manifest-failed/u,
    );

    await writeFile(
      path.join(root, "scripts", "windows", "unexpected.ps1"),
      "unexpected\n",
      "utf8",
    );
    await assert.rejects(
      createRuntimeManifest({
        root,
        commit: "c".repeat(40),
        nodePath: process.execPath,
        trackedPaths: new Set([...bootstrapPaths, "scripts/windows/unexpected.ps1"]),
      }),
      /runtime-manifest-failed/u,
    );

    assert.throws(
      () => assertUniqueNormalizedPaths(["public/A.js", "public/a.js"]),
      /runtime-manifest-failed/u,
    );
    assert.throws(
      () => assertUniqueNormalizedPaths(["public/evil\u0000.js"]),
      /runtime-manifest-failed/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("manifest generation rejects a reparse/symbolic entry", async (t) => {
  const { createRuntimeManifest } = (await import(generatorUrl)) as {
    createRuntimeManifest: (options: {
      root: string;
      commit: string;
      nodePath: string;
      trackedPaths: Set<string>;
    }) => Promise<unknown>;
  };
  const root = await createFixture();
  const target = path.join(root, "outside.txt");
  const link = path.join(root, "public", "linked.txt");

  try {
    await writeFile(target, "outside\n", "utf8");
    try {
      await symlink(target, link, "file");
    } catch {
      t.skip("Creating a symbolic link is not permitted on this Windows host.");
      return;
    }
    await assert.rejects(
      createRuntimeManifest({
        root,
        commit: "d".repeat(40),
        nodePath: process.execPath,
        trackedPaths: new Set(bootstrapPaths),
      }),
      /runtime-manifest-failed/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
