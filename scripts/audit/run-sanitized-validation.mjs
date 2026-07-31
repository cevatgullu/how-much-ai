import { spawnSync } from "node:child_process";
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

function runNpmCommand(npmPath, args, env) {
  let result;
  if (process.platform === "win32") {
    const comSpec = env.ComSpec;
    if (
      typeof comSpec !== "string" ||
      !path.isAbsolute(comSpec) ||
      !comSpec.toLowerCase().endsWith(`${path.sep}cmd.exe`)
    ) {
      throw new Error("invalid-command-processor");
    }
    const fixedArguments = args.join(" ");
    result = spawnSync(
      comSpec,
      ["/d", "/s", "/c", `""${npmPath}" ${fixedArguments}"`],
      {
        env,
        stdio: "inherit",
        windowsHide: true,
        shell: false,
      },
    );
  } else {
    result = spawnSync(npmPath, args, {
      env,
      stdio: "inherit",
      shell: false,
    });
  }

  if (result.error || result.signal || result.status !== 0) {
    throw new Error("validation-command-failed");
  }
}

export function runSanitizedValidation({
  npmPath,
  sourceEnvironment = process.env,
} = {}) {
  const env = createSanitizedBuildEnvironment(sourceEnvironment);
  for (const args of [["test"], ["run", "typecheck"], ["run", "build"]]) {
    runNpmCommand(npmPath, args, env);
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
