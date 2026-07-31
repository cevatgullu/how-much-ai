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

const RULES = [
  {
    id: "private-key",
    pattern: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/gu,
  },
  {
    id: "provider-token",
    pattern:
      /\bsk-(?:(?:ant-(?:api|oat|ort)\d{2}|proj|svcacct)-)?[A-Za-z0-9_-]{24,}\b/gu,
  },
  {
    id: "bearer-value",
    pattern:
      /\b(?:authorization|proxy-authorization)\b\s*[:=]\s*["']?Bearer\s+[A-Za-z0-9._~+/=-]{20,}/giu,
  },
  {
    id: "refresh-token-assignment",
    pattern:
      /\brefresh[_-]?token\b\s*[:=]\s*["'][A-Za-z0-9._~+/=-]{16,}["']/giu,
  },
  {
    id: "strict-local-secret-assignment",
    pattern:
      /\b(?:APP_PASSWORD|AUTH_SECRET|VAULT_ENCRYPTION_SECRET)\b\s*[:=]\s*["'][^"'\r\n]{12,}["']/gu,
  },
];

const TEXT_EXTENSIONS = new Set([
  "",
  ".cjs",
  ".conf",
  ".css",
  ".csv",
  ".env",
  ".html",
  ".ini",
  ".js",
  ".json",
  ".jsx",
  ".lock",
  ".md",
  ".mjs",
  ".ps1",
  ".psd1",
  ".psm1",
  ".scss",
  ".sh",
  ".svg",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);

// These exact source-only tests intentionally contain synthetic credential
// shapes. The exception is keyed by both rule and normalized filename and is
// disabled in manifest mode, where every installable byte is scanned without
// source/test exclusions.
const REVIEWED_SOURCE_FIXTURES = new Map([
  [
    "provider-token",
    new Set([
      "lib/anthropic-refresh-safety.test.ts",
      "lib/credentials.test.ts",
      "lib/manual-connect.test.ts",
      "lib/oauth-connect.test.ts",
      "lib/providers/anthropic-adapter.test.ts",
      "lib/server-error-diagnostics.test.ts",
    ]),
  ],
  [
    "refresh-token-assignment",
    new Set([
      "lib/browser-boundary.test.ts",
      "lib/local-credentials.test.ts",
      "lib/manual-connect.test.ts",
      "lib/oauth-connect.test.ts",
      "lib/usage-token-endurance.test.ts",
      "lib/vault-client.test.ts",
      "lib/vault.test.ts",
    ]),
  ],
  [
    "strict-local-secret-assignment",
    new Set([
      "lib/bootstrap-ui.test.ts",
      "lib/oauth-connect.test.ts",
      "lib/providers/connect-openai.test.ts",
      "lib/providers/usage-service-openai.test.ts",
      "lib/safe-secret-scan.test.ts",
      "lib/sanitized-validation.test.ts",
      "lib/session.test.ts",
      "lib/usage-file-coordination.test.ts",
      "lib/usage-redis-coordination.test.ts",
      "lib/usage-token-endurance.test.ts",
      "lib/vault-recovery.test.ts",
      "lib/vault.test.ts",
    ]),
  ],
]);

function isReviewedSyntheticSourceFixture(ruleId, relativePath) {
  const paths = REVIEWED_SOURCE_FIXTURES.get(ruleId);
  return paths?.has(relativePath) ?? false;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeRelative(value) {
  const normalized = value.replaceAll("\\", "/").normalize("NFC");
  if (
    normalized === "" ||
    normalized.startsWith("/") ||
    normalized.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error("unsafe-relative-path");
  }
  return normalized;
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

async function assertOrdinaryFile(root, absolutePath) {
  const info = await lstat(absolutePath);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error("non-ordinary-file");
  }
  const resolved = await realpath(absolutePath);
  const resolvedRoot = await realpath(root);
  if (
    resolved.toLowerCase() !== resolvedRoot.toLowerCase() &&
    !isInside(resolvedRoot, resolved)
  ) {
    throw new Error("path-escape");
  }
}

async function enumerateRoot(cwd, requestedRoot, rootIndex) {
  const absoluteRoot = path.resolve(cwd, requestedRoot);
  const relativeRoot = path.relative(cwd, absoluteRoot);
  const external =
    relativeRoot === ".." ||
    relativeRoot.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeRoot);
  const info = await lstat(absoluteRoot);
  if (info.isSymbolicLink()) {
    throw new Error("symbolic-root");
  }
  const externalPrefix = external
    ? `external-${rootIndex}/${normalizeRelative(path.basename(absoluteRoot))}`
    : undefined;
  if (info.isFile()) {
    return [
      {
        absolutePath: absoluteRoot,
        relative: externalPrefix ?? normalizeRelative(relativeRoot),
        boundary: path.dirname(absoluteRoot),
      },
    ];
  }
  if (!info.isDirectory()) {
    throw new Error("unsupported-root");
  }

  const files = [];
  const pending = [absoluteRoot];
  while (pending.length > 0) {
    const directory = pending.pop();
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error("symbolic-entry");
      }
      if (entry.isDirectory()) {
        pending.push(absolute);
      } else if (entry.isFile()) {
        const relativeWithinRoot = normalizeRelative(
          path.relative(absoluteRoot, absolute),
        );
        files.push({
          absolutePath: absolute,
          relative: external
            ? `${externalPrefix}/${relativeWithinRoot}`
            : normalizeRelative(path.relative(cwd, absolute)),
          boundary: absoluteRoot,
        });
      } else {
        throw new Error("unsupported-entry");
      }
    }
  }
  return files;
}

function extractManifestPath(entry) {
  if (typeof entry === "string") {
    return entry;
  }
  if (
    entry &&
    typeof entry === "object" &&
    typeof entry.path === "string"
  ) {
    return entry.path;
  }
  throw new Error("invalid-manifest-entry");
}

async function filesFromManifest(cwd, manifestPath) {
  const raw = await readFile(manifestPath, "utf8");
  const manifest = JSON.parse(raw);
  if (
    !manifest ||
    typeof manifest !== "object" ||
    !Array.isArray(manifest.runtimeFiles) ||
    !Array.isArray(manifest.bootstrapFiles)
  ) {
    throw new Error("invalid-manifest");
  }
  const names = [
    ...manifest.runtimeFiles.map(extractManifestPath),
    ...manifest.bootstrapFiles.map(extractManifestPath),
  ].map(normalizeRelative);
  if (new Set(names.map((name) => name.toLowerCase())).size !== names.length) {
    throw new Error("duplicate-manifest-path");
  }
  return names.map((name) => path.resolve(cwd, ...name.split("/")));
}

function parseArguments(argv) {
  const roots = [];
  let jsonPath;
  let manifestPath;
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!value) {
      throw new Error("invalid-arguments");
    }
    if (flag === "--root") {
      roots.push(value);
    } else if (flag === "--json" && jsonPath === undefined) {
      jsonPath = value;
    } else if (flag === "--manifest" && manifestPath === undefined) {
      manifestPath = value;
    } else {
      throw new Error("invalid-arguments");
    }
  }
  if (
    jsonPath === undefined ||
    (manifestPath === undefined && roots.length === 0) ||
    (manifestPath !== undefined && roots.length > 0)
  ) {
    throw new Error("invalid-arguments");
  }
  return {
    jsonPath: path.resolve(jsonPath),
    manifestPath: manifestPath ? path.resolve(manifestPath) : undefined,
    roots,
  };
}

