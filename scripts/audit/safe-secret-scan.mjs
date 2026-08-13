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
      /["']?\b(?:access[_-]?token|OPENAI_ACCESS_TOKEN)\b["']?[^\S\r\n\u2028\u2029]*(?::|=(?!=|>))[^\S\r\n\u2028\u2029]*["']?eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}["']?(?=$|[\s,;}\]])/giu,
  },
  {
    id: "bearer-value",
    pattern:
      /\b(?:authorization|proxy-authorization)\b\s*[:=]\s*["']?Bearer\s+[A-Za-z0-9._~+/=-]{20,}/giu,
  },
  {
    id: "refresh-token-assignment",
    pattern:
      /["']?\brefresh[_-]?token\b["']?[^\S\r\n\u2028\u2029]*(?::|=(?!=|>))[^\S\r\n\u2028\u2029]*(?:"[^"\r\n\u2028\u2029]{16,}"|'[^'\r\n\u2028\u2029]{16,}'|`[^`\r\n\u2028\u2029]{16,}`|([A-Za-z0-9._~+/=-]{16,}))(?=$|[\s,;}\]])/giu,
  },
  {
    id: "strict-local-secret-assignment",
    pattern:
      /["']?\b(?:APP_PASSWORD|AUTH_SECRET|VAULT_ENCRYPTION_SECRET)\b["']?[^\S\r\n\u2028\u2029]*(?::|=(?!=|>))[^\S\r\n\u2028\u2029]*(?:"[^"\r\n\u2028\u2029]{12,}"|'[^'\r\n\u2028\u2029]{12,}'|`[^`\r\n\u2028\u2029]{12,}`|([A-Za-z0-9._~+/=-]{12,}))(?=$|[\s,;}\]])/gu,
  },
];

