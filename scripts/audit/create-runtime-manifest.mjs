import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const EXPECTED_BOOTSTRAP_PATHS = Object.freeze([
  "scripts/windows/connect-claude-secure.ps1",
  "scripts/windows/oauth-handoff-extension/callback.js",
  "scripts/windows/oauth-handoff-extension/manifest.json",
  "scripts/windows/open-secure-local.ps1",
  "scripts/windows/SecureLocalIntegrity.psm1",
  "scripts/windows/SecureLocalRuntime.psm1",
  "scripts/windows/SecureLocalSecrets.psm1",
  "scripts/windows/start-secure-local.ps1",
  "scripts/windows/verify-final-local-state.ps1",
]);

const REQUIRED_RUNTIME_FILES = Object.freeze([
  "package.json",
  "package-lock.json",
  "next.config.ts",
]);
const REQUIRED_RUNTIME_DIRECTORIES = Object.freeze([
  "public",
  "node_modules",
  ".next",
]);
const INSTALLER_PATH = "scripts/windows/install-secure-local.ps1";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeManifestPath(value) {
  if (typeof value !== "string" || value.length === 0 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error("unsafe-manifest-path");
  }
  const normalized = value.replaceAll("\\", "/").normalize("NFC");
  if (
    normalized.startsWith("/") ||
    /^[A-Za-z]:/u.test(normalized) ||
    normalized.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error("unsafe-manifest-path");
  }
  return normalized;
}

export function assertUniqueNormalizedPaths(paths) {
  try {
    const folded = new Set();
    for (const value of paths) {
      const normalized = normalizeManifestPath(value);
      const key = normalized.toLocaleLowerCase("en-US");
      if (folded.has(key)) {
        throw new Error("path-collision");
      }
      folded.add(key);
    }
  } catch {
    throw new Error("runtime-manifest-failed");
  }
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

async function assertOrdinaryDirectory(absolutePath) {
  const info = await lstat(absolutePath);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("invalid-directory");
  }
  const resolved = await realpath(absolutePath);
  if (path.resolve(resolved).toLowerCase() !== path.resolve(absolutePath).toLowerCase()) {
    throw new Error("reparse-directory");
  }
}

async function assertOrdinaryFile(root, absolutePath) {
  const before = await lstat(absolutePath);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error("invalid-file");
  }
  const resolved = await realpath(absolutePath);
  if (!isInside(root, resolved) && resolved.toLowerCase() !== absolutePath.toLowerCase()) {
    throw new Error("file-outside-root");
  }
  return before;
}

function sameFileSnapshot(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

async function hashStableFile(root, absolutePath, manifestPath) {
  const before = await assertOrdinaryFile(root, absolutePath);
  const bytes = await readFile(absolutePath);
  const after = await lstat(absolutePath);
  if (!after.isFile() || after.isSymbolicLink() || !sameFileSnapshot(before, after)) {
    throw new Error("file-set-race");
  }
  return {
    path: normalizeManifestPath(manifestPath),
    size: bytes.byteLength,
    sha256: sha256(bytes),
  };
}

async function enumerateDirectory(root, directoryPath, prefix, { excludeCache = false } = {}) {
  await assertOrdinaryDirectory(directoryPath);
  const results = [];
  const pending = [{ absolute: directoryPath, relative: prefix }];
  while (pending.length > 0) {
    const current = pending.pop();
    const entries = await readdir(current.absolute, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const relative = normalizeManifestPath(`${current.relative}/${entry.name}`);
      const absolute = path.join(current.absolute, entry.name);
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) {
        throw new Error("reparse-entry");
      }
      if (info.isDirectory()) {
        const resolved = await realpath(absolute);
        if (resolved.toLowerCase() !== absolute.toLowerCase()) {
          throw new Error("reparse-entry");
        }
        if (excludeCache && relative.toLowerCase() === ".next/cache") {
          continue;
        }
        pending.push({ absolute, relative });
      } else if (info.isFile()) {
        results.push({ absolute, relative });
      } else {
        throw new Error("unsupported-entry");
      }
    }
  }
  results.sort((left, right) => left.relative.localeCompare(right.relative, "en"));
  return results;
}

async function snapshotInstallablePaths(root) {
  const results = [];
  for (const relative of REQUIRED_RUNTIME_FILES) {
    const absolute = path.join(root, relative);
    await assertOrdinaryFile(root, absolute);
    results.push({ absolute, relative });
  }
  for (const relative of REQUIRED_RUNTIME_DIRECTORIES) {
    results.push(
      ...(await enumerateDirectory(root, path.join(root, relative), relative, {
        excludeCache: relative === ".next",
      })),
    );
  }
  results.sort((left, right) => left.relative.localeCompare(right.relative, "en"));
  assertUniqueNormalizedPaths(results.map((entry) => entry.relative));
  return results;
}

async function assertExactBootstrapTree(root) {
  const windowsRoot = path.join(root, "scripts", "windows");
  const files = await enumerateDirectory(root, windowsRoot, "scripts/windows");
  const actual = files
    .map((entry) => entry.relative)
    .filter((entry) => entry !== INSTALLER_PATH)
    .sort((left, right) => left.localeCompare(right, "en"));
  if (
    actual.length !== EXPECTED_BOOTSTRAP_PATHS.length ||
    actual.some((entry, index) => entry !== EXPECTED_BOOTSTRAP_PATHS[index])
  ) {
    throw new Error("unexpected-bootstrap-tree");
  }
  return files.filter((entry) => entry.relative !== INSTALLER_PATH);
}

