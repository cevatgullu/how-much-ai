import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
import http from "node:http";

const moduleUrl = pathToFileURL(
  path.resolve("scripts/audit/prove-runtime-immutability.mjs"),
).href;

type RuntimeListener = {
  localAddress: string;
  localPort: number;
  pid: number;
};

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "hma-immutable-source-"));
  const runtime = new Map([
    ["package.json", Buffer.from('{"private":true}\n')],
    [".next/BUILD_ID", Buffer.from("reviewed-build\n")],
    [".next/app-path-routes-manifest.json", Buffer.from("{}\n")],
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
      installerSha256: "f".repeat(64),
      runtimeFiles: [...runtime.entries()]
        .map(([relative, bytes]) => ({
          path: relative,
          size: bytes.byteLength,
          sha256: sha256(bytes),
        }))
        .sort((left, right) =>
          left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
        ),
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
  const baseEnvironmentNames = [
    "APPDATA",
    "COMSPEC",
    "HOMEDRIVE",
    "HOMEPATH",
    "LOCALAPPDATA",
    "NUMBER_OF_PROCESSORS",
    "OS",
    "PATHEXT",
    "PROCESSOR_ARCHITECTURE",
    "PROCESSOR_IDENTIFIER",
    "SYSTEMDRIVE",
    "SYSTEMROOT",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "WINDIR",
  ];
  const syntheticBaseNames = new Set([
    "APPDATA",
    "LOCALAPPDATA",
    "TEMP",
    "TMP",
    "USERPROFILE",
  ]);
  const processEnvironmentNames = new Set(
    Object.entries(process.env)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
      .map(([name]) => name.toUpperCase()),
  );
  const expectedEnvironmentNames = [
    ...baseEnvironmentNames.filter(
      (name) => syntheticBaseNames.has(name) || processEnvironmentNames.has(name),
    ),
    "APP_PASSWORD",
    "AUTH_SECRET",
    "ENABLE_LOCAL_CONNECT",
    "HMC_LISTEN_HOST",
    "HMC_LISTEN_PORT",
    "HMC_STRICT_LOCAL_MODE",
    "NEXT_TELEMETRY_DISABLED",
    "NODE_ENV",
    "PORT",
    "TRUST_PROXY_IP_HEADERS",
    "VAULT_DATA_DIR",
    "VAULT_ENCRYPTION_SECRET",
  ].sort();

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
        assert.deepEqual(Object.keys(environment).sort(), expectedEnvironmentNames);
        assert.equal("PATH" in environment, false);
        assert.equal("HOME" in environment, false);
        assert.equal("NODE_OPTIONS" in environment, false);
        assert.equal("NPM_CONFIG_USERCONFIG" in environment, false);
        assert.notEqual(
          path.resolve(environment.USERPROFILE).toLowerCase(),
          path.resolve(process.env.USERPROFILE ?? os.homedir()).toLowerCase(),
        );
        assert.equal(
          path.resolve(environment.APPDATA).startsWith(
            `${path.resolve(environment.USERPROFILE)}${path.sep}`,
          ),
          true,
        );
        seenSecrets.add(environment.APP_PASSWORD);
        assert.equal(
          await readFile(path.join(stageRoot, ".next", "server", "app.js"), "utf8"),
          "compiled\n",
        );
      },
    });

    assert.deepEqual(result, { ok: true, cycles: 2, files: 5 });
    assert.equal(seenSecrets.size, 1);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("production observation dwells through repeated owned readiness checks", async () => {
  const { observeOwnedRuntimeStability } = (await import(moduleUrl)) as {
    observeOwnedRuntimeStability: (options: {
      child: { pid: number; exitCode: number | null; signalCode: string | null };
      listenerProbe: () => Promise<RuntimeListener[]>;
      readiness: () => Promise<boolean>;
      pause: () => Promise<void>;
      observations?: number;
    }) => Promise<void>;
  };
  const child = { pid: 930, exitCode: null, signalCode: null };
  let pauses = 0;
  let readinessCalls = 0;
  let listenerCalls = 0;

  await observeOwnedRuntimeStability({
    child,
    listenerProbe: async () => {
      listenerCalls += 1;
      return [{ localAddress: "127.0.0.1", localPort: 37645, pid: child.pid }];
    },
    readiness: async () => {
      readinessCalls += 1;
      return true;
    },
    pause: async () => {
      pauses += 1;
    },
    observations: 10,
  });

  assert.equal(pauses, 10);
  assert.equal(readinessCalls, 10);
  assert.equal(listenerCalls, 20);

  let replacementProbe = 0;
  await assert.rejects(
    observeOwnedRuntimeStability({
      child,
      listenerProbe: async () => {
        replacementProbe += 1;
        return [{
          localAddress: "127.0.0.1",
          localPort: 37645,
          pid: replacementProbe < 4 ? child.pid : child.pid + 1,
        }];
      },
      readiness: async () => true,
      pause: async () => {},
      observations: 10,
    }),
    /service-listener-owner-mismatch/u,
  );
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

test("a child-created empty runtime directory is rejected", async () => {
  const { proveRuntimeImmutability } = (await import(moduleUrl)) as {
    proveRuntimeImmutability: (options: {
      root: string;
      manifest: unknown;
      nodePath: string;
      applyPrivateAcl: () => Promise<void>;
      runCycle: (context: {
        stageRoot: string;
        cycle: number;
      }) => Promise<void>;
    }) => Promise<unknown>;
  };
  const fixture = await createFixture();

  try {
    await assert.rejects(
      proveRuntimeImmutability({
        root: fixture.root,
        manifest: fixture.manifest,
        nodePath: process.execPath,
        applyPrivateAcl: async () => {},
        runCycle: async ({ stageRoot, cycle }) => {
          if (cycle === 1) {
            await mkdir(path.join(stageRoot, ".next", "cache"), {
              recursive: true,
            });
          }
        },
      }),
      /runtime-immutability-failed/u,
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
        installerSha256: string;
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

test("a jointly replaced manifest and digest cannot reach a production cycle", async () => {
  const { proveRuntimeImmutabilityFromManifest } = (await import(moduleUrl)) as {
    proveRuntimeImmutabilityFromManifest: (options: {
      root: string;
      manifestPath: string;
      expectedManifestSha256: string;
      nodePath: string;
      applyPrivateAcl: () => Promise<void>;
      runCycle: () => Promise<void>;
    }) => Promise<unknown>;
  };
  const fixture = await createFixture();
  const manifestPath = path.join(fixture.root, "runtime-manifest.json");
  const digestPath = path.join(fixture.root, "runtime-manifest.sha256");
  let cycles = 0;

  try {
    const trustedBytes = Buffer.from(JSON.stringify(fixture.manifest), "utf8");
    const expectedManifestSha256 = sha256(trustedBytes);
    await writeFile(manifestPath, trustedBytes);
    await writeFile(digestPath, expectedManifestSha256, "ascii");
    const replacedManifest = {
      ...fixture.manifest,
      nodeSha256: "0".repeat(64),
    };
    const replacedBytes = Buffer.from(JSON.stringify(replacedManifest), "utf8");
    await writeFile(manifestPath, replacedBytes);
    await writeFile(digestPath, sha256(replacedBytes), "ascii");

    await assert.rejects(
      proveRuntimeImmutabilityFromManifest({
        root: fixture.root,
        manifestPath,
        expectedManifestSha256,
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
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("readiness proof rejects an existing listener and a listener owned by another process", async () => {
  const {
    assertRuntimePortAvailable,
    waitForOwnedReadiness,
  } = (await import(moduleUrl)) as {
    assertRuntimePortAvailable: (
      listenerProbe: () => Promise<RuntimeListener[]>,
    ) => Promise<void>;
    waitForOwnedReadiness: (options: {
      child: { pid: number; exitCode: number | null; signalCode: string | null };
      listenerProbe: () => Promise<RuntimeListener[]>;
      readiness: () => Promise<boolean>;
      pause: () => Promise<void>;
      deadline: number;
    }) => Promise<void>;
  };

  await assert.rejects(
    assertRuntimePortAvailable(async () => [
      { localAddress: "127.0.0.1", localPort: 37645, pid: 901 },
    ]),
    /service-port-in-use/u,
  );

  let readinessCalls = 0;
  await assert.rejects(
    waitForOwnedReadiness({
      child: { pid: 902, exitCode: null, signalCode: null },
      listenerProbe: async () => [
        { localAddress: "127.0.0.1", localPort: 37645, pid: 901 },
      ],
      readiness: async () => {
        readinessCalls += 1;
        return true;
      },
      pause: async () => {
        throw new Error("unexpected-pause");
      },
      deadline: Date.now() + 1_000,
    }),
    /service-listener-owner-mismatch/u,
  );
  assert.equal(readinessCalls, 0);
});

test("readiness rejects wildcard, LAN, IPv6, and additional listeners", async () => {
  const { waitForOwnedReadiness } = (await import(moduleUrl)) as {
    waitForOwnedReadiness: (options: {
      child: { pid: number; exitCode: number | null; signalCode: string | null };
      listenerProbe: () => Promise<RuntimeListener[]>;
      readiness: () => Promise<boolean>;
      pause: () => Promise<void>;
      deadline: number;
    }) => Promise<void>;
  };
  const invalidSnapshots: RuntimeListener[][] = [
    [{ localAddress: "0.0.0.0", localPort: 37645, pid: 903 }],
    [{ localAddress: "192.0.2.10", localPort: 37645, pid: 903 }],
    [{ localAddress: "::1", localPort: 37645, pid: 903 }],
    [
      { localAddress: "127.0.0.1", localPort: 37645, pid: 903 },
      { localAddress: "0.0.0.0", localPort: 37645, pid: 903 },
    ],
  ];

  for (const listeners of invalidSnapshots) {
    let readinessCalls = 0;
    await assert.rejects(
      waitForOwnedReadiness({
        child: { pid: 903, exitCode: null, signalCode: null },
        listenerProbe: async () => listeners,
        readiness: async () => {
          readinessCalls += 1;
          return true;
        },
        pause: async () => {
          throw new Error("unexpected-pause");
        },
        deadline: Date.now() + 1_000,
      }),
      /service-listener-owner-mismatch/u,
    );
    assert.equal(readinessCalls, 0);

    const snapshots = [
      [{ localAddress: "127.0.0.1", localPort: 37645, pid: 903 }],
      listeners,
    ];
    await assert.rejects(
      waitForOwnedReadiness({
        child: { pid: 903, exitCode: null, signalCode: null },
        listenerProbe: async () => snapshots.shift() ?? [],
        readiness: async () => {
          readinessCalls += 1;
          return true;
        },
        pause: async () => {
          throw new Error("unexpected-pause");
        },
        deadline: Date.now() + 1_000,
      }),
      /service-listener-owner-mismatch/u,
    );
    assert.equal(readinessCalls, 1);
  }
});

test("readiness is accepted only while the launched child exclusively owns loopback", async () => {
  const { waitForOwnedReadiness } = (await import(moduleUrl)) as {
    waitForOwnedReadiness: (options: {
      child: { pid: number; exitCode: number | null; signalCode: string | null };
      listenerProbe: () => Promise<RuntimeListener[]>;
      readiness: () => Promise<boolean>;
      pause: () => Promise<void>;
      deadline: number;
    }) => Promise<void>;
  };
  const listenerSnapshots: RuntimeListener[][] = [
    [{ localAddress: "127.0.0.1", localPort: 37645, pid: 903 }],
    [{ localAddress: "127.0.0.1", localPort: 37645, pid: 903 }],
  ];
  let readinessCalls = 0;

  await waitForOwnedReadiness({
    child: { pid: 903, exitCode: null, signalCode: null },
    listenerProbe: async () =>
      listenerSnapshots.shift() ?? [
        { localAddress: "127.0.0.1", localPort: 37645, pid: 904 },
      ],
    readiness: async () => {
      readinessCalls += 1;
      return true;
    },
    pause: async () => {},
    deadline: Date.now() + 1_000,
  });

  assert.equal(readinessCalls, 1);
  assert.deepEqual(listenerSnapshots, []);
});

test("post-stop cleanup requires zero listeners on every address", async () => {
  const { stopRuntimeChildAndAssertPortFree } = (await import(moduleUrl)) as {
    stopRuntimeChildAndAssertPortFree: (options: {
      child: { exitCode: number | null; signalCode: string | null };
      listenerProbe: () => Promise<RuntimeListener[]>;
    }) => Promise<void>;
  };
  const survivingSnapshots: RuntimeListener[][] = [
    [{ localAddress: "127.0.0.1", localPort: 37645, pid: 905 }],
    [{ localAddress: "0.0.0.0", localPort: 37645, pid: 905 }],
    [{ localAddress: "192.0.2.10", localPort: 37645, pid: 905 }],
    [{ localAddress: "::1", localPort: 37645, pid: 905 }],
    [
      { localAddress: "127.0.0.1", localPort: 37645, pid: 905 },
      { localAddress: "0.0.0.0", localPort: 37645, pid: 906 },
    ],
  ];

  for (const listeners of survivingSnapshots) {
    await assert.rejects(
      stopRuntimeChildAndAssertPortFree({
        child: { exitCode: 0, signalCode: null },
        listenerProbe: async () => listeners,
      }),
      /service-port-in-use/u,
    );
  }
});

test(
  "the Windows port probe rejects a wildcard listener",
  { skip: process.platform !== "win32" },
  async () => {
    const {
      assertRuntimePortAvailable,
      stopRuntimeChildAndAssertPortFree,
    } = (await import(moduleUrl)) as {
      assertRuntimePortAvailable: () => Promise<void>;
      stopRuntimeChildAndAssertPortFree: (options: {
        child: ReturnType<typeof spawn>;
      }) => Promise<void>;
    };
    const child = spawn(
      process.execPath,
      [
        "-e",
        "require('node:net').createServer().listen(37645,'0.0.0.0',()=>process.stdout.write('ready\\n'))",
      ],
      {
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
        shell: false,
      },
    );

    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("listener-start-timeout")),
          5_000,
        );
        child.stdout!.once("data", () => {
          clearTimeout(timer);
          resolve();
        });
      });
      await assert.rejects(
        assertRuntimePortAvailable(),
        /service-port-in-use/u,
      );
    } finally {
      await stopRuntimeChildAndAssertPortFree({ child });
    }
  },
);

test(
  "the Windows port probe rejects an IPv6-only listener",
  { skip: process.platform !== "win32" },
  async () => {
    const {
      assertRuntimePortAvailable,
      stopRuntimeChildAndAssertPortFree,
    } = (await import(moduleUrl)) as {
      assertRuntimePortAvailable: () => Promise<void>;
      stopRuntimeChildAndAssertPortFree: (options: {
        child: ReturnType<typeof spawn>;
      }) => Promise<void>;
    };
    const child = spawn(
      process.execPath,
      [
        "-e",
        "require('node:net').createServer().listen(37645,'::1',()=>process.stdout.write('ready\\n'))",
      ],
      {
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
        shell: false,
      },
    );

    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("listener-start-timeout")),
          5_000,
        );
        child.stdout!.once("data", () => {
          clearTimeout(timer);
          resolve();
        });
        child.once("error", reject);
      });
      await assert.rejects(
        assertRuntimePortAvailable(),
        /service-port-in-use/u,
      );
    } finally {
      await stopRuntimeChildAndAssertPortFree({ child });
    }
  },
);

test(
  "the Windows listener probe recognizes the exact launched Node owner",
  { skip: process.platform !== "win32" },
  async () => {
    const {
      waitForOwnedReadiness,
      stopRuntimeChildAndAssertPortFree,
    } = (await import(moduleUrl)) as {
      waitForOwnedReadiness: (options: {
        child: ReturnType<typeof spawn>;
        readiness: () => Promise<boolean>;
        deadline: number;
      }) => Promise<void>;
      stopRuntimeChildAndAssertPortFree: (options: {
        child: ReturnType<typeof spawn>;
      }) => Promise<void>;
    };
    const child = spawn(
      process.execPath,
      [
        "-e",
        "require('node:http').createServer((q,s)=>s.end('ok')).listen(37645,'127.0.0.1',()=>process.stdout.write('ready\\n'))",
      ],
      {
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
        shell: false,
      },
    );

    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("listener-start-timeout")),
          5_000,
        );
        child.stdout!.once("data", () => {
          clearTimeout(timer);
          resolve();
        });
      });
      await waitForOwnedReadiness({
        child,
        readiness: async () =>
          await new Promise<boolean>((resolve) => {
            const request = http.get(
              "http://127.0.0.1:37645/login",
              (response) => {
                response.resume();
                response.once("end", () => resolve(true));
              },
            );
            request.once("error", () => resolve(false));
          }),
        deadline: Date.now() + 5_000,
      });
    } finally {
      await stopRuntimeChildAndAssertPortFree({ child });
    }
  },
);

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
