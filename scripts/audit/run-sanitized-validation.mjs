import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ALLOWED_RUNTIME_VARIABLES = [
  ["SystemRoot", "systemroot"],
  ["WINDIR", "windir"],
  ["ComSpec", "comspec"],
  ["PATHEXT", "pathext"],
  ["PATH", "path"],
  ["TEMP", "temp"],
  ["TMP", "tmp"],
  ["LOCALAPPDATA", "localappdata"],
  ["APPDATA", "appdata"],
  ["USERPROFILE", "userprofile"],
  ["HOMEDRIVE", "homedrive"],
  ["HOMEPATH", "homepath"],
  ["NUMBER_OF_PROCESSORS", "number_of_processors"],
  ["PROCESSOR_ARCHITECTURE", "processor_architecture"],
  ["PROCESSOR_IDENTIFIER", "processor_identifier"],
  ["OS", "os"],
];

const FIXED_VARIABLES = {
  NEXT_TELEMETRY_DISABLED: "1",
  NODE_ENV: "production",
  NPM_CONFIG_AUDIT: "false",
  NPM_CONFIG_FUND: "false",
};

function caseInsensitiveEntries(source) {
  const entries = new Map();
  for (const [name, value] of Object.entries(source ?? {})) {
    if (typeof value === "string") {
      const folded = name.toLowerCase();
      if (entries.has(folded) && entries.get(folded) !== value) {
        throw new Error("ambiguous-environment");
      }
      entries.set(folded, value);
    }
  }
  return entries;
}

export function createSanitizedBuildEnvironment(source = process.env) {
  const sourceEntries = caseInsensitiveEntries(source);
  const result = {};
  for (const [canonicalName, lookupName] of ALLOWED_RUNTIME_VARIABLES) {
    if (
      process.platform === "win32" &&
      (lookupName === "comspec" || lookupName === "path")
    ) {
      continue;
    }
    const value = sourceEntries.get(lookupName);
    if (value !== undefined) {
      result[canonicalName] = value;
    }
  }
  return { ...result, ...FIXED_VARIABLES };
}

