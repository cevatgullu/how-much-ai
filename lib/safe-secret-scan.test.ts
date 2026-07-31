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

test("manifest mode examines every listed runtime and bootstrap path", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "hma-secret-manifest-"));
  const artifact = path.join(fixture, "result.json");
  const manifestPath = path.join(fixture, "runtime-manifest.json");

  try {
    await mkdir(path.join(fixture, "runtime"), { recursive: true });
    await mkdir(path.join(fixture, "bootstrap"), { recursive: true });
    await writeFile(path.join(fixture, "runtime", "app.js"), "ok\n", "utf8");
    await writeFile(
      path.join(fixture, "bootstrap", "module.psm1"),
      "function Test-Ok { $true }\n",
      "utf8",
    );
    await writeFile(
      manifestPath,
      JSON.stringify({
        runtimeFiles: [{ path: "runtime/app.js" }],
        bootstrapFiles: [{ path: "bootstrap/module.psm1" }],
      }),
      "utf8",
    );

    const result = await runScanner(fixture, [
      "--json",
      artifact,
      "--manifest",
      manifestPath,
    ]);
    const report = JSON.parse(await readFile(artifact, "utf8")) as {
      ok: boolean;
      filesScanned: number;
      examinedPathHashes: string[];
    };

    assert.equal(result.code, 0);
    assert.equal(report.ok, true);
    assert.equal(report.filesScanned, 2);
    assert.deepEqual(
      report.examinedPathHashes,
      ["bootstrap/module.psm1", "runtime/app.js"]
        .map((value) => createHash("sha256").update(value).digest("hex"))
        .sort(),
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
    await writeFile(
      path.join(fixture, ...relative.split("/")),
      'process.env.AUTH_SECRET = "synthetic-test-secret";\n',
      "utf8",
    );
    await writeFile(
      manifestPath,
      JSON.stringify({
        runtimeFiles: [{ path: relative }],
        bootstrapFiles: [],
      }),
      "utf8",
    );
    const result = await runScanner(fixture, [
      "--json",
      artifact,
      "--manifest",
      manifestPath,
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
