import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  unlink,
  writeFile,
} from "node:fs/promises";
import { devNull } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

function compareOrdinal(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export const EXPECTED_BOOTSTRAP_PATHS = Object.freeze([
  "scripts/windows/connect-claude-secure.ps1",
  "scripts/windows/launch-secure-local.ps1",
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
const EXCLUDED_NON_RUNTIME_FILES = new Set([
  "node_modules/convex/dist/cli.bundle.cjs",
  "node_modules/convex/dist/cli.bundle.cjs.map",
  "node_modules/convex/src/cli/lib/formatenvvaluefordotfile.test.ts",
  "node_modules/next/dist/docs/01-app/02-guides/environment-variables.md",
]);
const EXPECTED_WINDOWS_SOURCE_PATHS = Object.freeze(
  [...EXPECTED_BOOTSTRAP_PATHS, INSTALLER_PATH].sort(compareOrdinal),
);
const DERIVED_RUNTIME_PREFIXES = Object.freeze([".next/", "node_modules/"]);
const IGNORED_GENERATED_PREFIXES = Object.freeze([
  ".next/",
  "node_modules/",
  "audit/",
]);
const AMBIENT_GIT_REPOSITORY_OVERRIDES = new Set([
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CEILING_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_DIR",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
  "GIT_INDEX_FILE",
  "GIT_NAMESPACE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_REPLACE_REF_BASE",
  "GIT_WORK_TREE",
]);
const GIT_NULL_CONFIG_PATH = process.platform === "win32" ? "NUL" : devNull;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function sameSecurityFileSnapshot(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
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

export function isExcludedNonRuntimeArtifact(relativePath) {
  const normalized = normalizeManifestPath(relativePath).toLocaleLowerCase("en-US");
  return (
    (normalized.startsWith(".next/") && normalized.endsWith(".map")) ||
    EXCLUDED_NON_RUNTIME_FILES.has(normalized)
  );
}

function assertNoAmbientGitRepositoryOverrides(environment = process.env) {
  for (const [key] of Object.entries(environment)) {
    if (AMBIENT_GIT_REPOSITORY_OVERRIDES.has(key.toUpperCase())) {
      throw new Error("ambient-git-repository-override");
    }
  }
}

function sanitizedGitEnvironment(environment = process.env) {
  const sanitized = Object.fromEntries(
    Object.entries(environment).filter(
      ([key]) => !key.toUpperCase().startsWith("GIT_"),
    ),
  );
  return {
    ...sanitized,
    GIT_CONFIG_GLOBAL: GIT_NULL_CONFIG_PATH,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_OPTIONAL_LOCKS: "0",
  };
}

function runGit(
  gitPath,
  root,
  args,
  { encoding = "utf8", maxBuffer = 16 * 1024 * 1024 } = {},
) {
  assertNoAmbientGitRepositoryOverrides();
  return execFileSync(
    gitPath,
    [
      "-c",
      "core.excludesFile=",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.untrackedCache=false",
      "-C",
      root,
      ...args,
    ],
    {
      encoding,
      env: sanitizedGitEnvironment(),
      maxBuffer,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
}

function parseNullTerminated(output) {
  if (typeof output !== "string" || (!output.endsWith("\0") && output !== "")) {
    throw new Error("invalid-git-output");
  }
  return output.split("\0").filter(Boolean);
}

function assertNoLocalGitAccelerators(gitPath, root) {
  const records = parseNullTerminated(
    runGit(gitPath, root, ["config", "--local", "--null", "--list"]),
  );
  const forbidden = new Set([
    "core.fsmonitor",
    "core.fsmonitorhookversion",
    "core.untrackedcache",
  ]);
  if (
    records.some((record) =>
      forbidden.has(record.split("\n", 1)[0].toLowerCase()),
    )
  ) {
    throw new Error("local-git-accelerator-configured");
  }
}

async function assertExactReviewedHead(
  gitPath,
  root,
  commit,
  upstreamBase,
) {
  const topLevel = runGit(gitPath, root, [
    "rev-parse",
    "--path-format=absolute",
    "--show-toplevel",
  ]).trim();
  const canonicalTopLevel = await realpath(path.resolve(topLevel));
  if (canonicalTopLevel.toLowerCase() !== root.toLowerCase()) {
    throw new Error("unexpected-git-root");
  }

  const head = runGit(
    gitPath,
    root,
    ["rev-parse", "--verify", "HEAD^{commit}"],
  ).trim();
  if (head !== commit) {
    throw new Error("source-not-exact-head");
  }
  if (upstreamBase !== undefined) {
    runGit(gitPath, root, [
      "merge-base",
      "--is-ancestor",
      upstreamBase,
      commit,
    ]);
  }
  assertNoLocalGitAccelerators(gitPath, root);

  const fsmonitorEntries = parseNullTerminated(
    runGit(gitPath, root, ["ls-files", "-f", "-z"]),
  );
  if (fsmonitorEntries.some((entry) => !entry.startsWith("H "))) {
    throw new Error("hidden-fsmonitor-state");
  }

  const indexEntries = parseNullTerminated(
    runGit(gitPath, root, ["ls-files", "-v", "-z"]),
  );
  if (indexEntries.some((entry) => !entry.startsWith("H "))) {
    throw new Error("hidden-index-state");
  }

  const status = runGit(gitPath, root, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=no",
  ]);
  if (status !== "") {
    throw new Error("tracked-source-not-clean");
  }
  assertOnlyReviewedUntrackedPaths(gitPath, root);
}

function getReviewedCommitPaths(gitPath, root, commit) {
  const entries = parseNullTerminated(
    runGit(gitPath, root, [
      "ls-tree",
      "-r",
      "--name-only",
      "-z",
      commit,
    ]),
  ).map((entry) => normalizeManifestPath(entry));
  assertUniqueNormalizedPaths(entries);
  return new Set(entries);
}

function isDerivedRuntimePath(manifestPath) {
  return DERIVED_RUNTIME_PREFIXES.some((prefix) =>
    manifestPath.startsWith(prefix),
  );
}

function isAllowedIgnoredGeneratedPath(manifestPath) {
  return (
    IGNORED_GENERATED_PREFIXES.some((prefix) =>
      manifestPath.startsWith(prefix),
    ) ||
    manifestPath === "next-env.d.ts" ||
    manifestPath === "tsconfig.tsbuildinfo"
  );
}

function assertOnlyReviewedUntrackedPaths(gitPath, root) {
  const untrackedPaths = parseNullTerminated(
    runGit(gitPath, root, [
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
      "--",
      ".",
      ":(exclude).next/**",
      ":(exclude)node_modules/**",
    ]),
  ).map((entry) => normalizeManifestPath(entry));
  assertUniqueNormalizedPaths(untrackedPaths);
  if (untrackedPaths.some((entry) => !isDerivedRuntimePath(entry))) {
    throw new Error("unreviewed-untracked-input");
  }

  const ignoredPaths = parseNullTerminated(
    runGit(gitPath, root, [
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "-z",
      "--",
      ".",
      ":(exclude).next/**",
      ":(exclude)node_modules/**",
      ":(exclude)audit/**",
    ]),
  ).map((entry) => normalizeManifestPath(entry));
  assertUniqueNormalizedPaths(ignoredPaths);
  if (ignoredPaths.some((entry) => !isAllowedIgnoredGeneratedPath(entry))) {
    throw new Error("unreviewed-ignored-input");
  }
}

function readReviewedBlob(gitPath, root, commit, manifestPath) {
  return runGit(
    gitPath,
    root,
    ["cat-file", "blob", `${commit}:${manifestPath}`],
    {
      encoding: null,
      maxBuffer: 256 * 1024 * 1024,
    },
  );
}

async function assertReviewedInputs({
  gitPath,
  root,
  commit,
  reviewedCommitPaths,
  runtimeEntries,
  windowsEntries,
}) {
  const reviewedEntries = [
    ...runtimeEntries.filter((entry) => !isDerivedRuntimePath(entry.relative)),
    ...windowsEntries,
  ];
  assertUniqueNormalizedPaths(reviewedEntries.map((entry) => entry.relative));
  if (
    reviewedEntries.some(
      (entry) => !reviewedCommitPaths.has(entry.relative),
    )
  ) {
    throw new Error("unreviewed-runtime-input");
  }

  const expected = new Map();
  for (const relative of reviewedCommitPaths) {
    const bytes = readReviewedBlob(gitPath, root, commit, relative);
    const expectedFile = {
      size: bytes.byteLength,
      sha256: sha256(bytes),
    };
    await hashStableFile(
      root,
      path.join(root, ...relative.split("/")),
      relative,
      expectedFile,
    );
    expected.set(relative, expectedFile);
  }
  return expected;
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
  const before = await lstat(absolutePath, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw new Error("invalid-directory");
  }
  const resolved = await realpath(absolutePath);
  if (path.resolve(resolved).toLowerCase() !== path.resolve(absolutePath).toLowerCase()) {
    throw new Error("reparse-directory");
  }
  const after = await lstat(absolutePath, { bigint: true });
  if (
    !after.isDirectory() ||
    after.isSymbolicLink() ||
    !sameSecurityFileSnapshot(before, after)
  ) {
    throw new Error("directory-race");
  }
  return after;
}

async function assertOrdinaryFile(root, absolutePath) {
  const before = await lstat(absolutePath, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error("invalid-file");
  }
  const resolved = await realpath(absolutePath);
  if (!isInside(root, resolved) && resolved.toLowerCase() !== absolutePath.toLowerCase()) {
    throw new Error("file-outside-root");
  }
  const after = await lstat(absolutePath, { bigint: true });
  if (
    !after.isFile() ||
    after.isSymbolicLink() ||
    !sameSecurityFileSnapshot(before, after)
  ) {
    throw new Error("file-race");
  }
  return after;
}

async function hashStableFile(
  root,
  absolutePath,
  manifestPath,
  expectedReviewedFile,
) {
  const before = await assertOrdinaryFile(root, absolutePath);
  const bytes = await readFile(absolutePath);
  const after = await lstat(absolutePath, { bigint: true });
  if (
    !after.isFile() ||
    after.isSymbolicLink() ||
    !sameSecurityFileSnapshot(before, after)
  ) {
    throw new Error("file-set-race");
  }
  const result = {
    path: normalizeManifestPath(manifestPath),
    size: bytes.byteLength,
    sha256: sha256(bytes),
  };
  if (
    expectedReviewedFile &&
    (result.size !== expectedReviewedFile.size ||
      result.sha256 !== expectedReviewedFile.sha256)
  ) {
    throw new Error("reviewed-input-byte-mismatch");
  }
  return result;
}

async function enumerateDirectory(
  root,
  directoryPath,
  prefix,
  { excludeCache = false, excludeNonRuntimeArtifacts = false } = {},
) {
  await assertOrdinaryDirectory(directoryPath);
  const results = [];
  const pending = [{ absolute: directoryPath, relative: prefix }];
  while (pending.length > 0) {
    const current = pending.pop();
    const entries = await readdir(current.absolute, { withFileTypes: true });
    entries.sort((left, right) => compareOrdinal(left.name, right.name));
    for (const entry of entries) {
      const relative = normalizeManifestPath(`${current.relative}/${entry.name}`);
      const absolute = path.join(current.absolute, entry.name);
      const info = await lstat(absolute, { bigint: true });
      if (info.isSymbolicLink()) {
        throw new Error("reparse-entry");
      }
      if (info.isDirectory()) {
        const resolved = await realpath(absolute);
        if (resolved.toLowerCase() !== absolute.toLowerCase()) {
          throw new Error("reparse-entry");
        }
        const after = await lstat(absolute, { bigint: true });
        if (
          !after.isDirectory() ||
          after.isSymbolicLink() ||
          !sameSecurityFileSnapshot(info, after)
        ) {
          throw new Error("directory-entry-race");
        }
        if (excludeCache && relative.toLowerCase() === ".next/cache") {
          continue;
        }
        pending.push({ absolute, relative });
      } else if (info.isFile()) {
        if (
          excludeNonRuntimeArtifacts &&
          isExcludedNonRuntimeArtifact(relative)
        ) {
          continue;
        }
        results.push({ absolute, relative });
      } else {
        throw new Error("unsupported-entry");
      }
    }
  }
  results.sort((left, right) => compareOrdinal(left.relative, right.relative));
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
        excludeNonRuntimeArtifacts:
          relative === ".next" || relative === "node_modules",
      })),
    );
  }
  results.sort((left, right) => compareOrdinal(left.relative, right.relative));
  assertUniqueNormalizedPaths(results.map((entry) => entry.relative));
  return results;
}