function samePath(left, right) {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

function assertOrdinaryPath(candidate, expectedType, errorCode) {
  try {
    if (
      typeof candidate !== "string" ||
      !path.isAbsolute(candidate) ||
      /[\u0000-\u001f\u007f"]/u.test(candidate)
    ) {
      throw new Error(errorCode);
    }
    const resolved = path.resolve(candidate);
    const info = lstatSync(resolved);
    const hasExpectedType =
      expectedType === "directory" ? info.isDirectory() : info.isFile();
    if (
      !hasExpectedType ||
      info.isSymbolicLink()
    ) {
      throw new Error(errorCode);
    }
    const canonical = realpathSync(resolved);
    if (!samePath(canonical, resolved)) {
      throw new Error(errorCode);
    }
    return canonical;
  } catch (error) {
    if (error instanceof Error && error.message === errorCode) {
      throw error;
    }
    throw new Error(errorCode);
  }
}

function normalizeExpectedNpmCliSha256(value) {
  if (typeof value !== "string" || !/^[a-fA-F0-9]{64}$/u.test(value)) {
    throw new Error("invalid-npm-cli-integrity");
  }
  return value.toLowerCase();
}

function sameStableFileState(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function assertExpectedNpmCli(npmCliPath, expectedNpmCliSha256) {
  const expected = normalizeExpectedNpmCliSha256(
    expectedNpmCliSha256,
  );
  try {
    const exactPath = assertOrdinaryPath(
      npmCliPath,
      "file",
      "invalid-npm-cli-integrity",
    );
    const before = lstatSync(exactPath, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink()) {
      throw new Error("invalid-npm-cli-integrity");
    }
    const bytes = readFileSync(exactPath);
    let observed;
    try {
      observed = createHash("sha256").update(bytes).digest("hex");
    } finally {
      bytes.fill(0);
    }
    const after = lstatSync(exactPath, { bigint: true });
    if (
      !after.isFile() ||
      after.isSymbolicLink() ||
      !sameStableFileState(before, after) ||
      !samePath(realpathSync(exactPath), exactPath) ||
      observed !== expected
    ) {
      throw new Error("invalid-npm-cli-integrity");
    }
    return exactPath;
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "invalid-npm-cli-integrity"
    ) {
      throw error;
    }
    throw new Error("invalid-npm-cli-integrity");
  }
}

function normalizeExpectedNpmTreeSha256(value) {
  if (typeof value !== "string" || !/^[a-fA-F0-9]{64}$/u.test(value)) {
    throw new Error("invalid-npm-tree-integrity");
  }
  return value.toLowerCase();
}

function assertSafeNpmTreeName(name) {
  if (
    typeof name !== "string" ||
    name.length === 0 ||
    name.normalize("NFC") !== name ||
    /[\u0000-\u001f\u007f/\\:]/u.test(name) ||
    name.endsWith(" ") ||
    name.endsWith(".")
  ) {
    throw new Error("invalid-npm-tree-integrity");
  }
}

function hashStableNpmTreeFile(filePath, relativePath) {
  const exactPath = assertOrdinaryPath(
    filePath,
    "file",
    "invalid-npm-tree-integrity",
  );
  const before = lstatSync(exactPath, { bigint: true });
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1n ||
    before.size > 268_435_456n
  ) {
    throw new Error("invalid-npm-tree-integrity");
  }
  const bytes = readFileSync(exactPath);
  let sha256;
  try {
    sha256 = createHash("sha256").update(bytes).digest("hex");
  } finally {
    bytes.fill(0);
  }
  const after = lstatSync(exactPath, { bigint: true });
  if (
    !after.isFile() ||
    after.isSymbolicLink() ||
    after.nlink !== 1n ||
    !sameStableFileState(before, after) ||
    !samePath(realpathSync(exactPath), exactPath)
  ) {
    throw new Error("invalid-npm-tree-integrity");
  }
  return {
    type: "F",
    relativePath,
    size: Number(before.size),
    sha256,
  };
}

function createNpmTreeSnapshot(npmPath) {
  try {
    const exactNpmPath = assertOrdinaryPath(
      npmPath,
      "file",
      "invalid-npm-tree-integrity",
    );
    const npmDirectory = assertOrdinaryPath(
      path.dirname(exactNpmPath),
      "directory",
      "invalid-npm-tree-integrity",
    );
    const nodeModules = assertOrdinaryPath(
      path.join(npmDirectory, "node_modules"),
      "directory",
      "invalid-npm-tree-integrity",
    );
    const npmRoot = assertOrdinaryPath(
      path.join(nodeModules, "npm"),
      "directory",
      "invalid-npm-tree-integrity",
    );
    const records = [
      { type: "D", relativePath: "node_modules" },
      { type: "D", relativePath: "node_modules/npm" },
      hashStableNpmTreeFile(exactNpmPath, "npm.cmd"),
    ];
    const seen = new Set(records.map((record) =>
      record.relativePath.toLowerCase(),
    ));
    let totalBytes = BigInt(records[2].size);

    const visit = (directory, relativeDirectory) => {
      const exactDirectory = assertOrdinaryPath(
        directory,
        "directory",
        "invalid-npm-tree-integrity",
      );
      const beforeDirectory = lstatSync(exactDirectory, {
        bigint: true,
      });
      const namesBefore = readdirSync(exactDirectory).sort();
      const localNames = new Set();
      for (const name of namesBefore) {
        assertSafeNpmTreeName(name);
        const foldedName = name.toLowerCase();
        if (localNames.has(foldedName)) {
          throw new Error("invalid-npm-tree-integrity");
        }
        localNames.add(foldedName);
        const absolutePath = path.join(exactDirectory, name);
        const relativePath = `${relativeDirectory}/${name}`;
        const foldedPath = relativePath.toLowerCase();
        if (seen.has(foldedPath) || records.length >= 100_000) {
          throw new Error("invalid-npm-tree-integrity");
        }
        seen.add(foldedPath);
        const info = lstatSync(absolutePath, { bigint: true });
        if (info.isSymbolicLink()) {
          throw new Error("invalid-npm-tree-integrity");
        }
        if (info.isDirectory()) {
          assertOrdinaryPath(
            absolutePath,
            "directory",
            "invalid-npm-tree-integrity",
          );
          records.push({ type: "D", relativePath });
          visit(absolutePath, relativePath);
        } else if (info.isFile()) {
          const record = hashStableNpmTreeFile(
            absolutePath,
            relativePath,
          );
          totalBytes += BigInt(record.size);
          if (totalBytes > 1_073_741_824n) {
            throw new Error("invalid-npm-tree-integrity");
          }
          records.push(record);
        } else {
          throw new Error("invalid-npm-tree-integrity");
        }
      }
      const namesAfter = readdirSync(exactDirectory).sort();
      const afterDirectory = lstatSync(exactDirectory, {
        bigint: true,
      });
      if (
        namesAfter.length !== namesBefore.length ||
        namesAfter.some((name, index) => name !== namesBefore[index]) ||
        !sameStableFileState(beforeDirectory, afterDirectory) ||
        !samePath(realpathSync(exactDirectory), exactDirectory)
      ) {
        throw new Error("invalid-npm-tree-integrity");
      }
    };
    visit(npmRoot, "node_modules/npm");

    records.sort((left, right) =>
      left.relativePath < right.relativePath
        ? -1
        : left.relativePath > right.relativePath
          ? 1
          : 0,
    );
    const aggregate = createHash("sha256");
    aggregate.update("HMA-NPM-TREE-V1\0", "utf8");
    for (const record of records) {
      aggregate.update(
        `${record.type}\0${record.relativePath}\0`,
        "utf8",
      );
      if (record.type === "F") {
        aggregate.update(
          `${record.size}\0${record.sha256}\0`,
          "utf8",
        );
      }
    }
    return {
      npmRoot,
      paths: records.map((record) =>
        `${record.type}:${record.relativePath}`,
      ),
      sha256: aggregate.digest("hex"),
    };
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "invalid-npm-tree-integrity"
    ) {
      throw error;
    }
    throw new Error("invalid-npm-tree-integrity");
  }
}

