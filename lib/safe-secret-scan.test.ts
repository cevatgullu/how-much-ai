import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const scanner = path.resolve("scripts/audit/safe-secret-scan.mjs");

async function writeTrustedManifest(
  manifestPath: string,
  manifest: unknown,
): Promise<string> {
  const installerRelative = "scripts/windows/install-secure-local.ps1";
  const installerBytes = Buffer.from("# reviewed installer\n", "utf8");
  const installerPath = path.join(
    path.dirname(manifestPath),
    ...installerRelative.split("/"),
  );
  await mkdir(path.dirname(installerPath), { recursive: true });
  await writeFile(installerPath, installerBytes);
  const exactManifest = {
    commit: "d".repeat(40),
    nodeSha256: "e".repeat(64),
    installerSha256: createHash("sha256")
      .update(installerBytes)
      .digest("hex"),
    ...(manifest as object),
  };
  const bytes = Buffer.from(JSON.stringify(exactManifest), "utf8");
  const expectedManifestSha256 = createHash("sha256")
    .update(bytes)
    .digest("hex");
  await writeFile(manifestPath, bytes);
  await writeFile(
    manifestPath.replace(/\.json$/u, ".sha256"),
    expectedManifestSha256,
    "ascii",
  );
  return expectedManifestSha256;
}