async function assertExactBootstrapTree(root) {
  const windowsRoot = path.join(root, "scripts", "windows");
  const files = await enumerateDirectory(root, windowsRoot, "scripts/windows");
  const actual = files.map((entry) => entry.relative);
  if (
    actual.length !== EXPECTED_WINDOWS_SOURCE_PATHS.length ||
    actual.some((entry, index) => entry !== EXPECTED_WINDOWS_SOURCE_PATHS[index])
  ) {
    throw new Error("unexpected-bootstrap-tree");
  }
  return {
    allFiles: files,
    bootstrapFiles: files.filter((entry) => entry.relative !== INSTALLER_PATH),
  };
}

async function assertNodeExecutable(nodePath) {
  if (
    path.resolve(nodePath).toLowerCase() !==
    path.resolve(process.execPath).toLowerCase()
  ) {
    throw new Error("unexpected-node-executable");
  }
  const before = await assertStableOrdinaryExecutable(nodePath, "node");
  const bytes = await readFile(nodePath);
  const after = await lstat(nodePath, { bigint: true });
  if (
    !after.isFile() ||
    after.isSymbolicLink() ||
    !sameSecurityFileSnapshot(before, after)
  ) {
    throw new Error("node-file-race");
  }
  return sha256(bytes);
}

async function assertStableOrdinaryExecutable(executablePath, kind) {
  if (typeof executablePath !== "string" || !path.isAbsolute(executablePath)) {
    throw new Error(`invalid-${kind}-path`);
  }
  const absolutePath = path.resolve(executablePath);
  const before = await lstat(absolutePath, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error(`invalid-${kind}-file`);
  }
  const resolved = await realpath(absolutePath);
  if (path.resolve(resolved).toLowerCase() !== absolutePath.toLowerCase()) {
    throw new Error(`reparse-${kind}-file`);
  }
  const after = await lstat(absolutePath, { bigint: true });
  if (
    !after.isFile() ||
    after.isSymbolicLink() ||
    !sameSecurityFileSnapshot(before, after)
  ) {
    throw new Error(`${kind}-file-race`);
  }
  return after;
}

