# Task 5 report: Windows CurrentUser DPAPI secret store

Implemented the strict-local Windows secret bundle module and its real Windows PowerShell 5.1 integration tests.

## Changes

- Added CurrentUser DPAPI protection with fixed application entropy, cryptographic random-secret generation, strict version/length/pairwise-uniqueness validation on protect and unprotect, a 64 KiB input bound, atomic create-without-overwrite behavior, and generic non-secret errors.
- Added fail-closed ACL traversal that verifies every existing local-drive path component before walking the tree. Private state must be owned by the current user and have exactly one explicit FullControl allow ACE for that user and one for SYSTEM; extra, deny, inherited, missing, or weakened rules fail verification.
- Added recursive reparse-point rejection before ACL mutation, including root, ancestor, and nested junction coverage that verifies external target SDDL is unchanged.
- Added a boolean-only streaming at-rest scanner for exact ASCII/UTF-8/UTF-16LE values, with encoding deduplication and overlap sized to catch matches across 4096-byte read boundaries.
- Exported only the six planned public functions. The test fixtures use generated or fixed fake values and pass random markers through child environment variables.

## TDD evidence

1. The initial focused DPAPI run failed with the module absent; the two-file focused run failed all five integration tests.
2. DPAPI round-trip, synthetic invalid payload, ACL mutation, junction, and streaming-scan cases passed after the minimal module implementation.
3. A nested explicit-ACE repair regression failed against the original ACL write path, then passed after the Windows PowerShell 5.1-compatible .NET ACL write was used with an owner fail-closed check.
4. Independent review identified an untested junction ancestor. Its regression proved the ACL setter and scanner reached the external child, then passed after every existing path component became part of fail-closed verification.

## Verification

- `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test lib/windows-dpapi-secrets.test.ts` — PASS (2 tests).
- `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test lib/windows-dpapi-secrets.test.ts lib/windows-acl-reparse.test.ts` — PASS (6 tests).
- `npm.cmd test` — PASS (329 tests).
- `npm.cmd run typecheck` — PASS.
- `npm.cmd run build` — PASS on the network-enabled retry; the sandboxed attempt could not fetch Inter/Lora. The successful build verified 22 Next output traces exclude local vault material. Existing worktree-root/NFT warnings remain.
- Post-focused-run temporary-directory check — PASS (zero matching DPAPI/ACL/reparse/scan fixtures left behind).

## Security notes

- No real credential, `.env*`, `.data`, browser profile, or developer auth store was read or modified.
- Tests and module diagnostics expose only safe booleans or generic errors; no marker, decrypted field, resolved fixture path, ACL entry, SDDL, match offset, or encoding detail is emitted.
