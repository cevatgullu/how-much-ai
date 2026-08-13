import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  chmod,
  copyFile,
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

const generatorPath = path.resolve(
  "scripts/audit/create-runtime-manifest.mjs",
);
const generatorUrl = pathToFileURL(generatorPath).href;
const scannerUrl = pathToFileURL(
  path.resolve("scripts/audit/safe-secret-scan.mjs"),
).href;
const gitExecutablePath =
  process.platform === "win32"
    ? path.join(
        path.parse(process.env.SystemRoot ?? "C:\\Windows").root,
        "Program Files",
        "Git",
        "mingw64",
        "bin",
        "git.exe",
      )
    : execFileSync("sh", ["-c", "command -v git"], {
        encoding: "utf8",
      }).trim();

if (!gitExecutablePath || !path.isAbsolute(gitExecutablePath)) {
  throw new Error("The runtime-manifest tests require an absolute Git executable.");
}
const gitExecutableSha256 = createHash("sha256")
  .update(readFileSync(gitExecutablePath))
  .digest("hex");

const bootstrapPaths = [
  "scripts/windows/SecureLocalIntegrity.psm1",
  "scripts/windows/SecureLocalRuntime.psm1",
  "scripts/windows/SecureLocalSecrets.psm1",
  "scripts/windows/connect-claude-secure.ps1",
  "scripts/windows/launch-secure-local.ps1",
  "scripts/windows/oauth-handoff-extension/callback.js",
  "scripts/windows/oauth-handoff-extension/manifest.json",
  "scripts/windows/open-secure-local.ps1",
  "scripts/windows/start-secure-local.ps1",
  "scripts/windows/verify-final-local-state.ps1",
];