async function assertGitExecutable(
  gitPath,
  expectedSnapshot,
  expectedSha256,
) {
  const expectedWindowsGitPath =
    process.platform === "win32"
      ? path.join(
          path.parse(process.execPath).root,
          "Program Files",
          "Git",
          "mingw64",
          "bin",
          "git.exe",
        )
      : undefined;
  if (
    process.platform === "win32" &&
    (typeof gitPath !== "string" ||
      path.basename(gitPath).toLowerCase() !== "git.exe" ||
      path.resolve(gitPath).toLowerCase() !==
        path.resolve(expectedWindowsGitPath).toLowerCase())
  ) {
    throw new Error("invalid-git-location");
  }
  const current = await assertStableOrdinaryExecutable(gitPath, "git");
  if (
    expectedSnapshot &&
    !sameSecurityFileSnapshot(expectedSnapshot, current)
  ) {
    throw new Error("git-file-changed");
  }
  if (
    expectedSha256 !== undefined &&
    (typeof expectedSha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(expectedSha256))
  ) {
    throw new Error("invalid-git-hash");
  }
  if (expectedSha256 === undefined) {
    return current;
  }
  const bytes = await readFile(gitPath);
  const after = await assertStableOrdinaryExecutable(gitPath, "git");
  if (
    !sameSecurityFileSnapshot(current, after) ||
    sha256(bytes) !== expectedSha256
  ) {
    throw new Error("git-hash-mismatch");
  }
  return after;
}