export function computeNpmTreeSha256(npmPath) {
  return createNpmTreeSnapshot(npmPath).sha256;
}

function inventoryInstallScripts(lockPath, expectedLockfileSha256) {
  try {
    const expected = normalizeExpectedNpmTreeSha256(
      expectedLockfileSha256,
    );
    const exactPath = assertOrdinaryPath(
      lockPath,
      "file",
      "invalid-lockfile-inventory",
    );
    if (path.basename(exactPath) !== "package-lock.json") {
      throw new Error("invalid-lockfile-inventory");
    }
    const before = lstatSync(exactPath, { bigint: true });
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1n ||
      before.size <= 0n ||
      before.size > 33_554_432n
    ) {
      throw new Error("invalid-lockfile-inventory");
    }
    const bytes = readFileSync(exactPath);
    let lock;
    let observed;
    try {
      observed = createHash("sha256").update(bytes).digest("hex");
      lock = JSON.parse(bytes.toString("utf8"));
    } finally {
      bytes.fill(0);
    }
    const after = lstatSync(exactPath, { bigint: true });
    if (
      !sameStableFileState(before, after) ||
      !samePath(realpathSync(exactPath), exactPath) ||
      observed !== expected ||
      !lock ||
      typeof lock !== "object" ||
      Array.isArray(lock) ||
      !lock.packages ||
      typeof lock.packages !== "object" ||
      Array.isArray(lock.packages)
    ) {
      throw new Error("invalid-lockfile-inventory");
    }

    const installScripts = [];
    for (const [packagePath, metadata] of Object.entries(lock.packages)) {
      if (
        !metadata ||
        typeof metadata !== "object" ||
        Array.isArray(metadata) ||
        metadata.hasInstallScript !== true
      ) {
        continue;
      }
      const name =
        typeof metadata.name === "string" && metadata.name.length > 0
          ? metadata.name
          : packagePath;
      const version = metadata.version;
      for (const value of [packagePath, name, version]) {
        if (
          typeof value !== "string" ||
          value.length === 0 ||
          value.length > 1024 ||
          /[\u0000-\u001f\u007f]/u.test(value)
        ) {
          throw new Error("invalid-lockfile-inventory");
        }
      }
      installScripts.push({
        path: packagePath,
        name,
        version,
      });
    }
    installScripts.sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    );
    return installScripts;
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "invalid-lockfile-inventory"
    ) {
      throw error;
    }
    throw new Error("invalid-lockfile-inventory");
  }
}

