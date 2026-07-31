import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
} from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSanitizedBuildEnvironment } from "./run-sanitized-validation.mjs";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeRelative(value) {
  if (typeof value !== "string" || value.length === 0 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error("invalid-path");
  }
  const normalized = value.replaceAll("\\", "/").normalize("NFC");
  if (
    normalized.startsWith("/") ||
    /^[A-Za-z]:/u.test(normalized) ||
    normalized.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error("invalid-path");
  }
  return normalized;
}

function assertExactEntry(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error("invalid-entry");
  }
  const keys = Object.keys(entry).sort();
  if (
    keys.length !== 3 ||
    keys[0] !== "path" ||
    keys[1] !== "sha256" ||
    keys[2] !== "size"
  ) {
    throw new Error("invalid-entry");
  }
  const relative = normalizeRelative(entry.path);
  if (
    !Number.isSafeInteger(entry.size) ||
    entry.size < 0 ||
    typeof entry.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(entry.sha256)
  ) {
    throw new Error("invalid-entry");
  }
  return { path: relative, size: entry.size, sha256: entry.sha256 };
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("invalid-manifest");
  }
  const keys = Object.keys(manifest).sort();
  if (
    keys.length !== 4 ||
    keys[0] !== "bootstrapFiles" ||
    keys[1] !== "commit" ||
    keys[2] !== "nodeSha256" ||
    keys[3] !== "runtimeFiles" ||
    typeof manifest.commit !== "string" ||
    !/^[a-f0-9]{40}$/u.test(manifest.commit) ||
    typeof manifest.nodeSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(manifest.nodeSha256) ||
    !Array.isArray(manifest.runtimeFiles) ||
    !Array.isArray(manifest.bootstrapFiles) ||
    manifest.runtimeFiles.length === 0
  ) {
    throw new Error("invalid-manifest");
  }
  const runtimeFiles = manifest.runtimeFiles.map(assertExactEntry);
  const bootstrapFiles = manifest.bootstrapFiles.map(assertExactEntry);
  const folded = new Set();
  for (const entry of [...runtimeFiles, ...bootstrapFiles]) {
    const key = entry.path.toLocaleLowerCase("en-US");
    if (folded.has(key)) {
      throw new Error("duplicate-path");
    }
    folded.add(key);
  }
  const sorted = [...runtimeFiles].sort((left, right) =>
    left.path.localeCompare(right.path, "en"),
  );
  const sortedBootstrap = [...bootstrapFiles].sort((left, right) =>
    left.path.localeCompare(right.path, "en"),
  );
  if (runtimeFiles.some((entry, index) => entry.path !== sorted[index].path)) {
    throw new Error("unsorted-paths");
  }
  if (
    bootstrapFiles.some(
      (entry, index) => entry.path !== sortedBootstrap[index].path,
    )
  ) {
    throw new Error("unsorted-paths");
  }
  return {
    commit: manifest.commit,
    nodeSha256: manifest.nodeSha256,
    runtimeFiles,
  };
}

async function assertOrdinaryFile(absolutePath) {
  const info = await lstat(absolutePath);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error("invalid-file");
  }
  const resolved = await realpath(absolutePath);
  if (resolved.toLowerCase() !== path.resolve(absolutePath).toLowerCase()) {
    throw new Error("reparse-file");
  }
  return info;
}

async function hashStableFile(absolutePath) {
  const before = await assertOrdinaryFile(absolutePath);
  const bytes = await readFile(absolutePath);
  const after = await lstat(absolutePath);
  if (
    !after.isFile() ||
    after.isSymbolicLink() ||
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs
  ) {
    throw new Error("file-race");
  }
  return { bytes, size: bytes.byteLength, sha256: sha256(bytes) };
}

async function applyPrivateWindowsAcl(root) {
  await chmod(root, 0o700);
  if (process.platform !== "win32") {
    return;
  }
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  if (!systemRoot) {
    throw new Error("missing-system-root");
  }
  const powerShell = path.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const script = [
    "$ErrorActionPreference='Stop'",
    "$p=[IO.Path]::GetFullPath($env:HMA_RUNTIME_ACL_TARGET)",
    "$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    "$icacls=Join-Path $env:SystemRoot 'System32\\icacls.exe'",
    "& $icacls $p '/inheritance:r' '/grant:r' ('*'+$sid+':(OI)(CI)F') '*S-1-5-18:(OI)(CI)F' | Out-Null",
    "if($LASTEXITCODE -ne 0){throw 'acl'}",
  ].join(";");
  const result = spawnSync(
    powerShell,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      script,
    ],
    {
      env: {
        ...createSanitizedBuildEnvironment(process.env),
        HMA_RUNTIME_ACL_TARGET: root,
        SystemRoot: systemRoot,
        WINDIR: systemRoot,
      },
      stdio: "ignore",
      windowsHide: true,
      shell: false,
    },
  );
  if (result.error || result.signal || result.status !== 0) {
    throw new Error("private-acl-failed");
  }
}