async function internalCreateRuntimeManifest({
  root,
  commit,
  nodePath,
  gitPath,
  expectedGitSha256,
  upstreamBase,
}) {
  if (typeof commit !== "string" || !/^[a-f0-9]{40}$/u.test(commit)) {
    throw new Error("invalid-commit");
  }
  if (
    upstreamBase !== undefined &&
    (typeof upstreamBase !== "string" ||
      !/^[a-f0-9]{40}$/u.test(upstreamBase))
  ) {
    throw new Error("invalid-upstream-base");
  }
  const requestedRoot = path.resolve(root);
  await assertOrdinaryDirectory(requestedRoot);
  const canonicalRoot = await realpath(requestedRoot);
  const gitSnapshot = await assertGitExecutable(
    gitPath,
    undefined,
    expectedGitSha256,
  );
  await assertExactReviewedHead(
    gitPath,
    canonicalRoot,
    commit,
    upstreamBase,
  );
  const reviewedCommitPaths = getReviewedCommitPaths(
    gitPath,
    canonicalRoot,
    commit,
  );
  const runtimeSnapshotBefore = await snapshotInstallablePaths(canonicalRoot);
  const windowsSnapshotBefore = await assertExactBootstrapTree(canonicalRoot);
  const expectedReviewedFiles = await assertReviewedInputs({
    gitPath,
    root: canonicalRoot,
    commit,
    reviewedCommitPaths,
    runtimeEntries: runtimeSnapshotBefore,
    windowsEntries: windowsSnapshotBefore.allFiles,
  });

  const runtimeFiles = [];
  for (const entry of runtimeSnapshotBefore) {
    runtimeFiles.push(
      await hashStableFile(
        canonicalRoot,
        entry.absolute,
        entry.relative,
        expectedReviewedFiles.get(entry.relative),
      ),
    );
  }
  const bootstrapFiles = [];
  for (const entry of windowsSnapshotBefore.bootstrapFiles) {
    bootstrapFiles.push(
      await hashStableFile(
        canonicalRoot,
        entry.absolute,
        entry.relative,
        expectedReviewedFiles.get(entry.relative),
      ),
    );
  }
  const installerEntry = windowsSnapshotBefore.allFiles.find(
    (entry) => entry.relative === INSTALLER_PATH,
  );
  if (!installerEntry) {
    throw new Error("missing-reviewed-installer");
  }
  const installerFile = await hashStableFile(
    canonicalRoot,
    installerEntry.absolute,
    installerEntry.relative,
    expectedReviewedFiles.get(installerEntry.relative),
  );
  runtimeFiles.sort((left, right) => compareOrdinal(left.path, right.path));
  bootstrapFiles.sort((left, right) => compareOrdinal(left.path, right.path));

  const runtimeSnapshotAfter = await snapshotInstallablePaths(canonicalRoot);
  const windowsSnapshotAfter = await assertExactBootstrapTree(canonicalRoot);
  const beforePaths = [
    ...runtimeSnapshotBefore.map((entry) => entry.relative),
    ...windowsSnapshotBefore.allFiles.map((entry) => entry.relative),
  ];
  const afterPaths = [
    ...runtimeSnapshotAfter.map((entry) => entry.relative),
    ...windowsSnapshotAfter.allFiles.map((entry) => entry.relative),
  ];
  if (
    beforePaths.length !== afterPaths.length ||
    beforePaths.some((entry, index) => entry !== afterPaths[index])
  ) {
    throw new Error("file-set-race");
  }
  await assertExactReviewedHead(
    gitPath,
    canonicalRoot,
    commit,
    upstreamBase,
  );
  await assertGitExecutable(
    gitPath,
    gitSnapshot,
    expectedGitSha256,
  );

  const manifest = {
    commit,
    nodeSha256: await assertNodeExecutable(nodePath),
    installerSha256: installerFile.sha256,
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
    "--git",
    "--expected-git-sha256",
    "--upstream-base",
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
    gitPath: values.get("--git"),
    expectedGitSha256: values.get("--expected-git-sha256"),
    upstreamBase: values.get("--upstream-base"),
    outputPath: path.resolve(values.get("--output")),
    sha256Path: path.resolve(values.get("--sha256-output")),
  };
}