test("reviewed text inputs keep exact LF bytes on every Git checkout", async () => {
  const attributes = await readFile(path.resolve(".gitattributes"), "utf8");
  assert.equal(attributes, "* text=auto eol=lf\n");
});

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "hma-manifest-"));
  const syntheticPrivateKeyMarker = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");
  const files = new Map<string, string | Buffer>([
    ["package.json", '{"private":true}\n'],
    ["package-lock.json", '{"lockfileVersion":3}\n'],
    ["next.config.ts", "export default {};\n"],
    ["public/icon.svg", "<svg></svg>\n"],
    ["node_modules/example/index.js", "module.exports = true;\n"],
    [
      "node_modules/convex/dist/cli.bundle.cjs",
      `"${syntheticPrivateKeyMarker}"\n`,
    ],
    [
      "node_modules/convex/dist/cli.bundle.cjs.map",
      `"${syntheticPrivateKeyMarker}"\n`,
    ],
    [
      "node_modules/convex/src/cli/lib/formatEnvValueForDotfile.test.ts",
      `"${syntheticPrivateKeyMarker}"\n`,
    ],
    [
      "node_modules/next/dist/docs/01-app/02-guides/environment-variables.md",
      `${syntheticPrivateKeyMarker}\n`,
    ],
    [
      "node_modules/convex/dist/cli.bundle.cjs.runtime",
      "module.exports = 'near-match';\n",
    ],
    [".next/BUILD_ID", "reviewed-build\n"],
    [".next/app-path-routes-manifest.json", "{}\n"],
    [".next/server/app.js", "production bundle\n"],
    [".next/server/app.js.map", '"refreshToken":"synthetic"\n'],
    [".next/server/app.js.map.runtime", "production near-match\n"],
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

function withoutAmbientGitEnvironment(
  additions: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return Object.fromEntries([
    ...Object.entries(process.env).filter(
      ([key]) => !key.toUpperCase().startsWith("GIT_"),
    ),
    ...Object.entries(additions),
  ]);
}

function git(root: string, args: string[]): string {
  return execFileSync(
    gitExecutablePath,
    ["-c", "core.excludesFile=", "-C", root, ...args],
    {
      encoding: "utf8",
      env: withoutAmbientGitEnvironment(),
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    },
  ).trim();
}

async function createReviewedFixture(): Promise<{
  root: string;
  commit: string;
}> {
  const root = await createFixture();
  git(root, ["init", "--quiet"]);
  git(root, ["config", "core.autocrlf", "false"]);
  git(root, ["config", "user.email", "runtime-manifest@example.invalid"]);
  git(root, ["config", "user.name", "Runtime Manifest Test"]);
  git(root, [
    "add",
    "--force",
    "--",
    "package.json",
    "package-lock.json",
    "next.config.ts",
    "public",
    "scripts/windows",
  ]);
  git(root, ["commit", "--quiet", "-m", "reviewed runtime source"]);
  return { root, commit: git(root, ["rev-parse", "HEAD"]) };
}

function runManifestCli({
  root,
  commit,
  outputPath,
  sha256Path,
  cwd = root,
  env = withoutAmbientGitEnvironment(),
  expectedGitSha256 = gitExecutableSha256,
  upstreamBase = commit,
}: {
  root: string;
  commit: string;
  outputPath: string;
  sha256Path: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  expectedGitSha256?: string;
  upstreamBase?: string;
}) {
  return spawnSync(
    process.execPath,
    [
      generatorPath,
      "--root",
      root,
      "--commit",
      commit,
      "--node",
      process.execPath,
      "--git",
      gitExecutablePath,
      "--expected-git-sha256",
      expectedGitSha256,
      "--upstream-base",
      upstreamBase,
      "--output",
      outputPath,
      "--sha256-output",
      sha256Path,
    ],
    {
      cwd,
      encoding: "utf8",
      env,
      windowsHide: true,
    },
  );
}

test("security file snapshots retain exact bigint identity precision", async () => {
  const { sameSecurityFileSnapshot } = (await import(generatorUrl)) as {
    sameSecurityFileSnapshot: (
      left: {
        dev: bigint;
        ino: bigint;
        size: bigint;
        mtimeNs: bigint;
        ctimeNs: bigint;
      },
      right: {
        dev: bigint;
        ino: bigint;
        size: bigint;
        mtimeNs: bigint;
        ctimeNs: bigint;
      },
    ) => boolean;
  };
  const snapshot = {
    dev: 7n,
    ino: 9_007_199_254_740_993n,
    size: 9_007_199_254_740_995n,
    mtimeNs: 9_007_199_254_740_997n,
    ctimeNs: 9_007_199_254_740_999n,
  };

  assert.equal(sameSecurityFileSnapshot(snapshot, { ...snapshot }), true);
  assert.equal(
    sameSecurityFileSnapshot(snapshot, {
      ...snapshot,
      ino: snapshot.ino + 1n,
    }),
    false,
  );
  assert.equal(
    sameSecurityFileSnapshot(snapshot, {
      ...snapshot,
      mtimeNs: snapshot.mtimeNs + 1n,
    }),
    false,
  );
});

test("runtime manifest is deterministic and selects only exact installable files", async () => {
  const { createRuntimeManifest } = (await import(generatorUrl)) as {
    createRuntimeManifest: (options: {
      root: string;
      commit: string;
      nodePath: string;
      gitPath: string;
    }) => Promise<{
      manifest: {
        commit: string;
        nodeSha256: string;
        installerSha256: string;
        runtimeFiles: Array<{ path: string; size: number; sha256: string }>;
        bootstrapFiles: Array<{ path: string; size: number; sha256: string }>;
      };
      bytes: Buffer;
      sha256: string;
    }>;
  };
  const { root, commit } = await createReviewedFixture();

  try {
    const options = {
      root,
      commit,
      nodePath: process.execPath,
      gitPath: gitExecutablePath,
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
      ".next/BUILD_ID",
      ".next/app-path-routes-manifest.json",
      ".next/server/app.js",
      ".next/server/app.js.map.runtime",
      "next.config.ts",
      "node_modules/convex/dist/cli.bundle.cjs.runtime",
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
    assert.equal(
      first.manifest.installerSha256,
      createHash("sha256").update("public installer\n").digest("hex"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("manifest generation rejects relative and reparse-point Git executables", async () => {
  const { createRuntimeManifest } = (await import(generatorUrl)) as {
    createRuntimeManifest: (options: {
      root: string;
      commit: string;
      nodePath: string;
      gitPath: string;
      gitPath: string;
    }) => Promise<unknown>;
  };
  const { root, commit } = await createReviewedFixture();
  const junctionRoot = await mkdtemp(
    path.join(os.tmpdir(), "hma-manifest-git-junction-"),
  );
  const junction = path.join(junctionRoot, "git-bin");

  try {
    await assert.rejects(
      createRuntimeManifest({
        root,
        commit,
        nodePath: process.execPath,
        gitPath: "git.exe",
      }),
      /runtime-manifest-failed/u,
    );
    if (process.platform === "win32") {
      await assert.rejects(
        createRuntimeManifest({
          root,
          commit,
          nodePath: process.execPath,
          gitPath: path.join(
            path.parse(process.execPath).root,
            "Program Files",
            "Git",
            "cmd",
            "git.exe",
          ),
        }),
        /runtime-manifest-failed/u,
      );
    }
    await symlink(path.dirname(gitExecutablePath), junction, "junction");
    await assert.rejects(
      createRuntimeManifest({
        root,
        commit,
        nodePath: process.execPath,
        gitPath: path.join(junction, path.basename(gitExecutablePath)),
      }),
      /runtime-manifest-failed/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(junctionRoot, { recursive: true, force: true });
  }
});

test(
  "manifest CLI ignores a repository-local fake git.exe and uses the reviewed absolute executable",
  { skip: process.platform !== "win32" },
  async () => {
    const { root, commit } = await createReviewedFixture();
    const workingDirectory = path.join(root, ".next");
    const fakeGit = path.join(workingDirectory, "git.exe");
    const outputPath = path.join(root, "audit", "runtime-manifest.json");
    const sha256Path = path.join(root, "audit", "runtime-manifest.sha256");
    const harmlessExecutable = execFileSync("where.exe", ["where.exe"], {
      encoding: "utf8",
      windowsHide: true,
    })
      .split(/\r?\n/u)
      .find(Boolean);

    try {
      assert.ok(harmlessExecutable);
      await copyFile(harmlessExecutable, fakeGit);
      const shadowed = spawnSync("git", ["--version"], {
        cwd: workingDirectory,
        encoding: "utf8",
        env: withoutAmbientGitEnvironment(),
        windowsHide: true,
      });
      assert.doesNotMatch(shadowed.stdout, /^git version /u);

      const result = runManifestCli({
        root,
        commit,
        outputPath,
        sha256Path,
        cwd: workingDirectory,
      });
      assert.equal(result.status, 0);
      const manifestBytes = await readFile(outputPath);
      const manifestSha256 = createHash("sha256")
        .update(manifestBytes)
        .digest("hex");
      assert.equal(
        await readFile(sha256Path, "ascii"),
        manifestSha256,
      );
      const publishedManifest = JSON.parse(manifestBytes.toString("utf8"));
      assert.deepEqual(JSON.parse(result.stdout), {
        ok: true,
        runtimeFiles: publishedManifest.runtimeFiles.length,
        bootstrapFiles: publishedManifest.bootstrapFiles.length,
        manifestSha256,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("manifest CLI rejects an untrusted Git hash and an unproven upstream base", async () => {
  const { root, commit } = await createReviewedFixture();
  const outputPath = path.join(root, "audit", "runtime-manifest.json");
  const sha256Path = path.join(root, "audit", "runtime-manifest.sha256");

  try {
    for (const overrides of [
      { expectedGitSha256: "0".repeat(64) },
      { upstreamBase: "0".repeat(40) },
    ]) {
      const result = runManifestCli({
        root,
        commit,
        outputPath,
        sha256Path,
        ...overrides,
      });
      assert.equal(result.status, 1);
      assert.match(
        result.stderr,
        /\{"ok":false,"error":"runtime-manifest-failed"\}\r?\n$/u,
      );
      await assert.rejects(readFile(outputPath), { code: "ENOENT" });
      await assert.rejects(readFile(sha256Path), { code: "ENOENT" });
    }
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
      gitPath: string;
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
  const { root, commit } = await createReviewedFixture();
  const manifestPath = path.join(root, "manifest.json");

  try {
    const generated = await createRuntimeManifest({
      root,
      commit,
      nodePath: process.execPath,
      gitPath: gitExecutablePath,
    });
    await writeFile(manifestPath, generated.bytes);
    await writeFile(
      manifestPath.replace(/\.json$/u, ".sha256"),
      generated.sha256,
      "ascii",
    );
    const scanned = await scanSecrets({
      cwd: root,
      manifestPath,
      expectedManifestSha256: generated.sha256,
    });
    const manifestPaths = [
      ...generated.manifest.runtimeFiles,
      ...generated.manifest.bootstrapFiles,
      {
        path: "scripts/windows/install-secure-local.ps1",
        sha256: generated.manifest.installerSha256,
      },
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

test("manifest generation rejects missing, additional, and colliding inputs", async () => {
  const {
    assertUniqueNormalizedPaths,
    createRuntimeManifest,
  } = (await import(generatorUrl)) as {
    assertUniqueNormalizedPaths: (paths: string[]) => void;
    createRuntimeManifest: (options: {
      root: string;
      commit: string;
      nodePath: string;
      gitPath: string;
    }) => Promise<unknown>;
  };
  const { root, commit } = await createReviewedFixture();

  try {
    await rm(path.join(root, ...bootstrapPaths[0].split("/")));
    await assert.rejects(
      createRuntimeManifest({
        root,
        commit,
        nodePath: process.execPath,
        gitPath: gitExecutablePath,
      }),
      /runtime-manifest-failed/u,
    );

    await writeFile(
      path.join(root, ...bootstrapPaths[0].split("/")),
      "reviewed\n",
      "utf8",
    );
    await writeFile(
      path.join(root, "scripts", "windows", "unexpected.ps1"),
      "unexpected\n",
      "utf8",
    );
    await assert.rejects(
      createRuntimeManifest({
        root,
        commit,
        nodePath: process.execPath,
        gitPath: gitExecutablePath,
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

test("manifest generation rejects an untracked public runtime input", async () => {
  const { createRuntimeManifest } = (await import(generatorUrl)) as {
    createRuntimeManifest: (options: {
      root: string;
      commit: string;
      nodePath: string;
      gitPath: string;
    }) => Promise<unknown>;
  };
  const { root, commit } = await createReviewedFixture();

  try {
    await writeFile(
      path.join(root, "public", "not-reviewed.js"),
      "globalThis.unreviewed = true;\n",
      "utf8",
    );
    await assert.rejects(
      createRuntimeManifest({
        root,
        commit,
        nodePath: process.execPath,
        gitPath: gitExecutablePath,
      }),
      /runtime-manifest-failed/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("manifest generation rejects an untracked application build input", async () => {
  const { createRuntimeManifest } = (await import(generatorUrl)) as {
    createRuntimeManifest: (options: {
      root: string;
      commit: string;
      nodePath: string;
      gitPath: string;
    }) => Promise<unknown>;
  };
  const { root, commit } = await createReviewedFixture();
  const rogueSource = path.join(root, "app", "rogue", "page.tsx");

  try {
    await mkdir(path.dirname(rogueSource), { recursive: true });
    await writeFile(
      rogueSource,
      "export default function Rogue() { return 'unreviewed'; }\n",
      "utf8",
    );
    await assert.rejects(
      createRuntimeManifest({
        root,
        commit,
        nodePath: process.execPath,
        gitPath: gitExecutablePath,
      }),
      /runtime-manifest-failed/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("manifest generation rejects an application change hidden by a fake fsmonitor hook", async () => {
  const { createRuntimeManifest } = (await import(generatorUrl)) as {
    createRuntimeManifest: (options: {
      root: string;
      commit: string;
      nodePath: string;
      gitPath: string;
    }) => Promise<unknown>;
  };
  const { root } = await createReviewedFixture();
  const trackedSource = path.join(root, "app", "tracked", "page.tsx");
  const hookPath = path.join(root, ".git", "hooks", "fake-fsmonitor");

  try {
    await mkdir(path.dirname(trackedSource), { recursive: true });
    await writeFile(trackedSource, "export default 'AAAA';\n", "utf8");
    git(root, ["add", "--force", "--", "app/tracked/page.tsx"]);
    git(root, ["commit", "--quiet", "-m", "review application input"]);
    const commit = git(root, ["rev-parse", "HEAD"]);

    await writeFile(
      hookPath,
      "#!/bin/sh\nprintf 'fake-token\\000'\n",
      "utf8",
    );
    await chmod(hookPath, 0o755);
    git(root, [
      "config",
      "core.fsmonitor",
      hookPath.replaceAll("\\", "/"),
    ]);
    git(root, ["config", "core.fsmonitorHookVersion", "2"]);
    assert.equal(
      git(root, [
        "status",
        "--porcelain=v1",
        "--untracked-files=no",
      ]),
      "",
    );

    await writeFile(trackedSource, "export default 'BBBB';\n", "utf8");
    assert.equal(
      git(root, [
        "status",
        "--porcelain=v1",
        "--untracked-files=no",
      ]),
      "",
      "the fixture must prove that the fake fsmonitor hid the changed bytes",
    );
    assert.match(
      git(root, ["ls-files", "-f", "--", "app/tracked/page.tsx"]),
      /^h /u,
      "the fixture must set Git's fsmonitor-valid index bit",
    );
    await assert.rejects(
      createRuntimeManifest({
        root,
        commit,
        nodePath: process.execPath,
        gitPath: gitExecutablePath,
      }),
      /runtime-manifest-failed/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("manifest generation rejects an ignored application build input", async () => {
  const { createRuntimeManifest } = (await import(generatorUrl)) as {
    createRuntimeManifest: (options: {
      root: string;
      commit: string;
      nodePath: string;
      gitPath: string;
    }) => Promise<unknown>;
  };
  const { root, commit } = await createReviewedFixture();
  const rogueSource = path.join(root, "app", "rogue", "page.tsx");

  try {
    await writeFile(
      path.join(root, ".git", "info", "exclude"),
      "app/rogue/page.tsx\n",
      "utf8",
    );
    await mkdir(path.dirname(rogueSource), { recursive: true });
    await writeFile(
      rogueSource,
      "export default function Rogue() { return 'ignored'; }\n",
      "utf8",
    );
    assert.equal(
      git(root, ["check-ignore", "app/rogue/page.tsx"]),
      "app/rogue/page.tsx",
    );
    await assert.rejects(
      createRuntimeManifest({
        root,
        commit,
        nodePath: process.execPath,
        gitPath: gitExecutablePath,
      }),
      /runtime-manifest-failed/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("manifest generation permits only the reviewed ignored generated paths", async () => {
  const { createRuntimeManifest } = (await import(generatorUrl)) as {
    createRuntimeManifest: (options: {
      root: string;
      commit: string;
      nodePath: string;
      gitPath: string;
    }) => Promise<unknown>;
  };
  const { root, commit } = await createReviewedFixture();

  try {
    await writeFile(
      path.join(root, ".git", "info", "exclude"),
      [
        ".next/",
        "node_modules/",
        "audit/",
        "next-env.d.ts",
        "*.tsbuildinfo",
        "",
      ].join("\n"),
      "utf8",
    );
    await mkdir(path.join(root, "audit", "final"), { recursive: true });
    await writeFile(
      path.join(root, "audit", "final", "review.json"),
      "{}\n",
      "utf8",
    );
    await writeFile(
      path.join(root, "next-env.d.ts"),
      "/// <reference types=\"next\" />\n",
      "utf8",
    );
    await writeFile(
      path.join(root, "tsconfig.tsbuildinfo"),
      "{}\n",
      "utf8",
    );

    await createRuntimeManifest({
      root,
      commit,
      nodePath: process.execPath,
      gitPath: gitExecutablePath,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("manifest generation rejects an ignored nested tsbuildinfo input", async () => {
  const { createRuntimeManifest } = (await import(generatorUrl)) as {
    createRuntimeManifest: (options: {
      root: string;
      commit: string;
      nodePath: string;
      gitPath: string;
    }) => Promise<unknown>;
  };
  const { root, commit } = await createReviewedFixture();
  const nestedBuildInfo = path.join(root, "app", "rogue.tsbuildinfo");

  try {
    await writeFile(
      path.join(root, ".git", "info", "exclude"),
      "*.tsbuildinfo\n",
      "utf8",
    );
    await mkdir(path.dirname(nestedBuildInfo), { recursive: true });
    await writeFile(nestedBuildInfo, "{}\n", "utf8");
    await assert.rejects(
      createRuntimeManifest({
        root,
        commit,
        nodePath: process.execPath,
        gitPath: gitExecutablePath,
      }),
      /runtime-manifest-failed/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("manifest generation rejects an untracked top-level runtime input", async () => {
  const { createRuntimeManifest } = (await import(generatorUrl)) as {
    createRuntimeManifest: (options: {
      root: string;
      commit: string;
      nodePath: string;
      gitPath: string;
    }) => Promise<unknown>;
  };
  const { root } = await createReviewedFixture();

  try {
    git(root, ["rm", "--cached", "--quiet", "--", "package.json"]);
    git(root, ["commit", "--quiet", "-m", "remove reviewed package input"]);
    const commit = git(root, ["rev-parse", "HEAD"]);
    await assert.rejects(
      createRuntimeManifest({
        root,
        commit,
        nodePath: process.execPath,
        gitPath: gitExecutablePath,
      }),
      /runtime-manifest-failed/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("manifest generation binds tracked working bytes to the exact HEAD blob", async () => {
  const { createRuntimeManifest } = (await import(generatorUrl)) as {
    createRuntimeManifest: (options: {
      root: string;
      commit: string;
      nodePath: string;
      gitPath: string;
    }) => Promise<unknown>;
  };
  const { root, commit } = await createReviewedFixture();

  try {
    await writeFile(
      path.join(root, "public", "icon.svg"),
      "<svg><script>changed()</script></svg>\n",
      "utf8",
    );
    await assert.rejects(
      createRuntimeManifest({
        root,
        commit,
        nodePath: process.execPath,
        gitPath: gitExecutablePath,
      }),
      /runtime-manifest-failed/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("manifest generation rejects a reviewed commit that is no longer HEAD", async () => {
  const { createRuntimeManifest } = (await import(generatorUrl)) as {
    createRuntimeManifest: (options: {
      root: string;
      commit: string;
      nodePath: string;
      gitPath: string;
    }) => Promise<unknown>;
  };
  const { root, commit } = await createReviewedFixture();

  try {
    git(root, [
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "advance reviewed head",
    ]);
    await assert.rejects(
      createRuntimeManifest({
        root,
        commit,
        nodePath: process.execPath,
        gitPath: gitExecutablePath,
      }),
      /runtime-manifest-failed/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const hiddenIndexFlag of ["--assume-unchanged", "--skip-worktree"]) {
  test(`manifest generation rejects ${hiddenIndexFlag.slice(2)} index flags`, async () => {
    const { createRuntimeManifest } = (await import(generatorUrl)) as {
      createRuntimeManifest: (options: {
        root: string;
        commit: string;
        nodePath: string;
        gitPath: string;
      }) => Promise<unknown>;
    };
    const { root, commit } = await createReviewedFixture();

    try {
      git(root, [
        "update-index",
        hiddenIndexFlag,
        "--",
        "public/icon.svg",
      ]);
      await assert.rejects(
        createRuntimeManifest({
          root,
          commit,
          nodePath: process.execPath,
          gitPath: gitExecutablePath,
        }),
        /runtime-manifest-failed/u,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("manifest generation rejects a privilege-free directory junction", async () => {
  const { createRuntimeManifest } = (await import(generatorUrl)) as {
    createRuntimeManifest: (options: {
      root: string;
      commit: string;
      nodePath: string;
      gitPath: string;
    }) => Promise<unknown>;
  };
  const { root, commit } = await createReviewedFixture();
  const target = await mkdtemp(path.join(os.tmpdir(), "hma-manifest-external-"));
  const link = path.join(root, "node_modules", "linked-directory");

  try {
    await writeFile(path.join(target, "outside.txt"), "outside\n", "utf8");
    await symlink(target, link, "junction");
    await assert.rejects(
      createRuntimeManifest({
        root,
        commit,
        nodePath: process.execPath,
        gitPath: gitExecutablePath,
      }),
      /runtime-manifest-failed/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
  }
});

for (const variable of ["GIT_DIR", "GIT_WORK_TREE"]) {
  test(`manifest CLI rejects ambient ${variable}`, async () => {
    const { root, commit } = await createReviewedFixture();
    const outputPath = path.join(root, "audit", "runtime-manifest.json");
    const sha256Path = path.join(root, "audit", "runtime-manifest.sha256");

    try {
      const result = runManifestCli({
        root,
        commit,
        outputPath,
        sha256Path,
        env: withoutAmbientGitEnvironment({
          [variable]: variable === "GIT_DIR" ? path.join(root, ".git") : root,
        }),
      });
      assert.equal(result.status, 1);
      assert.match(
        result.stderr,
        /\{"ok":false,"error":"runtime-manifest-failed"\}\r?\n$/u,
      );
      await assert.rejects(readFile(outputPath), { code: "ENOENT" });
      await assert.rejects(readFile(sha256Path), { code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("manifest CLI never publishes a manifest beside a pre-existing mismatched sha256", async () => {
  const { root, commit } = await createReviewedFixture();
  const outputPath = path.join(root, "audit", "runtime-manifest.json");
  const sha256Path = path.join(root, "audit", "runtime-manifest.sha256");
  const mismatchedSha256 = `${"0".repeat(64)}\n`;

  try {
    await mkdir(path.dirname(sha256Path), { recursive: true });
    await writeFile(sha256Path, mismatchedSha256, {
      encoding: "ascii",
      flag: "wx",
    });
    const result = runManifestCli({
      root,
      commit,
      outputPath,
      sha256Path,
    });

    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /\{"ok":false,"error":"runtime-manifest-failed"\}\r?\n$/u,
    );
    await assert.rejects(readFile(outputPath), { code: "ENOENT" });
    assert.equal(await readFile(sha256Path, "ascii"), mismatchedSha256);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
