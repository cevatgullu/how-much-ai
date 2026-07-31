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
import { isIP } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SERVICE_BASE_ENVIRONMENT_NAMES = [
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

const SANITIZED_BUILD_ENVIRONMENT_NAMES = [
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "PATH",
  "TEMP",
  "TMP",
  "LOCALAPPDATA",
  "APPDATA",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "PROCESSOR_IDENTIFIER",
  "OS",
];

function createSanitizedBuildEnvironment(source = process.env) {
  const sourceEntries = caseInsensitiveEnvironment(source);
  const result = {};
  for (const name of SANITIZED_BUILD_ENVIRONMENT_NAMES) {
    if (
      process.platform === "win32" &&
      (name === "COMSPEC" || name === "PATH")
    ) {
      continue;
    }
    const value = sourceEntries.get(name);
    if (value !== undefined) {
      result[
        name === "SYSTEMROOT"
          ? "SystemRoot"
          : name === "COMSPEC"
            ? "ComSpec"
            : name
      ] = value;
    }
  }
  return {
    ...result,
    NEXT_TELEMETRY_DISABLED: "1",
    NODE_ENV: "production",
    NPM_CONFIG_AUDIT: "false",
    NPM_CONFIG_FUND: "false",
  };
}

function compareOrdinal(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

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
    keys.length !== 5 ||
    keys[0] !== "bootstrapFiles" ||
    keys[1] !== "commit" ||
    keys[2] !== "installerSha256" ||
    keys[3] !== "nodeSha256" ||
    keys[4] !== "runtimeFiles" ||
    typeof manifest.commit !== "string" ||
    !/^[a-f0-9]{40}$/u.test(manifest.commit) ||
    typeof manifest.installerSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(manifest.installerSha256) ||
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
    compareOrdinal(left.path, right.path),
  );
  const sortedBootstrap = [...bootstrapFiles].sort((left, right) =>
    compareOrdinal(left.path, right.path),
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
    installerSha256: manifest.installerSha256,
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
  const snapshot = [];
  const pending = [{ absolute: stageRoot, relative: "" }];
  while (pending.length > 0) {
    const current = pending.pop();
    const entries = await readdir(current.absolute, { withFileTypes: true });
    entries.sort((left, right) => compareOrdinal(left.name, right.name));
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
        snapshot.push({
          path: relative,
          type: "directory",
          size: 0,
          sha256: "",
        });
        pending.push({ absolute, relative });
      } else if (info.isFile()) {
        const hashed = await hashStableFile(absolute);
        snapshot.push({
          path: relative,
          type: "file",
          size: hashed.size,
          sha256: hashed.sha256,
        });
      } else {
        throw new Error("stage-special-entry");
      }
    }
  }
  snapshot.sort((left, right) => compareOrdinal(left.path, right.path));
  return snapshot;
}

function expectedStageSnapshot(runtimeFiles) {
  const directories = new Set();
  for (const entry of runtimeFiles) {
    const parts = entry.path.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      directories.add(parts.slice(0, index).join("/"));
    }
  }
  return [
    ...[...directories].map((relative) => ({
      path: relative,
      type: "directory",
      size: 0,
      sha256: "",
    })),
    ...runtimeFiles.map((entry) => ({
      ...entry,
      type: "file",
    })),
  ].sort((left, right) => compareOrdinal(left.path, right.path));
}

function sameSnapshot(actual, expected) {
  return (
    actual.length === expected.length &&
    actual.every(
      (entry, index) =>
        entry.path === expected[index].path &&
        entry.type === expected[index].type &&
        entry.size === expected[index].size &&
        entry.sha256 === expected[index].sha256,
    )
  );
}

function caseInsensitiveEnvironment(source) {
  const folded = new Map();
  for (const [name, value] of Object.entries(source ?? {})) {
    if (typeof value !== "string") {
      continue;
    }
    const key = name.toUpperCase();
    if (folded.has(key) && folded.get(key) !== value) {
      throw new Error("ambiguous-environment");
    }
    folded.set(key, value);
  }
  return folded;
}