const SOURCE_ROOT_EXCLUDED_ENTRIES = new Set([
  ".git",
  ".next",
  "audit",
  "node_modules",
]);

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
      fileSha256: "6500014d1c3d5b3bdfc18d0f8bb9685987dc7350030c96ea74a6c0c4d958109f",
      matchCount: 1,
    },
  ],
  [
    "provider-token|lib/anthropic-refresh-safety.test.ts",
    {
      fileSha256: "66e9292392935ec77f159bf67fa10ba6c83c9d7caf9ccd5026ad179f12dec56e",
      matchCount: 1,
    },
  ],
  [
    "provider-token|lib/credentials.test.ts",
    {
      fileSha256: "d952be4702140f053abfb4339aa5f387108cf7c363ca1c6ce9ca8b7e1b551e2a",
      matchCount: 4,
    },
  ],
  [
    "provider-token|lib/manual-connect.test.ts",
    {
      fileSha256: "2684cca79dadf40e0c8c33389d4253f759445b58c9ee281dde0de1b84a918c59",
      matchCount: 8,
    },
  ],
  [
    "provider-token|lib/oauth-connect.test.ts",
    {
      fileSha256: "797948f7dc4b8c7c1d2ebc9a46d9a93d291f0f596e3379d9315a0e0ca191ae35",
      matchCount: 1,
    },
  ],
  [
    "provider-token|lib/providers/anthropic-adapter.test.ts",
    {
      fileSha256: "f6d840302a6f3bb54e8939eb7ebd977ef3cbbb546d44ebfd160122cac296ce66",
      matchCount: 1,
    },
  ],
  [
    "provider-token|lib/server-error-diagnostics.test.ts",
    {
      fileSha256: "999169615a9942ccd061a6adbfd5706ebe38742da6896637efb6872340880a63",
      matchCount: 1,
    },
  ],
  [
    "refresh-token-assignment|lib/browser-boundary.test.ts",
    {
      fileSha256: "9973ce556aabe0999ba9884ad7cdf511e6bddbb0418fa9abc1871c422bc004fc",
      matchCount: 3,
    },
  ],
  [
    "refresh-token-assignment|lib/local-credentials.test.ts",
    {
      fileSha256: "9db37060dbb16ee354ff51d5fdc5bbed6c30db286ef5285d09c05a238990eb02",
      matchCount: 2,
    },
  ],
  [
    "refresh-token-assignment|lib/manual-connect.test.ts",
    {
      fileSha256: "2684cca79dadf40e0c8c33389d4253f759445b58c9ee281dde0de1b84a918c59",
      matchCount: 2,
    },
  ],
  [
    "refresh-token-assignment|lib/oauth-connect.test.ts",
    {
      fileSha256: "797948f7dc4b8c7c1d2ebc9a46d9a93d291f0f596e3379d9315a0e0ca191ae35",
      matchCount: 1,
    },
  ],
  [
    "refresh-token-assignment|lib/oauth-secure-handoff.test.ts",
    {
      fileSha256: "e74c236faf1625950feb43a51665566c7ff81ab3d33a78e2265434bd5789b451",
      matchCount: 2,
    },
  ],
  [
    "refresh-token-assignment|lib/usage-token-endurance.test.ts",
    {
      fileSha256: "8f45804749c7c77bf094be73c2eb94b79b88406f2a8c888c191b8bb81c6346e0",
      matchCount: 14,
    },
  ],
  [
    "refresh-token-assignment|lib/vault-client.test.ts",
    {
      fileSha256: "dcf9a26c976c10d022c8ef08fe11e76fb29b9ca665baf831364ef14898abbc07",
      matchCount: 1,
    },
  ],
  [
    "refresh-token-assignment|lib/vault.test.ts",
    {
      fileSha256: "5fb3492148a590f1010c3ba41a4371bb677f93c8d894e8dd40755181e469597d",
      matchCount: 12,
    },
  ],
  [
    "refresh-token-assignment|lib/safe-secret-scan.test.ts",
    {
      fileSha256: "6500014d1c3d5b3bdfc18d0f8bb9685987dc7350030c96ea74a6c0c4d958109f",
      matchCount: 1,
    },
  ],
  [
    "strict-local-secret-assignment|lib/bootstrap-ui.test.ts",
    {
      fileSha256: "105e11c0f7371f2d82079e874c8926c145898ef0311a3fae89bbcf68b46b935b",
      matchCount: 3,
    },
  ],
  [
    "strict-local-secret-assignment|lib/manual-connect.test.ts",
    {
      fileSha256: "2684cca79dadf40e0c8c33389d4253f759445b58c9ee281dde0de1b84a918c59",
      matchCount: 2,
    },
  ],
  [
    "strict-local-secret-assignment|lib/oauth-connect.test.ts",
    {
      fileSha256: "797948f7dc4b8c7c1d2ebc9a46d9a93d291f0f596e3379d9315a0e0ca191ae35",
      matchCount: 5,
    },
  ],
  [
    "strict-local-secret-assignment|lib/providers/connect-openai.test.ts",
    {
      fileSha256: "167a9a6702fa4978281548543dd990900fb44cb6946123916b01c65db6b06e75",
      matchCount: 3,
    },
  ],
  [
    "strict-local-secret-assignment|lib/providers/usage-service-openai.test.ts",
    {
      fileSha256: "8e37ce823d1e31ab32a7dd087a2e4300f8fd875f425e1d829ec7ba4e42a5ce4a",
      matchCount: 1,
    },
  ],
  [
    "strict-local-secret-assignment|lib/request-route-guards.test.ts",
    {
      fileSha256: "59792023f1afce76df6b8bcaac595e1bf4150a7246b2d57c992816a7e3ea8460",
      matchCount: 2,
    },
  ],
  [
    "strict-local-secret-assignment|lib/safe-secret-scan.test.ts",
    {
      fileSha256: "6500014d1c3d5b3bdfc18d0f8bb9685987dc7350030c96ea74a6c0c4d958109f",
      matchCount: 5,
    },
  ],
  [
    "strict-local-secret-assignment|lib/sanitized-validation.test.ts",
    {
      fileSha256: "d7bee17c607d055e602405b42ad640dbb934045be1139f0f6b407d56d2dac8f9",
      matchCount: 2,
    },
  ],
  [
    "strict-local-secret-assignment|lib/session.test.ts",
    {
      fileSha256: "a9e543285a9ded25d7ec09e77b8e0538b5d9859e0ed280732b83023a9646a516",
      matchCount: 3,
    },
  ],
  [
    "strict-local-secret-assignment|lib/usage-file-coordination.test.ts",
    {
      fileSha256: "db38868ac4c2ad00108f0528d3ada73f21a6d315a75bc6a1ac656e804c542039",
      matchCount: 1,
    },
  ],
  [
    "strict-local-secret-assignment|lib/usage-redis-coordination.test.ts",
    {
      fileSha256: "29c9f7dafc78f4c48447db34d80a3cc9e86a33f9170634911e51a18b4b2209c7",
      matchCount: 1,
    },
  ],
  [
    "strict-local-secret-assignment|lib/usage-token-endurance.test.ts",
    {
      fileSha256: "8f45804749c7c77bf094be73c2eb94b79b88406f2a8c888c191b8bb81c6346e0",
      matchCount: 1,
    },
  ],
  [
    "strict-local-secret-assignment|lib/vault-recovery.test.ts",
    {
      fileSha256: "c06f9b563b27032bae82c0d559014e29cb719c0cfd34aba00584bf77da931688",
      matchCount: 7,
    },
  ],
  [
    "strict-local-secret-assignment|lib/vault.test.ts",
    {
      fileSha256: "5fb3492148a590f1010c3ba41a4371bb677f93c8d894e8dd40755181e469597d",
      matchCount: 11,
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

async function readStableOrdinaryFile(root, absolutePath) {
  const before = await lstat(absolutePath, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) {
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
  const bytes = await readFile(absolutePath);
  const after = await lstat(absolutePath, { bigint: true });
  if (
    !after.isFile() ||
    after.isSymbolicLink() ||
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeNs !== after.mtimeNs ||
    before.ctimeNs !== after.ctimeNs
  ) {
    throw new Error("file-race");
  }
  return bytes;
}

async function enumerateRoot(cwd, requestedRoot, rootIndex) {
  const absoluteRoot = path.resolve(cwd, requestedRoot);
  const isSourceRoot =
    absoluteRoot.toLowerCase() === path.resolve(cwd).toLowerCase();
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
      if (
        isSourceRoot &&
        directory.toLowerCase() === absoluteRoot.toLowerCase() &&
        SOURCE_ROOT_EXCLUDED_ENTRIES.has(entry.name.toLowerCase())
      ) {
        continue;
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

function extractManifestEntry(entry) {
  if (
    entry &&
    typeof entry === "object" &&
    !Array.isArray(entry) &&
    Object.keys(entry).sort().join(",") === "path,sha256,size" &&
    typeof entry.path === "string" &&
    Number.isSafeInteger(entry.size) &&
    entry.size >= 0 &&
    typeof entry.sha256 === "string" &&
    /^[a-f0-9]{64}$/u.test(entry.sha256)
  ) {
    return {
      path: normalizeRelative(entry.path),
      size: entry.size,
      sha256: entry.sha256,
    };
  }
  throw new Error("invalid-manifest-entry");
}

async function filesFromManifest(
  cwd,
  manifestPath,
  expectedManifestSha256,
) {
  if (!/^[a-f0-9]{64}$/u.test(expectedManifestSha256 ?? "")) {
    throw new Error("invalid-manifest-hash");
  }
  const bytes = await readStableOrdinaryFile(cwd, manifestPath);
  const digestPath = manifestPath.toLowerCase().endsWith(".json")
    ? `${manifestPath.slice(0, -5)}.sha256`
    : `${manifestPath}.sha256`;
  const digestBytes = await readStableOrdinaryFile(cwd, digestPath);
  const publishedDigest = digestBytes.toString("ascii");
  if (
    publishedDigest !== expectedManifestSha256 ||
    sha256(bytes) !== expectedManifestSha256
  ) {
    throw new Error("manifest-hash-mismatch");
  }
  const manifest = JSON.parse(bytes.toString("utf8"));
  if (
    !manifest ||
    typeof manifest !== "object" ||
    Array.isArray(manifest) ||
    Object.keys(manifest).sort().join(",") !==
      "bootstrapFiles,commit,installerSha256,nodeSha256,runtimeFiles" ||
    typeof manifest.commit !== "string" ||
    !/^[a-f0-9]{40}$/u.test(manifest.commit) ||
    typeof manifest.nodeSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(manifest.nodeSha256) ||
    typeof manifest.installerSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(manifest.installerSha256) ||
    !Array.isArray(manifest.runtimeFiles) ||
    !Array.isArray(manifest.bootstrapFiles)
  ) {
    throw new Error("invalid-manifest");
  }
  const entries = [
    ...manifest.runtimeFiles.map(extractManifestEntry),
    ...manifest.bootstrapFiles.map(extractManifestEntry),
    {
      path: "scripts/windows/install-secure-local.ps1",
      size: undefined,
      sha256: manifest.installerSha256,
    },
  ];
  if (
    new Set(entries.map((entry) => entry.path.toLowerCase())).size !==
    entries.length
  ) {
    throw new Error("duplicate-manifest-path");
  }
  return entries.map((entry) => ({
    ...entry,
    absolutePath: path.resolve(cwd, ...entry.path.split("/")),
  }));
}

function parseArguments(argv) {
  const roots = [];
  let jsonPath;
  let manifestPath;
  let expectedManifestSha256;
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
    } else if (
      flag === "--expected-manifest-sha256" &&
      expectedManifestSha256 === undefined
    ) {
      expectedManifestSha256 = value;
    } else {
      throw new Error("invalid-arguments");
    }
  }
  if (
    jsonPath === undefined ||
    (manifestPath === undefined && roots.length === 0) ||
    (manifestPath !== undefined && roots.length > 0) ||
    (manifestPath !== undefined &&
      !/^[a-f0-9]{64}$/u.test(expectedManifestSha256 ?? "")) ||
    (manifestPath === undefined && expectedManifestSha256 !== undefined)
  ) {
    throw new Error("invalid-arguments");
  }
  return {
    jsonPath: path.resolve(jsonPath),
    manifestPath: manifestPath ? path.resolve(manifestPath) : undefined,
    expectedManifestSha256,
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
  expectedManifestSha256,
}) {
  const root = await realpath(cwd);
  let files;
  if (manifestPath) {
    files = (
      await filesFromManifest(
        root,
        manifestPath,
        expectedManifestSha256,
      )
    ).map(
      (entry) => ({
        absolutePath: entry.absolutePath,
        relative: entry.path,
        boundary: root,
        expectedSize: entry.size,
        expectedSha256: entry.sha256,
      }),
    );
  } else {
    if (expectedManifestSha256 !== undefined) {
      throw new Error("invalid-manifest-hash");
    }
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
    normalizedFiles.push({
      absolutePath: file.absolutePath,
      relative,
      boundary: file.boundary,
      expectedSize: file.expectedSize,
      expectedSha256: file.expectedSha256,
    });
  }
  normalizedFiles.sort((left, right) =>
    left.relative.localeCompare(right.relative, "en"),
  );

  const findings = [];
  let suppressedSourceFixtureCount = 0;
  let binaryFilesExamined = 0;
  for (const file of normalizedFiles) {
    const bytes = await readStableOrdinaryFile(
      file.boundary,
      file.absolutePath,
    );
    const fileSha256 = sha256(bytes);
    if (
      file.expectedSha256 !== undefined &&
      (fileSha256 !== file.expectedSha256 ||
        (file.expectedSize !== undefined &&
          bytes.byteLength !== file.expectedSize))
    ) {
      throw new Error("manifest-file-mismatch");
    }
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
      expectedManifestSha256: parsed.expectedManifestSha256,
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
