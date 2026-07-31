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
    id: "openai-access-token-assignment",
    pattern:
      /["']?\b(?:access[_-]?token|OPENAI_ACCESS_TOKEN)\b["']?\s*(?::|=(?!=|>))\s*["']?eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}["']?(?=$|[\s,;}\]])/giu,
  },
  {
    id: "bearer-value",
    pattern:
      /\b(?:authorization|proxy-authorization)\b\s*[:=]\s*["']?Bearer\s+[A-Za-z0-9._~+/=-]{20,}/giu,
  },
  {
    id: "refresh-token-assignment",
    pattern:
      /["']?\brefresh[_-]?token\b["']?\s*(?::|=(?!=|>))\s*(?:"[^"\r\n]{16,}"|'[^'\r\n]{16,}'|([A-Za-z0-9._~+/=-]{16,}))(?=$|[\s,;}\]])/giu,
  },
  {
    id: "strict-local-secret-assignment",
    pattern:
      /["']?\b(?:APP_PASSWORD|AUTH_SECRET|VAULT_ENCRYPTION_SECRET)\b["']?\s*(?::|=(?!=|>))\s*(?:"[^"\r\n]{12,}"|'[^'\r\n]{12,}'|([A-Za-z0-9._~+/=-]{12,}))(?=$|[\s,;}\]])/gu,
  },
];

const JAVASCRIPT_SOURCE_EXTENSIONS = new Set([
  ".cjs",
  ".js",
  ".jsx",
  ".mjs",
  ".ts",
  ".tsx",
]);

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