function createSyntheticServiceEnvironment(vaultRoot, profileRoot) {
  const source = caseInsensitiveEnvironment(process.env);
  const environment = {};
  for (const name of SERVICE_BASE_ENVIRONMENT_NAMES) {
    const value = source.get(name);
    if (typeof value === "string" && value.length > 0) {
      environment[name] = value;
    }
  }
  return {
    ...environment,
    APPDATA: path.join(profileRoot, "appdata"),
    APP_PASSWORD: randomBytes(32).toString("base64url"),
    AUTH_SECRET: randomBytes(32).toString("base64url"),
    ENABLE_LOCAL_CONNECT: "1",
    HMC_LISTEN_HOST: "127.0.0.1",
    HMC_LISTEN_PORT: "37645",
    HMC_STRICT_LOCAL_MODE: "1",
    LOCALAPPDATA: path.join(profileRoot, "localappdata"),
    NEXT_TELEMETRY_DISABLED: "1",
    NODE_ENV: "production",
    PORT: "37645",
    TEMP: path.join(profileRoot, "temp"),
    TMP: path.join(profileRoot, "temp"),
    TRUST_PROXY_IP_HEADERS: "0",
    USERPROFILE: profileRoot,
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

function normalizeRuntimeListeners(value) {
  if (!Array.isArray(value)) {
    throw new Error("listener-probe-invalid");
  }
  return value.map((listener) => {
    if (
      !listener ||
      typeof listener !== "object" ||
      typeof listener.localAddress !== "string" ||
      listener.localAddress.trim() !== listener.localAddress ||
      isIP(listener.localAddress) === 0 ||
      listener.localPort !== 37645 ||
      !Number.isSafeInteger(listener.pid) ||
      listener.pid <= 0
    ) {
      throw new Error("listener-probe-invalid");
    }
    return {
      localAddress: listener.localAddress,
      localPort: listener.localPort,
      pid: listener.pid,
    };
  });
}

function parseNetstatEndpoint(value) {
  if (typeof value !== "string") {
    return null;
  }
  const match = value.startsWith("[")
    ? /^\[([^\]\s]+)\]:(\d{1,5})$/u.exec(value)
    : /^([^:\s]+):(\d{1,5})$/u.exec(value);
  if (!match || isIP(match[1]) === 0) {
    return null;
  }
  const port = Number(match[2]);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
    return null;
  }
  return { address: match[1], port };
}

function getRuntimePortListeners() {
  if (process.platform !== "win32") {
    throw new Error("listener-ownership-unsupported");
  }
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  if (!systemRoot) {
    throw new Error("missing-system-root");
  }
  const netstat = path.join(systemRoot, "System32", "netstat.exe");
  const outputs = ["TCP", "TCPv6"].map((protocol) => {
    const result = spawnSync(netstat, ["-ano", "-p", protocol], {
      env: {
        ...createSanitizedBuildEnvironment(process.env),
        SystemRoot: systemRoot,
        WINDIR: systemRoot,
      },
      encoding: "utf8",
      windowsHide: true,
      shell: false,
      timeout: 10_000,
      maxBuffer: 64 * 1024,
    });
    if (result.error || result.signal || result.status !== 0) {
      throw new Error("listener-probe-failed");
    }
    return result.stdout;
  });
  const listeners = [];
  for (const line of outputs.join("\n").split(/\r?\n/u)) {
    const columns = line.trim().split(/\s+/u);
    if (columns[0] !== "TCP") {
      continue;
    }
    if (columns.length !== 5) {
      throw new Error("listener-probe-invalid");
    }
    const local = parseNetstatEndpoint(columns[1]);
    if (!local) {
      throw new Error("listener-probe-invalid");
    }
    if (local.port !== 37645) {
      continue;
    }
    const foreign = parseNetstatEndpoint(columns[2]);
    if (!foreign) {
      throw new Error("listener-probe-invalid");
    }
    if (
      foreign.port !== 0 ||
      (foreign.address !== "0.0.0.0" && foreign.address !== "::")
    ) {
      continue;
    }
    if (!/^\d+$/u.test(columns[4])) {
      throw new Error("listener-probe-invalid");
    }
    const pid = Number(columns[4]);
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      throw new Error("listener-probe-invalid");
    }
    listeners.push({
      localAddress: local.address,
      localPort: local.port,
      pid,
    });
  }
  return normalizeRuntimeListeners(listeners);
}

export async function assertRuntimePortAvailable(
  listenerProbe = async () => getRuntimePortListeners(),
) {
  const listeners = normalizeRuntimeListeners(await listenerProbe());
  if (listeners.length !== 0) {
    throw new Error("service-port-in-use");
  }
}

function isExclusiveOwnedLoopbackListener(listeners, childPid) {
  return (
    listeners.length === 1 &&
    listeners[0].localAddress === "127.0.0.1" &&
    listeners[0].localPort === 37645 &&
    listeners[0].pid === childPid
  );
}

export async function waitForOwnedReadiness({
  child,
  listenerProbe = async () => getRuntimePortListeners(),
  readiness = requestReadiness,
  pause = async () =>
    await new Promise((resolve) => setTimeout(resolve, 250)),
  deadline,
}) {
  if (
    !child ||
    !Number.isSafeInteger(child.pid) ||
    child.pid <= 0 ||
    !Number.isFinite(deadline)
  ) {
    throw new Error("service-child-invalid");
  }
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error("service-exited");
    }
    const before = normalizeRuntimeListeners(await listenerProbe());
    if (before.length > 0) {
      if (!isExclusiveOwnedLoopbackListener(before, child.pid)) {
        throw new Error("service-listener-owner-mismatch");
      }
      const ready = await readiness();
      const after = normalizeRuntimeListeners(await listenerProbe());
      if (!isExclusiveOwnedLoopbackListener(after, child.pid)) {
        throw new Error("service-listener-owner-mismatch");
      }
      if (
        ready &&
        child.exitCode === null &&
        child.signalCode === null
      ) {
        return;
      }
    }
    await pause();
  }
  throw new Error("service-not-ready");
}