function isTextCapable(relativePath, bytes) {
  if (bytes.includes(0)) {
    return false;
  }
  const extension = path.extname(relativePath).toLowerCase();
  return TEXT_EXTENSIONS.has(extension);
}

export async function scanSecrets({
  cwd = process.cwd(),
  roots = [],
  manifestPath,
}) {
  const root = await realpath(cwd);
  let files;
  if (manifestPath) {
    files = (await filesFromManifest(root, manifestPath)).map(
      (absolutePath) => ({
        absolutePath,
        relative: normalizeRelative(path.relative(root, absolutePath)),
        boundary: root,
      }),
    );
  } else {
    const groups = await Promise.all(
      roots.map((requestedRoot, index) =>
        enumerateRoot(root, requestedRoot, index),
      ),
    );
    files = groups.flat();
  }

  const normalizedFiles = [];
  const folded = new Set();
  const physicalFiles = new Set();
  for (const file of files) {
    await assertOrdinaryFile(file.boundary, file.absolutePath);
    const relative = normalizeRelative(file.relative);
    const key = relative.toLowerCase();
    const physicalKey = (await realpath(file.absolutePath)).toLowerCase();
    if (folded.has(key) || physicalFiles.has(physicalKey)) {
      throw new Error("duplicate-input-path");
    }
    folded.add(key);
    physicalFiles.add(physicalKey);
    normalizedFiles.push({ absolutePath: file.absolutePath, relative });
  }
  normalizedFiles.sort((left, right) =>
    left.relative.localeCompare(right.relative, "en"),
  );

  const findings = [];
  let suppressedSourceFixtureCount = 0;
  let binaryFilesExamined = 0;
  for (const file of normalizedFiles) {
    const bytes = await readFile(file.absolutePath);
    if (!isTextCapable(file.relative, bytes)) {
      binaryFilesExamined += 1;
      continue;
    }
    const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    for (const rule of RULES) {
      rule.pattern.lastIndex = 0;
      const matches = [...text.matchAll(rule.pattern)];
      const unsuppressed = matches.filter((match) => {
        const suppress =
          !manifestPath &&
          isReviewedSyntheticSourceFixture(
            rule.id,
            file.relative,
          );
        if (suppress) {
          suppressedSourceFixtureCount += 1;
        }
        return !suppress;
      });
      if (unsuppressed.length > 0) {
        findings.push({
          ruleId: rule.id,
          pathHash: sha256(file.relative),
        });
      }
    }
  }
  findings.sort(
    (left, right) =>
      left.pathHash.localeCompare(right.pathHash, "en") ||
      left.ruleId.localeCompare(right.ruleId, "en"),
  );

  return {
    ok: findings.length === 0,
    filesScanned: normalizedFiles.length,
    binaryFilesExamined,
    suppressedSourceFixtureCount,
    findingCount: findings.length,
    findings,
    examinedPathHashes: normalizedFiles
      .map((file) => sha256(file.relative))
      .sort(),
  };
}