async function unlinkIfSameFile(absolutePath, expectedIdentity) {
  try {
    const current = await lstat(absolutePath, { bigint: true });
    if (
      !expectedIdentity ||
      !sameSecurityFileSnapshot(current, expectedIdentity)
    ) {
      throw new Error("published-file-identity-changed");
    }
    await unlink(absolutePath);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
}

async function unlinkIfPresent(absolutePath) {
  try {
    await unlink(absolutePath);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
}

async function publishManifestPair({
  outputPath,
  sha256Path,
  manifestBytes,
  manifestSha256,
}) {
  if (
    path.resolve(outputPath).toLowerCase() ===
    path.resolve(sha256Path).toLowerCase()
  ) {
    throw new Error("output-path-collision");
  }

  await mkdir(path.dirname(outputPath), { recursive: true });
  await mkdir(path.dirname(sha256Path), { recursive: true });
  const nonce = randomBytes(16).toString("hex");
  const outputStage = path.join(
    path.dirname(outputPath),
    `.${path.basename(outputPath)}.${nonce}.tmp`,
  );
  const sha256Stage = path.join(
    path.dirname(sha256Path),
    `.${path.basename(sha256Path)}.${nonce}.tmp`,
  );
  let outputPublished = false;
  let sha256Published = false;
  let outputIdentity;
  let sha256Identity;

  try {
    await writeFile(outputStage, manifestBytes, { flag: "wx" });
    await writeFile(sha256Stage, manifestSha256, {
      encoding: "ascii",
      flag: "wx",
    });
    await link(outputStage, outputPath);
    outputPublished = true;
    outputIdentity = await lstat(outputPath, { bigint: true });
    await link(sha256Stage, sha256Path);
    sha256Published = true;
    sha256Identity = await lstat(sha256Path, { bigint: true });
  } catch (error) {
    if (sha256Published) {
      await unlinkIfSameFile(sha256Path, sha256Identity);
    }
    if (outputPublished) {
      await unlinkIfSameFile(outputPath, outputIdentity);
    }
    throw error;
  } finally {
    await unlinkIfPresent(outputStage);
    await unlinkIfPresent(sha256Stage);
  }
}

async function main() {
  try {
    const parsed = parseArguments(process.argv.slice(2));
    const generated = await createRuntimeManifest({
      root: parsed.root,
      commit: parsed.commit,
      nodePath: parsed.nodePath,
      gitPath: parsed.gitPath,
      expectedGitSha256: parsed.expectedGitSha256,
      upstreamBase: parsed.upstreamBase,
    });
    await publishManifestPair({
      outputPath: parsed.outputPath,
      sha256Path: parsed.sha256Path,
      manifestBytes: generated.bytes,
      manifestSha256: generated.sha256,
    });
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        runtimeFiles: generated.manifest.runtimeFiles.length,
        bootstrapFiles: generated.manifest.bootstrapFiles.length,
        manifestSha256: generated.sha256,
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