async function runScanner(
  cwd: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync(process.execPath, [scanner, ...args], {
      cwd,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: 30_000,
      windowsHide: true,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as {
      code?: number;
      stdout?: string;
      stderr?: string;
    };
    return {
      code: Number(failure.code ?? 1),
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    };
  }
}

test("scanner reports a rule and filename hash without emitting secret content or paths", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "hma-secret-scan-"));
  const secretMarker = `sk-ant-api03-${"SensitiveMarker".repeat(4)}`;
  const relative = "nested/credential.txt";
  const rawPath = path.join(fixture, "nested", "credential.txt");
  const artifact = path.join(fixture, "result.json");

  try {
    await mkdir(path.dirname(rawPath), { recursive: true });
    await writeFile(rawPath, `CLAUDE_TOKEN=${secretMarker}\n`, "utf8");

    const result = await runScanner(fixture, [
      "--json",
      artifact,
      "--root",
      "nested",
    ]);
    const report = JSON.parse(await readFile(artifact, "utf8")) as {
      ok: boolean;
      filesScanned: number;
      findingCount: number;
      findings: Array<{ ruleId: string; pathHash: string }>;
    };
    const allOutput = `${result.stdout}\n${result.stderr}\n${JSON.stringify(report)}`;

    assert.equal(result.code, 1);
    assert.equal(report.ok, false);
    assert.equal(report.filesScanned, 1);
    assert.equal(report.findingCount, 1);
    assert.deepEqual(report.findings, [
      {
        ruleId: "provider-token",
        pathHash: createHash("sha256").update(relative).digest("hex"),
      },
    ]);
    assert.equal(allOutput.includes(secretMarker), false);
    assert.equal(allOutput.includes(rawPath), false);
    assert.equal(allOutput.includes("credential.txt"), false);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("clean fixtures return a sanitized zero-finding report", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "hma-secret-clean-"));
  const artifact = path.join(fixture, "result.json");

  try {
    await writeFile(
      path.join(fixture, "clean.ts"),
      "export const label = 'Claude 1';\n",
      "utf8",
    );
    const result = await runScanner(fixture, [
      "--json",
      artifact,
      "--root",
      "clean.ts",
    ]);
    const report = JSON.parse(await readFile(artifact, "utf8")) as {
      ok: boolean;
      filesScanned: number;
      findingCount: number;
      findings: unknown[];
    };

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    assert.equal(report.ok, true);
    assert.equal(report.filesScanned, 1);
    assert.equal(report.findingCount, 0);
    assert.deepEqual(report.findings, []);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("empty assignments cannot consume a value from a later line", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "hma-secret-empty-"));
  const artifact = path.join(fixture, "result.json");
  const refreshPlaceholder = "documented-placeholder-refresh-token";
  const jwt = [
    "eyJsyntheticHeader",
    "eyJsyntheticPayload",
    "syntheticSignature",
  ].join(".");

  try {
    for (const separator of ["\n", "\r\n", "\u2028", "\u2029"]) {
      await writeFile(
        path.join(fixture, "empty.env"),
        [
          "APP_PASSWORD=",
          "AUTH_SECRET=",
          "VAULT_ENCRYPTION_SECRET=",
          "refresh_token=",
          refreshPlaceholder,
          "access_token=",
          jwt,
          "authorization=",
          "NEXT_PUBLIC_LONG_ORDINARY_VALUE=not-a-secret",
          "",
        ].join(separator),
        "utf8",
      );
      const result = await runScanner(fixture, [
        "--json",
        artifact,
        "--root",
        "empty.env",
      ]);
      const report = JSON.parse(await readFile(artifact, "utf8")) as {
        ok: boolean;
        findingCount: number;
      };

      assert.equal(result.code, 0, JSON.stringify(separator));
      assert.equal(report.ok, true, JSON.stringify(separator));
      assert.equal(report.findingCount, 0, JSON.stringify(separator));
    }
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("source-root scans omit generated, vendor, audit, and VCS trees but explicit roots do not", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "hma-secret-source-root-"));
  const artifact = path.join(fixture, "result.json");
  const explicitArtifact = path.join(fixture, "explicit-result.json");
  const marker = `sk-ant-api03-${"GeneratedMarker".repeat(3)}`;

  try {
    await writeFile(path.join(fixture, "clean.ts"), "export const clean = true;\n", "utf8");
    await mkdir(path.join(fixture, "scripts", "audit"), { recursive: true });
    await writeFile(
      path.join(fixture, "scripts", "audit", "reviewed.mjs"),
      "export const reviewed = true;\n",
      "utf8",
    );
    for (const directory of [".git", ".next", "audit", "node_modules"]) {
      await mkdir(path.join(fixture, directory), { recursive: true });
      await writeFile(
        path.join(fixture, directory, "generated.txt"),
        `${marker}\n`,
        "utf8",
      );
    }

    const sourceResult = await runScanner(fixture, [
      "--json",
      artifact,
      "--root",
      ".",
    ]);
    const sourceReport = JSON.parse(await readFile(artifact, "utf8")) as {
      ok: boolean;
      filesScanned: number;
      findingCount: number;
    };
    assert.equal(sourceResult.code, 0);
    assert.deepEqual(sourceReport, {
      ok: true,
      filesScanned: 2,
      findingCount: 0,
      binaryFilesExamined: 0,
      suppressedSourceFixtureCount: 0,
      findings: [],
      examinedPathHashes: ["clean.ts", "scripts/audit/reviewed.mjs"]
        .map((value) => createHash("sha256").update(value).digest("hex"))
        .sort(),
    });

    const explicitResult = await runScanner(fixture, [
      "--json",
      explicitArtifact,
      "--root",
      ".next",
    ]);
    const explicitReport = JSON.parse(
      await readFile(explicitArtifact, "utf8"),
    ) as { findingCount: number; findings: Array<{ ruleId: string }> };
    assert.equal(explicitResult.code, 1);
    assert.equal(explicitReport.findingCount, 1);
    assert.equal(explicitReport.findings[0]?.ruleId, "provider-token");
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("manifest mode examines every listed runtime and bootstrap path", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "hma-secret-manifest-"));
  const artifact = path.join(fixture, "result.json");
  const manifestPath = path.join(fixture, "runtime-manifest.json");

  try {
    await mkdir(path.join(fixture, "runtime"), { recursive: true });
    await mkdir(path.join(fixture, "bootstrap"), { recursive: true });
    const runtimeBytes = Buffer.from("ok\n", "utf8");
    const bootstrapBytes = Buffer.from("function Test-Ok { $true }\n", "utf8");
    await writeFile(path.join(fixture, "runtime", "app.js"), runtimeBytes);
    await writeFile(
      path.join(fixture, "bootstrap", "module.psm1"),
      bootstrapBytes,
    );
    const expectedManifestSha256 = await writeTrustedManifest(
      manifestPath,
      {
        runtimeFiles: [{
          path: "runtime/app.js",
          size: runtimeBytes.byteLength,
          sha256: createHash("sha256").update(runtimeBytes).digest("hex"),
        }],
        bootstrapFiles: [{
          path: "bootstrap/module.psm1",
          size: bootstrapBytes.byteLength,
          sha256: createHash("sha256").update(bootstrapBytes).digest("hex"),
        }],
      },
    );

    const result = await runScanner(fixture, [
      "--json",
      artifact,
      "--manifest",
      manifestPath,
      "--expected-manifest-sha256",
      expectedManifestSha256,
    ]);
    const report = JSON.parse(await readFile(artifact, "utf8")) as {
      ok: boolean;
      filesScanned: number;
      examinedPathHashes: string[];
    };

    assert.equal(result.code, 0);
    assert.equal(report.ok, true);
    assert.equal(report.filesScanned, 3);
    assert.deepEqual(
      report.examinedPathHashes,
      [
        "bootstrap/module.psm1",
        "runtime/app.js",
        "scripts/windows/install-secure-local.ps1",
      ]
        .map((value) => createHash("sha256").update(value).digest("hex"))
        .sort(),
    );
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("manifest mode rejects a jointly replaced manifest and digest before traversal", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "hma-secret-anchor-"));
  const artifact = path.join(fixture, "result.json");
  const manifestPath = path.join(fixture, "runtime-manifest.json");
  const filePath = path.join(fixture, "app.js");
  const bytes = Buffer.from("ok\n", "utf8");

  try {
    await writeFile(filePath, bytes);
    const trustedManifestSha256 = await writeTrustedManifest(manifestPath, {
      runtimeFiles: [{
        path: "app.js",
        size: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      }],
      bootstrapFiles: [],
    });
    await writeTrustedManifest(manifestPath, {
      runtimeFiles: [{
        path: "missing.js",
        size: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      }],
      bootstrapFiles: [],
    });

    const result = await runScanner(fixture, [
      "--json",
      artifact,
      "--manifest",
      manifestPath,
      "--expected-manifest-sha256",
      trustedManifestSha256,
    ]);
    const report = JSON.parse(await readFile(artifact, "utf8")) as {
      ok: boolean;
      filesScanned: number;
      error: string;
    };

    assert.equal(result.code, 2);
    assert.deepEqual(report, {
      ok: false,
      filesScanned: 0,
      binaryFilesExamined: 0,
      findingCount: 0,
      findings: [],
      examinedPathHashes: [],
      error: "secret-scan-failed",
    });
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("manifest mode rejects decoy bytes that do not match the trusted entry", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "hma-secret-decoy-"));
  const artifact = path.join(fixture, "result.json");
  const manifestPath = path.join(fixture, "runtime-manifest.json");
  const relative = "app.js";
  const reviewedBytes = Buffer.from(
    'process.env.AUTH_SECRET = "reviewed-synthetic-secret";\n',
    "utf8",
  );

  try {
    await writeFile(path.join(fixture, relative), reviewedBytes);
    const trustedManifestSha256 = await writeTrustedManifest(manifestPath, {
      runtimeFiles: [{
        path: relative,
        size: reviewedBytes.byteLength,
        sha256: createHash("sha256").update(reviewedBytes).digest("hex"),
      }],
      bootstrapFiles: [],
    });
    await writeFile(path.join(fixture, relative), "export const clean = true;\n", "utf8");

    const result = await runScanner(fixture, [
      "--json",
      artifact,
      "--manifest",
      manifestPath,
      "--expected-manifest-sha256",
      trustedManifestSha256,
    ]);

    assert.equal(result.code, 2);
    assert.equal(
      (JSON.parse(await readFile(artifact, "utf8")) as { filesScanned: number })
        .filesScanned,
      0,
    );
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("source-test suppressions never apply to an installable manifest entry", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "hma-secret-installable-"));
  const artifact = path.join(fixture, "result.json");
  const manifestPath = path.join(fixture, "runtime-manifest.json");
  const relative = "lib/vault.test.ts";

  try {
    await mkdir(path.join(fixture, "lib"), { recursive: true });
    const fixtureBytes = Buffer.from(
      'process.env.AUTH_SECRET = "synthetic-test-secret";\n',
      "utf8",
    );
    await writeFile(path.join(fixture, ...relative.split("/")), fixtureBytes);
    const expectedManifestSha256 = await writeTrustedManifest(
      manifestPath,
      {
        runtimeFiles: [{
          path: relative,
          size: fixtureBytes.byteLength,
          sha256: createHash("sha256").update(fixtureBytes).digest("hex"),
        }],
        bootstrapFiles: [],
      },
    );
    const result = await runScanner(fixture, [
      "--json",
      artifact,
      "--manifest",
      manifestPath,
      "--expected-manifest-sha256",
      expectedManifestSha256,
    ]);
    const report = JSON.parse(await readFile(artifact, "utf8")) as {
      ok: boolean;
      findingCount: number;
      findings: Array<{ ruleId: string }>;
      suppressedSourceFixtureCount: number;
    };

    assert.equal(result.code, 1);
    assert.equal(report.ok, false);
    assert.equal(report.findingCount, 1);
    assert.equal(report.findings[0]?.ruleId, "strict-local-secret-assignment");
    assert.equal(report.suppressedSourceFixtureCount, 0);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("an explicitly requested external state root is scanned under an opaque logical path", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "hma-secret-cwd-"));
  const external = await mkdtemp(path.join(os.tmpdir(), "hma-secret-state-"));
  const artifact = path.join(fixture, "result.json");
  const secretMarker = `sk-ant-oat01-${"ExternalCanary".repeat(3)}`;
  const externalFile = path.join(external, "credential.txt");

  try {
    await writeFile(externalFile, `${secretMarker}\n`, "utf8");
    const result = await runScanner(fixture, [
      "--json",
      artifact,
      "--root",
      externalFile,
    ]);
    const report = JSON.parse(await readFile(artifact, "utf8")) as {
      findingCount: number;
      findings: Array<{ ruleId: string; pathHash: string }>;
    };
    const combined = `${result.stdout}\n${result.stderr}\n${JSON.stringify(report)}`;

    assert.equal(result.code, 1);
    assert.equal(report.findingCount, 1);
    assert.deepEqual(report.findings, [
      {
        ruleId: "provider-token",
        pathHash: createHash("sha256")
          .update("external-0/credential.txt")
          .digest("hex"),
      },
    ]);
    assert.equal(combined.includes(secretMarker), false);
    assert.equal(combined.includes(external), false);
    assert.equal(combined.includes("credential.txt"), false);
  } finally {
    await rm(fixture, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  }
});