function assertExactProjectMetadataFile({
  projectRoot,
  filePath,
  expectedLeafName,
  expectedSha256,
}) {
  const errorCode = "invalid-project-metadata-integrity";
  try {
    if (
      typeof expectedSha256 !== "string" ||
      !/^[a-fA-F0-9]{64}$/u.test(expectedSha256)
    ) {
      throw new Error(errorCode);
    }
    const root = assertOrdinaryPath(
      projectRoot,
      "directory",
      errorCode,
    );
    const exactPath = assertOrdinaryPath(
      filePath,
      "file",
      errorCode,
    );
    if (
      path.basename(exactPath) !== expectedLeafName ||
      !samePath(path.dirname(exactPath), root)
    ) {
      throw new Error(errorCode);
    }
    const before = lstatSync(exactPath, { bigint: true });
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1n ||
      before.size <= 0n ||
      before.size > 33_554_432n
    ) {
      throw new Error(errorCode);
    }
    const bytes = readFileSync(exactPath);
    let observed;
    try {
      observed = createHash("sha256").update(bytes).digest("hex");
    } finally {
      bytes.fill(0);
    }
    const after = lstatSync(exactPath, { bigint: true });
    if (
      !sameStableFileState(before, after) ||
      !samePath(realpathSync(exactPath), exactPath) ||
      observed !== expectedSha256.toLowerCase()
    ) {
      throw new Error(errorCode);
    }
    return exactPath;
  } catch (error) {
    if (error instanceof Error && error.message === errorCode) {
      throw error;
    }
    throw new Error(errorCode);
  }
}

function assertPinnedProjectMetadata({
  projectRoot,
  packageJsonPath,
  expectedPackageJsonSha256,
  packageLockPath,
  expectedLockfileSha256,
  requireLockfile,
}) {
  assertExactProjectMetadataFile({
    projectRoot,
    filePath: packageJsonPath,
    expectedLeafName: "package.json",
    expectedSha256: expectedPackageJsonSha256,
  });
  if (requireLockfile) {
    assertExactProjectMetadataFile({
      projectRoot,
      filePath: packageLockPath,
      expectedLeafName: "package-lock.json",
      expectedSha256: expectedLockfileSha256,
    });
  }
}

function assertExpectedNpmTree(npmPath, expectedNpmTreeSha256) {
  const expected = normalizeExpectedNpmTreeSha256(
    expectedNpmTreeSha256,
  );
  const snapshot = createNpmTreeSnapshot(npmPath);
  if (snapshot.sha256 !== expected) {
    throw new Error("invalid-npm-tree-integrity");
  }
  return snapshot;
}

function createTrustedWindowsCommandEnvironment(npmPath, env) {
  const entries = caseInsensitiveEntries(env);
  const systemRootValue = entries.get("systemroot");
  const windirValue = entries.get("windir");
  if (
    systemRootValue === undefined ||
    windirValue === undefined ||
    !samePath(systemRootValue, windirValue)
  ) {
    throw new Error("invalid-windows-command-environment");
  }

  const systemRoot = assertOrdinaryPath(
    systemRootValue,
    "directory",
    "invalid-windows-command-environment",
  );
  const windir = assertOrdinaryPath(
    windirValue,
    "directory",
    "invalid-windows-command-environment",
  );
  if (!samePath(systemRoot, windir)) {
    throw new Error("invalid-windows-command-environment");
  }

  const system32 = assertOrdinaryPath(
    path.join(systemRoot, "System32"),
    "directory",
    "invalid-windows-command-environment",
  );
  const powershellDirectory = assertOrdinaryPath(
    path.join(system32, "WindowsPowerShell", "v1.0"),
    "directory",
    "invalid-windows-command-environment",
  );
  const commandShell = assertOrdinaryPath(
    path.join(system32, "cmd.exe"),
    "file",
    "invalid-windows-command-environment",
  );
  assertOrdinaryPath(
    path.join(powershellDirectory, "powershell.exe"),
    "file",
    "invalid-windows-command-environment",
  );

  const npmDirectory = assertOrdinaryPath(
    path.dirname(npmPath),
    "directory",
    "invalid-npm-installation",
  );
  const exactNpmPath = assertOrdinaryPath(
    npmPath,
    "file",
    "invalid-npm-installation",
  );
  const nodePath = assertOrdinaryPath(
    path.join(npmDirectory, "node.exe"),
    "file",
    "invalid-npm-installation",
  );
  const npmCliPath = assertOrdinaryPath(
    path.join(
      npmDirectory,
      "node_modules",
      "npm",
      "bin",
      "npm-cli.js",
    ),
    "file",
    "invalid-npm-installation",
  );
  if (
    !samePath(exactNpmPath, npmPath) ||
    !samePath(nodePath, process.execPath)
  ) {
    throw new Error("invalid-npm-installation");
  }

  return {
    env: {
      ...env,
      SystemRoot: systemRoot,
      WINDIR: systemRoot,
      ComSpec: commandShell,
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      PATH: [
        npmDirectory,
        system32,
        systemRoot,
        powershellDirectory,
      ].join(path.delimiter),
    },
    nodePath,
    npmCliPath,
  };
}