export async function observeOwnedRuntimeStability({
  child,
  listenerProbe = async () => getRuntimePortListeners(),
  readiness = requestReadiness,
  pause = async () =>
    await new Promise((resolve) => setTimeout(resolve, 500)),
  observations = 10,
}) {
  if (
    !child ||
    !Number.isSafeInteger(child.pid) ||
    child.pid <= 0 ||
    !Number.isSafeInteger(observations) ||
    observations < 1 ||
    observations > 100
  ) {
    throw new Error("service-child-invalid");
  }
  for (let observation = 0; observation < observations; observation += 1) {
    await pause();
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error("service-exited");
    }
    const before = normalizeRuntimeListeners(await listenerProbe());
    if (!isExclusiveOwnedLoopbackListener(before, child.pid)) {
      throw new Error("service-listener-owner-mismatch");
    }
    const ready = await readiness();
    const after = normalizeRuntimeListeners(await listenerProbe());
    if (!isExclusiveOwnedLoopbackListener(after, child.pid)) {
      throw new Error("service-listener-owner-mismatch");
    }
    if (
      !ready ||
      child.exitCode !== null ||
      child.signalCode !== null
    ) {
      throw new Error("service-readiness-lost");
    }
  }
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

export async function stopRuntimeChildAndAssertPortFree({
  child,
  listenerProbe = async () => getRuntimePortListeners(),
}) {
  try {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      if (!(await waitForExit(child, 10_000))) {
        child.kill("SIGKILL");
        if (!(await waitForExit(child, 5_000))) {
          throw new Error("service-did-not-stop");
        }
      }
    }
  } finally {
    await assertRuntimePortAvailable(listenerProbe);
  }
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
  await assertRuntimePortAvailable();
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
    await waitForOwnedReadiness({
      child,
      deadline: Date.now() + 60_000,
    });
    await observeOwnedRuntimeStability({ child });
  } finally {
    await stopRuntimeChildAndAssertPortFree({ child });
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
    const profileRoot = path.join(proofRoot, "profile");
    await mkdir(stageRoot, { recursive: false });
    await mkdir(vaultRoot, { recursive: true });
    for (const directory of [
      profileRoot,
      path.join(profileRoot, "appdata"),
      path.join(profileRoot, "localappdata"),
      path.join(profileRoot, "temp"),
    ]) {
      await mkdir(directory, { recursive: false });
    }
    await stageRuntime(sourceRoot, stageRoot, validated.runtimeFiles);
    const initial = await enumerateStage(stageRoot);
    const expectedInitial = expectedStageSnapshot(validated.runtimeFiles);
    if (!sameSnapshot(initial, expectedInitial)) {
      throw new Error("initial-stage-mismatch");
    }

    const serviceEnvironment = createSyntheticServiceEnvironment(
      vaultRoot,
      profileRoot,
    );
    try {
      for (let cycle = 1; cycle <= 2; cycle += 1) {
        const environment = { ...serviceEnvironment };
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
    } finally {
      for (const name of [
        "APP_PASSWORD",
        "AUTH_SECRET",
        "VAULT_ENCRYPTION_SECRET",
      ]) {
        serviceEnvironment[name] = "";
        delete serviceEnvironment[name];
      }
    }
    return { ok: true, cycles: 2, files: validated.runtimeFiles.length };
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
    argv.length !== 6 ||
    argv[0] !== "--root" ||
    argv[2] !== "--manifest" ||
    argv[4] !== "--expected-manifest-sha256" ||
    !/^[a-f0-9]{64}$/u.test(argv[5])
  ) {
    throw new Error("invalid-arguments");
  }
  return {
    root: path.resolve(argv[1]),
    manifestPath: path.resolve(argv[3]),
    expectedManifestSha256: argv[5],
  };
}

async function readVerifiedManifest(
  manifestPath,
  expectedManifestSha256,
) {
  if (!/^[a-f0-9]{64}$/u.test(expectedManifestSha256 ?? "")) {
    throw new Error("manifest-hash-mismatch");
  }
  const manifestFile = await hashStableFile(manifestPath);
  const expectedPath = manifestPath.toLowerCase().endsWith(".json")
    ? `${manifestPath.slice(0, -5)}.sha256`
    : `${manifestPath}.sha256`;
  const digestFile = await hashStableFile(expectedPath);
  const publishedDigest = digestFile.bytes.toString("ascii");
  if (
    publishedDigest !== expectedManifestSha256 ||
    manifestFile.sha256 !== expectedManifestSha256
  ) {
    throw new Error("manifest-hash-mismatch");
  }
  return JSON.parse(manifestFile.bytes.toString("utf8"));
}

export async function proveRuntimeImmutabilityFromManifest(options) {
  try {
    const manifest = await readVerifiedManifest(
      path.resolve(options.manifestPath),
      options.expectedManifestSha256,
    );
    return await internalProof({
      ...options,
      manifest,
    });
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

async function main() {
  try {
    const parsed = parseArguments(process.argv.slice(2));
    const result = await proveRuntimeImmutabilityFromManifest({
      root: parsed.root,
      manifestPath: parsed.manifestPath,
      expectedManifestSha256: parsed.expectedManifestSha256,
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