test("private-key material is examined even when its extension is not on a text allowlist", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "hma-secret-key-"));
  const artifact = path.join(fixture, "result.json");
  const rawPath = path.join(fixture, "identity.pem");

  try {
    await writeFile(
      rawPath,
      "-----BEGIN PRIVATE KEY-----\nsynthetic-only\n-----END PRIVATE KEY-----\n",
      "utf8",
    );
    const result = await runScanner(fixture, [
      "--json",
      artifact,
      "--root",
      "identity.pem",
    ]);
    const report = JSON.parse(await readFile(artifact, "utf8")) as {
      findingCount: number;
      findings: Array<{ ruleId: string }>;
    };

    assert.equal(result.code, 1);
    assert.equal(report.findingCount, 1);
    assert.equal(report.findings[0]?.ruleId, "private-key");
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("UTF-16 files and unquoted secret assignments cannot bypass the scan", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "hma-secret-utf16-"));
  const artifact = path.join(fixture, "result.json");
  const password = "A".repeat(32);
  const refreshToken = "R".repeat(32);
  const rawPath = path.join(fixture, "opaque.bin");
  const utf16 = Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from(
      `APP_PASSWORD=${password}\r\nrefresh_token=${refreshToken}\r\n`,
      "utf16le",
    ),
  ]);

  try {
    await writeFile(rawPath, utf16);
    const result = await runScanner(fixture, [
      "--json",
      artifact,
      "--root",
      "opaque.bin",
    ]);
    const report = JSON.parse(await readFile(artifact, "utf8")) as {
      findingCount: number;
      findings: Array<{ ruleId: string }>;
    };
    const combined = `${result.stdout}\n${result.stderr}\n${JSON.stringify(report)}`;

    assert.equal(result.code, 1);
    assert.equal(report.findingCount, 2);
    assert.deepEqual(
      report.findings.map((finding) => finding.ruleId).sort(),
      ["refresh-token-assignment", "strict-local-secret-assignment"],
    );
    assert.equal(combined.includes(password), false);
    assert.equal(combined.includes(refreshToken), false);
    assert.equal(combined.includes(rawPath), false);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("unquoted secrets embedded in TypeScript string literals are detected", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "hma-secret-ts-literal-"));
  const artifact = path.join(fixture, "result.json");
  const password = "SuperSecretPassword";

  try {
    await writeFile(
      path.join(fixture, "string-fixture.ts"),
      `const fixture = "APP_PASSWORD=${password} ;";\n`,
      "utf8",
    );
    await writeFile(
      path.join(fixture, "template-fixture.ts"),
      `const fixture = \`\nAPP_PASSWORD=${password}\n\`;\n`,
      "utf8",
    );
    const result = await runScanner(fixture, [
      "--json",
      artifact,
      "--root",
      ".",
    ]);
    const report = JSON.parse(await readFile(artifact, "utf8")) as {
      findingCount: number;
      findings: Array<{ ruleId: string }>;
    };
    const combined = `${result.stdout}\n${result.stderr}\n${JSON.stringify(report)}`;

    assert.equal(result.code, 1);
    assert.equal(report.findingCount, 2);
    assert.deepEqual(
      report.findings.map((finding) => finding.ruleId),
      ["strict-local-secret-assignment", "strict-local-secret-assignment"],
    );
    assert.equal(combined.includes(password), false);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("JavaScript template-literal assignment values cannot bypass the scan", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "hma-secret-template-"));
  const artifact = path.join(fixture, "result.json");
  const password = "TemplatePasswordMarker";
  const refreshToken = "TemplateRefreshTokenMarker";

  try {
    await writeFile(
      path.join(fixture, "fixture.ts"),
      [
        `const APP_PASSWORD = \`${password}\`;`,
        `const refresh_token = \`${refreshToken}\`;`,
      ].join("\n"),
      "utf8",
    );
    const result = await runScanner(fixture, [
      "--json",
      artifact,
      "--root",
      "fixture.ts",
    ]);
    const report = JSON.parse(await readFile(artifact, "utf8")) as {
      findingCount: number;
      findings: Array<{ ruleId: string }>;
    };
    const combined = `${result.stdout}\n${result.stderr}\n${JSON.stringify(report)}`;

    assert.equal(result.code, 1);
    assert.equal(report.findingCount, 2);
    assert.deepEqual(
      report.findings.map((finding) => finding.ruleId).sort(),
      ["refresh-token-assignment", "strict-local-secret-assignment"],
    );
    assert.equal(combined.includes(password), false);
    assert.equal(combined.includes(refreshToken), false);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("shell and PowerShell assignments are never treated as member references", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "hma-secret-shell-"));
  const artifact = path.join(fixture, "result.json");
  const password = "SuperSecretPassword";

  try {
    await writeFile(
      path.join(fixture, "fixture.sh"),
      `APP_PASSWORD=${password}\n`,
      "utf8",
    );
    await writeFile(
      path.join(fixture, "fixture.ps1"),
      `$env:APP_PASSWORD=${password}\r\n`,
      "utf8",
    );
    const result = await runScanner(fixture, [
      "--json",
      artifact,
      "--root",
      ".",
    ]);
    const report = JSON.parse(await readFile(artifact, "utf8")) as {
      findingCount: number;
      findings: Array<{ ruleId: string }>;
    };
    const combined = `${result.stdout}\n${result.stderr}\n${JSON.stringify(report)}`;

    assert.equal(result.code, 1);
    assert.equal(report.findingCount, 2);
    assert.deepEqual(
      report.findings.map((finding) => finding.ruleId),
      ["strict-local-secret-assignment", "strict-local-secret-assignment"],
    );
    assert.equal(combined.includes(password), false);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("real JavaScript and TypeScript member references remain clean", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "hma-secret-members-"));
  const artifact = path.join(fixture, "result.json");

  try {
    await writeFile(
      path.join(fixture, "fixture.ts"),
      [
        "const config = { APP_PASSWORD: productionPassword };",
        "process.env.AUTH_SECRET = configuration.authSecret;",
      ].join("\n"),
      "utf8",
    );
    const result = await runScanner(fixture, [
      "--json",
      artifact,
      "--root",
      "fixture.ts",
    ]);
    const report = JSON.parse(await readFile(artifact, "utf8")) as {
      findingCount: number;
    };

    assert.equal(result.code, 0);
    assert.equal(report.findingCount, 0);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("BOM-less UTF-16 secrets remain detectable after a long non-ASCII prefix", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "hma-secret-utf16-prefix-"));
  const artifact = path.join(fixture, "result.json");
  const password = "SuperSecretPassword";
  const text = `${"一".repeat(5_000)}\nAPP_PASSWORD=${password}\n`;
  const littleEndian = Buffer.from(text, "utf16le");
  const bigEndian = Buffer.from(littleEndian);
  for (let index = 0; index < bigEndian.length; index += 2) {
    [bigEndian[index], bigEndian[index + 1]] = [
      bigEndian[index + 1],
      bigEndian[index],
    ];
  }

  try {
    await writeFile(path.join(fixture, "little-endian.bin"), littleEndian);
    await writeFile(path.join(fixture, "big-endian.bin"), bigEndian);
    const result = await runScanner(fixture, [
      "--json",
      artifact,
      "--root",
      ".",
    ]);
    const report = JSON.parse(await readFile(artifact, "utf8")) as {
      findingCount: number;
      findings: Array<{ ruleId: string }>;
    };
    const combined = `${result.stdout}\n${result.stderr}\n${JSON.stringify(report)}`;

    assert.equal(result.code, 1);
    assert.equal(report.findingCount, 2);
    assert.deepEqual(
      report.findings.map((finding) => finding.ruleId),
      ["strict-local-secret-assignment", "strict-local-secret-assignment"],
    );
    assert.equal(combined.includes(password), false);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("a plaintext OpenAI JWT access token is detected in a vault-shaped JSON file", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "hma-secret-openai-"));
  const artifact = path.join(fixture, "result.json");
  const jwt = [
    "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9",
    "eyJzdWIiOiJzeW50aGV0aWMtb25seSJ9",
    "c3ludGhldGljLXNpZ25hdHVyZS1vbmx5",
  ].join(".");
  const rawPath = path.join(fixture, "vault.json");

  try {
    await writeFile(rawPath, JSON.stringify({ accessToken: jwt }), "utf8");
    const result = await runScanner(fixture, [
      "--json",
      artifact,
      "--root",
      "vault.json",
    ]);
    const report = JSON.parse(await readFile(artifact, "utf8")) as {
      findingCount: number;
      findings: Array<{ ruleId: string }>;
    };
    const combined = `${result.stdout}\n${result.stderr}\n${JSON.stringify(report)}`;

    assert.equal(result.code, 1);
    assert.equal(report.findingCount, 1);
    assert.equal(
      report.findings[0]?.ruleId,
      "openai-access-token-assignment",
    );
    assert.equal(combined.includes(jwt), false);
    assert.equal(combined.includes(rawPath), false);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("reviewed source suppressions are invalidated by any fixture-file change", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "hma-secret-reviewed-"));
  const artifact = path.join(fixture, "result.json");
  const relative = "lib/vault.test.ts";
  const rawPath = path.join(fixture, ...relative.split("/"));
  const reviewedBytes = await readFile(path.resolve(relative));
  const novelSecret = "novel-production-shaped-secret-987654321";

  try {
    await mkdir(path.dirname(rawPath), { recursive: true });
    await writeFile(rawPath, reviewedBytes);
    const cleanResult = await runScanner(fixture, [
      "--json",
      artifact,
      "--root",
      relative,
    ]);
    assert.equal(cleanResult.code, 0);

    await writeFile(
      rawPath,
      Buffer.concat([
        reviewedBytes,
        Buffer.from(`\nprocess.env.AUTH_SECRET = "${novelSecret}";\n`, "utf8"),
      ]),
    );
    const changedResult = await runScanner(fixture, [
      "--json",
      artifact,
      "--root",
      relative,
    ]);
    const report = JSON.parse(await readFile(artifact, "utf8")) as {
      findingCount: number;
      findings: Array<{ ruleId: string }>;
    };
    const combined = `${changedResult.stdout}\n${changedResult.stderr}\n${JSON.stringify(report)}`;

    assert.equal(changedResult.code, 1);
    assert.equal(report.findingCount > 0, true);
    assert.equal(
      report.findings.some(
        (finding) => finding.ruleId === "strict-local-secret-assignment",
      ),
      true,
    );
    assert.equal(combined.includes(novelSecret), false);
    assert.equal(combined.includes(rawPath), false);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