async function assertNodeExecutable(nodePath) {
  if (!path.isAbsolute(nodePath)) {
    throw new Error("invalid-node-path");
  }
  const info = await lstat(nodePath);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error("invalid-node-file");
  }
  const resolved = await realpath(nodePath);
  if (resolved.toLowerCase() !== path.resolve(nodePath).toLowerCase()) {
    throw new Error("reparse-node-file");
  }
  const before = await stat(nodePath);
  const bytes = await readFile(nodePath);
  const after = await stat(nodePath);
  if (!sameFileSnapshot(before, after)) {
    throw new Error("node-file-race");
  }
  return sha256(bytes);
}

async function internalCreateRuntimeManifest({
  root,
  commit,
  nodePath,
  trackedPaths,
}) {
  if (typeof commit !== "string" || !/^[a-f0-9]{40}$/u.test(commit)) {
    throw new Error("invalid-commit");
  }
  const requestedRoot = path.resolve(root);
  await assertOrdinaryDirectory(requestedRoot);
  const canonicalRoot = await realpath(requestedRoot);
  const runtimeSnapshotBefore = await snapshotInstallablePaths(canonicalRoot);
  const bootstrapSnapshotBefore = await assertExactBootstrapTree(canonicalRoot);
  const tracked = new Set(
    [...trackedPaths].map((entry) => normalizeManifestPath(entry)),
  );
  if (EXPECTED_BOOTSTRAP_PATHS.some((entry) => !tracked.has(entry))) {
    throw new Error("untracked-bootstrap-input");
  }

  const runtimeFiles = [];
  for (const entry of runtimeSnapshotBefore) {
    runtimeFiles.push(
      await hashStableFile(canonicalRoot, entry.absolute, entry.relative),
    );
  }
  const bootstrapFiles = [];
  for (const entry of bootstrapSnapshotBefore) {
    bootstrapFiles.push(
      await hashStableFile(canonicalRoot, entry.absolute, entry.relative),
    );
  }
  runtimeFiles.sort((left, right) => left.path.localeCompare(right.path, "en"));
  bootstrapFiles.sort((left, right) => left.path.localeCompare(right.path, "en"));

  const runtimeSnapshotAfter = await snapshotInstallablePaths(canonicalRoot);
  const bootstrapSnapshotAfter = await assertExactBootstrapTree(canonicalRoot);
  const beforePaths = [
    ...runtimeSnapshotBefore.map((entry) => entry.relative),
    ...bootstrapSnapshotBefore.map((entry) => entry.relative),
  ];
  const afterPaths = [
    ...runtimeSnapshotAfter.map((entry) => entry.relative),
    ...bootstrapSnapshotAfter.map((entry) => entry.relative),
  ];
  if (
    beforePaths.length !== afterPaths.length ||
    beforePaths.some((entry, index) => entry !== afterPaths[index])
  ) {
    throw new Error("file-set-race");
  }

  const manifest = {
    commit,
    nodeSha256: await assertNodeExecutable(nodePath),
    runtimeFiles,
    bootstrapFiles,
  };
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { manifest, bytes, sha256: sha256(bytes) };
}

export async function createRuntimeManifest(options) {
  try {
    return await internalCreateRuntimeManifest(options);
  } catch {
    throw new Error("runtime-manifest-failed");
  }
}

function parseArguments(argv) {
  const accepted = new Set([
    "--root",
    "--commit",
    "--node",
    "--output",
    "--sha256-output",
  ]);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!accepted.has(flag) || !value || values.has(flag)) {
      throw new Error("invalid-arguments");
    }
    values.set(flag, value);
  }
  if (values.size !== accepted.size) {
    throw new Error("invalid-arguments");
  }
  return {
    root: path.resolve(values.get("--root")),
    commit: values.get("--commit"),
    nodePath: path.resolve(values.get("--node")),
    outputPath: path.resolve(values.get("--output")),
    sha256Path: path.resolve(values.get("--sha256-output")),
  };
}

function getTrackedWindowsPaths(root) {
  const output = execFileSync(
    "git",
    ["-C", root, "ls-files", "-z", "--", "scripts/windows"],
    { encoding: "utf8", windowsHide: true, maxBuffer: 1024 * 1024 },
  );
  return new Set(
    output
      .split("\0")
      .filter(Boolean)
      .map((entry) => entry.replaceAll("\\", "/")),
  );
}

function assertCleanExactCommit(root, commit) {
  const head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
    encoding: "utf8",
    windowsHide: true,
  }).trim();
  const status = execFileSync(
    "git",
    ["-C", root, "status", "--porcelain", "--untracked-files=no"],
    { encoding: "utf8", windowsHide: true, maxBuffer: 1024 * 1024 },
  );
  if (head !== commit || status !== "") {
    throw new Error("source-not-clean-exact-commit");
  }
}

async function main() {
  try {
    const parsed = parseArguments(process.argv.slice(2));
    assertCleanExactCommit(parsed.root, parsed.commit);
    const generated = await createRuntimeManifest({
      root: parsed.root,
      commit: parsed.commit,
      nodePath: parsed.nodePath,
      trackedPaths: getTrackedWindowsPaths(parsed.root),
    });
    await mkdir(path.dirname(parsed.outputPath), { recursive: true });
    await mkdir(path.dirname(parsed.sha256Path), { recursive: true });
    await writeFile(parsed.outputPath, generated.bytes, { flag: "wx" });
    await writeFile(parsed.sha256Path, `${generated.sha256}\n`, {
      encoding: "ascii",
      flag: "wx",
    });
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        runtimeFiles: generated.manifest.runtimeFiles.length,
        bootstrapFiles: generated.manifest.bootstrapFiles.length,
      })}\n`,
    );
  } catch {
    process.stderr.write('{"ok":false,"error":"runtime-manifest-failed"}\n');
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  await main();
}