async function stageRuntime(sourceRoot, stageRoot, entries) {
  for (const entry of entries) {
    const source = path.resolve(sourceRoot, ...entry.path.split("/"));
    const relativeFromRoot = path.relative(sourceRoot, source);
    if (
      relativeFromRoot === ".." ||
      relativeFromRoot.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativeFromRoot)
    ) {
      throw new Error("source-path-escape");
    }
    const sourceFile = await hashStableFile(source);
    if (
      sourceFile.size !== entry.size ||
      sourceFile.sha256 !== entry.sha256
    ) {
      throw new Error("source-mismatch");
    }
    const destination = path.join(stageRoot, ...entry.path.split("/"));
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(source, destination);
    const copied = await hashStableFile(destination);
    if (copied.size !== entry.size || copied.sha256 !== entry.sha256) {
      throw new Error("copy-mismatch");
    }
  }
}

async function enumerateStage(stageRoot) {
  const files = [];
  const pending = [{ absolute: stageRoot, relative: "" }];
  while (pending.length > 0) {
    const current = pending.pop();
    const entries = await readdir(current.absolute, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const absolute = path.join(current.absolute, entry.name);
      const relative = normalizeRelative(
        current.relative ? `${current.relative}/${entry.name}` : entry.name,
      );
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) {
        throw new Error("stage-reparse");
      }
      if (info.isDirectory()) {
        const resolved = await realpath(absolute);
        if (resolved.toLowerCase() !== absolute.toLowerCase()) {
          throw new Error("stage-reparse");
        }
        pending.push({ absolute, relative });
      } else if (info.isFile()) {
        const hashed = await hashStableFile(absolute);
        files.push({ path: relative, size: hashed.size, sha256: hashed.sha256 });
      } else {
        throw new Error("stage-special-entry");
      }
    }
  }
  files.sort((left, right) => left.path.localeCompare(right.path, "en"));
  return files;
}

function sameSnapshot(actual, expected) {
  return (
    actual.length === expected.length &&
    actual.every(
      (entry, index) =>
        entry.path === expected[index].path &&
        entry.size === expected[index].size &&
        entry.sha256 === expected[index].sha256,
    )
  );
}

function createSyntheticServiceEnvironment(vaultRoot) {
  return {
    ...createSanitizedBuildEnvironment(process.env),
    APP_PASSWORD: randomBytes(32).toString("base64url"),
    AUTH_SECRET: randomBytes(32).toString("base64url"),
    ENABLE_LOCAL_CONNECT: "1",
    HMC_LISTEN_HOST: "127.0.0.1",
    HMC_LISTEN_PORT: "37645",
    HMC_STRICT_LOCAL_MODE: "1",
    PORT: "37645",
    TRUST_PROXY_IP_HEADERS: "0",
    VAULT_DATA_DIR: vaultRoot,
    VAULT_ENCRYPTION_SECRET: randomBytes(32).toString("base64url"),
  };
}

function requestReadiness() {
  return new Promise((resolve) => {
    const request = http.get(
      {
        host: "127.0.0.1",
        port: 37645,
        path: "/login",
        timeout: 1_000,
      },
      (response) => {
        response.resume();
        response.once("end", () => resolve(true));
      },
    );
    request.once("timeout", () => {
      request.destroy();
      resolve(false);
    });
    request.once("error", () => resolve(false));
  });
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return true;
  }
  return await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.removeListener("exit", onExit);
      resolve(false);
    }, timeoutMs);
    function onExit() {
      clearTimeout(timer);
      resolve(true);
    }
    child.once("exit", onExit);
  });
}