// These reviewed source-only tests intentionally contain synthetic credential
// shapes. Suppression requires the exact rule, normalized path, complete file
// hash, and match count. Any byte-level fixture change disables suppression for
// that rule. Manifest mode never uses source exceptions.
const REVIEWED_SOURCE_FIXTURES = new Map([
  [
    "private-key|lib/safe-secret-scan.test.ts",
    {
      fileSha256: "5a27b21b1c327fbe638c78cb839e895c6b264b59b79c2ceb8b66e303213e3c34",
      matchCount: 1,
    },
  ],
  [
    "provider-token|lib/anthropic-refresh-safety.test.ts",
    {
      fileSha256: "36c9d14af8db85c1338fcfc7642163abae7bfba9b6758d180a2a179a86ca9759",
      matchCount: 1,
    },
  ],
  [
    "provider-token|lib/credentials.test.ts",
    {
      fileSha256: "4a121828769b389b319ae3e508cef1a48d64edd5c26e4354d5d3c22fec0717a6",
      matchCount: 4,
    },
  ],
  [
    "provider-token|lib/manual-connect.test.ts",
    {
      fileSha256: "a5108107d5901d336dec04a72028a65be59b9b590c22c497c70a25b76a8708e7",
      matchCount: 8,
    },
  ],
  [
    "provider-token|lib/oauth-connect.test.ts",
    {
      fileSha256: "2c51e62d915119e1b69139eb62f1a1b584effe3f6f274148d6fc5dca76debfdf",
      matchCount: 1,
    },
  ],
  [
    "provider-token|lib/providers/anthropic-adapter.test.ts",
    {
      fileSha256: "fcf1ec4eddf7a89696fe4a0650e8ee2560423803e5ac2a1f6c7e67cca8066d0f",
      matchCount: 1,
    },
  ],
  [
    "provider-token|lib/server-error-diagnostics.test.ts",
    {
      fileSha256: "1f1f15e3e86b5b38e21b60c18b79dc9dd8da960db23863fd28ee36069159bea8",
      matchCount: 1,
    },
  ],
  [
    "refresh-token-assignment|lib/browser-boundary.test.ts",
    {
      fileSha256: "5c71ca645b7fa5bc35f4693e9c24c49604e5b177b69bc415f2b2bac58e6e3d1f",
      matchCount: 3,
    },
  ],
  [
    "refresh-token-assignment|lib/local-credentials.test.ts",
    {
      fileSha256: "ea42bb4a36db8152019051e6e06935ec88da63df23df7078eac189b0969a4573",
      matchCount: 2,
    },
  ],
  [
    "refresh-token-assignment|lib/manual-connect.test.ts",
    {
      fileSha256: "a5108107d5901d336dec04a72028a65be59b9b590c22c497c70a25b76a8708e7",
      matchCount: 2,
    },
  ],
  [
    "refresh-token-assignment|lib/oauth-connect.test.ts",
    {
      fileSha256: "2c51e62d915119e1b69139eb62f1a1b584effe3f6f274148d6fc5dca76debfdf",
      matchCount: 1,
    },
  ],
  [
    "refresh-token-assignment|lib/usage-token-endurance.test.ts",
    {
      fileSha256: "79a30d97dd67d3a1a93780b3e2e080be25a6bab17494dea4107e9d124bd4dc30",
      matchCount: 13,
    },
  ],
  [
    "refresh-token-assignment|lib/vault-client.test.ts",
    {
      fileSha256: "9e06b3698c8b8cb1cf6de693b6535443a28bafe51fba677772d00cea1f6fbb3a",
      matchCount: 1,
    },
  ],
  [
    "refresh-token-assignment|lib/vault.test.ts",
    {
      fileSha256: "b5294d74ad6f52f14353eee59d5a753508806b843c49c2de9ccd8a682ef34825",
      matchCount: 3,
    },
  ],
  [
    "strict-local-secret-assignment|lib/bootstrap-ui.test.ts",
    {
      fileSha256: "16193d9e07cfa611a97e7abd48f0a4d3ba9f097d208b846a9ef6d72e72ab8af2",
      matchCount: 2,
    },
  ],
  [
    "strict-local-secret-assignment|lib/oauth-connect.test.ts",
    {
      fileSha256: "2c51e62d915119e1b69139eb62f1a1b584effe3f6f274148d6fc5dca76debfdf",
      matchCount: 2,
    },
  ],
  [
    "strict-local-secret-assignment|lib/providers/connect-openai.test.ts",
    {
      fileSha256: "195348e7b6d650ca80d7a81ceb4641db2c8f2942970ff6936c4d2e00c207c60d",
      matchCount: 1,
    },
  ],
  [
    "strict-local-secret-assignment|lib/providers/usage-service-openai.test.ts",
    {
      fileSha256: "de0a281c4a749666a988dba9ef90cd4c1dbf76f3cca20ba29e60704f8aa246b4",
      matchCount: 1,
    },
  ],
  [
    "strict-local-secret-assignment|lib/safe-secret-scan.test.ts",
    {
      fileSha256: "5a27b21b1c327fbe638c78cb839e895c6b264b59b79c2ceb8b66e303213e3c34",
      matchCount: 4,
    },
  ],
  [
    "strict-local-secret-assignment|lib/sanitized-validation.test.ts",
    {
      fileSha256: "a6923e4ae1fe2518a358cf1e57e7293ea61ad08d0895e9e592e76e9764bdf963",
      matchCount: 2,
    },
  ],
  [
    "strict-local-secret-assignment|lib/session.test.ts",
    {
      fileSha256: "ba91d458030e428cd307dd7ac8c2e3c914d398b0650e75dbeda7a67692561006",
      matchCount: 3,
    },
  ],
  [
    "strict-local-secret-assignment|lib/usage-file-coordination.test.ts",
    {
      fileSha256: "99a60d11a0553d73e28e59ae1816ff3503819fdc559b271d57a869024be00210",
      matchCount: 1,
    },
  ],
  [
    "strict-local-secret-assignment|lib/usage-redis-coordination.test.ts",
    {
      fileSha256: "99c1acd202336457ecb599018b322570a5f46b0d77237d3f6a938451629fbace",
      matchCount: 1,
    },
  ],
  [
    "strict-local-secret-assignment|lib/usage-token-endurance.test.ts",
    {
      fileSha256: "79a30d97dd67d3a1a93780b3e2e080be25a6bab17494dea4107e9d124bd4dc30",
      matchCount: 1,
    },
  ],
  [
    "strict-local-secret-assignment|lib/vault-recovery.test.ts",
    {
      fileSha256: "b6c077139439dc39da0b103e1702044e377f8c73a23ee47f86f0b7a46806e7d0",
      matchCount: 3,
    },
  ],
  [
    "strict-local-secret-assignment|lib/vault.test.ts",
    {
      fileSha256: "b5294d74ad6f52f14353eee59d5a753508806b843c49c2de9ccd8a682ef34825",
      matchCount: 4,
    },
  ],
]);

function isReviewedSyntheticSourceFixture({
  ruleId,
  relativePath,
  fileSha256,
  matchCount,
}) {
  const reviewed = REVIEWED_SOURCE_FIXTURES.get(
    `${ruleId}|${relativePath}`,
  );
  return (
    reviewed?.fileSha256 === fileSha256 &&
    reviewed?.matchCount === matchCount
  );
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
  if (detectUtf16Encoding(bytes)) {
    return true;
  }
  const extension = path.extname(relativePath).toLowerCase();
  if (TEXT_EXTENSIONS.has(extension)) {
    return !bytes.includes(0);
  }
  const sample = bytes.subarray(0, Math.min(bytes.byteLength, 8192));
  if (sample.byteLength === 0) {
    return true;
  }
  let disallowedControls = 0;
  for (const byte of sample) {
    if (byte === 0) {
      return false;
    }
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) {
      disallowedControls += 1;
    }
  }
  return disallowedControls / sample.byteLength < 0.01;
}

