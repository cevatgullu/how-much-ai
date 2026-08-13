// Windows ACL tightening for vault files.
//
// WHY THIS EXISTS
// ---------------
// `fs.chmod(0o600)` is a no-op for access control on Windows — it toggles the read-only
// attribute and nothing else. A file created inside the vault directory therefore takes its
// ACEs by *inheritance* from that directory, which carries ContainerInherit|ObjectInherit.
//
// The secure-local startup check (`Test-HmaExactPrivateAcl`) requires every vault file to
// carry exactly two ACEs — current user and SYSTEM, FullControl — and requires them to be
// explicit, `IsInherited = false`. An inherited ACE fails that test even though the effective
// permissions are identical, because inheritance means a later change to the parent silently
// rewrites the child.
//
// The consequence measured on 2026-08-13: every vault write produced files the next cold start
// refused, and the app failed to launch with the deliberately opaque
// "Secure local launcher failed." The installer sets these ACLs explicitly; the runtime write
// path did not, so normal use broke the boot gate.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

const SYSTEM_SID = "S-1-5-18";
const SID_PATTERN = /^S-1-5-21-\d+-\d+-\d+-\d+$/u;

let cachedUserSid: string | null = null;

export class WindowsAclError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WindowsAclError";
  }
}

/**
 * Arguments for one icacls invocation. `/inheritance:r` drops the inherited ACEs (which is what
 * protects the ACL), and `/grant:r` then writes the two explicit entries. SIDs are used rather
 * than names so a renamed or localised account cannot change what is granted; icacls reads a
 * leading `*` as "this principal is a SID".
 */
export function windowsPrivateAclArgs(file: string, userSid: string): string[] {
  return [file, "/inheritance:r", "/grant:r", `*${userSid}:(F)`, `*${SYSTEM_SID}:(F)`];
}

/** Extract the current user's SID from `whoami /user /fo csv /nh` output. */
export function parseWhoamiSid(stdout: string): string | null {
  const line = stdout.split(/\r?\n/u).map((row) => row.trim()).find(Boolean);
  if (!line) return null;
  const fields = line.split(",").map((field) => field.trim().replace(/^"|"$/gu, ""));
  const sid = fields[fields.length - 1];
  return sid && SID_PATTERN.test(sid) ? sid : null;
}

async function currentUserSid(): Promise<string> {
  if (cachedUserSid) return cachedUserSid;
  let stdout: string;
  try {
    ({ stdout } = await run("whoami", ["/user", "/fo", "csv", "/nh"], { windowsHide: true }));
  } catch {
    throw new WindowsAclError("Windows kullanıcı kimliği okunamadı.");
  }
  const sid = parseWhoamiSid(stdout);
  if (!sid) throw new WindowsAclError("Windows kullanıcı kimliği çözümlenemedi.");
  cachedUserSid = sid;
  return sid;
}

/**
 * Replace a file's ACL with the exact private pair. No-op off Windows, where the POSIX mode the
 * caller already applied is the real control.
 *
 * Failures throw rather than being swallowed: a vault file with inherited ACEs is precisely the
 * state that breaks the next launch, and surfacing it at write time is far cheaper to diagnose
 * than an opaque launcher failure hours later.
 */
export async function enforcePrivateWindowsAcl(file: string): Promise<void> {
  if (process.platform !== "win32") return;
  const sid = await currentUserSid();
  try {
    await run("icacls", windowsPrivateAclArgs(file, sid), { windowsHide: true });
  } catch {
    throw new WindowsAclError(
      "Kasa dosyasının Windows izinleri ayarlanamadı; bir sonraki başlatma reddedilirdi.",
    );
  }
}

/** Test seam: clears the memoised SID so a suite can exercise the lookup path repeatedly. */
export function resetWindowsAclCacheForTests(): void {
  cachedUserSid = null;
}