async function main() {
  let report;
  let outputPath;
  try {
    const parsed = parseArguments(process.argv.slice(2));
    outputPath = parsed.jsonPath;
    report = await scanSecrets({
      cwd: process.cwd(),
      roots: parsed.roots,
      manifestPath: parsed.manifestPath,
    });
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, {
      encoding: "utf8",
      flag: "w",
    });
    process.stdout.write(
      `${JSON.stringify({
        ok: report.ok,
        filesScanned: report.filesScanned,
        findingCount: report.findingCount,
      })}\n`,
    );
    if (!report.ok) {
      process.exitCode = 1;
    }
  } catch {
    const failure = {
      ok: false,
      filesScanned: 0,
      binaryFilesExamined: 0,
      findingCount: 0,
      findings: [],
      examinedPathHashes: [],
      error: "secret-scan-failed",
    };
    if (outputPath) {
      try {
        await mkdir(path.dirname(outputPath), { recursive: true });
        await writeFile(outputPath, `${JSON.stringify(failure, null, 2)}\n`, {
          encoding: "utf8",
          flag: "w",
        });
      } catch {
        // The CLI deliberately emits no raw filesystem diagnostic.
      }
    }
    process.stderr.write('{"ok":false,"error":"secret-scan-failed"}\n');
    process.exitCode = 2;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  await main();
}