export function assertSafeProjectConfiguration(projectRoot) {
  const root = path.resolve(projectRoot);
  const rootInfo = lstatSync(root);
  if (
    !rootInfo.isDirectory() ||
    rootInfo.isSymbolicLink() ||
    !samePath(realpathSync(root), root)
  ) {
    throw new Error("forbidden-project-configuration");
  }
  const folded = new Set();
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const normalized = entry.name.normalize("NFC");
    if (/[\u0000-\u001f\u007f]/u.test(normalized)) {
      throw new Error("forbidden-project-configuration");
    }
    const lower = normalized.toLowerCase();
    if (folded.has(lower)) {
      throw new Error("forbidden-project-configuration");
    }
    folded.add(lower);
    if (
      lower === ".npmrc" ||
      ((lower === ".env" || lower.startsWith(".env.")) &&
        lower !== ".env.example")
    ) {
      throw new Error("forbidden-project-configuration");
    }
    if (lower === ".env.example") {
      const examplePath = path.join(root, entry.name);
      const info = lstatSync(examplePath);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        !samePath(realpathSync(examplePath), examplePath)
      ) {
        throw new Error("forbidden-project-configuration");
      }
    }
  }
}

export function createIsolatedNpmEnvironment(
  sourceEnvironment = process.env,
  { offline = true } = {},
) {
  const root = mkdtempSync(path.join(os.tmpdir(), "hma-npm-isolation-"));
  try {
    chmodSync(root, 0o700);
    const appData = path.join(root, "appdata");
    const localAppData = path.join(root, "localappdata");
    const cache = path.join(root, "cache");
    const temporary =
      process.platform === "win32"
        ? path.join(localAppData, "Temp")
        : path.join(root, "temp");
    for (const directory of [appData, localAppData, cache, temporary]) {
      mkdirSync(directory, { recursive: false });
    }
    const userConfig = path.join(root, "user.npmrc");
    const globalConfig = path.join(root, "global.npmrc");
    writeFileSync(userConfig, "", { encoding: "utf8", flag: "wx", mode: 0o600 });
    writeFileSync(globalConfig, "", {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    const env = {
      ...createSanitizedBuildEnvironment(sourceEnvironment),
      APPDATA: appData,
      HOME: root,
      LOCALAPPDATA: localAppData,
      TEMP: temporary,
      TMP: temporary,
      USERPROFILE: root,
      NPM_CONFIG_AUDIT: "false",
      NPM_CONFIG_CACHE: cache,
      NPM_CONFIG_COLOR: "false",
      NPM_CONFIG_FUND: "false",
      NPM_CONFIG_GLOBALCONFIG: globalConfig,
      NPM_CONFIG_IGNORE_SCRIPTS: "true",
      NPM_CONFIG_LOGLEVEL: "error",
      NPM_CONFIG_OFFLINE: String(offline),
      NPM_CONFIG_UPDATE_NOTIFIER: "false",
      NPM_CONFIG_USERCONFIG: userConfig,
    };
    return {
      env,
      root,
      expected: { userConfig, globalConfig, cache, offline },
      cleanup: () => {
        rmSync(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function parseArguments(argv) {
  const measureOnly =
    argv.length === 2 && argv[0] === "--measure-npm-tree";
  const inventoryOnly =
    argv.length === 4 &&
    argv[0] === "--inventory-install-scripts" &&
    argv[2] === "--expected-lockfile-sha256";
  const pinnedOperation =
    argv.length === 16 &&
    argv[0] === "--run-pinned-npm" &&
    ["ci", "ls", "audit", "sbom"].includes(argv[1]) &&
    argv[2] === "--npm" &&
    argv[4] === "--expected-npm-cli-sha256" &&
    argv[6] === "--expected-npm-tree-sha256" &&
    argv[8] === "--package-json" &&
    argv[10] === "--expected-package-json-sha256" &&
    argv[12] === "--package-lock" &&
    argv[14] === "--expected-lockfile-sha256";
  if (
    !measureOnly &&
    !inventoryOnly &&
    !pinnedOperation &&
    (
      argv.length !== 10 ||
      argv[0] !== "--npm" ||
      argv[2] !== "--expected-npm-cli-sha256" ||
      argv[4] !== "--expected-npm-tree-sha256" ||
      argv[6] !== "--package-json" ||
      argv[8] !== "--expected-package-json-sha256"
    )
  ) {
    throw new Error("invalid-arguments");
  }
  if (inventoryOnly) {
    const lockPath = path.resolve(argv[1]);
    if (
      !path.isAbsolute(argv[1]) ||
      path.basename(lockPath) !== "package-lock.json" ||
      /["\r\n&|<>^%]/u.test(lockPath)
    ) {
      throw new Error("invalid-lockfile-path");
    }
    return {
      mode: "inventory",
      lockPath,
      expectedLockfileSha256: normalizeExpectedNpmTreeSha256(argv[3]),
    };
  }
  const npmPathArgument = pinnedOperation ? argv[3] : argv[1];
  const npmPath = path.resolve(npmPathArgument);
  if (
    !path.isAbsolute(npmPathArgument) ||
    !npmPath.toLowerCase().endsWith(`${path.sep}npm.cmd`) ||
    /["\r\n&|<>^%]/u.test(npmPath)
  ) {
    throw new Error("invalid-npm-path");
  }
  if (pinnedOperation) {
    const packageJsonPath = path.resolve(argv[9]);
    const packageLockPath = path.resolve(argv[13]);
    if (
      !path.isAbsolute(argv[9]) ||
      path.basename(packageJsonPath) !== "package.json" ||
      /["\r\n&|<>^%]/u.test(packageJsonPath) ||
      !path.isAbsolute(argv[13]) ||
      path.basename(packageLockPath) !== "package-lock.json" ||
      /["\r\n&|<>^%]/u.test(packageLockPath)
    ) {
      throw new Error("invalid-project-metadata-path");
    }
    return {
      mode: "pinned-operation",
      operation: argv[1],
      npmPath,
      expectedNpmCliSha256: normalizeExpectedNpmCliSha256(argv[5]),
      expectedNpmTreeSha256: normalizeExpectedNpmTreeSha256(argv[7]),
      packageJsonPath,
      expectedPackageJsonSha256: normalizeExpectedNpmTreeSha256(
        argv[11],
      ),
      packageLockPath,
      expectedLockfileSha256: normalizeExpectedNpmTreeSha256(argv[15]),
    };
  }
  if (measureOnly) {
    return {
      mode: "measure",
      npmPath,
    };
  }
  const packageJsonPath = path.resolve(argv[7]);
  if (
    !path.isAbsolute(argv[7]) ||
    path.basename(packageJsonPath) !== "package.json" ||
    /["\r\n&|<>^%]/u.test(packageJsonPath)
  ) {
    throw new Error("invalid-project-metadata-path");
  }
  return {
    mode: "validate",
    npmPath,
    expectedNpmCliSha256: normalizeExpectedNpmCliSha256(argv[3]),
    expectedNpmTreeSha256: normalizeExpectedNpmTreeSha256(argv[5]),
    packageJsonPath,
    expectedPackageJsonSha256: normalizeExpectedNpmTreeSha256(argv[9]),
  };
}

function runNpmCommand(
  npmPath,
  args,
  env,
  projectRoot,
  expectedNpmCliSha256,
  expectedNpmTreeSha256,
  { capture = false } = {},
) {
  let result;
  const stdio = capture ? ["ignore", "pipe", "pipe"] : "inherit";
  if (process.platform === "win32") {
    const trusted = createTrustedWindowsCommandEnvironment(
      npmPath,
      env,
    );
    const npmCliPath = assertExpectedNpmCli(
      trusted.npmCliPath,
      expectedNpmCliSha256,
    );
    const npmTreeBefore = assertExpectedNpmTree(
      npmPath,
      expectedNpmTreeSha256,
    );
    try {
      result = spawnSync(
        trusted.nodePath,
        [npmCliPath, ...args],
        {
          cwd: projectRoot,
          env: trusted.env,
          stdio,
          encoding: capture ? "utf8" : undefined,
          maxBuffer: capture ? 1024 * 1024 : undefined,
          windowsHide: true,
          shell: false,
        },
      );
    } finally {
      assertExpectedNpmCli(npmCliPath, expectedNpmCliSha256);
      const npmTreeAfter = assertExpectedNpmTree(
        npmPath,
        expectedNpmTreeSha256,
      );
      if (
        npmTreeAfter.paths.length !== npmTreeBefore.paths.length ||
        npmTreeAfter.paths.some(
          (entry, index) => entry !== npmTreeBefore.paths[index],
        )
      ) {
        throw new Error("invalid-npm-tree-integrity");
      }
    }
  } else {
    result = spawnSync(npmPath, args, {
      cwd: projectRoot,
      env,
      stdio,
      encoding: capture ? "utf8" : undefined,
      maxBuffer: capture ? 1024 * 1024 : undefined,
      shell: false,
    });
  }

  if (result.error || result.signal || result.status !== 0) {
    throw new Error("validation-command-failed");
  }
  return result;
}

function exactConfigPath(actual, expected) {
  return (
    typeof actual === "string" &&
    samePath(actual, expected)
  );
}

export function verifyNpmConfiguration(
  npmPath,
  env,
  expected,
  projectRoot,
  expectedNpmCliSha256,
  expectedNpmTreeSha256,
) {
  const result = runNpmCommand(
    npmPath,
    ["config", "list", "--json"],
    env,
    projectRoot,
    expectedNpmCliSha256,
    expectedNpmTreeSha256,
    { capture: true },
  );
  let config;
  try {
    config = JSON.parse(result.stdout);
  } catch {
    throw new Error("unsafe-npm-configuration");
  }
  if (
    !config ||
    typeof config !== "object" ||
    Array.isArray(config) ||
    !exactConfigPath(config.userconfig, expected.userConfig) ||
    !exactConfigPath(config.globalconfig, expected.globalConfig) ||
    !exactConfigPath(config.cache, expected.cache) ||
    config.audit !== false ||
    config.fund !== false ||
    config["ignore-scripts"] !== true ||
    config.offline !== expected.offline ||
    config["strict-ssl"] !== true
  ) {
    throw new Error("unsafe-npm-configuration");
  }
  for (const key of [
    "node-options",
    "script-shell",
    "proxy",
    "https-proxy",
    "cafile",
    "cert",
    "key",
    "_auth",
    "_authToken",
    "username",
    "_password",
  ]) {
    const value = config[key];
    if (value !== null && value !== undefined && value !== "") {
      throw new Error("unsafe-npm-configuration");
    }
  }
  if (
    Object.entries(config).some(
      ([key, value]) =>
        key.startsWith("//") &&
        value !== null &&
        value !== undefined &&
        value !== "",
    )
  ) {
    throw new Error("unsafe-npm-configuration");
  }
}

function runPinnedNpmOperation({
  operation,
  npmPath,
  expectedNpmCliSha256,
  expectedNpmTreeSha256,
  packageJsonPath,
  expectedPackageJsonSha256,
  packageLockPath,
  expectedLockfileSha256,
  sourceEnvironment = process.env,
  projectRoot = process.cwd(),
}) {
  if (!["ci", "ls", "audit", "sbom"].includes(operation)) {
    throw new Error("invalid-pinned-npm-operation");
  }
  const root = path.resolve(projectRoot);
  const expectedNpmCliHash = normalizeExpectedNpmCliSha256(
    expectedNpmCliSha256,
  );
  const expectedNpmTreeHash = normalizeExpectedNpmTreeSha256(
    expectedNpmTreeSha256,
  );
  const isolated = createIsolatedNpmEnvironment(
    sourceEnvironment,
    { offline: false },
  );
  const argumentsByOperation = {
    ci: ["ci", "--ignore-scripts", "--audit=false", "--fund=false"],
    ls: ["ls", "--all"],
    audit: ["audit", "--json"],
    sbom: ["sbom", "--sbom-format", "cyclonedx"],
  };
  try {
    assertPinnedProjectMetadata({
      projectRoot: root,
      packageJsonPath,
      expectedPackageJsonSha256,
      packageLockPath,
      expectedLockfileSha256,
      requireLockfile: true,
    });
    assertSafeProjectConfiguration(root);
    verifyNpmConfiguration(
      npmPath,
      isolated.env,
      isolated.expected,
      root,
      expectedNpmCliHash,
      expectedNpmTreeHash,
    );
    const result = runNpmCommand(
      npmPath,
      argumentsByOperation[operation],
      isolated.env,
      root,
      expectedNpmCliHash,
      expectedNpmTreeHash,
      { capture: true },
    );
    assertPinnedProjectMetadata({
      projectRoot: root,
      packageJsonPath,
      expectedPackageJsonSha256,
      packageLockPath,
      expectedLockfileSha256,
      requireLockfile: true,
    });
    assertSafeProjectConfiguration(root);
    verifyNpmConfiguration(
      npmPath,
      isolated.env,
      isolated.expected,
      root,
      expectedNpmCliHash,
      expectedNpmTreeHash,
    );
    return result.stdout;
  } finally {
    isolated.cleanup();
  }
}

export function runSanitizedValidation({
  npmPath,
  expectedNpmCliSha256,
  expectedNpmTreeSha256,
  packageJsonPath = path.resolve("package.json"),
  expectedPackageJsonSha256,
  sourceEnvironment = process.env,
  projectRoot = process.cwd(),
} = {}) {
  const root = path.resolve(projectRoot);
  const expectedNpmCliHash = normalizeExpectedNpmCliSha256(
    expectedNpmCliSha256,
  );
  const expectedNpmTreeHash = normalizeExpectedNpmTreeSha256(
    expectedNpmTreeSha256,
  );
  const isolated = createIsolatedNpmEnvironment(sourceEnvironment);
  try {
    for (const args of [["test"], ["run", "typecheck"], ["run", "build"]]) {
      assertPinnedProjectMetadata({
        projectRoot: root,
        packageJsonPath,
        expectedPackageJsonSha256,
        requireLockfile: false,
      });
      assertSafeProjectConfiguration(root);
      verifyNpmConfiguration(
        npmPath,
        isolated.env,
        isolated.expected,
        root,
        expectedNpmCliHash,
        expectedNpmTreeHash,
      );
      runNpmCommand(
        npmPath,
        args,
        isolated.env,
        root,
        expectedNpmCliHash,
        expectedNpmTreeHash,
      );
      assertPinnedProjectMetadata({
        projectRoot: root,
        packageJsonPath,
        expectedPackageJsonSha256,
        requireLockfile: false,
      });
      assertSafeProjectConfiguration(root);
      verifyNpmConfiguration(
        npmPath,
        isolated.env,
        isolated.expected,
        root,
        expectedNpmCliHash,
        expectedNpmTreeHash,
      );
    }
  } finally {
    isolated.cleanup();
  }
}

async function main() {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.mode === "pinned-operation") {
      process.stdout.write(
        `${JSON.stringify({
          ok: true,
          operation: options.operation,
          output: runPinnedNpmOperation(options),
        })}\n`,
      );
      return;
    }
    if (options.mode === "inventory") {
      process.stdout.write(
        `${JSON.stringify({
          ok: true,
          installScripts: inventoryInstallScripts(
            options.lockPath,
            options.expectedLockfileSha256,
          ),
        })}\n`,
      );
      return;
    }
    if (options.mode === "measure") {
      process.stdout.write(
        `${JSON.stringify({
          ok: true,
          npmTreeSha256: computeNpmTreeSha256(options.npmPath),
        })}\n`,
      );
      return;
    }
    runSanitizedValidation({
      npmPath: options.npmPath,
      expectedNpmCliSha256: options.expectedNpmCliSha256,
      expectedNpmTreeSha256: options.expectedNpmTreeSha256,
      packageJsonPath: options.packageJsonPath,
      expectedPackageJsonSha256: options.expectedPackageJsonSha256,
    });
    process.stdout.write('{"ok":true,"commandsPassed":3}\n');
  } catch {
    process.stderr.write('{"ok":false,"error":"sanitized-validation-failed"}\n');
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  await main();
}