async function defaultRunCycle({ stageRoot, environment, nodePath }) {
  const nextBin = path.join(
    stageRoot,
    "node_modules",
    "next",
    "dist",
    "bin",
    "next",
  );
  const child = spawn(
    nodePath,
    [nextBin, "start", "--hostname", "127.0.0.1", "--port", "37645"],
    {
      cwd: stageRoot,
      env: environment,
      stdio: "ignore",
      windowsHide: true,
      shell: false,
    },
  );
  try {
    const deadline = Date.now() + 60_000;
    let ready = false;
    while (!ready && Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error("service-exited");
      }
      ready = await requestReadiness();
      if (!ready) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    if (!ready) {
      throw new Error("service-not-ready");
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      if (!(await waitForExit(child, 10_000))) {
        child.kill("SIGKILL");
        if (!(await waitForExit(child, 5_000))) {
          throw new Error("service-did-not-stop");
        }
      }
    }
  }
}

async function internalProof({
  root,
  manifest,
  nodePath,
  runCycle = defaultRunCycle,
  applyPrivateAcl = applyPrivateWindowsAcl,
}) {
  const sourceRoot = await realpath(path.resolve(root));
  const validated = validateManifest(manifest);
  const nodeFile = await hashStableFile(path.resolve(nodePath));
  if (nodeFile.sha256 !== validated.nodeSha256) {
    throw new Error("node-mismatch");
  }

  const proofRoot = await mkdtemp(path.join(os.tmpdir(), "hma-runtime-proof-"));
  try {
    await applyPrivateAcl(proofRoot);
    const stageRoot = path.join(proofRoot, "runtime");
    const vaultRoot = path.join(proofRoot, "state", "vault");
    await mkdir(stageRoot, { recursive: false });
    await mkdir(vaultRoot, { recursive: true });
    await stageRuntime(sourceRoot, stageRoot, validated.runtimeFiles);
    const initial = await enumerateStage(stageRoot);
    if (!sameSnapshot(initial, validated.runtimeFiles)) {
      throw new Error("initial-stage-mismatch");
    }

    for (let cycle = 1; cycle <= 2; cycle += 1) {
      const environment = createSyntheticServiceEnvironment(vaultRoot);
      try {
        await runCycle({
          stageRoot,
          cycle,
          environment,
          nodePath: path.resolve(nodePath),
        });
      } finally {
        for (const name of [
          "APP_PASSWORD",
          "AUTH_SECRET",
          "VAULT_ENCRYPTION_SECRET",
        ]) {
          environment[name] = "";
          delete environment[name];
        }
      }
      const current = await enumerateStage(stageRoot);
      if (!sameSnapshot(current, initial)) {
        throw new Error("runtime-mutated");
      }
    }
    return { ok: true, cycles: 2, files: initial.length };
  } finally {
    await rm(proofRoot, { recursive: true, force: true });
  }
}

export async function proveRuntimeImmutability(options) {
  try {
    return await internalProof(options);
  } catch (error) {
    if (typeof options?.onSanitizedFailure === "function") {
      const code =
        error instanceof Error && /^[a-z0-9-]+$/u.test(error.message)
          ? error.message
          : "unknown";
      options.onSanitizedFailure(code);
    }
    throw new Error("runtime-immutability-failed");
  }
}

function parseArguments(argv) {
  if (
    argv.length !== 4 ||
    argv[0] !== "--root" ||
    argv[2] !== "--manifest"
  ) {
    throw new Error("invalid-arguments");
  }
  return {
    root: path.resolve(argv[1]),
    manifestPath: path.resolve(argv[3]),
  };
}

async function readVerifiedManifest(manifestPath) {
  const bytes = await readFile(manifestPath);
  const expectedPath = manifestPath.toLowerCase().endsWith(".json")
    ? `${manifestPath.slice(0, -5)}.sha256`
    : `${manifestPath}.sha256`;
  const expected = (await readFile(expectedPath, "ascii")).trim();
  if (!/^[a-f0-9]{64}$/u.test(expected) || sha256(bytes) !== expected) {
    throw new Error("manifest-hash-mismatch");
  }
  return JSON.parse(bytes.toString("utf8"));
}

async function main() {
  try {
    const parsed = parseArguments(process.argv.slice(2));
    const manifest = await readVerifiedManifest(parsed.manifestPath);
    const result = await proveRuntimeImmutability({
      root: parsed.root,
      manifest,
      nodePath: process.execPath,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch {
    process.stderr.write('{"ok":false,"error":"runtime-immutability-failed"}\n');
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  await main();
}