function detectUtf16Encoding(bytes) {
  if (bytes.byteLength >= 2) {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) {
      return "utf-16le";
    }
    if (bytes[0] === 0xfe && bytes[1] === 0xff) {
      return "utf-16be";
    }
  }
  const sampleLength = Math.min(bytes.byteLength - (bytes.byteLength % 2), 8192);
  if (sampleLength < 8) {
    return undefined;
  }
  let evenNulls = 0;
  let oddNulls = 0;
  const pairs = sampleLength / 2;
  for (let index = 0; index < sampleLength; index += 2) {
    if (bytes[index] === 0) {
      evenNulls += 1;
    }
    if (bytes[index + 1] === 0) {
      oddNulls += 1;
    }
  }
  if (oddNulls / pairs > 0.6 && evenNulls / pairs < 0.1) {
    return "utf-16le";
  }
  if (evenNulls / pairs > 0.6 && oddNulls / pairs < 0.1) {
    return "utf-16be";
  }
  return undefined;
}

function decodeCandidatesForScan(bytes) {
  const candidates = new Set([bytes.toString("latin1")]);
  const utf16Encoding = detectUtf16Encoding(bytes);
  if (utf16Encoding) {
    candidates.add(
      new TextDecoder(utf16Encoding, { fatal: false }).decode(bytes),
    );
  }
  // Latin-1 preserves every ASCII byte verbatim, so credentials embedded in
  // an otherwise binary or extensionless file are still examined.
  // If a file contains nulls, scan both UTF-16 byte orders as well. A BOM-less
  // file can otherwise make a prefix look like the opposite byte order.
  if (bytes.includes(0)) {
    candidates.add(new TextDecoder("utf-16le", { fatal: false }).decode(bytes));
    candidates.add(new TextDecoder("utf-16be", { fatal: false }).decode(bytes));
  }
  return [...candidates];
}

function isJavaScriptCodeOffset(text, offset) {
  const contexts = [{ type: "code" }];
  for (let index = 0; index < offset; index += 1) {
    const context = contexts.at(-1);
    const character = text[index];
    const next = text[index + 1];
    if (context.type === "single-quote" || context.type === "double-quote") {
      if (character === "\\") {
        index += 1;
      } else if (
        (context.type === "single-quote" && character === "'") ||
        (context.type === "double-quote" && character === '"')
      ) {
        contexts.pop();
      }
      continue;
    }
    if (context.type === "line-comment") {
      if (character === "\r" || character === "\n") {
        contexts.pop();
      }
      continue;
    }
    if (context.type === "block-comment") {
      if (character === "*" && next === "/") {
        contexts.pop();
        index += 1;
      }
      continue;
    }
    if (context.type === "template") {
      if (character === "\\") {
        index += 1;
      } else if (character === "`") {
        contexts.pop();
      } else if (character === "$" && next === "{") {
        contexts.push({ type: "code", templateDepth: 1 });
        index += 1;
      }
      continue;
    }
    if (character === "'") {
      contexts.push({ type: "single-quote" });
    } else if (character === '"') {
      contexts.push({ type: "double-quote" });
    } else if (character === "`") {
      contexts.push({ type: "template" });
    } else if (character === "/" && next === "/") {
      contexts.push({ type: "line-comment" });
      index += 1;
    } else if (character === "/" && next === "*") {
      contexts.push({ type: "block-comment" });
      index += 1;
    } else if (context.templateDepth !== undefined) {
      if (character === "{") {
        context.templateDepth += 1;
      } else if (character === "}") {
        context.templateDepth -= 1;
        if (context.templateDepth === 0) {
          contexts.pop();
        }
      }
    }
  }
  return contexts.at(-1)?.type === "code";
}

function isUnquotedSourceMemberReference(
  ruleId,
  relativePath,
  text,
  match,
) {
  if (
    ruleId !== "refresh-token-assignment" &&
    ruleId !== "strict-local-secret-assignment"
  ) {
    return false;
  }
  const unquotedValue = match[1];
  if (
    typeof unquotedValue !== "string" ||
    !JAVASCRIPT_SOURCE_EXTENSIONS.has(
      path.extname(relativePath).toLowerCase(),
    )
  ) {
    return false;
  }
  const relativeValueIndex = match[0].lastIndexOf(unquotedValue);
  return (
    relativeValueIndex >= 0 &&
    isJavaScriptCodeOffset(text, match.index + relativeValueIndex) &&
    /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/u.test(
      unquotedValue,
    )
  );
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
    const fileSha256 = sha256(bytes);
    if (!isTextCapable(file.relative, bytes)) {
      binaryFilesExamined += 1;
    }
    const texts = decodeCandidatesForScan(bytes);
    for (const rule of RULES) {
      const matches = texts.flatMap((text) => {
        rule.pattern.lastIndex = 0;
        return [...text.matchAll(rule.pattern)].filter(
          (match) =>
            !isUnquotedSourceMemberReference(
              rule.id,
              file.relative,
              text,
              match,
            ),
        );
      });
      const suppress =
        !manifestPath &&
        isReviewedSyntheticSourceFixture({
          ruleId: rule.id,
          relativePath: file.relative,
          fileSha256,
          matchCount: matches.length,
        });
      if (suppress) {
        suppressedSourceFixtureCount += matches.length;
      }
      const unsuppressed = suppress ? [] : matches;
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
