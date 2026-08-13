import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { promisify } from "node:util";
import "./providers/_resolve-ts.mjs";

const { windowsPrivateAclArgs, parseWhoamiSid, enforcePrivateWindowsAcl } = await import(
  "./windows-private-acl.ts"
);

const run = promisify(execFile);
const onWindows = process.platform === "win32";

test("the icacls arguments drop inheritance and grant exactly two SIDs", () => {
  const args = windowsPrivateAclArgs("C:\\vault\\vault.enc", "S-1-5-21-1-2-3-1001");
  assert.deepEqual(args, [
    "C:\\vault\\vault.enc",
    // Removing inherited ACEs is what protects the ACL; without it the two grants below would
    // sit alongside the inherited pair and the startup check would still see IsInherited entries.
    "/inheritance:r",
    "/grant:r",
    "*S-1-5-21-1-2-3-1001:(F)",
    "*S-1-5-18:(F)",
  ]);
  // Principals are SIDs, never names: a renamed or localised account must not change the grant.
  assert.equal(args.some((arg) => /Administrators|Users|Everyone/u.test(arg)), false);
});

test("the whoami SID is read from the last CSV field and validated", () => {
  assert.equal(parseWhoamiSid('"cevat\\gllce","S-1-5-21-11-22-33-1001"\r\n'), "S-1-5-21-11-22-33-1001");
  assert.equal(parseWhoamiSid("cevat\\gllce,S-1-5-21-11-22-33-1001\n"), "S-1-5-21-11-22-33-1001");
  // A machine or well-known SID in that slot means the output was not what we expected.
  assert.equal(parseWhoamiSid('"cevat\\gllce","S-1-5-18"'), null);
  assert.equal(parseWhoamiSid(""), null);
  assert.equal(parseWhoamiSid("garbage"), null);
});

test("a written file ends up with exactly two non-inherited ACEs", { skip: !onWindows }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hma-acl-"));
  const file = path.join(dir, "vault.enc");
  await writeFile(file, "x", "utf8");
  await enforcePrivateWindowsAcl(file);

  const { stdout } = await run("icacls", [file], { windowsHide: true });
  // icacls prints one "path:principal:(rights)" line per ACE; inherited ones carry (I).
  const aces = stdout
    .split(/\r?\n/u)
    .filter((line) => line.includes(":(") && !line.startsWith("Successfully"));
  assert.equal(aces.length, 2, `beklenen 2 ACE, gelen:\n${stdout}`);
  assert.equal(aces.some((line) => /\(I\)/u.test(line)), false, "miras alinmis ACE kalmamali");
  assert.equal(aces.some((line) => /SYSTEM/iu.test(line)), true);
  assert.equal(await readFile(file, "utf8"), "x", "izin degisikligi icerigi bozmamali");
});

test("no-op away from Windows", { skip: onWindows }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hma-acl-"));
  const file = path.join(dir, "vault.enc");
  await writeFile(file, "x", "utf8");
  await enforcePrivateWindowsAcl(file);
  assert.equal(await readFile(file, "utf8"), "x");
});
