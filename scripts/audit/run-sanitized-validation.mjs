import { spawnSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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
) {
  const root = mkdtempSync(path.join(os.tmpdir(), "hma-npm-isolation-"));
  try {
    chmodSync(root, 0o700);
    const appData = path.join(root, "appdata");
    const localAppData = path.join(root, "localappdata");
    const cache = path.join(root, "cache");
    const temporary = path.join(root, "temp");
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
      NPM_CONFIG_OFFLINE: "true",
      NPM_CONFIG_UPDATE_NOTIFIER: "false",
      NPM_CONFIG_USERCONFIG: userConfig,
    };
    return {
      env,
      root,
      expected: { userConfig, globalConfig, cache },
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
  if (argv.length !== 2 || argv[0] !== "--npm") {
    throw new Error("invalid-arguments");
  }
  const npmPath = path.resolve(argv[1]);
  if (
    !path.isAbsolute(argv[1]) ||
    !npmPath.toLowerCase().endsWith(`${path.sep}npm.cmd`) ||
    /["\r\n&|<>^%]/u.test(npmPath)
  ) {
    throw new Error("invalid-npm-path");
  }
  return npmPath;
}

function runNpmCommand(
  npmPath,
  args,
  env,
  projectRoot,
  { capture = false } = {},
) {
  let result;
  const stdio = capture ? ["ignore", "pipe", "pipe"] : "inherit";
  if (process.platform === "win32") {
    const npmDirectory = path.dirname(npmPath);
    const nodePath = path.join(npmDirectory, "node.exe");
    const npmCliPath = path.join(
      npmDirectory,
      "node_modules",
      "npm",
      "bin",
      "npm-cli.js",
    );
    for (const candidate of [npmPath, nodePath, npmCliPath]) {
      const info = lstatSync(candidate);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        !samePath(realpathSync(candidate), candidate)
      ) {
        throw new Error("invalid-npm-installation");
      }
    }
    if (!samePath(nodePath, process.execPath)) {
      throw new Error("invalid-npm-installation");
    }
    result = spawnSync(
      nodePath,
      [npmCliPath, ...args],
      {
        cwd: projectRoot,
        env,
        stdio,
        encoding: capture ? "utf8" : undefined,
        maxBuffer: capture ? 1024 * 1024 : undefined,
        windowsHide: true,
        shell: false,
      },
    );
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
) {
  const result = runNpmCommand(
    npmPath,
    ["config", "list", "--json"],
    env,
    projectRoot,
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
    config.offline !== true ||
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

export function runSanitizedValidation({
  npmPath,
  sourceEnvironment = process.env,
  projectRoot = process.cwd(),
} = {}) {
  const root = path.resolve(projectRoot);
  const isolated = createIsolatedNpmEnvironment(sourceEnvironment);
  try {
    for (const args of [["test"], ["run", "typecheck"], ["run", "build"]]) {
      assertSafeProjectConfiguration(root);
      verifyNpmConfiguration(
        npmPath,
        isolated.env,
        isolated.expected,
        root,
      );
      runNpmCommand(npmPath, args, isolated.env, root);
      assertSafeProjectConfiguration(root);
      verifyNpmConfiguration(
        npmPath,
        isolated.env,
        isolated.expected,
        root,
      );
    }
  } finally {
    isolated.cleanup();
  }
}

async function main() {
  try {
    const npmPath = parseArguments(process.argv.slice(2));
    runSanitizedValidation({ npmPath });
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
